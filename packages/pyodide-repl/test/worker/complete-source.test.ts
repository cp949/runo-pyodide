// @vitest-environment node
/**
 * worker Tab 완성 헬퍼(`loadCompleteSource`, RD-015, 01-protocols.md 1.2) 시험. 실제 pyodide(node) +
 * `pyodide.console.PyodideConsole`로 `complete-source.py`의 후처리(정렬·내부 이름 제외·예외 삼킴·경고 억제)와
 * `KeyboardInterrupt` 전파, 코드포인트 `start`를 확인한다(`console.test.ts`·`multiline.test.ts` 패턴).
 */
import { loadPyodide, type PyodideInterface } from "pyodide";
import type { PyProxy } from "pyodide/ffi";
import { beforeAll, describe, expect, test } from "vitest";
import {
  createConsole,
  type PyodideConsoleProxy,
} from "../../src/worker/console";
import {
  loadCompleteSource,
  type CompleteSource,
} from "../../src/worker/complete-source";
import {
  CORPUS,
  FALSE_POSITIVE_LINES,
  GATE_FALSE_LINES,
  NON_NONE_LINES,
  NUMERIC_LITERAL_LINES,
} from "../terminal/import-gate-corpus";
import {
  mentionsImportKeyword,
  resolveCompletion,
} from "../../src/terminal/tab-completion";

let pyodide: PyodideInterface;
let pyconsole: PyodideConsoleProxy;
let completer: CompleteSource;

beforeAll(async () => {
  pyodide = await loadPyodide();
  const repl = createConsole(
    pyodide,
    { write: () => {}, writeErrorRaw: () => {} },
    { topLevelAwait: false },
  );
  pyconsole = repl.pyconsole;
  completer = loadCompleteSource(pyodide, pyconsole);
}, 60_000);

