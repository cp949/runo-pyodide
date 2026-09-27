/**
 * `tab-completion.ts` 순수 함수 시험(docs/design/07-tab-completion.md 7.2~7.4). worker·xterm-readline
 * 의존이 없어 문자열만으로 단정한다. 후보 문자열과 목록 화면의 기대값은 CPython 3.14 `_pyrepl`을
 * pty로 실측한 결과(DELTA-01 측정 하니스)에서 가져왔다.
 */
import { describe, expect, it } from "vitest";
import {
  formatCompletionList,
  planTab,
  resolveCompletion,
} from "../../src/terminal/tab-completion";

// pyodide `Console.completer_word_break_characters`와 같은 스템 구분자 33자. `tab-completion.ts`의
// 내부 상수를 그대로 옮긴 것이 아니라, 구현이 지켜야 할 요구사항을 독립적으로 적어 둔 것이다.
const STEM_DELIMITERS = ` \t\n\`~!@#$%^&*()-=+[{]}\\|;:'",<>/?`;

describe("planTab: 스템이 빈 곳에서는 다음 4칸 단위까지 공백을 넣는다", () => {
  it("빈 버퍼는 4칸을 넣는다", () => {
    expect(planTab("", 0)).toEqual({ kind: "indent", text: "    " });
  });

  it.each([
    ["공백 1칸 뒤", " ", 3],
    ["공백 2칸 뒤", "  ", 2],
    ["공백 3칸 뒤", "   ", 1],
    ["공백 4칸 뒤", "    ", 4],
  ])("%s에서는 다음 4칸 단위 위치까지 공백을 넣는다", (_이름, buf, 칸수) => {
    expect(planTab(buf, buf.length)).toEqual({
      kind: "indent",
      text: " ".repeat(칸수),
    });
  });

  it("탭 문자 뒤는 1칸으로 세어 3칸을 넣는다", () => {
    expect(planTab("\t", 1)).toEqual({ kind: "indent", text: "   " });
  });

  it("구분자로 끝나는 줄은 줄 전체 길이로 열을 센다", () => {
    // "abc "는 공백(구분자)으로 끝나 스템이 비고, 열은 줄 전체 길이(4)로 센다: 4 - 4%4 = 4.
    expect(planTab("abc ", 4)).toEqual({ kind: "indent", text: "    " });
  });

  it("여러 줄 버퍼는 커서가 있는 논리 줄만 열로 센다", () => {
    // 첫 줄 "x = 1"(길이 5)을 논리 줄 분리 없이 전체 길이로 세면 "x = 1\n  "는 8글자라 4 - 8%4 = 4가
    // 나온다. 둘째(현재) 줄만 "  "(공백 2칸, 구분자로 끝남)로 세면 4 - 2%4 = 2다 — 두 계산이 갈리므로
    // 논리 줄 분리(`lastIndexOf("\n")`)를 빼는 변이를 실제로 잡는다.
    expect(planTab("x = 1\n  ", 8)).toEqual({ kind: "indent", text: "  " });
  });

  it("열은 코드포인트로 센다: 이모지는 1칸으로 센다", () => {
    // "😀 "는 이모지(코드포인트 1개, UTF-16 2유닛) + 공백(구분자) = 코드포인트 2개, UTF-16 3유닛.
    // 코드포인트로 세면 4 - 2%4 = 2인데, UTF-16 길이로 세면 4 - 3%4 = 1이라 다른 값이 나온다 — `column =
    // [...line].length`를 `line.length`로 바꾸는 변이를 실제로 잡는다.
    expect(planTab("😀 ", 3)).toEqual({ kind: "indent", text: "  " });
  });

  it("구분자 목록은 33자다", () => {
    expect([...STEM_DELIMITERS]).toHaveLength(33);
  });

  it.each([...STEM_DELIMITERS])(
    "구분자 %j 바로 뒤는 스템이 비어 공백을 넣는다",
    (구분자) => {
      expect(planTab(`x${구분자}`, 2).kind).toBe("indent");
    },
  );
});

describe("planTab: 스템이 있는 곳에서는 완성을 요청한다", () => {
  it("`os.pa` 끝은 커서 앞 텍스트를 source로 완성을 요청한다", () => {
    expect(planTab("os.pa", 5)).toEqual({ kind: "complete", source: "os.pa" });
  });

  it("커서가 버퍼 중간이면 커서 뒤 텍스트는 source에 들어가지 않는다", () => {
    expect(planTab("os.pa!", 5)).toEqual({ kind: "complete", source: "os.pa" });
  });
});

