// 테스트용 가상 터미널 하네스.
// - Output 인터페이스를 구현한다.
// - xterm-readline이 내보내는 ANSI 이스케이프 시퀀스를 파싱한다(CUU/CUD/CUF/CUB, CUP, ED, EL, SGR).
// - 2차원 격자 + 커서 + 스크롤백을 유지한다.
// 테스트는 정확한 바이트 스트림 대신 결과로 보이는 화면을 검증한다.
// 그래서 사용자에게 보이는 결과가 맞는 한 렌더러 리팩터링에도 깨지지 않는다.

import { Output } from "./tty";

export class VTerm implements Output {
  public cols: number;
  public rows: number;
  public cursorRow = 0;
  public cursorCol = 0;
  public grid: string[][];
  public scrollback: string[][] = [];
  // xterm 방식 "pending wrap".
  // - 마지막 열에 문자를 쓰면 커서는 그 열에 머물고 이 플래그가 선다.
  // - 다음 출력 가능 문자는 쓰기 전에 다음 행으로 줄바꿈한다.
  // - \r, \n, 커서 위치 지정 명령은 플래그를 지운다.
  private pendingWrap = false;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, () => this.blankRow());
  }

  public write(text: string): void {
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === "\x1b") {
        if (text[i + 1] === "[") {
          let j = i + 2;
          // 선택적 사설 모드 접두를 건너뛴다(예: \x1b[?25l의 ?).
          // 커서 표시 여부는 모델링하지 않는다.
          // 사설 모드 시퀀스 전체를 no-op으로 처리한다.
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
          // 알 수 없는 이스케이프: ESC를 건너뛴다.
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

  public print(text: string): void {
    this.write(text);
  }

  public println(text: string): void {
    this.write(text + "\r\n");
  }

  // 보이는 격자를 문자열로 돌려준다. 행은 '\n'으로 잇는다.
  // 검증문이 읽기 쉽도록 행마다 끝 공백을 자르고 끝의 빈 행을 버린다.
  // 패딩을 포함한 전체 행렬이 필요하면 `grid`를 직접 쓴다.
  public screen(): string {
    const trimmed = this.grid.map((r) => r.join("").replace(/ +$/, ""));
    while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") {
      trimmed.pop();
    }
    return trimmed.join("\n");
  }

  public cursor(): [number, number] {
    return [this.cursorRow, this.cursorCol];
  }

  // xterm.js의 resize 동작을 따른다.
  // 커서를 새 범위로 제한하고 격자를 늘리거나 줄인다(기존 행은 위쪽에 보존).
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

  private blankRow(): string[] {
    return Array.from({ length: this.cols }, () => " ");
  }

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

  private lineFeed(): void {
    if (this.cursorRow < this.rows - 1) {
      this.cursorRow++;
    } else {
      this.scrollback.push(this.grid.shift()!);
      this.grid.push(this.blankRow());
    }
    this.pendingWrap = false;
  }

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
        // SGR: 스타일은 무시한다. 보이는 문자만 검증한다.
        return;
      default:
        return;
    }
  }
}
