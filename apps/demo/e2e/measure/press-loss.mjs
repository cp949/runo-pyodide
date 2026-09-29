// RD-007 브라우저 단일 눌림 소실 측정.
// `while True: pass` 실행 중 Ctrl+C 한 번이 항상 프롬프트를 돌려주는지 N회 반복한다.
// 소실이 남으면 프롬프트가 돌아오지 않는다(HANG).
// `node/rd-007/press-loss.mjs`가 같은 것을 통계로 본다. 이 스크립트는 실제 브라우저의 폴링·worker 경합에서 본다.
//
// 시행 분류:
// - OK: 프롬프트가 돌아왔다.
// - HANG_RECOVERED: 돌아오지 않았지만 Ctrl+C를 한 번 더 누르니 돌아왔다(소실).
// - HANG_STUCK: 한 번 더 눌러도 돌아오지 않는다. 이 시행에서 반복을 멈춘다.
// 판정: HANG이 0이면 통과한다(종료 코드는 `hangs === 0`). 기준의 출처는 RD-007이다.
//
// 출처 RD-007에서 이관(RD-018). 사용법은 `apps/demo/e2e/README.md`.
// 결과 파일 label은 url에 `:4173`이 있으면 preview, 그 밖은 dev다.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../lib.mjs";

const url = process.argv[2] ?? "http://localhost:5173";
/** 시행 수. 기본 200. */
const trials = Number(process.env.N ?? 200);
const results = [];

const measureDir = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = process.env.E2E_RESULTS_DIR ?? path.join(measureDir, "..", "results");
const label = url.includes(":4173") ? "preview" : "dev";

const h = await open(url);
const { waitPrompt, waitPromptTail, clear, type, enter, rows, cursorRow, focus, ctrlC, startBlockLine, countTracebacks, page } = h;

await waitPrompt(">>>", 60000);
await focus();

/** 마지막 텍스트 행이 프롬프트로 끝나고 커서가 그 행에 있는지 한 번만 본다(대기하지 않는다). */
async function atPrompt() {
  const all = await rows();
  let last = all.length - 1;
  while (last >= 0 && all[last] === "") last -= 1;
  return last >= 0 && all[last].endsWith(">>>") && (await cursorRow()) === last;
}

let hangs = 0;
let probeRecovered = 0;
const returnMs = [];
const started = Date.now();

for (let trial = 0; trial < trials; trial += 1) {
  await clear();
  // 복합문 한 줄은 빈 줄 Enter가 있어야 실행이 시작된다(3.14 REPL과 같다).
  await startBlockLine("while True: pass");
  // 눌림 시각을 폴링 위상과 어긋나게 흩뿌린다.
  await page.waitForTimeout(300 + Math.random() * 200);
  const pressAt = Date.now();
  await ctrlC();
  let outcome = "OK";
  try {
    await waitPromptTail(8000);
    returnMs.push(Date.now() - pressAt);
  } catch {
    // 프롬프트가 돌아오지 않았다. 한 번 더 눌러 회복되는지 본다. 소실이면 회복된다.
    outcome = "HANG";
    hangs += 1;
    await ctrlC();
    try {
      await waitPromptTail(4000);
      probeRecovered += 1;
      outcome = "HANG_RECOVERED";
    } catch {
      outcome = "HANG_STUCK";
    }
  }
  const tracebacks = await countTracebacks();
  results.push({ trial, outcome, ms: Date.now() - pressAt, tracebacks });
  if (outcome !== "OK") console.log(`  #${trial} ${outcome}`);
  if (outcome === "HANG_STUCK") break;
  // 50회마다 세션이 살아 있는지 확인한다.
  if ((trial + 1) % 50 === 0) {
    await clear();
    await type("1+1");
    await enter();
    await waitPrompt(">>>");
    const all = (await rows()).filter((r) => r !== "");
    if (all.at(-2) !== "2") throw new Error(`건강 확인 실패: ${JSON.stringify(all.slice(-4))}`);
    console.log(`  ${trial + 1}/${trials} hangs=${hangs}`);
  }
}

const sorted = [...returnMs].sort((a, b) => a - b);
const summary = {
  url,
  trials,
  completed: results.length,
  hangs,
  probeRecovered,
  stuck: results.filter((r) => r.outcome === "HANG_STUCK").length,
  dirtyTracebacks: results.filter((r) => r.tracebacks !== 1).length,
  returnMs: {
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    p99: sorted[Math.floor(sorted.length * 0.99)] ?? null,
    max: sorted.at(-1) ?? null,
  },
  pageErrors: h.otherPageErrors().length,
  pageErrorSample: h.otherPageErrors().slice(0, 3),
  webLoopReraises: h.pageErrors.length - h.otherPageErrors().length,
  problemLogs: h.problemLogs().slice(0, 5),
  seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
};
mkdirSync(resultsDir, { recursive: true });
writeFileSync(
  path.join(resultsDir, `press-loss-${trials}-${label}.json`),
  `${JSON.stringify({ summary, results }, null, 2)}\n`,
);
await h.browser.close();
console.log(JSON.stringify(summary, null, 2));
process.exit(hangs === 0 ? 0 : 1);
