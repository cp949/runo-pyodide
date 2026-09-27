// RD-012 DELTA-04 브라우저 지연 측정. RD-009 `sleep-await-check.mjs`
// (`_works/_completed/20260922-09-rd-009-idle-ctrl-c/verify/sleep-await-check.mjs`) 사본에 TLA 셀 4개
// (`await5`·`awaitloop`·`tla-sleep-0.1`·`tla-burst`)를 더했다. 측정 전용(판정선 재측정은 이 DELTA 범위 밖).
//
// 비TLA 12셀은 RD-009 원본과 동일(재현 확인용 기준선). TLA 4셀은 `tla: true`를 달고 있고, 셀 실행 순서를
// `tla` 거짓 → 참으로 정렬해 TLA 스위치 전환이 총 1번만 일어나게 한다(전환마다 세션 리셋이라 비용이 크다).
// `awaitloop`은 `either` 판정(`line` 규칙 또는 `tb1` 규칙 중 하나 통과)이라 셀별로 어느 가지를 탔는지
// `branches: { line, tb1 }`로 센다(비율 판정 없음, 기록용).
//
// 출처 RD-012(canonical, 16셀판), `_works/_completed/20260923-13-rd-012-top-level-await/verify/`에서
// 이관(RD-018 DELTA-04). 결과 파일 쓰기는 자기 `results/sleep-await-dev.json` 직접 쓰기에서 `finish({ label })`
// 기준(`E2E_RESULTS_DIR`)으로 통일했다 — 셀별 `{n, passed, median, max, pageErrors, tla, form}` 내용은 불변.
//
// 사용: node sleep-await-check.mjs <url>(생략 시 http://localhost:5173)     (16셀 × N=20 = 320회, 오래 걸린다)
//       ONLY=await5,awaitloop N=5 node sleep-await-check.mjs <url>   (일부 셀만, 시행 수 줄임)
//
// 셀별로: pre(가져오기·함수 정의, 셀 시작 시 1회) → N회 반복(run 제출 → 지정 시각에 Ctrl+C → 복귀 대기).
// 복귀 시각(TRP-005 취지 유지, 측정 정밀도는 페이지 내부 시계로): Node 쪽 `keyboard.press` 직전 시각 대신 페이지
// 안에 심은 keydown 리스너의 실제 `Ctrl+c` 타임스탬프(다중 눌림은 마지막 눌림, 연타는 첫 눌림)를 쓰고, 복귀 시각도
// 페이지 안 MutationObserver가 마지막 텍스트 행이 `>>>`(커서 포함)로 바뀐 순간을 잡는다 — 같은 시계라 Node↔페이지
// CDP 왕복(각 폴링마다 evaluate 2회, 스크래치 진단 실측 +5~8ms)이 측정값에 섞이지 않는다. 폴링(`waitPromptAt`)은
// "언제 다음 단계로 넘어가도 되는지"(정확성 게이트)에만 쓰고 통계에는 페이지 내부 타임스탬프를 쓴다.
// 형식 판정은 셀 종류별로 다르다(아래 `checkForm`).
// 우리 프레임 검사: 화면에 `<sigint-handler>`·`<sleep-slice>`·`webloop.py`·`<webloop-reraise>` 없음.
// 결과 파일 label은 url 포트 4173이면 preview, 그 밖은 dev(RD-018 DELTA-02 결정과 같은 규칙).
import { performance } from "node:perf_hooks";
import { open, same, show } from "../lib.mjs";

