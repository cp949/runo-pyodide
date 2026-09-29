/**
 * 세션 하나(worker 1개)가 필요로 하는 자원·게이트(`00-architecture.md` 4.2). `reset()`(RD-010)이 통째로 교체하는 단위다.
 * interrupt buffer·송신기도 세션마다 새로 만든다. 옛 worker는 `terminate()` 뒤에도 한동안 살아 같은 buffer의 SIGINT를
 * 가로챌 수 있다(TRP-049·`14-runner.md` 14.3.5).
 * 핸들(`index.ts`)이 소유하는 `readline`·Ctrl+C 핸들러는 세션을 넘어 산다.
 * 공통 부분(worker·프레임·RPC·`readInput`·게이트·종료)은 core 세션(`startCoreSession`)이 맡는다.
 * REPL 화면 상호작용은 main driver(`repl-main-driver.ts`)가 맡는다. 이 모듈은 둘을 조립해 `ReplSession`을 낸다.
 * Ctrl+C 한 번(게이트 → `^C` 에코 → 전송)은 `interrupt()`가 묶는다. 핸들의 Ctrl+C 핸들러는 `interrupt()`만 부른다.
 */
import type { TerminalSurface } from "@cp949/runo-pyodide-terminal/internal";
import type { ReplStatus } from "./index";
import {
  createInterruptBuffer,
  createInterruptSender,
  startCoreSession,
  type CoreSession,
} from "@cp949/runo-pyodide-core";
import { createReplMainDriver, type SourcePrompt } from "./repl-main-driver";
import type { CompletionPopover } from "./terminal/completion-popover";
import type { SourceLink } from "./run-source";
import type { SourceCompletion } from "./worker/complete-source";

export interface StartSessionOptions {
  /** 핸들 소유. 세션을 넘어 산다(`readline`·history 유지). 세션마다 `surface.openIo()`로 입출력을 새로 연다. */
  surface: TerminalSurface;
  /** 세션마다 불린다. */
  createWorker: () => Worker;
  /** 끝 `/`가 붙은 pyodide CDN 위치. */
  indexURL: string;
  /** 초기화 프레임 `driver` 필드에 그대로 싣는다. 값을 바꾸려면 새 세션(RD-012). */
  topLevelAwait: boolean;
  /** 핸들이 소유한 `runSource` 슬롯의 창구. 세션을 넘어 사는 슬롯을 이 세션의 읽기 흐름에 잇는다. */
  source: SourceLink;
  /** 상태가 바뀔 때 부른다. */
  onStatus: (status: ReplStatus) => void;
  /** worker `error` 이벤트 또는 `crashed` 알림(첫 신호만) 뒤 부른다. */
  onCrash?: (message: string) => void;
  /** 있으면(옵션 켬, RD-049) main driver로 그대로 전달한다. */
  completionPopover?: () => CompletionPopover;
}

export interface ReplSession {
  /**
   * Ctrl+C 한 번을 처리한다.
   * - 게이트가 닫혀 있으면(대상 코드 없음) 무동작.
   * - 열려 있으면 세션 sink로 `^C`를 에코한 뒤 이 세션의 interrupt buffer에 눌림을 쓴다.
   *
   * 규칙: `03-ctrl-c.md` 2.7.
   */
  interrupt(): void;
  /** 지금 `runSource`를 받아들일 수 있는가. 부작용이 없다(`repl-main-driver.ts`). */
  sourcePrompt(): SourcePrompt;
  /** 열린 읽기를 가져가 `{ source }`로 응답하도록 준비한다. 받아들일 수 없으면 `false`. */
  sendSource(code: string): boolean;
  /** 옛 읽기를 끝내고 세션 자원을 정리한다. 순서: `08-session.md` 8.1 2번(core `terminate`와 REPL driver 훅). */
  terminate(): void;
}

export function startSession(options: StartSessionOptions): ReplSession {
  const {
    surface,
    createWorker,
    indexURL,
    topLevelAwait,
    source,
    onStatus,
    onCrash,
    completionPopover,
  } = options;

  // 세션마다 새 buffer·송신기. 프레임에 넣는 것과 같은 SharedArrayBuffer 뷰를 송신기도 쓴다. 송신기는 `send()` 전에는 타이머가 없어,
  // 아래에서 던져도(worker 생성 실패 등) 따로 정리할 것이 없다.
  const interruptBuffer = createInterruptBuffer();
  const interruptSender = createInterruptSender(interruptBuffer);

  // main driver의 `complete`가 core 세션의 `call`을 참조한다. 실제 Tab을 누를 때(세션이 시작된 뒤)만 불리므로 늦게 채워도 된다.
  const ref: { core?: CoreSession } = {};
  const repl = createReplMainDriver({
    readline: surface.readline,
    // sink 세트·터미널 뷰는 세션마다 새로 연다. 새 세션이 이전 꼬리를 물려받지 않게(05-output.md 4.1).
    io: surface.openIo(),
    promptRow: surface.promptRow,
    interruptSender,
    topLevelAwait,
    source,
    completionPopover,
    complete: (code, pending) => {
      if (!ref.core) throw new Error("세션이 아직 시작되지 않았다");
      return ref.core.call<SourceCompletion>("complete", code, pending);
    },
  });
  const core = startCoreSession({
    createWorker,
    indexURL,
    interruptBuffer,
    interruptSender,
    driver: repl.driver,
    output: repl.output,
    onStatus,
    onCrash,
  });
  ref.core = core;

  return {
    interrupt: () => {
      if (!core.pythonRunning()) return;
      repl.echoCtrlC();
      interruptSender.send();
    },
    sourcePrompt: () => repl.sourcePrompt(),
    sendSource: (code) => repl.sendSource(code),
    terminate: () => core.terminate(),
  };
}