describe("loadCompleteSource: 후처리", () => {
  test("`os.pa`는 정렬된 `os.*` 후보를 돌려주고 `start`는 마지막 단어 구분자 다음 위치다", () => {
    pyodide.runPython("import os");

    const result = completer("os.pa", undefined);

    // rlcompleter의 attr_matches는 이미 정렬해 돌려주지만, complete_source의 sorted()가 불변식을 지킨다(전역
    // 매칭은 정렬돼 있지 않다는 것을 아래 "내부 이름 제외" 시험이 보인다). 완성 문자열은 dotted 전체 이름이다.
    expect(result.completions).toEqual([
      "os.pardir",
      "os.path",
      "os.pathconf(",
      "os.pathconf_names",
      "os.pathsep",
    ]);
    // "os.pa" 앞에 단어 구분자(공백·세미콜론 등)가 없으므로 start는 0이다(rlcompleter docstring 예시와 동치).
    expect(result.start).toBe(0);
  });

  test("`pending`이 `import`/`from` 블록이 아니면 이름 완성 결과가 그대로다", () => {
    pyodide.runPython("import os");

    const withPending = completer("os.pa", "if True:");
    const withoutPending = completer("os.pa", undefined);

    // 모듈 판정이 `None`이라 pending은 이름 완성 경로에 영향을 주지 않는다(start도 source 꼬리로만 정해진다).
    expect(withPending).toEqual(withoutPending);
  });

  test("`_pyodide`·`___`로 시작하는 이름은 후보에서 뺀다", () => {
    pyodide.runPython("import _pyodide");
    pyodide.runPython("___x = 1");

    // 전역 매칭(`.`이 없는 소스)은 rlcompleter가 정렬하지 않는다 — 내부 이름 필터가 없으면 "_pyodide"·
    // "_pyodide_core"가 섞여 나온다. 필터가 전부 걸러내 빈 결과가 되는 것으로 확인한다.
    expect(completer("_py", undefined)).toEqual({ completions: [], start: 0 });
    const dunder = completer("__", undefined);
    expect(dunder.completions).not.toContain("___x");
  });

  test("예외를 던지는 `__dir__`은 빈 결과다", () => {
    pyodide.runPython(`
class _BrokenDir:
    def __dir__(self):
        raise RuntimeError("boom")
_broken_dir_obj = _BrokenDir()
`);

    const result = completer("_broken_dir_obj.", undefined);

    expect(result).toEqual({ completions: [], start: 0 });
  });

  test("`DeprecationWarning`을 내는 속성 접근에서 stderr에 경고가 새지 않는다", () => {
    // `@property`는 쓰지 않는다 — bpo-44752 이후 attr_matches는 property 후보를 getattr 없이 그대로 추가해서
    // getter(따라서 경고)가 애초에 불리지 않는다(공허 통과 원인, 리뷰 지적). `__dir__`이 후보를 직접 내놓고
    // `__getattr__`이 실제로 getattr되어 경고를 내는 조합으로 바꿨다(KeyboardInterrupt 시험과 같은 패턴).
    pyodide.runPython(`
import warnings
class _Deprecated:
    def __dir__(self):
        return ["dep"]
    def __getattr__(self, name):
        warnings.warn("deprecated", DeprecationWarning)
        return 1
_deprecated_obj = _Deprecated()
`);
    const stderr: string[] = [];
    pyodide.setStderr({ batched: (text) => stderr.push(text) });

    const result = completer("_deprecated_obj.dep", undefined);

    expect(result.completions).toContain("_deprecated_obj.dep");
    expect(stderr.join("")).toBe("");
    pyodide.setStderr();
  });

  test("전역 이름 매칭은 정렬되지 않은 순서로 오고, `sorted()`가 사전순으로 고정한다", () => {
    // global_matches(dotted 아닌 소스)는 namespace dict의 삽입 순서를 그대로 따른다(attr_matches와 달리 자체
    // 정렬이 없다) — 실측: `zz_b = 1; zz_a = 1` 뒤 raw global_matches는 ["zz_b", "zz_a"](삽입 순서),
    // complete_source의 sorted()가 없으면 이 순서가 그대로 새 나간다. builtin과 이름이 안 겹치는 접두사를 썼다
    // (`z` 하나만 쓰면 builtin `zip`이 섞여 나온다).
    pyodide.runPython(`
zz_b = 1
zz_a = 1
`);

    const result = completer("zz_", undefined);

    expect(result.completions).toEqual(["zz_a", "zz_b"]);
  });

  test("`start`는 코드포인트 인덱스다(서로게이트 쌍인 이모지도 1로 센다)", () => {
    pyodide.runPython(`
class _A:
    attr_one = 1
_a = _A()
`);

    const result = completer('x = "😀" ; _a.at', undefined);

    // JS(UTF-16)로는 "_a"가 12번째 코드 유닛에서 시작하지만(이모지가 서로게이트 쌍 2유닛), Python 코드포인트로는
    // 이모지가 1글자라 10번째다.
    expect(result).toEqual({ completions: ["_a.attr_one"], start: 10 });
  });

  test("`KeyboardInterrupt`는 삼키지 않고 전파된다(변이 `except BaseException`이면 이 시험이 실패한다)", () => {
    pyodide.runPython(`
class _C:
    def __dir__(self):
        return ["x"]
    def __getattr__(self, name):
        raise KeyboardInterrupt()
_c = _C()
`);

    expect(() => completer("_c.x", undefined)).toThrowError(
      /KeyboardInterrupt/,
    );
  });
});

/**
 * 번들 pyodide의 원본 `ModuleCompleter().get_completions(line)`. 판정이 없으면(`None`) `null`이다. 호출마다 새 인스턴스를 만든다.
 * REPL 전역을 오염시키지 않도록 별도 이름공간에서 정의한다. 원본은 `complete-source.py`가 쓰는 서브클래스가 아니라 zip 보정 전 클래스다.
 */
function rawModuleComplete(line: string): string[] | null {
  const namespace = pyodide.toPy({}) as PyProxy & {
    get(name: string): unknown;
  };
  try {
    pyodide.runPython(
      `
from _pyrepl._module_completer import ModuleCompleter

def probe(line):
    return ModuleCompleter().get_completions(line)
`,
      { globals: namespace },
    );
    const probe = namespace.get("probe") as ((
      line: string,
    ) => PyProxy | undefined) &
      PyProxy;
    const result = probe(line);
    probe.destroy();
    if (result === undefined) return null;
    try {
      return result.toJs() as string[];
    } finally {
      result.destroy();
    }
  } finally {
    namespace.destroy();
  }
}

