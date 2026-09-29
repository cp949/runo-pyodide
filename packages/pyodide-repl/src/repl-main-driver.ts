/**
 * REPL main driver(RD-020).
 *
 * core 세션(`startCoreSession`, `@cp949/runo-pyodide-core`)의 몫:
 * - worker·프레임·RPC
 * - `readInput` 처리
 * - 게이트
 *
 * 이 모듈의 몫(REPL 화면 상호작용):
 * - sink, 줄 편집 정책(`autoIndent`·`blockHistory`·`tabReader`)
 * - `surface.promptRow`(RD-027)로 낸 읽기·읽기 가드
 * - RPC 핸들러 `readLine`·`writeOutput`·`writeError`
 * - 게이트 재료(`isIdle` = `phase !== "idle"`)
 * - 종료 시 읽기 정리
 *
 * 읽기 상태는 phase 하나로 합친다(docs/design/08-session.md 8.1).
 * `opening`/`open`/`closing` 구분:
 * - 벤더 읽기가 열려 있는가(그려졌는가).
 * - 벤더 promise가 끝났는가(응답이 바깥 promise로 올라가기 전).
 * - 근거: 벤더 promise의 `.then`이 바깥 promise 처리보다 먼저 돈다(08-session.md 8.1 `closing` 항목).
 *
 * 주석의 `Pn`은 규칙 ID다. 같은 ID가 `test/repl-main-driver.test.ts` 시험 제목에 있다.
 * 세션마다 새로 만든다(00-architecture.md 4.2, 08-session.md 8.1).
 */
import { ReadCancelledError, ReadTakenError } from "@cp949/runo-xterm-readline";
import { STDIN_EOF } from "@cp949/runo-pyodide-core";
import type {
  InterruptSender,
  MainDriver,
  OutputChunk,
} from "@cp949/runo-pyodide-core";
import type { ReplDriverOptions } from "./driver-options";
import type {
  ReadLineOutcome,
  ReadLineReply,
  ReadLineSourceReply,
} from "./repl-protocol";
import type { SourceLink } from "./run-source";
import type { CompletionPopover } from "./terminal/completion-popover";
import { createLineEditor } from "./terminal/line-editor";
import { createReadGuard } from "./terminal/read-guard";
import type {
  PromptRow,
  SurfaceIo,
  SurfaceReadline,
} from "@cp949/runo-pyodide-terminal/internal";
import type { SourceCompletion } from "./worker/complete-source";

/**
 * 지금 `runSource`를 받아들일 수 있는가.
 * - `wait`: 첫 프롬프트 전(`loading`). 슬롯이 기다린다.
 * - `open`: 프롬프트가 화면에 그려져 있고 입력을 기다린다. 가져갈 수 있다.
 * - `busy`: 그 밖. 블록 입력·Python 실행·`input()` 대기·Tab 왕복·프롬프트가 그려지기 전.
 */
export type SourcePrompt = "wait" | "busy" | "open";

/**
 * REPL 읽기 phase(docs/design/08-session.md 8.1).
 * 옛 읽기 진행 플래그·취소 방어 플래그·bridge의 읽기 단계 필드를 하나로 합친다.
 */
type ReadPhase = "idle" | "opening" | "open" | "closing" | "cancel-settling";

/** `createReplMainDriver()` 옵션. */
export interface ReplMainDriverOptions {
  /** 핸들이 소유한다. 세션을 넘어 산다(history 유지). auto-indent·block-history·tab-reader 정책이 쓰는 멤버만 노출한다(RD-027). */
  readline: SurfaceReadline;

  /** 이 세션의 화면 입출력(`surface.openIo()`). `terminate` 훅이 `close()`한다. */
  io: SurfaceIo;

  /** 위젯 수명(surface 소유). 프롬프트 행 읽기·take·접두 떼기·읽기 끝내기에 쓴다(RD-027). */
  promptRow: PromptRow;

  /** 핸들이 소유한다. `readLine`·`readInput` 도착과 Tab 취소가 부른다. */
  interruptSender: InterruptSender;

  /** 초기화 프레임 `driver` 필드로 실린다. */
  topLevelAwait: boolean;

  /**
   * worker의 `complete`를 부른다(core 세션의 `call`).
   * 실제 Tab을 누를 때(세션이 이미 시작된 뒤)만 실행된다.
   * 그래서 이 함수가 core 세션을 늦게 참조해도 된다.
   */
  complete: (
    source: string,
    pending: string | undefined,
  ) => Promise<SourceCompletion>;

