/**
 * `createRepl`의 Ctrl+C 시험.
 * RD-008: 입력줄 취소. REPL 읽기는 응답 `null`, stdin 읽기는 메일박스 CANCELLED가 되고 둘 다 `^C`를 찍지 않는다. 취소 응답 뒤
 * 다음 요청이 오기 전의 구간(`cancelSettling`)은 게이트를 닫고, `input()` 취소에는 닫지 않는다.
 * RD-007: 실행 중 Ctrl+C. 벤더 `Readline`이 활성 읽기 없이 부르는 `setCtrlCHandler`가 `^C`를 꼬리에 쓰고 프레임의 interrupt
 * buffer에 SIGINT를 쓰는지, 게이트(`pythonRunning`)가 대상 코드가 없는 구간의 눌림을 버리는지, cancel 지점이 송신기의 재전송을
 * 멈추는지 본다. 송신기의 상태기계 자체는 core `protocol/interrupt-sender.test.ts`가 맡는다.
 */
import { describe, expect, test, vi } from "vitest";
import { Readline } from "@cp949/runo-xterm-readline";
import { SIGNAL } from "@cp949/runo-pyodide-core";
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
  tick,
  settle,
  waitFor,
  type Session,
  useReplHarness,
} from "./harness";

useReplHarness();

describe.each([
  { mode: "동기", asyncWrite: false },
  { mode: "비동기", asyncWrite: true },
])(
  "입력줄 Ctrl+C 취소(RD-008), write 콜백이 $mode 모드일 때",
  ({ asyncWrite }) => {
    test("REPL 읽기 중 Ctrl+C는 `^C` 없이 줄을 바꾸고 `null`로 응답한다", async () => {
      const session = startSession({}, { asyncWrite });
      const { fake } = session;
      const { line } = await startRead(session);

      fake.type("abc\x03");
      fake.flush();

      await expect(line).resolves.toBeNull();
      expect(session.bytes()).toContain("abc");
      expect(session.bytes()).not.toContain("^C");
      expect(session.bytes().endsWith("\r\n")).toBe(true);
      // 취소는 응답 `null`로만 알린다. main은 SIGINT를 쓰지 않는다.
      expect(slots(session).seq).toBe(0);
    });

    test("Shift+Enter로 쌓은 여러 줄 버퍼도 `^C` 없이 취소된다", async () => {
      const session = startSession({}, { asyncWrite });
      const { fake } = session;
      const { line } = await startRead(session);

      fake.type("if True:");
      fake.keyDown({ key: "Enter", shiftKey: true });
      fake.type("    print(3)");
      fake.type("\x03");
      fake.flush();

      await expect(line).resolves.toBeNull();
      expect(session.bytes()).toContain("if True:");
      expect(session.bytes()).toContain("print(3)");
      expect(session.bytes()).not.toContain("^C");
      expect(session.bytes().endsWith("\r\n")).toBe(true);
    });

    test("`cancelable`이 거짓인 `readLine` 요청은 벤더 원본대로 `^C`를 찍고 같은 프롬프트를 다시 그린다", async () => {
      const session = startSession({}, { asyncWrite });
      const { fake, workerRpc } = session;
      const before = flushRequestCount(fake);
      const response = observe(
        workerRpc.call("readLine", ">>> ", undefined, false),
      );
      await drainReadStart(fake, before);

      fake.type("abc\x03");
      fake.flush();
      await settle();

      expect(response().state).toBe("pending");
      expect(session.bytes()).toContain("^C");

      fake.type("1\r");
      await waitFor(() => response().state === "resolved");
      expect(response()).toEqual({ state: "resolved", value: "1" });
    });

    test("`cancelable`이 거짓인 `readInput` 알림도 원본대로라 메일박스가 IDLE로 남는다", async () => {
      const session = startSession({}, { asyncWrite });
      const { fake, workerRpc } = session;
      workerRpc.notify("write", "x: ");
      const before = flushRequestCount(fake);
      workerRpc.notify("readInput", false);
      await drainReadStart(fake, before);

      fake.type("ab\x03");
      fake.flush();
      await settle();

      expect(session.bytes()).toContain("^C");
      expect(peek(session)).toEqual({ kind: "none" });
      expect(slots(session).seq).toBe(0);

      fake.type("cd\r");
      await expect(takeResponse(session)).resolves.toEqual({
        kind: "line",
        text: "cd",
      });
    });
  },
);

