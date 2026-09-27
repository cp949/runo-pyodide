// @vitest-environment node
/**
 * worker 부팅의 호환 탐지(RD-021): interrupt 공개 API 부재 시 시작 거부(`loadFailed`), driver `probe` 호출 위치, `ready` 페이로드
 * `{ pyodideVersion, versionMismatch, degraded, details? }`. 지점마다 실제 pyodide(node)를 새로 로드해 비공개 API를 한 곳씩
 * 바꾸고(속성 삭제·`__file__` 변조) `degraded`에 그 식별자만 실리며 해당 기능만 꺼지는지 본다. 변이가 다음 시험에 새지 않도록
 * 시험마다 `loadPyodide()`를 새로 부른다. driver는 콘솔 뼈대(core)만 쓰는 가짜라 REPL을 모른다.
 */
import { loadPyodide, type PyodideInterface } from "pyodide";
import { describe, expect, test, vi } from "vitest";
import { PYODIDE_VERSION } from "../../src/pyodide-version";
import { createMainSide } from "../boot-harness";
import { bootWorker } from "../../src/worker/boot";
import {
  createCoreConsole,
  installStdioWriters,
} from "../../src/worker/core-console";
import type {
  WorkerDriver,
  WorkerDriverSession,
} from "../../src/worker/driver";

/** core 콘솔 뼈대만 쓰는 가짜 driver. `run`은 바로 끝난다(부팅 시퀀스만 본다). */
function createDriver(overrides: Partial<WorkerDriverSession> = {}) {
  const log: string[] = [];
  const driver: WorkerDriver = {
    parseOptions: (raw) => raw,
    createSession: () => ({
      handlers: {},
      createConsole: ({ pyodide, sinks }) => {
        log.push("createConsole");
        installStdioWriters(pyodide, sinks);
        return createCoreConsole(pyodide, sinks);
      },
      run: async () => {},
      atPrompt: () => false,
      ...overrides,
    }),
  };
  return { driver, log };
}

/** 새 pyodide를 로드하고 `mutation`(Python)을 한 번 실행한다. 로드한 인스턴스는 `loaded`로 시험에 돌려준다. */
function loadMutated(mutation?: string) {
  const loaded: { pyodide?: PyodideInterface } = {};
  const load = async () => {
    const pyodide = await loadPyodide();
    if (mutation) pyodide.runPython(mutation);
    loaded.pyodide = pyodide;
    return pyodide;
  };
  return { load, loaded };
}

/** 부팅을 끝까지 돌리고 `ready` 페이로드를 돌려준다. `loadFailed`가 오면 시험이 실패한다. */
async function bootAndGetReady(mutation?: string) {
  const main = createMainSide();
  const { driver } = createDriver();
  const { load, loaded } = loadMutated(mutation);

  await bootWorker(main.frame, { driver, loadPyodide: load });
  const outcome = await main.waitForOutcome();

  expect(outcome[0]).toBe("ready");
  return {
    payload: outcome[1] as Record<string, unknown>,
    pyodide: loaded.pyodide!,
  };
}

describe("bootWorker: ready 페이로드", () => {
  test("고정 버전 pyodide 부팅은 degraded가 비고 versionMismatch가 거짓이다(업그레이드 알림 역할)", async () => {
    const { payload } = await bootAndGetReady();

    expect(payload).toStrictEqual({
      pyodideVersion: PYODIDE_VERSION,
      versionMismatch: false,
      degraded: [],
    });
  }, 60_000);

  test("pyodide.version이 고정 버전과 다르면 versionMismatch가 참이고 pyodideVersion은 실제 값이다", async () => {
    const main = createMainSide();
    const { driver } = createDriver();
    const instance = await loadPyodide();
    const otherVersion = new Proxy(instance, {
      get(target, key) {
        if (key === "version") return "0.0.0-other";
        return Reflect.get(target, key) as unknown;
      },
    });

    await bootWorker(main.frame, {
      driver,
      loadPyodide: async () => otherVersion,
    });
    const outcome = await main.waitForOutcome();

    expect(outcome).toEqual([
      "ready",
      { pyodideVersion: "0.0.0-other", versionMismatch: true, degraded: [] },
    ]);
  }, 60_000);
});

