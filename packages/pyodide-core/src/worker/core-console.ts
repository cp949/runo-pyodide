/**
 * 콘솔 뼈대(02-console-core.md 5.1).
 * driver가 쓰는 공통 부분만 둔다.
 * - 전역 stdout/stderr Writer 등록
 * - `PyodideConsole` 생성 + stdout/stderr 콜백 연결
 *
 * `sys.ps1/ps2`·TLA 비트·헬퍼 namespace 같은 REPL 전용 부분은 driver가 얹는다.
 * 두 함수를 따로 내고 driver `createConsole`이 부른다.
 * REPL은 그 사이에 `sys.ps1/ps2`를 끼운다. 이전 구현 순서를 따른 것이다. 기능 제약이 아니다.
 * pyodide `console.py`는 `ps1`을 읽지 않는다(02-console-core.md 5.1).
 */
import type { PyodideInterface } from "pyodide";
import type { PyProxy } from "pyodide/ffi";
import { createSinkWriter } from "./sink-writer";

/** 콘솔 콜백과 전역 스트림이 같이 쓰는 sink 둘. worker에서는 RPC `notify` 래퍼다. */
export interface ConsoleSinks {
  /** stdout 텍스트 */
  write(text: string): void;

  /** stderr 원문 텍스트 */
  writeErrorRaw(text: string): void;
}

/** `console.push`가 판정한 입력 상태. 완결·불완전(더 입력 필요)·구문 오류. */
export type SyntaxCheck = "incomplete" | "syntax-error" | "complete";

/** `console.push`가 돌려주는 `ConsoleFuture`의 proxy */
export interface ConsoleFutureProxy extends PyProxy {
  /** 입력 상태 */
  readonly syntax_check: SyntaxCheck;

  /** 구문 오류일 때 pyodide가 만든 오류 문구. 그 밖에는 `undefined`. */
  readonly formatted_error: string | undefined;
}

/** pyodide private 경로 `_compile.compiler.flags`. pyodide를 올릴 때 경로가 바뀌면 시험이 먼저 깨진다. */
export interface CompilerFlagsHolder {
  _compile: { compiler: { flags: number } };
}

/** `pyodide.console.PyodideConsole` 인스턴스의 proxy. 이 저장소가 쓰는 멤버만 선언한다. */
export interface PyodideConsoleProxy extends PyProxy, CompilerFlagsHolder {
  /** 콘솔이 잡은 stdout을 받는 콜백 */
  stdout_callback: ((text: string) => void) | undefined;

  /** 콘솔이 잡은 stderr를 받는 콜백 */
  stderr_callback: ((text: string) => void) | undefined;

  /** 한 줄을 밀어 넣고 입력 상태를 돌려받는다. */
  push(line: string): ConsoleFutureProxy;

  /** 접근할 때마다 새 proxy다. 쓴 뒤 `destroy()`한다(02-console-core.md 5.1). */
  readonly buffer: PyProxy & {
    readonly length: number;
    clear(): void;
    toJs(): string[];
  };
}

/**
 * 전역 stdout/stderr Writer를 sink에 잇는다(`print`·`sys.stdout.write`가 콘솔 밖에서 쓴 것도 잡는다).
 * 세션마다 한 번 부른다. 콘솔 생성 전에 부른다.
 */
export function installStdioWriters(
  pyodide: Pick<PyodideInterface, "setStdout" | "setStderr">,
  sinks: ConsoleSinks,
): void {
  pyodide.setStdout(createSinkWriter((text) => sinks.write(text)));
  pyodide.setStderr(createSinkWriter((text) => sinks.writeErrorRaw(text)));
}

/** {@link createCoreConsole}의 옵션 */
export interface CoreConsoleOptions {
  /** 트레이스백에 나타나는 소스 이름. 기본은 pyodide 기본값 `<console>`이다. */
  filename?: string;
}

/**
 * `PyodideConsole(pyodide.globals)`를 만들고 stdout/stderr 콜백을 sink에 잇는다.
 * `stdin_callback`은 넘기지 않는다(`setStdin` 전역 설정을 쓴다).
 * 배너(`pyodide.console.BANNER`)는 REPL driver가 읽는다.
 * `pyodide.console` 모듈 proxy는 이전 구현과 같이 세션 동안 놓지 않는다.
 */
export function createCoreConsole(
  pyodide: PyodideInterface,
  sinks: ConsoleSinks,
  options: CoreConsoleOptions = {},
): PyodideConsoleProxy {
  const consoleModule = pyodide.pyimport("pyodide.console") as PyProxy & {
    PyodideConsole: {
      (globals: PyProxy): PyodideConsoleProxy;
      callKwargs(
        globals: PyProxy,
        kwargs: { filename: string },
      ): PyodideConsoleProxy;
    };
  };
  const pyconsole =
    options.filename === undefined
      ? consoleModule.PyodideConsole(pyodide.globals)
      : consoleModule.PyodideConsole.callKwargs(pyodide.globals, {
          filename: options.filename,
        });
  pyconsole.stdout_callback = (text) => sinks.write(text);
  pyconsole.stderr_callback = (text) => sinks.writeErrorRaw(text);
  return pyconsole;
}
