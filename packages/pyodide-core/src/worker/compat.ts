/**
 * pyodide 호환 탐지 보조(RD-021).
 * worker 부팅이 비공개 API 지점을 한 번 탐지해 `ready` 페이로드로 알린다. 쓰는 것은 두 가지다.
 * - 저하 지점 수집기
 * - interrupt 공개 API 확인
 *
 * 지점 식별자 6개(`13-version-upgrade.md`) 중 core가 내는 4개의 이름이 여기 있다.
 * REPL이 내는 2개(`compiler-flags`·`incomplete-input-message`)는 driver `probe`가 문자열로 돌려준다.
 */

/** core 지점의 저하 식별자. `run-sync`는 `pyodide.ffi.run_sync`·`pyodide.webloop.run_sync`·`console.runcode` 셋을 묶는다. */
export type CoreDegradedId =
  "webloop-handlers" | "run-sync" | "sleep-slice" | "webloop-filename";

/** 기대와 다른 지점을 알린다. `detail`은 어긋난 이름(`pyodide.ffi.run_sync` 등)이다. 경고 본문에만 쓰인다. */
export type ReportDegraded = (id: CoreDegradedId, detail: string) => void;

/** 저하 지점 수집기. 식별자는 처음 보고한 순서로 모으고 중복을 없앤다. */
export interface DegradedCollector {
  /** 설치 함수가 부른다(`ReportDegraded`). */
  report: ReportDegraded;

  /** driver `probe`가 돌려준 식별자를 상세 없이 더한다. */
  addIds(ids: readonly string[]): void;

  /** 식별자(처음 보고한 순서, 중복 없음) */
  degraded(): string[];

  /** 식별자별 상세. 상세가 하나도 없으면 `undefined`. */
  details(): Record<string, string[]> | undefined;
}

/** 빈 저하 지점 수집기를 만든다. 부팅마다 하나 쓴다. */
export function createDegradedCollector(): DegradedCollector {
  // Map은 삽입 순서를 유지한다. 값은 그 식별자의 상세 목록(없을 수 있다).
  const entries = new Map<string, string[]>();
  const ensure = (id: string) => {
    let details = entries.get(id);
    if (!details) {
      details = [];
      entries.set(id, details);
    }
    return details;
  };
  return {
    report(id, detail) {
      const details = ensure(id);
      if (!details.includes(detail)) details.push(detail);
    },
    addIds(ids) {
      for (const id of ids) ensure(id);
    },
    degraded: () => [...entries.keys()],
    details() {
      const withDetails = [...entries].filter(([, list]) => list.length > 0);
      if (withDetails.length === 0) return undefined;
      return Object.fromEntries(
        withDetails.map(([id, list]) => [id, [...list]]),
      );
    },
  };
}

/** Ctrl+C 연결이 쓰는 pyodide 공개 API. 없으면 중단이 성립하지 않는다. 시작을 거부한다(`degraded`가 아니다). */
const INTERRUPT_API_NAMES = ["setInterruptBuffer", "checkInterrupt"] as const;

/** 없는(함수가 아닌) interrupt 공개 API 이름. 비어 있으면 시작해도 된다. */
export function findMissingInterruptApi(pyodide: object): string[] {
  return INTERRUPT_API_NAMES.filter(
    (name) => typeof (pyodide as Record<string, unknown>)[name] !== "function",
  );
}
