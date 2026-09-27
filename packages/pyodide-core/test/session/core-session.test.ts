// @vitest-environment node
/**
 * core 세션(`startCoreSession`) 시험. main 쪽 세션의 공통 부분 — worker 생성·초기화 프레임·RPC 핸들러 합성·
 * 출력 계약 `{ stream, text }`·`readInput` 처리·게이트 `pythonRunning`·종료 수명 주기 — 을 가짜 worker와 가짜 driver로 본다.
 * REPL 쪽 조립(읽기 가드·`readLine`·읽기 phase)은 repl `index.test.ts`·`repl-main-driver.test.ts`가 실제 `Readline`으로 본다.
 * worker 역할의 rpc는 프레임의 포트에 시험이 직접 만든다(worker가 실제로 없으므로 프레임의 포트를 전송하지 않고 그대로 쓴다).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseInitFrame } from "../../src/protocol/init-frame";
import type { InitFrame } from "../../src/protocol/init-frame";
import { createInterruptBuffer } from "../../src/protocol/interrupt-protocol";
import type { InterruptSender } from "../../src/protocol/interrupt-sender";
import { createRpc } from "../../src/protocol/rpc";
import { PYODIDE_VERSION } from "../../src/pyodide-version";
import type { Rpc } from "../../src/protocol/rpc";
import {
  peekMailbox,
  takeMailboxResponse,
} from "../../src/protocol/stdin-mailbox";
import type { StdinMailboxBuffers } from "../../src/protocol/stdin-mailbox";
import { STDIN_EOF } from "../../src/protocol/stdin-eof";
import {
  CORE_MAIN_HANDLER_NAMES,
  startCoreSession,
} from "../../src/session/core-session";
import type {
  CoreSession,
  CoreSessionOptions,
} from "../../src/session/core-session";
import type { MainDriver, OutputChunk } from "../../src/session/driver";

/** 초기화 프레임의 stdin 필드를 `StdinMailboxBuffers` 모양으로 바꾼다. */
function mailboxOf(frame: InitFrame): StdinMailboxBuffers {
  return { ctrl: frame.stdinCtrl, data: frame.stdinData };
}

const ports: MessagePort[] = [];
const workerRpcs: Rpc[] = [];
const sessions: CoreSession[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const rpc of workerRpcs.splice(0)) rpc.dispose();
  for (const port of ports.splice(0)) port.close();
  sessions.length = 0;
});

/** `postMessage`·`terminate`만 기록하는 가짜 worker. 호출 순서 검증을 위해 공용 로그에도 남긴다. */
function createFakeWorker(log: string[] = []) {
  const errorListeners = new Set<(event: { message?: string }) => void>();
  // 리스너를 뗀 뒤에도 이미 큐에 있던 이벤트가 늦게 도착하는 경우를 흉내 내려고 등록된 적 있는 리스너를 모두 기억한다.
  const everAdded: ((event: { message?: string }) => void)[] = [];
  const postMessage = vi.fn<
    (message: unknown, transfer: Transferable[]) => void
  >((message) => {
    ports.push((message as InitFrame).rpcPort);
  });
  const terminate = vi.fn(() => {
    log.push("worker.terminate");
  });
  const worker = {
    postMessage,
    terminate,
    addEventListener: (
      type: string,
      listener: (event: { message?: string }) => void,
    ) => {
      if (type === "error") {
        errorListeners.add(listener);
        everAdded.push(listener);
      }
    },
    removeEventListener: (
      type: string,
      listener: (event: { message?: string }) => void,
    ) => {
      if (type === "error") {
        errorListeners.delete(listener);
        log.push("worker.removeEventListener(error)");
      }
    },
  } as unknown as Worker;
  return {
    worker,
    postMessage,
    terminate,
    frame: () => postMessage.mock.calls[0]?.[0] as InitFrame,
    dispatchError(message?: string) {
      for (const listener of errorListeners) listener({ message });
    },
    /** 리스너를 뗀 뒤에 도착한 것으로 치고 등록된 적 있는 리스너를 직접 부른다. */
    dispatchLateError(message?: string) {
      for (const listener of everAdded) listener({ message });
    },
  };
}

