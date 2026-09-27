/**
 * 폴링 비용(TRP-024). pyodide는 바이트코드 약 50개마다 interrupt buffer의 [0]을 읽는다. 그 경로에 접근자·
 * Proxy가 끼면 Python 실행이 통째로 느려진다. 우리 배선(`createInterruptBuffer` + `attachRuntime`)이 진짜
 * `Int32Array`를 그대로 넘기는지 실행 시간으로 확인한다. 출처 RD-007,
 * `_works/_completed/20260922-07-rd-007-ctrl-c-running/verify/node/`에서 이관(RD-018 DELTA-04).
 *
 * 모드: `plain`(맨 `Int32Array`를 `setInterruptBuffer`) · `plain2`(같은 것, 잡음 대조) · `repo`(저장소 배선 전체).
 * 워밍업 뒤 ABAB로 교차 측정해 중앙값 비율을 낸다. 통과: `repo`의 두 비율이 1.03 이내.
 *
 * 사용(레포 루트에서):
 *   node --import packages/pyodide-testkit/src/ts-resolve-hook.mjs apps/demo/e2e/node/rd-007/poll-overhead.mjs [--rounds 10]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
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
const { createInterruptBuffer } = await import(
  new URL("../pyodide-core/src/protocol/interrupt-protocol.ts", REPO).href
);

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (pairs, value, index, all) =>
        index % 2 === 0 ? [...pairs, [value.slice(2), all[index + 1]]] : pairs,
      [],
    ),
);
const rounds = Number(args.rounds ?? 10);
/** 정수 루프 반복 수. 순수 바이트코드라 폴링 빈도가 가장 높은 형태다. */
const LOOP_N = 3_000_000;
/** `str(i)` 루프 반복 수. 할당·객체 생성이 섞인 형태다. */
const STR_N = 300_000;

const pyodide = await loadPyodide();
// 콘솔은 연결에 필요하다(핸들러가 `console.filename`·`formattraceback`을 쓴다). 측정은 `runPython`으로 한다.
const repl = createConsole(
  pyodide,
  { write() {}, writeErrorRaw() {} },
  { topLevelAwait: false },
);

pyodide.runPython(`
def loop_i(n):
    i = 0
    while i < n:
        i += 1
    return i

def str_loop(n):
    total = 0
    for i in range(n):
        total += len(str(i))
    return total
`);

const detach = () =>
  pyodide.setInterruptBuffer(
    /** @type {never} */ (/** @type {unknown} */ (undefined)),
  );

/** 모드마다 interrupt buffer를 붙이는 방식이 다르다. `repo`만 저장소 배선을 전부 지난다. */
function attach(mode) {
  detach();
  if (mode === "repo") {
    const buffer = createInterruptBuffer();
    // attachRuntime은 WebLoop 재보고 억제도 한다(연결 자체는 이전과 같다). 이 측정은 재보고 여부와 무관하다.
    attachRuntime(pyodide, repl.pyconsole, {
      interruptBuffer: buffer,
      stdin: { requestInput: () => {}, wait: () => null },
      report: (id, detail) => console.warn(`[degraded] ${id}: ${detail}`),
    });
    return buffer;
  }
  const buffer = new Int32Array(new SharedArrayBuffer(16));
  pyodide.setInterruptBuffer(buffer);
  return buffer;
}

function measure(call) {
  const started = process.hrtime.bigint();
  pyodide.runPython(call);
  return Number(process.hrtime.bigint() - started) / 1e6;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const MODES = ["plain", "plain2", "repo"];
const samples = Object.fromEntries(MODES.map((mode) => [mode, { loop: [], str: [] }]));

// 워밍업(JIT·캐시). 결과는 버린다.
for (const mode of MODES) {
  attach(mode);
  measure(`loop_i(${LOOP_N})`);
  measure(`str_loop(${STR_N})`);
}

for (let round = 0; round < rounds; round += 1) {
  // 교차 순서: 시간에 따라 드리프트하는 잡음이 한 모드에 몰리지 않게 한다.
  const order = round % 2 === 0 ? MODES : [...MODES].reverse();
  for (const mode of order) {
    attach(mode);
    samples[mode].loop.push(measure(`loop_i(${LOOP_N})`));
    samples[mode].str.push(measure(`str_loop(${STR_N})`));
  }
  process.stderr.write(`  round ${round + 1}/${rounds}\n`);
}
detach();

const medians = Object.fromEntries(
  MODES.map((mode) => [
    mode,
    { loop: median(samples[mode].loop), str: median(samples[mode].str) },
  ]),
);
const report = {
  rounds,
  loopN: LOOP_N,
  strN: STR_N,
  medianMs: medians,
  ratios: {
    // 잡음 대조: 같은 배선끼리의 비율. 1에서 얼마나 벗어나는지가 측정 잡음의 크기다.
    plain2: {
      loop: Number((medians.plain2.loop / medians.plain.loop).toFixed(4)),
      str: Number((medians.plain2.str / medians.plain.str).toFixed(4)),
    },
    repo: {
      loop: Number((medians.repo.loop / medians.plain.loop).toFixed(4)),
      str: Number((medians.repo.str / medians.plain.str).toFixed(4)),
    },
  },
};
report.pass = report.ratios.repo.loop <= 1.03 && report.ratios.repo.str <= 1.03;

mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(path.join(RESULTS_DIR, "node-poll-overhead.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
