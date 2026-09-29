// @vitest-environment node
/**
 * `createRunner` 통합 시험(실제 pyodide).
 * - worker 스레드에 `runDriver`를 올린다(`test/roles/run-worker.ts`).
 * - main 역할의 `createRunner`가 그 스레드를 `Worker`처럼 쓴다.
 * - 시험마다 새 worker 스레드와 새 `loadPyodide()`를 쓴다.
 *
 * 가짜 worker 시험(`runner.test.ts`)이 못 보는 것을 본다.
 * - 실제 stdin 메일박스 왕복: `input()` → `readInput` 알림 → `InputProvider` → 응답 → 출력.
 * - 실제 SIGINT 폴링: `while True` + `stop()`.
 * - 폴백 terminate 뒤 새 worker 부팅.
 * - 옛 worker가 살아 있을 때 재시작한 worker의 interrupt(TRP-049).
 *
 * 시간:
 * - `stop()` 폴백(`STOP_FALLBACK_MS` = 1000ms)은 제품의 실제 타이머다. 그 시험만 실시간으로 그 시간을 지난다.
 * - 판정은 이벤트(결과·상태)로 한다. ms 상한 단언은 없다(`docs/design/09-testing.md` 9.7).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { spawnWorkerLike, type WorkerLike } from "@repo/pyodide-testkit/thread";
import type { OutputChunk } from "../../src/session/driver";
import { STDIN_EOF } from "../../src/protocol/stdin-eof";
import {
  createRunner,
  type InputProvider,
  type RunnerHandle,
  type RunnerOptions,
  type RunnerStatus,
} from "../../src/session/runner";

// `runDriver`를 올리는 worker 역할 스크립트.
const RUN_WORKER_ROLE = new URL("../roles/run-worker.ts", import.meta.url);

/** 부팅·폴백 재생성이 느린 장비에서도 정지를 잡는 시험 시간 제한(판정선 아님). */
const TEST_TIMEOUT_MS = 90_000;

// 시험 중 만든 runner. `afterEach`가 dispose한다.
const runners: RunnerHandle[] = [];

beforeEach(() => {
  vi.stubGlobal("crossOriginIsolated", true);
});

afterEach(() => {
  for (const runner of runners.splice(0)) runner.dispose();
  vi.unstubAllGlobals();
});

/** `start()`가 돌려주는 시험 도구 묶음. */
interface Started {
  /** 시험 대상 runner */
  runner: RunnerHandle;

  /** `onStatus`로 받은 상태 기록 */
  statuses: RunnerStatus[];

  /** `onOutput`으로 받은 조각 기록 */
  chunks: OutputChunk[];

  /** 지금까지 나온 stdout 전체 */
  stdout(): string;

  /** 지금까지 나온 stderr 전체 */
  stderr(): string;

  /** runner가 `status`가 될 때까지 기다린다. 다른 끝 상태(`crashed`·`load-failed`)면 던진다. */
  waitStatus(status: RunnerStatus): Promise<void>;

  /** stdout에 `text`가 나올 때까지 기다린다. */
  waitOutput(text: string): Promise<void>;
}

/** 조건이 참이 될 때까지 이벤트 루프를 돌린다(벽시계 상한 없음, 시험 시간 제한이 정지를 잡는다). */
async function until(predicate: () => boolean): Promise<void> {
  while (!predicate())
    await new Promise<void>((resolve) => setImmediate(resolve));
}

