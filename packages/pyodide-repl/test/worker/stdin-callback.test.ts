// @vitest-environment node
/**
 * `createStdinCallback`을 실제 pyodide(node)의 `setStdin({ stdin })`에 걸어 보는 경계 시험(09-testing.md 9.1).
 * - 주입한 `requestInput`·`wait`가 어떤 순서·인자로 불리는지 고정한다.
 * - pyodide가 돌려준 줄을 `input()`·`sys.stdin`의 다섯 읽기 경로가 어떻게 해석하는지 고정한다.
 * - `wait()`의 취소 표식·예외가 Python에 어떤 예외로 도착하는지 고정한다.
 * - 취소 변환(RD-008)과 취소·눌림 경합은 콘솔 러너 경로로 본다.
 * - 스레드·메일박스는 쓰지 않는다. 그 왕복은 core `test/protocol/thread-scenario.test.ts`가 본다.
 */
import type { PyodideInterface } from "pyodide";
import { describe, expect, test, vi } from "vitest";
import { ACK, createInterruptBuffer, SIGNAL } from "@cp949/runo-pyodide-core";
import {
  discardPendingInterrupt,
  readRequestSeq,
  signalInterrupt,
} from "@cp949/runo-pyodide-core/worker";
import {
  BUSY,
  CONSOLE_TRACEBACK,
  execSource,
  pyodide,
  READY,
  useConsoleHarness,
} from "../console-harness";
import {
  createSinkWriter,
  createStdinCallback,
} from "@cp949/runo-pyodide-core/test-utils/worker";

/**
 * 시험이 `pyodide.globals`에 만든 이름. 시험이 끝나면 지운다.
 * - 예: `runResult`의 `json`·`sys`·`result`, 콘솔 제출의 `x`·`f`.
 * - 콘솔도 같은 `__main__`을 쓴다. 남기면 "변수는 대입되지 않는다" 단언이 앞 시험의 `x`를 본다.
 * - `_`는 넣지 않는다. `globals.has`는 `builtins`까지 보므로 값 에코가 만든 `builtins._`에서 참이 된다. 그러면 `delete`가 `KeyError`를 던진다.
 */
const TEST_GLOBALS = [
  "x",
  "result",
  "line",
  "json",
  "sys",
  "contextlib",
  "guard",
  "f",
];

/**
 * 공용 하니스. 취소 변환은 콘솔 러너 경로(`setup()`)로 돌린다.
 * - SIGINT 핸들러는 스택에 `<console>` 프레임이 있을 때만 `KeyboardInterrupt`를 낸다.
 * - `runPython`(파일명 `<exec>`)에서는 취소가 버려지고 CPython이 읽기를 재시도한다.
 * - 하니스는 각본 없는 stdin을 attach에 넘긴다.
 * - 시험마다 `installStdin`이 계측 콜백으로 `setStdin`을 다시 건다. attach의 stdin을 덮는다.
 */
const { setup } = useConsoleHarness({
  // stdin 원복은 공용 해체가 한다. 프롬프트를 모은 stdout 시험의 sink만 되돌린다.
  afterEach: (pyodide) => {
    pyodide.setStdout();
    for (const name of TEST_GLOBALS) {
      if (pyodide.globals.has(name)) pyodide.globals.delete(name);
    }
  },
  afterAll: () => {
    pyodide.setStdin();
    pyodide.setStdout();
  },
});

/** `wait()` 각본 한 칸. 문자열은 한 줄, `null`은 취소 표식, `Error`는 던진다. */
type Step = string | null | Error;

/** 취소 변환에 쓸 버퍼와 잘못된 전송을 고르는 옵션. */
interface StdinOptions {
  /** 취소 변환이 SIGINT를 실제로 쓰는 버퍼(요청 번호 +1). 없으면 기록만 남긴다. */
  buffer?: Int32Array;

