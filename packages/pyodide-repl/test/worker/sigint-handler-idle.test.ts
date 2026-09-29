// @vitest-environment node
/**
 * 정지한 실행 깨우기 시험(03-ctrl-c.md 2.4의 규칙 ③과 깨우기 세부, 09-testing.md 9.1, TRP-020·TRP-021).
 * - `asyncio.run`·`run_until_complete`·`run_sync`·top-level await 대기 중에는 사용자 스택이 JSPI로 정지한다.
 * - 그 사이 SIGINT 폴링은 사용자 프레임 없는 콜백에서 일어난다.
 * - 이 SIGINT를 버리지 않고 대기 Task나 콘솔 task를 취소해 사용자 지점에서 중단한다. 이것이 여기서 고정하는 규칙이다.
 * - JSPI·asyncio 스케줄러·`ConsoleFuture`에 걸쳐 있어 실제 pyodide(node)에서만 재현된다. mock 없이 로드한다.
 *
 * RD-009a: `run_sync` 계열로 들어간 awaitable이 예외로 끝나는 경우.
 * - 취소뿐 아니라 사용자 코드가 낸 어떤 예외든 `guard`가 값으로 나른다. 래퍼가 사용자 스택에서 다시 올린다.
 * - Task가 예외로 끝나 JS 경계를 넘으면 pyodide가 `sys.excepthook`으로 트레이스백을 한 번 더 찍는다(TRP-021). 이를 막는다.
 * - `"run_sync 계열 대기에서 코루틴이 낸 예외"` describe가 이 나르기·프레임 다듬기를 확인한다.
 *
 * 깨우기 흉내:
 * - 프로덕션 경로는 감시 타이머(03-ctrl-c.md 2.5)가 깨우는 것이다.
 * - 여기서는 `console-harness.ts`의 `wakeAfter(ms)`가 그 한 틱을 흉내낸다(`signalInterrupt` → `interruptIdle()` → 깨웠으면 소비·ack).
 * - 타이머 없이 핸들러만으로 깨우는 경로는 눌림 스레드(core `test/roles/interrupt-presser.ts`)가 만든다.
 */
import { describe, expect, it } from "vitest";
import {
  CONSOLE_TRACEBACK,
  execSource,
  pyodide,
  READY,
  type SetupOptions,
  slots,
  useConsoleHarness,
} from "../console-harness";
import { PS1, PS2 } from "../../src/worker/submission-runner";
import { SIGINT_HANDLER_FILENAME } from "@cp949/runo-pyodide-core/test-utils/worker";

/** 공용 하니스. */
const harness = useConsoleHarness();

/** 설치 가드가 알리는 저하 지점을 받는 가짜. 가드 시험만 넘겨 쓴다. */
const { report } = harness;

/** top-level await 대기 중단의 화면. 3.14 `python -m asyncio`처럼 트레이스백 없이 한 줄이다. */
const AWAIT_INTERRUPT = "KeyboardInterrupt\n";
/** 대기 시간(초). 깨우지 못하면 시험이 이 시간을 다 채우고 단언에서 실패한다. */
const IDLE_WAIT = "5";
/** `wakeAfter`가 깨우는 시각(ms). */
const WAKE_AT_MS = 100;
/** 깨운 뒤 이 시간(ms) 안에 제출이 끝나야 깨운 것으로 본다. 목표는 200ms다. 병렬 실행의 부하 여유를 둔다. */
const WAKE_LIMIT_MS = 1000;

/** 콘솔을 조립하고 시나리오가 쓰는 모듈(`asyncio`, `time`, `run_sync`)을 콘솔에서 import해 둔다. */
async function setup(options?: SetupOptions) {
  const runner = harness.setup(options);
  expect(await runner.run("import asyncio, time")).toEqual(READY);
  expect(await runner.run("from pyodide.ffi import run_sync")).toEqual(READY);
  return runner;
}

/** `setup()`이 돌려주는 콘솔 러너. */
type Runner = Awaited<ReturnType<typeof setup>>;

/** `runWaking`의 결과. */
interface Outcome {
  /**
   * `interruptIdle()`이 깨울 것을 찾았는지 여부.
   * - 경합이 있어 참을 단언하지 않는다.
   * - 핸들러 규칙 ③이 한 틱 미룬 깨우기가 먼저 돌았으면 `interrupt_idle` 본문은 깨울 것이 없어 거짓을 돌려준다.
   * - 어느 쪽이든 깨어나고 ack는 정확히 한 번 오른다. 슬롯으로 단언한다.
   */
  woke: boolean;

  /** 제출 시작부터 끝까지의 ms. 깨우기는 그중 `wakeAt`에 일어난다. */
  elapsedMs: number;
}

/** `wakeAt` 뒤에 감시 타이머 한 틱을 흉내내면서 한 줄을 제출한다. */
async function runWaking(
  runner: Runner,
  source: string,
  wakeAt = WAKE_AT_MS,
): Promise<Outcome> {
  const startedAt = performance.now();
  const wake = runner.wakeAfter(wakeAt);
  expect(await runner.run(source)).toEqual(READY);
  const elapsedMs = performance.now() - startedAt;
  return { woke: (await wake).woke, elapsedMs };
}

/**
 * 블록 본문 줄들을 실제 타이핑처럼 한 줄씩 push한다.
 * 개행이 든 한 번의 `run()`은 `split_paste`로 즉시 실행된다(RD-011).
 * 마지막 빈 줄 전에 깨우기를 걸려면 줄 단위로 나눠 보내야 한다.
 */
async function submitBlockLines(runner: Runner, block: string): Promise<void> {
  for (const line of block.split("\n")) {
    expect((await runner.run(line)).prompt).toBe(PS2);
  }
}

/**
 * 복합문(블록)을 제출한다.
 * 콘솔은 빈 줄을 받아야 블록을 실행한다. 실제 대기는 그 빈 줄 push에서 시작한다.
 * 깨우기를 그 직전에 건다.
 */
async function runBlockWaking(
  runner: Runner,
  block: string,
  wakeAt = WAKE_AT_MS,
): Promise<Outcome> {
  await submitBlockLines(runner, block);
  return runWaking(runner, "", wakeAt);
}

/** 깨운 뒤 곧 끝났는지 단언한다. 깨우지 못하면 대기 시간(5초)을 다 채워 여기서 실패한다. */
function expectWoken(outcome: Outcome, wakeAt = WAKE_AT_MS): void {
  expect(outcome.elapsedMs).toBeLessThan(wakeAt + WAKE_LIMIT_MS);
}

