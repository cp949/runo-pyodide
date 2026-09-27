/**
 * `runSource(code)`의 실행 슬롯(RD-022a, 확정 6·9). 핸들이 하나 소유하고 세션(worker)을 넘어 산다: 대기 중인 코드는 `reset()`을
 * 넘겨 새 worker의 첫 `>>> `에서 실행되기 때문이다. main driver는 세션마다 새로 만들어지므로 슬롯과는 `SourceLink`(좁은 창구)로만
 * 만난다. 코어 `createRunner`의 `active` 슬롯과 같은 역할이다(대기 중에도 슬롯을 차지한다).
 *
 * 단계:
 *
 * | phase     | 뜻                                                                                  |
 * | --------- | ------------------------------------------------------------------------------------ |
 * | waiting   | 첫 `>>> ` 요청 전(`loading`). worker에 아직 보내지 않았다.                              |
 * | sent      | `{ source }` 응답을 보냈다. worker가 실행 중이거나 결말을 싣고 돌아오는 중이다.           |
 * | settling  | 결말이 도착했다. 보존한 줄로 다음 `>>> ` 읽기가 화면에 그려지면 resolve한다(확정 9).      |
 */
import {
  RunRejectedError,
  type RunRejectedReason,
  type RunResult,
} from "@cp949/runo-pyodide-core";
import type { ReadLineOutcome } from "./repl-protocol";

export type SourcePhase = "waiting" | "sent" | "settling";

/** 세션이 슬롯을 끝내는 사건. `restarted`는 `reset()`, 나머지는 거부 사유다. */
export type SourceEnd = "restarted" | RunRejectedReason;

/** 슬롯을 차지한 실행 하나. */
export interface SourceRun {
  readonly code: string;
  phase: SourcePhase;
  /** `settling`에서만 있다. */
  outcome?: ReadLineOutcome;
  resolve(result: RunResult): void;
  reject(error: unknown): void;
}

/** 거부 사유별 오류 문구. */
const END_MESSAGES: Record<RunRejectedReason, string> = {
  busy: "이미 실행 중이다",
  unavailable: "실행할 수 없는 상태다",
  disposed: "dispose된 REPL이다",
  crashed: "worker가 크래시해 실행을 끝냈다",
};

export function rejection(reason: RunRejectedReason): RunRejectedError {
  return new RunRejectedError(reason, END_MESSAGES[reason]);
}

/**
 * 슬롯에서 뗀 실행을 사건에 맞게 끝낸다. 결말이 이미 도착했으면(`settling`) 코드는 실행을 마쳤으므로 사건과 무관하게 그 결말로
 * resolve한다. 그 밖에는 `restarted`는 `{ kind: "restarted" }`로 resolve하고 나머지는 `RunRejectedError`로 reject한다.
 */
export function endRun(run: SourceRun, event: SourceEnd): void {
  if (run.phase === "settling" && run.outcome !== undefined) {
    run.resolve(run.outcome);
  } else if (event === "restarted") {
    run.resolve({ kind: "restarted" });
  } else {
    run.reject(rejection(event));
  }
}

/** main driver가 슬롯과 만나는 창구(세션이 소유한 driver가 부른다). */
export interface SourceLink {
  /** 대기 중인 코드가 있으면 `sent`로 바꾸고 코드를 돌려준다. 첫 `>>> ` 요청이 온 순간에만 의미가 있다. */
  claim(): string | undefined;
  /** 결말이 도착했다(`sent` → `settling`). 슬롯이 이미 비었으면(리셋 등) 무시한다. */
  receive(outcome: ReadLineOutcome): void;
  /** 복원한 읽기가 화면에 그려졌다. `settling`이면 결말로 resolve하고 슬롯을 비운다. */
  settle(): void;
}

export interface SourceSlot extends SourceLink {
  /** 슬롯이 차 있는가(대기·실행·정착 어느 단계든). */
  readonly occupied: boolean;
  /** `waiting` 슬롯이 있는가. */
  readonly waiting: boolean;
  /** 슬롯을 차지하고 결과 Promise를 만든다. */
  occupy(code: string, phase: "waiting" | "sent"): Promise<RunResult>;
  /** 슬롯을 비우고 차지하던 실행을 돌려준다. 끝내는 것(`endRun`)은 호출자가 콜백 뒤에 한다(TRP-051). */
  take(): SourceRun | undefined;
}

export function createSourceSlot(): SourceSlot {
  let active: SourceRun | undefined;
  return {
    get occupied() {
      return active !== undefined;
    },
    get waiting() {
      return active?.phase === "waiting";
    },
    occupy(code, phase) {
      return new Promise<RunResult>((resolve, reject) => {
        active = { code, phase, resolve, reject };
      });
    },
    take() {
      const run = active;
      active = undefined;
      return run;
    },
    claim() {
      if (active?.phase !== "waiting") return undefined;
      active.phase = "sent";
      return active.code;
    },
    receive(outcome) {
      if (active?.phase !== "sent") return;
      active.phase = "settling";
      active.outcome = outcome;
    },
    settle() {
      if (active?.phase !== "settling") return;
      const run = active;
      active = undefined;
      if (run.outcome !== undefined) run.resolve(run.outcome);
    },
  };
}
