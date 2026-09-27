// @vitest-environment node
/**
 * 실행·분류 공용 함수 `exec_in_console`(run-driver.py)의 실제 pyodide(node) 시험. runner(`run_code`)와 REPL `runSource`가 같은
 * 컴파일·`console.runcode`·결말 분류를 쓰게 하려고 `run_code`에서 떼어 낸 뒤쪽이다. 여기서는 runner 전용 준비(새 globals·
 * stdin 교체)가 이 함수 안에 없다는 것과 파일명이 콘솔의 `filename`(기본 `<console>`)을 따른다는 것, `SystemExit` 뒤 닫힌
 * stdin 되살림은 이 함수가 한다는 것을 본다. 분류 분기 전수는 `run-driver-classify.test.ts`, runner 경로 전체는
 * `run-driver-pyodide.test.ts`가 본다. 실제 `PyodideConsole`을 쓰되 SIGINT 계층은 올리지 않는다(정상·오류·종료 경로만 태운다).
 */
import { loadPyodide, type PyodideInterface } from "pyodide";
import type { PyProxy } from "pyodide/ffi";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  createCoreConsole,
  installStdioWriters,
  type PyodideConsoleProxy,
} from "../../src/worker/core-console";
import { loadExecInConsole, toRunOutcome } from "../../src/worker/run-driver";

let pyodide: PyodideInterface;
const output = { stdout: "", stderr: "" };
const consoles: PyodideConsoleProxy[] = [];

const sinks = {
  write: (text: string) => {
    output.stdout += text;
  },
  writeErrorRaw: (text: string) => {
    output.stderr += text;
  },
};

beforeAll(async () => {
  pyodide = await loadPyodide();
  installStdioWriters(pyodide, sinks);
}, 60_000);

afterAll(() => {
  for (const console of consoles) console.destroy();
});

beforeEach(() => {
  output.stdout = "";
  output.stderr = "";
});

/** 콘솔을 만든다. `filename`을 생략하면 pyodide 기본 `<console>`이다(REPL 콘솔과 같다). */
function makeConsole(filename?: string): PyodideConsoleProxy {
  const pyconsole = createCoreConsole(
    pyodide,
    sinks,
    filename === undefined ? {} : { filename },
  );
  consoles.push(pyconsole);
  return pyconsole;
}

/** 공용 함수를 불러 결말을 `RunOutcome`으로 바꾼다. */
async function exec(
  pyconsole: PyodideConsoleProxy,
  source: string,
  {
    topLevelAwait = false,
    filename,
  }: { topLevelAwait?: boolean; filename?: string } = {},
) {
  const execInConsole = loadExecInConsole(pyodide);
  try {
    return toRunOutcome(
      await execInConsole(pyconsole, source, topLevelAwait, filename),
    );
  } finally {
    (execInConsole as PyProxy).destroy();
  }
}

describe("exec_in_console: runner 전용 준비를 하지 않는다", () => {
  test("기존 globals(pyodide.globals)를 교체하지 않아 이전 변수를 읽고 새 변수가 남는다", async () => {
    const pyconsole = makeConsole();
    pyodide.globals.set("before", 41);

    const outcome = await exec(pyconsole, "after = before + 1\nprint(after)");

    expect(outcome).toStrictEqual({ kind: "ok" });
    expect(output.stdout).toBe("42\n");
    expect(pyodide.globals.get("after")).toBe(42);
    pyodide.globals.delete("before");
    pyodide.globals.delete("after");
  }, 60_000);

  test("콘솔이 잡고 있는 globals 객체가 실행 뒤에도 같은 dict다", async () => {
    const pyconsole = makeConsole();
    const isSame = pyodide.runPython("lambda a, b: a is b") as PyProxy &
      ((a: unknown, b: unknown) => boolean);
    expect(isSame(pyconsole.globals, pyodide.globals)).toBe(true);

    await exec(pyconsole, "pass");

    expect(isSame(pyconsole.globals, pyodide.globals)).toBe(true);
    // 사용자 코드가 __name__ 등을 새로 정하지 않는다(runner의 새 globals와 다르다).
    expect(pyodide.globals.has("__file__")).toBe(false);
    isSame.destroy();
  }, 60_000);

  test("sys.stdin을 바꾸지 않는다", async () => {
    const pyconsole = makeConsole();
    pyodide.runPython(
      "import io, sys\n_orig_stdin = sys.stdin\nsys.stdin = _sentinel = io.StringIO('abc')",
    );
    const before = pyodide.runPython("id(sys.stdin)") as number;

    await exec(pyconsole, "pass");

    expect(pyodide.runPython("id(sys.stdin)")).toBe(before);
    pyodide.runPython("sys.stdin = _orig_stdin\ndel _orig_stdin, _sentinel");
  }, 60_000);
});

