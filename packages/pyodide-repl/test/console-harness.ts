/**
 * REPL 콘솔 통합 하니스(node + 실제 pyodide 전용, 09-testing.md 9.1). 시험 파일은 최상위에서 `useConsoleHarness()`를
 * 한 번 불러 pyodide 로드·해체를 등록하고, 시험마다 `setup()`으로 콘솔·버퍼·SIGINT 핸들러·제출 러너를 조립한다.
 *
 * 조립은 운영과 같은 `attachRuntime`(03-ctrl-c.md 2.6)이다: `prepare?.(buffer)`(핸들러 설치 전) →
 * `attachRuntime(pyodide, repl.pyconsole, { interruptBuffer: buffer, stdin, report })`. attach가 폐기까지 하므로
 * `prepare`로 미리 만든 요청 번호는 연결 시점에 지워지고 ack가 오른다(`sigint-handler.test.ts` 참고).
 */
import { loadPyodide, type PyodideInterface } from "pyodide";
import type { PyProxy } from "pyodide/ffi";
import { afterAll, afterEach, beforeAll, type Mock, vi } from "vitest";
import {
  createInterruptBuffer,
  SIGNAL,
  signalInterrupt,
} from "@cp949/runo-pyodide-core";
import {
  acknowledgeInterrupt,
  discardPendingInterrupt,
} from "@cp949/runo-pyodide-core/worker";
import {
  createConsole,
  type PyodideConsoleProxy,
  type ReplConsole,
} from "../src/worker/console";
import { loadSplitPaste } from "../src/worker/multiline";
import {
  attachRuntime,
  type InterruptIdle,
  type RuntimeAttachDeps,
  warnDegraded,
  INTERRUPT_PRESSER_ROLE,
  type PresserCommand,
  type PresserEvent,
  type ReportDegraded,
} from "@cp949/runo-pyodide-core/test-utils/worker";
import {
  createSubmissionRunner,
  PS1,
  type SubmissionResult,
  type SubmissionRunner,
} from "../src/worker/submission-runner";
import { spawnRole } from "@repo/pyodide-testkit/thread";

/** 제출이 끝나고 다음 줄을 받는 상태(`>>> `). */
export const READY: SubmissionResult = { prompt: PS1, exit: false };

/**
 * 상한 있는 바쁜 루프(약 0.23초). 핸들러가 잘못돼 SIGINT가 버려져도 시험이 멈추지 않고 단언에서 실패한다.
 * `while True: pass`는 눌림이 소실되면 vitest가 멈출 수 없는 무한 루프가 된다.
 */
export const BUSY = "for _ in range(10**7): pass";

/** `started()`가 참을 돌려주는 최대 시간(ms). `while started(): pass`가 눌림 소실 때 이 시간 뒤에는 끝난다. */
export const STARTED_LIMIT_MS = 5000;

/** 사용자 프로그램 소스를 한 줄 `exec(...)` 제출로 만든다. JSON 문자열은 Python 문자열 리터럴로도 유효하다. */
export const execSource = (program: string) =>
  `exec(${JSON.stringify(program)})`;

/** `<console>` 한 줄 실행이 `KeyboardInterrupt`로 끝났을 때의 정확한 출력. 소스 줄·우리 프레임이 없다. */
export const CONSOLE_TRACEBACK =
  'Traceback (most recent call last):\n  File "<console>", line 1, in <module>\nKeyboardInterrupt\n';

/** 눌림 스레드 보고 타입. `presser().done()`의 결과를 받는 시험이 쓴다. */
export type { PresserEvent };

/** [SIGINT, ack, 요청 번호, 예약]. 슬롯 배치는 프로토콜 규약이라 인덱스 그대로 본다. */
export const slots = (buffer: Int32Array) => Array.from(buffer);

export interface SetupOptions {
  topLevelAwait?: boolean;
  /** 핸들러를 설치하기 전에 버퍼를 만진다(이전 세션이 남긴 요청 번호 등). attach가 뒤이어 폐기한다. */
  prepare?: (buffer: Int32Array) => void;
  /** 조각 교체·정지한 실행 깨우기·트레이스백 파일명 가드가 알리는 저하 지점을 받는다. 기본은 `console.warn`이다. */
  report?: ReportDegraded;
  /** 기본은 각본 없는 stdin(`requestInput`은 아무것도 안 하고 `wait`는 던진다, 각본 없는 읽기는 `OSError`). */
  stdin?: RuntimeAttachDeps["stdin"];
}

/** `wakeAfter`의 결과. `woke`는 `interruptIdle()`이 깨울 것을 찾았는지다. */
export interface WakeOutcome {
  woke: boolean;
}