  /** 요청 번호를 올리지 않는 잘못된 전송 여부. 핸들러가 재전송으로 보고 버린다(TRAP-28). */
  signalWithoutSeq?: boolean;

  /** 각본 칸을 돌려주기 직전에 부르는 훅. 경합 시험이 "읽기가 열렸다"를 눌림 스레드에 알리는 데 쓴다. */
  onRead?: () => void;
}

/**
 * 각본대로 답하는 콜백을 `setStdin`에 건다.
 * - 반환값은 호출 기록이다(`"request:<cancelable>"`·`"wait"`·`"signal"`·`"check"`).
 * - 각본이 소진된 뒤의 읽기는 던진다. 기대보다 많이 읽는 코드가 EOF로 조용히 끝나지 않게 한다.
 */
function installStdin(script: Step[], options: StdinOptions = {}): string[] {
  const calls: string[] = [];
  let next = 0;
  const { buffer, signalWithoutSeq = false, onRead } = options;
  pyodide.setStdin({
    stdin: createStdinCallback({
      requestInput: (cancelable) => {
        calls.push(`request:${cancelable}`);
      },
      wait: () => {
        calls.push("wait");
        const step = script[next++];
        if (step === undefined) throw new Error("stdin 각본이 소진됐다");
        if (step instanceof Error) throw step;
        onRead?.();
        return step === null
          ? { kind: "cancelled" as const }
          : { kind: "line" as const, text: step };
      },
      signalInterrupt: () => {
        calls.push("signal");
        if (!buffer) return;
        // 잘못된 전송은 번호를 올리지 않고 SIGINT 슬롯만 쓴다.
        if (signalWithoutSeq) Atomics.store(buffer, SIGNAL, 2);
        else signalInterrupt(buffer);
      },
      checkInterrupt: () => {
        calls.push("check");
        pyodide.checkInterrupt();
      },
    }),
  });
  return calls;
}

/** Python 코드를 실행하고 그 안에서 `result`에 담은 값을 JSON으로 돌려받는다. */
function runResult(code: string): unknown {
  const json = pyodide.runPython(
    `import json, sys\n${code}\njson.dumps(result)`,
  ) as string;
  return JSON.parse(json);
}

/** `wait` 호출 수를 센다. pyodide가 콜백을 다시 부른 횟수와 같다. */
function countWaits(calls: string[]): number {
  return calls.filter((call) => call === "wait").length;
}

