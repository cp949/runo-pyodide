/**
 * 실행 driver의 worker 쪽(RD-022). 앱의 worker 파일이 `runWorker({ driver: runDriver })`로 쓴다. main이 RPC `runCode(source)`로
 * 코드 한 덩어리를 보내면 새 globals에서 `CodeRunner(exec, filename)` + `console.runcode`로 실행하고 결말(`RunOutcome`)을
 * 돌려준다. REPL의 `ConsoleFuture`·`runsource` 경로를 거치지 않으므로 `sigint-handler.py`의 `runcode` 래퍼·`formattraceback`
 * 교체·SIGINT 규칙 ①이 그대로 성립한다(가설 시험 `run-driver-pyodide.test.ts`). 결과 분류와 stderr 쓰기는 `run-driver.py`가 한다.
 *
 * 세션은 `run(ctx)`가 끝나지 않는 Promise로 산다: REPL과 달리 제어 흐름이 없고 요청(`runCode`)마다 일한다. 종료는 main이
 * worker를 끝낼 때다. `restarted`는 main이 만드는 결말이라 여기에는 없다.
 */
import type { PyodideInterface } from "pyodide";
import type { PyProxy } from "pyodide/ffi";
import {
  parseRunDriverOptions,
  type RunDriverOptions,
} from "../protocol/run-driver-options";
import type { RunOutcome } from "../protocol/run-outcome";
import {
  createCoreConsole,
  installStdioWriters,
  type PyodideConsoleProxy,
} from "./core-console";
import type { WorkerDriver, WorkerDriverSession } from "./driver";
import RUN_DRIVER_SOURCE from "./run-driver.py?raw";

export type { RunDriverOptions } from "../protocol/run-driver-options";

export type { RunOutcome };

export interface RunSession extends WorkerDriverSession {
  /** `run()`이 돌려준 Promise를 끝낸다(시험용). 프로덕션에서는 main이 worker를 종료할 때까지 세션이 살아 있다. */
  end(): void;
}

/** Python `run_code`·`exec_in_console`이 돌려주는 `[kind, error_type, traceback, code]`(None은 JS `undefined`). */
export type RawOutcome = [
  string,
  string | undefined,
  string | undefined,
  number | bigint | undefined,
];

type RunCodePy = PyProxy &
  ((
    console: PyodideConsoleProxy,
    source: string,
    filename: string,
    topLevelAwait: boolean,
  ) => Promise<RawOutcome>);

/**
 * 실행·분류 공용 함수 `exec_in_console(console, source, top_level_await, filename=None)`의 JS 모양. runner와 REPL `runSource`가
 * 쓴다. 이름공간·열린 `sys.stdin`은 바꾸지 않고(`SystemExit` 뒤 닫힌 stdin 되살림만 한다, 14-runner.md 14.2.2) 파일명은
 * `console.filename`이다(`filename`을 주면 그 값이 우선).
 */
export type ExecInConsolePy = PyProxy &
  ((
    console: PyodideConsoleProxy,
    source: string,
    topLevelAwait: boolean,
    filename?: string,
  ) => Promise<RawOutcome>);

/** driver Python이 만든 결말을 검증하며 `RunOutcome`으로 바꾼다. 형식이 어긋나면 던진다(RPC 오류로 나간다). */
export function toRunOutcome([
  kind,
  errorType,
  traceback,
  code,
]: RawOutcome): RunOutcome {
  switch (kind) {
    case "ok":
      return { kind };
    case "error":
      if (typeof errorType === "string" && typeof traceback === "string") {
        return { kind, errorType, traceback };
      }
      break;
    case "interrupted":
      if (typeof traceback === "string") return { kind, traceback };
      break;
    case "exit":
      if (typeof code === "number") return { kind, code };
      break;
  }
  throw new Error(`실행 driver 결과 형식 오류 — kind: ${kind}`);
}

export function createRunSession(options: RunDriverOptions): RunSession {
  let running = false;
  let runCodePy: RunCodePy | undefined;
  let pyconsole: PyodideConsoleProxy | undefined;
  let end!: () => void;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });

  return {
    handlers: {
      async runCode(source: unknown): Promise<RunOutcome> {
        if (typeof source !== "string") {
          throw new TypeError("runCode 인자 오류 — source: 문자열 필요");
        }
        // 재진입 거부는 main의 `busy` 검사가 놓친 경우의 방어다. 첫 await 전에 동기로 판정한다.
        if (running) throw new Error("runCode 재진입 거부 — 이미 실행 중이다");
        if (!runCodePy || !pyconsole) throw new Error("콘솔이 아직 없다");
        running = true;
        try {
          return toRunOutcome(
            await runCodePy(
              pyconsole,
              source,
              options.filename,
              options.topLevelAwait,
            ),
          );
        } finally {
          running = false;
        }
      },
    },
    createConsole({ pyodide, sinks }) {
      installStdioWriters(pyodide, sinks);
      pyconsole = createCoreConsole(pyodide, sinks, {
        filename: options.filename,
      });
      runCodePy = loadRunCode(pyodide);
      return pyconsole;
    },
    // 요청 단위로 일하는 세션이라 제어 흐름이 없다: 끝나라는 신호까지 산다(끝나면 core가 감시 타이머를 멈춘다).
    run: () => ended,
    // 실행 중이 아니면 대상 Python 코드가 없다(03-ctrl-c.md 2.5). 실행 뒤 남은 asyncio task·타이머 콜백이 도는 동안도 참이다.
    // REPL과 달리 `runCode` 진입 폐기는 없다: 틱보다 먼저 온 실행의 잔류 눌림은 driver Python에서 규칙 ④가 버린다(14-runner.md 14.2.6).
    atPrompt: () => !running,
    end,
  };
}

/**
 * driver Python을 별도 namespace(빈 dict)에서 정의하고 함수 하나를 꺼낸다. 사용자 globals를 오염시키지 않는다. 호출마다
 * 소스를 새로 실행하므로 소비자가 세션마다 한 번만 부르고 함수는 세션 동안 쓴다.
 */
function loadDriverFunction<T extends PyProxy>(
  pyodide: PyodideInterface,
  name: string,
): T {
  const namespace = pyodide.toPy({}) as PyProxy & {
    get(name: string): unknown;
  };
  try {
    pyodide.runPython(RUN_DRIVER_SOURCE, {
      globals: namespace,
      filename: "<run-driver>",
    });
    return namespace.get(name) as T;
  } finally {
    namespace.destroy();
  }
}

function loadRunCode(pyodide: PyodideInterface): RunCodePy {
  return loadDriverFunction<RunCodePy>(pyodide, "run_code");
}

/**
 * 실행·분류 공용 함수를 올린다(REPL `runSource`용). `run_code`와 달리 `console.globals`·열린 `sys.stdin`을 바꾸지 않는다(`SystemExit`
 * 뒤 닫힌 stdin 되살림은 예외, 14-runner.md 14.2.2). 함수는 세션 동안 쓰고 세션이 끝날 때 `destroy()`한다.
 */
export function loadExecInConsole(pyodide: PyodideInterface): ExecInConsolePy {
  return loadDriverFunction<ExecInConsolePy>(pyodide, "exec_in_console");
}

export const runDriver: WorkerDriver<RunDriverOptions> = {
  parseOptions: parseRunDriverOptions,
  createSession: createRunSession,
};
