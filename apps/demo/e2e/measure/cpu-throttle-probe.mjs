// CPU 감속(`Emulation.setCPUThrottlingRate`)이 메인 스레드와 pyodide worker에 각각 얼마나 적용되는지 잰다(기록용 프로브).
// 이슈 `.scratch/e2e-time-dependence/issues/03-cpu-throttle-probe.md`의 미검증 가정("worker에도 걸리는가")을 수치로 확정한다.
// 판정 스크립트가 아니다: 통과/실패 상한을 두지 않는다(`docs/design/09-testing.md` 9.7 6항). 아래 "적용 ○/×"는 콘솔·결과 JSON `notes`에
// 남기는 기록이며 종료 코드에 영향을 주지 않는다(종료 코드는 pageErrors 0과 표본 수집 완료 여부만 본다).
// `run.mjs`의 `SETS`·`MEASURE_SET`에는 등록하지 않는다(L2·L3 상시 비용을 만들지 않는다). `pnpm --filter demo e2e:cpu-throttle`로 손으로 돌린다.
//
// 절차: 한 페이지 안에서 rate 1 → 2 → 4 → 8 순으로 CDP 감속 배율을 바꾸며, rate마다 4회 실행하고 첫 회(전환 뒤 워밍)는 버려
// 표본 3회의 중앙값을 낸다. rate마다 세 경로를 잰다.
//   1. 메인 스레드: `page.evaluate` 안의 **고정 작업량** 바쁜 루프. 반복 수는 rate 1에서 약 200ms가 되도록 보정한다.
//   2. worker 고정 작업량: `for _ in range(n): pass`(n은 rate 1에서 약 300ms가 되도록 보정). 소요는 Enter `keydown`부터 프롬프트 복귀까지.
//   3. worker 시간 한정: 지시받은 형태(`t=time.time()` / `while time.time()-t<0.5: pass`)에 반복 횟수 세기를 더한 것.
//
// 설계 결정 — 고정 작업량을 쓰는 이유: 시간에 묶인 루프(`while time.time()-t < 0.5`, `while performance.now()-t < 200`)는 CPU가
// 느려져도 벽시계로 항상 0.5초·0.2초에 끝난다. 소요를 재면 감속이 걸려도 안 걸려도 같은 값이라 적용 여부를 못 가린다. 그래서 (a)
// 고정 작업량의 소요와 (b) 시간 한정 루프에서 센 반복 횟수(감속되면 줄어든다)를 함께 기록한다. 3번은 (b)이며 벽시계 소요도
// 같이 남겨 "0.5초 근처에 그대로"임을 보인다.
//
// 시계: 소요는 **페이지 시계**(`performance.now()`: Enter `keydown` 캡처 → 프롬프트 행 출현 `MutationObserver`)로 잰다. CPU 감속은
// 실행 속도만 늦추고 시각 자체(`performance.now()`)를 늦추지 않으며, Node↔페이지 CDP 왕복(폴링·evaluate)이 섞이지 않는다(TRP-022).
// 참고 열로 Node 시계(`perf_hooks`, Enter 직전 ~ 복귀 감지 뒤)와 Python 쪽 `time.perf_counter()` 차(worker 안 순수 루프 시간, 메인
// 스레드 렌더 지연이 섞이지 않는다)를 같이 남긴다. 메인 스레드는 감속되는데 worker가 아니면 페이지 시계 소요에 메인 렌더 지연이
// 섞여 worker가 느려진 것처럼 보일 수 있으므로, 판정이 갈리면 Python 쪽 열로 교차 확인한다.
//
// 감속 적용: 이 프로브가 rate를 스스로 바꾸므로 `lib.mjs`의 `E2E_CPU_THROTTLE` 자동 적용과 충돌하지 않게 시작 전에 그 환경변수를
// 지운다(값이 있었으면 경고). 프로브는 자체 CDP 세션(`page.context().newCDPSession(page)`)으로 rate를 보낸다. `lib.mjs`는 수정하지 않는다.
//
// 사용: node cpu-throttle-probe.mjs <url>(생략 시 http://localhost:5173)   RUNS=<정수>(rate당 실행 수, 기본 4, 첫 회는 버림)
// 결과 파일 label은 url 포트 4173이면 preview, 그 밖은 dev(RD-018 DELTA-02 결정과 같은 규칙).
import { performance } from "node:perf_hooks";
import { open } from "../lib.mjs";

const url = process.argv[2] ?? "http://localhost:5173";
const RATES = [1, 2, 4, 8];
const RUNS = Number(process.env.RUNS ?? 4);
if (!Number.isInteger(RUNS) || RUNS < 2) throw new Error(`RUNS=${process.env.RUNS}는 2 이상의 정수여야 한다(첫 회는 버린다)`);
const label = url.includes(":4173") ? "preview" : "dev";