/** `screen.stderr`의 `  File ...` 줄들. */
const frames = (stderr: string) =>
  stderr.split("\n").filter((line) => line.startsWith("  File "));

/** `asyncio.run`·`run_until_complete`·`run_sync` 3종에 같은 코루틴 식을 태운다. 셋 다 같은 `run_sync` 래퍼를 거친다. */
const RUNNERS: [string, (coroutineExpr: string) => string][] = [
  ["asyncio.run", (c) => `asyncio.run(${c})`],
  [
    "run_until_complete",
    (c) => `asyncio.get_event_loop().run_until_complete(${c})`,
  ],
  ["run_sync", (c) => `run_sync(${c})`],
];

describe("정지한 대기 중 Ctrl+C", () => {
  it.each([
    ["asyncio.run", `asyncio.run(asyncio.sleep(${IDLE_WAIT}))`],
    [
      "run_until_complete",
      `asyncio.get_event_loop().run_until_complete(asyncio.sleep(${IDLE_WAIT}))`,
    ],
    ["run_sync", `run_sync(asyncio.sleep(${IDLE_WAIT}))`],
  ])(
    "%s 대기는 깨운 뒤 곧 표준 트레이스백으로 끝난다",
    async (_title, source) => {
      const runner = await setup();

      expectWoken(await runWaking(runner, source));

      // 우리 프레임도 `pyodide/webloop.py`의 `_run`·`run_until_complete`도 남지 않는다.
      expect(runner.screen.stderr).toBe(CONSOLE_TRACEBACK);
      // 깨운 쪽이 타이머든 핸들러든 SIGINT는 소비되고 ack는 정확히 한 번 오른다.
      expect(slots(runner.buffer)).toEqual([0, 1, 1, 0]);
    },
    20_000,
  );

  it("중단한 뒤 다음 문장이 정상 실행된다", async () => {
    const runner = await setup();
    expectWoken(
      await runWaking(runner, `asyncio.run(asyncio.sleep(${IDLE_WAIT}))`),
    );
    runner.screen.stdout = "";
    runner.screen.stderr = "";

    expect(await runner.run("1 + 1")).toEqual(READY);

    expect(runner.screen.stdout).toBe("2\n");
    expect(runner.screen.stderr).toBe("");
  }, 20_000);

  it("KeyboardInterrupt는 except로 잡히고 finally가 실행된다", async () => {
    const runner = await setup();
    const block = [
      "try:",
      `    run_sync(asyncio.sleep(${IDLE_WAIT}))`,
      "except KeyboardInterrupt:",
      "    print('caught')",
      "finally:",
      "    print('fin')",
    ].join("\n");

    expectWoken(await runBlockWaking(runner, block));

    expect(runner.screen.stdout).toBe("caught\nfin\n");
    expect(runner.screen.stderr).toBe("");
  }, 20_000);

  // `run_sync`를 부르는 함수의 소스. `<console>` 파일명으로 정의해 사용자 프레임으로 인정되게 한다. `run_sync`는 3행이다.
  const NESTED_SOURCE = `def f():
    import asyncio
    run_sync(asyncio.sleep(${IDLE_WAIT}))
`;

  it("중첩 호출 안의 run_sync 대기도 사용자 프레임까지만 보인다", async () => {
    const runner = await setup();
    pyodide.runPython(NESTED_SOURCE, {
      globals: pyodide.globals,
      filename: "<console>",
    });

    expectWoken(await runWaking(runner, "f()"));

    expect(frames(runner.screen.stderr)).toEqual([
      '  File "<console>", line 1, in <module>',
      '  File "<console>", line 3, in f',
    ]);
    expect(runner.screen.stderr).toMatch(/KeyboardInterrupt\n$/);
  }, 20_000);

  // 래퍼가 부른 라이브러리 프레임(`ensure_future` 등)에서 SIGINT가 소비되면 트레이스백은 [사용자, 래퍼, 라이브러리, 핸들러] 순서다.
  // 핸들러 프레임만 자르면 래퍼와 라이브러리 프레임이 샌다.
  it("래퍼가 부른 라이브러리 프레임에서 올라온 KeyboardInterrupt도 우리 프레임 없이 보인다", async () => {
    const runner = await setup();
    pyodide.runPython(
      `import asyncio, signal
_real_ensure_future = asyncio.ensure_future

def _leaky_ensure_future(*args, **kwargs):
    # Task를 먼저 만든 뒤 눌림을 소비한다(만들기 전에 끊으면 대기 코루틴이 await되지 않아 RuntimeWarning이 화면에
    # 끼어든다). press()는 요청 번호를 올려 재전송 무시 규칙에 걸리지 않게 한다.
    fut = _real_ensure_future(*args, **kwargs)
    press()
    signal.raise_signal(signal.SIGINT)
    return fut

asyncio.ensure_future = _leaky_ensure_future
`,
      { globals: pyodide.globals, filename: "<test>" },
    );

    try {
      expect(await runner.run("run_sync(asyncio.sleep(0.05))")).toEqual(READY);
    } finally {
      pyodide.runPython(
        "import asyncio\nasyncio.ensure_future = _real_ensure_future",
        {
          globals: pyodide.globals,
          filename: "<test>",
        },
      );
    }

    expect(runner.screen.stderr).toBe(CONSOLE_TRACEBACK);
  }, 20_000);

  // 깨우기 간격은 `sleep(1)` 종료 콜백에 위상이 고정되지 않도록 어긋나게 둔다.
  it("KeyboardInterrupt를 잡고 계속 도는 프로그램은 깨우기 3회를 모두 받는다", async () => {
    const runner = await setup();
    expect(await runner.run("n = 0")).toEqual(READY);
    expect(await runner.run("deadline = time.monotonic() + 6")).toEqual(READY);
    const block = [
      "while n < 3 and time.monotonic() < deadline:",
      "    try:",
      "        run_sync(asyncio.sleep(1))",
      "    except KeyboardInterrupt:",
      "        n += 1",
    ].join("\n");
    await submitBlockLines(runner, block);
    const wakes = [
      runner.wakeAfter(100),
      runner.wakeAfter(400),
      runner.wakeAfter(700),
    ];

    expect(await runner.run("")).toEqual(READY);

    await Promise.all(wakes);
    expect(pyodide.globals.get("n")).toBe(3);
  }, 20_000);

  // 같은 틱의 연타 3회다.
  // 첫 깨우기만 성공한다. 나머지는 깨울 것이 없어 SIGINT를 슬롯에 남긴다.
  // 남은 SIGINT는 재개한 스택의 폴링이나 루프의 폐기가 치운다. 트레이스백은 하나여야 한다.
  it("정지한 대기 중 0ms 연타 3회에도 트레이스백은 한 번이다", async () => {
    const runner = await setup();
    const wakes = [
      runner.wakeAfter(WAKE_AT_MS),
      runner.wakeAfter(WAKE_AT_MS),
      runner.wakeAfter(WAKE_AT_MS),
    ];

    expect(await runner.run(`run_sync(asyncio.sleep(${IDLE_WAIT}))`)).toEqual(
      READY,
    );

    // 깨운 것은 많아야 하나다. 첫 호출이나 그것이 일으킨 핸들러 둘 중 하나다. 나머지 SIGINT는 슬롯에 남는다.
    const woke = (await Promise.all(wakes)).filter((wake) => wake.woke);
    expect(woke.length).toBeLessThanOrEqual(1);
    expect(runner.screen.stderr.match(/KeyboardInterrupt/g)).toHaveLength(1);
    expect(runner.screen.stderr).not.toContain(SIGINT_HANDLER_FILENAME);
    // 남은 SIGINT는 worker 루프가 제출 전에 폐기한다(03-ctrl-c.md 2.6). 그 뒤 다음 문장은 정상이다.
    runner.screen.stdout = "";
    runner.screen.stderr = "";
    expect(await runner.run("1 + 1")).toEqual(READY);
    expect(runner.screen.stdout).toBe("2\n");
    expect(runner.screen.stderr).toBe("");
  }, 20_000);

  // 대기 코루틴(`guard`)은 우리가 깨운 취소만 정상 값으로 바꾼다.
  // 사용자 코드가 낸 `CancelledError`는 그대로 올라온다.
  it("사용자가 낸 CancelledError는 KeyboardInterrupt로 바뀌지 않는다", async () => {
    const runner = await setup();
    pyodide.runPython(
      "import asyncio\n\nasync def boom():\n    raise asyncio.CancelledError()\n",
      { globals: pyodide.globals, filename: "<console>" },
    );
    const program = [
      "try:",
      "    run_sync(boom())",
      "except asyncio.CancelledError:",
      "    print('user-cancel')",
    ].join("\n");

    expect(await runner.run(execSource(program))).toEqual(READY);

    expect(runner.screen.stdout).toBe("user-cancel\n");
    expect(runner.screen.stderr).toBe("");
  }, 20_000);

  it("실행 중이 아니면 interruptIdle()은 아무것도 깨우지 않는다", async () => {
    const runner = await setup();

    expect(runner.interruptIdle()).toBe(false);

    expect(slots(runner.buffer)).toEqual([0, 0, 0, 0]);
  });
});

