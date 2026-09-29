/**
 * `Readline.write`·`writeReady` 시험.
 * - `\n`은 `\r\n`으로 바꿔 쓴다. 연속한 `\n`도 모두 바꾼다.
 * - `writeReady`는 xterm이 아직 처리하지 않은 쓰기 양으로 판정한다. `term`이 없으면 쓰지 않으므로 세지 않는다.
 */
import { describe, expect, test } from "vitest";
import { Readline } from "../src/readline";
import { StubTerminal } from "./stub-terminal";

type Term = Parameters<Readline["activate"]>[0];

function activated(asyncWrite = false) {
  const term = new StubTerminal(20, 6);
  term.asyncWrite = asyncWrite;
  const rl = new Readline();
  rl.activate(term as unknown as Term);
  return { term, rl };
}

describe("write의 줄바꿈 변환", () => {
  test.each([
    ["\n", "\r\n"],
    ["a\nb", "a\r\nb"],
    ["\nb", "\r\nb"],
    ["a\r\nb", "a\r\nb"],
    ["a\n\nb", "a\r\n\r\nb"],
    ["\n\nb", "\r\n\r\nb"],
    ["a\n\n\nb", "a\r\n\r\n\r\nb"],
    ["a\r\n\nb", "a\r\n\r\nb"],
    ["a\n\r\nb", "a\r\n\r\nb"],
  ])("%j를 %j로 쓴다", (text, expected) => {
    const { term, rl } = activated();
    rl.write(text);
    expect(term.log).toEqual([expected]);
  });
});

describe("writeReady", () => {
  test("term이 없으면 쓰지 않으므로 쓰기 양을 세지 않는다", () => {
    const rl = new Readline();
    rl.write("x".repeat(20000));
    expect(rl.writeReady()).toBe(true);
  });

  test("term 없이 쓴 글자가 activate 뒤 쓰기의 판정에 남지 않는다", () => {
    const rl = new Readline();
    rl.write("x".repeat(20000));
    const term = new StubTerminal(20, 6);
    term.asyncWrite = true;
    rl.activate(term as unknown as Term);
    rl.write("y".repeat(10001));
    expect(rl.writeReady()).toBe(false);
    term.flush();
    expect(rl.writeReady()).toBe(true);
  });

  test("상한(10000)을 넘으면 거짓이고 xterm이 처리하면 참이 된다", () => {
    const { term, rl } = activated(true);
    rl.write("x".repeat(10000));
    expect(rl.writeReady()).toBe(true);
    rl.write("x");
    expect(rl.writeReady()).toBe(false);
    term.flush();
    expect(rl.writeReady()).toBe(true);
  });
});
