// Enter 직후 지연(ms)별로 친 키가 다음 프롬프트에 들어오는지 잰다. RD-003 프로브의 RD-005 이식. RD-019 이전에는 읽기 비활성 구간의 키가
// 버려져(편차 32) 지연 0~10ms에서 유입이 들쭉날쭉했다. RD-019(type-ahead) 뒤에는 벤더 Readline이 그 구간의 키를 쌓았다가 다음 읽기에서
// 재생하므로 전 지연에서 N/N 유입이 기대값이다(회귀 관찰용 측정. 판정은 `checks/type-ahead-check.mjs` T04·T01이 한다).
// RD-003 시점에는 `readLine` 핸들 API가 프롬프트를 직접 그렸지만 지금은 worker 왕복(`readLine` 요청 → `run` → 다음 `readLine`)이 더해져
// 창이 달라질 수 있다. 판정에 쓰지 않고 수치만 기록한다(편차 32는 RD-019에서 해소).
// 출처 RD-005, `_works/_completed/20260922-05-rd-005-repl-loop/verify/`에서 이관(RD-018 DELTA-04).
// 사용: node keys-after-enter-probe.mjs <url>(생략 시 http://localhost:5173) [반복 N=10]
// 결과 파일 label은 url 포트 4173이면 preview, 그 밖은 dev(RD-018 DELTA-02 결정과 같은 규칙). 판정선 없음(측정 전용).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../lib.mjs";

const url = process.argv[2] ?? "http://localhost:5173";
const N = Number(process.argv[3] ?? 10);
const delays = [0, 5, 10, 20, 50, 100, 200];

const measureDir = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = process.env.E2E_RESULTS_DIR ?? path.join(measureDir, "..", "results");
const label = url.includes(":4173") ? "preview" : "dev";

const h = await open(url);
const { page, waitPrompt, rows } = h;
await waitPrompt(">>>", 60000);
await page.locator('[data-testid="terminal"] .xterm-screen').click();

/** 마지막 프롬프트 행(`>>>`로 시작하는 마지막 행). */
const lastPrompt = async () => {
  const r = await rows();
  for (let i = r.length - 1; i >= 0; i--) if (r[i].startsWith(">>>")) return r[i];
  return null;
};
const waitEmptyPrompt = async () => {
  for (let i = 0; i < 200; i++) {
    if ((await lastPrompt()) === ">>>") return true;
    await page.waitForTimeout(20);
  }
  return false;
};

const result = {};
for (const delay of delays) {
  let kept = 0;
  for (let n = 0; n < N; n++) {
    // 빈 줄 Enter: worker가 `run("")`을 하고 다음 `readLine`을 요청하는 동안이 읽기 비활성 구간이다.
    await page.keyboard.press("Enter");
    if (delay > 0) await page.waitForTimeout(delay);
    await page.keyboard.type("z");
    await page.waitForTimeout(250);
    if ((await lastPrompt()) === ">>> z") kept++;
    await page.keyboard.press("Control+U");
    await waitEmptyPrompt();
  }
  result[`${delay}ms`] = `${kept}/${N} 들어옴`;
}
const payload = { url, N, result, pageErrors: h.pageErrors, problemLogs: h.problemLogs() };
console.log(JSON.stringify(payload, null, 2));
mkdirSync(resultsDir, { recursive: true });
writeFileSync(path.join(resultsDir, `keys-after-enter-probe-${label}.json`), JSON.stringify(payload, null, 2));
await h.browser.close();
