/**
 * 입력줄 버퍼와 커서.
 * 규칙은 docs/design/06-editing.md 6.1.
 *
 * 단위:
 * - `pos`는 UTF-16 코드 유닛 인덱스다.
 * - 이동·삭제의 횟수 `n`은 코드 포인트 수다.
 * - 화면 폭은 다루지 않는다. 폭 계산은 `Tty`가 한다.
 */

/** 이동·삭제 횟수. 코드 포인트 수다. */
type RepeatCount = number;

/** 여러 줄을 담을 수 있는 입력줄 버퍼. 줄 구분은 `\n`이다. */
export class LineBuffer {
  /** 버퍼 텍스트 */
  public buf = "";

  /** 커서 위치(UTF-16 인덱스) */
  public pos = 0;

  /** 버퍼 전체를 돌려준다. */
  public buffer(): string {
    return this.buf;
  }

  /** 커서 앞까지의 텍스트를 돌려준다. */
  public pos_buffer(): string {
    return this.buf.slice(0, this.pos);
  }

  /** 버퍼 길이를 UTF-16 코드 유닛 단위로 돌려준다. */
  public length(): number {
    return this.buf.length;
  }

  /** 버퍼 길이를 코드 포인트(문자) 단위로 돌려준다. */
  public char_length(): number {
    return [...this.buf].length;
  }

  /** 텍스트와 커서 위치를 함께 설정한다. */
  public update(text: string, pos: number) {
    this.buf = text;
    this.pos = pos;
  }

  /**
   * 커서 자리에 `text`를 끼우고 커서를 삽입 뒤로 옮긴다.
   * 커서가 버퍼 끝이었으면(끝에 덧붙였으면) 참이다.
   */
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

  /** 커서를 `n`글자 왼쪽으로 옮긴다. 옮겼으면 참이다. 버퍼 처음이면 거짓이다. */
  public moveBack(n: number): boolean {
    const pos = this.prevPos(n);
    if (pos !== undefined) {
      this.pos = pos;
      return true;
    } else {
      return false;
    }
  }

  /** 커서를 `n`글자 오른쪽으로 옮긴다. 옮겼으면 참이다. 버퍼 끝이면 거짓이다. */
  public moveForward(n: number): boolean {
    const pos = this.nextPos(n);
    if (pos !== undefined) {
      this.pos = pos;
      return true;
    } else {
      return false;
    }
  }

  /** 커서를 현재 줄(`\n` 기준) 처음으로 옮긴다. 옮겼으면 참이다. */
  public moveHome(): boolean {
    const start = this.startOfLine();
    if (this.pos > start) {
      this.pos = start;
      return true;
    }
    return false;
  }

  /** 커서를 현재 줄(`\n` 기준) 끝으로 옮긴다. 옮겼으면 참이다. */
  public moveEnd(): boolean {
    const end = this.endOfLine();
    if (this.pos === end) {
      return false;
    }
    this.pos = end;
    return true;
  }

  /** 현재 줄 처음의 인덱스를 돌려준다. */
  public startOfLine(): number {
    const start = this.buf.slice(0, this.pos).lastIndexOf("\n");
    if (start !== -1) {
      return start + 1;
    } else {
      return 0;
    }
  }

  /** 현재 줄 끝(`\n` 자리 또는 버퍼 끝)의 인덱스를 돌려준다. */
  public endOfLine(): number {
    const end = this.buf.slice(this.pos).indexOf("\n");
    if (end !== -1) {
      return this.pos + end;
    } else {
      return this.buf.length;
    }
  }

  /**
   * 커서를 `n`줄 위로 옮긴다. 첫 줄이면 옮기지 않고 거짓이다.
   * 화면 열을 유지하려고 한다. 도착 줄이 더 짧으면 그 줄 끝으로 간다.
   *
   * - 열은 코드 포인트 수로 센다. 전각 문자의 화면 폭은 반영하지 않는다.
   * - 버퍼 0번 줄은 프롬프트 뒤에 그려진다. `promptCols`는 그 프롬프트가 차지하는 열 수다.
   */
  public moveLineUp(n: number, promptCols: number = 0): boolean {
    const off = this.buf.slice(0, this.pos).lastIndexOf("\n");
    if (off === -1) {
      return false;
    }
    // 현재 줄은 0번 줄이 아니다(`pos` 앞에 `\n`이 있음을 방금 확인했다).
    // 0번 줄이 아니면 버퍼 열이 시각 열과 같다.
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
    // 버퍼 열 N은 시각 열 N + promptCols에 놓인다.
    // 도착 줄이 0번 줄이면 promptCols를 빼서 출발한 시각 열에 맞춘다.
    const destBufCol = destIsLine0
      ? Math.max(0, visualCol - promptCols)
      : visualCol;

    const slice = [...this.buf.slice(destStart, destEnd)].slice(0, destBufCol);

    const units = slice.map((c) => c.length).reduce((acc, m) => acc + m, 0);
    this.pos = destStart + units;
    return true;
  }

  /**
   * 커서를 `n`줄 아래로 옮긴다. 마지막 줄이면 옮기지 않고 거짓이다.
   * 화면 열을 유지하려고 한다. 도착 줄이 더 짧으면 그 줄 끝으로 간다.
   * 열 계산은 `moveLineUp`과 같다.
   */
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
    // 0번 줄은 프롬프트 뒤에 그려지므로 시각 열이 column + promptCols다.
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

    // 도착 줄은 현재 줄 아래라 0번 줄이 아니다.
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

  /** 커서 위치만 설정한다. */
  public set_pos(pos: number) {
    this.pos = pos;
  }

  /**
   * 커서에서 `n`글자 앞의 위치를 돌려준다.
   * 커서가 버퍼 처음이면 `undefined`다.
   */
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

  /**
   * 커서에서 `n`글자 뒤의 위치를 돌려준다.
   * 커서가 버퍼 끝이면 `undefined`다.
   */
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

  /** 커서 앞 `n`글자를 지우고 커서를 그 자리로 옮긴다. 지웠으면 참이다. */
  public backspace(n: RepeatCount): boolean {
    const newPos = this.prevPos(n);
    if (newPos === undefined) {
      return false;
    }
    this.buf = this.buf.slice(0, newPos) + this.buf.slice(this.pos);
    this.pos = newPos;
    return true;
  }

  /** 커서 뒤 `n`글자를 지운다. 커서는 그대로다. 지웠으면 참이다. */
  public delete(n: RepeatCount): boolean {
    const nextChar = this.nextPos(n);
    if (nextChar !== undefined) {
      this.buf = this.buf.slice(0, this.pos) + this.buf.slice(nextChar);
      return true;
    } else {
      return false;
    }
  }

  /**
   * 커서부터 현재 줄 끝까지 지운다.
   * 커서가 줄 끝(`\n` 바로 앞)이면 그 `\n` 하나를 지운다.
   * 커서가 버퍼 끝이거나 버퍼가 비었으면 지우지 않고 거짓이다.
   */
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
