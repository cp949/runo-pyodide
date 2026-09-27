/**
 * UI 비의존 실행 핸들 `createRunner`(RD-022). worker 생성·재생성, interrupt buffer·송신기, core 세션(`startCoreSession`),
 * 상태 8종을 소유하고 코드 한 덩어리씩 실행한다(`run`). 터미널·xterm을 모른다: 출력은 `onOutput`, 입력은 `InputProvider`,
 * 상태는 `onStatus`로 주고받는다. xterm 실행창(`createTerminalRunner`)과 canvas 같은 다른 소비자가 이것 위에 얹힌다.
 * worker 쪽은 `runDriver`(`worker/run-driver.ts`)다.
 *
 * 규칙 요약(전체 규칙은 docs/design/14-runner.md):
 * - 한 번에 하나만 실행한다. 실행 중(대기 중 포함)에 `run()`을 또 부르면 `RunRejectedError("busy")`.
 * - `loading`·`restarting`이면 `ready`까지 기다린 뒤 실행한다(대기도 슬롯을 차지한다). `load-failed`·`crashed`·`not-isolated`면
 *   `RunRejectedError("unavailable")`.
 * - `stop()` = interrupt → `STOP_FALLBACK_MS` 안에 끝나지 않으면 worker를 terminate하고 새로 만든다(`restarted`).
 * - `interrupt()`는 Ctrl+C용이다: 실행 중이면 눌림만 보내고 terminate·재생성은 없다(REPL과 같은 송신기·연타 보호·재전송).
 * - 생애 사건: `reset()` → 실행 중이던 `run`은 `{ kind: "restarted" }`, `dispose()` → `RunRejectedError("disposed")`, worker 크래시 →
 *   `RunRejectedError("crashed")`(자동 재생성 없음, 복구는 `reset()`).
 */
import { createInterruptBuffer } from "../protocol/interrupt-protocol";
import {
  createInterruptSender,
  type InterruptSender,
} from "../protocol/interrupt-sender";
import { parseRunDriverOptions } from "../protocol/run-driver-options";
import { callConsumer } from "./consumer-callback";
import type { RunOutcome } from "../protocol/run-outcome";
import { STDIN_EOF } from "../protocol/stdin-eof";
import { DEFAULT_PYODIDE_INDEX_URL } from "../pyodide-version";
import { createOutputTail } from "../terminal/output-tail";
import { startCoreSession } from "./core-session";
import type { CoreSession } from "./core-session";
import type { MainDriver, OutputChunk, SessionStatus } from "./driver";

/** `stop()`이 interrupt를 보낸 뒤 `run()`이 끝나기를 기다리는 시간(ms). 넘기면 worker를 terminate하고 새로 만든다. */
export const STOP_FALLBACK_MS = 1000;

/**
 * runner의 생애 상태. `loading`(첫 worker 부팅) → `ready` ⇄ `running` ⇄ `waiting-input`(`input()`·`sys.stdin` 읽기 대기),
 * `restarting`(`reset()`·`stop()` 폴백 뒤 새 worker 부팅), 끝 상태 `load-failed`·`crashed`(`reset()`으로 복구)·`not-isolated`
 * (cross-origin isolation이 꺼져 worker를 만들지 않는다).
 */
export type RunnerStatus =
  | "loading"
  | "ready"
  | "running"
  | "waiting-input"
  | "restarting"
  | "load-failed"
  | "crashed"
  | "not-isolated";

/** 코드가 실행됐을 때의 결말. `restarted`는 실행 도중 worker가 교체됐다는 뜻이다(`reset()` 또는 `stop()` 폴백). */
export type RunResult = RunOutcome | { kind: "restarted" };

/** `stop()`의 결말. `idle` = 멈출 실행이 없었다, `stopped` = 실행이 worker 교체 없이 끝났다, `restarted` = worker를 교체했다. */
export type StopResult = "idle" | "stopped" | "restarted";

