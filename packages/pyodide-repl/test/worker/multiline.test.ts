// @vitest-environment node
/**
 * 분할기(`split_paste`, 02-console-core.md 5.2) 시험. Python `ast`에 의존하므로 mock 없이 실제
 * pyodide를 로드해 검증한다. 이전 구현(`/work/cp949/pyodide-samples/apps/repl/src/repl/multiline.test.ts`)의
 * 21건을 이식하고 2차 `compile`·top-level await 관련 3건을 더했다.
 */
import { loadPyodide, type PyodideInterface } from "pyodide";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createConsole } from "../../src/worker/console";
import { loadSplitPaste, type SplitPaste } from "../../src/worker/multiline";

let pyodide: PyodideInterface;
let splitPaste: SplitPaste;
let flagsOff: number;
let flagsOn: number;

beforeAll(async () => {
  pyodide = await loadPyodide();
  splitPaste = loadSplitPaste(pyodide);
  const sinks = { write: vi.fn(), writeErrorRaw: vi.fn() };
  flagsOff = createConsole(pyodide, sinks, {
    topLevelAwait: false,
  }).compilerFlags();
  flagsOn = createConsole(pyodide, sinks, {
    topLevelAwait: true,
  }).compilerFlags();
}, 60_000);

describe("split_paste: 문장 단위 분할", () => {
  it("함수 정의와 호출을 서로 다른 chunk로 나누고 빈 줄은 제거한다", () => {
    const [error, chunks] = splitPaste(
      "def add(a, b):\n    return a + b\n\nprint(add(1, 2))",
      flagsOff,
    );

    expect(error).toBeUndefined();
    expect(chunks).toEqual([
      ["def add(a, b):", "    return a + b"],
      ["print(add(1, 2))"],
    ]);
  });

  it("클래스 메서드 사이에 빈 줄이 있어도 클래스 하나를 chunk 하나로 묶는다", () => {
    const source =
      "class A:\n    def f(self): return 1\n\n    def g(self): return 2\n\nprint(A().g())";

    const [error, chunks] = splitPaste(source, flagsOff);

    expect(error).toBeUndefined();
    expect(chunks).toEqual([
      ["class A:", "    def f(self): return 1", "    def g(self): return 2"],
      ["print(A().g())"],
    ]);
  });

  it("데코레이터 줄부터 chunk를 시작한다", () => {
    const source =
      "def deco(f):\n    return f\n\n@deco\ndef foo():\n    return 1";

    const [error, chunks] = splitPaste(source, flagsOff);

    expect(error).toBeUndefined();
    expect(chunks).toEqual([
      ["def deco(f):", "    return f"],
      ["@deco", "def foo():", "    return 1"],
    ]);
  });

  it("세미콜론으로 한 줄에 이어진 문장은 chunk 하나로 묶는다", () => {
    const [error, chunks] = splitPaste("a = 1; b = 2\nprint(a + b)", flagsOff);

    expect(error).toBeUndefined();
    expect(chunks).toEqual([["a = 1; b = 2"], ["print(a + b)"]]);
  });

  it("여러 줄 문자열 안의 빈 줄은 보존한다", () => {
    const [error, chunks] = splitPaste('s = """a\n\nb"""\nprint(s)', flagsOff);

    expect(error).toBeUndefined();
    expect(chunks).toEqual([['s = """a', "", 'b"""'], ["print(s)"]]);
  });

  it("여러 줄 문자열 안의 공백만 있는 줄은 공백까지 보존한다", () => {
    const [error, chunks] = splitPaste('s = """a\n   \nb"""', flagsOff);

    expect(error).toBeUndefined();
    expect(chunks).toEqual([['s = """a', "   ", 'b"""']]);
  });

  it("여러 줄 f-string 안의 빈 줄은 보존한다", () => {
    const [error, chunks] = splitPaste('n = 5\nu = f"""a\n\n{n}"""', flagsOff);

    expect(error).toBeUndefined();
    expect(chunks).toEqual([["n = 5"], ['u = f"""a', "", '{n}"""']]);
  });

  it("문자열 안의 U+2028처럼 Python이 줄바꿈으로 보지 않는 문자 때문에 줄이 어긋나지 않는다", () => {
    const [error, chunks] = splitPaste('s = "a b"\nprint(1)', flagsOff);

    expect(error).toBeUndefined();
    expect(chunks).toEqual([['s = "a b"'], ["print(1)"]]);
  });

  it("탭 들여쓰기를 그대로 보존한다", () => {
    const [error, chunks] = splitPaste(
      "def f():\n\treturn 1\nprint(f())",
      flagsOff,
    );

    expect(error).toBeUndefined();
    expect(chunks).toEqual([["def f():", "\treturn 1"], ["print(f())"]]);
  });

  it("top-level await가 든 입력도 TLA 플래그에서는 오류 없이 분할한다", () => {
    const [error, chunks] = splitPaste(
      "import asyncio\nawait asyncio.sleep(0)\nprint(1)",
      flagsOn,
    );

    expect(error).toBeUndefined();
    expect(chunks).toEqual([
      ["import asyncio"],
      ["await asyncio.sleep(0)"],
      ["print(1)"],
    ]);
  });

  it("함수 밖 return은 파싱은 통과하지만 2차 compile 오류가 되어 아무 문장도 실행하지 않는다", () => {
    const [error, chunks] = splitPaste("print(1)\nreturn 5", flagsOff);

    expect(error).toContain("'return' outside function");
    expect(chunks).toEqual([]);
  });
});