describe("게이트 안전성: 게이트가 거짓인 줄은 원본 ModuleCompleter가 None이다(TRAP-33)", () => {
  // 게이트가 거짓이면 main이 worker에 묻지 않고 공백을 넣는다. 그 줄이 `None`이 아니면 3.14와 결과가 갈린다. 코퍼스 분류 사실은
  // `mentionsImportKeyword` 없이도 확인할 수 있어 먼저 단정하고(사실 확인), 게이트 함수에 직접 거는 시험을 뒤에 둔다.
  test("코퍼스는 55줄이고 겹치는 줄이 없다", () => {
    expect(CORPUS).toHaveLength(55);
    expect(new Set(CORPUS).size).toBe(55);
  });

  test.each(GATE_FALSE_LINES)(
    "게이트 거짓 그룹 %j은 ModuleCompleter가 None이다",
    (line) => {
      expect(rawModuleComplete(line)).toBeNull();
    },
  );

  test.each(FALSE_POSITIVE_LINES)(
    "오탐 그룹 %j은 ModuleCompleter가 None이다",
    (line) => {
      expect(rawModuleComplete(line)).toBeNull();
    },
  );

  test.each(NON_NONE_LINES)(
    "비None 그룹 %j은 ModuleCompleter가 None이 아니다",
    (line) => {
      expect(rawModuleComplete(line)).not.toBeNull();
    },
  );

  test.each(NUMERIC_LITERAL_LINES)(
    "숫자 리터럴 %j은 단어 경계 게이트가 거짓이어도 ModuleCompleter가 후보를 낸다(None이 아니다)",
    (line) => {
      expect(/\b(import|from)\b/.test(line)).toBe(false);
      expect(rawModuleComplete(line)).not.toBeNull();
    },
  );

  test("코퍼스에서 mentionsImportKeyword가 거짓인 줄은 전부 ModuleCompleter가 None이다", () => {
    const gateFalse = CORPUS.filter((line) => !mentionsImportKeyword(line));

    // 대상이 비면 공허 통과다. 게이트 거짓 그룹 16줄이 전부 남아야 한다.
    expect(gateFalse.length).toBeGreaterThanOrEqual(GATE_FALSE_LINES.length);
    for (const line of gateFalse) {
      expect(rawModuleComplete(line), JSON.stringify(line)).toBeNull();
    }
  });
});

describe("zip stdlib 보정 사전 조건(TRAP-10)", () => {
  // 보정(서브클래스의 `_is_stdlib_module` 오버라이드)은 원본의 사설 이름에 기댄다. 번들 `get_completions`는 `except Exception`으로
  // `AttributeError`를 삼켜 `[]`를 돌려주므로, 이름이 바뀌어도 보정 시험만 실패하고 원인을 말하지 않는다. 이름을 먼저 따로 단정한다.
  test("보정이 기대는 사설 이름 `_stdlib_path`(str)·`_is_stdlib_module`이 원본에 있다", () => {
    const namespace = pyodide.toPy({}) as PyProxy;
    try {
      pyodide.runPython(
        "from _pyrepl._module_completer import ModuleCompleter\ncompleter = ModuleCompleter()",
        { globals: namespace },
      );

      expect(
        pyodide.runPython("isinstance(completer._stdlib_path, str)", {
          globals: namespace,
        }),
      ).toBe(true);
      expect(
        pyodide.runPython("completer._stdlib_path", { globals: namespace }),
      ).toBe("/lib/python314.zip");
      expect(
        pyodide.runPython("hasattr(completer, '_is_stdlib_module')", {
          globals: namespace,
        }),
      ).toBe(true);
    } finally {
      namespace.destroy();
    }
  });

  // pyodide stdlib는 zip(zipimporter)이라 원본이 `HARDCODED_SUBMODULES`(`collections.abc` 등)를 놓치고 `[]`를 낸다. 네이티브 3.14는 후보를 낸다.
  // 번들이 고치면 이 단정이 실패해 서브클래스 오버라이드를 걷어낼 때를 알려 준다.
  test.each([
    "import collections.a", // 측정 B009(A09)
    "from collections import a", // 측정 B010(A10)
    "from xml.parsers.expat import ",
    "import xml.parsers.expat.",
  ])("원본 ModuleCompleter는 %j에 []를 낸다(zip 보정 대상)", (line) => {
    expect(rawModuleComplete(line)).toEqual([]);
  });
});

/** `source` 끝에서 Tab을 한 번 눌렀을 때 3.14처럼 커서에 삽입되는 텍스트. 삽입할 것이 없으면 null이다. */
function insertedText(source: string, pending?: string): string | null {
  const { completions, start } = completer(source, pending);
  const action = resolveCompletion({
    buf: source,
    pos: source.length,
    second: false,
    completions,
    start,
  });
  return action.kind === "insert" ? action.text : null;
}

