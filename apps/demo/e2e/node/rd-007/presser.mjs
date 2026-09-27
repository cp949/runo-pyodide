/**
 * 눌림 스레드. 저장소 `createInterruptSender`를 그대로 써서 main 브라우저의 Ctrl+C 송신을 흉내낸다.
 * 실행 스레드는 Python에 막혀 있어 같은 스레드에서 눌림을 예약할 수 없다(TRP-029).
 * 출처 RD-007, `_works/_completed/20260922-07-rd-007-ctrl-c-running/verify/node/`에서 이관(RD-018 DELTA-04).
 *
 * 대기는 전부 이벤트 루프 기반이다: `Atomics.wait`로 스레드를 막으면 송신기의 5ms 재전송 점검(`setTimeout`)이 돌지
 * 못해 이 스크립트가 재려는 것(재전송이 소실을 복구하는가)이 사라진다. 마지막 1.5ms만 스핀으로 맞춘다.
 *
 * workerData: `{ buffer, ctl, intervalMs, maxResends, mutate }`. 시각은 `process.hrtime.bigint()`(스레드 간 원점이 같다).
 * ctl: [0] 예약, [1] 종료 플래그, [2] KeyboardInterrupt 수, [3] 시작 표시.
 */
import { parentPort, workerData } from "node:worker_threads";
import { createInterruptSender } from "../../../../../packages/pyodide-core/src/protocol/interrupt-sender.ts";
import {
  SEQ,
  SIGNAL,
  signalInterrupt,
} from "../../../../../packages/pyodide-core/src/protocol/interrupt-protocol.ts";

const port = parentPort;
if (!port) throw new Error("worker 스레드에서만 실행한다");

const { buffer, ctl, intervalMs = 5, mutate = "none" } = workerData;

/** 변이 모드(하니스 검출력 증명용). 여러 개를 `+`로 잇는다. */
const mutations = new Set(mutate.split("+").filter((name) => name !== "none"));
/** 재전송 없음. `lose-first`와 조합하면 소실이 그대로 남아야 한다. */
const maxResends = mutations.has("no-resend") ? 0 : (workerData.maxResends ?? 10);

const CTL_STOP = 1;
const CTL_KI = 2;
const CTL_STARTED = 3;

/** 재전송 시각(ns). 라운드마다 비운다. 송신기의 `compareExchange`를 이 isolate에서만 감싸 기록한다. */
let resendAt = [];
const originalCompareExchange = Atomics.compareExchange;
Atomics.compareExchange = function (typedArray, index, expected, replacement) {
  const isResend =
    typedArray.buffer === buffer.buffer &&
    index === SIGNAL &&
    expected === 0 &&
    replacement === 2;
  if (!isResend) {
    return originalCompareExchange.call(
      Atomics,
      typedArray,
      index,
      expected,
      replacement,
    );
  }
  // 변이: 재전송이 새 요청 번호를 쓴다(핸들러가 재전송을 새 눌림으로 본다).
  if (mutations.has("resend-new-seq")) Atomics.add(typedArray, SEQ, 1);
  const previous = originalCompareExchange.call(
    Atomics,
    typedArray,
    index,
    expected,
    replacement,
  );
  if (previous === 0) resendAt.push(process.hrtime.bigint());
  else if (mutations.has("resend-new-seq")) Atomics.sub(typedArray, SEQ, 1);
  return previous;
};

/** 변이 `lose-first`: 눌림의 첫 SIGINT 쓰기를 삼켜 소실을 강제한다. 재전송만이 복구할 수 있다. */
let loseNextSignal = false;
const originalStore = Atomics.store;
Atomics.store = function (typedArray, index, value) {
  if (
    loseNextSignal &&
    typedArray.buffer === buffer.buffer &&
    index === SIGNAL &&
    value === 2
  ) {
    loseNextSignal = false;
    return value;
  }
  return originalStore.call(Atomics, typedArray, index, value);
};

const sender = createInterruptSender(buffer, { intervalMs, maxResends });

