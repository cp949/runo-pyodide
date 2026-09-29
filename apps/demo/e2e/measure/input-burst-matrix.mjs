// RD-008 취소 연타 매트릭스. RD-007 `burst-matrix.mjs`와 같은 형식이다.
// `input()` 대기 중 연타(F×5)와 `... ` 프롬프트 연타(RD-012b I)를 셀별 N회 반복해 생존과 형식을 본다.
//
// 셀:
// - a: `input()` 대기 중 0ms 2회.
// - b: `input()` 대기 중 0ms 5회.
// - c: `input()` 대기 중 키 반복 20회(Control을 누른 채 c 반복).
// - lp5: 긴 프롬프트 `input("p"*70 + ": ")` + 5회.
// - sp5: 짧은 프롬프트 `input("x: ")` + 5회.
// - pa: `... ` 프롬프트 0ms 2회.
// - pb: `... ` 프롬프트 0ms 5회.
// - pc: `... ` 프롬프트 키 반복 20회.
//
// 판정 우선순위: CRASH > HANG > DIRTY > OK.
// - CRASH: 프롬프트 미복귀 + 대상 pageerror(webloop 재보고 제외). pageerror가 새로 난 실패도 CRASH로 올린다.
// - HANG: 프롬프트 미복귀.
// - DIRTY:
//   - input 셀: 트레이스백이 1이 아니다.
//   - 프롬프트 셀: `^C`가 하나라도 있다(게이트 항 `cancelSettling`의 판정). 취소 줄(`KeyboardInterrupt`)이 없다.
//   - 두 종류 공통: 뒤이은 `ok`가 없다. 뒤이은 실행이 잔류 SIGINT로 트레이스백을 냈다.
// - OK: 그 밖.
// 종료 코드는 전 셀이 N/N OK이고 pageerror가 0일 때 0이다.
//
// 기록만 하는 값:
// - input 셀의 `^C` 개수는 판정이 아니다(편차 36).
// - `KeyboardInterrupt` 줄 수. 프롬프트 셀에서 연타가 한 줄로 합쳐지는 것은 편차 37이다.
//
// 출처 RD-008에서 이관(RD-018). 사용법은 `apps/demo/e2e/README.md`.
// 결과 파일 label은 url에 `:4173`이 있으면 preview, 그 밖은 dev다.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../lib.mjs";

const url = process.argv[2] ?? "http://localhost:5173";
/** 셀마다 반복하는 시행 수. 기본 20. */
const trials = Number(process.env.N ?? 20);
/** 돌릴 셀 이름 목록(쉼표 구분). 기본은 전 셀이다. */
const combos = (process.env.COMBOS ?? "a,b,c,lp5,sp5,pa,pb,pc").split(",").filter(Boolean);

const measureDir = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = process.env.E2E_RESULTS_DIR ?? path.join(measureDir, "..", "results");
const label = url.includes(":4173") ? "preview" : "dev";
/** 결과 JSON 경로. 환경변수 `OUT`으로 바꾼다. */
const outPath = process.env.OUT ?? path.join(resultsDir, `input-burst-matrix-${label}.json`);

/** `lp5` 셀의 긴 프롬프트(72자). */
const LONG_PROMPT = 'input("p" * 70 + ": ")';

/**
 * 셀 이름을 연타 방식으로 바꾼다. 알 수 없는 이름이면 던진다.
 * 반환: `{ kind: "input"|"prompt", code?, count, hold }`. `hold`가 참이면 Control을 누른 채 반복한다.
 */
function parseCombo(name) {
  const table = {
    a: { kind: "input", code: "burst_v = input()", count: 2, hold: false },
    b: { kind: "input", code: "burst_v = input()", count: 5, hold: false },
    c: { kind: "input", code: "burst_v = input()", count: 20, hold: true },
    lp5: { kind: "input", code: `burst_v = ${LONG_PROMPT}`, count: 5, hold: false },
    sp5: { kind: "input", code: 'burst_v = input("x: ")', count: 5, hold: false },
    pa: { kind: "prompt", count: 2, hold: false },
    pb: { kind: "prompt", count: 5, hold: false },
    pc: { kind: "prompt", count: 20, hold: true },
  };
  const spec = table[name];
  if (!spec) throw new Error(`알 수 없는 셀: ${name}`);
  return spec;
}

const report = {};
const started = Date.now();