/** 후처리 전 `console.complete`가 낸 후보. 모듈 분기가 없으면 어떤 잘못된 후보가 나오는지 확인하는 사전 조건에 쓴다. */
function rawConsoleComplete(source: string): string[] {
  const result = (
    pyconsole as unknown as { complete(text: string): PyProxy }
  ).complete(source);
  try {
    return (result.toJs() as [string[], number])[0];
  } finally {
    result.destroy();
  }
}

/**
 * `ModuleCompleter.get_completions`를 `body`(Python 람다 식)로 잠시 바꿔 `run`을 실행한다. `ZipStdlibModuleCompleter`는
 * `get_completions`를 오버라이드하지 않아 기반 클래스의 교체가 그대로 적용된다. 끝나면 원복한다.
 */
function withModuleCompleterStub<T>(lambdaSource: string, run: () => T): T {
  const namespace = pyodide.toPy({}) as PyProxy;
  try {
    pyodide.runPython(
      "from _pyrepl._module_completer import ModuleCompleter\noriginal = ModuleCompleter.get_completions",
      { globals: namespace },
    );
    try {
      pyodide.runPython(`ModuleCompleter.get_completions = ${lambdaSource}`, {
        globals: namespace,
      });
      return run();
    } finally {
      pyodide.runPython("ModuleCompleter.get_completions = original", {
        globals: namespace,
      });
    }
  } finally {
    namespace.destroy();
  }
}

describe("loadCompleteSource: import·from 모듈 완성", () => {
  test("`import os.pa`는 `os.path`로 완성한다", () => {
    // 원본 이름 완성은 os 전역의 속성을 나열해 모듈이 아닌 os.pardir가 섞인다.
    pyodide.runPython("import os");
    expect(rawConsoleComplete("import os.pa")).toContain("os.pardir");

    // 측정 A01
    expect(completer("import os.pa", undefined)).toEqual({
      completions: ["os.path"],
      start: 7,
    });
    expect(insertedText("import os.pa")).toBe("th");
  });

  test("`from os import pa`는 `path`로 완성한다", () => {
    // 원본 이름 완성은 키워드 pass로 새 나간다.
    expect(rawConsoleComplete("from os import pa")).toEqual(["pass"]);

    // 측정 A02
    expect(completer("from os import pa", undefined)).toEqual({
      completions: ["path"],
      start: 15,
    });
    expect(insertedText("from os import pa")).toBe("th");
  });

  test.each(["import ", "from "])(
    "빈 스템 %j은 ModuleCompleter 순서 그대로 후보를 내고 start는 source 길이다",
    (source) => {
      const raw = rawModuleComplete(source);
      expect(raw).not.toBeNull();

      const { completions, start } = completer(source, undefined);

      // 후보는 cwd의 .py·패키지와 환경에 의존하므로 개수·전체 목록은 단정하지 않는다(TRAP-27). 원본과의 관계만 본다.
      expect(completions.length).toBeGreaterThan(0);
      expect(completions).toEqual(
        (raw ?? []).filter((c) => !/^(_pyodide|___)/.test(c)),
      );
      expect(start).toBe(source.length);
    },
  );

  test("내부 이름(`_pyodide*`)은 모듈 후보에서도 숨긴다", () => {
    // 원본 ModuleCompleter는 밑줄 접두사를 주면 pyodide 내부 모듈을 낸다.
    expect(rawModuleComplete("import _pyo")).toContain("_pyodide");

    // 걸러내고 남은 것이 없으면 판정이 있어도 결과는 `([], 0)`이다(이름 완성으로 폴백하지 않는다).
    expect(completer("import _pyo", undefined)).toEqual({
      completions: [],
      start: 0,
    });
  });

  test("ModuleCompleter가 낸 순서를 정렬하지 않고 내부 이름만 거른다", () => {
    // 실제 후보는 이미 정렬돼 있어 정렬 여부를 볼 수 없다. 오름차순도 내림차순도 아닌 목록을 돌려주도록 기반 클래스를 잠시 바꾼다
    // (내림차순 입력이면 `sorted(..., reverse=True)` 변이가 통과한다).
    const result = withModuleCompleterStub(
      "lambda self, line: ['m', 'a', 'z', '_pyodide_x']",
      () => completer("import ", undefined),
    );

    expect(result).toEqual({ completions: ["m", "a", "z"], start: 7 });
  });

  test("서로게이트 쌍이 스템 앞에 있어도 start는 코드포인트 인덱스다", () => {
    const source = 'x = "😀"; import os.pa';

    // 이모지는 JS 인덱스로 2칸이라 스템 `os.pa` 앞의 `import ` 끝이 JS는 17, Python은 16이다.
    expect(source.indexOf("os.pa")).toBe(17);
    expect(completer(source, undefined)).toEqual({
      completions: ["os.path"],
      start: 16,
    });
    expect(insertedText(source)).toBe("th");
  });

  test("호출마다 새 인스턴스를 만들어 그 사이 생긴 패키지도 후보에 넣는다", () => {
    const sitePackages = pyodide.runPython(
      "import sys; next(p for p in sys.path if p.endswith('site-packages'))",
    ) as string;
    const packageDir = `${sitePackages}/zz_fake_pkg`;
    // 첫 호출로 인스턴스가 만들어지고(변이: 모듈 전역 1개로 캐시) 이후 생긴 패키지를 못 본다.
    expect(completer("import zz_fa", undefined).completions).toEqual([]);

    try {
      pyodide.FS.mkdirTree(packageDir);
      pyodide.FS.writeFile(`${packageDir}/__init__.py`, "");

      expect(completer("import zz_fa", undefined).completions).toEqual([
        "zz_fake_pkg",
      ]);
    } finally {
      pyodide.FS.unlink(`${packageDir}/__init__.py`);
      pyodide.FS.rmdir(packageDir);
    }
  });
});