describe("top-level await 대기 중 Ctrl+C", () => {
  it("await 대기는 깨운 뒤 곧 KeyboardInterrupt 한 줄로 끝난다", async () => {
    const runner = await setup({ topLevelAwait: true });

    expectWoken(await runWaking(runner, `await asyncio.sleep(${IDLE_WAIT})`));

    expect(runner.screen.stderr).toBe(AWAIT_INTERRUPT);
    runner.screen.stderr = "";
    expect(await runner.run("1 + 1")).toEqual(READY);
    expect(runner.screen.stdout).toBe("2\n");
    expect(runner.screen.stderr).toBe("");
  }, 20_000);

  it("finally는 실행된다", async () => {
    const runner = await setup({ topLevelAwait: true });
    const block = [
      "try:",
      `    await asyncio.sleep(${IDLE_WAIT})`,
      "finally:",
      "    print('fin')",
    ].join("\n");

    expectWoken(await runBlockWaking(runner, block));

    expect(runner.screen.stdout).toBe("fin\n");
    expect(runner.screen.stderr).toBe(AWAIT_INTERRUPT);
  }, 20_000);

  it("except asyncio.CancelledError는 잡는다", async () => {
    const runner = await setup({ topLevelAwait: true });
    const block = [
      "try:",
      `    await asyncio.sleep(${IDLE_WAIT})`,
      "except asyncio.CancelledError:",
      "    print('cancelled-caught')",
    ].join("\n");

    expectWoken(await runBlockWaking(runner, block));

    expect(runner.screen.stdout).toBe("cancelled-caught\n");
    expect(runner.screen.stderr).toBe("");
  }, 20_000);

  // 3.14 `python -m asyncio`와 같다.
  // await 중단은 콘솔 task 취소라 `KeyboardInterrupt`가 아니라 `CancelledError`로 온다.
  it("except KeyboardInterrupt는 잡지 못한다", async () => {
    const runner = await setup({ topLevelAwait: true });
    const block = [
      "try:",
      `    await asyncio.sleep(${IDLE_WAIT})`,
      "except KeyboardInterrupt:",
      "    print('caught')",
    ].join("\n");

    expectWoken(await runBlockWaking(runner, block));

    expect(runner.screen.stdout).toBe("");
    expect(runner.screen.stderr).toBe(AWAIT_INTERRUPT);
  }, 20_000);
});

// 콘솔 task는 await 지점에서 멈춘(`CORO_SUSPENDED`) 때만 취소한다.
// 실행 중이거나 재개 중인 task를 취소하면 코루틴이 끝나는 순간 task가 취소로 끝난다.
// 그러면 `ConsoleFuture`가 영영 끝나지 않는다(HANG, TRAP-08).
// 이 조건이 깨지면 아래 시험은 끝나지 않아 시간 초과로 실패한다.
describe("콘솔 task 취소 조건", () => {
  it("실행 중인 콘솔 task는 interruptIdle()이 취소하지 않는다", async () => {
    const runner = await setup({ topLevelAwait: true });
    pyodide.globals.set("idle", runner.interruptIdle);

    expect(await runner.run("print(idle())")).toEqual(READY);
    expect(await runner.run("print('next')")).toEqual(READY);

    expect(runner.screen.stdout).toBe("False\nnext\n");
    expect(runner.screen.stderr).toBe("");
  }, 10_000);

  it("이미 깨운 대기 위의 두 번째 interruptIdle()은 콘솔 task를 취소하지 않는다", async () => {
    const runner = await setup({ topLevelAwait: true });
    const calls: boolean[] = [];
    // 정지한 대기 중 한 JS 콜백 안에서 두 번 부른다.
    // 첫 호출이 대기를 깨운다. 대기가 재개되기 전에 둘째 호출이 온다.
    // 이때 콘솔 task는 아직 `run_sync` 안이라 `CORO_RUNNING`이다.
    const timer = setTimeout(() => {
      calls.push(runner.interruptIdle(), runner.interruptIdle());
    }, WAKE_AT_MS);

    try {
      expect(await runner.run(`run_sync(asyncio.sleep(${IDLE_WAIT}))`)).toEqual(
        READY,
      );
    } finally {
      clearTimeout(timer);
    }

    expect(calls).toEqual([true, false]);
    expect(runner.screen.stderr).toBe(CONSOLE_TRACEBACK);
  }, 20_000);
});