describe("planTab: import·from 게이트가 참이면 스템이 비어도 완성을 요청한다(RD-016)", () => {
  it("빈 스템 + `import `는 complete다", () => {
    expect(planTab("import ", 7)).toEqual({
      kind: "complete",
      source: "import ",
    });
  });

  it("빈 스템 + `from os import `는 complete다", () => {
    expect(planTab("from os import ", 15)).toEqual({
      kind: "complete",
      source: "from os import ",
    });
  });

  it("빈 스템 + `x = `는 게이트가 거짓이라 기존대로 indent다", () => {
    expect(planTab("x = ", 4)).toEqual({ kind: "indent", text: "    " });
  });

  it("게이트는 부분 문자열이다: `important = `도 참이라 complete다(worker가 None으로 판정한다)", () => {
    expect(planTab("important = ", 12)).toEqual({
      kind: "complete",
      source: "important = ",
    });
  });

  it("빈 버퍼는 pending이 없으면 indent다", () => {
    expect(planTab("", 0)).toEqual({ kind: "indent", text: "    " });
    expect(planTab("", 0, undefined)).toEqual({ kind: "indent", text: "    " });
  });

  it("pending에만 import가 있고 현재 줄이 비면 complete다(source는 커서 앞 텍스트 그대로)", () => {
    expect(planTab("", 0, "from os import (")).toEqual({
      kind: "complete",
      source: "",
    });
  });

  it("pending에만 import가 있고 현재 줄이 구분자로 끝나도 complete다", () => {
    expect(planTab("    x = ", 8, "import os")).toEqual({
      kind: "complete",
      source: "    x = ",
    });
  });

  it("pending이 있어도 게이트가 거짓이면 indent다", () => {
    expect(planTab("", 0, "x = 1")).toEqual({ kind: "indent", text: "    " });
  });

  it("커서 뒤 텍스트의 import는 게이트에 들어가지 않는다", () => {
    expect(planTab("x = import", 4)).toEqual({ kind: "indent", text: "    " });
  });

  it("스템이 있는 곳은 게이트와 무관하게 complete다", () => {
    expect(planTab("os.pa", 5, "x = 1")).toEqual({
      kind: "complete",
      source: "os.pa",
    });
  });
});

/** worker가 돌려준 후보를 붙여 resolveCompletion 인자를 만든다. 기본은 커서가 버퍼 끝, 첫 Tab이다. */
function resume(
  buf: string,
  completions: string[],
  start = 0,
  opts: { pos?: number; second?: boolean } = {},
) {
  return {
    buf,
    pos: opts.pos ?? buf.length,
    second: opts.second ?? false,
    completions,
    start,
  };
}

