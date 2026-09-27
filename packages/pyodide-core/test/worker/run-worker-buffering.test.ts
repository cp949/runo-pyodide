/**
 * `runWorker`의 init 프레임 버퍼링(RD-023). worker 전역이면 모듈이 평가될 때 수신기가 message 리스너를 걸어, `runWorker`를 늦게
 * 불러도(파일 안의 `await` 뒤 등) init 프레임을 잃지 않고 그때 부팅한다(번들의 import 순서 조건은 01-protocols.md 4절). 모듈 평가 시점의 동작을 보려고 시험마다
 * 모듈을 새로 불러온다(`vi.resetModules`). jsdom의 `self`에는 worker 전역 표지가 없어 `WorkerGlobalScope`를 가짜로 세워 구분한다.
 * 리스너 규칙(배열·비 init·필드 오류)은 `init-receiver.test.ts`, 호출 즉시 리스너가 걸리는 기존 경로는 `run-worker.test.ts`가 본다.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createInitFrame as createBaseInitFrame } from "../boot-harness";
import type { WorkerDriver } from "../../src/worker/driver";
import type { WorkerPlugin } from "../../src/worker/plugin";

vi.mock("../../src/worker/boot", () => ({ bootWorker: vi.fn(async () => {}) }));

const driver: WorkerDriver = {
  parseOptions: () => undefined,
  createSession() {
    throw new Error("부팅 mock이라 세션을 만들지 않는다");
  },
};

const ports: MessagePort[] = [];
/** 모듈이 건 message 리스너. 시험이 끝나면 전역에서 치워 다음 시험으로 새지 않게 한다. */
const registered: EventListenerOrEventListenerObject[] = [];

function receive(data: unknown) {
  self.dispatchEvent(new MessageEvent("message", { data }));
}

function createInitFrame() {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  return createBaseInitFrame({ rpcPort: port1 });
}

/** `run-worker` 모듈을 새로 평가한다. 이 순간에 모듈 평가 시점 동작이 일어난다. */
async function evaluateModule() {
  vi.resetModules();
  const runWorkerModule = await import("../../src/worker/run-worker");
  const bootModule = await import("../../src/worker/boot");
  return {
    runWorker: runWorkerModule.runWorker,
    bootWorker: vi.mocked(bootModule.bootWorker),
  };
}

/** `self instanceof WorkerGlobalScope`가 참이 되게 한다(worker 전역인 척). */
function pretendWorkerScope() {
  vi.stubGlobal(
    "WorkerGlobalScope",
    class {
      static [Symbol.hasInstance]() {
        return true;
      }
    },
  );
}

beforeEach(() => {
  const add = self.addEventListener.bind(self) as typeof self.addEventListener;
  vi.spyOn(self, "addEventListener").mockImplementation(
    (type: string, listener: unknown, options?: unknown) => {
      if (type === "message")
        registered.push(listener as EventListenerOrEventListenerObject);
      add(type, listener as EventListener, options as AddEventListenerOptions);
    },
  );
});

afterEach(() => {
  for (const listener of registered.splice(0))
    self.removeEventListener("message", listener);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const port of ports.splice(0)) port.close();
});

describe("runWorker: 모듈 평가 시점 수신(worker 전역)", () => {
  test("모듈을 평가하면 runWorker를 부르기 전에 message 리스너가 걸린다", async () => {
    pretendWorkerScope();

    await evaluateModule();

    expect(registered).toHaveLength(1);
  });

  test("runWorker보다 먼저 온 init 프레임은 runWorker를 부를 때 부팅한다", async () => {
    pretendWorkerScope();
    const { runWorker, bootWorker } = await evaluateModule();
    const initFrame = createInitFrame();

    receive(initFrame);
    expect(bootWorker).not.toHaveBeenCalled();
    runWorker({ driver });

    expect(bootWorker).toHaveBeenCalledTimes(1);
    const [frame, deps] = bootWorker.mock.calls[0] ?? [];
    expect(frame === initFrame).toBe(true);
    expect(deps?.driver).toBe(driver);
    expect(typeof deps?.loadPyodide).toBe("function");
  });

  test("runWorker를 부른 뒤에 온 init 프레임도 부팅한다", async () => {
    pretendWorkerScope();
    const { runWorker, bootWorker } = await evaluateModule();
    const initFrame = createInitFrame();

    runWorker({ driver });
    expect(bootWorker).not.toHaveBeenCalled();
    receive(initFrame);

    expect(bootWorker).toHaveBeenCalledTimes(1);
    const [frame] = bootWorker.mock.calls[0] ?? [];
    expect(frame === initFrame).toBe(true);
  });

  test("runWorker를 두 번 부르면 두 번째는 오류로 알리고 부팅은 한 번만 한다", async () => {
    pretendWorkerScope();
    const { runWorker, bootWorker } = await evaluateModule();

    runWorker({ driver });
    expect(() => runWorker({ driver })).toThrow(/한 번/);
    receive(createInitFrame());

    expect(bootWorker).toHaveBeenCalledTimes(1);
  });

  test("plugins를 그대로 부팅에 넘긴다", async () => {
    pretendWorkerScope();
    const { runWorker, bootWorker } = await evaluateModule();
    const plugins: WorkerPlugin[] = [{ name: "a", prepare: () => {} }];

    receive(createInitFrame());
    runWorker({ driver, plugins });

    expect(bootWorker.mock.calls[0]?.[1].plugins).toBe(plugins);
  });
});

describe("runWorker: worker 전역이 아닐 때(jsdom·node 시험)", () => {
  test("모듈을 평가해도 message 리스너를 걸지 않는다", async () => {
    await evaluateModule();

    expect(registered).toHaveLength(0);
  });

  test("runWorker를 부르면 그때 리스너를 걸어 부팅하고 plugins를 넘긴다", async () => {
    const { runWorker, bootWorker } = await evaluateModule();
    const plugins: WorkerPlugin[] = [{ name: "a", prepare: () => {} }];

    runWorker({ driver, plugins });
    expect(registered).toHaveLength(1);
    receive(createInitFrame());

    expect(bootWorker).toHaveBeenCalledTimes(1);
    expect(bootWorker.mock.calls[0]?.[1].plugins).toBe(plugins);
  });
});
