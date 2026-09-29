/**
 * 터미널 출력 계층.
 * 입력줄 배치를 계산하고(`calculatePosition`·`computeLayout`) 이스케이프 시퀀스로 그린다(`refreshLine`).
 * 규칙은 docs/design/06-editing.md 6.1.
 *
 * 전제:
 * - 화면 좌표는 `anchorRow`(프롬프트 첫 행)를 0행으로 센다.
 * - 터미널 크기는 `col`·`row`가 가진다. 크기가 바뀌면 호출자가 갱신한다.
 */
import { Position, Layout } from "./state";
import { LineBuffer } from "./line";
import stringWidth from "string-width";
import { Highlighter } from "./highlight";

/** `Tty`가 쓰는 출력 대상. `Readline`과 시험용 `VTerm`이 구현한다. */
export interface Output {
  /** 텍스트를 그대로 쓴다. */
  write(text: string): void;

  /** 텍스트를 쓴다. */
  print(text: string): void;

  /** 텍스트를 쓰고 줄바꿈한다. */
  println(text: string): void;
}

/** 터미널 크기와 앵커 행을 들고 입력줄을 그리는 계층. */
export class Tty {
  /** 탭 정지 간격(열 수) */
  public tabWidth: number;

  /** 터미널 열 수 */
  public col: number;

  /** 터미널 행 수 */
  public row: number;

  /** 프롬프트 첫 행의 화면 행(0부터). 스크롤로 0 쪽으로 당겨질 수 있다. */
  public anchorRow: number;

  private out: Output;

  /**
   * @param col 터미널 열 수.
   * @param row 터미널 행 수.
   * @param tabWidth 탭 정지 간격.
   * @param out 출력 대상.
   * @param anchorRow 프롬프트 첫 행의 화면 행. 기본 0.
   */
  constructor(
    col: number,
    row: number,
    tabWidth: number,
    out: Output,
    anchorRow = 0,
  ) {
    this.tabWidth = tabWidth;
    this.col = col;
    this.row = row;
    this.anchorRow = anchorRow;
    this.out = out;
  }

  /** `out.write`로 그대로 위임한다. */
  public write(text: string) {
    return this.out.write(text);
  }

  /** `out.print`로 그대로 위임한다. */
  public print(text: string) {
    return this.out.print(text);
  }

  /** `out.println`으로 그대로 위임한다. */
  public println(text: string) {
    return this.out.println(text);
  }

  /** 커서를 왼쪽 위로 옮기고 화면 전체를 지운다. `anchorRow`는 바꾸지 않는다. */
  public clearScreen() {
    this.out.write("\x1b[H\x1b[2J");
  }

  /** 입력줄이 쓸 수 있는 행 수. 앵커 행부터 터미널 맨 아래까지이며 최소 1이다. */
  public viewportRows(): number {
    return Math.max(this.row - this.anchorRow, 1);
  }

  /**
   * `orig`에서 시작해 `this.col`열 폭 터미널에 `text`를 출력했을 때 끝나는 좌표를 계산한다.
   *
   * 규칙:
   * - `\n`은 다음 행 열 0이다.
   * - 탭은 다음 탭 정지까지 채운다.
   * - 이스케이프 시퀀스는 폭 0이다(`width`).
   * - 글자가 열 수를 넘으면 다음 행으로 감긴다.
   * - 마지막 글자가 정확히 맨 끝 열을 채우면 다음 행 열 0으로 정규화한다.
   */
  public calculatePosition(text: string, orig: Position): Position {
    const pos = { ...orig };
    let escSeq = 0;

    [...text].forEach((c) => {
      if (c === "\n") {
        pos.row += 1;
        pos.col = 0;
        return;
      }
      let cw = 0;
      if (c === "\t") {
        cw = this.tabWidth - (pos.col % this.tabWidth);
      } else {
        let size;
        [size, escSeq] = width(c, escSeq);
        cw = size;
      }
      pos.col += cw;
      if (pos.col > this.col) {
        pos.row += 1;
        pos.col = cw;
      }
    });

    if (pos.col === this.col) {
      pos.col = 0;
      pos.row += 1;
    }

    return pos;
  }

