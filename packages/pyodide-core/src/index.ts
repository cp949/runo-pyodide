// main 쪽 프로토콜(01-protocols.md)과 core 세션(`startCoreSession`, driver 경계).
export { postInitFrame } from "./protocol/init-frame";
export type { InitFrame } from "./protocol/init-frame";
export { DEFAULT_PYODIDE_INDEX_URL, PYODIDE_VERSION } from "./pyodide-version";
export type { ReadyPayload } from "./protocol/ready-payload";
export {
  ACK,
  SEQ,
  SIGNAL,
  createInterruptBuffer,
  signalInterrupt,
} from "./protocol/interrupt-protocol";
export { createInterruptSender } from "./protocol/interrupt-sender";
export type { InterruptSender } from "./protocol/interrupt-sender";
export { createRpc } from "./protocol/rpc";
export type { Rpc, RpcHandlers } from "./protocol/rpc";
export {
  createMailboxWriter,
  createStdinMailbox,
} from "./protocol/stdin-mailbox";
export { STDIN_EOF } from "./protocol/stdin-eof";
export { composeRpcHandlers } from "./protocol/rpc-handlers";
export { createOutputTail, leavesVisibleText } from "./terminal/output-tail";
export {
  CORE_MAIN_HANDLER_NAMES,
  startCoreSession,
} from "./session/core-session";
export type { CoreSession, CoreSessionOptions } from "./session/core-session";
export type { MainDriver, OutputChunk, SessionStatus } from "./session/driver";
export type { RunOutcome } from "./protocol/run-outcome";
export { RunRejectedError, createRunner } from "./session/runner";
export { callConsumer } from "./session/consumer-callback";
export type {
  InputProvider,
  InterruptResult,
  RunRejectedReason,
  RunResult,
  RunnerHandle,
  RunnerOptions,
  RunnerStatus,
  StopResult,
} from "./session/runner";