const url = process.argv[2] ?? "http://localhost:5173";
const N = Number(process.env.N ?? 20);
const ONLY = (process.env.ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const label = url.includes(":4173") ? "preview" : "dev";

// KeyboardInterrupt를 잡고 3회 세는 함수(계획서 CATCHER 예시 그대로, n·dl은 지역 변수라 호출마다 새로 돈다).
// RD-018 DELTA-04: RD-013 자동 들여쓰기 프리필과 겹치므로(DELTA-02 `ctrl-c-check.mjs`와 같은 원인 — 코드는 안
// 바뀌었는데 이관한 스크립트가 dev에서 실패해 낡은 입력 가정으로 판정, 판정 문자열·로직은 불변) 본문 줄은
// 들여쓰기 없이 그대로 치고(프리필이 이미 그 레벨), dedent가 필요한 줄만 `{ line, dedent }`로 Backspace 횟수를
// 명시한다(DELTA-02가 실측한 규칙: `:`로 끝나는 줄 제출 뒤 프리필 +1단위, 아니면 유지, Backspace 1회 = 1단위 dedent).
const CATCHER_LINES = [
  "def catcher():",
  "n = 0", // 프리필(4칸)이 def 본문 레벨과 일치한다
  "dl = time.monotonic() + 30", // 같은 레벨(4) 유지
  "while time.monotonic() < dl:", // 같은 레벨(4)에서 침, 콜론이라 다음 줄은 8로 늘어난다
  "try:", // 프리필(8칸)과 일치, 콜론이라 다음 줄은 12로 늘어난다
  "time.sleep(0.5)", // 프리필(12칸)이 try 본문 레벨과 일치한다
  { line: "except KeyboardInterrupt:", dedent: 1 }, // except를 try와 같은 레벨(8)로: Backspace 1회 뒤 콜론이라 다음 줄은 12로
  "n += 1", // 프리필(12칸)이 except 본문 레벨과 일치한다
  "if n >= 3:", // 같은 레벨(12)에서 침, 콜론이라 다음 줄은 16으로 늘어난다
  "return n", // 프리필(16칸)이 if 본문 레벨과 일치한다
  { line: "return n", dedent: 3 }, // 함수 본문 레벨(4)로: Backspace 3회(16→12→8→4)
];

// offset: Enter 뒤 눌림(들) 시각(ms). loop 셀은 800~1000ms 구간에서 매 시행 무작위(주기 100ms인 sleep-0.1·arun-loop는
// 이 구간이 정확히 두 주기라 재개 직전 위상도 포함된다), 단발 셀은 1000ms 고정(계획서 "비TLA 9셀 ... 단발 셀은 1000ms 고정").
const loopOffset = () => 800 + Math.random() * 200;
const fixedOffset = () => 1000;

const CELLS = {
  "sleep-0.01": { pre: ["import time"], run: "while True: time.sleep(0.01)", block: true, kind: "single", offset: loopOffset, form: "tb1" },
  "sleep-0.1": { pre: ["import time"], run: "while True: time.sleep(0.1)", block: true, kind: "single", offset: loopOffset, form: "tb1" },
  "sleep-1": { pre: ["import time"], run: "while True: time.sleep(1)", block: true, kind: "single", offset: loopOffset, form: "tb1" },
  sleep5: { pre: ["import time"], run: "time.sleep(5)", block: false, kind: "single", offset: fixedOffset, form: "tb1" },
  arun5: { pre: ["import asyncio"], run: "asyncio.run(asyncio.sleep(5))", block: false, kind: "single", offset: fixedOffset, form: "tb1" },
  ruc5: { pre: ["import asyncio"], run: "asyncio.get_event_loop().run_until_complete(asyncio.sleep(5))", block: false, kind: "single", offset: fixedOffset, form: "tb1" },
  runsync5: { pre: ["import asyncio", "from pyodide.ffi import run_sync"], run: "run_sync(asyncio.sleep(5))", block: false, kind: "single", offset: fixedOffset, form: "tb1" },
  "arun-sleep": {
    pre: ["import time", "import asyncio", { block: ["async def main(): time.sleep(5)"] }],
    run: "asyncio.run(main())",
    block: false,
    kind: "single",
    offset: fixedOffset,
    form: "tb1",
  },
  catch3j: {
    pre: ["import time", { block: CATCHER_LINES }],
    run: "catcher()",
    block: false,
    kind: "multi",
    presses: [800, 1850, 3010],
    form: "catch3",
  },
  "arun-loop": {
    pre: ["import asyncio", { block: ["async def main():", "    while True: await asyncio.sleep(0.1)"] }],
    run: "asyncio.run(main())",
    block: false,
    kind: "single",
    offset: loopOffset,
    form: "tb1",
  },
  "runsync-sleep": {
    pre: ["import time", "import asyncio", "from pyodide.ffi import run_sync", { block: ["async def main(): time.sleep(5)"] }],
    run: "run_sync(main())",
    block: false,
    kind: "single",
    offset: fixedOffset,
    form: "tb1",
  },
  "sleep-burst": { pre: ["import time"], run: "while True: time.sleep(0.1)", block: true, kind: "burst", offset: () => 800, form: "burst" },
  // ── RD-012 TLA 셀 4개(브라우저에서만, node는 top-level-await.test.ts) ──
  await5: { tla: true, pre: ["import asyncio"], run: "await asyncio.sleep(5)", block: false, kind: "single", offset: fixedOffset, form: "line" },
  awaitloop: { tla: true, pre: ["import asyncio"], run: "while True: await asyncio.sleep(0.1)", block: true, kind: "single", offset: loopOffset, form: "either" },
  "tla-sleep-0.1": { tla: true, pre: ["import time"], run: "while True: time.sleep(0.1)", block: true, kind: "single", offset: loopOffset, form: "tb1" },
  "tla-burst": { tla: true, pre: [], run: "while True: pass", block: true, kind: "burst", offset: () => 800, burstCount: 30, form: "burst" },
};
// tla 거짓 → 참 순으로 정렬(전환마다 리셋이라 총 전환 횟수를 최소화한다). 같은 tla값 안에서는 정의 순서를 유지한다.
const orderedIds = Object.keys(CELLS).sort(
  (a, b) => Number(Boolean(CELLS[a].tla)) - Number(Boolean(CELLS[b].tla)),
);
const CELL_IDS = orderedIds.filter((id) => ONLY.length === 0 || ONLY.includes(id));
if (CELL_IDS.length === 0) {
  console.error(`ONLY=${ONLY.join(",")}가 알려진 셀과 겹치지 않는다. 셀: ${Object.keys(CELLS).join(", ")}`);
  process.exit(2);
}

const h = await open(url);
const {
  step, waitPrompt, waitFor, clear, type, enter, press, tail, rows, trimmedRows, cursorRow, focus, settled,
  ctrlC, ctrlCBurst, startBlockLine, countTracebacks, setTopLevelAwait, page,
} = h;

// 페이지 내부 타이머: Ctrl+C(`c` keydown, ctrlKey)의 실제 타임스탬프 기록 + 프롬프트 복귀 순간을 같은 시계로 잡는다.
await page.evaluate(() => {
  window.__ctrlCAt = [];
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.ctrlKey && e.key === "c") window.__ctrlCAt.push(performance.now());
    },
    true,
  );
  window.__armPrompt = () => {
    window.__promptReadyAt = null;
    const root = document.querySelector(".xterm-rows");
    const text = (el) => (el.textContent ?? "").replace(/ /g, " ").replace(/\s+$/, "");
    const check = () => {
      const rowsEls = [...root.querySelectorAll(":scope > div")];
      let last = rowsEls.length - 1;
      while (last >= 0 && text(rowsEls[last]) === "") last -= 1;
      if (last >= 0 && text(rowsEls[last]) === ">>>" && rowsEls[last].querySelector(".xterm-cursor")) {
        if (window.__promptReadyAt == null) window.__promptReadyAt = performance.now();
      }
    };
    if (window.__promptObserver) window.__promptObserver.disconnect();
    window.__promptObserver = new MutationObserver(check);
    window.__promptObserver.observe(root, { childList: true, subtree: true, characterData: true });
    check();
  };
});
/** 눌림 전에 부른다: 복귀 관측을 무장하고 이전 눌림 기록을 비운다. */
async function armMeasurement() {
  await page.evaluate(() => {
    window.__armPrompt();
    window.__ctrlCAt.length = 0;
  });
}
/** 눌림·복귀가 끝난 뒤 페이지 시계로 잰 경과(ms)를 읽는다. `which`: "last"(기본, 단발·다중 눌림의 마지막) | "first"(연타 시작). */
async function readElapsed(which = "last") {
  const r = await page.evaluate(() => ({ promptReadyAt: window.__promptReadyAt, ctrlCAt: window.__ctrlCAt.slice() }));
  const at = which === "first" ? r.ctrlCAt[0] : r.ctrlCAt.at(-1);
  return r.promptReadyAt - at;
}

