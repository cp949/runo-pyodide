// @vitest-environment node
/**
 * worker 콘솔 코어(`createConsole`) 시험(02-console-core.md 5.1·5.4, TRAP-02·03).
 *
 * 실제 pyodide(node)에서 아래를 확인한다.
 * - `PyodideConsole` 생성·콜백·`sys.ps1/ps2`.
 * - `runLine`의 네 결과.
 * - `await_fut` 헬퍼.
 * - 값 에코(`echo`).
 * - `_IncompleteInputError` 정규화.
 * - `pending()`/`clearPending()`.
 *
 * sink는 `vi.fn()`이라 터미널 바이트는 보지 않는다. 그것은 `terminal/sinks-pyodide.test.ts`가 본다.
 */
import { loadPyodide, type PyodideInterface } from "pyodide";
import { beforeAll, describe, expect, test, vi } from "vitest";
import {
  createConsole,
  type ReplConsole,
  type RunLineResult,
} from "../../src/worker/console";
import {
  suppressWebLoopReraise,
  warnDegraded,
} from "@cp949/runo-pyodide-core/test-utils/worker";

/** 파일 전체가 공유하는 pyodide 인스턴스. 앞 시험이 남긴 전역을 뒤 시험이 볼 수 있다. */
let pyodide: PyodideInterface;

beforeAll(async () => {
  pyodide = await loadPyodide();
}, 60_000);

/** 새 콘솔과 호출을 기록하는 sink. 콘솔을 만들 때마다 전역 stdout/stderr Writer가 이 sink로 다시 등록된다. */
function setup(topLevelAwait = false) {
  const sinks = { write: vi.fn(), writeErrorRaw: vi.fn() };
  const repl = createConsole(pyodide, sinks, { topLevelAwait });
  // `exit()` 같은 시험은 SystemExit을 실제로 낸다.
  // WebLoop 재보고가 처리되지 않은 Promise 거부를 남기지 않도록 worker와 같은 순서로 억제를 설치한다(03-ctrl-c.md 2.8).
  suppressWebLoopReraise(pyodide, { report: warnDegraded });
  return { sinks, repl };
}

