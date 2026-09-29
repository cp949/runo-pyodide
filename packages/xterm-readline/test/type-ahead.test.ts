/**
 * 읽기가 없는 구간의 키 버퍼링(type-ahead) 시험(RD-019).
 * 계약(`docs/design/06-editing.md` 6.7):
 * - `activeRead`가 없을 때 들어온 `onData` 덩어리는 Ctrl+C·Ctrl+L을 뺀 전부 원본 문자열째 버퍼에 쌓인다.
 * - 다음 `read()`의 write 콜백 안(`new State`·`prefill` 직후)에서 `readData`로 하나씩 재생한다.
 * - Ctrl+C는 쌓이지 않고 버퍼를 비운 뒤 `ctrlCHandler`로 간다.
 * - 버퍼는 `cancelRead()`·`dispose()`가 비운다. 상한은 4096 UTF-16 코드 유닛이다.
 * - Shift+Enter(`attachCustomKeyEventHandler`로 오는 키)도 같은 분기를 탄다.
 *   - 활성 읽기가 없으면 `Input`째 쌓고, 재생 때 `readKey`로 처리한다(`onKey` 훅 통과).
 *   - `printAbove` 재그리기 중이면 `queued`에 쌓아 앞선 키와 순서를 지킨다.
 *   - 길이는 1로 센다.
 *
 * `StubTerminal`의 `asyncWrite`로 write 콜백을 `flush()`까지 미룬다.
 */
import { describe, expect, test, vi } from "vitest";
import { InputType, type Input } from "../src/keymap";
import { Readline, type ReadlineOptions } from "../src/readline";
import { asTerminal, StubTerminal } from "./stub-terminal";

/** 옵션을 받아 `StubTerminal`에 활성화한 `Readline`을 만든다. */
function setup(cols = 20, rows = 8, options: ReadlineOptions = {}) {
  const term = new StubTerminal(cols, rows);
  const readline = new Readline({ persist: false, ...options });
  readline.activate(asTerminal(term));
  return { term, readline };
}

// 키 입력 시퀀스
const CTRL_C = "\x03";
const CTRL_L = "\x0c";
const TAB = "\t";