describe("loadCompleteSource: pyodide zip stdlib 보정", () => {
  // 원본은 zip stdlib 패키지의 HARDCODED_SUBMODULES를 놓치고 []를 낸다(사전 조건은 "zip stdlib 보정 사전 조건" 절). 서브클래스가 채운다.
  test.each([
    ["import collections.a", ["collections.abc"], 7, "bc"], // 측정 A09
    ["from collections import a", ["abc"], 24, "bc"], // 측정 A10
    ["from xml.parsers.expat import ", ["errors", "model"], 30, null], // 후보가 둘이고 공통 접두사가 스템뿐이라 삽입할 것이 없다
    [
      "import xml.parsers.expat.",
      ["xml.parsers.expat.errors", "xml.parsers.expat.model"],
      7,
      null,
    ],
  ])(
    "%j은 3.14처럼 HARDCODED_SUBMODULES 후보를 낸다",
    (source, 후보, start, 삽입) => {
      // 사전 조건: 원본은 []다. 번들이 고치면 이 단정이 실패해 서브클래스를 걷어낼 때를 알려 준다.
      expect(rawModuleComplete(source)).toEqual([]);

      expect(completer(source, undefined)).toEqual({
        completions: 후보,
        start,
      });
      expect(insertedText(source)).toBe(삽입);
    },
  );

  // 보정은 stdlib 판정만 바꾼다. 원본과 같던 줄은 보정 뒤에도 원본 ModuleCompleter와 같은 후보를 내야 한다.
  test.each([
    "import os.pa",
    "from os import p",
    "from os import ",
    "import xml.dom.m",
    "from xml.dom import m",
    "import importlib.m",
    "from email import ",
    "import concurrent.f",
    "import os.path.",
    "import sys.",
  ])("%j은 보정 전(원본 ModuleCompleter)과 같은 후보를 낸다", (source) => {
    const raw = rawModuleComplete(source);
    expect(raw).not.toBeNull();

    expect(completer(source, undefined).completions).toEqual(
      (raw ?? []).filter((c) => !/^(_pyodide|___)/.test(c)),
    );
  });
});

describe("loadCompleteSource: 모듈 완성이 []이면 무동작", () => {
  test.each([
    "import zzzz",
    "import os.zzz",
    "from . import x",
    "from .a",
    "from .. import ",
    "from math import s",
  ])("%j은 후보 없음이고 이름 완성으로 폴백하지 않는다", (source) => {
    // 측정 A14~A16·A18·A20: 네이티브·pyodide 모두 []
    expect(rawModuleComplete(source)).toEqual([]);

    expect(completer(source, undefined)).toEqual({ completions: [], start: 0 });
  });

  test("폴백하면 틀린 후보를 내는 입력이다", () => {
    expect(rawConsoleComplete("from math import s")).toContain("sorted(");
    expect(rawConsoleComplete("from .. import ").length).toBeGreaterThan(100);
  });
});

