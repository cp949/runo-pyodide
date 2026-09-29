/**
 * 터미널 입력 파서.
 * `onData` 문자열을 키 단위 `Input`으로 쪼갠다.
 * 규칙은 docs/design/06-editing.md 6.1.
 */

/** 입력 종류. 파서가 판정하지 못한 제어 문자·이스케이프는 `Unsupported*`다. */
export enum InputType {
  Text,
  AltEnter,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Delete,
  Backspace,
  CtrlA,
  CtrlC,
  CtrlD,
  CtrlE,
  CtrlK,
  CtrlL,
  CtrlQ,
  CtrlS,
  CtrlU,
  End,
  Enter,
  Home,
  ShiftEnter,
  UnsupportedControlChar,
  UnsupportedEscape,
}

/** 파서가 만든 입력 하나 */
export interface Input {
  /** 입력 종류 */
  inputType: InputType;

  /** 원문 토큰. 코드 포인트 하나가 한 항목이다. `Text`는 여러 항목을 가진다. */
  data: string[];
}

/**
 * `onData` 문자열을 `Input` 목록으로 쪼갠다.
 * 제어 문자와 이스케이프 시퀀스는 각각 `Input` 하나다. 그 사이의 글자는 `Text` 하나로 묶는다.
 */
export function parseInput(data: string): Input[] {
  return Array.from(splitInput(data));
}

/** CSI에서 최종 바이트 앞에 올 수 있는 바이트(파라미터·중간, 0x20-0x3F)인가. */
function isCsiParamByte(c: string): boolean {
  return c.length === 1 && c >= "\x20" && c <= "\x3f";
}

/**
 * `parseInput`의 본체. 코드 포인트 단위로 읽으며 `Input`을 하나씩 내보낸다.
 *
 * 한계:
 * - 서로게이트 쌍은 한 토큰으로 읽어 `Text`에 넣는다.
 * - 파라미터가 붙은 CSI는 최종 바이트까지 읽는다. `ESC [ 3 ~`(Delete)만 매핑하고 나머지는 `UnsupportedEscape`다.
 *   `ESC [ 1 ; 5 C` 같은 수정자 시퀀스도 `UnsupportedEscape` 하나다.
 * - 파라미터가 붙은 CSI의 최종 바이트 앞에서 입력이 끝나면 그 시퀀스를 버린다. `ESC [`만 남은 경우도 같다.
 */
function* splitInput(data: string) {
  let text = [];

  const it = data[Symbol.iterator]();
  for (let next = it.next(); !next.done; next = it.next()) {
    const c = next.value;

    if (c.length > 1) {
      text.push(c);
      continue;
    }

    const val = c.charCodeAt(0);
    if (text.length > 0 && (val < 0x20 || val === 0x7f)) {
      yield {
        inputType: InputType.Text,
        data: text,
      };
      text = [];
    }

    if (val === 0x1b) {
      const seq2 = it.next();
      if (seq2.done) {
        text.push("\x1b");
        continue;
      }

      // `ESC` 뒤가 `[`가 아니다: Alt 조합. Alt+Enter만 `AltEnter`다.
      let inputType = InputType.UnsupportedEscape;
      if (seq2.value !== "[") {
        switch (seq2.value) {
          case "\r":
            inputType = InputType.AltEnter;
            break;
        }
        yield {
          inputType,
          data: ["\x1b", seq2.value],
        };
        continue;
      }

      // CSI 시퀀스(`ESC [`)
      const seq3 = it.next();
      if (seq3.done) {
        continue;
      }

      // 파라미터(0x30-0x3F)·중간(0x20-0x2F) 바이트로 시작하는 CSI.
      // 최종 바이트(0x40-0x7E)까지 읽어 `Input` 하나로 낸다. `ESC [ 3 ~`만 Delete다.
      if (isCsiParamByte(seq3.value)) {
        const seq = ["\x1b", "[", seq3.value];
        for (;;) {
          const more = it.next();
          if (more.done) {
            return;
          }
          seq.push(more.value);
          if (!isCsiParamByte(more.value)) {
            break;
          }
        }
        if (seq.join("") === "\x1b[3~") {
          inputType = InputType.Delete;
        }
        yield { inputType, data: seq };
        continue;
      }

      switch (seq3.value) {
        case "A":
          inputType = InputType.ArrowUp;
          break;
        case "B":
          inputType = InputType.ArrowDown;
          break;
        case "C":
          inputType = InputType.ArrowRight;
          break;
        case "D":
          inputType = InputType.ArrowLeft;
          break;
        case "F":
          inputType = InputType.End;
          break;
        case "H":
          inputType = InputType.Home;
          break;
        case "\r":
          inputType = InputType.AltEnter;
          break;
      }
      yield {
        inputType,
        data: ["\x1b", "[", seq3.value],
      };
      continue;
    }

    // 제어 문자. 매핑이 없으면(`\t`·`\n` 등) `UnsupportedControlChar`다.
    if (val < 0x20 || val === 0x7f) {
      let inputType = InputType.UnsupportedControlChar;
      switch (val) {
        case 0x1:
          inputType = InputType.CtrlA;
          break;
        case 0x3:
          inputType = InputType.CtrlC;
          break;
        case 0x4:
          inputType = InputType.CtrlD;
          break;
        case 0x5:
          inputType = InputType.CtrlE;
          break;
        case 0xb:
          inputType = InputType.CtrlK;
          break;
        case 0x11:
          inputType = InputType.CtrlQ;
          break;
        case 0x13:
          inputType = InputType.CtrlS;
          break;
        case 0x15:
          inputType = InputType.CtrlU;
          break;
        case 0xd:
          inputType = InputType.Enter;
          break;
        case 0x7f:
          inputType = InputType.Backspace;
          break;
        case 0xc:
          inputType = InputType.CtrlL;
          break;
      }
      yield {
        inputType,
        data: [c],
      };
      continue;
    }

    // 그 밖의 글자는 텍스트로 모은다.
    text.push(c);
  }

  if (text.length > 0) {
    yield {
      inputType: InputType.Text,
      data: text,
    };
  }
}
