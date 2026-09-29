// @vitest-environment node
/**
 * `detectRuntimeSupport()`의 판정표를 고정한다.
 * - 결정: `docs/adr/0008-chrome84-build-floor-and-pyodide-runtime-floor.md`
 * - 규칙 정의: `docs/design/14-runner.md` 14.3.1
 * - `WebAssembly.validate`와 `crossOriginIsolated`를 스텁해 세 결과(`supported`·`not-isolated`·`unsupported`)를 각각 재현한다.
 * - wasm 판정이 모듈 스코프에 캐시된다. 시험마다 `vi.resetModules()` + 동적 import로 새 인스턴스를 만든다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// 시험이 바꾸는 전역의 원래 값. `afterEach`에서 복원한다.
const originalValidate = WebAssembly.validate;
const hadIsolated = Object.prototype.hasOwnProperty.call(
  globalThis,
  "crossOriginIsolated",
);
const originalIsolated = (globalThis as { crossOriginIsolated?: boolean })
  .crossOriginIsolated;

/**
 * `globalThis.crossOriginIsolated`를 `value`로 바꾼다. `undefined`면 프로퍼티를 지운다(속성이 없는 환경 재현).
 */
function setIsolated(value: boolean | undefined): void {
  if (value === undefined) {
    delete (globalThis as { crossOriginIsolated?: boolean })
      .crossOriginIsolated;
    return;
  }
  Object.defineProperty(globalThis, "crossOriginIsolated", {
    value,
    configurable: true,
    writable: true,
  });
}

/**
 * 모듈 캐시를 비우고 `detectRuntimeSupport`를 새로 import한다. 시험마다 wasm 판정 캐시가 비어 있게 한다.
 */
async function loadDetectRuntimeSupport() {
  vi.resetModules();
  const module = await import("../src/runtime-support");
  return module.detectRuntimeSupport;
}

afterEach(() => {
  WebAssembly.validate = originalValidate;
  if (hadIsolated) setIsolated(originalIsolated);
  else setIsolated(undefined);
  vi.resetModules();
});

describe("detectRuntimeSupport", () => {
  it("WebAssembly.validate가 false면 격리 여부와 무관하게 unsupported다", async () => {
    WebAssembly.validate = () => false;
    setIsolated(true);

    const detectRuntimeSupport = await loadDetectRuntimeSupport();

    expect(detectRuntimeSupport()).toBe("unsupported");
  });

  it("WebAssembly.validate가 false면 비격리에서도 unsupported다(not-isolated가 아니다)", async () => {
    WebAssembly.validate = () => false;
    setIsolated(false);

    const detectRuntimeSupport = await loadDetectRuntimeSupport();

    expect(detectRuntimeSupport()).toBe("unsupported");
  });

  it("validate true + 비격리면 not-isolated다", async () => {
    WebAssembly.validate = () => true;
    setIsolated(false);

    const detectRuntimeSupport = await loadDetectRuntimeSupport();

    expect(detectRuntimeSupport()).toBe("not-isolated");
  });

  it("validate true + 격리면 supported다", async () => {
    WebAssembly.validate = () => true;
    setIsolated(true);

    const detectRuntimeSupport = await loadDetectRuntimeSupport();

    expect(detectRuntimeSupport()).toBe("supported");
  });

  it('typeof WebAssembly !== "object"면 unsupported다', async () => {
    const original = globalThis.WebAssembly;
    // @ts-expect-error 테스트 전용으로 전역을 지운다.
    delete globalThis.WebAssembly;
    setIsolated(true);

    try {
      const detectRuntimeSupport = await loadDetectRuntimeSupport();
      expect(detectRuntimeSupport()).toBe("unsupported");
    } finally {
      globalThis.WebAssembly = original;
    }
  });

  it("WebAssembly.validate가 던지면 unsupported다(예외를 던지지 않는다는 계약)", async () => {
    WebAssembly.validate = () => {
      throw new Error("boom");
    };
    setIsolated(true);

    const detectRuntimeSupport = await loadDetectRuntimeSupport();

    expect(() => detectRuntimeSupport()).not.toThrow();
    expect(detectRuntimeSupport()).toBe("unsupported");
  });

  it("실제 바이트는 Node(WebAssembly 네이티브)에서 true다(감지 바이트 자체의 유효성)", async () => {
    setIsolated(true);

    const detectRuntimeSupport = await loadDetectRuntimeSupport();

    expect(detectRuntimeSupport()).toBe("supported");
  });

  it("모듈 스코프에서 1회만 계산하고 캐시한다(두 번째 호출은 validate를 다시 부르지 않는다)", async () => {
    let calls = 0;
    WebAssembly.validate = () => {
      calls += 1;
      return true;
    };
    setIsolated(true);

    const detectRuntimeSupport = await loadDetectRuntimeSupport();
    detectRuntimeSupport();
    detectRuntimeSupport();

    expect(calls).toBe(1);
  });

  it("wasm 판정만 캐시하고 격리 여부는 매번 새로 읽는다(같은 인스턴스에서 격리 값이 바뀌면 결과도 바뀐다)", async () => {
    let calls = 0;
    WebAssembly.validate = () => {
      calls += 1;
      return true;
    };
    setIsolated(false);

    const detectRuntimeSupport = await loadDetectRuntimeSupport();

    expect(detectRuntimeSupport()).toBe("not-isolated");
    setIsolated(true);
    expect(detectRuntimeSupport()).toBe("supported");
    expect(calls).toBe(1);
  });
});
