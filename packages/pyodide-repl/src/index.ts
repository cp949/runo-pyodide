import type { Terminal } from "@xterm/xterm";
import {
  callConsumer,
  DEFAULT_PYODIDE_INDEX_URL,
  detectRuntimeSupport,
  RunRejectedError,
  type RunRejectedReason,
  type RunResult,
} from "@cp949/runo-pyodide-core";
import {
  endRun,
  rejection,
  createSourceSlot,
  type SourceEnd,
} from "./run-source";
import { startSession, type ReplSession } from "./session";
import { createCompletionPopover } from "./terminal/completion-popover";
import { createTerminalSurface } from "@cp949/runo-pyodide-terminal/internal";
import type { CopyResult } from "@cp949/runo-pyodide-terminal";

export type { CopyResult };

/**
 * `runSource()`의 거부 오류·결과 유니온. core의 같은 클래스·타입이다(`createRunner`와 `instanceof`가 성립한다, 14.3.2).
 */
export { RunRejectedError };
export type { RunRejectedReason, RunResult };

/** 기본 pyodide CDN 위치. 끝 `/`를 포함한다(`00-architecture.md` 4.1). 값은 core가 `pyodide/package.json`에서 유도한다. */
export { DEFAULT_PYODIDE_INDEX_URL };

/** 비격리 페이지에서 세션을 시작하지 않는 이유를 알리는 터미널 안내 문구(ADR-0004). */
export const NOT_ISOLATED_WARNING =
  "경고: cross-origin isolation이 꺼져 있어 Python 세션을 시작하지 않습니다. 서버가 COOP/COEP 헤더를 보내야 합니다.";

/**
 * 브라우저가 pyodide 런타임의 wasm 기능을 지원하지 않는 페이지에서 세션을 시작하지 않는 이유를 알리는 터미널 안내
 * 문구(design.md D4). 런타임 floor 값을 하드코딩하지 않고 README 호환 절을 가리킨다.
 */
export const UNSUPPORTED_BROWSER_WARNING =
  "경고: 이 브라우저는 pyodide 런타임이 요구하는 기능을 지원하지 않아 Python 세션을 시작하지 않습니다. 브라우저 호환(README) 절을 확인하세요.";

/** `reset()`이 옛 세션 뒤에 남기는 안내 줄(청록, `08-session.md`). */
export const RESET_NOTICE =
  "[세션 리셋됨 — 이전 변수/import가 모두 초기화되었습니다]";

/**
 * 세션의 생애를 앱에 알리는 값. RD-004는 `loading`·`ready`·`load-failed`·`not-isolated`를 발행하고, RD-005부터
 * `terminated`(`exit()`)를 발행한다. `crashed`는 RD-010이 발행한다. `unsupported`는 design.md D4(브라우저가 pyodide
 * 런타임 wasm 기능을 지원하지 않음, 판정 순서는 `detectRuntimeSupport()`).
 */
export type ReplStatus =
  | "loading"
  | "ready"
  | "load-failed"
  | "not-isolated"
  | "unsupported"
  | "terminated"
  | "crashed";

export interface ReplOptions {
  /** 호출자가 소유하는 xterm `Terminal`. 코어는 줄 편집기를 붙이기만 하고 dispose하지 않는다. */
  terminal: Terminal;
  /** 세션마다 불린다(리셋은 RD-010). 앱은 `new Worker(new URL("./repl.worker.ts", import.meta.url), { type: "module" })`를 돌려준다. */
  createWorker: () => Worker;
  /** 기본 CDN. 끝 `/`가 없으면 붙인다. */
  pyodide?: { indexURL?: string };
  /** 상태가 바뀔 때 부른다. `loading`은 `createRepl`이 반환하기 전에 동기로 온다. */
  onStatus?: (status: ReplStatus) => void;
  /** worker `error` 이벤트 또는 `crashed` 알림(첫 신호만) 뒤, 또는 `reset()` 중 worker 생성 실패 뒤 `onStatus("crashed")` 다음에 부른다(RD-010). */
  onCrash?: (message: string) => void;
  /** 기본 `false`. `=== true`일 때만 켠다. 바꾸려면 `reset({ topLevelAwait })`(RD-012, `02-console-core.md` 5.4). */
  topLevelAwait?: boolean;
  /** 드래그 선택(`mouseup`) 시 자동 복사할지. 기본 `true`(`=== false`일 때만 끔). Ctrl+C 복사는 이 값과 무관하게 항상 동작한다(RD-017). */
  copyOnSelect?: boolean;
  /** 선택 복사(자동·Ctrl+C 모두) 결과를 알린다(RD-017). */
  onCopy?: (result: CopyResult) => void;
  /**
   * 기본 꺼짐(`=== true`일 때만 켬). 두 번째 Tab의 완성 후보 목록을 텍스트(`printAbove`) 대신 커서 옆
   * 선택 상자(popover)로 띄운다. `createRepl` 때만 읽는다(세터 없음, 규칙: `docs/design/07-tab-completion.md` 7.6).
   */
  completionPopover?: boolean;
}

