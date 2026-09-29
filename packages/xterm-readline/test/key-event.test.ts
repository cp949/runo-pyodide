/**
 * `ReadlineOptions.onKeyEvent` 훅 시험(`docs/design/06-editing.md` 6.1/6.6).
 * 계약:
 * - 모든 keydown/keypress/keyup에서 벤더 `handleKeyEvent` 처리 앞에서 부른다.
 * - `true`를 돌려주면 벤더 처리(Shift+Enter 삽입 포함)를 생략한다.
 * - `handleKeyEvent` 자체는 xterm에 `false`를 돌려준다. xterm의 기본 처리도 생략된다.
 */
import { describe, expect, test } from "vitest";
import { Readline, ReadlineOptions } from "../src/readline";
import { StubTerminal } from "./stub-terminal";

/** 훅을 단 `Readline`을 `StubTerminal`에 활성화한다. */
function setup(onKeyEvent?: ReadlineOptions["onKeyEvent"]) {
  const term = new StubTerminal(20, 8);
  const readline = new Readline({ persist: false, onKeyEvent });
  readline.activate(readline_term(term));
  return { term, readline };
}

/** `StubTerminal`을 `Readline.activate`가 받는 xterm `Terminal` 타입으로 단언한다. */
function readline_term(term: StubTerminal) {
  return term as unknown as Parameters<Readline["activate"]>[0];
}

// Shift+Enter keydown 이벤트
const SHIFT_ENTER_KEYDOWN = { key: "Enter", shiftKey: true, type: "keydown" };

describe("onKeyEvent 훅", () => {
  test("훅이 true면 Shift+Enter가 무시되고 xterm에 false를 돌려준다", () => {
    const { term, readline } = setup(() => true);
    void readline.read("> ");
    term.type("ab");

    const result = term.fireKeyEvent(SHIFT_ENTER_KEYDOWN);

    expect(result).toBe(false);
    expect(readline.getLine()).toBe("ab");
  });

  test("훅이 false면 Shift+Enter가 원본 동작대로 개행을 삽입한다", () => {
    const { term, readline } = setup(() => false);
    void readline.read("> ");
    term.type("ab");

    const result = term.fireKeyEvent(SHIFT_ENTER_KEYDOWN);

    expect(result).toBe(false);
    expect(readline.getLine()).toBe("ab\n");
  });

  test("훅이 없으면 원본 동작대로 개행을 삽입한다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("ab");

    const result = term.fireKeyEvent(SHIFT_ENTER_KEYDOWN);

    expect(result).toBe(false);
    expect(readline.getLine()).toBe("ab\n");
  });

  test("keyup 이벤트도 훅에 전달된다(event.type 확인)", () => {
    const seenTypes: string[] = [];
    const { term } = setup((event) => {
      seenTypes.push(event.type);
      return false;
    });

    term.fireKeyEvent({ key: "a", type: "keydown" });
    term.fireKeyEvent({ key: "a", type: "keyup" });

    expect(seenTypes).toEqual(["keydown", "keyup"]);
  });
});
