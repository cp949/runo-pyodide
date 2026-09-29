// @vitest-environment node
/**
 * REPL 콘솔의 호환 탐지 두 지점 시험(RD-021).
 *
 * - `compiler-flags`: `pyconsole._compile.compiler.flags` 경로.
 * - `incomplete-input-message`: `1 +`의 EOF 문법 오류 문구.
 *
 * 실제 pyodide(node)를 시험마다 새로 로드해 지점을 하나씩 바꾼다(`PyodideConsole` 클래스 패치).
 * `probe()`가 그 식별자만 돌려주고 해당 기능만 꺼지는지 본다.
 * 변이가 다른 시험에 새지 않도록 파일 공유 인스턴스를 쓰지 않는다.
 *
 * flags 부재 fallback(확정 7)의 세 가지를 각각 고정한다.
 * - `setTopLevelAwait` 건너뜀.
 * - `normalizeSyntaxError` 원문.
 * - `compilerFlags()` → `TOP_LEVEL_AWAIT_FLAG`.
 */
import { loadPyodide, type PyodideInterface } from "pyodide";
import type { PyProxy } from "pyodide/ffi";
import { describe, expect, test, vi } from "vitest";
import { createConsole, type ReplConsole } from "../../src/worker/console";
import { loadSplitPaste } from "../../src/worker/multiline";
import { TOP_LEVEL_AWAIT_FLAG } from "../../src/worker/top-level-await";

/** `_compile.compiler.flags` 경로만 없앤다. 안쪽 컴파일러는 그대로라 pyodide 기본(TLA 켬)이 유지된다. */
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
 * EOF 오류 표시 문구를 다른 것으로 바꾼다. pyodide가 `_IncompleteInputError` 문구를 바꾼 상황이다.
 * 문법 오류 표시는 `formatsyntaxerror`가 만든다.
 */
const CHANGE_INCOMPLETE_MESSAGE = `
import pyodide.console as pc
_orig_format = pc.PyodideConsole.formatsyntaxerror
def _format(self, exc):
    return _orig_format(self, exc).replace(
        '_IncompleteInputError: incomplete input', 'SyntaxError: unexpected EOF'
    )
pc.PyodideConsole.formatsyntaxerror = _format
`;

/** `1 +`를 push하면 던진다. pyodide가 콘솔 push 계약을 바꿔 문구를 확인할 수 없는 상황이다. */
const PUSH_THROWS = `
import pyodide.console as pc
_orig_push = pc.PyodideConsole.push
def _push(self, line):
    if line == '1 +':
        raise RuntimeError('push 변경')
    return _orig_push(self, line)
pc.PyodideConsole.push = _push
`;

/**
 * 새 pyodide를 로드하고 `mutation`(Python 소스)을 적용한 뒤 새 콘솔을 만든다.
 * `topLevelAwait`의 기본값은 `false`다.
 */
async function setup(
  options: { mutation?: string; topLevelAwait?: boolean } = {},
) {
  const pyodide = await loadPyodide();
  if (options.mutation) pyodide.runPython(options.mutation);
  pyodide.runPython("import asyncio");
  const repl = createConsole(
    pyodide,
    { write: vi.fn(), writeErrorRaw: vi.fn() },
    { topLevelAwait: options.topLevelAwait ?? false },
  );
  return { pyodide, repl };
}

describe("고정 버전 pyodide", () => {
  test("probe()는 빈 배열이다", async () => {
    const { repl } = await setup();

    expect(repl.probe()).toEqual([]);
  }, 60_000);
});

describe("compiler-flags 저하", () => {
  test("probe()는 compiler-flags만 돌려준다", async () => {
    const { repl } = await setup({ mutation: REMOVE_FLAGS_PATH });

    expect(repl.probe()).toEqual(["compiler-flags"]);
  }, 60_000);

  test("setTopLevelAwait를 건너뛴다: 경로에 flags를 쓰지 않고 topLevelAwait: false가 무시돼 top-level await가 실행된다", async () => {
    const { repl } = await setup({
      mutation: REMOVE_FLAGS_PATH,
      topLevelAwait: false,
    });

    // 건너뛰지 않았다면 `undefined & ~비트`인 0이 경로에 써진다.
    const compiler = (
      repl.pyconsole as unknown as {
        _compile: { compiler: { flags?: number } };
      }
    )._compile.compiler;
    expect(compiler.flags).toBeUndefined();
    const result = await repl.runLine("await asyncio.sleep(0)", {
      echo: false,
    });
    expect(result.kind).toBe("complete");
  }, 60_000);

  test("normalizeSyntaxError는 원문을 돌려준다: EOF 오류가 정규화되지 않는다", async () => {
    const { repl } = await setup({ mutation: REMOVE_FLAGS_PATH });

    const result = await repl.runLine("1 +");

    expect(result).toEqual({
      kind: "syntax-error",
      formattedError:
        '  File "<console>", line 1\n    1 +\n      ^\n_IncompleteInputError: incomplete input\n',
    });
  }, 60_000);

  test("compilerFlags()는 TOP_LEVEL_AWAIT_FLAG(0x2000)이고 붙여넣기 분할이 top-level await 문장을 자른다", async () => {
    const { pyodide, repl } = await setup({ mutation: REMOVE_FLAGS_PATH });

    const flags = repl.compilerFlags();
    const [error, chunks] = loadSplitPaste(pyodide)(
      "await asyncio.sleep(0)\nx = 1",
      flags,
    );

    expect(flags).toBe(TOP_LEVEL_AWAIT_FLAG);
    expect(error).toBeUndefined();
    expect(chunks).toEqual([["await asyncio.sleep(0)"], ["x = 1"]]);
  }, 60_000);

  test("incomplete-input-message 탐지는 flags 저하와 무관하게 동작한다(문구가 정상이면 보고하지 않는다)", async () => {
    const { repl } = await setup({ mutation: REMOVE_FLAGS_PATH });

    expect(repl.probe()).not.toContain("incomplete-input-message");
  }, 60_000);
});

