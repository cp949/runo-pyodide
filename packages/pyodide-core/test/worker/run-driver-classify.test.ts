// @vitest-environment node
/**
 * 실행 driver Python(`run-driver.py`)의 결말 분류 전수(RD-022 DELTA-02). 실제 pyodide에 `run_code`를 올리고 콘솔은 가짜
 * (`FakeConsole`: `runcode`가 정해 둔 예외를 올리고 `formattraceback`·`formatsyntaxerror`는 예외 클래스 이름만 낸다)로 바꿔서,
 * SIGINT 계층·메일박스 없이 분기 하나하나를 결정적으로 태운다. 실제 콘솔·SIGINT·stdin과 이어진 경로는
 * `run-driver-pyodide.test.ts`가 본다. pyodide는 파일당 한 번만 로드한다(가짜 콘솔이라 시험 사이 상태가 새지 않는다).
 */
import { loadPyodide, type PyodideInterface } from "pyodide";
import type { PyProxy } from "pyodide/ffi";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { installStdioWriters } from "../../src/worker/core-console";
import RUN_DRIVER_SOURCE from "../../src/worker/run-driver.py?raw";

/** `run_code`가 돌려주는 `[kind, error_type, traceback, code]`. */
type Raw = [
  string,
  string | undefined,
  string | undefined,
  number | bigint | undefined,
];

type RunCode = (
  console: PyProxy,
  source: string,
  filename: string,
  topLevelAwait: boolean,
) => Promise<Raw>;

/** 가짜 콘솔과 시험용 예외 클래스. 예외 인스턴스는 `mk(표현식)`으로 만든다. */
const HELPERS = `
import io, json, sys

class FakeConsole:
    """run_code가 부르는 콘솔 표면만 흉내 낸다."""
    def __init__(self, raises=None):
        self.raises = raises
        self.globals = None
        self.calls = []

    async def runcode(self, source, runner):
        self.calls.append(
            [source, type(runner).__name__, sorted(self.globals), self.globals["__name__"], self.globals["__file__"], id(self.globals)]
        )
        self.globals["leak"] = 1
        if self.raises is not None:
            raise self.raises

    def formattraceback(self, exc):
        return "TB:" + type(exc).__name__ + "\\n"

    def formatsyntaxerror(self, exc):
        return "SE:" + type(exc).__name__ + "\\n"

    def summary(self):
        return json.dumps(self.calls)

class KI(KeyboardInterrupt):
    pass

class IdleInterrupt(Exception):
    pass

class Custom(BaseException):
    pass

class BadStr:
    def __str__(self):
        raise RuntimeError("no str")

def mk(expr):
    return eval(expr)
`;

let pyodide: PyodideInterface;
let helpers: PyProxy & { get(name: string): unknown };
let namespace: PyProxy & {
  get(name: string): unknown;
  set(name: string, value: unknown): void;
};
let runCode: RunCode;
const output = { stdout: "", stderr: "" };

beforeAll(async () => {
  pyodide = await loadPyodide();
  installStdioWriters(pyodide, {
    write: (text) => {
      output.stdout += text;
    },
    writeErrorRaw: (text) => {
      output.stderr += text;
    },
  });
  namespace = pyodide.toPy({}) as typeof namespace;
  pyodide.runPython(RUN_DRIVER_SOURCE, {
    globals: namespace,
    filename: "<run-driver>",
  });
  runCode = namespace.get("run_code") as RunCode;
  helpers = pyodide.toPy({}) as typeof helpers;
  pyodide.runPython(HELPERS, { globals: helpers });
}, 60_000);

afterAll(() => {
  namespace.destroy();
  helpers.destroy();
});

/** 가짜 콘솔로 `run_code`를 부른다. `raises`는 `runcode`가 올릴 예외의 Python 표현식이다. */
async function run(
  raises: string | undefined,
  { source = "pass", filename = "main.py", topLevelAwait = false } = {},
) {
  output.stdout = "";
  output.stderr = "";
  const FakeConsole = helpers.get("FakeConsole") as (
    exc?: unknown,
  ) => PyProxy & {
    summary(): string;
  };
  const exc =
    raises === undefined
      ? undefined
      : pyodide.runPython(`mk(${JSON.stringify(raises)})`, {
          globals: helpers,
        });
  const fake = FakeConsole(exc);
  const result = await runCode(fake, source, filename, topLevelAwait);
  const calls = JSON.parse(fake.summary()) as [
    string,
    string,
    string[],
    string,
    string,
    number,
  ][];
  return { result, calls, stderr: output.stderr };
}

