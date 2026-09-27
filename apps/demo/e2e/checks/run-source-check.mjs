// RD-022a DELTA-05 브라우저 확인: REPL 핸들 `runSource(code)`(REPL 화면, 쿼리 없음). 실제 xterm 6 + 실제 브라우저 + 실제 CDN pyodide.
// 코드를 `textarea`(`source`)에 넣고 `run-source` 버튼을 누르면 결과 칸(`source-result`)에 `runSource()`가 돌려준 결과 유니온의 JSON이
// 나오고 거부는 `{"rejected":"<reason>"}`다. 화면은 xterm 행(`.xterm-rows > div`)으로 판정한다.
//
// 셀:
//   S01 `pri`까지 친 상태에서 `runSource("x = 1\nprint(x)")` → 행 `1`, 마지막 행 `>>> pri`(커서 끝), `ok`, 이어서 `x` 제출 → `1`(globals 공유)
//   S02 `1/0` → `error`·`ZeroDivisionError`, 트레이스백 행(`File "<console>"`, 빨강), 뒤에 `>>>` 재그리기
//   S03 블록 입력 중(`if 1:` Enter → `...`) 호출 → `{"rejected":"busy"}`, 화면·블록 입력 무변경
//   S04 REPL이 `while True: pass`를 실행 중일 때 호출 → `busy`, 이어서 Ctrl+C로 정리
//   S05 `runSource`가 실행하는 `while True: pass` → Ctrl+C → `interrupted`, `^C`·`KeyboardInterrupt` 행, 프롬프트 복원
//   S06 `print(input("n: "))` → `n: ` 뒤 입력 → `n: abc`·`abc` 행, `ok`
//   S07 `sys.exit(3)` → `exit{ code: 3 }`·이어서 REPL `1+1` → `2`(세션 유지), `exit()` → `exit{ code: 0 }`·이어서 `runSource("print(input())")`가 stdin으로 읽는다
//   S08 `runSource` 실행 중 `reset` 버튼 → `restarted`, 새 세션에서 REPL 명령이 돈다
//   S09 `pri`에서 커서를 두 칸 왼쪽(`p|ri`)에 두고 `print(1)` → 재그리기 뒤 커서 열 5, `X` 입력 → `>>> pXri`
//   S10 `print("a", end="")` 뒤 `a>>> pri`에서 `print(2)` → 꼬리 `a` 행 보존, `2` 행, `>>> pri`
//   끝  콘솔 경고·오류·pageerror 0(`finish()`의 `pageErrors`도 0이어야 `ok`다)
//
// 시간 판정(`docs/design/09-testing.md` 9.7): 고정 대기·ms 상한을 쓰지 않는다. 실행이 "진행 중"임은 출력 행 마커(`S0nGO`)로 확인하고,
// 결과 칸이 채워진 뒤 화면을 읽을 때는 조건이 참이 될 때까지 기다린다(결과 칸이 xterm DOM보다 먼저 바뀔 수 있다, TRP-050). 화면 판정은 행
// 정확일치(`hasRow`)·증가분(`countOf`)이고 부분일치는 쓰지 않는다. 호출은 프롬프트 행이 화면에 보인 뒤에 한다(그려지기 전 호출은 `busy`다).
// 거부(`busy`)는 화면을 건드리지 않으므로 "무변경"은 결과 도착 직후 스냅샷과, 뒤이은 정상 조작이 끝난 뒤 행 목록의 형태로 함께 확인한다.
//
// 사용: node run-source-check.mjs [url](생략 시 http://localhost:5173)     ONLY=S01,S05 node run-source-check.mjs
// 결과 파일 label은 url 포트 4173이면 preview, 그 밖은 dev(RD-018 DELTA-02 결정과 같은 규칙).
import { checkEntry, exitWith, serverLabel } from "../check-runner.mjs";
import { hasFg, open, same, show } from "../lib.mjs";

const { url } = checkEntry();
const label = serverLabel(url);
/** worker 부팅(pyodide 로드)·리셋 대기용 정지 감지 timeout(판정선이 아니다). */
const BOOT_TIMEOUT_MS = 90000;

