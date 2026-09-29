// RD-008 브라우저 확인 ①: 입력줄(REPL 프롬프트) Ctrl+C 취소. RD-008에서 이관했다(RD-018).
//
// 셀 출처:
// - 이전 구현 RD-012b의 브라우저 ID를 새 데모(하니스 `lib.mjs`)로 옮겼다.
// - 건너뛰었던 ID(RD-011a S14, RD-006b G3·W2)를 복원했다.
// - 빈 프롬프트 취소(B0)를 새로 넣었다.
// - 건너뛴 ID는 G1(RD-013 몫), J1·J2(RD-010 몫)다.
//
// 기대 바이트는 3.14.4 pty 재측정(`pty/rd-008/results.md` ①②③④)과 같은 형태다.
// `\r\n` + 빨간 `KeyboardInterrupt` 한 줄. `^C` 없음, 빈 줄 없음.
//
// 규칙(TRP-005·006·008·011):
// - 확인마다 Ctrl+L로 시작한다.
// - 새 프롬프트가 보인 뒤 입력한다.
// - 정확한 행 목록으로 단언한다.
//
// 옮기며 바뀐 기대값:
// - E1·E2: `input()` 취소가 생겨 트레이스백 + `NameError`가 됐다. RD-012b 시절에는 취소가 없었다.
// - C1 본문 줄: `... ` 프리필(4칸, RD-013)을 그대로 쓴다. 수동 들여쓰기를 치지 않는다. 화면 문자열은 같다.
// - D1·D3: Shift+Enter 둘째 줄도 같은 프리필을 받는다. 기대 행이 `print(3)`이 아니라 `    print(3)`이다.
// - D2는 화면 문자열을 보지 않아 영향이 없다.
//
// 사용: `node prompt-cancel-check.mjs [url]`. `ONLY=RM1,B0`로 셀을 고른다.
// 결과 파일 규칙은 README "결과 파일 규칙".
import { checkEntry, exitWith, serverLabel } from "../check-runner.mjs";
import { open, same, show } from "../lib.mjs";

const { url } = checkEntry();
const label = serverLabel(url);

const h = await open(url);
const {
  step, waitPrompt, waitPromptTail, waitLastEndsWith, clear, type, enter, press, tail, rows, lastLine,
  spansOf, cursorRow, focus, settled, ctrlC, ctrlCBurst, holdCtrlC, caretCount, interruptCount,
  cancelWhenReading, startBlockLine, countTracebacks, page,
} = h;

/**
 * 실패해 남은 상태를 깨끗한 `>>> `로 되돌린다. 최대 10바퀴 돈다.
 * - 커서가 마지막 텍스트 행에 있다: Ctrl+U로 입력을 지우고 Enter.
 * - 커서가 그 아래에 있다(실행 중): Ctrl+C.
 */
async function recover() {
  for (let i = 0; i < 10; i += 1) {
    const all = await rows();
    let last = all.length - 1;
    while (last >= 0 && all[last] === "") last -= 1;
    const line = last >= 0 ? all[last] : "";
    const atCursor = last >= 0 && (await cursorRow()) === last;
    if (line === ">>>" && atCursor) return;
    if (atCursor) {
      await press("Control+u");
      await press("Enter");
      await page.waitForTimeout(400);
      continue;
    }
    await ctrlC();
    await page.waitForTimeout(500);
  }
}
/** 확인을 실행하고, 실패하면 `recover()`로 프롬프트를 되돌린다. */
async function check(name, fn) {
  await step(name, fn);
  if (h.checks[name] === false) await recover();
}
/** 문장 하나를 실행하고 다음 프롬프트까지 기다린다. */
async function run(code) {
  await type(code);
  await enter();
  await waitPrompt(">>>");
}
/** `if True:` → `... `까지 간다(블록 입력 중 상태). */
async function openBlock() {
  await type("if True:");
  await enter();
  await waitPrompt("...");
}

await check("초기: 프롬프트가 뜬다", async () => {
  await waitPrompt(">>>", 60000);
  await focus();
});

// ── A(RD-012b) + RM1(RD-008 시나리오) + S14(RD-011a): `... `에서 취소
await check("RM1/A1/S14 `... ` Ctrl+C는 다음 줄에 KeyboardInterrupt를 내고 `>>> `로 돌아온다", async () => {
  await clear();
  await openBlock();
  await ctrlC();
  await waitPrompt(">>>", 8000);
  const t = await tail(4);
  if (!same(t, [">>> if True:", "...", "KeyboardInterrupt", ">>>"])) throw new Error(show(t));
});
await check("A2 `^C`를 찍지 않는다", async () => {
  const n = await caretCount();
  if (n !== 0) throw new Error(`^C ${n}개 — ${show(await tail(4))}`);
});
await check("A3 KeyboardInterrupt는 빨강(writeError)이다", async () => {
  const spans = await spansOf("KeyboardInterrupt");
  if (!spans.some((s) => /xterm-fg-1\b/.test(s.cls))) throw new Error(show(spans));
});
await check("A4 이어서 입력한 print(1)이 1을 낸다(블록이 버려졌다)", async () => {
  await run("print(1)");
  const t = await tail(3);
  if (!same(t, [">>> print(1)", "1", ">>>"])) throw new Error(show(t));
});

