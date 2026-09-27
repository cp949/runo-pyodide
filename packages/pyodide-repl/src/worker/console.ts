/**
 * worker 쪽 콘솔 코어(02-console-core.md 5.1·5.4). `PyodideConsole`을 만들어 콜백을 sink에 잇고, `sys.ps1/ps2`·배너·
 * TLA 비트를 갖추며, `push()` 결과를 Python `await_fut` 헬퍼로만 await하는 `runLine`을 제공한다.
 * 값 에코 문자열(`repr()` 전체)과 EOF에서 끊긴 문법 오류의 표준 문구 정규화도 Python 헬퍼가 만든다.
 * 취소·안전망은 이 위에 RD-005의 `submission-runner`가 얹는다.
 */
import type { PyodideInterface } from "pyodide";
import type { PyProxy } from "pyodide/ffi";
import {
  createCoreConsole,
  installStdioWriters,
  type ConsoleFutureProxy,
  type ConsoleSinks,
  type PyodideConsoleProxy,
} from "@cp949/runo-pyodide-core/worker";
import {
  hasCompilerFlags,
  setTopLevelAwait,
  TOP_LEVEL_AWAIT_FLAG,
} from "./top-level-await";
import HELPERS_SOURCE from "./console-helpers.py?raw";

// 콘솔 뼈대 타입은 core가 소유한다(`ConsoleSinks`·`PyodideConsoleProxy`·`ConsoleFutureProxy`·`SyntaxCheck`). 이 모듈을 import하던
// 곳이 바뀌지 않도록 다시 내보낸다.
export type {
  ConsoleFutureProxy,
  ConsoleSinks,
  PyodideConsoleProxy,
  SyntaxCheck,
} from "@cp949/runo-pyodide-core/worker";

export interface ConsoleOptions {
  /** 초기화 프레임의 `topLevelAwait`. 콘솔 생성 직후 한 번만 적용한다. */
  topLevelAwait: boolean;
}

export type RunLineResult =
  | { kind: "incomplete" }
  /** 표준 문구로 정규화한 문법 오류(끝 개행 포함). 개행 제거는 호출부(러너)가 한다. */
  | { kind: "syntax-error"; formattedError: string }
  /** `echo`는 값의 `repr()` 전체다. 값이 `None`이거나 `exited`면 null. `exited`는 `SystemExit`(`exit()`/`quit()`)다. */
  | { kind: "complete"; echo: string | null; exited: boolean }
  /** 실행 예외 또는 `repr` 예외의 트레이스백(끝 개행 포함, 내부 프레임 없음). */
  | { kind: "error"; formattedError: string };

export interface ReplConsole {
  /** `pyodide.console.BANNER`. 끝 개행 없음. `writeOutput`으로 낸다(sink가 개행을 붙인다, TRAP-29). */
  readonly banner: string;
  readonly pyconsole: PyodideConsoleProxy;
  /**
   * 한 줄을 push하고 결과를 기다린다. `ConsoleFuture`는 Python `await_fut`로만 await한다.
   * `options.echo`(기본 `true`)가 거짓이면 값 `repr()`·`builtins._` 갱신을 건너뛴다(분할 재생 중 에코하지 않는 문장).
   */
  runLine(source: string, options?: { echo?: boolean }): Promise<RunLineResult>;
  /** 블록 입력 중이면 콘솔 buffer의 줄들을 `\n`으로 이은 텍스트, 아니면 undefined. */
  pending(): string | undefined;
  /** 미완성 블록을 버린다(`buffer.clear()`). 블록이 없어도 안전하다. */
  clearPending(): void;
  /**
   * `pyconsole._compile.compiler.flags`에서 `INCOMPLETE_INPUT_FLAGS`를 뺀 값. `split_paste`의 2차 `compile`에 넘긴다.
   * 그 경로가 없으면(`compiler-flags` 저하) `TOP_LEVEL_AWAIT_FLAG`(0x2000)로 대체한다.
   */
  compilerFlags(): number;
  /**
   * pyodide 비공개 지점 두 곳의 저하 식별자(RD-021, driver `probe`가 부른다). `compiler-flags`는 생성 때 판정한 값이고
   * `incomplete-input-message`는 부를 때 독립 콘솔로 `1 +`를 컴파일해 확인한다(실제 콘솔 상태를 바꾸지 않는다). 문제가 없으면 빈 배열.
   */
  probe(): string[];
}

