/**
 * `terminal/auto-indent.ts` 시험(`docs/design/06-editing.md` 6.3, RD-013).
 * - 순수 함수: `nextIndentation`·`indentUnitWidth`·`backspaceCount`.
 * - 정책 객체: `createAutoIndent`가 `readOptions`로 내는 `prefill`·`onKey`.
 *
 * 기대값은 이전 구현의 python3.14 pty 실측이다.
 * `_pyrepl.readline`과의 차분 대조는 `auto-indent-parity.test.ts`가 맡는다.
 */
import { InputType, type Input } from "@cp949/runo-xterm-readline";
import { describe, expect, it } from "vitest";
import {
  backspaceCount,
  createAutoIndent,
  indentUnitWidth,
  nextIndentation,
} from "../../src/terminal/auto-indent";

/** 커서가 버퍼 끝일 때 Enter로 개행한 뒤 다음 줄에 들어갈 공백을 돌려준다. */
function indentationAfter(
  buffer: string,
  lastUsed: string | null = null,
): string {
  return nextIndentation(buffer, buffer.length, lastUsed).indentation;
}

// 기대값은 이전 구현이 python3.14 -q를 pty로 구동해 관찰한 실측 결과다.
describe("nextIndentation: 3.14 REPL 실측 동작", () => {
  it("`:`로 끝나는 줄 다음 줄은 4칸 들여쓴다", () => {
    expect(indentationAfter("for i in range(2):")).toBe("    ");
  });

  it("`:`가 없어도 직전 줄의 들여쓰기를 이어받는다", () => {
    expect(indentationAfter("for i in range(2):\n    print(i)")).toBe("    ");
  });

  it("들여쓰기 없는 일반 줄 다음은 비어 있다", () => {
    expect(indentationAfter("x = 1")).toBe("");
  });

  it("블록에서 처음 나온 들여쓰기 폭을 단위로 쓴다", () => {
    // 자동 4칸 위에 4칸을 더 타이핑해 8칸이 첫 들여쓰기가 된 경우다.
    // 다음 줄은 16칸이다(8 유지 + 8 추가).
    expect(indentationAfter("if True:\n        if True:")).toBe(" ".repeat(16));
  });

  it("이전 블록에서 본 들여쓰기 폭을 새 블록에서도 쓴다", () => {
    // 2칸으로 쓴 블록 뒤 새 블록의 자동 들여쓰기는 2칸이다.
    // 새 세션(`null`)은 4칸이다.
    const buffer = "if True:\n  x=1";
    const { lastUsedIndentation } = nextIndentation(
      buffer,
      buffer.length,
      null,
    );

    expect(lastUsedIndentation).toBe("  ");
    expect(indentationAfter("if True:", lastUsedIndentation)).toBe("  ");
    expect(indentationAfter("if True:", null)).toBe("    ");
  });

  it("본문 없이 공백뿐인 줄에서 Enter를 눌러도 블록이 열려 있어 다시 4칸이 채워진다", () => {
    // 공백뿐인 줄은 들여쓰기로 이어받지 않는다.
    // 그 앞의 `:`는 거슬러 올라가 찾는다.
    expect(indentationAfter("if True:\n    ")).toBe("    ");
  });

  it("`:` 뒤 줄 끝 주석은 무시한다", () => {
    expect(indentationAfter("if x:  # 조건")).toBe("    ");
  });

  it("주석뿐인 줄은 `:`로 끝나도 들여쓰지 않는다", () => {
    expect(indentationAfter("# 참고:")).toBe("");
  });

  it("문자열 안의 `#`도 주석으로 오인한다(3.14와 같은 한계)", () => {
    expect(indentationAfter('if s == "#":')).toBe("");
  });
});

describe("indentUnitWidth", () => {
  it("스페이스로 쓴 단위는 그 길이이고 아니면 4칸이다", () => {
    expect(indentUnitWidth(null)).toBe(4);
    expect(indentUnitWidth("  ")).toBe(2);
    expect(indentUnitWidth("        ")).toBe(8);
    expect(indentUnitWidth("\t")).toBe(4);
  });
});

// 기대값은 python3.14 -q 실측과 `backspace_dedent` 소스를 따른다.
// 실측: 자동 4칸 뒤 Backspace 한 번에 0칸이 된다.
// 3.14와 달리 이전 줄들의 들여쓰기 수준이 아니라 단위 배수를 쓴다(편차 12).
describe("backspaceCount", () => {
  // 연속 줄(`... ` 입력줄)로 가정하고 커서를 버퍼 끝에 둔다.
  const continuing = (buffer: string, unitWidth = 4) =>
    backspaceCount(buffer, buffer.length, unitWidth, true);

  it("연속 줄의 앞 공백은 단위 배수까지 지운다", () => {
    expect(continuing("    ")).toBe(4);
    expect(continuing(" ".repeat(8))).toBe(4);
    expect(continuing(" ".repeat(6))).toBe(2);
    expect(continuing("  ")).toBe(2);
  });

  it("단위 폭이 2이면 2칸씩 지운다", () => {
    expect(continuing("    ", 2)).toBe(2);
  });

  it("공백 앞에 글자나 탭이 있으면 한 글자만 지운다", () => {
    expect(continuing("    a")).toBe(1);
    expect(continuing("\t")).toBe(1);
    expect(continuing("  \t  ")).toBe(1);
  });

  it("줄 시작이면 한 글자(개행)만 지운다", () => {
    expect(continuing("")).toBe(1);
    expect(continuing("if x:\n")).toBe(1);
  });

  it("이어지는 줄이 아닌 버퍼의 첫 줄에서는 한 글자만 지운다", () => {
    expect(backspaceCount("    ", 4, 4, false)).toBe(1);
  });

  it("여러 줄 버퍼의 둘째 줄부터는 연속 줄이 아니어도 한 단위를 지운다", () => {
    const buffer = `if x:\n${" ".repeat(8)}`;

    expect(backspaceCount(buffer, buffer.length, 4, false)).toBe(4);
  });

  it("커서가 공백 사이에 있으면 커서 앞 공백만 센다", () => {
    const buffer = `if x:\n${" ".repeat(8)}pass`;

    expect(backspaceCount(buffer, 6 + 6, 4, false)).toBe(2);
  });
});

