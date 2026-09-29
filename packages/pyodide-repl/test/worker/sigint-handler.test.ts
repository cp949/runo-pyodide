// @vitest-environment node
/**
 * worker SIGINT 핸들러 시험(03-ctrl-c.md 2.4의 RD-007 부분, TRAP-04·TRAP-24·TRAP-31).
 * - 대상 규칙: 스택에 `<console>` 프레임이 있을 때만 `KeyboardInterrupt`, 요청 번호 확인·ack, 핸들러 프레임 절단.
 * - 이 규칙은 pyodide의 시그널 폴링·asyncio 스케줄러·`ConsoleFuture`의 트레이스백 생성에 걸친다.
 * - 실제 pyodide(node)에서만 재현되므로 mock 없이 로드한다.
 * - 같은 스레드의 눌림(`press()`)은 결정적이다.
 * - 실제 스레드 경합은 눌림 스레드 역할(core `test/roles/interrupt-presser.ts`)이 만든다.
 * - 핸들러를 먼저 설치하고 그 뒤에 버퍼를 연결한다(worker의 `attachRuntime`과 같은 순서).
 * - 연결 순서 자체는 `runtime-attach.test.ts`가 본다.
 */
import { describe, expect, it } from "vitest";
import {
  discardPendingInterrupt,
  signalInterrupt,
} from "@cp949/runo-pyodide-core/worker";
import {
  BUSY,
  CONSOLE_TRACEBACK,
  execSource,
  pyodide,
  READY,
  slots,
  useConsoleHarness,
} from "../console-harness";

const { setup } = useConsoleHarness();

/**
 * 상한 시간(`limit`초) 동안 돌며 `KeyboardInterrupt`를 잡은 횟수를 세는 함수의 소스.
 * - `<console>` 파일명으로 정의한다. 이 함수의 프레임이 사용자 프레임으로 인정된다.
 * - 눌림이 소실되면 횟수가 모자란다. 같은 눌림이 두 번 처리되면 넘친다.
 */
const CATCH_LOOP_SOURCE = `
import time

def catch_loop(limit):
    started()
    count = 0
    end = time.monotonic() + limit
    while time.monotonic() < end:
        try:
            while time.monotonic() < end:
                pass
        except KeyboardInterrupt:
            count += 1
    return count
`;

/**
 * 트레이스백을 만드는 동안(스택에 사용자 프레임이 없다)의 눌림을 만드는 훅의 소스.
 * - 첫 호출에서 눌림을 쓴다.
 * - 반복문으로 폴링이 이 함수 안에서 일어나게 한다.
 * - 그 뒤 원래 `formattraceback`(핸들러가 감싼 것)을 부른다.
 */
const TRACEBACK_HOOK_SOURCE = `
def install_hook(console, press):
    original = console.formattraceback
    fired = False

    def formattraceback(exc):
        nonlocal fired
        if not fired:
            fired = True
            press()
            for _ in range(1000):
                pass
        return original(exc)

    console.formattraceback = formattraceback
`;

