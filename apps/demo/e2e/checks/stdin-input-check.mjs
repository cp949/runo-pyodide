// RD-006 브라우저 검증(input()·sys.stdin 읽기). 출처 RD-006, `_works/_completed/20260922-06-rd-006-stdin-input/verify/`에서
// 이관(RD-018). 이전 구현 RD-006b
// `pyodide-samples/_works/_completed/20260919-11-rd-006b-repl-prompt-join/reference/browser-check.mjs`(74개) 중 stdin 해당 23개
//   E1, K1~K3, L1, M1, M2, N1~N3, O1, O2, P1~P9, R1, U1(`input("p: ")` 원형)
// 와 ROADMAP RD-006 시나리오(RM1: `x: abc` 한 줄, TICK: 프롬프트 대기 중 배경 출력)를 새 데모(하니스 lib.mjs)에 맞춰 옮겼다.
// 기대 행·입력 문장은 이전 스크립트의 것을 그대로 쓴다. 건너뛴 ID는 skipped-ids.md.
// 이전과 달라진 점:
//   - 입력은 읽기가 시작된 뒤에 보낸다(TRP-005). stdin 프롬프트 글자는 읽기 시작보다 먼저(`write` 알림) 화면에 나오고 프롬프트 없는
//     `input()`은 화면 신호가 없어, 첫 글자를 한 번 치고 에코될 때까지 기다린다(`typeWhenReading`, 재시도 없음 — RD-019 이후 읽기 전 키는 버려지지 않고 쌓였다가 읽기 시작에서 재생된다).
//   - 고정 sleep 대신 화면이 안정될 때까지(`settled`) 기다린다.
//   - 각 확인은 Ctrl+L(`clear`)로 시작해 정확한 행 목록으로 단언한다(TRP-008). 개행 수는 커서 행으로 본다(TRP-006).
// 사용: node stdin-input-check.mjs <url>(생략 시 http://localhost:5173)     ONLY=RM1,TICK node stdin-input-check.mjs <url>
// 결과 파일 label은 url 포트 4173이면 preview, 그 밖은 dev(RD-018 DELTA-02 결정).
import { checkEntry, exitWith, serverLabel } from "../check-runner.mjs";
import { open, same, show } from "../lib.mjs";

const { url } = checkEntry();
const label = serverLabel(url);

const h = await open(url);
const { step, waitPrompt, waitLastEndsWith, waitFor, clear, type, enter, press, tail, lastLine, rows, trimmedRows, nonEmpty, spansOf, cursorRow, focus, typeWhenReading, settled, markText, readMark, page } = h;

/** 화면을 지우고 문장을 제출해 stdin 읽기가 시작될 때까지 기다린다. `promptSuffix`가 있으면 그 프롬프트가 보일 때까지 기다린다. */
async function startInput(code, promptSuffix) {
  await clear();
  await type(code);
  await enter();
  if (promptSuffix) await waitLastEndsWith(promptSuffix);
  await settled(150);
}
/** stdin 읽기에 입력한 줄을 Enter로 끝내고 REPL 프롬프트가 돌아올 때까지 기다린다. */
async function finishRead() {
  await enter();
  await waitPrompt(">>>");
}
/** REPL 프롬프트(`>>>`)에서 문장을 실행하고 다음 프롬프트까지 기다린다. */
async function run(code) {
  await type(code);
  await enter();
  await waitPrompt(">>>");
}
/** 확인이 실패해 읽기가 열린 채 남았으면 Enter로 끝내 다음 확인이 이어지게 한다. */
async function recover() {
  for (let i = 0; i < 6; i += 1) {
    const all = await rows();
    let last = all.length - 1;
    while (last >= 0 && all[last] === "") last -= 1;
    if (last >= 0 && all[last] === ">>>" && (await cursorRow()) === last) return;
    await press("Enter");
    await page.waitForTimeout(400);
  }
}
async function stdinStep(name, fn) {
  await step(name, fn);
  if (h.checks[name] === false) await recover();
}

await step("초기: 프롬프트가 뜬다", async () => {
  await waitPrompt(">>>", 60000);
  await focus();
});

