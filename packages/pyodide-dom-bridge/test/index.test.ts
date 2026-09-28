/**
 * main 진입점: `createBridgeMain()`은 coincident main을 옵션 없이 한 번만 부르고 `{ Worker, native }`만 돌려준다.
 * `isDomBridgeSupported()`는 `crossOriginIsolated === true`와 growable `SharedArrayBuffer` 생성 성공, 두 조건을 모두 본다
 * (coincident가 `native`를 정하는 조건과 같다). UA 판별은 하지 않는다.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => {
  class FakeWorker {}
  return {
    FakeWorker,
    coincidentMain: vi.fn(() => ({
      Worker: FakeWorker,
      native: true,
      transfer: () => [],
      ffi: { evaluate: () => "위험" },
    })),
  };
});

vi.mock("@cp949/runo-coincident/window/main", () => ({ default: fake.coincidentMain }));

async function loadIndex() {
  vi.resetModules();
  return import("../src/index");
}

beforeEach(() => {
  fake.coincidentMain.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createBridgeMain", () => {
  test("coincident main을 옵션 없이 한 번만 부르고 여러 번 불러도 같은 결과를 돌려준다", async () => {
    const { createBridgeMain } = await loadIndex();

    const a = createBridgeMain();
    const b = createBridgeMain();

    expect(fake.coincidentMain).toHaveBeenCalledTimes(1);
    expect(fake.coincidentMain).toHaveBeenCalledWith();
    expect(b).toBe(a);
  });

  test("Worker와 native만 노출한다", async () => {
    const { createBridgeMain } = await loadIndex();

    const bridge = createBridgeMain();

    expect(Object.keys(bridge).sort()).toEqual(["Worker", "native"]);
    expect(bridge.Worker).toBe(fake.FakeWorker);
    expect(bridge.native).toBe(true);
  });

  test("모듈을 불러오는 것만으로는 coincident를 호출하지 않는다", async () => {
    await loadIndex();

    expect(fake.coincidentMain).not.toHaveBeenCalled();
  });
});

describe("isDomBridgeSupported", () => {
  /** 생성 옵션 `maxByteLength`를 받으면 성공하는(또는 던지는) SharedArrayBuffer 가짜. */
  function stubSharedArrayBuffer(growable: boolean) {
    vi.stubGlobal(
      "SharedArrayBuffer",
      class {
        constructor(_length: number, options?: { maxByteLength?: number }) {
          if (!growable && options?.maxByteLength !== undefined)
            throw new TypeError("growable 미지원");
        }
      },
    );
  }

  test("격리돼 있지 않으면 false다(growable SAB가 되더라도)", async () => {
    vi.stubGlobal("crossOriginIsolated", false);
    stubSharedArrayBuffer(true);
    const { isDomBridgeSupported } = await loadIndex();

    expect(isDomBridgeSupported()).toBe(false);
  });

  test("growable SharedArrayBuffer 생성이 던지면 false다(격리돼 있더라도)", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    stubSharedArrayBuffer(false);
    const { isDomBridgeSupported } = await loadIndex();

    expect(isDomBridgeSupported()).toBe(false);
  });

  test("SharedArrayBuffer가 아예 없으면 false다", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    vi.stubGlobal("SharedArrayBuffer", undefined);
    const { isDomBridgeSupported } = await loadIndex();

    expect(isDomBridgeSupported()).toBe(false);
  });

  test("두 조건이 모두 참이면 true다", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    stubSharedArrayBuffer(true);
    const { isDomBridgeSupported } = await loadIndex();

    expect(isDomBridgeSupported()).toBe(true);
  });

  test("이 판정은 coincident를 호출하지 않는다", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    stubSharedArrayBuffer(true);
    const { isDomBridgeSupported } = await loadIndex();

    isDomBridgeSupported();

    expect(fake.coincidentMain).not.toHaveBeenCalled();
  });
});