describe("loadCompleteSource: 모듈 완성이 판정하지 않는 입력(None) 폴백", () => {
  test.each([
    ["import os ", 2], // 측정 A22
    ["import os.path ", 1], // 측정 A23
    ["from os import path ", 4], // 측정 A24
    ["import os as ", 3],
    ["important = ", 4], // 게이트가 참이어도(부분 문자열 `import`) 파서는 None이다
    ["x = 1 ", 2], // 대조군: import가 없는 줄도 같은 규칙이다
  ])(
    "%j은 스템이 비어 있어 공백 %i칸 하나를 후보로 내고 start는 source 길이다",
    (source, 칸수) => {
      // 원본 이름 완성은 빈 스템에서 전체 이름을 돌려준다(공백 분기가 없으면 이 목록이 새 나간다).
      expect(rawConsoleComplete(source).length).toBeGreaterThan(1);
      expect(rawModuleComplete(source)).toBeNull();

      expect(completer(source, undefined)).toEqual({
        completions: [" ".repeat(칸수)],
        start: source.length,
      });
    },
  );

  test("`import os; os.pa`는 스템이 있어 속성 완성 경로로 처리한다", () => {
    // 측정 A25: 후보 개수·목록은 플랫폼에 의존한다. 구조만 단정한다.
    pyodide.runPython("import os");
    expect(rawModuleComplete("import os; os.pa")).toBeNull();

    const { completions, start } = completer("import os; os.pa", undefined);

    expect(start).toBe(11);
    expect(completions).toContain("os.path");
    expect(completions.every((c) => c.startsWith("os.pa"))).toBe(true);
  });

  // 열은 현재 줄 안 위치다. `\t`는 1로, 서로게이트 쌍은 코드포인트 1로 센다. source 전체 길이로 세면 여러 줄에서 어긋난다.
  test.each<[string, string | undefined, number, number]>([
    ["", undefined, 4, 0],
    ["x = 1\n", undefined, 4, 6],
    ["x = 1\n  ", undefined, 2, 8],
    ["\t", undefined, 3, 1],
    ["😀 ", undefined, 2, 2],
    ["    ", "for i in range(3):", 4, 4], // 블록 이전 줄이 import가 아니면 None이고 pending은 열에 영향이 없다
  ])(
    "%j (pending %j)은 공백 %i칸 하나를 후보로 낸다",
    (source, pending, 칸수, start) => {
      expect(completer(source, pending)).toEqual({
        completions: [" ".repeat(칸수)],
        start,
      });
    },
  );

  test("pending이 있어도 스템이 비어 있지 않으면 이름 완성 경로다", () => {
    const { completions, start } = completer("    p", "for i in range(3):");

    expect(start).toBe(4);
    expect(completions).toContain("print(");
    expect(completions.every((c) => c.startsWith("p"))).toBe(true);
  });
});

describe("loadCompleteSource: 여러 문장·여러 줄의 모듈 완성", () => {
  test.each([
    ["x = 1; import o", 14], // 측정 A29
    ["x = 1\nimport o", 13], // 측정 A30
    ["if True:\n    import o", 20], // 측정 A31
  ])(
    "%j은 마지막 import 문의 모듈 후보를 내고 start는 %i이다",
    (source, start) => {
      expect(rawConsoleComplete(source)).toContain("open(");

      const result = completer(source, undefined);

      expect(result.start).toBe(start);
      expect(result.completions).toContain("os");
      expect(result.completions.every((c) => c.startsWith("o"))).toBe(true);
      // 이름 완성으로 새면 `open(` 같은 builtins가 섞인다. 모듈 이름은 식별자뿐이다.
      expect(result.completions).not.toContain("open(");
      expect(result.completions.filter((c) => !/^\w+$/.test(c))).toEqual([]);
    },
  );
});

