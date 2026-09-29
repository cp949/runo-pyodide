// @vitest-environment node
/**
 * `createRepl`의 `unsupported` 분기 시험.
 * - 조건: `detectRuntimeSupport()`가 wasm 미지원으로 판정한다(`docs/adr/0008-chrome84-build-floor-and-pyodide-runtime-floor.md`).
 *
 * 이 파일만 따로 두는 이유:
 * - 다른 `create-repl/*.test.ts`는 `useReplHarness()`로 `createRepl`을 최상위에서 정적 import한다. core의 wasm 지원 캐시를 공유한다.
 * - `WebAssembly.validate`를 거짓으로 바꾸려면 `vi.resetModules()` + 동적 import로 독립된 모듈 인스턴스가 필요하다.
 * - `pyodide-core/test/session/runner-unsupported.test.ts`와 같은 이유다.
 *
 * `@vitest-environment node`를 두는 이유:
 * - core와 같다. jsdom 환경 파일들과 워커·컨텍스트를 공유하면 이 파일의 `WebAssembly.validate` 몽키패치가 다른 파일로 샌다.
 * - 실측: environment 지시 없이 실행하면 `session-start.test.ts`의 비격리 페이지 시험이 깨진다.
 * - `createFakeTerminal`은 `withElement`를 안 쓴다. `document`가 필요 없어 node 환경에서도 동작한다.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createFakeTerminal } from "@repo/pyodide-testkit/fake-terminal";
import { createFakeWorker } from "./harness";

/** 시험이 덮어쓰기 전의 `WebAssembly.validate`. `afterEach`가 복원한다. */
const originalValidate = WebAssembly.validate;

beforeEach(() => {
  // 격리 여부와 무관하게 unsupported여야 한다(판정 순서: wasm 먼저).
  // 격리를 참으로 둬서 이 순서를 증명한다.
  vi.stubGlobal("crossOriginIsolated", true);
  WebAssembly.validate = () => false;
});

afterEach(() => {
  WebAssembly.validate = originalValidate;
  vi.unstubAllGlobals();
  vi.resetModules();
});

test("wasm 미지원이면 격리 여부와 무관하게 worker 없이 unsupported 경고를 내고 runSource는 unavailable로 거부된다", async () => {
  vi.resetModules();
  const { createRepl, UNSUPPORTED_BROWSER_WARNING } =
    await import("../../src/index");
  const fake = createFakeTerminal();
  const createWorkerSpy = vi.fn(() => createFakeWorker().worker);
  const onStatus = vi.fn();

  const handle = createRepl({
    terminal: fake.term,
    createWorker: createWorkerSpy,
    onStatus,
  });

  expect(createWorkerSpy).not.toHaveBeenCalled();
  expect(onStatus.mock.calls).toEqual([["unsupported"]]);
  expect(fake.written.join("")).toContain(
    `\x1b[33m${UNSUPPORTED_BROWSER_WARNING}\x1b[0m\r\n`,
  );
  expect(handle.crossOriginIsolated).toBe(true);
  await expect(handle.runSource("1")).rejects.toMatchObject({
    reason: "unavailable",
  });
  expect(() => {
    handle.dispose();
    handle.dispose();
  }).not.toThrow();
});
