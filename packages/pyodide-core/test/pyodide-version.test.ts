/**
 * pyodide 고정 버전 상수 시험. 버전의 원천은 `pnpm-workspace.yaml` catalog이고, 코드는 설치된
 * `pyodide/package.json`의 `version`에서 값을 유도한다(ADR-0007). 리터럴을 코드에 두지 않는다.
 */
import { describe, expect, test } from "vitest";
import pyodidePackage from "pyodide/package.json" with { type: "json" };
import {
  DEFAULT_PYODIDE_INDEX_URL,
  PYODIDE_VERSION,
} from "../src/pyodide-version";

describe("pyodide 고정 버전 상수", () => {
  test("PYODIDE_VERSION은 설치된 pyodide/package.json의 version과 같다", () => {
    expect(PYODIDE_VERSION).toBe(pyodidePackage.version);
  });

  test("DEFAULT_PYODIDE_INDEX_URL은 고정 버전 CDN 경로이고 끝 `/`를 포함한다", () => {
    expect(DEFAULT_PYODIDE_INDEX_URL).toBe(
      `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,
    );
    expect(DEFAULT_PYODIDE_INDEX_URL.endsWith("/full/")).toBe(true);
  });
});