// 타이머 틱 사이에 Python 콜백이 SIGINT를 먼저 소비하면 타이머만으로는 눌림이 손실된다.
// 핸들러가 사용자 스택이 없어 버리는 경우다.
// 이 시험은 타이머(`wakeAfter`) 없이 핸들러 규칙 ③만으로 깨운다.
describe("SIGINT 핸들러 보완(타이머 없음)", () => {
  it("정지한 run_sync 루프의 콜백이 소비한 SIGINT도 루프를 끊는다", async () => {
    const runner = await setup();
    expect(
      (await runner.run("for _ in range(300): run_sync(asyncio.sleep(0.01))"))
        .prompt,
    ).toBe(PS2);
    const presser = runner.presser();
    presser.press({ offsets: [200], waitStarted: false });
    const startedAt = performance.now();

    expect(await runner.run("")).toEqual(READY);

    expect(performance.now() - startedAt).toBeLessThan(200 + WAKE_LIMIT_MS);
    expect(runner.screen.stderr).toBe(CONSOLE_TRACEBACK);
    await presser.done();
  }, 20_000);

  // await 사이에 사용자 프레임이 자주 도는 짧은 루프다.
  // 눌림이 소비되는 위치에 따라 화면이 셋 중 하나다.
  // - 정지한 구간(콜백): 콘솔 task 취소의 한 줄.
  // - 사용자 프레임: 보통의 트레이스백.
  // - 사용자 await 사슬 안의 asyncio 프레임: 그 프레임이 든 트레이스백.
  // 어느 쪽이든 끊기고 우리 쪽 프레임은 없다.
  it("TLA await 루프의 콜백이 소비한 SIGINT도 루프를 끊는다", async () => {
    const runner = await setup({ topLevelAwait: true });
    expect(
      (await runner.run("for _ in range(300): await asyncio.sleep(0.01)"))
        .prompt,
    ).toBe(PS2);
    const presser = runner.presser();
    presser.press({ offsets: [200], waitStarted: false });
    const startedAt = performance.now();

    expect(await runner.run("")).toEqual(READY);

    expect(performance.now() - startedAt).toBeLessThan(200 + WAKE_LIMIT_MS);
    expect(runner.screen.stderr).toMatch(
      /^(KeyboardInterrupt|Traceback \(most recent call last\):\n[\s\S]*KeyboardInterrupt)\n$/,
    );
    expect(runner.screen.stderr).not.toMatch(
      /sigint_handler|<sigint-handler>|run_sync|guard|WOKEN/,
    );
    await presser.done();
  }, 20_000);
});