describe("bootWorker: interrupt 공개 API 부재는 시작 거부(loadFailed)", () => {
  const fn = () => {};

  test.each([
    ["setInterruptBuffer", { checkInterrupt: fn }],
    ["checkInterrupt", { setInterruptBuffer: fn }],
  ])(
    "%s가 없으면 loadFailed로 알리고 콘솔 생성·probe·ready로 가지 않는다",
    async (missing, fake) => {
      const main = createMainSide();
      const probe = vi.fn(() => []);
      const { driver, log } = createDriver({ probe });

      await bootWorker(main.frame, {
        driver,
        loadPyodide: async () => fake as unknown as PyodideInterface,
      });
      const outcome = await main.waitForOutcome();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(outcome[0]).toBe("loadFailed");
      expect(outcome[1]).toContain(missing);
      expect(log).toEqual([]);
      expect(probe).not.toHaveBeenCalled();
      expect(main.events.some((event) => event[0] === "ready")).toBe(false);
    },
  );

  test("둘 다 없으면 메시지에 두 이름이 모두 들어간다", async () => {
    const main = createMainSide();
    const { driver } = createDriver();

    await bootWorker(main.frame, {
      driver,
      loadPyodide: async () => ({}) as unknown as PyodideInterface,
    });
    const outcome = await main.waitForOutcome();

    expect(outcome[0]).toBe("loadFailed");
    expect(outcome[1]).toContain("setInterruptBuffer");
    expect(outcome[1]).toContain("checkInterrupt");
  });
});

describe("bootWorker: driver probe", () => {
  test("콘솔 생성 직후에 불리고 { pyodide, pyconsole }을 받는다", async () => {
    const main = createMainSide();
    const seen: { pyodide?: unknown; pyconsole?: unknown } = {};
    const { driver, log } = createDriver({
      probe: (context) => {
        log.push("probe");
        seen.pyodide = context.pyodide;
        seen.pyconsole = context.pyconsole;
        return [];
      },
    });
    const { load, loaded } = loadMutated();

    await bootWorker(main.frame, { driver, loadPyodide: load });
    await main.waitForOutcome();

    expect(log).toEqual(["createConsole", "probe"]);
    expect(seen.pyodide).toBe(loaded.pyodide);
    expect(seen.pyconsole).toBeDefined();
  }, 60_000);

  test("probe가 돌려준 식별자가 ready의 degraded에 실리고 core 지점 식별자 앞에 온다", async () => {
    const main = createMainSide();
    const { driver } = createDriver({
      probe: () => ["compiler-flags", "incomplete-input-message"],
    });
    const { load } = loadMutated("import time; time.sleep = lambda secs: None");

    await bootWorker(main.frame, { driver, loadPyodide: load });
    const outcome = await main.waitForOutcome();

    expect(outcome).toEqual([
      "ready",
      {
        pyodideVersion: PYODIDE_VERSION,
        versionMismatch: false,
        degraded: ["compiler-flags", "incomplete-input-message", "sleep-slice"],
        details: { "sleep-slice": ["time.sleep.__wrapped__"] },
      },
    ]);
  }, 60_000);

  test("probe가 던지면 loadFailed로 알리고 ready로 가지 않는다", async () => {
    const main = createMainSide();
    const { driver } = createDriver({
      probe: () => {
        throw new Error("probe 실패");
      },
    });
    const { load } = loadMutated();

    await bootWorker(main.frame, { driver, loadPyodide: load });
    const outcome = await main.waitForOutcome();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(outcome).toEqual(["loadFailed", "Error: probe 실패"]);
    expect(main.events.some((event) => event[0] === "ready")).toBe(false);
  }, 60_000);

  test("probe가 없는 driver도 부팅된다(선택 메서드)", async () => {
    const { payload } = await bootAndGetReady();

    expect(payload.degraded).toEqual([]);
  }, 60_000);
});

/** 부팅 뒤 같은 인스턴스에서 Python 식을 평가한다. */
function evaluate(pyodide: PyodideInterface, source: string): unknown {
  return pyodide.runPython(source);
}

