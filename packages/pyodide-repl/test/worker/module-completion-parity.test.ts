// @vitest-environment node
/**
 * `import`/`from` 줄 모듈 완성의 3.14 pty 동등성 시험(RD-016, docs/design/07-tab-completion.md 7.5).
 *
 * 실제 pyodide(node)로 worker `complete_source`를 돌린다.
 * main 쪽 계산(`planTab`·`resolveCompletion`·`formatCompletionList`)을 그대로 이어 붙인 시뮬레이터가 한 줄 버퍼에 Tab을 누른다.
 * 그 결과(화면 행·커서)를 CPython 3.14.4 pty 실측과 비교한다.
 *
 * 기대값 출처:
 * - `apps/demo/e2e/pty/rd-016/res_import.json`(A01~A36).
 * - `res_import_extra.json`(X01~X04).
 * - `cases_import.json`(setup·Tab 횟수).
 *
 * 시험은 `apps/demo`를 읽지 않는다. 기대값은 리터럴로 옮겼다.
 * 아래 생성 구역은 스크립트로 옮겼다(RD-016).
 * 그 스크립트는 케이스 ID·키 목록을 원본과 대조했다.
 * A37(`import os  # c\n`)은 여기서 다루지 않는다. `complete-source.test.ts`의 quirk 단위 시험이 맡는다.
 *
 * 시뮬레이터가 다루지 않는 것:
 * - 실제 터미널 렌더링(재그리기·줄바꿈).
 * - readline 배선.
 * - 위 둘은 브라우저 L1 `tab-check.mjs`가 맡는다.
 *
 * 시뮬레이터의 화면 모델:
 * - 화면 행은 프롬프트(`>>> `·`... `)와 논리 줄을 이어 오른쪽 공백을 자른 것이다.
 * - 목록이 열리면 그 아래에 행을 잇는다.
 * - 커서는 버퍼 끝이다.
 *
 * 판정:
 * - 화면 행 비교에서 pty의 `[ not unique ]` 행은 뺀다. 3.14 전용 안내 행이다(편차 16).
 * - 편차 18(환경 모듈 집합 차이)로 후보가 달라져도 화면이 같은 케이스(A07·A08·A28·A35·X03 등)는 화면을 그대로 비교한다.
 * - 화면이 같을 수 없는 것은 `import `·`from ` 두 번째 Tab의 목록(A11·A12 2단계)뿐이다.
 *   - pty는 192개를 22행 쪽으로 넘기고 `108 more...`를 붙인다(편차 16).
 *   - 이 저장소는 178개를 열 우선 배치로 다 그린다.
 *   - 이 두 단계는 구조로 판정한다: 입력 행 동일, 커서 동일, 목록 첫 행 앞 17칸 동일, 행 폭 80 이하(TRAP-27).
 *   - 열 폭은 문자열 길이 근사다(편차 21).
 */
import { loadPyodide, type PyodideInterface } from "pyodide";
import { beforeAll, describe, expect, test } from "vitest";
import {
  formatCompletionList,
  planTab,
  resolveCompletion,
} from "../../src/terminal/tab-completion";
import { createConsole } from "../../src/worker/console";
import {
  loadCompleteSource,
  type CompleteSource,
} from "../../src/worker/complete-source";

/** pty 24x80과 같은 터미널 열 수. */
const COLUMNS = 80;

/** pty 프롬프트 폭(`>>> `·`... ` 모두 4칸). */
const PROMPT_WIDTH = 4;

/** pty 화면의 한 시점. 행은 오른쪽 공백이 없고, 커서는 `[행, 열]`이며 열은 프롬프트를 포함한다. */
interface PtyScreen {
  screen: string[];
  cursor: [number, number];
}

/** pty 실측 케이스 하나. `steps[k]`는 Tab을 k+1번 누른 직후 화면이다. */
interface PtyCase {
  id: string;
  text: string;
  tabs: number;
  typed: PtyScreen;
  steps: PtyScreen[];
}

