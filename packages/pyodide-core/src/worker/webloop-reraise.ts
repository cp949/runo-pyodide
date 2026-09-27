/**
 * WebLoop 재보고 억제(03-ctrl-c.md 2.8). pyodide의 WebLoop은 콜백(`run_handle`) 안에서 난 `KeyboardInterrupt`·
 * `SystemExit`을 삼키지 않고 다시 던진다 — 실행 중단·`input()` 취소·`exit()`마다 처리되지 않은 Promise 거부(브라우저
 * `pageerror`, node `Unhandled Rejection`)가 남는다. 사용자에게 보일 트레이스백은 이미 화면에 나갔으므로 이 재보고에는
 * 정보가 없다. WebLoop private 속성 두 개를 no-op으로 바꿔 재보고를 없앤다. pyodide 버전이 바뀌어 속성이 없으면 설치를
 * 건너뛰고 `report`로 알린다(부분 설치는 하지 않는다). 사용자에게 보일 경고는 main 세션이 `ready` 페이로드로 한 번 낸다.
 */
import type { PyodideInterface } from "pyodide";
import type { PyProxy } from "pyodide/ffi";
import type { ReportDegraded } from "./compat";
import WEBLOOP_RERAISE_SOURCE from "./webloop-reraise.py?raw";

export interface WebLoopReraiseDeps {
  /** 설치를 건너뛰게 한, 없는 WebLoop 속성 이름마다 `("webloop-handlers", 이름)`으로 불린다. boot.ts가 수집기를 넣는다. */
  report: ReportDegraded;
}

/** 억제 설치 소스의 Python 파일명. 트레이스백에 새면 알아보기 위한 이름이다. */
export const WEBLOOP_RERAISE_FILENAME = "<webloop-reraise>";

/**
 * 세션당 1회. WebLoop private 속성(`_keyboard_interrupt_handler`·`_system_exit_handler`)을 no-op으로 바꾼다.
 * 동기 함수.
 */
export function suppressWebLoopReraise(
  pyodide: Pick<PyodideInterface, "runPython" | "toPy">,
  deps: WebLoopReraiseDeps,
): void {
  // 별도 namespace(빈 dict)에서 정의해 사용자 globals를 오염시키지 않는다.
  const namespace = pyodide.toPy({}) as PyProxy & {
    get(name: string): unknown;
  };
  try {
    pyodide.runPython(WEBLOOP_RERAISE_SOURCE, {
      globals: namespace,
      filename: WEBLOOP_RERAISE_FILENAME,
    });
    const install = namespace.get("install") as PyProxy &
      ((report: ReportDegraded) => void);
    try {
      install(deps.report);
    } finally {
      install.destroy();
    }
  } finally {
    namespace.destroy();
  }
}