describe("실행 중 SIGINT", () => {
  it("사용자 코드가 도는 중의 SIGINT는 KeyboardInterrupt 트레이스백을 내고 프롬프트로 돌아온다", async () => {
    const { run, screen, buffer } = setup();

    expect(await run(execSource(`press()\n${BUSY}`))).toEqual(READY);

    expect(screen.stderr).toMatch(/^Traceback \(most recent call last\):\n/);
    expect(screen.stderr).toMatch(/KeyboardInterrupt\n$/);
    // ack는 스택 검사·예외보다 먼저 올라 예외 경로에서도 빠지지 않는다. 슬롯은 폴링이 비웠다.
    expect(slots(buffer)).toEqual([0, 1, 1, 0]);
  });

  it("트레이스백에 핸들러의 프레임이 나오지 않는다", async () => {
    const { run, screen } = setup();

    await run(execSource(`press()\n${BUSY}`));

    expect(screen.stderr).not.toContain("<sigint-handler>");
    expect(screen.stderr).not.toContain("sigint_handler");
    // 남는 프레임은 `<console>`의 `exec(...)` 호출과 그 안에서 중단된 코드 둘뿐이다.
    // pyodide는 약 50회 평가마다 폴링한다. 눌림 뒤 첫 폴링이 `press()`가 있는 1행에 떨어질 수도 있다.
    // 폴링 위상은 앞서 실행된 코드의 양에 따라 밀린다.
    const frames = screen.stderr
      .split("\n")
      .filter((line) => line.startsWith("  File "));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toBe('  File "<console>", line 1, in <module>');
    expect(frames[1]).toMatch(/^ {2}File "<string>", line [12], in <module>$/);
  });

  it("`<console>` 한 줄 실행의 트레이스백은 소스 줄 없이 사용자 프레임 하나만 남는다", async () => {
    const { run, screen, presser } = setup();
    const p = presser();
    p.press({ offsets: [50] });

    // 복합문은 빈 줄을 받아야 실행된다.
    // 루프가 `started()`가 참인 동안만 돌아서 눌림이 소실돼도 5초 뒤에는 끝난다.
    expect(await run("while started(): pass")).toMatchObject({
      prompt: "... ",
    });
    expect(await run("")).toEqual(READY);

    expect(screen.stderr).toBe(CONSOLE_TRACEBACK);
    await p.done();
  }, 20_000);

  it("일반 예외의 트레이스백은 그대로다", async () => {
    const { run, screen } = setup();

    await run("1/0");

    expect(screen.stderr).toBe(
      'Traceback (most recent call last):\n  File "<console>", line 1, in <module>\nZeroDivisionError: division by zero\n',
    );
  });

  it("KeyboardInterrupt를 잡고 계속 도는 프로그램도 다음 SIGINT에 다시 중단된다", async () => {
    const { run, screen, buffer } = setup();
    // 첫 눌림은 `press()`도 `try` 안에 둔다. 폴링이 `press()` 호출 줄에 떨어져도 `except`가 잡아야 한다.
    const program = [
      "try:",
      "    press()",
      `    ${BUSY}`,
      "except KeyboardInterrupt:",
      "    pass",
      "press()",
      BUSY,
    ].join("\n");

    expect(await run(execSource(program))).toEqual(READY);

    expect(screen.stderr.match(/Traceback/g)).toHaveLength(1);
    expect(screen.stderr).toMatch(/KeyboardInterrupt\n$/);
    expect(slots(buffer)).toEqual([0, 2, 2, 0]);
  });

  it("top-level await 켜짐에서도 사용자 코드의 바쁜 루프를 중단한다", async () => {
    const { run, screen, buffer } = setup({ topLevelAwait: true });

    expect(await run(execSource(`press()\n${BUSY}`))).toEqual(READY);

    expect(screen.stderr).toMatch(/KeyboardInterrupt\n$/);
    expect(slots(buffer)).toEqual([0, 1, 1, 0]);
  });
});

describe("실행 중이 아닐 때의 SIGINT", () => {
  // 실행할 사용자 코드가 없을 때 쓴 SIGINT가 남으면 다음 문장의 `pyconsole.push`(컴파일)가 `KeyboardInterrupt`로 끊겨 worker가 죽었다(TRAP-04).
  // 컴파일 스택에는 `<console>` 프레임이 없어 핸들러가 버린다.
  // 첫 방어인 REPL 루프의 폐기는 `repl-loop.test.ts`가 본다.
  it.each([
    ["1+1", "2\n"],
    ["print(1)", "1\n"],
  ])(
    "남아 있던 SIGINT는 다음 문장 %s의 컴파일을 끊지 않고 버려진다",
    async (source, stdout) => {
      const { run, screen, buffer } = setup();
      signalInterrupt(buffer);

      expect(await run(source)).toEqual(READY);

      expect(screen.stdout).toBe(stdout);
      expect(screen.stderr).toBe("");
      expect(slots(buffer)).toEqual([0, 1, 1, 0]);
    },
  );

  // 트레이스백 생성 중에는 스택에 사용자 프레임이 없다.
  // 여기서 예외를 내면 트레이스백이 끊기거나 `str() failed`가 된다.
  it("트레이스백을 만드는 동안의 SIGINT는 버려져 트레이스백이 끝까지 나온다", async () => {
    const { run, screen, buffer, pyconsole } = setup();
    const namespace = pyodide.toPy({});
    try {
      pyodide.runPython(TRACEBACK_HOOK_SOURCE, {
        globals: namespace,
        filename: "<test>",
      });
      const installHook = namespace.get("install_hook");
      try {
        installHook(pyconsole, () => signalInterrupt(buffer));
      } finally {
        installHook.destroy();
      }
    } finally {
      namespace.destroy();
    }

    expect(await run("1/0")).toEqual(READY);

    expect(screen.stderr).toBe(
      'Traceback (most recent call last):\n  File "<console>", line 1, in <module>\nZeroDivisionError: division by zero\n',
    );
    // 버려진 눌림도 전달된 것이다. ack가 안 오르면 main이 소실로 오판해 다시 쓴다.
    expect(slots(buffer)).toEqual([0, 1, 1, 0]);
  });

  it("`<console>` 프레임이 없는 함수 실행 중의 SIGINT는 버리고 ack한다", () => {
    const { buffer } = setup();
    pyodide.runPython(
      "def g():\n    press()\n    for _ in range(10**6): pass\n    return 1",
      { globals: pyodide.globals, filename: "<not-console>" },
    );

    expect(pyodide.runPython("g()")).toBe(1);

    expect(slots(buffer)).toEqual([0, 1, 1, 0]);
  });
});

