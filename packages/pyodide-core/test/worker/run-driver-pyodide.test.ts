// @vitest-environment node
/**
 * 실행 driver의 실제 pyodide(node) 시험. DELTA-01의 가설 확인(가설 1~8: `CodeRunner(mode="exec", filename)` +
 * `console.runcode(source, runner)` 경로가 SIGINT 계층(`sigint-handler.py`)을 수정 없이 재사용하는지)과 DELTA-02의 결말 분류
 * 통합(문법 오류 이름 통일·stdin 교체·재진입 거부·`atPrompt` 전이·종료 코드 범위)을 담는다. 시험마다 새 `loadPyodide()`를
 * 부르고 `bootWorker`의 실제 배선(`attachRuntime`·감시 타이머)을 그대로 쓴다. main 역할은 같은 스레드의
 * `MessageChannel` 반대편이다. 분류 분기 전수(가짜 콘솔)는 `run-driver-classify.test.ts`, 세션 단위(가짜 pyodide)는
 * `run-driver.test.ts`가 본다.
 *
 * 하니스 제약: Python이 스레드를 막는 동안에는 이 스레드의 이벤트 루프가 돌지 못한다. 그래서 (1) Ctrl+C는 별도 눌림 스레드
 * (`test/roles/interrupt-presser.ts`)가 interrupt buffer에 쓰고, (2) `input()`의 응답은 실행 전에 메일박스에 미리 넣어 둔다
 * (메일박스는 응답이 먼저 와 있어도 `wait()`가 바로 돌아온다). `readInput` 알림은 실행이 끝난 뒤에야 도착한다.
 *
 * 사용자 코드가 호출하는 시험 훅은 `probe` JS 모듈로 넣는다: 실행 driver는 run마다 새 globals를 만들므로 REPL 시험처럼
 * `pyodide.globals.set`으로 훅을 심을 수 없다.
 */
import { loadPyodide, type PyodideInterface } from "pyodide";
import { afterEach, describe, expect, test } from "vitest";
import { spawnRole } from "@repo/pyodide-testkit/thread";
import type { InitFrame } from "../../src/protocol/init-frame";
import {
  createInterruptBuffer,
  hasPendingInterrupt,
  signalInterrupt,
} from "../../src/protocol/interrupt-protocol";
import { createRpc } from "../../src/protocol/rpc";
import {
  createMailboxWriter,
  createStdinMailbox,
} from "../../src/protocol/stdin-mailbox";
import type { PresserCommand, PresserEvent } from "../roles/interrupt-presser";
import { createInitFrame } from "../boot-harness";
import { bootWorker } from "../../src/worker/boot";
import type { WorkerDriver } from "../../src/worker/driver";
import {
  createRunSession,
  runDriver,
  type RunDriverOptions,
  type RunSession,
} from "../../src/worker/run-driver";

const INTERRUPT_PRESSER_ROLE = new URL(
  "../roles/interrupt-presser.ts",
  import.meta.url,
);
const MAILBOX_WRITER_ROLE = new URL(
  "../roles/mailbox-writer.ts",
  import.meta.url,
);

/** `probe.started()`가 참을 돌려주는 최대 시간(ms). 눌림이 소실돼도 `while probe.started(): pass`가 이 시간 뒤에는 끝난다. */
const STARTED_LIMIT_MS = 5000;

/** 취소한 읽기를 다시 시도하는 회귀(TRP-020)가 나도 시험이 멈추지 않도록 메일박스 대기를 푸는 시각(ms). */
const STDIN_WATCHDOG_MS = 8000;

/** 정지한 대기 시간(초). 깨우지 못하면 시험이 이 시간을 다 채우기 전에 vitest 시간 제한에서 실패한다. */
const IDLE_WAIT_S = 60;

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 여러 줄 Python 소스. */
const py = (...lines: string[]) => lines.join("\n");

/** 트레이스백의 `File "..."` 프레임 줄들의 파일명. */
const frameFiles = (traceback: string | undefined) =>
  [...(traceback ?? "").matchAll(/^ {2}File "([^"]+)"/gm)].map(
    (match) => match[1],
  );

/** 결과의 필드를 종류와 무관하게 읽는 보기. 유니온 모양 검증은 `toStrictEqual` 시험이 한다. */
interface OutcomeView {
  kind: string;
  errorType?: string;
  traceback?: string;
  code?: number;
}