await stdinStep('RM1 ROADMAP: input("x: ")는 x: 뒤에서 기다리고 abc Enter 뒤 화면이 x: abc 한 줄이며 name == "abc"가 True', async () => {
  await startInput('name = input("x: ")', "x:");
  await typeWhenReading("abc");
  await settled();
  const during = await tail(2);
  if (!same(during, ['>>> name = input("x: ")', "x: abc"])) throw new Error(`입력 중 ${show(during)}`);
  await finishRead();
  const after = await tail(3);
  if (!same(after, ['>>> name = input("x: ")', "x: abc", ">>>"])) throw new Error(`Enter 뒤 ${show(after)}`);
  await run('name == "abc"');
  const eq = await tail(3);
  if (!same(eq, ['>>> name == "abc"', "True", ">>>"])) throw new Error(`비교 ${show(eq)}`);
});

await stdinStep("K1·K2·K3 input(\"x: \"): 입력 중 x: abc 한 줄, `>>> abc`로 그리지 않음, Enter 뒤 kv가 'abc'", async () => {
  await startInput('kv = input("x: ")', "x:");
  await typeWhenReading("abc");
  await settled();
  const t = await tail(2);
  if (!same(t, ['>>> kv = input("x: ")', "x: abc"])) throw new Error(`K1 ${show(t)}`);
  if ((await rows()).some((l) => l.includes(">>> abc"))) throw new Error(`K2 ${show(await tail(3))}`);
  await finishRead();
  await run("kv");
  const a = await tail(5);
  if (!same(a, ['>>> kv = input("x: ")', "x: abc", ">>> kv", "'abc'", ">>>"])) throw new Error(`K3 ${show(a)}`);
});

await stdinStep("L1 인자 없는 input()은 프롬프트 없이 입력만 받는다", async () => {
  await startInput("lv = input()");
  await typeWhenReading("abc");
  await settled();
  const t = await tail(2);
  if (!same(t, [">>> lv = input()", "abc"])) throw new Error(show(t));
  await finishRead();
});

await stdinStep("O1 sys.stdin.readline()도 프롬프트 없이 입력만 받고 값은 'abc\\n'이다", async () => {
  await startInput("import sys; sv = sys.stdin.readline()");
  await typeWhenReading("abc");
  await settled();
  const t = await tail(2);
  if (!same(t, [">>> import sys; sv = sys.stdin.readline()", "abc"])) throw new Error(show(t));
  await finishRead();
  await run("sv");
  const v = await tail(2);
  if (!same(v, ["'abc\\n'", ">>>"])) throw new Error(`sv ${show(v)}`);
});

await stdinStep("M1 개행 없는 출력 뒤 인자 없는 input()은 꼬리 뒤에 이어진다(3.14의 tabc)", async () => {
  await startInput('print("t", end=""); mv = input()');
  await typeWhenReading("abc");
  await settled();
  const t = await tail(2);
  if (!same(t, ['>>> print("t", end=""); mv = input()', "tabc"])) throw new Error(show(t));
  await finishRead();
});

await stdinStep("M2 꼬리 + 프롬프트 인자는 이어 붙는다(3.14의 tp: abc)", async () => {
  await startInput('print("t", end=""); mv = input("p: ")', "p:");
  await typeWhenReading("abc");
  await settled();
  const t = await tail(2);
  if (!same(t, ['>>> print("t", end=""); mv = input("p: ")', "tp: abc"])) throw new Error(show(t));
  await finishRead();
});

await stdinStep("O2 sys.stdin.readline()도 꼬리 뒤에 이어진다(3.14의 tabc)", async () => {
  await startInput('import sys; print("t", end=""); sv = sys.stdin.readline()');
  await typeWhenReading("abc");
  await settled();
  const t = await tail(2);
  if (!same(t, ['>>> import sys; print("t", end=""); sv = sys.stdin.readline()', "tabc"])) throw new Error(show(t));
  await finishRead();
});