/**
 * `interrupt()`가 한 일. `sent` = 눌림을 보냈다, `input-cancelled` = 열린 입력 읽기를 취소했다, `ignored` = 그 밖
 * 상태라 아무 일도 하지 않았다(규칙: `docs/design/14-runner.md` 14.3.3).
 */
export type InterruptResult = "sent" | "input-cancelled" | "ignored";

export type RunRejectedReason = "busy" | "unavailable" | "disposed" | "crashed";

/**
 * `run()`이 코드를 실행하지 못했거나 실행 도중 worker가 사라졌을 때 Promise를 reject하는 오류. 결과 유니온(`RunResult`)은
 * "코드가 실행됐을 때의 결말"만 담고 이 오류는 그 밖의 경우다.
 */
export class RunRejectedError extends Error {
  readonly reason: RunRejectedReason;
  constructor(reason: RunRejectedReason, message?: string) {
    super(message ?? `run 거부: ${reason}`);
    this.name = "RunRejectedError";
    this.reason = reason;
  }
}

/**
 * 입력 공급자. Python이 `input()`·`sys.stdin`을 읽으면 부른다. `prompt`는 그 시점 화면의 미종결 마지막 줄 텍스트다
 * (출력 꼬리, `terminal/output-tail`). 돌려주는 줄은 개행 없는 한 줄이고 `null`은 읽기 취소, `STDIN_EOF`는 입력 끝이다 —
 * `input()`은 `EOFError`, `sys.stdin` 읽기는 그때까지 읽은 것으로 끝난다. `signal`이 abort되면
 * (Ctrl+C·`stop()`·`interrupt()`·`reset()`·`dispose()`·크래시) core가 이미 읽기를 끝냈으므로 그 뒤 값은 버려진다.
 * 실행이 취소되면 Python에서는 `KeyboardInterrupt`가 난다. reject하면 `input()`이 `OSError`로 끝난다.
 */
export type InputProvider = (
  prompt: string,
  signal: AbortSignal,
) => Promise<string | null | typeof STDIN_EOF>;

export interface RunnerOptions {
  /** worker를 만들 때마다 부른다(첫 worker와 재생성). 앱은 `runWorker({ driver: runDriver })`를 담은 worker 파일을 돌려준다. */
  createWorker: () => Worker;
  /** 기본 CDN. 끝 `/`가 없으면 붙인다. */
  pyodide?: { indexURL?: string };
  /** 트레이스백의 소스 이름. 기본 `"main.py"`. 생성 시 고정된다(콘솔 `filename`과 SIGINT 규칙 ①이 이 이름에 의존한다, TRP-020). */
  filename?: string;
  /** `true`일 때만 모듈 최상위 `await`를 허용한다. 기본 `false`. */
  topLevelAwait?: boolean;
  /** 입력 공급자. 없으면 `input()`은 읽기 취소(`null`)를 받는다. */
  inputProvider?: InputProvider;
  /** Python의 stdout·stderr 원문 조각. 줄 끝 처리·색은 소비자가 정한다. */
  onOutput: (chunk: OutputChunk) => void;
  /** 상태가 바뀔 때 부른다. 첫 상태(`loading` 또는 `not-isolated`)는 `createRunner`가 반환하기 전에 동기로 온다. */
  onStatus?: (status: RunnerStatus) => void;
  /** worker `error` 이벤트 또는 `crashed` 알림(첫 신호만) 뒤 `onStatus("crashed")` 다음에 부른다. */
  onCrash?: (message: string) => void;
  /** pyodide 로드 실패 메시지. `onStatus("load-failed")` 앞에 온다. */
  onLoadFailed?: (message: string) => void;
  /**
   * `run()`이 코드를 받아들인 순간 그 `run()` 호출 안에서 동기로 한 번 부른다(인자 없음). 실행 슬롯을 차지한 뒤·`runCode`
   * 전송 앞이라 이때 `busy`는 참이고 상태는 아직 `ready`(`running` 전)다. 거부(`busy`·`unavailable`·`disposed`·문자열 아님)에서는
   * 부르지 않는다. `loading`·`restarting`에서 수락된 run도 즉시 부르고, `ready`가 돼 실행을 시작할 때는 다시 부르지 않는다.
   *
   * 콜백 안에서 `run()`은 `busy`로 거부된다. `stop()`·`reset()`·`dispose()`는 불러도 된다: 콜백 뒤에 runner가 `disposed`이거나 슬롯이
   * 이 run이 아니거나 세션이 바뀌었으면 옛 세션에 `runCode`를 보내지 않는다(`stop()`·`dispose()`가 이미 그 run의 결말을 정했고,
   * `reset()`이면 새 worker가 `ready`가 될 때 실행한다). 콜백이 던지면 슬롯을 풀고 그 `run()`을 그 오류로 reject하며 `runCode`는
   * 보내지 않는다(runner는 `busy`에 갇히지 않는다).
   */
  onRunAccepted?: () => void;
}

