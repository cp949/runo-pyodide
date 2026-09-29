/**
 * REPL 콘솔 통합 하니스. node + 실제 pyodide 전용이다(09-testing.md 9.1).
 *
 * 사용법:
 * - 시험 파일 최상위에서 `useConsoleHarness()`를 한 번 부른다. pyodide 로드·해체가 등록된다.
 * - 시험마다 `setup()`으로 콘솔·버퍼·SIGINT 핸들러·제출 러너를 조립한다.
 *
 * 조립은 운영과 같은 `attachRuntime`(03-ctrl-c.md 2.6)이다.
 * - 핸들러 설치 전에 `prepare?.(buffer)`가 버퍼를 만진다.
 * - 이어서 `attachRuntime(pyodide, repl.pyconsole, { interruptBuffer: buffer, stdin, report })`가 연결한다.
 * - attach가 폐기까지 한다. `prepare`가 남긴 SIGINT 슬롯 2는 연결 시점에 지워지고 ack가 오른다.
 * - 요청 번호(SEQ)는 지워지지 않는다. `worker/sigint-handler.test.ts`가 이 경계를 본다.
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
 * 상한 있는 바쁜 루프(약 0.23초).
 * 핸들러가 잘못돼 SIGINT가 버려져도 시험이 멈추지 않고 단언에서 실패한다.
 * `while True: pass`는 눌림이 소실되면 vitest가 멈출 수 없는 무한 루프가 된다.
 */
export const BUSY = "for _ in range(10**7): pass";

/** `started()`가 참을 돌려주는 최대 시간(ms). 눌림이 소실돼도 `while started(): pass`는 이 시간 뒤에 끝난다. */
export const STARTED_LIMIT_MS = 5000;

/** 사용자 프로그램 소스를 한 줄 `exec(...)` 제출로 만든다. JSON 문자열은 Python 문자열 리터럴로도 유효하다. */
export const execSource = (program: string) =>
  `exec(${JSON.stringify(program)})`;

/** `<console>` 한 줄 실행이 `KeyboardInterrupt`로 끝났을 때의 정확한 출력. 소스 줄과 우리 프레임이 없다. */
export const CONSOLE_TRACEBACK =
  'Traceback (most recent call last):\n  File "<console>", line 1, in <module>\nKeyboardInterrupt\n';

/** 눌림 스레드 보고 타입. `presser().done()`의 결과를 받는 시험이 쓴다. */
export type { PresserEvent };

/** 버퍼를 `[SIGINT, ack, 요청 번호, 예약]` 배열로 읽는다. 슬롯 배치는 프로토콜 규약(03-ctrl-c.md 2.1)이라 인덱스 그대로 본다. */
export const slots = (buffer: Int32Array) => Array.from(buffer);

/** `setup()` 옵션. */
export interface SetupOptions {
  topLevelAwait?: boolean;

  /** 핸들러 설치 전에 버퍼를 만지는 훅(이전 세션이 남긴 요청 번호 등). 뒤이은 attach의 폐기 대상. */
  prepare?: (buffer: Int32Array) => void;

  /** 저하 지점(조각 교체·정지한 실행 깨우기·트레이스백 파일명 가드)을 받는 콜백. 기본값은 `console.warn`. */
  report?: ReportDegraded;

  /** stdin 전송 수단. 기본값은 각본 없는 stdin(`requestInput` 무동작, `wait` 던짐, 각본 없는 읽기 `OSError`). */
  stdin?: RuntimeAttachDeps["stdin"];
}

/** `wakeAfter`의 결과. `woke`는 `interruptIdle()`이 깨울 것을 찾았는지다. */
export interface WakeOutcome {
  woke: boolean;
}

/** 눌림 스레드 조종기. `presser()`가 돌려준다. */
export interface Presser {
  /** 눌림 예약. 즉시 반환하고, 쓰기는 눌림 스레드가 `started()`를 기다린 뒤 수행. */
  press(
    command: Omit<Extract<PresserCommand, { kind: "press" }>, "kind">,
  ): void;

  /** 시작 표시 지우기(라운드 반복용). */
  reset(): Promise<void>;

  /** 눌림을 다 쓴 뒤의 보고 대기. */
  done(): Promise<PresserEvent>;
}

/** `setup()`이 조립해 돌려주는 콘솔 러너. */
export interface ConsoleRunner {
  /** 한 줄 제출(`createSubmissionRunner`의 `run`). */
  run: SubmissionRunner["run"];

  /** 이 조립이 모은 화면 바이트(sink가 붙이는 개행 포함). */
  screen: { stdout: string; stderr: string };

  buffer: Int32Array;

  pyconsole: PyodideConsoleProxy;

  /** 이 조립의 REPL 콘솔. `runSource` 시험(`run-source.test.ts`)이 같은 콘솔에 실행기를 붙이는 대상. */
  repl: ReplConsole;

  /** 눌림 스레드 기동. 시험이 끝나면 함께 종료. */
  presser: () => Presser;

  /**
   * 눌림 스레드에 "시나리오에 들어갔다"를 알리는 함수.
   * - Python 전역 `started()`가 이 함수. JS 쪽 훅(stdin `wait()` 등)에서도 호출 가능.
   * - 첫 호출 뒤 `STARTED_LIMIT_MS` 동안만 참 반환.
   */
  markStarted: () => boolean;

  /** 설치가 돌려준 Python `interrupt_idle`. destroy는 공용 해체의 몫. 시험이 직접 destroy하면 해체가 두 번 destroy해 던짐. */
  interruptIdle: InterruptIdle;