// 폴링이 SIGINT를 처리하는 bytecode 위치는 폴링 위상에 달려 있다. 자연 재현율이 0%~67%로 흔들린다.
// 그래서 경합 지점에 `press(); signal.raise_signal(SIGINT)`를 끼워 그 인터리빙을 결정적으로 만든다.
// 주입 코드는 `<test>` 파일명이라 사용자 프레임이 아니다. 핸들러가 규칙 ③으로 간다.
describe("asyncio 콜백 경합 지점에서 처리된 SIGINT(주입)", () => {
  // `asyncio.sleep`의 타이머 콜백 `_set_result_unless_cancelled`는 `fut.cancelled()` 검사와 `fut.set_result()` 사이가 원자적이라고 가정한다.
  // 그 사이에서 처리된 SIGINT가 대기 Task를 그 자리에서 취소하면 sleep future가 취소된다.
  // 그 뒤 `set_result`가 `InvalidStateError`를 내고 WebLoop가 그것을 stderr에 찍는다.
  it("sleep 타이머 콜백의 검사 통과 직후 처리된 SIGINT도 표준 트레이스백만 남긴다", async () => {
    const runner = await setup();
    pyodide.runPython(
      `import asyncio.futures, signal
_sruc_original = asyncio.futures._set_result_unless_cancelled
_sruc_hits = []

def _sruc_pressing(fut, result):
    # 원본과 같은 본문에 "검사 통과 뒤 눌림 처리" 한 지점만 끼운다(첫 호출에서 한 번).
    if fut.cancelled():
        return
    if not _sruc_hits:
        _sruc_hits.append(1)
        press()
        signal.raise_signal(signal.SIGINT)
    fut.set_result(result)

asyncio.futures._set_result_unless_cancelled = _sruc_pressing
`,
      { globals: pyodide.globals, filename: "<test>" },
    );

    try {
      expect(await runner.run("run_sync(asyncio.sleep(0.01))")).toEqual(READY);
    } finally {
      pyodide.runPython(
        "import asyncio.futures\nasyncio.futures._set_result_unless_cancelled = _sruc_original",
        { globals: pyodide.globals, filename: "<test>" },
      );
    }

    // 주입 지점을 실제로 지났는지 확인한다. 지나지 않았으면 이 시험은 아무것도 보지 않은 것이다.
    expect(
      pyodide.runPython("len(_sruc_hits)", { globals: pyodide.globals }),
    ).toBe(1);
    expect(runner.screen.stderr).toBe(CONSOLE_TRACEBACK);
  }, 20_000);

  // 감시 타이머가 이미 깨운 대기가 취소 처리(`finally`)를 도는 동안 새 SIGINT가 콜백에서 처리되는 경우다.
  // 그 눌림은 곧 올라갈 `KeyboardInterrupt`에 합쳐져야 한다.
  // 핸들러가 이것까지 한 틱 미루면 미룬 콜백이 `KeyboardInterrupt` 전달 뒤에 돈다.
  // 그러면 다음 `run_sync`에서 `KeyboardInterrupt`를 한 번 더 올린다(이중 반영).
  it("감시 타이머가 깨운 대기의 취소 처리 중 소비된 SIGINT는 KeyboardInterrupt를 한 번 더 만들지 않는다", async () => {
    const runner = await setup();
    pyodide.runPython(
      `import asyncio, signal

def _late_press():
    press()
    signal.raise_signal(signal.SIGINT)

async def woken_waiter():
    try:
        await asyncio.sleep(5)
    finally:
        # 깨운 대기의 취소 처리 중에 다음 콜백으로 눌림을 예약한다: guard가 WOKEN으로 끝나 래퍼가 재개하기 전에 처리된다.
        asyncio.get_event_loop().call_soon(_late_press)
`,
      { globals: pyodide.globals, filename: "<test>" },
    );
    const program = [
      "n = 0",
      "try:",
      "    run_sync(woken_waiter())",
      "except KeyboardInterrupt:",
      "    n += 1",
      "deadline = time.monotonic() + 1",
      "while time.monotonic() < deadline:",
      "    try:",
      "        run_sync(asyncio.sleep(0.05))",
      "    except KeyboardInterrupt:",
      "        n += 1",
    ].join("\n");
    const wake = runner.wakeAfter(WAKE_AT_MS);

    expect(await runner.run(execSource(program))).toEqual(READY);

    await wake;
    expect(pyodide.globals.get("n")).toBe(1);
    expect(runner.screen.stderr).toBe("");
  }, 20_000);

  // `run_sync` 래퍼가 `guard(awaitable)` 코루틴을 만든 뒤 Task를 만들기 전에 SIGINT가 처리되는 경우다.
  // 사슬에 `<console>` 프레임이 있어 핸들러 규칙 ①이 그 자리에서 `KeyboardInterrupt`를 올린다.
  // 그때 `guard`·awaitable 코루틴이 await되지 않은 채 버려지면 `RuntimeWarning: coroutine ... was never awaited`가 트레이스백 앞에 찍힌다.
  it("run_sync 래퍼가 Task를 만들기 전에 처리된 SIGINT도 never awaited 경고 없이 표준 트레이스백만 남긴다", async () => {
    const runner = await setup();
    pyodide.runPython(
      `import asyncio, signal
_ef_original = asyncio.ensure_future
_ef_hits = []

def _ef_pressing(*args, **kwargs):
    # run_sync 래퍼가 guard 코루틴을 넘긴 호출에서만, 진입 직후(Task 생성 전) 한 번 눌림을 처리한다. 콘솔도 제출마다
    # ensure_future로 실행 task를 만들므로 첫 호출만 고르면 그쪽에 걸린다.
    if not _ef_hits and getattr(args[0] if args else None, '__name__', '') == 'guard':
        _ef_hits.append(1)
        press()
        signal.raise_signal(signal.SIGINT)
    return _ef_original(*args, **kwargs)

asyncio.ensure_future = _ef_pressing
`,
      { globals: pyodide.globals, filename: "<test>" },
    );

    try {
      expect(await runner.run("run_sync(asyncio.sleep(0.01))")).toEqual(READY);
    } finally {
      pyodide.runPython(
        "import asyncio\nasyncio.ensure_future = _ef_original",
        {
          globals: pyodide.globals,
          filename: "<test>",
        },
      );
    }

    expect(
      pyodide.runPython("len(_ef_hits)", { globals: pyodide.globals }),
    ).toBe(1);
    expect(runner.screen.stderr).toBe(CONSOLE_TRACEBACK);
  }, 20_000);

  // C `run_sync`는 넘겨받은 `guard` Task를 JS로 바꾸는 중(python2js → pyproxy_getflags → type_getflags)에 `Generator` 추상 클래스 검사를 부른다.
  // 그 검사는 `ABCMeta.__subclasscheck__` Python 프레임이다.
  // 그 프레임에서 SIGINT가 처리되면 사슬에 `<console>` 프레임이 있어 규칙 ①이 `KeyboardInterrupt`를 올린다.
  // pyodide는 그 예외를 `ConversionError`로 감싼다.
  // 주입 조건은 식별 비교만 쓴다. `isinstance`·`issubclass`로 ABC를 검사하면 이 래퍼가 재귀한다.
  // WebLoop의 Task 클래스는 `PyodideTask`다.
  const injectSubclasscheck = () =>
    pyodide.runPython(
      `import abc, collections.abc, signal
import pyodide.webloop
_sc_original = abc.ABCMeta.__subclasscheck__
_sc_hits = []

def _sc_pressing(cls, subclass):
    # guard Task를 JS로 바꾸는 Generator 검사에서만, 한 번 눌림을 처리한다.
    if not _sc_hits and cls is collections.abc.Generator and subclass is pyodide.webloop.PyodideTask:
        _sc_hits.append(1)
        press()
        signal.raise_signal(signal.SIGINT)
    return _sc_original(cls, subclass)

abc.ABCMeta.__subclasscheck__ = _sc_pressing
`,
      { globals: pyodide.globals, filename: "<test>" },
    );

  // 주입을 되돌리고 주입 횟수를 돌려준다. 파일이 공유하는 세션에 상태를 남기지 않는다.
  const restoreSubclasscheck = () =>
    pyodide.runPython(
      `import abc
abc.ABCMeta.__subclasscheck__ = _sc_original
_sc_n = len(_sc_hits)
del _sc_original, _sc_hits, _sc_pressing
_sc_n`,
      { globals: pyodide.globals, filename: "<test>" },
    ) as number;

  it("run_sync 래퍼의 JS 변환 중 처리된 SIGINT도 표준 트레이스백만 남긴다", async () => {
    const runner = await setup();
    injectSubclasscheck();
    let hits: number;

    try {
      expect(await runner.run("run_sync(asyncio.sleep(0.01))")).toEqual(READY);
    } finally {
      hits = restoreSubclasscheck();
    }

    // 주입 지점을 실제로 지났는지 확인한다. 지나지 않았으면 이 시험은 아무것도 보지 않은 것이다.
    expect(hits).toBe(1);
    const stderr = runner.screen.stderr;
    expect(stderr).toBe(CONSOLE_TRACEBACK);
    // 위 단언이 통째 비교라 실패 메시지가 길다. 새는 조각을 이름으로 따로 확인한다(TRP-021).
    for (const leaked of [
      "ConversionError",
      "<sigint-handler>",
      "<frozen abc>",
      "<test>",
    ]) {
      expect(stderr).not.toContain(leaked);
    }
    expect(stderr.split("Traceback (most recent call last)").length - 1).toBe(
      1,
    );
  }, 20_000);

  it("run_sync 래퍼의 JS 변환 중 처리된 SIGINT도 사용자 except KeyboardInterrupt가 잡는다", async () => {
    const runner = await setup();
    injectSubclasscheck();
    const program = [
      "caught = 0",
      "try:",
      "    run_sync(asyncio.sleep(0.01))",
      "except KeyboardInterrupt:",
      "    caught = 1",
    ].join("\n");
    let hits: number;

    try {
      expect(await runner.run(execSource(program))).toEqual(READY);
    } finally {
      hits = restoreSubclasscheck();
    }

    expect(hits).toBe(1);
    expect(pyodide.globals.get("caught")).toBe(1);
    expect(runner.screen.stderr).toBe("");
  }, 20_000);

  // 변환 중 눌림을 규칙 ①로 올리지 않고 미룬 깨우기로 보내는 수정이 `pending`만 세우는 것으로 줄어드는 경우다.
  // 짧은 awaitable은 같은 결말이다. 긴 awaitable은 끝까지 실행된 뒤에야 `KeyboardInterrupt`가 오른다.
  // 판정은 시간이 아니라 이벤트다. 대기가 끝까지 돌지 않았고(`done`), 취소 처리(`finally`)는 실행됐다(`fin`).
  it("run_sync 래퍼의 JS 변환 중 처리된 SIGINT는 긴 awaitable을 끝까지 돌리지 않고 취소한다", async () => {
    const runner = await setup();
    pyodide.runPython(
      `import asyncio
_cv_done = []
_cv_fin = []

async def _cv_slow():
    try:
        await asyncio.sleep(5)
        _cv_done.append(1)
    finally:
        _cv_fin.append(1)
`,
      { globals: pyodide.globals, filename: "<test>" },
    );
    injectSubclasscheck();
    let hits: number;

    try {
      expect(await runner.run("run_sync(_cv_slow())")).toEqual(READY);
    } finally {
      hits = restoreSubclasscheck();
    }

    expect(hits).toBe(1);
    expect(runner.screen.stderr).toBe(CONSOLE_TRACEBACK);
    expect(
      pyodide.runPython("_cv_done", { globals: pyodide.globals }).toJs(),
    ).toEqual([]);
    expect(
      pyodide.runPython("_cv_fin", { globals: pyodide.globals }).toJs(),
    ).toEqual([1]);
  }, 20_000);

  // 변환 구간 표시(`converting`)는 C `run_sync`가 끝나면 내려가야 한다.
  // 남아 있으면 다음 `run_sync` 호출의 Task 생성 전 눌림까지 미뤄진다.
  // 원래 결말은 규칙 ①로 올려 awaitable을 시작하지 않는 것이다. 미뤄지면 awaitable이 시작된 뒤에야 중단된다.
  it("앞선 run_sync가 끝난 뒤 Task 생성 전에 처리된 SIGINT는 awaitable을 시작하지 않고 표준 트레이스백만 남긴다", async () => {
    const runner = await setup();
    expect(await runner.run("run_sync(asyncio.sleep(0.01))")).toEqual(READY);
    pyodide.runPython(
      `import asyncio, signal
_cs_started = []
_cs_original = asyncio.ensure_future
_cs_hits = []

async def _cs_probe():
    _cs_started.append(1)
    await asyncio.sleep(5)

def _cs_pressing(*args, **kwargs):
    # guard 코루틴을 넘긴 호출의 진입 직후(Task 생성 전)에 한 번 눌림을 처리한다.
    if not _cs_hits and getattr(args[0] if args else None, '__name__', '') == 'guard':
        _cs_hits.append(1)
        press()
        signal.raise_signal(signal.SIGINT)
    return _cs_original(*args, **kwargs)

asyncio.ensure_future = _cs_pressing
`,
      { globals: pyodide.globals, filename: "<test>" },
    );

    try {
      expect(await runner.run("run_sync(_cs_probe())")).toEqual(READY);
    } finally {
      pyodide.runPython(
        "import asyncio\nasyncio.ensure_future = _cs_original",
        { globals: pyodide.globals, filename: "<test>" },
      );
    }

    expect(
      pyodide.runPython("len(_cs_hits)", { globals: pyodide.globals }),
    ).toBe(1);
    expect(runner.screen.stderr).toBe(CONSOLE_TRACEBACK);
    expect(
      pyodide.runPython("_cs_started", { globals: pyodide.globals }).toJs(),
    ).toEqual([]);
  }, 20_000);
});

