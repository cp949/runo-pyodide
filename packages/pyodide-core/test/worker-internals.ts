/**
 * repl에 남은 통합 시험(SIGINT 4종·`runtime-attach`·`stdin-callback`·`console`·`submission-runner`·`webloop-reraise`)이
 * core worker 모듈을 직접 조립할 때 쓰는 진입점(`@cp949/runo-pyodide-core/test-utils/worker`, `development`·`types`
 * 전용, `publishConfig`는 `null`). 이 모듈들은 core 공개 export가 아니다(내부 부품이고 시험만 쓴다).
 * 눌림 스레드 역할 URL(`INTERRUPT_PRESSER_ROLE`)도 여기서 낸다 — repl이 core 소스를 상대 경로로 가리키지 않게 한다.
 */
export { attachRuntime } from "../src/worker/runtime-attach";
export type {
  AttachedRuntime,
  RuntimeAttachDeps,
} from "../src/worker/runtime-attach";
export {
  SIGINT_HANDLER_FILENAME,
  installSigintHandler,
} from "../src/worker/sigint-handler";
export type { InterruptIdle } from "../src/worker/sigint-handler";
export { createSinkWriter } from "../src/worker/sink-writer";
export {
  SLEEP_SLICE_FILENAME,
  installSleepSlice,
} from "../src/worker/sleep-slice";
export { createStdinCallback } from "../src/worker/stdin-callback";
export { suppressWebLoopReraise } from "../src/worker/webloop-reraise";
import type { ReportDegraded } from "../src/worker/compat";
export type { ReportDegraded };

/** 저하 보고를 `console.warn`으로 내는 시험용 `report`. 기대와 다른 지점이 시험 로그에 보이게 한다(worker 부팅은 수집기를 쓴다). */
export const warnDegraded: ReportDegraded = (id, detail) =>
  console.warn(`[degraded] ${id}: ${detail}`);

/** 눌림 스레드 역할 스크립트 위치. 시험 세 곳이 같은 파일을 띄운다(`spawnRole`은 URL을 받는다). */
export const INTERRUPT_PRESSER_ROLE = new URL(
  "./roles/interrupt-presser.ts",
  import.meta.url,
);
export type { PresserCommand, PresserEvent } from "./roles/interrupt-presser";