interface Runner {
  /** 코드 한 덩어리를 실행하고 결과를 기다린다(RPC `runCode`). */
  run(source: string): Promise<OutcomeView>;
  /** `runCode`를 기다리지 않고 시작한다(재진입 시험). */
  runAsync(source: string): Promise<OutcomeView>;
  /** 세션의 `atPrompt()`(감시 타이머가 읽는 값). */
  atPrompt(): boolean;
  /** 사용자 코드가 `probe.entered()`를 부를 때까지 기다린다. */
  entered(): Promise<void>;
  /** 사용자 코드가 `await probe.gate()`로 기다리는 문을 연다. */
  openGate(): void;
  /** `probe.snap()`이 기록한 `atPrompt()` 값들. */
  snaps: boolean[];
  /** worker가 낸 출력 누적(`write`·`writeErrorRaw` 알림). 응답보다 먼저 도착한다(같은 포트). */
  output: { stdout: string; stderr: string };
  /** `readInput` 알림의 `cancelable` 인자들(도착 순서). */
  readInputs: unknown[];
  /** `probe.mark()`가 마지막으로 불린 시각(`process.hrtime.bigint()`). */
  markedAt(): bigint | undefined;
  /** 눌림 스레드를 띄워 `probe.started()` 뒤 `offsetMs`에 누르게 한다. 보고는 `next()`로 받는다. */
  startPresser(offsetMs: number): { next(): Promise<PresserEvent> };
  /** 다음 `input()` 읽기에 줄을 미리 넣는다. */
  deliverLine(text: string): Promise<void>;
  /** 다음 `input()` 읽기를 취소로 미리 표시한다. */
  cancelRead(): Promise<void>;
  /** 이 스레드에서 새 눌림을 버퍼에 바로 쓴다(요청 번호 +1, 송신기 재전송 없음). */
  pressNow(): void;
  /** 버퍼에 전달 대기 눌림(SIGNAL 2)이 남아 있는가. */
  pendingInterrupt(): boolean;
  /** 참이면 감시 타이머에 `atPrompt()`를 거짓으로 보여 프롬프트 유휴 폐기를 막는다(틱보다 먼저 온 `runCode` 재현용). */
  holdIdleDiscard(value: boolean): void;
  pyodide(): PyodideInterface;
}

/**
 * `bootWorker`를 이 스레드에서 돌려 `ready`까지 기다린다. `runDriver`와 같은 세션 팩토리를 쓰되 시험이 끝낼 수 있게
 * `RunSession.end()`를 잡아 둔다.
 */
