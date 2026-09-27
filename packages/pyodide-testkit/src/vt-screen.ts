/**
 * 시험용 가상 화면. 줄 편집기가 내는 ANSI 시퀀스(CUU·CUD·CUF·CUB·ED·EL·SGR)와 `\r`·`\n`을 해석해 눈에 보이는 화면(격자)과 커서를
 * 유지한다. 바이트 열이 아니라 결과 화면을 단정하려는 시험(repl `run-source.test.ts`, terminal `sinks.test.ts`·`terminal-runner.test.ts`)이
 * 쓴다. 벤더 `xterm-readline`의 `VTerm`과 같은 모델을 줄여 둔 것이다(패키지 경계 때문에 벤더 시험 도구를 가져오지 않는다). VT 전체를
 * 해석하지 않는다.
 */
import type { FakeTerminal } from "./fake-terminal";

/**
 * 가짜 터미널의 `write` 앞에 가상 화면을 끼운다. write마다 화면에 반영하고 커서 모델(`fake.screen.cursorX/Y`)도 갱신한다
 * (`Readline`이 재그리기 앵커 행으로 `cursorY`를 읽는다). write 콜백의 동기·비동기 모드는 가짜 터미널 그대로다.
 */
export function attachVtScreen(fake: FakeTerminal, vt: VtScreen): void {
  const originalWrite = fake.term.write.bind(fake.term);
  fake.term.write = ((text: string, callback?: () => void) => {
    vt.write(text);
    fake.screen.cursorX = vt.cursorCol;
    fake.screen.cursorY = vt.cursorRow;
    originalWrite(text, callback);
  }) as typeof fake.term.write;
}

/**
 * 가짜 터미널과 같은 열 수의 `VtScreen`을 만들어 붙인다. 이후 write가 `fake.screen`의 커서를 VT 해석값으로 덮으므로 화면 모델을
 * 시험이 직접 지정해야 하는 시험에는 붙이지 않는다.
 */
export function attachScreen(fake: FakeTerminal, rows = 24): VtScreen {
  const vt = new VtScreen(fake.term.cols, rows);
  attachVtScreen(fake, vt);
  return vt;
}

export class VtScreen {
  readonly cols: number;
  readonly rows: number;
  cursorRow = 0;
  cursorCol = 0;
  /** 스크롤로 밀려난 행 수. */
  scrolled = 0;
  private grid: string[][];
  /** xterm처럼 마지막 열에 글자를 쓰면 다음 글자가 들어올 때 줄이 바뀐다. */
  private pendingWrap = false;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, () => this.blankRow());
  }

  private blankRow(): string[] {
    return Array.from({ length: this.cols }, () => " ");
  }

  private row(index: number): string[] {
    let row = this.grid[index];
    if (row === undefined) {
      row = this.blankRow();
      this.grid[index] = row;
    }
    return row;
  }

  private lineFeed(): void {
    if (this.cursorRow < this.rows - 1) {
      this.cursorRow += 1;
    } else {
      this.grid.shift();
      this.grid.push(this.blankRow());
      this.scrolled += 1;
    }
    this.pendingWrap = false;
  }

  write(text: string): void {
    let index = 0;
    while (index < text.length) {
      const char = text.charAt(index);
      if (char === "\x1b" && text[index + 1] === "[") {
        let end = index + 2;
        let params = "";
        while (end < text.length && /[0-9;?]/.test(text.charAt(end))) {
          params += text.charAt(end);
          end += 1;
        }
        const final = text.charAt(end);
        if (!params.startsWith("?")) this.csi(params, final);
        index = end + 1;
        continue;
      }
      if (char === "\x1b") {
        index += 1;
        continue;
      }
      if (char === "\n") {
        this.lineFeed();
      } else if (char === "\r") {
        this.cursorCol = 0;
        this.pendingWrap = false;
      } else if (char === "\b") {
        // 실제 터미널처럼 커서만 왼쪽으로 옮긴다(글자는 지우지 않는다).
        this.cursorCol = Math.max(0, this.cursorCol - 1);
        this.pendingWrap = false;
      } else if (char === "\x07") {
        // BEL은 화면에 그리지 않는다.
      } else {
        this.put(char);
      }
      index += 1;
    }
  }

  private put(char: string): void {
    if (this.pendingWrap) {
      this.cursorCol = 0;
      this.lineFeed();
    }
    this.row(this.cursorRow)[this.cursorCol] = char;
    if (this.cursorCol === this.cols - 1) this.pendingWrap = true;
    else this.cursorCol += 1;
  }

  private csi(params: string, final: string): void {
    const first = Number.parseInt(params.split(";")[0] ?? "", 10);
    const count = Number.isNaN(first) || first === 0 ? 1 : first;
    switch (final) {
      case "A":
        this.cursorRow = Math.max(0, this.cursorRow - count);
        this.pendingWrap = false;
        return;
      case "B":
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + count);
        this.pendingWrap = false;
        return;
      case "C":
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + count);
        this.pendingWrap = false;
        return;
      case "D":
        this.cursorCol = Math.max(0, this.cursorCol - count);
        this.pendingWrap = false;
        return;
      case "J": {
        // 0(기본): 커서부터 화면 끝까지. 다른 모드는 이 시험이 쓰지 않는다.
        const line = this.row(this.cursorRow);
        for (let col = this.cursorCol; col < this.cols; col += 1)
          line[col] = " ";
        for (let row = this.cursorRow + 1; row < this.rows; row += 1) {
          this.grid[row] = this.blankRow();
        }
        return;
      }
      case "K": {
        const line = this.row(this.cursorRow);
        for (let col = this.cursorCol; col < this.cols; col += 1)
          line[col] = " ";
        return;
      }
      default:
        // SGR(`m`)과 알 수 없는 시퀀스는 글자에 영향이 없다.
        return;
    }
  }

  /** 보이는 행 목록. 행마다 끝 공백을 자르고 끝의 빈 행은 버린다. */
  lines(): string[] {
    const rows = this.grid.map((row) => row.join("").replace(/ +$/, ""));
    while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
    return rows;
  }

  /** `lines()`를 개행으로 이은 문자열. */
  screen(): string {
    return this.lines().join("\n");
  }

  /** `[행, 열]`. */
  cursor(): [number, number] {
    return [this.cursorRow, this.cursorCol];
  }
}