const r2 = (x) => Math.round(x * 100) / 100;
const stat = (a) => {
  if (!a.length) return { median: null, max: null };
  const s = [...a].sort((x, y) => x - y);
  const med = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { median: r2(med), max: r2(s[s.length - 1]) };
};
const OUR_FRAME_RE = /<sigint-handler>|<sleep-slice>|webloop\.py|<webloop-reraise>/;

/** 프롬프트가 아닌 상태로 남아 있으면 되돌린다(RD-007 ctrl-c-check.mjs recover와 같은 판단). TLA ON에서도 같다. */
async function recover() {
  for (let i = 0; i < 10; i += 1) {
    const all = await rows();
    let last = all.length - 1;
    while (last >= 0 && all[last] === "") last -= 1;
    const line = last >= 0 ? all[last] : "";
    const atCursor = last >= 0 && (await cursorRow()) === last;
    if (line === ">>>" && atCursor) return;
    if (atCursor) {
      await press("Enter");
      await page.waitForTimeout(400);
      continue;
    }
    await ctrlC();
    await page.waitForTimeout(500);
  }
}
async function safeStep(name, fn) {
  await step(name, fn);
  if (h.checks[name] === false) await recover();
}

/**
 * 여러 줄짜리 블록(함수 정의 등)을 제출한다. 마지막에 빈 줄로 닫히며 정의는 곧바로 실행되지 않으므로 `>>>`까지 기다린다.
 * 각 항목은 문자열(프리필 위에 그대로 친다) 또는 `{ line, dedent }`(`dedent`회 Backspace로 프리필을 한 단위씩
 * 줄인 뒤 친다, RD-013 자동 들여쓰기 — DELTA-04 `CATCHER_LINES` 참고).
 */