/** 눌림 스레드 조종기. `presser()`가 돌려준다. */
export interface Presser {
  /** 눌림을 예약한다. 바로 돌아오고, 눌림 스레드가 `started()`를 기다린 뒤 쓴다. */
  press(
    command: Omit<Extract<PresserCommand, { kind: "press" }>, "kind">,
  ): void;
  /** 시작 표시를 지운다(라운드 반복용). */
  reset(): Promise<void>;
  /** 눌림을 다 쓴 뒤의 보고를 기다린다. */
  done(): Promise<PresserEvent>;
}

export interface ConsoleRunner {
  /** 한 줄 제출. `createSubmissionRunner`의 `run`이다. */
  run: SubmissionRunner["run"];
  /** 이 조립이 모은 화면 바이트. sink가 붙이는 개행까지 그대로다. */
  screen: { stdout: string; stderr: string };
  buffer: Int32Array;
  pyconsole: PyodideConsoleProxy;
  /** 이 조립의 REPL 콘솔. `runSource` 시험(`run-source.test.ts`)이 같은 콘솔에 실행기를 붙인다. */
  repl: ReplConsole;
  /** 눌림 스레드를 띄운다. 시험이 끝나면 종료된다. */
  presser: () => Presser;
  /**
   * 눌림 스레드에 "시나리오에 들어갔다"를 알린다. Python 전역 `started()`가 이것이고, JS 쪽 훅(stdin `wait()` 등)에서도
   * 부를 수 있다. 첫 호출 뒤 `STARTED_LIMIT_MS` 동안만 참을 돌려준다.
   */
  markStarted: () => boolean;
  /** 설치가 돌려준 Python `interrupt_idle`. 공용 해체가 destroy한다 — 시험이 직접 destroy하면 해체가 두 번 destroy해 던진다. */
  interruptIdle: InterruptIdle;
  /**
   * `ms` 뒤에 감시 타이머(03-ctrl-c.md 2.5)의 한 틱을 흉내낸다: `signalInterrupt` → `interruptIdle()` → 깨웠으면
   * SIGINT를 소비하고(`compareExchange(2 → 0)`) 소비에 성공했을 때만 ack. 깨우지 못했으면 SIGINT를 남겨 재개한
   * 사용자 스택의 폴링이 받게 한다. JSPI로 정지한 동안에는 JS 이벤트 루프가 비어 같은 스레드 타이머로 충분하다.
   */
  wakeAfter: (ms: number) => Promise<WakeOutcome>;
}

/**
 * 공용 해체가 치울 것: `wakeAfter`가 건 타이머, 설치가 돌려준 proxy, 연결한 버퍼. `setup()`이 자동으로 넣고, 하니스 밖에서
 * `attachRuntime`을 직접 부른 시험은 `track()`으로 넣는다. vitest가 파일마다 모듈을 따로 읽으므로 파일 사이에 새지 않는다.
 */
const pendingWakes: ReturnType<typeof setTimeout>[] = [];
const liveInterruptIdles: InterruptIdle[] = [];
const liveBuffers: Int32Array[] = [];

// 설치는 pyodide 모듈 전역 `pyodide.ffi.run_sync`·`pyodide.webloop.run_sync`를 래퍼로 바꾼다. 파일 하나가 pyodide
// 인스턴스를 공유하므로 되돌리지 않으면 setup마다 래퍼가 겹쌓인다. 첫 설치 전 값을 모듈 속성에 한 번 붙잡아 두고
// 해체가 그것으로 되돌린다.
const SAVE_RUN_SYNC = `import pyodide.ffi

if not hasattr(pyodide.ffi, '_test_original_run_sync'):
    pyodide.ffi._test_original_run_sync = pyodide.ffi.run_sync
`;
const RESTORE_RUN_SYNC = `import pyodide.ffi
import pyodide.webloop

original = getattr(pyodide.ffi, '_test_original_run_sync', None)
if original is not None:
    pyodide.ffi.run_sync = original
    pyodide.webloop.run_sync = original
`;

/** 사용자 globals를 오염시키지 않도록 버리는 namespace에서 돌린다. */
function runInScratch(
  pyodide: Pick<PyodideInterface, "runPython" | "toPy">,
  source: string,
): void {
  const namespace = pyodide.toPy({}) as PyProxy;
  try {
    pyodide.runPython(source, {
      globals: namespace,
      filename: "<console-harness>",
    });
  } finally {
    namespace.destroy();
  }
}

/** 로드 직후 한 번 부른다. 첫 설치 전의 `run_sync`를 붙잡아 둔다(이미 있으면 유지). */
function saveRunSync(
  pyodide: Pick<PyodideInterface, "runPython" | "toPy">,
): void {
  runInScratch(pyodide, SAVE_RUN_SYNC);
}

