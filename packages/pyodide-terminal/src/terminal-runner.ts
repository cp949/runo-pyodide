/**
 * xterm 실행창 `createTerminalRunner`(RD-022). core의 UI 비의존 `createRunner`를 호출자 소유 xterm `Terminal`에 붙인다:
 * 출력은 sink로 그리고, 입력은 `input()`이 불릴 때만 한 줄 읽는다. REPL(`createRepl`)과 달리 프롬프트도 history도 없다.
 *
 * 키 정책(그릴링 확정 15): `Readline`을 `{ persist: false, typeAhead: false }`로 만들어 `input()` 읽기 밖의 입력(키·붙여넣기·IME)을
 * 버린다. Ctrl+C·Ctrl+L 단독 입력만 읽기 밖에서도 처리한다. Ctrl+C는 상태로 갈린다(`onCtrlC`):
 * 선택이 있으면 복사(선택 복사가 먼저 가로챈다), `running`이면 `^C` 표시 + `interrupt`, `waiting-input`이면 읽기 취소, 그 밖은 무동작.
 *
 * 화면 규칙: `run()` 시작 시 `clearOnRun`이면 화면을 지우고, 아니면 현재 io 꼬리에 보이는 글자가 있을 때 `\r\n` 한 번
 * (RD-010 리셋 규칙과 같다).
 * 거부될 `run()`은 화면을 건드리지 않는다(실행 중 프로그램의 출력을 망치지 않는다).
 */
import { ReadCancelledError } from "@cp949/runo-xterm-readline";
import {
  createRunner,
  type InputProvider,
  type OutputChunk,
  type RunResult,
  type RunnerHandle,
  type RunnerStatus,
  type StopResult,
} from "@cp949/runo-pyodide-core";
import type { Terminal } from "@xterm/xterm";
import type { CopyResult } from "./selection-copy";
import { createTerminalSurface } from "./surface";

/** 비격리 페이지에서 세션을 시작하지 않는 이유를 알리는 안내. REPL의 `NOT_ISOLATED_WARNING`과 같은 문구다(ADR-0004). */
const NOT_ISOLATED_NOTICE =
  "경고: cross-origin isolation이 꺼져 있어 Python 세션을 시작하지 않습니다. 서버가 COOP/COEP 헤더를 보내야 합니다.";

/** 런타임 미지원 페이지에서 세션을 시작하지 않는 이유를 알리는 안내. REPL의 `UNSUPPORTED_BROWSER_WARNING`과 같은 문구다(design.md D4). */
const UNSUPPORTED_BROWSER_NOTICE =
  "경고: 이 브라우저는 pyodide 런타임이 요구하는 기능을 지원하지 않아 Python 세션을 시작하지 않습니다. 브라우저 호환(README) 절을 확인하세요.";

export interface TerminalRunnerOptions {
  /** 호출자가 소유하는 xterm `Terminal`. 줄 편집기를 붙이기만 하고 dispose하지 않는다. */
  terminal: Terminal;
  /** worker를 만들 때마다 부른다(첫 worker와 재생성). 앱은 `runWorker({ driver: runDriver })`를 담은 worker 파일을 돌려준다. */
  createWorker: () => Worker;
  /** 기본 CDN. 끝 `/`가 없으면 붙인다. */
  pyodide?: { indexURL?: string };
  /** 트레이스백의 소스 이름. 기본 `"main.py"`. 생성 시 고정된다. */
  filename?: string;
  /** `true`일 때만 모듈 최상위 `await`를 허용한다. 기본 `false`. */
  topLevelAwait?: boolean;
  /** `true`일 때만 `run()` 시작 시 화면을 지운다. 기본 `false`(줄바꿈만). */
  clearOnRun?: boolean;
  /** 드래그 선택(`mouseup`) 시 자동 복사할지. 기본 `true`(`=== false`일 때만 끔). Ctrl+C 복사는 이 값과 무관하게 항상 동작한다. */
  copyOnSelect?: boolean;
  /** 선택 복사(자동·Ctrl+C 모두) 결과를 알린다. */
  onCopy?: (result: CopyResult) => void;
  /**
   * 입력 공급자. 주면 `input()`을 xterm 입력 대신 이것이 받는다(터미널은 읽기를 열지 않는다). 없으면 xterm에서 한 줄을 읽는다.
   * `signal`이 abort되면(Ctrl+C·`stop()`·`reset()`·`dispose()`·크래시) core가 이미 읽기를 끝냈으므로 그 뒤 값은 버려진다.
   */
  inputProvider?: InputProvider;
  /** 상태가 바뀔 때 부른다. 첫 상태(`loading`·`not-isolated`·`unsupported`)는 `createTerminalRunner`가 반환하기 전에 동기로 온다. */
  onStatus?: (status: RunnerStatus) => void;
  /** Python의 stdout·stderr 조각(화면에 그린 것과 같다). */
  onOutput?: (chunk: OutputChunk) => void;
  /** worker `error` 이벤트 또는 `crashed` 알림(첫 신호만) 뒤 `onStatus("crashed")` 다음에 부른다. */
  onCrash?: (message: string) => void;
}

