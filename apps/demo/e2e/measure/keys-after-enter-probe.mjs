// Enter 직후 지연(ms)별로 친 키가 다음 프롬프트에 들어오는지 잰다. RD-003 프로브를 RD-005에서 이식했다.
// 측정 전용이다. 판정선이 없고 종료 코드는 항상 0이다.
//
// 기대값:
// - RD-019 이전: 읽기가 비활성인 구간의 키가 버려져(편차 32) 지연 0~10ms에서 유입이 들쭉날쭉했다.
// - RD-019 이후: 벤더 Readline이 그 구간의 키를 쌓았다가 다음 읽기에서 재생한다. 전 지연에서 N/N 유입이 기대값이다.
// - 이 측정은 회귀 관찰용이다. 판정은 `checks/type-ahead-check.mjs` T04·T01이 한다.
//
// RD-003 때는 `readLine` 핸들 API가 프롬프트를 직접 그렸다.
// 지금은 worker 왕복(`readLine` 요청 → `run` → 다음 `readLine`)이 더해져 읽기 비활성 창의 길이가 다를 수 있다.
//
// 출처 RD-005에서 이관(RD-018). 사용법은 `apps/demo/e2e/README.md`. 반복 수 N은 두 번째 위치 인자다(기본 10).
// 결과 파일 label은 url에 `:4173`이 있으면 preview, 그 밖은 dev다.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../lib.mjs";

const url = process.argv[2] ?? "http://localhost:5173";
/** 지연마다 반복하는 횟수. */
const N = Number(process.argv[3] ?? 10);
/** Enter와 `z` 사이의 지연(ms). 이 값 자체가 측정 대상이라 고정 대기다. */
const delays = [0, 5, 10, 20, 50, 100, 200];

const measureDir = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = process.env.E2E_RESULTS_DIR ?? path.join(measureDir, "..", "results");
const label = url.includes(":4173") ? "preview" : "dev";

const h = await open(url);
const { page, waitPrompt, rows } = h;
await waitPrompt(">>>", 60000);
await page.locator('[data-testid="terminal"] .xterm-screen').click();

/** 마지막 프롬프트 행(`>>>`로 시작하는 마지막 행). 없으면 null. */
const lastPrompt = async () => {
  const r = await rows();
  for (let i = r.length - 1; i >= 0; i--) if (r[i].startsWith(">>>")) return r[i];
  return null;
};
/** 빈 프롬프트 `>>>`가 될 때까지 20ms 간격으로 최대 200번 본다. 못 되면 거짓을 돌려준다. */
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
    // 빈 줄 Enter. worker가 `run("")`을 하고 다음 `readLine`을 요청하는 동안이 읽기 비활성 구간이다.
    await page.keyboard.press("Enter");
    if (delay > 0) await page.waitForTimeout(delay);
    await page.keyboard.type("z");
    // 재생된 키가 화면에 그려질 시간을 준다.
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
