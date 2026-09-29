/**
 * 시험용 가상 터미널 하네스.
 *
 * - `Output`을 구현한다.
 * - `xterm-readline`이 내보내는 이스케이프 시퀀스를 해석한다: CUU·CUD·CUF·CUB(`A`~`D`), CUP(`H`), ED(`J`), EL(`K`), SGR(`m`).
 * - ED는 모드 0·2만, EL은 모드 0만 처리한다. SGR은 무시한다.
 * - 2차원 격자 + 커서 + 스크롤백을 유지한다.
 * - 정확한 바이트 스트림 대신 결과로 보이는 화면을 검증하게 한다.
 * - 그래서 보이는 결과가 맞는 한 렌더러를 리팩터링해도 시험이 깨지지 않는다.
 *
 * 한계:
 * - 글자마다 한 칸을 쓴다. 전각 폭과 서로게이트 쌍을 모델링하지 않는다.
 * - 탭을 해석하지 않는다.
 */
import { Output } from "./tty";

/** 격자·커서·스크롤백을 가진 가상 터미널. */
export class VTerm implements Output {
  /** 열 수 */
  public cols: number;

  /** 행 수 */
  public rows: number;

  /** 커서 행(0부터) */
  public cursorRow = 0;

  /** 커서 열(0부터) */
  public cursorCol = 0;

  /** 보이는 화면. 행 배열의 배열이며 칸마다 글자 하나다. */
  public grid: string[][];

  /** 위로 밀려난 행 */
  public scrollback: string[][] = [];