describe("type-ahead 버퍼", () => {
  test("활성 읽기가 없을 때 친 키는 그리지 않고 쌓았다가 다음 read()에서 입력줄로 재생한다", () => {
    const { term, readline } = setup();

    term.type("abc");
    // 읽기 전에는 화면에 아무것도 그리지 않는다(에코 없음).
    expect(term.vt.screen()).toBe("");

    void readline.read(">>> ");

    expect(term.vt.screen()).toBe(">>> abc");
    expect(readline.getLine()).toBe("abc");
    // 커서가 입력줄 끝에 있다.
    expect(readline.getCursor()).toBe(3);
    expect(term.vt.cursor()).toEqual([0, 7]);
  });

  test("read() 호출 뒤 write 콜백이 오기 전에 친 키도 콜백 안에서 재생한다", () => {
    const { term, readline } = setup();
    term.asyncWrite = true;

    void readline.read(">>> ");
    // 콜백 전이라 activeRead가 없다 — "Enter 직후 창"과 같은 상태다.
    term.type("ab");
    expect(readline.getLine()).toBe("");

    term.flush();

    expect(readline.getLine()).toBe("ab");
    expect(readline.getCursor()).toBe(2);
  });

  test("버퍼 안 Enter는 첫 줄만 소비하고 나머지는 다음 읽기가 받는다", async () => {
    const { term, readline } = setup();

    term.type("ab\rcd");
    const first = await readline.read(">>> ");
    expect(first).toBe("ab");

    void readline.read(">>> ");
    expect(readline.getLine()).toBe("cd");
    expect(readline.getCursor()).toBe(2);
  });

  test("버퍼 재생은 한 번만 일어난다(다음 읽기에 이미 소비한 키가 되살아나지 않는다)", async () => {
    const { term, readline } = setup();

    term.type("a\r");
    expect(await readline.read(">>> ")).toBe("a");

    void readline.read(">>> ");
    expect(readline.getLine()).toBe("");
  });

  test("Ctrl+C는 쌓이지 않고 버퍼를 비운 뒤 ctrlCHandler를 부른다", () => {
    const { term, readline } = setup();
    const onCtrlC = vi.fn();
    readline.setCtrlCHandler(onCtrlC);

    term.type("abc");
    term.feed(CTRL_C);
    expect(onCtrlC).toHaveBeenCalledTimes(1);

    // 이후 새로 친 키는 다시 쌓인다.
    term.type("x");
    void readline.read(">>> ");

    expect(readline.getLine()).toBe("x");
    // Ctrl+C 자체는 재생되지 않아 ctrlCHandler가 다시 불리지 않는다.
    expect(onCtrlC).toHaveBeenCalledTimes(1);
  });

  test("Ctrl+L은 즉시 화면을 지우고 버퍼에 쌓지 않으며 버퍼에 쌓인 키도 건드리지 않는다", () => {
    const { term, readline } = setup();

    readline.print("hello");
    expect(term.vt.screen()).toBe("hello");
    term.type("ab");

    term.feed(CTRL_L);
    expect(term.vt.screen()).toBe("");

    void readline.read(">>> ");
    // 지운 화면 위에 프롬프트가 그려지고, 버퍼는 `ab`만 재생된다(Ctrl+L은 재생되지 않아 다시 지우지 않는다).
    expect(readline.getLine()).toBe("ab");
    expect(term.vt.screen()).toBe(">>> ab");
  });

  test("dispose() 뒤에는 버퍼가 비어 다시 활성화해도 옛 키를 재생하지 않는다", async () => {
    const { term, readline } = setup();
    term.asyncWrite = true;

    const pending = readline.read(">>> ");
    const rejected = expect(pending).rejects.toThrow("readline disposed");
    term.type("ab");
    readline.dispose();
    await rejected;
    // 늦게 온 콜백은 아무것도 재생하지 않는다.
    term.flush();

    const term2 = new StubTerminal(20, 8);
    readline.activate(asTerminal(term2));
    void readline.read(">>> ");
    expect(readline.getLine()).toBe("");
    expect(term2.vt.screen()).toBe(">>>");
  });

  test("dispose() 뒤 재활성화하면 옛 키는 없고 새로 친 키만 쌓인다", () => {
    const { term, readline } = setup();

    term.type("old");
    readline.dispose();
    const term2 = new StubTerminal(20, 8);
    readline.activate(asTerminal(term2));
    term2.type("new");
    void readline.read(">>> ");

    expect(readline.getLine()).toBe("new");
  });

  test("cancelRead() 뒤에는 버퍼가 비고 이후 새로 친 키는 다시 쌓인다", async () => {
    const { term, readline } = setup();
    term.asyncWrite = true;

    const pending = readline.read(">>> ");
    const rejected = expect(pending).rejects.toThrow("read cancelled");
    term.type("ab");
    readline.cancelRead();
    await rejected;
    term.flush();

    // 취소된 읽기의 콜백은 재생하지 않고, 이후 새 세션에서 친 키는 쌓인다.
    term.type("cd");
    void readline.read(">>> ");
    term.flush();

    expect(readline.getLine()).toBe("cd");
  });

  test("붙여넣기 덩어리(개행 포함)는 낡은 State를 건드리지 않고 다음 읽기에서 readPaste 경로로 재생한다", () => {
    const { term, readline } = setup();

    // 초기 State는 접두어 ">" 짜리 낡은 것이다. 여기에 editInsert되면 안 된다.
    term.feed("ab\rcd");
    expect(readline.getLine()).toBe("");
    expect(term.vt.screen()).toBe("");

    void readline.read(">>> ");

    // readPaste는 Enter를 줄 바꿈 텍스트로 바꿔 한 번에 넣는다(제출하지 않는다).
    expect(readline.getLine()).toBe("ab\ncd");
  });

  test("상한 4096을 넘는 덩어리는 통째로 버리고 앞에 쌓인 키는 유지하며 작은 덩어리는 계속 받는다", () => {
    const { term, readline } = setup();

    term.feed("a".repeat(4000));
    // 4000 + 200 > 4096 — 통째로 버린다(앞에서부터 잘라 채우지 않는다).
    term.feed("b".repeat(200));
    // 4000 + 2는 상한 안이므로 받는다.
    term.feed("cd");
    // 4002 + 100 > 4096 — 버린다.
    term.feed("e".repeat(100));
    void readline.read(">>> ");

    expect(readline.getLine()).toBe("a".repeat(4000) + "cd");
  });

  test("합계가 정확히 4096이면 받고 그다음 한 글자부터 버린다", () => {
    const { term, readline } = setup();

    term.feed("a".repeat(4096));
    term.feed("b");
    void readline.read(">>> ");

    expect(readline.getLine()).toBe("a".repeat(4096));
  });

  test("버린 덩어리는 합계에 들어가지 않아 이후 작은 덩어리가 상한 안에서 받아진다", () => {
    const { term, readline } = setup();

    term.feed("x".repeat(5000));
    term.feed("y".repeat(4096));
    void readline.read(">>> ");

    expect(readline.getLine()).toBe("y".repeat(4096));
  });

  test("onKey 훅이 재생 키마다 불리고 true를 돌려준 키는 소비된다", () => {
    const { term, readline } = setup();
    const seen: string[] = [];
    const onKey = (input: Input) => {
      seen.push(input.data.join(""));
      return input.data.join("") === "x";
    };

    term.type("axb");
    void readline.read(">>> ", { onKey });

    expect(seen).toEqual(["a", "x", "b"]);
    expect(readline.getLine()).toBe("ab");
  });

  test("재생 키가 printAbove로 재그리기를 시작하면 뒤 키는 queued가 이어받아 순서가 보존된다", () => {
    const { term, readline } = setup();
    term.asyncWrite = true;
    // Tab에서 printAbove를 시작하고 소비하는 훅(코어 Tab 리더와 같은 형태).
    const onKey = (input: Input) => {
      if (input.data.join("") !== TAB) return false;
      void readline.printAbove("cand");
      return true;
    };

    term.type("a" + TAB + "bc");
    void readline.read(">>> ", { onKey });
    term.flush();
    // 재그리기 뒤 도착한 키는 재생분·queued분 뒤에 온다.
    term.type("d");

    expect(readline.getLine()).toBe("abcd");
    expect(term.vt.screen()).toBe(">>> a\ncand\n>>> abcd");
  });

  test("다중 토큰 덩어리는 Ctrl+C가 섞여 있어도 덩어리째 쌓이고 ctrlCHandler를 부르지 않는다", () => {
    const { term, readline } = setup();
    const onCtrlC = vi.fn();
    readline.setCtrlCHandler(onCtrlC);

    term.type("x");
    term.feed("ab" + CTRL_C + "cd");
    expect(onCtrlC).not.toHaveBeenCalled();

    void readline.read(">>> ");

    // 재생 때 읽기가 살아 있으므로 붙여넣은 Ctrl+C는 그 읽기의 Ctrl+C(줄 다시 그리기)로 처리된다.
    expect(onCtrlC).not.toHaveBeenCalled();
    expect(readline.getLine()).toBe("cd");
  });
});

