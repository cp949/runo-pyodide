/**
 * main 쪽 core 세션(00-architecture.md 4.2). worker 하나에 대응하는 공통 자원·게이트를 소유한다.
 * - MessageChannel·stdin 메일박스·초기화 프레임
 * - RPC(core 핸들러 + driver 핸들러 합성)
 * - `readInput` 처리
 * - "Python 실행 중" 게이트
 * - 크래시·종료
 *
 * 화면 상호작용은 driver(`MainDriver`)가 낸다.
 * 세션은 `reset()`(RD-010)이 통째로 교체하는 단위다.
 * `interruptBuffer`·`interruptSender`는 호출자가 소유하며 세션마다 새로 만든다.
 * 옛 worker가 같은 buffer의 SIGINT를 가로채지 못하게 한다(TRP-049).
 */
import { postInitFrame } from "../protocol/init-frame";
import type { InitFrame } from "../protocol/init-frame";
import type { ReadyPayload } from "../protocol/ready-payload";
import type { InterruptSender } from "../protocol/interrupt-sender";
import { createRpc } from "../protocol/rpc";
import type { Rpc } from "../protocol/rpc";
import { PYODIDE_VERSION } from "../pyodide-version";
import { composeRpcHandlers } from "../protocol/rpc-handlers";
import {
  createMailboxWriter,
  createStdinMailbox,
} from "../protocol/stdin-mailbox";
import { STDIN_EOF } from "../protocol/stdin-eof";
import type { MainDriver, OutputChunk, SessionStatus } from "./driver";

/** {@link startCoreSession}의 옵션 */
export interface CoreSessionOptions {
  /** worker 생성 함수. 세션마다 불린다. */
  createWorker: () => Worker;

  /** 끝 `/`가 붙은 pyodide CDN 위치 */
  indexURL: string;

  /** 호출자 소유. 세션마다 새로 만든다(리셋이 옛 buffer를 물려주지 않는다, TRP-049). 초기화 프레임에 그대로 싣는다. */
  interruptBuffer: Int32Array;

  /** 호출자 소유. `interruptBuffer`와 짝이다(세션마다 새로 만든다). */
  interruptSender: InterruptSender;

  /** 화면 상호작용. 옵션은 초기화 프레임 `driver` 필드로 간다. 핸들러는 core 핸들러와 합성돼 RPC에 등록된다. */
  driver: MainDriver;

  /** Python의 stdout·stderr 원문(`write`·`writeErrorRaw` 알림)을 받는다. */
  output: (chunk: OutputChunk) => void;

  /** 상태가 바뀔 때 부른다. */
  onStatus: (status: SessionStatus) => void;

  /** worker `error` 이벤트 또는 `crashed` 알림(첫 신호만) 뒤 부른다. */
  onCrash?: (message: string) => void;
}

/** worker 하나에 대응하는 main 쪽 세션 핸들 */
export interface CoreSession {
  /**
   * main이 보는 "Python 실행 중"(`03-ctrl-c.md` 2.7): `alive && inputReadsPending === 0 && !driver.isIdle()`.
   * 거짓이면 Ctrl+C를 에코도 전송도 하지 않는다.
   */
  pythonRunning(): boolean;

  /**
   * 이 세션에서 실행할 코드가 더 없어진 지점(`exit()`·로드 실패). 게이트를 닫고 재전송을 멈춘다.
   * 닫지 않으면 잔류 SIGNAL 2를 아무도 소비하지 않는다. 송신기가 5ms마다 영원히 점검한다(RD-012h(a)).
   */
  endSession(): void;

  /**
   * `ended=true` → `driver.terminate()` → `endSession()` → worker `error` 리스너 제거 → `rpc.dispose()` → `worker.terminate()`.
   * `rpc.dispose()`가 `worker.terminate()`보다 앞이어야 한다. 대기 중인 요청이 reject되는 시점에 worker가 아직 살아 있어야 한다.
   */
  terminate(): void;

  /** `terminate()` 뒤 참 */
  readonly ended: boolean;

  /** worker 핸들러를 부른다(REPL의 `complete`). 종료(`rpc.dispose()`) 때 대기 중인 요청은 reject된다. */
  call<T = unknown>(name: string, ...args: unknown[]): Promise<T>;
}

/**
 * core가 main 쪽에 등록하는 RPC 핸들러 이름(worker → main). driver 핸들러가 이 이름을 쓰면 세션 생성 시 예외다.
 * worker 쪽 표(main → worker, `worker/boot.ts`의 `CORE_WORKER_HANDLERS`)와는 방향이 다르다. 서로 다른 끝점에서 합성한다.
 * `coreHandlers`가 `satisfies`로 이 표와 이름이 일치함을 컴파일 때 강제한다. 늘리면 양쪽을 함께 고친다.
 */
