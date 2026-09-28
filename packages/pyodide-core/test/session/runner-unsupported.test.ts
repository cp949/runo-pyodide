// @vitest-environment node
/**
 * `createRunner`의 `unsupported`(`detectRuntimeSupport()` wasm 미지원, DELTA-05) 분기만 따로 본다. `runner.test.ts`의
 * 나머지 시험은 실제 Node `WebAssembly.validate`(참)를 공유 모듈 인스턴스로 쓰므로, `WebAssembly.validate`를 거짓으로
 * 바꾸려면 `vi.resetModules()` + 동적 import로 이 파일만 독립된 모듈 인스턴스를 써야 한다(`../runtime-support.ts`의
 * wasm 지원 캐시가 파일 안에서 먼저 계산되면 이후 스텁이 반영되지 않는다 — `runtime-support.test.ts`와 같은 이유).
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
