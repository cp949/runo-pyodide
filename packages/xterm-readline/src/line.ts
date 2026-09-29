type RepeatCount = number;

export class LineBuffer {
  public buf = "";
  public pos = 0;

  public buffer(): string {
    return this.buf;
  }

  public pos_buffer(): string {
    return this.buf.slice(0, this.pos);
  }

  // 버퍼 길이를 UTF-16 코드 유닛 단위로 돌려준다.
  public length(): number {
    return this.buf.length;
  }

  // 버퍼 길이를 코드 포인트(문자) 단위로 돌려준다.
  public char_length(): number {
    return [...this.buf].length;
  }

  // 텍스트와 위치를 설정한다.
  public update(text: string, pos: number) {
    this.buf = text;
    this.pos = pos;
  }

  public insert(text: string): boolean {
    const shift = text.length;
    const push = this.pos === this.buf.length;
    if (push) {
      this.buf = this.buf + text;
    } else {
      this.buf = this.buf.slice(0, this.pos) + text + this.buf.slice(this.pos);
    }
    this.pos += shift;
    return push;
  }

  public moveBack(n: number): boolean {
    const pos = this.prevPos(n);
    if (pos !== undefined) {
      this.pos = pos;
      return true;
    } else {
      return false;
    }
  }

  public moveForward(n: number): boolean {
    const pos = this.nextPos(n);
    if (pos !== undefined) {
      this.pos = pos;
      return true;
    } else {
      return false;
    }
  }

  public moveHome(): boolean {
    const start = this.startOfLine();
    if (this.pos > start) {
      this.pos = start;
      return true;
    }
    return false;
  }

  public moveEnd(): boolean {
    const end = this.endOfLine();
    if (this.pos === end) {
      return false;
    }
    this.pos = end;
    return true;
  }

  public startOfLine(): number {
    const start = this.buf.slice(0, this.pos).lastIndexOf("\n");
    if (start !== -1) {
      return start + 1;
    } else {
      return 0;
    }
  }

  public endOfLine(): number {
    const end = this.buf.slice(this.pos).indexOf("\n");
    if (end !== -1) {
      return this.pos + end;
    } else {
      return this.buf.length;
    }
  }

  public moveLineUp(n: number, promptCols: number = 0): boolean {
    const off = this.buf.slice(0, this.pos).lastIndexOf("\n");
    if (off === -1) {
      return false;
    }
    // 현재 커서는 버퍼 0번 줄에 있지 않다(`pos` 앞에 `\n`이 있음을 방금 확인했다).
    // 그래서 세로 정렬에서는 버퍼 열이 시각 열과 같다.
    const visualCol = [...this.buf.slice(off + 1, this.pos)].length;

    let destStart = this.buf.slice(0, off).lastIndexOf("\n");
    let destIsLine0 = destStart === -1;
    if (destIsLine0) {
      destStart = 0;
    } else {
      destStart = destStart + 1;
    }
    let destEnd = off;

    for (let i = 1; i < n; i++) {
      if (destStart === 0) {
        break;
      }
      destEnd = destStart - 1;
      destStart = this.buf.slice(0, destEnd).lastIndexOf("\n");
      destIsLine0 = destStart === -1;
      if (destIsLine0) {
        destStart = 0;
      } else {
        destStart = destStart + 1;
      }
    }

    // 0번 줄은 앞에 프롬프트가 그려진다.
    // 그래서 버퍼 열 N은 시각 열 N + promptCols에 놓인다.
    // 출발한 시각 열에 그대로 내리려면 도착 줄이 0번 줄일 때 promptCols를 뺀다.
    const destBufCol = destIsLine0
      ? Math.max(0, visualCol - promptCols)
      : visualCol;

    const slice = [...this.buf.slice(destStart, destEnd)].slice(0, destBufCol);

    let gIdx = off;
    if (slice.length > 0) {
      gIdx = slice.map((c) => c.length).reduce((acc, m) => acc + m, 0);
      gIdx = destStart + gIdx;
    }
    this.pos = gIdx;
    return true;
  }

  public moveLineDown(n: number, promptCols: number = 0): boolean {
    const off = this.buf.slice(this.pos).indexOf("\n");
    if (off === -1) {
      return false;
    }

    let lineStart = this.buf.slice(0, this.pos).lastIndexOf("\n");
    const currentIsLine0 = lineStart === -1;
    if (currentIsLine0) {
      lineStart = 0;
    } else {
      lineStart += 1;
    }

    const column = [...this.buf.slice(lineStart, this.pos)].length;
    // 커서의 시각 열.
    // 버퍼 0번 줄은 프롬프트 뒤에 그려지므로 시각 열이 column + promptCols다.
    // 다른 줄은 시각 열 0에서 시작한다.
    const visualCol = currentIsLine0 ? column + promptCols : column;
    let destStart = this.pos + off + 1;

    let destEnd = this.buf.slice(destStart).indexOf("\n");
    if (destEnd === -1) {
      destEnd = this.buf.length;
    } else {
      destEnd = destStart + destEnd;
    }

    for (let i = 1; i < n; i++) {
      if (destEnd === this.buf.length) {
        break;
      }
      destStart = destEnd + 1;
      destEnd = this.buf.slice(destStart).indexOf("\n");
      if (destEnd === -1) {
        destEnd = this.buf.length;
      } else {
        destEnd = destStart + destEnd;
      }
    }

    // 도착 줄은 현재 줄 아래이므로 0번 줄일 수 없다.
    // 버퍼 열이 시각 열과 같다.
    const slice = [...this.buf.slice(destStart, destEnd)];
    if (visualCol < slice.length) {
      this.pos =
        slice
          .slice(0, visualCol)
          .map((c) => c.length)
          .reduce((acc, m) => acc + m, 0) + destStart;
    } else {
      this.pos = destEnd;
    }

    return true;
  }

  // 커서 위치를 설정한다.
  public set_pos(pos: number) {
    this.pos = pos;
  }

  // `pos` 바로 앞 문자의 위치를 돌려준다.
  public prevPos(n: RepeatCount): number | undefined {
    if (this.pos === 0) {
      return undefined;
    }
    const buf = this.buf.slice(0, this.pos);
    return (
      this.pos -
      [...buf]
        .slice(-n)
        .map((c) => c.length)
        .reduce((acc, m) => acc + m, 0)
    );
  }

  // 현재 `pos` 바로 뒤 문자의 위치를 돌려준다.
  public nextPos(n: RepeatCount): number | undefined {
    if (this.pos === this.buf.length) {
      return undefined;
    }
    const buf = this.buf.slice(this.pos);
    return (
      this.pos +
      [...buf]
        .slice(0, n)
        .map((c) => c.length)
        .reduce((acc, m) => acc + m, 0)
    );
  }

  public backspace(n: RepeatCount): boolean {
    const newPos = this.prevPos(n);
    if (newPos === undefined) {
      return false;
    }
    this.buf = this.buf.slice(0, newPos) + this.buf.slice(this.pos);
    this.pos = newPos;
    return true;
  }

  public delete(n: RepeatCount): boolean {
    const nextChar = this.nextPos(n);
    if (nextChar !== undefined) {
      this.buf = this.buf.slice(0, this.pos) + this.buf.slice(nextChar);
      return true;
    } else {
      return false;
    }
  }

  public deleteEndOfLine(): boolean {
    if (this.buf.length == 0 || this.pos == this.buf.length) {
      return false;
    }

    const start = this.pos;
    const end = this.endOfLine();
    if (start == end) {
      this.delete(1);
    } else {
      this.buf = this.buf.slice(0, start) + this.buf.slice(end);
    }

    return true;
  }
}
