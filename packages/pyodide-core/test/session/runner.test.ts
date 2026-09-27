// @vitest-environment node
/**
 * `createRunner` 시험(가짜 worker + 가짜 타이머). 실제 `startCoreSession`·`MessageChannel`·인터럽트 송신기·stdin 메일박스를 쓰고
 * worker 쪽만 시험이 흉내 낸다: 초기화 프레임의 포트에 `createRpc`를 붙여 `runCode`를 받고 `ready`·`readInput`·`write` 알림을
 * 보낸다. 시간(`stop()`의 1000ms 폴백)은 vitest 가짜 타이머(`setTimeout`·`clearTimeout`만)로 밀고 실시간 대기는 없다.
 * MessagePort 왕복은 `setImmediate` 회전으로 기다린다(조건이 참이 될 때까지, 벽시계 시간 상한 없음).
 * 실제 pyodide 통합은 `runner-pyodide.test.ts`가 본다.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SIGNAL } from "../../src/protocol/interrupt-protocol";
import type { RunOutcome } from "../../src/protocol/run-outcome";
import { STDIN_EOF } from "../../src/protocol/stdin-eof";
import { DEFAULT_PYODIDE_INDEX_URL } from "../../src/pyodide-version";
import {
  createFakeWorker,
  createFakeWorkerFactory,
  type FakeWorker,
  type FakeWorkerFactory,
  type MailboxResponse,
} from "../fake-worker";
import {
  createRunner,
  RunRejectedError,
  STOP_FALLBACK_MS,
  type InputProvider,
  type RunnerHandle,
  type RunnerOptions,
  type RunnerStatus,
  type RunResult,
} from "../../src/session/runner";

const factories: FakeWorkerFactory[] = [];
const runners: RunnerHandle[] = [];

beforeEach(() => {
  // 비격리 환경(node)에서는 `crossOriginIsolated`가 없다. worker를 만드는 경로는 격리를 전제한다.
  vi.stubGlobal("crossOriginIsolated", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  for (const runner of runners.splice(0)) runner.dispose();
  for (const factory of factories.splice(0)) factory.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** MessagePort로 도착하는 메시지를 기다린다. 조건이 참이 될 때까지 이벤트 루프를 돌린다(시간 상한 없이 회전 수로 끊는다). */
async function until(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 5000; turn += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("기다리던 상태가 되지 않았다");
}

/** 도착하지 않아야 할 메시지를 단언하기 전에 이벤트 루프를 충분히 돌린다. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

interface Started {
  runner: RunnerHandle;
  workers: FakeWorker[];
  /** 마지막으로 만든 fake worker. 단일 worker 시험에서 `workers[0]!`를 대체한다(재생성 시험은 `workers[i]`를 그대로 쓴다). */
  worker(): FakeWorker;
  /** 가장 오래된 미종결 `runCode`를 끝낸다(호출마다 다음으로 오래된 것). 뒤따르는 status 대기는 호출자가 한다. */
  finishRun(outcome?: RunOutcome): Promise<void>;
  /** `worker().readInput()` 뒤 `worker().takeResponse()`를 돌려준다. 응답을 기다리지 않는 시험은 `worker().readInput()`을 직접 부른다. */
  readInput(): Promise<MailboxResponse>;
  createWorker: ReturnType<typeof vi.fn<() => Worker>>;
  onOutput: ReturnType<typeof vi.fn>;
  onStatus: ReturnType<typeof vi.fn<(status: RunnerStatus) => void>>;
  onCrash: ReturnType<typeof vi.fn<(message: string) => void>>;
  onLoadFailed: ReturnType<typeof vi.fn<(message: string) => void>>;
  statuses: RunnerStatus[];
}

function start(options: Partial<RunnerOptions> = {}): Started {
  const factory = createFakeWorkerFactory();
  factories.push(factory);
  const createWorker = vi.fn(factory.createWorker);
  const statuses: RunnerStatus[] = [];
  const onStatus = vi.fn((status: RunnerStatus) => {
    statuses.push(status);
  });
  const onOutput = vi.fn();
  const onCrash = vi.fn<(message: string) => void>();
  const onLoadFailed = vi.fn<(message: string) => void>();
  const runner = createRunner({
    createWorker,
    onOutput,
    onStatus,
    onCrash,
    onLoadFailed,
    ...options,
  });
  runners.push(runner);
  const worker = () => factory.workers.at(-1)!;
  let finishedRuns = 0;
  const finishRun = async (outcome: RunOutcome = { kind: "ok" }) => {
    const index = finishedRuns;
    await until(() => worker().pending.length > index);
    finishedRuns += 1;
    worker().pending[index]!.resolve(outcome);
  };
  const readInput = async () => {
    worker().readInput();
    return worker().takeResponse();
  };
  return {
    runner,
    workers: factory.workers,
    worker,
    finishRun,
    readInput,
    createWorker,
    onOutput,
    onStatus,
    onCrash,
    onLoadFailed,
    statuses,
  };
}

/** worker를 만들고 `ready`까지 진행한다. */
async function startReady(options: Partial<RunnerOptions> = {}) {
  const started = start(options);
  started.worker().ready();
  await until(() => started.runner.status === "ready");
  return started;
}

/** `run()`을 시작하고 worker가 `runCode`를 받을 때까지 기다린다. */
async function runAndWait(
  { runner, workers }: Started,
  code = "print(1)",
  worker = 0,
) {
  const result = runner.run(code);
  // 거부되는 run의 Promise를 시험이 붙잡기 전에 unhandled로 새지 않게 한다.
  result.catch(() => {});
  await until(() => workers[worker]!.pending.length > 0);
  // async 함수가 Promise를 그대로 돌려주면 run의 완료까지 기다리게 되므로 객체로 감싼다.
  return { result };
}

/** 영원히 끝나지 않는 provider. 받은 signal을 숨긴다. 호출 여부는 `provider`(vi.fn) 매처로 본다. */
function stalledProvider() {
  let signal: AbortSignal | undefined;
  const provider = vi.fn<InputProvider>((_prompt, sig) => {
    signal = sig;
    return new Promise<string | null>(() => {});
  });
  return { provider, signal: () => signal };
}

describe("createRunner: 생성과 옵션 검증", () => {
  test.each([
    ["filename이 빈 문자열", { filename: "" }, /filename/],
    [
      "filename이 문자열이 아님",
      { filename: 1 as unknown as string },
      /filename/,
    ],
    [
      "topLevelAwait가 boolean이 아님",
      { topLevelAwait: "yes" as unknown as boolean },
      /topLevelAwait/,
    ],
  ])("%s이면 worker를 만들기 전에 동기로 던진다", (_name, bad, message) => {
    const createWorker = vi.fn(() => createFakeWorker().worker);

    expect(() =>
      createRunner({ createWorker, onOutput: () => {}, ...bad }),
    ).toThrow(message);
    expect(createWorker).not.toHaveBeenCalled();
  });

  test("옵션을 생략하면 프레임 driver 필드에 기본값 filename·topLevelAwait를 싣는다", () => {
    const { worker } = start();

    expect(worker().frame().driver).toStrictEqual({
      filename: "main.py",
      topLevelAwait: false,
    });
  });

  test("지정한 filename·topLevelAwait는 프레임에 그대로 실린다", () => {
    const { worker } = start({ filename: "app.py", topLevelAwait: true });

    expect(worker().frame().driver).toStrictEqual({
      filename: "app.py",
      topLevelAwait: true,
    });
  });

  test("pyodide 위치를 생략하면 기본 CDN을, 지정하면 끝 슬래시를 보정해 프레임에 싣는다", () => {
    const basic = start();
    const custom = start({ pyodide: { indexURL: "https://x.test/pyodide" } });

    expect(basic.worker().frame().pyodide.indexURL).toBe(
      DEFAULT_PYODIDE_INDEX_URL,
    );
    expect(custom.worker().frame().pyodide.indexURL).toBe(
      "https://x.test/pyodide/",
    );
  });

  test("첫 상태 loading을 createRunner가 반환하기 전에 동기로 알린다", () => {
    const { statuses, runner } = start();

    expect(statuses).toEqual(["loading"]);
    expect(runner.status).toBe("loading");
  });

  test("cross-origin isolation이 꺼져 있으면 worker 없이 not-isolated이고 run은 unavailable로 거부된다", async () => {
    vi.stubGlobal("crossOriginIsolated", false);
    const { runner, createWorker, statuses } = start();

    expect(createWorker).not.toHaveBeenCalled();
    expect(statuses).toEqual(["not-isolated"]);
    expect(runner.status).toBe("not-isolated");
    await expect(runner.run("1")).rejects.toMatchObject({
      name: "RunRejectedError",
      reason: "unavailable",
    });
    await expect(runner.stop()).resolves.toBe("idle");
    runner.reset();
    runner.interrupt();
    expect(createWorker).not.toHaveBeenCalled();
  });
});

