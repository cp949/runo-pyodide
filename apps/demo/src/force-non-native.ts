/**
 * `native: false`를 Chromium에서 강제하는 시험 훅(RD-023).
 *
 * 왜 이 방식인가(TRP-066):
 * - coincident의 `native`는 옵션이 아니라 모듈 평가 시점 탐지다.
 * - `new SharedArrayBuffer(4, { maxByteLength: 8 })`(growable)이 성공하는가로 정해진다.
 * - 그래서 coincident보다 먼저 평가돼야 한다.
 * - main과 worker 두 realm 모두에서 가려야 한다. 한쪽만 가리면 두 realm의 `native`가 어긋난다.
 *
 * realm별 첫 import:
 * - 창(main): `DomBridgeView.tsx`. 쿼리 `?native=0`일 때만 가린다.
 * - worker: `dom-bridge-native0.worker.ts`. 이 worker는 `?native=0`일 때만 만들어지므로 무조건 가린다.
 *
 * growable 옵션 없는 고정 크기 `new SharedArrayBuffer(n)`(core의 stdin·interrupt 버퍼)은 그대로 통과시킨다.
 */
const inWindow = typeof window !== "undefined";
const forced = inWindow
  ? new URLSearchParams(location.search).get("native") === "0"
  : true;

if (forced) {
  const Original = globalThis.SharedArrayBuffer;
  globalThis.SharedArrayBuffer = new Proxy(Original, {
    construct(target, args, newTarget) {
      const options = args[1] as { maxByteLength?: number } | undefined;
      if (options !== undefined && "maxByteLength" in options)
        throw new TypeError(
          "growable SharedArrayBuffer 강제 비활성(native: false 시험 훅)",
        );
      return Reflect.construct(
        target,
        args,
        newTarget === undefined ? target : newTarget,
      );
    },
  });
}

/** 이 realm에서 growable SharedArrayBuffer를 가렸는가 */
export const forcedNonNative = forced;