/** 공용 해체에서 부른다. `saveRunSync`가 붙잡은 값으로 래퍼 층을 걷어낸다. 저장한 적이 없으면 아무것도 하지 않는다. */
function restoreRunSync(
  pyodide: Pick<PyodideInterface, "runPython" | "toPy">,
): void {
  runInScratch(pyodide, RESTORE_RUN_SYNC);
}

/**
 * 콘솔 + interrupt buffer + SIGINT 핸들러 + 제출 러너를 조립한다. Python 전역 `press`·`resend`·`started`를 심어
 * 시나리오가 같은 스레드에서 눌림을 만들거나 눌림 스레드에 시작을 알릴 수 있게 한다.
 */
function setupConsoleRunner(
  pyodide: PyodideInterface,
  {
    topLevelAwait = false,
    prepare,
    report = warnDegraded,
    stdin = {
      requestInput: () => {},
      wait: () => {
        throw new Error("console-harness: stdin 각본 없음");
      },
    },
  }: SetupOptions = {},
): ConsoleRunner {
  const screen = { stdout: "", stderr: "" };
  const repl = createConsole(
    pyodide,
    {
      write: (text) => {
        screen.stdout += text;
      },
      writeErrorRaw: (text) => {
        screen.stderr += text;
      },
    },
    { topLevelAwait },
  );
  const buffer = createInterruptBuffer();
  prepare?.(buffer);
  // 운영과 같은 조립(03-ctrl-c.md 2.6). `run_sync` 원본은 `useConsoleHarness`가 로드 직후 붙잡아 두었다.
  const attached = attachRuntime(pyodide, repl.pyconsole, {
    interruptBuffer: buffer,
    stdin,
    report,
  });
  const interruptIdle = attached.interruptIdle;
  track(buffer, interruptIdle);

  // 실제 sink(readline.println)처럼 writeOutput/writeError가 끝에 개행을 붙인다.
  const { run } = createSubmissionRunner(
    pyodide,
    repl,
    {
      writeOutput: (text) => {
        screen.stdout += `${text}\n`;
      },
      writeError: (text) => {
        screen.stderr += `${text}\n`;
      },
    },
    { splitPaste: loadSplitPaste(pyodide) },
  );

  // 실행 중인 Python에서 부르는 JS 콜백. `press`는 main이 Ctrl+C마다 쓰는 것, `resend`는 main의 재전송(같은 요청 번호로
  // SIGINT 슬롯만 다시 쓴다)이다.
  pyodide.globals.set("press", () => signalInterrupt(buffer));
  pyodide.globals.set("resend", () => {
    Atomics.compareExchange(buffer, 0, 0, 2);
  });
  // 눌림 스레드에 "Python이 시나리오에 들어갔다"를 알린다. 참을 돌려주는 동안 `while started(): pass`가 돈다.
  const ctl = new Int32Array(new SharedArrayBuffer(4));
  let firstCallAt: number | undefined;
  function markStarted(): boolean {
    Atomics.store(ctl, 0, 1);
    Atomics.notify(ctl, 0);
    firstCallAt ??= performance.now();
    return performance.now() - firstCallAt < STARTED_LIMIT_MS;
  }
  pyodide.globals.set("started", markStarted);

  function presser(): Presser {
    const role = spawnRole(INTERRUPT_PRESSER_ROLE, { buffer, ctl });
    return {
      press(command): void {
        role.post({ kind: "press", ...command } satisfies PresserCommand);
      },
      async reset(): Promise<void> {
        firstCallAt = undefined;
        role.post({ kind: "reset" } satisfies PresserCommand);
        await role.next();
      },
      done: () => role.next<PresserEvent>(),
    };
  }

  function wakeAfter(ms: number): Promise<WakeOutcome> {
    return new Promise<WakeOutcome>((resolve) => {
      pendingWakes.push(
        setTimeout(() => {
          signalInterrupt(buffer);
          const woke = interruptIdle();
          // 깨웠을 때만 소비한다. 소비에 성공한 틱만 ack한다(03-ctrl-c.md 2.2의 ack 지점 ②).
          if (woke && Atomics.compareExchange(buffer, SIGNAL, 2, 0) === 2) {
            acknowledgeInterrupt(buffer);
          }
          resolve({ woke });
        }, ms),
      );
    });
  }

  return {
    run,
    screen,
    buffer,
    pyconsole: repl.pyconsole,
    repl,
    presser,
    markStarted,
    interruptIdle,
    wakeAfter,
  };
}