const h = await open(url);
const { page, step, waitFor, waitPrompt, waitStatus, rows, rowClasses, spansOf, tail, cursorRow, focus, type, enter, press, submit, ctrlC, typeWhenReading, clear } = h;

/** 커서가 있는 행에서 커서 앞 텍스트의 길이(열 좌표). 커서 행이 없으면 -1. */
const cursorCol = () =>
  page.evaluate(() => {
    const rowEls = [...document.querySelectorAll(".xterm-rows > div")];
    const row = rowEls.find((r) => r.querySelector(".xterm-cursor"));
    if (!row) return -1;
    let col = 0;
    for (const child of row.childNodes) {
      if (child.nodeType === 1 && child.classList?.contains("xterm-cursor")) break;
      col += (child.textContent ?? "").length;
    }
    return col;
  });

/** 행 하나가 `text`와 정확히 같은지(입력 행 `>>> …`과 출력 행을 구별하려면 전체 일치여야 한다, TRP-011). */
const hasRow = async (text) => (await rows()).some((r) => r === text);
/** `text`와 정확히 같은 행의 개수. */
const countRow = async (text) => (await rows()).filter((r) => r === text).length;
/** 이어붙인 화면에서 `needle`이 나오는 횟수(행이 감겨도 놓치지 않는다). 증가분으로만 쓴다. */
const countOf = async (needle) => (await rows()).join("").split(needle).length - 1;

const resultText = () => page.locator('[data-testid="source-result"]').textContent();
/** 결과 칸이 비어 있지 않을 때까지 기다려 JSON으로 파싱한다(새 호출을 시작하면 앱이 이전 결과를 지운다). */
async function waitResult(description, timeoutMs = 30000) {
  await waitFor(async () => (await resultText()) !== "", `source-result: ${description}`, timeoutMs);
  return JSON.parse(await resultText());
}
/**
 * 코드를 `textarea`에 넣고 `run-source` 버튼을 누른다(호출이 시작되면 결과 칸이 비워진다). 채우기·클릭이 xterm의 숨은 textarea에서
 * 포커스를 가져가므로 끝에 되돌린다(이후 키 입력이 터미널로 간다).
 */
async function startSource(code) {
  await page.fill('[data-testid="source"]', code);
  await page.click('[data-testid="run-source"]');
  await focus();
}
/** `startSource` 뒤 결과를 기다린다. */
async function callSource(code, description = code, timeoutMs = 30000) {
  await startSource(code);
  return waitResult(description, timeoutMs);
}
/** 끝쪽 빈 행을 자른 화면의 마지막 `n`행이 `expected`가 될 때까지 기다린다(결과 칸이 화면보다 먼저 바뀔 수 있다). */
async function waitTail(expected, description, timeoutMs = 15000) {
  await waitFor(async () => same(await tail(expected.length), expected), `${description}: 마지막 ${expected.length}행 = ${show(expected)}`, timeoutMs);
}
/** 화면에 출력 행(`text` 전체가 한 행)이 나타날 때까지 기다린다. */
const waitRow = (text, timeoutMs = 30000) => waitFor(() => hasRow(text), `출력 행 ${show(text)}`, timeoutMs);
/** 마지막 텍스트 행과 커서가 그 행에 있는지(프롬프트가 그려졌는지). */
async function lastRowInfo() {
  const all = await rows();
  let last = all.length - 1;
  while (last >= 0 && all[last] === "") last -= 1;
  return { text: last >= 0 ? all[last] : "", isCursorRow: last >= 0 && (await cursorRow()) === last };
}
/** 마지막 텍스트 행이 `expected`이고 커서가 그 행에서 `col`열에 있을 때까지 기다린다. */
async function waitLineWithCursor(expected, col, description, timeoutMs = 15000) {
  await waitFor(
    async () => {
      const info = await lastRowInfo();
      return info.text === expected && info.isCursorRow && (await cursorCol()) === col;
    },
    `${description}: 마지막 행 ${show(expected)}·커서 열 ${col}`,
    timeoutMs,
  );
}
/** 입력 줄을 통째로 지운다(커서 앞 Ctrl+U, 뒤 Ctrl+K). 빈 `>>>`가 될 때까지 기다린다. */
async function wipeInput() {
  await press("Control+u");
  await press("Control+k");
  await waitPrompt(">>>", 10000);
}
/** 셀 시작 상태: 화면을 지워 `>>>` 프롬프트가 맨 윗 행에 오게 한다(호출은 이 프롬프트가 보인 뒤에 한다). */
async function freshCell() {
  await waitPrompt(">>>", BOOT_TIMEOUT_MS);
  await clear();
}
/** 실패한 셀 뒤 복구: `reset` 버튼으로 새 세션을 열고 첫 프롬프트를 기다린다(실행 중·블록 입력이 남았어도 끝난다). */
async function recover() {
  await page.click('[data-testid="reset"]');
  await waitStatus(["ready", "load-failed"], "복구: 리셋 뒤 ready", BOOT_TIMEOUT_MS);
  await focus();
  await waitPrompt(">>>", BOOT_TIMEOUT_MS);
}
async function rsStep(name, fn) {
  await step(name, fn);
  if (h.checks[name] === false) await recover().catch((e) => console.log(`복구 실패: ${e.message}`));
}