async function startRunner(
  options: Partial<RunDriverOptions> = {},
): Promise<Runner> {
  const channel = new MessageChannel();
  const mailbox = createStdinMailbox();
  const interruptBuffer = createInterruptBuffer();
  const frame: InitFrame = createInitFrame({
    rpcPort: channel.port1,
    interruptBuffer,
    stdinCtrl: mailbox.ctrl,
    stdinData: mailbox.data,
    driver: options,
  });

  const output = { stdout: "", stderr: "" };
  const readInputs: unknown[] = [];
  type Outcome = { ok: true } | { ok: false; message: string };
  let settle!: (outcome: Outcome) => void;
  const outcome = new Promise<Outcome>((resolve) => {
    settle = resolve;
  });
  const rpc = createRpc(channel.port2, {
    write: (text: string) => {
      output.stdout += text;
    },
    writeErrorRaw: (text: string) => {
      output.stderr += text;
    },
    readInput: (cancelable: unknown) => {
      readInputs.push(cancelable);
    },
    ready: () => settle({ ok: true }),
    loadFailed: (message: string) => settle({ ok: false, message }),
    crashed: (payload: { message: string }) =>
      settle({ ok: false, message: `crashed: ${payload.message}` }),
  });

  // 눌림 스레드와 공유하는 "Python이 시나리오에 들어갔다" 표시와 시각 기록.
  const ctl = new Int32Array(new SharedArrayBuffer(4));
  let firstCallAt: number | undefined;
  let markedAt: bigint | undefined;
  const snaps: boolean[] = [];
  let signalEntered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let openGate!: () => void;
  const gatePromise = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const probe = {
    // 실행 중 세션의 `atPrompt()`를 기록한다(참이면 감시 타이머가 눌림을 폐기한다).
    snap: () => {
      snaps.push(session!.atPrompt());
    },
    entered: () => signalEntered(),
    gate: () => gatePromise,
    started: () => {
      Atomics.store(ctl, 0, 1);
      Atomics.notify(ctl, 0);
      firstCallAt ??= performance.now();
      return performance.now() - firstCallAt < STARTED_LIMIT_MS;
    },
    mark: () => {
      markedAt = process.hrtime.bigint();
    },
  };

  let loaded: PyodideInterface | undefined;
  let session: RunSession | undefined;
  let idleDiscardHeld = false;
  const driver: WorkerDriver<RunDriverOptions> = {
    parseOptions: runDriver.parseOptions,
    createSession: (parsed) => {
      const created = (session = createRunSession(parsed));
      // 감시 타이머는 core가 이 반환값의 `atPrompt()`로 읽는다. `probe.snap()`은 원래 값을 기록한다.
      return {
        ...created,
        atPrompt: () => !idleDiscardHeld && created.atPrompt(),
      };
    },
  };
  const booted = bootWorker(frame, {
    driver,
    loadPyodide: async () => {
      const pyodide = await loadPyodide();
      pyodide.registerJsModule("probe", probe);
      loaded = pyodide;
      return pyodide;
    },
  });
  cleanups.push(async () => {
    session?.end();
    await booted;
    rpc.dispose();
    channel.port1.close();
    channel.port2.close();
  });

  const ready = await outcome;
  if (!ready.ok) throw new Error(`부팅 실패: ${ready.message}`);

  /** 읽기가 막혀도 영구 정지하지 않게 8초 뒤 줄을 넣는 스레드. 정상 경로에서는 시험이 끝날 때 회수된다. */
  const armWatchdog = () => {
    spawnRole(MAILBOX_WRITER_ROLE, {
      mailbox,
      delayMs: STDIN_WATCHDOG_MS,
      text: "WATCHDOG",
    });
  };

  return {
    output,
    readInputs,
    run: (source) => rpc.call<OutcomeView>("runCode", source),
    runAsync: (source) => rpc.call<OutcomeView>("runCode", source),
    atPrompt: () => session!.atPrompt(),
    entered: () => enteredPromise,
    openGate,
    snaps,
    markedAt: () => markedAt,
    pyodide: () => loaded!,
    startPresser(offsetMs) {
      const role = spawnRole(INTERRUPT_PRESSER_ROLE, {
        buffer: interruptBuffer,
        ctl,
      });
      role.post({
        kind: "press",
        offsets: [offsetMs],
      } satisfies PresserCommand);
      return { next: () => role.next<PresserEvent>() };
    },
    async deliverLine(text) {
      armWatchdog();
      await createMailboxWriter(mailbox).deliver(text);
    },
    async cancelRead() {
      armWatchdog();
      await createMailboxWriter(mailbox).cancel();
    },
    pressNow: () => signalInterrupt(interruptBuffer),
    pendingInterrupt: () => hasPendingInterrupt(interruptBuffer),
    holdIdleDiscard(value) {
      idleDiscardHeld = value;
    },
  };
}

/**
 * `source`를 실행하는 동안 눌림 스레드가 `probe.started()` 뒤 `offsetMs`에 누른다. `source`는 `probe.mark()`를 불러야 한다.
 * 결과와, 눌림 시각부터 실행이 끝나 응답을 받을 때까지의 ms를 돌려준다(두 시각 모두 스레드 공통의 `process.hrtime.bigint()`).
 */
async function runPressed(runner: Runner, source: string, offsetMs: number) {
  const presser = runner.startPresser(offsetMs);
  const outcome = await runner.run(source);
  const finishedAt = process.hrtime.bigint();
  const event = await presser.next();
  if (event.kind !== "pressed") throw new Error(`눌림 실패: ${event.kind}`);
  const afterPressMs =
    Number(finishedAt - runner.markedAt()!) / 1e6 - event.atMs[0]!;
  return { outcome, afterPressMs };
}

/** 실행이 `KeyboardInterrupt`로 끝났을 때 트레이스백 끝 줄. */
const INTERRUPT_LAST_LINE = "KeyboardInterrupt\n";

