// @vitest-environment node
/**
 * `time.sleep` 20ms 조각 교체 시험(03-ctrl-c.md 2.4의 "`time.sleep` 20ms 조각", 09-testing.md 9.1). pyodide는
 * `time.sleep`을 webloop의 `_sleep`으로 바꿔 둔다: JSPI가 있으면 `run_sync(asyncio.sleep(t))`(사용자 스택이 정지해
 * 눌림이 버려지고 sleep 중 이벤트 루프가 돌며 무효 인자 문구가 asyncio의 것이 된다), 없으면 원본 블로킹 sleep(폴링이
 * 아예 없다)이다. 이 시험이 도는 vitest/node는 JSPI가 있는 쪽이다. 조각 교체가 20ms마다
 * `pyodide_js.checkInterrupt()`를 불러 `time.sleep` 호출 지점에서 `KeyboardInterrupt`가 나게 한다. 조각 경계·
 * 트레이스백·무효 인자 의미는 실제 pyodide에서만 재현되므로 mock 없이 로드한다. 조립은
 * `test/console-harness.ts`가 `sigint-handler.test.ts`와 공유한다.
 *
 * 인스턴스를 파일 하나에서 공유하므로 `afterEach`가 `time.sleep`을 pyodide 기본(webloop `_sleep`)으로 되돌린다.
 * 조각 래퍼 자체는 `functools.wraps` 규칙상 겹쌓이지 않지만, "설치 전" 시험이 앞선 시험의 래퍼를 보면 안 된다.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BUSY,
  CONSOLE_TRACEBACK,
  execSource,
  type PresserEvent,
  pyodide,
  READY,
  useConsoleHarness,
} from "../console-harness";
import { SLEEP_SLICE_FILENAME } from "@cp949/runo-pyodide-core/test-utils/worker";

/**
 * 눌림 뒤 `KeyboardInterrupt`까지의 상한(ms). 응답성이 요구 사항 자체라 상한 판정을 쓴다
 * (`09-testing.md` 9.7 예외 2, `03-ctrl-c.md` 2.4의 20ms 조각). 조각이 걸리지 않으면 `time.sleep(5)`는
 * 5초, `time.sleep(2**31)`은 사실상 무한이므로 1초면 결함과 정상을 가른다. 값 근거는 같은 장비 실측이다:
 * 파일 단독 42.8~56.9ms(n=25), 패키지 전체 병렬 63.5~92.1ms(n=15), 루트 전체 실행에서 133.2ms
 * (옛 100ms 상한의 거짓 실패, `.scratch/sigint-test-isolation/issues/04-sleep-slice-2pow31-timing-flake.md`).
 * 같은 이유로 `run-driver-pyodide.test.ts`도 1초를 쓴다.
 */
const PRESS_LIMIT_MS = 1000;

const { setup, report } = useConsoleHarness({
  // 설치 전 상태를 붙잡아 시험마다 되돌린다. `_default_sleep`은 webloop의 `_sleep`, `_default_wrapped`는 원본 C 함수다.
  afterLoad: (pyodide) => {
    pyodide.runPython(
      "import time\n_default_sleep = time.sleep\n_default_wrapped = time.sleep.__wrapped__",
    );
  },
  // 조각 래퍼와 가드 시험의 `del time.sleep.__wrapped__`를 한 번에 되돌린다.
  afterEach: (pyodide) => {
    pyodide.runPython(
      "import time\ntime.sleep = _default_sleep\ntime.sleep.__wrapped__ = _default_wrapped",
    );
  },
});

/**
 * `started(); mark(); <source>` 한 줄을 돌리는 동안 눌림 스레드가 `offsetMs` 뒤에 누른다. 눌림 시각부터 제출이
 * 끝날 때까지의 ms를 돌려준다. 두 시각 모두 스레드 공통의 `process.hrtime.bigint()`로 잰다.
 */
async function pressDuring(
  runner: ReturnType<typeof setup>,
  source: string,
  offsetMs: number,
): Promise<number> {
  let markedAt: bigint | undefined;
  pyodide.globals.set("mark", () => {
    markedAt = process.hrtime.bigint();
  });
  const presser = runner.presser();
  presser.press({ offsets: [offsetMs] });

  expect(await runner.run(`started(); mark(); ${source}`)).toEqual(READY);

  const finishedMs = Number(process.hrtime.bigint() - markedAt!) / 1e6;
  const event = (await presser.done()) as Extract<
    PresserEvent,
    { kind: "pressed" }
  >;
  expect(event.kind).toBe("pressed");
  return finishedMs - event.atMs[0]!;
}

/** `screen.stderr`의 마지막 줄(예외 종류와 문구). */
const lastLine = (stderr: string) => stderr.trimEnd().split("\n").at(-1);

