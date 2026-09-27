// RD-007 브라우저 검증(실행 중 Ctrl+C). 출처 RD-007, `_works/_completed/20260922-07-rd-007-ctrl-c-running/verify/`에서
// 이관(RD-018). ROADMAP 시나리오와 이전 구현 브라우저 ID 중
// 이 RD가 맡는 것(G1·G2·S1·S08)을 새 데모(하니스 lib.mjs)에 맞춰 옮겼다. 건너뛴 ID는 skipped-ids.md.
// 기대 바이트는 DELTA-02가 node에서 고정한 것과 같다:
//   'Traceback (most recent call last):\n  File "<console>", line 1, in <module>\nKeyboardInterrupt\n'
// 규칙(TRP-005·006·008·011): 각 확인은 Ctrl+L로 시작하고, 새 프롬프트가 보인 뒤 입력하며, 정확한 행 목록으로 단언한다.
// RD-018 DELTA-02 갱신: S1a·S1·RM2는 다단 중첩(try/while/except/pass)이라 RD-013 자동 들여쓰기 프리필과 수동 들여쓰기가
// 겹치면 실제로 IndentationError/SyntaxError가 난다. dev 서버 프로브(cursorCol 실측, 이 DELTA)로 확인한 규칙:
//   - `:`로 끝나는 줄을 제출하면 다음 줄 프리필이 한 단위(4칸) 늘어난다. `:`로 끝나지 않는 줄(인라인 복합문 등)은 같은
//     레벨을 유지한다.
//   - 프리필이 이미 그 레벨의 들여쓰기이므로 본문 줄은 들여쓰기 없이 그대로 친다(`type("print(1)")`).
//   - 레벨을 한 단계 낮춰야 하면(예: `except`를 `try`보다 얕게) Backspace 한 번으로 한 단위(4칸)가 통째로 지워진다
//     (프리필 끝에서, 추가로 친 문자가 없을 때).
// 화면 기대값 자체는 원래 스크립트가 4칸 단위로 손으로 들여썼던 것과 우연히 같아 문자열은 바뀌지 않는다.
// 사용: node ctrl-c-check.mjs <url>(생략 시 http://localhost:5173)     ONLY=RM1,S1 node ctrl-c-check.mjs <url>
// 결과 파일 label은 url 포트 4173이면 preview, 그 밖은 dev(RD-018 DELTA-02 결정).
import { checkEntry, exitWith, serverLabel } from "../check-runner.mjs";
import { open, same, show } from "../lib.mjs";

const { url } = checkEntry();
const label = serverLabel(url);

const h = await open(url);
const {
  step, waitPrompt, waitPromptTail, waitLastEndsWith, waitFor, clear, type, enter, press, tail, rows, trimmedRows,
  spansOf, cursorRow, focus, typeWhenReading, settled, ctrlC, startBlockLine, resetPrompt, submit,
  countTracebacks, handlerLeaks, page,
} = h;

/** 실행이 시작될 시간을 준 뒤 Ctrl+C를 누른다. 누르기 전에 화면이 프롬프트 행에서 내려가 있어야 한다. */
async function interruptAfter(ms) {
  await page.waitForTimeout(ms);
  await ctrlC();
}
/**
 * 화면을 지우고 `while True: pass`를 실행한다. 복합문 한 줄이라 `... `가 뜨고 빈 줄 Enter로 실행이 시작된다
 * (3.14 REPL과 같다). 그래서 화면에는 코드 행과 `...` 행이 남는다.
 */
async function start(code) {
  await clear();
  await startBlockLine(code);
}
/** REPL 프롬프트에서 문장을 실행하고 다음 프롬프트까지 기다린다. */
async function run(code) {
  await type(code);
  await enter();
  await waitPrompt(">>>");
}
/**
 * 확인이 실패해 남은 상태를 `>>> `로 되돌린다. 세 가지를 구분한다:
 * `... `(블록 입력 중) → Enter로 끝낸다(실행이 시작되면 다음 바퀴가 Ctrl+C로 끊는다),
 * 꼬리가 붙은 프롬프트(`^C>>> `) → Enter로 깨끗한 프롬프트를 만든다, 그 밖(실행 중) → Ctrl+C.
 */
async function recover() {
  for (let i = 0; i < 10; i += 1) {
    const all = await rows();
    let last = all.length - 1;
    while (last >= 0 && all[last] === "") last -= 1;
    const line = last >= 0 ? all[last] : "";
    const atCursor = last >= 0 && (await cursorRow()) === last;
    if (line === ">>>" && atCursor) return;
    // 커서가 마지막 텍스트 행에 있으면 무언가를 읽는 중이다(`... ` 블록, 꼬리 프롬프트, stdin 읽기).
    // Enter로 끝낸다. 커서가 그 아래에 있으면 실행 중이므로 Ctrl+C로 끊는다.
    if (atCursor) {
      await press("Enter");
      await page.waitForTimeout(400);
      continue;
    }
    await ctrlC();
    await page.waitForTimeout(500);
  }
}
async function ctrlCStep(name, fn) {
  await step(name, fn);
  if (h.checks[name] === false) await recover();
}