// lib.mjs가 open()에서 이 환경변수를 읽어 첫 프롬프트 뒤 감속을 자동 적용한다. 프로브는 rate를 직접 정하므로 끈다.
if (process.env.E2E_CPU_THROTTLE !== undefined) {
  console.warn(`경고: E2E_CPU_THROTTLE=${process.env.E2E_CPU_THROTTLE}는 이 프로브가 무시한다(rate를 스스로 1/2/4/8로 바꾼다)`);
  delete process.env.E2E_CPU_THROTTLE;
}

const h = await open(url);
const { page, waitPrompt, waitFor, rows, submit, clear, type, press, step } = h;
await waitPrompt(">>>", 60000);
await h.focus();
const cdp = await page.context().newCDPSession(page);
const setRate = (rate) => cdp.send("Emulation.setCPUThrottlingRate", { rate });

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
/** 중앙값. 표본이 없으면 null. */
function median(a) {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
/** 워밍(각 rate 첫 회)을 버리고 중앙값을 낸다. */
const medianAfterWarmup = (a) => median(a.slice(1));

// ── 메인 스레드 경로 ─────────────────────────────────────────────────────────────
/** 페이지 메인 스레드에서 고정 반복 수 `n`의 바쁜 루프를 돌리고 페이지 시계 소요(ms)를 돌려준다. */
const mainBusy = (n) =>
  page.evaluate((count) => {
    const t0 = performance.now();
    let x = 0;
    for (let i = 0; i < count; i += 1) x += Math.sqrt(i);
    const t1 = performance.now();
    return { ms: t1 - t0, sink: x > 0 };
  }, n);
/** rate 1에서 `targetMs`쯤 걸리는 반복 수를 구한다(첫 실행은 JIT 워밍이라 버린다). */
async function calibrateMain(targetMs) {
  let n = 2_000_000;
  for (let i = 0; i < 3; i += 1) {
    const { ms } = await mainBusy(n);
    n = Math.max(100_000, Math.round((n * targetMs) / Math.max(ms, 1) / 100_000) * 100_000);
  }
  return n;
}

// ── worker 경로(REPL 프롬프트에 소스를 제출) ──────────────────────────────────────────
// `exec`로 함수 두 개를 한 번씩 정의한다(여러 줄 블록의 자동 들여쓰기를 피한다). 출력 행은 `PY <초>`·`PN <횟수>`이며 입력 줄은
// `>>> `로 시작하므로 `^PY `·`^PN `에 걸리지 않는다.
//   w(n): 고정 작업량 n번 반복한 시간(Python 쪽 시계). b(x): x초 동안 반복 횟수를 센다(지시받은 `while time.time()-t<0.5: pass` 형태).
// 입력 줄이 터미널 열 수(80)를 넘어 감기면 `type()`이 커서 행 끝 10글자를 못 찾아 시간 초과가 난다(첫 실행 실패 원인, 실측). 그래서
// 모든 입력 줄을 `MAX_LINE`자 이하로 유지하고 `submitLine()`이 그것을 강제한다.
const MAX_LINE = 70;
const IMPORTS = "from time import time as q, perf_counter as p";
const DEF_W = `exec("def w(n):\\n s=p()\\n for _ in range(n):pass\\n print('PY',p()-s)")`;
const DEF_B = `exec("def b(x):\\n s=q()\\n n=0\\n while q()-s<x:n+=1\\n print('PN',n)")`;
/** 한 줄 입력을 제출한다. 감기는 길이면 던진다(위 설명). */
async function submitLine(source) {
  if (source.length > MAX_LINE) throw new Error(`입력 줄 ${source.length}자 > ${MAX_LINE}자(터미널 80열에서 감긴다): ${source}`);
  await submit(source);
}

/** 페이지 안에 "Enter 키 눌림 → 프롬프트 행 복귀" 시계를 심는다(한 번). */
async function installPromptClock() {
  await page.evaluate(() => {
    const root = document.querySelector(".xterm-rows");
    const text = (el) => (el.textContent ?? "").replace(/ /g, " ").replace(/\s+$/, "");
    window.__cp = { startedAt: null, readyAt: null };
    window.__cpArm = () => {
      window.__cp = { startedAt: null, readyAt: null };
    };
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Enter" && window.__cp.startedAt == null) window.__cp.startedAt = performance.now();
      },
      true,
    );
    const check = () => {
      const cp = window.__cp;
      // Enter를 누른 뒤에만 본다. 그 전의 낡은 `>>>` 행에 통과하지 않는다(TRP-005).
      if (cp.startedAt == null || cp.readyAt != null) return;
      const els = [...root.querySelectorAll(":scope > div")];
      let last = els.length - 1;
      while (last >= 0 && text(els[last]) === "") last -= 1;
      if (last >= 0 && text(els[last]) === ">>>" && els[last].querySelector(".xterm-cursor")) cp.readyAt = performance.now();
    };
    new MutationObserver(check).observe(root, { childList: true, subtree: true, characterData: true });
  });
}