describe("bootWorker: 지점별 저하(실제 pyodide, 시험마다 새 로드)", () => {
  test("webloop-handlers: WebLoop 속성 하나가 없으면 그 이름만 상세에 싣고 남은 속성도 건드리지 않는다", async () => {
    const { payload, pyodide } = await bootAndGetReady(
      "import asyncio\ndel asyncio.get_event_loop()._system_exit_handler",
    );

    expect(payload).toStrictEqual({
      pyodideVersion: PYODIDE_VERSION,
      versionMismatch: false,
      degraded: ["webloop-handlers"],
      details: { "webloop-handlers": ["_system_exit_handler"] },
    });
    // 부분 설치 없음: 있던 속성은 no-op으로 바뀌지 않고 기본값 None이다.
    expect(
      evaluate(
        pyodide,
        "import asyncio\nasyncio.get_event_loop()._keyboard_interrupt_handler is None",
      ),
    ).toBe(true);
  }, 60_000);

  test("run-sync: pyodide.ffi.run_sync가 호출 불가이면 run-sync만 싣고 교체를 설치하지 않는다", async () => {
    const { payload, pyodide } = await bootAndGetReady(
      [
        "import builtins, pyodide.ffi, pyodide.webloop",
        "builtins._before_run_sync = pyodide.webloop.run_sync",
        "pyodide.ffi.run_sync = None",
      ].join("\n"),
    );

    expect(payload).toStrictEqual({
      pyodideVersion: PYODIDE_VERSION,
      versionMismatch: false,
      degraded: ["run-sync"],
      details: { "run-sync": ["pyodide.ffi.run_sync"] },
    });
    // 깨우기 교체만 꺼진다: webloop의 run_sync가 원본 그대로이고 SIGINT 핸들러는 설치돼 있다.
    expect(
      evaluate(
        pyodide,
        "import builtins, pyodide.webloop\npyodide.webloop.run_sync is builtins._before_run_sync",
      ),
    ).toBe(true);
    expect(
      evaluate(
        pyodide,
        "import signal\nsignal.getsignal(signal.SIGINT).__name__",
      ),
    ).toBe("sigint_handler");
  }, 60_000);

  test("sleep-slice: time.sleep.__wrapped__가 없으면 sleep-slice만 싣고 time.sleep을 교체하지 않는다", async () => {
    const { payload, pyodide } = await bootAndGetReady(
      [
        "import builtins, time",
        "builtins._before_sleep = time.sleep = lambda secs: None",
      ].join("\n"),
    );

    expect(payload).toStrictEqual({
      pyodideVersion: PYODIDE_VERSION,
      versionMismatch: false,
      degraded: ["sleep-slice"],
      details: { "sleep-slice": ["time.sleep.__wrapped__"] },
    });
    expect(
      evaluate(
        pyodide,
        "import builtins, time\ntime.sleep is builtins._before_sleep",
      ),
    ).toBe(true);
    expect(
      evaluate(
        pyodide,
        "import signal\nsignal.getsignal(signal.SIGINT).__name__",
      ),
    ).toBe("sigint_handler");
  }, 60_000);

  test("webloop-filename: pyodide.webloop.__file__이 webloop.py로 끝나지 않으면 그 경로를 상세에 싣고 나머지 기능은 그대로다", async () => {
    const { payload, pyodide } = await bootAndGetReady(
      "import pyodide.webloop\npyodide.webloop.__file__ = '/somewhere/other.py'",
    );

    expect(payload).toStrictEqual({
      pyodideVersion: PYODIDE_VERSION,
      versionMismatch: false,
      degraded: ["webloop-filename"],
      details: { "webloop-filename": ["/somewhere/other.py"] },
    });
    // 끌 기능이 없다: 조각 교체·깨우기 교체·핸들러 설치는 모두 됐다.
    expect(
      evaluate(pyodide, "import time\ntime.sleep.__code__.co_filename"),
    ).toBe("<sleep-slice>");
    expect(
      evaluate(
        pyodide,
        "import signal\nsignal.getsignal(signal.SIGINT).__name__",
      ),
    ).toBe("sigint_handler");
  }, 60_000);

  test("webloop-filename: __file__이 없으면(None) 상세에 None을 싣는다", async () => {
    const { payload } = await bootAndGetReady(
      "import pyodide.webloop\npyodide.webloop.__file__ = None",
    );

    expect(payload.degraded).toEqual(["webloop-filename"]);
    expect(payload.details).toEqual({ "webloop-filename": ["None"] });
  }, 60_000);
});