/**
 * 아래 생성 구역의 두 상수.
 * - `SETUP`: pty 하니스가 케이스마다 새 세션에서 실행한 setup 5줄.
 * - `PTY_CASES`: 실측 케이스 40개(A01~A36·X01~X04). 손으로 고치지 않는다.
 */
// <생성 시작: gen-parity-cases.mjs>
const SETUP: string[] = [
  "import os",
  "x = [1, 2]; _x = 1; __y__ = 2",
  "f = lambda a: a",
  'A = type("A", (), {"attr_one": 1, "_priv": 2, "meth": lambda self: 0, "prop": property(lambda self: 1)})',
  "a = A()",
];
const PTY_CASES: PtyCase[] = [
  {
    id: "A01",
    text: "import os.pa",
    tabs: 1,
    typed: { screen: [">>> import os.pa"], cursor: [0, 16] },
    steps: [{ screen: [">>> import os.path"], cursor: [0, 18] }],
  },
  {
    id: "A02",
    text: "from os import pa",
    tabs: 1,
    typed: { screen: [">>> from os import pa"], cursor: [0, 21] },
    steps: [{ screen: [">>> from os import path"], cursor: [0, 23] }],
  },
  {
    id: "A03",
    text: "import o",
    tabs: 1,
    typed: { screen: [">>> import o"], cursor: [0, 12] },
    steps: [{ screen: [">>> import o", "[ not unique ]"], cursor: [0, 12] }],
  },
  {
    id: "A04",
    text: "from o",
    tabs: 1,
    typed: { screen: [">>> from o"], cursor: [0, 10] },
    steps: [{ screen: [">>> from o", "[ not unique ]"], cursor: [0, 10] }],
  },
  {
    id: "A05",
    text: "import xml.dom.m",
    tabs: 1,
    typed: { screen: [">>> import xml.dom.m"], cursor: [0, 20] },
    steps: [
      {
        screen: [">>> import xml.dom.mini", "[ not unique ]"],
        cursor: [0, 23],
      },
    ],
  },
  {
    id: "A06",
    text: "from xml.dom import m",
    tabs: 1,
    typed: { screen: [">>> from xml.dom import m"], cursor: [0, 25] },
    steps: [
      {
        screen: [">>> from xml.dom import mini", "[ not unique ]"],
        cursor: [0, 28],
      },
    ],
  },
  {
    id: "A07",
    text: "import os, sy",
    tabs: 1,
    typed: { screen: [">>> import os, sy"], cursor: [0, 17] },
    steps: [
      { screen: [">>> import os, sy", "[ not unique ]"], cursor: [0, 17] },
    ],
  },
  {
    id: "A08",
    text: "import os as o, sy",
    tabs: 1,
    typed: { screen: [">>> import os as o, sy"], cursor: [0, 22] },
    steps: [
      { screen: [">>> import os as o, sy", "[ not unique ]"], cursor: [0, 22] },
    ],
  },
  {
    id: "A09",
    text: "import collections.a",
    tabs: 1,
    typed: { screen: [">>> import collections.a"], cursor: [0, 24] },
    steps: [{ screen: [">>> import collections.abc"], cursor: [0, 26] }],
  },
  {
    id: "A10",
    text: "from collections import a",
    tabs: 1,
    typed: { screen: [">>> from collections import a"], cursor: [0, 29] },
    steps: [{ screen: [">>> from collections import abc"], cursor: [0, 31] }],
  },
  {
    id: "A11",
    text: "import ",
    tabs: 2,
    typed: { screen: [">>> import"], cursor: [0, 11] },
    steps: [
      { screen: [">>> import", "[ not unique ]"], cursor: [0, 11] },
      {
        screen: [
          ">>> import",
          "abc              filecmp          pathlib          statistics",
          "annotationlib    fileinput        pdb              string",
          "antigravity      fnmatch          pickle           stringprep",
          "argparse         fractions        pickletools      struct",
          "array            ftplib           pip              subprocess",
          "ast              functools        pkgutil          symtable",
          "asyncio          gc               platform         sys",
          "atexit           genericpath      plistlib         sysconfig",
          "base64           getopt           poplib           syslog",
          "bdb              getpass          posix            tabnanny",
          "binascii         gettext          posixpath        tarfile",
          "bisect           glob             pprint           tempfile",
          "builtins         graphlib         profile          termios",
          "bz2              grp              pstats           textwrap",
          "cProfile         gzip             pty              this",
          "calendar         hashlib          pwd              threading",
          "cmath            heapq            py_compile       time",
          "cmd              hmac             pyclbr           timeit",
          "code             html             pydoc            tkinter",
          "codecs           http             pydoc_data       token",
          "codeop           idlelib          pyexpat          tokenize",
          "   108 more...",
        ],
        cursor: [0, 11],
      },
    ],
  },
  {
    id: "A12",
    text: "from ",
    tabs: 2,
    typed: { screen: [">>> from"], cursor: [0, 9] },
    steps: [
      { screen: [">>> from", "[ not unique ]"], cursor: [0, 9] },
      {
        screen: [
          ">>> from",
          "abc              filecmp          pathlib          statistics",
          "annotationlib    fileinput        pdb              string",
          "antigravity      fnmatch          pickle           stringprep",
          "argparse         fractions        pickletools      struct",
          "array            ftplib           pip              subprocess",
          "ast              functools        pkgutil          symtable",
          "asyncio          gc               platform         sys",
          "atexit           genericpath      plistlib         sysconfig",
          "base64           getopt           poplib           syslog",
          "bdb              getpass          posix            tabnanny",
          "binascii         gettext          posixpath        tarfile",
          "bisect           glob             pprint           tempfile",
          "builtins         graphlib         profile          termios",
          "bz2              grp              pstats           textwrap",
          "cProfile         gzip             pty              this",
          "calendar         hashlib          pwd              threading",
          "cmath            heapq            py_compile       time",
          "cmd              hmac             pyclbr           timeit",
          "code             html             pydoc            tkinter",
          "codecs           http             pydoc_data       token",
          "codeop           idlelib          pyexpat          tokenize",
          "   108 more...",
        ],
        cursor: [0, 9],
      },
    ],
  },
  {
    id: "A13",
    text: "from os import ",
    tabs: 1,
    typed: { screen: [">>> from os import"], cursor: [0, 19] },
    steps: [{ screen: [">>> from os import path"], cursor: [0, 23] }],
  },
  {
    id: "A14",
    text: "import zzzz",
    tabs: 1,
    typed: { screen: [">>> import zzzz"], cursor: [0, 15] },
    steps: [{ screen: [">>> import zzzz"], cursor: [0, 15] }],
  },
  {
    id: "A15",
    text: "import os.zzz",
    tabs: 1,
    typed: { screen: [">>> import os.zzz"], cursor: [0, 17] },
    steps: [{ screen: [">>> import os.zzz"], cursor: [0, 17] }],
  },
  {
    id: "A16",
    text: "from . import x",
    tabs: 1,
    typed: { screen: [">>> from . import x"], cursor: [0, 19] },
    steps: [{ screen: [">>> from . import x"], cursor: [0, 19] }],
  },
  {
    id: "A17",
    text: "from .",
    tabs: 1,
    typed: { screen: [">>> from ."], cursor: [0, 10] },
    steps: [{ screen: [">>> from ."], cursor: [0, 10] }],
  },
  {
    id: "A18",
    text: "from .a",
    tabs: 1,
    typed: { screen: [">>> from .a"], cursor: [0, 11] },
    steps: [{ screen: [">>> from .a"], cursor: [0, 11] }],
  },
  {
    id: "A19",
    text: "from . import ",
    tabs: 1,
    typed: { screen: [">>> from . import"], cursor: [0, 18] },
    steps: [{ screen: [">>> from . import"], cursor: [0, 18] }],
  },
  {
    id: "A20",
    text: "from math import s",
    tabs: 1,
    typed: { screen: [">>> from math import s"], cursor: [0, 22] },
    steps: [{ screen: [">>> from math import s"], cursor: [0, 22] }],
  },
  {
    id: "A21",
    text: "from os import (path, s",
    tabs: 1,
    typed: { screen: [">>> from os import (path, s"], cursor: [0, 27] },
    steps: [{ screen: [">>> from os import (path, s"], cursor: [0, 27] }],
  },
  {
    id: "A22",
    text: "import os ",
    tabs: 1,
    typed: { screen: [">>> import os"], cursor: [0, 14] },
    steps: [{ screen: [">>> import os"], cursor: [0, 16] }],
  },
  {
    id: "A23",
    text: "import os.path ",
    tabs: 1,
    typed: { screen: [">>> import os.path"], cursor: [0, 19] },
    steps: [{ screen: [">>> import os.path"], cursor: [0, 20] }],
  },
  {
    id: "A24",
    text: "from os import path ",
    tabs: 1,
    typed: { screen: [">>> from os import path"], cursor: [0, 24] },
    steps: [{ screen: [">>> from os import path"], cursor: [0, 28] }],
  },
  {
    id: "A25",
    text: "import os; os.pa",
    tabs: 1,
    typed: { screen: [">>> import os; os.pa"], cursor: [0, 20] },
    steps: [
      { screen: [">>> import os; os.pa", "[ not unique ]"], cursor: [0, 20] },
    ],
  },
  {
    id: "A26",
    text: "import os\nos.pa",
    tabs: 1,
    typed: { screen: [">>> import os", "... os.pa"], cursor: [1, 9] },
    steps: [
      {
        screen: [">>> import os", "... os.pa", "[ not unique ]"],
        cursor: [1, 9],
      },
    ],
  },
  {
    id: "A27",
    text: "x = 1",
    tabs: 1,
    typed: { screen: [">>> x = 1"], cursor: [0, 9] },
    steps: [{ screen: [">>> x = 1"], cursor: [0, 9] }],
  },
  {
    id: "A28",
    text: "import os; import s",
    tabs: 1,
    typed: { screen: [">>> import os; import s"], cursor: [0, 23] },
    steps: [
      {
        screen: [">>> import os; import s", "[ not unique ]"],
        cursor: [0, 23],
      },
    ],
  },
  {
    id: "A29",
    text: "x = 1; import o",
    tabs: 1,
    typed: { screen: [">>> x = 1; import o"], cursor: [0, 19] },
    steps: [
      { screen: [">>> x = 1; import o", "[ not unique ]"], cursor: [0, 19] },
    ],
  },
  {
    id: "A30",
    text: "x = 1\nimport o",
    tabs: 1,
    typed: { screen: [">>> x = 1", "... import o"], cursor: [1, 12] },
    steps: [
      {
        screen: [">>> x = 1", "... import o", "[ not unique ]"],
        cursor: [1, 12],
      },
    ],
  },
  {
    id: "A31",
    text: "if True:\n    import o",
    tabs: 1,
    typed: { screen: [">>> if True:", "...     import o"], cursor: [1, 16] },
    steps: [
      {
        screen: [">>> if True:", "...     import o", "[ not unique ]"],
        cursor: [1, 16],
      },
    ],
  },
  {
    id: "A32",
    text: "from os import (\n    p",
    tabs: 1,
    typed: { screen: [">>> from os import (", "...     p"], cursor: [1, 9] },
    steps: [
      { screen: [">>> from os import (", "...     path"], cursor: [1, 12] },
    ],
  },
  {
    id: "A33",
    text: "from os import (\n    path,\n    ",
    tabs: 1,
    typed: {
      screen: [">>> from os import (", "...     path,", "..."],
      cursor: [2, 8],
    },
    steps: [
      {
        screen: [">>> from os import (", "...     path,", "...     path"],
        cursor: [2, 12],
      },
    ],
  },
  {
    id: "A34",
    text: "def f():\n    yield from o",
    tabs: 1,
    typed: {
      screen: [">>> def f():", "...     yield from o"],
      cursor: [1, 20],
    },
    steps: [
      {
        screen: [">>> def f():", "...     yield from o", "[ not unique ]"],
        cursor: [1, 20],
      },
    ],
  },
  {
    id: "A35",
    text: "def f():\n    yield from ",
    tabs: 1,
    typed: { screen: [">>> def f():", "...     yield from"], cursor: [1, 19] },
    steps: [
      {
        screen: [">>> def f():", "...     yield from", "[ not unique ]"],
        cursor: [1, 19],
      },
    ],
  },
  {
    id: "A36",
    text: "raise ValueError from o",
    tabs: 1,
    typed: { screen: [">>> raise ValueError from o"], cursor: [0, 27] },
    steps: [
      {
        screen: [">>> raise ValueError from o", "[ not unique ]"],
        cursor: [0, 27],
      },
    ],
  },
  {
    id: "X01",
    text: "import os.pa  # c",
    tabs: 1,
    typed: { screen: [">>> import os.pa  # c"], cursor: [0, 21] },
    steps: [{ screen: [">>> import os.pa  # cs.path"], cursor: [0, 27] }],
  },
  {
    id: "X02",
    text: "import os.pa\n",
    tabs: 1,
    typed: { screen: [">>> import os.pa", "..."], cursor: [1, 4] },
    steps: [{ screen: [">>> import os.pa", "... os.path"], cursor: [1, 11] }],
  },
  {
    id: "X03",
    text: "import os, ",
    tabs: 1,
    typed: { screen: [">>> import os,"], cursor: [0, 15] },
    steps: [{ screen: [">>> import os,", "[ not unique ]"], cursor: [0, 15] }],
  },
  {
    id: "X04",
    text: "from os import path,",
    tabs: 1,
    typed: { screen: [">>> from os import path,"], cursor: [0, 24] },
    steps: [{ screen: [">>> from os import path,path"], cursor: [0, 28] }],
  },
];
// <생성 끝>