  /** 핸들이 소유한 `runSource` 슬롯과 만나는 창구. 세션을 넘어 사는 슬롯을 이 세션의 읽기 흐름에 잇는다(RD-022a). */
  source: SourceLink;

  /** 있으면(옵션 켬, RD-049) 세션당 한 번 불러 `createLineEditor`로 넘긴다. */
  completionPopover?: () => CompletionPopover;
}

/** `createReplMainDriver()`가 돌려주는 값. */
export interface ReplMainDriver {
  /** core 세션에 넘기는 driver. */
  driver: MainDriver;

  /** core 출력 계약 `{ stream, text }` → sink. stdout은 `write`, stderr는 `writeErrorRaw`(원문). */
  output(chunk: OutputChunk): void;

  /** 세션의 sink로 `^C`를 에코한다(tty 로컬 에코 흉내, 꼬리 추적에 반영). */
  echoCtrlC(): void;

  /** 지금 `runSource`를 받아들일 수 있는가(`wait`·`open`·`busy`). 부작용이 없다. `runSource()` 판정과 `busy` 게터가 함께 쓴다. */
  sourcePrompt(): SourcePrompt;

  /** 열린 읽기를 가져가 `{ source }`로 응답하도록 준비한다. 받아들일 수 없으면 아무것도 하지 않고 `false`. */
  sendSource(code: string): boolean;
}

/**
 * 세션 하나의 REPL main driver를 만든다.
 * `readLine`·`readInput` 핸들러와 종료 훅이 읽기 phase를 공유한다. 상태는 이 클로저 안에만 있다.
 */
