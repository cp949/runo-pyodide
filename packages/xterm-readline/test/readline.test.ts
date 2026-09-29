/**
 * `Readline` 통합 시험.
 * 가짜 xterm `StubTerminal`을 쓴다. 가짜는 `onData`·`onResize`·`attachCustomKeyEventHandler`·
 * `write(text, cb)`를 제공하고, `buffer.active.cursorY`는 마지막으로 쓴 LF 행이다.
 * - `read()` 시점의 앵커 flush.
 * - `onData` 입력 → `State` → 화면 갱신.
 * - 탭 처리.
 * - `onResize` 재배치.
 */
import { expect, test } from "vitest";
import { Readline } from "../src/readline";
import { StubTerminal } from "./stub-terminal";

test("read()는 앞선 write가 flush된 뒤의 cursorY를 잡는다", () => {
  const term = new StubTerminal(20, 6);
  const rl = new Readline();
  rl.activate(term as unknown as Parameters<typeof rl.activate>[0]);

  // read() 전에 배너를 찍는다. cursorY가 버퍼를 따라 내려간다.
  rl.println("line1");
  rl.println("line2");
  rl.println("line3");
  // read()를 동기로 부른다. 스텁은 write 콜백을 바로 부른다.
  // 실제 xterm에서는 flush 전에 앵커를 잡지 않도록 read()가 term.write("", cb)로 감싼다.
  // 프롬프트가 배너 바로 아래 행에 놓이고 배너 위에 덮이지 않는지 본다.
  rl.read("> ");
  // VTerm.screen()이 끝 공백을 잘라내므로 커서 위치를 직접 확인한다.
  expect(term.vt.screen().split("\n").slice(0, 3)).toEqual([
    "line1",
    "line2",
    "line3",
  ]);
  expect(term.vt.cursor()).toEqual([3, 2]);
});

test("onData 입력이 State를 움직여 화면을 갱신한다", async () => {
  const term = new StubTerminal(20, 6);
  const rl = new Readline();
  rl.activate(term as unknown as Parameters<typeof rl.activate>[0]);

  const promise = rl.read("> ");
  // 입력 전에 한 틱 양보한다. read() 안의 term.write("", cb) 콜백이 돌아 State가 만들어진 뒤여야 한다.
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

test("onResize는 Tty를 다시 맞추고 활성 읽기를 다시 그린다", () => {
  const term = new StubTerminal(40, 8);
  const rl = new Readline();
  rl.activate(term as unknown as Parameters<typeof rl.activate>[0]);

  rl.read("> ");
  for (const ch of "abc") term.feed(ch);
  expect(term.vt.screen()).toBe("> abc");

  // 20x4로 줄여도 그려 둔 버퍼가 그대로 보여야 한다.
  term.resize(20, 4);
  expect(term.vt.screen()).toBe("> abc");
  expect(term.vt.cursor()).toEqual([0, 5]);
});
