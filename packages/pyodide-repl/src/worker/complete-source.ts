/**
 * worker 쪽 Tab 완성 헬퍼 로더(RD-015, docs/design/01-protocols.md 1.2).
 * - 본체는 complete-source.py(`.py?raw`)다.
 * - 별도 namespace에서 실행한다. 사용자 globals를 오염시키지 않는다(`console.ts`·`multiline.ts`와 같은 패턴).
 * - 모듈 완성(RD-016)은 이 파일이 아니라 `.py`의 모듈 분기가 맡는다.
 */
import type { PyodideInterface } from "pyodide";
import type { PyProxy } from "pyodide/ffi";
import type { PyodideConsoleProxy } from "./console";
import COMPLETE_SOURCE from "./complete-source.py?raw";

/** `complete_source`가 후처리한 결과. `start`는 코드포인트 인덱스 그대로(Python `str` 인덱스)다. */
export interface SourceCompletion {
  /** 완성 후보 목록 */
  completions: string[];

  /** 후보가 바꿀 구간의 시작 인덱스. 코드포인트 기준이다. */
  start: number;
}

/**
 * Tab 완성 함수. `source` 끝(커서 자리)의 후보를 돌려준다.
 * `pending`은 `... ` 블록의 이전 줄들(`\n`으로 이음)이다.
 * 모듈 완성기에는 `pending + '\n' + source`를 넣는다(RD-016).
 */
export type CompleteSource = (
  source: string,
  pending: string | undefined,
) => SourceCompletion;

/** 완성 소스의 Python 파일명. 트레이스백(`KeyboardInterrupt` 전파 등)에 새면 알아보기 위한 이름이다. */
export const COMPLETE_SOURCE_FILENAME = "<complete-source>";

/**
 * 완성 헬퍼를 별도 namespace에 올려 `CompleteSource`를 만든다. 세션마다 한 번 부른다. 동기 함수다.
 * 돌려준 함수는 호출마다 Python 결과 proxy를 `destroy()`한다.
 */
export function loadCompleteSource(
  pyodide: Pick<PyodideInterface, "runPython" | "toPy">,
  pyconsole: PyodideConsoleProxy,
): CompleteSource {
  // 별도 namespace(빈 dict)에서 정의해 사용자 globals를 오염시키지 않는다.
  const namespace = pyodide.toPy({}) as PyProxy & {
    get(name: string): unknown;
  };
  pyodide.runPython(COMPLETE_SOURCE, {
    globals: namespace,
    filename: COMPLETE_SOURCE_FILENAME,
  });
  const completeSource = namespace.get("complete_source") as (
    console: PyodideConsoleProxy,
    source: string,
    pending: string | undefined,
  ) => PyProxy;
  namespace.destroy();
  return (source, pending) => {
    const result = completeSource(pyconsole, source, pending);
    try {
      const [completions, start] = result.toJs() as [string[], number];
      return { completions, start };
    } finally {
      result.destroy();
    }
  };
}