describe("가설 1: 바쁜 루프 중 Ctrl+C", () => {
  test("while 루프 중 눌림은 interrupted로 끝나고 트레이스백은 main.py 프레임부터 시작한다", async () => {
    const runner = await startRunner();

    const { outcome } = await runPressed(
      runner,
      py(
        "import probe",
        "probe.started()",
        "probe.mark()",
        "while probe.started(): pass",
      ),
      100,
    );

    expect(outcome.kind).toBe("interrupted");
    // 우리 프레임(run-driver·runcode 래퍼·핸들러)과 pyodide 내부 프레임(_base.py·console.py)이 없다.
    expect(frameFiles(outcome.traceback)).toEqual(["main.py"]);
    // 3.14는 중단된 호출 식 밑에 `~~^^` 줄을 붙일 수 있다. 프레임·소스 줄·마지막 줄만 본다.
    expect(outcome.traceback).toMatch(
      /^Traceback \(most recent call last\):\n {2}File "main.py", line 4, in <module>\n {4}while probe.started\(\): pass\n( +[~^]+\n)?KeyboardInterrupt\n$/,
    );
    expect(runner.output.stderr).toBe(outcome.traceback);
  }, 60_000);
});

describe("가설 2: time.sleep 중 Ctrl+C", () => {
  test("time.sleep(10) 중 눌림은 sleep 조각이 끊어 interrupted로 끝난다", async () => {
    const runner = await startRunner();

    const { outcome, afterPressMs } = await runPressed(
      runner,
      py(
        "import probe, time",
        "probe.started()",
        "probe.mark()",
        "time.sleep(10)",
      ),
      300,
    );

    expect(outcome.kind).toBe("interrupted");
    expect(frameFiles(outcome.traceback)).toEqual(["main.py"]);
    expect(outcome.traceback).toContain("    time.sleep(10)\n");
    // 응답성 요구라 상한 판정이 허용된다(09-testing.md 9.7 예외 2, 03-ctrl-c.md 2.4: 20ms 조각). 끊지 못하면 10초가 걸리므로
    // 병렬 부하 여유를 둔 1초로 가른다.
    expect(afterPressMs).toBeLessThan(1000);
  }, 60_000);
});

describe("가설 3: 정지한 실행 깨우기(exec 모드에도 active 추적이 걸린다)", () => {
  test("최상위 await 대기 중 눌림은 감시 타이머가 깨워 interrupted로 끝난다", async () => {
    const runner = await startRunner({ topLevelAwait: true });

    const { outcome } = await runPressed(
      runner,
      py(
        "import asyncio, probe",
        "probe.started()",
        "probe.mark()",
        `await asyncio.sleep(${IDLE_WAIT_S})`,
      ),
      300,
    );

    expect(outcome.kind).toBe("interrupted");
    // 정지한 콘솔 task를 취소해 끝낸 중단은 REPL과 같이 트레이스백 없이 한 줄이다(3.14 `python -m asyncio`).
    expect(outcome.traceback).toBe(INTERRUPT_LAST_LINE);
  }, 20_000);

  test("asyncio.run 대기 중 눌림은 깨워서 main.py 프레임 하나의 트레이스백으로 끝난다", async () => {
    const runner = await startRunner();

    const { outcome } = await runPressed(
      runner,
      py(
        "import asyncio, probe",
        "probe.started()",
        "probe.mark()",
        `asyncio.run(asyncio.sleep(${IDLE_WAIT_S}))`,
      ),
      300,
    );

    expect(outcome.kind).toBe("interrupted");
    expect(frameFiles(outcome.traceback)).toEqual(["main.py"]);
    expect(outcome.traceback).toContain(
      `    asyncio.run(asyncio.sleep(${IDLE_WAIT_S}))\n`,
    );
  }, 20_000);

  test("중단한 뒤 다음 실행은 잔류 SIGINT 없이 정상 실행된다", async () => {
    const runner = await startRunner({ topLevelAwait: true });
    await runPressed(
      runner,
      py(
        "import asyncio, probe",
        "probe.started()",
        "probe.mark()",
        `await asyncio.sleep(${IDLE_WAIT_S})`,
      ),
      300,
    );

    const next = await runner.run(
      py("import asyncio", "await asyncio.sleep(0.05)", "print('after')"),
    );

    expect(next).toEqual({ kind: "ok" });
    expect(runner.output.stdout).toBe("after\n");
  }, 20_000);

  // 앞 run 끝에 도착한 눌림이 틱(20ms)의 유휴 폐기보다 먼저 온 다음 `runCode`에 남은 경우. 폐기 단계는 driver에 없고
  // `<console>` 프레임 전의 driver Python(`run-driver.py` 준비·컴파일)에서 핸들러 규칙 ④가 버린다(14-runner.md 14.2.6).
  test("틱 폐기 전에 다음 실행이 들어와도 남은 눌림은 그 실행을 끊지 않는다", async () => {
    const runner = await startRunner();
    expect(await runner.run("pass")).toEqual({ kind: "ok" });
    runner.holdIdleDiscard(true);
    runner.pressNow();

    const next = await runner.run(
      py("for i in range(3_000_000):", "    pass", "print('after')"),
    );

    expect(next).toEqual({ kind: "ok" });
    expect(runner.output.stdout).toBe("after\n");
    expect(runner.pendingInterrupt()).toBe(false);
  }, 20_000);
});