  /**
   * 프롬프트 뒤에 `line`을 이어 그렸을 때의 배치를 계산한다.
   * `scrollOffset`은 0으로 둔다. 채우는 것은 호출자(`State.refresh`)다.
   */
  public computeLayout(promptSize: Position, line: LineBuffer): Layout {
    const newPromptSize = { ...promptSize };
    const pos = line.pos;
    const cursor = this.calculatePosition(
      line.buf.slice(0, line.pos),
      promptSize,
    );
    const end =
      pos === line.buf.length
        ? { ...cursor }
        : this.calculatePosition(line.buf.slice(pos), cursor);
    const newLayout: Layout = {
      promptSize: newPromptSize,
      cursor,
      end,
      scrollOffset: 0,
    };
    return newLayout;
  }

  /**
   * 강조된 텍스트를 `this.col`에서 줄바꿈하며 시각 행으로 나눈다.
   * 활성 SGR은 새 행마다 처음에 다시 붙인다.
   * SGR은 누적하지 않는다. 마지막 SGR 하나만 활성으로 본다. 리셋(`ESC [ 0 m`)은 활성 SGR을 지운다.
   */
  public splitIntoVisualRows(text: string): string[] {
    const rows: string[] = [];
    let currentRow = "";
    let col = 0;
    let escSeq = 0;
    let activeSgr = "";
    let pendingEsc = "";

    const finishEsc = () => {
      if (pendingEsc.endsWith("m")) {
        if (
          pendingEsc === "\x1b[0m" ||
          pendingEsc === "\x1b[m" ||
          /^\x1b\[0(?:;0)*m$/.test(pendingEsc)
        ) {
          activeSgr = "";
        } else {
          activeSgr = pendingEsc;
        }
      }
      pendingEsc = "";
    };

    for (const c of [...text]) {
      // 이스케이프 시퀀스 진행 중: 행에 덧붙이고 종결 문자를 추적한다.
      if (escSeq !== 0) {
        currentRow += c;
        pendingEsc += c;
        const [, next] = width(c, escSeq);
        escSeq = next;
        if (escSeq === 0) finishEsc();
        continue;
      }

      if (c === "\x1b") {
        currentRow += c;
        pendingEsc = c;
        const [, next] = width(c, 0);
        escSeq = next;
        if (escSeq === 0) finishEsc();
        continue;
      }

      if (c === "\n") {
        rows.push(currentRow);
        currentRow = activeSgr;
        col = 0;
        continue;
      }

      let cw = 0;
      if (c === "\t") {
        cw = this.tabWidth - (col % this.tabWidth);
      } else {
        cw = stringWidth(c);
      }

      if (col + cw > this.col) {
        rows.push(currentRow);
        currentRow = activeSgr + c;
        col = cw;
      } else {
        currentRow += c;
        col += cw;
      }
    }

    rows.push(currentRow);
    // 버퍼가 오른쪽 끝 열에서 끝나면 calculatePosition이 end를 (row+1, 0)으로
    // 정규화한다. 여기서도 같게 맞춰 행 수를 Layout.end.row와 일치시킨다.
    // 어긋나면 커서가 한 행 모자라게 놓이고, 이후 증분 이동이 계속 밀린다.
    if (col === this.col && col > 0) {
      rows.push(activeSgr);
    }
    return rows;
  }

  /**
   * 입력줄을 다시 그린다.
   * `anchorRow`에서 시작하는 `viewportRows()`행 창에 그린다.
   * `[scrollOffset, scrollOffset + viewportRows)` 범위의 행만 출력한다.
   * 그리는 동안 커서를 숨긴다.
   *
   * @param prompt 그릴 프롬프트.
   * @param line 입력 버퍼.
   * @param oldLayout 직전에 그린 배치. 물리 커서 위치의 기준이다.
   * @param newLayout 지금 그릴 배치. `scrollOffset`을 이 호출이 다시 맞출 수 있다.
   * @param highlighter 강조 훅.
   */
  public refreshLine(
    prompt: string,
    line: LineBuffer,
    oldLayout: Layout,
    newLayout: Layout,
    highlighter: Highlighter,
  ) {
    // 갱신 시퀀스 동안 커서를 숨긴다.
    // 숨기지 않으면 중간 단계(커서 올리기·행 쓰기·커서 내리기)에서 커서가 앵커 행에 잠깐 보인다.
    // 버퍼가 여러 줄이면 윗줄에서 깜빡이는 잔상이 된다.
    this.write("\x1b[?25l");
    try {
      this.refreshLineInner(prompt, line, oldLayout, newLayout, highlighter);
    } finally {
      this.write("\x1b[?25h");
    }
  }

  /** `refreshLine`의 본체. 커서 숨김·복구는 호출자가 맡는다. 단계는 아래 `Step`이다. */
  private refreshLineInner(
    prompt: string,
    line: LineBuffer,
    oldLayout: Layout,
    newLayout: Layout,
    highlighter: Highlighter,
  ) {
    const oldScroll = oldLayout.scrollOffset ?? 0;
    const newScroll = newLayout.scrollOffset ?? 0;

    // Step 0: 하이라이트된 전체 텍스트를 만들어 시각 행으로 나눈다.
    // 터미널 스크롤 여부를 정하기 전에 버퍼 높이를 알아야 한다.
    const highlighted =
      highlighter.highlightPrompt(prompt) +
      highlighter.highlight(line.buf, line.pos);
    const allRows = this.splitIntoVisualRows(highlighted);

    // Step 1: 물리 커서의 현재 위치를 구한다.
    // 직전 갱신 뒤 (anchor + oldCursorViewportRow, oldCursor.col)에 있다.
    const oldCursorViewportRow = Math.max(oldLayout.cursor.row - oldScroll, 0);
    let physicalRow = this.anchorRow + oldCursorViewportRow;

    // Step 2: 버퍼가 앵커 아래 남은 행보다 높으면 마지막 행에서 \n을 써 터미널을 위로 스크롤한다.
    // anchorRow가 그만큼 0 쪽으로 당겨진다. 0 아래로는 내려가지 않는다.
    // 버퍼가 화면보다 높으면 보이지 않는 행은 그리지 않는다(Step 5의 scrollOffset).
    const desiredVisible = Math.min(allRows.length, this.row);
    const currentBelowAnchor = this.row - this.anchorRow;
    if (desiredVisible > currentBelowAnchor && this.anchorRow > 0) {
      const scrollUp = Math.min(
        desiredVisible - currentBelowAnchor,
        this.anchorRow,
      );
      const downBy = this.row - 1 - physicalRow;
      if (downBy > 0) this.write(`\x1b[${downBy}B`);
      this.write("\n".repeat(scrollUp));
      this.anchorRow -= scrollUp;
      physicalRow = this.row - 1;
    }

    // Step 3: 물리 커서를 anchorRow까지 올린다.
    const upToAnchor = physicalRow - this.anchorRow;
    if (upToAnchor > 0) this.write(`\x1b[${upToAnchor}A`);

    // Step 4: 열 0으로 옮기고 커서부터 아래를 지운다.
    this.write("\r\x1b[J");

    // Step 5: 뷰포트에 맞춰 scrollOffset을 다시 제한한다.
    // State는 스크롤 전 뷰포트로 scrollOffset을 계산했다.
    // Step 2가 앵커를 당겼으면 뷰포트가 커졌다. 버퍼가 들어맞으면 scrollOffset이 0으로 돌아갈 수 있다.
    const viewport = this.viewportRows();
    let effectiveScroll = newScroll;
    if (newLayout.cursor.row < effectiveScroll) {
      effectiveScroll = newLayout.cursor.row;
    } else if (newLayout.cursor.row >= effectiveScroll + viewport) {
      effectiveScroll = newLayout.cursor.row - viewport + 1;
    }
    if (allRows.length <= viewport) effectiveScroll = 0;
    effectiveScroll = Math.max(
      0,
      Math.min(effectiveScroll, allRows.length - viewport),
    );
    newLayout.scrollOffset = effectiveScroll;
    const start = effectiveScroll;
    const end = Math.min(allRows.length, start + viewport);

    // Step 6: 보이는 행을 \r\n으로 이어 출력한다.
    for (let i = start; i < end; i++) {
      if (i > start) this.write("\r\n");
      this.write(allRows[i]);
      // 행 끝에서 SGR을 리셋한다.
      // 다음 행이나 버퍼 아래 빈 공간으로 스타일이 번지지 않게 한다.
      this.write("\x1b[0m");
    }

    // Step 7: 커서를 (newCursor.row - effectiveScroll, newCursor.col)에 둔다.
    const cursorViewportRow = newLayout.cursor.row - effectiveScroll;
    const lastWrittenViewportRow = end - 1 - start;
    const upBy = Math.max(lastWrittenViewportRow - cursorViewportRow, 0);
    if (upBy > 0) this.write(`\x1b[${upBy}A`);
    if (newLayout.cursor.col > 0) {
      this.write(`\r\x1b[${newLayout.cursor.col}C`);
    } else {
      this.write("\r");
    }
  }

  /**
   * `refreshLine`의 Step 3·4(앵커 행으로 올라가 `\r\x1b[J`)만 떼어 낸 것.
   * 물리 커서가 `layout` 기준(`anchorRow + cursor.row - scrollOffset`)에 있다고 본다.
   * 앵커 행 열 0까지 올라가 그 아래를 전부 지운다.
   */
  public eraseLine(layout: Layout) {
    const viewportRow = Math.max(
      layout.cursor.row - (layout.scrollOffset ?? 0),
      0,
    );
    if (viewportRow > 0) this.write(`\x1b[${viewportRow}A`);
    this.write("\r\x1b[J");
  }

  /**
   * 화면 커서를 `oldCursor`에서 `newCursor`로 상대 이동 시퀀스로 옮긴다.
   * 행을 먼저, 열을 나중에 옮긴다. 다시 그리지 않는다.
   */
  public moveCursor(oldCursor: Position, newCursor: Position) {
    if (newCursor.row > oldCursor.row) {
      // 아래로 이동
      const rowShift = newCursor.row - oldCursor.row;
      if (rowShift === 1) {
        this.write("\x1b[B");
      } else {
        this.write(`\x1b[${rowShift}B`);
      }
    } else if (newCursor.row < oldCursor.row) {
      // 위로 이동
      const rowShift = oldCursor.row - newCursor.row;
      if (rowShift === 1) {
        this.write("\x1b[A");
      } else {
        this.write(`\x1b[${rowShift}A`);
      }
    }

    if (newCursor.col > oldCursor.col) {
      // 오른쪽으로 이동
      const colShift = newCursor.col - oldCursor.col;
      if (colShift === 1) {
        this.write("\x1b[C");
      } else {
        this.write(`\x1b[${colShift}C`);
      }
    } else if (newCursor.col < oldCursor.col) {
      const colShift = oldCursor.col - newCursor.col;
      if (colShift === 1) {
        this.write("\x1b[D");
      } else {
        this.write(`\x1b[${colShift}D`);
      }
    }
    return;
  }
}

/**
 * 글자 하나(`text`)의 열 폭과 다음 이스케이프 상태를 돌려준다.
 *
 * `escSeq` 상태:
 * - 0: 이스케이프 밖.
 * - 1: `ESC` 바로 뒤.
 * - 2: CSI(`ESC [`) 본문 안.
 *
 * 이스케이프 시퀀스 안의 글자는 폭 0이다. CSI가 아닌 `ESC x`는 두 글자로 끝난다.
 */
function width(text: string, escSeq: number): [size: number, esc_seq: number] {
  if (escSeq === 1) {
    if (text === "[") {
      return [0, 2];
    } else {
      return [0, 0];
    }
  } else if (escSeq === 2) {
    // CSI 본문(ECMA-48):
    // - 파라미터 바이트 0x30-0x3F(숫자·`:`·`;`·사설 접두 `<=>?`)와 중간 바이트 0x20-0x2F: 시퀀스를 잇는다.
    // - 최종 바이트 0x40-0x7E: 폭 0으로 끝난다.
    // - 그 밖의 글자(0x20 미만·0x7F 이상): 시퀀스를 끝낸다. 이 글자의 폭은 0으로 센다.
    const code = text.charCodeAt(0);
    if (code >= 0x20 && code <= 0x3f) {
      return [0, escSeq];
    }
    return [0, 0];
  } else if (text === "\x1b") {
    return [0, 1];
  } else if (text === "\n") {
    return [0, escSeq];
  } else {
    return [stringWidth(text), escSeq];
  }
}
