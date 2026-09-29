/**
 * 눌림 스레드 역할(시험 전용, TRAP-26).
 * 실행 스레드가 Python에 막혀 있는 동안 별도 스레드가 interrupt buffer에 SIGINT를 써서 main의 Ctrl+C를 흉내낸다.
 * 블로킹 실행 중에는 실행 스레드의 `setTimeout`이 돌지 못한다. 눌림을 같은 스레드에서 예약할 수 없는 이유다.
 *
 * workerData: `{ buffer, ctl }`. 둘 다 SharedArrayBuffer 위의 Int32Array다.
 * - `buffer`: interrupt buffer.
 * - `ctl[0]`: "Python이 시나리오에 들어갔다"는 표시. 시험이 Python에서 부르는 JS 함수가 1로 쓰고 `Atomics.notify`한다.
 *
 * 눌림 시각은 `process.hrtime.bigint()`로 잰다.
 * - 스레드 간에 같은 단조 시계다.
 * - `performance.now()`는 스레드마다 원점이 달라 쓰지 않는다.
 *
 * `resend: true`는 main처럼 송신기(`createInterruptSender`)로 쓰고 5ms 점검·재전송까지 흉내낸다.
 * - 재전송이 없으면 pyodide 폴링의 읽기·비우기 경합(TRAP-06)으로 눌림이 드물게 소실된다.
 * - 눌림마다 중단을 단언하는 시험이 간헐 실패한다(이슈 sigint-test-isolation/09).
 * - 송신기 타이머는 `setTimeout`이 아니라 이 스레드의 루프가 돌린다.
 * - 스레드가 `Atomics.wait`로 대기하면 `setTimeout` 점검이 한 번도 돌지 않는다(TRP-014).
 */
import { parentPort, workerData } from "node:worker_threads";
import { signalInterrupt } from "../../src/protocol/interrupt-protocol";
import { createInterruptSender } from "../../src/protocol/interrupt-sender";

/** main 시험이 눌림 스레드에 보내는 명령. */
export type PresserCommand =
  | {
      kind: "press";

      /** 기준 시각부터 눌림까지의 지연(ms). 오름차순 */
      offsets: number[];

      /** true면 요청 번호를 올리지 않고 SIGINT 슬롯만 다시 쓴다(main 재전송 흉내) */
      raw?: boolean;

      /** 기본 true. `ctl[0]`이 1이 될 때까지(최대 5초) 기다린 뒤 그 시각을 기준으로 삼는다. false면 명령을 받은 시각이 기준이다. */
      waitStarted?: boolean;

      /**
       * true면 main 송신기처럼 쓰고 ack를 점검해 재전송한다. `raw`와 함께 쓰지 않는다.
       * 다음 눌림이 앞 눌림의 점검을 교체한다.
       * 마지막 눌림의 점검은 ack가 오르거나, 재전송 예산을 다 쓰거나, `RESEND_LIMIT_MS`가 지나면 멈춘다.
       */
      resend?: boolean;
    }
  /** `ctl[0]`을 0으로 되돌린다(라운드 반복용). */
  | { kind: "reset" };

/** 눌림 스레드가 main 시험에 돌려주는 보고. `atMs`는 기준 시각부터 각 눌림까지 실제로 걸린 시간(ms)이다. */
export type PresserEvent =
  | { kind: "pressed"; count: number; atMs: number[] }
  | { kind: "not-started" }
  | { kind: "reset" };

/** 눌림 스레드의 `workerData`. */
interface PresserData {
  buffer: Int32Array;
  ctl: Int32Array;
}

const port = parentPort;
if (!port) throw new Error("worker 스레드에서만 실행한다");
const { buffer, ctl } = workerData as PresserData;
const pause = new Int32Array(new SharedArrayBuffer(4));

/** 마지막 눌림의 재전송 점검 상한(ms). SIGINT가 소비되지 않고 남으면 송신기는 끝없이 점검한다. 여기서 멈춘다. */
const RESEND_LIMIT_MS = 2000;

/** 송신기가 예약한 점검 하나. `runChecks` 루프가 시각이 되면 부른다. */
let due: { at: bigint; callback: () => void } | undefined;
const sender = createInterruptSender(buffer, {
  setTimer: (callback: () => void, ms: number) => {
    due = {
      at: process.hrtime.bigint() + BigInt(Math.round(ms * 1e6)),
      callback,
    };
    return due;
  },
  clearTimer: (timer: unknown) => {
    if (due === timer) due = undefined;
  },
});

/** `until` 전까지 예약된 점검을 차례로 돌린다. 점검이 다음을 예약하지 않으면(전달 확인·예산 소진) 일찍 끝난다. */
function runChecks(until: bigint): void {
  while (due !== undefined && due.at < until) {
    const { at, callback } = due;
    sleepUntil(at);
    due = undefined;
    callback();
  }
}

/** `target`(hrtime) 시각까지 블로킹 대기한다. 마지막 1.5ms는 스핀으로 기다려 밀리초 미만 오차를 줄인다. */
function sleepUntil(target: bigint): void {
  for (;;) {
    const remain = Number(target - process.hrtime.bigint()) / 1e6;
    if (remain <= 0) return;
    if (remain > 2) Atomics.wait(pause, 0, 0, remain - 1.5);
  }
}

/** main 시험에 보고를 보낸다. */
function post(event: PresserEvent): void {
  port?.postMessage(event);
}

// 명령 하나를 동기로 끝까지 처리한다. 눌림 중에는 이 스레드가 대기로 막힌다.
port.on("message", (command: PresserCommand) => {
  if (command.kind === "reset") {
    Atomics.store(ctl, 0, 0);
    post({ kind: "reset" });
    return;
  }
  const { offsets, raw = false, waitStarted = true, resend = false } = command;
  if (waitStarted && Atomics.wait(ctl, 0, 0, 5000) === "timed-out") {
    post({ kind: "not-started" });
    return;
  }
  // 기준 시각에서 offsets마다 눌림을 쓰고, 실제 눌림 시각을 기록한다.
  const base = process.hrtime.bigint();
  const atMs: number[] = [];
  const at = (offset: number) => base + BigInt(Math.round(offset * 1e6));
  for (const [i, offset] of offsets.entries()) {
    sleepUntil(at(offset));
    if (resend) sender.send();
    else if (raw) Atomics.compareExchange(buffer, 0, 0, 2);
    else signalInterrupt(buffer);
    atMs.push(Number(process.hrtime.bigint() - base) / 1e6);
    // 다음 눌림 전까지(마지막이면 상한까지) 재전송 점검을 돌린다.
    if (resend) {
      const next = offsets[i + 1];
      runChecks(
        next === undefined
          ? process.hrtime.bigint() + BigInt(RESEND_LIMIT_MS * 1e6)
          : at(next),
      );
    }
  }
  sender.cancel();
  post({ kind: "pressed", count: offsets.length, atMs });
});