/** 눌림 하나. 변이 모드에 따라 첫 쓰기를 삼키거나(소실) 한 번 더 보낸다(이중). */
function press() {
  if (mutations.has("lose-first")) loseNextSignal = true;
  sender.send();
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 목표 시각까지 기다린다. 이벤트 루프를 열어 두다가 마지막 1.5ms만 스핀한다. */
async function sleepUntil(target) {
  for (;;) {
    const remain = Number(target - process.hrtime.bigint()) / 1e6;
    if (remain <= 0) return;
    if (remain > 2) await delay(remain - 1.5);
    else {
      while (process.hrtime.bigint() < target);
      return;
    }
  }
}

/** Python이 시나리오에 들어갈 때까지 기다린다(`started()`가 ctl[3]을 1로 쓴다). */
async function waitStarted(timeoutMs) {
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
  while (Atomics.load(ctl, CTL_STARTED) === 0) {
    if (process.hrtime.bigint() > deadline) return false;
    const result = Atomics.waitAsync(ctl, CTL_STARTED, 0, 5);
    if (result.async) await result.value;
    else if (result.value === "timed-out") await delay(1);
  }
  return true;
}

/** main이 보내는 라운드 종료 신호. 신호가 먼저 와도 잃지 않게 플래그로 받는다. */
let resolveRoundDone;
let roundDoneSeen = false;
function waitRoundDone() {
  if (roundDoneSeen) {
    roundDoneSeen = false;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    resolveRoundDone = resolve;
  });
}

/** 라운드가 끝나지 않으면 새 번호의 눌림으로 구조한다. 구조가 필요했다는 것은 눌림이 소실됐다는 뜻이다. */
function startWatchdog(state, watchdogMs) {
  return setInterval(() => {
    state.rescued += 1;
    signalInterrupt(buffer);
  }, watchdogMs);
}

port.on("message", async (command) => {
  if (command.type === "round-done") {
    if (resolveRoundDone) {
      const resolve = resolveRoundDone;
      resolveRoundDone = undefined;
      resolve();
    } else roundDoneSeen = true;
    return;
  }

  if (command.type === "single") {
    resendAt = [];
    const state = { rescued: 0 };
    if (!(await waitStarted(command.startTimeoutMs ?? 5000))) {
      port.postMessage({ type: "round", started: false });
      return;
    }
    const base = process.hrtime.bigint();
    await sleepUntil(base + BigInt(Math.round(command.delayMs * 1e6)));
    const pressAt = process.hrtime.bigint();
    press();
    const watchdog = startWatchdog(state, command.watchdogMs ?? 1500);
    // main이 라운드 종료를 알릴 때까지 이벤트 루프를 열어 둔다(재전송 점검이 계속 돈다).
    await waitRoundDone();
    clearInterval(watchdog);
    sender.cancel();
    port.postMessage({
      type: "round",
      started: true,
      pressAt,
      resendAt,
      rescued: state.rescued,
    });
    return;
  }

  if (command.type === "multi") {
    resendAt = [];
    const { presses, gapMs, settleMs = 100, leadMs = 20 } = command;
    if (!(await waitStarted(command.startTimeoutMs ?? 5000))) {
      port.postMessage({ type: "page", started: false });
      return;
    }
    const base = process.hrtime.bigint() + BigInt(Math.round(leadMs * 1e6));
    const pressAt = [];
    // 눌림 하나하나에 대응하는 KeyboardInterrupt 수. 다음 눌림 직전(= 직전 구간이 처리된 뒤)에 세어 차이를 낸다.
    const kiDelta = [];
    let previousKi = Atomics.load(ctl, CTL_KI);
    for (let i = 0; i < presses; i += 1) {
      await sleepUntil(base + BigInt(Math.round(i * gapMs * 1e6)));
      const ki = Atomics.load(ctl, CTL_KI);
      if (i > 0) kiDelta.push(ki - previousKi);
      previousKi = ki;
      pressAt.push(process.hrtime.bigint());
      press();
      // 변이 `double-press`: 같은 자리에서 새 번호로 한 번 더 보낸다(이중 중단이 나와야 한다).
      if (mutations.has("double-press")) {
        await delay(2);
        press();
      }
    }
    await delay(settleMs);
    kiDelta.push(Atomics.load(ctl, CTL_KI) - previousKi);
    // 여기부터의 KeyboardInterrupt는 집계에서 빠진다(main의 `mark()`가 종료 플래그를 보고 세지 않는다).
    Atomics.store(ctl, CTL_STOP, 1);
    sender.cancel();
    // 시나리오는 `KeyboardInterrupt`를 잡은 자리에서만 종료를 확인한다. 끝날 때까지 새 눌림을 보낸다.
    const closing = setInterval(() => signalInterrupt(buffer), 5);
    await waitRoundDone();
    clearInterval(closing);
    port.postMessage({
      type: "page",
      started: true,
      presses,
      pressAt,
      kiDelta,
      resends: resendAt.length,
    });
    return;
  }

  throw new Error(`알 수 없는 명령: ${JSON.stringify(command)}`);
});
