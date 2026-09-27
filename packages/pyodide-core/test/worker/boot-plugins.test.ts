// @vitest-environment node
/**
 * worker 부팅의 플러그인 준비 단계(`BootOptions.plugins`, RD-023). `loadPyodide`와 interrupt 공개 API 확인 뒤, `createConsole` 앞에서
 * 배열 순서대로 `prepare({ pyodide })`를 하나씩 await한다. 던지거나 reject하면 `plugin "<name>": ` 접두를 붙여 `loadFailed`로 알리고
 * 콘솔 생성 이후로 가지 않는다. 대부분은 가짜 pyodide(interrupt 공개 API만 있는 객체)로 호출 순서만 보고, 마지막 시험만 실제
 * pyodide(node)로 `ready`까지 간다.
 */
import { loadPyodide, type PyodideInterface } from "pyodide";
import { describe, expect, test } from "vitest";
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
import type { WorkerPlugin } from "../../src/worker/plugin";

/** interrupt 공개 API만 있는 가짜 pyodide. 콘솔 생성 단계에서 driver가 던져 부팅을 끝낸다. */
const fakePyodide = {
  setInterruptBuffer: () => {},
  checkInterrupt: () => {},
} as unknown as PyodideInterface;

/**
 * 호출 순서를 `log`에 남기는 가짜 driver. `createConsole`은 기록만 하고 `stop`으로 던져 시퀀스를 거기서 끝낸다
 * (`realConsole`이면 core 콘솔을 만들어 `ready`까지 간다).
 */
function createDriver(log: string[], realConsole = false) {
  const driver: WorkerDriver = {
    parseOptions: (raw) => raw,
    createSession: (): WorkerDriverSession => ({
      handlers: {},
      createConsole: ({ pyodide, sinks }) => {
        log.push("createConsole");
        if (!realConsole) throw new Error("stop");
        installStdioWriters(pyodide, sinks);
        return createCoreConsole(pyodide, sinks);
      },
      run: async () => {},
      atPrompt: () => false,
    }),
  };
  return driver;
}

