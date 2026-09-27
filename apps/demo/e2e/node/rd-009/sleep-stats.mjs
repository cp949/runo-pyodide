/**
 * node N=30 통계(RD-009 완료 기준). 실제 pyodide(node)에 저장소 worker 모듈을 `boot.ts`와 같은
 * 순서로 배선하고(`createConsole` → `attachRuntime`(WebLoop 재보고 억제 포함) → `createSubmissionRunner`),
 * 별도 스레드(core `test/roles/interrupt-presser.ts`)가 저장소 송신 프로토콜(`signalInterrupt`)로 눌림을 쓴다.
 * `--mode jspi|nojspi` × 5 프로그램 × N=30, 눌림 시각은 300~3000ms 균등 무작위(시행마다 다시 뽑는다).
 * 출처 RD-009, `_works/_completed/20260922-09-rd-009-idle-ctrl-c/verify/node/`에서 이관(RD-018 DELTA-04).
 *
 * 실행(레포 루트에서):
 *   H1=packages/pyodide-testkit/src/ts-resolve-hook.mjs
 *   H2=apps/demo/e2e/node/rd-009/py-raw-hook.mjs
 *   node --import $H1 --import $H2 apps/demo/e2e/node/rd-009/sleep-stats.mjs --mode jspi --n 30
 *
 * `--import` 순서가 중요하다: `ts-resolve-hook.mjs`(확장자 없는 상대 import 해석)를 먼저, `py-raw-hook.mjs`(`.py?raw`
 * 텍스트 해석)를 **나중에** 등록해야 한다(node 훅 체인은 스택이라 나중 등록이 먼저 실행된다). 순서가 바뀌면
 * `ts-resolve-hook.mjs`의 확장자 정규식이 `?raw` 쿼리 문자열을 모르고 `.py?raw.ts`로 잘못 늘린다(README 참고).
 *
 * `--mode nojspi`는 `loadPyodide()` 전에 `WebAssembly.Suspending`·`promising`·`Suspender`를 지운다(vitest
 * `sigint-handler-nojspi.test.ts`와 같은 방법). 프로그램: `sleep5` = `time.sleep(5)`, `loopXX` =
 * `while True: time.sleep(<초>)`(`01`→0.1, `002`→0.02, `0015`→0.015, `001`→0.01). 각 시행은 `started()`를 먼저
 * 실행해 presser 스레드에 "Python이 들어갔다"를 알리고, presser는 그 시각 기준 무작위 지연 뒤 `signalInterrupt`를 쓴다.
 *
 * `--dry`(양성 대조): 저장소 송신 프로토콜을 통째로 건너뛰어(presser 스레드를 아예 띄우지 않는다) 각 프로그램을
 * **유한** 형태(무한 `while True` 대신 총 실행 시간이 비슷한 `for` 상한)로 돌려 눌림 없이 완주시킨다. `screen.stderr`가
 * 비어 있으면(트레이스백 없음) "중단 없음"이다 — 하니스가 완주와 중단을 실제로 구별하는지 증명한다(RD-007
 * `poll-overhead.mjs` 류의 `--mutate` 양성 대조와 같은 목적, 다만 `interrupt-presser.ts`를 고치지 않으므로 신호를
 * 아예 보내지 않는 쪽으로 구현했다).
 */
import { Worker } from "node:worker_threads";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// apps/demo/e2e/node/rd-009/ 기준 5단계 위가 레포 루트(옛 `_works/.../verify/node/`의 4단계에서 +1).
const REPO = new URL("../../../../../packages/pyodide-repl/", import.meta.url);
const RESULTS_DIR = process.env.E2E_RESULTS_DIR ?? path.join(scriptDir, "..", "..", "results");