describe("취소 직후의 게이트(cancelSettling, RD-008)", () => {
  test("취소 응답 뒤 다음 요청이 오기 전의 Ctrl+C는 에코도 전송도 하지 않는다", async () => {
    const session = startSession({}, { asyncWrite: true });
    const { fake } = session;
    const { line } = await startRead(session);
    fake.type("abc\x03");
    fake.flush();
    await expect(line).resolves.toBeNull();

    // 벤더에는 활성 읽기가 없어 이 키는 Ctrl+C 핸들러로 온다. 게이트가 막지 않으면 SIGINT가 남아 다음 push가 죽는다(TRP-009).
    fake.type("\x03");

    expect(echoes(session)).toBe(0);
    expect(slots(session).seq).toBe(0);

    // 정상 복귀: 다음 요청이 오면 읽기가 열리고 그 줄이 응답이 된다.
    const { line: next } = await startRead(session);
    fake.type("1\r");
    await expect(next).resolves.toBe("1");
  });

  test("`readLine` 요청 도착이 방어를 내려 응답 뒤의 Ctrl+C는 다시 전송된다", async () => {
    const session = startSession({}, { asyncWrite: true });
    const { fake } = session;
    const { line } = await startRead(session);
    fake.type("abc\x03");
    fake.flush();
    await expect(line).resolves.toBeNull();

    const { line: next } = await startRead(session);
    fake.type("1\r");
    await expect(next).resolves.toBe("1");

    fake.type("\x03");

    expect(echoes(session)).toBe(1);
    expect(slots(session).seq).toBe(1);
  });

  test("취소 뒤 열린 stdin 읽기가 값을 전달하면(`inputReadsPending` → 0) 방어가 내려간다", async () => {
    const session = startSession({}, { asyncWrite: true });
    const { fake, workerRpc } = session;
    const { line } = await startRead(session);
    // 프롬프트를 기다리는 사이 배경 콜백의 `input()`이 도착한다. 가드가 REPL 읽기 뒤로 미룬다.
    const before = flushRequestCount(fake);
    workerRpc.notify("readInput", true);
    await settle();

    // REPL 읽기를 취소하면 방어가 서고, 가드가 미뤄 둔 stdin 읽기가 열린다.
    fake.type("\x03");
    fake.flush();
    await expect(line).resolves.toBeNull();
    await drainReadStart(fake, before);

    fake.type("abc\r");
    await expect(takeResponse(session)).resolves.toEqual({
      kind: "line",
      text: "abc",
    });
    await settle();

    // 값을 전달한 시점이 worker가 깨어나 사용자 코드를 재개하는 시점이다. 요청 도착만으로 내리면 이 구간이 막힌다.
    fake.type("\x03");
    expect(echoes(session)).toBe(1);
    expect(slots(session).seq).toBe(1);
  });

  test("cancelable 읽기 중 dispose하면 응답이 가지 않고 이후 Ctrl+C는 무동작이다", async () => {
    const session = startSession({}, { asyncWrite: true });
    const { fake } = session;
    const { line } = await startRead(session);
    const outcome = observe(line);
    fake.type("abc");

    session.handle.dispose();
    fake.flush();
    await settle();

    // 읽기는 `Error("readline disposed")`로 끝나지만 dispose가 RPC를 먼저 끊으므로 worker 역할 rpc에는 응답이 오지 않는다.
    expect(outcome().state).toBe("pending");
    const writtenAtDispose = fake.written.length;
    expect(() => fake.type("\x03")).not.toThrow();
    expect(fake.written).toHaveLength(writtenAtDispose);
    expect(slots(session).seq).toBe(0);
  });
});

