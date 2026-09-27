/* tslint:disable:max-classes-per-file */
import { LineBuffer } from "./line";
import { Tty } from "./tty";
import { History } from "./history";
import stringWidth from "string-width";
import { Highlighter, IdentityHighlighter } from "./highlight";

export class Position {
  public col: number;
  public row: number;

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

export class Layout {
  public promptSize: Position;
  public cursor: Position;
  public end: Position;
  public scrollOffset: number;

  constructor(promptSize: Position) {
    this.promptSize = promptSize;
    this.cursor = new Position();
    this.end = new Position();
    this.scrollOffset = 0;
  }
}

export class State {
  private prompt: string;
  /** 생성자에 넘긴 프롬프트. `setPromptPrefix`가 접두를 바꿔도 이 값은 그대로다. */
  private basePrompt: string;
  /** 프롬프트 앞에 붙인 접두(열린 읽기 위 배경 출력의 미종결 조각). 없으면 빈 문자열. */
  private prefix = "";
  private promptSize: Position;
  private line: LineBuffer = new LineBuffer();
  private tty: Tty;
  private layout: Layout;
  private highlighter: Highlighter;
  private highlighting = false;
  private history: History;
  // Bash-style edit-mode lockout: any successful cursor movement or edit
  // sets editing=true; a buffer replacement via update() (history nav or
  // Ctrl-U) resets it. Up/Down only navigate history while editing=false;
  // once editing, Up/Down move within the buffer and no-op at boundaries.
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

  public buffer(): string {
    return this.line.buffer();
  }

  /** 현재 커서 위치(UTF-16 인덱스). */
  public cursor(): number {
    return this.line.pos;
  }

  public getTty(): Tty {
    return this.tty;
  }

  /** 현재 프롬프트 접두. 없으면 빈 문자열. */
  public promptPrefix(): string {
    return this.prefix;
  }

  /**
   * 프롬프트 앞에 `prefix`를 붙인다. 비어 있지 않으면 접두와 기준 프롬프트 사이에 `\x1b[0m`을 넣어 접두의 SGR이
   * 프롬프트로 새지 않게 한다. 빈 문자열이면 기준 프롬프트로 돌아간다. 화면에는 쓰지 않는다 — 다음 `refresh()`가
   * 새 프롬프트로 그린다. `prefix`에 `\n`·`\r`이 없어야 한다(`\n`은 행 계산을, `\r`은 폭 계산을 어긋나게 한다).
   * 폭보다 긴 접두는 감긴 프롬프트로 계산된다.
   */
  public setPromptPrefix(prefix: string): void {
    this.prefix = prefix;
    this.prompt =
      prefix === "" ? this.basePrompt : prefix + "\x1b[0m" + this.basePrompt;
    this.promptSize = this.tty.calculatePosition(this.prompt, new Position());
    this.layout.promptSize = { ...this.promptSize };
  }

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

  public clearScreen() {
    this.tty.clearScreen();
    this.tty.anchorRow = 0;
    this.layout.cursor = new Position();
    this.layout.end = new Position();
    this.layout.scrollOffset = 0;
    this.refresh();
  }

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
   * 화면에 쓰지 않고 커서를 `pos`에 둔 뒤 `text`를 끼운다. 새 커서를 돌려준다. 입력줄이 화면에 없는 동안(`Readline`의
   * `printAbove`·`printAboveRaw` 재그리기 대기) 공개 편집 API가 쓴다 — 결과는 재그리기 콜백의 `refresh()`가 그린다.
   */
  public insertOffscreen(pos: number, text: string): number {
    this.editing = true;
    this.line.pos = pos;
    this.line.insert(text);
    return this.line.pos;
  }

  /** `insertOffscreen`과 같은 조건에서 커서를 `pos`에 둔 뒤 앞 n글자를 지운다(그리지 않음). 새 커서를 돌려준다. */
  public backspaceOffscreen(pos: number, n: number): number {
    this.line.pos = pos;
    if (this.line.backspace(n)) this.editing = true;
    return this.line.pos;
  }

  /** `insertOffscreen`과 같은 조건에서 버퍼를 `text`로 바꾸고 커서를 끝에 둔다(`update`와 같되 그리지 않음). 새 커서를 돌려준다. */
  public updateOffscreen(text: string): number {
    this.line.update(text, text.length);
    this.editing = false;
    return this.line.pos;
  }

