/**
 * `PyodideConsole`의 top-level await 비트 토글(02-console-core.md 5.4). 콘솔은 부모 `Console.__init__`이
 * `PyCF_ALLOW_TOP_LEVEL_AWAIT`를 항상 켜므로 기본이 ON이고 생성자로 끌 수 없다(TRAP-03). 그래서 생성 직후
 * 컴파일 플래그에서 이 비트만 끄거나 켠다. 다른 비트는 여러 줄 입력 판정에 쓰이므로 건드리지 않는다.
 */
import type { CompilerFlagsHolder } from "@cp949/runo-pyodide-core/worker";

/** `ast.PyCF_ALLOW_TOP_LEVEL_AWAIT`. 콘솔 컴파일 플래그에서 이 비트만 켜고 끈다. */
export const TOP_LEVEL_AWAIT_FLAG = 0x2000;

/** 생성 직후 `PyodideConsole`의 플래그: TLA(0x2000) | ALLOW_INCOMPLETE_INPUT(0x4000) | DONT_IMPLY_DEDENT(0x200). */
export const DEFAULT_CONSOLE_FLAGS = 0x6200;

// `CompilerFlagsHolder`(pyodide private 경로 `_compile.compiler.flags`)는 core 콘솔 뼈대 타입이 소유한다.
export type { CompilerFlagsHolder };

/**
 * pyodide 비공개 경로 `_compile.compiler.flags`가 숫자로 있는가(RD-021 `compiler-flags` 탐지). PyProxy에서 없는 속성 접근은
 * 던지지 않고 `undefined`이지만, 접근 자체가 던져도 없는 것으로 본다. 없으면 REPL은 TLA 토글·EOF 문구 정규화를 건너뛰고
 * `compilerFlags()`를 `TOP_LEVEL_AWAIT_FLAG`로 대체한다(확정 7).
 */
export function hasCompilerFlags(pyconsole: unknown): boolean {
  try {
    const flags = (
      pyconsole as {
        _compile?: { compiler?: { flags?: unknown } | null } | null;
      }
    )._compile?.compiler?.flags;
    return typeof flags === "number";
  } catch {
    return false;
  }
}

/** 콘솔 생성 직후 한 번만 부른다. 실행 중 바꾸면 `... ` 블록의 다음 push가 실패한다(TRAP-03). */
export function setTopLevelAwait(
  pyconsole: CompilerFlagsHolder,
  enabled: boolean,
): void {
  const flags = pyconsole._compile.compiler.flags;
  pyconsole._compile.compiler.flags = enabled
    ? flags | TOP_LEVEL_AWAIT_FLAG
    : flags & ~TOP_LEVEL_AWAIT_FLAG;
}
