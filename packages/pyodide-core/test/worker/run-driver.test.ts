/**
 * 실행 driver 세션(`createRunSession`)·옵션 검증·공개 export 단위 시험(RD-022).
 * pyodide는 가짜다. Python `run_code`를 시험이 제어하는 함수로 바꿔 RPC 핸들러 `runCode`의 동작을 본다.
 * - 재진입 거부
 * - `atPrompt` 전이
 * - 결과 검증
 * - 세션 수명
 *
 * 실제 pyodide와 이어진 경로는 `run-driver-pyodide.test.ts`가 본다.
 * Python 분류 분기는 `run-driver-classify.test.ts`가 본다.
 */
import type { PyodideInterface } from "pyodide";
import { describe, expect, test, vi } from "vitest";
import type { InitFrame } from "../../src/protocol/init-frame";
import { createInitFrame } from "../boot-harness";
import * as workerEntry from "../../src/worker";
import { bootWorker } from "../../src/worker/boot";
import type { ConsoleContext, RunContext } from "../../src/worker/driver";
import {
  createRunSession,
  runDriver,
  type RunOutcome,
} from "../../src/worker/run-driver";

/** Python `run_code`가 돌려주는 `[kind, error_type, traceback, code]`(None은 JS `undefined`). */
type Raw = [
  string,
  string | undefined,
  string | undefined,
  number | bigint | undefined,
];

/**
 * 가짜 pyodide와 가짜 Python `run_code`를 만든다.
 * `run_code`는 시험이 준 함수다. `namespace.get`이 그 함수를 돌려준다.
 */
function createFakes(runCodePy: (...args: unknown[]) => Promise<Raw>) {
  const pyconsole = { kind: "fake-console" };
  const consoleFactory = Object.assign(
    vi.fn(() => pyconsole),
    {
      callKwargs: vi.fn(() => pyconsole),
    },
  );
  const namespace = { get: vi.fn(() => runCodePy), destroy: vi.fn() };
  const pyodide = {
    setStdout: vi.fn(),
    setStderr: vi.fn(),
    pyimport: vi.fn(() => ({ PyodideConsole: consoleFactory })),
    toPy: vi.fn(() => namespace),
    runPython: vi.fn(),
  };
  const context = {
    pyodide: pyodide as unknown as PyodideInterface,
    sinks: { write: vi.fn(), writeErrorRaw: vi.fn() },
    frame: {} as InitFrame,
  } satisfies ConsoleContext;
  return { pyodide, pyconsole, consoleFactory, namespace, context };
}

/** 시험이 풀 수 있는 미해결 Promise. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 대기 중인 Promise 콜백이 돌 기회를 준다(macrotask 한 번). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 세션 생성에 쓰는 기본 옵션. */
const OPTIONS = { filename: "main.py", topLevelAwait: false };

describe("parseOptions", () => {
  test("생략한 필드는 filename main.py·topLevelAwait false다", () => {
    expect(runDriver.parseOptions({})).toEqual({
      filename: "main.py",
      topLevelAwait: false,
    });
    expect(
      runDriver.parseOptions({ filename: undefined, topLevelAwait: undefined }),
    ).toEqual({
      filename: "main.py",
      topLevelAwait: false,
    });
  });

  test("준 값은 그대로 쓰고 알 수 없는 필드는 무시한다", () => {
    expect(
      runDriver.parseOptions({
        filename: "app.py",
        topLevelAwait: true,
        extra: 1,
      }),
    ).toEqual({
      filename: "app.py",
      topLevelAwait: true,
    });
    expect(runDriver.parseOptions({ topLevelAwait: false })).toEqual({
      filename: "main.py",
      topLevelAwait: false,
    });
  });

  test.each([
    ["undefined", undefined, "driver"],
    ["null", null, "driver"],
    ["문자열", "main.py", "driver"],
    ["숫자", 3, "driver"],
    ["배열", [], "driver"],
    ["filename 숫자", { filename: 1 }, "filename"],
    ["filename null", { filename: null }, "filename"],
    ["filename 빈 문자열", { filename: "" }, "filename"],
    ["topLevelAwait 문자열", { topLevelAwait: "yes" }, "topLevelAwait"],
    ["topLevelAwait 숫자", { topLevelAwait: 1 }, "topLevelAwait"],
    ["topLevelAwait null", { topLevelAwait: null }, "topLevelAwait"],
  ])("잘못된 값(%s)은 틀린 필드 이름을 담은 예외다", (_name, raw, field) => {
    expect(() => runDriver.parseOptions(raw)).toThrow(field);
  });

  test("옵션이 틀리면 부팅이 그 오류로 거부되고 pyodide 로드를 시작하지 않는다", async () => {
    const { port1, port2 } = new MessageChannel();
    const frame = createInitFrame({
      rpcPort: port1,
      driver: { topLevelAwait: "yes" },
    });
    const loadPyodide = vi.fn(async () => {
      throw new Error("호출되면 안 된다");
    });

    await expect(
      bootWorker(frame, { driver: runDriver, loadPyodide }),
    ).rejects.toThrow("topLevelAwait");

    expect(loadPyodide).not.toHaveBeenCalled();
    port1.close();
    port2.close();
  });
});