describe("type-ahead Shift+Enter", () => {
  test("활성 읽기가 없을 때 친 a Shift+Enter b는 다음 read()에서 순서대로 재생되어 버퍼가 줄 바꿈 사이에 둔 a와 b이고 커서는 끝이다", () => {
    const { term, readline } = setup();

    term.type("a");
    term.pressShiftEnter();
    term.type("b");
    // 읽기 전에는 화면에 아무것도 그리지 않는다.
    expect(term.vt.screen()).toBe("");

    void readline.read(">>> ");

    expect(readline.getLine()).toBe("a\nb");
    expect(readline.getCursor()).toBe(3);
  });

  test("재생된 Shift+Enter는 onKey 훅이 InputType.ShiftEnter로 받고 소비하면 벤더 개행 삽입이 생략된다", () => {
    const { term, readline } = setup();
    const seen: InputType[] = [];
    const onKey = (input: Input) => {
      seen.push(input.inputType);
      // 자동 들여쓰기 훅처럼 ShiftEnter를 소비하고 직접 개행+들여쓰기를 넣는다.
      if (input.inputType !== InputType.ShiftEnter) return false;
      readline.editInsert("\n  ");
      return true;
    };

    term.type("a");
    term.pressShiftEnter();
    term.type("b");
    void readline.read(">>> ", { onKey });

    expect(seen).toEqual([
      InputType.Text,
      InputType.ShiftEnter,
      InputType.Text,
    ]);
    // 벤더가 개행을 한 번 더 넣었다면 "a\n\n  b"가 된다.
    expect(readline.getLine()).toBe("a\n  b");
  });

  test("a Shift+Enter 뒤 Ctrl+C가 오면 버퍼가 비어 다음 read()에서 아무것도 재생되지 않는다", () => {
    const { term, readline } = setup();
    const onCtrlC = vi.fn();
    readline.setCtrlCHandler(onCtrlC);
    const seen: InputType[] = [];

    term.type("a");
    term.pressShiftEnter();
    term.feed(CTRL_C);
    expect(onCtrlC).toHaveBeenCalledTimes(1);

    void readline.read(">>> ", {
      onKey: (input) => {
        seen.push(input.inputType);
        return false;
      },
    });

    expect(seen).toEqual([]);
    expect(readline.getLine()).toBe("");
  });

  test("printAbove 재그리기 대기 중 친 c Shift+Enter d는 queued를 거쳐 순서가 보존되어 버퍼 끝이 줄 바꿈 사이에 둔 c와 d가 된다", () => {
    const { term, readline } = setup();
    term.asyncWrite = true;

    void readline.read(">>> ");
    term.flush();
    void readline.printAbove("cand");
    // 재그리기 콜백이 오기 전(`offscreen` 대기 중)에 친 키다.
    term.type("c");
    term.pressShiftEnter();
    term.type("d");
    term.flush();

    expect(readline.getLine()).toBe("c\nd");
    expect(readline.getCursor()).toBe(3);
  });

  test("재생 중 Enter로 읽기가 끝나면 뒤의 Shift+Enter는 다음 읽기로 넘어간다: x Enter Shift+Enter y", async () => {
    const { term, readline } = setup();

    term.type("x");
    term.feed("\r");
    term.pressShiftEnter();
    term.type("y");

    expect(await readline.read(">>> ")).toBe("x");

    void readline.read(">>> ");
    expect(readline.getLine()).toBe("\ny");
    expect(readline.getCursor()).toBe(2);
  });
});

