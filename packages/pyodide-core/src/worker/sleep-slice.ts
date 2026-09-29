/**
 * `time.sleep` 20ms 조각 교체(03-ctrl-c.md 2.4의 "`time.sleep` 20ms 조각").
 * pyodide는 `time.sleep`을 `run_sync(asyncio.sleep(t))`로 바꿔 둔다(JSPI가 없으면 원본 블로킹).
 * - sleep 중 이벤트 루프가 다른 콜백을 돌린다.
 * - JSPI가 없으면 `time.sleep(5)`를 끝까지 못 끊는다.
 *
 * 원본 C 함수(`time.sleep.__wrapped__`)를 20ms 조각으로 나눠 조각마다 `pyodide_js.checkInterrupt()`를 부른다.
 * 그러면 사용자 스택이 정지하지 않은 채 SIGINT 핸들러가 `time.sleep` 호출 지점에서 `KeyboardInterrupt`를 올린다.
 *
 * `attachRuntime`이 SIGINT 핸들러 설치 **전에** 부른다.
 * 돌려받은 코드 객체 tuple을 `installSigintHandler`의 `extraOwnCodes`로 넘긴다. 트레이스백에서 우리 프레임이 잘린다.
 */
import type { PyodideInterface } from "pyodide";
import type { PyProxy } from "pyodide/ffi";
import type { ReportDegraded } from "./compat";
import SLEEP_SLICE_SOURCE from "./sleep-slice.py?raw";

export interface SleepSliceDeps {
  /** 설치를 건너뛰게 한 어긋난 이름마다 `("sleep-slice", 이름)`으로 불린다. boot.ts가 수집기를 넣는다. */
  report: ReportDegraded;
}

/** 조각 래퍼 소스의 Python 파일명. 트레이스백에 새면 알아보기 위한 이름이다. 절단은 코드 객체로 한다. */
export const SLEEP_SLICE_FILENAME = "<sleep-slice>";

/**
 * `time.sleep`을 20ms 조각 + `checkInterrupt()` 폴링 래퍼로 바꾼다.
 * 돌려주는 proxy는 우리 코드 객체 tuple(`sleep`·`poll`)이다.
 * 호출자가 `installSigintHandler`의 `extraOwnCodes`로 넘긴 뒤 destroy한다.
 * pyodide 내부가 기대와 다르면 `report` 후 `undefined`(교체하지 않는다). 세션당 1회, 동기 함수.
 */
export function installSleepSlice(
  pyodide: Pick<PyodideInterface, "runPython" | "toPy">,
  deps: SleepSliceDeps,
): PyProxy | undefined {
  // 별도 namespace(빈 dict)에서 정의해 사용자 globals를 오염시키지 않는다. 래퍼 함수는 `time.sleep`이 붙잡는다.
  const namespace = pyodide.toPy({}) as PyProxy & {
    get(name: string): unknown;
  };
  try {
    pyodide.runPython(SLEEP_SLICE_SOURCE, {
      globals: namespace,
      filename: SLEEP_SLICE_FILENAME,
    });
    const install = namespace.get("install") as PyProxy &
      ((report: ReportDegraded) => PyProxy | undefined);
    try {
      // 어느 가정이 어긋났는지는 Python 쪽이 이름별로 report한다.
      return install(deps.report) ?? undefined;
    } finally {
      install.destroy();
    }
  } finally {
    namespace.destroy();
  }
}