export interface ReplHandle {
  /**
   * worker와 RPC를 정리하고 대기 중인 읽기를 끝내며 줄 편집기를 뗀다. 두 번 불러도 안전하다.
   * `Terminal`은 dispose하지 않는다.
   */
  dispose(): void;
  /**
   * 화면·history를 유지한 채 worker를 새로 만든다(변수·import는 사라진다). 청록 안내 줄(`RESET_NOTICE`) 뒤 새 배너가
   * 뜬다. `dispose()` 뒤·`not-isolated`·`unsupported`면 no-op. 그 외 상태(`ready`·`terminated`·`crashed`·`load-failed`·`loading`)는
   * 전부 허용한다. 동기이며 안에서 `loading`을 동기로 발행하고 이후 새 worker의 `ready`/`load-failed`가 재발행한다.
   * `topLevelAwait`가 boolean이면 그 값으로 바꾸고, 생략·`undefined`면 마지막으로 적용한 값을 유지한다(RD-012).
   * 확인 대화상자·디바운스 없음. 새 worker 생성(`createWorker`)이 던지면 던지지 않고 `loading` 대신 `crashed` → `onCrash`로
   * 넘긴다(`createRunner.reset()`과 같다). 복구는 다시 `reset()`이다 — `onCrash` 안에서 동기로 부르면 생성이 계속 실패할 때 재귀한다.
   */
  reset(options?: { topLevelAwait?: boolean }): void;
  /** `globalThis.crossOriginIsolated === true`. 거짓이면 worker가 없다(참이어도 `detectRuntimeSupport()`가 `unsupported`면 마찬가지다). */
  readonly crossOriginIsolated: boolean;
  /** 드래그 자동 복사 on/off를 바꾼다. 리셋 없음(`reset()`과 무관). `dispose()` 뒤 no-op(RD-017). */
  setCopyOnSelect(on: boolean): void;
  /**
   * 코드를 REPL globals에서 실행하고 결말을 돌려준다(RD-022a). 입력 줄 에코 없이 출력만 화면에 내고, 치던 한 줄(텍스트·커서)은 보존해
   * 실행이 끝나면 `>>> pri`처럼 다시 그린 뒤(그 읽기가 화면에 그려진 뒤) resolve한다. `input()`·Ctrl+C·Tab은 평소 명령 실행과 같다.
   * history에 남기지 않는다. 결과 유니온은 `createRunner`와 같다(`ok`·`error`·`interrupted`·`exit`·`restarted`). `exit`(`SystemExit`)여도
   * 세션은 유지된다.
   *
   * 실행하지 못하면 `RunRejectedError`로 reject한다: `disposed`(`dispose()` 뒤), `unavailable`(`not-isolated`·`unsupported`·`load-failed`·`crashed`·
   * `terminated`), `busy`(블록 입력 중·Python 실행 중·`input()` 대기 중·다른 `runSource` 진행·대기 중·Tab 왕복 중·프롬프트가 그려지기
   * 전). `code`가 문자열이 아니면 `TypeError`. `loading`(최초·리셋 직후)이면 슬롯을 차지하고 첫 `>>> `에서 실행한다. 대기 중 `reset()`은
   * 유지하고(그 리셋의 worker 생성이 실패하면 `crashed`) `load-failed`는 `unavailable`, 실행 중 `reset()`은 `{ kind: "restarted" }`, 실행 중·대기 중 크래시는 `crashed`, 실행 중·대기
   * 중 `dispose()`는 `disposed`다. 이미 정해진 결말을 그리는 도중의 사건은 그 결말을 바꾸지 않는다.
   */
  runSource(code: string): Promise<RunResult>;
  /** 지금 `runSource()`를 부르면 `busy`로 거부되는가. 판정은 `runSource()`와 같은 함수다. `dispose()` 뒤는 `false`다(`disposed`로 거부된다). */
  readonly busy: boolean;
}

