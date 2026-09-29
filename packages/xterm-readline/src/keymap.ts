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

/**
 * `parseInput`의 본체. 코드 포인트 단위로 읽으며 `Input`을 하나씩 내보낸다.
 *
 * 한계:
 * - 서로게이트 쌍은 한 토큰으로 읽어 `Text`에 넣는다.
 * - `ESC [ n ~`은 `n = 3`(Delete)만 매핑한다. 나머지는 `UnsupportedEscape`다.
 * - `ESC [ 1 ; 5 C` 같은 수정자 시퀀스는 처리하지 않는다. 앞 세 문자를 버리고 나머지(`5C`)가 `Text`가 된다.
 * - `ESC [` 뒤에서 입력이 끝나면 그 시퀀스를 버린다.
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

      // 숫자로 시작하는 CSI(`ESC [ n ~`). 자릿수는 한두 자리다.
      if (seq3.value >= "0" && seq3.value <= "9") {
        let digit = seq3.value;
        const nextDigit = it.next();
        if (nextDigit.done) {
          return;
        }
        if (nextDigit.value >= "0" && nextDigit.value <= "9") {
          digit += nextDigit.value;
        } else if (nextDigit.value !== "~") {
          continue;
        }
        switch (digit) {
          case "3":
            inputType = InputType.Delete;
            break;
        }
        yield {
          inputType,
          data: ["\x1b", "[", digit, "~"],
        };
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
