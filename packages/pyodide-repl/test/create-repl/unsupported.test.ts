// @vitest-environment node
/**
 * `createRepl`의 `unsupported`(`detectRuntimeSupport()` wasm 미지원, `docs/adr/0008-chrome84-build-floor-and-pyodide-runtime-floor.md`) 분기만 따로 본다. 다른 `create-repl/*.test.ts`는
 * `useReplHarness()`로 `createRepl`을 최상위에서 정적 import해 core의 wasm 지원 캐시를 공유하므로, `WebAssembly.validate`를 거짓으로
 * 바꾸려면 `vi.resetModules()` + 동적 import로 이 파일만 독립된 모듈 인스턴스를 써야 한다(`pyodide-core/test/session/runner-unsupported.test.ts`와
 * 같은 이유). `@vitest-environment node`도 core와 같은 이유로 둔다 — jsdom 환경 파일들과 워커/컨텍스트를 공유하면 이 파일의
 * `WebAssembly.validate` 몽키패치가 다른 파일로 샌다(실측: environment 지시 없이 실행하면 `session-start.test.ts`의 비격리 페이지
 * 시험이 깨진다). `createFakeTerminal`은 `withElement`를 안 쓰므로 `document`가 필요 없어 node 환경에서도 동작한다.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createFakeTerminal } from "@repo/pyodide-testkit/fake-terminal";
import { createFakeWorker } from "./harness";

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

test("wasm 미지원이면 격리 여부와 무관하게 worker 없이 unsupported 경고를 내고 runSource는 unavailable로 거부된다", async () => {
  vi.resetModules();
  const { createRepl, UNSUPPORTED_BROWSER_WARNING } = await import(
    "../../src/index"
  );
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
