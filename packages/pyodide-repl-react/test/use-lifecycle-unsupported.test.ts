// @vitest-environment node
/**
 * `initialRunnerStatus()`의 `unsupported`(`detectRuntimeSupport()` wasm 미지원, DELTA-07) 분기만 따로 본다.
 * 다른 시험 파일은 실제 Node `WebAssembly.validate`(참)를 공유 모듈 인스턴스로 쓰므로, `WebAssembly.validate`를
 * 거짓으로 바꾸려면 `vi.resetModules()` + 동적 import로 이 파일만 독립된 모듈 인스턴스를 써야 한다
 * (`@cp949/runo-pyodide-core`의 wasm 지원 캐시가 먼저 계산되면 이후 스텁이 반영되지 않는다 —
 * `runtime-support.test.ts`·`runner-unsupported.test.ts`와 같은 이유).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const originalValidate = WebAssembly.validate;

beforeEach(() => {
  vi.stubGlobal("crossOriginIsolated", true);
  WebAssembly.validate = () => false;
});

afterEach(() => {
  WebAssembly.validate = originalValidate;
  vi.unstubAllGlobals();
  vi.resetModules();
});

test("wasm 미지원이면 격리 여부와 무관하게 unsupported다", async () => {
  vi.resetModules();
  const { initialRunnerStatus } = await import("../src/use-lifecycle");

  expect(initialRunnerStatus()).toBe("unsupported");
});
