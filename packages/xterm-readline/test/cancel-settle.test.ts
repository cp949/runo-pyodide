/**
 * `cancelRead({ settle: true })` 화면 정리 시험. 취소 시점 상태마다 Readline이 쓰는 바이트와 반환값을 고정한다.
 *
 * | 취소 시점 상태 | 쓰는 것 | 반환 |
 * | --- | --- | --- |
 * | 재그리기 대기 중 + 접두 있음(`printAboveRaw`) | `접두 + "\x1b[0m\r\n"` | `true` |
 * | 재그리기 대기 중 + 접두 없음(`printAbove` 또는 접두 `""`) | 없음 | `true` |
 * | 그려진 활성 읽기 | `moveCursorToEnd()` → `refreshUnhighlighted()` → `"\r\n"` | `true` |
 * | write 콜백 대기 읽기만 / 열린 읽기 없음 / `dispose()` 뒤 | 없음 | `false` |
 *
 * `settle`을 주지 않으면(또는 `false`) 화면에 쓰지 않고 `false`를 돌려준다.
 * `StubTerminal`의 write 바이트 기록과 콜백 미루기(`asyncWrite`)를 쓴다.
 */
import { describe, expect, test } from "vitest";
import { Readline, ReadCancelledError } from "../src/readline";
import { asTerminal, StubTerminal } from "./stub-terminal";

type Outcome =
  | { state: "pending" }
  | { state: "resolved"; value: unknown }
  | { state: "rejected"; reason: unknown };

/** promise의 현재 상태를 읽는 함수를 돌려준다. */
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
function setup(cols = 20, rows = 10) {
  const term = new StubTerminal(cols, rows);
  const readline = new Readline({ persist: false });
  readline.activate(asTerminal(term));
  return { term, readline };
}