describe("공개 export", () => {
  test("worker 진입점이 runDriver를 내고 세션은 runCode 핸들러를 가진다", () => {
    expect(workerEntry.runDriver).toBe(runDriver);
    expect(Object.keys(runDriver.createSession(OPTIONS).handlers)).toEqual([
      "runCode",
    ]);
  });
});

describe("createConsole", () => {
  test("옵션 filename으로 콘솔을 만들고 driver Python을 별도 namespace에 올려 namespace는 놓는다", () => {
    const fakes = createFakes(async () => [
      "ok",
      undefined,
      undefined,
      undefined,
    ]);
    const session = createRunSession({
      filename: "app.py",
      topLevelAwait: false,
    });

    const created = session.createConsole(fakes.context);

    expect(created).toBe(fakes.pyconsole);
    expect(fakes.consoleFactory.callKwargs).toHaveBeenCalledWith(undefined, {
      filename: "app.py",
    });
    expect(fakes.pyodide.setStdout).toHaveBeenCalledTimes(1);
    expect(fakes.pyodide.setStderr).toHaveBeenCalledTimes(1);
    const [source, options] = fakes.pyodide.runPython.mock.calls[0] as [
      string,
      { filename: string; globals: unknown },
    ];
    expect(source).toContain("async def run_code(");
    expect(options.filename).toBe("<run-driver>");
    expect(options.globals).toBe(fakes.namespace);
    expect(fakes.namespace.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("runCode", () => {
  test("콘솔·filename·topLevelAwait를 Python run_code에 넘기고 결과를 돌려준다", async () => {
    const runCodePy = vi.fn<(...args: unknown[]) => Promise<Raw>>(async () => [
      "ok",
      undefined,
      undefined,
      undefined,
    ]);
    const fakes = createFakes(runCodePy);
    const session = createRunSession({
      filename: "app.py",
      topLevelAwait: true,
    });
    session.createConsole(fakes.context);

    const outcome = await session.handlers.runCode!("print(1)" as never);

    expect(outcome).toStrictEqual({ kind: "ok" });
    expect(runCodePy).toHaveBeenCalledWith(
      fakes.pyconsole,
      "print(1)",
      "app.py",
      true,
    );
  });

  test.each<[string, Raw, RunOutcome]>([
    ["ok", ["ok", undefined, undefined, undefined], { kind: "ok" }],
    [
      "error",
      ["error", "ValueError", "TB\n", undefined],
      { kind: "error", errorType: "ValueError", traceback: "TB\n" },
    ],
    [
      "interrupted",
      ["interrupted", undefined, "KeyboardInterrupt\n", undefined],
      { kind: "interrupted", traceback: "KeyboardInterrupt\n" },
    ],
    ["exit", ["exit", undefined, undefined, 3], { kind: "exit", code: 3 }],
    ["exit 0", ["exit", undefined, undefined, 0], { kind: "exit", code: 0 }],
  ])(
    "Python 결말 %s를 유니온 모양 그대로 옮긴다(불필요한 필드 없음)",
    async (_name, raw, expected) => {
      const session = createRunSession(OPTIONS);
      session.createConsole(createFakes(async () => raw).context);

      expect(await session.handlers.runCode!("x" as never)).toStrictEqual(
        expected,
      );
    },
  );

  test.each<[string, Raw]>([
    ["알 수 없는 종류", ["restarted", undefined, undefined, undefined]],
    ["error인데 errorType 없음", ["error", undefined, "TB\n", undefined]],
    ["error인데 traceback 없음", ["error", "ValueError", undefined, undefined]],
    [
      "interrupted인데 traceback 없음",
      ["interrupted", undefined, undefined, undefined],
    ],
    ["exit인데 code 없음", ["exit", undefined, undefined, undefined]],
    ["exit인데 code가 BigInt", ["exit", undefined, undefined, 2n ** 60n]],
  ])(
    "형식이 어긋난 Python 결말(%s)은 거부하고 실행 중 표시를 지운다",
    async (_name, raw) => {
      const session = createRunSession(OPTIONS);
      session.createConsole(createFakes(async () => raw).context);

      await expect(session.handlers.runCode!("x" as never)).rejects.toThrow(
        "결과 형식 오류",
      );

      expect(session.atPrompt()).toBe(true);
    },
  );

  test.each([[undefined], [null], [3], [["x"]], [{}]])(
    "문자열이 아닌 source(%j)는 Python을 부르지 않고 거부한다",
    async (source) => {
      const runCodePy = vi.fn<(...args: unknown[]) => Promise<Raw>>(
        async () => ["ok", undefined, undefined, undefined],
      );
      const session = createRunSession(OPTIONS);
      session.createConsole(createFakes(runCodePy).context);

      await expect(session.handlers.runCode!(source as never)).rejects.toThrow(
        "source",
      );

      expect(runCodePy).not.toHaveBeenCalled();
      expect(session.atPrompt()).toBe(true);
    },
  );

  test("콘솔을 만들기 전에는 거부한다", async () => {
    const session = createRunSession(OPTIONS);

    await expect(session.handlers.runCode!("x" as never)).rejects.toThrow(
      "콘솔이 아직 없다",
    );

    expect(session.atPrompt()).toBe(true);
  });
});

describe("atPrompt 전이와 재진입 거부", () => {
  test("실행 중에만 거짓이고 정상·Python 예외 어느 쪽으로 끝나도 참으로 돌아온다", async () => {
    const gate = deferred<Raw>();
    const session = createRunSession(OPTIONS);
    session.createConsole(createFakes(() => gate.promise).context);
    expect(session.atPrompt()).toBe(true);

    const run = session.handlers.runCode!("x" as never);
    expect(session.atPrompt()).toBe(false);
    gate.resolve(["ok", undefined, undefined, undefined]);
    await run;
    expect(session.atPrompt()).toBe(true);

    const failing = createRunSession(OPTIONS);
    const failure = deferred<Raw>();
    failing.createConsole(createFakes(() => failure.promise).context);
    const failed = failing.handlers.runCode!("x" as never);
    expect(failing.atPrompt()).toBe(false);
    failure.reject(new Error("Python 오류"));
    await expect(failed).rejects.toThrow("Python 오류");
    expect(failing.atPrompt()).toBe(true);
  });

  test("실행 중 두 번째 runCode는 Python을 다시 부르지 않고 거부되며 첫 실행을 건드리지 않는다", async () => {
    const gate = deferred<Raw>();
    const runCodePy = vi.fn(() => gate.promise);
    const session = createRunSession(OPTIONS);
    session.createConsole(createFakes(runCodePy).context);
    const first = session.handlers.runCode!("first" as never);

    await expect(session.handlers.runCode!("second" as never)).rejects.toThrow(
      "재진입 거부",
    );

    expect(runCodePy).toHaveBeenCalledTimes(1);
    // 거부된 호출이 실행 중 표시를 지우지 않는다.
    expect(session.atPrompt()).toBe(false);
    gate.resolve(["exit", undefined, undefined, 3]);
    expect(await first).toStrictEqual({ kind: "exit", code: 3 });
    expect(session.atPrompt()).toBe(true);
  });

  test("끝난 뒤에는 다시 받는다", async () => {
    const runCodePy = vi.fn<(...args: unknown[]) => Promise<Raw>>(async () => [
      "ok",
      undefined,
      undefined,
      undefined,
    ]);
    const session = createRunSession(OPTIONS);
    session.createConsole(createFakes(runCodePy).context);

    await session.handlers.runCode!("a" as never);
    await session.handlers.runCode!("b" as never);

    expect(runCodePy).toHaveBeenCalledTimes(2);
  });
});

describe("run(ctx) 세션 수명", () => {
  test("호출해도 끝나지 않고 end() 뒤에만 끝난다", async () => {
    const session = createRunSession(OPTIONS);
    let settled = false;

    const running = session.run({} as RunContext).then(() => {
      settled = true;
    });
    await flush();
    await flush();
    expect(settled).toBe(false);

    session.end();
    await running;
    expect(settled).toBe(true);
  });

  test("run이 끝나지 않는 동안에도 runCode는 계속 받는다", async () => {
    const session = createRunSession(OPTIONS);
    session.createConsole(
      createFakes(async () => ["ok", undefined, undefined, undefined]).context,
    );
    void session.run({} as RunContext);

    await session.handlers.runCode!("a" as never);
    await session.handlers.runCode!("b" as never);

    expect(session.atPrompt()).toBe(true);
    session.end();
  });
});