describe("ack와 요청 번호", () => {
  // main의 재전송은 같은 요청 번호로 SIGINT를 다시 쓴다.
  // 이미 처리한 번호가 늦게 또 도착하면 무시해야 한다.
  // 그래야 `KeyboardInterrupt`를 잡고 계속 도는 프로그램이 눌림 한 번에 두 번 중단되지 않는다.
  it("같은 요청 번호의 두 번째 도착은 무시한다", async () => {
    const { run, screen, buffer } = setup();
    const program = [
      "caught = False",
      "finished = False",
      "try:",
      "    press()",
      `    ${BUSY}`,
      "except KeyboardInterrupt:",
      "    caught = True",
      "resend()",
      BUSY,
      "finished = True",
    ].join("\n");

    expect(await run(execSource(program))).toEqual(READY);

    expect(pyodide.globals.get("caught")).toBe(true);
    expect(pyodide.globals.get("finished")).toBe(true);
    expect(screen.stderr).toBe("");
    // 무시한 도착은 ack도 올리지 않는다. 슬롯은 폴링이 비웠다.
    expect(slots(buffer)).toEqual([0, 1, 1, 0]);
  });

  it("요청 번호가 다르면 새 눌림으로 처리한다", async () => {
    const { run, buffer } = setup();
    const program = [
      "n = 0",
      "for _ in range(2):",
      "    try:",
      "        press()",
      `        ${BUSY}`,
      "    except KeyboardInterrupt:",
      "        n += 1",
    ].join("\n");

    await run(execSource(program));

    expect(pyodide.globals.get("n")).toBe(2);
    expect(slots(buffer)).toEqual([0, 2, 2, 0]);
  });

  // 세션 리셋은 새 worker에 같은 버퍼를 다시 넘긴다.
  // 새 핸들러는 이전 세션이 남긴 요청 번호를 이미 처리한 것으로 봐야 한다.
  // 그래야 이전 세션의 재전송이 새 세션을 끊지 않는다. 이후의 새 눌림은 번호가 올라 그대로 처리된다.
  // 연결 전 폐기(attach의 discard)는 남은 SIGINT를 지우며 ack를 +1한다(TRAP-31, Q5).
  // 폐기는 요청 번호를 지우지 않는다(SEQ 슬롯은 그대로 2).
  // 그래서 `resend()`로 그 번호의 재전송을 흉내내, 핸들러의 `last_seq` 스냅샷(설치 시점 `seq()`)이 2를 기억하는지 본다.
  // 폐기만으로는 이 시험이 `last_seq` 오류를 못 잡는다는 전체 브랜치 리뷰의 지적이 있었다.
  it("설치 시점의 요청 번호는 이미 처리한 것으로 보고 이후의 새 눌림은 처리한다", async () => {
    const { run, screen, buffer } = setup({
      // 요청 번호 2, SIGINT 슬롯 2(이전 세션의 재전송이 남아 있다).
      prepare: (previous) => {
        signalInterrupt(previous);
        signalInterrupt(previous);
      },
    });
    const program = [
      "caught = False",
      "resend()",
      BUSY,
      "try:",
      "    press()",
      `    ${BUSY}`,
      "except KeyboardInterrupt:",
      "    caught = True",
    ].join("\n");

    expect(await run(execSource(program))).toEqual(READY);

    expect(pyodide.globals.get("caught")).toBe(true);
    expect(screen.stderr).toBe("");
    expect(slots(buffer)).toEqual([0, 2, 3, 0]);
  });
});

