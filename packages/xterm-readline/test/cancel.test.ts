/**
 * 취소 가능한 읽기(`read(prompt, { cancelable: true })`)와 `cancelRead()` 시험.
 * - `cancelable`이면 Ctrl+C가 원본처럼 "`^C` + 같은 프롬프트 재그리기"로 끝나지 않고 읽기를 `null`로 끝낸다.
 * - `cancelRead()`는 활성 읽기와 write 콜백 대기 읽기를 `ReadCancelledError`로 끝낸다.
 * - 옵션이 없거나 `cancelable: false`면 원본 동작이 그대로다.
 */
import { describe, expect, test } from "vitest";
import { Readline, ReadCancelledError } from "../src/readline";
import { asTerminal, StubTerminal } from "./stub-terminal";

type Outcome =
  | { state: "pending" }
  | { state: "resolved"; value: unknown }
  | { state: "rejected"; reason: unknown };

/** promise의 현재 상태를 읽는 함수를 돌려준다. 끝나지 않는 읽기도 시험이 멈추지 않고 잡는다. */
function observe(promise: Promise<unknown>): () => Outcome {
  let outcome: Outcome = { state: "pending" };
  promise.then(
    (value) => {
      outcome = { state: "resolved", value };
    },
    (reason) => {
      outcome = { state: "rejected", reason };
    },
  );
  return () => outcome;
}

/** 대기 중인 마이크로태스크와 타이머 한 번을 지나가게 한다. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** `StubTerminal`에 활성화한 `Readline`을 만든다. */
function createSession(cols = 20, rows = 8) {
  const term = new StubTerminal(cols, rows);
  const readline = new Readline({ persist: false });
  readline.activate(asTerminal(term));
  return { term, readline };
}

// 제어 키 입력 시퀀스
const CTRL_C = "\x03";
const ENTER = "\r";
const ARROW_UP = "\x1b[A";
const ARROW_LEFT = "\x1b[D";

describe("cancelable 읽기의 Ctrl+C", () => {
  test("읽기를 null로 끝내고 커서를 입력 아래 줄로 내리며 ^C를 찍지 않는다", async () => {
    const { term, readline } = createSession();
    const outcome = observe(readline.read("> ", { cancelable: true }));
    term.type("abc");

    term.feed(CTRL_C);
    await tick();

    expect(outcome()).toEqual({ state: "resolved", value: null });
    expect(term.vt.screen()).toBe("> abc");
    expect(term.vt.screen()).not.toContain("^C");
    expect(term.vt.cursor()).toEqual([1, 0]);
  });

  test("커서를 입력 중간에 두고 눌러도 개행은 감긴 입력의 끝 뒤에 들어간다", async () => {
    // cols 8: "> " + "abcdefgh"가 두 행으로 감긴다.
    const { term, readline } = createSession(8);
    const outcome = observe(readline.read("> ", { cancelable: true }));
    term.type("abcdefgh");
    term.feed(ARROW_LEFT);
    term.feed(ARROW_LEFT);
    term.feed(ARROW_LEFT);

    term.feed(CTRL_C);
    await tick();

    expect(outcome()).toEqual({ state: "resolved", value: null });
    expect(term.vt.screen()).toBe("> abcdef\ngh");
    expect(term.vt.cursor()).toEqual([2, 0]);
  });

  test("취소 뒤 다음 읽기 전의 키는 버려지고 Ctrl+C는 ctrlCHandler로 간다", async () => {
    const { term, readline } = createSession();
    let ctrlCCount = 0;
    readline.setCtrlCHandler(() => {
      ctrlCCount += 1;
    });
    const outcome = observe(readline.read("> ", { cancelable: true }));
    term.type("abc");
    term.feed(CTRL_C);
    await tick();
    const screenAfterCancel = term.vt.screen();

    term.type("x");
    term.feed(CTRL_C);

    expect(outcome()).toEqual({ state: "resolved", value: null });
    expect(term.vt.screen()).toBe(screenAfterCancel);
    expect(term.vt.screen()).not.toContain("x");
    expect(ctrlCCount).toBe(1);
  });

  test("취소한 입력은 history에 남지 않는다", async () => {
    const { term, readline } = createSession();
    const outcome = observe(readline.read("> ", { cancelable: true }));
    term.type("abc");
    term.feed(CTRL_C);
    await tick();

    readline.read("> ", { cancelable: true });
    term.feed(ARROW_UP);

    expect(outcome()).toEqual({ state: "resolved", value: null });
    expect(readline.getLine()).toBe("");
  });

  test("Enter로 제출한 줄만 history에 남아 취소한 줄 대신 돌아온다", async () => {
    const { term, readline } = createSession();
    const submitted = observe(readline.read("> ", { cancelable: true }));
    term.type("keep");
    term.feed(ENTER);
    await tick();
    const cancelled = observe(readline.read("> ", { cancelable: true }));
    term.type("drop");
    term.feed(CTRL_C);
    await tick();

    readline.read("> ", { cancelable: true });
    term.feed(ARROW_UP);
    const first = readline.getLine();
    term.feed(ARROW_UP);

    expect(submitted()).toEqual({ state: "resolved", value: "keep" });
    expect(cancelled()).toEqual({ state: "resolved", value: null });
    expect(first).toBe("keep");
    // history에 항목이 하나뿐이라 한 번 더 올라가도 그대로다.
    expect(readline.getLine()).toBe("keep");
  });

  test("Enter는 그대로 문자열로 이행한다", async () => {
    const { term, readline } = createSession();
    const outcome = observe(readline.read("> ", { cancelable: true }));

    term.type("abc");
    term.feed(ENTER);
    await tick();

    expect(outcome()).toEqual({ state: "resolved", value: "abc" });
  });

  test("취소되지 않은 채 dispose되면 여전히 Error로 reject된다", async () => {
    const { term, readline } = createSession();
    const outcome = observe(readline.read("> ", { cancelable: true }));
    term.type("abc");

    readline.dispose();
    await tick();

    expect(outcome()).toEqual({ state: "rejected", reason: expect.any(Error) });
  });
});