/** 하니스 밖에서 `attachRuntime`을 직접 부른 시험이 연결한 버퍼와 돌려받은 proxy를 공용 해체에 맡긴다. */
function track(buffer: Int32Array, interruptIdle?: InterruptIdle): void {
  liveBuffers.push(buffer);
  if (interruptIdle) liveInterruptIdles.push(interruptIdle);
}

/**
 * 공용 해체. 남은 SIGINT가 다음 시험의 Python 실행을 끊지 않도록 버퍼를 먼저 떼고 비운 뒤 핸들러를 기본으로 되돌린다.
 * 아직 터지지 않은 `wakeAfter` 타이머와 살아 있는 `interrupt_idle` proxy도 치운다. 각본 없는 읽기는 다음 시험에서
 * `OSError`가 되게 stdin을 되돌린다.
 */
function teardown(pyodide: PyodideInterface): void {
  for (const timer of pendingWakes.splice(0)) clearTimeout(timer);
  for (const idle of liveInterruptIdles.splice(0)) idle.destroy();
  pyodide.setInterruptBuffer(
    undefined as unknown as Parameters<
      PyodideInterface["setInterruptBuffer"]
    >[0],
  );
  for (const buffer of liveBuffers.splice(0)) discardPendingInterrupt(buffer);
  // 아래는 Python을 돌리므로 버퍼를 뗀 뒤에 한다.
  pyodide.runPython(
    "import signal\nsignal.signal(signal.SIGINT, signal.default_int_handler)",
  );
  // `setStdin`은 `sys.stdin` 객체를 바꾸지 않는다(TRP-010). 줄 일부만 읽고 남은 `\n`이 다음 시험의 첫 읽기가 되지 않게
  // 새 스트림으로 갈아 끼운다.
  pyodide.setStdin({ error: true });
  runInScratch(
    pyodide,
    'import sys\nsys.stdin = open(0, encoding="utf-8", closefd=False)',
  );
  restoreRunSync(pyodide);
}

/** `useConsoleHarness`의 파일별 확장 지점. 부르는 순서는 하니스가 고정한다. */
export interface ConsoleHarnessOptions {
  /** `loadPyodide` 전(JSPI 지우기 등). */
  beforeLoad?: () => void;
  /** `loadPyodide` 직후, `run_sync` 원본을 붙잡기 전(설치 전 상태 붙잡기 등). */
  afterLoad?: (pyodide: PyodideInterface) => void;
  /** 시험마다 공용 해체 뒤. 버퍼를 뗀 뒤라 Python을 돌려도 된다. */
  afterEach?: (pyodide: PyodideInterface) => void;
  /** 파일 끝. */
  afterAll?: () => void;
}

export interface ConsoleHarness {
  /** 콘솔 러너를 조립한다. 버퍼·proxy는 공용 해체가 치운다. */
  setup: (options?: SetupOptions) => ConsoleRunner;
  /** 설치 가드가 알리는 저하 지점을 받는 가짜. 시험마다 비운다. `setup`의 기본 report는 `warnDegraded`다. */
  report: Mock<ReportDegraded>;
  /** 하니스 밖에서 `attachRuntime`으로 연결한 버퍼·proxy를 공용 해체에 맡긴다. */
  track: typeof track;
}

/**
 * 파일이 최상위에서 한 번 쓰는 pyodide 인스턴스. `useConsoleHarness`가 `beforeAll`에서 채운다 — ESM live binding이라
 * import한 쪽이 시험 안에서 읽으면 로드된 값이 보인다.
 */
export let pyodide: PyodideInterface;

/**
 * 시험 파일 최상위에서 한 번 부른다. 등록하는 hook:
 * - `beforeAll`: `beforeLoad` → `loadPyodide` → `afterLoad` → `run_sync` 원본 붙잡기
 * - `afterEach`: `vi.restoreAllMocks()`(스파이를 먼저 풀어 원본으로 버퍼를 뗀다) → 공용 해체 → `report` 비우기 → 파일 `afterEach`
 * - `afterAll`: 파일 `afterAll`
 */
export function useConsoleHarness(
  options: ConsoleHarnessOptions = {},
): ConsoleHarness {
  const report = vi.fn<ReportDegraded>();

  beforeAll(async () => {
    options.beforeLoad?.();
    pyodide = await loadPyodide();
    options.afterLoad?.(pyodide);
    saveRunSync(pyodide);
  }, 60_000);

  afterEach(() => {
    vi.restoreAllMocks();
    teardown(pyodide);
    report.mockReset();
    options.afterEach?.(pyodide);
  });

  if (options.afterAll) afterAll(options.afterAll);

  return {
    setup: (setupOptions) => setupConsoleRunner(pyodide, setupOptions),
    report,
    track,
  };
}
