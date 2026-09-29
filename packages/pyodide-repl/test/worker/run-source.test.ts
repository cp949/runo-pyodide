// @vitest-environment node
/**
 * REPL `runSource` 실행기(`createSourceRunner`)의 실제 pyodide(node) 시험(RD-022a).
 * main이 열린 `readLine` RPC에 `{ source }`로 응답하면 worker 루프가 이 실행기로 코드를 REPL 콘솔에서 돌린다.
 *
 * 확인하는 것:
 * - REPL globals를 그대로 쓴다(`x = 1` 뒤 REPL 명령 `x`).
 * - 값 에코와 `_` 갱신이 없다.
 * - 트레이스백이 `<console>` 형식이다.
 * - `SystemExit`가 세션을 끝내지 않는다.
 * - SIGINT 규칙 ①(파일명 일치)과 정지한 `await` 깨우기가 평소 명령과 같이 동작한다.
 * - TLA가 콘솔 컴파일러 플래그를 따른다.
 * - `input()`이 stdin 리더를 그대로 쓴다.
 *
 * 조립(콘솔·interrupt buffer·SIGINT 핸들러·제출 러너)은 `console-harness.ts`가 맡는다.
 */
import { describe, expect, it, vi } from "vitest";
import type { RunOutcome } from "@cp949/runo-pyodide-core/worker";
import {
  BUSY,
  pyodide,
  READY,
  type SetupOptions,
  slots,
  useConsoleHarness,
} from "../console-harness";
import { runReplLoop } from "../../src/worker/repl-loop";
import {
  createSourceRunner,
  type SourceRunner,
} from "../../src/worker/run-source";
import { PS1 } from "../../src/worker/submission-runner";

/** 이 시험이 만든 실행기. 파일 `afterEach`가 치운다. */
const sources: SourceRunner[] = [];

/** 시험이 `pyodide.globals`에 만든 이름. 다음 시험으로 새지 않게 지운다. */
const TEST_GLOBALS = ["x", "y", "s", "sys", "asyncio", "value"];

/** 시험 사이의 해체를 맡는 공용 하니스. 실행기·전역 이름·`builtins._`를 치운다. */
const harness = useConsoleHarness({
  afterEach: (pyodide) => {
    for (const source of sources.splice(0)) source.destroy();
    for (const name of TEST_GLOBALS) {
      if (pyodide.globals.has(name)) pyodide.globals.delete(name);
    }
    // 값 에코가 남긴 `builtins._`를 지운다.
    pyodide.runPython(
      "import builtins\nif hasattr(builtins, '_'): del builtins._",
    );
  },
});

/** 콘솔·SIGINT 계층·제출 러너를 조립하고 같은 콘솔에 `runSource` 실행기를 붙인다. */
function setup(options?: SetupOptions) {
  const runner = harness.setup(options);
  const source = createSourceRunner(pyodide, runner.repl);
  sources.push(source);
  return { ...runner, runSource: (code: string) => source.run(code) };
}

/** `<console>` 한 줄 실행이 처리되지 않은 `ZeroDivisionError`로 끝났을 때의 정확한 트레이스백. 소스 줄이 없다. */
const ZERO_DIVISION_TRACEBACK =
  'Traceback (most recent call last):\n  File "<console>", line 1, in <module>\nZeroDivisionError: division by zero\n';

describe("runSource: REPL 콘솔 이름공간·출력", () => {
  it("코드는 REPL globals에서 실행돼 `x = 1` 뒤 REPL 명령 `x`가 1을 돌려준다", async () => {
    const { runSource, run, screen } = setup();

    expect(await runSource("x = 1\nprint(x)")).toEqual({ kind: "ok" });
    expect(screen.stdout).toBe("1\n");

    expect(await run("x")).toEqual(READY);
    expect(screen.stdout).toBe("1\n1\n");
    expect(screen.stderr).toBe("");
  });

  it("REPL에서 만든 이름도 runSource 코드가 읽는다", async () => {
    const { runSource, run, screen } = setup();
    expect(await run("y = 41")).toEqual(READY);

    expect(await runSource("print(y + 1)")).toEqual({ kind: "ok" });

    expect(screen.stdout).toBe("42\n");
  });

  it("마지막 식 값을 에코하지 않고 `_`를 바꾸지 않는다", async () => {
    const { runSource, run, screen } = setup();
    expect(await run("'sentinel'")).toEqual(READY);
    expect(screen.stdout).toBe("'sentinel'\n");

    expect(await runSource("1 + 1")).toEqual({ kind: "ok" });
    expect(screen.stdout).toBe("'sentinel'\n");

    // `_`는 REPL 값 에코가 정하는 것이라 exec 실행이 건드리지 않았다면 그대로 `'sentinel'`이다.
    expect(await run("_")).toEqual(READY);
    expect(screen.stdout).toBe("'sentinel'\n'sentinel'\n");
  });

  it("`__name__`은 REPL과 같은 `__main__`이고 코드 객체의 파일명은 `<console>`이다", async () => {
    const { runSource, screen } = setup();

    expect(
      await runSource(
        "import sys\nprint(__name__, sys._getframe().f_code.co_filename)",
      ),
    ).toEqual({ kind: "ok" });

    expect(screen.stdout).toBe("__main__ <console>\n");
  });
});