await step("초기 프롬프트가 뜨고 요소·전역·xterm 개수가 계약과 같다", async () => {
  await waitPrompt(">>>", BOOT_TIMEOUT_MS);
  await focus();
  for (const id of ["source", "run-source", "source-result"]) {
    const count = await page.locator(`[data-testid="${id}"]`).count();
    if (count !== 1) throw new Error(`data-testid=${id} 요소 ${count}개`);
  }
  const xterms = await page.locator(".xterm").count();
  if (xterms !== 1) throw new Error(`.xterm 요소 ${xterms}개`);
  const leaked = await page.evaluate(() => ["runSource", "repl", "handle", "replHandle"].filter((k) => k in window));
  if (leaked.length > 0) throw new Error(`window 전역 노출 ${show(leaked)}`);
  if ((await resultText()) !== "") throw new Error(`시작 결과 칸 = ${show(await resultText())}`);
});

await rsStep("S01 `pri`를 친 상태에서 runSource → 행 `1`·마지막 행 `>>> pri`, 이어서 `x` → `1`", async () => {
  await freshCell();
  await type("pri");
  await waitLineWithCursor(">>> pri", 7, "호출 전 입력");
  const r = await callSource("x = 1\nprint(x)");
  if (!same(r, { kind: "ok" })) throw new Error(`결과 = ${show(r)}`);
  await waitTail(["1", ">>> pri"], "runSource 뒤 화면");
  await waitLineWithCursor(">>> pri", 7, "복원한 줄");
  if (await hasRow(">>> x = 1")) throw new Error("입력 줄 에코 행 `>>> x = 1`이 있다");
  if ((await countRow(">>> pri")) !== 1) throw new Error(`\`>>> pri\` 행 ${await countRow(">>> pri")}개(프롬프트가 남았다)`);
  await wipeInput();
  await submit("x");
  await waitTail([">>> x", "1", ">>>"], "REPL `x` 제출");
});

await rsStep("S02 `1/0` → error·ZeroDivisionError, 트레이스백 행(빨강), 뒤에 `>>>` 재그리기", async () => {
  await freshCell();
  const r = await callSource("1/0");
  if (r.kind !== "error" || r.errorType !== "ZeroDivisionError") throw new Error(`결과 = ${show(r)}`);
  if (!r.traceback.includes('File "<console>", line 1')) throw new Error(`traceback = ${show(r.traceback)}`);
  await waitTail(
    ["Traceback (most recent call last):", '  File "<console>", line 1, in <module>', "ZeroDivisionError: division by zero", ">>>"],
    "runSource 뒤 화면",
  );
  const spans = await spansOf("ZeroDivisionError: division by zero");
  if (!spans.some((s) => hasFg(s.cls.split(/\s+/), 1))) throw new Error(`빨강 span 없음 ${show(spans)}`);
});

