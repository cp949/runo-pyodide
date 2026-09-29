// @vitest-environment node
/**
 * `initialRunnerStatus()`의 `unsupported` 분기 시험. node 환경.
 * - 조건: `detectRuntimeSupport()`가 wasm 미지원으로 판정한다.
 * - 별도 파일인 이유: core는 wasm 지원 판정을 모듈 스코프에 캐시한다. 캐시가 먼저 계산되면 이후 `WebAssembly.validate` 스텁이 반영되지 않는다.
 * - 방법: `vi.resetModules()` 뒤 동적 import로 이 파일만 독립된 모듈 인스턴스를 쓴다.
 * - 같은 이유의 core 시험: `runtime-support.test.ts`, `runner-unsupported.test.ts`.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// 시험이 거짓으로 바꾸는 `WebAssembly.validate`의 원본. `afterEach`에서 복원한다.
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