async function defineBlock(lines) {
  for (const item of lines) {
    const line = typeof item === "string" ? item : item.line;
    const dedent = typeof item === "string" ? 0 : (item.dedent ?? 0);
    for (let i = 0; i < dedent; i += 1) await press("Backspace");
    await type(line);
    await enter();
    await waitPrompt("...");
  }
  await enter();
  await waitPrompt(">>>");
}
async function runPre(pre) {
  for (const item of pre) {
    if (typeof item === "string") {
      await type(item);
      await enter();
      await waitPrompt(">>>");
    } else {
      await defineBlock(item.block);
    }
  }
}

/** `keyboard.press` 직전 시각부터 새 `>>> ` 행(커서 포함)이 보일 때까지, 3ms 간격으로 폴링해 그 시각을 돌려준다. */
async function waitPromptAt() {
  return waitFor(
    async () => {
      const all = await rows();
      let last = all.length - 1;
      while (last >= 0 && all[last] === "") last -= 1;
      if (last >= 0 && all[last] === ">>>" && (await cursorRow()) === last) return performance.now();
      return null;
    },
    "복귀(측정)",
    25000,
    3,
  );
}

/** `tb1` 규칙: 트레이스백 정확히 1개 + 뒤에서 두 번째(빈 줄 제외) 행이 KeyboardInterrupt. */
async function checkTb1() {
  const tb = await countTracebacks();
  if (tb !== 1) throw new Error(`트레이스백 ${tb}개(1개 기대) ${show(await tail(8))}`);
  const nonEmpty = (await trimmedRows()).filter((l) => l !== "");
  const last = nonEmpty.at(-2); // 마지막은 >>>, 그 앞이 KeyboardInterrupt 행이어야 한다
  if (last !== "KeyboardInterrupt") throw new Error(`마지막 줄 ${show(last)}(KeyboardInterrupt 기대) ${show(await tail(8))}`);
}
/**
 * `line` 규칙(RD-012 확정 13): 트레이스백 0개 + 뒤에서 두 번째(빈 줄 제외) 행이 KeyboardInterrupt. `await` 대기
 * 중 취소는 콘솔 task 취소라 트레이스백 없이 한 줄로 끝난다(`10-parity-deviations.md` 1절, python -m asyncio와 같다).
 * 트레이스백 있는 형식(`tb1`)은 `^C` 에코가 "Traceback (most recent call last):" 행에 붙지만, 이 형식은 그
 * 머리글이 없어 `^C` 에코가 KeyboardInterrupt 행 앞에 그대로 붙는다(실측 `^CKeyboardInterrupt`) — 그 접두만 뗀다.
 * `OUR_FRAME_RE` 0건은 호출부가 모든 셀에 공통으로 검사하므로 여기서 다시 보지 않는다.
 */
