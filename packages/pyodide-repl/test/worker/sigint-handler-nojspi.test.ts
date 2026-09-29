// @vitest-environment node
/**
 * JSPI 없는 경로(구형 브라우저·Safari)의 SIGINT 핸들러·`time.sleep` 조각 시험(03-ctrl-c.md 2.4, 09-testing.md 9.1, TRAP-25).
 * - 하니스 `beforeLoad`에서 `WebAssembly.Suspending`·`promising`·`Suspender`를 지운 채 `loadPyodide()`한다.
 *   pyodide는 `"Suspending" in WebAssembly`로 JSPI 지원을 판정한다.
 * - vitest 파일 격리라 다른 파일에 영향이 없다. `afterAll`에서 원복한다.
 * - 이 경로에서 `run_sync` 대기는 사용자 스택을 정지하지 않는다(`pyodide.ffi.can_run_sync()`가 거짓).
 *   그래서 정지한 실행 깨우기(핸들러 규칙 ③)는 대상이 없다.
 * - 중단은 핸들러 규칙 ①②④만 맡는다. 스택에 사용자 프레임이 있을 때만 `KeyboardInterrupt`를 낸다.
 * - `time.sleep`은 JSPI 유무와 무관한 20ms 블로킹 조각 래퍼(`sleep-slice.py`)다. sleep 중 눌림도 조각 사이의 폴링이 끊는다.
 * - 조립은 `console-harness.ts`가 `sigint-handler.test.ts`와 공유한다.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BUSY,
  CONSOLE_TRACEBACK,
  execSource,
  pyodide,
  READY,
  slots,
  useConsoleHarness,
} from "../console-harness";
import { PS2 } from "../../src/worker/submission-runner";

// `loadPyodide` 전에 JSPI 심볼을 지워 JSPI 없는 환경을 흉내낸다(판정은 pyodide.asm.mjs의 `"Suspending" in WebAssembly`).
// Node 24는 JSPI가 기본으로 켜져 있다. 지우지 않으면 이 파일의 시험이 JSPI 있는 경로를 탄다.
type Jspi = { Suspending?: unknown; promising?: unknown; Suspender?: unknown };
const wasm = WebAssembly as unknown as Jspi;
/** 지울 JSPI 심볼 이름. */
const JSPI_NAMES = ["Suspending", "promising", "Suspender"] as const;
/** `beforeLoad`가 지운 심볼의 원래 값. `afterAll`이 되돌린다. */
const savedJspi: Partial<Record<(typeof JSPI_NAMES)[number], unknown>> = {};

/** JSPI를 끈 채 pyodide를 로드하는 공용 하니스. */
const harness = useConsoleHarness({
  beforeLoad: () => {
    for (const name of JSPI_NAMES) {
      savedJspi[name] = wasm[name];
      delete wasm[name];
    }
  },
  afterAll: () => {
    for (const name of JSPI_NAMES) {
      if (savedJspi[name] !== undefined) wasm[name] = savedJspi[name];
    }
  },
});
/** 설치 가드가 알리는 저하 지점을 받는 가짜. `report`가 불리지 않는지 보는 시험만 쓴다. */
const { report } = harness;

/** 콘솔을 조립하고 `time.sleep`을 쓸 수 있게 `import time`까지 실행한다. */
async function setup() {
  const runner = harness.setup({ report });
  expect(await runner.run("import time")).toEqual(READY);
  return runner;
}

describe("JSPI 없는 경로", () => {
  // 나머지 시험이 실제로 JSPI 없는 경로를 타는지 고정한다. JSPI가 살아 있으면 아래 시험들은 다른 경로를 본다.
  it("콘솔 실행 안 pyodide.ffi.can_run_sync()가 거짓이다", async () => {
    const runner = await setup();

    expect(await runner.run("from pyodide.ffi import can_run_sync")).toEqual(
      READY,
    );
    expect(await runner.run("print(can_run_sync())")).toEqual(READY);

    expect(runner.screen.stdout).toBe("False\n");
  });

  // 조각 래퍼는 설치 시점에 `pyodide_js.checkInterrupt`를 붙잡는다. 그래서 스파이를 setup 전에 건다(09-testing.md 9.1).
  // 설치 가드 5종(sleep-slice 2 + sigint-handler 3)은 JSPI 유무와 무관하다. 이 경로에서도 전부 통과해야 한다.
  it("설치는 저하 보고 없이 끝나고 time.sleep(0.05)는 조각 래퍼로 원본 블로킹 sleep을 끝까지 3회 폴링한다", async () => {
    const checkInterrupt = vi.spyOn(pyodide, "checkInterrupt");
    const runner = await setup();

    expect(report).not.toHaveBeenCalled();
    expect(await runner.run("time.sleep(0.05)")).toEqual(READY);

    // 0.05초를 20ms 조각으로 나누면 0.02 + 0.02 + 0.01(3조각)이라 checkInterrupt가 3회 불린다.
    expect(checkInterrupt.mock.calls.length).toBe(3);
    expect(runner.screen.stderr).toBe("");
  });

  it("바쁜 루프 중 눌림은 핸들러가 중단한다(규칙 ①②④, JSPI 무관)", async () => {
    const runner = await setup();

    expect(await runner.run(execSource(`press()\n${BUSY}`))).toEqual(READY);

    expect(runner.screen.stderr).toMatch(
      /^Traceback \(most recent call last\):\n/,
    );
    expect(runner.screen.stderr).toMatch(/KeyboardInterrupt\n$/);
  });

  // 한 줄 복합문(`while True: …`)은 빈 줄을 받아야 실행이 시작된다(09-testing.md 9.3, 3.14와 같다).
  // `waitStarted: false`로 눌림 스레드를 미리 예약해 두고, 빈 줄 제출로 실행을 시작한다.
  it("무한 루프의 time.sleep(0.02) 중 눌림 스레드 300ms는 사용자 프레임만 남은 표준 트레이스백으로 끊는다", async () => {
    const runner = await setup();
    expect((await runner.run("while True: time.sleep(0.02)")).prompt).toBe(PS2);
    const presser = runner.presser();
    presser.press({ offsets: [300], waitStarted: false });

    expect(await runner.run("")).toEqual(READY);

    expect(runner.screen.stderr).toBe(CONSOLE_TRACEBACK);
    await presser.done();
  }, 20_000);

  // JSPI가 없으면 `can_run_sync()`가 거짓이다. `asyncio.run`이 정지한 대기를 만들지 않고 즉시 동기 실행된다.
  // 깨울 정지한 실행이 없다.
  it("interruptIdle()은 깨울 것이 없어 항상 false다", async () => {
    const runner = await setup();

    expect(runner.interruptIdle()).toBe(false);

    expect(slots(runner.buffer)).toEqual([0, 0, 0, 0]);
  });
});
