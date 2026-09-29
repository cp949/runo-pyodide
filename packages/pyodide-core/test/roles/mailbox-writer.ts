/**
 * 메일박스 main 쪽 역할(시험 전용). `delayMs` 뒤에 한 줄을 전달한다.
 *
 * 별도 스레드가 필요한 이유는 두 가지다.
 * - 취소한 읽기를 CPython이 다시 시도하는 회귀(TRP-020)가 나면 worker 스레드가 `Atomics.wait`에 영구히 막힌다.
 * - 같은 스레드의 `setTimeout`은 막힌 스레드에서 돌지 못한다.
 *
 * 이 역할이 그 대기를 풀어 준다. 시험이 멈추지 않고 단언에서 실패한다.
 *
 * workerData: `{ mailbox: StdinMailboxBuffers, delayMs: number, text: string }`
 */
import { parentPort, workerData } from "node:worker_threads";
import {
  createMailboxWriter,
  type StdinMailboxBuffers,
} from "../../src/protocol/stdin-mailbox";

/** 메일박스 쓰기 스레드의 `workerData`. */
interface WriterData {
  mailbox: StdinMailboxBuffers;
  delayMs: number;
  text: string;
}

const port = parentPort;
if (!port) throw new Error("worker 스레드에서만 실행한다");
const { mailbox, delayMs, text } = workerData as WriterData;
const writer = createMailboxWriter(mailbox);

// `delayMs` 뒤에 한 줄을 전달하고 완료를 알린다.
setTimeout(() => {
  void writer.deliver(text).then(() => port.postMessage({ kind: "delivered" }));
}, delayMs);
