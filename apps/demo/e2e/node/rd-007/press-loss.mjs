/**
 * 눌림 소실·누락·이중 통계(node, 판정선).
 * - 실제 pyodide(node)에 저장소 worker 모듈을 worker와 같은 순서로 배선한다.
 * - 별도 스레드(`presser.mjs`)가 저장소 송신기로 눌림을 쓴다.
 * - 5분 이상 걸리고 타이밍으로 판정하므로 `pnpm test`에 넣지 않는다.
 *
 * 시나리오:
 * - `single`: 라운드마다 눌림 한 번. 라운드가 `--watchdog` ms 안에 끝나지 않아 감시견이 새 번호로 구조하면 소실(`lost`)로 센다.
 * - `multi`: 페이지마다 눌림 `--k`개를 `--gap` ms 간격으로 쓴다. 눌림 하나당 `KeyboardInterrupt` 수를 세어 누락(`missing`)·이중(`doubles`)을 구한다.
 *
 * 판정선: single `lost === 0`, multi `missing === 0 && doubles === 0`. 종료 코드에는 반영하지 않는다. 결과 JSON을 읽는다.
 * `--mutate`는 하니스 검출력을 증명하는 변조다. 종류와 기대는 `README.md` "하니스 검출력" 절이다.
 *
 * 출처 RD-007에서 이관(RD-018).
 * 실행법은 `README.md`다.
 */
import { Worker } from "node:worker_threads";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// apps/demo/e2e/node/rd-007/ 기준 5단계 위가 레포 루트다.
/** `packages/pyodide-repl/` 폴더 URL. 소스 모듈 import의 기준이며 pyodide도 이 패키지의 `node_modules`에서 가져온다. */
const REPO = new URL("../../../../../packages/pyodide-repl/", import.meta.url);
const RESULTS_DIR = process.env.E2E_RESULTS_DIR ?? path.join(scriptDir, "..", "..", "results");

const { loadPyodide } = await import(
  new URL("node_modules/pyodide/pyodide.mjs", REPO).href
);
const { createConsole } = await import(
  new URL("src/worker/console.ts", REPO).href
);
const { attachRuntime } = await import(
  new URL("../pyodide-core/src/worker/runtime-attach.ts", REPO).href
);
const { createSubmissionRunner } = await import(
  new URL("src/worker/submission-runner.ts", REPO).href
);
const {
  ACK,
  SEQ,
  SIGNAL,
  createInterruptBuffer,
  discardPendingInterrupt,
} = await import(new URL("../pyodide-core/src/protocol/interrupt-protocol.ts", REPO).href);

/** `--이름 값` 쌍만 받는다. 그 밖의 인자는 던진다. */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--")) throw new Error(`알 수 없는 인자: ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const scenario = args.scenario ?? "single";
const mutate = args.mutate ?? "none";

// `ctl` 슬롯 번호. `presser.mjs`와 같은 값이다.
const CTL_STOP = 1;
const CTL_KI = 2;
const CTL_STARTED = 3;

/** 메인과 눌림 스레드가 공유하는 제어 슬롯(`presser.mjs` 머리 주석 참고). */
const ctl = new Int32Array(new SharedArrayBuffer(16));
const buffer = createInterruptBuffer();

/** `KeyboardInterrupt`를 잡은 시각(ns). 종료 플래그가 선 뒤의 눌림은 집계에서 뺀다. */
let markAt = [];

const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

const histogram = (values) => {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
};

const pyodide = await loadPyodide();
const sinks = { write() {}, writeErrorRaw() {} };
// worker의 부팅 순서와 같게 배선한다(createConsole → attachRuntime).
// - 감시 타이머(`docs/design/03-ctrl-c.md` 2.5)는 배선하지 않는다.
// - attachRuntime이 WebLoop 재보고 억제도 함께 건다. 이 시험이 재는 것(눌림 소실·누락·이중)과는 무관하다.
const repl = createConsole(pyodide, sinks, { topLevelAwait: false });
attachRuntime(pyodide, repl.pyconsole, {
  interruptBuffer: buffer,
  stdin: { requestInput: () => {}, wait: () => null },
  report: (id, detail) => console.warn(`[degraded] ${id}: ${detail}`),
});
const errors = [];
const runner = createSubmissionRunner(pyodide, repl, {
  writeOutput() {},
  writeError: (text) => errors.push(text),
});

