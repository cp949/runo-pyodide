// @vitest-environment node
/**
 * 제출 러너(`createSubmissionRunner`) 시험(02-console-core.md 5.2, 05-output.md 4.1).
 * 실제 pyodide(node)의 실제 `ReplConsole` + 실제 `splitPaste`를 러너에 물려 한 줄 제출·값 에코·오류 표시·끝 개행·`exit`·
 * `null` 취소·여러 줄 분할(붙여넣기)·줄 단위 흘림(블록 입력 중)·코퍼스 차등 검증을 확인한다. 가짜 분할기는 배선
 * 시험 1건에만 쓴다.
 * 실행 밖에서 새는 `KeyboardInterrupt` 안전망은 실제 SIGINT 없이 `runLine`·`clearPending`을 `KeyboardInterrupt`를 던지는
 * Python 함수로 바꿔 끼워 재현한다.
 */
import { loadPyodide, type PyodideInterface } from "pyodide";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { createConsole, type ReplConsole } from "../../src/worker/console";
import corpus from "./multiline-corpus.json";
import { loadSplitPaste, type SplitPaste } from "../../src/worker/multiline";
import { createSubmissionRunner } from "../../src/worker/submission-runner";
import {
  suppressWebLoopReraise,
  warnDegraded,
} from "@cp949/runo-pyodide-core/test-utils/worker";

let pyodide: PyodideInterface;
let splitPaste: SplitPaste;

beforeAll(async () => {
  pyodide = await loadPyodide();
  splitPaste = loadSplitPaste(pyodide);
}, 60_000);

/**
 * 새 콘솔과 러너. `screen`은 화면에 쌓일 텍스트다 — 콘솔 콜백(`print` 등)은 개행이 이미 들어 있어 그대로 잇고,
 * `io`(`writeOutput`/`writeError`)는 실제 sink(`readline.println`)처럼 끝에 개행을 붙인다(TRAP-29). 호출부가 끝 개행을
 * 이미 붙여 넘기면 화면에 빈 줄이 하나 더 생기므로 이 모사가 이중 개행을 잡는다.
 * `hooks`로 러너가 보는 `runLine`·`clearPending`만 바꿔 끼울 수 있다(실제 콘솔은 그대로).
 */
function setup() {
  const screen = { stdout: "", stderr: "" };
  const sinks = {
    write: vi.fn((text: string) => {
      screen.stdout += text;
    }),
    writeErrorRaw: vi.fn((text: string) => {
      screen.stderr += text;
    }),
  };
  const repl = createConsole(pyodide, sinks, { topLevelAwait: false });
  // KeyboardInterrupt 안전망·exit() 시험이 WebLoop 재보고로 처리되지 않은 Promise 거부를 남기지 않도록 worker와
  // 같은 순서로 설치한다(03-ctrl-c.md 2.8).
  suppressWebLoopReraise(pyodide, { report: warnDegraded });
  const io = {
    writeOutput: vi.fn((text: string) => {
      screen.stdout += `${text}\n`;
    }),
    writeError: vi.fn((text: string) => {
      screen.stderr += `${text}\n`;
    }),
  };
  const hooks: {
    runLine?: ReplConsole["runLine"];
    clearPending?: ReplConsole["clearPending"];
    splitPaste?: SplitPaste;
  } = {};
  const seen: Pick<
    ReplConsole,
    "runLine" | "pending" | "clearPending" | "compilerFlags"
  > = {
    runLine: (source, options) =>
      (hooks.runLine ?? repl.runLine)(source, options),
    pending: () => repl.pending(),
    clearPending: () => (hooks.clearPending ?? repl.clearPending)(),
    compilerFlags: () => repl.compilerFlags(),
  };
  const splitPasteSpy = vi.fn((source: string, flags: number) =>
    (hooks.splitPaste ?? splitPaste)(source, flags),
  );
  const { run } = createSubmissionRunner(pyodide, seen, io, {
    splitPaste: splitPasteSpy,
  });
  return { run, io, screen, hooks, splitPasteSpy };
}

const READY = { prompt: ">>> ", exit: false };