/** 화면이 같을 수 없어 구조로 판정하는 단계(케이스 ID → 단계 인덱스). `[ not unique ]` 외 차이가 목록 쪽 넘김뿐인 두 단계다. */
const STRUCTURAL_STEPS: Record<string, number> = { A11: 1, A12: 1 };

/** pty가 목록 열 폭을 재는 셀 폭(최장 후보 15자 + 간격 2). 네이티브·pyodide 모두 최장이 `multiprocessing`이라 같다. */
const LIST_CELL_WIDTH = 17;

/** 시뮬레이터가 돌려주는 단계 결과. 구조 판정은 화면 행에서 목록이 어디서 시작하는지 알아야 한다. */
interface SimStep extends PtyScreen {
  /** 목록 행의 시작 인덱스. 목록이 열리지 않았으면 `null`. */
  listStart: number | null;
}

/** 시험 대상 `loadCompleteSource`의 결과. `beforeAll`이 만든다. */
let completer: CompleteSource;

beforeAll(async () => {
  const pyodide: PyodideInterface = await loadPyodide();
  const repl = createConsole(
    pyodide,
    { write: () => {}, writeErrorRaw: () => {} },
    { topLevelAwait: false },
  );
  completer = loadCompleteSource(pyodide, repl.pyconsole);
  // pty 하니스는 케이스마다 새 세션에서 setup 5줄(`import os` 등)을 실행했다. 여기서는 같은 REPL 전역에 한 번만 실행한다.
  for (const line of SETUP) pyodide.runPython(line);
}, 60_000);