await step("초기: 프롬프트가 뜬다", async () => {
  await waitPrompt(">>>", 60000);
  await focus();
});

await ctrlCStep("RM1 ROADMAP 기본: while True: pass 중 Ctrl+C → ^C에 이어 트레이스백 3줄과 >>>", async () => {
  await start("while True: pass");
  await interruptAfter(300);
  await waitPrompt(">>>");
  const lines = await tail(6);
  const expected = [
    ">>> while True: pass",
    "...",
    "^CTraceback (most recent call last):",
    '  File "<console>", line 1, in <module>',
    "KeyboardInterrupt",
    ">>>",
  ];
  if (!same(lines, expected)) throw new Error(`화면 ${show(lines)}`);
  // `KeyboardInterrupt` 행은 빨강 한 덩어리다(sink writeError).
  const spans = await spansOf("KeyboardInterrupt");
  const red = spans.filter((s) => s.cls.includes("xterm-fg-1")).map((s) => s.text).join("");
  if (red !== "KeyboardInterrupt") throw new Error(`빨강 span ${show(spans)}`);
});

await ctrlCStep("G1 실행 중 Ctrl+C가 KeyboardInterrupt 트레이스백으로 끝난다(정규식)", async () => {
  await start("while True: pass");
  await interruptAfter(300);
  await waitPrompt(">>>");
  const text = (await trimmedRows()).join("\n");
  if (!/Traceback[\s\S]*KeyboardInterrupt\n>>>$/.test(text)) throw new Error(`화면 ${show(text.slice(-200))}`);
});

await ctrlCStep("G2 중단 뒤 print(1)이 정상 실행된다", async () => {
  await start("while True: pass");
  await interruptAfter(300);
  await waitPrompt(">>>");
  await clear();
  await run("print(1)");
  const lines = await tail(3);
  if (!same(lines, [">>> print(1)", "1", ">>>"])) throw new Error(`화면 ${show(lines)}`);
});

await ctrlCStep("S08 블록 형태(while True: pass Enter → ... Enter)도 같은 트레이스백으로 끝난다", async () => {
  await clear();
  await type("while True: pass");
  await enter();
  await waitPrompt("...");
  await enter();
  await interruptAfter(1200);
  await waitPrompt(">>>");
  const lines = await tail(6);
  const expected = [
    ">>> while True: pass",
    "...",
    "^CTraceback (most recent call last):",
    '  File "<console>", line 1, in <module>',
    "KeyboardInterrupt",
    ">>>",
  ];
  if (!same(lines, expected)) throw new Error(`화면 ${show(lines)}`);
});

await ctrlCStep("S1a except로 잡은 중단 뒤 프롬프트는 트레이스백 없이 `^C>>> `로 이어진다", async () => {
  await clear();
  await submit("try:", "...");
  await submit("while True: pass", "..."); // 프리필(4칸) 그대로 — try 본문 레벨을 유지한다(다음 줄도 같은 레벨)
  await press("Backspace"); // except를 try와 같은 레벨(0)로 되돌린다(한 단위 dedent)
  await submit("except KeyboardInterrupt:", "...");
  await submit("pass", "..."); // 프리필(4칸)이 except 본문 레벨과 일치한다
  await enter();
  await interruptAfter(300);
  // 잡았으므로 트레이스백이 없다. `^C`는 꼬리에 남아 다음 프롬프트와 한 행이 된다.
  await waitPromptTail();
  await settled(150);
  if ((await countTracebacks()) !== 0) throw new Error(`트레이스백이 있다 ${show(await tail(6))}`);
  const last = (await trimmedRows()).at(-1);
  if (last !== "^C>>>") throw new Error(`중단 뒤 마지막 행 ${show(last)}`);
  await enter();
  await waitPrompt(">>>");
});

