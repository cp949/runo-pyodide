/**
 * `createTerminalRunner` 시험의 공용 setup(RD-031 DELTA-01). `terminal-runner-screen.test.ts`의 `setupReal`·`factory`·
 * `handles` 정리와 `terminal-runner.test.ts`가 쓰던 `statuses`·`screen`·`startInput`을 한곳에 합친다(design §3.4). 실제
 * core `createRunner` + 공용 fake worker(`@cp949/runo-pyodide-core/test-utils`)로 실행창을 만든다: 가짜 core는 이제 없다.
 * 시험 전용이며 패키지 진입점(`index.ts`·`internal.ts`)에서 import하지 않는다.
 */
import { afterEach, beforeEach, expect, vi } from "vitest";
import {
  createFakeWorkerFactory,
  type FakeWorker,
  type FakeWorkerFactory,
} from "@cp949/runo-pyodide-core/test-utils";
import type { RunnerStatus } from "@cp949/runo-pyodide-core";
import { tick } from "@repo/pyodide-testkit/async";
import {
  createFakeTerminal,
  type FakeTerminal,
  type FakeTerminalOptions,
} from "@repo/pyodide-testkit/fake-terminal";
import {
  createTerminalRunner,
  type TerminalRunnerHandle,
  type TerminalRunnerOptions,
} from "../src/terminal-runner";

export { tick };

export const factory: FakeWorkerFactory = createFakeWorkerFactory();
const handles: TerminalRunnerHandle[] = [];

beforeEach(() => {
  vi.stubGlobal("crossOriginIsolated", true);
});

afterEach(() => {
  // runner를 먼저 정리해 대기 중인 run을 `disposed`로 끝낸 뒤 worker의 rpc 포트를 닫는다.
  for (const handle of handles.splice(0)) handle.dispose();
  factory.dispose();
  factory.workers.length = 0;
  vi.unstubAllGlobals();
});

export interface SetupOptions {
  terminal?: FakeTerminalOptions;
  /** 미리 만든 가짜 터미널. `terminal` 옵션 대신 쓴다(옵션 콜백이 터미널을 봐야 할 때). */
  fake?: FakeTerminal;
  /** `false`면 `loading`인 채로 둔다(worker의 `ready`를 보내지 않는다). 기본 `true`. */
  ready?: boolean;
  runner?: Partial<TerminalRunnerOptions>;
}

export interface RealSetup {
  fake: FakeTerminal;
  /** core·벤더 Readline이 실제로 도는 실행창 핸들. `run()`은 시험이 기다리지 않아도 처리되지 않은 rejection을 남기지 않는다. */
  handle: TerminalRunnerHandle;
  /** `onStatus`로 받은 상태 이력(호출자가 `runner.onStatus`를 따로 주면 그것이 대신 쓰인다). */
  statuses: RunnerStatus[];
  /** 화면에 쓰인 원문 전체. */
  screen(): string;
  /** 이 실행창이 만든 첫(유일한) 가짜 worker. */
  worker(): FakeWorker;
  /** worker가 준비됐다(`loading` → `ready`). 대기 run이 있으면 곧바로 보내져 `running`이 되므로 둘 다 준비 완료로 본다. */
  becomeReady(): Promise<void>;
  /** 아직 끝내지 않은 가장 오래된 run 요청을 끝낸다(요청이 올 때까지 기다린다). */
  finishRun(
    outcome?: { kind: "ok" } | { kind: "exit"; code: number },
  ): Promise<void>;
  /**
   * `input()` 요청을 연다: `worker.write(prompt)`(꼬리가 프롬프트가 된다) 뒤 `worker.readInput()`을 보내고 `waiting-input`
   * (= provider 호출)까지 기다린다. 읽기가 그려졌다는 뜻은 아니다: 동기 write 터미널이면 이 시점에 그려져 있고,
   * `asyncWrite`면 호출자가 `flush`해야 그려진다. 읽기 결과는 시험이 볼 수 없다 — `worker().takeResponse()`·`peekMailbox()`로 본다.
   */
  startInput(prompt?: string): Promise<void>;
}

/** 실제 `Readline`·sink·선택 복사·core `createRunner` + 가짜 worker로 실행창을 만든다. `ready`가 기본으로 끝난 상태다. */
export async function setupReal(
  setupOptions: SetupOptions = {},
): Promise<RealSetup> {
  const fake: FakeTerminal =
    setupOptions.fake ?? createFakeTerminal(setupOptions.terminal);
  const statuses: RunnerStatus[] = [];
  // 이 호출이 만들 worker의 위치를 미리 잡아 둔다: 한 시험이 `setupReal()`을 여러 번 부르면(여러 runner) 각자 자기
  // worker만 봐야 한다(`factory.workers[0]` 고정은 두 번째 호출부터 엉뚱한 worker를 가리킨다).
  const workerIndex = factory.workers.length;
  const core = createTerminalRunner({
    terminal: fake.term,
    createWorker: factory.createWorker,
    onStatus: (status) => statuses.push(status),
    ...setupOptions.runner,
  });
  handles.push(core);
  // 시험이 기다리지 않는 `run()`의 reject(정리 때 `disposed`)가 처리되지 않은 rejection이 되지 않게 한다.
  const handle: TerminalRunnerHandle = {
    run(code) {
      const result = core.run(code);
      result.catch(() => {});
      return result;
    },
    stop: () => core.stop(),
    reset: () => core.reset(),
    clear: () => core.clear(),
    dispose: () => core.dispose(),
    get status() {
      return core.status;
    },
    setCopyOnSelect: (on) => core.setCopyOnSelect(on),
  };
  const screen = () => fake.written.join("");
  const worker = () => factory.workers[workerIndex]!;
  const becomeReady = async () => {
    worker().ready();
    await vi.waitFor(() =>
      expect(["ready", "running"]).toContain(handle.status),
    );
  };
  // `pending`은 끝낸 요청을 지우지 않는다. 끝낸 개수를 세어 다음 요청을 기다린다(마지막 항목을 보면 두 번째 run에서
  // 이미 끝낸 요청을 다시 resolve한다).
  let finishedRuns = 0;
  const finishRun = async (
    outcome: { kind: "ok" } | { kind: "exit"; code: number } = { kind: "ok" },
  ) => {
    const index = finishedRuns;
    await vi.waitFor(() =>
      expect(worker().pending.length).toBeGreaterThan(index),
    );
    finishedRuns += 1;
    worker().pending[index]!.resolve(outcome);
  };
  const startInput = async (prompt = "") => {
    // 이전 읽기가 남긴 응답이 있으면 실제 worker의 소비처럼 받아 비운다 — 그러지 않으면 이번 읽기의 `deliver`가
    // 대기에 멈춘다(가짜 worker는 실제 worker의 소비를 흉내 내지 않는다).
    if (worker().peekMailbox().kind !== "none") {
      await worker().takeResponse();
    }
    worker().write(prompt);
    worker().readInput();
    await vi.waitFor(() => expect(handle.status).toBe("waiting-input"));
  };
  if (setupOptions.ready !== false) await becomeReady();
  return {
    fake,
    handle,
    statuses,
    screen,
    worker,
    becomeReady,
    finishRun,
    startInput,
  };
}
