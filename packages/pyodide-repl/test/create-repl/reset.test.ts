/**
 * `createRepl`의 `reset()`과 크래시 감지 시험(RD-010). 리셋은 옛 세션을 cancelRead → rpc dispose → worker.terminate 순서로
 * 끝내고 새 interrupt buffer·메일박스·sink 세트로 새 worker를 시작한다. 화면·history는 리셋을 넘어 산다. worker `error`
 * 이벤트는 `onStatus('crashed')`·`onCrash`가 되고 그 뒤 Ctrl+C·미뤄진 stdin 읽기를 막는다.
 */
import { describe, expect, test, vi } from "vitest";
import { Readline } from "@cp949/runo-xterm-readline";
import { createRepl, RESET_NOTICE } from "../../src/index";
import { SIGNAL } from "@cp949/runo-pyodide-core";
import { createFakeTerminal } from "@repo/pyodide-testkit/fake-terminal";
import {
  createFakeWorker,
  startSession,
  startResettableSession,
  startRead,
  flushRequestCount,
  startInputRead,
  peek,
  slotsOf,
  slots,
  echoes,
  observe,
  must,
  settle,
  waitFor,
  readyPayload,
  trackHandle,
  useReplHarness,
} from "./harness";

useReplHarness();

describe("reset()(RD-010)", () => {
  test("reset은 cancelRead → rpc dispose(port.close) → worker.terminate 순서로 옛 세션을 끝내고, 새 buffer로 시작하며 옛 송신기도 멈춘다", async () => {
    const cancelReadSpy = vi.spyOn(Readline.prototype, "cancelRead");
    const closeSpy = vi.spyOn(MessagePort.prototype, "close");

    const session = startResettableSession();
    const oldWorker = must(session.workers[0]);
    session.workerRpc.notify("write", "t");
    await waitFor(() => session.bytes() === "t");

    // 가짜 worker는 SIGINT를 소비(ack)하지 않는다 — 송신기가 살아 있다면 5ms마다 재전송한다.
    session.fake.type("\x03");
    const buffer = oldWorker.frame().interruptBuffer;
    await waitFor(() => Atomics.load(buffer, SIGNAL) === 2);
    cancelReadSpy.mockClear();
    closeSpy.mockClear();

    session.handle.reset();

    // 옛 buffer는 아무도 지우지 않는다(옛 worker가 자기 buffer만 읽으므로 새 세션과 섞이지 않는다). 새 세션은 깨끗한 buffer로 시작한다.
    expect(Atomics.load(buffer, SIGNAL)).toBe(2);
    expect(slotsOf(must(session.workers[1]).frame().interruptBuffer)).toEqual({
      signal: 0,
      ack: 0,
      seq: 0,
    });
    // reset()의 settle 호출이 먼저, core 세션 terminate 훅의 호출(열린 읽기가 이미 끝나 무동작)이 뒤다.
    expect(cancelReadSpy).toHaveBeenCalledTimes(2);
    expect(cancelReadSpy.mock.calls[0]).toEqual([{ settle: true }]);
    expect(cancelReadSpy.mock.calls[1]).toEqual([]);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(must(cancelReadSpy.mock.invocationCallOrder[0])).toBeLessThan(
      must(closeSpy.mock.invocationCallOrder[0]),
    );
    expect(must(closeSpy.mock.invocationCallOrder[0])).toBeLessThan(
      must(oldWorker.terminate.mock.invocationCallOrder[0]),
    );

    // 송신기가 멈췄으면 소실을 흉내 내도(SIGNAL만 0) 잠시 뒤에 되살아나지 않는다(재전송 없음, TRP-009 계승).
    Atomics.store(buffer, SIGNAL, 0);
    await settle();
    expect(Atomics.load(buffer, SIGNAL)).toBe(0);
  });

  test("reset은 새 interruptBuffer를 새 프레임에 싣고 createWorker를 다시 부르며, 옛 worker만 terminate된다", () => {
    const session = startResettableSession();
    const oldWorker = must(session.workers[0]);
    const buffer = oldWorker.frame().interruptBuffer;

    session.handle.reset();

    expect(session.createWorkerSpy).toHaveBeenCalledTimes(2);
    expect(session.workers).toHaveLength(2);
    const newWorker = must(session.workers[1]);
    // 옛 worker는 terminate 뒤에도 한동안 살아 같은 buffer의 SIGINT를 가로챌 수 있다(TRP-049). 세션마다 다른 SharedArrayBuffer여야 한다.
    const newBuffer = newWorker.frame().interruptBuffer;
    expect(newBuffer.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(newBuffer.buffer).not.toBe(buffer.buffer);
    expect(oldWorker.terminate).toHaveBeenCalledTimes(1);
    expect(newWorker.terminate).not.toHaveBeenCalled();
  });

  test("리셋 뒤 Ctrl+C는 새 buffer에만 SIGINT를 쓰고 옛 buffer 슬롯은 리셋 시점 값 그대로다", async () => {
    const session = startResettableSession();
    const oldBuffer = must(session.workers[0]).frame().interruptBuffer;
    // 옛 세션이 SIGINT를 받은 채(소비되지 않음) 리셋된다.
    session.fake.type("\x03");
    await waitFor(() => Atomics.load(oldBuffer, SIGNAL) === 2);
    const oldAtReset = slotsOf(oldBuffer);

    session.handle.reset();
    const newBuffer = must(session.workers[1]).frame().interruptBuffer;
    session.fake.type("\x03");
    await settle();

    expect(slotsOf(newBuffer)).toEqual({ signal: 2, ack: 0, seq: 1 });
    expect(slotsOf(oldBuffer)).toEqual(oldAtReset);
  });

  test("reset은 새 sink 세트·메일박스로 시작해 이전 꼬리·메일박스 값을 물려받지 않는다", async () => {
    const session = startResettableSession();
    session.workerRpc.notify("write", "t");
    await waitFor(() => session.bytes() === "t");
    const oldStdinData = must(session.workers[0]).frame().stdinData;

    session.handle.reset();
    await startRead(session);

    expect(session.bytes()).toContain(RESET_NOTICE);
    // 새 세션의 프롬프트가 옛 세션의 꼬리("t")를 이어 그리지 않는다(`t\x1b[0m>>> ` 형태가 되지 않는다, `line-editing.test.ts`의 꼬리 프롬프트 시험과 대조).
    expect(session.bytes()).not.toContain("t\x1b[0m>>> ");
    const afterNotice = session
      .bytes()
      .slice(session.bytes().indexOf(RESET_NOTICE));
    expect(afterNotice).toContain(">>> ");
    expect(must(session.workers[1]).frame().stdinData.buffer).not.toBe(
      oldStdinData.buffer,
    );
  });

  test("reset은 loading을 동기로 발행하고 새 worker의 ready 알림에 ready를 발행한다", async () => {
    const session = startResettableSession();
    session.onStatus.mockClear();

    session.handle.reset();

    expect(session.onStatus.mock.calls.at(-1)).toEqual(["loading"]);

    session.workerRpc.notify("ready", readyPayload());
    await waitFor(() => session.onStatus.mock.calls.at(-1)?.[0] === "ready");

    expect(session.onStatus.mock.calls.at(-1)).toEqual(["ready"]);
  });

  test("리셋 안내 줄: 꼬리가 있으면 개행 뒤에, 없으면 바로 그려진다(TRP-006)", async () => {
    const session = startResettableSession();

    // 리셋 시점에 아직 열린 읽기가 없다(worker의 첫 readLine 요청 전) — 미종결 출력으로 현재 io 꼬리를 만든다.
    session.workerRpc.notify("write", "t");
    await waitFor(() => session.bytes().includes("t"));
    const before1 = session.fake.written.length;
    session.handle.reset();
    const written1 = session.fake.written.slice(before1).join("");
    expect(written1.startsWith("\r\n")).toBe(true);
    expect(written1).toContain(RESET_NOTICE);

    // 새 세션(reset이 방금 만들었다)은 아직 아무 출력도 없어 꼬리가 비어 있다.
    const before2 = session.fake.written.length;
    session.handle.reset();
    const written2 = session.fake.written.slice(before2).join("");
    expect(written2.startsWith("\r\n")).toBe(false);
    expect(written2).toContain(RESET_NOTICE);
  });

  // DELTA-05(최종 리뷰 발견): `promptRow.endRead`(reset 경로)도 breakLine·notice와 같은 꼬리 판정 함수를
  // 쓴다 — SGR만 남은 꼬리를 "꼬리 있음"으로 잘못 보면 불필요한 개행이 안내 앞에 남는다(수정 전이면 RED).
  test("SGR만 남은 꼬리(색 안 닫고 개행으로 끝난 출력)에서 reset해도 안내 앞에 불필요한 개행이 생기지 않는다(회귀)", async () => {
    const session = startResettableSession();

    // 열린 읽기가 없다(worker의 첫 readLine 요청 전) — 색을 안 닫고 개행으로 끝난 출력으로 SGR-only 꼬리를 만든다.
    session.workerRpc.notify("write", "\x1b[31mred\n");
    await waitFor(() => session.bytes().includes("red"));
    const before = session.fake.written.length;

    session.handle.reset();

    const written = session.fake.written.slice(before).join("");
    expect(written.startsWith("\r\n")).toBe(false);
    expect(written).toContain(RESET_NOTICE);
  });

  // B1(design.md §5): 그리기 전 창(write 콜백 대기 중)에서 reset하면 그리기 전 읽기가 있었으므로 무조건 개행한다 —
  // 열린 읽기가 없을 때(꼬리 기준)와 달리 꼬리가 비어 있어도 안내 앞에 개행이 하나 생긴다(Q3, 화면 바이트 변경 수용).
  test("B1: 그리기 전 창(>>> 읽기 콜백 전)에서 reset하면 꼬리가 비어 있어도 안내 앞에 개행이 하나 생긴다", async () => {
    const session = startResettableSession({}, { asyncWrite: true });
    const { fake, workerRpc } = session;
    const flushRequests = () =>
      fake.written.filter((text) => text === "").length;
    const before = flushRequests();
    const line = workerRpc.call<string | null>(
      "readLine",
      ">>> ",
      undefined,
      true,
    );
    void line.catch(() => {});
    await waitFor(() => flushRequests() > before);
    // flush하지 않는다 — 프롬프트가 아직 그려지지 않은 상태(그리기 전 읽기, hasPendingRead() true)에서 reset한다.
    const beforeWritten = fake.written.length;

    session.handle.reset();

    const written = fake.written.slice(beforeWritten).join("");
    expect(written.startsWith("\r\n")).toBe(true);
    expect(written).toContain(RESET_NOTICE);
  });

  test("reset은 옛 세션의 열린 readLine 읽기를 응답 없이 끝내고 새 세션의 첫 readLine 요청을 받는다", async () => {
    const session = startResettableSession();
    const { line: oldLine } = await startRead(session);
    const oldOutcome = observe(oldLine);

    session.handle.reset();
    await settle();

    expect(oldOutcome()).toEqual({ state: "pending" });

    // "이미 읽는 중"으로 거절되지 않고 새 세션의 첫 readLine이 정상 시작된다(읽기 phase는 세션마다 새로 시작).
    const { line: newLine } = await startRead(session);
    session.fake.type("ok\r");

    await expect(newLine).resolves.toBe("ok");
  });

  test("리셋 뒤 새 세션의 prefill은 4칸이다(옛 세션이 2칸 블록을 본 뒤에도, RD-013)", async () => {
    const session = startResettableSession();
    // 옛 세션에 2칸 들여쓰기 블록을 보여 lastUsedIndentation을 "  "로 만든다(worker가 보낼 pending을 하니스가 직접 준다).
    const { line: old } = await startRead(session, "... ", "if True:\n  x=1");
    session.fake.type("\r");
    await old;

    session.handle.reset();

    const { line: fresh } = await startRead(
      session,
      "... ",
      "for i in range(2):",
    );
    session.fake.type("print(i)\r");

    await expect(fresh).resolves.toBe("    print(i)");
  });

  test("reset은 열린 input() 읽기를 끝내되 옛 메일박스에 fail을 쓰지 않는다(TRP-003)", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const session = startResettableSession();
    session.workerRpc.notify("write", "x: ");
    await startInputRead(session);
    const oldWorker = must(session.workers[0]);

    session.handle.reset();
    await settle();

    expect(peek({ fakeWorker: oldWorker })).toEqual({ kind: "none" });
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("취소 응답 뒤(cancelSettling) 리셋하면 새 세션의 첫 Ctrl+C가 에코·전송된다", async () => {
    const session = startResettableSession();
    const { line } = await startRead(session);
    session.fake.type("abc\x03");
    await expect(line).resolves.toBeNull();

    session.handle.reset();
    const newWorker = must(session.workers[1]);
    session.fake.type("\x03");

    expect(echoes(session)).toBe(1);
    expect(slots({ fakeWorker: newWorker }).seq).toBe(1);
  });

  test("ready·terminated·load-failed·loading 상태 어디서든 reset이 새 세션을 만든다", () => {
    const triggers: Array<
      (s: ReturnType<typeof startResettableSession>) => void
    > = [
      () => {}, // loading(기본 상태, ready 알림 전)
      (s) => s.workerRpc.notify("ready", readyPayload()),
      (s) => s.workerRpc.notify("sessionTerminated"),
      (s) => s.workerRpc.notify("loadFailed", "실패"),
    ];
    for (const trigger of triggers) {
      const session = startResettableSession();
      trigger(session);

      session.handle.reset();

      expect(session.workers).toHaveLength(2);
      expect(session.createWorkerSpy).toHaveBeenCalledTimes(2);
      expect(session.onStatus.mock.calls.at(-1)).toEqual(["loading"]);
    }
  });

  test("dispose 뒤 reset은 아무것도 하지 않는다", () => {
    const session = startResettableSession();
    session.handle.dispose();
    const writtenAtDispose = session.fake.written.length;

    expect(() => session.handle.reset()).not.toThrow();

    expect(session.createWorkerSpy).toHaveBeenCalledTimes(1);
    expect(session.fake.written).toHaveLength(writtenAtDispose);
  });

  test("reset 뒤 dispose는 마지막 세션만 끝낸다", () => {
    const session = startResettableSession();
    const oldWorker = must(session.workers[0]);
    session.handle.reset();
    const newWorker = must(session.workers[1]);

    session.handle.dispose();

    expect(oldWorker.terminate).toHaveBeenCalledTimes(1);
    expect(newWorker.terminate).toHaveBeenCalledTimes(1);
  });

  test("not-isolated에서 reset은 no-op이다", () => {
    vi.stubGlobal("crossOriginIsolated", false);
    const fake = createFakeTerminal();
    const createWorkerSpy = vi.fn(() => createFakeWorker().worker);
    const handle = createRepl({
      terminal: fake.term,
      createWorker: createWorkerSpy,
    });
    trackHandle(handle);
    const writtenBefore = fake.written.length;

    expect(() => handle.reset()).not.toThrow();

    expect(createWorkerSpy).not.toHaveBeenCalled();
    expect(fake.written).toHaveLength(writtenBefore);
  });

  test("history는 reset을 넘어 유지된다(같은 Readline 인스턴스)", async () => {
    const session = startResettableSession();
    const { line } = await startRead(session);
    session.fake.type("kept\r");
    await expect(line).resolves.toBe("kept");

    session.handle.reset();

    const { line: next } = await startRead(session);
    session.fake.type("\x1b[A\r"); // ↑로 이전 history를 불러와 그대로 제출
    await expect(next).resolves.toBe("kept");
  });

  test("[D6] 대조: 미뤄진 stdin 읽기 없이 reset하면 type-ahead가 새 >>> 읽기로 간다(회귀 없음)", async () => {
    const session = startResettableSession({}, { asyncWrite: true });
    await startRead(session);

    session.handle.reset();
    session.fake.flush();
    await settle();
    const afterReset = session.bytes().length;

    session.fake.type("abc");
    session.fake.flush();
    await settle();

    expect(session.bytes().slice(afterReset)).not.toContain(
      "\x1b[?25l\r\x1b[J\x1b[0m\r\x1b[?25h",
    );
    expect(session.bytes().slice(afterReset)).not.toContain("abc");

    const { line } = await startRead(session);
    session.fake.type("\r");
    await expect(line).resolves.toBe("abc");
  });

  test("[D6] 미뤄진 stdin 읽기 중 reset하면 옛 읽기가 새 세션 화면에 열리지 않고 부팅 중 입력은 새 >>> 읽기로 간다(이슈 06)", async () => {
    const session = startResettableSession({}, { asyncWrite: true });
    await startRead(session);
    session.workerRpc.notify("readInput", true);
    await settle(); // read-guard가 미룬다(접두를 뗀다)

    session.handle.reset();
    session.fake.flush();
    await settle();
    const afterReset = session.bytes().length;

    session.fake.type("abc");
    session.fake.flush();
    await settle();

    expect(session.bytes().slice(afterReset)).not.toContain(
      "\x1b[?25l\r\x1b[J\x1b[0m\r\x1b[?25h",
    );
    expect(session.bytes().slice(afterReset)).not.toContain("abc");

    const { line } = await startRead(session);
    session.fake.type("\r");
    await expect(line).resolves.toBe("abc");
  });
});

describe("크래시 감지(RD-010)", () => {
  test("worker error 이벤트는 onStatus('crashed') 뒤 onCrash(message)를 순서대로 부른다", () => {
    const onCrash = vi.fn();
    const session = startSession({ onCrash });

    session.fakeWorker.dispatchError("boom");

    expect(session.onStatus.mock.calls.at(-1)).toEqual(["crashed"]);
    expect(onCrash).toHaveBeenCalledWith("boom");
    const statusOrder = must(session.onStatus.mock.invocationCallOrder.at(-1));
    const crashOrder = must(onCrash.mock.invocationCallOrder.at(-1));
    expect(statusOrder).toBeLessThan(crashOrder);
  });

  test("크래시 뒤 Ctrl+C는 에코도 전송도 하지 않는다", () => {
    const session = startSession();
    session.fake.type("\x03");
    expect(slots(session).seq).toBe(1); // 대조: 크래시 전에는 전송된다

    session.fakeWorker.dispatchError("boom");
    session.fake.type("\x03");

    expect(slots(session).seq).toBe(1);
    expect(echoes(session)).toBe(1);
  });

  test("[D6] 미뤄진 stdin 읽기 중 크래시하면 REPL 읽기를 Enter로 끝내도 새 stdin 읽기가 열리지 않는다", async () => {
    const session = startSession({}, { asyncWrite: true });
    await startRead(session);
    session.workerRpc.notify("readInput", true);
    await settle(); // read-guard가 미룬다(접두를 뗀다)

    session.fakeWorker.dispatchError("boom");
    await waitFor(() => session.onStatus.mock.calls.at(-1)?.[0] === "crashed");

    const before = flushRequestCount(session.fake);
    session.fake.type("x\r");
    session.fake.flush();
    await settle();

    // 미뤄진 stdin 읽기가 REPL 읽기 뒤에 열리려 하면 빈 접두 읽기 그리기(`term.write("", cb)`)가 새로 생긴다.
    expect(flushRequestCount(session.fake)).toBe(before);
    expect(session.bytes()).not.toContain(
      "\x1b[?25l\r\x1b[J\x1b[0m\r\x1b[?25h",
    );

    session.fake.type("abc");
    session.fake.flush();
    await settle();
    expect(session.bytes()).not.toContain("abc");
  });

  test("[R4] 미뤄진 stdin 읽기 중 크래시 → Enter → reset하면 뗀 배경 프롬프트가 자기 행에 남고 안내가 그 아래에 온다(이슈 prompt-row-followups/07)", async () => {
    const session = startResettableSession({}, { asyncWrite: true });
    await startRead(session);
    session.workerRpc.notify("write", "bg> ");
    session.workerRpc.notify("readInput", true);
    await settle();
    session.fake.flush();
    await settle(); // read-guard가 미룬다(접두를 뗀다)

    session.fakeWorker.dispatchError("boom");
    await waitFor(() => session.onStatus.mock.calls.at(-1)?.[0] === "crashed");

    const beforeEnter = session.bytes().length;
    session.fake.type("x\r");
    session.fake.flush();
    await settle();
    session.fake.flush();
    await settle();
    expect(session.bytes().slice(beforeEnter)).toContain("bg> ");

    const beforeReset = session.bytes().length;
    session.handle.reset();
    session.fake.flush();
    await settle();

    const notice = "\x1b[36m[세션 리셋됨";
    const resetBytes = session.bytes().slice(beforeReset);
    expect(resetBytes.slice(0, 2 + notice.length)).toBe(`\r\n${notice}`);
    expect(session.bytes().slice(beforeEnter)).toContain(`bg> \r\n${notice}`);
  });

  test("[R3] 미뤄진 stdin 읽기 중 크래시 → Enter 없이 reset하면 뗀 배경 프롬프트를 그리지 않는다(io가 닫힌 뒤 D6, 현행 유지)", async () => {
    const session = startResettableSession({}, { asyncWrite: true });
    await startRead(session);
    session.workerRpc.notify("write", "bg> ");
    session.workerRpc.notify("readInput", true);
    await settle();
    session.fake.flush();
    await settle();

    session.fakeWorker.dispatchError("boom");
    await waitFor(() => session.onStatus.mock.calls.at(-1)?.[0] === "crashed");

    const beforeReset = session.bytes().length;
    session.handle.reset();
    session.fake.flush();
    await settle();
    session.fake.flush();
    await settle();

    const resetBytes = session.bytes().slice(beforeReset);
    expect(resetBytes).toContain("\x1b[36m[세션 리셋됨");
    expect(resetBytes).not.toContain("bg> ");
  });

  test("크래시 뒤 reset은 새 세션을 만들고 옛 error 리스너를 떼어 낸다", () => {
    const session = startResettableSession();
    const oldWorker = must(session.workers[0]);

    oldWorker.dispatchError("boom");
    expect(session.onStatus.mock.calls.at(-1)).toEqual(["crashed"]);

    session.handle.reset();

    expect(session.workers).toHaveLength(2);
    expect(session.createWorkerSpy).toHaveBeenCalledTimes(2);
    expect(session.onStatus.mock.calls.at(-1)).toEqual(["loading"]);
    expect(oldWorker.removeEventListener).toHaveBeenCalledWith(
      "error",
      expect.any(Function),
    );
  });
});