describe("실행 중 Ctrl+C(RD-007)", () => {
  /** 소실을 흉내 낸다: ack 없이 SIGNAL만 0으로 지운다. 송신기가 살아 있으면 5ms 안에 같은 번호로 다시 쓴다. */
  function loseSignal(session: Pick<Session, "fakeWorker">) {
    Atomics.store(session.fakeWorker.frame().interruptBuffer, SIGNAL, 0);
  }

  /** 상태 콜백이 `loading` 다음 값을 받을 때까지 기다린다. cancel·게이트 갱신이 그 콜백보다 먼저 끝나 있다. */
  const waitNextStatus = (session: Pick<Session, "onStatus">) =>
    waitFor(() => session.onStatus.mock.calls.length === 2);

  test("활성 읽기가 없을 때(로딩 중 포함) Ctrl+C는 `^C`를 쓰고 요청 번호를 올려 SIGINT를 쓴다", async () => {
    // `ready`를 보내지 않아 세션은 아직 로딩 중이다. 부팅 중 눌림도 버퍼에 써져 worker가 폐기한다(boot-press).
    const session = startSession();
    session.workerRpc.notify("write", "t");
    await waitFor(() => session.bytes() === "t");

    session.fake.type("\x03");

    expect(session.bytes()).toBe("t^C");
    expect(slots(session)).toEqual({ signal: 2, ack: 0, seq: 1 });
  });

  test("`^C`는 sink write로 나가 꼬리에 남으므로 다음 프롬프트가 `t^C>>> `로 이어진다", async () => {
    const session = startSession();
    session.workerRpc.notify("write", "t");
    await waitFor(() => session.bytes() === "t");
    session.fake.type("\x03");

    await startRead(session);

    // `readline.print("^C")`로 에코하면 꼬리가 `t`뿐이라 `t>>> `가 되고 `^C`는 프롬프트 밖에 따로 남는다(S1).
    expect(session.bytes()).toContain("t^C\x1b[0m>>> ");
  });

  test("Ctrl+C를 연달아 누르면 눌림마다 `^C`를 쓰고 요청 번호를 하나씩 올린다", () => {
    const session = startSession();

    session.fake.type("\x03\x03\x03");

    expect(session.bytes()).toBe("^C^C^C");
    expect(slots(session)).toEqual({ signal: 2, ack: 0, seq: 3 });
  });

  test("눌림을 보낸 뒤 소실되면(SIGNAL만 0) 송신기가 같은 요청 번호로 다시 쓴다", async () => {
    const session = startSession();
    session.fake.type("\x03");
    loseSignal(session);

    await settle();

    // 재전송은 번호를 올리지 않는다. 이 시험은 송신기가 프레임의 그 버퍼에 배선됐는지만 본다(상태기계는 interrupt-sender 시험).
    expect(slots(session)).toEqual({ signal: 2, ack: 0, seq: 1 });
  });

  test.each([
    { notification: "sessionTerminated", args: [] },
    { notification: "loadFailed", args: ["Error: boom"] },
  ])(
    "$notification 뒤 Ctrl+C는 에코도 전송도 하지 않는다",
    async ({ notification, args }) => {
      const session = startSession();
      session.fake.type("\x03");
      // 대조: 세션이 살아 있는 동안에는 전송된다.
      expect(slots(session).seq).toBe(1);
      session.workerRpc.notify(notification, ...args);
      await waitNextStatus(session);

      session.fake.type("\x03");

      expect(slots(session).seq).toBe(1);
      expect(echoes(session)).toBe(1);
    },
  );

  test("`readLine` 요청이 도착한 뒤 읽기가 활성화되기 전(flush 갭)의 Ctrl+C는 에코도 전송도 하지 않는다", async () => {
    const session = startSession({}, { asyncWrite: true });
    const { fake, workerRpc } = session;
    const before = flushRequestCount(fake);
    const response = observe(
      workerRpc.call("readLine", ">>> ", undefined, true),
    );
    await waitFor(() => flushRequestCount(fake) > before);

    // 읽기 시작 write 콜백이 아직 오지 않아 벤더 `Readline`에는 활성 읽기가 없다. 그래서 이 키는 Ctrl+C 핸들러로 온다.
    fake.type("\x03");
    expect(echoes(session)).toBe(0);
    expect(slots(session).seq).toBe(0);

    fake.flush();
    await tick();
    fake.flush();
    fake.type("1\r");
    await waitFor(() => response().state === "resolved");
    expect(response()).toEqual({ state: "resolved", value: "1" });

    // 응답이 나간 뒤에는 worker가 실행을 재개한 것으로 보고 전송한다.
    fake.type("\x03");
    expect(slots(session).seq).toBe(1);
    expect(echoes(session)).toBe(1);
  });

  test("`readInput` 알림이 도착한 뒤 읽기가 활성화되기 전의 Ctrl+C는 에코도 전송도 하지 않고, 값을 전달한 뒤에는 전송한다", async () => {
    const session = startSession({}, { asyncWrite: true });
    const { fake, workerRpc } = session;
    workerRpc.notify("write", "x: ");
    const before = flushRequestCount(fake);
    workerRpc.notify("readInput", true);
    await waitFor(() => flushRequestCount(fake) > before);

    fake.type("\x03");
    expect(echoes(session)).toBe(0);
    expect(slots(session).seq).toBe(0);

    fake.flush();
    await tick();
    fake.flush();
    fake.type("abc\r");
    await expect(takeResponse(session)).resolves.toEqual({
      kind: "line",
      text: "abc",
    });

    // 메일박스에 값이 실린 시점이 worker가 깨어나 실행을 재개하는 시점이다.
    fake.type("\x03");
    expect(slots(session).seq).toBe(1);
    expect(echoes(session)).toBe(1);
  });

  test("REPL 읽기가 실패로 끝나도 게이트가 다시 열린다", async () => {
    const session = startSession();
    vi.spyOn(Readline.prototype, "read").mockRejectedValueOnce(
      new Error("읽기 실패"),
    );
    const response = observe(
      session.workerRpc.call("readLine", ">>> ", undefined, true),
    );
    await waitFor(() => response().state === "rejected");

    session.fake.type("\x03");

    // 읽기가 줄·취소·실패 어느 쪽으로 끝나든 게이트는 열려야 한다. 닫힌 채 남으면 Ctrl+C가 영영 죽는다.
    expect(slots(session).seq).toBe(1);
  });

  test("`input()` 응답을 아직 다 전달하지 못한 동안(다음 청크 대기) Ctrl+C는 에코도 전송도 하지 않는다", async () => {
    const session = startSession();
    await startInputRead(session);
    // 64KiB를 넘는 줄은 청크로 나뉜다. worker가 첫 청크를 가져가기 전에는 다음 청크를 쓰지 못하고 멈춘다.
    session.fake.paste("x".repeat(70_000));
    session.fake.type("\r");
    await vi.waitFor(() => {
      expect(peek(session)).toMatchObject({ kind: "chunk", last: false });
    });

    session.fake.type("\x03");
    expect(echoes(session)).toBe(0);
    expect(slots(session).seq).toBe(0);

    // worker가 첫 청크를 가져간 것처럼 소비한다 — main이 이어서 마지막 청크를 써 전체 줄을 완성한다.
    // 그 시점에 worker가 깨어나 실행을 재개한다. 그때부터 다시 전송한다.
    await expect(takeResponse(session)).resolves.toEqual({
      kind: "line",
      text: "x".repeat(70_000),
    });
    session.fake.type("\x03");
    expect(slots(session).seq).toBe(1);
  });

  test.each([
    { notification: "sessionTerminated", args: [] },
    { notification: "loadFailed", args: ["Error: boom"] },
  ])(
    "$notification 알림이 도착하면 송신기가 취소돼 소실된 눌림을 다시 쓰지 않는다",
    async ({ notification, args }) => {
      const session = startSession();
      session.fake.type("\x03");
      session.workerRpc.notify(notification, ...args);
      await waitNextStatus(session);

      loseSignal(session);
      await settle();

      expect(slots(session).signal).toBe(0);
    },
  );

  test("dispose하면 송신기가 취소돼 소실된 눌림을 다시 쓰지 않는다", async () => {
    const session = startSession();
    session.fake.type("\x03");

    session.handle.dispose();
    loseSignal(session);
    await settle();

    expect(slots(session).signal).toBe(0);
  });

  test("dispose 뒤 Ctrl+C는 에코도 전송도 하지 않고 오류도 내지 않는다", () => {
    const session = startSession();
    session.handle.dispose();
    const writtenAtDispose = session.fake.written.length;

    expect(() => session.fake.type("\x03")).not.toThrow();

    expect(session.fake.written).toHaveLength(writtenAtDispose);
    expect(slots(session).seq).toBe(0);
  });
});