await stdinStep("N1·N2·N3 색 프롬프트: 글자와 입력이 한 줄이고 프롬프트는 초록(xterm-fg-2), 입력한 abc는 초록이 아니다", async () => {
  await startInput('nv = input("\\x1b[32mNm: \\x1b[0m")', "Nm:");
  await typeWhenReading("abc");
  await settled();
  const line = await lastLine();
  if (line !== "Nm: abc") throw new Error(`N1 ${show(line)}`);
  const spans = await spansOf("Nm:");
  const promptGreen = spans.some((sp) => sp.text.includes("Nm:") && /xterm-fg-2\b/.test(sp.cls));
  const inputGreen = spans.some((sp) => sp.text.includes("abc") && /xterm-fg-2\b/.test(sp.cls));
  if (!promptGreen) throw new Error(`N2 ${show(spans)}`);
  if (inputGreen) throw new Error(`N3 ${show(spans)}`);
  await finishRead();
});

// P. 터미널 폭(80)을 넘는 프롬프트: 앞 행이 중복되지 않고 나머지 뒤에 입력이 이어진다.
const Q80 = "q".repeat(80);
await stdinStep("P1·P2·P3·P4 130자 프롬프트(2행): 첫 행(80자)이 한 번만, 나머지 뒤에 입력이 이어지고, 제출한 줄 바로 아래에서 시작하며, Enter 뒤 값이 돌아온다", async () => {
  await startInput('pv = input("q" * 130 + ": ")', `${"q".repeat(50)}:`);
  await typeWhenReading("abc");
  await settled();
  const t = await tail(4);
  if ((await nonEmpty()).filter((l) => l === Q80).length !== 1) throw new Error(`P1 ${show(t)}`);
  if ((await lastLine()) !== `${"q".repeat(50)}: abc`) throw new Error(`P2 ${show(await lastLine())}`);
  if (!same(t.slice(0, 2), ['>>> pv = input("q" * 130 + ": ")', Q80])) throw new Error(`P3 ${show(t)}`);
  await finishRead();
  await run("pv");
  if (!(await rows()).some((l) => l === "'abc'")) throw new Error(`P4 ${show(await tail(3))}`);
});

await stdinStep("P5·P6 200자 프롬프트(3행): 첫 두 행이 한 번씩만, 마지막 행은 나머지 프롬프트 뒤에 입력이 이어진다", async () => {
  await startInput('pv = input("q" * 200 + ": ")', `${"q".repeat(40)}:`);
  await typeWhenReading("abc");
  await settled();
  const ne = await nonEmpty();
  if (ne.filter((l) => l === Q80).length !== 2) throw new Error(`P5 ${show(await tail(5))}`);
  if ((await lastLine()) !== `${"q".repeat(40)}: abc`) throw new Error(`P6 ${show(await lastLine())}`);
  await finishRead();
});

await stdinStep("P7 정확히 폭과 같은 프롬프트(80자): 행이 중복되지 않고 입력은 다음 행에서 시작한다", async () => {
  await startInput('pv = input("q" * 80)');
  await typeWhenReading("abc");
  await settled();
  const t = await tail(3);
  if ((await nonEmpty()).filter((l) => l === Q80).length !== 1 || (await lastLine()) !== "abc") throw new Error(show(t));
  await finishRead();
});

await stdinStep("P8 한 행 안의 긴 프롬프트(70자)는 올라가지 않고 한 줄이다", async () => {
  await startInput('pv = input("q" * 70)');
  await typeWhenReading("abc");
  await settled();
  const t = await tail(2);
  if (!same(t, ['>>> pv = input("q" * 70)', `${"q".repeat(70)}abc`])) throw new Error(show(t));
  await finishRead();
});

await stdinStep("P9 전각 문자 프롬프트(45자 = 90칸): 첫 행(40자)이 한 번만 나온다", async () => {
  await startInput('pv = input("\\uac00" * 45 + ": ")');
  await typeWhenReading("abc");
  await settled();
  const full = (await nonEmpty()).filter((l) => l === "가".repeat(40)).length;
  console.log("관찰  전각 프롬프트 화면 끝:", show(await tail(4)));
  if (full !== 1) throw new Error(`40자 행 ${full}개 ${show(await tail(4))}`);
  await finishRead();
});

await stdinStep("R1 한 문장에서 두 번 읽으면 각 프롬프트가 자기 줄에서 이어진다", async () => {
  await startInput('a1 = input("a: "); b1 = input("b: ")', "a:");
  await typeWhenReading("1");
  await enter();
  await waitLastEndsWith("b:");
  await settled(150);
  await typeWhenReading("2");
  await settled();
  const t = await tail(3);
  if (!same(t, ['>>> a1 = input("a: "); b1 = input("b: ")', "a: 1", "b: 2"])) throw new Error(show(t));
  await finishRead();
});

