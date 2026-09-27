// RD-007 연타·키 반복 매트릭스. 이전 구현 `baseline.mjs`의 COMBOS·분류를 옮겼다.
// 실행 중 Ctrl+C를 여러 형태로 몰아쳐도 프롬프트가 돌아오고(HANG 아님), 트레이스백이 정확히 하나이며
// (여러 번 중단되지 않는다), 뒤이은 실행이 죽지 않는지(잔류 SIGINT 없음) 본다.
//
// 셀: a(0ms 30회) b1·b5·b20·b50(간격 ms로 30회) c(키 반복: 500ms 뒤 29×33ms) d2·d5(2회·5회) warm-a(같은 페이지에서 한 번 중단한 뒤 a)
// 판정 우선순위: CRASH > HANG > DIRTY > OK
//   CRASH  프롬프트 미복귀 + pageerror/worker 오류
//   HANG   프롬프트 미복귀
//   DIRTY  트레이스백이 2 이상이거나(트레이스백 생성 중 또 중단), 스크롤되지 않았는데 0이거나,
//          뒤이은 `for … pass` + `print('ok')`의 `ok`가 없거나, 핸들러 문자열이 샜다
// 출처 RD-007, `_works/_completed/20260922-07-rd-007-ctrl-c-running/verify/`에서 이관(RD-018 DELTA-04).
// 사용: N=20 COMBOS=a,b5 node burst-matrix.mjs <url>(생략 시 http://localhost:5173)
// 결과 파일 label은 url 포트 4173이면 preview, 그 밖은 dev. 판정선은 이 DELTA에서 재측정하지 않는다(배선 확인만).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../lib.mjs";

const url = process.argv[2] ?? "http://localhost:5173";
const trials = Number(process.env.N ?? 20);
const combos = (process.env.COMBOS ?? "a,b1,b5,b20,b50,c,d2,d5,warm-a").split(",").filter(Boolean);

const measureDir = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = process.env.E2E_RESULTS_DIR ?? path.join(measureDir, "..", "results");
const label = url.includes(":4173") ? "preview" : "dev";

/** 셀 이름 → 연타 방식. `warm`은 시행 전에 한 번 중단해 둔다(콜드 경로만 보지 않게). */
function parseCombo(name) {
  if (name === "a") return { count: 30, gapMs: 0 };
  if (name === "c") return { count: 30, gapMs: 33, leadMs: 500 };
  if (name === "warm-a") return { count: 30, gapMs: 0, warm: true };
  const burst = /^b(\d+)$/.exec(name);
  if (burst) return { count: 30, gapMs: Number(burst[1]) };
  const few = /^d(\d+)$/.exec(name);
  if (few) return { count: Number(few[1]), gapMs: 120 };
  throw new Error(`알 수 없는 셀: ${name}`);
}

const report = {};
const started = Date.now();

