/**
 * `createRepl`의 `input()` 읽기 시험(RD-006). 각 시험을 write 콜백 동기·비동기 두 모드로 돌린다.
 *
 * 대상:
 * - worker의 `readInput` 알림 → 꼬리 프롬프트로 stdin 읽기 → 메일박스 `deliver`·`fail`.
 * - 열린 REPL 읽기와의 순서(read-guard).
 * - stdin 읽기 취소(CANCELLED).
 *
 * 실제 `Atomics.wait` 왕복은 core `test/protocol/thread-scenario.test.ts`가 본다.
 */
import { describe, expect, test, vi } from "vitest";
import { Readline } from "@cp949/runo-xterm-readline";
import {
  startSession,
  startRead,
  flushRequestCount,
  drainReadStart,
  startInputRead,
  takeResponse,
  peek,
  slots,
  echoes,
  observe,
  settle,
  waitFor,
  useReplHarness,
} from "./harness";

useReplHarness();

describe.each([
  { mode: "동기", asyncWrite: false },
  { mode: "비동기", asyncWrite: true },
])("input() 읽기(write 콜백이 $mode 모드일 때)", ({ asyncWrite }) => {
  // 실제 `Readline.read`를 그대로 부르면서 받은 프롬프트를 기록한다.
  // 프로토타입 메서드라 addon 인스턴스에도 적용된다.
  function spyPrompts() {
    const read = vi.spyOn(Readline.prototype, "read");
    return () => read.mock.calls.map(([prompt]) => prompt);
  }

  test("readInput 알림에 직전 출력의 꼬리를 프롬프트로 한 줄을 읽어 메일박스에 전달한다", async () => {
    const session = startSession({}, { asyncWrite });
    const prompts = spyPrompts();
    session.workerRpc.notify("write", "x: ");
    await startInputRead(session);

    session.fake.type("abc\r");
    const response = await takeResponse(session);

    expect(prompts()).toEqual(["x: "]);
    expect(response).toEqual({ kind: "line", text: "abc" });
    // 프롬프트와 입력이 Enter 때 한 조각으로 다시 그려진다. 화면에는 `x: abc` 한 줄이 남는다.
    expect(session.fake.written).toContain("x: abc");
  });

  test("REPL 읽기가 열려 있는 동안 도착한 readInput은 그 줄을 Enter한 뒤에 시작하고 REPL 줄은 REPL 응답이 된다", async () => {
    const session = startSession({}, { asyncWrite });
    const { fake, workerRpc } = session;
    const prompts = spyPrompts();
    const { line } = await startRead(session);
    const outcome = observe(line);

    // 프롬프트를 기다리는 사이 배경 콜백의 `input("bg> ")`가 프롬프트를 쓰고 stdin 읽기를 요청한다.
    workerRpc.notify("write", "bg> ");
    workerRpc.notify("readInput", true);
    await settle();
    expect(prompts()).toEqual([">>> "]);
    expect(peek(session)).toEqual({ kind: "none" });
    expect(outcome().state).toBe("pending");

    // 사용자가 REPL 줄을 친다.
    // - 이 줄은 REPL 응답이 된다.
    // - stdin 읽기는 그 뒤에 배경 프롬프트(`bg> `)로 시작한다.
    // 배경 출력의 재그리기(write 콜백)를 먼저 끝낸다.
    // 비동기 모드에서 남겨 두면 친 키가 벤더 큐에 쌓인다. 실 xterm은 콜백이 스스로 온다.
    fake.flush();
    const before = flushRequestCount(fake);
    fake.type("x = 41\r");
    await drainReadStart(fake, before);
    await waitFor(() => outcome().state === "resolved");
    expect(outcome()).toEqual({ state: "resolved", value: "x = 41" });
    expect(prompts()).toEqual([">>> ", "bg> "]);
    expect(peek(session)).toEqual({ kind: "none" });

    fake.type("hello\r");
    await expect(takeResponse(session)).resolves.toEqual({
      kind: "line",
      text: "hello",
    });
  });

  test("겹치는 readLine 요청의 거절이 read-guard의 활성 REPL 읽기 추적을 깨지 않는다", async () => {
    const session = startSession({}, { asyncWrite });
    const { fake, workerRpc } = session;
    const prompts = spyPrompts();
    const { line: first } = await startRead(session);
    const second = observe(workerRpc.call("readLine", ">>> ", undefined, true));
    await waitFor(() => second().state === "rejected");

    // 거절된 요청을 가드가 활성 읽기로 추적하면 진짜 활성 REPL 읽기를 잃는다.
    // 그러면 stdin 읽기가 앞당겨진다.
    workerRpc.notify("readInput", true);
    await settle();
    expect(prompts()).toEqual([">>> "]);

    const before = flushRequestCount(fake);
    fake.type("ok\r");
    await drainReadStart(fake, before);
    await expect(first).resolves.toBe("ok");
    expect(prompts()).toEqual([">>> ", ""]);
    fake.type("hello\r");
    await expect(takeResponse(session)).resolves.toEqual({
      kind: "line",
      text: "hello",
    });
  });

  test("dispose하면 대기 중인 stdin 읽기가 끝나도 메일박스를 쓰지 않고 오류도 내지 않는다", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const session = startSession({}, { asyncWrite });
    session.workerRpc.notify("write", "x: ");
    await startInputRead(session);

    // `readline.dispose()`가 대기 중인 읽기를 reject한다.
    // dispose된 세션의 worker는 이미 terminate됐으므로 `fail`하지 않는다.
    session.handle.dispose();
    session.fake.flush();
    await settle();

    expect(peek(session)).toEqual({ kind: "none" });
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("읽기가 dispose 밖의 이유로 실패하면 fail로 worker를 깨워 사유를 알린다", async () => {
    const session = startSession({}, { asyncWrite });
    vi.spyOn(Readline.prototype, "read").mockRejectedValueOnce(
      new Error("읽기 실패"),
    );

    session.workerRpc.notify("readInput", true);
    const response = await takeResponse(session);

    if (response.kind !== "error")
      throw new Error(`unexpected kind: ${response.kind}`);
    expect(response.message).toContain("읽기 실패");
  });

  test("stdin 읽기 중 Ctrl+C는 `^C` 없이 읽기를 취소해 메일박스를 CANCELLED로 만든다", async () => {
    const session = startSession({}, { asyncWrite });
    const { fake } = session;
    session.workerRpc.notify("write", "x: ");
    await startInputRead(session);

    fake.type("ab\x03");
    fake.flush();
    await expect(takeResponse(session)).resolves.toEqual({ kind: "cancelled" });

    expect(session.bytes()).toContain("ab");
    expect(session.bytes()).not.toContain("^C");
    // 취소는 main이 메일박스로만 알린다. 이 경로에서 main은 SIGINT를 쓰지 않는다.
    // stdin 취소의 SIGINT는 worker의 stdin 콜백이 쓴다(03-ctrl-c.md 2.2).
    expect(slots(session).seq).toBe(0);
  });

  test("`input()` 취소 직후의 Ctrl+C는 게이트가 열려 있어 에코하고 전송한다", async () => {
    const session = startSession({}, { asyncWrite });
    const { fake } = session;
    session.workerRpc.notify("write", "x: ");
    await startInputRead(session);
    fake.type("ab\x03");
    fake.flush();
    await expect(takeResponse(session)).resolves.toEqual({ kind: "cancelled" });
    // `inputReadsPending`은 `cancel()`이 끝난 뒤에 내려간다.
    await settle();

    fake.type("\x03");

    // 취소 뒤에도 사용자 코드(`except KeyboardInterrupt` 뒤 계산)가 계속 돌 수 있다.
    // 그래서 이 구간의 Ctrl+C는 중단 경로다.
    expect(echoes(session)).toBe(1);
    expect(slots(session).seq).toBe(1);
  });
});