function normalizeIndexUrl(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

export function createRepl(options: ReplOptions): ReplHandle {
  // 선택 복사·`Readline` 조립과 정리는 surface가 소유한다(`!isolated`와도 무관, 확정 8).
  // history는 세션(마운트) 동안 메모리에만 둔다. 새로고침 뒤에는 비어 있어야 한다. 세션을 넘어 산다(리셋은 RD-010).
  const surface = createTerminalSurface(options.terminal, {
    copyOnSelect: options.copyOnSelect,
    onCopy: options.onCopy,
    readline: { persist: false, skipBlankHistory: true },
  });
  const readline = surface.readline;
  const onStatus = (next: ReplStatus) => callConsumer(options.onStatus, next);
  const onCrash = (message: string) => callConsumer(options.onCrash, message);
  // `crossOriginIsolated`(getter 의미 그대로, ADR-0004)와 판정 순서(`unsupported` 먼저)를 소유한 `detectRuntimeSupport()`는
  // 별개다 — `isolated`는 `ReplHandle.crossOriginIsolated`가 쓰고, `support`가 세션 시작 여부를 정한다(규칙:
  // `docs/design/14-runner.md` 14.3.1).
  const isolated = globalThis.crossOriginIsolated === true;
  const support = detectRuntimeSupport();
  const supported = support === "supported";
  const indexURL = normalizeIndexUrl(
    options.pyodide?.indexURL ?? DEFAULT_PYODIDE_INDEX_URL,
  );

  let disposed = false;
  let session: ReplSession | undefined;
  // `runSource`의 실행 슬롯. 세션을 넘어 산다(대기 중인 코드는 `reset()`을 넘겨 새 worker의 첫 `>>> `에서 실행된다).
  const slot = createSourceSlot();
  // 마지막으로 알린 상태(`runSource` 거부 판정의 재료). 알림 전에 갱신한다.
  let status: ReplStatus = supported ? "loading" : support;
  // 상태가 슬롯을 끝내는 사건: 크래시는 `crashed`, 로드 실패·`exit()`는 `unavailable`.
  const statusEnd = (next: ReplStatus): SourceEnd | undefined =>
    next === "crashed"
      ? "crashed"
      : next === "load-failed" || next === "terminated"
        ? "unavailable"
        : undefined;
  /**
   * 상태를 알린다. 소비자 콜백이 안에서 `runSource`·`reset`·`dispose`를 부를 수 있으므로 슬롯·상태를 콜백 앞에 확정하고 슬롯의 결과는
   * 콜백 뒤에 낸다(TRP-051).
   */
  const emitStatus = (next: ReplStatus) => {
    status = next;
    const end = statusEnd(next);
    const run = end === undefined ? undefined : slot.take();
    onStatus(next);
    if (run !== undefined && end !== undefined) endRun(run, end);
  };
  // supported일 때만 있다. not-isolated·unsupported에서 reset()은 no-op(ReplHandle.reset 문서).
  let resetSession: ((next?: { topLevelAwait?: boolean }) => void) | undefined;

  if (!supported) {
    // not-isolated: SharedArrayBuffer가 없어 초기화 프레임을 만들 수 없다(ADR-0004, TRP-002). unsupported: 브라우저가
    // pyodide 런타임 wasm 기능을 지원하지 않는다(design.md D4). 두 경우 모두 폴백은 없다.
    surface.promptRow.notice(
      support === "not-isolated"
        ? NOT_ISOLATED_WARNING
        : UNSUPPORTED_BROWSER_WARNING,
      "warning",
    );
    emitStatus(support);
  } else {
    // 마지막으로 적용한 값(sticky). 무인자 reset()·reset({})·reset({ topLevelAwait: undefined })는 이 값을 그대로 쓴다.
    let topLevelAwait = options.topLevelAwait === true;
    // 벤더 `Readline`은 활성 읽기가 없을 때만 부른다(읽기 중 Ctrl+C는 벤더가 같은 프롬프트를 다시 그린다).
    // 현재 세션을 `session` 변수로 늦게 읽는다: 리셋이 세션을 바꿔도 다시 등록할 필요가 없다.
    readline.setCtrlCHandler(() => {
      session?.interrupt();
    });
    // `=== true`일 때만 팩토리를 만든다. 첫 세션·`reset()` 둘 다 이 `spawnSession`을 거친다.
    const completionPopover =
      options.completionPopover === true
        ? () => createCompletionPopover(options.terminal, readline)
        : undefined;
    const spawnSession = () => {
      session = startSession({
        surface,
        createWorker: options.createWorker,
        indexURL,
        topLevelAwait,
        source: slot,
        onStatus: emitStatus,
        onCrash,
        completionPopover,
      });
    };
    spawnSession();
    emitStatus("loading");

    resetSession = (next) => {
      // boolean이 명시된 경우에만 바꾼다. 생략·undefined는 마지막 값을 유지한다(sticky).
      if (typeof next?.topLevelAwait === "boolean")
        topLevelAwait = next.topLevelAwait;
      // 실행 중이던 runSource는 `restarted`로 끝난다. 대기 중인 것은 유지해 새 worker의 첫 `>>> `에서 실행한다(아직 실행되지 않았다).
      // 슬롯은 콜백이 불리기 전에 비운다(TRP-051). 이미 결말이 도착한 것은 그 결말로 끝난다(`endRun`).
      const run = slot.waiting ? undefined : slot.take();
      // `finally`: 정리 중 무엇이 던져도 슬롯에서 뗀 실행은 끝낸다. 옛 worker는 이미 교체됐으므로 `restarted`다.
      try {
        // 열린 읽기를 끝내고 화면을 정리한다. `session.terminate()` 앞, 같은 동기 블록이어야 하고 세션이 없어도(앞
        // 리셋의 worker 생성 실패) 부른다 — 규칙: `08-session.md` 8.1 1번, `docs/traps/TRP-083`.
        surface.promptRow.endRead({ screen: true });
        // 옛 세션 정리(순서: `08-session.md` 8.1 2번).
        if (session !== undefined) session.terminate();
        // 새 worker 생성이 실패해도 끝난 옛 세션을 가리키지 않게 한다(runner `restart()`와 같다).
        session = undefined;
        surface.promptRow.notice(RESET_NOTICE, "info");
        try {
          spawnSession();
        } catch (error) {
          // 세션을 시작하지 못했다(`createWorker` 또는 프레임 전송이 던짐, core 세션이 만든 자원은 정리했다). runner `restart()`와 같이 던지지 않고 `loading`을 거치지 않은 채
          // `crashed` 다음에 `onCrash`로 넘긴다. 대기 중이던 runSource는 `crashed`로 끝난다. 복구는 다시 `reset()`이다.
          emitStatus("crashed");
          if (!disposed) onCrash(String(error));
          return;
        }
        emitStatus("loading");
      } finally {
        if (run !== undefined) endRun(run, "restarted");
      }
    };
  }

  /** `runSource()`의 거부 판정. `busy` 게터가 같은 함수를 쓴다(부작용 없음). */
  const judge = ():
    | { kind: "wait" | "open" }
    | { kind: "reject"; reason: RunRejectedReason } => {
    if (disposed) return { kind: "reject", reason: "disposed" };
    if (
      status === "not-isolated" ||
      status === "unsupported" ||
      status === "load-failed" ||
      status === "crashed" ||
      status === "terminated"
    ) {
      return { kind: "reject", reason: "unavailable" };
    }
    // 대기 중인 것도 슬롯을 차지한다.
    if (slot.occupied) return { kind: "reject", reason: "busy" };
    const prompt = session?.sourcePrompt() ?? "busy";
    return prompt === "busy"
      ? { kind: "reject", reason: "busy" }
      : { kind: prompt };
  };

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      // 실행 중·대기 중이던 runSource는 `disposed`로 끝난다(이미 결말이 도착한 것은 그 결말로). 슬롯은 정리 앞에서 비운다.
      const run = slot.take();
      // `finally`: 정리 중 무엇이 던져도 슬롯에서 뗀 실행은 끝낸다(`reset()`과 같은 이유).
      try {
        // 알림 핸들러가 dispose된 줄 편집기에 쓰지 않도록 `surface.dispose()` 앞에서 세션을 끝낸다(게이트·송신기·
        // RPC·worker, `08-session.md` 8.1 2번).
        session?.terminate();
        // 선택 복사 리스너와 `Readline`을 뗀다(surface가 두 정리의 순서를 소유한다). 벤더 dispose가 멱등이라
        // term.dispose()가 addon을 다시 dispose해도 안전하다.
        surface.dispose();
      } finally {
        if (run !== undefined) endRun(run, "disposed");
      }
    },
    reset(options) {
      if (disposed) return;
      resetSession?.(options);
    },
    get crossOriginIsolated() {
      return isolated;
    },
    setCopyOnSelect(on) {
      if (disposed) return;
      surface.setCopyOnSelect(on);
    },
    runSource(code) {
      if (typeof code !== "string") {
        return Promise.reject(
          new TypeError("runSource 인자 오류 — code: 문자열 필요"),
        );
      }
      const verdict = judge();
      if (verdict.kind === "reject")
        return Promise.reject(rejection(verdict.reason));
      // 첫 프롬프트 전(`loading`)이면 슬롯이 기다린다. 첫 `readLine` 요청이 오면 그 요청에 `{ source }`로 응답한다.
      if (verdict.kind === "wait") return slot.occupy(code, "waiting");
      // 프롬프트가 열려 있다: 열린 읽기를 가져가고 줄을 보존한다. `judge()`가 `open`이면 가져갈 수 있다.
      if (!session?.sendSource(code)) return Promise.reject(rejection("busy"));
      return slot.occupy(code, "sent");
    },
    get busy() {
      const verdict = judge();
      return verdict.kind === "reject" && verdict.reason === "busy";
    },
  };
}
