/**
 * worker 쪽 브리지 핸들. `bridge()`가 돌려주는 값이다. coincident가 함께 돌려주는 `ffi`(임의 코드 평가 등)는 CSP 때문에
 * 노출하지 않는다.
 */
export interface WorkerBridge {
  /** main이 `worker.proxy`에 등록한 함수들(`native`면 동기 호출). 시험용 훅·앱 고유 함수 노출에 쓴다. */
  proxy: Record<string, unknown>;
  /** main `window`의 원격 프록시(guard 없음). Python에는 `guardedWindow`로 감싸 넘긴다. */
  window: Window & typeof globalThis;
  /** 동기 DOM 호출이 되는 환경인가. `false`면 `domBridge()`가 명시 오류로 실패한다. */
  native: boolean;
}