function createFakeSender(log: string[] = []): InterruptSender & {
  cancel: ReturnType<typeof vi.fn>;
} {
  return {
    send: vi.fn(),
    cancel: vi.fn(() => {
      log.push("interruptSender.cancel");
    }),
  };
}

/** 시험이 조작하는 가짜 driver. 기본은 읽기 대기 없음(`isIdle` 거짓), 입력 읽기는 끝나지 않는 promise다. */
function createFakeDriver(overrides: Partial<MainDriver> = {}) {
  const state = { idle: false };
  const driver: MainDriver = {
    options: { marker: "driver-options" },
    handlers: {},
    isIdle: () => state.idle,
    readInput: () => new Promise<string | null>(() => {}),
    ...overrides,
  };
  return { driver, state };
}

interface StartOptions extends Partial<CoreSessionOptions> {
  log?: string[];
}

/** 세션을 시작하고 worker 역할 rpc를 붙인다. */
function start(options: StartOptions = {}) {
  const log = options.log ?? [];
  const fakeWorker = createFakeWorker(log);
  const interruptSender = createFakeSender(log);
  const { driver, state } = createFakeDriver();
  const output = vi.fn<(chunk: OutputChunk) => void>();
  const onStatus = vi.fn();
  const onCrash = vi.fn();
  const session = startCoreSession({
    createWorker: () => fakeWorker.worker,
    indexURL: "https://example.test/pyodide/",
    interruptBuffer: createInterruptBuffer(),
    interruptSender,
    driver,
    output,
    onStatus,
    onCrash,
    ...options,
  });
  sessions.push(session);
  const workerRpc = createRpc(fakeWorker.frame().rpcPort);
  workerRpcs.push(workerRpc);
  return {
    session,
    fakeWorker,
    interruptSender,
    driver: options.driver ?? driver,
    state,
    output,
    onStatus,
    onCrash,
    workerRpc,
    log,
  };
}

/** MessagePort로 도착하는 알림을 기다린다. 조건이 참이 되면 바로 돌아온다(최대 2초). */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let waited = 0; waited < 2000; waited += 5) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("기다리던 상태가 되지 않았다");
}