export function createReplMainDriver(
  options: ReplMainDriverOptions,
): ReplMainDriver {
  const { readline, io, promptRow, interruptSender, topLevelAwait, complete } =
    options;
  const link = options.source;
  // `io.terminal`은 세션이 끝난(`io.close()`) 뒤 write 콜백을 전달하지 않는 뷰다(TRP-004).
  // `sinks`는 세션마다 새것이다.
  const { sinks } = io;
  // 세션 소유 상태: autoIndent의 lastUsedIndentation·blockHistory의 기준점·tabReader의 세대.
  // - 이 세션 동안 유지된다.
  // - `reset()`이 새 세션(새 객체)을 만들면 초기화된다(08-session.md 8.1, `terminal/line-editor.ts`).
  // `complete`는 core 세션의 `call`을 클로저로 참조한다.
  // - 이 클로저는 Tab을 누를 때(세션이 이미 시작된 뒤)만 실행된다.
  // - 그래서 선언 순서는 문제가 되지 않는다.
  const lineEditor = createLineEditor(readline, {
    complete,
    interruptCompletion: () => interruptSender.send(),
    popover: options.completionPopover?.(),
  });

  // 벤더 `Readline`은 열린 읽기를 교체하고 앞 promise를 끝내지 않는다.
  // worker 루프는 응답을 받은 뒤에만 다시 요청한다. 그래서 겹치는 요청은 오류로 거절한다.
  // `opening`·`open`·`closing` 셋 다 "벤더 읽기가 열려 있다"는 뜻이다. 겹침 판정(P2)은 이 셋을 함께 본다.
  let phase: ReadPhase = "idle";
  // 벤더 REPL 읽기가 열려 있는가. P2 겹침 거절과 P17 종료 폐기의 조건이다.
  const readOpen = () =>
    phase === "opening" || phase === "open" || phase === "closing";
  // 첫 `readLine` 요청이 도착했다(그 전에는 `sourcePrompt()`가 `wait`).
  let sawRequest = false;
  // 최근 요청이 블록 입력(`... `)인가(`pending !== undefined`).
  let blockPending = false;
  // 읽기마다 오른다. 끝난 읽기의 늦은 콜백(벤더 promise 종료·그리기 write)을 버리는 데 쓴다.
  let readSeq = 0;
  // 진행 중인 stdin(`input()`) 읽기 수. core `inputReadsPending`(`pyodide-core/src/session/core-session.ts`)의 사본이다.
  // - core는 이 값을 driver에 내주지 않는다.
  // - 그래서 `inputRequested`/`inputResumed` 훅으로 여기서 따로 센다.
  // core interface로 내지 않는 이유:
  // - driver가 core보다 먼저 만들어져 늦은 참조가 필요하다.
  // - `promptState()` 판정이 한 곳에서 읽히지 않게 된다.
  // core 카운터의 의미가 바뀌면 다시 본다.
  let inputPending = 0;
  // `sendSource()`가 가져간 코드. 읽기가 `ReadTakenError`로 끝나면 응답으로 나간다.
  let takenCode: string | undefined;
  // 다음 읽기에 복원할 줄(`sendSource()`가 가져간 자리).
  let restore: { text: string; cursor: number } | undefined;
  // 결말을 실은 요청의 읽기가 그려지면(P6b) 슬롯을 정착시킨다(P3에서 세운다).
  let settleOnDraw = false;

  // `sourcePrompt()`·`sendSource()`가 함께 쓰는 판정(P7). 부작용이 없다.
  const promptState = (): SourcePrompt => {
    if (!sawRequest) return "wait";
    if (
      phase !== "open" ||
      blockPending ||
      inputPending > 0 ||
      lineEditor.requesting
    ) {
      return "busy";
    }
    return "open";
  };

  // `readLine` 요청이 도착했다(겹침 거절을 통과한 요청, P3).
  // - 결말이 실려 왔으면: 슬롯에 알리고, 복원한 읽기가 그려지면 정착하도록 예약한다.
  // - 대기 슬롯을 실행하는 요청이면: 읽기를 열지 않고 돌려줄 응답 `{ source }`를 준다.
  // - 그 밖에는 `undefined`(평소 읽기).
  const claimRequest = (
    pending: string | undefined,
    outcome: ReadLineOutcome | undefined,
  ): ReadLineSourceReply | undefined => {
    sawRequest = true;
    blockPending = pending !== undefined;
    if (outcome !== undefined) {
      link.receive(outcome);
      settleOnDraw = true;
      return undefined;
    }
    if (pending !== undefined) return undefined;
    const source = link.claim();
    if (source === undefined) return undefined;
    // 화면에는 아무것도 그리지 않았다. 미종결 꼬리가 있으면 새 줄에서 출력을 시작한다(docs/design/14-runner.md 14.5.4).
    restore = undefined;
    promptRow.breakLine();
    return { source };
  };

  // 읽기 rejection이 `sendSource()` 때문이면(P12) 그 코드를 담은 응답을 준다. 아니면 `undefined`.
  const takeIfTaken = (error: unknown): ReadLineSourceReply | undefined => {
    if (!(error instanceof ReadTakenError) || takenCode === undefined) {
      return undefined;
    }
    const source = takenCode;
    takenCode = undefined;
    return { source };
  };

  // 프롬프트를 기다리는 동안 worker의 배경 콜백이 `input()`을 부르면 stdin 읽기가 REPL 읽기를 교체한다.
  // 그러면 REPL 읽기는 고아가 된다. read-guard의 처리(04-stdin-input.md 3.2):
  // - stdin 읽기를 활성 REPL 읽기가 끝난 뒤로 미룬다.
  // - 미룬 읽기의 접두 떼기·D6 그리기도 promptRow로 직접 낸다.
  const guard = createReadGuard(promptRow);

  const driver: MainDriver = {
    options: { topLevelAwait } satisfies ReplDriverOptions,
    handlers: {
      writeOutput: (text: string) => sinks.writeOutput(text),
      writeError: (text: string) => sinks.writeError(text),
      // 꼬리 + 프롬프트를 그리고 Enter까지 한 줄을 읽어 응답한다.
      // - 취소(Ctrl+C)는 `null` 응답이다. worker의 루프가 `run(null)`로 `KeyboardInterrupt`를 낸다.
      // - `pending`은 자동 들여쓰기 프리필의 재료다(RD-013).
      // - `outcome`은 바로 앞 `{ source }` 응답으로 실행한 코드의 결말이다(RD-022a).
      // 응답 종류:
      // - 줄: Enter로 제출한 줄.
      // - `null`: 취소.
      // - `{ source }`: `runSource`가 읽기를 가져간 경우, 또는 대기하던 코드를 첫 프롬프트에서 실행하는 경우.
      // - `{ eof: true }`: `>>>`의 빈 줄 Ctrl+D. `pending === undefined`인 요청만 EOF를 켠다(RD-048).
      readLine: (
        prompt: string,
        pending: string | undefined,
        cancelable: boolean,
        outcome?: ReadLineOutcome,
      ): Promise<ReadLineReply> => {
        // 요청이 온 순간 worker는 실행을 멈추고 줄을 기다린다. 보낸 눌림의 재전송은 여기서 멈춘다(03-ctrl-c.md 2.3).
        interruptSender.cancel();
        // 요청이 도착했다 = worker가 다음 줄을 기다린다. 앞 취소의 방어 구간이 여기서 끝난다(P1, P2보다 먼저).
        if (phase === "cancel-settling") phase = "idle";
        // 거절은 가드 바깥에서 한다(P2). 거절된 promise를 가드가 활성 읽기로 추적하면 진짜 활성 REPL 읽기를 잃는다.
        if (readOpen()) return Promise.reject(new Error("이미 읽는 중"));
        // 결말 도착·대기 슬롯 실행 판정(P3). 대기하던 코드는 읽기를 열지 않고 바로 응답한다.
        // phase는 `idle` 그대로다. worker가 곧 실행하므로 게이트는 "실행 중"이다.
        const claimed = claimRequest(pending, outcome);
        if (claimed !== undefined) return Promise.resolve(claimed);
        readSeq += 1;
        phase = "opening"; // P4
        return guard
          .readLine(prompt, {
            cancelable,
            // `>>>`(pending 없음)만 EOF를 켠다. 블록 연속줄(`...`)의 빈 줄 Ctrl+D는 EOF가 아니다(RD-048).
            eof: pending === undefined ? true : undefined,
            // flush 뒤, `readline.read()` 직전에 평가한다(P5). restore 소비·Tab 세대가 이 시점에 묶여 있다.
            readOptions: () => {
              const options = lineEditor.begin(pending, restore);
              restore = undefined;
              return options;
            },
            // 벤더가 읽기를 열었다(P6). `seq`로 늦게 도는 콜백(다음 읽기가 이미 시작된 뒤)을 가른다.
            // 그려짐을 벤더 사건으로 받지 않고 write FIFO로 재는 이유·재검토 조건은 08-session.md 8.1 `open` 항목.
            onOpen: (read) => {
              const seq = readSeq;
              const closeIfOpen = () => {
                // 벤더 promise 종료(P6a). 바깥 promise(`guard.readLine`이 돌려주는 것) 처리보다 먼저 돈다(08-session.md 8.1 `closing` 항목).
                // 이 사이 창에서 `sourcePrompt()`가 `busy`를 내도록 phase를 여기서 먼저 내린다.
                if (
                  seq === readSeq &&
                  (phase === "opening" || phase === "open")
                ) {
                  phase = "closing";
                }
              };
              read.then(closeIfOpen, closeIfOpen);
              // 벤더 `read()`가 이미 그리기 콜백을 큐에 넣었다. 이 콜백은 그 뒤에 온다.
              // 따라서 이 콜백이 돌 때 벤더는 프롬프트·복원한 줄을 그리는 write를 냈고, 쌓인 type-ahead도 재생한 뒤다.
              io.terminal.write("", () => {
                if (seq !== readSeq) return;
                if (phase === "opening") phase = "open"; // P6b
                // 정착은 phase와 떼어 낸다.
                // - type-ahead의 Enter로 복원한 읽기가 이미 끝났어도 그 읽기는 그려졌다. 여기서 정착한다.
                //   (xterm이 write 처리를 끊어 그 사이 벤더 promise가 끝난 경우.)
                // - 다음 읽기로 미루면 제출된 명령이 끝날 때까지 resolve하지 않는다.
                if (settleOnDraw) {
                  settleOnDraw = false;
                  // 그리기 write는 벤더 콜백 안에서 나와 이 콜백보다 뒤에 큐에 섰다.
                  // 한 번 더 기다려 그것들이 처리된 뒤에 정착한다.
                  io.terminal.write("", () => link.settle());
                }
              });
            },
          })
          .then(
            (line) => {
              if (line === STDIN_EOF) {
                // EOF(RD-048)는 취소와 같은 방어 phase를 재사용한다. 새 phase를 만들지 않는다.
                // `sessionTerminated` 도착 전까지 벤더에 활성 읽기가 없다. Ctrl+C를 보낼 곳이 없다
                // (08-session.md 8.1 `cancel-settling`과 같은 이유).
                phase = "cancel-settling";
                lineEditor.end({ kind: "eof" });
                return { eof: true };
              }
              // 바깥 promise 처리(P9·P10). phase를 먼저 정한 뒤 편집기를 부른다. 순서는 관측되지 않는다.
              phase = line === null ? "cancel-settling" : "idle";
              // 이번 세대의 읽기가 끝났다(Enter·취소 둘 다).
              // - 왕복 중 취소됐으면 여기서 인터럽트가 나간다.
              // - 취소한 블록은 첫 줄까지 history에서 지운다(06-editing.md 6.4, `line-editor.ts` E7).
              // - worker 쪽 `run(null)`의 `clearPending()`과 짝이다.
              lineEditor.end(
                line === null ? { kind: "cancel" } : { kind: "line", line },
              );
              return line;
            },
            (error: unknown) => {
              // P11·P12·P13 모두 phase는 `idle`이다.
              phase = "idle";
              // `reset()`의 `cancelRead()`로 끝난 옛 읽기는 응답 없이 조용히 끝낸다(P11).
              // 이 세션의 worker는 이미 종료 중이라 응답을 기다리지 않는다.
              // 영영 풀리지 않는 promise를 돌려 RPC가 응답을 보내지 않게 한다.
              if (error instanceof ReadCancelledError)
                return new Promise<ReadLineReply>(() => {});
              // `sendSource()`가 가져간 읽기(P12): 줄 대신 코드를 응답한다.
              // phase는 위에서 이미 `idle`이다. worker가 실행하는 동안 core 게이트가 "실행 중"이다.
              // Ctrl+C·감시 타이머는 평소 명령 실행과 같다.
              const source = takeIfTaken(error);
              if (source !== undefined) {
                lineEditor.end({ kind: "taken" });
                return source;
              }
              throw error; // P13
            },
          );
      },
    },
    // core 게이트 `pythonRunning = alive && inputReadsPending === 0 && !isIdle()`의 재료(P16).
    // 눌림이 닿을 대상 코드가 없는 구간이 유휴다:
    // - 프롬프트 입력을 기다리는 동안(`opening`·`open`·`closing`).
    // - 취소 응답 뒤 다음 요청 전(`cancel-settling`).
    // `readLine` 응답 뒤~다음 요청 전(배경 콜백이 CPU를 잡는 구간)은 유휴가 아니다(편차 2, docs/design/10-parity-deviations.md).
    // 단, 그 응답이 취소였으면 `cancel-settling`이 막는다.
    isIdle: () => phase !== "idle",
    readInput: (cancelable, sessionEnded) =>
      guard.readInput(cancelable, sessionEnded), // P18
    // 알림이 도착했다 = worker가 사용자 코드 안에서 입력을 기다린다. 앞 취소의 방어 구간이 여기서 끝난다(P14).
    inputRequested: () => {
      if (phase === "cancel-settling") phase = "idle";
      inputPending += 1;
    },
    // 재개 지점이다. 앞 취소의 방어도 함께 내린다(`input()` 취소 뒤 계산 중단이 막히지 않게, P15).
    inputResumed: () => {
      if (phase === "cancel-settling") phase = "idle";
      inputPending = Math.max(0, inputPending - 1);
    },
    // 호환 경고는 core 세션이 이미 냈다(문제가 있을 때만). 여기서는 버전 로그만 남긴다.
    onReady: (payload) => {
      console.info("[repl] pyodide 준비", payload.pyodideVersion);
    },
    // worker는 죽지 않는다. 접두사는 main이 붙이고 빨강 한 줄로 낸다(01-protocols.md 1.2).
    onLoadFailed: (message) => {
      sinks.writeError(`pyodide 로드 실패: ${message}`);
    },
    terminate: () => {
      // core가 `ended`를 먼저 세우고 이 훅을 부른다. 같은 지점에서 게이트를 닫는다(P17).
      io.close();
      // REPL 읽기가 열려 있으면(`opening`·`open`·`closing`) 입력을 기다리던 블록이다. 버린다.
      // 실행 중·`exit()`로 끝난 블록은 phase가 `idle`이라 남는다(P17).
      // tabReader는 readOpen과 무관하게 항상 동기로 끝난다.
      // 이유: 대기 중인 `complete` 요청의 뒤이은 reject가 취소된 세션 상태를 건드리지 못하게 막는다(`terminal/line-editor.ts`).
      lineEditor.dispose(readOpen());
      promptRow.endRead({ screen: false });
    },
  };

  return {
    driver,
    output: ({ stream, text }) => {
      if (stream === "stdout") sinks.write(text);
      else sinks.writeErrorRaw(text);
    },
    echoCtrlC() {
      sinks.write("^C");
    },
    sourcePrompt: () => promptState(),
    sendSource(code) {
      // P8
      if (promptState() !== "open") return false;
      // `promptRow.take()`가 배경 출력이 남긴 접두·프롬프트 앞 꼬리를 화면 순서대로 다시 쓴 뒤 편집 중이던 줄을 돌려준다.
      const line = promptRow.take();
      if (line === undefined) return false;
      // 읽기는 여기서 끝났다. `ReadTakenError` 처리는 `readLine` 핸들러의 몫이다.
      phase = "closing";
      takenCode = code;
      restore = line;
      return true;
    },
  };
}