/**
 * `createAutoIndent`가 받는 `readline`의 가짜.
 * 버퍼·커서를 실제로 편집해 `onKey`의 결과를 관찰한다.
 * `backspaceCalls`는 `editBackspace`가 받은 글자 수의 기록이다.
 */
function createFakeReadline(
  initial: { buffer?: string; cursor?: number } = {},
) {
  let buffer = initial.buffer ?? "";
  let cursor = initial.cursor ?? buffer.length;
  const backspaceCalls: number[] = [];
  return {
    getLine: () => buffer,
    getCursor: () => cursor,
    editInsert: (text: string) => {
      buffer = buffer.slice(0, cursor) + text + buffer.slice(cursor);
      cursor += text.length;
    },
    editBackspace: (n: number) => {
      backspaceCalls.push(n);
      buffer = buffer.slice(0, cursor - n) + buffer.slice(cursor);
      cursor -= n;
    },
    get backspaceCalls() {
      return backspaceCalls;
    },
  };
}

/** 데이터 없는 키 입력 하나를 만든다. */
function key(inputType: InputType): Input {
  return { inputType, data: [] };
}

describe("createAutoIndent", () => {
  it("pending이 있으면 직전 줄 들여쓰기 + `:` 뒤 단위를 prefill로 준다", () => {
    const autoIndent = createAutoIndent(createFakeReadline());

    const options = autoIndent.readOptions("for i in range(2):");

    expect(options.prefill).toBe("    ");
  });

  it("pending이 없으면 prefill이 없다", () => {
    const autoIndent = createAutoIndent(createFakeReadline());

    const options = autoIndent.readOptions(undefined);

    expect(options.prefill).toBeUndefined();
    expect(typeof options.onKey).toBe("function");
  });

  it("2칸 블록 뒤 새 블록 prefill은 2칸이다(세션 동안 유지)", () => {
    const autoIndent = createAutoIndent(createFakeReadline());

    autoIndent.readOptions("if True:\n  x=1"); // lastUsedIndentation이 "  "로 갱신된다.
    const options = autoIndent.readOptions("if True:");

    expect(options.prefill).toBe("  ");
  });

  it("Shift+Enter는 pending을 앞에 붙여 계산해 개행 + 들여쓰기를 한 번에 넣는다", () => {
    const readline = createFakeReadline({ buffer: "", cursor: 0 });
    const autoIndent = createAutoIndent(readline);
    const { onKey } = autoIndent.readOptions("for i in range(2):");

    const consumed = onKey!(key(InputType.ShiftEnter));

    expect(consumed).toBe(true);
    expect(readline.getLine()).toBe("\n    ");
    expect(readline.getCursor()).toBe(5);
  });

  it("Alt+Enter도 같다", () => {
    const readline = createFakeReadline({ buffer: "", cursor: 0 });
    const autoIndent = createAutoIndent(readline);
    const { onKey } = autoIndent.readOptions("for i in range(2):");

    const consumed = onKey!(key(InputType.AltEnter));

    expect(consumed).toBe(true);
    expect(readline.getLine()).toBe("\n    ");
  });

  it("Backspace는 단위 배수까지 지울 때만 소비한다", () => {
    const readline = createFakeReadline({ buffer: "    ", cursor: 4 });
    const autoIndent = createAutoIndent(readline);
    // pending이 있는 읽기(연속 줄)라 continuation이 켜진다.
    const { onKey } = autoIndent.readOptions("if x:");

    const consumed = onKey!(key(InputType.Backspace));

    expect(consumed).toBe(true);
    expect(readline.backspaceCalls).toEqual([4]);
    expect(readline.getLine()).toBe("");
  });

  it("`>>> ` 첫 줄의 Backspace는 소비하지 않는다", () => {
    const readline = createFakeReadline({ buffer: "    ", cursor: 4 });
    const autoIndent = createAutoIndent(readline);
    // pending이 없는 읽기(새 `>>> ` 줄)라 continuation이 꺼진다.
    const { onKey } = autoIndent.readOptions(undefined);

    const consumed = onKey!(key(InputType.Backspace));

    expect(consumed).toBe(false);
    expect(readline.backspaceCalls).toEqual([]);
  });

  it("Enter·Ctrl+C는 소비하지 않는다", () => {
    const autoIndent = createAutoIndent(createFakeReadline());
    const { onKey } = autoIndent.readOptions("if x:");

    expect(onKey!(key(InputType.Enter))).toBe(false);
    expect(onKey!(key(InputType.CtrlC))).toBe(false);
  });

  it("취소 뒤에도(readOptions를 pending 없이 다시 불러도) 단위는 유지된다", () => {
    const autoIndent = createAutoIndent(createFakeReadline());

    autoIndent.readOptions("if True:\n  x=1"); // lastUsedIndentation = "  "
    autoIndent.readOptions(undefined); // 취소 뒤 새 프롬프트를 흉내 낸다(pending 없음).
    const options = autoIndent.readOptions("if True:");

    expect(options.prefill).toBe("  ");
  });
});
