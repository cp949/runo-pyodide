/**
 * `ready` 알림 페이로드(01-protocols.md 1.2). worker가 부팅 때 한 번 탐지한 pyodide 호환 결과를 main에 알린다.
 * `versionMismatch`는 로드된 `pyodide.version`과 core 고정 버전(`PYODIDE_VERSION`)의 **완전 일치** 비교다(부분 일치·범위 없음).
 * `degraded`는 비공개 API 지점 중 기대와 달라 해당 기능만 꺼진 식별자다. 시작 거부(interrupt 공개 API 부재)는 여기 오지 않고
 * `loadFailed`가 된다. 공개 API로 노출하지 않는 내부 계약이다(정책 Q16).
 */

export interface ReadyPayload {
  /** worker가 로드한 pyodide의 `version`(실제 값). */
  pyodideVersion: string;
  /** `pyodideVersion`이 core 고정 버전과 다르다. */
  versionMismatch: boolean;
  /** 저하된 지점의 식별자(처음 보고한 순서, 중복 없음). 문제가 없으면 빈 배열. */
  degraded: string[];
  /** 식별자별 상세 이름(`pyodide.ffi.run_sync` 등). 상세가 하나도 없으면 이 키 자체가 없다. */
  details?: Record<string, string[]>;
}

export interface ReadyPayloadInput {
  /** 로드된 `pyodide.version`. */
  actual: string;
  /** core 고정 버전. */
  expected: string;
  degraded: readonly string[];
  details?: Record<string, string[]>;
}

/** `ready` 페이로드를 만든다. `details`는 있을 때만 싣는다. */
export function createReadyPayload(input: ReadyPayloadInput): ReadyPayload {
  const payload: ReadyPayload = {
    pyodideVersion: input.actual,
    versionMismatch: input.actual !== input.expected,
    degraded: [...input.degraded],
  };
  if (input.details) payload.details = input.details;
  return payload;
}
