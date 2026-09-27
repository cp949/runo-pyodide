/**
 * 실행 driver worker 역할(시험 전용). 실제 pyodide(node)를 worker 스레드에 올려 `runWorker({ driver: runDriver })`가 브라우저에서
 * 하는 일을 그대로 한다: 초기화 프레임 수신 → `bootWorker`. main 역할(시험 본문)의 `createRunner`가 이 스레드를 `Worker`처럼
 * 쓴다(`spawnWorkerLike`). Python이 `Atomics.wait`로 스레드를 막는 동안에도 main의 이벤트 루프가 살아 있어 `readInput` 알림 →
 * 응답 왕복이 실제 시간 흐름으로 일어난다.
 */
import { parentPort } from "node:worker_threads";
import { loadPyodide } from "pyodide";
import { parseInitFrame } from "../../src/protocol/init-frame";
import { bootWorker } from "../../src/worker/boot";
import { runDriver } from "../../src/worker/run-driver";

const port = parentPort;
if (!port) throw new Error("worker 스레드에서만 실행한다");

// 스크립트 최상단에서 첫 메시지를 받는다(첫 await 이전).
port.once("message", (data: unknown) => {
  const frame = parseInitFrame(data);
  bootWorker(frame, {
    driver: runDriver,
    loadPyodide: () => loadPyodide(),
  }).catch((error: unknown) => {
    console.error("[run-worker] 부팅 시퀀스 예외", error);
  });
});