describe("stdin 콜백", () => {
  test("`input()`은 각본 한 줄을 그대로 돌려준다", () => {
    installStdin(["abc"]);

    expect(pyodide.runPython("input()")).toBe("abc");
  });

  test('`input("x: ")`의 프롬프트는 stdout으로 나가고 콜백에는 넘어오지 않는다', () => {
    const out: string[] = [];
    pyodide.setStdout(createSinkWriter((text) => out.push(text)));
    const calls = installStdin(["abc"]);

    const value = pyodide.runPython('input("x: ")');

    expect(value).toBe("abc");
    expect(out.join("")).toBe("x: ");
    // `requestInput`은 인자 `true`만 받고 프롬프트 문자열은 어느 호출에도 없다.
    expect(calls).toEqual(["request:true", "wait"]);
  });

  test('`sys.stdin.readline()`은 tty처럼 개행이 붙은 "abc\\n"이다', () => {
    installStdin(["a", "b"]);

    // 콜백은 개행 없이 돌려주고 pyodide가 붙인다. 콜백이 붙였다면 두 번째 줄이 빈 줄이 됐을 것이다.
    expect(
      runResult("result = [sys.stdin.readline(), sys.stdin.readline()]"),
    ).toEqual(["a\n", "b\n"]);
  });

  test("`sys.stdin.read(3)`은 한 줄 뒤 돌아온다", () => {
    const calls = installStdin(["abc"]);

    expect(runResult("result = sys.stdin.read(3)")).toBe("abc");
    expect(countWaits(calls)).toBe(1);
  });

  test('`sys.stdin.readlines(1)`은 ["abc\\n"]이다', () => {
    const calls = installStdin(["abc"]);

    expect(runResult("result = sys.stdin.readlines(1)")).toEqual(["abc\n"]);
    expect(countWaits(calls)).toBe(1);
  });

  test('`for line in sys.stdin`의 첫 줄은 "abc\\n"이고 `break`로 나온다', () => {
    const calls = installStdin(["abc"]);

    expect(
      runResult(`
for line in sys.stdin:
    result = line
    break
`),
    ).toBe("abc\n");
    expect(countWaits(calls)).toBe(1);
  });

  test("다섯 경로 모두 콜백 호출 수가 소비한 줄 수와 같다", () => {
    const calls = installStdin(["abc", "abc", "abc", "abc", "abc"]);

    // `read(3)`은 줄의 `\n`을 Python 버퍼에 남기므로 마지막에 둔다.
    // 앞에 두면 남은 `\n`이 다음 경로의 첫 줄이 된다(TRP-010).
    runResult(`
input()
sys.stdin.readline()
sys.stdin.readlines(1)
for line in sys.stdin:
    break
sys.stdin.read(3)
result = None
`);

    expect(countWaits(calls)).toBe(5);
  });

  test("요청 알림이 `wait()`보다 먼저다(읽기마다)", () => {
    // "readInput 알림 → wait()" 순서는 이 모듈이 소유한다(01-protocols.md 1.3).
    // 뒤집으면 main이 알림을 못 받은 채 worker가 정지해 교착한다.
    // 변이 검사의 검출 시험이다.
    const calls = installStdin(["a", "b"]);

    pyodide.runPython("input()\ninput()");

    expect(calls).toEqual(["request:true", "wait", "request:true", "wait"]);
  });

  test("정상 줄에서는 `signal`·`check`를 부르지 않는다", () => {
    const buffer = createInterruptBuffer();
    const calls = installStdin(["abc"], { buffer });

    expect(pyodide.runPython("input()")).toBe("abc");
    expect(calls).toEqual(["request:true", "wait"]);
    expect(Array.from(buffer)).toEqual([0, 0, 0, 0]);
  });

  test("`wait()`가 던지면 `input()`에서 `OSError`가 난다", () => {
    installStdin([new Error("main 읽기 실패")]);

    expect(
      runResult(`
try:
    input()
    result = "예외 없음"
except OSError:
    result = "oserror"
except BaseException as e:
    result = type(e).__name__
`),
    ).toBe("oserror");
  });

  test("`sys.stdin.isatty()`는 거짓이고 `input()`은 non-tty 경로다", () => {
    installStdin([]);

    expect(pyodide.runPython("import sys\nsys.stdin.isatty()")).toBe(false);
  });
});

/** `screen.stderr`에 `KeyboardInterrupt`가 몇 번 나오는지 센다. */
const countInterrupts = (stderr: string) =>
  stderr.match(/KeyboardInterrupt/g)?.length ?? 0;

