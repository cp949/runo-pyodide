// @vitest-environment node
/**
 * `createTerminalRunner`의 `unsupported` 분기만 따로 보는 시험.
 * - 분기 조건: `detectRuntimeSupport()`가 wasm 미지원으로 판정한다(`docs/adr/0008-chrome84-build-floor-and-pyodide-runtime-floor.md`).
 * - 나머지 `terminal-runner*.test.ts`는 jsdom에서 core `createRunner`를 실제로 붙이고 모듈을 공유한다.
 * - `WebAssembly.validate`를 거짓으로 바꾸면 그 파일들에 영향이 간다.
 * - 그래서 이 파일만 `vi.resetModules()` + 동적 import로 독립된 모듈 인스턴스를 쓴다.
 * - `@vitest-environment node`도 같은 이유다. jsdom 파일과 워커를 공유하면 몽키패치가 샌다.
 * - `createFakeTerminal`은 `withElement`를 쓰지 않으므로 `document`가 필요 없다.
 *
 * 같은 구조의 시험:
 * - `pyodide-core/test/session/runner-unsupported.test.ts`
 * - `pyodide-repl/test/create-repl/unsupported.test.ts`
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createFakeTerminal } from "@repo/pyodide-testkit/fake-terminal";

const originalValidate = WebAssembly.validate;

beforeEach(() => {
  // 판정 순서는 wasm이 먼저다. 격리를 참으로 둬서 격리 여부와 무관하게 unsupported가 되는지 본다.
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