/** `formatted_error`의 마지막 줄이 이것이면 재컴파일로 정규화한다. */
export const INCOMPLETE_INPUT_MARKER =
  "_IncompleteInputError: incomplete input";
/** `formatted_error`의 마지막 줄이 `INCOMPLETE_INPUT_MARKER`인가. 정규화와 `probe`의 문구 탐지가 같은 판정을 쓴다. */
function endsWithIncompleteMarker(formattedError: string): boolean {
  const lines = formattedError.replace(/\n$/, "").split("\n");
  return lines[lines.length - 1] === INCOMPLETE_INPUT_MARKER;
}

/** codeop이 최종 컴파일에서 끄는 두 비트: ALLOW_INCOMPLETE_INPUT(0x4000) | DONT_IMPLY_DEDENT(0x200). */
export const INCOMPLETE_INPUT_FLAGS = 0x4200;

/** 프롬프트 문자열. `sys.ps1/ps2`로 설정한다(CPython REPL과 같은 값). */
const PS1 = ">>> ";
const PS2 = "... ";

/**
 * `sys.ps1/ps2`를 `pyimport("sys")` proxy에 JS에서 대입해 설정한다. `runPython("import sys")`는 `pyodide.globals`
 * (= `__main__`)에 `sys`를 남겨 새 REPL의 `globals()`에 없어야 할 이름이 생긴다(편차 22 해소).
 */
function setPrompts(pyodide: PyodideInterface): void {
  const sysModule = pyodide.pyimport("sys") as PyProxy & {
    ps1: string;
    ps2: string;
  };
  try {
    sysModule.ps1 = PS1;
    sysModule.ps2 = PS2;
  } finally {
    sysModule.destroy();
  }
}

// await_fut·format_syntax_error·retrieve_exception 본체와 설명은 console-helpers.py에 있다(DELTA-00에서 이전).

/** `await_fut`가 돌려주는 세 값. Python `None`은 JS `undefined`로 온다. */
type AwaitFutResult = [
  echo: string | undefined,
  exited: boolean,
  error: string | undefined,
];

/**
 * 순서: 전역 stdout/stderr Writer 등록(core `installStdioWriters`) → `sys.ps1/ps2` → `PyodideConsole(pyodide.globals)` + 콜백
 * (core `createCoreConsole`) → TLA 비트 → `await_fut` namespace. 동기 함수다. 세션마다 한 번 부른다.
 */
