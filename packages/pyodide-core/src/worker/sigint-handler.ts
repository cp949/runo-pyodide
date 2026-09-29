/**
 * worker Python SIGINT 핸들러(03-ctrl-c.md 2.4).
 * pyodide 폴링이 interrupt buffer의 SIGINT를 읽으면 `signal.signal(SIGINT, …)`로 등록한 이 핸들러가 돈다.
 * 핸들러 동작:
 * - 눌림을 받았다고 ack한다.
 * - 스택에 사용자 프레임이 있을 때만 `KeyboardInterrupt`를 낸다.
 *   사용자 프레임은 `co_filename`이 콘솔 `filename`인 프레임이다(REPL은 `<console>`, 실행 driver는 `filename` 옵션 값).
 *
 * 중단 트레이스백에서 핸들러 프레임은 `console.formattraceback` 교체로 자른다.
 *
 * 사용자 프레임이 없어도 사용자 코드가 실행 중이면(= `runcode` 안) 정지한 실행을 깨운다.
 * 이유(TRAP-07):
 * - `asyncio.run`·`run_until_complete`·`run_sync` 대기는 JSPI로 사용자 스택이 정지한다.
 * - top-level await 대기는 콘솔 task가 멈춰 있다.
 * - 그래서 폴링이 사용자 프레임 없는 콜백에서 일어난다.
 *
 * 깨우기 방식:
 * - `pyodide.webloop.run_sync`·`pyodide.ffi.run_sync`·`console.runcode`를 래퍼로 바꿔 대기 Task나 콘솔 task를 취소한다.
 * - 돌려주는 `interrupt_idle`은 감시 타이머가 같은 일을 하는 진입점이다.
 *
 * 그 밖(다음 문장 컴파일, 트레이스백 생성, 시작 코드)의 SIGINT는 버린다(TRAP-04).
 * pyodide 내부가 기대와 다르면 깨우기만 건너뛰고 `report`로 알린다.
 *
 * 이 파일은 `protocol/`을 import하지 않는다.
 * `ack`·`seq`는 `attachRuntime`이 `acknowledgeInterrupt`·`readRequestSeq`를 클로저로 넣는다(`stdin-callback.ts`와 같은 패턴).
 */
import type { PyodideInterface } from "pyodide";
import type { PyProxy } from "pyodide/ffi";
import type { PyodideConsoleProxy } from "./core-console";
import type { ReportDegraded } from "./compat";
import SIGINT_HANDLER_SOURCE from "./sigint-handler.py?raw";

/** {@link installSigintHandler}가 받는 것. 버퍼 대신 클로저를 받는다. */
export interface SigintHandlerDeps {
  /** 눌림을 받았다는 표시. `acknowledgeInterrupt(buffer)`를 `attachRuntime`이 넣는다. 폴링 경로가 아니라 핸들러 진입에서만 불린다. */
  ack(): void;

  /** 현재 요청 번호. `readRequestSeq(buffer)`를 `attachRuntime`이 넣는다. */
  seq(): number;

  /**
   * 설치 가드가 건너뛴 부분을 알린다.
   * - 정지한 실행 깨우기 가드의 어긋난 이름마다 `("run-sync", 이름)`.
   * - 트레이스백 파일명 가드는 `("webloop-filename", 경로)`.
   * - boot.ts가 수집기를 넣는다.
   */
  report: ReportDegraded;
}

/** 핸들러·래퍼 소스의 Python 파일명. 트레이스백에 새면 알아보기 위한 이름이다. 절단은 코드 객체로 한다. */
export const SIGINT_HANDLER_FILENAME = "<sigint-handler>";

/**
 * Python `interrupt_idle`. 정지한 사용자 실행을 깨운다. 깨웠으면 `true`(부른 쪽이 SIGINT를 소비하고 ack한다),
 * 깨울 것이 없으면 `false`(SIGINT는 그대로 둬 재개한 사용자 스택의 폴링이 받게 한다). 세션 끝에 `destroy()`한다.
 */
export type InterruptIdle = (() => boolean) & PyProxy;

/**
 * `signal.signal(SIGINT, …)` 핸들러 설치 + `console.formattraceback` 교체.
 * `attachRuntime`이 버퍼 연결 **전에** 부른다(핸들러 없이 연결하면 부팅 중 눌림이 기본 핸들러로 시작 코드를 죽인다, TRAP-31).
 * 세션마다 pyodide가 새로 만들어지므로 한 번만 설치한다. 동기 함수.
 *
 * `extraOwnCodes`는 다른 모듈이 심은 우리 코드 객체 tuple의 proxy다(`installSleepSlice`의 반환값).
 * 절단 대상에 합쳐진다. 호출자가 이 함수가 돌아온 뒤 destroy한다.
 *
 * 돌려주는 `interrupt_idle` proxy는 namespace를 destroy한 뒤에도 살아 있다(Python 함수가 자기 globals를 붙잡는다).
 * 감시 타이머가 세션 동안 쓴다. 호출자가 끝에 destroy한다.
 */
export function installSigintHandler(
  pyodide: Pick<PyodideInterface, "runPython" | "toPy">,
  pyconsole: PyodideConsoleProxy,
  deps: SigintHandlerDeps,
  extraOwnCodes?: PyProxy,
): InterruptIdle {
  // 별도 namespace(빈 dict)에서 정의해 사용자 globals를 오염시키지 않는다. proxy는 설치 뒤 버리고, 핸들러 함수는
  // Python 쪽 참조(`signal` 모듈, `console.formattraceback`)가 유지한다.
  const namespace = pyodide.toPy({}) as PyProxy & {
    get(name: string): unknown;
  };
  try {
    pyodide.runPython(SIGINT_HANDLER_SOURCE, {
      globals: namespace,
      filename: SIGINT_HANDLER_FILENAME,
    });
    const install = namespace.get("install") as PyProxy &
      ((
        console: PyodideConsoleProxy,
        ack: () => void,
        seq: () => number,
        report: ReportDegraded,
        extraOwnCodes?: PyProxy,
      ) => InterruptIdle);
    try {
      // JS 함수 세 개는 pyodide가 JsProxy로 넘긴다.
      // `ack`·`seq`는 핸들러 진입에서만, `report`는 설치 중에만 불린다. 폴링 경로에 JS 훅이 없다(TRAP-23).
      // `undefined`를 넘기면 Python이 `None`으로 받아 기본값 `()`가 무시된다. 그래서 인자 수를 나눠 부른다.
      return extraOwnCodes
        ? install(pyconsole, deps.ack, deps.seq, deps.report, extraOwnCodes)
        : install(pyconsole, deps.ack, deps.seq, deps.report);
    } finally {
      install.destroy();
    }
  } finally {
    namespace.destroy();
  }
}
