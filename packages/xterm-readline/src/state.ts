/* tslint:disable:max-classes-per-file */
/**
 * 입력줄 상태.
 * 버퍼·커서·history·프롬프트를 묶고, 편집·이동을 `Tty` 출력으로 옮긴다.
 * 규칙은 docs/design/06-editing.md 6.1.
 *
 * 단위:
 * - `Position`의 행·열은 앵커 행(프롬프트 첫 행)을 0행으로 센 화면 좌표다.
 * - 커서 인덱스는 UTF-16 코드 유닛이다.
 */
import { LineBuffer } from "./line";
import { Tty } from "./tty";
import { History } from "./history";
import stringWidth from "string-width";
import { Highlighter, IdentityHighlighter } from "./highlight";

/** 앵커 행 기준 화면 좌표. 행·열 모두 0부터 센다. */
export class Position {
  /** 열 */
  public col: number;

  /** 행 */
  public row: number;

  /** 인자 순서는 (행, 열)이다. 생략하면 0이다. */
  constructor(rows?: number, cols?: number) {
    if (rows !== undefined) {
      this.row = rows;
    } else {
      this.row = 0;
    }
    if (cols !== undefined) {
      this.col = cols;
    } else {
      this.col = 0;
    }
  }
}

/** 마지막으로 그린 입력줄의 화면 배치. 다음 재그리기가 물리 커서 위치를 알아내는 기준이다. */
export class Layout {
  /** 프롬프트가 끝나는 자리(프롬프트 다음 글자가 놓일 좌표) */
  public promptSize: Position;

  /** 커서 좌표 */
  public cursor: Position;

  /** 버퍼 끝 좌표 */
  public end: Position;

  /** 화면에 그리는 첫 행. 버퍼가 뷰포트보다 높을 때만 0이 아니다. */
  public scrollOffset: number;

  constructor(promptSize: Position) {
    this.promptSize = promptSize;
    this.cursor = new Position();
    this.end = new Position();
    this.scrollOffset = 0;
  }
}

/**
 * 읽기 하나의 입력줄 상태.
 * `read()`의 write 콜백이 읽기마다 새로 만든다. 취소 불가 Ctrl+C도 새로 만든다.
 */
export class State {
  /** 실제로 그리는 프롬프트. 접두가 있으면 접두를 포함한다. */
  private prompt: string;

  /** 생성자에 넘긴 프롬프트. `setPromptPrefix`가 접두를 바꿔도 이 값은 그대로다. */
  private basePrompt: string;
  /** 프롬프트 앞에 붙인 접두(열린 읽기 위 배경 출력의 미종결 조각). 없으면 빈 문자열. */
  private prefix = "";

  /** `prompt`가 끝나는 자리 */
  private promptSize: Position;

  private line: LineBuffer = new LineBuffer();

  private tty: Tty;

  /** 마지막으로 그린 배치 */
  private layout: Layout;

  private highlighter: Highlighter;

  /** 직전 확인에서 커서 강조가 켜져 있었는가. 꺼질 때 한 번 더 그리게 한다(`shouldHighlight`). */
  private highlighting = false;

  private history: History;

  /**
   * Bash 방식 편집 모드 잠금.
   * - 커서 이동이나 편집이 성공하면 true가 된다.
   * - `update()`로 버퍼를 바꾸면(history 탐색, Ctrl-U) false로 돌아간다.
   * - false일 때만 위/아래 키가 history를 탐색한다.
   * - true이면 위/아래 키는 버퍼 안에서 움직인다. 경계에서는 아무 일도 하지 않는다.
   */
  private editing = false;

  constructor(
    prompt: string,
    tty: Tty,
    highlighter: Highlighter,
    history: History,
  ) {
    this.prompt = prompt;
    this.basePrompt = prompt;
    this.tty = tty;
    this.highlighter = highlighter;
    this.history = history;
    this.promptSize = tty.calculatePosition(prompt, new Position());
    this.layout = new Layout(this.promptSize);
  }

  /** 버퍼 전체를 돌려준다. */
  public buffer(): string {
    return this.line.buffer();
  }

  /** 현재 커서 위치(UTF-16 인덱스). */
  public cursor(): number {
    return this.line.pos;
  }

  /** 이 상태가 쓰는 `Tty`. */
  public getTty(): Tty {
    return this.tty;
  }

  /** 현재 프롬프트 접두. 없으면 빈 문자열. */
  public promptPrefix(): string {
    return this.prefix;
  }