await stdinStep("E1 input()이 돌려준 값을 쓰고 다음 프롬프트 앞에 빈 줄이 없다(커서 행)", async () => {
  await startInput("ev = input()");
  await typeWhenReading("hello");
  await finishRead();
  await run("ev");
  const t = await tail(5);
  if (!same(t, [">>> ev = input()", "hello", ">>> ev", "'hello'", ">>>"])) throw new Error(show(t));
  const all = await trimmedRows();
  if ((await cursorRow()) !== all.length - 1) throw new Error(`커서 행 ${await cursorRow()} / 텍스트 ${all.length}행: 빈 줄이 끼었다`);
});

await stdinStep("U1 앞 문장의 꼬리(t)를 물려받지 않는다(t>>> 뒤 input(\"p: \")는 p: abc)", async () => {
  await clear();
  await type('print("t", end="")');
  await enter();
  await waitPrompt("t>>>");
  await type('uv = input("p: ")');
  await enter();
  await waitLastEndsWith("p:");
  await settled(150);
  await typeWhenReading("abc");
  await settled();
  const t = await tail(3);
  if (!same(t, ['>>> print("t", end="")', 't>>> uv = input("p: ")', "p: abc"])) throw new Error(show(t));
  await finishRead();
});

await stdinStep("TICK ROADMAP: 프롬프트 대기 중 call_later(2, print, 'TICK')의 TICK이 Enter 없이 보이고 2초보다 이르지 않다", async () => {
  await clear();
  await type("import asyncio; asyncio.get_event_loop().call_later(2, print, 'TICK')");
  // 입력한 코드 행(`call_later(2, print, 'TICK')`)도 `TICK`을 포함한다. 그 행을 빼야 출력이 나온 시점을 잰다(빼지 않으면 즉시 참).
  // 시작점은 프롬프트 복귀가 아니라 Enter `keydown`의 페이지 시각이다. 복귀 뒤에 재면 느린 장비에서 구간이 짧아져 하한이 깨진다.
  // 페이지 시계라 Node↔CDP 왕복이 값에 섞이지 않는다(TRP-022). 입력 줄이 80열 안에 들어가 감기지 않으므로 `call_later`가 같은 행에 있다.
  await markText("TICK", { exclude: "call_later", startOnKey: { key: "Enter" } });
  await enter();
  await waitPrompt(">>>");
  const tickRows = async () => (await rows()).filter((l) => l.includes("TICK") && !l.includes("call_later"));
  if ((await tickRows()).length !== 0) throw new Error(`프롬프트가 돌아온 시점에 이미 TICK 출력이 있다 ${show(await tail(4))}`);
  // 정지 감지용 10초 대기다(판정선이 아니다, 9.7 4항). 상한 ms 판정은 하지 않는다: 요구 사항은 "Enter 없이 나온다"이지 응답성 수치가 아니다.
  const { elapsedMs } = await readMark({ timeoutMs: 10000 });
  await settled();
  console.log(`관찰  TICK ${elapsedMs.toFixed(1)}ms 뒤(Enter 기준) 화면 끝:`, show(await tail(4)), "커서 행", await cursorRow());
  h.notes["TICK Enter→TICK 출현(기록, ms)"] = Math.round(elapsedMs * 10) / 10;
  // 하한: `call_later(2)` 타이머 자체가 2000ms라 느린 장비에서 더 빨라지지 않는다(9.7 하한 행).
  if (elapsedMs < 2000) throw new Error(`TICK이 Enter 뒤 ${elapsedMs.toFixed(1)}ms 만에 보였다(call_later(2)의 2000ms보다 이르다)`);
});

await step("콘솔 경고·오류·pageerror가 없다", async () => {
  if (h.problemLogs().length > 0 || h.pageErrors.length > 0) {
    throw new Error(JSON.stringify({ problemLogs: h.problemLogs(), pageErrors: h.pageErrors }));
  }
});

const ok = await h.finish({ label });
exitWith(ok);
