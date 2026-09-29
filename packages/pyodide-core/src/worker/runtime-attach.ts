/**
 * Python 런타임 연결의 유일한 진입점. 규칙(순서·이유·실패 처리, 규칙 ID A1~A6): `docs/design/03-ctrl-c.md` 2.6.
 *
 * 연결 순서(A1):
 * - WebLoop 재보고 억제(`suppressWebLoopReraise`)
 * - `time.sleep` 조각(`installSleepSlice`)
 * - SIGINT 핸들러(`installSigintHandler`)
 * - 연결 전에 쓰인 SIGINT 폐기(`discardPendingInterrupt`)
 * - interrupt buffer 연결(`setInterruptBuffer`)
 * - stdin 콜백(`setStdin`)
 *
 * 클로저 주입:
 * - `ack`·`seq`·`discard`·`signalInterrupt`는 `protocol/interrupt-protocol`에서 직접 import해 `deps.interruptBuffer`로 묶는다.
 * - 호출자가 클로저를 만들 필요가 없다.
 * - 부품 `sigint-handler.ts`·`stdin-callback.ts`·`sleep-slice.ts`·`webloop-reraise.ts`는 여전히 `protocol/`을 import하지 않는다.
 */
import type { PyodideInterface } from "pyodide";
import {
  acknowledgeInterrupt,
  discardPendingInterrupt,
  readRequestSeq,
  signalInterrupt,
} from "../protocol/interrupt-protocol";
import type { ReportDegraded } from "./compat";
import type { PyodideConsoleProxy } from "./core-console";
import { type InterruptIdle, installSigintHandler } from "./sigint-handler";
import { installSleepSlice } from "./sleep-slice";
import { createStdinCallback, type StdinCallbackDeps } from "./stdin-callback";
import { suppressWebLoopReraise } from "./webloop-reraise";

/** `attachRuntime`이 받는 것. `stdin`은 전송 수단(메일박스)과 무관하게 주입한다. */
export interface RuntimeAttachDeps {
  /** 초기화 프레임의 interrupt 버퍼 */
  interruptBuffer: Int32Array;

  /** stdin 콜백에 넘길 알림·대기 함수 */
  stdin: Pick<StdinCallbackDeps, "requestInput" | "wait">;

  /** 설치 가드가 건너뛴 지점을 알린다. */
  report: ReportDegraded;
}

/** 연결 결과. `destroy`는 `interruptIdle` proxy만 놓는다(설치물 원복 없음). */
export interface AttachedRuntime {
  /** 감시 타이머가 정지한 실행을 깨울 때 쓰는 Python 함수 */
  interruptIdle: InterruptIdle;

  /** `interruptIdle` proxy를 놓는다. */
  destroy(): void;
}

/**
 * Python 런타임을 연결한다. 순서·실패 처리는 03-ctrl-c.md 2.6(A1·A5).
 * 던질 때는 `interruptIdle` proxy를 이미 놓은 뒤다(설치물 원복 없음).
 */
export function attachRuntime(
  pyodide: Pick<
    PyodideInterface,
    "runPython" | "toPy" | "setInterruptBuffer" | "setStdin" | "checkInterrupt"
  >,
  pyconsole: PyodideConsoleProxy,
  deps: RuntimeAttachDeps,
): AttachedRuntime {
  const { interruptBuffer, stdin, report } = deps;
  suppressWebLoopReraise(pyodide, { report });
  // 조각 교체가 실패해도(가드) 핸들러는 그대로 설치한다. 그 경우 코드 객체가 없어 절단 목록만 짧아진다.
  const codes = installSleepSlice(pyodide, { report });
  let interruptIdle: InterruptIdle;
  try {
    interruptIdle = installSigintHandler(
      pyodide,
      pyconsole,
      {
        ack: () => acknowledgeInterrupt(interruptBuffer),
        seq: () => readRequestSeq(interruptBuffer),
        report,
      },
      codes,
    );
  } finally {
    // 코드 객체 tuple proxy 해제뿐이다. `time.sleep`은 교체된 채로 남는다(원복 수단 없음).
    codes?.destroy();
  }
  try {
    discardPendingInterrupt(interruptBuffer);
    pyodide.setInterruptBuffer(interruptBuffer);
    pyodide.setStdin({
      stdin: createStdinCallback({
        requestInput: stdin.requestInput,
        wait: stdin.wait,
        // 위에서 버퍼를 연결했으므로 `checkInterrupt()`가 EINTR을 던진다.
        signalInterrupt: () => signalInterrupt(interruptBuffer),
        checkInterrupt: () => pyodide.checkInterrupt(),
      }),
    });
  } catch (error) {
    interruptIdle.destroy();
    throw error;
  }
  return {
    interruptIdle,
    destroy: () => interruptIdle.destroy(),
  };
}
