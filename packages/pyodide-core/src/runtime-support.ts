/**
 * 빌드 floor(Chrome 84) ≤ 브라우저 < 런타임 floor(pyodide가 요구하는 wasm 기능) 구간을 명시적으로 구분한다
 * (`docs/adr/0008-chrome84-build-floor-and-pyodide-runtime-floor.md` 결정 3). `crossOriginIsolated` 직접 판정을
 * 쓰던 자리(`createRunner`·`createRepl`·`createTerminalRunner`·`isDomBridgeSupported` 등)가 이 함수로 바뀐다 —
 * 판정 순서는 이 함수 하나가 소유한다(규칙 정의: `docs/design/14-runner.md` 14.3.1).
 */

/**
 * reference types + legacy Wasm 예외 처리를 한 번에 판정하는 최소 wasm 모듈:
 * `(module (func (param externref) try catch_all end))`. pyodide 314.0.7의 wasm이 요구하는 두 기능(런타임 floor
 * 정적 판정 Chrome 96, ADR-0008 "런타임 floor: 정적 판정과 실측") 중 `WebAssembly.validate`로 정적 판정 가능한
 * 것만 담는다 — Node 24.21.0에서 `--no-experimental-wasm-legacy-eh`로 `false`가 나오는 것으로 검증했다. pyodide
 * 업그레이드 시 재검증 절차는 `docs/design/13-version-upgrade.md` "런타임 floor 탐지 바이트 재검증".
 */
const WASM_RUNTIME_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x01, 0x6f, 0x00, // type: (externref) -> ()
  0x03, 0x02, 0x01, 0x00, //                   func 0: type 0
  0x0a, 0x08, 0x01, 0x06, 0x00, //             code: 1 body, size 6, 0 locals
  0x06, 0x40, 0x19, 0x0b, 0x0b, //             try(void) catch_all end end
]);

export type RuntimeSupport = "supported" | "unsupported" | "not-isolated";

/**
 * wasm 기능 지원 여부만 캐시한다(`crossOriginIsolated`는 캐시하지 않는다). 근거: 둘 다 페이지 수명 동안 바뀌지 않는
 * 값이지만, `WebAssembly.validate()`만 실제로 계산 비용이 있다 — `crossOriginIsolated` 읽기는 속성 접근
 * 하나라 캐시할 이유가 없고, 캐시하면 이 저장소 전역에서 이미 자리 잡은 시험 패턴(`vi.stubGlobal("crossOriginIsolated",
 * ...)`로 테스트마다 격리 여부를 바꾸는 것, 14개 시험 파일이 쓴다)이 모듈 스코프 캐시에 막혀 깨진다(2026-09-28 실측:
 * `runner.test.ts` 등에서 이 값을 캐시하면 첫 호출의 값이 파일의 나머지 시험에 고정돼 버렸다).
 */
let wasmSupportCache: boolean | undefined;

function checkWasmSupport(): boolean {
  try {
    return (
      typeof WebAssembly === "object" &&
      WebAssembly.validate(WASM_RUNTIME_PROBE)
    );
  } catch {
    // 예외를 던지지 않는다(계약) — 판정 자체가 실패하면 미지원으로 본다.
    return false;
  }
}

/**
 * 실행 가능 여부를 판정한다. 예외를 던지지 않는다.
 *
 * 순서 근거(`docs/design/14-runner.md` 14.3.1): Chrome 84는 `crossOriginIsolated` 속성 자체가 없다(87+에 생긴다). ②를
 * 먼저 보면 "헤더를 고치라"는 틀린 안내가 된다. 브라우저 버전이 근본 원인이므로 wasm 판정이 먼저다. Chrome 92~95는
 * 격리돼도 wasm이 컴파일되지 않는다(93만 실측 확인, 92·94·95는 pyodide 314가 요구하는 wasm 기능별 최초 지원 버전
 * 표에서 정적으로 추정한 범위 — reftypes 96·legacy EH 95·`Object.hasOwn` 93·COI/SAB 게이팅 92).
 */
export function detectRuntimeSupport(): RuntimeSupport {
  wasmSupportCache ??= checkWasmSupport();
  if (!wasmSupportCache) return "unsupported";
  if (globalThis.crossOriginIsolated !== true) return "not-isolated";
  return "supported";
}