async function checkLine() {
  const tb = await countTracebacks();
  if (tb !== 0) throw new Error(`트레이스백 ${tb}개(0개 기대) ${show(await tail(8))}`);
  const nonEmpty = (await trimmedRows()).filter((l) => l !== "");
  const last = (nonEmpty.at(-2) ?? "").replace(/^(\^C)+/, "");
  if (last !== "KeyboardInterrupt") throw new Error(`뒤에서 두 번째 줄 ${show(nonEmpty.at(-2))}(KeyboardInterrupt 기대, ^C 접두 허용) ${show(await tail(8))}`);
}

/** 형식 판정. 실패하면 던진다. `either`는 통과한 가지 이름("line"|"tb1")을 돌려준다(그 외 폼은 undefined). */
async function checkForm(cfg) {
  if (cfg.form === "tb1") {
    await checkTb1();
  } else if (cfg.form === "line") {
    await checkLine();
  } else if (cfg.form === "either") {
    try {
      await checkLine();
      return "line";
    } catch (lineError) {
      try {
        await checkTb1();
        return "tb1";
      } catch (tb1Error) {
        throw new Error(`line도 tb1도 아니다 — line: ${lineError.message} / tb1: ${tb1Error.message}`);
      }
    }
  } else if (cfg.form === "catch3") {
    const tb = await countTracebacks();
    if (tb !== 0) throw new Error(`트레이스백 ${tb}개(0개 기대) ${show(await tail(8))}`);
    const lines = await trimmedRows();
    if (!lines.some((l) => l === "^C^C^C3")) throw new Error(`^C^C^C3 행 없음 ${show(lines.slice(-8))}`);
  } else if (cfg.form === "burst") {
    const tb = await countTracebacks();
    if (tb !== 1) throw new Error(`트레이스백 ${tb}개(1개 기대) ${show(await tail(8))}`);
    await type("print('ok')");
    await enter();
    await waitPrompt(">>>");
    const lines = await tail(3);
    if (!same(lines, [">>> print('ok')", "ok", ">>>"])) throw new Error(`연타 뒤 print('ok') 화면 ${show(lines)}`);
  }
}

const stats = {};
const cellPageErrorsBefore = {};
const branchCounts = {};

await safeStep("초기: 프롬프트가 뜬다", async () => {
  await waitPrompt(">>>", 60000);
  await focus();
});

