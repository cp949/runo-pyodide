// @vitest-environment node
/**
 * REPL driver의 `probe`(RD-021, core `WorkerDriverSession.probe`) 배선 시험.
 *
 * - core는 `createConsole` 직후 `probe({ pyodide, pyconsole })`를 부른다.
 * - REPL driver는 콘솔의 두 지점 탐지(`compiler-flags`·`incomplete-input-message`) 결과를 식별자 배열로 돌려준다.
 * - 지점별 판정과 기능 저하는 `console-compat.test.ts`가 본다. 여기서는 driver 세션을 거치는 경로만 본다.
 * - 시험마다 새 pyodide를 로드한다.
 */
import { loadPyodide } from "pyodide";
import { describe, expect, test, vi } from "vitest";
import type { InitFrame } from "@cp949/runo-pyodide-core/worker";
import { replDriver } from "../../src/worker/repl-driver";

/** `_compile.compiler.flags` 경로만 없앤다(`console-compat.test.ts`와 같은 변이). */
const REMOVE_FLAGS_PATH = `
import types
import pyodide.console as pc
_orig_init = pc.PyodideConsole.__init__
def _init(self, *args, **kwargs):
    _orig_init(self, *args, **kwargs)
    inner = self._compile
    class Compiler:
        compiler = types.SimpleNamespace()
        def __call__(self, *a, **k):
            return inner(*a, **k)
    self._compile = Compiler()
pc.PyodideConsole.__init__ = _init
`;

/**
 * 새 pyodide에 `mutation`(Python 소스)을 적용하고 driver 세션을 만들어 `createConsole` → `probe`를 core와 같은 순서로 부른다.
 * 저하 식별자 배열(`degraded`)을 돌려준다.
 */
async function createAndProbe(mutation?: string) {
  const pyodide = await loadPyodide();
  if (mutation) pyodide.runPython(mutation);
  const session = replDriver.createSession({ topLevelAwait: false });
  const sinks = { write: vi.fn(), writeErrorRaw: vi.fn() };
  const pyconsole = session.createConsole({
    pyodide,
    sinks,
    frame: {} as InitFrame,
  });
  return { degraded: session.probe?.({ pyodide, pyconsole }) };
}

describe("replDriver 세션의 probe", () => {
  test("고정 버전 pyodide에서는 빈 배열이다", async () => {
    const { degraded } = await createAndProbe();

    expect(degraded).toEqual([]);
  }, 60_000);

  test("compiler-flags 경로가 없으면 그 식별자를 돌려준다", async () => {
    const { degraded } = await createAndProbe(REMOVE_FLAGS_PATH);

    expect(degraded).toEqual(["compiler-flags"]);
  }, 60_000);
});
