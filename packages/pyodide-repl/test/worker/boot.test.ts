// @vitest-environment node
/**
 * worker 부팅 시퀀스(`bootWorker({ driver: replDriver })`) 시험(01-protocols.md 5절 S1, 00-architecture.md 3.1·3.2).
 *
 * - 실제 `MessageChannel` 양 끝에 worker 역할(`bootWorker`)과 main 역할(`createRpc` + 기록 핸들러)을 둔다.
 * - 실제 pyodide(node)로 아래를 확인한다.
 *   - `ready` → 배너 → 각본형 `readLine` REPL 실행 순서와 종료.
 *   - 루프 안팎의 예상 밖 오류 정책(`repl 내부 오류`, `crashed`).
 *   - `compiler-flags` 저하 부팅과 `ready`의 `degraded`.
 *   - `input()`·`sys.stdin.readline()` 배선과 취소.
 *   - SIGINT 처리(실행 전 폐기, 실행 중 눌림, 감시 타이머의 깨우기·폐기).
 *   - `complete` 응답이 프롬프트 대기 중에만 실제 후보를 계산하는 것.
 *   - 루프 명령 `{ source }`의 결말 전달(RD-022a).
 * - 알림과 `readLine` 요청은 한 타임라인(`events`)에 도착 순서대로 기록한다.
 *   "출력이 다음 프롬프트 요청보다 먼저 온다"를 순서까지 고정한다.
 * - CDN 동적 import(`loadPyodideFromCdn`)는 브라우저 전용이다. npm `loadPyodide`를 주입한다.
 */
import { loadPyodide, type PyodideInterface } from "pyodide";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ACK, SIGNAL, PYODIDE_VERSION } from "@cp949/runo-pyodide-core";
import { createMainSide as createHarnessMainSide } from "@cp949/runo-pyodide-core/test-utils";
import { bootWorker, signalInterrupt } from "@cp949/runo-pyodide-core/worker";
import { replDriver } from "../../src/worker/repl-driver";

/**
 * 감시 타이머가 눌림을 깨우거나 버릴 때까지의 상한(ms).
 *
 * - 응답성이 요구 사항이라 상한 판정을 쓴다(`09-testing.md` 9.7 예외 2).
 * - 타이머 틱은 20ms(`interrupt-watch.ts`)다.
 * - 깨우지 못하면 대기 시간(`asyncio.sleep(5)`)을 다 채우거나 ack가 영영 오지 않는다. 1초면 결함과 정상을 가른다.
 * - 옛 값(200ms·100ms)은 동시 실행 부하에서 거짓 실패를 냈다.
 */
const WATCH_LIMIT_MS = 1000;

afterEach(() => {
  vi.restoreAllMocks();
});

/** `ms` 동안 기다린다. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * worker 역할이 받을 초기화 프레임과, main 역할이 받은 알림·요청 기록을 만든다.
 * 기록은 `[이름, ...인자]`이고 도착 순서대로 하니스가 남긴다.
 *
 * - `script`는 `readLine` 요청에 차례로 답할 값이다.
 *   - 항목이 함수면 그 요청이 도착한 때 호출해 반환값으로 답한다. `writer.deliver` 같은 부작용을 그 시점에 넣는 용도다.
 *   - 각본이 끝난 뒤의 요청은 오류로 답한다. 기록은 남는다.
 * - `writer`는 main 쪽 메일박스 쓰기다.
 *   - worker가 `Atomics.wait`로 정지하기 전에 `deliver`해 두면(선전달) 시험 스레드가 worker와 같은 스레드여도 멈추지 않는다.
 *   - STATE가 이미 READY면 `Atomics.wait`가 즉시 돌아온다.
 */
function scriptedMainSide(script: unknown[] = []) {
  return createHarnessMainSide({
    frame: { driver: { topLevelAwait: false } },
    extraNotifications: ["writeOutput", "writeError"],
    requests: {
      readLine: () => {
        if (script.length === 0) throw new Error("각본 밖 readLine 요청");
        const next = script.shift();
        return typeof next === "function" ? (next as () => unknown)() : next;
      },
    },
  });
}