  /** 버퍼를 `text`로 바꾸고 다시 그린다. 커서는 `cursor`(생략하면 끝)에 둔다. */
  public update(text: string, cursor: number = text.length) {
    this.line.update(text, cursor);
    this.editing = false;
    this.refresh();
  }

  public editBackspace(n: number) {
    if (this.line.backspace(n)) {
      this.editing = true;
      this.refresh();
    }
  }

  public editDelete(n: number) {
    if (this.line.delete(n)) {
      this.editing = true;
      this.refresh();
    }
  }

  public editDeleteEndOfLine() {
    if (this.line.deleteEndOfLine()) {
      this.editing = true;
      this.refresh();
    }
  }

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

  // Re-render the current line with no highlighter applied. Intended
  // for commit-time redraws (e.g. on Enter) so the line that ends up
  // in scrollback doesn't have any cursor-driven highlight (e.g. a
  // matching-bracket SGR) baked into it.
  public refreshUnhighlighted() {
    const prev = this.highlighter;
    this.highlighter = new IdentityHighlighter();
    try {
      this.refresh();
    } finally {
      this.highlighter = prev;
    }
  }

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

  public moveCursorBack(n: number) {
    if (this.line.moveBack(n)) {
      this.editing = true;
      this.moveCursor();
    }
  }

  public moveCursorForward(n: number) {
    if (this.line.moveForward(n)) {
      this.editing = true;
      this.moveCursor();
    }
  }

  public moveCursorUp(n: number) {
    if (this.editing) {
      if (this.line.moveLineUp(n, this.promptSize.col)) {
        this.moveCursor();
      }
      return;
    }
    this.previousHistory();
  }

  public moveCursorDown(n: number) {
    if (this.editing) {
      if (this.line.moveLineDown(n, this.promptSize.col)) {
        this.moveCursor();
      }
      return;
    }
    this.nextHistory();
  }

  public moveCursorHome() {
    if (this.line.moveHome()) {
      this.editing = true;
      this.moveCursor();
    }
  }

  public moveCursorEnd() {
    if (this.line.moveEnd()) {
      this.editing = true;
      this.moveCursor();
    }
  }

  public moveCursorToEnd() {
    if (this.line.pos === this.line.buf.length) {
      return;
    }
    this.line.pos = this.line.buf.length;
    this.refresh();
  }

  /**
   * 프롬프트 첫 행부터 입력 마지막 행까지 화면에서 지우고 커서를 프롬프트 첫 행 열 0에 둔다. 물리 커서 행은
   * `refresh()`가 남긴 레이아웃(`layout.cursor`·`scrollOffset`)이 알려 주므로 새 상태 없이 같은 계산을 쓴다.
   * 지운 뒤 레이아웃은 초기값으로 되돌려 이 State를 다시 그려도 옛 행을 기준으로 삼지 않는다.
   */
  public erase() {
    this.tty.eraseLine(this.layout);
    this.resetLayout();
  }

  /**
   * 커서 위치(line.pos)만 되돌린다. `printAbove`가 원시 텍스트를 쓰기 전 물리적 커서를 버퍼 끝으로
   * 옮기려고 부른 `moveCursorToEnd()`는 논리 위치도 함께 옮기므로, 재그리기 직전 이 메서드로 원래
   * 위치를 되돌린 뒤 `refresh()`를 한 번 더 부르면 그 위치로 다시 그려진다. escape 쓰기는 하지
   * 않는다(뒤이은 refresh() 한 번이면 충분해 State를 다시 만들 필요가 없다, TRP-030 회피).
   */
  public restoreCursor(pos: number) {
    this.line.pos = pos;
  }

  /**
   * printAbove가 원시 텍스트를 쓴 뒤 새 앵커를 기준으로 한 새 레이아웃에서 다시 그리도록,
   * `moveCursorToEnd()`가 남긴 옛 레이아웃(옛 커서 행)을 0으로 되돌린다. `tty.clearScreen()`은
   * 부르지 않는다(화면을 지우지 않음, 리뷰 repro D 검증).
   */
  public resetLayout(): void {
    this.layout.cursor = new Position();
    this.layout.end = new Position();
    this.layout.scrollOffset = 0;
  }

  public previousHistory() {
    if (this.history.cursor === -1 && this.line.length() > 0) {
      return;
    }
    const prev = this.history.prev();
    if (prev !== undefined) {
      this.update(prev);
    }
  }

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

  public moveCursor() {
    const cursor = this.tty.calculatePosition(
      this.line.pos_buffer(),
      this.promptSize,
    );
    if (cursor === this.layout.cursor) {
      return;
    }
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
