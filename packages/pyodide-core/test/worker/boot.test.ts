// @vitest-environment node
/**
 * core `bootWorker`의 부팅 불변식 시험(00-architecture.md 3.1, 01-protocols.md 5절 S1).
 * - driver는 실제 `runDriver`(RD-022)를 그대로 쓴다. 부팅도 실제로 돈다.
 * - 단언은 driver 중립 값만 본다: `ready`·`loadFailed`·`crashed` 알림, 호출 순번, 인터럽트 버퍼 상태.
 * - REPL 타임라인(배너·`readLine` 각본)에는 기대지 않는다.
 *
 * 규칙 ID B1~B8은 `00-architecture.md` 3.1에서 정의한다(RD-040).
 */
import { loadPyodide, type PyodideInterface } from "pyodide";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from "vitest";
import type { InitFrame } from "../../src/protocol/init-frame";
import { signalInterrupt } from "../../src/protocol/interrupt-protocol";
import { parseRunDriverOptions } from "../../src/protocol/run-driver-options";
import { createMainSide } from "../boot-harness";
import { bootWorker } from "../../src/worker/boot";
import type {
  WorkerDriver,
  WorkerDriverSession,
} from "../../src/worker/driver";
import {
  createRunSession,
  type RunDriverOptions,
  type RunSession,
} from "../../src/worker/run-driver";

let pyodide: PyodideInterface;

beforeAll(async () => {
  pyodide = await loadPyodide();
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
  // B3은 버퍼 연결 뒤 setStdin에서 던져 공유 인스턴스에 버퍼가 남는다.
  // 남은 버퍼는 다음 시험의 부팅이 폴링한다. 그래서 매번 연결을 푼다.
  pyodide.setInterruptBuffer(
    undefined as unknown as Parameters<
      PyodideInterface["setInterruptBuffer"]
    >[0],
  );
});

/** `ms` 밀리초 기다린다. `loadFailed` 뒤에 다른 알림이 더 오지 않는지 볼 때 쓴다. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `runDriver`(실제 부팅)를 감싸 `bootWorker`를 부른다.
 * - `options.run`을 주면 그 세션의 `run`만 바꾼다. B8 전용이다. `ready` 뒤 catch 경로를 여는 최소 조작이고, 나머지 세션 동작은 그대로다.
 * - `session()`은 시험이 `end()`로 세션을 끝낼 때 쓴다.
 * - `onTestFinished`가 시험이 끝내지 않은 세션도 정리한다. `end()`를 다시 불러도 안전하다(두 번째 `resolve`는 no-op).
 */
function bootRun(
  frame: InitFrame,
  loadPyodideFn: () => Promise<PyodideInterface>,
  options: { run?: WorkerDriverSession["run"] } = {},
) {
  let session: RunSession | undefined;
  const driver: WorkerDriver<RunDriverOptions> = {
    parseOptions: parseRunDriverOptions,
    createSession: (opts) => {
      const created = createRunSession(opts);
      session = created;
      return options.run ? { ...created, run: options.run } : created;
    },
  };
  const booted = bootWorker(frame, { driver, loadPyodide: loadPyodideFn });
  onTestFinished(async () => {
    session?.end();
    await booted;
  });
  return { booted, session: () => session };
}