describe("가설 4: 실행 예외 트레이스백", () => {
  test("1/0은 File main.py, line N과 소스 줄이 나온다", async () => {
    const runner = await startRunner();

    const outcome = await runner.run(py("x = 1", "1/0"));

    expect(outcome.kind).toBe("error");
    expect(outcome.errorType).toBe("ZeroDivisionError");
    expect(outcome.traceback).toBe(
      'Traceback (most recent call last):\n  File "main.py", line 2, in <module>\n    1/0\n    ~^~\nZeroDivisionError: division by zero\n',
    );
    expect(runner.output.stderr).toBe(outcome.traceback);
  }, 60_000);

  test("함수 안 예외는 main.py 프레임 둘만 남고 우리·pyodide 내부 프레임이 없다", async () => {
    const runner = await startRunner();

    const outcome = await runner.run(
      py("def f():", "    return int('x')", "", "f()"),
    );

    expect(outcome.kind).toBe("error");
    expect(outcome.errorType).toBe("ValueError");
    expect(frameFiles(outcome.traceback)).toEqual(["main.py", "main.py"]);
    expect(outcome.traceback).toContain("    f()\n");
    expect(outcome.traceback).toContain("    return int('x')\n");
  }, 60_000);
});

describe("가설 5: run마다 새 globals", () => {
  test("__name__·__file__·__doc__·__spec__ 등 CPython 스크립트 실행과 같은 이름이 있다", async () => {
    const runner = await startRunner({ filename: "main.py" });

    const outcome = await runner.run(
      py(
        "print(__name__, __file__, __doc__, __spec__)",
        "print(type(__builtins__).__name__)",
        "print('__loader__' in globals())",
        "print(sorted(k for k in globals() if not k.startswith('__')))",
      ),
    );

    expect(outcome).toEqual({ kind: "ok" });
    expect(runner.output.stdout).toBe(
      "__main__ main.py None None\nmodule\nFalse\n[]\n",
    );
  }, 60_000);

  test("두 번째 run에서 첫 run의 변수는 NameError이고 import한 모듈은 sys.modules에 남는다", async () => {
    const runner = await startRunner();
    // 미리 로드돼 있지 않은 표준 라이브러리 모듈을 고른다.
    expect(
      runner.pyodide().runPython("'colorsys' in __import__('sys').modules"),
    ).toBe(false);

    expect(await runner.run(py("import colorsys", "x = 1"))).toEqual({
      kind: "ok",
    });
    const second = await runner.run(
      py("import sys", "print('colorsys' in sys.modules)", "x"),
    );

    expect(second.kind).toBe("error");
    expect(second.errorType).toBe("NameError");
    expect(runner.output.stdout).toBe("True\n");
  }, 60_000);

  test("__annotations__가 문자열로 바뀌지 않고 사용자 전역이 pyodide.globals를 오염시키지 않는다", async () => {
    const runner = await startRunner();

    await runner.run(
      py("def f(a: int): pass", "print(f.__annotations__)", "leaked = 1"),
    );

    expect(runner.output.stdout).toBe("{'a': <class 'int'>}\n");
    expect(runner.pyodide().globals.has("leaked")).toBe(false);
  }, 60_000);
});