describe("취소 변환(RD-008)", () => {
  test("`input()` 대기 중 취소는 호출 지점의 `KeyboardInterrupt`가 되고 변수는 대입되지 않는다", async () => {
    const { run, screen, buffer } = setup();
    const calls = installStdin([null], { buffer });

    expect(await run("x = input()")).toEqual(READY);

    expect(screen.stderr).toBe(CONSOLE_TRACEBACK);
    expect(calls).toEqual(["request:true", "wait", "signal", "check"]);
    // SIGINT는 콜백 안에서 곧바로 소비돼 잔류가 없다. ack·요청 번호는 하나씩 올랐다.
    expect(Array.from(buffer)).toEqual([0, 1, 1, 0]);

    screen.stderr = "";
    expect(await run("x")).toEqual(READY);
    expect(screen.stderr).toContain("NameError");
  });

  test("취소한 읽기를 다시 시도하지 않는다", async () => {
    const { run, buffer } = setup();
    const calls = installStdin([null, "abc"], { buffer });

    await run("x = input()");

    expect(countWaits(calls)).toBe(1);
  });

  test("`try/except KeyboardInterrupt`가 잡고 `except Exception`은 잡지 못한다", async () => {
    const { run, screen, buffer } = setup();
    installStdin([null, null], { buffer });

    await run(
      execSource(`
try:
    input()
    print("예외 없음")
except KeyboardInterrupt:
    print("caught")
`),
    );
    expect(screen.stdout).toContain("caught");
    expect(screen.stderr).toBe("");

    await run(
      execSource(`
try:
    input()
except Exception:
    print("Exception이 잡았다")
`),
    );
    expect(screen.stdout).not.toContain("Exception이 잡았다");
    expect(screen.stderr).toContain("KeyboardInterrupt");
  });

  test("`finally`와 `with`의 `__exit__`가 실행된다", async () => {
    const { run, screen, buffer } = setup();
    installStdin([null, null], { buffer });

    await run(
      execSource(`
try:
    try:
        input()
    finally:
        print("finally")
except KeyboardInterrupt:
    pass
`),
    );
    expect(screen.stdout).toContain("finally");

    await run(
      execSource(`
import contextlib

@contextlib.contextmanager
def guard():
    try:
        yield
    finally:
        print("exit")

try:
    with guard():
        input()
except KeyboardInterrupt:
    pass
`),
    );
    expect(screen.stdout).toContain("exit");
  });

  test.each([
    { path: "sys.stdin.readline()", code: "sys.stdin.readline()" },
    { path: "sys.stdin.read()", code: "sys.stdin.read()" },
    { path: "for line in sys.stdin", code: "next(iter(sys.stdin))" },
  ])("$path 취소도 같은 `KeyboardInterrupt`다", async ({ code }) => {
    const { run, screen, buffer } = setup();
    installStdin([null], { buffer });

    expect(await run(`import sys; ${code}`)).toEqual(READY);

    expect(screen.stderr).toMatch(/KeyboardInterrupt\n$/);
    expect(screen.stderr).not.toContain("EOFError");
  });

  test("함수 안에서 부른 `input()`의 취소는 그 프레임을 트레이스백에 남긴다", async () => {
    const { run, screen, buffer } = setup();
    installStdin([null], { buffer });

    await run(
      execSource(`
def f():
    return input("in f: ")

f()
`),
    );

    expect(screen.stderr).toContain("in f");
    expect(screen.stderr).toMatch(/KeyboardInterrupt\n$/);
  });

  test("요청 번호를 올리지 않은 전송은 핸들러가 재전송으로 보고 버려 읽기가 재시도된다(TRAP-28)", async () => {
    const { run, screen, buffer } = setup();
    // 실행 중 눌림 한 번을 처리시켜 핸들러의 `last_seq`를 0이 아닌 값으로 올린다.
    // 핸들러는 설치 시점의 번호를 `last_seq`로 잡는다(`install`의 `last_seq = seq()`).
    // 그래서 번호를 올리지 않은 전송은 세션의 첫 취소부터 이미 무시된다(브라우저 양성 대조 ②에서 실측).
    // 이 순서는 "번호가 실제로 전진해야 처리된다"는 성질을 0 → 1 이후 구간에서도 고정한다.
    expect(
      await run(execSource("press()\nfor _ in range(10**7): pass")),
    ).toEqual(READY);
    expect(Array.from(buffer)).toEqual([0, 1, 1, 0]);
    screen.stderr = "";
    const calls = installStdin([null, "abc"], {
      buffer,
      signalWithoutSeq: true,
    });

    expect(await run("x = input()")).toEqual(READY);

    // 버려진 SIGINT라 예외가 없다. CPython이 읽기를 다시 시도해 둘째 각본 줄이 대입된다.
    expect(screen.stderr).toBe("");
    expect(countWaits(calls)).toBe(2);
    expect(pyodide.runPython("x")).toBe("abc");
    // ack도 오르지 않는다(핸들러가 번호 확인에서 바로 돌아간다).
    expect(Atomics.load(buffer, ACK)).toBe(1);
  });

  test("`checkInterrupt()`가 SIGINT를 소비하지 않으면 EOF로 떨어지고 경고를 한 번 남긴다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { run, screen, buffer } = setup();
    // 버퍼를 떼면 `pyodide.checkInterrupt()`는 아무것도 던지지 않는다. 연결 전 콜백이 불린 상황을 만든다.
    pyodide.setInterruptBuffer(
      undefined as unknown as Parameters<
        PyodideInterface["setInterruptBuffer"]
      >[0],
    );
    installStdin([null], { buffer });

    expect(await run("x = input()")).toEqual(READY);

    expect(screen.stderr).toContain("EOFError");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("checkInterrupt");
  });

  test("취소를 20번 반복해도 매번 `KeyboardInterrupt`이고 SIGINT 잔류가 없다", async () => {
    const { run, screen, buffer } = setup();
    installStdin(
      Array.from({ length: 20 }, () => null),
      { buffer },
    );

    for (let round = 0; round < 20; round += 1) {
      screen.stderr = "";
      expect(await run("x = input()")).toEqual(READY);
      expect(screen.stderr).toBe(CONSOLE_TRACEBACK);
      expect(Atomics.load(buffer, SIGNAL)).toBe(0);
    }

    expect(Array.from(buffer)).toEqual([0, 20, 20, 0]);
  }, 30_000);
});