describe("time.sleep 조각 폴링", () => {
  it("time.sleep(5) 도중의 눌림이 1초 안에 KeyboardInterrupt로 끊는다", async () => {
    const runner = setup();

    const afterPressMs = await pressDuring(runner, "time.sleep(5)", 300);

    expect(runner.screen.stderr).toBe(CONSOLE_TRACEBACK);
    expect(afterPressMs).toBeLessThan(PRESS_LIMIT_MS);
  }, 20_000);

  it("time.sleep(0.1)은 20ms 조각마다 checkInterrupt를 부른다", async () => {
    // 조각 래퍼는 설치 시점에 `pyodide_js.checkInterrupt`를 붙잡으므로 스파이를 setup 전에 건다.
    const checkInterrupt = vi.spyOn(pyodide, "checkInterrupt");
    const { run } = setup();

    expect(await run("time.sleep(0.1)")).toEqual(READY);

    expect(checkInterrupt.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(checkInterrupt.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("한 조각 이하의 time.sleep(0.01) 3회도 매번 폴링한다", async () => {
    const checkInterrupt = vi.spyOn(pyodide, "checkInterrupt");
    const { run } = setup();

    expect(
      await run(
        execSource("import time\nfor _ in range(3):\n    time.sleep(0.01)"),
      ),
    ).toEqual(READY);

    expect(checkInterrupt).toHaveBeenCalledTimes(3);
  });

  it("time.sleep(0)은 원본에 넘어가 폴링하지 않는다", async () => {
    const checkInterrupt = vi.spyOn(pyodide, "checkInterrupt");
    const { run, screen } = setup();

    expect(await run("time.sleep(0)")).toEqual(READY);

    expect(checkInterrupt).toHaveBeenCalledTimes(0);
    expect(screen.stderr).toBe("");
  });

  it("같은 스레드의 눌림 뒤 time.sleep(0.01)은 그 호출 안에서 끊긴다", async () => {
    const { run, screen } = setup();
    const startedAt = performance.now();

    expect(await run("press(); time.sleep(0.01)")).toEqual(READY);

    expect(screen.stderr).toBe(CONSOLE_TRACEBACK);
    expect(performance.now() - startedAt).toBeLessThan(PRESS_LIMIT_MS);
  });
});

describe("pyodide 가정과 설치", () => {
  // attach에 시험 전용 토글이 없어(Q6) 하니스를 쓰지 않는다. 앞 시험의 `afterEach`가 매번 `time.sleep`을
  // 기본으로 되돌리므로(파일 머리의 `afterLoad` 참고) 이 시점의 상태가 곧 pyodide 원본이다.
  it("설치 전 time.sleep은 webloop의 _sleep이고 __wrapped__는 원본 C 함수다", () => {
    expect(
      pyodide.runPython(
        "import inspect, time\ninspect.isbuiltin(time.sleep.__wrapped__)",
      ),
    ).toBe(true);
    expect(pyodide.runPython("time.sleep.__code__.co_name")).toBe("_sleep");
    expect(pyodide.runPython("time.sleep.__code__.co_filename")).toMatch(
      /pyodide\/webloop\.py$/,
    );
  });

  it("설치 뒤 time.sleep은 <sleep-slice>의 래퍼이고 __wrapped__는 같은 원본 C 함수다", () => {
    setup();

    expect(
      pyodide.runPython("import time\ntime.sleep.__code__.co_filename"),
    ).toBe(SLEEP_SLICE_FILENAME);
    expect(
      pyodide.runPython("time.sleep.__wrapped__ is _default_wrapped"),
    ).toBe(true);
  });

  it("같은 pyodide에 두 번 설치해도 래퍼가 겹쌓이지 않는다", () => {
    setup();
    setup();

    expect(
      pyodide.runPython(
        "import inspect, time\ninspect.isbuiltin(time.sleep.__wrapped__)",
      ),
    ).toBe(true);
    expect(
      pyodide.runPython("time.sleep.__wrapped__ is _default_wrapped"),
    ).toBe(true);
    expect(pyodide.runPython("time.sleep.__code__.co_filename")).toBe(
      SLEEP_SLICE_FILENAME,
    );
  });
});

/**
 * 무효 인자의 예외 문구는 로컬 CPython 3.14.4로 잰 값이다(`verify/py314-sleep-messages.txt`). 조각 래퍼가 다루지
 * 않는 인자를 원본 C 함수에 그대로 넘기므로 CPython과 같아야 한다. pyodide 기본 `_sleep`은 파이썬 함수라
 * 인자 개수·키워드 오류 문구가 다르다.
 */
const PY314_MESSAGES: Record<string, string> = {
  "time.sleep(-1)": "ValueError: sleep length must be non-negative",
  "time.sleep('a')":
    "TypeError: 'str' object cannot be interpreted as an integer or float",
  "time.sleep(float('nan'))": "ValueError: Invalid value NaN (not a number)",
  "time.sleep(float('inf'))":
    "OverflowError: timestamp out of range for platform time_t",
  "time.sleep(1, 2)":
    "TypeError: time.sleep() takes exactly one argument (2 given)",
  "time.sleep(secs=1)": "TypeError: time.sleep() takes no keyword arguments",
};

describe("time.sleep 인자와 의미", () => {
  it.each(Object.entries(PY314_MESSAGES))(
    "무효 인자 %s의 마지막 줄이 CPython 3.14.4와 같다",
    async (source, expected) => {
      const { run, screen } = setup();

      expect(await run(source)).toEqual(READY);

      expect(lastLine(screen.stderr)).toBe(expected);
    },
  );

  it("time.sleep(9.3e9)는 원본의 OverflowError다", async () => {
    const { run, screen } = setup();

    expect(await run("time.sleep(9.3e9)")).toEqual(READY);

    expect(lastLine(screen.stderr)).toBe(
      "OverflowError: timestamp out of range for platform time_t",
    );
  });

  it("time.sleep(0)과 time.sleep(True)는 오류 없이 끝난다", async () => {
    const { run, screen } = setup();

    expect(await run("time.sleep(0)")).toEqual(READY);
    expect(await run("time.sleep(True)")).toEqual(READY);

    expect(screen.stderr).toBe("");
  }, 20_000);

  it("time.sleep(2**31)도 조각돼 눌림에 끊긴다", async () => {
    const runner = setup();

    const afterPressMs = await pressDuring(runner, "time.sleep(2**31)", 200);

    expect(runner.screen.stderr).toBe(CONSOLE_TRACEBACK);
    expect(afterPressMs).toBeLessThan(PRESS_LIMIT_MS);
  }, 20_000);

  it("__index__ 객체도 조각돼 눌림에 끊긴다", async () => {
    const runner = setup();
    pyodide.runPython("class I:\n    def __index__(self):\n        return 5", {
      globals: pyodide.globals,
      filename: "<test>",
    });

    const afterPressMs = await pressDuring(runner, "time.sleep(I())", 200);

    expect(runner.screen.stderr).toBe(CONSOLE_TRACEBACK);
    expect(afterPressMs).toBeLessThan(PRESS_LIMIT_MS);
  }, 20_000);
});

describe("time.sleep 조각 교체의 의미", () => {
  // 조각은 블로킹 C sleep이라 sleep 중에는 이벤트 루프가 돌지 않는다(CPython과 같다). pyodide 기본 `_sleep`은
  // JSPI가 있으면 `run_sync(asyncio.sleep(t))`라 여기서 콜백이 돌아버린다 — 이 시험이 그 차이를 고정한다.
  const SCHEDULE_SOURCE = [
    "import asyncio, time",
    "marks = []",
    "asyncio.get_event_loop().call_later(0.01, lambda: marks.append('later'))",
    "async def coro():",
    "    marks.append('task')",
    "asyncio.ensure_future(coro())",
    "time.sleep(0.1)",
    "during = ','.join(marks)",
  ].join("\n");

  it("sleep 중에는 이벤트 루프 콜백이 돌지 않고 다음 문장에서 돈다", async () => {
    const { run } = setup();

    expect(await run(execSource(SCHEDULE_SOURCE))).toEqual(READY);
    expect(pyodide.globals.get("during")).toBe("");

    // 짧은 JS 대기로 이벤트 루프에 차례를 준다. 그 뒤에는 예약한 콜백과 Task가 모두 돌아 있다.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await run(execSource("after = ','.join(sorted(marks))"))).toEqual(
      READY,
    );
    expect(pyodide.globals.get("after")).toBe("later,task");
  }, 20_000);
});

describe("time.sleep 도중 Ctrl+C의 화면", () => {
  /** `<console>` 파일명으로 정의해 이 함수의 프레임이 사용자 프레임으로 인정되게 한다. `time.sleep`은 5행이다. */
  const SLEEPER_SOURCE = `import time

def sleeper():
    started()
    time.sleep(5)
`;

  /** `KeyboardInterrupt`를 잡고 `time.sleep(0.05)`로 상한 시간 동안 도는 루프. 잡은 횟수를 돌려준다. */
  const SLEEP_CATCH_LOOP_SOURCE = `
import time

def sleep_catch_loop(limit):
    started()
    count = 0
    end = time.monotonic() + limit
    while time.monotonic() < end:
        try:
            while time.monotonic() < end:
                time.sleep(0.05)
        except KeyboardInterrupt:
            count += 1
    return count
`;

  it("함수 안 time.sleep 중 눌림의 트레이스백에 우리 프레임이 없다", async () => {
    const { run, screen, presser } = setup();
    pyodide.runPython(SLEEPER_SOURCE, {
      globals: pyodide.globals,
      filename: "<console>",
    });
    const p = presser();
    p.press({ offsets: [200] });

    expect(await run("sleeper()")).toEqual(READY);
    await p.done();

    const frames = screen.stderr
      .split("\n")
      .filter((line) => line.startsWith("  File "));
    expect(frames).toEqual([
      '  File "<console>", line 1, in <module>',
      '  File "<console>", line 5, in sleeper',
    ]);
    expect(screen.stderr).not.toContain(SLEEP_SLICE_FILENAME);
    expect(screen.stderr).not.toContain("<sigint-handler>");
    expect(screen.stderr).toMatch(/KeyboardInterrupt\n$/);
  }, 20_000);

  it("top-level await 켜짐에서도 time.sleep 중 눌림이 같은 트레이스백을 낸다", async () => {
    const runner = setup({ topLevelAwait: true });

    await pressDuring(runner, "time.sleep(5)", 200);

    expect(runner.screen.stderr).toBe(CONSOLE_TRACEBACK);
  }, 20_000);

  it("중단 뒤 다음 문장이 정상으로 돈다", async () => {
    const runner = setup();

    await pressDuring(runner, "time.sleep(5)", 200);
    runner.screen.stdout = "";
    runner.screen.stderr = "";

    expect(await runner.run("1 + 1")).toEqual(READY);
    expect(runner.screen.stdout).toBe("2\n");
    expect(runner.screen.stderr).toBe("");
  }, 20_000);

  it("try/except KeyboardInterrupt/finally가 sleep 중 눌림을 잡고 stderr는 비어 있다", async () => {
    const { run, screen, presser } = setup();
    const program = [
      "import time",
      "try:",
      "    started()",
      "    time.sleep(5)",
      "except KeyboardInterrupt:",
      "    print('caught')",
      "finally:",
      "    print('fin')",
    ].join("\n");
    const p = presser();
    p.press({ offsets: [200] });

    expect(await run(execSource(program))).toEqual(READY);
    await p.done();

    expect(screen.stdout).toBe("caught\nfin\n");
    // 폴링이 excepthook을 비우지 않으면 여기에 핸들러 프레임만 든 트레이스백이 더 찍힌다.
    expect(screen.stderr).toBe("");
  }, 20_000);

  it("KeyboardInterrupt를 잡고 sleep으로 도는 루프가 3회 눌림을 전부 잡는다", async () => {
    const { run, screen, presser } = setup();
    pyodide.runPython(SLEEP_CATCH_LOOP_SOURCE, {
      globals: pyodide.globals,
      filename: "<console>",
    });
    const p = presser();
    p.press({ offsets: [100, 200, 300] });

    expect(await run("sleep_catch_loop(1)")).toEqual(READY);

    expect(screen.stdout).toBe("3\n");
    expect(await p.done()).toMatchObject({ kind: "pressed", count: 3 });
  }, 20_000);
});

describe("설치 가드", () => {
  it("time.sleep.__wrapped__가 없으면 조각 교체를 건너뛰고 sleep-slice로 report한다", async () => {
    pyodide.runPython("import time\ndel time.sleep.__wrapped__");

    const { run, screen } = setup({ report });

    expect(report.mock.calls).toEqual([
      ["sleep-slice", "time.sleep.__wrapped__"],
    ]);
    expect(pyodide.runPython("import time\ntime.sleep is _default_sleep")).toBe(
      true,
    );
    // 조각 교체가 꺼져도 SIGINT 핸들러는 그대로 동작한다(설치가 서로 격리돼 있다).
    expect(await run(execSource(`press()\n${BUSY}`))).toEqual(READY);
    expect(screen.stderr).toMatch(/KeyboardInterrupt\n$/);
  });

  it("pyodide_js.checkInterrupt가 없으면 조각 교체를 건너뛰고 sleep-slice로 report한다", async () => {
    const original = pyodide.checkInterrupt;
    let runner: ReturnType<typeof setup>;
    Reflect.set(pyodide, "checkInterrupt", undefined);
    try {
      runner = setup({ report });
    } finally {
      Reflect.set(pyodide, "checkInterrupt", original);
    }

    expect(report.mock.calls).toEqual([
      ["sleep-slice", "pyodide_js.checkInterrupt"],
    ]);
    expect(pyodide.runPython("import time\ntime.sleep is _default_sleep")).toBe(
      true,
    );
    expect(await runner.run(execSource(`press()\n${BUSY}`))).toEqual(READY);
    expect(runner.screen.stderr).toMatch(/KeyboardInterrupt\n$/);
  });
});