describe("incomplete-input-message 저하", () => {
  test("probe()는 incomplete-input-message만 돌려준다", async () => {
    const { repl } = await setup({ mutation: CHANGE_INCOMPLETE_MESSAGE });

    expect(repl.probe()).toEqual(["incomplete-input-message"]);
  }, 60_000);

  test("문구가 바뀌면 `1 +`가 정규화되지 않고 원문 그대로 표시되며 정상 실행은 그대로다", async () => {
    const { repl } = await setup({ mutation: CHANGE_INCOMPLETE_MESSAGE });

    const syntaxError = await repl.runLine("1 +");
    const value = await repl.runLine("1 + 1");

    expect(syntaxError).toEqual({
      kind: "syntax-error",
      formattedError:
        '  File "<console>", line 1\n    1 +\n      ^\nSyntaxError: unexpected EOF\n',
    });
    expect(value).toEqual({ kind: "complete", echo: "2", exited: false });
  }, 60_000);

  test("문구를 확인할 수 없으면(독립 콘솔 push가 던짐) 기대와 다른 것으로 보고 incomplete-input-message를 돌려준다", async () => {
    const { repl } = await setup({ mutation: PUSH_THROWS });

    expect(repl.probe()).toEqual(["incomplete-input-message"]);
  }, 60_000);

  test("flags가 정상이면 compilerFlags()는 그대로 INCOMPLETE 비트를 뺀 값이다", async () => {
    const { repl } = await setup({ mutation: CHANGE_INCOMPLETE_MESSAGE });

    expect(repl.compilerFlags() & 0x4200).toBe(0);
  }, 60_000);
});

describe("probe()는 콘솔 상태를 바꾸지 않는다", () => {
  // 사용자 전역·builtins의 `_`·`sys.last_*`·미완성 블록·buffer를 스냅샷으로 뽑는다.
  function snapshot(pyodide: PyodideInterface, repl: ReplConsole) {
    const names = pyodide.runPython("sorted(globals().keys())") as PyProxy;
    const globalNames = names.toJs() as string[];
    names.destroy();
    // `import builtins`가 사용자 전역에 이름을 남기지 않게 버리는 namespace에서 읽는다.
    const scratch = pyodide.toPy({});
    const underscore = pyodide.runPython(
      "import builtins\nrepr(getattr(builtins, '_', 'unset'))",
      { globals: scratch },
    );
    // 오류 표시(`formatsyntaxerror`)가 설정하는 값이다. 사용자는 `sys.last_value`·`pdb.pm()`으로 본다.
    const lastExc = pyodide.runPython(
      "import sys\nrepr([getattr(sys, n, 'unset') for n in ('last_exc', 'last_type', 'last_value', 'last_traceback')])",
      { globals: scratch },
    );
    scratch.destroy();
    return {
      globalNames,
      underscore,
      lastExc,
      pending: repl.pending(),
    };
  }

  test("열린 블록이 있어도 buffer·builtins._·전역이 그대로이고 블록을 이어 끝낼 수 있다", async () => {
    const { pyodide, repl } = await setup();
    await repl.runLine("7"); // builtins._ = 7
    await repl.runLine("if True:"); // 미완성 블록
    const before = snapshot(pyodide, repl);

    const degraded = repl.probe();
    const after = snapshot(pyodide, repl);
    await repl.runLine("    y = 5");
    const closed = await repl.runLine("");

    expect(degraded).toEqual([]);
    expect(before.pending).toBe("if True:");
    expect(after).toEqual(before);
    expect(closed.kind).toBe("complete");
    expect(pyodide.runPython("y")).toBe(5);
  }, 60_000);

  test("사용자 오류가 남긴 sys.last_*는 probe() 뒤에도 그 오류를 가리킨다", async () => {
    const { pyodide, repl } = await setup();
    await repl.runLine("1 / 0"); // sys.last_* = ZeroDivisionError
    const before = snapshot(pyodide, repl);

    repl.probe();

    expect(before.lastExc).toContain("ZeroDivisionError");
    expect(snapshot(pyodide, repl)).toEqual(before);
  }, 60_000);

  test("문구가 바뀐 상태에서 probe()를 여러 번 불러도 결과가 같고 상태가 그대로다", async () => {
    const { pyodide, repl } = await setup({
      mutation: CHANGE_INCOMPLETE_MESSAGE,
    });
    const before = snapshot(pyodide, repl);

    const first = repl.probe();
    const second = repl.probe();

    expect(first).toEqual(["incomplete-input-message"]);
    expect(second).toEqual(first);
    expect(snapshot(pyodide, repl)).toEqual(before);
  }, 60_000);
});