describe("한 줄 제출", () => {
  test("식을 입력하면 값을 에코하고 `>>> `로 돌아온다", async () => {
    const { run, io } = setup();

    const result = await run("1 + 1");

    expect(result).toStrictEqual(READY);
    expect(io.writeOutput.mock.calls).toEqual([["2"]]);
    expect(io.writeError).not.toHaveBeenCalled();
  });

  test("블록 시작 줄은 `... `와 pending을 돌려주고 빈 줄이 블록을 실행한다", async () => {
    const { run, screen } = setup();

    expect(await run("if True:")).toStrictEqual({
      prompt: "... ",
      exit: false,
      pending: "if True:",
    });
    expect(await run("    print('x')")).toStrictEqual({
      prompt: "... ",
      exit: false,
      pending: "if True:\n    print('x')",
    });
    expect(screen.stdout).toBe("");
    expect(await run("")).toStrictEqual(READY);
    expect(screen.stdout).toBe("x\n");
  });

  test("문법 오류는 오류를 한 번 쓰고 `>>> `로 돌아온다", async () => {
    const { run, io } = setup();

    const result = await run("x = = 1");

    expect(result).toStrictEqual(READY);
    expect(io.writeError).toHaveBeenCalledTimes(1);
    expect(io.writeError.mock.calls[0]?.[0]).toContain(
      "SyntaxError: invalid syntax",
    );
    expect(io.writeOutput).not.toHaveBeenCalled();
  });

  test("EOF에서 끊긴 `1 +`는 표준 `SyntaxError: invalid syntax`로 나온다", async () => {
    const { run, io } = setup();

    await run("1 +");

    expect(io.writeError.mock.calls).toEqual([
      [
        '  File "<console>", line 1\n    1 +\n       ^\nSyntaxError: invalid syntax',
      ],
    ]);
  });

  test("빈 줄만 입력하면 아무것도 출력하지 않는다", async () => {
    const { run, io, screen } = setup();

    const result = await run("");

    expect(result).toStrictEqual(READY);
    expect(io.writeOutput).not.toHaveBeenCalled();
    expect(io.writeError).not.toHaveBeenCalled();
    expect(screen.stdout + screen.stderr).toBe("");
  });

  test("런타임 예외는 트레이스백을 쓰고 이후 입력을 계속 받는다", async () => {
    const { run, io } = setup();

    expect(await run("1/0")).toStrictEqual(READY);
    expect(io.writeError.mock.calls[0]?.[0]).toContain(
      "ZeroDivisionError: division by zero",
    );
    expect(await run("2 + 2")).toStrictEqual(READY);
    expect(io.writeOutput.mock.calls).toEqual([["4"]]);
  });

  test("`None`과 대입은 출력이 없다", async () => {
    const { run, io } = setup();

    await run("None");
    await run("x = 3");

    expect(io.writeOutput).not.toHaveBeenCalled();
    expect(io.writeError).not.toHaveBeenCalled();
  });

  test("`__repr__` 예외는 트레이스백으로 나온다", async () => {
    const { run, io } = setup();
    pyodide.runPython(
      "class BadRepr:\n    def __repr__(self):\n        raise ValueError('boom')\n",
    );

    const result = await run("BadRepr()");

    expect(result).toStrictEqual(READY);
    expect(io.writeOutput).not.toHaveBeenCalled();
    expect(io.writeError.mock.calls[0]?.[0]).toMatch(
      /^Traceback \(most recent call last\):\n[\s\S]*ValueError: boom$/,
    );
  });
});

// sink가 개행을 붙이므로 러너는 끝 개행 없는 텍스트를 넘겨야 한다. 어긋나면 프롬프트 앞에 빈 줄이 생긴다.
describe("출력 끝 개행", () => {
  test("식 값 에코 뒤에 빈 줄이 없다", async () => {
    const { run, screen } = setup();

    await run("2");

    expect(screen.stdout).toBe("2\n");
  });

  test("트레이스백 뒤에 빈 줄이 없다", async () => {
    const { run, screen } = setup();

    await run("1/0");

    expect(
      screen.stderr.endsWith("ZeroDivisionError: division by zero\n"),
    ).toBe(true);
    expect(screen.stderr.endsWith("\n\n")).toBe(false);
  });

  test("문법 오류 뒤에 빈 줄이 없다", async () => {
    const { run, screen } = setup();

    await run("x = = 1");

    expect(screen.stderr.endsWith("SyntaxError: invalid syntax\n")).toBe(true);
    expect(screen.stderr.endsWith("\n\n")).toBe(false);
  });

  test("예외 메시지 자체가 개행으로 끝나면 그 개행은 남긴다", async () => {
    const { run, screen } = setup();

    await run('raise ValueError("x\\n")');

    // CPython도 `ValueError: x` 뒤 빈 줄을 낸다. 러너는 끝 개행을 정확히 하나만 뗀다.
    expect(screen.stderr.endsWith("ValueError: x\n\n")).toBe(true);
    expect(screen.stderr.endsWith("\n\n\n")).toBe(false);
  });
});