/** `--이름 값` 또는 플래그(`--dry`, 다음 토큰이 없거나 `--`로 시작하면 `"true"`)를 받는다. */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new Error(`알 수 없는 인자: ${token}`);
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[name] = "true";
    } else {
      args[name] = next;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const mode = args.mode ?? "jspi";
if (mode !== "jspi" && mode !== "nojspi") {
  throw new Error(`알 수 없는 --mode: ${mode} (jspi|nojspi)`);
}
const progNames = (args.progs ?? "sleep5,loop01,loop002,loop0015,loop001").split(",");
const n = Number(args.n ?? 30);
const [pressMin, pressMax] = (args.press ?? "300,3000").split(",").map(Number);
const dry = args.dry === "true";

if (mode === "nojspi") {
  // pyodide는 `"Suspending" in WebAssembly`로 JSPI 지원을 판정한다. loadPyodide 전에 지워 JSPI 없는 환경을 흉내낸다
  // (`sigint-handler-nojspi.test.ts`와 같은 방법).
  for (const name of ["Suspending", "promising", "Suspender"]) {
    delete WebAssembly[name];
  }
}

const { loadPyodide } = await import(
  new URL("node_modules/pyodide/pyodide.mjs", REPO).href
);
const { createConsole } = await import(
  new URL("src/worker/console.ts", REPO).href
);
const { attachRuntime } = await import(
  new URL("../pyodide-core/src/worker/runtime-attach.ts", REPO).href
);
const { createSubmissionRunner, PS1, PS2 } = await import(
  new URL("src/worker/submission-runner.ts", REPO).href
);
const { createInterruptBuffer, discardPendingInterrupt } = await import(
  new URL("../pyodide-core/src/protocol/interrupt-protocol.ts", REPO).href
);

const pyodide = await loadPyodide();

/** 시행마다 초기화한다. */
let screen = { stdout: "", stderr: "" };
/** 이 시행에서 stderr 첫 바이트가 도착한 시각(ns). `undefined`면 아직 없음. */
let firstStderrAt;

const warnings = [];
// 저하 보고(RD-021 `report(id, detail)`)를 경고 목록에 모은다.
const report = (id, detail) => {
  const message = `${id}: ${detail}`;
  warnings.push(message);
  console.warn(message);
};

const repl = createConsole(
  pyodide,
  {
    write: (text) => {
      screen.stdout += text;
    },
    writeErrorRaw: (text) => {
      if (firstStderrAt === undefined) firstStderrAt = process.hrtime.bigint();
      screen.stderr += text;
    },
  },
  { topLevelAwait: false },
);
// worker의 부팅 순서와 같게 배선한다(createConsole → attachRuntime). attachRuntime이 WebLoop 재보고 억제까지
// 한 번에 한다(이전에는 별도 호출이었다).
const buffer = createInterruptBuffer();
attachRuntime(pyodide, repl.pyconsole, {
  interruptBuffer: buffer,
  stdin: { requestInput: () => {}, wait: () => null },
  report,
});
const runner = createSubmissionRunner(pyodide, repl, {
  writeOutput: (text) => {
    screen.stdout += `${text}\n`;
  },
  writeError: (text) => {
    if (firstStderrAt === undefined) firstStderrAt = process.hrtime.bigint();
    screen.stderr += `${text}\n`;
  },
});

pyodide.runPython("import time");

/** `ctl[0]`: `started()`가 1로 쓰고 notify한다. presser 스레드가 이 값을 기다린다(`interrupt-presser.ts`). */
const ctl = new Int32Array(new SharedArrayBuffer(4));
/** `started()`가 JS에서 불린 시각(ns). presser의 상대 `atMs`를 절대 시각으로 바꾸는 기준이다. */
let startedAtMain;
pyodide.globals.set("started", () => {
  startedAtMain = process.hrtime.bigint();
  Atomics.store(ctl, 0, 1);
  Atomics.notify(ctl, 0);
  return true;
});

let presser;
function ensurePresser() {
  if (presser) return presser;
  presser = new Worker(
    new URL("../pyodide-core/test/roles/interrupt-presser.ts", REPO),
    {
      execArgv: [
        "--import",
        new URL("../pyodide-testkit/src/ts-resolve-hook.mjs", REPO).href,
      ],
      workerData: { buffer, ctl },
    },
  );
  presser.unref();
  return presser;
}

/** 눌림 스레드의 다음 메시지 하나. */
function nextPresserMessage() {
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

const LOOP_SECS = { "01": 0.1, "002": 0.02, "0015": 0.015, "001": 0.01 };

/** `--progs` 이름 → 제출할 소스 줄 목록. `real`은 무한 루프(눌림이 있어야 끝난다), `dry`는 눌림 없이 완주하는 유한
 * 형태(총 실행 시간이 비슷하도록 총 1초 안팎으로 반복 횟수를 잡는다). 두 경우 다 `started()`를 첫 줄로 둔다(dry는
 * presser가 없어 신호를 안 쓰지만 구조를 맞춰 둔다). */
function programLines(name, isDry) {
  if (name === "sleep5") {
    return isDry ? ["started(); time.sleep(1)"] : ["started(); time.sleep(5)"];
  }
  const match = /^loop(\d+)$/.exec(name);
  if (!match) throw new Error(`알 수 없는 프로그램: ${name}`);
  const secs = LOOP_SECS[match[1]];
  if (secs === undefined) {
    throw new Error(`알 수 없는 loop 접미사: ${match[1]} (01|002|0015|001)`);
  }
  if (isDry) {
    const reps = Math.max(1, Math.round(1 / secs));
    return ["started()", `for _ in range(${reps}): time.sleep(${secs})`];
  }
  return ["started()", `while True: time.sleep(${secs})`];
}

const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(3));
};