// 제어 키 재생 결과(RD-019). 3.14 pty 실측(`apps/demo/e2e/pty/rd-019/results.md`)과 대조하는 웹 값이다.
// 실행 중 친 키를 각각 `onData` 한 번으로 흘려 다음 읽기에서 재생한 결과를 고정한다.
// xterm은 키마다 `onData`를 따로 부른다.
describe("type-ahead 제어 키 재생(pty 대조 값)", () => {
  const BACKSPACE = "\x7f";
  const LEFT = "\x1b[D";
  const CTRL_U = "\x15";
  const CTRL_D = "\x04";

  /** 실행 중(읽기 없음)에 `keys`를 한 키씩 치고 다음 `read(">>> ")`에서 재생한 결과를 돌려준다. */
  function replay(keys: string[]) {
    const { term, readline } = setup();
    for (const key of keys) term.feed(key);
    void readline.read(">>> ");
    return {
      screen: term.vt.screen(),
      line: readline.getLine(),
      cursor: readline.getCursor(),
      cursorCol: term.vt.cursor()[1],
    };
  }

  test("Backspace는 재생 때 앞 글자를 지운다: abx⌫c → abc, 커서 끝", () => {
    const r = replay(["a", "b", "x", BACKSPACE, "c"]);
    expect(r.line).toBe("abc");
    expect(r.screen).toBe(">>> abc");
    expect(r.cursorCol).toBe(7);
  });

  test("←는 재생 때 커서를 옮기고 뒤 글자는 그 자리에 들어간다: ab←c → acb, 커서는 c 뒤", () => {
    const r = replay(["a", "b", LEFT, "c"]);
    expect(r.line).toBe("acb");
    expect(r.screen).toBe(">>> acb");
    expect(r.cursor).toBe(2);
    expect(r.cursorCol).toBe(6);
  });

  test("Ctrl+U는 재생 때 커서 앞을 줄 처음까지 지운다: abc^Ude → de", () => {
    const r = replay(["a", "b", "c", CTRL_U, "d", "e"]);
    expect(r.line).toBe("de");
    expect(r.screen).toBe(">>> de");
    expect(r.cursorCol).toBe(6);
  });

  test("커서가 끝인 Ctrl+D는 재생 때 지울 글자가 없어 입력줄을 바꾸지 않는다: abc^D → abc(EOF·NUL 없음)", () => {
    const r = replay(["a", "b", "c", CTRL_D]);
    expect(r.line).toBe("abc");
    expect(r.screen).toBe(">>> abc");
    expect(r.cursorCol).toBe(7);
  });

  test("빈 입력의 Ctrl+D 단독은 재생 때 아무 일도 하지 않는다", () => {
    const r = replay([CTRL_D]);
    expect(r.line).toBe("");
    expect(r.screen).toBe(">>>");
    expect(r.cursorCol).toBe(4);
  });
});