/** 실제 worker 스레드로 runner를 만들고 `ready`까지 기다린다. `options`로 기본 옵션을 덮어쓴다. */
async function start(options: Partial<RunnerOptions> = {}): Promise<Started> {
  const statuses: RunnerStatus[] = [];
  const chunks: OutputChunk[] = [];
  const runner = createRunner({
    createWorker: () => spawnWorkerLike(RUN_WORKER_ROLE) as unknown as Worker,
    onOutput: (chunk) => void chunks.push(chunk),
    onStatus: (status) => void statuses.push(status),
    ...options,
  });
  runners.push(runner);
  const started: Started = {
    runner,
    statuses,
    chunks,
    stdout: () =>
      chunks
        .filter((chunk) => chunk.stream === "stdout")
        .map((chunk) => chunk.text)
        .join(""),
    stderr: () =>
      chunks
        .filter((chunk) => chunk.stream === "stderr")
        .map((chunk) => chunk.text)
        .join(""),
    // 부팅 실패·크래시면 기다리던 상태가 영영 오지 않는다. 바로 실패시킨다.
    waitStatus: (status) =>
      until(() => {
        if (runner.status === "crashed" || runner.status === "load-failed") {
          if (status !== runner.status) {
            throw new Error(`기다리던 ${status} 대신 ${runner.status}`);
          }
        }
        return runner.status === status;
      }),
    waitOutput: (text) => until(() => started.stdout().includes(text)),
  };
  await started.waitStatus("ready");
  return started;
}

