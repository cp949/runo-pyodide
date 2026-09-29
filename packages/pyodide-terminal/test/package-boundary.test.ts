// @vitest-environment node
/**
 * terminal 패키지 경계 시험.
 * - 대상: 소비자에게 가는 런타임 의존 트리. 작업공간 내부 core·xterm-readline과 전이 의존을 포함한다.
 * - 금지: 동기 브리지 라이브러리 `coincident`·`reflected-ffi`(ADR-0001).
 * - 목적: "coincident 없이 실행창을 쓴다"는 약속을 강제한다.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  collectInstalledDependencyNames,
  findForbiddenDependencies,
} from "@repo/pyodide-testkit/package-boundary";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

describe("terminal 패키지 의존 트리", () => {
  const { names } = collectInstalledDependencyNames(PACKAGE_DIR);

  test("coincident·reflected-ffi가 없다", () => {
    expect(findForbiddenDependencies(names)).toEqual([]);
  });

  test("작업공간 내부 패키지와 그 전이 의존까지 실제로 따라갔다", () => {
    // 집합이 비면 위 단언은 항상 통과한다. 트리를 실제로 걸었다는 증거를 함께 단언한다.
    expect(names).toContain("@cp949/runo-pyodide-core");
    expect(names).toContain("@cp949/runo-xterm-readline");
    expect(names).toContain("string-width");
    expect(names).toContain("@xterm/xterm");
  });

  test("repl에 의존하지 않는다(repl → terminal 단방향)", () => {
    expect(names.has("@cp949/runo-pyodide-repl")).toBe(false);
  });
});