describe("가설 6: SystemExit", () => {
  test.each([
    ["sys.exit()", 0, ""],
    ["sys.exit(3)", 3, ""],
    ['sys.exit("x")', 1, "x\n"],
    ["exit()", 0, ""],
  ])(
    "%s는 exit 코드 %i이고 stderr는 %j다",
    async (body, code, stderr) => {
      const runner = await startRunner();

      const outcome = await runner.run(py("import sys", body));

      expect(outcome).toEqual({ kind: "exit", code });
      expect(runner.output.stderr).toBe(stderr);
    },
    60_000,
  );

  test("최상위 await 뒤의 sys.exit(3)도 exit 코드 3이다", async () => {
    const runner = await startRunner({ topLevelAwait: true });

    const outcome = await runner.run(
      py("import asyncio, sys", "await asyncio.sleep(0)", "sys.exit(3)"),
    );

    expect(outcome).toEqual({ kind: "exit", code: 3 });
  }, 60_000);

  test("exit 뒤 다음 실행이 정상 실행된다", async () => {
    const runner = await startRunner();
    await runner.run("exit()");

    const next = await runner.run("print('again')");

    expect(next).toEqual({ kind: "ok" });
    expect(runner.output.stdout).toBe("again\n");
  }, 60_000);
});

describe("가설 6 보충: exit()가 stdin을 닫는가", () => {
  test("exit() 뒤 다음 실행의 input()도 한 줄을 받는다", async () => {
    const runner = await startRunner();
    await runner.run("exit()");
    await runner.deliverLine("still");

    const outcome = await runner.run("print(input())");

    expect(outcome).toEqual({ kind: "ok" });
    expect(runner.output.stdout).toBe("still\n");
  }, 60_000);
});

describe("가설 7: 컴파일 플래그", () => {
  test("최상위 await 끔은 SyntaxError다", async () => {
    const runner = await startRunner({ topLevelAwait: false });

    const outcome = await runner.run(
      py("import asyncio", "await asyncio.sleep(0)"),
    );

    expect(outcome.kind).toBe("error");
    expect(outcome.errorType).toBe("SyntaxError");
    expect(outcome.traceback).toContain("'await' outside function");
    expect(frameFiles(outcome.traceback)).toEqual(["main.py"]);
  }, 60_000);

  test("최상위 await 켬은 실행한다", async () => {
    const runner = await startRunner({ topLevelAwait: true });

    const outcome = await runner.run(
      py("import asyncio", "await asyncio.sleep(0)", "print('ran')"),
    );

    expect(outcome).toEqual({ kind: "ok" });
    expect(runner.output.stdout).toBe("ran\n");
  }, 60_000);

  test("미완성 소스 `if x:`는 None이 아니라 문법 오류로 끝난다", async () => {
    const runner = await startRunner();

    const outcome = await runner.run("if x:");

    expect(outcome.kind).toBe("error");
    // IndentationError는 SyntaxError의 하위 클래스다: errorType은 통일하고 구체 이름은 트레이스백에 남는다(DELTA-02 결정).
    expect(outcome.errorType).toBe("SyntaxError");
    expect(outcome.traceback).toContain("IndentationError");
    expect(outcome.traceback).toContain(
      "expected an indented block after 'if'",
    );
  }, 60_000);

  test("컴파일 단계 오류(모듈 최상위 return)도 문법 오류로 끝난다", async () => {
    const runner = await startRunner();

    const outcome = await runner.run("return 1");

    expect(outcome.kind).toBe("error");
    expect(outcome.errorType).toBe("SyntaxError");
    expect(outcome.traceback).toContain("'return' outside function");
  }, 60_000);

  test("첫 줄 들여쓰기를 자동으로 없애지 않는다", async () => {
    const runner = await startRunner();

    const outcome = await runner.run("  x = 1");

    expect(outcome.kind).toBe("error");
    expect(outcome.traceback).toContain("unexpected indent");
  }, 60_000);

  test("마지막 식의 값을 돌려주거나 출력하지 않는다", async () => {
    const runner = await startRunner();

    const outcome = await runner.run("1 + 1");

    expect(outcome).toEqual({ kind: "ok" });
    expect(runner.output.stdout).toBe("");
  }, 60_000);
});

