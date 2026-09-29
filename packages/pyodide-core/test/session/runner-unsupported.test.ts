// @vitest-environment node
/**
 * `createRunner`의 `unsupported` 분기만 따로 본다(`detectRuntimeSupport()`가 wasm 미지원으로 판정).
 * - `runner.test.ts`의 나머지 시험은 실제 Node `WebAssembly.validate`(참)를 쓴다.
 * - 이 파일은 `WebAssembly.validate`를 거짓으로 바꾼다.
 * - `../../src/runtime-support.ts`가 wasm 판정을 모듈 스코프에 캐시한다. 먼저 계산된 값은 이후 스텁을 무시한다.
 * - 그래서 `vi.resetModules()` + 동적 import로 독립된 모듈 인스턴스를 쓴다(`runtime-support.test.ts`와 같은 이유).
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

test("wasm 미지원이면 격리 여부와 무관하게 worker 없이 unsupported이고 run은 unavailable로 거부된다", async () => {
  vi.resetModules();
  const { createRunner } = await import("../../src/session/runner");
  const createWorker = vi.fn();
  const statuses: string[] = [];

  const runner = createRunner({
    createWorker,
    onOutput: () => {},
    onStatus: (status) => statuses.push(status),
  });

  expect(createWorker).not.toHaveBeenCalled();
  expect(statuses).toEqual(["unsupported"]);
  expect(runner.status).toBe("unsupported");
  await expect(runner.run("1")).rejects.toMatchObject({
    name: "RunRejectedError",
    reason: "unavailable",
  });
  await expect(runner.stop()).resolves.toBe("idle");
  runner.reset();
  runner.interrupt();
  expect(createWorker).not.toHaveBeenCalled();

  runner.dispose();
});
