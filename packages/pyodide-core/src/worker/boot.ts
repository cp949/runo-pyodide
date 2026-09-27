/**
 * worker 부팅 시퀀스(01-protocols.md 5절 S1, 00-architecture.md 3.1). 초기화 프레임을 받은 뒤
 * pyodide 로드 → interrupt 공개 API 확인 → 플러그인 `prepare` → 콘솔 생성 → 호환 탐지 → 런타임 연결(`attachRuntime`) → `ready` → driver 실행
 * 순서로 진행한다. 로더는 주입해 node에서 npm
 * `loadPyodide`로 시험하고 브라우저에서는 CDN 로더(`loadPyodideFromCdn`)를 쓴다.
 */
import type { PyodideInterface } from "pyodide";
import type { InitFrame } from "../protocol/init-frame";
import {
  consumeInterrupt,
  discardPendingInterrupt,
  hasPendingInterrupt,
} from "../protocol/interrupt-protocol";
import { createReadyPayload } from "../protocol/ready-payload";
import { createRpc } from "../protocol/rpc";
import { composeRpcHandlers } from "../protocol/rpc-handlers";
import { createMailboxReader } from "../protocol/stdin-mailbox";
import { PYODIDE_VERSION } from "../pyodide-version";
import { createDegradedCollector, findMissingInterruptApi } from "./compat";
import type { ConsoleSinks } from "./core-console";
import type { WorkerDriver } from "./driver";
import { startInterruptWatch } from "./interrupt-watch";
import type { WorkerPlugin } from "./plugin";
import { attachRuntime, type AttachedRuntime } from "./runtime-attach";

export interface BootDeps {
  loadPyodide(indexURL: string): Promise<PyodideInterface>;
}

export interface BootOptions extends BootDeps {
  driver: WorkerDriver;
  /** 없으면 플러그인 단계가 없다. 배열 순서대로 하나씩 await한다(`WorkerPlugin`). */
  plugins?: readonly WorkerPlugin[];
}

/**
 * core가 worker 쪽에 등록하는 RPC 핸들러(main → worker 요청). 지금은 없다(main→worker 요청은 driver의 `complete`뿐이다).
 * 방향이 반대인 main 쪽 표(worker → main: `write`·`readInput` 등)는 `session/core-session.ts`의 `CORE_MAIN_HANDLER_NAMES`다.
 * 두 표는 서로 다른 RPC 끝점에 붙어 이름 충돌 검사도 따로 한다(각 끝점에서 core 표 + driver 표를 `composeRpcHandlers`로 합성).
 */
const CORE_WORKER_HANDLERS = {};

/**
 * 플러그인이 던지거나 reject한 값을 `plugin "<name>": ` 뒤에 붙일 문구로 바꾼다. `String()`이 던지는 값(null 프로토타입 객체,
 * `toString`이 던지는 객체)이면 `Object.prototype.toString`(`[object Object]` 등)으로 대신한다: 변환이 catch 안에서 던지면 접두와
 * 플러그인 이름이 사라진 다른 오류가 loadFailed로 나간다.
 */
function describePluginFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}

/**
 * 순서: driver 옵션 검증(`parseOptions`) → driver 세션 생성 → RPC 생성(core + driver 핸들러 합성) → loadPyodide → interrupt 공개
 * API 확인 → 플러그인 `prepare`(배열 순서, 하나씩 await) → `driver.createConsole` → `driver.probe` → `attachRuntime` → ntf ready →
 * 감시 타이머 시작 → `driver.run`(00-architecture.md 3.1(5)). interrupt 공개 API(`setInterruptBuffer`·`checkInterrupt`)가 없으면
 * Ctrl+C가 성립하지 않아 콘솔을 만들기 전에 loadFailed로 시작을 거부한다. 플러그인(RD-023)은 그 확인을 통과한 pyodide를 받고, 던지거나
 * reject하면 `plugin "<name>": ` 접두를 붙여 같은 catch의 loadFailed로 간다(`attachRuntime` 전이라 정리할 설치가 없다). 비공개 API 지점(driver `probe` + core 4지점)은 부팅 중
 * 한 번 탐지해 `ready` 페이로드 `{ pyodideVersion, versionMismatch, degraded, details? }`로 알린다(RD-021). worker는 경고를
 * 내지 않고 main 세션이 문제가 있을 때만 `console.warn`을 한 번 낸다. `attachRuntime`(Python 런타임 연결, 순서·실패 처리는
 * 03-ctrl-c.md 2.6)이 부팅 중 눌림으로부터 시작 코드를 지키는 유일한 진입점이다.
 * 로드·interrupt API 확인·콘솔 생성·probe·런타임 연결 실패는 ntf loadFailed(String(error))로 알리고 돌아온다(worker는 살아 있다).
 * 감시 타이머(`startInterruptWatch`, 03-ctrl-c.md 2.5)는 driver 실행 직전에 켜고 실행이 끝나면(`exit()`) `finally`에서 끈다.
 * `ready` 알림 뒤(감시·driver 실행)의 잡히지 않은 예외는 ntf crashed({ message: String(error) })로 나간다(RD-010, worker는 살아 있을 수 있다).
 */