  /**
   * 프롬프트 앞에 `prefix`를 붙인다.
   * - 비어 있지 않으면 접두와 기준 프롬프트 사이에 `\x1b[0m`을 넣는다. 접두의 SGR이 프롬프트로 새지 않게 한다.
   * - 빈 문자열이면 기준 프롬프트로 돌아간다.
   * - 화면에는 쓰지 않는다. 다음 `refresh()`가 새 프롬프트로 그린다.
   * - `prefix`에 `\n`·`\r`이 없어야 한다. `\n`은 행 계산을, `\r`은 폭 계산을 어긋나게 한다.
   * - 폭보다 긴 접두는 감긴 프롬프트로 계산한다.
   */
  public setPromptPrefix(prefix: string): void {
    this.prefix = prefix;
    this.prompt =
      prefix === "" ? this.basePrompt : prefix + "\x1b[0m" + this.basePrompt;
    this.promptSize = this.tty.calculatePosition(this.prompt, new Position());
    this.layout.promptSize = { ...this.promptSize };
  }

  /**
   * 커서 강조 때문에 전체를 다시 그려야 하는가.
   * - 하이라이터가 커서 자리 강조를 요구하면 참이다.
   * - 직전에 강조했다가 이번에 요구하지 않아도 참이다. 남은 강조를 지워야 한다.
   * - 호출마다 `highlighting` 표시를 갱신한다.
   */
  public shouldHighlight(): boolean {
    const highlighting = this.highlighter.highlightChar(
      this.line.buf,
      this.line.pos,
    );
    if (highlighting) {
      this.highlighting = true;
      return true;
    } else if (this.highlighting) {
      this.highlighting = false;
      return true;
    } else {
      return false;
    }
  }

  /** 화면을 지우고 배치를 초기화한 뒤 입력줄을 맨 위에 다시 그린다. */
  public clearScreen() {
    this.tty.clearScreen();
    this.tty.anchorRow = 0;
    this.layout.cursor = new Position();
    this.layout.end = new Position();
    this.layout.scrollOffset = 0;
    this.refresh();
  }

  /**
   * 커서 자리에 `text`를 끼우고 화면에 반영한다.
   *
   * 빠른 경로(글자만 쓰고 재그리기 생략)의 조건:
   * - 버퍼 끝에 덧붙였다.
   * - 한 줄 텍스트다.
   * - 폭이 0보다 크다.
   * - 삽입 뒤에도 같은 행 안에 남는다.
   * - `shouldHighlight()`가 거짓이다.
   *
   * 조건이 하나라도 어긋나면 `refresh()`로 다시 그린다.
   */
  public editInsert(text: string) {
    this.editing = true;
    const push = this.line.insert(text);
    const multiline = text.includes("\n");
    if (push && !multiline) {
      const width = stringWidth(text);
      if (
        width > 0 &&
        this.layout.cursor.col + width < this.tty.col &&
        !this.shouldHighlight()
      ) {
        this.layout.cursor.col += width;
        this.layout.end.col += width;
        this.tty.write(text);
      } else {
        this.refresh();
      }
    } else {
      this.refresh();
    }
  }

  /**
   * 화면에 쓰지 않고 커서를 `pos`에 둔 뒤 `text`를 끼운다. 새 커서를 돌려준다.
   * 입력줄이 화면에 없는 동안 공개 편집 API가 쓴다(`Readline`의 `printAbove`·`printAboveRaw` 재그리기 대기).
   * 결과는 재그리기 콜백의 `refresh()`가 그린다.
   */
  public insertOffscreen(pos: number, text: string): number {
    this.editing = true;
    this.line.pos = pos;
    this.line.insert(text);
    return this.line.pos;
  }

  /** `insertOffscreen`과 같은 조건에서 커서를 `pos`에 둔 뒤 앞 `n`글자를 지운다. 그리지 않는다. 새 커서를 돌려준다. */
  public backspaceOffscreen(pos: number, n: number): number {
    this.line.pos = pos;
    if (this.line.backspace(n)) this.editing = true;
    return this.line.pos;
  }

  /** `insertOffscreen`과 같은 조건에서 버퍼를 `text`로 바꾸고 커서를 끝에 둔다. `update`와 달리 그리지 않는다. 새 커서를 돌려준다. */
  public updateOffscreen(text: string): number {
    this.line.update(text, text.length);
    this.editing = false;
    return this.line.pos;
  }