describe("createConsole", () => {
  test("배너는 Python 3.14.2로 시작하고 끝 개행이 없다", () => {
    const { repl } = setup();

    expect(repl.banner.startsWith("Python 3.14.2 (")).toBe(true);
    expect(repl.banner.includes('Type "help"')).toBe(true);
    expect(repl.banner.endsWith("\n")).toBe(false);
  });

  test("`sys.ps1`·`sys.ps2`가 설정된다", () => {
    setup();

    const prompts = pyodide.runPython("import sys; (sys.ps1, sys.ps2)");

    expect(prompts.toJs()).toEqual([">>> ", "... "]);
    prompts.destroy();
  });

  test("새 콘솔을 만들어도 `sys`가 사용자 전역에 남지 않는다", () => {
    // pyodide 인스턴스를 시험끼리 공유한다. 앞 시험이 남긴 `sys`를 먼저 지운다.
    pyodide.runPython("globals().pop('sys', None)");
    setup();

    const leaked = pyodide.runPython("'sys' in globals()");

    expect(leaked).toBe(false);
  });

  test("기본 옵션(false)에서 top-level await가 꺼져 있다", async () => {
    const { repl } = setup();

    const result = await repl.runLine("await 1");

    expect(result.kind).toBe("syntax-error");
    expect(result).toMatchObject({
      formattedError: expect.stringContaining("'await' outside function"),
    });
  });

  test("식 한 줄은 값의 repr와 함께 complete로 끝나고 `builtins._`가 갱신된다", async () => {
    const { repl } = setup();

    const result = await repl.runLine("1 + 1");

    expect(result).toEqual({ kind: "complete", echo: "2", exited: false });
    expect(pyodide.runPython("_")).toBe(2);
  });

  test("문장은 echo 없이 complete다", async () => {
    const { repl } = setup();

    const result = await repl.runLine("x = 3");

    expect(result).toStrictEqual({
      kind: "complete",
      echo: null,
      exited: false,
    });
  });

  test("미완성 블록은 incomplete다", async () => {
    const { repl } = setup();

    const result = await repl.runLine("if True:");

    expect(result).toEqual({ kind: "incomplete" });
  });

  test("문법 오류는 syntax-error와 formatted_error다", async () => {
    const { repl } = setup();

    // EOF에서 끊긴 입력(`1 +` 등)은 아래 "문법 오류 정규화"가 다룬다.
    // 여기서는 정규화 없이 나오는 평범한 오류를 쓴다.
    const result = await repl.runLine("x = = 1");

    expect(result.kind).toBe("syntax-error");
    if (result.kind !== "syntax-error") return;
    expect(result.formattedError.includes("SyntaxError: invalid syntax")).toBe(
      true,
    );
    expect(result.formattedError.endsWith("\n")).toBe(true);
  });

  test("실행 예외는 error와 내부 프레임 없는 트레이스백이다", async () => {
    const { repl } = setup();

    const result = await repl.runLine("1/0");

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.formattedError.includes("ZeroDivisionError")).toBe(true);
    for (const internal of [
      "runcode",
      "push",
      "_runcode_with_lock",
      "await_fut",
    ]) {
      expect(result.formattedError.includes(internal)).toBe(false);
    }
  });

  test("`exit()`는 exited가 참인 complete다", async () => {
    const { repl } = setup();

    const result = await repl.runLine("exit()");

    expect(result).toStrictEqual({
      kind: "complete",
      echo: null,
      exited: true,
    });
  });

  test("콘솔 실행 중 stdout 조각은 write sink로 즉시 온다", async () => {
    const { repl, sinks } = setup();

    await repl.runLine('print("x", end="")');

    // 빈 `end`도 조각으로 온다. 무출력 규칙은 main sink가 지킨다.
    expect(sinks.write.mock.calls).toEqual([["x"], [""]]);
    expect(sinks.writeErrorRaw).not.toHaveBeenCalled();
  });

  test("콘솔 실행 중 stderr 조각은 writeErrorRaw sink로 온다", async () => {
    const { repl, sinks } = setup();

    await repl.runLine('import sys; print("err", file=sys.stderr)');

    expect(sinks.writeErrorRaw.mock.calls).toEqual([["err"], ["\n"]]);
    expect(sinks.write).not.toHaveBeenCalled();
  });

  test("콘솔 밖 출력은 전역 Writer로 같은 sink에 온다", () => {
    const { sinks } = setup();

    pyodide.runPython('print("bg", flush=True)');
    pyodide.runPython('import sys; sys.stderr.write("e\\n")');

    expect(sinks.write.mock.calls).toEqual([["bg\n"]]);
    expect(sinks.writeErrorRaw.mock.calls).toEqual([["e\n"]]);
  });

  test("헬퍼 함수(`await_fut`·`format_syntax_error`)는 사용자 globals에 남지 않는다", () => {
    setup();

    expect(pyodide.runPython("'await_fut' in globals()")).toBe(false);
    expect(pyodide.runPython("'format_syntax_error' in globals()")).toBe(false);
  });

  test("`compilerFlags()`는 INCOMPLETE_INPUT_FLAGS(0x4200) 비트를 빼고 TLA 토글에 따라 0x2000 비트가 바뀐다", () => {
    const { repl: withoutTla } = setup(false);
    const { repl: withTla } = setup(true);

    expect(withoutTla.compilerFlags() & 0x4200).toBe(0);
    expect(withTla.compilerFlags() & 0x4200).toBe(0);
    expect(withoutTla.compilerFlags() & 0x2000).toBe(0);
    expect(withTla.compilerFlags() & 0x2000).toBe(0x2000);
  });
});