describe("깨울 수 없는 순간에 소비된 SIGINT", () => {
  // 표시(`pending`)는 재개하는 `run_sync`가 올려야 사라진다.
  // 대기가 예외로 끝나 재개 지점에서 올리지 못하면, 실행이 끝날 때(`runcode` 경계) 지워져야 한다.
  // 그래야 다음 문장이 끊기지 않는다.
  // 코루틴은 `<console>`이 아닌 파일명으로 정의한다. `<console>`이면 핸들러가 사용자 프레임으로 보고 그 자리에서 `KeyboardInterrupt`를 올린다.
  it("예외로 끝난 실행에 남은 표시는 다음 문장을 끊지 않는다", async () => {
    const runner = await setup();
    pyodide.runPython(
      `import asyncio, signal

async def w():
    press()
    signal.raise_signal(signal.SIGINT)
    raise ValueError("boom")
`,
      { globals: pyodide.globals, filename: "<test>" },
    );
    expect(await runner.run("run_sync(w())")).toEqual(READY);
    expect(runner.screen.stderr).toContain("ValueError: boom");
    runner.screen.stdout = "";
    runner.screen.stderr = "";

    expect(
      await runner.run("run_sync(asyncio.sleep(0.05)); print('ok')"),
    ).toEqual(READY);

    expect(runner.screen.stdout).toBe("ok\n");
    expect(runner.screen.stderr).toBe("");
  }, 20_000);
});

describe("pyodide 가정", () => {
  // `run_sync` 대기가 사용자 스택을 정지하는 것은 JSPI로 정지할 수 있는 호출 스택에서만이다.
  // 그래서 `pyodide.runPython`의 동기 호출이 아니라 콘솔 실행 안에서 본다.
  it("콘솔 실행 안의 can_run_sync()는 참이다", async () => {
    const runner = await setup();

    expect(
      await runner.run("from pyodide.ffi import can_run_sync; can_run_sync()"),
    ).toEqual(READY);

    expect(runner.screen.stdout).toBe("True\n");
  });

  // 사용자의 `from pyodide.ffi import run_sync`와 webloop.py의 `run_until_complete`가 모두 래퍼를 부르려면 두 곳을 함께 교체해야 한다.
  it("설치 뒤 pyodide.ffi.run_sync와 pyodide.webloop.run_sync는 같은 래퍼다", async () => {
    await setup();

    expect(
      pyodide.runPython(
        `import pyodide.ffi, pyodide.webloop
pyodide.ffi.run_sync is pyodide.webloop.run_sync and pyodide.ffi.run_sync.__code__.co_filename == "${SIGINT_HANDLER_FILENAME}"`,
        { globals: pyodide.toPy({}), filename: "<test>" },
      ),
    ).toBe(true);
  });
});

