/**
 * `@cp949/runo-pyodide-terminal` 공개 진입점. xterm 실행창 `createTerminalRunner`(RD-022)를 낸다. 공통 부품은 `./internal`이다.
 * `RunRejectedError`와 결과·상태 타입은 core의 것을 다시 내보낸다(같은 클래스라 `instanceof`가 성립한다).
 */
export {
  createTerminalRunner,
  type TerminalRunnerHandle,
  type TerminalRunnerOptions,
} from "./terminal-runner";
export {
  RunRejectedError,
  type InputProvider,
  type OutputChunk,
  type RunRejectedReason,
  type RunResult,
  type RunnerStatus,
  type StopResult,
} from "@cp949/runo-pyodide-core";
export type { CopyResult } from "./selection-copy";