// ── B0(신규): 빈 프롬프트에서도 KeyboardInterrupt를 낸다(3.14 pty ①. "빈 버퍼면 생략"은 배제된 변이)
await check("B0 빈 `>>> `에서 Ctrl+C도 KeyboardInterrupt 한 줄을 낸다", async () => {
  await clear();
  await ctrlC();
  // 취소 전 마지막 행이 이미 `>>>`이므로 `waitPrompt`만으로는 낡은 행에 바로 통과한다. 취소 줄을 먼저 기다린다.
  await h.waitFor(async () => (await rows()).some((r) => r === "KeyboardInterrupt"), "취소 줄", 8000);
  await waitPrompt(">>>", 8000);
  const t = await tail(3);
  if (!same(t, [">>>", "KeyboardInterrupt", ">>>"])) throw new Error(show(t));
  if ((await caretCount()) !== 0) throw new Error("`^C`가 찍혔다");
});

// ── B(RD-012b) + G3(RD-006b): `>>> abc`에서 취소
await check("B1/G3 `>>> abc` Ctrl+C는 KeyboardInterrupt를 내고 `>>> `로 돌아온다", async () => {
  await clear();
  await type("abc");
  await ctrlC();
  await waitPrompt(">>>", 8000);
  const t = await tail(3);
  if (!same(t, [">>> abc", "KeyboardInterrupt", ">>>"])) throw new Error(show(t));
});
await check("B2 입력 버퍼가 비워져 abc가 다음 입력에 섞이지 않는다", async () => {
  await run("print(1)");
  const t = await tail(3);
  if (!same(t, [">>> print(1)", "1", ">>>"])) throw new Error(show(t));
  if ((await rows()).join("").includes("abcprint")) throw new Error("abc가 섞였다");
});

// ── W2(RD-006b): 꼬리가 든 프롬프트(`t>>> abc`)에서 취소
await check("W2 꼬리가 든 프롬프트(`t>>> abc`)에서도 취소가 같다", async () => {
  await clear();
  await type('print("t", end="")');
  await enter();
  await waitLastEndsWith(">>>", 8000);
  await type("abc");
  await ctrlC();
  await waitPrompt(">>>", 8000);
  const t = await tail(4);
  if (!same(t, ['>>> print("t", end="")', "t>>> abc", "KeyboardInterrupt", ">>>"])) throw new Error(show(t));
});

// ── C(RD-012b): 본문 줄까지 쌓인 블록 전체를 버린다
await check("C1 본문 줄이 쌓인 블록도 같은 형식으로 취소된다", async () => {
  await clear();
  await openBlock();
  await type("print(2)"); // RD-013 프리필(4칸)이 이미 채워져 있다 — 수동 들여쓰기를 치지 않는다.
  await enter();
  await waitPrompt("...", 8000);
  await ctrlC();
  await waitPrompt(">>>", 8000);
  const t = await tail(5);
  if (!same(t, [">>> if True:", "...     print(2)", "...", "KeyboardInterrupt", ">>>"])) throw new Error(show(t));
});
await check("C2 취소된 본문(print(2))은 실행되지 않는다", async () => {
  await run("print(1)");
  const t = await tail(3);
  if (!same(t, [">>> print(1)", "1", ">>>"])) throw new Error(show(t));
  if ((await rows()).some((r) => r === "2")) throw new Error("2가 출력됐다");
});

// ── D(RD-012b): Shift+Enter로 만든 여러 줄 편집 버퍼
await check("D1 여러 줄 편집 버퍼 Ctrl+C는 버퍼 아래에 KeyboardInterrupt를 낸다", async () => {
  await clear();
  await type("if True:");
  await press("Shift+Enter");
  await page.waitForTimeout(300);
  await type("print(3)"); // RD-013 프리필(4칸)이 Shift+Enter 줄에도 채워진다 — 화면은 `    print(3)`이 된다.
  await ctrlC();
  await waitPrompt(">>>", 8000);
  const t = await tail(4);
  if (!same(t, [">>> if True:", "    print(3)", "KeyboardInterrupt", ">>>"])) throw new Error(show(t));
});
await check("D2 취소 뒤 print(1)이 1을 내고 3은 출력되지 않는다", async () => {
  await run("print(1)");
  const t = await tail(3);
  if (!same(t, [">>> print(1)", "1", ">>>"])) throw new Error(show(t));
  if ((await rows()).some((r) => r === "3")) throw new Error("3이 출력됐다");
});
await check("D3 커서가 버퍼 앞쪽이어도 마지막 줄 아래에 KeyboardInterrupt가 나온다", async () => {
  await clear();
  await type("if True:");
  await press("Shift+Enter");
  await page.waitForTimeout(300);
  await type("print(3)"); // RD-013 프리필(4칸)이 Shift+Enter 줄에도 채워진다 — 화면은 `    print(3)`이 된다.
  await press("Control+a");
  await page.waitForTimeout(200);
  await ctrlC();
  await waitPrompt(">>>", 8000);
  const t = await tail(4);
  if (!same(t, [">>> if True:", "    print(3)", "KeyboardInterrupt", ">>>"])) throw new Error(show(t));
});

