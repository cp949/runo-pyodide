// RD-007 부팅 중 Ctrl+C 판정(TRAP-31).
// - pyodide를 로드하는 동안 누른 Ctrl+C가 시작 코드를 죽이지 않는지 본다.
// - main 게이트는 로딩 중에도 열려 있어 눌림이 실제로 버퍼에 써진다.
// - worker의 연결 단계(핸들러 설치 → 폐기 → 버퍼 연결)가 그 눌림을 폐기해야 한다.
//
// 시행 순서:
// 1. 시행마다 새 페이지를 연다.
// 2. 프롬프트가 나올 때까지 Ctrl+C를 누른다. 프롬프트 전에 누른 시행이 표본이며 그 수를 `beforePrompt`에 센다.
// 3. 프롬프트가 뜨면 `1 + 1`을 평가해 시작 코드가 살았는지 본다.
//
// 판정: 전 시행이 `OK`이면 통과한다(종료 코드는 `allOk`). 기준은 기본 N=30의 30/30이다.
// 기준의 출처는 RD-007 완료 기준이다. RD-018에서 dev N=30이 30/30 OK였다.
// baseline 세트 소속이다(`apps/demo/e2e/sets.mjs`의 `SETS`). `measure/`에 있지만 판정 스크립트다.
//
// 출처 RD-007에서 이관(RD-018). 사용법은 `apps/demo/e2e/README.md`.
// 결과 파일 label은 url에 `:4173`이 있으면 preview, 그 밖은 dev다.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../lib.mjs";

const url = process.argv[2] ?? "http://localhost:5173";
/** 시행 수. 기본 30. */
const trials = Number(process.env.N ?? 30);
/** 첫 눌림 전 고정 대기(ms). 0이면 기다리지 않는다. */
const pressAtMs = Number(process.env.PRESS_AT_MS ?? 0);
/** 눌림 한 번에 누르는 Ctrl+C 횟수. */
const presses = Number(process.env.PRESSES ?? 1);
/** 눌림 반복 간격(ms). dev에서 "터미널은 있고 프롬프트는 아직"인 창이 100ms 안팎이라 촘촘해야 한다. */
const gapMs = Number(process.env.GAP_MS ?? 20);
/**
 * pyodide CDN 응답을 늦추는 시간(ms). 0이면 늦추지 않는다.
 * dev에서는 xterm이 붙는 데 약 1.9초가 걸려, 그 시점에 pyodide 로드가 이미 끝나 있을 수 있다.
 * 응답을 늦추면 "터미널은 있고 pyodide는 아직"인 창이 넓어진다.
 * 기본이 0인 이유: Playwright route가 다른 요청까지 늦춰 창이 넓어지지 않는다.
 */
const delayPyodideMs = Number(process.env.DELAY_PYODIDE_MS ?? 0);

const measureDir = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = process.env.E2E_RESULTS_DIR ?? path.join(measureDir, "..", "results");
const label = url.includes(":4173") ? "preview" : "dev";

const results = [];
const started = Date.now();

for (let trial = 0; trial < trials; trial += 1) {
  const openedAt = Date.now();
  // `waitUntil: "commit"`으로 문서가 오자마자 돌아온다(로드 완료를 기다리면 눌림이 늦는다).
  const h = await open(url, {
    waitUntil: "commit",
    before: async (page) => {
      if (delayPyodideMs <= 0) return;
      await page.route(/cdn\.jsdelivr\.net/, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, delayPyodideMs));
        await route.continue();
      });
    },
  });
  const { page, waitPrompt, rows, type, enter, focus } = h;
  const record = { trial, outcome: "OK" };
  try {
    // 프롬프트가 나올 때까지 촘촘히 누른다.
    // - xterm이 붙기 전의 키는 아무 데도 가지 않아 무해하다.
    // - 붙은 뒤 프롬프트 전에 들어간 키가 이 확인의 표본이다.
    // - dev에서 그 창은 100ms 안팎이라 한 번으로는 맞히기 어렵다.
    const promptSeen = () =>
      page
        .$$eval(".xterm-rows > div", (els) => els.some((e) => (e.textContent ?? "").includes(">>>")))
        .catch(() => false);
    const terminalReady = () =>
      page.$(".xterm-helper-textarea").then((el) => el !== null).catch(() => false);
    if (pressAtMs > 0) await page.waitForTimeout(pressAtMs);
    let pressesDuringBoot = 0;
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      if (await promptSeen()) break;
      const ready = await terminalReady();
      if (ready) {
        await focus();
        for (let i = 0; i < presses; i += 1) await page.keyboard.press("Control+c");
        pressesDuringBoot += presses;
      }
      await page.waitForTimeout(gapMs);
    }
    record.pressesDuringBoot = pressesDuringBoot;
    record.beforePrompt = pressesDuringBoot > 0;
    record.pressedAtMs = Date.now() - openedAt;

    // 부팅이 끝나 프롬프트가 나와야 한다. 앞의 `^C`는 허용한다(게이트가 열려 있어 에코된다).
    await h.waitPromptTail(40000);
    record.promptAtMs = Date.now() - openedAt;
    const status = await page.$eval('[data-testid="status"]', (el) => el.textContent ?? "").catch(() => "");
    record.status = status.trim();
    if (!record.status.includes("ready")) {
      record.outcome = "status-not-ready";
    }
    // 시작 코드가 살았는지 한 줄을 평가해 본다. 꼬리에 `^C`가 쌓여 있으면 먼저 비운다.
    const last = (await rows()).filter((r) => r !== "").at(-1) ?? "";
    if (last !== ">>>") await h.resetPrompt();
    await type("1 + 1");
    await enter();
    await waitPrompt(">>>", 15000);
    const all = (await rows()).filter((r) => r !== "");
    if (all.at(-2) !== "2") {
      record.outcome = "prompt-but-no-eval";
      record.rows = all.slice(-4);
    }
  } catch (e) {
    record.outcome = h.otherPageErrors().length > 0 ? "pageerror" : "timeout";
    record.error = String(e.message ?? e).slice(0, 200);
    record.rows = (await rows().catch(() => [])).filter((r) => r !== "").slice(-6);
  }
  record.pageErrors = h.otherPageErrors().length;
  record.webLoopReraises = h.pageErrors.length - h.otherPageErrors().length;
  if (record.pageErrors > 0) record.pageErrorSample = h.otherPageErrors().slice(0, 2);
  await h.browser.close();
  results.push(record);
  if (record.outcome !== "OK") console.log(`  #${trial} ${record.outcome} ${record.error ?? ""}`);
  else if ((trial + 1) % 10 === 0) console.log(`  ${trial + 1}/${trials} ok`);
}

const outcomes = {};
for (const r of results) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
const summary = {
  url,
  trials,
  pressAtMs,
  presses,
  gapMs,
  delayPyodideMs,
  outcomes,
  beforePrompt: results.filter((r) => r.beforePrompt).length,
  pressesDuringBoot: {
    min: Math.min(...results.map((r) => r.pressesDuringBoot ?? 0)),
    max: Math.max(...results.map((r) => r.pressesDuringBoot ?? 0)),
    total: results.reduce((sum, r) => sum + (r.pressesDuringBoot ?? 0), 0),
  },
  pageErrors: results.reduce((sum, r) => sum + (r.pageErrors ?? 0), 0),
  allOk: results.every((r) => r.outcome === "OK"),
  seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
};
mkdirSync(resultsDir, { recursive: true });
writeFileSync(
  path.join(resultsDir, `boot-press-${trials}-${label}.json`),
  `${JSON.stringify({ summary, results }, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.allOk ? 0 : 1);