for (const combo of combos) {
  const spec = parseCombo(combo);
  // 셀마다 새 페이지(cold)를 연다.
  const h = await open(url);
  const {
    waitPrompt, waitPromptTail, clear, type, enter, rows, focus, ctrlCBurst, holdCtrlC,
    typeWhenReading, startBlockLine, resetPrompt, countTracebacks, caretCount, interruptCount,
    settled, page,
  } = h;
  await waitPrompt(">>>", 60000);
  await focus();

  const cell = { combo, spec, ok: 0, outcomes: {}, carets: [], interrupts: [], failures: [] };
  const bump = (outcome) => {
    cell.outcomes[outcome] = (cell.outcomes[outcome] ?? 0) + 1;
    if (outcome === "OK") cell.ok += 1;
  };

  try {
    for (let trial = 0; trial < trials; trial += 1) {
      const errorsBefore = h.otherPageErrors().length;
      let outcome = "OK";
      let detail = "";
      try {
        // 이전 시행이 꼬리(`^C…`)를 남겼으면 Ctrl+L이 그 행을 맨 위에 그대로 그려 `clear()`가 실패한다.
        const before = (await rows()).filter((r) => r !== "").at(-1) ?? "";
        if (before !== ">>>") await resetPrompt();
        await clear();

        // 연타 전에 읽기를 연다.
        if (spec.kind === "input") {
          await type(spec.code);
          await enter();
          // 첫 글자 에코로 읽기가 열린 것을 확인한다.
          await typeWhenReading("ab");
        } else {
          await type("if True:");
          await enter();
          await waitPrompt("...", 8000);
        }
        if (spec.hold) await holdCtrlC(spec.count);
        else await ctrlCBurst(spec.count);

        await waitPromptTail(15000);
        // 화면이 250ms 조용해진 뒤 개수를 센다. 조용해지지 않아도 그대로 센다.
        await settled(250).catch(() => {});
        const carets = await caretCount();
        const interrupts = await interruptCount();
        const tracebacks = await countTracebacks();
        cell.carets.push(carets);
        cell.interrupts.push(interrupts);

        if (spec.kind === "input" && tracebacks !== 1) {
          outcome = "DIRTY";
          detail = `트레이스백 ${tracebacks}개`;
        } else if (spec.kind === "prompt" && carets !== 0) {
          outcome = "DIRTY";
          detail = `^C ${carets}개`;
        } else if (spec.kind === "prompt" && interrupts < 1) {
          outcome = "DIRTY";
          detail = "취소 줄이 없다";
        } else {
          // 잔류 SIGINT가 있으면 이 실행이 중단된다.
          const last = (await rows()).filter((r) => r !== "").at(-1) ?? "";
          if (last !== ">>>") await resetPrompt();
          await clear();
          await startBlockLine("for i in range(300000): pass");
          await waitPrompt(">>>", 20000);
          await type("print('ok')");
          await enter();
          await waitPrompt(">>>", 20000);
          const lines = (await rows()).filter((r) => r !== "");
          if (!lines.includes("ok")) {
            outcome = "DIRTY";
            detail = `ok 없음 ${JSON.stringify(lines.slice(-4))}`;
          } else if ((await countTracebacks()) !== 0) {
            outcome = "DIRTY";
            detail = "잔류 SIGINT가 트레이스백을 냈다";
          }
        }
      } catch (e) {
        outcome = h.otherPageErrors().length > errorsBefore ? "CRASH" : "HANG";
        detail = String(e.message ?? e).slice(0, 200);
      }
      if (h.otherPageErrors().length > errorsBefore && outcome !== "OK") outcome = "CRASH";
      bump(outcome);
      if (outcome !== "OK") cell.failures.push({ trial, outcome, detail });
      if (outcome !== "OK") {
        // 실패한 시행의 잔재를 치운다(다음 시행이 그 잔재로 실패하지 않게).
        await resetPrompt().catch(() => {});
      }
    }
  } finally {
    cell.pageErrors = h.otherPageErrors();
    cell.webLoopReraises = h.pageErrors.length - h.otherPageErrors().length;
    await h.browser.close();
  }

  const median = (xs) => (xs.length ? [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)] : null);
  cell.caretMedian = median(cell.carets);
  cell.interruptMedian = median(cell.interrupts);
  report[combo] = cell;
  console.log(
    `${combo}: OK ${cell.ok}/${trials} ${JSON.stringify(cell.outcomes)} ^C중앙값=${cell.caretMedian} ` +
      `KI중앙값=${cell.interruptMedian} ^C범위=${Math.min(...cell.carets)}~${Math.max(...cell.carets)} ` +
      `재보고=${cell.webLoopReraises}` +
      (cell.failures.length ? ` 실패=${JSON.stringify(cell.failures.slice(0, 3))}` : ""),
  );
}

const summary = {
  url,
  trials,
  elapsedMs: Date.now() - started,
  cells: Object.fromEntries(
    Object.entries(report).map(([k, v]) => [
      k,
      {
        ok: v.ok,
        outcomes: v.outcomes,
        caretMedian: v.caretMedian,
        caretRange: [Math.min(...v.carets), Math.max(...v.carets)],
        interruptMedian: v.interruptMedian,
        interruptRange: [Math.min(...v.interrupts), Math.max(...v.interrupts)],
        webLoopReraises: v.webLoopReraises,
        pageErrors: v.pageErrors,
        failures: v.failures,
      },
    ]),
  ),
};
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
const allOk = Object.values(report).every((c) => c.ok === trials && c.pageErrors.length === 0);
process.exit(allOk ? 0 : 1);