describe("resolveCompletion", () => {
  it("후보가 없으면 아무 일도 하지 않는다", () => {
    expect(resolveCompletion(resume("os.zzzz", []))).toEqual({ kind: "none" });
  });

  it("후보가 하나면 스템 뒤 나머지를 그대로 삽입한다", () => {
    expect(resolveCompletion(resume("os.pa", ["os.path"]))).toEqual({
      kind: "insert",
      text: "th",
    });
  });

  it("후보가 여럿이면 공통 접두사에서 스템을 뺀 만큼만 채운다", () => {
    expect(
      resolveCompletion(resume("a.at", ["a.attr_one", "a.attr_two"])),
    ).toEqual({
      kind: "insert",
      text: "tr_",
    });
  });

  it("스템이 공통 접두사와 같으면(채울 것이 없으면) 첫 Tab은 아무 일도 하지 않는다", () => {
    expect(
      resolveCompletion(
        resume("os.pa", ["os.pardir", "os.path", "os.pathsep"]),
      ),
    ).toEqual({
      kind: "none",
    });
  });

  it("연속 두 번째 Tab이고 채울 것이 없으면 목록을 연다", () => {
    const completions = ["os.pardir", "os.path", "os.pathsep"];
    expect(
      resolveCompletion(resume("os.pa", completions, 0, { second: true })),
    ).toEqual({
      kind: "list",
      completions,
      stem: "os.pa",
    });
  });

  it("두 번째 Tab이어도 채울 수 있으면 삽입이 먼저다", () => {
    expect(
      resolveCompletion(resume("os.pa", ["os.path"], 0, { second: true })),
    ).toEqual({
      kind: "insert",
      text: "th",
    });
  });

  it("후보 하나가 이미 입력과 같으면 두 번째 Tab이어도 목록을 열지 않는다", () => {
    expect(
      resolveCompletion(resume("True", ["True"], 0, { second: true })),
    ).toEqual({ kind: "none" });
  });

  it("start가 0이 아니면 그 뒤부터가 스템이다", () => {
    const source = "x = 1 ; os.pa";
    expect(resolveCompletion(resume(source, ["os.path"], 8))).toEqual({
      kind: "insert",
      text: "th",
    });
  });

  it("start는 코드포인트 인덱스다: 스템 앞에 이모지가 있어도 스템이 밀리지 않는다", () => {
    // 이모지는 JS에서 2칸(서로게이트 쌍)이지만 Python str에서는 1칸이라, "a"의 코드포인트 인덱스는
    // 10이고 같은 위치의 UTF-16 인덱스는 11이다. UTF-16 slice로 자르면 스템이 한 칸 밀린다(TRP-031).
    const source = 'x = "😀" ; a.at';
    expect(
      resolveCompletion(resume(source, ["a.attr_one", "a.attr_two"], 10)),
    ).toEqual({
      kind: "insert",
      text: "tr_",
    });
  });

  it("공통 접두사는 코드포인트 단위로 자른다: 서로게이트 쌍의 절반만 남기지 않는다", () => {
    // U+20000과 U+20001은 상위 서로게이트가 같고 하위만 달라, UTF-16 단위 비교는 반쪽을 남길 수 있다.
    expect(
      resolveCompletion(resume("a", ["a\u{20000}", "a\u{20001}"])),
    ).toEqual({ kind: "none" });
  });

  it("공통 접두사를 스템 길이만큼 자르는 것도 코드포인트 단위다: 스템이 공통 접두사로 시작하지 않는 아스트랄 케이스", () => {
    // 스템 "ab"(코드포인트 2개)와 후보 두 개("\u{20000}cd", "\u{20000}ce")의 공통 접두사는
    // "\u{20000}c"(코드포인트 2개, UTF-16 3유닛)다. UTF-16 `slice(stem.length)` = `slice(2)`는
    // 서로게이트 쌍(2유닛)의 두 번째 유닛에서 시작해 "c"만 남기지만(고아 서로게이트가 없는 우연한
    // 경우라도 잘못된 위치), 코드포인트 `slice([...stem].length)` = `slice(2)`는 코드포인트 2개를
    // 통째로 건너뛰어 ""가 남는다 — kind가 "insert"(UTF-16)와 "none"(코드포인트)으로 갈린다.
    expect(
      resolveCompletion(resume("ab", ["\u{20000}cd", "\u{20000}ce"])),
    ).toEqual({ kind: "none" });
  });
});

describe("formatCompletionList", () => {
  // 기대 행은 3.14 `_pyrepl`을 80열 pty에서 두 번 Tab한 화면이다(행 끝 공백은 화면에서 잘렸다).
  it("셀 폭(최장 후보 + 간격 2) 기준으로 한 줄에 채운다", () => {
    expect(
      formatCompletionList(["a.attr_one", "a.meth()", "a.prop"], 80),
    ).toEqual(["a.attr_one  a.meth()    a.prop"]);
    expect(
      formatCompletionList(["A.attr_one", "A.meth(", "A.mro()", "A.prop"], 80),
    ).toEqual(["A.attr_one  A.meth(     A.mro()     A.prop"]);
  });

  it("열 우선으로 채운다: 왼쪽 열부터 위에서 아래로 채우고 셀 인덱스는 row + k*rowCount다", () => {
    // 셀 폭 3(길이1+간격2), 9열이면 3열, 후보 7개면 3행(ceil(7/3)) — 3열 x 3행 격자.
    expect(
      formatCompletionList(["a", "b", "c", "d", "e", "f", "g"], 9),
    ).toEqual(["a  d  g", "b  e", "c  f"]);
  });

  it("셀 폭이 터미널 열보다 넓어도 열 수는 최소 1이다", () => {
    expect(formatCompletionList(["aaaaaaaaaa"], 4)).toEqual(["aaaaaaaaaa"]);
    expect(formatCompletionList(["aaaaaaaaaa", "bbbbbbbbbb"], 4)).toEqual([
      "aaaaaaaaaa",
      "bbbbbbbbbb",
    ]);
  });

  it("200개를 넘으면 200개까지만 나열하고 남은 개수를 마지막 행에 적는다", () => {
    const completions = Array.from({ length: 201 }, (_, i) => `name${i}`);
    const rows = formatCompletionList(completions, 80);
    expect(rows.at(-1)).toBe("...1개 더");
    const body = rows.slice(0, -1).join("\n");
    expect(body).toContain("name199");
    expect(body).not.toContain("name200");
  });

  it("정확히 200개면 남은 개수 행을 붙이지 않는다", () => {
    const completions = Array.from({ length: 200 }, (_, i) => `name${i}`);
    const rows = formatCompletionList(completions, 80);
    expect(rows.some((row) => row.includes("..."))).toBe(false);
  });
});
