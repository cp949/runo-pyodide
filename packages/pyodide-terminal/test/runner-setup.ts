/**
 * `createTerminalRunner` 시험의 공용 setup(RD-031).
 * - 구성: 실제 core `createRunner` + 공용 fake worker(`@cp949/runo-pyodide-core/test-utils`).
 * - 제공: `setupReal`·`factory`, worker 정리 hook, `statuses`·`screen`·`startInput` 도우미.
 * - 사용처: `terminal-runner.test.ts`, `terminal-runner-screen.test.ts`.
 * - hook: `beforeEach`·`afterEach`를 import 시점에 등록한다. 전역 stub과 runner 정리를 맡는다.
 * - 시험 전용이다. 패키지 진입점(`index.ts`·`internal.ts`)에서 import하지 않는다.
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

/** `setupReal`의 옵션. */
export interface SetupOptions {
  /** 가짜 터미널 생성 옵션. `fake`를 주면 무시한다. */
  terminal?: FakeTerminalOptions;

  /** 미리 만든 가짜 터미널. 옵션 콜백이 터미널을 봐야 할 때 `terminal` 대신 쓴다. */
  fake?: FakeTerminal;

  /** `false`면 `loading` 상태로 둔다(worker에 `ready`를 보내지 않는다). 기본 `true`. */
  ready?: boolean;

  /** `createTerminalRunner`에 덮어쓸 옵션. */
  runner?: Partial<TerminalRunnerOptions>;
}

/** `setupReal`이 돌려주는 실행창과 조작 도구. */
export interface RealSetup {
  /** 실행창이 붙은 가짜 터미널 */
  fake: FakeTerminal;

  /** core·벤더 Readline이 실제로 도는 실행창 핸들. 시험이 `run()`을 기다리지 않아도 처리되지 않은 rejection이 남지 않는다. */
  handle: TerminalRunnerHandle;

  /** `onStatus`로 받은 상태 이력. `runner.onStatus`를 따로 주면 비어 있다. */
  statuses: RunnerStatus[];

  /** 화면에 쓰인 원문 전체 */
  screen(): string;

  /** 이 실행창이 만든 가짜 worker */
  worker(): FakeWorker;

  /**
   * worker를 준비시킨다(`loading` → `ready`).
   * 대기 중인 run이 있으면 곧바로 보내져 `running`이 된다. 둘 다 준비 완료로 본다.
   */
  becomeReady(): Promise<void>;

  /** 아직 끝내지 않은 가장 오래된 run 요청을 끝낸다. 요청이 올 때까지 기다린다. */
  finishRun(
    outcome?: { kind: "ok" } | { kind: "exit"; code: number },
  ): Promise<void>;

  /**
   * `input()` 요청을 열고 `waiting-input`(= provider 호출)까지 기다린다.
   * - 순서: `worker.write(prompt)`(꼬리가 프롬프트가 된다) 뒤 `worker.readInput()`.
   * - 읽기가 화면에 그려졌다는 뜻은 아니다. 동기 write 터미널은 이 시점에 그려져 있다.
   * - `asyncWrite` 터미널은 호출자가 `flush`해야 그려진다.
   * - 읽기 결과는 `worker().takeResponse()`·`peekMailbox()`로 본다.
   */
  startInput(prompt?: string): Promise<void>;
}

/**
 * 실제 `Readline`·sink·선택 복사·core `createRunner`에 가짜 worker를 붙여 실행창을 만든다.
 * 기본으로 `ready`까지 끝낸 상태로 돌려준다.
 */
export async function setupReal(
  setupOptions: SetupOptions = {},
): Promise<RealSetup> {
  const fake: FakeTerminal =
    setupOptions.fake ?? createFakeTerminal(setupOptions.terminal);
  const statuses: RunnerStatus[] = [];
  // 이 호출이 만들 worker의 위치를 미리 잡아 둔다.
  // 한 시험이 `setupReal()`을 여러 번 부르면 runner마다 자기 worker만 봐야 한다.
  // `factory.workers[0]`으로 고정하면 두 번째 호출부터 엉뚱한 worker를 가리킨다.
  const workerIndex = factory.workers.length;
  const core = createTerminalRunner({
    terminal: fake.term,
    createWorker: factory.createWorker,
    onStatus: (status) => statuses.push(status),
    ...setupOptions.runner,
  });
  handles.push(core);
  // 시험이 기다리지 않는 `run()`의 reject(정리 때 `disposed`)를 처리되지 않은 rejection으로 남기지 않는다.
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
  // `pending`은 끝낸 요청을 지우지 않는다. 끝낸 개수를 세어 다음 요청을 기다린다.
  // 마지막 항목을 보면 두 번째 run에서 이미 끝낸 요청을 다시 resolve한다.
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
    // 이전 읽기가 남긴 응답이 있으면 실제 worker가 소비하듯 받아 비운다.
    // 비우지 않으면 이번 읽기의 `deliver`가 대기에서 멈춘다. 가짜 worker는 소비를 흉내 내지 않는다.
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