// 실제 스레드가 실행 스레드와 경합해 SIGINT를 쓴다.
// 같은 스레드의 `press()`가 못 만드는 타이밍(폴링 중 쓰기, 두 슬롯의 메모리 순서)이 여기서 나온다.
// 통계(N=3000)는 `apps/demo/e2e/node/rd-007/press-loss.mjs`가 본다.
// 눌림마다 중단을 단언하는 시험은 main처럼 재전송한다(`resend: true`).
// 재전송이 없으면 pyodide 폴링의 읽기·비우기 경합(TRAP-06)으로 눌림이 드물게 소실돼 간헐 실패한다(이슈 sigint-test-isolation/09).
// 재전송은 같은 요청 번호라 핸들러가 한 번만 처리한다. 개수·ack 단언은 그대로다.
describe("눌림 스레드", () => {
  it("단일 눌림 20회 전부 KeyboardInterrupt로 끝나고 ack가 20 오른다", async () => {
    const { run, screen, buffer, presser } = setup();
    const p = presser();

    for (let round = 1; round <= 20; round++) {
      await p.reset();
      screen.stderr = "";
      p.press({ offsets: [30 + Math.random() * 20], resend: true });

      await run(execSource(`started()\n${BUSY}`));

      expect(await p.done()).toMatchObject({ kind: "pressed", count: 1 });
      expect(screen.stderr).toMatch(/KeyboardInterrupt\n$/);
      expect(buffer[1]).toBe(round);
    }
    expect(buffer[0]).toBe(0);
  }, 30_000);

  // 25ms 간격 눌림 20회를 상한 시간(1초) 동안 도는 루프가 잡는다.
  // 하나라도 소실되면 모자라고, 같은 눌림이 두 번 처리되면 넘친다.
  it("KeyboardInterrupt를 잡고 세는 루프에 25ms 간격 20회 → 정확히 20(누락·이중 0)", async () => {
    const { run, screen, buffer, presser } = setup();
    pyodide.runPython(CATCH_LOOP_SOURCE, {
      globals: pyodide.globals,
      filename: "<console>",
    });
    const p = presser();
    p.press({
      offsets: Array.from({ length: 20 }, (_, i) => 30 + 25 * i),
      resend: true,
    });

    expect(await run("catch_loop(1)")).toEqual(READY);

    expect(screen.stdout).toBe("20\n");
    expect(buffer[1]).toBe(20);
    expect(await p.done()).toMatchObject({ kind: "pressed", count: 20 });
  }, 20_000);

  // main 재전송이 같은 번호로 SIGINT를 다시 쓰는 것을 눌림 스레드 둘로 만든다.
  // 재도착은 눌림 5회 각각 5ms 뒤에 온다.
  it("눌림 20회 사이에 같은 번호의 재도착 5회가 섞여도 정확히 20", async () => {
    const { run, screen, buffer, presser } = setup();
    pyodide.runPython(CATCH_LOOP_SOURCE, {
      globals: pyodide.globals,
      filename: "<console>",
    });
    const presses = presser();
    const resends = presser();
    const pressAt = (i: number) => 30 + 25 * i;
    presses.press({
      offsets: Array.from({ length: 20 }, (_, i) => pressAt(i)),
      resend: true,
    });
    resends.press({
      offsets: [2, 5, 8, 11, 14].map((i) => pressAt(i) + 5),
      raw: true,
    });

    expect(await run("catch_loop(1)")).toEqual(READY);

    expect(screen.stdout).toBe("20\n");
    expect(buffer[1]).toBe(20);
    expect(await presses.done()).toMatchObject({ kind: "pressed", count: 20 });
    expect(await resends.done()).toMatchObject({ kind: "pressed", count: 5 });
  }, 20_000);

  // 같은 시각의 눌림 30개는 SIGINT 슬롯 하나로 합쳐진다.
  // 트레이스백은 하나이고 다음 실행이 멀쩡해야 한다(TRAP-04).
  it("top-level await 켜짐에서 0ms 간격 30회 연타 뒤에도 트레이스백 1개와 다음 실행 정상", async () => {
    const { run, screen, buffer, presser } = setup({ topLevelAwait: true });
    const p = presser();
    p.press({ offsets: Array<number>(30).fill(40) });

    expect(await run(execSource(`started()\n${BUSY}`))).toEqual(READY);
    await p.done();

    expect(screen.stderr.match(/KeyboardInterrupt/g)).toHaveLength(1);
    expect(screen.stderr).not.toContain("sigint_handler");
    // 폴링이 합친 횟수는 실행마다 달라 ack 수는 하한만 본다.
    // 남은 SIGINT는 worker 루프의 폐기를 흉내내 지운다.
    expect(buffer[1]).toBeGreaterThanOrEqual(1);
    discardPendingInterrupt(buffer);
    screen.stderr = "";
    screen.stdout = "";
    expect(await run("1+1")).toEqual(READY);
    expect(screen.stdout).toBe("2\n");
    expect(screen.stderr).toBe("");
  }, 20_000);
});