describe("exec_in_console: 파일명은 콘솔의 filename이다", () => {
  test("기본 콘솔은 트레이스백 프레임이 <console>이고 소스 줄은 없다", async () => {
    const pyconsole = makeConsole();

    const outcome = await exec(pyconsole, "x = 1\n1 / 0");

    expect(outcome.kind).toBe("error");
    expect(outcome).toMatchObject({ errorType: "ZeroDivisionError" });
    expect((outcome as { traceback: string }).traceback).toContain(
      'File "<console>", line 2, in <module>',
    );
    expect(output.stderr).toBe((outcome as { traceback: string }).traceback);
  }, 60_000);

  test("콘솔에 filename을 주면 그 이름이 프레임 파일명이다(인자 없이)", async () => {
    const pyconsole = makeConsole("app.py");

    const outcome = await exec(pyconsole, "1 / 0");

    expect((outcome as { traceback: string }).traceback).toContain(
      'File "app.py", line 1, in <module>',
    );
  }, 60_000);

  test("문법 오류도 <console> 파일명을 따르고 errorType은 SyntaxError다", async () => {
    const pyconsole = makeConsole();

    const outcome = await exec(pyconsole, "x = = 1");

    expect(outcome).toMatchObject({ kind: "error", errorType: "SyntaxError" });
    expect((outcome as { traceback: string }).traceback).toContain(
      'File "<console>", line 1',
    );
  }, 60_000);

  test("filename 인자를 주면 컴파일 파일명이 그 값이다(runner의 run_code 호환, 문법 오류 위치로 확인)", async () => {
    const pyconsole = makeConsole();

    const outcome = await exec(pyconsole, "x = = 1", {
      filename: "explicit.py",
    });

    expect((outcome as { traceback: string }).traceback).toContain(
      'File "explicit.py", line 1',
    );
  }, 60_000);
});

describe("exec_in_console: exec 의미와 분류", () => {
  test("마지막 식의 값을 출력하지 않고 builtins._를 바꾸지 않는다", async () => {
    const pyconsole = makeConsole();
    pyodide.runPython("import builtins\nbuiltins._ = 'sentinel'");

    const outcome = await exec(pyconsole, "1 + 1");

    expect(outcome).toStrictEqual({ kind: "ok" });
    expect(output.stdout).toBe("");
    expect(pyodide.runPython("builtins._")).toBe("sentinel");
    pyodide.runPython("del builtins._");
  }, 60_000);

  test("SystemExit는 exit 코드로 분류하고 stderr에 쓰지 않는다", async () => {
    const pyconsole = makeConsole();

    const outcome = await exec(pyconsole, "import sys\nsys.exit(3)");

    expect(outcome).toStrictEqual({ kind: "exit", code: 3 });
    expect(output.stderr).toBe("");
  }, 60_000);

  test("topLevelAwait 인자를 따른다: 켬은 ok, 끔은 SyntaxError", async () => {
    const pyconsole = makeConsole();
    const source = "import asyncio\nawait asyncio.sleep(0)";

    const on = await exec(pyconsole, source, { topLevelAwait: true });
    const off = await exec(pyconsole, source, { topLevelAwait: false });

    expect(on).toStrictEqual({ kind: "ok" });
    expect(off).toMatchObject({ kind: "error", errorType: "SyntaxError" });
  }, 60_000);

  test("첫 줄 들여쓰기를 없애지 않고 오류로 낸다(dedent=False)", async () => {
    const pyconsole = makeConsole();

    const outcome = await exec(pyconsole, "  x = 1");

    expect(outcome).toMatchObject({ kind: "error", errorType: "SyntaxError" });
  }, 60_000);
});