/**
 * 소스 한 줄을 제출하고 프롬프트 복귀까지의 소요를 잰다. 화면을 먼저 지워 이전 출력 행이 남지 않게 한다.
 * 반환: `{ pageMs, nodeMs, out }`. `out`은 `out` 정규식에 걸린 출력 행의 캡처(없으면 null).
 */
async function runWorker(source, outRe) {
  await clear();
  await type(source);
  await page.evaluate(() => window.__cpArm());
  const nodeStart = performance.now();
  await press("Enter");
  await waitFor(async () => (await page.evaluate(() => window.__cp.readyAt)) != null, `worker 소스 ${source} 뒤 프롬프트 복귀`, 120000, 20);
  const nodeMs = performance.now() - nodeStart;
  const cp = await page.evaluate(() => window.__cp);
  let out = null;
  for (const row of await rows()) {
    const m = outRe.exec(row);
    if (m) out = Number(m[1]);
  }
  return { pageMs: cp.readyAt - cp.startedAt, nodeMs, out };
}

// ── 준비(rate 1, 감속 없음) ──────────────────────────────────────────────────────
await installPromptClock();
await submitLine(IMPORTS);
await submitLine(DEF_W);
await submitLine(DEF_B);
const mainN = await calibrateMain(200);
// worker 고정 작업량 보정: 워밍 1회 뒤 Python 쪽 시계로 300ms쯤 되게 한다.
let workerN = 1_000_000;
for (let i = 0; i < 3; i += 1) {
  const { out } = await runWorker(`w(${workerN})`, /^PY (\d+(?:\.\d+)?)$/);
  if (out == null) throw new Error("worker 보정: PY 출력 행을 찾지 못했다");
  workerN = Math.max(100_000, Math.round((workerN * 0.3) / Math.max(out, 0.001) / 100_000) * 100_000);
}
console.log(`보정: 메인 반복 수 ${mainN}(rate 1에서 ~200ms), worker 반복 수 ${workerN}(rate 1에서 ~300ms)`);

// ── rate 스윕 ─────────────────────────────────────────────────────────────────
/** rate별 원시 표본. `[rate]: { main: [ms], wFix: [ms], wFixNode: [ms], wFixPy: [ms], wBoundWall: [ms], wBoundCount: [n] }` */
const samples = {};
try {
  for (const rate of RATES) {
    await step(`R${rate}`, async () => {
      const s = { main: [], wFix: [], wFixNode: [], wFixPy: [], wBoundWall: [], wBoundCount: [] };
      samples[rate] = s;
      await setRate(rate);
      for (let i = 0; i < RUNS; i += 1) s.main.push((await mainBusy(mainN)).ms);
      for (let i = 0; i < RUNS; i += 1) {
        const r = await runWorker(`w(${workerN})`, /^PY (\d+(?:\.\d+)?)$/);
        s.wFix.push(r.pageMs);
        s.wFixNode.push(r.nodeMs);
        s.wFixPy.push((r.out ?? Number.NaN) * 1000);
      }
      for (let i = 0; i < RUNS; i += 1) {
        const r = await runWorker("b(0.5)", /^PN (\d+)$/);
        s.wBoundWall.push(r.pageMs);
        s.wBoundCount.push(r.out ?? Number.NaN);
      }
    });
  }
} finally {
  // 이후 finish()의 화면 읽기가 감속에 휘둘리지 않게 되돌린다.
  await setRate(1).catch(() => {});
}