  /**
   * `ms` 뒤에 감시 타이머(03-ctrl-c.md 2.5)의 한 틱을 흉내내는 함수.
   * - 호출 순서: `signalInterrupt` → `interruptIdle()`.
   * - 깨웠으면 SIGINT를 소비하고(`compareExchange(2 → 0)`), 소비에 성공했을 때만 ack.
   * - 깨우지 못했으면 SIGINT를 남김. 재개한 사용자 스택의 폴링이 받는다.
   * - JSPI로 정지한 동안에는 JS 이벤트 루프가 비어 같은 스레드 타이머로 충분.
   */
  wakeAfter: (ms: number) => Promise<WakeOutcome>;
}

/**
 * 공용 해체가 치울 것.
 * - `wakeAfter`가 건 타이머, 설치가 돌려준 proxy, 연결한 버퍼다.
 * - `setup()`이 자동으로 넣는다. 하니스 밖에서 `attachRuntime`을 직접 부른 시험은 `track()`으로 넣는다.
 * - vitest가 파일마다 모듈을 따로 읽으므로 파일 사이에 새지 않는다.
 */
const pendingWakes: ReturnType<typeof setTimeout>[] = [];
const liveInterruptIdles: InterruptIdle[] = [];
const liveBuffers: Int32Array[] = [];

/**
 * `run_sync` 원본 보존·복원용 Python 소스.
 * - 설치가 `pyodide.ffi.run_sync`·`pyodide.webloop.run_sync`를 래퍼로 바꾼다.
 * - 파일 하나가 pyodide 인스턴스를 공유하므로 되돌리지 않으면 setup마다 래퍼가 겹쌓인다.
 * - 첫 설치 전 값을 모듈 속성에 한 번 붙잡아 두고 해체가 그것으로 되돌린다.
 */
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
 * 콘솔 + interrupt buffer + SIGINT 핸들러 + 제출 러너를 조립한다.
 * Python 전역 `press`·`resend`·`started`를 심는다. 시나리오가 같은 스레드에서 눌림을 만들고, 눌림 스레드에 시작을 알릴 수 있다.
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

  // 실행 중인 Python에서 부르는 JS 콜백.
  // - `press`: main이 Ctrl+C마다 쓰는 눌림.
  // - `resend`: main의 재전송. 같은 요청 번호로 SIGINT 슬롯만 다시 쓴다.
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
 * 공용 해체. 처리 순서:
 * - 아직 터지지 않은 `wakeAfter` 타이머와 살아 있는 `interrupt_idle` proxy를 치운다.
 * - 버퍼를 먼저 떼고 비운다. 남은 SIGINT가 다음 시험의 Python 실행을 끊지 않게 한다.
 * - SIGINT 핸들러를 기본으로 되돌린다.
 * - stdin을 되돌린다. 각본 없는 읽기가 다음 시험에서 `OSError`가 되게 한다.
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
  // `setStdin`은 `sys.stdin` 객체를 바꾸지 않는다(TRP-010).
  // 줄 일부만 읽고 남은 `\n`이 다음 시험의 첫 읽기가 되지 않게 새 스트림으로 갈아 끼운다.
  pyodide.setStdin({ error: true });
  runInScratch(
    pyodide,
    'import sys\nsys.stdin = open(0, encoding="utf-8", closefd=False)',
  );
  restoreRunSync(pyodide);
}

/** `useConsoleHarness`의 파일별 확장 지점. 부르는 순서는 하니스가 고정한다. */
export interface ConsoleHarnessOptions {
  /** `loadPyodide` 전 훅(JSPI 지우기 등). */
  beforeLoad?: () => void;

  /** `loadPyodide` 직후, `run_sync` 원본을 붙잡기 전 훅(설치 전 상태 붙잡기 등). */
  afterLoad?: (pyodide: PyodideInterface) => void;

  /** 시험마다 공용 해체 뒤 훅. 버퍼를 뗀 뒤라 Python 실행 가능. */
  afterEach?: (pyodide: PyodideInterface) => void;

  /** 파일 끝 훅. */
  afterAll?: () => void;
}

/** `useConsoleHarness`가 돌려주는 시험용 손잡이. */
export interface ConsoleHarness {
  /** 콘솔 러너 조립. 버퍼·proxy는 공용 해체가 치움. */
  setup: (options?: SetupOptions) => ConsoleRunner;

  /** 설치 가드가 알리는 저하 지점을 받는 가짜. 시험마다 비움. `setup`의 기본 report는 `warnDegraded`. */
  report: Mock<ReportDegraded>;

  /** 하니스 밖에서 `attachRuntime`으로 연결한 버퍼·proxy를 공용 해체에 맡긴다. */
  track: typeof track;
}

/**
 * 파일이 최상위에서 한 번 쓰는 pyodide 인스턴스.
 * `useConsoleHarness`가 `beforeAll`에서 채운다. ESM live binding이라 import한 쪽이 시험 안에서 읽으면 로드된 값이 보인다.
 */
export let pyodide: PyodideInterface;

/**
 * 시험 파일 최상위에서 한 번 부른다. 등록하는 hook:
 * - `beforeAll`: `beforeLoad` → `loadPyodide` → `afterLoad` → `run_sync` 원본 붙잡기
 * - `afterEach`: `vi.restoreAllMocks()` → 공용 해체 → `report` 비우기 → 파일 `afterEach`
 * - `afterAll`: 파일 `afterAll`
 *
 * `afterEach`가 스파이를 먼저 푸는 이유는 원본 함수로 버퍼를 떼기 위해서다.
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