export interface TerminalRunnerHandle {
  /**
   * 코드 한 덩어리를 새 globals(`__main__`)에서 실행하고 결말을 돌려준다. 시작 시 화면을 준비한다(`clearOnRun`이면 지우고, 아니면
   * 이전 출력이 개행 없이 끝나 그 행에 보이는 글자가 남았을 때 줄바꿈). 실행하지 못하면 화면을 건드리지 않고 `RunRejectedError`로 reject한다(core 계약).
   */
  run(code: string): Promise<RunResult>;
  /** 실행을 멈춘다(interrupt → 1000ms 뒤 terminate → 재생성). 결과는 core `stop()`과 같다. */
  stop(): Promise<StopResult>;
  /** worker를 새로 만든다(변수·import 초기화). 화면은 그대로다. 실행 중이던 `run()`은 `{ kind: "restarted" }`. */
  reset(): void;
  /** 화면과 스크롤백을 지운다. 입력을 기다리는 중(읽기가 열린 동안)과 `dispose()` 뒤에는 아무것도 하지 않는다. */
  clear(): void;
  /** runner를 정리하고 줄 편집기·선택 복사를 뗀다. `Terminal`은 dispose하지 않는다. 두 번 불러도 안전하다. */
  dispose(): void;
  readonly status: RunnerStatus;
  /** 드래그 자동 복사 on/off를 바꾼다. `dispose()` 뒤 no-op. */
  setCopyOnSelect(on: boolean): void;
}

/**
 * xterm 실행창을 만든다. core `createRunner`가 worker·상태·`run`/`stop`을 맡고, 이 함수는 화면(sink)·입력(`Readline`)·Ctrl+C·
 * 선택 복사를 붙인다. 옵션 오류는 core가 동기로 던지며, 그 전에 붙인 줄 편집기·선택 복사는 정리한다.
 */