  /**
   * 버퍼를 `text`로 바꾸고 다시 그린다. 커서는 `cursor`(생략하면 끝)에 둔다.
   * 편집 모드 잠금(`editing`)을 푼다.
   */
  public update(text: string, cursor: number = text.length) {
    this.line.update(text, cursor);
    this.editing = false;
    this.refresh();
  }

  /** 커서 앞 `n`글자를 지우고 다시 그린다. 지운 것이 없으면 아무것도 하지 않는다. */
  public editBackspace(n: number) {
    if (this.line.backspace(n)) {
      this.editing = true;
      this.refresh();
    }
  }

  /** 커서 뒤 `n`글자를 지우고 다시 그린다. 지운 것이 없으면 아무것도 하지 않는다. */
  public editDelete(n: number) {
    if (this.line.delete(n)) {
      this.editing = true;
      this.refresh();
    }
  }

  /** 커서부터 현재 줄 끝까지 지우고 다시 그린다(Ctrl+K). */
  public editDeleteEndOfLine() {
    if (this.line.deleteEndOfLine()) {
      this.editing = true;
      this.refresh();
    }
  }

  /**
   * 입력줄 전체를 다시 그린다.
   * 새 배치를 계산해 `scrollOffset`을 맞추고 `Tty.refreshLine`으로 쓴 뒤 `layout`을 새 배치로 바꾼다.
   */
  public refresh() {
    const newLayout = this.tty.computeLayout(this.promptSize, this.line);
    newLayout.scrollOffset = this.adjustScroll(
      newLayout.cursor.row,
      this.layout.scrollOffset,
    );
    this.tty.refreshLine(
      this.prompt,
      this.line,
      this.layout,
      newLayout,
      this.highlighter,
    );
    this.layout = newLayout;
  }

  /**
   * 강조 없이 현재 줄을 다시 그린다.
   * 확정 시점(예: Enter)에 쓴다.
   * 스크롤백에 남는 줄에 커서 기반 강조(예: 짝 괄호 SGR)가 박히지 않게 한다.
   */
  public refreshUnhighlighted() {
    const prev = this.highlighter;
    this.highlighter = new IdentityHighlighter();
    try {
      this.refresh();
    } finally {
      this.highlighter = prev;
    }
  }

  /**
   * 커서 행이 뷰포트 안에 남도록 `scrollOffset`을 조정한다.
   * 이미 안에 있으면 `prevOffset`을 유지한다. 벗어나면 가장 가까운 가장자리에 맞춘다.
   */
  private adjustScroll(cursorRow: number, prevOffset: number): number {
    const viewport = this.tty.viewportRows();
    if (cursorRow < prevOffset) {
      return cursorRow;
    }
    if (cursorRow >= prevOffset + viewport) {
      return cursorRow - viewport + 1;
    }
    return prevOffset;
  }

  /** 커서를 `n`글자 왼쪽으로 옮긴다. 옮겼으면 편집 모드로 들어가 화면 커서를 옮긴다. */
  public moveCursorBack(n: number) {
    if (this.line.moveBack(n)) {
      this.editing = true;
      this.moveCursor();
    }
  }

  /** 커서를 `n`글자 오른쪽으로 옮긴다. 옮겼으면 편집 모드로 들어가 화면 커서를 옮긴다. */
  public moveCursorForward(n: number) {
    if (this.line.moveForward(n)) {
      this.editing = true;
      this.moveCursor();
    }
  }

  /**
   * 위 화살표.
   * 편집 모드면 버퍼 안에서 `n`줄 올라간다. 첫 줄이면 아무 일도 없다.
   * 편집 모드가 아니면 이전 history를 불러온다.
   */
  public moveCursorUp(n: number) {
    if (this.editing) {
      if (this.line.moveLineUp(n, this.promptSize.col)) {
        this.moveCursor();
      }
      return;
    }
    this.previousHistory();
  }

  /**
   * 아래 화살표.
   * 편집 모드면 버퍼 안에서 `n`줄 내려간다. 마지막 줄이면 아무 일도 없다.
   * 편집 모드가 아니면 다음 history를 불러온다.
   */
  public moveCursorDown(n: number) {
    if (this.editing) {
      if (this.line.moveLineDown(n, this.promptSize.col)) {
        this.moveCursor();
      }
      return;
    }
    this.nextHistory();
  }

  /** 커서를 현재 줄 처음으로 옮긴다. */
  public moveCursorHome() {
    if (this.line.moveHome()) {
      this.editing = true;
      this.moveCursor();
    }
  }