export async function bootWorker(
  frame: InitFrame,
  options: BootOptions,
): Promise<void> {
  // 옵션이 틀리면 여기서 던진다: RPC·pyodide 로드 어느 것도 시작하기 전이다(프레임 검증 실패와 같이 `runWorker`가 로그로 남긴다).
  const driverOptions = options.driver.parseOptions(frame.driver);
  const session = options.driver.createSession(driverOptions);
  // driver 핸들러(`complete` 등)는 createRpc 생성 시에만 등록할 수 있다(`protocol/rpc.ts`, 나중 등록 API 없음).
  const rpc = createRpc(
    frame.rpcPort,
    composeRpcHandlers(CORE_WORKER_HANDLERS, session.handlers),
  );
  const interruptBuffer = frame.interruptBuffer;
  const sinks: ConsoleSinks = {
    write: (text) => rpc.notify("write", text),
    writeErrorRaw: (text) => rpc.notify("writeErrorRaw", text),
  };
  let pyconsole: ReturnType<typeof session.createConsole>;
  let pyodide: PyodideInterface;
  let attached: AttachedRuntime | undefined;
  const collector = createDegradedCollector();
  try {
    pyodide = await options.loadPyodide(frame.pyodide.indexURL);
    // 시작 거부: interrupt 공개 API가 없으면 중단 없이 실행하게 되므로 콘솔을 만들기 전에 끝낸다(`degraded`가 아니다).
    const missingApi = findMissingInterruptApi(pyodide);
    if (missingApi.length > 0) {
      throw new Error(
        `pyodide에 Ctrl+C 공개 API(${missingApi.join(", ")})가 없어 시작할 수 없습니다`,
      );
    }
    // 플러그인 준비. 콘솔 생성 전이라 플러그인이 등록한 것(JS 모듈 등)이 콘솔·driver 시작 코드에서 보인다. 순서대로 하나씩 기다린다.
    for (const plugin of options.plugins ?? []) {
      try {
        await plugin.prepare({ pyodide });
      } catch (error) {
        throw new Error(
          `plugin "${plugin.name}": ${describePluginFailure(error)}`,
          { cause: error },
        );
      }
    }
    pyconsole = session.createConsole({ pyodide, sinks, frame });
    // driver가 기대하는 비공개 API 지점 탐지. 콘솔 생성 직후 한 번이고 던지면 loadFailed다.
    collector.addIds(session.probe?.({ pyodide, pyconsole }) ?? []);
    const mailbox = createMailboxReader({
      ctrl: frame.stdinCtrl,
      data: frame.stdinData,
    });
    // Python 런타임 연결(03-ctrl-c.md 2.6). 실패는 loadFailed다. input()·sys.stdin 읽기는 알림을 먼저 올리고 Atomics.wait로
    // 멈춘다(01-protocols.md 1.3). 콘솔에는 stdin_callback을 넘기지 않으므로(02-console-core.md) 이 전역 설정이
    // 그대로 쓰인다.
    attached = attachRuntime(pyodide, pyconsole, {
      interruptBuffer,
      stdin: {
        requestInput: (cancelable) => rpc.notify("readInput", cancelable),
        wait: () => mailbox.wait(),
      },
      report: collector.report,
    });
    rpc.notify(
      "ready",
      createReadyPayload({
        actual: pyodide.version,
        expected: PYODIDE_VERSION,
        degraded: collector.degraded(),
        details: collector.details(),
      }),
    );
  } catch (error) {
    // `attached`는 attachRuntime이 성공했을 때만 정의된다. attachRuntime 도중 실패(핸들러 설치 뒤 단계가 던진
    // 경우)는 attachRuntime이 스스로 interrupt_idle(PyProxy)을 destroy하고 다시 던지므로 `attached`가 여전히
    // undefined라 아래는 no-op이다. attachRuntime 성공 뒤(ready 알림 등)의 실패면 이 한 번이 proxy를 놓는
    // 유일한 destroy다(설치물 원복 없음).
    attached?.destroy();
    rpc.notify("loadFailed", String(error));
    return;
  }
  // 이 지점부터의 잡히지 않은 예외는 loadFailed가 아니라 crashed다(RD-010, worker는 살아 있을 수 있다).
  try {
    // 세션의 프롬프트 대기 여부를 감시 타이머의 프롬프트 유휴 폐기가 읽는다(03-ctrl-c.md 2.5, 01-protocols.md 1.2).
    // driver가 REPL 루프의 `readLine` 대기 중일 때 참이다.
    const stopWatch = startInterruptWatch({
      interruptIdle: attached.interruptIdle,
      atPrompt: () => session.atPrompt(),
      hasPending: () => hasPendingInterrupt(interruptBuffer),
      consume: () => consumeInterrupt(interruptBuffer),
      discard: () => discardPendingInterrupt(interruptBuffer),
    });
    // driver 실행이 끝나면(`exit()`) 세션이 끝난 것이다. 감시 타이머는 여기서 놓아 준다.
    try {
      await session.run({ pyodide, pyconsole, rpc, frame });
    } finally {
      stopWatch();
    }
  } catch (error) {
    rpc.notify("crashed", { message: String(error) });
  } finally {
    // 깨우기 proxy는 정상 종료·크래시 어느 쪽이든 여기서 놓아 준다.
    attached.destroy();
  }
}
