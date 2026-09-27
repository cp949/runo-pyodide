/**
 * 실행 driver 옵션(초기화 프레임 `driver` 필드의 내용, 01-protocols.md 4절). main 쪽이 싣고 worker 쪽 `runDriver`가 검증한다.
 * 두 쪽이 같은 타입·파서를 쓰도록 worker 코드(`?raw` Python 포함)와 분리해 둔다. 옵션이 틀린 worker는 `ready`도 `loadFailed`도
 * 알리지 않고 부팅이 거부되므로(`bootWorker`) main은 worker를 만들기 전에 같은 파서로 먼저 검증해야 한다.
 */
export interface RunDriverOptions {
  /** 트레이스백에 나타나는 소스 이름이자 콘솔 `filename`. SIGINT 규칙 ①이 이 이름과 프레임 파일명의 일치에 의존한다(TRP-020). */
  filename: string;
  /** `true`일 때만 모듈 최상위 `await`를 허용한다. */
  topLevelAwait: boolean;
}

/** `filename`을 주지 않았을 때 이름(CPython 스크립트 예시의 관례). */
export const DEFAULT_RUN_FILENAME = "main.py";

/**
 * `frame.driver`를 검증한다. 값은 객체여야 하고 두 필드는 생략할 수 있다(`undefined` = 생략). 생략하면 `filename`은
 * `"main.py"`, `topLevelAwait`는 `false`다. 있는데 타입이 틀리면(`null` 포함) 어느 필드가 왜 틀렸는지 담은 오류를 던진다.
 * 알 수 없는 필드는 무시한다.
 */
export function parseRunDriverOptions(raw: unknown): RunDriverOptions {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("실행 driver 옵션 오류 — driver: 객체 필요");
  }
  const { filename, topLevelAwait } = raw as {
    filename?: unknown;
    topLevelAwait?: unknown;
  };
  if (
    filename !== undefined &&
    (typeof filename !== "string" || filename === "")
  ) {
    throw new Error(
      "실행 driver 옵션 오류 — filename: 비어 있지 않은 문자열 필요",
    );
  }
  if (topLevelAwait !== undefined && typeof topLevelAwait !== "boolean") {
    throw new Error("실행 driver 옵션 오류 — topLevelAwait: boolean 필요");
  }
  return {
    filename: filename ?? DEFAULT_RUN_FILENAME,
    topLevelAwait: topLevelAwait ?? false,
  };
}