// 가정이 깨지면 정지한 실행 깨우기만 건너뛴다.
// 핸들러 규칙 ①②④(바쁜 루프 중단)와 `time.sleep` 조각 중단은 그대로다.
describe("설치 가드", () => {
  // 가드에 걸린 설치에서도 남아 있어야 하는 것을 단언한다. 바쁜 루프 중단과 `time.sleep` 조각 중단이다.
  async function expectStillInterruptible(runner: Runner): Promise<void> {
    expect(
      await runner.run(execSource("press()\nfor _ in range(10**7): pass")),
    ).toEqual(READY);
    expect(runner.screen.stderr).toMatch(/KeyboardInterrupt\n$/);
    runner.screen.stderr = "";
    const presser = runner.presser();
    presser.press({ offsets: [200] });
    const startedAt = performance.now();
    expect(await runner.run("started(); time.sleep(5)")).toEqual(READY);
    expect(performance.now() - startedAt).toBeLessThan(200 + WAKE_LIMIT_MS);
    expect(runner.screen.stderr).toMatch(/KeyboardInterrupt\n$/);
    await presser.done();
  }

  it.each([
    [
      "pyodide.webloop",
      "pyodide.webloop.run_sync = None",
      "pyodide.webloop.run_sync",
    ],
    ["pyodide.ffi", "del pyodide.ffi.run_sync", "pyodide.ffi.run_sync"],
  ])(
    "%s의 run_sync가 기대와 다르면 깨우기를 건너뛰고 run-sync로 report한다",
    async (_title, breakage, label) => {
      pyodide.runPython(`import pyodide.ffi, pyodide.webloop\n${breakage}`, {
        globals: pyodide.toPy({}),
        filename: "<test>",
      });

      const runner = await setup({ report });

      expect(report.mock.calls).toEqual([["run-sync", label]]);
      expect(runner.interruptIdle()).toBe(false);
      await expectStillInterruptible(runner);
    },
    30_000,
  );

  it("console.runcode가 코루틴 함수가 아니면 깨우기를 건너뛰고 run-sync로 report한다", async () => {
    // 클래스 속성을 바꿔 설치 시점의 `console.runcode`를 일반 함수로 만든다.
    // 설치 직후 되돌린다. 그 뒤의 실행은 원래 `runcode`(인스턴스 속성이 없으므로 클래스 것)를 쓴다.
    pyodide.runPython(
      `import pyodide.console
_saved_runcode = pyodide.console.PyodideConsole.runcode
pyodide.console.PyodideConsole.runcode = lambda self, source, code: None`,
      { globals: pyodide.globals, filename: "<test>" },
    );
    let runner: Runner;
    try {
      runner = await setup({ report });
    } finally {
      pyodide.runPython(
        `import pyodide.console
pyodide.console.PyodideConsole.runcode = _saved_runcode
del _saved_runcode`,
        { globals: pyodide.globals, filename: "<test>" },
      );
    }

    expect(report.mock.calls).toEqual([["run-sync", "console.runcode"]]);
    expect(runner.interruptIdle()).toBe(false);
    await expectStillInterruptible(runner);
  }, 30_000);
});

/** `time.sleep(5)`를 부르는 코루틴의 소스. `<console>` 파일명으로 정의해 사용자 프레임으로 인정되게 한다. `time.sleep`은 5행이다. */
const SLEEPER_SOURCE = `import asyncio, time

async def main():
    started()
    time.sleep(5)
`;

/** `SLEEPER_SOURCE`의 `time.sleep(5)`가 눌림에 끊겼을 때의 정확한 화면. `main` 프레임(5행)이 남는다. */
const CONSOLE_MAIN_SLEEP_TRACEBACK =
  'Traceback (most recent call last):\n  File "<console>", line 1, in <module>\n  File "<console>", line 5, in main\nKeyboardInterrupt\n';

describe("time.sleep과 정지한 대기의 조합", () => {
  it.each(RUNNERS)(
    "%s 코루틴 안의 time.sleep 중 눌림도 webloop 프레임 없이 끊고 main 프레임을 남긴다",
    async (_title, wrap) => {
      const runner = await setup();
      pyodide.runPython(SLEEPER_SOURCE, {
        globals: pyodide.globals,
        filename: "<console>",
      });
      const presser = runner.presser();
      presser.press({ offsets: [300] });
      const startedAt = performance.now();

      expect(await runner.run(wrap("main()"))).toEqual(READY);

      expect(performance.now() - startedAt).toBeLessThan(300 + WAKE_LIMIT_MS);
      expect(runner.screen.stderr).toBe(CONSOLE_MAIN_SLEEP_TRACEBACK);
      await presser.done();
    },
    20_000,
  );
});