export interface RunnerHandle {
  /**
   * 코드 한 덩어리를 새 globals(`__main__`)에서 실행하고 결말을 돌려준다. 코드가 실행되지 못하면 `RunRejectedError`로
   * reject한다(`busy`·`unavailable`·`disposed`·`crashed`).
   */
  run(code: string): Promise<RunResult>;
  /**
   * 실행을 멈춘다. `ready`이거나 실행이 없으면 즉시 `"idle"`. `waiting-input`이면 입력을 취소(`KeyboardInterrupt`)하고, 그 밖에는
   * interrupt를 보낸다. 호출 시각부터 `STOP_FALLBACK_MS` 안에 `run()`이 끝나면 `"stopped"`, 아니면 worker를 terminate하고
   * 새로 만들어 `"restarted"`(그 `run()`은 `{ kind: "restarted" }`). 로딩 대기 중이던 `run()`은 취소돼
   * `RunRejectedError("unavailable")`로 끝나고 `stop()`은 `"idle"`이다.
   */
  stop(): Promise<StopResult>;
  /**
   * Ctrl+C용. 열린 입력 읽기가 있으면 그 읽기를 취소하고(`"input-cancelled"`) 눌림은 보내지 않는다(worker는 메일박스에
   * 정지해 SIGINT를 폴링하지 못한다). 그 밖에 실행 중(`active?.phase === "sent"`)이고 core 세션이 살아 있으면
   * interrupt만 보낸다(`"sent"`, terminate·재생성 없음, 연타 보호·재전송은 송신기 몫). 그 밖의 상태는 아무 일도 하지
   * 않는다(`"ignored"`).
   */
  interrupt(): InterruptResult;
  /**
   * worker를 새로 만든다(변수·import 초기화). 실행 중이던 `run()`은 `{ kind: "restarted" }`, 대기 중인 `stop()`은 `"restarted"`.
   * 로딩 대기 중이던 `run()`은 새 worker가 `ready`가 되면 실행된다. `crashed`·`load-failed`에서도 복구한다.
   * `dispose()` 뒤·`not-isolated`에서는 no-op.
   */
  reset(): void;
  /** worker·RPC를 정리한다. 실행 중이거나 대기 중인 `run()`은 `RunRejectedError("disposed")`. 두 번 불러도 안전하다. */
  dispose(): void;
  readonly status: RunnerStatus;
  /**
   * 지금 `run()`을 부르면 `RunRejectedError("busy")`로 거부되는가: run이 실행 슬롯을 차지하고 있거나(로딩·재시작 대기 포함)
   * run 없는 배경 `input()` 대기(`waiting-input`)다. `status`만으로는 `loading`·`restarting` 대기 run과 같은 틱의 `reset()`
   * 직후를 구분하지 못한다.
   */
  readonly busy: boolean;
}

interface ActiveRun {
  code: string;
  /** `waiting` = 로딩·재시작 대기(worker에 아직 안 보냈다), `sent` = `runCode`를 보냈다. */
  phase: "waiting" | "sent";
  resolve(result: RunResult): void;
  reject(error: unknown): void;
}

interface Stopping {
  timer: ReturnType<typeof setTimeout>;
  resolve(result: StopResult): void;
  promise: Promise<StopResult>;
}