describe("cancelRead()", () => {
  test("cancelRead는 활성 읽기를 ReadCancelledError로 끝내고 다음 read()를 받는다", async () => {
    const { term, readline } = createSession();
    const outcome = observe(readline.read("> "));
    term.type("abc");

    readline.cancelRead();
    await tick();

    expect(outcome()).toEqual({
      state: "rejected",
      reason: expect.any(ReadCancelledError),
    });
    // 화면·커서는 코어가 정한다. cancelRead 자체는 아무것도 그리지 않는다.
    expect(term.vt.screen()).toBe("> abc");
    expect(term.vt.screen()).not.toContain("^C");

    const next = observe(readline.read("> "));
    term.type("next");
    term.feed(ENTER);
    await tick();

    expect(next()).toEqual({ state: "resolved", value: "next" });
  });

  test("cancelRead는 write 콜백을 기다리는 읽기도 끝낸다", async () => {
    const written: string[] = [];
    const queue: (() => void)[] = [];
    const term = {
      cols: 20,
      rows: 8,
      options: { tabStopWidth: 8 } as { tabStopWidth?: number },
      buffer: { active: { cursorY: 0 } },
      onData: (_handler: (data: string) => void) => ({ dispose: () => {} }),
      onResize: (_handler: (size: { cols: number; rows: number }) => void) => ({
        dispose: () => {},
      }),
      attachCustomKeyEventHandler: (
        _fn: (event: KeyboardEvent) => boolean,
      ) => {},
      write: (text: string, callback?: () => void) => {
        written.push(text);
        if (callback) queue.push(callback);
      },
    };
    const readline = new Readline({ persist: false });
    readline.activate(asTerminal(term));

    const outcome = observe(readline.read("> "));
    // write 콜백이 아직 오지 않은 상태(pendingReads)에서 취소한다.
    readline.cancelRead();
    await tick();

    expect(outcome()).toEqual({
      state: "rejected",
      reason: expect.any(ReadCancelledError),
    });

    // 늦게 도착한 콜백이 activeRead를 되살리지 않는다(dispose와 같은 방어).
    for (const callback of queue.splice(0)) callback();
    const next = observe(readline.read("> "));
    // 되살아났다면 이 read()가 activeRead를 덮어써 입력을 받지 못한다.

    expect(next()).toEqual({ state: "pending" });
  });

  test("읽기가 없을 때 cancelRead는 아무것도 하지 않는다", () => {
    const { term, readline } = createSession();

    expect(() => readline.cancelRead()).not.toThrow();
    expect(term.vt.screen()).toBe("");

    const outcome = observe(readline.read("> "));
    term.type("ok");
    term.feed(ENTER);

    return tick().then(() => {
      expect(outcome()).toEqual({ state: "resolved", value: "ok" });
    });
  });

  test("cancelRead로 끝난 입력은 history에 남지 않는다", async () => {
    const { term, readline } = createSession();
    const outcome = observe(readline.read("> "));
    term.type("abc");
    readline.cancelRead();
    await tick();

    readline.read("> ");
    term.feed(ARROW_UP);

    expect(outcome()).toEqual({
      state: "rejected",
      reason: expect.any(ReadCancelledError),
    });
    expect(readline.getLine()).toBe("");
  });

  test("cancelRead 뒤에도 Ctrl+C 핸들러·키 리스너가 살아 있다", async () => {
    const { term, readline } = createSession();
    let ctrlCCount = 0;
    readline.setCtrlCHandler(() => {
      ctrlCCount += 1;
    });
    const outcome = observe(readline.read("> "));
    term.type("abc");
    readline.cancelRead();
    await tick();

    // cancelRead 뒤에는 activeRead가 없어 Ctrl+C는 ctrlCHandler로 간다(활성 읽기 중 취소와 다르다).
    term.feed(CTRL_C);
    expect(ctrlCCount).toBe(1);

    const next = observe(readline.read("> "));
    term.type("z");
    term.feed(ENTER);
    await tick();

    expect(outcome()).toEqual({
      state: "rejected",
      reason: expect.any(ReadCancelledError),
    });
    expect(next()).toEqual({ state: "resolved", value: "z" });
  });
});

describe.each([
  { label: "옵션을 주지 않으면", options: undefined },
  { label: "cancelable: false면", options: { cancelable: false } },
])("$label 원본 동작이 그대로다", ({ options }) => {
  test("^C를 찍고 같은 프롬프트를 다시 그리며 읽기는 끝나지 않는다", async () => {
    const { term, readline } = createSession();
    const outcome = observe(
      options === undefined
        ? readline.read("> ")
        : readline.read("> ", options),
    );
    term.type("abc");

    term.feed(CTRL_C);
    await tick();

    expect(outcome()).toEqual({ state: "pending" });
    // screen()은 행 끝 공백을 잘라내므로 다시 그린 프롬프트는 "> "가 아니라 ">"로 보인다.
    expect(term.vt.screen()).toBe("> abc^C\n>");

    term.type("1");
    term.feed(ENTER);
    await tick();

    expect(outcome()).toEqual({ state: "resolved", value: "1" });
    expect(term.vt.screen()).toBe("> abc^C\n> 1");
  });
});