describe("가설 8: input()", () => {
  test("input()은 stdin 콜백 경유로 한 줄을 받는다", async () => {
    const runner = await startRunner();
    await runner.deliverLine("hello");

    const outcome = await runner.run(py("x = input()", "print(x)"));

    expect(outcome).toEqual({ kind: "ok" });
    expect(runner.output.stdout).toBe("hello\n");
    expect(runner.readInputs).toEqual([true]);
  }, 60_000);

  test("input() 취소는 호출 지점의 KeyboardInterrupt이고 읽기를 다시 시도하지 않는다", async () => {
    const runner = await startRunner();
    await runner.cancelRead();

    const outcome = await runner.run(py("x = input()", "print('after')"));

    expect(outcome.kind).toBe("interrupted");
    expect(frameFiles(outcome.traceback)).toEqual(["main.py"]);
    expect(outcome.traceback).toBe(
      'Traceback (most recent call last):\n  File "main.py", line 1, in <module>\n    x = input()\n' +
        INTERRUPT_LAST_LINE,
    );
    // 취소가 재시도 루프로 떨어졌다면(TRP-020) 감시 스레드가 넣은 줄로 계속 진행해 `after`가 나온다.
    expect(runner.output.stdout).toBe("");
    expect(runner.readInputs).toEqual([true]);
  }, 60_000);

  test("취소한 뒤 다음 실행의 input()이 정상 동작한다", async () => {
    const runner = await startRunner();
    await runner.cancelRead();
    await runner.run("input()");
    await runner.deliverLine("second");

    const outcome = await runner.run(py("print(input())"));

    expect(outcome).toEqual({ kind: "ok" });
    expect(runner.output.stdout).toBe("second\n");
  }, 60_000);
});

describe("DELTA-02: 문법 오류 errorType 통일", () => {
  test.each([
    ["일반 문법 오류 `x = = 1`", "x = = 1", "SyntaxError: invalid syntax"],
    ["들여쓰기 오류 `if x:`", "if x:", "IndentationError"],
    ["탭·공백 혼용", "if 1:\n\tx = 1\n        y = 2\n", "TabError"],
  ])(
    "컴파일 단계: %s는 errorType SyntaxError이고 트레이스백에 구체 이름이 있다",
    async (_name, source, expected) => {
      const runner = await startRunner();

      const outcome = await runner.run(source);

      expect(outcome.kind).toBe("error");
      expect(outcome.errorType).toBe("SyntaxError");
      expect(outcome.traceback).toContain(expected);
      expect(runner.output.stderr).toBe(outcome.traceback);
    },
    60_000,
  );

  test("실행 중 exec()가 올린 IndentationError도 errorType SyntaxError다", async () => {
    const runner = await startRunner();

    const outcome = await runner.run('exec("if x:")');

    expect(outcome.kind).toBe("error");
    expect(outcome.errorType).toBe("SyntaxError");
    expect(outcome.traceback).toContain("IndentationError");
    expect(frameFiles(outcome.traceback)).toContain("main.py");
  }, 60_000);
});

describe("DELTA-02: 결말 분류(사용자 코드가 직접 만든 종료·중단)", () => {
  test("사용자 코드가 올린 KeyboardInterrupt는 출처와 무관하게 interrupted다", async () => {
    const runner = await startRunner();

    const outcome = await runner.run(
      py("def f():", "    raise KeyboardInterrupt", "f()"),
    );

    expect(outcome.kind).toBe("interrupted");
    expect(frameFiles(outcome.traceback)).toEqual(["main.py", "main.py"]);
    expect(outcome.traceback?.endsWith("KeyboardInterrupt\n")).toBe(true);
    expect(runner.output.stderr).toBe(outcome.traceback);
  }, 60_000);

  test("SystemExit를 사용자 코드가 잡으면 ok이고 잡지 않은 함수 안 SystemExit는 exit다", async () => {
    const runner = await startRunner();

    const caught = await runner.run(
      py(
        "import sys",
        "try:",
        "    sys.exit(3)",
        "except SystemExit as e:",
        "    print('code', e.code)",
      ),
    );
    const raised = await runner.run(
      py("def f():", "    raise SystemExit(2)", "f()"),
    );

    expect(caught).toStrictEqual({ kind: "ok" });
    expect(runner.output.stdout).toBe("code 3\n");
    expect(raised).toStrictEqual({ kind: "exit", code: 2 });
  }, 60_000);

  test("종료 코드가 int32 밖이면 RPC를 지나도 number로 하위 8비트가 된다", async () => {
    const runner = await startRunner();

    const outcome = await runner.run(
      py("import sys", `sys.exit(${2 ** 31 + 5})`),
    );
    const huge = await runner.run(py("import sys", "sys.exit(2**70 + 7)"));

    expect(outcome).toStrictEqual({ kind: "exit", code: 5 });
    expect(huge).toStrictEqual({ kind: "exit", code: 7 });
  }, 60_000);
});

