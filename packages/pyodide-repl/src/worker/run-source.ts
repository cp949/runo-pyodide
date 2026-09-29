/**
 * REPL 루프 명령 `{ source }`의 실행기(RD-022a).
 * - core `exec_in_console`(runner와 공용 컴파일·`console.runcode`·결말 분류)을 REPL 콘솔에 붙인다.
 * - runner와 달리 이름공간(`pyodide.globals`)을 바꾸지 않는다. 열린 `sys.stdin`도 바꾸지 않는다. REPL 명령과 같은 세계에서 돈다.
 * - `exit()`가 닫은 stdin은 core `exec_in_console`이 되살린다(`docs/design/14-runner.md` 14.2.2).
 * - 파일명은 `console.filename`(`<console>`)이다. SIGINT 규칙 ①(03-ctrl-c.md 2.4)·`formattraceback` 절단이 평소 명령 실행과 같게 성립한다(TRP-020).
 * - 마지막 식 값을 에코하지 않는다. `builtins._`를 바꾸지 않는다(exec 모드).
 */
import type { PyodideInterface } from "pyodide";
import {
  loadExecInConsole,
  toRunOutcome,
  type RunOutcome,
} from "@cp949/runo-pyodide-core/worker";
import type { ReplConsole } from "./console";
import { TOP_LEVEL_AWAIT_FLAG } from "./top-level-await";

export interface SourceRunner {
  /** 코드 한 덩어리를 REPL 콘솔에서 실행하고 결말을 돌려준다. worker 내부 오류는 던진다(사용자 코드의 오류는 결말이다). */
  run(source: string): Promise<RunOutcome>;
  /** Python 함수 proxy를 놓는다. 세션이 끝날 때 한 번 부른다(두 번째부터는 무동작). */
  destroy(): void;
}

/**
 * 세션마다 한 번 만든다. Python 소스를 한 번만 올리고 함수를 세션 동안 쓴다.
 * TLA는 `run` 때마다 콘솔의 현재 컴파일러 플래그에서 읽는다.
 * `compilerFlags()`는 `_compile.compiler.flags`(pyodide 비공개 경로)를 읽는다.
 * 경로가 없으면(`compiler-flags` 저하) pyodide 기본 그대로 TLA 켬으로 대체한다.
 */
export function createSourceRunner(
  pyodide: PyodideInterface,
  repl: Pick<ReplConsole, "pyconsole" | "compilerFlags">,
): SourceRunner {
  const execInConsole = loadExecInConsole(pyodide);
  let destroyed = false;
  return {
    async run(source) {
      const topLevelAwait = (repl.compilerFlags() & TOP_LEVEL_AWAIT_FLAG) !== 0;
      return toRunOutcome(
        await execInConsole(repl.pyconsole, source, topLevelAwait),
      );
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      execInConsole.destroy();
    },
  };
}