/** 다음 이벤트 루프 차례까지 기다린다(await 중인 부팅이 더 나아갈 기회를 준다). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

describe("bootWorker: plugins 호출 위치", () => {
  test("prepare는 loadPyodide 뒤·createConsole 앞에서 pyodide를 받아 호출된다", async () => {
    const main = createMainSide();
    const log: string[] = [];
    const seen: unknown[] = [];
    const plugin: WorkerPlugin = {
      name: "a",
      prepare: (context) => {
        log.push("prepare");
        seen.push(context.pyodide);
      },
    };

    await bootWorker(main.frame, {
      driver: createDriver(log),
      loadPyodide: async () => {
        log.push("loadPyodide");
        return fakePyodide;
      },
      plugins: [plugin],
    });

    expect(log).toEqual(["loadPyodide", "prepare", "createConsole"]);
    expect(seen[0]).toBe(fakePyodide);
  });

  test("interrupt 공개 API가 없어 시작을 거부하면 prepare를 부르지 않는다", async () => {
    const main = createMainSide();
    const log: string[] = [];

    await bootWorker(main.frame, {
      driver: createDriver(log),
      loadPyodide: async () => ({}) as unknown as PyodideInterface,
      plugins: [{ name: "a", prepare: () => void log.push("prepare") }],
    });
    const outcome = await main.waitForOutcome();

    expect(outcome[0]).toBe("loadFailed");
    expect(log).toEqual([]);
  });

  test("여러 플러그인은 배열 순서대로 하나씩 await된다(앞 prepare가 풀리기 전에 다음을 부르지 않는다)", async () => {
    const main = createMainSide();
    const log: string[] = [];
    const releases: Record<string, () => void> = {};
    const slow = (name: string): WorkerPlugin => ({
      name,
      prepare: () =>
        new Promise<void>((resolve) => {
          log.push(`${name}:시작`);
          releases[name] = () => {
            log.push(`${name}:끝`);
            resolve();
          };
        }),
    });

    const booting = bootWorker(main.frame, {
      driver: createDriver(log),
      loadPyodide: async () => fakePyodide,
      plugins: [slow("a"), slow("b"), slow("c")],
    });
    await tick();
    expect(log).toEqual(["a:시작"]);

    releases.a?.();
    await tick();
    expect(log).toEqual(["a:시작", "a:끝", "b:시작"]);

    releases.b?.();
    await tick();
    expect(log).toEqual(["a:시작", "a:끝", "b:시작", "b:끝", "c:시작"]);
    expect(log).not.toContain("createConsole");

    releases.c?.();
    await booting;
    expect(log.slice(-2)).toEqual(["c:끝", "createConsole"]);
  });

  test("plugins가 없거나 빈 배열이면 기존과 같이 loadPyodide 다음이 createConsole이다", async () => {
    for (const plugins of [undefined, []] as const) {
      const main = createMainSide();
      const log: string[] = [];

      await bootWorker(main.frame, {
        driver: createDriver(log),
        loadPyodide: async () => {
          log.push("loadPyodide");
          return fakePyodide;
        },
        ...(plugins ? { plugins } : {}),
      });

      expect(log).toEqual(["loadPyodide", "createConsole"]);
    }
  });
});

describe("bootWorker: plugins 실패는 loadFailed", () => {
  test("동기로 던지면 plugin 접두를 붙인 loadFailed로 알리고 createConsole로 가지 않는다", async () => {
    const main = createMainSide();
    const log: string[] = [];
    const plugin: WorkerPlugin = {
      name: "a",
      prepare: () => {
        throw new Error("동기 실패");
      },
    };

    await bootWorker(main.frame, {
      driver: createDriver(log),
      loadPyodide: async () => fakePyodide,
      plugins: [plugin],
    });
    const outcome = await main.waitForOutcome();
    await tick();

    // 다른 loadFailed 문구와 같이 `String(error)`라 `Error: ` 로 시작하고, 오류 메시지가 `plugin "<name>": `으로 시작한다.
    expect(outcome).toEqual(["loadFailed", 'Error: plugin "a": 동기 실패']);
    expect(log).toEqual([]);
    expect(main.events.some((event) => event[0] === "ready")).toBe(false);
  });

  test("reject하면 plugin 접두를 붙인 loadFailed로 알린다", async () => {
    const main = createMainSide();
    const log: string[] = [];
    const plugin: WorkerPlugin = {
      name: "b",
      prepare: async () => {
        await Promise.resolve();
        throw new Error("비동기 실패");
      },
    };

    await bootWorker(main.frame, {
      driver: createDriver(log),
      loadPyodide: async () => fakePyodide,
      plugins: [plugin],
    });
    const outcome = await main.waitForOutcome();

    expect(outcome).toEqual(["loadFailed", 'Error: plugin "b": 비동기 실패']);
    expect(log).toEqual([]);
  });

  test("Error가 아닌 값으로 reject해도 문자열로 바꿔 접두를 붙인다", async () => {
    const main = createMainSide();
    const plugin: WorkerPlugin = {
      name: "c",
      prepare: () => Promise.reject("문자열 사유"),
    };

    await bootWorker(main.frame, {
      driver: createDriver([]),
      loadPyodide: async () => fakePyodide,
      plugins: [plugin],
    });
    const outcome = await main.waitForOutcome();

    expect(outcome).toEqual(["loadFailed", 'Error: plugin "c": 문자열 사유']);
  });

  test.each([
    ["null 프로토타입 객체", () => Object.create(null) as unknown],
    [
      "toString이 던지는 객체",
      () => ({
        toString() {
          throw new Error("변환 실패");
        },
      }),
    ],
  ])(
    "%s로 reject해도 사유 변환이 던지지 않고 plugin 접두를 붙인 loadFailed로 알린다",
    async (_이름, makeReason) => {
      const main = createMainSide();
      const plugin: WorkerPlugin = {
        name: "x",
        prepare: () => Promise.reject(makeReason()),
      };

      await bootWorker(main.frame, {
        driver: createDriver([]),
        loadPyodide: async () => fakePyodide,
        plugins: [plugin],
      });
      const outcome = await main.waitForOutcome();

      expect(outcome[0]).toBe("loadFailed");
      expect(String(outcome[1])).toMatch(/^Error: plugin "x": \S/);
    },
  );

  test("plugins가 모두 성공한 뒤 createConsole이 실패하면 loadFailed 문구에 plugin 접두가 없다", async () => {
    const main = createMainSide();
    const log: string[] = [];

    await bootWorker(main.frame, {
      driver: createDriver(log),
      loadPyodide: async () => fakePyodide,
      plugins: [
        { name: "a", prepare: () => void log.push("a") },
        { name: "b", prepare: () => void log.push("b") },
      ],
    });
    const outcome = await main.waitForOutcome();

    expect(log).toEqual(["a", "b", "createConsole"]);
    expect(outcome).toEqual(["loadFailed", "Error: stop"]);
    expect(String(outcome[1])).not.toContain('plugin "');
  });

  test("앞 플러그인이 실패하면 뒤 플러그인은 부르지 않는다", async () => {
    const main = createMainSide();
    const log: string[] = [];

    await bootWorker(main.frame, {
      driver: createDriver(log),
      loadPyodide: async () => fakePyodide,
      plugins: [
        {
          name: "first",
          prepare: () => {
            log.push("first");
            throw new Error("실패");
          },
        },
        { name: "second", prepare: () => void log.push("second") },
      ],
    });
    const outcome = await main.waitForOutcome();

    expect(outcome[1]).toBe('Error: plugin "first": 실패');
    expect(log).toEqual(["first"]);
  });
});

describe("bootWorker: plugins와 실제 pyodide", () => {
  test("prepare가 등록한 JS 모듈을 실행 단계의 Python이 import한다(ready까지 간다)", async () => {
    const main = createMainSide();
    const log: string[] = [];
    let imported: unknown;
    const base = createDriver(log, true);
    const driver: WorkerDriver = {
      ...base,
      createSession: (options) => {
        const session = base.createSession(options);
        return {
          ...session,
          run: async ({ pyodide }) => {
            imported = pyodide.runPython(
              "from plugin_probe import answer\nanswer",
            );
          },
        };
      },
    };

    await bootWorker(main.frame, {
      driver,
      loadPyodide: () => loadPyodide(),
      plugins: [
        {
          name: "probe",
          prepare: async ({ pyodide }) => {
            await Promise.resolve();
            pyodide.registerJsModule("plugin_probe", { answer: 42 });
          },
        },
      ],
    });
    const outcome = await main.waitForOutcome();

    expect(outcome[0]).toBe("ready");
    expect(imported).toBe(42);
  }, 60_000);
});