  /** 커서를 현재 줄 끝으로 옮긴다. */
  public moveCursorEnd() {
    if (this.line.moveEnd()) {
      this.editing = true;
      this.moveCursor();
    }
  }

  /**
   * 커서를 버퍼 끝으로 옮기고 다시 그린다.
   * 이미 끝이면 아무것도 하지 않는다.
   * 편집 모드는 바꾸지 않는다.
   */
  public moveCursorToEnd() {
    if (this.line.pos === this.line.buf.length) {
      return;
    }
    this.line.pos = this.line.buf.length;
    this.refresh();
  }

  /**
   * 프롬프트 첫 행부터 입력 마지막 행까지 화면에서 지우고 커서를 프롬프트 첫 행 열 0에 둔다.
   * 물리 커서 행은 `refresh()`가 남긴 레이아웃(`layout.cursor`·`scrollOffset`)이 알려 준다.
   * 지운 뒤 레이아웃을 초기값으로 되돌린다. 이 State를 다시 그려도 옛 행을 기준으로 삼지 않는다.
   */
  public erase() {
    this.tty.eraseLine(this.layout);
    this.resetLayout();
  }

  /**
   * 논리 커서(`line.pos`)만 `pos`로 되돌린다.
   * `printAbove`는 원시 텍스트를 쓰기 전에 `moveCursorToEnd()`로 물리 커서를 버퍼 끝에 둔다.
   * 그 호출이 논리 커서도 끝으로 옮긴다.
   * 재그리기 직전에 이 메서드로 원래 위치를 되돌린 뒤 `refresh()`를 부르면 그 위치로 그려진다.
   * 이스케이프 시퀀스는 쓰지 않는다. 뒤따르는 `refresh()` 한 번이면 충분해 State를 다시 만들 필요가 없다(TRAP-17 회피).
   */
  public restoreCursor(pos: number) {
    this.line.pos = pos;
  }

  /**
   * 배치의 커서·끝 좌표와 `scrollOffset`을 0으로 되돌린다.
   * `printAbove`가 원시 텍스트를 쓴 뒤 새 앵커 기준으로 다시 그리려고 쓴다.
   * `moveCursorToEnd()`가 남긴 옛 배치(옛 커서 행)를 버린다.
   * 화면에는 쓰지 않는다. `tty.clearScreen()`도 부르지 않는다.
   */
  public resetLayout(): void {
    this.layout.cursor = new Position();
    this.layout.end = new Position();
    this.layout.scrollOffset = 0;
  }

  /**
   * 이전(더 오래된) history 항목으로 버퍼를 바꾼다.
   * 탐색 중이 아닌데 버퍼가 비어 있지 않으면 입력을 지키려고 아무것도 하지 않는다.
   * 더 오래된 항목이 없어도 아무것도 하지 않는다.
   */
  public previousHistory() {
    if (this.history.cursor === -1 && this.line.length() > 0) {
      return;
    }
    const prev = this.history.prev();
    if (prev !== undefined) {
      this.update(prev);
    }
  }

  /**
   * 다음(더 최근) history 항목으로 버퍼를 바꾼다.
   * 가장 최근 항목에서 한 번 더 부르면 빈 줄이 된다.
   * 탐색 중이 아니면 아무것도 하지 않는다.
   */
  public nextHistory() {
    if (this.history.cursor === -1) {
      return;
    }
    const next = this.history.next();
    if (next !== undefined) {
      this.update(next);
    } else {
      this.update("");
    }
  }

  /**
   * 논리 커서에 맞춰 화면 커서를 옮긴다.
   * 강조가 바뀌어야 하거나 커서 행이 보이는 창 밖이면 `refresh()`로 다시 그린다.
   * 그 밖에는 상대 이동 시퀀스만 쓴다.
   */
  public moveCursor() {
    const cursor = this.tty.calculatePosition(
      this.line.pos_buffer(),
      this.promptSize,
    );
    const viewport = this.tty.viewportRows();
    const inWindow =
      cursor.row >= this.layout.scrollOffset &&
      cursor.row < this.layout.scrollOffset + viewport;
    if (this.shouldHighlight() || !inWindow) {
      this.refresh();
    } else {
      this.tty.moveCursor(this.layout.cursor, cursor);
      this.layout.promptSize = { ...this.promptSize };
      this.layout.cursor = { ...cursor };
    }
  }
}