export function createConsole(
  pyodide: PyodideInterface,
  sinks: ConsoleSinks,
  options: ConsoleOptions,
): ReplConsole {
  installStdioWriters(pyodide, sinks);
  setPrompts(pyodide);
  const pyconsole = createCoreConsole(pyodide, sinks);
  const consoleModule = pyodide.pyimport("pyodide.console") as PyProxy & {
    BANNER: string;
  };
  // `_compile.compiler.flags`가 없으면 TLA 토글을 건너뛴다: pyodide 기본이 TLA 켬이라 `topLevelAwait: false`는 무시된다(확정 7).
  // 판정은 `setTopLevelAwait`보다 앞이어야 한다(뒤에서 하면 없는 경로에 쓰거나 던진다).
  const flagsAvailable = hasCompilerFlags(pyconsole);
  if (flagsAvailable) setTopLevelAwait(pyconsole, options.topLevelAwait);
  // 별도 namespace(빈 dict)에서 정의해 사용자 globals를 오염시키지 않는다. 함수는 세션 동안 쓰므로 proxy를 유지한다.
  const namespace = pyodide.toPy({}) as PyProxy & {
    get(name: string): unknown;
  };
  pyodide.runPython(HELPERS_SOURCE, {
    globals: namespace,
    filename: "<console-helpers>",
  });
  const awaitFut = namespace.get("await_fut") as (
    fut: ConsoleFutureProxy,
    echo: boolean,
  ) => Promise<AwaitFutResult>;
  const formatSyntaxError = namespace.get("format_syntax_error") as (
    source: string,
    flags: number,
  ) => string | undefined;
  const retrieveException = namespace.get("retrieve_exception") as (
    fut: ConsoleFutureProxy,
  ) => void;
  const incompleteInputMessage = namespace.get(
    "incomplete_input_message",
  ) as () => string | undefined;

  function pending(): string | undefined {
    const buffer = pyconsole.buffer;
    try {
      return buffer.length > 0 ? buffer.toJs().join("\n") : undefined;
    } finally {
      buffer.destroy();
    }
  }

  /**
   * pyodide는 EOF에서 끊긴 문법 오류를 `_IncompleteInputError: incomplete input`으로 표시한다. 3.14 REPL은
   * `SyntaxError: invalid syntax`이므로 그 경우만 재컴파일한 문구로 바꾼다. 재컴파일이 오류 없이 끝나거나 실패하면 원문이다.
   * `pending`은 push 전에 읽은 buffer(push가 끝나면 buffer는 비워진다)다.
   */
  function normalizeSyntaxError(
    raw: string,
    pendingBefore: string | undefined,
    source: string,
  ): string {
    // `_compile.compiler.flags`가 없으면 재컴파일 플래그를 만들 수 없어 원문을 돌려준다(`compiler-flags` 저하).
    if (!flagsAvailable) return raw;
    if (!endsWithIncompleteMarker(raw)) return raw;
    const whole =
      pendingBefore === undefined ? source : `${pendingBefore}\n${source}`;
    try {
      return (
        formatSyntaxError(
          whole,
          pyconsole._compile.compiler.flags & ~INCOMPLETE_INPUT_FLAGS,
        ) ?? raw
      );
    } catch {
      return raw;
    }
  }

  return {
    banner: consoleModule.BANNER,
    pyconsole,
    pending,
    clearPending() {
      const buffer = pyconsole.buffer;
      try {
        buffer.clear();
      } finally {
        buffer.destroy();
      }
    },
    compilerFlags() {
      if (!flagsAvailable) return TOP_LEVEL_AWAIT_FLAG;
      return pyconsole._compile.compiler.flags & ~INCOMPLETE_INPUT_FLAGS;
    },
    probe() {
      const degraded: string[] = [];
      if (!flagsAvailable) degraded.push("compiler-flags");
      // 문구를 확인할 수 없는 경우(독립 콘솔 push가 던지거나 문법 오류로 끝나지 않음)도 기대와 다른 것으로 본다.
      let message: string | undefined;
      try {
        message = incompleteInputMessage() ?? undefined;
      } catch {
        message = undefined;
      }
      if (message === undefined || !endsWithIncompleteMarker(message)) {
        degraded.push("incomplete-input-message");
      }
      return degraded;
    },
    async runLine(source, options) {
      const shouldEcho = options?.echo ?? true;
      const pendingBefore = pending();
      const fut = pyconsole.push(source);
      try {
        if (fut.syntax_check === "incomplete") return { kind: "incomplete" };
        if (fut.syntax_check === "syntax-error") {
          retrieveException(fut);
          return {
            kind: "syntax-error",
            formattedError: normalizeSyntaxError(
              fut.formatted_error ?? "",
              pendingBefore,
              source,
            ),
          };
        }
        try {
          const [echo, exited, error] = await awaitFut(fut, shouldEcho);
          if (error !== undefined)
            return { kind: "error", formattedError: error };
          return { kind: "complete", echo: echo ?? null, exited };
        } catch {
          // 오류 문자열은 e.message가 아니라 fut.formatted_error(내부 프레임이 잘린 것)를 쓴다.
          return { kind: "error", formattedError: fut.formatted_error ?? "" };
        }
      } finally {
        fut.destroy();
      }
    },
  };
}