describe("DELTA-02: run 사이 sys.stdin", () => {
  test("이전 run이 sys.stdin.read(3)으로 남긴 버퍼가 다음 run의 input()에 새지 않는다", async () => {
    const runner = await startRunner();
    await runner.deliverLine("abcdef");
    expect(
      await runner.run(py("import sys", "print(sys.stdin.read(3))")),
    ).toStrictEqual({
      kind: "ok",
    });
    await runner.deliverLine("new");

    const outcome = await runner.run("print(input())");

    expect(outcome).toStrictEqual({ kind: "ok" });
    // 교체가 없으면 앞 run의 남은 줄 `def`를 먼저 읽는다(TRP-010과 같은 현상).
    expect(runner.output.stdout).toBe("abc\nnew\n");
  }, 60_000);

  test("사용자 코드가 바꿔 놓은 sys.stdin도 다음 run에서 원래 stdin 모양으로 돌아온다", async () => {
    const runner = await startRunner();
    await runner.run(
      py("import io, sys", "sys.stdin = io.StringIO('fake\\n')"),
    );
    await runner.deliverLine("real");

    const outcome = await runner.run(
      py(
        "import sys",
        "print(sys.stdin.name, sys.stdin.encoding, sys.stdin.line_buffering)",
        "print(input())",
      ),
    );

    expect(outcome).toStrictEqual({ kind: "ok" });
    expect(runner.output.stdout).toBe("<stdin> utf-8 True\nreal\n");
  }, 60_000);

  test("연속한 run마다 input()이 새 줄을 받는다(교체가 fd 0을 닫지 않는다)", async () => {
    const runner = await startRunner();

    for (const line of ["one", "two", "three"]) {
      await runner.deliverLine(line);
      expect(await runner.run("print(input())")).toStrictEqual({ kind: "ok" });
    }

    expect(runner.output.stdout).toBe("one\ntwo\nthree\n");
  }, 60_000);
});

describe("DELTA-02: atPrompt 전이와 재진입 거부(실제 부팅)", () => {
  test("atPrompt는 실행 중에만 거짓이고 실행이 끝나면(오류 포함) 참으로 돌아온다", async () => {
    const runner = await startRunner();
    expect(runner.atPrompt()).toBe(true);

    await runner.run(py("import probe", "probe.snap()"));
    expect(runner.atPrompt()).toBe(true);
    await runner.run(py("import probe", "probe.snap()", "1/0"));
    expect(runner.atPrompt()).toBe(true);
    await runner.run(py("import probe", "probe.snap()", "raise SystemExit(1)"));
    expect(runner.atPrompt()).toBe(true);
    await runner.run("if x:");
    expect(runner.atPrompt()).toBe(true);

    // 실행 중에 찍은 값: 셋 모두 거짓이다.
    expect(runner.snaps).toEqual([false, false, false]);
  }, 60_000);

  test("실행 중 두 번째 runCode는 거부되고 첫 실행은 영향 없이 끝난다", async () => {
    const runner = await startRunner({ topLevelAwait: true });
    const first = runner.runAsync(
      py(
        "import probe",
        "probe.entered()",
        "await probe.gate()",
        "print('first done')",
      ),
    );
    await runner.entered();

    await expect(runner.run("print('second')")).rejects.toThrow("재진입 거부");
    // 거부된 호출이 실행 중 표시를 지우지 않는다.
    expect(runner.atPrompt()).toBe(false);
    runner.openGate();

    expect(await first).toStrictEqual({ kind: "ok" });
    expect(runner.output.stdout).toBe("first done\n");
    expect(runner.atPrompt()).toBe(true);
    // 끝난 뒤에는 다시 받는다.
    expect(await runner.run("print('third')")).toStrictEqual({ kind: "ok" });
    expect(runner.output.stdout).toBe("first done\nthird\n");
  }, 60_000);
});
