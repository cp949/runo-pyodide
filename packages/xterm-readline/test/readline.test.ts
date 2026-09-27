// Integration tests for Readline against a stub xterm-like Terminal that
// exposes onData, onResize, attachCustomKeyEventHandler, write(text, cb),
// and a buffer.active.cursorY readable as the last LF row written. These
// cover the read()-time anchor flush and the onResize end-to-end path.

import { expect, test } from "vitest";
import { Readline } from "../src/readline";
import { StubTerminal } from "./stub-terminal";

test("read() samples cursorY *after* prior writes have flushed", () => {
  const term = new StubTerminal(20, 6);
  const rl = new Readline();
  rl.activate(term as unknown as Parameters<typeof rl.activate>[0]);

  // Print a banner before read(); cursorY should advance through the buffer.
  rl.println("line1");
  rl.println("line2");
  rl.println("line3");
  // Synchronously call read(); our stub's write callback fires immediately,
  // but in production read() is wrapped in term.write("", cb) precisely so
  // the anchor isn't sampled before flush. Verify the prompt lands on the
  // row directly under the banner, not on top of it.
  rl.read("> ");
  // Trailing spaces are trimmed by VTerm.screen(); check cursor position
  // directly to confirm the prompt landed under the banner, not on top.
  expect(term.vt.screen().split("\n").slice(0, 3)).toEqual([
    "line1",
    "line2",
    "line3",
  ]);
  expect(term.vt.cursor()).toEqual([3, 2]);
});

test("typing through onData drives State and updates the screen", async () => {
  const term = new StubTerminal(20, 6);
  const rl = new Readline();
  rl.activate(term as unknown as Parameters<typeof rl.activate>[0]);

  const promise = rl.read("> ");
  // Yield once so read()'s internal term.write("", cb) callback runs and
  // the State is constructed before we feed input.
  await Promise.resolve();

  for (const ch of "hello") term.feed(ch);
  expect(term.vt.screen()).toBe("> hello");
  term.feed("\r"); // Enter
  expect(await promise).toBe("hello");
});

test("붙여넣은 탭을 버퍼에 보존한다", async () => {
  const term = new StubTerminal(40, 8);
  const rl = new Readline();
  rl.activate(term as unknown as Parameters<typeof rl.activate>[0]);

  rl.read("> ");
  await Promise.resolve();

  term.feed("if x:\r\tpass");
  expect(rl.getLine()).toBe("if x:\n\tpass");
});

test("단독 탭 키는 여전히 무시한다", async () => {
  const term = new StubTerminal(40, 8);
  const rl = new Readline();
  rl.activate(term as unknown as Parameters<typeof rl.activate>[0]);

  rl.read("> ");
  await Promise.resolve();

  term.feed("\t");
  expect(rl.getLine()).toBe("");
});

test("onResize re-fits Tty and re-renders the active read", () => {
  const term = new StubTerminal(40, 8);
  const rl = new Readline();
  rl.activate(term as unknown as Parameters<typeof rl.activate>[0]);

  rl.read("> ");
  for (const ch of "abc") term.feed(ch);
  expect(term.vt.screen()).toBe("> abc");

  // Shrink to 20x4 — the rendered buffer should still be visible and valid.
  term.resize(20, 4);
  expect(term.vt.screen()).toBe("> abc");
  expect(term.vt.cursor()).toEqual([0, 5]);
});