describe("값 에코(`echo`)", () => {
  test("문자열은 따옴표가 붙은 Python repr로 온다", async () => {
    const { repl } = setup();

    const result = await repl.runLine("'abc'");

    expect(result).toEqual({ kind: "complete", echo: "'abc'", exited: false });
  });

  test("dict는 JS 변환이 아닌 Python repr로 온다", async () => {
    const { repl } = setup();

    const result = await repl.runLine("{'a': [1, None]}");

    expect(result).toEqual({
      kind: "complete",
      echo: "{'a': [1, None]}",
      exited: false,
    });
  });

  test("`None`은 echo가 null이고 직전 `builtins._`를 유지한다", async () => {
    const { repl } = setup();
    await repl.runLine("5");

    const result = await repl.runLine("None");

    expect(result).toEqual({ kind: "complete", echo: null, exited: false });
    expect(pyodide.runPython("import builtins; builtins._")).toBe(5);
  });

  test("1000자를 넘는 repr도 절단 없이 전체가 온다", async () => {
    const { repl } = setup();
    const expected = `[${Array.from({ length: 400 }, (_, i) => i).join(", ")}]`;

    const result = await repl.runLine("list(range(400))");

    expect(expected.length).toBeGreaterThan(1000);
    expect(result).toEqual({ kind: "complete", echo: expected, exited: false });
  });

  test("`__repr__` 예외는 헬퍼 프레임 없는 트레이스백의 error이고 `builtins._`를 바꾸지 않는다", async () => {
    const { repl } = setup();
    pyodide.runPython(
      "class BadRepr:\n    def __repr__(self):\n        raise ValueError('boom')\n",
    );
    await repl.runLine("7");

    const result = await repl.runLine("BadRepr()");

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(
      result.formattedError.startsWith("Traceback (most recent call last):\n"),
    ).toBe(true);
    expect(result.formattedError.includes("in __repr__")).toBe(true);
    // 끝 개행은 하나다. 개행 제거는 호출부(러너)가 한다.
    expect(result.formattedError.endsWith("ValueError: boom\n")).toBe(true);
    for (const internal of [
      "runcode",
      "push",
      "_runcode_with_lock",
      "await_fut",
    ]) {
      expect(result.formattedError.includes(internal)).toBe(false);
    }
    expect(pyodide.runPython("import builtins; builtins._")).toBe(7);
  });
});

/** 줄들을 차례로 push하고 마지막 줄의 결과를 돌려준다. */
async function pushAll(
  repl: ReplConsole,
  lines: string[],
): Promise<RunLineResult> {
  let result: RunLineResult = { kind: "incomplete" };
  for (const line of lines) result = await repl.runLine(line);
  return result;
}