// Python 시나리오가 부르는 JS 콜백 셋.
// - `started()`: 눌림 스레드에 "Python이 시나리오에 들어갔다"를 알린다.
// - `stop()`: 종료 플래그를 읽는다.
// - `mark()`: `KeyboardInterrupt`를 잡은 것을 센다.
pyodide.globals.set("started", () => {
  Atomics.store(ctl, CTL_STARTED, 1);
  Atomics.notify(ctl, CTL_STARTED);
});
pyodide.globals.set("stop", () => Atomics.load(ctl, CTL_STOP) === 1);
pyodide.globals.set("mark", () => {
  // 종료용 눌림이 만든 중단은 세지 않는다(마지막 진짜 눌림 뒤 settle을 두고 플래그가 선다).
  if (Atomics.load(ctl, CTL_STOP) === 1) return;
  Atomics.add(ctl, CTL_KI, 1);
  markAt.push(process.hrtime.bigint());
});

// 시나리오 소스.
// - `<console>` 파일명으로 컴파일해 이 함수들의 프레임이 사용자 프레임으로 인정되게 한다(핸들러의 스택 규칙).
// - `started()`는 `try` 본문 안에서 부른다. 폴링 위상에 따라 호출 직후의 SIGINT가 `try` 밖에서 처리될 수 있다(TRP-012).
// - `single_ki`: 무한 루프 하나. 눌림 하나가 `KeyboardInterrupt` 하나를 만들어야 한다.
// - `catch_loop`: 종료 플래그가 설 때까지 `KeyboardInterrupt`를 잡고 센다. 중첩 `try`는 안쪽 `except` 밖에서 난 중단도 세기 위해서다.
const SCENARIOS = `
def single_ki():
    try:
        started()
        while True:
            pass
    except KeyboardInterrupt:
        mark()

def catch_loop():
    started()
    while True:
        try:
            try:
                while True:
                    pass
            except KeyboardInterrupt:
                mark()
                if stop():
                    return
        except KeyboardInterrupt:
            mark()
            if stop():
                return
`;
pyodide.runPython(
  `exec(compile(${JSON.stringify(SCENARIOS)}, "<console>", "exec"), globals())`,
);

/** 눌림 스레드. 프로세스 종료를 막지 않게 `unref`한다. */
const presser = new Worker(new URL("presser.mjs", import.meta.url), {
  execArgv: [
    "--import",
    new URL("../pyodide-testkit/src/ts-resolve-hook.mjs", REPO).href,
  ],
  workerData: { buffer, ctl, mutate },
});
presser.unref();

/** 눌림 스레드의 다음 메시지 하나. 라운드마다 부르므로 쓰지 않은 리스너를 반드시 뗀다. */
function nextMessage() {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      presser.off("error", onError);
      resolve(message);
    };
    const onError = (error) => {
      presser.off("message", onMessage);
      reject(error);
    };
    presser.once("message", onMessage);
    presser.once("error", onError);
  });
}

const started = Date.now();
let report;

