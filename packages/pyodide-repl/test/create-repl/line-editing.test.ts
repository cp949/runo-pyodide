/**
 * `createRepl` 줄 편집 시험(RD-003·RD-005). worker 역할 rpc가 `readLine`을 요청하면 main이 실제 `Readline`으로 한 줄을 읽어
 * 응답한다. 에코·편집 키·history·꼬리 프롬프트·자동 들여쓰기 프리필과 dispose 뒤의 안전성을 write 콜백 동기/비동기 모드로 본다.
 * history는 메모리에만 두고 `localStorage`를 읽거나 쓰지 않는다.
 */
import { describe, expect, test, vi } from "vitest";
import { Readline } from "@cp949/runo-xterm-readline";
import { createRepl } from "../../src/index";
import { createFakeTerminal } from "@repo/pyodide-testkit/fake-terminal";
import {
  createWorker,
  startSession,
  startRead,
  startInputRead,
  observe,
  tick,
  settle,
  waitFor,
  useReplHarness,
} from "./harness";

useReplHarness();

describe.each([
  { mode: "동기", asyncWrite: false },
  { mode: "비동기", asyncWrite: true },
])("write 콜백이 $mode 모드일 때", ({ asyncWrite }) => {
  test("타이핑한 글자를 터미널에 에코하고 Enter로 그 줄을 worker에게 돌려준다", async () => {
    const session = startSession({}, { asyncWrite });

    const { line } = await startRead(session);
    session.fake.type("abc\r");

    await expect(line).resolves.toBe("abc");
    expect(session.bytes()).toContain("abc");
  });

  test("Backspace와 방향키(←/→)로 고친 줄을 돌려준다", async () => {
    const session = startSession({}, { asyncWrite });

    const { line } = await startRead(session);
    // "acd" → ←← → a 뒤에 "b" 삽입 → "abcd" → → → Backspace가 c를 지움 → "abd"
    session.fake.type("acd\x1b[D\x1b[Db\x1b[C\x7f\r");

    await expect(line).resolves.toBe("abd");
  });

  test("↑/↓로 이전에 입력한 줄을 불러온다", async () => {
    const session = startSession({}, { asyncWrite });
    const { line: first } = await startRead(session);
    session.fake.type("one\r");
    await first;
    const { line: second } = await startRead(session);
    session.fake.type("two\r");
    await second;

    const { line: third } = await startRead(session);
    // ↑ two, ↑ one, ↓ two
    session.fake.type("\x1b[A\x1b[A\x1b[B\r");

    await expect(third).resolves.toBe("two");
  });

  test("worker의 readLine 요청에 직전 출력의 꼬리와 프롬프트를 이어 그린다(`t>>> `)", async () => {
    const session = startSession({}, { asyncWrite });
    session.workerRpc.notify("write", "t");

    await startRead(session);

    expect(session.bytes()).toContain("t\x1b[0m>>> ");
  });

  test("worker가 요청한 프롬프트(`... `)를 그대로 그린다", async () => {
    const session = startSession({}, { asyncWrite });

    await startRead(session, "... ");

    expect(session.bytes()).toContain("... ");
    expect(session.bytes()).not.toContain(">>> ");
  });

  test("빈 줄 Enter는 null(취소)이 아니라 빈 문자열로 응답한다", async () => {
    const session = startSession({}, { asyncWrite });

    const { line } = await startRead(session);
    session.fake.type("\r");

    await expect(line).resolves.toBe("");
  });

  test("readLine 요청의 pending은 자동 들여쓰기 프리필로 리더까지 전달된다(RD-013)", async () => {
    const session = startSession({}, { asyncWrite });

    const { line } = await startRead(session, "... ", "for i in range(2):");
    session.fake.type("print(i)\r");

    await expect(line).resolves.toBe("    print(i)");
  });

  test("공백뿐인 제출은 history에 남지 않는다(skipBlankHistory)", async () => {
    const session = startSession({}, { asyncWrite });
    const { line: first } = await startRead(session);
    session.fake.type("real\r");
    await first;

    const { line: second } = await startRead(session);
    session.fake.type("   \r");
    await expect(second).resolves.toBe("   ");

    // 공백뿐인 제출이 history에 남았다면 ↑는 "   "을 먼저 불러온다. 기록되지 않았으니 바로 "real"이다.
    const { line: third } = await startRead(session);
    session.fake.type("\x1b[A\r");

    await expect(third).resolves.toBe("real");
  });

  test("stdin 읽기(input())에는 프리필도 onKey도 없다(확정 4)", async () => {
    const session = startSession({}, { asyncWrite });
    const readSpy = vi.spyOn(Readline.prototype, "read");

    await startInputRead(session);

    const lastCall = readSpy.mock.calls.at(-1);
    expect(lastCall?.[1]).toEqual({ cancelable: true, eof: true });
  });

  test("dispose하면 대기 중인 읽기가 끝나 뒤늦은 입력이 터미널에 쓰이지 않고 worker에 응답도 가지 않는다", async () => {
    const session = startSession({}, { asyncWrite });
    const { handle, fake } = session;
    const { line } = await startRead(session);
    const outcome = observe(line);

    handle.dispose();
    const writtenAtDispose = fake.written.length;
    fake.type("abc\r");
    await settle();

    expect(fake.written).toHaveLength(writtenAtDispose);
    // RPC가 닫혀 응답이 오지 않는다(응답이 갔다면 "abc"가 그대로 돌아온다).
    expect(outcome().state).toBe("pending");
  });

  test("dispose 뒤 도착한 readLine 요청은 터미널에 쓰지 않는다", async () => {
    const { handle, fake, workerRpc } = startSession({}, { asyncWrite });
    handle.dispose();
    const writtenAtDispose = fake.written.length;

    // 응답은 오지 않으므로 promise는 결과를 보지 않고 observe로만 붙여 둔다.
    observe(workerRpc.call("readLine", ">>> ", undefined, true));
    fake.flush();
    await settle();

    expect(fake.written).toHaveLength(writtenAtDispose);
  });

  // StrictMode의 mount → cleanup 순서: 읽기를 시작하자마자 dispose하고, 이어서 terminal.dispose()가 addon을 다시 dispose한다.
  test("dispose 직후 terminal.dispose()가 addon을 다시 dispose해도 안전하고 뒤늦은 콜백이 해제된 buffer를 읽지 않는다", async () => {
    const { handle, fake, workerRpc } = startSession({}, { asyncWrite });
    observe(workerRpc.call("readLine", ">>> ", undefined, true));
    await waitFor(() => fake.written.includes(""));

    handle.dispose();
    expect(() => fake.term.dispose()).not.toThrow();
    fake.flush();
    await tick();

    expect(fake.disposedBufferReads).toBe(0);
  });

  test("폭을 넘는 꼬리를 정리하려고 flush를 기다리는 중에 dispose해도 뒤늦은 콜백이 해제된 buffer를 읽지 않는다", async () => {
    const { handle, fake, workerRpc } = startSession({}, { asyncWrite });
    // 100자 꼬리는 짧지 않아 `rewindTail`이 flush를 기다린다(비동기 모드에서는 그 콜백이 dispose 뒤에 온다).
    workerRpc.notify("write", "x".repeat(100));
    observe(workerRpc.call("readLine", ">>> ", undefined, true));
    await waitFor(() => fake.written.includes(""));

    handle.dispose();
    expect(() => fake.term.dispose()).not.toThrow();
    fake.flush();
    await tick();
    fake.flush();

    expect(fake.disposedBufferReads).toBe(0);
  });
});

test("dispose는 호출자가 소유한 Terminal을 dispose하지 않는다", () => {
  const fake = createFakeTerminal();
  const terminalDispose = vi.spyOn(fake.term, "dispose");
  const repl = createRepl({ terminal: fake.term, createWorker });

  repl.dispose();

  expect(terminalDispose).not.toHaveBeenCalled();
});

describe("history 저장", () => {
  test("저장된 history를 복원하지도 덮어쓰지도 않고 메모리에서만 이전 줄을 불러온다", async () => {
    localStorage.setItem("history", JSON.stringify(["old"]));
    const session = startSession();
    const { line: first } = await startRead(session);
    session.fake.type("new\r");
    await first;

    const { line: second } = await startRead(session);
    // ↑를 두 번 눌러도 "new"에서 멈춘다. 저장된 "old"를 복원했다면 두 번째 ↑가 "old"를 불러온다.
    session.fake.type("\x1b[A\x1b[A\r");

    await expect(second).resolves.toBe("new");
    expect(localStorage.getItem("history")).toBe(JSON.stringify(["old"]));
  });
});