/** 프롬프트 `readLine` 요청의 기록. 인자는 프롬프트 `>>> `, pending 없음, `cancelable`이다. */
const PROMPT_REQUEST = ["readLine", ">>> ", undefined, true];

/** 고정 버전 pyodide 부팅의 `ready` 페이로드: 저하 지점 없음, 버전 일치, `details` 없음. */
const CLEAN_READY = {
  pyodideVersion: PYODIDE_VERSION,
  versionMismatch: false,
  degraded: [],
};

/** 각본 `["1 + 1", "exit()"]`이 눌림의 영향 없이 끝났을 때의 알림·요청 타임라인. */
const CLEAN_SESSION = [
  ["ready", CLEAN_READY],
  ["writeOutput", expect.stringMatching(/^Python 3\.14\.2 \(.*[^\n]$/s)],
  PROMPT_REQUEST,
  ["writeOutput", "2"],
  PROMPT_REQUEST,
  ["sessionTerminated"],
];

describe("REPL driver 부팅", () => {
  test("배너 뒤 readLine 요청에 답하면 출력이 다음 요청보다 먼저 오고 exit()로 끝난다", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { frame, events, waitFor } = scriptedMainSide([
      "1 + 1",
      "if True:",
      "    print(1)",
      "",
      "1 +",
      "1/0",
      'print("t", end="")',
      "exit()",
    ]);

    await bootWorker(frame, {
      driver: replDriver,
      loadPyodide: () => loadPyodide(),
    });
    await waitFor(() => events.some((e) => e[0] === "sessionTerminated"));

    // 배너는 개행을 더해 보내지 않는다(TRAP-29).
    // 빈 조각(`write ""`)은 main sink가 거른다. 여기서는 알림을 그대로 기록한다.
    expect(events).toEqual([
      ["ready", CLEAN_READY],
      ["writeOutput", expect.stringMatching(/^Python 3\.14\.2 \(.*[^\n]$/s)],
      PROMPT_REQUEST,
      ["writeOutput", "2"],
      PROMPT_REQUEST,
      ["readLine", "... ", "if True:", true],
      ["readLine", "... ", "if True:\n    print(1)", true],
      ["write", "1"],
      ["write", "\n"],
      PROMPT_REQUEST,
      [
        "writeError",
        '  File "<console>", line 1\n    1 +\n       ^\nSyntaxError: invalid syntax',
      ],
      PROMPT_REQUEST,
      [
        "writeError",
        expect.stringMatching(
          /^Traceback \(most recent call last\):\n[\s\S]*ZeroDivisionError: division by zero$/,
        ),
      ],
      PROMPT_REQUEST,
      ["write", "t"],
      ["write", ""],
      PROMPT_REQUEST,
      ["sessionTerminated"],
    ]);
    const traceback = String(
      events.find(
        (e) => e[0] === "writeError" && String(e[1]).includes("ZeroDivision"),
      )?.[1],
    );
    for (const internal of ["runcode", "push", "await_fut", "__repl_run"]) {
      expect(traceback.includes(internal)).toBe(false);
    }
    expect(consoleError).not.toHaveBeenCalled();
  }, 30_000);

  test("sessionTerminated 뒤에는 readLine 요청이 더 오지 않는다", async () => {
    const { frame, events, waitFor } = scriptedMainSide(["exit()"]);

    await bootWorker(frame, {
      driver: replDriver,
      loadPyodide: () => loadPyodide(),
    });
    await waitFor(() => events.some((e) => e[0] === "sessionTerminated"));
    const count = events.length;
    await sleep(200);

    expect(events).toHaveLength(count);
    expect(events.filter((e) => e[0] === "readLine")).toHaveLength(1);
  }, 30_000);

  test("run이 예상 밖 오류를 던지면 repl 내부 오류를 알리고 콘솔을 정리한 뒤 다음 프롬프트로 계속한다", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    // 문자열이 아닌 입력은 콘솔 `push`가 `KeyboardInterrupt`가 아닌 TypeError를 던진다.
    // 러너가 삼키지 않는 오류의 실제 경로다.
    // 콘솔 buffer에 그 값이 남는다. `clearPending()`이 없으면 다음 줄도 같은 오류로 실패한다.
    const { frame, events, waitFor } = scriptedMainSide([
      42,
      "1 + 1",
      "exit()",
    ]);

    await bootWorker(frame, {
      driver: replDriver,
      loadPyodide: () => loadPyodide(),
    });
    await waitFor(() => events.some((e) => e[0] === "sessionTerminated"));

    expect(events.slice(2)).toEqual([
      PROMPT_REQUEST,
      [
        "writeError",
        expect.stringMatching(/^repl 내부 오류: [\s\S]*TypeError/),
      ],
      PROMPT_REQUEST,
      ["writeOutput", "2"],
      PROMPT_REQUEST,
      ["sessionTerminated"],
    ]);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toBe("[repl.worker] 루프 오류");
  }, 30_000);

  test("부팅 시퀀스(루프 포함)의 잡히지 않은 예외는 crashed 알림으로 나가고 이후 readLine 요청은 오지 않는다", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    // writeError 전송 자체가 실패하는 상황을 흉내 낸다(예: 알림 핸들러의 예외 재발생).
    // onError가 이 알림을 던지면 repl-loop의 run 오류 처리가 삼키지 못한다.
    // 예외는 boot의 바깥 catch로 새어 `crashed` 알림이 된다(RD-010).
    const { frame, events, waitFor } = scriptedMainSide([42, "exit()"]);
    const realPostMessage = frame.rpcPort.postMessage.bind(frame.rpcPort);
    vi.spyOn(frame.rpcPort, "postMessage").mockImplementation((message) => {
      const m = message as { kind?: string; name?: string };
      if (m.kind === "ntf" && m.name === "writeError") {
        throw new Error("포트 전송 실패");
      }
      realPostMessage(message);
    });

    await bootWorker(frame, {
      driver: replDriver,
      loadPyodide: () => loadPyodide(),
    });
    await waitFor(() => events.some((e) => e[0] === "crashed"));

    expect(events.find((e) => e[0] === "crashed")).toEqual([
      "crashed",
      { message: "Error: 포트 전송 실패" },
    ]);
    expect(events.filter((e) => e[0] === "readLine")).toHaveLength(1);
    expect(events.some((e) => e[0] === "sessionTerminated")).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      "[repl.worker] 루프 오류",
      expect.anything(),
    );
  }, 30_000);

  test("compiler-flags가 저하된 pyodide도 부팅되고 ready의 degraded에 그 식별자만 실려 REPL이 계속 동작한다", async () => {
    const { frame, events, waitFor } = scriptedMainSide(["1 + 1", "exit()"]);

    await bootWorker(frame, {
      driver: replDriver,
      loadPyodide: async () => {
        const instance = await loadPyodide();
        // `_compile.compiler.flags` 경로만 없앤다. 안쪽 컴파일러는 그대로다.
        // 새 인스턴스라 다른 시험에 새지 않는다.
        instance.runPython(
          [
            "import types",
            "import pyodide.console as pc",
            "_orig_init = pc.PyodideConsole.__init__",
            "def _init(self, *args, **kwargs):",
            "    _orig_init(self, *args, **kwargs)",
            "    inner = self._compile",
            "    class Compiler:",
            "        compiler = types.SimpleNamespace()",
            "        def __call__(self, *a, **k):",
            "            return inner(*a, **k)",
            "    self._compile = Compiler()",
            "pc.PyodideConsole.__init__ = _init",
          ].join("\n"),
        );
        return instance;
      },
    });
    await waitFor(() => events.some((e) => e[0] === "sessionTerminated"));

    expect(events[0]).toEqual([
      "ready",
      {
        pyodideVersion: PYODIDE_VERSION,
        versionMismatch: false,
        degraded: ["compiler-flags"],
      },
    ]);
    expect(events).toContainEqual(["writeOutput", "2"]);
  }, 60_000);

  test('input("x: ")과 sys.stdin.readline()은 출력 → readInput 알림 → 메일박스 값 순서로 읽고 값이 REPL 변수에 들어간다', async () => {
    const { frame, events, waitFor, writer } = scriptedMainSide([
      // 선전달: 각 줄이 `input()`을 부르기 전에 값을 메일박스에 넣어 둔다.
      // 두 번째 선전달은 첫 값이 소비된 뒤라 STATE가 IDLE이다.
      () => {
        void writer.deliver("abc");
        return 'x = input("x: ")';
      },
      "x",
      () => {
        void writer.deliver("def");
        return "import sys; y = sys.stdin.readline()";
      },
      "y",
      "exit()",
    ]);
    let setStdinSpy: ReturnType<typeof vi.spyOn<PyodideInterface, "setStdin">>;

    await bootWorker(frame, {
      driver: replDriver,
      loadPyodide: async () => {
        const instance = await loadPyodide();
        // 배선이 빠진 회귀에서 `input()`이 node의 실제 stdin을 동기로 읽으면 스레드가 막힌다.
        // `waitFor`·시험 timeout도 돌지 못해 스위트 전체가 멈춘다.
        // 기본 stdin을 즉시 오류로 바꿔 두면 `OSError`로 실패한다. 정상 부팅은 이 값을 덮어쓴다.
        instance.setStdin({ error: true });
        setStdinSpy = vi.spyOn(instance, "setStdin");
        return instance;
      },
    });
    await waitFor(() => events.some((e) => e[0] === "sessionTerminated"));

    // 각 읽기가 자기 값을 읽는다.
    // `input()`은 `'abc'`, `readline()`은 tty처럼 개행이 붙은 `'def\n'`이다(repr).
    expect(events.slice(2)).toEqual([
      PROMPT_REQUEST,
      ["write", "x: "],
      ["readInput", true],
      PROMPT_REQUEST,
      ["writeOutput", "'abc'"],
      PROMPT_REQUEST,
      ["readInput", true],
      PROMPT_REQUEST,
      ["writeOutput", "'def\\n'"],
      PROMPT_REQUEST,
      ["sessionTerminated"],
    ]);
    // 옵션은 `stdin`뿐이다. 기본 `isatty: false`·`autoEOF: true`를 그대로 쓴다(시험의 전제).
    expect(setStdinSpy!).toHaveBeenCalledTimes(1);
    expect(Object.keys(setStdinSpy!.mock.calls[0]![0]!)).toEqual(["stdin"]);
  }, 30_000);

  test("메일박스 취소 표식은 `input()` 호출 지점의 KeyboardInterrupt가 되고 다음 프롬프트로 이어진다", async () => {
    const { frame, events, waitFor, writer } = scriptedMainSide([
      // 선전달: `input()`이 정지하기 전에 취소 표식을 써 둔다(STATE가 CANCELLED면 `Atomics.wait`가 즉시 돌아온다).
      () => {
        void writer.cancel();
        return 'x = input("x: ")';
      },
      "exit()",
    ]);

    await bootWorker(frame, {
      driver: replDriver,
      loadPyodide: async () => {
        const instance = await loadPyodide();
        // 배선이 빠진 회귀에서 node의 실제 stdin을 동기로 읽으면 스위트가 멈춘다.
        // 즉시 오류로 바꿔 둔다. 정상 부팅은 이 값을 덮어쓴다.
        instance.setStdin({ error: true });
        return instance;
      },
    });
    await waitFor(() => events.some((e) => e[0] === "sessionTerminated"));

    // 순서: 프롬프트 출력 → readInput 알림 → 취소 트레이스백 → 다음 프롬프트.
    // 오류는 `KeyboardInterrupt`다. `EOFError`도 `OSError`도 아니다.
    expect(events.slice(2)).toEqual([
      PROMPT_REQUEST,
      ["write", "x: "],
      ["readInput", true],
      [
        "writeError",
        'Traceback (most recent call last):\n  File "<console>", line 1, in <module>\nKeyboardInterrupt',
      ],
      PROMPT_REQUEST,
      ["sessionTerminated"],
    ]);
    // 콜백이 쓴 SIGINT는 그 자리에서 소비됐고 ack·요청 번호가 하나씩 올랐다.
    expect([...frame.interruptBuffer]).toEqual([0, 1, 1, 0]);
  }, 30_000);

  test("readLine 응답 뒤 남은 SIGINT는 실행 전에 폐기되고 ack된다", async () => {
    const { frame, events, waitFor } = scriptedMainSide([
      // 읽는 동안 쓰인 눌림은 대상 코드가 없다(TRAP-04).
      // `readLine` 요청이 도착한 때 SIGINT를 쓰고 줄을 돌려준다.
      () => {
        signalInterrupt(frame.interruptBuffer);
        return "1 + 1";
      },
      "exit()",
    ]);

    await bootWorker(frame, {
      driver: replDriver,
      loadPyodide: () => loadPyodide(),
    });
    await waitFor(() => events.some((e) => e[0] === "sessionTerminated"));

    expect(events).toEqual(CLEAN_SESSION);
    expect([...frame.interruptBuffer]).toEqual([0, 1, 1, 0]);
  }, 30_000);

  test("readLine 응답 뒤 남은 SIGINT는 핸들러가 무시할 번호여도 실행 전에 지우고 ack한다", async () => {
    const { frame, events, waitFor } = scriptedMainSide([
      // 이미 처리한 번호의 재전송 잔여를 흉내 낸다. 요청 번호는 두고 SIGNAL만 2로 쓴다.
      // 핸들러는 같은 번호를 ack 없이 무시한다.
      // 폴링에 맡기면 ack 없이 지워져 송신기가 소실로 오판한다(TRAP-31).
      // 루프의 폐기가 지우면서 ack해야 한다.
      () => {
        Atomics.store(frame.interruptBuffer, SIGNAL, 2);
        return "1 + 1";
      },
      "exit()",
    ]);

    await bootWorker(frame, {
      driver: replDriver,
      loadPyodide: () => loadPyodide(),
    });
    await waitFor(() => events.some((e) => e[0] === "sessionTerminated"));

    expect(events).toEqual(CLEAN_SESSION);
    expect([...frame.interruptBuffer]).toEqual([0, 1, 0, 0]);
  }, 30_000);

  test("부팅한 worker에서 실행 중 눌림은 핸들러 프레임 없는 KeyboardInterrupt 트레이스백으로 끝나고 ack된다", async () => {
    const { frame, events, waitFor } = scriptedMainSide([
      // 프로그램이 스스로 눌림을 써서 같은 스레드에서 결정적으로 만든다. `sigint-handler.test.ts`와 같은 방식이다.
      'exec("press()\\nfor _ in range(10**7): pass")',
      "exit()",
    ]);

    await bootWorker(frame, {
      driver: replDriver,
      loadPyodide: async () => {
        const instance = await loadPyodide();
        instance.globals.set("press", () =>
          signalInterrupt(frame.interruptBuffer),
        );
        return instance;
      },
    });
    await waitFor(() => events.some((e) => e[0] === "sessionTerminated"));

    // `exec` 실행의 프레임은 정확히 둘이다(`<console>` + `<string>`). 핸들러 프레임은 절단돼 나오지 않는다.
    expect(events.find((e) => e[0] === "writeError")).toEqual([
      "writeError",
      expect.stringMatching(
        /^Traceback \(most recent call last\):\n {2}File "<console>", line 1, in <module>\n {2}File "<string>", line [12], in <module>\nKeyboardInterrupt$/,
      ),
    ]);
    // 핸들러가 프레임 버퍼의 요청 번호를 읽고 ack했다.
    expect([...frame.interruptBuffer]).toEqual([0, 1, 1, 0]);
  }, 30_000);

  test("정지한 실행(asyncio.run 대기) 중 눌림은 감시 타이머가 1초 안에 깨운다", async () => {
    let pressedAt: number | undefined;
    const { frame, events, waitFor } = scriptedMainSide([
      "import asyncio",
      () => {
        // 타이머가 깨운다는 것을 보이려고 main의 재전송 송신기는 쓰지 않는다. `signalInterrupt` 한 번뿐이다.
        // 100ms 뒤에 쓴다. readLine 응답 직후 루프의 `discardPendingInterrupt`(실행 전 폐기, TRAP-04)가
        // 이 눌림을 지우지 않게, 대기가 실제로 시작된 뒤의 눌림으로 만든다.
        setTimeout(() => {
          pressedAt = performance.now();
          signalInterrupt(frame.interruptBuffer);
        }, 100);
        return "asyncio.run(asyncio.sleep(5))";
      },
      "exit()",
    ]);

    await bootWorker(frame, {
      driver: replDriver,
      loadPyodide: () => loadPyodide(),
    });
    await waitFor(() => events.filter((e) => e[0] === "readLine").length >= 3);
    const elapsedMs = performance.now() - (pressedAt as number);
    await waitFor(() => events.some((e) => e[0] === "sessionTerminated"));

    expect(elapsedMs).toBeLessThan(WATCH_LIMIT_MS);
    // 우리 프레임(핸들러·run_sync 래퍼)도 webloop 프레임도 남지 않는다(03-ctrl-c.md 2.4 "깨우기 세부").
    expect(events.find((e) => e[0] === "writeError")).toEqual([
      "writeError",
      'Traceback (most recent call last):\n  File "<console>", line 1, in <module>\nKeyboardInterrupt',
    ]);
    // 깨운 쪽이 타이머든 핸들러 규칙 ③이든(둘은 경합한다) 정확히 한 번만 소비·ack된다.
    expect([...frame.interruptBuffer]).toEqual([0, 1, 1, 0]);
  }, 30_000);

  test("프롬프트가 열려 있는 동안 남은 SIGINT는 감시 타이머가 1초 안에 버리고, 다음 실행에는 새지 않는다", async () => {
    let pressedAt: number | undefined;
    let resolveNext: ((line: string) => void) | undefined;
    const { frame, events, waitFor } = scriptedMainSide([
      // readLine 요청이 도착한 시점(atPrompt=true, 아직 응답 전)에 SIGINT를 쓴다.
      // 대상 코드가 없는 낡은 눌림이라 감시 타이머가 그 틱에서 버려야 한다(03-ctrl-c.md 2.5 "프롬프트 유휴 폐기").
      () =>
        new Promise<string>((resolve) => {
          resolveNext = resolve;
          pressedAt = performance.now();
          signalInterrupt(frame.interruptBuffer);
        }),
      "exit()",
    ]);

    const booted = bootWorker(frame, {
      driver: replDriver,
      loadPyodide: () => loadPyodide(),
    });
    await waitFor(() => frame.interruptBuffer[ACK] === 1);
    const elapsedMs = performance.now() - (pressedAt as number);
    expect(elapsedMs).toBeLessThan(WATCH_LIMIT_MS);
    expect(frame.interruptBuffer[SIGNAL]).toBe(0);

    resolveNext?.("1 + 1");
    await booted;
    await waitFor(() => events.some((e) => e[0] === "sessionTerminated"));

    // 버려진 SIGINT는 다음 실행으로 새지 않는다. `writeOutput("2")`(값 에코)만 오고 `writeError`는 없다.
    expect(events.slice(2)).toEqual(CLEAN_SESSION.slice(2));
  }, 30_000);

  test("프롬프트 대기 중(atPrompt)에만 complete가 실제 후보를 계산하고, 대기 전·실행 중에는 빈 응답이다(RD-015)", async () => {
    let resolveSecondLine: ((line: string) => void) | undefined;
    const { frame, events, waitFor, rpc } = scriptedMainSide([
      "import asyncio; import os",
      () =>
        new Promise<string>((resolve) => {
          resolveSecondLine = resolve;
        }),
      "exit()",
    ]);

    void bootWorker(frame, {
      driver: replDriver,
      loadPyodide: () => loadPyodide(),
    });
    // 콘솔 생성 전(ready 전)에는 completer가 없어 빈 응답이다.
    // createRpc는 부팅 함수의 첫 await 전에 handlers를 등록한다. pyodide 로드가 끝나기 전에 온 요청도 즉시 빈 값으로 답한다.
    await expect(rpc.call("complete", "os.pa", undefined)).resolves.toEqual({
      completions: [],
      start: 0,
    });

    // 두 번째 readLine이 열려 있는 동안(atPrompt=true, 아직 응답 전)에는 실제 후보를 계산한다.
    await waitFor(() => events.filter((e) => e[0] === "readLine").length >= 2);
    const duringPrompt = await rpc.call<{
      completions: string[];
      start: number;
    }>("complete", "os.pa", undefined);
    expect(duringPrompt.completions.length).toBeGreaterThan(0);
    expect(duringPrompt.completions).toContain("os.path");

    // 실행 중(atPrompt=false)에 보낸 complete는 빈 응답이다.
    // `asyncio.sleep`이 WebLoop에 양보하므로 실행 중에도 이벤트 루프가 살아 있다. 이 요청이 처리된다(RD-009 sleep-await).
    resolveSecondLine?.("asyncio.run(asyncio.sleep(1))");
    await sleep(50);
    await expect(rpc.call("complete", "os.pa", undefined)).resolves.toEqual({
      completions: [],
      start: 0,
    });

    await waitFor(() => events.filter((e) => e[0] === "readLine").length >= 3);
    await waitFor(() => events.some((e) => e[0] === "sessionTerminated"));
  }, 30_000);
});

