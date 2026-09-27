// @vitest-environment node
/**
 * core 패키지 경계: 소비자에게 가는 런타임 의존 트리에 동기 브리지 라이브러리(`coincident`·`reflected-ffi`, ADR-0001)와
 * 터미널 라이브러리(`@cp949/runo-xterm-readline`)가 없다. core는 REPL·터미널을 모른다(RD-022 이전 확정).
 */
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  collectInstalledDependencyNames,
  findForbiddenDependencies,
} from "@repo/pyodide-testkit/package-boundary";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

describe("core 패키지 의존 트리", () => {
  const { names } = collectInstalledDependencyNames(PACKAGE_DIR);

  test("coincident·reflected-ffi가 없다", () => {
    expect(findForbiddenDependencies(names)).toEqual([]);
  });

  test("@cp949/runo-xterm-readline에 의존하지 않는다", () => {
    expect(names.has("@cp949/runo-xterm-readline")).toBe(false);
  });
});