describe("종료", () => {
  test.each([
    { code: "exit()" },
    { code: "quit()" },
    { code: "raise SystemExit" },
  ])("`$code`은 exit가 참이고 오류를 쓰지 않는다", async ({ code }) => {
    const { run, io } = setup();

    const result = await run(code);

    expect(result).toStrictEqual({ prompt: ">>> ", exit: true });
    expect(io.writeError).not.toHaveBeenCalled();
    expect(io.writeOutput).not.toHaveBeenCalled();
  });
});

describe("취소(`null`)", () => {
  test("블록 입력 중 취소하면 블록을 버리고 이어서 입력한 줄이 새로 실행된다", async () => {
    const { run, screen } = setup();
    await run("if True:");

    expect(await run(null)).toStrictEqual(READY);

    // 버리지 않았다면 `if True:\nprint(1)`이 IndentationError가 된다.
    expect(await run("print(1)")).toStrictEqual(READY);
    expect(screen.stdout).toBe("1\n");
  });

  test("취소는 `KeyboardInterrupt` 한 줄만 쓴다(트레이스백 헤더·값 에코 없음)", async () => {
    const { run, io, screen } = setup();
    await run("if True:");

    await run(null);

    expect(io.writeError.mock.calls).toEqual([["KeyboardInterrupt"]]);
    expect(io.writeOutput).not.toHaveBeenCalled();
    expect(screen.stderr).toBe("KeyboardInterrupt\n");
    expect(screen.stdout).toBe("");
  });

  test("본문 줄까지 쌓인 블록도 전체를 버린다", async () => {
    const { run, screen } = setup();
    await run("if True:");
    await run("    print(2)");

    await run(null);

    expect(await run("print(1)")).toStrictEqual(READY);
    expect(screen.stdout).toBe("1\n");
  });

  test("`>>> `에서의 취소도 같은 출력을 내고 `>>> `로 돌아온다", async () => {
    const { run, io, screen } = setup();

    expect(await run(null)).toStrictEqual(READY);

    expect(io.writeError.mock.calls).toEqual([["KeyboardInterrupt"]]);
    expect(screen.stdout).toBe("");
  });
});

/**
 * 호출하면 `KeyboardInterrupt`를 던지는 Python 함수. 사용자 코드 밖(컴파일·취소 처리)에서 새는 SIGINT를 SIGINT 없이
 * 재현한다. 사용자 globals를 더럽히지 않도록 별도 namespace에서 정의한다.
 */
function pythonFunction<T>(source: string): T {
  return pyodide.runPython(source, { globals: pyodide.toPy({}) }) as T;
}
const LEAK = "def leak(*args):\n    raise KeyboardInterrupt\nleak";