/** 표준 트레이스백 형식(사용자 프레임 하나, `<console>`). 콘솔 인스턴스를 시행마다 새로 만들지 않으므로(속도) 줄
 * 번호는 시행마다 증가한다 — 그래서 고정 문자열이 아니라 형태를 정규식으로 본다. */
const TRACEBACK_SHAPE =
  /^Traceback \(most recent call last\):\n {2}File "<console>", line \d+, in <module>\nKeyboardInterrupt\n$/;

async function runRealTrial(program) {
  screen = { stdout: "", stderr: "" };
  firstStderrAt = undefined;
  startedAtMain = undefined;
  Atomics.store(ctl, 0, 0);
  discardPendingInterrupt(buffer);

  const delayMs = pressMin + Math.random() * (pressMax - pressMin);
  ensurePresser();
  const pressed = nextPresserMessage();
  presser.postMessage({
    kind: "press",
    offsets: [delayMs],
    waitStarted: true,
  });

  let result;
  for (const line of programLines(program, false)) {
    result = await runner.run(line);
  }
  if (result.prompt === PS2) result = await runner.run("");

  const doneAt = process.hrtime.bigint();
  const pressEvent = await pressed;
  if (pressEvent.kind !== "pressed") {
    throw new Error(`눌림 스레드가 시작 신호를 못 받았다: ${JSON.stringify(pressEvent)}`);
  }
  if (startedAtMain === undefined) {
    throw new Error("started()가 불리지 않았다(프로그램 배선을 확인해라)");
  }
  const pressAt = startedAtMain + BigInt(Math.round(pressEvent.atMs[0] * 1e6));
  const interrupted = screen.stderr.includes("KeyboardInterrupt");
  const latencyMs = interrupted
    ? Number((firstStderrAt ?? doneAt) - pressAt) / 1e6
    : null;
  const exactMatch = TRACEBACK_SHAPE.test(screen.stderr);
  return {
    requestedDelayMs: Number(delayMs.toFixed(1)),
    actualDelayMs: pressEvent.atMs[0],
    interrupted,
    latencyMs: latencyMs === null ? null : Number(latencyMs.toFixed(3)),
    exactMatch,
    extraStderr: interrupted && !exactMatch,
    stderr: screen.stderr,
  };
}

async function runDryTrial(program) {
  screen = { stdout: "", stderr: "" };
  firstStderrAt = undefined;
  Atomics.store(ctl, 0, 0);
  discardPendingInterrupt(buffer);

  let result;
  for (const line of programLines(program, true)) {
    result = await runner.run(line);
  }
  if (result.prompt === PS2) result = await runner.run("");

  const interrupted = screen.stderr.includes("KeyboardInterrupt");
  return { interrupted, stderr: screen.stderr };
}