describe("split_paste: 입력 정규화", () => {
  it("CRLF와 CR 줄바꿈을 LF로 정규화한다", () => {
    const [error, chunks] = splitPaste(
      "a = 1\r\nb = 2\rprint(a + b)",
      flagsOff,
    );

    expect(error).toBeUndefined();
    expect(chunks).toEqual([["a = 1"], ["b = 2"], ["print(a + b)"]]);
  });

  it("전체가 들여쓰인 입력은 공통 들여쓰기를 제거한다", () => {
    const [error, chunks] = splitPaste(
      "    def f():\n        return 1\n    print(f())",
      flagsOff,
    );

    expect(error).toBeUndefined();
    expect(chunks).toEqual([["def f():", "    return 1"], ["print(f())"]]);
  });

  it("공백과 빈 줄만 있는 입력은 chunk도 오류도 없다", () => {
    const [error, chunks] = splitPaste("\n  \n\t\n", flagsOff);

    expect(error).toBeUndefined();
    expect(chunks).toEqual([]);
  });

  it("주석만 있는 입력은 chunk도 오류도 없다", () => {
    const [error, chunks] = splitPaste("# only\n\n# comments", flagsOff);

    expect(error).toBeUndefined();
    expect(chunks).toEqual([]);
  });
});

describe("split_paste: 부작용", () => {
  it("SyntaxWarning이 나는 코드도 분할 중에는 경고를 출력하지 않는다(실행 시점에 한 번만 나오도록)", () => {
    const stderr: string[] = [];
    pyodide.setStderr({ batched: (text) => stderr.push(text) });

    splitPaste('print("\\d")', flagsOff);

    expect(stderr).toEqual([]);
  });
});

describe("split_paste: 파싱 오류", () => {
  it("뒤쪽에 문법 오류가 있으면 오류를 반환하고 앞 문장도 chunk로 내지 않는다", () => {
    const [error, chunks] = splitPaste('print("앞")\nx = = 2', flagsOff);

    expect(error).toContain("SyntaxError");
    expect(chunks).toEqual([]);
  });

  it("오류 위치는 한 줄 입력 오류와 같은 <console> 파일 이름과 붙여넣은 텍스트 기준 줄 번호로 표시한다", () => {
    const [error] = splitPaste('print("앞")\nx = = 2', flagsOff);

    expect(error).toContain('File "<console>", line 2');
  });

  it("본문이 없는 미완성 블록은 오류로 반환한다", () => {
    const [error, chunks] = splitPaste("x = 1\nif x:", flagsOff);

    expect(error).toContain("IndentationError");
    expect(chunks).toEqual([]);
  });

  it("닫히지 않은 괄호는 오류로 반환한다", () => {
    const [error, chunks] = splitPaste("print(1)\nprint(2", flagsOff);

    expect(error).toContain("SyntaxError");
    expect(chunks).toEqual([]);
  });

  it("일부 줄만 들여쓴 입력은 IndentationError로 반환한다", () => {
    const [error, chunks] = splitPaste("x = 1\n    y = 2", flagsOff);

    expect(error).toContain("IndentationError");
    expect(chunks).toEqual([]);
  });
});

describe("split_paste: 2차 compile(top-level await)", () => {
  it("TLA가 꺼진 플래그에서는 top-level await도 2차 compile 오류다", () => {
    const [error, chunks] = splitPaste("print(1)\nawait x", flagsOff);

    expect(error).toContain("'await' outside function");
    expect(chunks).toEqual([]);
  });

  it("TLA가 켜진 플래그에서는 같은 입력이 오류 없이 두 chunk로 분할된다", () => {
    const [error, chunks] = splitPaste("print(1)\nawait x", flagsOn);

    expect(error).toBeUndefined();
    expect(chunks).toEqual([["print(1)"], ["await x"]]);
  });
});

describe("split_paste: globals 오염 없음", () => {
  it("사용자 globals에 split_paste가 남지 않는다", () => {
    expect(pyodide.globals.get("split_paste")).toBeUndefined();
  });
});