export function createTerminalRunner(
  options: TerminalRunnerOptions,
): TerminalRunnerHandle {
  const terminal = options.terminal;
  // 읽기 밖 입력은 버린다(typeAhead: false). history는 메모리에도 남기지 않는다(`readInput`이 `history: false`로 읽는다).
  const surface = createTerminalSurface(terminal, {
    copyOnSelect: options.copyOnSelect,
    onCopy: options.onCopy,
    readline: { persist: false, typeAhead: false },
  });
  const { readline, promptRow } = surface;
  // sinks가 쓰는 터미널 뷰의 게이트는 `disposed = true`와 같은 지점에서 `io.close()`로 닫는다(TRP-004).
  const io = surface.openIo();
  const { sinks } = io;

  let disposed = false;
  let runner: RunnerHandle | undefined;
  /** 열려 있는 xterm 입력 읽기 수(기본 provider만 올린다). */
  let openReads = 0;

  /** 기본 입력 공급자: 직전 출력의 꼬리를 프롬프트로 xterm에서 한 줄 읽는다(`prompt` 인자는 자체 꼬리를 쓰므로 무시한다). */
  const readInput: InputProvider = async (_prompt, signal) => {
    if (signal.aborted) return null;
    // 읽는 도중 abort(Ctrl+C·`stop()`·`reset()`·크래시): 열린 읽기를 끝내 다음 Enter가 죽은 읽기에 들어가지 않게 한다.
    // 화면 정리(접두 재출력·감긴 입력 아래 행 머리)는 벤더 `settle`이 한다(`06-editing.md`). settle이 실패하면(`false`)
    // `promptRow.endRead`가 대체 개행을 낸다 — 그리기 전 읽기였으면 무조건, 아니면 꼬리에 보이는 글자가 있을 때만(RD-028 §3).
    // dispose 중에는 화면에 쓰지 않는다.
    const onAbort = () => {
      promptRow.endRead(disposed ? { screen: false } : { screen: true });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    openReads += 1;
    try {
      // 읽기 줄은 history에 남기지 않는다(벤더 `ReadOptions.history: false`). 빈 줄 Ctrl+D는 EOF다(RD-048,
      // core가 `STDIN_EOF`를 `input()`의 `EOFError`로 바꾼다).
      return await promptRow.read("", {
        cancelable: true,
        signal,
        history: false,
        eof: true,
      });
    } catch (error) {
      // `cancelRead()`로 끝난 읽기는 오류가 아니라 읽기 취소(null)다.
      if (error instanceof ReadCancelledError || disposed) return null;
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      openReads -= 1;
    }
  };

  const clearScreen = () => {
    promptRow.clear();
  };

  /** core가 `run()`을 받아들일 때(`onRunAccepted`) 화면을 준비한다. 새 실행의 꼬리는 비어 있다(core도 실행 시작에 꼬리를 비운다). */
  const prepareScreen = () => {
    if (options.clearOnRun === true) {
      clearScreen();
      return;
    }
    // 현재 io 꼬리에 보이는 글자가 있으면 개행 뒤에서 시작한다(미종결 줄로 끝난 이전 출력·입력 뒤, RD-010 리셋 규칙과
    // 같다, TRP-006).
    promptRow.breakLine();
  };

  // 벤더 `Readline`은 활성 읽기가 없을 때만 부른다(읽기 중 Ctrl+C는 벤더가 읽기를 취소한다). 판정은 core `interrupt()`
  // 한 곳이다(규칙: `docs/design/14-runner.md` 14.5.3). 현재 runner를 늦게 읽는다.
  readline.setCtrlCHandler(() => {
    // tty 로컬 에코 흉내. 눌림을 실제로 보냈을 때만 쓴다(전송 뒤에 써야 `t^Cx: ` 순서가 유지된다).
    if (runner?.interrupt() === "sent") sinks.write("^C");
  });

  try {
    runner = createRunner({
      createWorker: options.createWorker,
      pyodide: options.pyodide,
      filename: options.filename,
      topLevelAwait: options.topLevelAwait,
      inputProvider: options.inputProvider ?? readInput,
      onOutput: (chunk) => {
        if (chunk.stream === "stdout") sinks.write(chunk.text);
        else sinks.writeErrorRaw(chunk.text);
        options.onOutput?.(chunk);
      },
      onStatus: (status) => {
        // 비격리·미지원은 worker가 없어 이후 어떤 신호도 없다. 사용자가 이유를 볼 수 있게 안내를 먼저 낸다(ADR-0004,
        // design.md D4).
        if (status === "not-isolated") {
          promptRow.notice(NOT_ISOLATED_NOTICE, "warning");
        } else if (status === "unsupported") {
          promptRow.notice(UNSUPPORTED_BROWSER_NOTICE, "warning");
        }
        options.onStatus?.(status);
      },
      onCrash: options.onCrash,
      // core가 `run()`을 받아들인 순간에만 화면을 준비한다. 거부(`busy`·`unavailable`·`disposed`·비문자열)에서는 불리지 않는다.
      // `disposed` 방어가 없어도 된다: core는 `dispose()` 뒤 `run()`을 콜백 전에 거부하고 terminal `dispose()`는 core를 먼저 끝낸다.
      onRunAccepted: prepareScreen,
      onLoadFailed: (message) => {
        sinks.writeError(`pyodide 로드 실패: ${message}`);
      },
    });
  } catch (error) {
    // 옵션 오류 등으로 core가 던졌다. 붙인 줄 편집기·선택 복사를 남기지 않는다.
    disposed = true;
    io.close();
    surface.dispose();
    throw error;
  }
  const core = runner;

  return {
    run: (code) => core.run(code),
    stop: () => core.stop(),
    reset: () => core.reset(),
    clear() {
      if (disposed || openReads > 0) return;
      clearScreen();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      io.close();
      // runner를 먼저 끝낸다: 열린 읽기의 signal이 abort돼 `cancelRead()`가 돈 뒤에 줄 편집기를 뗀다.
      core.dispose();
      surface.dispose();
    },
    get status() {
      return core.status;
    },
    setCopyOnSelect(on) {
      if (disposed) return;
      surface.setCopyOnSelect(on);
    },
  };
}
