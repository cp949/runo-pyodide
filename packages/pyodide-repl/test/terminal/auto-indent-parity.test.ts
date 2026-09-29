// @vitest-environment node
/**
 * `nextIndentation`(이식본)이 3.14 REPL과 같은 값을 내는지 대조하는 차분 시험(`docs/design/09-testing.md` 9.1).
 * 오라클은 pyodide에 든 `_pyrepl.readline`의 함수다. 기대값이 이식본이 아니라 CPython 구현에서 나온다.
 *
 * 오라클은 `maybe_accept`가 개행을 넣은 뒤 밟는 절차를 그대로 따른다.
 * 1. 직전 줄 들여쓰기 이어받기
 * 2. `last_used_indentation` 갱신
 * 3. `:` 뒤 추가분
 */
import { loadPyodide, type PyodideInterface } from "pyodide";
import { beforeAll, describe, expect, it } from "vitest";
import { nextIndentation } from "../../src/terminal/auto-indent";

/** pyodide에 올리는 오라클 Python 소스. `oracle(text, pos, last_used)`가 `(들여쓰기, last_used)`를 돌려준다. */
const ORACLE_SOURCE = `
from _pyrepl.readline import _get_first_indentation, _get_previous_line_indent, _should_auto_indent

def oracle(text, pos, last_used):
    buf = list(text)
    prevlinestart, indent = _get_previous_line_indent(buf, pos)
    buf[pos:pos] = ["\\n"]
    pos += 1
    kept = ""
    if indent:
        kept = "".join(buf[prevlinestart:prevlinestart + indent])
        buf[pos:pos] = list(kept)
        pos += len(kept)
    first = _get_first_indentation(buf)
    if first is not None:
        last_used = first
    extra = ""
    if _should_auto_indent(buf, pos):
        extra = last_used if last_used is not None else " " * 4
    return kept + extra, last_used
`;

/** 오라클 호출 시그니처. `nextIndentation`의 입력·반환과 같은 모양이다. */
type Oracle = (
  text: string,
  pos: number,
  lastUsed: string | null,
) => [string, string | null];

/** `beforeAll`이 pyodide에서 꺼내 채우는 오라클 함수. */
let oracle: Oracle;

beforeAll(async () => {
  const pyodide: PyodideInterface = await loadPyodide();
  const namespace = pyodide.globals.get("dict")();
  pyodide.runPython(ORACLE_SOURCE, { globals: namespace });
  const oraclePy = namespace.get("oracle");
  namespace.destroy();
  oracle = (text, pos, lastUsed) => {
    // JS null은 Python None이 아니라 jsnull이 되므로 undefined로 넘긴다.
    const result = oraclePy(text, pos, lastUsed ?? undefined);
    const [indentation, lastUsedIndentation] = result.toJs() as [
      string,
      string | undefined,
    ];
    result.destroy();
    return [indentation, lastUsedIndentation ?? null];
  };
}, 60_000);

/** 차분 대조 케이스 하나. */
interface Case {
  /** 시험 제목. */
  name: string;

  buffer: string;

  /** 커서 위치. 생략하면 버퍼 끝이다. */
  pos?: number;

  lastUsed?: string | null;
}

/** 차분 대조 케이스 29건. 오라클과 `nextIndentation`이 같은 값을 내야 한다. */
const CASES: Case[] = [
  { name: "`:`로 끝나는 헤더", buffer: "for i in range(2):" },
  { name: "본문 줄 뒤", buffer: "for i in range(2):\n    print(i)" },
  { name: "들여쓰기 없는 일반 줄", buffer: "x = 1" },
  { name: "빈 버퍼", buffer: "" },
  {
    name: "첫 들여쓰기가 8칸인 중첩 헤더",
    buffer: "if True:\n        if True:",
  },
  { name: "2칸 들여쓴 본문", buffer: "if True:\n  x=1" },
  { name: "본문 없이 공백뿐인 줄", buffer: "if True:\n    " },
  { name: "공백뿐인 줄이 여러 개", buffer: "if True:\n    \n    " },
  { name: "`:` 뒤 줄 끝 주석", buffer: "if x:  # 조건" },
  { name: "주석 안에 콜론이 있는 헤더", buffer: "while True:  # 반복:" },
  { name: "주석뿐인 줄", buffer: "# 참고:" },
  { name: "문자열 안의 `#`", buffer: 'if s == "#":' },
  { name: "탭으로 들여쓴 본문", buffer: "if x:\n\tpass" },
  { name: "탭으로 들여쓴 중첩 헤더", buffer: "def f():\n\tif x:" },
  { name: "앞 줄보다 깊이 들여쓴 줄", buffer: "if x:\n    a\n        b" },
  { name: "닫히지 않은 대괄호", buffer: "x = [" },
  { name: "괄호 안 이어 쓴 줄", buffer: "foo(a,\n    b," },
  { name: "메서드 헤더", buffer: "class A:\n    def f(self):" },
  {
    name: "한 줄 메서드 뒤의 메서드 헤더",
    buffer: "class A:\n    def f(self): return 1\n    def g(self):",
  },
  { name: "`:`로 끝나는 딕셔너리 리터럴", buffer: 'd = {"a":' },
  { name: "개행으로 끝나는 버퍼", buffer: "if x:\n    a\n" },
  { name: "들여쓴 헤더가 첫 줄", buffer: "    if x:" },
  { name: "커서가 `:` 바로 뒤(뒤에 글자)", buffer: "if x:pass", pos: 5 },
  { name: "커서 뒤가 공백으로 시작", buffer: "if x: pass", pos: 5 },
  { name: "커서가 앞 줄 끝", buffer: "a = 1\nb = 2", pos: 5 },
  { name: "커서가 들여쓴 줄 중간", buffer: "if x:\n    ab", pos: 11 },
  { name: "이전 블록의 들여쓰기가 탭", buffer: "if True:", lastUsed: "\t" },
  {
    name: "이전 블록의 들여쓰기가 8칸",
    buffer: "if True:",
    lastUsed: "        ",
  },
  {
    name: "헤더가 아닌 줄은 이전 들여쓰기를 쓰지 않는다",
    buffer: "x = 1",
    lastUsed: "  ",
  },
];

describe("nextIndentation: pyodide _pyrepl.readline과 차분", () => {
  for (const { name, buffer, pos = buffer.length, lastUsed = null } of CASES) {
    it(name, () => {
      const [indentation, lastUsedIndentation] = oracle(buffer, pos, lastUsed);

      expect(nextIndentation(buffer, pos, lastUsed)).toEqual({
        indentation,
        lastUsedIndentation,
      });
    });
  }
});
