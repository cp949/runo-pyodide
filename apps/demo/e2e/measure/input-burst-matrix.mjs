// RD-008 취소 연타 매트릭스. RD-007 `burst-matrix.mjs` 형식.
// `input()` 대기 중 연타(F×5)와 `... ` 프롬프트 연타(RD-012b I)를 셀별 N회 반복해 생존·형식을 본다.
//
// 셀:
//   a    `input()` 대기 중 0ms 2회
//   b    `input()` 대기 중 0ms 5회
//   c    `input()` 대기 중 키 반복 20회(Control을 누른 채 c 반복)
//   lp5  긴 프롬프트 `input("p"*70 + ": ")` + 5회
//   sp5  짧은 프롬프트 `input("x: ")` + 5회
//   pa   `... ` 프롬프트 0ms 2회
//   pb   `... ` 프롬프트 0ms 5회
//   pc   `... ` 프롬프트 키 반복 20회
//
// 판정 우선순위 CRASH > HANG > DIRTY > OK
//   CRASH  프롬프트 미복귀 + 대상 pageerror(webloop 재보고 제외)
//   HANG   프롬프트 미복귀
//   DIRTY  input 셀: 트레이스백이 1이 아니거나 뒤이은 `ok`가 없다
//          프롬프트 셀: `^C`가 하나라도 있거나(게이트 항 `cancelSettling`의 판정), 취소 줄이 없거나 `ok`가 없다
//   OK     그 밖
// `^C` 개수는 input 셀에서는 판정이 아니라 기록이다(편차 36). `KeyboardInterrupt` 줄 수도 기록한다
// (이전 구현 02c 한계 7의 "연타 취소가 합쳐진다"와 대조해 편차 등록은 DELTA-06이 판단한다).
//
// 출처 RD-008, `_works/_completed/20260922-08-rd-008-prompt-and-input-cancel/verify/`에서 이관(RD-018 DELTA-04).
// 사용: N=20 COMBOS=a,b,c,lp5,sp5,pa,pb,pc node input-burst-matrix.mjs <url>(생략 시 http://localhost:5173)
// 결과 파일 label은 url 포트 4173이면 preview, 그 밖은 dev. 판정선은 이 DELTA에서 재측정하지 않는다(배선 확인만).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../lib.mjs";

const url = process.argv[2] ?? "http://localhost:5173";
const trials = Number(process.env.N ?? 20);
const combos = (process.env.COMBOS ?? "a,b,c,lp5,sp5,pa,pb,pc").split(",").filter(Boolean);

const measureDir = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = process.env.E2E_RESULTS_DIR ?? path.join(measureDir, "..", "results");
const label = url.includes(":4173") ? "preview" : "dev";
const outPath = process.env.OUT ?? path.join(resultsDir, `input-burst-matrix-${label}.json`);

const LONG_PROMPT = 'input("p" * 70 + ": ")';

/** 셀 이름 → { kind: "input"|"prompt", code?, count, hold } */
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
  // 셀마다 새 페이지(cold).
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

        if (spec.kind === "input") {
          await type(spec.code);
          await enter();
          await typeWhenReading("ab");
        } else {
          await type("if True:");
          await enter();
          await waitPrompt("...", 8000);
        }
        if (spec.hold) await holdCtrlC(spec.count);
        else await ctrlCBurst(spec.count);

        await waitPromptTail(15000);
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
          // 잔류 SIGINT가 있으면 이 실행이 죽는다.
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
        // 실패한 시행 뒤 상태를 되돌린다(다음 시행이 그 잔재로 실패하지 않게).
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