// ── 집계·기록 ─────────────────────────────────────────────────────────────────
const table = RATES.filter((rate) => samples[rate]).map((rate) => {
  const s = samples[rate];
  return {
    rate,
    mainMs: r1(medianAfterWarmup(s.main)),
    workerFixedPageMs: r1(medianAfterWarmup(s.wFix)),
    workerFixedNodeMs: r1(medianAfterWarmup(s.wFixNode)),
    workerFixedPyMs: r1(medianAfterWarmup(s.wFixPy)),
    workerBoundedWallMs: r1(medianAfterWarmup(s.wBoundWall)),
    workerBoundedCount: medianAfterWarmup(s.wBoundCount),
  };
});
const base = table.find((row) => row.rate === 1);
/** rate 1 대비 배율. 값이 없으면 null. `invert`는 작을수록 느린 지표(반복 횟수)용. */
const ratio = (row, key, invert = false) => {
  if (!base || base[key] == null || row[key] == null || base[key] === 0 || row[key] === 0) return null;
  const q = invert ? base[key] / row[key] : row[key] / base[key];
  return Math.round(q * 100) / 100;
};
for (const row of table) {
  row.ratio = {
    main: ratio(row, "mainMs"),
    workerFixedPage: ratio(row, "workerFixedPageMs"),
    workerFixedNode: ratio(row, "workerFixedNodeMs"),
    workerFixedPy: ratio(row, "workerFixedPyMs"),
    workerBoundedCount: ratio(row, "workerBoundedCount", true),
  };
}
const at = (rate) => table.find((row) => row.rate === rate);
/** 판정(기록용). 메인: rate 4에서 2배 이상이면 ○(명목의 절반 이상), 각 rate가 명목의 0.5~1.5배면 "비례". worker: rate 4에서 2배 이상 ○, 1.25배 이하 ×, 사이는 불명확. */
function judge() {
  const r4 = at(4);
  if (!r4) return { main: "판정 불가(rate 4 표본 없음)", worker: "판정 불가(rate 4 표본 없음)", note: "" };
  const proportional = [2, 4, 8].every((rate) => {
    const q = at(rate)?.ratio.main;
    return q != null && q >= rate * 0.5 && q <= rate * 1.5;
  });
  const mainOk = r4.ratio.main != null && r4.ratio.main >= 2;
  const main = r4.ratio.main == null ? "판정 불가" : mainOk ? (proportional ? "메인 적용 ○ (rate에 비례)" : "메인 적용 ○ (비례 아님)") : "메인 적용 ×";
  const workerOf = (q) => (q == null ? "판정 불가" : q >= 2 ? "○" : q <= 1.25 ? "×" : "불명확");
  const page4 = workerOf(r4.ratio.workerFixedPage);
  const py4 = workerOf(r4.ratio.workerFixedPy);
  const cnt4 = workerOf(r4.ratio.workerBoundedCount);
  const note = `교차 확인(rate 4): 페이지 시계 ${page4}, Python 시계 ${py4}, 시간 한정 루프 반복 횟수 ${cnt4}${page4 === py4 && py4 === cnt4 ? " — 일치" : " — 불일치(메인 렌더 지연이 섞였는지 확인)"}`;
  return { main, worker: `worker 적용 ${page4}`, note };
}
const verdict = judge();

const pad = (v, w) => String(v ?? "-").padStart(w);
console.log(`\n=== CPU 감속 프로브 결과(중앙값, rate당 ${RUNS - 1}회, 첫 회 버림) ===`);
console.log(
  `${pad("rate", 4)} | ${pad("main ms", 8)} | ${pad("w고정 page", 10)} | ${pad("w고정 node", 10)} | ${pad("w고정 py", 9)} | ${pad("w한정 wall", 10)} | ${pad("w한정 횟수", 11)} | rate1 대비 main/wPage/wPy/wCount`,
);
for (const row of table) {
  console.log(
    `${pad(row.rate, 4)} | ${pad(row.mainMs, 8)} | ${pad(row.workerFixedPageMs, 10)} | ${pad(row.workerFixedNodeMs, 10)} | ${pad(row.workerFixedPyMs, 9)} | ${pad(row.workerBoundedWallMs, 10)} | ${pad(row.workerBoundedCount, 11)} | ${row.ratio.main}/${row.ratio.workerFixedPage}/${row.ratio.workerFixedPy}/${row.ratio.workerBoundedCount}`,
  );
}
console.log(`판정(기록, 종료 코드와 무관): ${verdict.main} / ${verdict.worker}`);
console.log(verdict.note);

// 결과 JSON `notes`에 표와 판정을 남긴다. `E2E_CPU_THROTTLE`은 lib가 1로 기록한다(프로브가 rate를 직접 바꾸므로 그 값은 의미 없다).
h.notes.probe = {
  rates: RATES,
  runsPerRate: RUNS,
  discardedPerRate: 1,
  calibration: { mainIterations: mainN, workerIterations: workerN },
  clock: "페이지 시계(performance.now, Enter keydown → 프롬프트 행 복귀 MutationObserver). Node 시계·Python 시계는 참고 열",
  table,
  verdict,
};
const ok = await h.finish({ label, probe: { table, verdict, samples } });
process.exit(ok ? 0 : 1);