  /**
   * xterm 방식 "pending wrap".
   * - 마지막 열에 글자를 쓰면 커서는 그 열에 머물고 이 플래그가 선다.
   * - 다음 출력 가능 글자는 쓰기 전에 다음 행으로 줄바꿈한다.
   * - `\r`, `\n`, 커서 위치 지정 명령, `resize`는 플래그를 지운다.
   */
  private pendingWrap = false;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, () => this.blankRow());
  }

  /**
   * 텍스트와 이스케이프 시퀀스를 해석해 격자에 반영한다.
   * `\r`은 열 0, `\n`은 줄 내림이다(열은 그대로).
   * CSI(`ESC [`)가 아닌 `ESC`는 그 한 글자만 건너뛰고 다음 글자를 텍스트로 쓴다.
   */
  public write(text: string): void {
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === "\x1b") {
        if (text[i + 1] === "[") {
          let j = i + 2;
          // 사설 모드 접두 `?`(예: \x1b[?25l)가 있으면 시퀀스 전체를 무시한다.
          // 커서 표시 여부는 모델링하지 않는다.
          let isPrivate = false;
          if (text[j] === "?") {
            isPrivate = true;
            j++;
          }
          let params = "";
          while (j < text.length && /[0-9;]/.test(text[j])) {
            params += text[j];
            j++;
          }
          const final = text[j];
          if (final !== undefined && !isPrivate) {
            this.handleCSI(params, final);
          }
          i = j + 1;
        } else {
          // CSI가 아닌 이스케이프: ESC만 건너뛴다.
          i += 1;
        }
        continue;
      }
      if (c === "\n") {
        this.lineFeed();
        i++;
        continue;
      }
      if (c === "\r") {
        this.cursorCol = 0;
        this.pendingWrap = false;
        i++;
        continue;
      }
      this.putChar(c);
      i++;
    }
  }

  /** `write`와 같다. */
  public print(text: string): void {
    this.write(text);
  }

  /** `text` 뒤에 `\r\n`을 붙여 쓴다. */
  public println(text: string): void {
    this.write(text + "\r\n");
  }

  /**
   * 보이는 격자를 문자열로 돌려준다. 행은 `\n`으로 잇는다.
   * 검증문이 읽기 쉽도록 행마다 끝 공백을 자르고 끝의 빈 행을 버린다.
   * 패딩을 포함한 전체 행렬이 필요하면 `grid`를 직접 쓴다.
   */
  public screen(): string {
    const trimmed = this.grid.map((r) => r.join("").replace(/ +$/, ""));
    while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") {
      trimmed.pop();
    }
    return trimmed.join("\n");
  }

  /** 커서 위치를 `[행, 열]`로 돌려준다. */
  public cursor(): [number, number] {
    return [this.cursorRow, this.cursorCol];
  }

  /**
   * 격자 크기를 바꾼다. 단순 모델이다.
   * - 줄일 때 행은 아래에서, 열은 오른쪽에서 자른다. 자른 행은 스크롤백으로 보내지 않는다.
   * - 늘릴 때 빈 칸으로 채운다.
   * - 글자를 다시 감지 않는다(xterm.js reflow와 다르다).
   * - 커서를 새 범위로 제한하고 pending wrap을 지운다.
   */
  public resize(cols: number, rows: number): void {
    if (rows < this.grid.length) {
      this.grid = this.grid.slice(0, rows);
    } else {
      while (this.grid.length < rows) this.grid.push(this.blankRow());
    }
    if (cols !== this.cols) {
      this.grid = this.grid.map((r) => {
        if (cols < r.length) return r.slice(0, cols);
        return [...r, ...Array.from({ length: cols - r.length }, () => " ")];
      });
    }
    this.cols = cols;
    this.rows = rows;
    this.cursorRow = Math.max(0, Math.min(rows - 1, this.cursorRow));
    this.cursorCol = Math.max(0, Math.min(cols - 1, this.cursorCol));
    this.pendingWrap = false;
  }

  /** 공백으로 채운 빈 행을 만든다. */
  private blankRow(): string[] {
    return Array.from({ length: this.cols }, () => " ");
  }

  /** 커서 자리에 글자 하나를 쓴다. pending wrap이 서 있으면 먼저 다음 행으로 줄바꿈한다. */
  private putChar(c: string): void {
    if (this.pendingWrap) {
      this.cursorCol = 0;
      this.lineFeed();
      this.pendingWrap = false;
    }
    this.grid[this.cursorRow][this.cursorCol] = c;
    if (this.cursorCol === this.cols - 1) {
      this.pendingWrap = true;
    } else {
      this.cursorCol++;
    }
  }

  /** 커서를 한 행 내린다. 마지막 행이면 맨 위 행을 스크롤백으로 밀고 빈 행을 붙인다. */
  private lineFeed(): void {
    if (this.cursorRow < this.rows - 1) {
      this.cursorRow++;
    } else {
      this.scrollback.push(this.grid.shift()!);
      this.grid.push(this.blankRow());
    }
    this.pendingWrap = false;
  }

  /**
   * CSI 시퀀스 하나를 처리한다.
   * `params`는 `;`로 구분한 숫자열이다. 인자가 없거나 0이면 기본값을 쓴다.
   * 처리하지 않는 최종 문자는 무시한다.
   */
  private handleCSI(params: string, final: string): void {
    const args =
      params.length === 0
        ? []
        : params.split(";").map((p) => parseInt(p, 10) || 0);
    const arg = (i: number, def: number) =>
      args[i] === undefined ? def : args[i] || def;
    switch (final) {
      case "A":
        this.cursorRow = Math.max(0, this.cursorRow - arg(0, 1));
        this.pendingWrap = false;
        return;
      case "B":
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + arg(0, 1));
        this.pendingWrap = false;
        return;
      case "C":
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + arg(0, 1));
        this.pendingWrap = false;
        return;
      case "D":
        this.cursorCol = Math.max(0, this.cursorCol - arg(0, 1));
        this.pendingWrap = false;
        return;
      case "H": {
        const r = arg(0, 1) - 1;
        const c = arg(1, 1) - 1;
        this.cursorRow = Math.max(0, Math.min(this.rows - 1, r));
        this.cursorCol = Math.max(0, Math.min(this.cols - 1, c));
        this.pendingWrap = false;
        return;
      }
      case "J": {
        const mode = args[0] || 0;
        if (mode === 0) {
          for (let c = this.cursorCol; c < this.cols; c++) {
            this.grid[this.cursorRow][c] = " ";
          }
          for (let r = this.cursorRow + 1; r < this.rows; r++) {
            this.grid[r] = this.blankRow();
          }
        } else if (mode === 2) {
          for (let r = 0; r < this.rows; r++) this.grid[r] = this.blankRow();
        }
        return;
      }
      case "K": {
        const mode = args[0] || 0;
        if (mode === 0) {
          for (let c = this.cursorCol; c < this.cols; c++) {
            this.grid[this.cursorRow][c] = " ";
          }
        }
        return;
      }
      case "m":
        // SGR: 스타일은 무시한다. 보이는 글자만 검증한다.
        return;
      default:
        return;
    }
  }
}
