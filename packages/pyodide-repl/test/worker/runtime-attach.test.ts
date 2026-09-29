// @vitest-environment node
/**
 * Python 런타임 연결(`attachRuntime`) 시험(TRAP-31).
 * - 규칙 ID(A1~A6)는 `docs/design/03-ctrl-c.md` 2.6의 표를 그대로 쓴다.
 * - 실제 pyodide(node)를 mock 없이 쓴다.
 * - `setInterruptBuffer`는 원본 호출 직전에 훅만 끼워 감싼다. 폴링이 시작되는 순간을 만들기 위해서다.
 * - 감싼 뒤에도 원본을 그대로 부른다.
 */
import { describe, expect, test, vi } from "vitest";
import { ACK, SIGNAL, createInterruptBuffer } from "@cp949/runo-pyodide-core";
import { signalInterrupt } from "@cp949/runo-pyodide-core/worker";
import {
  CONSOLE_TRACEBACK,
  pyodide,
  READY,
  useConsoleHarness,
} from "../console-harness";
import { createConsole } from "../../src/worker/console";
import {
  SLEEP_SLICE_FILENAME,
  attachRuntime,
  type RuntimeAttachDeps,
} from "@cp949/runo-pyodide-core/test-utils/worker";

const harness = useConsoleHarness();

/** 폴링이 여러 번 일어나는 짧은 바쁜 루프(약 25ms). 폴링이 대기 중인 SIGINT를 읽으면 핸들러가 돈다. */
const BUSY = "for _ in range(10**6): pass";

/**
 * 각본 없는 stdin. 읽으면 던져 Python `OSError`가 된다(하니스 `setup()` 기본값과 같다).
 * 취소 표식(`null`)을 기본값으로 두지 않는다.
 * 실수로 끼운 `input()`이 `KeyboardInterrupt` 트레이스백을 내 `CONSOLE_TRACEBACK` 단언을 우연히 통과하기 때문이다.
 */
const NO_STDIN: RuntimeAttachDeps["stdin"] = {
  requestInput: () => {},
  wait: () => {
    throw new Error("runtime-attach: stdin 각본 없음");
  },
};

/** 새 콘솔·새 버퍼·각본 없는 stdin과 `attachRuntime` deps를 만든다. 연결은 시험이 직접 한다. */
function setup() {
  const { pyconsole } = createConsole(
    pyodide,
    { write: () => {}, writeErrorRaw: () => {} },
    { topLevelAwait: false },
  );
  const buffer = createInterruptBuffer();
  const { report } = harness;
  const deps: RuntimeAttachDeps = {
    interruptBuffer: buffer,
    stdin: NO_STDIN,
    report,
  };
  return { pyconsole, buffer, deps, report };
}

/** `attachRuntime`을 부르고, 연결한 버퍼와 돌려받은 proxy를 하니스 공용 해체에 맡긴다. */
function attach(
  pyconsole: ReturnType<typeof setup>["pyconsole"],
  deps: RuntimeAttachDeps,
) {
  const attached = attachRuntime(pyodide, pyconsole, deps);
  harness.track(deps.interruptBuffer, attached.interruptIdle);
  return attached;
}

/** 원본 `setInterruptBuffer`를 부르기 직전에 `hook`을 실행한다. 폴링이 시작되는 순간의 상태를 만든다. */
function beforeConnect(hook: () => void) {
  const original = pyodide.setInterruptBuffer.bind(pyodide);
  return vi
    .spyOn(pyodide, "setInterruptBuffer")
    .mockImplementation((buffer) => {
      hook();
      original(buffer);
    });
}