describe("loadCompleteSource: 블록 이전 줄(pending)", () => {
  test("pending이 없으면 이름 완성으로 새고 있으면 모듈 이름으로 완성한다", () => {
    expect(completer("    p", undefined).completions).toContain("pass");

    expect(completer("    p", "from os import (")).toEqual({
      completions: ["path"],
      start: 4,
    });
  });

  test("`pending`이 `if True:`이면 `    import os.pa`를 `os.path`로 완성한다", () => {
    expect(completer("    import os.pa", "if True:")).toEqual({
      completions: ["os.path"],
      start: 11,
    });
  });

  test.each(["from os import (", "from os import (\n    path,"])(
    "pending %j는 start에 영향을 주지 않는다",
    (pending) => {
      // start는 source의 스템 꼬리로만 정해진다: 4칸 들여쓴 p는 4다.
      expect(completer("    p", pending).start).toBe(4);
    },
  );

  test("pending 뒤 빈 스템은 공백이 아니라 모듈 후보를 낸다", () => {
    // 측정 A33: 3.14는 `... ` 줄의 빈 스템에서 모듈 판정이 공백 후보보다 먼저다.
    expect(completer("    ", "from os import (\n    path,")).toEqual({
      completions: ["path"],
      start: 4,
    });
  });
});

describe("loadCompleteSource: 3.14 스템 어긋남 동등 재현", () => {
  // 스템은 구분자 기준이고 모듈 파싱은 토큰 기준이라 어긋나면 3.14가 이상한 삽입을 한다. 삽입 규칙(후보[len(스템):])이 같아 pyodide도 같은 결과를 낸다.
  test.each([
    // 편차 23(X01): 3.14 화면 `import os.pa  # cs.path`. 주석 안의 c가 스템이다.
    ["import os.pa  # c", ["os.path"], 16, "s.path", "import os.pa  # cs.path"],
    // X02: 3.14는 둘째 줄에 os.path를 넣는다. 빈 줄이 스템이다.
    ["import os.pa\n", ["os.path"], 13, "os.path", "import os.pa\nos.path"],
    // X04: 3.14 화면 `from os import path,path`. 콤마 뒤 빈 스템이다.
    ["from os import path,", ["path"], 20, "path", "from os import path,path"],
    // A37: 3.14는 둘째 줄에 os를 넣는다.
    ["import os  # c\n", ["os"], 15, "os", "import os  # c\nos"],
  ])("%j은 3.14처럼 어긋난 삽입을 한다", (source, 후보, start, 삽입, 결과) => {
    expect(completer(source, undefined)).toEqual({ completions: 후보, start });
    expect(insertedText(source)).toBe(삽입);
    expect(source + 삽입).toBe(결과);
  });
});

describe("loadCompleteSource: 모듈 분기의 예외 처리", () => {
  test("모듈 분기 안 `KeyboardInterrupt`는 삼키지 않고 전파된다", () => {
    withModuleCompleterStub(
      "lambda self, line: (_ for _ in ()).throw(KeyboardInterrupt())",
      () => {
        expect(() => completer("import os.pa", undefined)).toThrowError(
          /KeyboardInterrupt/,
        );
      },
    );
  });

  test("모듈 분기 안 일반 예외는 삼키고 빈 결과를 낸다", () => {
    const result = withModuleCompleterStub(
      "lambda self, line: (_ for _ in ()).throw(RuntimeError('boom'))",
      () => completer("import os.pa", undefined),
    );

    expect(result).toEqual({ completions: [], start: 0 });
  });
});

describe("loadCompleteSource: `_pyrepl` 모듈 완성기 import 실패(TRAP-10)", () => {
  test("`_pyrepl._module_completer`를 가져올 수 없으면 loadCompleteSource가 던진다", () => {
    // 모듈 객체를 잠시 sys.modules에서 가려 `import`가 ModuleNotFoundError를 내게 한다(`None` 항목은 가져오기 금지 표시다).
    // 별도 이름공간에 저장해 REPL 전역을 오염시키지 않는다.
    const namespace = pyodide.toPy({}) as PyProxy;
    pyodide.runPython(
      `
import sys
import importlib
name = '_pyrepl._module_completer'
saved = importlib.import_module(name)
sys.modules[name] = None
`,
      { globals: namespace },
    );
    try {
      expect(() => loadCompleteSource(pyodide, pyconsole)).toThrowError(
        /ModuleNotFoundError|ImportError/,
      );
    } finally {
      pyodide.runPython("sys.modules[name] = saved", { globals: namespace });
      namespace.destroy();
    }

    // 원복 확인: 다시 로드되고 모듈 분기가 동작한다.
    expect(
      loadCompleteSource(pyodide, pyconsole)("import os.pa", undefined),
    ).toEqual({ completions: ["os.path"], start: 7 });
  });
});