/**
 * 열린 입력 읽기 하나. `abandon()`은 살아 있는 세션의 취소(Ctrl+C·`stop()`)와 세션이 사라진 경우(크래시·`terminate`)
 * 모두에 쓴다 — 공급자 `AbortController`를 abort하고 `null`로 resolve한다(규칙: `docs/design/08-session.md` 8.1 D5).
 * 세션이 살아 있으면 core가 `cancel`을 쓰고, 끝났으면 D2가 버린다.
 */
interface PendingInput {
  abandon(): void;
}

function normalizeIndexUrl(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

export function createRunner(options: RunnerOptions): RunnerHandle {
  // 옵션이 틀린 worker는 `ready`도 `loadFailed`도 알리지 않고 부팅이 거부된다. worker를 만들기 전에 같은 파서로 먼저 검증해
  // 잘못된 값이면 여기서 동기로 던진다(worker·버퍼 생성 없음). 프레임 `driver` 필드에는 파서가 돌려준 값을 싣는다.
  const driverOptions = parseRunDriverOptions({
    filename: options.filename,
    topLevelAwait: options.topLevelAwait,
  });
  const { createWorker, onOutput, onStatus, onCrash, onLoadFailed } = options;
  const onRunAccepted = options.onRunAccepted;
  const inputProvider = options.inputProvider;
  const isolated = globalThis.crossOriginIsolated === true;
  const indexURL = normalizeIndexUrl(
    options.pyodide?.indexURL ?? DEFAULT_PYODIDE_INDEX_URL,
  );

  let status: RunnerStatus = isolated ? "loading" : "not-isolated";
  let disposed = false;
  /** 세션(worker)을 새로 만들 때마다 오른다. 옛 세션의 뒤늦은 콜백을 버리는 기준이다. */
  let generation = 0;
  let session: CoreSession | undefined;
  /** 실행 슬롯. 대기 중(`waiting`)과 실행 중(`sent`) 모두 차지한다. */
  let active: ActiveRun | undefined;
  let stopping: Stopping | undefined;
  let pendingInput: PendingInput | undefined;
  // 화면의 미종결 마지막 줄. `InputProvider`의 `prompt`가 된다. stdout·stderr 모두 화면에 나가므로 둘 다 먹인다.
  const tail = createOutputTail();

  // 현재 세션의 눌림 송신기. interrupt buffer는 세션(worker)마다 새로 만든다(`spawn()`): 옛 worker는 `terminate()` 뒤에도 한동안
  // 살아 있을 수 있어(Chromium은 스크립트가 끝나지 않는 worker를 최대 약 2초 뒤에 강제 종료한다) 같은 버퍼를 물려주면 옛 worker의
  // SIGINT 폴링이 새 worker의 눌림을 가로챈다. 옛 worker는 자기 버퍼만 읽으므로 새 세션의 눌림·ack와 섞이지 않는다.
  let interruptSender: InterruptSender | undefined;

  function setStatus(next: RunnerStatus): void {
    if (status === next) return;
    status = next;
    callConsumer(onStatus, next);
  }

  function resolveStop(result: StopResult): void {
    const current = stopping;
    if (!current) return;
    stopping = undefined;
    clearTimeout(current.timer);
    current.resolve(result);
  }

  // 소비자 콜백(`onStatus`)은 안에서 `run`·`reset`·`dispose`를 다시 부를 수 있다. 그래서 `setStatus` 전에 슬롯·`stop()` 결말 같은
  // 내부 상태를 먼저 확정하고, `setStatus` 뒤에는 세션·슬롯이 그대로인지 다시 확인한다.

  /** `worker`로 `runCode`를 보낸다. 슬롯은 이미 이 run이 차지하고 있다. */
  function dispatch(run: ActiveRun): void {
    run.phase = "sent";
    // 새 실행의 꼬리는 비어 있다. 이전 실행이 미종결 줄로 끝났다면 소비자가 줄바꿈을 처리한다.
    tail.reset();
    // 응답 전에 worker가 사라지면(`reset`·`dispose`·크래시) 이미 결말이 정해졌고(`active !== run`) rpc의 reject는 버린다.
    // `running` 알림보다 먼저 보낸다: 콜백이 세션을 바꿔도 이 run은 보낸 세션에 묶이고 결말은 그 사건(`restarted`·`disposed`)이 정한다.
    void session!.call<RunOutcome>("runCode", run.code).then(
      (outcome) => finishRun(run, () => run.resolve(outcome)),
      (error: unknown) => finishRun(run, () => run.reject(error)),
    );
    setStatus("running");
  }

  function finishRun(run: ActiveRun, settle: () => void): void {
    if (active !== run) return;
    active = undefined;
    // stop()이 기다리던 실행이 worker 교체 없이 끝났다.
    resolveStop("stopped");
    if (status === "running") setStatus("ready");
    settle();
  }

  /** 실행 슬롯을 비우고 차지하던 run(대기·실행 중)을 돌려준다. */
  function takeActive(): ActiveRun | undefined {
    const run = active;
    active = undefined;
    return run;
  }

  function handleCrash(): void {
    // 열린 읽기는 세션과 함께 사라진다(worker가 죽었거나 부팅 뒤 예외로 끝났다).
    pendingInput?.abandon();
    const run = takeActive();
    resolveStop("stopped");
    setStatus("crashed");
    run?.reject(
      new RunRejectedError("crashed", "worker가 크래시해 실행을 끝냈다"),
    );
  }

  /** 세션 하나를 시작한다. 콜백은 `generation`으로 옛 세션의 것을 버린다. */
  function spawn(): void {
    const gen = ++generation;
    const isCurrent = () => gen === generation;
    // 이 세션의 크래시를 상태에 반영했다. core 세션은 `onStatus("crashed")` 다음에 `onCrash`를 부르는데, 그 사이 콜백이
    // `reset()`으로 세대를 올려도 이 세션의 크래시 메시지는 전달한다.
    let crashReflected = false;
    const driver: MainDriver = {
      options: driverOptions,
      handlers: {},
      // 실행 중이 아니면 눌림이 닿을 대상 코드가 없다(core 게이트 `pythonRunning`의 재료).
      isIdle: () => active?.phase !== "sent",
      readInput: () => {
        // 규칙: `docs/design/08-session.md` 8.1 D1. 세션이 끝난(크래시·`terminate`) 뒤에는 core가 이 메서드를 아예
        // 부르지 않는다 — 여기서는 세션이 살아 있다고 가정한다.
        // stop() 중에 시작된 읽기(KeyboardInterrupt를 잡고 다시 input()을 부른 프로그램)는 공급자를 거치지 않고 취소한다.
        if (stopping) return Promise.resolve(null);
        const controller = new AbortController();
        const prompt = tail.value();
        // 읽는 동안 worker는 메일박스에 정지해 새 출력이 없다. 읽기가 끝나면 커서가 다음 줄 처음이라 꼬리가 없다.
        tail.reset();
        let abandon!: () => void;
        const abandoned = new Promise<string | null>((resolve) => {
          abandon = () => {
            controller.abort();
            resolve(null);
          };
        });
        const entry: PendingInput = { abandon };
        pendingInput = entry;
        let provided: Promise<string | null | typeof STDIN_EOF>;
        try {
          provided = inputProvider
            ? Promise.resolve(inputProvider(prompt, controller.signal))
            : Promise.resolve(null);
        } catch (error) {
          provided = Promise.reject(error);
        }
        return Promise.race([
          provided.then((line) =>
            typeof line === "string" || line === STDIN_EOF ? line : null,
          ),
          abandoned,
        ]).finally(() => {
          if (pendingInput === entry) pendingInput = undefined;
        });
      },
      // worker가 사용자 코드 안에서 입력을 기다린다. 훅 호출 자체는 core의 D1이 끝난 세션에서 막으므로 `isCurrent()`만
      // `inputResumed`와 같은 모양으로 남긴다.
      inputRequested: () => {
        if (isCurrent()) setStatus("waiting-input");
      },
      // 응답(`deliver`·`cancel`·`eof`)이 끝나 worker가 재개한다.
      inputResumed: () => {
        if (isCurrent() && status === "waiting-input") {
          setStatus(active?.phase === "sent" ? "running" : "ready");
        }
      },
      onLoadFailed: (message) => {
        if (isCurrent()) callConsumer(onLoadFailed, message);
      },
      // `reset()`·`dispose()`·크래시 복구가 세션을 끝낼 때 열린 읽기를 응답 없이 버린다.
      terminate: () => {
        pendingInput?.abandon();
      },
    };
    // 프레임에 넣는 것과 같은 SharedArrayBuffer 뷰를 송신기도 쓴다.
    const interruptBuffer = createInterruptBuffer();
    const sender = createInterruptSender(interruptBuffer);
    interruptSender = sender;
    session = startCoreSession({
      createWorker,
      indexURL,
      interruptBuffer,
      interruptSender: sender,
      driver,
      output: (chunk) => {
        if (!isCurrent()) return;
        tail.feed(chunk.text);
        onOutput(chunk);
      },
      onStatus: (next: SessionStatus) => {
        if (!isCurrent()) return;
        switch (next) {
          case "ready": {
            setStatus("ready");
            // 로딩·재시작 대기 중이던 run을 이제 보낸다. `onStatus("ready")` 콜백이 `reset()`·`dispose()`를 불렀으면 이 세션은
            // 이미 옛것이다: 대기 run은 새 세션의 `ready`가 보낸다.
            if (
              isCurrent() &&
              status === "ready" &&
              active?.phase === "waiting"
            ) {
              dispatch(active);
            }
            break;
          }
          case "load-failed": {
            const run = takeActive();
            setStatus("load-failed");
            run?.reject(
              new RunRejectedError(
                "unavailable",
                "pyodide 로드 실패로 실행할 수 없다",
              ),
            );
            break;
          }
          case "crashed":
            crashReflected = true;
            handleCrash();
            break;
          case "terminated":
            // `runDriver`는 `sessionTerminated`를 보내지 않는다(요청 단위 세션). 도착해도 상태를 바꾸지 않는다.
            break;
        }
      },
      onCrash: (message) => {
        if (crashReflected && !disposed) callConsumer(onCrash, message);
      },
    });
  }

  /**
   * worker를 교체한다(`reset()`·`stop()` 폴백 공통). 옛 세션을 끝내고(열린 읽기 버림·송신기 취소·rpc·worker terminate) 새
   * 세션을 새 interrupt buffer로 시작한다(옛 SIGINT는 옛 버퍼에 남고 새 worker는 보지 못한다). 실행 중이던 run은 `restarted`로, 기다리던 `stop()`은 `"restarted"`로 끝난다.
   */
  function restart(): void {
    const sent = active?.phase === "sent" ? active : undefined;
    if (sent) active = undefined;
    const oldSession = session;
    session = undefined;
    oldSession?.terminate();
    tail.reset();
    // worker는 이미 교체됐다(옛 것은 terminate). 새 worker 생성이 실패해도 기다리던 `stop()`의 결말은 `"restarted"`다
    // (`handleCrash()`의 `"stopped"`보다 먼저 정한다).
    resolveStop("restarted");
    try {
      spawn();
    } catch (error) {
      // worker를 만들지 못했다. `restarting`을 거치지 않고 `crashed`가 된다. 복구는 다시 `reset()`이다.
      generation += 1;
      handleCrash();
      if (!disposed) callConsumer(onCrash, String(error));
      sent?.resolve({ kind: "restarted" });
      return;
    }
    // 새 세션을 만든 뒤에 알린다: 콜백이 `dispose()`·`reset()`을 불러도 정리할 세션이 이미 `session`에 있다.
    setStatus("restarting");
    sent?.resolve({ kind: "restarted" });
  }

  if (isolated) {
    // `loading`을 먼저 알린다: 세션 생성이 던지면 createRunner가 던지므로 소비자는 이 상태를 본 채 예외를 받는다.
    callConsumer(onStatus, "loading");
    spawn();
  } else {
    callConsumer(onStatus, "not-isolated");
  }

  return {
    run(code) {
      return new Promise<RunResult>((resolve, reject) => {
        if (typeof code !== "string") {
          reject(new TypeError("run 인자 오류 — code: 문자열 필요"));
          return;
        }
        if (disposed) {
          reject(new RunRejectedError("disposed", "dispose된 runner다"));
          return;
        }
        if (
          status === "not-isolated" ||
          status === "load-failed" ||
          status === "crashed"
        ) {
          reject(
            new RunRejectedError(
              "unavailable",
              `실행할 수 없는 상태: ${status}`,
            ),
          );
          return;
        }
        // 대기 중인 run도 슬롯을 차지한다. worker가 배경 `input()` 대기로 막혀 있을 때도 새 실행은 받지 못한다.
        if (active || status === "waiting-input") {
          reject(new RunRejectedError("busy", "이미 실행 중이다"));
          return;
        }
        const run: ActiveRun = { code, phase: "waiting", resolve, reject };
        active = run;
        // 수락을 알린다(슬롯 점유 뒤·dispatch 앞). 콜백은 `run`·`stop`·`reset`·`dispose`를 다시 부를 수 있어 뒤에 다시 확인한다.
        const gen = generation;
        try {
          onRunAccepted?.();
        } catch (error) {
          // 콜백이 던졌다: 슬롯을 풀고 그 오류로 끝낸다. 콜백 안에서 `stop()`·`dispose()`가 이미 이 run을 끝냈으면 `reject`는 무시된다.
          if (active === run) active = undefined;
          reject(error);
          return;
        }
        if (disposed || active !== run || generation !== gen) return;
        if (status === "ready") dispatch(run);
        // `loading`·`restarting`이면 `ready` 알림이 dispatch한다.
      });
    },
    stop() {
      if (stopping) return stopping.promise;
      if (disposed) return Promise.resolve<StopResult>("idle");
      const run = active;
      if (!run) {
        // 실행이 없다. 배경 task가 `input()`으로 worker를 붙잡고 있으면 그 읽기만 취소한다.
        pendingInput?.abandon();
        return Promise.resolve<StopResult>("idle");
      }
      if (run.phase === "waiting") {
        // 코드는 실행되지 않았다. 결과 유니온에 넣지 않고 거부로 끝낸다.
        active = undefined;
        run.reject(
          new RunRejectedError(
            "unavailable",
            "worker가 준비되기 전에 stop()으로 취소됐다",
          ),
        );
        return Promise.resolve<StopResult>("idle");
      }
      let resolve!: (result: StopResult) => void;
      const promise = new Promise<StopResult>((res) => {
        resolve = res;
      });
      const current: Stopping = {
        timer: setTimeout(() => {
          if (stopping === current) restart();
        }, STOP_FALLBACK_MS),
        resolve,
        promise,
      };
      stopping = current;
      if (pendingInput) pendingInput.abandon();
      else interruptSender!.send();
      return promise;
    },
    interrupt() {
      if (disposed) return "ignored";
      // 열린 입력 읽기는 눌림이 아니라 읽기 취소로 끝낸다(worker는 메일박스에 정지해 SIGINT를 폴링하지 못한다).
      if (pendingInput) {
        pendingInput.abandon();
        return "input-cancelled";
      }
      if (active?.phase === "sent" && session?.pythonRunning()) {
        interruptSender!.send();
        return "sent";
      }
      return "ignored";
    },
    reset() {
      if (disposed || !isolated) return;
      restart();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // 옛 세션의 뒤늦은 콜백(열린 읽기를 버린 뒤의 `inputResumed`·출력·크래시)이 상태·소비자에 닿지 않게 세대를 올린다.
      generation += 1;
      const run = active;
      active = undefined;
      session?.terminate();
      session = undefined;
      resolveStop("stopped");
      run?.reject(new RunRejectedError("disposed", "dispose된 runner다"));
    },
    get status() {
      return status;
    },
    get busy() {
      return active !== undefined || status === "waiting-input";
    },
  };
}
