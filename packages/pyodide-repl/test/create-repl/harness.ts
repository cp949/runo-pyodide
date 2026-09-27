/**
 * `createRepl` 시험(`test/create-repl/*.test.ts`, `runSource` 시험 포함)이 함께 쓰는 하니스. 실제 `Readline`을 가짜 터미널에 붙이고, worker는
 * 가짜(`postMessage`·`terminate`·`error` 리스너만 기록)로 둔다. worker 역할의 rpc는 시험이 초기화 프레임의 포트에 직접 만든다.
 * worker가 없어 메일박스를 아무도 가져가지 않으므로 main이 쓴 값이 그대로 남고, 시험이 `takeResponse`·`peek`로 대신 읽는다.
 *
 * 시험 파일은 최상위에서 `useReplHarness()`를 한 번 불러 시험마다의 격리 페이지 설정과 정리(rpc·핸들·포트)를 등록한다.
 * `startSession`·`startResettableSession`을 거치지 않고 `createRepl`을 직접 부른 시험은 `trackHandle`로 정리 대상에 올린다.
 */
import { afterEach, beforeEach, vi } from "vitest";
import { createRepl, type ReplHandle, type ReplOptions } from "../../src/index";
import {
  type InitFrame,
  ACK,
  SEQ,
  SIGNAL,
  createRpc,
  type Rpc,
  type RpcHandlers,
  PYODIDE_VERSION,
} from "@cp949/runo-pyodide-core";
import {
  peekMailbox,
  takeMailboxResponse,
} from "@cp949/runo-pyodide-core/test-utils";
import { observe, tick, type Outcome } from "@repo/pyodide-testkit/async";
import {
  createFakeTerminal,
  type FakeTerminal,
  type FakeTerminalOptions,
} from "@repo/pyodide-testkit/fake-terminal";

export { observe, tick, type Outcome };

/**
 * 초기화 프레임에 실린 `topLevelAwait`. driver 옵션이라 최상위가 아니라 `frame.driver` 안에 있다(RD-020, `InitFrame.driver`).
 * 단언 값은 그대로이고 읽는 경로만 바뀌었다.
 */
export function topLevelAwaitOf(frame: InitFrame): unknown {
  return (frame.driver as { topLevelAwait?: unknown }).topLevelAwait;
}

/** 배열 인덱스가 반드시 있는 시험에서 `T | undefined`를 `T`로 좁힌다(`noUncheckedIndexedAccess`). */
export function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("있어야 할 값이 없다");
  return value;
}

/** MessagePort 알림이 도착했을 시간을 준다. "오지 않아야 한다"는 단언 앞에서 쓴다. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

/** MessagePort로 도착하는 알림을 기다린다. 조건이 참이 되면 바로 돌아온다(최대 2초). */
export async function waitFor(predicate: () => boolean): Promise<void> {
  for (let waited = 0; waited < 2000; waited += 5) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("기다리던 상태가 되지 않았다");
}

/** 프레임의 rpcPort. 열린 MessagePort가 vitest 워커를 잡지 않게 시험이 끝나면 닫는다. */
const openPorts: MessagePort[] = [];
/** 새 시험이 만든 핸들과 worker 역할 rpc. 시험이 끝나면 정리한다. */
const handles: ReplHandle[] = [];
const workerRpcs: Rpc[] = [];

/** 아무것도 하지 않는 가짜 worker. postMessage로 받은 프레임을 기록하고 `error` 리스너를 걸 수 있게 한다. */
export function createFakeWorker() {
  const postMessage = vi.fn<
    (message: unknown, transfer: Transferable[]) => void
  >((message) => {
    openPorts.push((message as InitFrame).rpcPort);
  });
  const terminate = vi.fn<() => void>();
  const errorListeners = new Set<(event: { message?: string }) => void>();
  const addEventListener = vi.fn(
    (type: string, listener: (event: { message?: string }) => void) => {
      if (type === "error") errorListeners.add(listener);
    },
  );
  const removeEventListener = vi.fn(
    (type: string, listener: (event: { message?: string }) => void) => {
      if (type === "error") errorListeners.delete(listener);
    },
  );
  const worker = {
    postMessage,
    terminate,
    addEventListener,
    removeEventListener,
  } as unknown as Worker;
  return {
    worker,
    postMessage,
    terminate,
    addEventListener,
    removeEventListener,
    frame: () => postMessage.mock.calls[0]?.[0] as InitFrame,
    /** 전역 worker `error` 이벤트를 흉내 낸다(RD-010). */
    dispatchError(message?: string) {
      for (const listener of errorListeners) listener({ message });
    },
  };
}

/** RD-003 시험이 쓰는 worker 팩토리. 세션이 시작되지만 아무 알림도 오지 않는다. */
export const createWorker = () => createFakeWorker().worker;