if (scenario === "single") {
  const rounds = Number(args.n ?? 3000);
  const watchdogMs = Number(args.watchdog ?? 1500);
  const stats = {
    lost: 0,
    notStarted: 0,
    resendsHist: [],
    latencyMs: [],
    recoveredLatencyMs: [],
    spuriousResends: 0,
    maxedOut: 0,
    escapes: 0,
  };
  for (let round = 0; round < rounds; round += 1) {
    discardPendingInterrupt(buffer);
    Atomics.store(ctl, CTL_STARTED, 0);
    Atomics.store(ctl, CTL_KI, 0);
    markAt = [];
    errors.length = 0;
    const answer = nextMessage();
    presser.postMessage({
      type: "single",
      // 눌림 시각을 폴링 위상과 어긋나게 흩뿌린다(고정 지연이면 같은 지점만 본다).
      delayMs: 100 + Math.random() * 7,
      watchdogMs,
    });
    await runner.run("single_ki()");
    presser.postMessage({ type: "round-done" });
    const result = await answer;
    if (!result.started) {
      stats.notStarted += 1;
      continue;
    }
    // 감시견이 구조했으면 첫 눌림이 소실된 라운드다.
    if (result.rescued > 0) stats.lost += 1;
    const resends = result.resendAt.length;
    stats.resendsHist.push(resends);
    if (resends >= 10) stats.maxedOut += 1;
    // 트레이스백이 화면에 나갔다면 `except`가 잡지 못한 것이다(TRP-012).
    if (errors.length > 0) stats.escapes += 1;
    if (markAt.length > 0) {
      const latency = Number(markAt[0] - result.pressAt) / 1e6;
      stats.latencyMs.push(latency);
      const firstResend = result.resendAt[0];
      if (firstResend !== undefined) {
        if (firstResend < markAt[0]) stats.recoveredLatencyMs.push(latency);
        else stats.spuriousResends += 1;
      }
    }
    if ((round + 1) % 200 === 0) {
      process.stderr.write(
        `  ${round + 1}/${rounds} lost=${stats.lost} escapes=${stats.escapes}\n`,
      );
    }
  }
  report = {
    scenario,
    mutate,
    rounds,
    lost: stats.lost,
    lostPct: Number(((stats.lost / rounds) * 100).toFixed(3)),
    notStarted: stats.notStarted,
    escapes: stats.escapes,
    maxedOut: stats.maxedOut,
    spuriousResends: stats.spuriousResends,
    recovered: stats.recoveredLatencyMs.length,
    resendsHist: histogram(stats.resendsHist),
    latencyMs: {
      p50: percentile(stats.latencyMs, 0.5),
      p99: percentile(stats.latencyMs, 0.99),
      max: stats.latencyMs.length ? Math.max(...stats.latencyMs) : null,
    },
    recoveredLatencyMs: {
      p50: percentile(stats.recoveredLatencyMs, 0.5),
      max: stats.recoveredLatencyMs.length
        ? Math.max(...stats.recoveredLatencyMs)
        : null,
    },
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
  };
} else if (scenario === "multi") {
  const presses = Number(args.k ?? 300);
  const pages = Number(args.pages ?? 10);
  const gapMs = Number(args.gap ?? 25);
  let missing = 0;
  let doubles = 0;
  let totalKi = 0;
  let totalAckDelta = 0;
  let resends = 0;
  const kiDelta = [];
  for (let page = 0; page < pages; page += 1) {
    discardPendingInterrupt(buffer);
    Atomics.store(ctl, CTL_STARTED, 0);
    Atomics.store(ctl, CTL_STOP, 0);
    Atomics.store(ctl, CTL_KI, 0);
    markAt = [];
    const ackBefore = Atomics.load(buffer, ACK);
    const answer = nextMessage();
    presser.postMessage({ type: "multi", presses, gapMs });
    await runner.run("catch_loop()");
    presser.postMessage({ type: "round-done" });
    const result = await answer;
    if (!result.started) throw new Error("시나리오가 시작되지 않았다");
    const ki = Atomics.load(ctl, CTL_KI);
    totalKi += ki;
    totalAckDelta += Atomics.load(buffer, ACK) - ackBefore;
    resends += result.resends;
    kiDelta.push(...result.kiDelta);
    missing += result.kiDelta.filter((delta) => delta === 0).length;
    doubles += result.kiDelta.filter((delta) => delta >= 2).length;
    process.stderr.write(
      `  page ${page + 1}/${pages} presses=${presses} ki=${ki} resends=${result.resends}\n`,
    );
  }
  report = {
    scenario,
    mutate,
    pages,
    pressesPerPage: presses,
    gapMs,
    presses: presses * pages,
    ki: totalKi,
    missing,
    doubles,
    resends,
    ackDelta: totalAckDelta,
    kiDeltaHist: histogram(kiDelta),
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
  };
} else {
  throw new Error(`알 수 없는 시나리오: ${scenario}`);
}

report.slots = {
  signal: Atomics.load(buffer, SIGNAL),
  ack: Atomics.load(buffer, ACK),
  seq: Atomics.load(buffer, SEQ),
};
const suffix = mutate === "none" ? scenario : `${scenario}-${mutate}`;
mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(path.join(RESULTS_DIR, `node-press-loss-${suffix}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
await presser.terminate();
