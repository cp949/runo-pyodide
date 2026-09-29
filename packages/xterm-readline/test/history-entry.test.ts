/**
 * `ReadOptions.historyEntry` 훅, `history: false` 옵션, `Readline.getHistory()` 시험.
 * 계약:
 * - Enter로 제출한 줄을 history에 넣기 직전에 훅을 부르고, 돌려준 문자열을 기록한다.
 * - `read()`의 결과는 원래 줄(`buffer()`)이다.
 * - `skipBlankHistory`가 거른 공백뿐인 제출과 취소(`cancelable` Ctrl+C)에는 훅을 부르지 않는다.
 */
import { describe, expect, test, vi } from "vitest";
import { Readline } from "../src/readline";
import { asTerminal, StubTerminal } from "./stub-terminal";

/** `skipBlankHistory`를 켠 `Readline`을 `StubTerminal`에 활성화한다. */
function setup(cols = 20, rows = 8) {
  const term = new StubTerminal(cols, rows);
  const readline = new Readline({ persist: false, skipBlankHistory: true });
  readline.activate(asTerminal(term));
  return { term, readline };
}

const ARROW_UP = "\x1b[A";
const CTRL_C = "\x03";
const ENTER = "\r";

describe("historyEntry 훅", () => {
  test("훅이 돌려준 텍스트가 history에 기록되고 read()는 원래 줄을 돌려준다", async () => {
    const { term, readline } = setup();

    const first = readline.read("> ", { historyEntry: (l) => `[${l}]` });
    term.type("abc");
    term.feed(ENTER);
    await expect(first).resolves.toBe("abc");

    void readline.read("> ");
    term.feed(ARROW_UP);
    expect(readline.getLine()).toBe("[abc]");
  });

  test("공백뿐인 제출(skipBlankHistory)에는 훅을 부르지 않는다", async () => {
    const { term, readline } = setup();
    const historyEntry = vi.fn();

    const first = readline.read("> ", { historyEntry });
    term.type("   ");
    term.feed(ENTER);
    await expect(first).resolves.toBe("   ");

    expect(historyEntry).not.toHaveBeenCalled();

    void readline.read("> ");
    term.feed(ARROW_UP);
    expect(readline.getLine()).toBe("");
  });

  test("취소(cancelable Ctrl+C)에는 훅을 부르지 않는다", async () => {
    const { term, readline } = setup();
    const historyEntry = vi.fn();

    const first = readline.read("> ", { cancelable: true, historyEntry });
    term.type("abc");
    term.feed(CTRL_C);
    await expect(first).resolves.toBeNull();

    expect(historyEntry).not.toHaveBeenCalled();
  });

  test("훅이 없으면 제출한 줄이 그대로 기록된다", async () => {
    const { term, readline } = setup();

    const first = readline.read("> ");
    term.type("abc");
    term.feed(ENTER);
    await expect(first).resolves.toBe("abc");

    void readline.read("> ");
    term.feed(ARROW_UP);
    expect(readline.getLine()).toBe("abc");
  });

  test("getHistory()는 appendHistory와 같은 객체를 돌려준다", () => {
    const { readline } = setup();

    readline.appendHistory("z");

    expect(readline.getHistory().entries[0]).toBe("z");
  });
});

describe("history: false 읽기 옵션", () => {
  test("Enter로 제출한 줄을 history에 넣지 않고, 다음 읽기(옵션 없음)는 다시 기록한다", async () => {
    const { term, readline } = setup();
    readline.appendHistory("old");

    const first = readline.read("> ", { history: false });
    term.type("abc");
    term.feed(ENTER);
    await expect(first).resolves.toBe("abc");
    expect(readline.getHistory().entries).toEqual(["old"]);

    const second = readline.read("> ");
    term.type("def");
    term.feed(ENTER);
    await expect(second).resolves.toBe("def");
    expect(readline.getHistory().entries).toEqual(["def", "old"]);
  });

  test("historyEntry 훅을 주어도 부르지 않는다", async () => {
    const { term, readline } = setup();
    const historyEntry = vi.fn((l: string) => `[${l}]`);

    const first = readline.read("> ", { history: false, historyEntry });
    term.type("abc");
    term.feed(ENTER);
    await expect(first).resolves.toBe("abc");

    expect(historyEntry).not.toHaveBeenCalled();
    expect(readline.getHistory().entries).toEqual([]);
  });

  test("↑로 이전 항목을 불러 제출해도 history는 그대로이고 커서는 처음으로 돌아가 다음 ↑가 최신 항목이다", async () => {
    const { term, readline } = setup();
    readline.appendHistory("a");
    readline.appendHistory("b");

    const first = readline.read("> ", { history: false });
    term.feed(ARROW_UP);
    term.feed(ARROW_UP);
    // 전제: 두 번째 항목까지 거슬러 올라갔다.
    expect(readline.getLine()).toBe("a");
    expect(readline.getHistory().cursor).toBe(1);
    term.feed(ENTER);
    await expect(first).resolves.toBe("a");

    expect(readline.getHistory().entries).toEqual(["b", "a"]);
    expect(readline.getHistory().cursor).toBe(-1);
    void readline.read("> ");
    term.feed(ARROW_UP);
    expect(readline.getLine()).toBe("b");
  });
});
