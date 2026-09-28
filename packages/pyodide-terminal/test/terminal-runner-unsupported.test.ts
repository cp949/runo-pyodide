// @vitest-environment node
/**
 * `createTerminalRunner`의 `unsupported`(`detectRuntimeSupport()` wasm 미지원, `docs/adr/0008-chrome84-build-floor-and-pyodide-runtime-floor.md`) 분기만 따로 본다. 나머지
 * `terminal-runner*.test.ts`는 jsdom 환경에서 core `createRunner`를 실제로 붙이며 모듈을 공유하므로, `WebAssembly.validate`를
 * 거짓으로 바꾸려면 `vi.resetModules()` + 동적 import로 이 파일만 독립된 모듈 인스턴스를 써야 한다(`pyodide-core/test/session/runner-unsupported.test.ts`·
 * `pyodide-repl/test/create-repl/unsupported.test.ts`와 같은 이유). `@vitest-environment node`도 같은 이유(jsdom 파일과 워커를
 * 공유하면 몽키패치가 샌다) — `createFakeTerminal`은 `withElement`를 안 쓰므로 `document`가 필요 없다.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createFakeTerminal } from "@repo/pyodide-testkit/fake-terminal";

const originalValidate = WebAssembly.validate;

beforeEach(() => {
  // 격리 여부와 무관하게 unsupported여야 한다(판정 순서: wasm 먼저) — 참으로 둬서 이 순서를 증명한다.
  vi.stubGlobal("crossOriginIsolated", true);
  WebAssembly.validate = () => false;
});

afterEach(() => {
  WebAssembly.validate = originalValidate;
  vi.unstubAllGlobals();
  vi.resetModules();
});

test("wasm 미지원이면 격리 여부와 무관하게 worker 없이 unsupported 안내를 노랑으로 내고 run은 unavailable로 거부된다", async () => {
  vi.resetModules();
  const { createTerminalRunner } = await import("../src/terminal-runner");
  const fake = createFakeTerminal();
  const createWorker = vi.fn(() => {
    throw new Error("unsupported에서는 worker를 만들면 안 된다");
  });
  const onStatus = vi.fn();

  const handle = createTerminalRunner({
    terminal: fake.term,
    createWorker,
    onStatus,
  });

  expect(createWorker).not.toHaveBeenCalled();
  expect(handle.status).toBe("unsupported");
  expect(onStatus).toHaveBeenCalledWith("unsupported");
  expect(fake.written).toHaveLength(1);
  expect(fake.written[0]).toContain("\x1b[33m");
  expect(fake.written[0]).toContain("지원하지 않아");
  await expect(handle.run("1")).rejects.toMatchObject({
    name: "RunRejectedError",
    reason: "unavailable",
  });
  expect(createWorker).not.toHaveBeenCalled();
  handle.dispose();
});
