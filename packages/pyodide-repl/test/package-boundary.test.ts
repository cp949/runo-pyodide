// @vitest-environment node
/**
 * repl 패키지 경계: 소비자에게 가는 런타임 의존 트리(작업공간 내부 core·xterm-readline과 그 전이 의존 포함)에 동기 브리지
 * 라이브러리(`coincident`·`reflected-ffi`, ADR-0001)가 없다. "coincident 없이 REPL을 쓴다"는 약속을 강제한다.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  collectInstalledDependencyNames,
  findForbiddenDependencies,
} from "@repo/pyodide-testkit/package-boundary";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

describe("repl 패키지 의존 트리", () => {
  const { names } = collectInstalledDependencyNames(PACKAGE_DIR);

  test("coincident·reflected-ffi가 없다", () => {
    expect(findForbiddenDependencies(names)).toEqual([]);
  });

  test("작업공간 내부 패키지와 그 전이 의존까지 실제로 따라갔다", () => {
    // 아무것도 따라가지 못해 빈 집합이 되면 위 단언이 항상 통과하므로, 트리를 걸었다는 증거를 함께 단언한다.
    expect(names).toContain("@cp949/runo-pyodide-core");
    expect(names).toContain("@cp949/runo-xterm-readline");
    expect(names).toContain("string-width");
    expect(names).toContain("@xterm/xterm");
  });
});