describe("createRunner + 실제 pyodide", () => {
  test(
    "input()은 prompt를 provider에 넘기고 응답한 줄을 받아 이어서 실행한다",
    async () => {
      const prompts: string[] = [];
      const provider: InputProvider = async (prompt) => {
        prompts.push(prompt);
        return "홍길동";
      };
      const started = await start({ inputProvider: provider });

      const result = await started.runner.run(
        'name = input("이름: ")\nprint(f"안녕 {name}")',
      );

      expect(result).toStrictEqual({ kind: "ok" });
      expect(prompts).toEqual(["이름: "]);
      expect(started.stdout()).toContain("안녕 홍길동");
      expect(started.statuses).toEqual([
        "loading",
        "ready",
        "running",
        "waiting-input",
        "running",
        "ready",
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "while True + stop()은 KeyboardInterrupt로 끝나 interrupted 결과와 stopped를 돌려준다",
    async () => {
      const started = await start();

      const result = started.runner.run(
        'print("시작", flush=True)\nwhile True:\n    pass',
      );
      await started.waitOutput("시작");
      const stopped = await started.runner.stop();

      expect(stopped).toBe("stopped");
      const outcome = await result;
      expect(outcome.kind).toBe("interrupted");
      expect(outcome).toMatchObject({
        traceback: expect.stringContaining("KeyboardInterrupt"),
      });
      expect(started.runner.status).toBe("ready");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "input() 대기 중 stop()은 읽기를 취소해 KeyboardInterrupt로 끝나고 provider의 signal이 abort된다",
    async () => {
      let seen: AbortSignal | undefined;
      const started = await start({
        inputProvider: (_prompt, signal) => {
          seen = signal;
          return new Promise<string | null>(() => {});
        },
      });

      const result = started.runner.run('input("값: ")');
      await started.waitStatus("waiting-input");
      const stopped = await started.runner.stop();

      expect(stopped).toBe("stopped");
      expect(await result).toMatchObject({ kind: "interrupted" });
      expect(seen?.aborted).toBe(true);
      expect(started.runner.status).toBe("ready");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "KeyboardInterrupt를 삼키는 루프는 stop() 폴백으로 worker가 교체되고 run은 restarted다",
    async () => {
      const started = await start();
      const source = [
        'print("시작", flush=True)',
        "while True:",
        "    try:",
        "        while True:",
        "            pass",
        "    except KeyboardInterrupt:",
        "        pass",
      ].join("\n");

      const result = started.runner.run(source);
      await started.waitOutput("시작");
      const stopped = await started.runner.stop();

      expect(stopped).toBe("restarted");
      expect(await result).toStrictEqual({ kind: "restarted" });
      await started.waitStatus("ready");
      expect(started.statuses).toEqual([
        "loading",
        "ready",
        "running",
        "restarting",
        "ready",
      ]);
      // 새 worker는 이전 상태 없이 정상 실행한다.
      expect(await started.runner.run("print('다시')")).toStrictEqual({
        kind: "ok",
      });
      expect(started.stdout()).toContain("다시");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "reset은 worker를 교체해 이전 run의 변수가 사라진다",
    async () => {
      const started = await start();
      expect(await started.runner.run("x = 1")).toStrictEqual({ kind: "ok" });

      started.runner.reset();
      await started.waitStatus("restarting");
      await started.waitStatus("ready");
      const outcome = await started.runner.run("print(x)");

      expect(outcome).toMatchObject({ kind: "error", errorType: "NameError" });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "provider가 없으면 input()은 읽기 취소를 받는다",
    async () => {
      const started = await start();

      const outcome = await started.runner.run("input()");

      // null 응답은 메일박스 cancel이다. worker의 stdin 콜백이 그것을 KeyboardInterrupt로 바꾼다(EOFError가 아니다).
      expect(outcome).toMatchObject({ kind: "interrupted" });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "[C6] sys.stdin.read()는 provider가 순서대로 준 줄에 이어 STDIN_EOF에서 끝난다(H2)",
    async () => {
      const lines = ["a", "b"];
      const provider: InputProvider = async () =>
        lines.length > 0 ? lines.shift()! : STDIN_EOF;
      const started = await start({ inputProvider: provider });

      const outcome = await started.runner.run(
        "import sys\nprint(repr(sys.stdin.read()))",
      );

      expect(outcome).toStrictEqual({ kind: "ok" });
      expect(started.stdout()).toContain("'a\\nb\\n'");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "[C7] input()이 STDIN_EOF를 받으면 EOFError로 끝난다",
    async () => {
      const started = await start({ inputProvider: async () => STDIN_EOF });

      const outcome = await started.runner.run("input()");

      expect(outcome).toMatchObject({
        kind: "error",
        errorType: "EOFError",
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "[C8] EOFError를 잡은 뒤 같은 run에서 input()을 다시 부르면 provider가 다시 불린다(H1)",
    async () => {
      let calls = 0;
      const provider: InputProvider = async () => {
        calls += 1;
        return calls === 1 ? STDIN_EOF : "다음줄";
      };
      const started = await start({ inputProvider: provider });

      const outcome = await started.runner.run(
        [
          "try:",
          "    input()",
          "except EOFError:",
          "    print('EOF 감지', flush=True)",
          "print(input())",
        ].join("\n"),
      );

      expect(outcome).toStrictEqual({ kind: "ok" });
      expect(calls).toBe(2);
      expect(started.stdout()).toContain("EOF 감지");
      expect(started.stdout()).toContain("다음줄");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "[C8] for line in sys.stdin은 EOF에서 같은 run 안에서 정상 종료한다",
    async () => {
      const lines = ["x", "y"];
      const provider: InputProvider = async () =>
        lines.length > 0 ? lines.shift()! : STDIN_EOF;
      const started = await start({ inputProvider: provider });

      const outcome = await started.runner.run(
        [
          "import sys",
          "count = 0",
          "for line in sys.stdin:",
          "    count += 1",
          "print(count)",
        ].join("\n"),
      );

      expect(outcome).toStrictEqual({ kind: "ok" });
      expect(started.stdout()).toContain("2");
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * `terminate()` 뒤에도 살아 있는 옛 worker를 만드는 `createWorker` 공급자(브라우저 상황 재현, TRP-049).
 * - Chromium은 Python 루프처럼 스크립트가 끝나지 않는 worker의 `terminate()`를 즉시 반영하지 않는다. 최대 약 2초 뒤에 강제로 끝낸다.
 *   실측: `worker close` 이벤트가 `terminate()`로부터 약 2초 뒤에 온다(`docs/traps/TRP-049`).
 * - 그 사이 옛 worker의 SIGINT 폴링이 새 worker와 같은 눌림을 두고 경쟁하면 눌림 하나를 가로챈다. 새 worker의 첫 interrupt가 사라진다.
 * - node의 `worker.terminate()`는 즉시라 이 구간이 없다.
 * - 이 헬퍼가 만든 worker는 `terminate()`를 무시한다. 시험이 끝나면 `spawnWorkerLike`가 실제로 끝낸다.
 * - 반환한 `workers[n].fireError()`는 살아 있는 n번째 worker에 `error` 이벤트를 보낸다.
 */
function lingeringWorkers() {
  const workers: {
    frame: { interruptBuffer: Int32Array } | undefined;
    fireError(message: string): void;
  }[] = [];
  return {
    workers,
    createWorker: (): Worker => {
      const real: WorkerLike = spawnWorkerLike(RUN_WORKER_ROLE);
      const listeners = new Set<(event: { message: string }) => void>();
      const entry: (typeof workers)[number] = {
        frame: undefined,
        fireError: (message) => {
          for (const listener of [...listeners]) listener({ message });
        },
      };
      workers.push(entry);
      const worker: WorkerLike = {
        postMessage: (message, transfer) => {
          entry.frame ??= message as { interruptBuffer: Int32Array };
          real.postMessage(message, transfer);
        },
        // 옛 worker가 살아 있는 상황을 재현한다. 종료를 요청받아도 아무것도 하지 않는다.
        terminate: () => {},
        addEventListener: (type, listener) => {
          if (type === "error") listeners.add(listener);
          real.addEventListener(type, listener);
        },
        removeEventListener: (type, listener) => {
          if (type === "error") listeners.delete(listener);
          real.removeEventListener(type, listener);
        },
      };
      return worker as unknown as Worker;
    },
  };
}

/** 정지 감지용 상한(판정선이 아니다). 눌림을 잃은 실행은 끝나지 않는다. 이 시간 뒤 "정지"로 판정해 시험을 실패시킨다. */
const STALL_MS = 15_000;
const STALLED = Symbol("stalled");

/** `STALL_MS` 뒤 `STALLED`로 resolve한다. 실행 결과와 `Promise.race`로 겨룬다. */
function stall(): Promise<typeof STALLED> {
  return new Promise((resolve) => setTimeout(() => resolve(STALLED), STALL_MS));
}

// `KeyboardInterrupt`를 삼키는 실행 소스.
// 표지 `삼킨다`는 `try` 본문 안에서 찍는다(TRP-012).
// `try` 앞에서 찍으면 `stop()`의 눌림이 표지 직후·`try` 진입 전에 처리될 수 있다.
// 그러면 `KeyboardInterrupt`가 `except`를 지나쳐 실행이 끝나고, `stop()`이 폴백 없이 `"stopped"`가 된다(이슈 sigint-test-isolation/07).
// 삼킬 때마다 표지가 다시 찍힌다.
const SWALLOW_SOURCE = [
  "while True:",
  "    try:",
  '        print("삼킨다", flush=True)',
  "        while True:",
  "            pass",
  "    except KeyboardInterrupt:",
  "        pass",
].join("\n");

// 끝나지 않는 실행 소스. run마다 표지 `돈다`가 한 번 찍힌다.
const SPIN_SOURCE = 'print("돈다", flush=True)\nwhile True:\n    pass';

/** 새 run마다 `돈다`가 한 번씩 찍히므로 stdout에서 센다. */
function spinCount(started: Started): number {
  return started.stdout().split("돈다").length - 1;
}

/** `삼킨다` 표지 수. stdout이 누적되므로 이 수가 늘어야 새 run이 `try` 안에 들어간 것이다. */
function swallowCount(started: Started): number {
  return started.stdout().split("삼킨다").length - 1;
}

/** `KeyboardInterrupt`를 삼키는 루프를 `stop()`해 폴백(terminate → 새 worker)으로 재시작하고 `ready`까지 기다린다. */
async function fallbackRestart(started: Started): Promise<void> {
  const before = swallowCount(started);
  const result = started.runner.run(SWALLOW_SOURCE);
  await until(() => swallowCount(started) > before);
  expect(await started.runner.stop()).toBe("restarted");
  expect(await result).toStrictEqual({ kind: "restarted" });
  await started.waitStatus("ready");
}

/** 무한 루프를 `interrupt()`로 끝내기를 `rounds`번 반복한다. 눌림이 사라지면(가로채이면) 그 회차에서 실패한다. */
async function expectInterruptRounds(
  started: Started,
  rounds: number,
): Promise<void> {
  for (let round = 1; round <= rounds; round++) {
    const result = started.runner.run(SPIN_SOURCE);
    await until(() => spinCount(started) >= round);
    started.runner.interrupt();
    const outcome = await Promise.race([result, stall()]);
    expect(outcome, `${round}번째 interrupt() 결과`).toMatchObject({
      kind: "interrupted",
    });
  }
}

describe("재시작한 worker의 첫 interrupt(옛 worker가 종료 전까지 살아 있을 때)", () => {
  test(
    "대조: 옛 worker가 terminate()로 즉시 끝나는 환경(node)에서는 폴백 뒤 interrupt()가 원래도 먹는다",
    async () => {
      const started = await start();
      await fallbackRestart(started);

      await expectInterruptRounds(started, 5);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "stop() 폴백 뒤 새 worker의 stop()은 폴백 없이 실행을 끝낸다",
    async () => {
      const lingering = lingeringWorkers();
      const started = await start({ createWorker: lingering.createWorker });
      await fallbackRestart(started);

      for (let round = 1; round <= 4; round++) {
        const result = started.runner.run(SPIN_SOURCE);
        await until(() => spinCount(started) >= round);
        expect(await started.runner.stop(), `${round}번째 stop()`).toBe(
          "stopped",
        );
        expect(await result).toMatchObject({ kind: "interrupted" });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "stop() 폴백 뒤 새 worker의 interrupt()(Ctrl+C)는 옛 worker에 가로채이지 않는다",
    async () => {
      const lingering = lingeringWorkers();
      const started = await start({ createWorker: lingering.createWorker });
      await fallbackRestart(started);

      await expectInterruptRounds(started, 5);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "폴백을 연달아 두 번 겪어도 새 worker의 interrupt()는 옛 worker 둘에 가로채이지 않는다",
    async () => {
      const lingering = lingeringWorkers();
      const started = await start({ createWorker: lingering.createWorker });
      await fallbackRestart(started);
      await fallbackRestart(started);

      await expectInterruptRounds(started, 5);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "stop() 폴백 뒤 reset()으로 만든 worker의 interrupt()도 옛 worker에 가로채이지 않는다",
    async () => {
      const lingering = lingeringWorkers();
      const started = await start({ createWorker: lingering.createWorker });
      await fallbackRestart(started);
      started.runner.reset();
      await started.waitStatus("restarting");
      await started.waitStatus("ready");

      await expectInterruptRounds(started, 5);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "실행 중 reset()으로 만든 worker의 interrupt()는 옛 worker에 가로채이지 않는다",
    async () => {
      const lingering = lingeringWorkers();
      const started = await start({ createWorker: lingering.createWorker });
      const running = started.runner.run(SWALLOW_SOURCE);
      await started.waitOutput("삼킨다");
      started.runner.reset();
      expect(await running).toStrictEqual({ kind: "restarted" });
      await started.waitStatus("ready");

      await expectInterruptRounds(started, 5);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "크래시로 끝난 실행 뒤 reset()으로 만든 worker의 interrupt()는 살아 있던 옛 worker에 가로채이지 않는다",
    async () => {
      const lingering = lingeringWorkers();
      const started = await start({ createWorker: lingering.createWorker });
      const running = started.runner.run(SWALLOW_SOURCE);
      await started.waitOutput("삼킨다");
      // worker 스레드는 살아 있고 `error` 이벤트만 온 경우다(worker 전역 오류).
      lingering.workers[0]!.fireError("시험용 worker 오류");
      await expect(running).rejects.toMatchObject({ reason: "crashed" });
      await started.waitStatus("crashed");
      started.runner.reset();
      await started.waitStatus("ready");

      await expectInterruptRounds(started, 5);
    },
    TEST_TIMEOUT_MS,
  );
});