// RD-009a: `run_sync` 계열 대기 안 코루틴이 예외로 끝났을 때 `sys.excepthook` 이중 인쇄를 없앤다. `guard`가 예외를 값으로 나른다.
describe("run_sync 계열 대기에서 코루틴이 낸 예외", () => {
  it.each(RUNNERS)(
    "%s: 코루틴이 낸 ValueError는 트레이스백이 한 번만 찍히고 main 프레임이 남는다",
    async (_title, wrap) => {
      const runner = await setup();
      pyodide.runPython("async def main():\n    raise ValueError('boom')\n", {
        globals: pyodide.globals,
        filename: "<console>",
      });

      expect(await runner.run(wrap("main()"))).toEqual(READY);

      expect(runner.screen.stderr).toBe(
        'Traceback (most recent call last):\n  File "<console>", line 1, in <module>\n  File "<console>", line 2, in main\nValueError: boom\n',
      );
    },
    20_000,
  );

  it.each(RUNNERS)(
    "%s: 코루틴이 낸 KeyboardInterrupt는 인자가 보존되고 한 번만 찍힌다",
    async (_title, wrap) => {
      const runner = await setup();
      pyodide.runPython(
        "async def main():\n    raise KeyboardInterrupt('custom')\n",
        { globals: pyodide.globals, filename: "<console>" },
      );

      expect(await runner.run(wrap("main()"))).toEqual(READY);

      expect(
        runner.screen.stderr.match(/Traceback \(most recent call last\):/g),
      ).toHaveLength(1);
      expect(
        runner.screen.stderr.match(/KeyboardInterrupt: custom/g),
      ).toHaveLength(1);
      expect(runner.screen.stderr).not.toContain(SIGINT_HANDLER_FILENAME);
    },
    20_000,
  );

  it("except 안에서 눌린 time.sleep도 컨텍스트 연쇄 문구가 한 번만 찍힌다", async () => {
    const runner = await setup();
    pyodide.runPython(
      `import time

async def main():
    started()
    try:
        raise ValueError('inner')
    except ValueError:
        time.sleep(5)
`,
      { globals: pyodide.globals, filename: "<console>" },
    );
    const presser = runner.presser();
    presser.press({ offsets: [300] });
    const startedAt = performance.now();

    expect(await runner.run("asyncio.run(main())")).toEqual(READY);

    expect(performance.now() - startedAt).toBeLessThan(300 + WAKE_LIMIT_MS);
    expect(
      runner.screen.stderr.match(
        /During handling of the above exception, another exception occurred:/g,
      ),
    ).toHaveLength(1);
    expect(runner.screen.stderr).not.toContain(SIGINT_HANDLER_FILENAME);
    expect(runner.screen.stderr).not.toContain("<sleep-slice>");
    expect(runner.screen.stderr).toMatch(/KeyboardInterrupt\n$/);
    expect(runner.screen.stderr.match(/ValueError: inner/g)).toHaveLength(1);
    await presser.done();
  }, 20_000);

  it("코루틴 안에서 KeyboardInterrupt를 잡고 finally도 실행된다", async () => {
    const runner = await setup();
    pyodide.runPython(
      `import time

async def main():
    started()
    try:
        time.sleep(5)
    except KeyboardInterrupt:
        print('caught')
    finally:
        print('fin')
`,
      { globals: pyodide.globals, filename: "<console>" },
    );
    const presser = runner.presser();
    presser.press({ offsets: [300] });
    const startedAt = performance.now();

    expect(await runner.run("asyncio.run(main())")).toEqual(READY);

    expect(performance.now() - startedAt).toBeLessThan(300 + WAKE_LIMIT_MS);
    expect(runner.screen.stdout).toBe("caught\nfin\n");
    expect(runner.screen.stderr).toBe("");
    await presser.done();
  }, 20_000);

  it("코루틴 안 sys.exit는 트레이스백 없이 종료 표시로 끝난다", async () => {
    const runner = await setup();
    pyodide.runPython("async def main():\n    import sys\n    sys.exit(3)\n", {
      globals: pyodide.globals,
      filename: "<console>",
    });

    expect(await runner.run("asyncio.run(main())")).toEqual({
      prompt: PS1,
      exit: true,
    });

    expect(runner.screen.stderr).toBe("");
  }, 20_000);

  // 사용자가 잡은 예외의 `__traceback__`에도 나르며 다듬은 결과가 그대로 보인다.
  // `guard`·sleep 조각·핸들러·JS 가짜 프레임이 없다.
  // `run_sync` 래퍼(`<sigint-handler>`)와 pyodide `webloop.py`는 실제 호출 경로라 남아도 허용 편차다.
  it("사용자가 잡은 KeyboardInterrupt의 __traceback__에는 우리 헬퍼 프레임이 없다", async () => {
    const runner = await setup();
    pyodide.runPython(SLEEPER_SOURCE, {
      globals: pyodide.globals,
      filename: "<console>",
    });
    pyodide.runPython(
      `def catcher():
    try:
        asyncio.run(main())
    except KeyboardInterrupt as e:
        import traceback
        print([(f.filename, f.name) for f in traceback.extract_tb(e.__traceback__)])
`,
      { globals: pyodide.globals, filename: "<console>" },
    );
    const presser = runner.presser();
    presser.press({ offsets: [300] });
    const startedAt = performance.now();

    expect(await runner.run("catcher()")).toEqual(READY);

    expect(performance.now() - startedAt).toBeLessThan(300 + WAKE_LIMIT_MS);
    expect(runner.screen.stdout).not.toMatch(
      /'guard'|'sleep'|'poll'|'sigint_handler'/,
    );
    expect(runner.screen.stdout).not.toContain("<sleep-slice>");
    expect(runner.screen.stdout).not.toContain("wasm://");
    expect(runner.screen.stdout).not.toContain("pyodide.asm.mjs");
    expect(runner.screen.stderr).toBe("");
    await presser.done();
  }, 20_000);

  it("코루틴이 부른 <console> 함수의 프레임도 남는다(중첩)", async () => {
    const runner = await setup();
    pyodide.runPython(
      `async def main():
    helper()

def helper():
    started()
    time.sleep(5)
`,
      { globals: pyodide.globals, filename: "<console>" },
    );
    const presser = runner.presser();
    presser.press({ offsets: [300] });
    const startedAt = performance.now();

    expect(await runner.run("asyncio.run(main())")).toEqual(READY);

    expect(performance.now() - startedAt).toBeLessThan(300 + WAKE_LIMIT_MS);
    expect(runner.screen.stderr).toBe(
      'Traceback (most recent call last):\n  File "<console>", line 1, in <module>\n  File "<console>", line 2, in main\n  File "<console>", line 6, in helper\nKeyboardInterrupt\n',
    );
    await presser.done();
  }, 20_000);

  // 코루틴 안에 사용자 프레임이 없는 경우(라이브러리가 낸 예외)의 규칙 검증이다.
  // 안쪽 끝이 우리 코드가 아니므로 절단하지 않는다.
  // 래퍼 프레임만 떼고 라이브러리 프레임(`asyncio/tasks.py`)은 남는다.
  it("코루틴 안에 사용자 프레임이 없으면 라이브러리 프레임이 남는다(TypeError)", async () => {
    const runner = await setup();

    expect(await runner.run("asyncio.run(asyncio.sleep('x'))")).toEqual(READY);

    expect(
      runner.screen.stderr.match(/Traceback \(most recent call last\):/g),
    ).toHaveLength(1);
    expect(runner.screen.stderr).toContain("asyncio/tasks.py");
    expect(runner.screen.stderr).toMatch(/TypeError/);
    expect(runner.screen.stderr).not.toContain(SIGINT_HANDLER_FILENAME);
  }, 20_000);
});