describe("run_code 결말 분류: 정상·중단", () => {
  test("예외 없이 끝나면 ok이고 stderr는 비어 있다", async () => {
    const { result, stderr } = await run(undefined);

    expect(result).toEqual(["ok", undefined, undefined, undefined]);
    expect(stderr).toBe("");
  });

  test.each([
    ["KeyboardInterrupt", "KeyboardInterrupt()", "TB:KeyboardInterrupt\n"],
    ["KeyboardInterrupt 하위 클래스", "KI()", "TB:KI\n"],
    [
      "정지한 대기를 깨운 표지 예외 IdleInterrupt",
      "IdleInterrupt()",
      "TB:IdleInterrupt\n",
    ],
  ])(
    "%s는 interrupted이고 트레이스백을 stderr에도 쓴다",
    async (_name, raises, traceback) => {
      const { result, stderr } = await run(raises);

      expect(result).toEqual(["interrupted", undefined, traceback, undefined]);
      expect(stderr).toBe(traceback);
    },
  );
});

describe("run_code 결말 분류: SystemExit(CPython 규칙)", () => {
  test.each([
    ["SystemExit()", 0],
    ["SystemExit(None)", 0],
    ["SystemExit(0)", 0],
    ["SystemExit(3)", 3],
    ["SystemExit(255)", 255],
    ["SystemExit(256)", 256],
    ["SystemExit(-1)", -1],
    ["SystemExit(True)", 1],
    ["SystemExit(2**31 - 1)", 2 ** 31 - 1],
    ["SystemExit(-(2**31))", -(2 ** 31)],
  ])(
    "int32 안 %s는 그대로 코드 %i이고 stderr에 아무것도 쓰지 않는다",
    async (raises, code) => {
      const { result, stderr } = await run(raises);

      expect(result).toEqual(["exit", undefined, undefined, code]);
      expect(typeof result[3]).toBe("number");
      expect(stderr).toBe("");
    },
  );

  test.each([
    ["SystemExit(2**31)", 0],
    ["SystemExit(2**31 + 5)", 5],
    ["SystemExit(2**53)", 0],
    ["SystemExit(2**53 - 1)", 255],
    ["SystemExit(-(2**53 - 1))", 1],
    ["SystemExit(2**70 + 7)", 7],
    ["SystemExit(-(2**70) - 1)", 255],
  ])(
    "int32 밖 %s는 BigInt가 아니라 number %i(하위 8비트)이다",
    async (raises, code) => {
      const { result } = await run(raises);

      expect(result[0]).toBe("exit");
      expect(typeof result[3]).toBe("number");
      expect(result[3]).toBe(code);
    },
  );

  test.each([
    ['SystemExit("x")', "x\n"],
    ["SystemExit(1.5)", "1.5\n"],
    ["SystemExit((1, 2))", "(1, 2)\n"],
    ["SystemExit(1, 2)", "(1, 2)\n"],
    ['SystemExit("")', "\n"],
  ])(
    "숫자가 아닌 코드 %s는 exit 1이고 str(코드)를 stderr에 쓴다",
    async (raises, message) => {
      const { result, stderr } = await run(raises);

      expect(result).toEqual(["exit", undefined, undefined, 1]);
      expect(stderr).toBe(message);
    },
  );

  test("str()이 던지는 코드 객체도 exit 1이고 클래스 이름으로 대신한다", async () => {
    const { result, stderr } = await run("SystemExit(BadStr())");

    expect(result).toEqual(["exit", undefined, undefined, 1]);
    expect(stderr).toBe("<BadStr 객체를 문자열로 바꿀 수 없다>\n");
  });
});

describe("run_code 결말 분류: 오류", () => {
  test.each([
    ["ValueError", "ValueError('x')", "ValueError"],
    ["BaseException 직접 하위 클래스", "Custom()", "Custom"],
    ["GeneratorExit", "GeneratorExit()", "GeneratorExit"],
    [
      "asyncio.CancelledError",
      "__import__('asyncio').CancelledError()",
      "CancelledError",
    ],
    [
      "이름이 IdleInterrupt와 비슷한 다른 예외",
      "type('IdleInterrupted', (Exception,), {})()",
      "IdleInterrupted",
    ],
  ])(
    "%s는 error이고 errorType은 클래스 이름이다",
    async (_name, raises, errorType) => {
      const { result, stderr } = await run(raises);

      expect(result).toEqual([
        "error",
        errorType,
        `TB:${errorType}\n`,
        undefined,
      ]);
      expect(stderr).toBe(`TB:${errorType}\n`);
    },
  );

  test.each([
    ["IndentationError", "IndentationError('x')"],
    ["TabError", "TabError('x')"],
    ["SyntaxError", "SyntaxError('x')"],
    [
      "SyntaxError를 상속한 사용자 클래스",
      "type('MySyntax', (SyntaxError,), {})('x')",
    ],
  ])(
    "실행 중 올라온 %s는 errorType SyntaxError로 통일하고 트레이스백에는 구체 이름이 남는다",
    async (_name, raises) => {
      const { result } = await run(raises);

      expect(result[0]).toBe("error");
      expect(result[1]).toBe("SyntaxError");
      expect(result[2]).toMatch(/^TB:\w+\n$/);
    },
  );
});

