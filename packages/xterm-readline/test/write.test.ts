/**
 * `Readline.write` 시험.
 * - `\n`은 `\r\n`으로 바꿔 쓴다. 연속한 `\n`도 모두 바꾼다.
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