/** "오지 않아야 한다"는 단언 앞에서 알림이 도착했을 시간을 준다. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

describe("startCoreSession: 게이트 pythonRunning", () => {
  test("살아 있고 읽기 대기가 없고 driver가 유휴가 아니면 참이다", () => {
    const { session } = start();

    expect(session.pythonRunning()).toBe(true);
  });

  test("driver.isIdle()이 참이면 거짓이다", () => {
    const { session, state } = start();

    state.idle = true;

    expect(session.pythonRunning()).toBe(false);
    state.idle = false;
    expect(session.pythonRunning()).toBe(true);
  });

  test("driver가 유휴가 아니어도 inputReadsPending이 0보다 크면 거짓이고 응답이 끝나면 다시 참이다", async () => {
    let resolveRead: (line: string | null) => void = () => {};
    const { driver } = createFakeDriver({
      readInput: () =>
        new Promise<string | null>((resolve) => {
          resolveRead = resolve;
        }),
    });
    const { session, workerRpc } = start({ driver });

    workerRpc.notify("readInput", true);
    await waitFor(() => !session.pythonRunning());

    expect(driver.isIdle()).toBe(false);
    expect(session.pythonRunning()).toBe(false);

    resolveRead("abc");
    await waitFor(() => session.pythonRunning());
    expect(session.pythonRunning()).toBe(true);
  });

  test("endSession() 뒤에는 거짓이고 송신기의 재전송을 멈춘다", () => {
    const { session, interruptSender } = start();

    session.endSession();

    expect(session.pythonRunning()).toBe(false);
    expect(interruptSender.cancel).toHaveBeenCalledTimes(1);
  });
});

describe("startCoreSession: 출력 계약 { stream, text }", () => {
  test("write 알림은 stdout 조각으로, writeErrorRaw 알림은 stderr 조각으로 output에 전달한다", async () => {
    const { workerRpc, output } = start();

    workerRpc.notify("write", "hello\n");
    workerRpc.notify("writeErrorRaw", "oops");
    await waitFor(() => output.mock.calls.length === 2);

    expect(output.mock.calls).toEqual([
      [{ stream: "stdout", text: "hello\n" }],
      [{ stream: "stderr", text: "oops" }],
    ]);
  });

  test("driver 핸들러의 알림은 output을 거치지 않고 driver가 받는다", async () => {
    const received: string[] = [];
    const { driver } = createFakeDriver({
      handlers: { writeOutput: (text: string) => void received.push(text) },
    });
    const { workerRpc, output } = start({ driver });

    workerRpc.notify("writeOutput", "line");
    await waitFor(() => received.length === 1);
    await settle();

    expect(received).toEqual(["line"]);
    expect(output).not.toHaveBeenCalled();
  });
});

describe("startCoreSession: 초기화 프레임", () => {
  test("driver 필드에 driver.options를 싣고 최상위에는 driver 설정이 없다", () => {
    const { fakeWorker, driver } = start();
    const frame = fakeWorker.frame();

    expect(frame.driver).toBe(driver.options);
    expect("topLevelAwait" in frame).toBe(false);
    expect(frame.pyodide.indexURL).toBe("https://example.test/pyodide/");
    expect(() => parseInitFrame(frame)).not.toThrow();
  });

  test("driver.options가 undefined여도 driver 키를 남겨 검증을 통과한다", () => {
    const { driver } = createFakeDriver({ options: undefined });
    const { fakeWorker } = start({ driver });

    expect("driver" in fakeWorker.frame()).toBe(true);
    expect(() => parseInitFrame(fakeWorker.frame())).not.toThrow();
  });

  test("프레임을 worker에 한 번 보내면서 rpcPort를 전송 목록에 담는다", () => {
    const { fakeWorker } = start();

    expect(fakeWorker.postMessage).toHaveBeenCalledTimes(1);
    // MessagePort를 든 객체에는 toEqual·toContain을 쓰지 않는다(순환 내부 참조). 정체성으로 본다.
    const [message, transfer] = fakeWorker.postMessage.mock.calls[0] as [
      InitFrame,
      Transferable[],
    ];
    expect(transfer).toHaveLength(1);
    expect(transfer[0] === message.rpcPort).toBe(true);
  });
});

describe("startCoreSession: RPC 핸들러 합성", () => {
  test.each(CORE_MAIN_HANDLER_NAMES)(
    "driver 핸들러가 core 이름 %s을(를) 가로채면 생성 시 예외를 던지고 worker를 만들지 않는다",
    (name) => {
      const { driver } = createFakeDriver({ handlers: { [name]: () => {} } });
      const createWorker = vi.fn(() => createFakeWorker().worker);

      expect(() =>
        startCoreSession({
          createWorker,
          indexURL: "x/",
          interruptBuffer: createInterruptBuffer(),
          interruptSender: createFakeSender(),
          driver,
          output: () => {},
          onStatus: () => {},
        }),
      ).toThrow(new RegExp(name));
      expect(createWorker).not.toHaveBeenCalled();
    },
  );

  test("core 이름과 겹치지 않는 driver 핸들러는 그대로 등록된다", async () => {
    const readLine = vi.fn(() => "x = 1");
    const { driver } = createFakeDriver({ handlers: { readLine } });
    const { workerRpc } = start({ driver });

    await expect(workerRpc.call("readLine", ">>> ")).resolves.toBe("x = 1");
  });
});

describe("startCoreSession: readInput 처리", () => {
  test("알림이 도착하면 재전송을 멈추고 driver에 알린 뒤 읽는다", async () => {
    const log: string[] = [];
    const { driver } = createFakeDriver({
      inputRequested: () => {
        log.push("driver.inputRequested");
      },
      readInput: (cancelable) => {
        log.push(`driver.readInput(${String(cancelable)})`);
        return new Promise<string | null>(() => {});
      },
    });
    const { workerRpc } = start({ driver, log });

    workerRpc.notify("readInput", true);
    await waitFor(() => log.includes("driver.readInput(true)"));

    expect(log).toEqual([
      "interruptSender.cancel",
      "driver.inputRequested",
      "driver.readInput(true)",
    ]);
  });

  test("읽은 줄은 메일박스 READY로 전달하고, 끝난 뒤에 재개를 driver에 알린다", async () => {
    const resumed = vi.fn();
    const { driver } = createFakeDriver({
      readInput: () => Promise.resolve("abc"),
      inputResumed: resumed,
    });
    const { fakeWorker, workerRpc, session } = start({ driver });

    workerRpc.notify("readInput", true);
    await waitFor(() => resumed.mock.calls.length === 1);

    // 재개 알림 시점에 이미 쓰여 있다(쓰기가 끝난 뒤 알린다). take는 늦은 쓰기도 기다려 순서를 보지 못한다.
    expect(peekMailbox(mailboxOf(fakeWorker.frame()))).toMatchObject({
      kind: "chunk",
      last: true,
    });
    await expect(
      takeMailboxResponse(mailboxOf(fakeWorker.frame())),
    ).resolves.toMatchObject({ kind: "line" });
    expect(session.pythonRunning()).toBe(true);
  });

  test("null(취소)은 메일박스 CANCELLED로 전달한다", async () => {
    const resumed = vi.fn();
    const { driver } = createFakeDriver({
      readInput: () => Promise.resolve(null),
      inputResumed: resumed,
    });
    const { fakeWorker, workerRpc } = start({ driver });

    workerRpc.notify("readInput", true);
    await waitFor(() => resumed.mock.calls.length === 1);

    expect(peekMailbox(mailboxOf(fakeWorker.frame()))).toMatchObject({
      kind: "cancelled",
    });
    await expect(
      takeMailboxResponse(mailboxOf(fakeWorker.frame())),
    ).resolves.toMatchObject({ kind: "cancelled" });
  });

  test("[C4] STDIN_EOF는 메일박스 EOF로 전달한다", async () => {
    const resumed = vi.fn();
    const { driver } = createFakeDriver({
      readInput: () => Promise.resolve(STDIN_EOF),
      inputResumed: resumed,
    });
    const { fakeWorker, workerRpc } = start({ driver });

    workerRpc.notify("readInput", true);
    await waitFor(() => resumed.mock.calls.length === 1);

    expect(peekMailbox(mailboxOf(fakeWorker.frame()))).toMatchObject({
      kind: "eof",
    });
    await expect(
      takeMailboxResponse(mailboxOf(fakeWorker.frame())),
    ).resolves.toMatchObject({ kind: "eof" });
  });

  test("[C5] 세션이 끝난 뒤 열린 읽기가 STDIN_EOF로 resolve해도 메일박스는 IDLE이다", async () => {
    let resolveRead: (
      line: string | null | typeof STDIN_EOF,
    ) => void = () => {};
    let readInputCalled = false;
    const resumed = vi.fn();
    const { driver } = createFakeDriver({
      readInput: () => {
        readInputCalled = true;
        return new Promise<string | null | typeof STDIN_EOF>((resolve) => {
          resolveRead = resolve;
        });
      },
      inputResumed: resumed,
    });
    const { fakeWorker, workerRpc, session } = start({ driver });

    workerRpc.notify("readInput", true);
    await waitFor(() => readInputCalled);
    session.terminate();

    resolveRead(STDIN_EOF);
    await waitFor(() => resumed.mock.calls.length === 1);

    expect(peekMailbox(mailboxOf(fakeWorker.frame()))).toEqual({
      kind: "none",
    });
  });

  test("[D3] 읽기가 오류로 끝나면 메일박스 ERROR로 전달한다", async () => {
    const resumed = vi.fn();
    const { driver } = createFakeDriver({
      readInput: () => Promise.reject(new Error("터미널 오류")),
      inputResumed: resumed,
    });
    const { fakeWorker, workerRpc } = start({ driver });

    workerRpc.notify("readInput", true);
    await waitFor(() => resumed.mock.calls.length === 1);

    expect(peekMailbox(mailboxOf(fakeWorker.frame()))).toMatchObject({
      kind: "error",
    });
    await expect(
      takeMailboxResponse(mailboxOf(fakeWorker.frame())),
    ).resolves.toMatchObject({ kind: "error" });
  });

  test("[D3] 세션이 끝난 뒤의 읽기 오류는 메일박스에 쓰지 않는다", async () => {
    let rejectRead: (error: unknown) => void = () => {};
    const resumed = vi.fn();
    const { driver } = createFakeDriver({
      readInput: () =>
        new Promise<string | null>((_, reject) => {
          rejectRead = reject;
        }),
      inputResumed: resumed,
    });
    const { fakeWorker, workerRpc, session } = start({ driver });
    workerRpc.notify("readInput", true);
    await waitFor(() => !session.pythonRunning());

    session.terminate();
    rejectRead(new Error("종료 뒤 오류"));
    await waitFor(() => resumed.mock.calls.length === 1);

    expect(peekMailbox(mailboxOf(fakeWorker.frame()))).toEqual({
      kind: "none",
    });
  });

  test("[D1] 크래시 뒤 도착한 readInput 알림은 driver를 부르지 않는다", async () => {
    const log: string[] = [];
    const { driver } = createFakeDriver({
      inputRequested: () => log.push("driver.inputRequested"),
      readInput: () => {
        log.push("driver.readInput");
        return new Promise<string | null>(() => {});
      },
    });
    const { fakeWorker, workerRpc, onCrash } = start({ driver });

    workerRpc.notify("crashed", { message: "루프 예외" });
    await waitFor(() => onCrash.mock.calls.length === 1);

    workerRpc.notify("readInput", true);
    await settle();

    expect(log).toEqual([]);
    expect(peekMailbox(mailboxOf(fakeWorker.frame()))).toEqual({
      kind: "none",
    });
  });

  test("[D2] 읽기가 열린 채 크래시한 뒤 그 읽기가 줄로 resolve해도 메일박스는 IDLE이다", async () => {
    let resolveRead: (line: string | null) => void = () => {};
    let readInputCalled = false;
    const resumed = vi.fn();
    const { driver } = createFakeDriver({
      readInput: () => {
        readInputCalled = true;
        return new Promise<string | null>((resolve) => {
          resolveRead = resolve;
        });
      },
      inputResumed: resumed,
    });
    const { fakeWorker, workerRpc, onCrash } = start({ driver });

    workerRpc.notify("readInput", true);
    await waitFor(() => readInputCalled);
    workerRpc.notify("crashed", { message: "루프 예외" });
    await waitFor(() => onCrash.mock.calls.length === 1);

    resolveRead("입력줄");
    await waitFor(() => resumed.mock.calls.length === 1);

    expect(peekMailbox(mailboxOf(fakeWorker.frame()))).toEqual({
      kind: "none",
    });
  });

  test("[D2] terminate() 뒤 열린 읽기가 줄로 resolve해도 메일박스는 IDLE이다", async () => {
    let resolveRead: (line: string | null) => void = () => {};
    let readInputCalled = false;
    const resumed = vi.fn();
    const { driver } = createFakeDriver({
      readInput: () => {
        readInputCalled = true;
        return new Promise<string | null>((resolve) => {
          resolveRead = resolve;
        });
      },
      inputResumed: resumed,
    });
    const { fakeWorker, workerRpc, session } = start({ driver });

    workerRpc.notify("readInput", true);
    await waitFor(() => readInputCalled);
    session.terminate();

    resolveRead("입력줄");
    await waitFor(() => resumed.mock.calls.length === 1);

    expect(peekMailbox(mailboxOf(fakeWorker.frame()))).toEqual({
      kind: "none",
    });
  });

  test("[D3] 읽기가 열린 채 크래시한 뒤 그 읽기가 임의 오류로 reject해도 메일박스는 IDLE이다(ERROR 아님)", async () => {
    let rejectRead: (error: unknown) => void = () => {};
    let readInputCalled = false;
    const resumed = vi.fn();
    const { driver } = createFakeDriver({
      readInput: () => {
        readInputCalled = true;
        return new Promise<string | null>((_, reject) => {
          rejectRead = reject;
        });
      },
      inputResumed: resumed,
    });
    const { fakeWorker, workerRpc, onCrash } = start({ driver });

    workerRpc.notify("readInput", true);
    await waitFor(() => readInputCalled);
    workerRpc.notify("crashed", { message: "루프 예외" });
    await waitFor(() => onCrash.mock.calls.length === 1);

    rejectRead(new Error("크래시 뒤 오류"));
    await waitFor(() => resumed.mock.calls.length === 1);

    expect(peekMailbox(mailboxOf(fakeWorker.frame()))).toEqual({
      kind: "none",
    });
  });

  test("[D6] driver.readInput에 넘긴 sessionEnded는 살아 있을 때 거짓, terminate() 뒤 참이다", async () => {
    let sessionEnded: (() => boolean) | undefined;
    const { driver } = createFakeDriver({
      readInput: (_cancelable, ended) => {
        sessionEnded = ended;
        return new Promise<string | null>(() => {});
      },
    });
    const { workerRpc, session } = start({ driver });

    workerRpc.notify("readInput", true);
    await waitFor(() => sessionEnded !== undefined);
    if (sessionEnded === undefined)
      throw new Error("readInput이 불리지 않았다");
    expect(sessionEnded()).toBe(false);

    session.terminate();
    expect(sessionEnded()).toBe(true);
  });

  test("[D6] driver.readInput에 넘긴 sessionEnded는 크래시 뒤 참이다", async () => {
    let sessionEnded: (() => boolean) | undefined;
    const { driver } = createFakeDriver({
      readInput: (_cancelable, ended) => {
        sessionEnded = ended;
        return new Promise<string | null>(() => {});
      },
    });
    const { workerRpc, onCrash } = start({ driver });

    workerRpc.notify("readInput", true);
    await waitFor(() => sessionEnded !== undefined);
    if (sessionEnded === undefined)
      throw new Error("readInput이 불리지 않았다");
    expect(sessionEnded()).toBe(false);

    workerRpc.notify("crashed", { message: "루프 예외" });
    await waitFor(() => onCrash.mock.calls.length === 1);

    expect(sessionEnded()).toBe(true);
  });
});

/** 문제 없는 부팅의 `ready` 페이로드(고정 버전, 저하 없음). */
const CLEAN_READY = {
  pyodideVersion: PYODIDE_VERSION,
  versionMismatch: false,
  degraded: [],
};