describe("run_code 컴파일 단계", () => {
  test.each([
    ["미완성 블록 `if x:`(IndentationError)", "if x:", "SE:IndentationError\n"],
    [
      "탭·공백 혼용(TabError)",
      "if 1:\n\tx = 1\n        y = 2\n",
      "SE:TabError\n",
    ],
    ["일반 문법 오류", "x = = 1", "SE:SyntaxError\n"],
    ["모듈 최상위 return(컴파일 단계)", "return 1", "SE:SyntaxError\n"],
    ["널 문자", "x = 1\0", "SE:SyntaxError\n"],
  ])(
    "%s는 errorType SyntaxError이고 runcode를 부르지 않는다",
    async (_name, source, text) => {
      const { result, calls, stderr } = await run(undefined, { source });

      expect(result).toEqual(["error", "SyntaxError", text, undefined]);
      expect(stderr).toBe(text);
      expect(calls).toEqual([]);
    },
  );

  test("최상위 await 끔은 문법 오류이고 켬은 runcode까지 간다", async () => {
    const source = "import asyncio\nawait asyncio.sleep(0)";

    const off = await run(undefined, { source, topLevelAwait: false });
    const on = await run(undefined, { source, topLevelAwait: true });

    expect(off.result[0]).toBe("error");
    expect(off.result[1]).toBe("SyntaxError");
    expect(off.calls).toEqual([]);
    expect(on.result[0]).toBe("ok");
    expect(on.calls).toHaveLength(1);
  });

  test.each([
    [
      "RecursionError",
      "RecursionError('maximum recursion depth exceeded during compilation')",
      "RecursionError: maximum recursion depth exceeded during compilation\n",
    ],
    ["MemoryError", "MemoryError()", "MemoryError\n"],
    // 이 둘은 `Console.runsource`와 같이 문법 오류 포맷터를 거치지만 SyntaxError가 아니므로 이름은 그대로다.
    ["ValueError", "ValueError('bad')", "SE:ValueError\n"],
    ["OverflowError", "OverflowError('big')", "SE:OverflowError\n"],
  ])(
    "컴파일러가 낸 %s는 RPC 오류가 아니라 error 결과다",
    async (name, expr, text) => {
      // 실제 너무 깊은 식은 실행 스레드 스택에 따라 pyodide 치명 오류가 되어 시험할 수 없다. 컴파일러(`CodeRunner`)를 대신한다.
      const original = namespace.get("CodeRunner");
      pyodide.runPython(`def raiser(*args, **kwargs):\n    raise ${expr}\n`, {
        globals: helpers,
      });
      namespace.set("CodeRunner", helpers.get("raiser"));
      try {
        const { result, calls, stderr } = await run(undefined, {
          source: "x = 1",
        });

        expect(result).toEqual(["error", name, text, undefined]);
        expect(stderr).toBe(text);
        expect(calls).toEqual([]);
      } finally {
        namespace.set("CodeRunner", original);
      }
    },
  );
});

describe("run_code 실행 환경", () => {
  test("run마다 CPython 스크립트와 같은 새 globals를 만들어 runcode에 준다", async () => {
    const first = await run(undefined, { filename: "app.py" });
    const second = await run(undefined, { filename: "app.py" });

    const keys = [
      "__builtins__",
      "__doc__",
      "__file__",
      "__name__",
      "__spec__",
    ];
    expect(first.calls[0]).toEqual([
      "pass",
      "CodeRunner",
      keys,
      "__main__",
      "app.py",
      expect.any(Number),
    ]);
    // 첫 실행이 남긴 `leak`이 두 번째 globals에 없고 dict도 새 것이다.
    expect(second.calls[0]![2]).toEqual(keys);
    expect(second.calls[0]![5]).not.toBe(first.calls[0]![5]);
  });
});

describe("run_code stdin 교체", () => {
  test("run 시작에 sys.stdin을 원래 pyodide stdin과 같은 모양의 새 객체로 바꾼다", async () => {
    pyodide.runPython(
      "import io, sys\nsentinel = io.StringIO('x')\nsys.stdin = sentinel",
      { globals: helpers },
    );
    const before = pyodide.runPython("id(sys.stdin)", {
      globals: helpers,
    }) as number;

    await run(undefined);

    expect(
      pyodide.runPython(
        "id(sys.stdin) != " + before + " and not sys.stdin.closed",
        { globals: helpers },
      ),
    ).toBe(true);
    expect(
      pyodide
        .runPython(
          "(sys.stdin.name, sys.stdin.encoding, sys.stdin.errors, sys.stdin.line_buffering, sys.stdin.fileno())",
          {
            globals: helpers,
          },
        )
        .toJs(),
    ).toEqual(["<stdin>", "utf-8", "strict", true, 0]);
  });

  test("닫힌 sys.stdin(exit()·quit()가 남긴 상태)도 다음 run에서 열린다", async () => {
    pyodide.runPython("sys.stdin.close()", { globals: helpers });

    await run(undefined);

    expect(pyodide.runPython("sys.stdin.closed", { globals: helpers })).toBe(
      false,
    );
  });
});