describe("exec_in_console: SystemExit 뒤 stdin", () => {
  // 파일이 pyodide 하나를 공유하므로 원래 sys.stdin을 센티널로 바꿔 둔 채 시작하고 매 시험 뒤 되돌린다.
  // exit()가 현재 sys.stdin을 닫으므로 원본 대신 센티널을 닫혀도 되는 값으로 둔다.
  beforeEach(() => {
    pyodide.runPython(
      "import io, sys\n_orig_stdin = sys.stdin\nsys.stdin = io.StringIO('sentinel')",
    );
  });

  afterEach(() => {
    pyodide.runPython("sys.stdin = _orig_stdin\ndel _orig_stdin");
  });

  test("[S1] exit()가 닫은 sys.stdin을 fd 0·<stdin>·라인 버퍼로 되살린다", async () => {
    const pyconsole = makeConsole();

    const outcome = await exec(pyconsole, "exit()");

    expect(outcome).toStrictEqual({ kind: "exit", code: 0 });
    expect(
      pyodide
        .runPython(
          "(sys.stdin.closed, sys.stdin.name, sys.stdin.encoding, sys.stdin.errors, sys.stdin.line_buffering, sys.stdin.fileno())",
        )
        .toJs(),
    ).toEqual([false, "<stdin>", "utf-8", "strict", true, 0]);
  }, 60_000);

  test("[S2] exit 결말이어도 열린 sys.stdin은 교체하지 않는다", async () => {
    const pyconsole = makeConsole();
    const before = pyodide.runPython("id(sys.stdin)") as number;

    const outcome = await exec(pyconsole, "import sys\nsys.exit(3)");

    expect(outcome).toStrictEqual({ kind: "exit", code: 3 });
    expect(pyodide.runPython("id(sys.stdin)")).toBe(before);
  }, 60_000);

  test("[S3] exit가 아닌 결말에서 닫힌 sys.stdin은 되살리지 않는다", async () => {
    const pyconsole = makeConsole();
    const before = pyodide.runPython("id(sys.stdin)") as number;

    const outcome = await exec(pyconsole, "import sys\nsys.stdin.close()");

    expect(outcome).toStrictEqual({ kind: "ok" });
    expect(pyodide.runPython("id(sys.stdin)")).toBe(before);
    expect(pyodide.runPython("sys.stdin.closed")).toBe(true);
  }, 60_000);

  test("[S4] sys.stdin이 None이어도 SystemExit 뒤 새로 연다", async () => {
    const pyconsole = makeConsole();

    const outcome = await exec(
      pyconsole,
      "import sys\nsys.stdin = None\nraise SystemExit(0)",
    );

    expect(outcome).toStrictEqual({ kind: "exit", code: 0 });
    expect(pyodide.runPython("sys.stdin is None")).toBe(false);
    expect(pyodide.runPython("sys.stdin.closed")).toBe(false);
  }, 60_000);

  test("[S5] closed 속성이 없는 sys.stdin이어도 exit 결말이 예외로 뒤집히지 않는다(opus 리뷰 회귀)", async () => {
    const pyconsole = makeConsole();

    const outcome = await exec(
      pyconsole,
      "import sys\nsys.stdin = object()\nsys.exit()",
    );

    expect(outcome).toStrictEqual({ kind: "exit", code: 0 });
    // _open_stdin()이 다시 열었다면 TextIOWrapper가 됐을 것 — object() 그대로라 건드리지 않았다는 뜻.
    expect(pyodide.runPython("type(sys.stdin) is object")).toBe(true);
  }, 60_000);
});