// `t^Cx: `가 한 행이 되려면 출력·중단·`input()`이 한 번의 실행 안에서 이어져야 한다. 제출을 나누면 그 사이에
// REPL 프롬프트가 그려지며 꼬리가 리셋돼(`promptRow.read`, RD-027) `^C`가 프롬프트에 흡수된다(위 S1a가 그 형태다).
await ctrlCStep("S1 한 실행 안에서 출력 → 중단(except) → input()이 이어지면 프롬프트가 t^Cx: 로 이어진다", async () => {
  await clear();
  await submit("def s1():", "...");
  await submit('print("t", end="")', "..."); // 프리필(4칸)이 def 본문 레벨과 일치한다
  await submit("try:", "..."); // 같은 레벨(4) 유지, 콜론이라 다음 줄은 한 단위 늘어난다(8)
  await submit("while True: pass", "..."); // 프리필(8칸) 그대로 — try 본문 레벨 유지
  await press("Backspace"); // except를 try와 같은 레벨(4)로 되돌린다
  await submit("except KeyboardInterrupt:", "...");
  await submit("pass", "..."); // 프리필(8칸)이 except 본문 레벨과 일치한다
  await press("Backspace"); // return을 def 본문 레벨(4)로 되돌린다
  await submit('return input("x: ")', "...");
  await enter();
  await waitPrompt(">>>");
  await clear();
  await type("s1()");
  await enter();
  await interruptAfter(300);
  // 중단을 잡고 이어서 `input("x: ")`가 시작된다. 꼬리는 `t` + `^C` + `x: `다.
  await waitLastEndsWith("x:");
  await settled(150);
  await typeWhenReading("abc");
  await settled();
  const line = (await trimmedRows()).at(-1);
  if (line !== "t^Cx: abc") throw new Error(`입력 행 ${show(line)}`);
  await enter();
  await waitPrompt(">>>");
});

await ctrlCStep("RM2 KeyboardInterrupt를 잡고 세는 프로그램은 눌림 3회에 정확히 3번 중단된다", async () => {
  await clear();
  // `<console>` 컴파일이라 핸들러가 사용자 프레임으로 본다(함수 정의 자체는 프롬프트에서 하므로 그대로다).
  await type("import time");
  await enter();
  await waitPrompt(">>>");
  await type("n = 0");
  await enter();
  await waitPrompt(">>>");
  await submit("def f():", "...");
  await submit("global n", "..."); // 프리필(4칸)이 def 본문 레벨과 일치한다
  await submit("end = time.monotonic() + 6", "..."); // 같은 레벨(4) 유지
  await submit("while time.monotonic() < end:", "..."); // 같은 레벨(4)에서 침, 콜론이라 다음 줄은 8로 늘어난다
  await submit("try:", "..."); // 프리필(8칸)과 일치, 콜론이라 다음 줄은 12로 늘어난다
  await submit("while time.monotonic() < end: pass", "..."); // 프리필(12칸) 그대로 — try 본문 레벨 유지
  await press("Backspace"); // except를 while 본문과 같은 레벨(8)로 되돌린다
  await submit("except KeyboardInterrupt: n += 1", "...");
  await enter();
  await waitPrompt(">>>");
  await clear();
  await type("f()");
  await enter();
  await page.waitForTimeout(800);
  for (let i = 0; i < 3; i += 1) {
    await ctrlC();
    await page.waitForTimeout(300);
  }
  await waitPromptTail(20000);
  // 눌림마다 `^C`가 꼬리에 쌓여 프롬프트가 `^C^C^C>>> `다. 빈 Enter로 깨끗한 `>>> `를 만든 뒤 화면을 지운다.
  await resetPrompt();
  await clear();
  await run("print('N=', n)");
  const lines = await tail(3);
  if (!same(lines, [">>> print('N=', n)", "N= 3", ">>>"])) throw new Error(`세기 결과 ${show(lines)}`);
});

await ctrlCStep("RM3 중단 뒤 남은 SIGINT가 없다(프롬프트에서 더 누른 뒤 실행이 죽지 않는다)", async () => {
  await start("while True: pass");
  await interruptAfter(300);
  await waitPrompt(">>>");
  // 프롬프트(활성 읽기)에서의 Ctrl+C는 벤더 경로다. 전송되지 않으므로 다음 실행에 남지 않아야 한다.
  await ctrlC();
  await ctrlC();
  await page.waitForTimeout(200);
  await clear();
  await run("print(1)");
  await clear();
  await startBlockLine("for i in range(300000): pass");
  await waitPrompt(">>>");
  await type("print('ok')");
  await enter();
  await waitPrompt(">>>");
  const lines = await tail(3);
  if (!same(lines, [">>> print('ok')", "ok", ">>>"])) throw new Error(`화면 ${show(lines)}`);
  if ((await countTracebacks()) !== 0) throw new Error("잔류 SIGINT가 트레이스백을 냈다");
});

await step("핸들러 프레임이 화면에 새지 않는다", async () => {
  const leaks = await handlerLeaks();
  if (leaks.length > 0) throw new Error(`핸들러 문자열 ${show(leaks)}`);
});

const ok = await h.finish({ label });
exitWith(ok);