// ── E(RD-012b): `input()` 중 Ctrl+C는 취소다
await check("E1 `input()` 중 Ctrl+C는 호출 지점의 트레이스백을 낸다(RD-012b 기대값 갱신)", async () => {
  await clear();
  await type("ans_e = input()");
  await enter();
  await cancelWhenReading("abc");
  await waitPrompt(">>>", 10000);
  const t = await tail(6);
  if (
    !same(t, [
      ">>> ans_e = input()",
      "abc",
      "Traceback (most recent call last):",
      '  File "<console>", line 1, in <module>',
      "KeyboardInterrupt",
      ">>>",
    ])
  )
    throw new Error(show(t));
});
await check("E2 취소된 `input()`은 대입하지 않는다(NameError)", async () => {
  await clear();
  await run("ans_e");
  if (!(await rows()).join("").includes("NameError")) throw new Error(show(await tail(5)));
});

// ── F(RD-012b): 실행 중 Ctrl+C는 RD-007 동작 그대로다
await check("F1 실행 중 Ctrl+C는 KeyboardInterrupt 트레이스백으로 중단된다", async () => {
  await clear();
  await startBlockLine("while True: pass");
  await page.waitForTimeout(400);
  await ctrlC();
  await waitPromptTail(15000);
  if ((await countTracebacks()) !== 1) throw new Error(`트레이스백 ${await countTracebacks()}개`);
  if (!(await rows()).join("").includes("KeyboardInterrupt")) throw new Error(show(await tail(6)));
});
await check("F2 중단 뒤에도 입력을 계속 받는다", async () => {
  await clear();
  await run("print(1)");
  const t = await tail(3);
  if (!same(t, [">>> print(1)", "1", ">>>"])) throw new Error(show(t));
});

// ── H1(RD-012b): 취소한 줄은 history에 없다
await check("H1 취소한 abc는 history에 없다(↑ 30회 동안 한 번도 나오지 않는다)", async () => {
  await clear();
  await type("abc");
  await ctrlC();
  await waitPrompt(">>>", 8000);
  await run("print(1)");
  const recalled = [];
  for (let i = 0; i < 30; i += 1) {
    await press("ArrowUp");
    await page.waitForTimeout(120);
    recalled.push(await lastLine());
  }
  await press("Control+u");
  if (recalled[0] !== ">>> print(1)") throw new Error(`첫 재호출 ${show(recalled[0])}`);
  if (recalled.includes(">>> abc")) throw new Error(`abc가 돌아왔다 ${show([...new Set(recalled)])}`);
});

// ── I(RD-012b): 취소 직후 연타. `^C` 0이 `cancelSettling`의 판정이고, 이어지는 실행이 죽지 않아야 한다.
/** 연타 셀의 수치 기록. 결과 JSON의 `burstNotes`로 나간다. */
const burstNotes = {};
/** 취소 직후 연타(`fire`)를 넣는 셀을 돌린다. `^C`가 0이고 뒤이은 실행이 죽지 않아야 통과한다. */
async function storm(id, label2, fire) {
  await check(`${id} ${label2}: \`^C\` 0이고 뒤이은 실행이 죽지 않는다`, async () => {
    await clear();
    await openBlock();
    await fire();
    await waitPrompt(">>>", 12000);
    await settled(250).catch(() => {});
    const carets = await caretCount();
    burstNotes[id] = { carets, interrupts: await interruptCount(), tail: await tail(4) };
    if (carets !== 0) throw new Error(`^C ${carets}개 — ${show(await tail(5))}`);
    await clear();
    await startBlockLine("for i in range(300000): pass");
    await waitPrompt(">>>", 20000);
    await type("print('ok')");
    await enter();
    await waitPrompt(">>>", 20000);
    const t = await tail(3);
    if (!same(t, [">>> print('ok')", "ok", ">>>"])) throw new Error(show(t));
    if ((await countTracebacks()) !== 0) throw new Error("잔류 SIGINT가 트레이스백을 냈다");
  });
}
await storm("I1", "0ms 2회", () => ctrlCBurst(2));
await storm("I2", "0ms 5회", () => ctrlCBurst(5));
await storm("I3", "키 반복 20회", () => holdCtrlC(20));

await step("대상 pageerror가 없다(webloop 재보고 제외)", async () => {
  const errs = h.otherPageErrors();
  if (errs.length > 0) throw new Error(show(errs));
});

console.log(`관찰  연타 셀 수치: ${JSON.stringify(burstNotes)}`);
const ok = await h.finish({ label, burstNotes });
exitWith(ok);