/** 논리 줄들로 pty 화면 행을 만든다. 첫 줄은 `>>> `, 나머지는 `... `를 붙이고 오른쪽 공백은 pty 캡처처럼 자른다. */
function bufferRows(lines: string[]): string[] {
  return lines.map((line, i) =>
    `${i === 0 ? ">>> " : "... "}${line}`.trimEnd(),
  );
}

/**
 * 한 줄 버퍼(커서는 끝)에 Tab을 `tabs`번 누르고 Tab마다의 화면을 돌려준다.
 *
 * - 여러 줄 입력은 마지막 줄만 버퍼다. 앞 줄들은 `pending`(`\n`으로 이음)이다.
 *   `tab-reader.ts`가 `... ` 읽기에서 `pendingBlock`을 worker `complete`의 `pending`으로 넘기는 것과 같다.
 * - 연속 Tab만 `second`다. 삽입·목록 여부는 `resolveCompletion`이 정한다.
 */
function simulate(text: string, tabs: number): SimStep[] {
  const lines = text.split("\n");
  let current = lines.pop() ?? "";
  const pending = lines.length > 0 ? lines.join("\n") : undefined;
  const steps: SimStep[] = [];
  for (let k = 0; k < tabs; k++) {
    let list: string[] = [];
    const plan = planTab(current, current.length, pending);
    if (plan.kind === "indent") {
      current += plan.text;
    } else {
      const { completions, start } = completer(plan.source, pending);
      const action = resolveCompletion({
        buf: current,
        pos: current.length,
        second: k > 0,
        completions,
        start,
      });
      if (action.kind === "insert") current += action.text;
      else if (action.kind === "list")
        list = formatCompletionList(action.completions, COLUMNS);
    }
    const rows = bufferRows([...lines, current]);
    steps.push({
      screen: [...rows, ...list],
      cursor: [rows.length - 1, PROMPT_WIDTH + [...current].length],
      listStart: list.length > 0 ? rows.length : null,
    });
  }
  return steps;
}