/**
 * 세션을 시작하고 worker 역할 rpc를 프레임의 포트에 만든다. `workerHandlers`는 worker가 요청을
 * 받는 쪽(`complete` 등)을 시험이 흉내 낼 때 쓴다(RD-015 DELTA-04, 기본은 핸들러 없음).
 */
export function startSession(
  overrides: Partial<ReplOptions> = {},
  terminalOptions: FakeTerminalOptions = {},
  workerHandlers: RpcHandlers = {},
) {
  const fake = createFakeTerminal(terminalOptions);
  const fakeWorker = createFakeWorker();
  const onStatus = vi.fn<NonNullable<ReplOptions["onStatus"]>>();
  const createWorkerSpy = vi.fn(() => fakeWorker.worker);
  const handle = createRepl({
    terminal: fake.term,
    createWorker: createWorkerSpy,
    onStatus,
    ...overrides,
  });
  handles.push(handle);
  const workerRpc = createRpc(fakeWorker.frame().rpcPort, workerHandlers);
  workerRpcs.push(workerRpc);
  const bytes = () => fake.written.join("");
  return {
    fake,
    fakeWorker,
    onStatus,
    createWorkerSpy,
    handle,
    workerRpc,
    bytes,
  };
}

/**
 * `reset()` 시험용: `createWorker`를 부를 때마다 새 가짜 worker를 만든다(`startSession`은 같은 worker를 재사용해
 * 리셋 전후의 worker를 구분할 수 없다). `fake`는 세션을 넘어 하나다(화면·history가 리셋을 넘어 산다). `fakeWorker`·
 * `workerRpc`는 가장 최근 세션(리셋됐으면 새 세션)을 가리킨다 — 기존 헬퍼(`startRead` 등)를 리셋 뒤에도 그대로 쓸 수 있게.
 */
export function startResettableSession(
  overrides: Partial<ReplOptions> = {},
  terminalOptions: FakeTerminalOptions = {},
  workerHandlers: RpcHandlers = {},
) {
  const fake = createFakeTerminal(terminalOptions);
  const workers: ReturnType<typeof createFakeWorker>[] = [];
  const rpcs: Rpc[] = [];
  const onStatus = vi.fn<NonNullable<ReplOptions["onStatus"]>>();
  const createWorkerSpy = vi.fn(() => {
    const fakeWorker = createFakeWorker();
    workers.push(fakeWorker);
    return fakeWorker.worker;
  });
  const handle = createRepl({
    terminal: fake.term,
    createWorker: createWorkerSpy,
    onStatus,
    ...overrides,
  });
  handles.push(handle);
  const bytes = () => fake.written.join("");
  const workerRpcAt = (index: number): Rpc => {
    const existing = rpcs[index];
    if (existing !== undefined) return existing;
    const rpc = createRpc(must(workers[index]).frame().rpcPort, workerHandlers);
    workerRpcs.push(rpc);
    rpcs[index] = rpc;
    return rpc;
  };
  return {
    fake,
    workers,
    onStatus,
    createWorkerSpy,
    handle,
    workerRpcAt,
    get fakeWorker() {
      return must(workers[workers.length - 1]);
    },
    get workerRpc() {
      return workerRpcAt(workers.length - 1);
    },
    bytes,
  };
}

/**
 * worker 역할 rpc로 `readLine`을 요청하고, main이 읽기를 시작해 입력 상태가 만들어질 때까지 write 콜백을 배출한다.
 * 읽기는 `term.write("", cb)`를 낸다(긴 꼬리를 정리하는 `rewindTail`의 flush도 같다). 출력 알림은 빈 조각을 쓰지
 * 않으므로 빈 문자열 write가 늘어난 것이 "요청이 도착했다"는 신호다. 꼬리가 길면 flush를 두 번 배출해야 읽기가 시작된다.
 * 읽기가 끝나기를 기다리지 않도록(async 함수는 반환한 Promise를 풀어 버린다) 읽기 Promise를 객체에 담아 돌려준다.
 */
export async function startRead(
  session: Pick<ReturnType<typeof startSession>, "fake" | "workerRpc">,
  prompt = ">>> ",
  pending: string | undefined = undefined,
): Promise<{ line: Promise<string | null | { eof: true }> }> {
  const { fake, workerRpc } = session;
  const flushRequests = () => fake.written.filter((text) => text === "").length;
  const before = flushRequests();
  const line = workerRpc.call<string | null | { eof: true }>(
    "readLine",
    prompt,
    pending,
    true,
  );
  // 시험이 읽기 결과를 기다리지 않고 끝나도 afterEach의 rpc 정리가 처리되지 않은 rejection을 만들지 않게 한다.
  void line.catch(() => {});
  await Promise.race([
    waitFor(() => flushRequests() > before),
    // 요청이 거절되면(핸들러 없음 등) 기다리지 않고 그 오류로 실패한다.
    line.then(() => undefined),
  ]);
  fake.flush();
  await tick();
  fake.flush();
  return { line };
}