await rsStep("S03 블록 입력 중(`...`) 호출 → busy, 화면·블록 입력 무변경", async () => {
  await freshCell();
  await type("if 1:");
  await enter();
  await waitPrompt("...");
  const before = await h.snapshot();
  const r = await callSource("print('S03')");
  if (!same(r, { rejected: "busy" })) throw new Error(`결과 = ${show(r)}`);
  if ((await h.snapshot()) !== before) throw new Error(`거부가 화면을 바꿨다: ${show(await tail(4))}`);
  // 블록 입력이 그대로 이어지는지: 이어서 본문을 넣어 실행한다(가져갔다면 프롬프트가 지워져 아래 판정이 깨진다).
  await type("pass");
  await enter();
  await waitPrompt("...");
  await enter();
  await waitPrompt(">>>");
  const all = await rows();
  if (all[0] !== ">>> if 1:") throw new Error(`첫 행 = ${show(all[0])}`);
  if ((await countRow(">>> if 1:")) !== 1) throw new Error(`\`>>> if 1:\` 행 ${await countRow(">>> if 1:")}개`);
  if (await hasRow("S03")) throw new Error("거부된 코드의 출력 `S03`이 있다");
  if ((await countOf("S03")) !== 0) throw new Error("화면에 `S03`이 남아 있다");
});

await rsStep("S04 REPL 명령 실행 중 호출 → busy, Ctrl+C로 정리", async () => {
  await freshCell();
  await type('print("S04GO"); exec("while True: pass")');
  await enter();
  await waitRow("S04GO");
  const before = await h.snapshot();
  const r = await callSource("print('S04')");
  if (!same(r, { rejected: "busy" })) throw new Error(`결과 = ${show(r)}`);
  if ((await h.snapshot()) !== before) throw new Error(`거부가 화면을 바꿨다: ${show(await tail(4))}`);
  const baseKI = await countOf("KeyboardInterrupt");
  await ctrlC();
  await waitPrompt(">>>", 20000);
  if ((await countOf("KeyboardInterrupt")) - baseKI < 1) throw new Error(`KeyboardInterrupt 증가 없음 ${show(await tail(6))}`);
  if (await hasRow("S04")) throw new Error("거부된 코드의 출력 `S04`가 있다");
});

await rsStep("S05 runSource 실행 중 Ctrl+C → interrupted, `^C`·KeyboardInterrupt 행, 프롬프트 복원", async () => {
  await freshCell();
  await startSource("print('S05GO')\nwhile True: pass");
  await waitRow("S05GO");
  if ((await resultText()) !== "") throw new Error(`실행 중에 결과 칸이 채워졌다: ${await resultText()}`);
  const baseCaret = await countOf("^C");
  await ctrlC();
  const r = await waitResult("interrupted");
  if (r.kind !== "interrupted" || typeof r.traceback !== "string" || !r.traceback.includes("KeyboardInterrupt")) throw new Error(`결과 = ${show(r)}`);
  // 평소 명령 실행의 Ctrl+C와 같은 형태(ctrl-c-check RM1): `^C` 에코에 트레이스백 머리글이 이어지고 `KeyboardInterrupt` 뒤 프롬프트가 복원된다.
  await waitTail(
    ["S05GO", "^CTraceback (most recent call last):", '  File "<console>", line 2, in <module>', "KeyboardInterrupt", ">>>"],
    "중단 뒤 화면",
  );
  if ((await countOf("^C")) - baseCaret !== 1) throw new Error(`^C 증가 ${(await countOf("^C")) - baseCaret}: ${show(await tail(8))}`);
  const info = await lastRowInfo();
  if (info.text !== ">>>" || !info.isCursorRow) throw new Error(`프롬프트 미복원 ${show(info)}`);
});