describe("실행 밖에서 새는 KeyboardInterrupt(안전망)", () => {
  test("`runLine`에서 새면 취소와 같은 출력을 내고 같은 콘솔에서 계속한다", async () => {
    const { run, io, hooks } = setup();
    hooks.runLine = pythonFunction<ReplConsole["runLine"]>(LEAK);

    expect(await run("1")).toStrictEqual(READY);

    expect(io.writeError.mock.calls).toEqual([["KeyboardInterrupt"]]);
    hooks.runLine = undefined;
    expect(await run("2 + 2")).toStrictEqual(READY);
    expect(io.writeOutput.mock.calls).toEqual([["4"]]);
  });

  test("블록 입력 중에 새면 미완성 블록을 버려 다음 입력에 붙지 않는다", async () => {
    const { run, screen, hooks } = setup();
    await run("if True:");
    hooks.runLine = pythonFunction<ReplConsole["runLine"]>(LEAK);

    expect(await run("    print(0)")).toStrictEqual(READY);

    hooks.runLine = undefined;
    expect(await run("print(1)")).toStrictEqual(READY);
    expect(screen.stdout).toBe("1\n");
    expect(screen.stderr).toBe("KeyboardInterrupt\n");
  });

  test("취소 처리(`clearPending`) 중 다시 끊겨도 던지지 않고 `KeyboardInterrupt`만 쓴다", async () => {
    const { run, io, hooks } = setup();
    hooks.clearPending = pythonFunction<ReplConsole["clearPending"]>(LEAK);

    const result = await run(null);

    expect(result).toStrictEqual(READY);
    expect(io.writeError.mock.calls).toEqual([["KeyboardInterrupt"]]);
  });

  test("복구 중 `clearPending`이 `KeyboardInterrupt`가 아닌 오류를 내면 삼키지 않고 던진다", async () => {
    const { run, io, hooks } = setup();
    hooks.runLine = pythonFunction<ReplConsole["runLine"]>(LEAK);
    hooks.clearPending = pythonFunction<ReplConsole["clearPending"]>(
      "def fail(*args):\n    raise RuntimeError('cleanup')\nfail",
    );

    await expect(run("1")).rejects.toThrow("RuntimeError: cleanup");

    expect(io.writeError).not.toHaveBeenCalled();
  });

  test("변환 중 `ConversionError`에 감싸인 `KeyboardInterrupt`도 취소로 처리한다", async () => {
    const { run, io, hooks } = setup();
    // `err.type`은 "ConversionError"지만 메시지의 연쇄 예외 출력에 `KeyboardInterrupt` 단독 줄이 있다.
    hooks.runLine = pythonFunction<ReplConsole["runLine"]>(
      [
        "from pyodide.ffi import ConversionError",
        "def leak(*args):",
        "    try:",
        "        raise KeyboardInterrupt",
        "    except KeyboardInterrupt as e:",
        "        raise ConversionError('wrapped') from e",
        "leak",
      ].join("\n"),
    );

    expect(await run("1")).toStrictEqual(READY);

    expect(io.writeError.mock.calls).toEqual([["KeyboardInterrupt"]]);
  });

  test("`KeyboardInterrupt`가 아닌 Python 오류는 삼키지 않고 던진다", async () => {
    const { run, io, hooks } = setup();
    hooks.runLine = pythonFunction<ReplConsole["runLine"]>(
      "def leak(*args):\n    raise RuntimeError('x')\nleak",
    );

    await expect(run("1")).rejects.toThrow("RuntimeError: x");

    expect(io.writeError).not.toHaveBeenCalled();
  });

  test("JS 오류도 삼키지 않고 던진다", async () => {
    const { run, hooks } = setup();
    hooks.runLine = () => {
      throw new Error("runLine 실패");
    };

    await expect(run("1")).rejects.toThrow("runLine 실패");
  });
});

describe("여러 줄 제출: 문장 단위 분할(붙여넣기)", () => {
  test("`1\\n2\\n3`은 마지막 값만 에코한다(S03)", async () => {
    const { run, screen } = setup();

    const result = await run("1\n2\n3");

    expect(result).toStrictEqual(READY);
    expect(screen.stdout).toBe("3\n");
  });

  test("함수 정의와 호출을 나눠 실행한다", async () => {
    const { run, screen } = setup();

    const result = await run(
      "def add(a, b):\n    return a + b\n\nprint(add(1, 2))",
    );

    expect(result).toStrictEqual(READY);
    expect(screen.stdout).toBe("3\n");
  });

  test("클래스 메서드 사이 빈 줄이 블록을 끊지 않는다", async () => {
    const { run, screen } = setup();
    const source =
      "class A:\n    def f(self): return 1\n\n    def g(self): return 2\n\nprint(A().g())";

    const result = await run(source);

    expect(result).toStrictEqual(READY);
    expect(screen.stdout).toBe("2\n");
  });

  test("붙여넣은 탭 들여쓰기를 그대로 실행한다", async () => {
    const { run, screen } = setup();

    const result = await run("def f():\n\treturn 1\nprint(f())");

    expect(result).toStrictEqual(READY);
    expect(screen.stdout).toBe("1\n");
  });
});

describe("여러 줄 제출: 파싱·컴파일 오류는 아무 문장도 실행하지 않는다", () => {
  test("문법 오류 뒤 이어진 이름 참조는 NameError다(S07)", async () => {
    const { run, screen } = setup();

    const first = await run("a = 1\nb = = 2");
    expect(first).toStrictEqual(READY);
    expect(screen.stderr).toContain("SyntaxError");
    expect(screen.stdout).toBe("");

    const second = await run("a");
    expect(second).toStrictEqual(READY);
    expect(screen.stderr).toContain("NameError");
  });

  test("함수 밖 return은 2차 compile 오류로 아무 문장도 실행하지 않는다", async () => {
    const { run, screen } = setup();

    const result = await run("print(1)\nreturn 2");

    expect(result).toStrictEqual(READY);
    expect(screen.stdout).toBe("");
    expect(screen.stderr).toContain("'return' outside function");
  });
});