describe("startCoreSession: pyodide 호환 경고", () => {
  /** ready 알림을 보내고 상태 알림이 올 때까지 기다린다. `console.warn` 호출은 스파이가 기록한다. */
  async function bootWith(
    payload: unknown,
    driver = createFakeDriver().driver,
  ) {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { workerRpc, onStatus, log } = start({ driver });
    onStatus.mockImplementation((status: string) =>
      log.push(`status:${status}`),
    );
    workerRpc.notify("ready", payload);
    await waitFor(() => onStatus.mock.calls.length === 1);
    return { warn, onStatus, log };
  }

  test("문제가 없으면 console.warn을 부르지 않는다", async () => {
    const { warn, onStatus } = await bootWith(CLEAN_READY);

    expect(warn).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith("ready");
  });

  test("버전이 다르면 expected·actual과 함께 정확히 1회 경고한다", async () => {
    const { warn, onStatus } = await bootWith({
      pyodideVersion: "0.0.0-other",
      versionMismatch: true,
      degraded: [],
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[session] pyodide 호환 경고", {
      expected: PYODIDE_VERSION,
      actual: "0.0.0-other",
      degraded: [],
      details: undefined,
    });
    expect(onStatus).toHaveBeenCalledWith("ready");
  });

  test("degraded가 비어 있지 않으면 식별자·상세와 함께 정확히 1회 경고한다", async () => {
    const { warn } = await bootWith({
      pyodideVersion: PYODIDE_VERSION,
      versionMismatch: false,
      degraded: ["run-sync", "compiler-flags"],
      details: { "run-sync": ["pyodide.ffi.run_sync"] },
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[session] pyodide 호환 경고", {
      expected: PYODIDE_VERSION,
      actual: PYODIDE_VERSION,
      degraded: ["run-sync", "compiler-flags"],
      details: { "run-sync": ["pyodide.ffi.run_sync"] },
    });
  });

  test("버전 불일치와 degraded가 함께 있어도 경고는 1회다", async () => {
    const { warn } = await bootWith({
      pyodideVersion: "0.0.0-other",
      versionMismatch: true,
      degraded: ["sleep-slice"],
    });

    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("경고는 driver.onReady보다 먼저, 상태 알림보다 앞에 난다", async () => {
    const log: string[] = [];
    const { driver } = createFakeDriver({
      onReady: () => {
        log.push("driver.onReady");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      log.push("console.warn");
    });
    const { workerRpc, onStatus } = start({ driver, log });
    onStatus.mockImplementation((status: string) =>
      log.push(`status:${status}`),
    );

    workerRpc.notify("ready", {
      pyodideVersion: PYODIDE_VERSION,
      versionMismatch: false,
      degraded: ["webloop-filename"],
    });
    await waitFor(() => onStatus.mock.calls.length === 1);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(log).toEqual(["console.warn", "driver.onReady", "status:ready"]);
  });
});

describe("startCoreSession: 상태 알림", () => {
  test("ready 알림은 driver에 페이로드를 알린 뒤 onStatus('ready')를 낸다", async () => {
    const log: string[] = [];
    const { driver } = createFakeDriver({
      onReady: (payload) => {
        log.push(`driver.onReady(${payload.pyodideVersion})`);
      },
    });
    const { workerRpc, onStatus } = start({ driver, log });
    onStatus.mockImplementation((status: string) =>
      log.push(`status:${status}`),
    );

    workerRpc.notify("ready", CLEAN_READY);
    await waitFor(() => onStatus.mock.calls.length === 1);

    expect(log).toEqual([`driver.onReady(${PYODIDE_VERSION})`, "status:ready"]);
  });

  test("ready 알림은 페이로드 객체를 그대로 driver.onReady에 넘긴다", async () => {
    const onReady = vi.fn();
    const { driver } = createFakeDriver({ onReady });
    const { workerRpc, onStatus } = start({ driver });
    const payload = {
      pyodideVersion: PYODIDE_VERSION,
      versionMismatch: false,
      degraded: ["run-sync"],
      details: { "run-sync": ["pyodide.ffi.run_sync"] },
    };

    workerRpc.notify("ready", payload);
    await waitFor(() => onStatus.mock.calls.length === 1);

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady.mock.calls[0]?.[0]).toEqual(payload);
  });

  test("loadFailed 알림은 게이트를 닫고 driver에 알린 뒤 onStatus('load-failed')를 낸다", async () => {
    const log: string[] = [];
    const { driver } = createFakeDriver({
      onLoadFailed: (message) => {
        log.push(`driver.onLoadFailed(${message})`);
      },
    });
    const { workerRpc, onStatus, session } = start({ driver, log });
    onStatus.mockImplementation((status: string) =>
      log.push(`status:${status}`),
    );

    workerRpc.notify("loadFailed", "boom");
    await waitFor(() => onStatus.mock.calls.length === 1);

    expect(log).toEqual([
      "interruptSender.cancel",
      "driver.onLoadFailed(boom)",
      "status:load-failed",
    ]);
    expect(session.pythonRunning()).toBe(false);
  });

  test("sessionTerminated 알림은 게이트를 닫고 onStatus('terminated')를 낸다", async () => {
    const { workerRpc, onStatus, session } = start();

    workerRpc.notify("sessionTerminated");
    await waitFor(() => onStatus.mock.calls.length === 1);

    expect(onStatus).toHaveBeenCalledWith("terminated");
    expect(session.pythonRunning()).toBe(false);
  });

  test("crashed 알림과 worker error 이벤트는 첫 신호만 반영한다", async () => {
    const { workerRpc, fakeWorker, onStatus, onCrash, session } = start();

    workerRpc.notify("crashed", { message: "루프 예외" });
    await waitFor(() => onCrash.mock.calls.length === 1);
    fakeWorker.dispatchError("뒤늦은 error");

    expect(onStatus.mock.calls).toEqual([["crashed"]]);
    expect(onCrash.mock.calls).toEqual([["루프 예외"]]);
    expect(session.pythonRunning()).toBe(false);
  });

  test("worker error 이벤트만 와도 crashed가 되고 메시지가 없으면 기본 문구를 쓴다", () => {
    const { fakeWorker, onCrash } = start();

    fakeWorker.dispatchError(undefined);

    expect(onCrash).toHaveBeenCalledWith("worker가 알 수 없는 이유로 종료됨");
  });
});

describe("startCoreSession: 종료 수명 주기", () => {
  test("terminate()는 driver 정리 → 송신기 취소 → error 리스너 제거 → rpc.dispose(포트 닫기) → worker.terminate 순서다", () => {
    const log: string[] = [];
    const { driver } = createFakeDriver({
      terminate: () => {
        log.push("driver.terminate");
      },
    });
    const originalClose = MessagePort.prototype.close;
    vi.spyOn(MessagePort.prototype, "close").mockImplementation(function (
      this: MessagePort,
    ) {
      log.push("port.close");
      return originalClose.call(this);
    });
    const { session } = start({ driver, log });

    session.terminate();

    expect(log).toEqual([
      "driver.terminate",
      "interruptSender.cancel",
      "worker.removeEventListener(error)",
      "port.close",
      "worker.terminate",
    ]);
  });

  test("terminate() 뒤 ended가 참이고 대기 중이던 call은 reject된다", async () => {
    const { session } = start();
    expect(session.ended).toBe(false);
    const pending = session.call("complete", "x");
    // 응답이 없는 요청이 걸려 있다. 종료가 rpc.dispose로 reject한다.
    const settled = pending.then(
      () => "resolved",
      () => "rejected",
    );

    session.terminate();

    expect(session.ended).toBe(true);
    await expect(settled).resolves.toBe("rejected");
  });

  test("terminate() 뒤에는 error 리스너가 떨어지고, 늦게 도착한 crashed 신호도 무시한다", () => {
    const { session, fakeWorker, onStatus, onCrash } = start();

    session.terminate();
    fakeWorker.dispatchError("리스너가 떨어진 뒤 error");
    fakeWorker.dispatchLateError("큐에 있던 늦은 error");

    expect(onStatus).not.toHaveBeenCalled();
    expect(onCrash).not.toHaveBeenCalled();
  });
});

describe("startCoreSession: 생성 실패", () => {
  test("worker를 만든 뒤 프레임 전송이 던지면 worker를 정리하고 던지며, 남은 worker의 뒤늦은 error는 상태를 바꾸지 않는다", async () => {
    const fakeWorker = createFakeWorker();
    fakeWorker.postMessage.mockImplementationOnce(() => {
      throw new Error("DataCloneError");
    });
    const onStatus = vi.fn();
    const onCrash = vi.fn();

    expect(() =>
      startCoreSession({
        createWorker: () => fakeWorker.worker,
        indexURL: "https://example.test/pyodide/",
        interruptBuffer: createInterruptBuffer(),
        interruptSender: createFakeSender(),
        driver: createFakeDriver().driver,
        output: vi.fn(),
        onStatus,
        onCrash,
      }),
    ).toThrow("DataCloneError");

    expect(fakeWorker.terminate).toHaveBeenCalledTimes(1);
    fakeWorker.dispatchLateError("late");
    await settle();
    expect(onStatus).not.toHaveBeenCalled();
    expect(onCrash).not.toHaveBeenCalled();
  });
});