for (const combo of combos) {
  const spec = parseCombo(combo);
  // 셀마다 새 페이지(cold). `warm-*`은 시행 전에 한 번 중단한다.
  const h = await open(url);
  const { waitPrompt, waitPromptTail, clear, type, enter, rows, focus, ctrlC, holdCtrlC, startBlockLine, resetPrompt, countTracebacks, handlerLeaks, page } = h;
  await waitPrompt(">>>", 60000);
  await focus();

  const cell = { combo, spec, ok: 0, outcomes: {}, failures: [], pageErrorsAtStart: h.otherPageErrors().length };
  try {
  for (let trial = 0; trial < trials; trial += 1) {
    const errorsBefore = h.otherPageErrors().length;
    // 이전 시행이 꼬리(`^C…`)를 남겼으면 Ctrl+L이 그 행을 그대로 맨 위에 그려 `clear()`가 실패한다.
    const before = (await rows()).filter((r) => r !== "").at(-1) ?? "";
    if (before !== ">>>") await resetPrompt();
    await clear();
    if (spec.warm) {
      // 한 번 중단해 트레이스백 경로·핸들러를 덥힌 뒤 본 시행을 한다.
      await startBlockLine("while True: pass");
      await page.waitForTimeout(300);
      await ctrlC();
      await waitPromptTail(8000).catch(() => {});
      await clear();
    }
    // 복합문 한 줄이라 빈 줄 Enter가 있어야 실행이 시작된다(3.14 REPL과 같다).
    await startBlockLine("while True: pass");
    await page.waitForTimeout(300);
    await holdCtrlC(spec.count, { gapMs: spec.gapMs, leadMs: spec.leadMs ?? 0 });

    let outcome = "OK";
    const detail = {};
    try {
      await waitPromptTail(10000);
    } catch {
      outcome = h.otherPageErrors().length > errorsBefore ? "CRASH" : "HANG";
    }
    if (outcome === "OK") {
      detail.tracebacks = await countTracebacks();
      // 실행이 끝난 뒤의 눌림은 활성 읽기로 가 벤더가 `>>> ^C` 한 행씩 다시 그린다(정상). 그 행이 쌓이면
      // 24행 뷰포트에서 트레이스백이 밀려 나가므로 0을 "트레이스백 없음"으로 읽으면 안 된다.
      detail.redraws = (await rows()).filter((r) => /^>>> \^C$/.test(r)).length;
      const leaks = await handlerLeaks();
      if (leaks.length > 0) {
        outcome = "DIRTY";
        detail.leaks = leaks;
      } else if (detail.tracebacks >= 2) {
        // 트레이스백을 만드는 중에 또 중단됐다(핸들러의 "그 밖 폐기" 규칙이 막아야 하는 것).
        outcome = "DIRTY";
      } else if (detail.tracebacks === 0 && detail.redraws === 0) {
        // 밀려 나간 것도 아닌데 트레이스백이 없다 = 중단이 트레이스백을 내지 않았다.
        outcome = "DIRTY";
      } else {
        // 연타 눌림마다 `^C`가 꼬리에 쌓여 프롬프트가 `^C…^C>>> `다. 빈 Enter로 깨끗한 `>>> `를 만든다.
        await resetPrompt();
        // 잔류 SIGINT가 있으면 뒤이은 실행이 중단된다.
        await clear();
        // `for`도 복합문이라 빈 줄 Enter가 있어야 실행된다.
        await startBlockLine("for i in range(300000): pass");
        try {
          await waitPrompt(">>>", 8000);
          await type("print('ok')");
          await enter();
          await waitPrompt(">>>", 8000);
          const all = (await rows()).filter((r) => r !== "");
          if (all.at(-2) !== "ok") {
            outcome = "DIRTY";
            detail.after = all.slice(-4);
          }
        } catch {
          outcome = "DIRTY";
          detail.after = "뒤이은 실행이 끝나지 않았다";
        }
      }
    }
    cell.outcomes[outcome] = (cell.outcomes[outcome] ?? 0) + 1;
    if (outcome === "OK") cell.ok += 1;
    else cell.failures.push({ trial, outcome, ...detail, rows: (await rows()).filter((r) => r !== "").slice(-6) });
    if (outcome === "CRASH" || outcome === "HANG") break;
  }
  } catch (e) {
    cell.aborted = String(e.message ?? e).slice(0, 300);
    cell.outcomes.ABORTED = (cell.outcomes.ABORTED ?? 0) + 1;
  }
  cell.pageErrors = h.otherPageErrors().length - cell.pageErrorsAtStart;
  cell.pageErrorSample = h.otherPageErrors().slice(0, 3);
  // 정상 중단마다 나는 webloop 재보고는 따로 센다(RD-009가 억제한다).
  cell.webLoopReraises = h.pageErrors.length - h.otherPageErrors().length;
  await h.browser.close();
  report[combo] = cell;
  console.log(`${combo}: ok ${cell.ok}/${trials} ${JSON.stringify(cell.outcomes)} pageErrors=${cell.pageErrors}`);
}

const summary = {
  url,
  trials,
  combos,
  cells: report,
  allOk: Object.values(report).every((c) => c.ok === trials),
  seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
};
mkdirSync(resultsDir, { recursive: true });
writeFileSync(
  path.join(resultsDir, `burst-matrix-${label}.json`),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify({ allOk: summary.allOk, seconds: summary.seconds }, null, 2));
process.exit(summary.allOk ? 0 : 1);