describe("createRunner: 상태 전이", () => {
  test("ready 알림이 오면 ready가 된다", async () => {
    const { statuses } = await startReady();

    expect(statuses).toEqual(["loading", "ready"]);
  });

  test("run 중에는 running, 결과가 오면 ready로 돌아온다", async () => {
    const started = await startReady();
    const { result } = await runAndWait(started);

    expect(started.runner.status).toBe("running");
    await started.finishRun({ kind: "ok" });

    await result;
    expect(started.statuses).toEqual(["loading", "ready", "running", "ready"]);
  });

  test.each<[string, RunOutcome]>([
    ["ok", { kind: "ok" }],
    [
      "error",
      { kind: "error", errorType: "ZeroDivisionError", traceback: "tb" },
    ],
    ["interrupted", { kind: "interrupted", traceback: "tb" }],
    ["exit", { kind: "exit", code: 3 }],
  ])(
    "worker가 돌려준 결말 %s을(를) 그대로 resolve한다",
    async (_name, outcome) => {
      const started = await startReady();
      const result = started.runner.run("code");

      await started.finishRun(outcome);

      await expect(result).resolves.toStrictEqual(outcome);
      expect(started.runner.status).toBe("ready");
    },
  );

  test("runCode에는 넘긴 코드가 그대로 간다", async () => {
    const started = await startReady();

    await runAndWait(started, "x = 1\nprint(x)");

    expect(started.worker().pending[0]!.code).toBe("x = 1\nprint(x)");
  });

  test("readInput 알림이 오면 waiting-input, 응답이 끝나면 running으로 돌아온다", async () => {
    const provider = vi.fn<InputProvider>(async () => "abc");
    const started = await startReady({ inputProvider: provider });
    await runAndWait(started);

    started.worker().readInput();
    await until(() => started.statuses.includes("waiting-input"));
    await until(() => started.runner.status === "running");

    expect(started.statuses).toEqual([
      "loading",
      "ready",
      "running",
      "waiting-input",
      "running",
    ]);
  });

  test("pyodide 로드 실패는 load-failed로 알리고 메시지를 onLoadFailed로 준다", async () => {
    const started = start();

    started.worker().loadFailed("cdn 접속 실패");
    await until(() => started.runner.status === "load-failed");

    expect(started.onLoadFailed).toHaveBeenCalledWith("cdn 접속 실패");
    await expect(started.runner.run("1")).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  test("로딩 대기 중인 run은 pyodide 로드 실패로 unavailable 거부를 받는다", async () => {
    const started = start();
    const result = started.runner.run("waiting");
    const rejected = expect(result).rejects.toMatchObject({
      name: "RunRejectedError",
      reason: "unavailable",
    });

    started.worker().loadFailed("cdn 접속 실패");

    await rejected;
  });

  test("worker error 이벤트는 crashed와 onCrash로 알리고 자동 재생성하지 않는다", async () => {
    const started = await startReady();

    started.worker().dispatchError("boom");

    expect(started.runner.status).toBe("crashed");
    expect(started.onCrash).toHaveBeenCalledWith("boom");
    await vi.advanceTimersByTimeAsync(STOP_FALLBACK_MS * 5);
    expect(started.createWorker).toHaveBeenCalledTimes(1);
    await expect(started.runner.run("1")).rejects.toMatchObject({
      reason: "unavailable",
    });
  });
});

describe("createRunner: run 거부와 로딩 대기", () => {
  test("실행 중에 run을 또 부르면 busy로 거부하고 worker에는 한 번만 보낸다", async () => {
    const started = await startReady();
    await runAndWait(started, "first");

    const second = started.runner.run("second");

    await expect(second).rejects.toMatchObject({
      name: "RunRejectedError",
      reason: "busy",
    });
    await settle();
    expect(started.worker().pending.map((run) => run.code)).toEqual(["first"]);
  });

  test("앞선 run이 끝나면 다음 run을 받는다", async () => {
    const started = await startReady();
    await runAndWait(started, "first");
    await started.finishRun({ kind: "ok" });
    await until(() => started.runner.status === "ready");

    const second = started.runner.run("second");
    await started.finishRun({ kind: "exit", code: 0 });

    await expect(second).resolves.toStrictEqual({ kind: "exit", code: 0 });
  });

  test("loading 중 run은 ready까지 기다렸다가 실행한다", async () => {
    const started = start();
    const result = started.runner.run("late");
    await settle();

    expect(started.worker().pending).toHaveLength(0);
    expect(started.runner.status).toBe("loading");

    started.worker().ready();
    await until(() => started.worker().pending.length === 1);
    expect(started.worker().pending[0]!.code).toBe("late");
    expect(started.runner.status).toBe("running");
    await started.finishRun({ kind: "ok" });

    await expect(result).resolves.toStrictEqual({ kind: "ok" });
  });

  test("로딩 대기 중인 run도 슬롯을 차지해 두 번째 run은 busy다", async () => {
    const started = start();
    void started.runner.run("waiting").catch(() => {});

    await expect(started.runner.run("second")).rejects.toMatchObject({
      reason: "busy",
    });
  });

  test("busy는 run이 슬롯을 차지한 동안(로딩 대기·실행 중) 참이고 결과가 오면 거짓이다", async () => {
    const started = start();
    expect(started.runner.busy).toBe(false);

    const result = started.runner.run("late");
    expect(started.runner.busy).toBe(true);
    started.worker().ready();
    await until(() => started.worker().pending.length === 1);
    expect(started.runner.busy).toBe(true);
    await started.finishRun({ kind: "ok" });
    await result;

    expect(started.runner.busy).toBe(false);
  });

  test("busy는 run 없는 배경 input() 대기(waiting-input)에서도 참이다", async () => {
    const started = await startReady({
      inputProvider: stalledProvider().provider,
    });

    started.worker().readInput();
    await until(() => started.runner.status === "waiting-input");

    expect(started.runner.busy).toBe(true);
  });

  test("reset 직후 같은 틱에도 busy는 실행 중이던 run이 비운 슬롯을 거짓으로 읽는다", async () => {
    const started = await startReady();
    await runAndWait(started);

    started.runner.reset();

    expect(started.runner.busy).toBe(false);
  });

  test("로딩 대기 중 stop은 대기를 취소한다: run은 unavailable로 거부되고 stop은 idle이며 ready 뒤에도 실행하지 않는다", async () => {
    const started = start();
    const result = started.runner.run("waiting");
    const rejected = expect(result).rejects.toMatchObject({
      reason: "unavailable",
    });

    await expect(started.runner.stop()).resolves.toBe("idle");
    await rejected;
    started.worker().ready();
    await until(() => started.runner.status === "ready");
    await settle();

    expect(started.worker().pending).toHaveLength(0);
  });

  test("dispose 뒤 run은 disposed로 거부된다", async () => {
    const started = await startReady();
    started.runner.dispose();

    await expect(started.runner.run("1")).rejects.toMatchObject({
      reason: "disposed",
    });
  });

  test("worker가 runCode를 오류로 답하면 그 오류로 reject하고 ready로 돌아온다", async () => {
    const started = await startReady();
    const { result } = await runAndWait(started);
    const rejected = expect(result).rejects.toThrow("재진입 거부");

    started.worker().pending[0]!.reject(new Error("runCode 재진입 거부"));

    await rejected;
    expect(started.runner.status).toBe("ready");
  });

  test("code가 문자열이 아니면 TypeError로 거부한다", async () => {
    const started = await startReady();

    await expect(
      started.runner.run(1 as unknown as string),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("createRunner: stop", () => {
  test("ready에서 stop은 눌림 없이 즉시 idle이다", async () => {
    const started = await startReady();

    await expect(started.runner.stop()).resolves.toBe("idle");

    expect(started.worker().signal()).toBe(0);
  });

  test("실행 중 stop은 interrupt를 보내고 폴백 시간 안에 run이 끝나면 stopped이며 worker를 교체하지 않는다", async () => {
    const started = await startReady();
    const { result } = await runAndWait(started);

    const stopped = started.runner.stop();
    expect(started.worker().signal()).toBe(2);
    await started.finishRun({
      kind: "interrupted",
      traceback: "KeyboardInterrupt",
    });

    await expect(stopped).resolves.toBe("stopped");
    await expect(result).resolves.toStrictEqual({
      kind: "interrupted",
      traceback: "KeyboardInterrupt",
    });
    // 끝난 뒤에는 폴백 타이머가 남아 있지 않다.
    await vi.advanceTimersByTimeAsync(STOP_FALLBACK_MS * 5);
    expect(started.createWorker).toHaveBeenCalledTimes(1);
    expect(started.worker().terminated()).toBe(false);
    expect(started.runner.status).toBe("ready");
  });

  test("폴백 시간 직전(999ms)에는 worker를 교체하지 않는다", async () => {
    const started = await startReady();
    await runAndWait(started);

    void started.runner.stop();
    await vi.advanceTimersByTimeAsync(STOP_FALLBACK_MS - 1);

    expect(started.createWorker).toHaveBeenCalledTimes(1);
    expect(started.worker().terminated()).toBe(false);
    expect(started.runner.status).toBe("running");
  });

  test("폴백 시간(1000ms)이 지나면 worker를 terminate하고 새로 만들며 run은 restarted, stop은 restarted다", async () => {
    const started = await startReady();
    const { result } = await runAndWait(started);

    const stopped = started.runner.stop();
    await vi.advanceTimersByTimeAsync(STOP_FALLBACK_MS);

    await expect(stopped).resolves.toBe("restarted");
    await expect(result).resolves.toStrictEqual({ kind: "restarted" });
    expect(started.workers[0]!.terminateCount()).toBe(1);
    expect(started.createWorker).toHaveBeenCalledTimes(2);
    expect(started.runner.status).toBe("restarting");
  });

  test("폴백 뒤 새 worker가 ready가 되면 다음 run은 새 worker에서 실행된다", async () => {
    const started = await startReady();
    await runAndWait(started, "loop");
    const stopped = started.runner.stop();
    await vi.advanceTimersByTimeAsync(STOP_FALLBACK_MS);
    await stopped;

    started.workers[1]!.ready();
    await until(() => started.runner.status === "ready");
    const next = started.runner.run("again");
    await until(() => started.workers[1]!.pending.length === 1);
    started.workers[1]!.pending[0]!.resolve({ kind: "ok" });

    await expect(next).resolves.toStrictEqual({ kind: "ok" });
    expect(started.workers[0]!.pending.map((run) => run.code)).toEqual([
      "loop",
    ]);
    expect(started.statuses).toEqual([
      "loading",
      "ready",
      "running",
      "restarting",
      "ready",
      "running",
      "ready",
    ]);
  });

  test("폴백으로 재생성한 worker에는 새 interrupt buffer를 싣고 옛 눌림은 옛 buffer에 남는다", async () => {
    const started = await startReady();
    await runAndWait(started);
    void started.runner.stop();
    expect(started.workers[0]!.signal()).toBe(2);

    await vi.advanceTimersByTimeAsync(STOP_FALLBACK_MS);

    // 옛 worker가 terminate() 뒤에도 한동안 살아 있으면 같은 buffer의 눌림을 가로챈다(브라우저 실측). buffer를 나눠 막는다.
    expect(started.workers[1]!.frame().interruptBuffer).not.toBe(
      started.workers[0]!.frame().interruptBuffer,
    );
    expect(started.workers[1]!.signal()).toBe(0);
    expect(started.workers[0]!.signal()).toBe(2);
  });

  test("폴백 뒤 새 worker의 interrupt()는 새 buffer에만 눌림을 쓴다", async () => {
    const started = await startReady();
    await runAndWait(started, "loop");
    void started.runner.stop();
    await vi.advanceTimersByTimeAsync(STOP_FALLBACK_MS);
    started.workers[1]!.ready();
    await until(() => started.runner.status === "ready");
    await runAndWait(started, "loop", 1);
    // 옛 buffer의 stop() 눌림을 치워 두고, 이후 옛 buffer에 새 눌림이 쓰이는지만 본다.
    Atomics.store(started.workers[0]!.frame().interruptBuffer, SIGNAL, 0);

    started.runner.interrupt();

    expect(started.workers[1]!.signal()).toBe(2);
    expect(started.workers[0]!.signal()).toBe(0);
  });

  test("reset()으로 재생성한 worker에도 새 interrupt buffer를 싣는다", async () => {
    const started = await startReady();

    started.runner.reset();

    expect(started.workers[1]!.frame().interruptBuffer).not.toBe(
      started.workers[0]!.frame().interruptBuffer,
    );
  });

  test("stop을 겹쳐 부르면 같은 결말을 공유하고 타이머는 처음 호출 시각부터다", async () => {
    const started = await startReady();
    await runAndWait(started);

    const first = started.runner.stop();
    await vi.advanceTimersByTimeAsync(600);
    const second = started.runner.stop();
    await vi.advanceTimersByTimeAsync(400);

    await expect(first).resolves.toBe("restarted");
    await expect(second).resolves.toBe("restarted");
  });

  test("waiting-input에서 stop은 공급자 signal을 abort하고 메일박스를 cancel하며 눌림은 보내지 않는다", async () => {
    const { provider, signal } = stalledProvider();
    const started = await startReady({ inputProvider: provider });
    await runAndWait(started);
    started.worker().readInput();
    await until(() => started.runner.status === "waiting-input");

    const stopped = started.runner.stop();
    await expect(started.worker().takeResponse()).resolves.toEqual({
      kind: "cancelled",
    });

    expect(signal()?.aborted).toBe(true);
    expect(started.worker().signal()).toBe(0);
    await started.finishRun({
      kind: "interrupted",
      traceback: "KeyboardInterrupt",
    });
    await expect(stopped).resolves.toBe("stopped");
  });

  test("stop 중에 시작된 입력 읽기는 공급자를 부르지 않고 바로 취소한다", async () => {
    const { provider } = stalledProvider();
    const started = await startReady({ inputProvider: provider });
    await runAndWait(started);
    void started.runner.stop();

    await expect(started.readInput()).resolves.toEqual({
      kind: "cancelled",
    });

    expect(provider).not.toHaveBeenCalled();
  });
});

describe("createRunner: interrupt", () => {
  test("[I3] 실행 중 interrupt는 눌림만 보내고 폴백 시간이 지나도 worker를 교체하지 않으며 sent를 돌려준다", async () => {
    const started = await startReady();
    await runAndWait(started);

    expect(started.runner.interrupt()).toBe("sent");

    expect(started.worker().signal()).toBe(2);
    await vi.advanceTimersByTimeAsync(STOP_FALLBACK_MS * 3);
    expect(started.createWorker).toHaveBeenCalledTimes(1);
    expect(started.worker().terminated()).toBe(false);
    expect(started.runner.status).toBe("running");
  });

  test("[I4] ready·loading에서 interrupt는 아무 일도 하지 않고 ignored를 돌려준다", async () => {
    const loading = start();
    expect(loading.runner.interrupt()).toBe("ignored");
    expect(loading.worker().signal()).toBe(0);

    const ready = await startReady();
    expect(ready.runner.interrupt()).toBe("ignored");
    expect(ready.worker().signal()).toBe(0);
  });

  test("[I4] crashed에서 interrupt는 ignored를 돌려준다", async () => {
    const started = await startReady();
    started.worker().crashedNotice("boom");
    await until(() => started.runner.status === "crashed");

    expect(started.runner.interrupt()).toBe("ignored");
    expect(started.worker().signal()).toBe(0);
  });

  test("[I2] waiting-input에서 interrupt는 읽기를 취소하고 input-cancelled를 돌려준다(메일박스 cancel, 공급자 signal abort)", async () => {
    const { provider, signal } = stalledProvider();
    const started = await startReady({ inputProvider: provider });
    await runAndWait(started);
    started.worker().readInput();
    await until(() => started.runner.status === "waiting-input");

    expect(started.runner.interrupt()).toBe("input-cancelled");
    await expect(started.worker().takeResponse()).resolves.toEqual({
      kind: "cancelled",
    });

    expect(signal()?.aborted).toBe(true);
    expect(started.worker().signal()).toBe(0);
  });
});

describe("createRunner: 생애 사건(reset·dispose·크래시)", () => {
  test("실행 중 reset은 run을 restarted로 끝내고 worker를 교체한다", async () => {
    const started = await startReady();
    const { result } = await runAndWait(started);

    started.runner.reset();

    await expect(result).resolves.toStrictEqual({ kind: "restarted" });
    expect(started.workers[0]!.terminateCount()).toBe(1);
    expect(started.createWorker).toHaveBeenCalledTimes(2);
    expect(started.runner.status).toBe("restarting");
  });

  test("reset이 기다리던 stop을 restarted로 끝내고 폴백 타이머를 남기지 않는다", async () => {
    const started = await startReady();
    await runAndWait(started);
    const stopped = started.runner.stop();

    started.runner.reset();

    await expect(stopped).resolves.toBe("restarted");
    await vi.advanceTimersByTimeAsync(STOP_FALLBACK_MS * 3);
    expect(started.createWorker).toHaveBeenCalledTimes(2);
  });

  test("로딩 대기 중인 run은 reset을 넘어 새 worker가 ready가 되면 실행된다", async () => {
    const started = start();
    const result = started.runner.run("waiting");

    started.runner.reset();
    started.workers[1]!.ready();
    await until(() => started.workers[1]!.pending.length === 1);
    started.workers[1]!.pending[0]!.resolve({ kind: "ok" });

    await expect(result).resolves.toStrictEqual({ kind: "ok" });
    expect(started.workers[0]!.pending).toHaveLength(0);
  });

  test("reset 직후 같은 틱에 낸 run은 옛 실행의 뒤늦은 rpc 거부에 지워지지 않고 새 worker에서 실행된다", async () => {
    const started = await startReady();
    await runAndWait(started, "old");

    started.runner.reset();
    const result = started.runner.run("new");
    started.workers[1]!.ready();
    await until(() => started.workers[1]!.pending.length === 1);
    started.workers[1]!.pending[0]!.resolve({ kind: "ok" });

    await expect(result).resolves.toStrictEqual({ kind: "ok" });
  });

  test("ready 알림 콜백 안에서 reset을 부르면 대기 run은 준비 안 된 새 worker에 보내지 않고 그 worker가 ready가 되면 실행한다", async () => {
    let resetOnReady = true;
    // 첫 상태(loading)는 `start()`가 반환하기 전에 오지만 ready가 아니라 `started`를 읽지 않는다.
    const started: Started = start({
      onStatus: (status) => {
        if (status === "ready" && resetOnReady) {
          resetOnReady = false;
          started.runner.reset();
        }
      },
    });
    const result = started.runner.run("waiting");

    started.workers[0]!.ready();
    await until(() => started.workers.length === 2);
    await settle();

    expect(started.workers[0]!.pending).toHaveLength(0);
    expect(started.workers[1]!.pending).toHaveLength(0);
    expect(started.runner.status).toBe("restarting");

    started.workers[1]!.ready();
    await until(() => started.workers[1]!.pending.length === 1);
    started.workers[1]!.pending[0]!.resolve({ kind: "ok" });
    await expect(result).resolves.toStrictEqual({ kind: "ok" });
  });

  test("stop 폴백의 재생성에서 createWorker가 던지면 run·stop 모두 restarted이고 상태는 crashed다", async () => {
    const started = await startReady();
    const { result } = await runAndWait(started);
    started.createWorker.mockImplementationOnce(() => {
      throw new Error("worker 생성 실패");
    });

    const stopped = started.runner.stop();
    await vi.advanceTimersByTimeAsync(STOP_FALLBACK_MS);

    await expect(stopped).resolves.toBe("restarted");
    await expect(result).resolves.toStrictEqual({ kind: "restarted" });
    expect(started.runner.status).toBe("crashed");
    expect(started.onCrash).toHaveBeenCalledWith("Error: worker 생성 실패");
  });

  test.each(["crashed", "load-failed"] as const)(
    "%s에서 reset은 새 worker로 복구한다",
    async (state) => {
      const started = start();
      if (state === "crashed") started.workers[0]!.dispatchError("boom");
      else started.workers[0]!.loadFailed("실패");
      await until(() => started.runner.status === state);

      started.runner.reset();
      expect(started.runner.status).toBe("restarting");
      started.workers[1]!.ready();
      await until(() => started.runner.status === "ready");

      expect(started.createWorker).toHaveBeenCalledTimes(2);
    },
  );

  test("실행 중 dispose는 run을 disposed로 거부하고 worker를 끝내며 기다리던 stop은 stopped다", async () => {
    const started = await startReady();
    const { result } = await runAndWait(started);
    const rejected = expect(result).rejects.toMatchObject({
      name: "RunRejectedError",
      reason: "disposed",
    });
    const stopped = started.runner.stop();

    started.runner.dispose();

    await rejected;
    await expect(stopped).resolves.toBe("stopped");
    expect(started.worker().terminateCount()).toBe(1);
  });

  test("[I1] dispose를 두 번 불러도 안전하고 이후 stop은 idle, reset은 no-op, interrupt는 ignored다", async () => {
    const started = await startReady();

    started.runner.dispose();
    started.runner.dispose();

    await expect(started.runner.stop()).resolves.toBe("idle");
    started.runner.reset();
    expect(started.runner.interrupt()).toBe("ignored");
    expect(started.createWorker).toHaveBeenCalledTimes(1);
    expect(started.worker().terminateCount()).toBe(1);
  });

  test("로딩 대기 중인 run은 dispose로 disposed 거부를 받는다", async () => {
    const started = start();
    const result = started.runner.run("waiting");
    const rejected = expect(result).rejects.toMatchObject({
      reason: "disposed",
    });

    started.runner.dispose();

    await rejected;
  });

  test("실행 중 worker error 이벤트는 run을 crashed로 거부하고 재생성하지 않는다", async () => {
    const started = await startReady();
    const { result } = await runAndWait(started);
    const rejected = expect(result).rejects.toMatchObject({
      name: "RunRejectedError",
      reason: "crashed",
    });

    started.worker().dispatchError("boom");

    await rejected;
    expect(started.runner.status).toBe("crashed");
    expect(started.onCrash).toHaveBeenCalledWith("boom");
    expect(started.createWorker).toHaveBeenCalledTimes(1);
  });

  test("crashed 알림도 같다: run은 crashed로 거부되고 상태 crashed 뒤 onCrash를 부른다", async () => {
    const started = await startReady();
    const { result } = await runAndWait(started);
    const rejected = expect(result).rejects.toMatchObject({
      reason: "crashed",
    });

    started.worker().crashedNotice("예외로 끝남");

    await rejected;
    expect(started.statuses.at(-1)).toBe("crashed");
    expect(started.onCrash).toHaveBeenCalledWith("예외로 끝남");
  });

  test("실행 중 크래시는 기다리던 stop을 stopped로 끝낸다", async () => {
    const started = await startReady();
    const { result } = await runAndWait(started);
    result.catch(() => {});
    const stopped = started.runner.stop();

    started.worker().dispatchError("boom");

    await expect(stopped).resolves.toBe("stopped");
  });

  test("옛 worker가 재시작 뒤에 늦게 낸 error 이벤트는 새 세션의 상태를 바꾸지 않는다", async () => {
    const started = await startReady();
    started.runner.reset();
    started.workers[1]!.ready();
    await until(() => started.runner.status === "ready");

    started.workers[0]!.dispatchError("늦은 오류");

    expect(started.runner.status).toBe("ready");
    expect(started.onCrash).not.toHaveBeenCalled();
  });
});

describe("createRunner: 출력과 InputProvider", () => {
  test("write·writeErrorRaw 알림은 stream을 붙여 onOutput으로 그대로 전달한다", async () => {
    const started = await startReady();

    started.worker().write("hello\n");
    started.worker().writeError("oops");
    await until(() => started.onOutput.mock.calls.length === 2);

    expect(started.onOutput.mock.calls).toEqual([
      [{ stream: "stdout", text: "hello\n" }],
      [{ stream: "stderr", text: "oops" }],
    ]);
  });

  test("provider에는 미종결 마지막 줄(출력 꼬리)이 prompt로 가고 응답 줄이 메일박스에 실린다", async () => {
    const provider = vi.fn<InputProvider>(async () => "홍길동");
    const started = await startReady({ inputProvider: provider });
    await runAndWait(started);

    started.worker().write("환영합니다\n이름: ");
    await expect(started.readInput()).resolves.toEqual({
      kind: "line",
      text: "홍길동",
    });

    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0]![0]).toBe("이름: ");
    expect(provider.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
  });

  test("stderr 출력도 화면의 줄로 세어 prompt 꼬리에 반영한다", async () => {
    const provider = vi.fn<InputProvider>(async () => "x");
    const started = await startReady({ inputProvider: provider });
    await runAndWait(started);

    started.worker().write("앞줄");
    started.worker().writeError("경고\n");
    started.worker().write("입력: ");
    started.worker().readInput();
    await until(() => provider.mock.calls.length === 1);

    expect(provider.mock.calls[0]![0]).toBe("입력: ");
  });

  test("provider가 없으면 null을 넘겨 읽기를 취소한다(메일박스 cancel)", async () => {
    const started = await startReady();
    await runAndWait(started);

    await expect(started.readInput()).resolves.toEqual({
      kind: "cancelled",
    });
  });

  test("provider가 null을 돌려주면 메일박스를 cancel한다", async () => {
    const started = await startReady({ inputProvider: async () => null });
    await runAndWait(started);

    await expect(started.readInput()).resolves.toEqual({
      kind: "cancelled",
    });
  });

  test("[C9] provider가 STDIN_EOF를 돌려주면 메일박스를 eof로 싣는다", async () => {
    const started = await startReady({ inputProvider: async () => STDIN_EOF });
    await runAndWait(started);

    await expect(started.readInput()).resolves.toEqual({
      kind: "eof",
    });
  });

  test("provider가 reject하면 메일박스에 오류를 싣는다(input()이 OSError)", async () => {
    const started = await startReady({
      inputProvider: () => Promise.reject(new Error("입력 장치 오류")),
    });
    await runAndWait(started);

    const response = await started.readInput();

    if (response.kind !== "error")
      throw new Error(`unexpected kind: ${response.kind}`);
    expect(response.message).toContain("입력 장치 오류");
  });

  test("provider가 동기로 던져도 같은 오류 경로다", async () => {
    const started = await startReady({
      inputProvider: () => {
        throw new Error("동기 오류");
      },
    });
    await runAndWait(started);

    await expect(started.readInput()).resolves.toMatchObject({
      kind: "error",
    });
  });

  test("새 run은 이전 run이 남긴 미종결 줄을 prompt로 물려받지 않는다", async () => {
    const provider = vi.fn<InputProvider>(async () => "x");
    const started = await startReady({ inputProvider: provider });
    await runAndWait(started);
    started.worker().write("미종결");
    await until(() => started.onOutput.mock.calls.length === 1);
    await started.finishRun({ kind: "ok" });
    await until(() => started.runner.status === "ready");

    void started.runner.run("second").catch(() => {});
    await until(() => started.worker().pending.length === 2);
    started.worker().readInput();
    await until(() => provider.mock.calls.length === 1);

    expect(provider.mock.calls[0]![0]).toBe("");
  });

  test("읽기가 시작되면 꼬리를 비운다: 이어지는 읽기의 prompt는 그 뒤 출력만이다", async () => {
    const provider = vi.fn<InputProvider>(async () => "x");
    const started = await startReady({ inputProvider: provider });
    await runAndWait(started);

    started.worker().write("첫: ");
    // worker가 값을 가져간 것을 흉내 낸다.
    await expect(started.readInput()).resolves.toEqual({
      kind: "line",
      text: "x",
    });
    await until(() => started.runner.status === "running");
    started.worker().write("둘: ");
    started.worker().readInput();
    await until(() => provider.mock.calls.length === 2);

    expect(provider.mock.calls.map((call) => call[0])).toEqual([
      "첫: ",
      "둘: ",
    ]);
  });

  test("reset은 열린 읽기의 signal을 abort하고 옛 메일박스에는 아무것도 쓰지 않는다", async () => {
    let seen: AbortSignal | undefined;
    const started = await startReady({
      inputProvider: (_prompt, signal) => {
        seen = signal;
        return new Promise<string | null>(() => {});
      },
    });
    await runAndWait(started);
    started.workers[0]!.readInput();
    await until(() => started.runner.status === "waiting-input");

    started.runner.reset();
    await settle();

    expect(seen?.aborted).toBe(true);
    expect(started.workers[0]!.peekMailbox()).toEqual({ kind: "none" });
  });

  test("dispose도 열린 읽기의 signal을 abort하고 메일박스에 쓰지 않는다", async () => {
    const { provider, signal } = stalledProvider();
    const started = await startReady({ inputProvider: provider });
    await runAndWait(started);
    started.worker().readInput();
    await until(() => started.runner.status === "waiting-input");

    started.runner.dispose();
    await settle();

    expect(signal()?.aborted).toBe(true);
    expect(started.worker().peekMailbox()).toEqual({ kind: "none" });
  });

  test("공급자가 문자열도 null도 아닌 값을 돌려주면 읽기 취소로 본다", async () => {
    const started = await startReady({
      inputProvider: (() =>
        Promise.resolve(undefined)) as unknown as InputProvider,
    });
    await runAndWait(started);

    await expect(started.readInput()).resolves.toEqual({
      kind: "cancelled",
    });
  });

  test("입력 대기 중 worker가 크래시하면 signal을 abort하고 메일박스에 쓰지 않는다", async () => {
    const { provider, signal } = stalledProvider();
    const started = await startReady({ inputProvider: provider });
    const { result } = await runAndWait(started);
    result.catch(() => {});
    started.worker().readInput();
    await until(() => started.runner.status === "waiting-input");

    started.worker().dispatchError("boom");
    await settle();

    expect(signal()?.aborted).toBe(true);
    expect(started.worker().peekMailbox()).toEqual({ kind: "none" });
  });

  test("run이 끝난 뒤 배경 task의 input() 대기는 waiting-input이고 새 run은 busy, stop은 그 읽기를 취소한다", async () => {
    const started = await startReady({
      inputProvider: () => new Promise<string | null>(() => {}),
    });
    await runAndWait(started);
    await started.finishRun({ kind: "ok" });
    await until(() => started.runner.status === "ready");

    started.worker().readInput();
    await until(() => started.runner.status === "waiting-input");

    await expect(started.runner.run("x")).rejects.toMatchObject({
      reason: "busy",
    });
    await expect(started.runner.stop()).resolves.toBe("idle");
    await expect(started.worker().takeResponse()).resolves.toEqual({
      kind: "cancelled",
    });
  });
});

describe("createRunner: 상태 콜백 안의 재진입과 dispose 뒤 알림", () => {
  /** `onStatus`에서 `when` 상태를 처음 받을 때 `act(runner)`를 부르는 runner. */
  function startReentrant(
    when: RunnerStatus,
    act: (runner: RunnerHandle) => void,
    options: Partial<RunnerOptions> = {},
  ): Started {
    let fired = false;
    // 첫 상태(loading)는 `start()`가 반환하기 전에 온다. `when`은 그 뒤 상태라 그때는 runner가 채워져 있다.
    const holder: { runner?: RunnerHandle } = {};
    const started = start({
      ...options,
      onStatus: (status) => {
        if (status === when && !fired) {
          fired = true;
          act(holder.runner!);
        }
      },
    });
    holder.runner = started.runner;
    return started;
  }

  test("waiting-input 중 dispose하면 그 뒤로 상태 알림이 오지 않고 status도 바뀌지 않는다", async () => {
    const started = await startReady({
      inputProvider: () => new Promise<string | null>(() => {}),
    });
    await runAndWait(started);
    started.worker().readInput();
    await until(() => started.runner.status === "waiting-input");
    const count = started.statuses.length;

    started.runner.dispose();
    await settle();

    expect(started.statuses.slice(count)).toEqual([]);
    expect(started.runner.status).toBe("waiting-input");
  });

  test("dispose 뒤 도착한 출력은 onOutput으로 전달하지 않는다", async () => {
    const started = await startReady();
    await runAndWait(started);

    started.runner.dispose();
    started.worker().write("late");
    await settle();

    expect(started.onOutput).not.toHaveBeenCalled();
  });

  test("크래시 뒤 살아 있는 worker가 input()을 부르면 공급자를 부르지 않고 crashed에 머물며 run은 unavailable이다", async () => {
    const provider = vi.fn<InputProvider>(() => Promise.resolve("x"));
    const started = await startReady({ inputProvider: provider });
    started.worker().dispatchError("Uncaught PythonError");
    await until(() => started.runner.status === "crashed");

    started.worker().readInput();
    await settle();

    expect(provider).not.toHaveBeenCalled();
    expect(started.runner.status).toBe("crashed");
    expect(started.worker().peekMailbox()).toEqual({ kind: "none" });
    await expect(started.runner.run("x")).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  test("crashed 콜백 안에서 reset해도 실행 중이던 run은 crashed로 거부되고 onCrash는 불린다", async () => {
    const started = startReentrant("crashed", (runner) => runner.reset());
    started.workers[0]!.ready();
    await until(() => started.runner.status === "ready");
    const { result } = await runAndWait(started);

    started.workers[0]!.dispatchError("boom");

    await expect(result).rejects.toMatchObject({ reason: "crashed" });
    expect(started.onCrash).toHaveBeenCalledWith("boom");
    expect(started.runner.status).toBe("restarting");
    expect(started.createWorker).toHaveBeenCalledTimes(2);
  });

  test("load-failed 콜백 안에서 reset해도 대기 run은 unavailable로 거부되고 새 worker에서 실행되지 않는다", async () => {
    const started = startReentrant("load-failed", (runner) => runner.reset());
    const result = started.runner.run("waiting");
    result.catch(() => {});

    started.workers[0]!.loadFailed("실패");
    await expect(result).rejects.toMatchObject({ reason: "unavailable" });
    await until(() => started.workers.length === 2);
    started.workers[1]!.ready();
    await settle();

    expect(started.workers[1]!.pending).toHaveLength(0);
  });

  test("running 콜백 안에서 reset하면 runCode는 새 worker로 가지 않고 run은 restarted다", async () => {
    const started = startReentrant("running", (runner) => runner.reset());
    started.workers[0]!.ready();
    await until(() => started.runner.status === "ready");

    const result = started.runner.run("first");
    await until(() => started.workers.length === 2);
    await settle();

    await expect(result).resolves.toStrictEqual({ kind: "restarted" });
    expect(started.workers[1]!.pending).toHaveLength(0);
  });

  test("대기 run을 보내는 running 콜백 안에서 dispose해도 ready 알림 처리가 던지지 않고 run은 disposed다", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const started = startReentrant("running", (runner) => runner.dispose());
    const result = started.runner.run("waiting");
    result.catch(() => {});

    started.worker().ready();
    await settle();

    await expect(result).rejects.toMatchObject({ reason: "disposed" });
    expect(started.worker().terminateCount()).toBe(1);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  test("restarting 콜백 안에서 dispose하면 새로 만든 worker도 terminate된다", async () => {
    const started = startReentrant("restarting", (runner) => runner.dispose());
    started.workers[0]!.ready();
    await until(() => started.runner.status === "ready");

    started.runner.reset();

    for (const worker of started.workers) {
      expect(worker.terminateCount()).toBe(1);
    }
  });

  test("restarting 콜백 안에서 reset하면 마지막 worker 말고는 모두 terminate된다", async () => {
    const started = startReentrant("restarting", (runner) => runner.reset());
    started.workers[0]!.ready();
    await until(() => started.runner.status === "ready");

    started.runner.reset();

    expect(started.workers).toHaveLength(3);
    expect(started.workers.map((w) => w.terminateCount())).toEqual([1, 1, 0]);
  });
});

describe("createRunner: onRunAccepted", () => {
  /** 수락 콜백이 부른 횟수와 매 호출 때의 `busy`·`status` 스냅샷을 모으는 runner. `act`는 콜백 안에서 runner를 다룬다. */
  function startAccepting(
    act?: (runner: RunnerHandle, calls: number) => void,
    options: Partial<RunnerOptions> = {},
  ) {
    const holder: { runner?: RunnerHandle } = {};
    const snapshots: { busy: boolean; status: RunnerStatus }[] = [];
    const onRunAccepted = vi.fn(() => {
      snapshots.push({
        busy: holder.runner!.busy,
        status: holder.runner!.status,
      });
      act?.(holder.runner!, snapshots.length);
    });
    const started = start({ ...options, onRunAccepted });
    holder.runner = started.runner;
    return { ...started, onRunAccepted, snapshots };
  }

  test("수락된 run()은 호출 안에서 동기로 한 번 콜백을 부르고 그 시점에 busy는 참이며 상태는 아직 ready다", async () => {
    const started = startAccepting();
    started.worker().ready();
    await until(() => started.runner.status === "ready");

    const result = started.runner.run("print(1)");

    // await 없이 확인한다: 콜백은 `run()` 호출 안에서 불렸다.
    expect(started.onRunAccepted).toHaveBeenCalledTimes(1);
    expect(started.snapshots).toEqual([{ busy: true, status: "ready" }]);
    await started.finishRun({ kind: "ok" });
    await result;
    expect(started.onRunAccepted).toHaveBeenCalledTimes(1);
  });

  test("콜백은 running 알림(runCode 전송)보다 앞서고 둘 다 run() 반환 전에 일어난다", async () => {
    const order: string[] = [];
    const started = start({
      onStatus: (status) => {
        if (status === "running") order.push("running");
      },
      onRunAccepted: () => {
        order.push("accepted");
      },
    });
    started.worker().ready();
    await until(() => started.runner.status === "ready");

    const result = started.runner.run("print(1)");
    order.push("returned");
    await started.finishRun({ kind: "ok" });
    await result;

    expect(order).toEqual(["accepted", "running", "returned"]);
  });

  test("busy 거부에서는 콜백을 부르지 않는다", async () => {
    const started = startAccepting();
    started.worker().ready();
    await until(() => started.runner.status === "ready");
    await runAndWait(started, "first");

    await expect(started.runner.run("second")).rejects.toMatchObject({
      reason: "busy",
    });

    expect(started.onRunAccepted).toHaveBeenCalledTimes(1);
  });

  test("waiting-input 때문에 busy로 거부되는 run에서도 콜백을 부르지 않는다", async () => {
    const started = startAccepting(undefined, {
      inputProvider: () => new Promise<string | null>(() => {}),
    });
    started.worker().ready();
    await until(() => started.runner.status === "ready");
    started.worker().readInput();
    await until(() => started.runner.status === "waiting-input");

    await expect(started.runner.run("x")).rejects.toMatchObject({
      reason: "busy",
    });

    expect(started.onRunAccepted).not.toHaveBeenCalled();
  });

  test("dispose 뒤 run 거부에서는 콜백을 부르지 않는다", async () => {
    const started = startAccepting();
    started.worker().ready();
    await until(() => started.runner.status === "ready");
    started.runner.dispose();

    await expect(started.runner.run("x")).rejects.toMatchObject({
      reason: "disposed",
    });

    expect(started.onRunAccepted).not.toHaveBeenCalled();
  });

  test.each(["crashed", "load-failed"] as const)(
    "%s 상태의 unavailable 거부에서는 콜백을 부르지 않는다",
    async (state) => {
      const started = startAccepting();
      if (state === "crashed") started.worker().dispatchError("boom");
      else started.worker().loadFailed("실패");
      await until(() => started.runner.status === state);

      await expect(started.runner.run("x")).rejects.toMatchObject({
        reason: "unavailable",
      });

      expect(started.onRunAccepted).not.toHaveBeenCalled();
    },
  );

  test("cross-origin isolation이 꺼진 not-isolated 거부에서는 콜백을 부르지 않는다", async () => {
    vi.stubGlobal("crossOriginIsolated", false);
    const started = startAccepting();

    await expect(started.runner.run("x")).rejects.toMatchObject({
      reason: "unavailable",
    });

    expect(started.onRunAccepted).not.toHaveBeenCalled();
  });

  test("code가 문자열이 아닌 TypeError 거부에서는 콜백을 부르지 않는다", async () => {
    const started = startAccepting();
    started.worker().ready();
    await until(() => started.runner.status === "ready");

    await expect(
      started.runner.run(1 as unknown as string),
    ).rejects.toBeInstanceOf(TypeError);

    expect(started.onRunAccepted).not.toHaveBeenCalled();
  });

  test("loading 중 수락된 run도 즉시 콜백을 부르고 ready 뒤 실행 시작에서는 다시 부르지 않는다", async () => {
    const started = startAccepting();

    const result = started.runner.run("late");

    expect(started.onRunAccepted).toHaveBeenCalledTimes(1);
    expect(started.snapshots).toEqual([{ busy: true, status: "loading" }]);
    started.worker().ready();
    await started.finishRun({ kind: "ok" });
    await result;
    expect(started.onRunAccepted).toHaveBeenCalledTimes(1);
  });

  test("restarting 중 수락된 run도 즉시 콜백을 부르고 새 worker가 ready가 된 뒤에는 다시 부르지 않는다", async () => {
    const started = startAccepting();
    started.workers[0]!.ready();
    await until(() => started.runner.status === "ready");
    started.runner.reset();
    expect(started.runner.status).toBe("restarting");

    const result = started.runner.run("late");

    expect(started.onRunAccepted).toHaveBeenCalledTimes(1);
    expect(started.snapshots).toEqual([{ busy: true, status: "restarting" }]);
    started.workers[1]!.ready();
    await until(() => started.workers[1]!.pending.length === 1);
    started.workers[1]!.pending[0]!.resolve({ kind: "ok" });
    await result;
    expect(started.onRunAccepted).toHaveBeenCalledTimes(1);
  });

  test("콜백 안에서 run을 다시 부르면 busy로 거부되고 콜백은 한 번만 불린다", async () => {
    let inner: Promise<RunResult> | undefined;
    const started = startAccepting((runner) => {
      inner = runner.run("inner");
      inner.catch(() => {});
    });
    started.worker().ready();
    await until(() => started.runner.status === "ready");

    const outer = started.runner.run("outer");

    await expect(inner).rejects.toMatchObject({ reason: "busy" });
    await until(() => started.worker().pending.length === 1);
    expect(started.onRunAccepted).toHaveBeenCalledTimes(1);
    expect(started.worker().pending.map((run) => run.code)).toEqual(["outer"]);
    await started.finishRun({ kind: "ok" });
    await expect(outer).resolves.toStrictEqual({ kind: "ok" });
  });

  test("콜백 안에서 dispose하면 그 run은 disposed로 거부되고 worker에 runCode를 보내지 않는다", async () => {
    const started = startAccepting((runner) => runner.dispose());
    started.worker().ready();
    await until(() => started.runner.status === "ready");

    const result = started.runner.run("x");

    await expect(result).rejects.toMatchObject({ reason: "disposed" });
    await settle();
    expect(started.worker().pending).toHaveLength(0);
    expect(started.worker().terminateCount()).toBe(1);
  });

  test("콜백 안에서 reset하면 옛 worker에는 보내지 않고 새 worker가 ready가 되면 실행한다", async () => {
    const started = startAccepting((runner, calls) => {
      if (calls === 1) runner.reset();
    });
    started.workers[0]!.ready();
    await until(() => started.runner.status === "ready");

    const result = started.runner.run("x");

    await until(() => started.workers.length === 2);
    await settle();
    expect(started.workers[0]!.pending).toHaveLength(0);
    expect(started.workers[1]!.pending).toHaveLength(0);
    expect(started.runner.status).toBe("restarting");
    started.workers[1]!.ready();
    await until(() => started.workers[1]!.pending.length === 1);
    started.workers[1]!.pending[0]!.resolve({ kind: "ok" });
    await expect(result).resolves.toStrictEqual({ kind: "ok" });
    expect(started.onRunAccepted).toHaveBeenCalledTimes(1);
  });

  test("콜백 안에서 stop하면 그 run은 unavailable로 거부되고 미전송이며 stop은 idle이다", async () => {
    let stopped: Promise<string> | undefined;
    const started = startAccepting((runner) => {
      stopped = runner.stop();
    });
    started.worker().ready();
    await until(() => started.runner.status === "ready");

    const result = started.runner.run("x");

    await expect(result).rejects.toMatchObject({ reason: "unavailable" });
    await expect(stopped).resolves.toBe("idle");
    await settle();
    expect(started.worker().pending).toHaveLength(0);
    expect(started.runner.busy).toBe(false);
    expect(started.runner.status).toBe("ready");
  });

  test("콜백이 던지면 run은 그 오류로 reject되고 busy는 거짓이며 runCode는 가지 않고 다음 run을 받는다", async () => {
    const failure = new Error("화면 준비 실패");
    const started = startAccepting((_runner, calls) => {
      if (calls === 1) throw failure;
    });
    started.worker().ready();
    await until(() => started.runner.status === "ready");

    await expect(started.runner.run("first")).rejects.toBe(failure);

    expect(started.runner.busy).toBe(false);
    expect(started.runner.status).toBe("ready");
    await settle();
    expect(started.worker().pending).toHaveLength(0);
    const second = started.runner.run("second");
    await until(() => started.worker().pending.length === 1);
    expect(started.worker().pending[0]!.code).toBe("second");
    await started.finishRun({ kind: "ok" });
    await expect(second).resolves.toStrictEqual({ kind: "ok" });
    expect(started.onRunAccepted).toHaveBeenCalledTimes(2);
  });

  test("loading 중 수락 콜백이 던져도 슬롯을 풀어 ready 뒤에 그 run을 보내지 않는다", async () => {
    const failure = new Error("화면 준비 실패");
    const started = startAccepting(() => {
      throw failure;
    });

    await expect(started.runner.run("late")).rejects.toBe(failure);

    expect(started.runner.busy).toBe(false);
    started.worker().ready();
    await until(() => started.runner.status === "ready");
    await settle();
    expect(started.worker().pending).toHaveLength(0);
  });
});

describe("createRunner: 소비자 콜백 예외 격리(규칙 08-session.md 8.5, X1·X2·X4)", () => {
  let report: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    report = vi.fn();
    vi.stubGlobal("reportError", report);
  });

  test("[X1] 첫 상태 loading 콜백이 던져도 createRunner는 반환하고 worker를 만든다", () => {
    const failure = new Error("loading 콜백 실패");
    const onStatus = vi.fn((status: RunnerStatus) => {
      if (status === "loading") throw failure;
    });

    let started!: Started;
    expect(() => {
      started = start({ onStatus });
    }).not.toThrow();

    expect(started.createWorker).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(failure);
  });

  test("[X2] ready 콜백이 던져도(실행 종료 finishRun 경로) run()은 결과로 resolve한다", async () => {
    const failure = new Error("ready 콜백 실패");
    const onStatus = vi.fn((status: RunnerStatus) => {
      if (status === "ready") throw failure;
    });
    const started = await startReady({ onStatus });
    const { result } = await runAndWait(started);

    await started.finishRun({ kind: "ok" });

    await expect(result).resolves.toStrictEqual({ kind: "ok" });
    expect(started.runner.status).toBe("ready");
    expect(report).toHaveBeenCalledWith(failure);
  });

  test("[X2] ready 콜백이 던져도 로딩 중 대기 run은 ready에서 전송된다(dispatch)", async () => {
    const failure = new Error("ready 콜백 실패");
    const onStatus = vi.fn((status: RunnerStatus) => {
      if (status === "ready") throw failure;
    });
    const started = start({ onStatus });
    const result = started.runner.run("late");
    result.catch(() => {});

    started.worker().ready();
    await until(() => started.worker().pending.length === 1);

    expect(started.worker().pending[0]!.code).toBe("late");
    expect(started.runner.status).toBe("running");
    expect(report).toHaveBeenCalledWith(failure);
    await started.finishRun({ kind: "ok" });
    await result;
  });

  test("[X2] crashed 콜백이 던져도 실행 중 run은 crashed로 거부되고 onCrash가 불린다", async () => {
    const failure = new Error("crashed 콜백 실패");
    const onStatus = vi.fn((status: RunnerStatus) => {
      if (status === "crashed") throw failure;
    });
    const started = await startReady({ onStatus });
    const { result } = await runAndWait(started);
    const rejected = expect(result).rejects.toMatchObject({
      reason: "crashed",
    });

    started.worker().dispatchError("boom");

    await rejected;
    expect(started.runner.status).toBe("crashed");
    expect(started.onCrash).toHaveBeenCalledWith("boom");
    expect(report).toHaveBeenCalledWith(failure);
  });

  test("[X2] onLoadFailed가 던져도 상태는 load-failed가 되고 대기 run은 unavailable로 거부된다", async () => {
    const failure = new Error("onLoadFailed 실패");
    const onLoadFailed = vi.fn(() => {
      throw failure;
    });
    const started = start({ onLoadFailed });
    const result = started.runner.run("waiting");
    const rejected = expect(result).rejects.toMatchObject({
      reason: "unavailable",
    });

    started.worker().loadFailed("cdn 접속 실패");

    await rejected;
    expect(started.runner.status).toBe("load-failed");
    expect(report).toHaveBeenCalledWith(failure);
  });

  test("[X2] load-failed 상태 콜백(onStatus)이 던져도 대기 run은 unavailable로 거부된다", async () => {
    const failure = new Error("load-failed 콜백 실패");
    const onStatus = vi.fn((status: RunnerStatus) => {
      if (status === "load-failed") throw failure;
    });
    const started = start({ onStatus });
    const result = started.runner.run("waiting");
    const rejected = expect(result).rejects.toMatchObject({
      reason: "unavailable",
    });

    started.worker().loadFailed("cdn 접속 실패");

    await rejected;
    expect(report).toHaveBeenCalledWith(failure);
  });

  test("[X2] restarting 콜백이 던져도 실행 중 run은 restarted로 resolve하고 reset()도 던지지 않는다", async () => {
    const failure = new Error("restarting 콜백 실패");
    const onStatus = vi.fn((status: RunnerStatus) => {
      if (status === "restarting") throw failure;
    });
    const started = await startReady({ onStatus });
    const { result } = await runAndWait(started);

    expect(() => started.runner.reset()).not.toThrow();

    await expect(result).resolves.toStrictEqual({ kind: "restarted" });
    expect(report).toHaveBeenCalledWith(failure);
  });

  test("[X2] onCrash가 던져도 보고만 하고 상태는 crashed다", async () => {
    const failure = new Error("onCrash 실패");
    const onCrash = vi.fn(() => {
      throw failure;
    });
    const started = await startReady({ onCrash });

    expect(() => started.worker().dispatchError("boom")).not.toThrow();

    expect(started.runner.status).toBe("crashed");
    expect(report).toHaveBeenCalledWith(failure);
  });

  test("[X4] onRunAccepted가 던지면 지금처럼 run()이 그 오류로 reject하고 reportError는 불리지 않는다", async () => {
    const failure = new Error("accept 실패");
    const started = await startReady({
      onRunAccepted: () => {
        throw failure;
      },
    });

    await expect(started.runner.run("x")).rejects.toBe(failure);

    expect(report).not.toHaveBeenCalled();
  });

  test("[X1] 첫 상태 not-isolated 콜백이 던져도 createRunner는 반환하고 worker를 만들지 않는다", () => {
    vi.stubGlobal("crossOriginIsolated", false);
    const failure = new Error("not-isolated 콜백 실패");
    const onStatus = vi.fn((status: RunnerStatus) => {
      if (status === "not-isolated") throw failure;
    });

    let started!: Started;
    expect(() => {
      started = start({ onStatus });
    }).not.toThrow();

    expect(started.createWorker).not.toHaveBeenCalled();
    expect(started.runner.status).toBe("not-isolated");
    expect(report).toHaveBeenCalledWith(failure);
  });

  test("[X2] stop 폴백 재생성에서 onCrash가 던져도 실행 중이던 run·stop은 restarted로 끝난다", async () => {
    const failure = new Error("onCrash 실패");
    const onCrash = vi.fn(() => {
      throw failure;
    });
    const started = await startReady({ onCrash });
    const { result } = await runAndWait(started);
    started.createWorker.mockImplementationOnce(() => {
      throw new Error("worker 생성 실패");
    });

    const stopped = started.runner.stop();
    await vi.advanceTimersByTimeAsync(STOP_FALLBACK_MS);

    await expect(stopped).resolves.toBe("restarted");
    await expect(result).resolves.toStrictEqual({ kind: "restarted" });
    expect(started.runner.status).toBe("crashed");
    expect(report).toHaveBeenCalledWith(failure);
  });
});

describe("RunRejectedError", () => {
  test("reason을 갖고 Error이며 이름은 RunRejectedError다", () => {
    const error = new RunRejectedError("busy");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RunRejectedError");
    expect(error.reason).toBe("busy");
  });
});