describe("runSource: 결말 분류", () => {
  it('처리되지 않은 예외는 error이고 트레이스백은 `File "<console>"` 형식이다', async () => {
    const { runSource, screen } = setup();

    const outcome = await runSource("1/0");

    expect(outcome).toEqual({
      kind: "error",
      errorType: "ZeroDivisionError",
      traceback: ZERO_DIVISION_TRACEBACK,
    });
    // 결말의 트레이스백은 stderr에도 같은 바이트로 나간다.
    expect(screen.stderr).toBe(ZERO_DIVISION_TRACEBACK);
  });

  it("여러 줄 코드의 오류는 그 줄 번호를 가리킨다", async () => {
    const { runSource } = setup();

    const outcome = await runSource("x = 1\nprint(x)\n1/0");

    expect(outcome).toMatchObject({
      kind: "error",
      errorType: "ZeroDivisionError",
    });
    expect((outcome as { traceback: string }).traceback).toContain(
      'File "<console>", line 3, in <module>',
    );
  });

  it("문법 오류는 SyntaxError 결말이다", async () => {
    const { runSource, screen } = setup();

    const outcome = await runSource("1 +");

    expect(outcome).toMatchObject({ kind: "error", errorType: "SyntaxError" });
    expect(screen.stderr).toContain("SyntaxError");
  });

  it("sys.exit(3)은 exit{ code: 3 }이고 세션은 이어져 다음 REPL 명령이 실행된다", async () => {
    const { runSource, run, screen } = setup();

    expect(await runSource("import sys\nsys.exit(3)")).toEqual({
      kind: "exit",
      code: 3,
    });
    expect(screen.stdout).toBe("");
    expect(screen.stderr).toBe("");

    // 세션 유지: 콘솔이 종료되지 않았고 다음 명령이 정상 실행된다.
    expect(await run("print('세션 유지')")).toEqual(READY);
    expect(screen.stdout).toBe("세션 유지\n");
  });

  it("sys.exit(3)은 sys.stdin 객체를 바꾸지 않는다(닫힌 경우에만 다시 연다)", async () => {
    const { runSource } = setup();
    const stdinId = () =>
      pyodide.runPython("id(__import__('sys').stdin)") as number;
    const before = stdinId();

    expect(await runSource("import sys\nsys.exit(3)")).toEqual({
      kind: "exit",
      code: 3,
    });

    expect(stdinId()).toBe(before);
  });

  it("사용자가 닫은 stdin은 exit 결말이 아니면 되살리지 않는다(평소 명령과 같다)", async () => {
    const { runSource } = setup();
    pyodide.setStdin({ stdin: () => "안녕" });

    expect(await runSource("import sys\nsys.stdin.close()")).toEqual({
      kind: "ok",
    });

    expect(await runSource("input()")).toMatchObject({
      kind: "error",
      errorType: "ValueError",
    });
  });

  it("exit()·quit() 뒤에도 sys.stdin이 살아 있어 다음 input()이 읽힌다", async () => {
    const { runSource } = setup();
    pyodide.setStdin({ stdin: () => "안녕" });

    expect(await runSource("exit()")).toEqual({ kind: "exit", code: 0 });

    expect(await runSource("value = input()")).toEqual({ kind: "ok" });
    expect(pyodide.globals.get("value")).toBe("안녕");
  });
});

describe("runSource: SIGINT·정지한 await(평소 명령 실행과 같은 경로)", () => {
  it("실행 중 SIGINT는 interrupted이고 트레이스백은 `<console>` 프레임 하나다(규칙 ① 파일명 일치)", async () => {
    const { runSource, screen, buffer } = setup();

    // 사용자 프로그램 앞줄에서 눌림을 쓰고, 횟수 상한이 있는 바쁜 루프를 돈다.
    // 눌림이 버려지면 루프가 끝나 `ok`가 나온다.
    const outcome = await runSource(`press()\n${BUSY}`);

    expect(outcome.kind).toBe("interrupted");
    const traceback = (outcome as { traceback: string }).traceback;
    // 폴링이 `press()` 줄(1)에 떨어질 수도 있다. 위상은 앞서 실행된 코드의 양에 따라 밀린다.
    expect(traceback).toMatch(
      /^Traceback \(most recent call last\):\n {2}File "<console>", line [12], in <module>\nKeyboardInterrupt\n$/,
    );
    expect(screen.stderr).toBe(traceback);
    // ack가 올랐고 슬롯은 폴링이 비웠다.
    expect(slots(buffer)).toEqual([0, 1, 1, 0]);
  });

  it("실행 중 SIGINT 뒤에도 세션이 이어져 다음 REPL 명령이 실행된다", async () => {
    const { runSource, run, screen } = setup();

    expect((await runSource(`press()\n${BUSY}`)).kind).toBe("interrupted");

    expect(await run("print('계속')")).toEqual(READY);
    expect(screen.stdout).toBe("계속\n");
  });

  it("정지한 await를 깨워 끝낸 중단도 interrupted이다(IdleInterrupt)", async () => {
    const { runSource, wakeAfter } = setup({ topLevelAwait: true });
    expect(await runSource("import asyncio")).toEqual({ kind: "ok" });

    const startedAt = performance.now();
    const wake = wakeAfter(100);
    const outcome = await runSource("await asyncio.sleep(5)");
    const elapsedMs = performance.now() - startedAt;
    await wake;

    // top-level await 대기의 중단 화면은 3.14 `python -m asyncio`처럼 트레이스백 없이 한 줄이다.
    expect(outcome).toEqual({
      kind: "interrupted",
      traceback: "KeyboardInterrupt\n",
    });
    // 깨우지 못하면 대기 시간(5초)을 다 채운다. 응답성 상한이다(09-testing.md 9.7 예외 2).
    expect(elapsedMs).toBeLessThan(1100);
  });
});