/** `(`마다 가짜 SGR을 두르는 강조기(괄호 강조 흉내). `state.test.ts`의 것과 같다. */
class BracketHighlighter {
  highlight(line: string, _pos: number): string {
    return line.replace(/\(/g, "\x1b[1;33m(\x1b[0m");
  }
  highlightPrompt(prompt: string): string {
    return prompt;
  }
  highlightChar(_line: string, _pos: number): boolean {
    return false;
  }
}

// Home 키 시퀀스
const HOME = "\x1b[H";
// 30글자 입력. 20열 터미널에서 두 행으로 감긴다.
const THIRTY = "abcdefghijklmnopqrstuvwxyz0123";
// `cancelRead`로 끝난 읽기의 기대 결과
const CANCELLED = { state: "rejected", reason: expect.any(ReadCancelledError) };

describe("cancelRead({ settle: true }) 재그리기 대기 중", () => {
  test("접두가 있으면 접두를 자기 행에 쓰고 커서를 다음 행 머리에 두며 true를 돌려준다", async () => {
    const { term, readline } = setup();
    const outcome = observe(readline.read("> "));
    term.type("abc");
    term.asyncWrite = true;
    void readline.printAboveRaw("out\n", "tick");
    const before = term.bytes();

    const settled = readline.cancelRead({ settle: true });
    term.flush();
    await tick();

    expect(settled).toBe(true);
    expect(outcome()).toEqual(CANCELLED);
    expect(term.bytes().slice(before.length)).toBe("tick\x1b[0m\r\n");
    expect(term.vt.cursor()).toEqual([2, 0]);

    readline.write("Traceback");
    expect(term.vt.screen()).toBe("out\ntick\nTraceback");
  });

  test("printAbove 뒤(접두 없음)에는 아무것도 쓰지 않고 true를 돌려준다", async () => {
    const { term, readline } = setup();
    const outcome = observe(readline.read("> "));
    term.type("abc");
    term.asyncWrite = true;
    void readline.printAbove("x");
    const before = term.bytes();

    const settled = readline.cancelRead({ settle: true });
    term.flush();
    await tick();

    expect(settled).toBe(true);
    expect(outcome()).toEqual(CANCELLED);
    expect(term.bytes()).toBe(before);
    expect(term.vt.cursor()).toEqual([2, 0]);

    readline.write("Traceback");
    expect(term.vt.screen()).toBe("> abc\nx\nTraceback");
  });

  test("printAboveRaw의 접두가 빈 문자열이면 아무것도 쓰지 않고 true를 돌려준다", async () => {
    const { term, readline } = setup();
    const outcome = observe(readline.read("> "));
    term.type("abc");
    term.asyncWrite = true;
    void readline.printAboveRaw("out\n", "");
    const before = term.bytes();

    const settled = readline.cancelRead({ settle: true });
    term.flush();
    await tick();

    expect(settled).toBe(true);
    expect(outcome()).toEqual(CANCELLED);
    expect(term.bytes()).toBe(before);

    readline.write("Traceback");
    expect(term.vt.screen()).toBe("out\nTraceback");
  });
});

describe("cancelRead({ settle: true }) 그려진 활성 읽기", () => {
  test("커서가 감긴 입력의 첫 행이어도 입력 두 행이 남고 뒤 출력은 입력 아래 새 행에 온다", async () => {
    const { term, readline } = setup(20, 10);
    const outcome = observe(readline.read("> "));
    term.type(THIRTY);
    term.feed(HOME);
    // 전제: 입력이 두 행으로 감기고 커서는 첫 행(프롬프트 뒤)에 있다.
    expect(term.vt.screen()).toBe("> abcdefghijklmnopqr\nstuvwxyz0123");
    expect(term.vt.cursor()).toEqual([0, 2]);

    const settled = readline.cancelRead({ settle: true });
    await tick();

    expect(settled).toBe(true);
    expect(outcome()).toEqual(CANCELLED);
    expect(term.vt.cursor()).toEqual([2, 0]);

    readline.write("Traceback\n");
    expect(term.vt.screen()).toBe(
      "> abcdefghijklmnopqr\nstuvwxyz0123\nTraceback",
    );
  });

  test("커서 위치 강조(괄호)를 벗긴 입력으로 다시 그린 뒤 개행한다", async () => {
    const { term, readline } = setup();
    readline.setHighlighter(new BracketHighlighter());
    // 끝에 붙여 치는 글자는 강조기를 거치지 않는 빠른 경로로 그려지므로 prefill(전체 다시 그리기)로 강조된 입력을 만든다.
    const outcome = observe(readline.read("> ", { prefill: "(foo)" }));
    // 전제: 입력은 강조된 형태로 그려져 있다.
    expect(term.bytes()).toContain("\x1b[1;33m(\x1b[0m");
    const before = term.bytes();

    const settled = readline.cancelRead({ settle: true });
    await tick();

    const added = term.bytes().slice(before.length);
    expect(settled).toBe(true);
    expect(outcome()).toEqual(CANCELLED);
    expect(added).toContain("(foo)");
    expect(added).not.toContain("\x1b[1;33m");
    expect(added.endsWith("\r\n")).toBe(true);
    expect(term.vt.cursor()).toEqual([1, 0]);
  });
});

describe("취소 가능한 Ctrl+C와 settle 취소의 줄 확정", () => {
  const CTRL_C = "\x03";

  /** 같은 입력 상태에서 취소한 뒤 추가된 바이트·화면·커서를 돌려준다. */
  async function cancelWith(
    how: "ctrl-c" | "settle",
    prepare: (s: ReturnType<typeof setup>) => Promise<unknown>,
  ) {
    const s = setup();
    const outcome = observe(prepare(s));
    const before = s.term.bytes();
    if (how === "ctrl-c") s.term.feed(CTRL_C);
    else s.readline.cancelRead({ settle: true });
    await tick();
    return {
      added: s.term.bytes().slice(before.length),
      screen: s.term.vt.screen(),
      cursor: s.term.vt.cursor(),
      outcome: outcome(),
    };
  }

  test("괄호 강조가 그려진 입력에서 둘은 같은 바이트(강조를 벗긴 입력 + 개행)를 쓴다", async () => {
    const prepare = ({ readline }: ReturnType<typeof setup>) => {
      readline.setHighlighter(new BracketHighlighter());
      return readline.read("> ", { cancelable: true, prefill: "(foo)" });
    };
    const byCtrlC = await cancelWith("ctrl-c", prepare);
    const bySettle = await cancelWith("settle", prepare);

    expect(byCtrlC.outcome).toEqual({ state: "resolved", value: null });
    expect(bySettle.outcome).toEqual(CANCELLED);
    expect(byCtrlC.added).toContain("(foo)");
    expect(byCtrlC.added).not.toContain("\x1b[1;33m");
    expect(byCtrlC.added.endsWith("\r\n")).toBe(true);
    expect(byCtrlC.added).toBe(bySettle.added);
    expect(byCtrlC.cursor).toEqual([1, 0]);
  });

  test("감긴 입력 첫 행 커서에서 둘은 같은 화면·커서(입력 아래 행 머리)를 남긴다", async () => {
    const prepare = ({ term, readline }: ReturnType<typeof setup>) => {
      const read = readline.read("> ", { cancelable: true });
      term.type(THIRTY);
      term.feed(HOME);
      return read;
    };
    const byCtrlC = await cancelWith("ctrl-c", prepare);
    const bySettle = await cancelWith("settle", prepare);

    expect(byCtrlC.screen).toBe("> abcdefghijklmnopqr\nstuvwxyz0123");
    expect(byCtrlC.cursor).toEqual([2, 0]);
    expect(byCtrlC.added).toBe(bySettle.added);
    expect(bySettle.screen).toBe(byCtrlC.screen);
  });
});

describe("cancelRead({ settle: true })가 정리할 수 없는 상태", () => {
  test("write 콜백을 기다리는 읽기만 있으면 아무것도 쓰지 않고 false를 돌려준다", async () => {
    const { term, readline } = setup();
    readline.write("tail");
    term.asyncWrite = true;
    const outcome = observe(readline.read("> "));
    const before = term.bytes();

    const settled = readline.cancelRead({ settle: true });
    term.flush();
    await tick();

    expect(settled).toBe(false);
    expect(outcome()).toEqual(CANCELLED);
    expect(term.bytes()).toBe(before);
  });

  test("열린 읽기가 없으면 아무것도 쓰지 않고 false를 돌려준다", () => {
    const { term, readline } = setup();
    readline.write("tail");
    const before = term.bytes();

    expect(readline.cancelRead({ settle: true })).toBe(false);
    expect(term.bytes()).toBe(before);
  });

  test("dispose 뒤에는 아무것도 쓰지 않고 false를 돌려준다", async () => {
    const { term, readline } = setup();
    const outcome = observe(readline.read("> "));
    term.type("abc");
    readline.dispose();
    const before = term.bytes();

    expect(readline.cancelRead({ settle: true })).toBe(false);
    await tick();

    expect(term.bytes()).toBe(before);
    expect(outcome()).toEqual({
      state: "rejected",
      reason: expect.any(Error),
    });
  });
});

describe("settle 없는 cancelRead", () => {
  test.each([
    { label: "인자 생략", call: (r: Readline) => r.cancelRead() },
    {
      label: "settle false",
      call: (r: Readline) => r.cancelRead({ settle: false }),
    },
  ])(
    "$label: 커서가 감긴 입력 첫 행이어도 화면에 쓰지 않고 false를 돌려준다",
    async ({ call }) => {
      const { term, readline } = setup(20, 10);
      const outcome = observe(readline.read("> "));
      term.type(THIRTY);
      term.feed(HOME);
      const before = term.bytes();

      const settled = call(readline);
      await tick();

      expect(settled).toBe(false);
      expect(outcome()).toEqual(CANCELLED);
      expect(term.bytes()).toBe(before);
      expect(term.vt.cursor()).toEqual([0, 2]);
    },
  );

  test("재그리기 대기 중 접두가 있어도 화면에 쓰지 않고 false를 돌려준다", async () => {
    const { term, readline } = setup();
    const outcome = observe(readline.read("> "));
    term.type("abc");
    term.asyncWrite = true;
    void readline.printAboveRaw("out\n", "tick");
    const before = term.bytes();

    const settled = readline.cancelRead();
    term.flush();
    await tick();

    expect(settled).toBe(false);
    expect(outcome()).toEqual(CANCELLED);
    expect(term.bytes()).toBe(before);
  });
});