// `ReadlineOptions.typeAhead`(RD-022).
// - 기본값 `true`가 위 시험 전부다.
// - `false`면 활성 읽기가 없는 구간에 들어온 입력을 쌓지 않고 버린다.
// - 입력은 전부 `dispatch`를 거치므로(`onData` 키·붙여넣기·IME 조합 완성 덩어리, Shift+Enter) `pushTypeAhead` 한 곳에서 막는다.
// - Ctrl+C·Ctrl+L 단독 입력은 `isImmediateKey`라 그대로 처리된다.
describe("typeAhead 옵션", () => {
  /** 실행창처럼 키 무시 모드로 만든다. */
  function setupOff() {
    return setup(20, 8, { typeAhead: false });
  }

  test("typeAhead가 false면 읽기 없는 구간에 친 문자는 다음 read()에 나타나지 않는다", () => {
    const { term, readline } = setupOff();

    term.type("abc");
    void readline.read(">>> ");

    expect(readline.getLine()).toBe("");
    expect(readline.getCursor()).toBe(0);
    expect(term.vt.screen()).toBe(">>>");
  });

  test("typeAhead가 false면 읽기 없는 구간의 붙여넣기(다중 문자 onData)는 버려진다", () => {
    const { term, readline } = setupOff();

    // 줄 바꿈이 섞인 붙여넣기 덩어리도 통째로 버린다.
    term.feed("hello world");
    term.feed("a\rb");
    void readline.read(">>> ");

    expect(readline.getLine()).toBe("");
    expect(term.vt.screen()).toBe(">>>");
  });

  test("typeAhead가 false면 읽기 없는 구간의 IME 조합 완성 덩어리(한글·이모지)도 버려진다", () => {
    const { term, readline } = setupOff();

    term.feed("한글");
    term.feed("😀");
    void readline.read(">>> ");

    expect(readline.getLine()).toBe("");
  });

  test("typeAhead가 false면 읽기 없는 구간의 Shift+Enter는 버려진다", () => {
    const { term, readline } = setupOff();

    term.type("a");
    term.pressShiftEnter();
    term.type("b");
    void readline.read(">>> ");

    // 문자와 개행 모두 재생되지 않는다.
    expect(readline.getLine()).toBe("");
    expect(term.vt.screen()).toBe(">>>");
  });

  test("typeAhead가 false면 방향키·Backspace 같은 제어 키도 쌓이지 않는다", () => {
    const { term, readline } = setupOff();

    for (const key of ["a", "\x1b[D", "\x7f", "\x15"]) term.feed(key);
    void readline.read(">>> ");

    expect(readline.getLine()).toBe("");
  });

  test("typeAhead가 false여도 read() write 콜백 대기 중에 친 키는 버려진다", () => {
    const { term, readline } = setupOff();
    term.asyncWrite = true;

    void readline.read(">>> ");
    // 콜백 전이라 activeRead가 없다.
    term.type("ab");
    term.pressShiftEnter();
    term.flush();

    expect(readline.getLine()).toBe("");
  });

  test("typeAhead가 false여도 활성 읽기 중 친 키는 정상으로 입력줄에 들어간다", () => {
    const { term, readline } = setupOff();

    void readline.read(">>> ");
    term.type("ab");
    term.feed("cd");
    term.pressShiftEnter();

    expect(readline.getLine()).toBe("abcd\n");
    expect(readline.getCursor()).toBe(5);
  });

  test("typeAhead가 false여도 읽기가 Enter로 끝난 뒤 이어 친 키는 다음 read()에 나타나지 않는다", async () => {
    const { term, readline } = setupOff();

    const first = readline.read(">>> ");
    // Enter 이후 c·d는 활성 읽기가 없는 구간의 입력이다.
    term.type("ab\rcd");
    expect(await first).toBe("ab");

    void readline.read(">>> ");
    expect(readline.getLine()).toBe("");
  });

  test("typeAhead가 false여도 printAbove 재그리기 중 친 키는 queued로 순서대로 반영된다", () => {
    const { term, readline } = setupOff();
    term.asyncWrite = true;

    void readline.read(">>> ");
    term.flush();
    void readline.printAbove("cand");
    // 재그리기 콜백 전에 친 키는 활성 읽기가 있으므로 버려지지 않고 queued가 잡는다.
    term.type("ab");
    term.flush();

    expect(readline.getLine()).toBe("ab");
  });

  test("typeAhead가 false여도 cancelRead() 뒤 활성 읽기 없이 친 키는 다음 read()에 나타나지 않는다", async () => {
    const { term, readline } = setupOff();

    const pending = readline.read(">>> ");
    const rejected = expect(pending).rejects.toThrow("read cancelled");
    readline.cancelRead();
    await rejected;
    term.type("x");
    void readline.read(">>> ");

    expect(readline.getLine()).toBe("");
  });

  test("typeAhead가 false여도 읽기 없는 구간의 Ctrl+C는 ctrlCHandler를 부른다", () => {
    const { term, readline } = setupOff();
    const onCtrlC = vi.fn();
    readline.setCtrlCHandler(onCtrlC);

    term.type("abc");
    term.feed(CTRL_C);

    expect(onCtrlC).toHaveBeenCalledTimes(1);
    void readline.read(">>> ");
    expect(readline.getLine()).toBe("");
  });

  test("typeAhead가 false여도 읽기 없는 구간의 Ctrl+L은 즉시 화면을 지운다", () => {
    const { term, readline } = setupOff();

    readline.print("hello");
    expect(term.vt.screen()).toBe("hello");
    term.feed(CTRL_L);

    expect(term.vt.screen()).toBe("");
  });

  test("typeAhead가 false여도 읽기 없는 구간의 Ctrl+C 다중 토큰 덩어리는 ctrlCHandler를 부르지 않고 버려진다", () => {
    const { term, readline } = setupOff();
    const onCtrlC = vi.fn();
    readline.setCtrlCHandler(onCtrlC);

    term.feed("ab" + CTRL_C + "cd");

    expect(onCtrlC).not.toHaveBeenCalled();
    void readline.read(">>> ");
    expect(readline.getLine()).toBe("");
  });

  test.each([
    ["옵션 생략", {}],
    ["typeAhead: true", { typeAhead: true }],
    ["typeAhead: undefined", { typeAhead: undefined }],
  ] as [string, ReadlineOptions][])(
    "%s이면 기존처럼 읽기 없는 구간의 문자·붙여넣기·Shift+Enter를 쌓았다가 다음 read()에서 재생한다",
    (_name, options) => {
      const { term, readline } = setup(20, 8, options);

      term.type("a");
      term.feed("bc");
      term.pressShiftEnter();
      term.type("d");
      void readline.read(">>> ");

      expect(readline.getLine()).toBe("abc\nd");
    },
  );
});