describe("core 부팅 불변식", () => {
  test("[B1] 로더가 던지면 loadFailed만 오고 ready는 오지 않으며 driver 실행에 들어가지 않는다", async () => {
    const main = createMainSide();
    const run = vi.fn(async () => {});

    bootRun(
      main.frame,
      async () => {
        throw new Error("boom");
      },
      { run },
    );
    await main.waitFor(() => main.events.length >= 1);
    await sleep(100);

    expect(main.events).toEqual([["loadFailed", "Error: boom"]]);
    expect(run).not.toHaveBeenCalled();
  });

  test("[B2] 콘솔 생성(pyimport)이 던지면 loadFailed만 오고 ready는 오지 않으며 driver 실행에 들어가지 않는다", async () => {
    const main = createMainSide();
    const run = vi.fn(async () => {});
    // 공유 인스턴스를 pyimport만 던지는 Proxy로 감싼다.
    // 콘솔 생성에서 pyimport를 부르는 곳은 `createCoreConsole`의 `pyodide.pyimport("pyodide.console")` 한 곳뿐이다.
    const broken = new Proxy(pyodide, {
      get(target, key) {
        if (key === "pyimport") {
          return () => {
            throw new Error("no console");
          };
        }
        return Reflect.get(target, key) as unknown;
      },
    });

    bootRun(main.frame, async () => broken, { run });
    await main.waitFor(() => main.events.length >= 1);
    await sleep(100);

    expect(main.events).toEqual([["loadFailed", "Error: no console"]]);
    expect(run).not.toHaveBeenCalled();
  });

  test("[B3] setStdin이 던지면 loadFailed만 오고 ready는 오지 않으며 driver 실행에 들어가지 않는다", async () => {
    const main = createMainSide();
    const run = vi.fn(async () => {});
    vi.spyOn(pyodide, "setStdin").mockImplementation(() => {
      throw new Error("bad stdin");
    });

    bootRun(main.frame, async () => pyodide, { run });
    await main.waitFor(() => main.events.length >= 1);
    await sleep(100);

    expect(main.events).toEqual([["loadFailed", "Error: bad stdin"]]);
    expect(run).not.toHaveBeenCalled();
  });

  test("[B4] 버퍼 연결(setInterruptBuffer)이 던지면 loadFailed만 오고 ready는 오지 않으며 driver 실행에 들어가지 않는다", async () => {
    const main = createMainSide();
    const run = vi.fn(async () => {});
    vi.spyOn(pyodide, "setInterruptBuffer").mockImplementation(() => {
      throw new Error("bad interrupt buffer");
    });

    bootRun(main.frame, async () => pyodide, { run });
    await main.waitFor(() => main.events.length >= 1);
    await sleep(100);

    expect(main.events).toEqual([
      ["loadFailed", "Error: bad interrupt buffer"],
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  test("[B5] 버퍼 연결 → setStdin → ready 순서이고, 연결한 버퍼는 프레임의 버퍼다", async () => {
    const main = createMainSide();
    const postMessage = vi.spyOn(main.frame.rpcPort, "postMessage");
    let setInterruptBufferSpy: ReturnType<
      typeof vi.spyOn<PyodideInterface, "setInterruptBuffer">
    >;
    let setStdinSpy: ReturnType<typeof vi.spyOn<PyodideInterface, "setStdin">>;

    const { booted, session } = bootRun(main.frame, async () => {
      const instance = await loadPyodide();
      setInterruptBufferSpy = vi.spyOn(instance, "setInterruptBuffer");
      setStdinSpy = vi.spyOn(instance, "setStdin");
      return instance;
    });
    await main.waitFor(() => main.events.some((e) => e[0] === "ready"));

    // 세 호출의 전역 호출 순번(invocationCallOrder)을 비교한다.
    // `ready`는 포트로 나간 알림 메시지에서 찾는다.
    const readyIndex = postMessage.mock.calls.findIndex(
      ([message]) => (message as { name?: string }).name === "ready",
    );
    expect(readyIndex).toBeGreaterThanOrEqual(0);
    const connectOrder = setInterruptBufferSpy!.mock.invocationCallOrder[0]!;
    const stdinOrder = setStdinSpy!.mock.invocationCallOrder[0]!;
    const readyOrder = postMessage.mock.invocationCallOrder[readyIndex]!;
    expect(connectOrder).toBeLessThan(stdinOrder);
    expect(stdinOrder).toBeLessThan(readyOrder);

    // 세션 종료(driver 실행·감시 타이머 정지)까지 끝난 뒤에도 연결은 한 번뿐이다.
    // ready 직후만 보면 그 뒤 run·teardown 중의 재연결을 놓친다.
    session()!.end();
    await booted;
    expect(setInterruptBufferSpy!).toHaveBeenCalledTimes(1);
    expect(setInterruptBufferSpy!.mock.calls[0]![0]).toBe(
      main.frame.interruptBuffer,
    );
  }, 30_000);

  test("[B6] 부팅 전에 쓰인 눌림은 연결 단계에서 폐기·ack되고 시작 코드를 죽이지 않는다", async () => {
    const main = createMainSide();
    signalInterrupt(main.frame.interruptBuffer); // SEQ 1, SIGNAL 2
    // 연결 단계가 끝난 시점을 다음 단계인 `setStdin` 호출에서 잡는다.
    let atSetStdin: number[] | undefined;

    bootRun(main.frame, async () => {
      const instance = await loadPyodide();
      const setStdin = instance.setStdin.bind(instance);
      vi.spyOn(instance, "setStdin").mockImplementation((...args) => {
        atSetStdin = [...main.frame.interruptBuffer];
        setStdin(...args);
      });
      return instance;
    });
    await main.waitFor(() => main.events.some((e) => e[0] === "ready"));

    // [SIGNAL, ACK, SEQ, 예약]: 눌림이 지워졌고 ack됐다. 연결 단계에서 끝나고 루프의 폐기에 미루지 않는다.
    expect(atSetStdin).toEqual([0, 1, 1, 0]);
    expect([...main.frame.interruptBuffer]).toEqual([0, 1, 1, 0]);

    // 시작 코드가 죽지 않았다는 것을 실제 실행 결말로 본다(driver 중립. REPL 배너·프롬프트가 아니다).
    // 이 뒤에 켜지는 감시 타이머(20ms)도 idle 상태에서 낡은 눌림을 지울 수 있다.
    // 그래서 이 단언과 위 버퍼 대조는 서로 겹친다(원 repl 시험도 같은 한계였다).
    // 연결 단계의 폐기만 따로 보는 관찰점은 `atSetStdin`뿐이다.
    await expect(main.rpc.call("runCode", "1 + 1")).resolves.toEqual({
      kind: "ok",
    });
    expect([...main.frame.interruptBuffer]).toEqual([0, 1, 1, 0]);
  }, 30_000);

  test("[B7] driver 실행이 끝나면 감시 타이머를 끈다(clearInterval이 setInterval의 id로 불린다)", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const main = createMainSide();

    const { booted, session } = bootRun(main.frame, () => loadPyodide());
    await main.waitFor(() => main.events.some((e) => e[0] === "ready"));
    session()!.end();
    await booted;

    // 감시 타이머는 tickMs 기본값 20으로 건다.
    // 다른 setInterval 호출과 섞여도 간격으로 골라낸다.
    const watchCallIndex = setIntervalSpy.mock.calls.findIndex(
      ([, ms]) => ms === 20,
    );
    expect(watchCallIndex).toBeGreaterThanOrEqual(0);
    const timerId = setIntervalSpy.mock.results[watchCallIndex]?.value;
    expect(clearIntervalSpy).toHaveBeenCalledWith(timerId);
  }, 30_000);

  test("[B8] ready 뒤 driver 실행의 예외는 crashed({ message })로 나가고 그 앞은 ready 하나뿐이다", async () => {
    const main = createMainSide();

    bootRun(main.frame, () => loadPyodide(), {
      run: async () => {
        throw new Error("boom");
      },
    });
    await main.waitFor(() => main.events.some((e) => e[0] === "crashed"));

    expect(main.events).toEqual([
      ["ready", expect.anything()],
      ["crashed", { message: "Error: boom" }],
    ]);
  }, 30_000);
});