/** `term.write("", cb)`를 요청한 횟수. 읽기가 시작되는 중이라는 신호다(`startRead` 설명 참고). */
export const flushRequestCount = (fake: FakeTerminal) =>
  fake.written.filter((text) => text === "").length;

/** 읽기 요청이 도착해 write 콜백을 배출하면 읽기가 시작된다. `before`는 요청 전의 `flushRequestCount`다. */
export async function drainReadStart(fake: FakeTerminal, before: number) {
  await waitFor(() => flushRequestCount(fake) > before);
  fake.flush();
  await tick();
  fake.flush();
}

/** worker 역할 rpc로 `readInput`을 알리고 stdin 읽기가 시작될 때까지 기다린다. 응답 통로는 메일박스뿐이라 반환값이 없다. */
export async function startInputRead(
  session: Pick<ReturnType<typeof startSession>, "fake" | "workerRpc">,
) {
  const before = flushRequestCount(session.fake);
  session.workerRpc.notify("readInput", true);
  await drainReadStart(session.fake, before);
}

/** 초기화 프레임의 stdin 필드를 `StdinMailboxBuffers` 모양으로 바꾼다. */
export function mailboxOf(
  session: Pick<ReturnType<typeof startSession>, "fakeWorker">,
) {
  const { stdinCtrl, stdinData } = session.fakeWorker.frame();
  return { ctrl: stdinCtrl, data: stdinData };
}

/**
 * 규칙: `docs/design/01-protocols.md` 2.5. main의 `createMailboxWriter`가 쓴 응답을 받는다(worker 없이 이
 * 시험이 대신 소비한다). `deliver`는 비동기라 Enter 직후에는 응답이 아직 없을 수 있다 — 응답이 쓰일 때까지 기다린다.
 */
export function takeResponse(
  session: Pick<ReturnType<typeof startSession>, "fakeWorker">,
) {
  return takeMailboxResponse(mailboxOf(session));
}

/** 규칙: `docs/design/01-protocols.md` 2.5. 소비하지 않고 현재 메일박스를 본다. */
export function peek(
  session: Pick<ReturnType<typeof startSession>, "fakeWorker">,
) {
  return peekMailbox(mailboxOf(session));
}

export type Session = ReturnType<typeof startSession>;

/** interrupt buffer 슬롯 세 개의 지금 값. */
export function slotsOf(buffer: Int32Array) {
  return {
    signal: Atomics.load(buffer, SIGNAL),
    ack: Atomics.load(buffer, ACK),
    seq: Atomics.load(buffer, SEQ),
  };
}

/** 프레임의 interrupt buffer 슬롯 세 개. main 송신기가 쓰는 것과 같은 SharedArrayBuffer 뷰다. */
export function slots(session: Pick<Session, "fakeWorker">) {
  return slotsOf(session.fakeWorker.frame().interruptBuffer);
}

/** 지금까지 터미널에 쓴 `^C` 에코 횟수. */
export const echoes = (session: Pick<Session, "bytes">) =>
  session.bytes().split("^C").length - 1;

/** worker가 보내는 `ready` 페이로드(문제 없는 부팅). 필요한 필드만 덮어쓴다. */
export const readyPayload = (overrides: Record<string, unknown> = {}) => ({
  pyodideVersion: PYODIDE_VERSION,
  versionMismatch: false,
  degraded: [],
  ...overrides,
});

/**
 * 시험마다 격리 페이지(`crossOriginIsolated` 참)로 시작하고, 끝나면 worker 역할 rpc·핸들·포트를 닫는다.
 * 시험 파일 최상위에서 한 번 부른다.
 */
export function useReplHarness(): void {
  beforeEach(() => {
    localStorage.clear();
    // jsdom에는 crossOriginIsolated가 없다(undefined → 비격리). 격리 페이지로 만든다.
    vi.stubGlobal("crossOriginIsolated", true);
  });

  afterEach(() => {
    for (const rpc of workerRpcs.splice(0)) rpc.dispose();
    for (const handle of handles.splice(0)) handle.dispose();
    for (const port of openPorts.splice(0)) port.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
}

/**
 * 하니스 세션 헬퍼를 거치지 않고 `createRepl`로 만든 핸들을 정리 대상에 올린다(비격리 페이지 시험 등).
 * 받은 핸들을 그대로 돌려준다.
 */
export function trackHandle(handle: ReplHandle): ReplHandle {
  handles.push(handle);
  return handle;
}