/**
 * 취소(worker 콜백이 쓰는 SIGINT)와 main 눌림(눌림 스레드가 쓰는 SIGINT)이 같은 버퍼에 동시에 쓰는 구간.
 * - 방어가 여럿이다: 콜백의 즉시 소비, 핸들러의 번호 확인, 루프의 `discardPendingInterrupt`.
 * - 최종 상태만 보면 어느 방어가 일했는지 가려진다(TRP-013).
 * - 그래서 구간마다 따로 단언한다.
 */
describe("취소와 눌림의 경합(RD-008)", () => {
  test.each([
    { label: "0ms 2회", presses: 2 },
    { label: "0ms 5회", presses: 5 },
  ])(
    "$label 연타가 취소와 겹쳐도 `KeyboardInterrupt`는 한 번이고 폐기 뒤 다음 제출이 산다",
    async ({ presses }) => {
      const { run, screen, buffer, markStarted, presser } = setup();
      const p = presser();

      for (let round = 0; round < 20; round += 1) {
        await p.reset();
        screen.stdout = "";
        screen.stderr = "";
        // 눌림 스레드는 읽기가 열린 순간을 기준으로 누른다. `wait()`가 취소 표식을 돌려주기 직전이다.
        installStdin([null], {
          buffer,
          onRead: () => {
            markStarted();
          },
        });
        p.press({ offsets: Array.from({ length: presses }, () => 0) });

        expect(await run("x = input()")).toEqual(READY);
        // 같은 읽기에 눌림이 몇 번 겹쳐도 `input()` 지점의 중단은 한 번이다.
        expect(countInterrupts(screen.stderr)).toBe(1);
        await p.done();

        // 0ms 눌림은 취소와 같은 읽기 안에 떨어진다. 콜백의 `checkInterrupt()`가 함께 소비한다(실측 20라운드 전부 잔류 없음).
        // 그래도 루프의 첫 방어를 그대로 거쳐 다음 제출이 깨끗한지 본다.
        // 잔류가 생기는 경우는 아래 "취소 트레이스백을 만드는 동안의 눌림도 …" 시험이 고정한다.
        discardPendingInterrupt(buffer);
        expect(Atomics.load(buffer, SIGNAL)).toBe(0);

        screen.stdout = "";
        screen.stderr = "";
        expect(await run("print(1)")).toEqual(READY);
        expect(screen.stdout).toContain("1");
        expect(screen.stderr).toBe("");
      }

      // 요청 번호는 전송마다 오른다. 라운드마다 눌림 `presses`회 + 취소 1회다.
      expect(readRequestSeq(buffer)).toBe(20 * (presses + 1));
    },
    60_000,
  );

  test("취소 트레이스백을 만드는 동안의 눌림도 트레이스백을 끝까지 내고 번호가 전부 오른다", async () => {
    const { run, screen, buffer, markStarted, presser } = setup();
    const p = presser();
    installStdin([null], {
      buffer,
      onRead: () => {
        markStarted();
      },
    });
    // 읽기가 열린 뒤 5~28.75ms에 20회 누른다. 취소의 트레이스백이 만들어지는 구간을 덮는다.
    p.press({ offsets: Array.from({ length: 20 }, (_, i) => 5 + i * 1.25) });

    expect(await run("x = input()")).toEqual(READY);
    await p.done();

    expect(screen.stderr).toContain("Traceback (most recent call last):");
    expect(screen.stderr).toMatch(/KeyboardInterrupt\n$/);
    // 요청 번호는 전송마다 오른다. 눌림 20 + 취소 1이다.
    // ack는 전송 횟수보다 작을 수 있다. 폴링이 슬롯을 비우기 전에 덮어쓴 눌림이 하나로 합쳐지기 때문이다.
    // 핸들러는 사용자 프레임이 없는 눌림을 버리고 ack한다.
    expect(readRequestSeq(buffer)).toBe(21);
    expect(Atomics.load(buffer, ACK)).toBeGreaterThanOrEqual(1);
    // 취소가 끝난 뒤 도착한 눌림은 돌고 있는 Python이 없어 소비되지 않고 슬롯에 남는다.
    // 루프의 첫 방어가 없으면 이 2가 다음 제출을 죽인다. `discardPendingInterrupt`의 존재 이유다.
    expect(Atomics.load(buffer, SIGNAL)).toBe(2);

    discardPendingInterrupt(buffer);
    screen.stderr = "";
    expect(await run("print(1)")).toEqual(READY);
    expect(screen.stderr).toBe("");
  }, 20_000);

  test("`except KeyboardInterrupt` 뒤 계산 중의 눌림은 그 계산을 끊는다", async () => {
    // `input()` 취소에 main 게이트의 방어(`cancel-settling` phase)를 걸지 않는 근거다.
    // 취소 뒤에도 사용자 코드가 계속 돈다. 그 구간의 Ctrl+C는 중단이어야 한다.
    const { run, screen, buffer, presser } = setup();
    const program = [
      "try:",
      "    input()",
      "except KeyboardInterrupt:",
      "    pass",
      "started()",
      BUSY,
    ].join("\n");
    installStdin([null, null], { buffer });

    // 대조군. 눌림이 없으면 취소를 잡은 뒤 계산이 끝까지 돈다.
    const baselineAt = performance.now();
    expect(await run(execSource(program))).toEqual(READY);
    const baseline = performance.now() - baselineAt;
    expect(screen.stderr).toBe("");

    const p = presser();
    await p.reset();
    p.press({ offsets: [30] });
    const pressedAt = performance.now();
    expect(await run(execSource(program))).toEqual(READY);
    const elapsed = performance.now() - pressedAt;
    await p.done();

    // 시간과 stderr 둘 다 본다. 한쪽만 보면 "빨리 끝났지만 중단은 아니다"를 놓친다(TRAP-26).
    expect(screen.stderr).toContain("KeyboardInterrupt");
    expect(elapsed).toBeLessThan(baseline * 0.8);
  }, 20_000);
});
