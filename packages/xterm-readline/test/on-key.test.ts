/**
 * `ReadOptions.onKey` 훅, 접근자 3종(`getCursor`·`editInsert`·`editBackspace`), `skipBlankHistory` 시험.
 * 계약(`docs/design/06-editing.md` 6.3):
 * - 활성 읽기의 키마다 벤더 처리 앞에서 부른다.
 * - `true`면 벤더 처리를 생략한다.
 * - `readPaste`의 `Text` 토큰(붙여넣은 문자)은 거치지 않는다.
 * - 활성 읽기가 없으면(write 콜백 대기 중 포함) 부르지 않는다. 대기 중 재생은 `type-ahead.test.ts`가 본다.
 */
import { describe, expect, test } from "vitest";
import { Input, InputType } from "../src/keymap";
import type { Input as ExportedInput } from "../src/index";
import { Readline } from "../src/readline";
import { StubTerminal } from "./stub-terminal";

/** 훅 없는 `Readline`을 `StubTerminal`에 활성화한다. */
function setup(cols = 20, rows = 8) {
  const term = new StubTerminal(cols, rows);
  const readline = new Readline({ persist: false });
  readline.activate(readline_term(term));
  return { term, readline };
}

/** `StubTerminal`을 `Readline.activate`가 받는 xterm `Terminal` 타입으로 단언한다. */
function readline_term(term: StubTerminal) {
  return term as unknown as Parameters<Readline["activate"]>[0];
}

const BACKSPACE = "\x7f";
const CTRL_C = "\x03";
const ALT_ENTER = "\x1b\r";
const ENTER = "\r";

describe("onKey 훅", () => {
  test("onKey가 true를 돌려주면 벤더는 그 키를 처리하지 않는다", () => {
    const { term, readline } = setup();
    void readline.read("> ", {
      onKey: (input) => input.inputType === InputType.Backspace,
    });

    term.type("ab");
    term.feed(BACKSPACE);

    expect(readline.getLine()).toBe("ab");
  });

  test("onKey가 false를 돌려주면 벤더가 원래대로 처리한다", () => {
    const { term, readline } = setup();
    void readline.read("> ", { onKey: () => false });

    term.type("ab");
    term.feed(BACKSPACE);

    expect(readline.getLine()).toBe("a");
  });

  test("onKey는 키 종류를 가리지 않고 받는다", () => {
    const { term, readline } = setup();
    const seen: InputType[] = [];
    void readline.read("> ", {
      onKey: (input) => {
        seen.push(input.inputType);
        return true; // 전부 소비해 부작용 없이 순서만 관찰한다.
      },
    });

    term.type("a");
    term.feed(CTRL_C);
    term.pressShiftEnter();
    term.feed(ALT_ENTER);
    term.feed(BACKSPACE);
    term.feed(ENTER);

    expect(seen).toEqual([
      InputType.Text,
      InputType.CtrlC,
      InputType.ShiftEnter,
      InputType.AltEnter,
      InputType.Backspace,
      InputType.Enter,
    ]);
  });

  test("붙여넣기 중 Text 토큰은 onKey를 거치지 않지만 그 사이의 비-Text 토큰(예: Ctrl+C)은 거친다", () => {
    const { term, readline } = setup();
    const seen: InputType[] = [];
    void readline.read("> ", {
      onKey: (input) => {
        seen.push(input.inputType);
        return true;
      },
    });

    // "ab" + Ctrl+C + "cd"를 한 번에 흘린다. 토큰이 2개 이상이라 readPaste 경로로 간다.
    // Text 토큰(ab, cd)은 state.editInsert로 바로 들어가 onKey를 거치지 않는다.
    // 사이의 CtrlC만 readKey를 거쳐 onKey에 닿는다.
    term.feed(`ab${CTRL_C}cd`);

    expect(seen).toEqual([InputType.CtrlC]);
    // onKey가 CtrlC를 소비했으므로 벤더의 CtrlC 처리(프롬프트 재그리기)는 일어나지 않고 텍스트만 남는다.
    expect(readline.getLine()).toBe("abcd");
  });

  test("활성 읽기가 없으면 onKey를 부르지 않는다", () => {
    const term = new StubTerminal(20, 8);
    const readline = new Readline({ persist: false });
    readline.activate(readline_term(term));
    let called = 0;

    // read() 호출 전에는 activeRead가 없다. CtrlC는 ctrlCHandler 분기로만 간다.
    term.feed(CTRL_C);
    expect(called).toBe(0);

    void readline.read("> ", {
      onKey: () => {
        called += 1;
        return false;
      },
    });
    // StubTerminal은 write 콜백을 동기로 불러 read() 시점에 이미 activeRead가 선다.
    term.feed("a");
    expect(called).toBe(1);
  });

  test("getCursor·editInsert·editBackspace는 현재 버퍼와 커서에 작용한다", () => {
    const { readline } = setup();

    readline.editInsert("for i in range(2):");
    expect(readline.getLine()).toBe("for i in range(2):");
    expect(readline.getCursor()).toBe("for i in range(2):".length);

    readline.editInsert("\n    ");
    expect(readline.getLine()).toBe("for i in range(2):\n    ");
    expect(readline.getCursor()).toBe("for i in range(2):\n    ".length);

    readline.editBackspace(4);
    expect(readline.getLine()).toBe("for i in range(2):\n");
    expect(readline.getCursor()).toBe("for i in range(2):\n".length);
  });

  test("ShiftEnter를 onKey가 소비해 editInsert로 들여쓰기를 채운다", () => {
    const { term, readline } = setup();
    void readline.read("> ", {
      onKey: (input) => {
        if (input.inputType === InputType.ShiftEnter) {
          readline.editInsert("\n    ");
          return true;
        }
        return false;
      },
    });

    term.type("for i in range(2):");
    term.pressShiftEnter();

    expect(readline.getLine()).toBe("for i in range(2):\n    ");
    expect(readline.getCursor()).toBe("for i in range(2):\n    ".length);
  });
});

describe("skipBlankHistory", () => {
  const ARROW_UP = "\x1b[A";

  test("켜지면 공백뿐인 제출은 history에 남지 않고 cursor는 처음으로 돌아간다", async () => {
    const term = new StubTerminal(20, 8);
    const readline = new Readline({ persist: false, skipBlankHistory: true });
    readline.activate(readline_term(term));

    const first = readline.read("> ");
    term.type("real");
    term.feed(ENTER);
    await expect(first).resolves.toBe("real");

    const second = readline.read("> ");
    term.type("   ");
    term.feed(ENTER);
    await expect(second).resolves.toBe("   ");

    void readline.read("> ");
    term.feed(ARROW_UP);
    expect(readline.getLine()).toBe("real");
  });

  test("기본값은 false라 공백뿐인 제출도 history에 남는다", async () => {
    const term = new StubTerminal(20, 8);
    const readline = new Readline({ persist: false });
    readline.activate(readline_term(term));

    const first = readline.read("> ");
    term.type("real");
    term.feed(ENTER);
    await expect(first).resolves.toBe("real");

    const second = readline.read("> ");
    term.type("   ");
    term.feed(ENTER);
    await expect(second).resolves.toBe("   ");

    void readline.read("> ");
    term.feed(ARROW_UP);
    expect(readline.getLine()).toBe("   ");
  });
});

test("Input 타입이 index에서 export된다", () => {
  const sample: ExportedInput = { inputType: InputType.Text, data: ["x"] };
  const also: Input = sample;
  expect(also.inputType).toBe(InputType.Text);
});