describe("여러 줄 제출: 예외·exit() 뒤 나머지 문장 미실행", () => {
  test("런타임 예외 뒤 나머지 문장은 실행하지 않는다", async () => {
    const { run, screen } = setup();

    const result = await run("print(1)\n1/0\nprint(2)");

    expect(result).toStrictEqual(READY);
    expect(screen.stdout).toBe("1\n");
    expect(screen.stderr).toContain("ZeroDivisionError");
  });

  test("`exit()` 뒤 나머지 문장은 실행하지 않는다", async () => {
    const { run, screen } = setup();

    const result = await run("print(1)\nexit()\nprint(2)");

    expect(result).toStrictEqual({ prompt: ">>> ", exit: true });
    expect(screen.stdout).toBe("1\n");
  });
});

describe("여러 줄 제출: 무동작 입력", () => {
  test.each([{ source: "# a\n\n# b" }, { source: "\n\n" }])(
    "`$source`는 push 없이 `>>> `로 돌아온다",
    async ({ source }) => {
      const { run, hooks, screen } = setup();
      let calls = 0;
      hooks.runLine = () => {
        calls++;
        throw new Error("빈 chunk는 runLine을 부르면 안 된다");
      };

      const result = await run(source);

      expect(result).toStrictEqual(READY);
      expect(calls).toBe(0);
      expect(screen.stdout + screen.stderr).toBe("");
    },
  );
});

describe("여러 줄 제출: `builtins._`는 마지막(에코한) 문장에서만 갱신된다", () => {
  test("에코하지 않은 중간 문장은 `_`를 갱신하지 않는다", async () => {
    const { run, screen } = setup();
    await run("42");

    await run("1\n2\nprint()");
    const result = await run("_");

    expect(result).toStrictEqual(READY);
    expect(screen.stdout.endsWith("42\n")).toBe(true);
  });

  test("마지막 문장이 값이면 `_`가 그 값으로 갱신된다", async () => {
    const { run, screen } = setup();

    await run("1\n2\n3");
    const result = await run("_");

    expect(result).toStrictEqual(READY);
    expect(screen.stdout).toBe("3\n3\n");
  });
});

describe("줄 단위 흘림(블록 입력 중 붙여넣기)", () => {
  test("블록 시작 뒤 본문+빈 줄+다음 문장을 흘려 넣으면 순서대로 실행된다", async () => {
    const { run, screen } = setup();
    await run("for i in range(2):");

    const result = await run("    print(i)\n\nprint('done')");

    expect(result).toStrictEqual(READY);
    expect(screen.stdout).toBe("0\n1\ndone\n");
  });

  test("본문 줄까지만 흘려 넣으면 여전히 `... `와 합쳐진 pending이다", async () => {
    const { run } = setup();
    await run("def f():");

    const result = await run("    a = 1\n    b = 2");

    expect(result).toStrictEqual({
      prompt: "... ",
      exit: false,
      pending: "def f():\n    a = 1\n    b = 2",
    });
  });

  test("흘림 중 오류가 나면 나머지 줄은 실행하지 않는다", async () => {
    const { run, screen } = setup();
    await run("if True:");

    const result = await run("    x = = 1\n    print('after')");

    expect(result).toStrictEqual(READY);
    expect(screen.stderr).toContain("SyntaxError");
    expect(screen.stdout).not.toContain("after");
  });
});

describe("배선: `deps.splitPaste`는 (line, compilerFlags())로 호출된다", () => {
  test("여러 줄 제출은 splitPaste에 원문과 compilerFlags()를 넘긴다", async () => {
    const { run, splitPasteSpy } = setup();

    await run("1\n2");

    expect(splitPasteSpy).toHaveBeenCalledWith("1\n2", 0);
  });
});

/** 코퍼스 소스를 exec로 통째 실행했을 때 `sys.stdout`에 쌓이는 문자열(기대값). */
async function execStdout(source: string): Promise<string> {
  return pyodide.runPythonAsync(
    [
      "import io, contextlib",
      "_buf = io.StringIO()",
      '_g = {"__name__": "__main__"}',
      "with contextlib.redirect_stdout(_buf):",
      '    exec(compile(SRC, "<x>", "exec"), _g)',
      "_buf.getvalue()",
    ].join("\n"),
    { globals: pyodide.toPy({ SRC: source }) },
  ) as Promise<string>;
}

describe("코퍼스 27: 러너 stdout이 exec 통째 실행 stdout과 일치한다", () => {
  test.each(corpus as { name: string; source: string }[])(
    "$name",
    async ({ name, source }) => {
      const expected = await execStdout(source);
      const { run, screen } = setup();

      const result = await run(source);

      expect(screen.stdout, name).toBe(expected);
      expect(screen.stderr, name).toBe("");
      expect(result.exit, name).toBe(false);
    },
  );
});