describe("문법 오류 정규화 — `_IncompleteInputError`를 3.14 표준 문구로", () => {
  // 기대값은 CPython 3.14.4 pty 실측이다. 파일명 `<python-input-0>`만 `<console>`로 바꿨다.
  test.each([
    {
      name: "`1 +`",
      lines: ["1 +"],
      expected:
        '  File "<console>", line 1\n    1 +\n       ^\nSyntaxError: invalid syntax\n',
    },
    {
      name: "`foo bar`",
      lines: ["foo bar"],
      expected:
        '  File "<console>", line 1\n    foo bar\n        ^^^\nSyntaxError: invalid syntax\n',
    },
    {
      name: "블록 안 `1 +`",
      lines: ["if True:", "    1 +"],
      expected:
        '  File "<console>", line 2\n    1 +\n       ^\nSyntaxError: invalid syntax\n',
    },
  ])("$name → 표준 SyntaxError 문구다", async ({ lines, expected }) => {
    const { repl } = setup();

    const result = await pushAll(repl, lines);

    expect(result).toEqual({ kind: "syntax-error", formattedError: expected });
  });

  test("본문 없는 중첩 블록은 IndentationError로 끝난다", async () => {
    const { repl } = setup();

    const result = await pushAll(repl, [
      "if True:",
      "    if True:",
      "    pass",
    ]);

    expect(result).toEqual({
      kind: "syntax-error",
      formattedError:
        "  File \"<console>\", line 3\n    pass\n    ^^^^\nIndentationError: expected an indented block after 'if' statement on line 2\n",
    });
  });

  test("EOF에서 끊긴 오류가 아니면 원문 그대로다(`)`)", async () => {
    const { repl } = setup();

    const result = await repl.runLine(")");

    expect(result.kind).toBe("syntax-error");
    if (result.kind !== "syntax-error") return;
    expect(result.formattedError.endsWith("SyntaxError: unmatched ')'\n")).toBe(
      true,
    );
  });

  test("top-level await가 켜져 있어도 같은 결과다", async () => {
    const { repl } = setup(true);

    const result = await repl.runLine("1 +");

    expect(result).toEqual({
      kind: "syntax-error",
      formattedError:
        '  File "<console>", line 1\n    1 +\n       ^\nSyntaxError: invalid syntax\n',
    });
  });

  test("정규화 뒤에도 이어지는 입력은 새 블록으로 시작한다", async () => {
    const { repl } = setup();
    await repl.runLine("1 +");

    const result = await repl.runLine("2 + 2");

    expect(result).toEqual({ kind: "complete", echo: "4", exited: false });
  });
});

describe("문법 오류 future 회수", () => {
  test("문법 오류를 반복해도 GC 때 `never retrieved` 로그가 stderr로 새지 않는다", async () => {
    const { repl, sinks } = setup();

    // 문법 오류 future는 await하지 않는다.
    // 예외를 회수하지 않으면 순환 참조가 사이클 GC에 수거될 때 asyncio가
    // `ConsoleFuture exception was never retrieved`를 sys.stderr로 낸다.
    // 이 로그는 destroy 직후가 아니라 나중에 나온다.
    for (let i = 0; i < 10; i++) await repl.runLine(`x = = ${i}`);
    for (let pass = 0; pass < 4; pass++) {
      pyodide.runPython("import gc; gc.collect()");
    }

    const leaked = sinks.writeErrorRaw.mock.calls
      .map(([text]) => text)
      .join("");
    expect(leaked).not.toContain("never retrieved");
    expect(leaked).toBe("");
  });
});

describe("`pending()`·`clearPending()`", () => {
  test("새 콘솔은 pending이 없다", () => {
    const { repl } = setup();

    expect(repl.pending()).toBeUndefined();
  });

  test("블록 입력 중에는 buffer의 줄을 개행으로 이은 텍스트를 돌려준다", async () => {
    const { repl } = setup();

    await repl.runLine("if True:");
    expect(repl.pending()).toBe("if True:");
    await repl.runLine("    x = 1");
    expect(repl.pending()).toBe("if True:\n    x = 1");
  });

  test("빈 줄로 블록이 실행되면 pending이 사라진다", async () => {
    const { repl } = setup();
    await repl.runLine("if True:");
    await repl.runLine("    x = 1");

    await repl.runLine("");

    expect(repl.pending()).toBeUndefined();
  });

  test("`clearPending()`은 미완성 블록을 버려 다음 줄이 새로 시작한다", async () => {
    const { repl } = setup();
    await repl.runLine("if True:");

    repl.clearPending();

    expect(repl.pending()).toBeUndefined();
    // 버리지 않았다면 `if True:\nprint(1)`이 IndentationError가 된다.
    const result = await repl.runLine("print(1)");
    expect(result).toEqual({ kind: "complete", echo: null, exited: false });
  });

  test("블록이 없을 때 `clearPending()`을 불러도 던지지 않는다", () => {
    const { repl } = setup();

    expect(() => repl.clearPending()).not.toThrow();
  });
});
