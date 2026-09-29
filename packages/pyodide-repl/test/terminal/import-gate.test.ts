/**
 * main 사전 게이트 `mentionsImportKeyword`의 판정 시험(RD-016, `docs/design/07-tab-completion.md` 7.5, TRAP-33).
 * 게이트는 부분 문자열 `/import|from/`이다.
 * 게이트가 거짓이면 3.14 `ModuleCompleter`는 항상 `None`이어야 한다.
 * 그 건전성은 `worker/complete-source.test.ts`가 실제 pyodide로 확인한다.
 * 입력 코퍼스는 `import-gate-corpus.ts`(측정 C 53줄 + 대소문자 변형 2줄)다.
 */
import { describe, expect, it } from "vitest";
import {
  FALSE_POSITIVE_LINES,
  GATE_FALSE_LINES,
  NON_NONE_LINES,
  NUMERIC_LITERAL_LINES,
} from "./import-gate-corpus";
import { mentionsImportKeyword } from "../../src/terminal/tab-completion";

describe("mentionsImportKeyword: 게이트가 거짓인 줄", () => {
  it.each(GATE_FALSE_LINES)("%j은 거짓이다", (line) => {
    expect(mentionsImportKeyword(line)).toBe(false);
  });

  it("대소문자를 구분한다(`IMPORT`·`FROM`은 거짓)", () => {
    expect(mentionsImportKeyword("IMPORT os")).toBe(false);
    expect(mentionsImportKeyword("FROM os")).toBe(false);
  });
});

describe("mentionsImportKeyword: 오탐(게이트 참, ModuleCompleter는 None)", () => {
  it.each(FALSE_POSITIVE_LINES)(
    "%j은 참이다(worker 왕복만 늘어난다)",
    (line) => {
      expect(mentionsImportKeyword(line)).toBe(true);
    },
  );
});

describe("mentionsImportKeyword: ModuleCompleter가 None이 아닌 줄", () => {
  it.each(NON_NONE_LINES)("%j은 참이다", (line) => {
    expect(mentionsImportKeyword(line)).toBe(true);
  });
});

describe("부분 문자열 게이트를 고른 근거: 단어 경계 게이트는 건전하지 않다", () => {
  it.each(NUMERIC_LITERAL_LINES)(
    "%j은 단어 경계 게이트가 거짓이지만 부분 문자열 게이트는 참이다",
    (line) => {
      // 3.14 tokenize는 `NUMBER` + `NAME('import')`로 나눈다. ModuleCompleter가 후보를 낸다(TRAP-33).
      // 이 사실은 complete-source.test.ts가 단정한다.
      expect(/\b(import|from)\b/.test(line)).toBe(false);
      expect(mentionsImportKeyword(line)).toBe(true);
    },
  );
});