let currentTLA = false; // 데모의 초기 상태(체크박스 꺼짐, 저장 없음)
for (const cellId of CELL_IDS) {
  const cfg = CELLS[cellId];
  if (Boolean(cfg.tla) !== currentTLA) {
    await setTopLevelAwait(Boolean(cfg.tla));
    currentTLA = Boolean(cfg.tla);
  }
  stats[cellId] = [];
  cellPageErrorsBefore[cellId] = h.pageErrors.length;
  await clear();
  await runPre(cfg.pre);

  for (let i = 1; i <= N; i += 1) {
    const name = `${cellId}#${String(i).padStart(2, "0")}`;
    await safeStep(name, async () => {
      await clear();
      let enterAt;
      if (cfg.block) {
        enterAt = performance.now();
        await startBlockLine(cfg.run);
      } else {
        await type(cfg.run);
        enterAt = performance.now();
        await enter();
      }

      let measureWhich = "last";
      if (cfg.kind === "multi") {
        for (let p = 0; p < cfg.presses.length; p += 1) {
          const wait = enterAt + cfg.presses[p] - performance.now();
          if (wait > 0) await page.waitForTimeout(wait);
          if (p === cfg.presses.length - 1) await armMeasurement();
          await ctrlC();
        }
      } else if (cfg.kind === "burst") {
        const wait = enterAt + cfg.offset() - performance.now();
        if (wait > 0) await page.waitForTimeout(wait);
        await armMeasurement();
        measureWhich = "first";
        await ctrlCBurst(cfg.burstCount ?? 5, 0);
      } else {
        const wait = enterAt + cfg.offset() - performance.now();
        if (wait > 0) await page.waitForTimeout(wait);
        await armMeasurement();
        await ctrlC();
      }

      await waitPromptAt();
      await settled(120, 5000);
      const elapsed = await readElapsed(measureWhich);
      stats[cellId].push(elapsed);

      const joined = (await rows()).join("");
      if (OUR_FRAME_RE.test(joined)) throw new Error(`우리 프레임 노출 ${show(await tail(8))}`);

      const branch = await checkForm(cfg);
      if (cfg.form === "either" && branch) {
        branchCounts[cellId] ??= {};
        branchCounts[cellId][branch] = (branchCounts[cellId][branch] ?? 0) + 1;
      }
    });
  }
}

await safeStep("핸들러 프레임이 화면에 새지 않는다", async () => {
  const leaks = await h.handlerLeaks();
  if (leaks.length > 0) throw new Error(`핸들러 문자열 ${show(leaks)}`);
});

// ---------- 결과 집계 ----------
const cellResults = {};
let totalPassed = 0;
let totalTrials = 0;
for (const cellId of CELL_IDS) {
  const cfg = CELLS[cellId];
  const trialNames = Object.keys(h.checks).filter((k) => k.startsWith(`${cellId}#`));
  const passed = trialNames.filter((k) => h.checks[k]).length;
  const { median, max } = stat(stats[cellId]);
  const pageErrors = h.pageErrors.length - cellPageErrorsBefore[cellId];
  cellResults[cellId] = {
    n: trialNames.length,
    passed,
    median,
    max,
    pageErrors,
    tla: Boolean(cfg.tla),
    form: cfg.form,
    ...(branchCounts[cellId] ? { branches: branchCounts[cellId] } : {}),
  };
  totalPassed += passed;
  totalTrials += trialNames.length;
}
console.log("\n=== 셀별 결과 ===");
for (const [id, r] of Object.entries(cellResults)) {
  const branchesText = r.branches ? ` branches=${JSON.stringify(r.branches)}` : "";
  console.log(`${id.padEnd(16)} n=${r.n} passed=${r.passed} median=${r.median}ms max=${r.max}ms pageErrors=${r.pageErrors} tla=${r.tla}${branchesText}`);
}

const ok = await h.finish({ label, cellResults, totalPassed, totalTrials, startedCellsOnly: ONLY.length ? ONLY : "전체" });
process.exit(ok ? 0 : 1);