describe("REPL driver 부팅: 루프 명령 `{ source }`(RD-022a)", () => {
  test("`{ source }` 응답을 실행하고 결말을 다음 readLine 요청의 네 번째 인자로 싣는다", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    // `sys`를 globals에 남기지 않으려고 `__import__`를 쓴다. 다른 시험의 globals 기대를 흔들지 않는다.
    const { frame, events, waitFor } = scriptedMainSide([
      { source: "print(1)\n__import__('sys').exit(3)" },
      'print("명령")',
      { source: "1/0" },
      "exit()",
    ]);

    await bootWorker(frame, {
      driver: replDriver,
      loadPyodide: () => loadPyodide(),
    });
    await waitFor(() => events.some((e) => e[0] === "sessionTerminated"));

    // 결말은 `{ source }` 응답 바로 다음 요청에만 실린다.
    // 첫 요청과 명령 뒤 요청은 기존 3인자 그대로다.
    expect(events.filter((e) => e[0] === "readLine")).toEqual([
      PROMPT_REQUEST,
      [...PROMPT_REQUEST, { kind: "exit", code: 3 }],
      PROMPT_REQUEST,
      [
        ...PROMPT_REQUEST,
        {
          kind: "error",
          errorType: "ZeroDivisionError",
          traceback: expect.stringMatching(
            /^Traceback \(most recent call last\):\n {2}File "<console>", line 1, in <module>\nZeroDivisionError: division by zero\n$/,
          ),
        },
      ],
    ]);
    // `sys.exit(3)`은 세션을 끝내지 않았다. 종료 통지는 마지막 `exit()` 명령 뒤 한 번뿐이고 마지막 이벤트다.
    expect(events.filter((e) => e[0] === "sessionTerminated")).toHaveLength(1);
    expect(events.at(-1)).toEqual(["sessionTerminated"]);
    // 출력은 그 결말을 싣는 다음 프롬프트 요청보다 먼저 온다(확정 9의 재료).
    const firstWrite = events.findIndex(
      (e) => e[0] === "write" && e[1] === "1",
    );
    const secondRequest = events.findIndex(
      (e, i) => e[0] === "readLine" && i > firstWrite,
    );
    expect(firstWrite).toBeGreaterThan(-1);
    expect(secondRequest).toBeGreaterThan(firstWrite);
    // 실행 뒤 명령이 이어졌다.
    expect(events).toContainEqual(["write", "명령"]);
    expect(consoleError).not.toHaveBeenCalled();
  }, 30_000);
});