mkdirSync(RESULTS_DIR, { recursive: true });

if (dry) {
  const perProgram = {};
  let totalInterrupted = 0;
  let totalTrials = 0;
  for (const program of progNames) {
    const trials = [];
    for (let i = 0; i < n; i += 1) {
      const trial = await runDryTrial(program);
      trials.push(trial);
      if (trial.interrupted) totalInterrupted += 1;
      totalTrials += 1;
    }
    const interruptedCount = trials.filter((t) => t.interrupted).length;
    perProgram[program] = {
      n,
      interruptedCount,
      noStopCount: n - interruptedCount,
      pass: interruptedCount === 0,
    };
    process.stderr.write(
      `[dry] ${program}: interrupted=${interruptedCount}/${n}\n`,
    );
  }
  const report = {
    scenario: "dry",
    mode,
    n,
    programs: perProgram,
    totalInterrupted,
    totalTrials,
    pass: totalInterrupted === 0,
  };
  writeFileSync(path.join(RESULTS_DIR, `node-sleep-${mode}-dry.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} else {
  const perProgram = {};
  for (const program of progNames) {
    const trials = [];
    for (let i = 0; i < n; i += 1) {
      const trial = await runRealTrial(program);
      trials.push(trial);
      if ((i + 1) % 10 === 0 || i === n - 1) {
        process.stderr.write(
          `[${mode}] ${program}: ${i + 1}/${n} interrupted=${
            trials.filter((t) => t.interrupted).length
          }\n`,
        );
      }
    }
    const interruptedCount = trials.filter((t) => t.interrupted).length;
    const exactMatchCount = trials.filter((t) => t.exactMatch).length;
    const extraStderrCount = trials.filter((t) => t.extraStderr).length;
    const latencies = trials
      .map((t) => t.latencyMs)
      .filter((v) => v !== null);
    const over200 = latencies.filter((v) => v > 200).length;
    perProgram[program] = {
      n,
      interruptedCount,
      exactMatchCount,
      extraStderrCount,
      over200,
      latencyMs: {
        median: percentile(latencies, 0.5),
        p90: percentile(latencies, 0.9),
        max: latencies.length ? Number(Math.max(...latencies).toFixed(3)) : null,
      },
      pass:
        interruptedCount === n &&
        exactMatchCount === n &&
        extraStderrCount === 0 &&
        over200 === 0,
      trials,
    };
  }
  const totals = Object.values(perProgram).reduce(
    (acc, p) => ({
      n: acc.n + p.n,
      interruptedCount: acc.interruptedCount + p.interruptedCount,
      exactMatchCount: acc.exactMatchCount + p.exactMatchCount,
      extraStderrCount: acc.extraStderrCount + p.extraStderrCount,
      over200: acc.over200 + p.over200,
    }),
    { n: 0, interruptedCount: 0, exactMatchCount: 0, extraStderrCount: 0, over200: 0 },
  );
  const report = {
    scenario: "sleep-stats",
    mode,
    pressRangeMs: [pressMin, pressMax],
    programs: perProgram,
    totals,
    pass:
      totals.interruptedCount === totals.n &&
      totals.exactMatchCount === totals.n &&
      totals.extraStderrCount === 0 &&
      totals.over200 === 0,
    warnings,
  };
  writeFileSync(path.join(RESULTS_DIR, `node-sleep-${mode}.json`), `${JSON.stringify(report, null, 2)}\n`);
  // trials 상세는 파일에만 남기고 콘솔에는 요약만 낸다(N=30×5=150줄은 너무 길다).
  const summary = {
    ...report,
    programs: Object.fromEntries(
      Object.entries(perProgram).map(([name, p]) => {
        const { trials: _trials, ...rest } = p;
        return [name, rest];
      }),
    ),
  };
  console.log(JSON.stringify(summary, null, 2));
}

if (presser) await presser.terminate();
