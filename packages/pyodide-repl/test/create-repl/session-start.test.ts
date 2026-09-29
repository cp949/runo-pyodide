/**
 * `createRepl` 세션 시작 시험(RD-004·RD-012).
 * - 격리 페이지: worker를 만들고 초기화 프레임을 보낸다. `ready`·`loadFailed`·`sessionTerminated`·출력 알림 4종에 답한다.
 * - 비격리 페이지: worker 없이 경고만 낸다.
 * - `topLevelAwait` 옵션: 첫 프레임과 `reset()` 뒤 프레임(`frame.driver`)에 sticky하게 실리는지 본다.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createRepl,
  DEFAULT_PYODIDE_INDEX_URL,
  NOT_ISOLATED_WARNING,
} from "../../src/index";
import {
  type InitFrame,
  DEFAULT_PYODIDE_INDEX_URL as CORE_DEFAULT_PYODIDE_INDEX_URL,
  PYODIDE_VERSION,
} from "@cp949/runo-pyodide-core";
import { parseInitFrame } from "@cp949/runo-pyodide-core/worker";
import { createFakeTerminal } from "@repo/pyodide-testkit/fake-terminal";
import {
  createFakeWorker,
  createWorker,
  startSession,
  startResettableSession,
  startRead,
  must,
  settle,
  waitFor,
  readyPayload,
  topLevelAwaitOf,
  trackHandle,
  useReplHarness,
} from "./harness";

useReplHarness();

describe("격리 페이지의 세션 시작", () => {
  test("worker를 만들고 첫 메시지로 검증을 통과하는 초기화 프레임을 전송 목록과 함께 보낸다", () => {
    const { createWorkerSpy, fakeWorker } = startSession();

    expect(createWorkerSpy).toHaveBeenCalledTimes(1);
    expect(fakeWorker.postMessage).toHaveBeenCalledTimes(1);
    // MessagePort를 든 객체에는 toEqual·toContain을 쓰지 않는다. 순환 내부 참조가 있다.
    // 정체성으로 본다.
    const [message, transfer] = fakeWorker.postMessage.mock.calls[0] as [
      InitFrame,
      Transferable[],
    ];
    expect(message).toBe(fakeWorker.frame());
    expect(transfer).toHaveLength(1);
    expect(transfer[0] === message.rpcPort).toBe(true);
    expect(() => parseInitFrame(message)).not.toThrow();
    expect(topLevelAwaitOf(message)).toBe(false);
    expect(message.pyodide.indexURL).toBe(DEFAULT_PYODIDE_INDEX_URL);
  });

  test("`DEFAULT_PYODIDE_INDEX_URL`은 core가 유도한 값의 재export이다", () => {
    expect(DEFAULT_PYODIDE_INDEX_URL).toBe(CORE_DEFAULT_PYODIDE_INDEX_URL);
    // core dist가 낡아 두 값이 모두 undefined여도 통과하지 않게 형태도 본다.
    // 값 자체는 core 상수 시험이 맡는다.
    expect(DEFAULT_PYODIDE_INDEX_URL).toMatch(
      /^https:\/\/cdn\.jsdelivr\.net\/pyodide\/v\d+\.\d+\.\d+\/full\/$/,
    );
  });

  test("`pyodide.indexURL` 옵션이 프레임에 들어가고 끝 `/`가 보장된다", () => {
    const { fakeWorker } = startSession({
      pyodide: { indexURL: "http://localhost:8000/pyodide" },
    });

    expect(fakeWorker.frame().pyodide.indexURL).toBe(
      "http://localhost:8000/pyodide/",
    );
  });

  test("`onStatus('loading')`을 createRepl 반환 전에 동기로 부른다", () => {
    const { onStatus } = startSession();

    expect(onStatus.mock.calls).toEqual([["loading"]]);
  });

  test("[X1] 첫 상태 loading 콜백이 던져도 createRepl은 반환하고 worker를 만든다(규칙: 08-session.md 8.5)", () => {
    const report = vi.fn();
    vi.stubGlobal("reportError", report);
    const failure = new Error("loading 콜백 실패");
    const onStatus = vi.fn(() => {
      throw failure;
    });

    const { createWorkerSpy } = startSession({ onStatus });

    expect(createWorkerSpy).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(failure);
  });

  test("worker의 ready 알림에 `onStatus('ready')`로 답한다", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { onStatus, workerRpc } = startSession();

    workerRpc.notify("ready", readyPayload());
    await waitFor(() => onStatus.mock.calls.length === 2);

    expect(onStatus.mock.calls.at(-1)).toEqual(["ready"]);
    expect(info).toHaveBeenCalledWith("[repl] pyodide 준비", PYODIDE_VERSION);
  });

  test("degraded가 있는 ready 알림은 console.warn 1회와 console.info를 함께 내고 onStatus('ready')로 답한다", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { onStatus, workerRpc } = startSession();

    workerRpc.notify("ready", readyPayload({ degraded: ["compiler-flags"] }));
    await waitFor(() => onStatus.mock.calls.length === 2);

    expect(onStatus.mock.calls.at(-1)).toEqual(["ready"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("[repl] pyodide 준비", PYODIDE_VERSION);
  });

  test("출력 알림 4종이 sink 규칙대로 터미널에 쓰인다", async () => {
    const { workerRpc, bytes } = startSession();

    workerRpc.notify("writeOutput", "v");
    workerRpc.notify("write", "x");
    workerRpc.notify("writeErrorRaw", "e");
    workerRpc.notify("writeError", "T");
    const expected =
      "v\r\n" + "x" + "\x1b[31me\x1b[0m" + "\x1b[31mT\x1b[0m\r\n";
    await waitFor(() => bytes().length >= expected.length);

    expect(bytes()).toBe(expected);
  });

  test("loadFailed 알림은 빨간 실패 줄과 `onStatus('load-failed')`가 된다", async () => {
    const { onStatus, workerRpc, bytes, fakeWorker } = startSession();

    workerRpc.notify("loadFailed", "Error: boom");
    await waitFor(() => onStatus.mock.calls.length === 2);

    expect(bytes()).toContain(
      "\x1b[31mpyodide 로드 실패: Error: boom\x1b[0m\r\n",
    );
    expect(onStatus.mock.calls.at(-1)).toEqual(["load-failed"]);
    // 로드 실패는 worker를 죽이지 않는다.
    expect(fakeWorker.terminate).not.toHaveBeenCalled();
  });

  test("dispose는 worker를 종료하고 이후 알림에 반응하지 않는다", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { handle, fakeWorker, onStatus, workerRpc, fake } = startSession();
    handle.dispose();
    const writtenAtDispose = fake.written.length;
    const statusCallsAtDispose = onStatus.mock.calls.length;

    workerRpc.notify("write", "late");
    workerRpc.notify("ready", readyPayload());
    await settle();

    expect(fakeWorker.terminate).toHaveBeenCalledTimes(1);
    expect(fake.written).toHaveLength(writtenAtDispose);
    expect(onStatus.mock.calls).toHaveLength(statusCallsAtDispose);
    expect(info).not.toHaveBeenCalled();
  });

  test("sessionTerminated 알림에 `onStatus('terminated')`로 답하고 그 뒤 입력은 터미널에 쓰이지 않는다", async () => {
    const session = startSession();
    const { fake, fakeWorker, onStatus, workerRpc } = session;
    const { line } = await startRead(session);
    fake.type("exit()\r");
    await line;
    const writtenBefore = fake.written.length;

    workerRpc.notify("sessionTerminated");
    await waitFor(() => onStatus.mock.calls.length === 2);
    fake.type("abc");

    expect(onStatus.mock.calls.at(-1)).toEqual(["terminated"]);
    // 종료는 터미널에 아무것도 쓰지 않는다. 3.14도 종료 메시지가 없다.
    // worker도 살려 둔다. 복구는 RD-010 reset()이다.
    expect(fake.written).toHaveLength(writtenBefore);
    expect(fakeWorker.terminate).not.toHaveBeenCalled();
  });

  test("[R5] `>>>` 빈 줄 Ctrl+D는 { eof: true } 응답이고, 뒤이은 sessionTerminated로 onStatus('terminated')·runSource가 unavailable이 된다(RD-048)", async () => {
    const session = startSession();
    const { fake, onStatus, workerRpc, handle } = session;
    const { line } = await startRead(session);

    fake.type("\x04");
    await expect(line).resolves.toEqual({ eof: true });

    // 실제 worker의 `repl-loop.ts`는 `{ eof: true }` 응답에 `onTerminated()` → `sessionTerminated` 알림으로 답한다.
    // 단위 시험은 `worker/repl-loop.test.ts` [R4]다.
    // 이 하니스는 worker를 흉내만 내므로 알림을 여기서 재현한다.
    workerRpc.notify("sessionTerminated");
    await waitFor(() => onStatus.mock.calls.length === 2);

    expect(onStatus.mock.calls.at(-1)).toEqual(["terminated"]);
    await expect(handle.runSource("1")).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  test("dispose를 두 번 불러도 worker는 한 번만 종료된다", () => {
    const { handle, fakeWorker } = startSession();

    handle.dispose();
    handle.dispose();

    expect(fakeWorker.terminate).toHaveBeenCalledTimes(1);
  });

  test("crossOriginIsolated 속성이 참이다", () => {
    const { handle } = startSession();

    expect(handle.crossOriginIsolated).toBe(true);
  });

  test("핸들마다 자기 터미널에 쓴다(sink 세트를 세션 사이에 공유하지 않는다)", async () => {
    const first = startSession();
    const second = startSession();

    first.workerRpc.notify("write", "t1");
    second.workerRpc.notify("write", "t2");
    await waitFor(() => first.bytes() !== "" && second.bytes() !== "");

    expect(first.bytes()).toBe("t1");
    expect(second.bytes()).toBe("t2");
  });
});

describe("비격리 페이지", () => {
  beforeEach(() => {
    vi.stubGlobal("crossOriginIsolated", false);
  });

  test("worker를 만들지 않고 노란 경고 한 줄을 낸다", () => {
    const fake = createFakeTerminal();
    const createWorkerSpy = vi.fn(() => createFakeWorker().worker);

    const handle = createRepl({
      terminal: fake.term,
      createWorker: createWorkerSpy,
    });
    trackHandle(handle);

    expect(createWorkerSpy).not.toHaveBeenCalled();
    expect(fake.written.join("")).toContain(
      `\x1b[33m${NOT_ISOLATED_WARNING}\x1b[0m\r\n`,
    );
  });

  test("`onStatus('not-isolated')`만 부른다", () => {
    const fake = createFakeTerminal();
    const onStatus = vi.fn();

    trackHandle(createRepl({ terminal: fake.term, createWorker, onStatus }));

    expect(onStatus.mock.calls).toEqual([["not-isolated"]]);
  });

  test("[X1] 첫 상태 not-isolated 콜백이 던져도 createRepl은 반환한다(규칙: 08-session.md 8.5)", () => {
    const report = vi.fn();
    vi.stubGlobal("reportError", report);
    const fake = createFakeTerminal();
    const failure = new Error("not-isolated 콜백 실패");
    const onStatus = vi.fn(() => {
      throw failure;
    });

    expect(() =>
      trackHandle(createRepl({ terminal: fake.term, createWorker, onStatus })),
    ).not.toThrow();

    expect(report).toHaveBeenCalledWith(failure);
  });

  test("crossOriginIsolated 속성이 거짓이고 dispose가 안전하다", () => {
    const fake = createFakeTerminal();
    const handle = createRepl({ terminal: fake.term, createWorker });

    expect(handle.crossOriginIsolated).toBe(false);
    expect(() => {
      handle.dispose();
      handle.dispose();
    }).not.toThrow();
  });
});

describe("top-level await 옵션(RD-012)", () => {
  test("`topLevelAwait: true`로 만들면 첫 프레임의 topLevelAwait가 true다", () => {
    const { fakeWorker } = startSession({ topLevelAwait: true });

    expect(topLevelAwaitOf(fakeWorker.frame())).toBe(true);
  });

  test("생략·false·boolean이 아닌 값은 첫 프레임의 topLevelAwait가 false다", () => {
    expect(topLevelAwaitOf(startSession().fakeWorker.frame())).toBe(false);
    expect(
      topLevelAwaitOf(
        startSession({ topLevelAwait: false }).fakeWorker.frame(),
      ),
    ).toBe(false);
    expect(
      topLevelAwaitOf(
        startSession({
          topLevelAwait: "yes" as unknown as boolean,
        }).fakeWorker.frame(),
      ),
    ).toBe(false);
  });

  test("reset({ topLevelAwait: true }) 뒤 새 worker의 프레임은 true다", () => {
    const session = startResettableSession();
    expect(topLevelAwaitOf(must(session.workers[0]).frame())).toBe(false);

    session.handle.reset({ topLevelAwait: true });

    expect(session.workers).toHaveLength(2);
    const newWorker = must(session.workers[1]);
    expect(topLevelAwaitOf(newWorker.frame())).toBe(true);
    expect(() => parseInitFrame(newWorker.frame())).not.toThrow();
  });

  test("그 뒤 무인자 reset()의 프레임도 true를 유지한다(sticky)", () => {
    const session = startResettableSession();
    session.handle.reset({ topLevelAwait: true });

    session.handle.reset();

    expect(session.workers).toHaveLength(3);
    expect(topLevelAwaitOf(must(session.workers[2]).frame())).toBe(true);
  });

  test("reset({ topLevelAwait: undefined })·reset({})도 직전 값을 유지한다", () => {
    const session = startResettableSession();
    session.handle.reset({ topLevelAwait: true });

    session.handle.reset({ topLevelAwait: undefined });
    session.handle.reset({});

    expect(session.workers).toHaveLength(4);
    expect(topLevelAwaitOf(must(session.workers[2]).frame())).toBe(true);
    expect(topLevelAwaitOf(must(session.workers[3]).frame())).toBe(true);
  });

  test("reset({ topLevelAwait: false })는 false로 되돌린다", () => {
    const session = startResettableSession();
    session.handle.reset({ topLevelAwait: true });

    session.handle.reset({ topLevelAwait: false });

    expect(session.workers).toHaveLength(3);
    expect(topLevelAwaitOf(must(session.workers[2]).frame())).toBe(false);
  });
});