export const CORE_MAIN_HANDLER_NAMES = [
  "write",
  "writeErrorRaw",
  "readInput",
  "sessionTerminated",
  "ready",
  "loadFailed",
  "crashed",
] as const;

type CoreMainHandlerName = (typeof CORE_MAIN_HANDLER_NAMES)[number];

/**
 * worker를 만들고 초기화 프레임을 보낸다. 세션 핸들을 돌려준다.
 * - 핸들러 이름이 core와 겹치면 채널·worker를 만들기 전에 던진다.
 * - worker 생성·프레임 전송이 실패하면 만든 자원을 정리하고 던진다.
 */
export function startCoreSession(options: CoreSessionOptions): CoreSession {
  const {
    interruptBuffer,
    interruptSender,
    createWorker,
    indexURL,
    driver,
    output,
    onStatus,
    onCrash,
  } = options;

  // `terminate()` 뒤 참
  let ended = false;
  // 크래시 신호(worker error 이벤트·crashed 알림)는 먼저 온 것만 반영한다(확정 1).
  let crashed = false;
  // 세션이 살아 있다. `sessionTerminated`·`loadFailed`·`terminate()`에서 거짓이 된다.
  let alive = true;
  // `readInput` 알림이 도착한 뒤 `deliver`/`cancel`/`eof`/`fail`이 끝나기 전. worker는 그동안 메일박스에 정지해 있다.
  let inputReadsPending = 0;
  // main이 보는 "Python 실행 중"(03-ctrl-c.md 2.7).
  // - 거짓이면 눌림이 닿을 대상 코드가 없다. Ctrl+C를 에코도 전송도 하지 않는다.
  // - core는 로딩 중(`ready` 전)도 참으로 본다. 부팅 중 눌림은 버퍼에 남고 worker의 연결 단계가 폐기한다(2.6).
  // - driver 유휴(REPL: `readLine` 응답 전·취소 직후)는 `driver.isIdle()`이 막는다.
  const pythonRunning = () =>
    alive && inputReadsPending === 0 && !driver.isIdle();
  // 게이트를 닫고 재전송을 멈춘다.
  const endSession = () => {
    alive = false;
    interruptSender.cancel();
  };
  // worker가 죽었거나(전역 `error`) 부팅 뒤 루프가 잡히지 않은 예외로 끝났을 때(`crashed` 알림) 부른다.
  // - 첫 신호만 반영한다(확정 1).
  // - 터미널에는 쓰지 않는다. 앱의 Alert가 보여준다(확정 9).
  // - worker는 terminate하지 않는다(복구는 `reset()`).
  const crash = (message: string) => {
    if (ended || crashed) return;
    crashed = true;
    endSession();
    onStatus("crashed");
    onCrash?.(message);
  };
  // 규칙: 8.1 D6. 읽기를 미뤘다가 여는 driver가 "열기 직전"에 조회하는 core 판정.
  const sessionEnded = () => ended || crashed;

  const mailbox = createStdinMailbox();
  const mailboxWriter = createMailboxWriter(mailbox);

  // core가 등록하는 핸들러(worker → main). 이름은 `CORE_MAIN_HANDLER_NAMES`와 같아야 한다(`satisfies`가 강제).
  const coreHandlers = {
    write: (text: string) => output({ stream: "stdout", text }),
    writeErrorRaw: (text: string) => output({ stream: "stderr", text }),
    // stdin 콜백 진입(worker는 이 알림 직후 메일박스에 정지한다). 응답 통로가 메일박스뿐이라 반환값이 없다.
    // 취소(Ctrl+C)는 `mailbox.cancel()`이다. worker의 stdin 콜백이 그것을 `KeyboardInterrupt`로 바꾼다.
    readInput: (cancelable: boolean) => {
      // 규칙: `docs/design/08-session.md` 8.1 D1. 끝난 세션에 도착한 알림은 아무것도 하지 않는다.
      // worker는 메일박스에 정지한 채 남는다. `reset()`의 `worker.terminate()`가 정리한다.
      if (ended || crashed) return;
      // 이 알림 직후 worker는 메일박스에 정지한다. 보낸 눌림의 재전송을 멈춘다(03-ctrl-c.md 2.3).
      interruptSender.cancel();
      // 알림 도착 = worker가 사용자 코드 안에서 입력을 기다린다. driver의 앞 취소 방어 구간이 여기서 끝난다.
      driver.inputRequested?.();
      inputReadsPending += 1;
      void driver
        .readInput(cancelable, sessionEnded)
        .then(
          (line) => {
            // 규칙: 8.1 D2. 열린 읽기가 resolve할 때 세션이 끝났으면 메일박스에 쓰지 않는다.
            if (ended || crashed) return undefined;
            if (line === STDIN_EOF) return mailboxWriter.eof();
            return line === null
              ? mailboxWriter.cancel()
              : mailboxWriter.deliver(line);
          },
          (error: unknown) => {
            // 규칙: 8.1 D3. 끝났으면 무기록, 살아 있으면 오류 종류와 무관하게 `fail`.
            // 끝난 세션에서는 `fail()`을 부르지 않는다.
            // worker가 이미 terminate돼 메일박스를 비우지 않으므로 `untilIdle`이 영영 안 풀릴 수 있다(TRP-003, 확정 14).
            return ended || crashed
              ? undefined
              : mailboxWriter.fail(String(error));
          },
        )
        .catch((error: unknown) =>
          console.error("[session] stdin 응답 실패", error),
        )
        .finally(() => {
          // `deliver`/`cancel`/`eof`/`fail`이 끝난 뒤에 내린다. 그 시점에 worker가 깨어나 실행을 재개한다.
          inputReadsPending -= 1;
          // 재개 지점이다. driver의 앞 취소 방어도 함께 내린다(`input()` 취소 뒤 계산 중단이 막히지 않게).
          driver.inputResumed?.();
        });
    },
    // 종료는 터미널에 쓰지 않는다(3.14도 종료 메시지가 없다). worker는 살려 둔다. 복구는 `reset()`이다.
    sessionTerminated: () => {
      endSession();
      onStatus("terminated");
    },
    ready: (payload: ReadyPayload) => {
      // 호환 경고는 여기서 세션당 한 번만 낸다(worker는 개별 경고를 내지 않는다). 문제가 없으면 내지 않는다.
      if (payload.versionMismatch || payload.degraded.length > 0) {
        console.warn("[session] pyodide 호환 경고", {
          expected: PYODIDE_VERSION,
          actual: payload.pyodideVersion,
          degraded: payload.degraded,
          details: payload.details,
        });
      }
      driver.onReady?.(payload);
      onStatus("ready");
    },
    // worker는 죽지 않는다. 접두사·표시는 driver가 정한다(01-protocols.md 1.2).
    loadFailed: (message: string) => {
      endSession();
      driver.onLoadFailed?.(message);
      onStatus("load-failed");
    },
    // 부팅 뒤(driver 실행)의 잡히지 않은 예외(01-protocols.md 1.2). worker는 살아 있을 수 있다.
    crashed: ({ message }: { message: string }) => crash(message),
  } satisfies Record<CoreMainHandlerName, (...args: never[]) => unknown>;
  // 이름이 겹치면 여기서 던진다. 채널·worker를 만들기 전이라 자원이 새지 않는다.
  const handlers = composeRpcHandlers(coreHandlers, driver.handlers);

  const channel = new MessageChannel();
  const frame: InitFrame = {
    kind: "init",
    rpcPort: channel.port2,
    interruptBuffer,
    stdinCtrl: mailbox.ctrl,
    stdinData: mailbox.data,
    driver: driver.options,
    pyodide: { indexURL },
  };
  const rpc: Rpc = createRpc(channel.port1, handlers);
  // worker 스레드 자체가 죽은 경우(crashed 알림이 오지 않는 실패)를 보완한다(01-protocols.md 1.2).
  const onWorkerError = (event: ErrorEvent) => {
    crash(event.message || "worker가 알 수 없는 이유로 종료됨");
  };
  let created: Worker | undefined;
  try {
    created = createWorker();
    created.addEventListener("error", onWorkerError);
    postInitFrame(created, frame);
  } catch (error) {
    // 만들다 만 자원을 정리하고 호출자에게 던진다.
    // 남은 worker의 뒤늦은 `error`가 다음 세션의 상태를 `crashed`로 바꾸지 않게 한다.
    // 리스너를 떼고 terminate한다(`ended`가 `crash()`도 막는다).
    ended = true;
    created?.removeEventListener("error", onWorkerError);
    rpc.dispose();
    created?.terminate();
    throw error;
  }
  const worker = created;

  return {
    pythonRunning,
    endSession,
    terminate() {
      ended = true;
      // driver 훅이 열린 읽기와 자원을 끝낸다. `endSession()` 앞이다.
      driver.terminate?.();
      endSession();
      worker.removeEventListener("error", onWorkerError);
      rpc.dispose();
      worker.terminate();
    },
    get ended() {
      return ended;
    },
    call: (name, ...args) => rpc.call(name, ...args),
  };
}