/** pty 화면에서 3.14 전용 `[ not unique ]` 행을 뺀다(편차 16). */
function withoutNotUnique(screen: string[]): string[] {
  return screen.filter((row) => row !== "[ not unique ]");
}

describe("모듈 완성 3.14 pty 동등성", () => {
  for (const c of PTY_CASES) {
    const title = `${c.id} ${JSON.stringify(c.text)} Tab ${c.tabs}회`;
    test(title, () => {
      const lines = c.text.split("\n");
      // 입력 직후(Tab 전) 화면·커서를 본다.
      // 시뮬레이터의 화면 모델이 pty 캡처와 같은지, 리터럴 옮김이 맞는지 확인한다.
      expect(bufferRows(lines)).toEqual(c.typed.screen);
      expect(c.typed.cursor).toEqual([
        lines.length - 1,
        PROMPT_WIDTH + [...lines[lines.length - 1]!].length,
      ]);

      const sim = simulate(c.text, c.tabs);

      expect(sim).toHaveLength(c.steps.length);
      c.steps.forEach((expected, k) => {
        const actual = sim[k]!;
        const expectedRows = withoutNotUnique(expected.screen);
        if (STRUCTURAL_STEPS[c.id] === k) {
          // 목록 단계는 입력 행·커서를 그대로 비교하고 목록은 구조만 본다.
          const inputRows = expectedRows.slice(0, 1);
          expect(
            actual.listStart,
            `${c.id} ${k + 1}번째 Tab에서 목록이 열린다`,
          ).toBe(inputRows.length);
          expect(actual.screen.slice(0, inputRows.length)).toEqual(inputRows);
          expect(actual.cursor).toEqual(expected.cursor);
          const listRows = actual.screen.slice(inputRows.length);
          // 열 우선 배치라 첫 행의 첫 셀은 첫 후보(`abc`)다. 두 번째 셀은 셀 폭 17칸에서 시작한다.
          expect(listRows[0]!.slice(0, LIST_CELL_WIDTH)).toBe(
            expectedRows[inputRows.length]!.slice(0, LIST_CELL_WIDTH),
          );
          for (const row of listRows)
            expect(row.length).toBeLessThanOrEqual(COLUMNS);
        } else {
          expect(actual.listStart).toBeNull();
          expect(actual.screen).toEqual(expectedRows);
          expect(actual.cursor).toEqual(expected.cursor);
        }
      });
    });
  }
});
