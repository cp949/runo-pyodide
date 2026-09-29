import { Position, Layout } from "./state";
import { LineBuffer } from "./line";
import stringWidth from "string-width";
import { Highlighter } from "./highlight";

export interface Output {
  write(text: string): void;
  print(text: string): void;
  println(text: string): void;
}

export class Tty {
  public tabWidth: number;
  public col: number;
  public row: number;
  public anchorRow: number;
  private out: Output;

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

  public write(text: string) {
    return this.out.write(text);
  }

  public print(text: string) {
    return this.out.print(text);
  }

  public println(text: string) {
    return this.out.println(text);
  }

  public clearScreen() {
    this.out.write("\x1b[H\x1b[2J");
  }

  public viewportRows(): number {
    return Math.max(this.row - this.anchorRow, 1);
  }

  // `orig`에서 시작해 `this.col`열 폭 터미널에 `text`를 출력할 때
  // 필요한 열·행 수를 계산한다.
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

  // 하이라이트된 텍스트를 `this.col`에서 줄바꿈하며 시각 행으로 나눈다.
  // 활성 SGR 이스케이프 시퀀스는 새 행마다 처음에 다시 붙인다.
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

  // anchorRow에서 시작하는 viewportRows()행 창에 레이아웃을 그린다.
  // [scrollOffset, scrollOffset + viewportRows) 범위의 행만 출력한다.
  public refreshLine(
    prompt: string,
    line: LineBuffer,
    oldLayout: Layout,
    newLayout: Layout,
    highlighter: Highlighter,
  ) {
    // 갱신 시퀀스 동안 커서를 숨긴다.
    // 아래의 커서 위로 이동·행 다시 쓰기·커서 아래로 이동 중간 단계에서
    // 재그리기마다 커서가 버퍼의 앵커 행에 잠깐 보인다.
    // 버퍼가 여러 줄이면 윗줄에서 유령 깜빡임으로 나타난다.
    this.write("\x1b[?25l");
    try {
      this.refreshLineInner(prompt, line, oldLayout, newLayout, highlighter);
    } finally {
      this.write("\x1b[?25h");
    }
  }

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

    // Step 1: 물리 커서는 지금 어디인가? 직전 갱신 뒤
    // (anchor + oldCursorViewportRow, oldCursor.col)에 있다.
    const oldCursorViewportRow = Math.max(oldLayout.cursor.row - oldScroll, 0);
    let physicalRow = this.anchorRow + oldCursorViewportRow;

    // Step 2: 버퍼가 앵커 아래에 들어가는 행 수보다 크면 마지막 행에서 \n을 써
    // 터미널을 위로 스크롤한다.
    // anchorRow가 0 쪽으로 당겨진다.
    // 아주 큰 버퍼면 프롬프트가 스크롤백으로 넘어간다.
    // 큰 명령을 history에서 불러올 때의 bash 동작과 같다.
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

    // Step 5: (커졌을 수 있는) 뷰포트에 맞춰 scrollOffset을 다시 제한한다.
    // State는 스크롤 전 뷰포트로 scrollOffset을 계산했다.
    // 앵커가 방금 내려갔으면 버퍼가 이제 들어맞아 scrollOffset이 0으로 되돌아갈 수 있다.
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
    // 다음 행이 SGR 없이 시작해도 스타일이 새지 않도록 행 사이에서 SGR을 리셋한다.
    for (let i = start; i < end; i++) {
      if (i > start) this.write("\r\n");
      this.write(allRows[i]);
      // 행 끝에서 활성 스타일을 리셋한다.
      // 프롬프트 재렌더링이나 버퍼 아래 빈 공간으로 스타일이 번지지 않게 한다.
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
   * `refreshLine`의 3·4단계(앵커 행으로 올라가 `\r\x1b[J`)만 떼어 낸 것. 물리 커서가 `layout` 기준
   * (`anchorRow + cursor.row - scrollOffset`)에 있다고 보고 앵커 행 열 0까지 올라가 그 아래를 전부 지운다.
   */
  public eraseLine(layout: Layout) {
    const viewportRow = Math.max(
      layout.cursor.row - (layout.scrollOffset ?? 0),
      0,
    );
    if (viewportRow > 0) this.write(`\x1b[${viewportRow}A`);
    this.write("\r\x1b[J");
  }

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

// `text`를 출력할 때의 열 폭을 돌려준다.
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
    // - 그 밖의 문자: 예전처럼 지원하지 않는 시퀀스로 보고 끝낸다.
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