describe("runSource: top-level await는 콘솔 컴파일러 플래그를 따른다", () => {
  it("켬이면 최상위 `await asyncio.sleep(0)`이 ok이다", async () => {
    const { runSource } = setup({ topLevelAwait: true });
    expect(await runSource("import asyncio")).toEqual({ kind: "ok" });

    expect(await runSource("await asyncio.sleep(0)")).toEqual({ kind: "ok" });
  });

  it("끔이면 같은 코드가 SyntaxError 결말이다", async () => {
    const { runSource } = setup({ topLevelAwait: false });
    expect(await runSource("import asyncio")).toEqual({ kind: "ok" });

    const outcome = await runSource("await asyncio.sleep(0)");

    expect(outcome).toMatchObject({ kind: "error", errorType: "SyntaxError" });
  });
});

describe("runSource: stdin", () => {
  it("input()은 pyodide stdin 리더를 그대로 읽고 sys.stdin 객체를 바꾸지 않는다", async () => {
    const stdin = vi.fn(() => "입력 줄");
    const { runSource, screen } = setup();
    // attach가 기본 stdin을 이미 걸었다. 각본이 없어 읽으면 던지는 stub이다.
    // 이 시험은 그 뒤에 실제 stdin을 다시 걸어 덮는다. `stdin-callback.test.ts`의 `installStdin`과 같은 방식이다.
    pyodide.setStdin({ stdin });
    const before = pyodide.runPython("id(__import__('sys').stdin)") as number;

    expect(await runSource("print(input())")).toEqual({ kind: "ok" });

    expect(screen.stdout).toBe("입력 줄\n");
    expect(stdin).toHaveBeenCalledTimes(1);
    expect(pyodide.runPython("id(__import__('sys').stdin)")).toBe(before);
  });
});

describe("createSourceRunner.destroy", () => {
  it("두 번 불러도 던지지 않는다", () => {
    const { repl } = setup();
    const source = createSourceRunner(pyodide, repl);

    source.destroy();

    expect(() => source.destroy()).not.toThrow();
  });

  it("destroy 뒤에는 Python 함수 proxy가 놓여 run이 실패한다(누수 없이 놓았다)", async () => {
    const { repl } = setup();
    const source = createSourceRunner(pyodide, repl);

    source.destroy();

    await expect(source.run("1")).rejects.toThrow();
  });
});

describe("runReplLoop 통합: `{ source }` 응답을 실제 실행기로 돌린다", () => {
  it("결말이 다음 요청에 실려 가고 exit 결말 뒤에도 세션이 이어진다", async () => {
    const { runSource, run } = setup();
    const replies: (string | { source: string })[] = [
      { source: "import sys\nsys.exit(3)" },
      "print('명령')",
      { source: "1/0" },
      "exit()",
    ];
    const requests: [string, string | undefined, RunOutcome | undefined][] = [];
    const onTerminated = vi.fn();

    await runReplLoop({
      readLine: async (prompt, pending, outcome) => {
        requests.push([prompt, pending, outcome]);
        return replies.shift() ?? null;
      },
      setAtPrompt: vi.fn(),
      discardPendingInterrupt: vi.fn(),
      run,
      runSource,
      onTerminated,
      onError: vi.fn(),
    });

    expect(requests).toEqual([
      [PS1, undefined, undefined],
      [PS1, undefined, { kind: "exit", code: 3 }],
      [PS1, undefined, undefined],
      [
        PS1,
        undefined,
        {
          kind: "error",
          errorType: "ZeroDivisionError",
          traceback: ZERO_DIVISION_TRACEBACK,
        },
      ],
    ]);
    // 종료 통지는 마지막 `exit()` 명령에서 한 번뿐이다. runSource의 `SystemExit`는 세션을 끝내지 않는다.
    expect(onTerminated).toHaveBeenCalledTimes(1);
  });
});