describe("attachRuntime", () => {
  test("[A1] 폴링이 시작될 때 SIGINT 핸들러가 이미 설치돼 있다", () => {
    const { pyconsole, deps } = setup();
    let handlerAtConnect: unknown;
    beforeConnect(() => {
      handlerAtConnect = pyodide.runPython(
        "import signal\nsignal.getsignal(signal.SIGINT).__name__",
      );
    });

    attach(pyconsole, deps);

    expect(handlerAtConnect).toBe("sigint_handler");
  });

  test("[A1] 폴링이 시작되는 순간 쓰인 눌림을 핸들러가 받아 버리고 시작 코드가 죽지 않는다", () => {
    const { pyconsole, buffer, deps } = setup();
    beforeConnect(() => signalInterrupt(buffer));

    attach(pyconsole, deps);
    // 연결 직후 도는 Python 실행이 그 눌림을 폴링으로 읽는다.
    // 사용자 프레임(`<console>`)이 없어 핸들러가 버린다.
    expect(() => pyodide.runPython(BUSY)).not.toThrow();

    expect(Atomics.load(buffer, ACK)).toBe(1);
    expect(Atomics.load(buffer, SIGNAL)).toBe(0);
  });

  test("[A3] 연결 전에 쓰인 SIGINT는 지우고 ack한다", () => {
    const { pyconsole, buffer, deps } = setup();
    signalInterrupt(buffer);

    attach(pyconsole, deps);

    // 실행 전에 슬롯을 본다. 폴링이 아니라 연결 절차가 지운 것이어야 한다. 슬롯 순서는 [SIGNAL, ACK, SEQ, 예약].
    expect([...buffer]).toEqual([0, 1, 1, 0]);
    expect(() => pyodide.runPython(BUSY)).not.toThrow();
    expect(Atomics.load(buffer, ACK)).toBe(1);
  });

  test("[A3] 연결 전에 눌림이 없으면 ack는 그대로다", () => {
    const { pyconsole, buffer, deps } = setup();

    attach(pyconsole, deps);

    expect([...buffer]).toEqual([0, 0, 0, 0]);
  });

  // 조각 교체는 핸들러보다 먼저여야 한다.
  // 래퍼의 코드 객체를 핸들러의 절단 목록에 넘겨야 트레이스백에서 우리 프레임이 잘린다.
  // 절단 결과는 아래 회귀 시험이 실제 배선으로 본다.
  test("[A2] 연결이 time.sleep 조각 교체까지 한다", () => {
    const { pyconsole, deps, report } = setup();

    attach(pyconsole, deps);

    expect(
      pyodide.runPython("import time\ntime.sleep.__code__.co_filename"),
    ).toBe(SLEEP_SLICE_FILENAME);
    expect(report).not.toHaveBeenCalled();
  });

  // `installSigintHandler`에 조각 래퍼의 코드 객체(`extraOwnCodes`)를 안 넘기면 화면에 `<sleep-slice>` 줄이 샌다.
  // `formattraceback`이 그 프레임을 우리 것으로 못 알아보기 때문이다.
  test("[A2] 연결 뒤 sleep 중 눌림의 트레이스백에 sleep-slice 프레임이 없다", async () => {
    const { run, screen, presser } = harness.setup();
    // 눌림 스레드가 Python이 sleep에 들어간 뒤(`started()`)에 쓴다.
    // 같은 스레드의 `press()`는 pyodide 폴링(약 50 바이트코드마다)이 sleep 진입 전에 소비할 수 있다.
    // 그러면 중단 지점이 흔들린다.
    const p = presser();
    p.press({ offsets: [200] });

    expect(await run("import time; started(); time.sleep(5)")).toEqual(READY);
    expect(await p.done()).toMatchObject({ kind: "pressed", count: 1 });

    expect(screen.stderr).toBe(CONSOLE_TRACEBACK);
  }, 20_000);

  test("[A1] 폐기가 버퍼 연결보다 먼저다", () => {
    const { pyconsole, buffer, deps } = setup();
    // 대상 코드가 없는 SIGINT. 연결 절차가 지우고 ack해야 한다.
    signalInterrupt(buffer);
    let ackAtConnect: number | undefined;
    beforeConnect(() => {
      ackAtConnect = Atomics.load(buffer, ACK);
    });

    attach(pyconsole, deps);

    // `setInterruptBuffer` 호출 직전에 이미 ack돼 있다. 폐기가 그 앞에서 끝났다는 뜻이다.
    // 폐기가 뒤로 가면 폴링이 시작된 뒤에야 지워져 ack 없이 SIGNAL이 비워질 위험이 생긴다(TRAP-31).
    expect(ackAtConnect).toBe(1);
  });

  test("[A1] setStdin은 버퍼 연결 뒤다", () => {
    const { pyconsole, deps } = setup();
    const setInterruptBufferSpy = vi.spyOn(pyodide, "setInterruptBuffer");
    const setStdinSpy = vi.spyOn(pyodide, "setStdin");

    attach(pyconsole, deps);

    expect(setInterruptBufferSpy.mock.invocationCallOrder[0]).toBeLessThan(
      setStdinSpy.mock.invocationCallOrder[0]!,
    );
  });

  test("[A4] stdin 취소 표식(wait가 cancelled)은 input() 호출 지점의 KeyboardInterrupt가 되고 attach가 연결한 버퍼로 전달된다", async () => {
    const requestInput = vi.fn();
    // SIGINT 핸들러는 스택에 `<console>` 프레임이 있을 때만 `KeyboardInterrupt`를 낸다.
    // 그래서 콘솔 러너 경로(하니스 `setup()`)로 돌린다. `runPython` 직접 호출로는 재현되지 않는다.
    const { run, screen } = harness.setup({
      stdin: { requestInput, wait: () => ({ kind: "cancelled" }) },
    });

    expect(await run("x = input()")).toEqual(READY);

    expect(requestInput).toHaveBeenCalledWith(true);
    expect(screen.stderr).toBe(CONSOLE_TRACEBACK);
  });

  test("[A5] 핸들러 설치 뒤 단계(버퍼 연결·stdin)가 던지면 interruptIdle을 destroy한 뒤 같은 오류를 다시 던진다", () => {
    const { pyconsole, deps } = setup();
    // 파이썬 콜러블 PyProxy는 prototype을 공유한다.
    // 2026-09-27 실측: `installSigintHandler`가 돌려주는 `interrupt_idle`과 `runPython`이 돌려주는 평범한 함수가 같은 prototype을 쓴다.
    // 이 실패 경로에서 `installSleepSlice`·`installSigintHandler`·`suppressWebLoopReraise`의 내부 `install` 함수도 각자 destroy한다.
    // 그래서 실패 시점의 호출 수를 기준으로 그 뒤 늘어난 호출 수만 본다.
    const sacrificial = pyodide.runPython("def _f(): pass\n_f") as unknown as {
      destroy(): void;
    };
    const destroySpy = vi.spyOn(Object.getPrototypeOf(sacrificial), "destroy");
    sacrificial.destroy();

    let countAtFailure = -1;
    vi.spyOn(pyodide, "setInterruptBuffer").mockImplementation(() => {
      countAtFailure = destroySpy.mock.calls.length;
      throw new Error("bad buffer");
    });

    expect(() => attachRuntime(pyodide, pyconsole, deps)).toThrow("bad buffer");

    expect(countAtFailure).toBeGreaterThanOrEqual(0);
    expect(destroySpy.mock.calls.length).toBe(countAtFailure + 1);
  });

  test("[A6] destroy()는 interruptIdle.destroy()와 같다", () => {
    const { pyconsole, deps } = setup();

    const attached = attachRuntime(pyodide, pyconsole, deps);
    const idleDestroy = vi.spyOn(attached.interruptIdle, "destroy");

    attached.destroy();

    expect(idleDestroy).toHaveBeenCalledTimes(1);
  });
});