await rsStep("S06 `print(input(\"n: \"))` → 입력 → `n: abc`·`abc` 행, ok", async () => {
  await freshCell();
  await startSource('print(input("n: "))');
  await waitPrompt("n:", 20000);
  await typeWhenReading("abc");
  await enter();
  const r = await waitResult("ok");
  if (!same(r, { kind: "ok" })) throw new Error(`결과 = ${show(r)}`);
  await waitTail(["n: abc", "abc", ">>>"], "input 뒤 화면");
});

await rsStep("S07 `sys.exit(3)`·`exit()` → exit, 세션 유지·이어서 REPL·`input()`", async () => {
  await freshCell();
  const a = await callSource("import sys; sys.exit(3)");
  if (!same(a, { kind: "exit", code: 3 })) throw new Error(`sys.exit 결과 = ${show(a)}`);
  await waitPrompt(">>>", 20000);
  await submit("1+1");
  await waitTail([">>> 1+1", "2", ">>>"], "sys.exit 뒤 REPL 명령");
  await clear();
  const b = await callSource("exit()");
  if (!same(b, { kind: "exit", code: 0 })) throw new Error(`exit() 결과 = ${show(b)}`);
  await waitPrompt(">>>", 20000);
  await clear();
  await startSource("print(input())");
  await typeWhenReading("hey");
  await enter();
  const c = await waitResult("input ok");
  if (!same(c, { kind: "ok" })) throw new Error(`input 결과 = ${show(c)}`);
  await waitTail(["hey", "hey", ">>>"], "exit() 뒤 input()");
});

await rsStep("S08 runSource 실행 중 reset → restarted, 새 세션에서 REPL 명령이 돈다", async () => {
  await freshCell();
  await startSource("print('S08GO')\nwhile True: pass");
  await waitRow("S08GO");
  await page.click('[data-testid="reset"]');
  const r = await waitResult("restarted");
  if (!same(r, { kind: "restarted" })) throw new Error(`결과 = ${show(r)}`);
  await waitStatus(["ready", "load-failed"], "리셋 뒤 ready", BOOT_TIMEOUT_MS);
  if ((await h.statusText()) !== "ready") throw new Error(`status = ${await h.statusText()}`);
  await focus();
  await waitPrompt(">>>", BOOT_TIMEOUT_MS);
  await clear();
  await submit("1+1");
  await waitTail([">>> 1+1", "2", ">>>"], "리셋 뒤 REPL 명령");
});

await rsStep("S09 커서 `p|ri`에서 runSource → 재그리기 뒤 커서 열 5, `X` 입력 → `>>> pXri`", async () => {
  await freshCell();
  await type("pri");
  await press("ArrowLeft");
  await press("ArrowLeft");
  await waitLineWithCursor(">>> pri", 5, "호출 전 커서");
  const r = await callSource("print(1)");
  if (!same(r, { kind: "ok" })) throw new Error(`결과 = ${show(r)}`);
  await waitTail(["1", ">>> pri"], "runSource 뒤 화면");
  await waitLineWithCursor(">>> pri", 5, "복원한 커서");
  await page.keyboard.type("X");
  await waitLineWithCursor(">>> pXri", 6, "X 입력 뒤");
  await wipeInput();
});

await rsStep("S10 꼬리 `a>>> pri`에서 runSource → `a` 행 보존, `2` 행, `>>> pri`", async () => {
  await freshCell();
  await type('print("a", end="")');
  await enter();
  await waitPrompt("a>>>", 20000);
  await type("pri");
  await waitLineWithCursor("a>>> pri", 8, "호출 전 꼬리 입력");
  const r = await callSource("print(2)");
  if (!same(r, { kind: "ok" })) throw new Error(`결과 = ${show(r)}`);
  await waitTail(["a", "2", ">>> pri"], "runSource 뒤 화면");
  await waitLineWithCursor(">>> pri", 7, "복원한 줄");
  await wipeInput();
});

await step("끝 콘솔 경고·오류·pageerror가 없다", async () => {
  if (h.problemLogs().length > 0 || h.pageErrors.length > 0) {
    throw new Error(JSON.stringify({ problemLogs: h.problemLogs(), pageErrors: h.pageErrors }));
  }
});

const ok = await h.finish({ label });
exitWith(ok);
