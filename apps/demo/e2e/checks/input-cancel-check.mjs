// RD-008 브라우저 검증 ②: `input()`·`sys.stdin.readline()` 대기 중 Ctrl+C 취소. 출처 RD-008에서 이관(RD-018).
// 이전 구현 RD-012c의 브라우저 ID를 새 데모로 이식하고, RD-006b에서 RD-008로 넘긴 ID(A1~A5·B1·B2·C1·C2·D1·E2·H1·H2·Q1)를
// 복원하고, 판정 항목 EC(확정 7)와 양성 대조 ② 전용 T35를 넣었다. 건너뛰는 ID는 J1·J2(→ RD-010).
// 기대 바이트는 node 시험의 `CONSOLE_TRACEBACK`과 같다:
//   'Traceback (most recent call last):' / '  File "<console>", line 1, in <module>' / 'KeyboardInterrupt'
// 3.14.4 실제 REPL은 이 트레이스백을 입력 줄에 개행 없이 붙이고 `_pyrepl` 프레임 4개를 더 보인다(`pty/results.md` ⑤⑥ → 편차 35).
// 이식 시 고친 기대값: A1의 둘째 행은 `>>> abc`가 아니라 `abc`, C2는 `in f: abc` 한 행,
// H1은 `...`/`a`/`a`/`b`/`Traceback…`.
// 사용: node input-cancel-check.mjs <url>(생략 시 http://localhost:5173)     ONLY=RM2,EC node input-cancel-check.mjs <url>
// 결과 파일 label은 url 포트 4173이면 preview, 그 밖은 dev(RD-018 결정).
import { checkEntry, exitWith, serverLabel } from "../check-runner.mjs";
import { open, same, show } from "../lib.mjs";

const { url } = checkEntry();
const label = serverLabel(url);

const TRACEBACK_HEAD = "Traceback (most recent call last):";
const CONSOLE_FRAME = '  File "<console>", line 1, in <module>';

const h = await open(url);
const {
  step, waitPrompt, waitPromptTail, clear, type, enter, press, tail, rows, lastLine, spansOf,
  cursorRow, focus, settled, ctrlC, ctrlCBurst, holdCtrlC, caretCount, cancelWhenReading,
  typeWhenReading, startBlockLine, countTracebacks, resetPrompt, markText, readMark, page,
} = h;

async function recover() {
  for (let i = 0; i < 12; i += 1) {
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
async function check(name, fn) {
  await step(name, fn);
  if (h.checks[name] === false) await recover();
}
async function run(code) {
  await type(code);
  await enter();
  await waitPrompt(">>>");
}
/** 꼬리(`^C…`)가 남았으면 빈 Enter로 깨끗한 프롬프트를 만든 뒤 화면을 지운다. */
async function freshScreen() {
  const last = (await rows()).filter((r) => r !== "").at(-1) ?? "";
  if (last !== ">>>") await resetPrompt();
  await clear();
}
/** 코드를 제출하고 읽기가 열린 것을 확인한 뒤 취소한다. */
async function cancelInput(code, text = "abc") {
  await type(code);
  await enter();
  await cancelWhenReading(text);
  await waitPromptTail(15000);
}
const screenText = async () => (await rows()).join("\n");
/**
 * 화면에 `text`와 **정확히 같은 행**이 있는지. 제출한 소스 줄이 화면에 에코되므로(`print('wrong')` 등)
 * 부분일치로 출력을 판정하면 소스 줄에 걸려 거짓 통과·거짓 실패가 난다.
 */
const hasRow = async (text) => (await rows()).some((r) => r === text);
/** 화면 전체에서 `needle`의 개수. 소스 줄이 이미 포함하고 있으면 기준선을 잡아 증가분으로 본다. */
const countOf = async (needle) => (await rows()).join("").split(needle).length - 1;

await check("초기: 프롬프트가 뜬다", async () => {
  await waitPrompt(">>>", 60000);
  await focus();
});

// ── RM2(ROADMAP) + A1~A5(RD-012c·RD-006b)
await check("RM2/A1 `input()` 대기 중 Ctrl+C는 입력 줄 아래 트레이스백을 내고 `>>> `로 돌아온다", async () => {
  await freshScreen();
  await cancelInput("ans_a = input()");
  const t = await tail(6);
  if (!same(t, [">>> ans_a = input()", "abc", TRACEBACK_HEAD, CONSOLE_FRAME, "KeyboardInterrupt", ">>>"]))
    throw new Error(show(t));
});
await check("A2 `^C`를 찍지 않는다", async () => {
  const n = await caretCount();
  if (n !== 0) throw new Error(`^C ${n}개 — ${show(await tail(6))}`);
});
await check("A3 KeyboardInterrupt는 빨강(writeError)이다", async () => {
  const spans = await spansOf("KeyboardInterrupt");
  if (!spans.some((s) => /xterm-fg-1\b/.test(s.cls))) throw new Error(show(spans));
});
await check("A4 대입이 일어나지 않아 ans_a가 없다(NameError)", async () => {
  await freshScreen();
  await run("print(ans_a)");
  if (!(await screenText()).includes("NameError: name 'ans_a' is not defined")) throw new Error(show(await tail(5)));
});
await check("A5 취소 뒤 REPL 입력이 정상이다", async () => {
  await freshScreen();
  await run("print(1)");
  const t = await tail(3);
  if (!same(t, [">>> print(1)", "1", ">>>"])) throw new Error(show(t));
});

// ── Q1(RD-006b): 프롬프트 인자가 있는 `input()`
await check('Q1 `input("x: ")` 취소는 `x: abc` 한 행 아래에 트레이스백을 낸다', async () => {
  await freshScreen();
  await cancelInput('ans_q = input("x: ")');
  const t = await tail(6);
  if (!same(t, ['>>> ans_q = input("x: ")', "x: abc", TRACEBACK_HEAD, CONSOLE_FRAME, "KeyboardInterrupt", ">>>"]))
    throw new Error(show(t));
});

// ── B(RD-012c·RD-006b): try/except와 finally
await check("B1 `except KeyboardInterrupt`가 잡아 caught만 나온다(트레이스백 없음)", async () => {
  await freshScreen();
  await type(`exec("try:\\n input()\\nexcept KeyboardInterrupt:\\n print('caught')")`);
  await enter();
  await cancelWhenReading("z");
  await waitPrompt(">>>", 15000);
  const t = await tail(3);
  if (t[1] !== "caught" || t[2] !== ">>>") throw new Error(show(await tail(5)));
  if ((await countTracebacks()) !== 0) throw new Error(`트레이스백이 났다 ${show(await tail(6))}`);
});
await check("B2 `except Exception`은 취소를 잡지 못한다", async () => {
  await freshScreen();
  await type(`exec("try:\\n input()\\nexcept Exception:\\n print('wrong')")`);
  await enter();
  await cancelWhenReading("z");
  await waitPromptTail(15000);
  if (await hasRow("wrong")) throw new Error(`Exception이 잡았다 ${show(await tail(6))}`);
  if (!(await hasRow("KeyboardInterrupt"))) throw new Error(show(await tail(6)));
});
await check("B3 `finally`가 실행된다(ROADMAP 목표)", async () => {
  await freshScreen();
  await type(`exec("try:\\n try:\\n  input()\\n finally:\\n  print('fin')\\nexcept KeyboardInterrupt:\\n pass")`);
  await enter();
  await cancelWhenReading("z");
  await waitPrompt(">>>", 15000);
  if (!(await hasRow("fin"))) throw new Error(show(await tail(5)));
});

// ── C(RD-012c·RD-006b): 함수 안 취소
await check("C1 함수 안 취소는 그 함수 프레임을 트레이스백에 보인다", async () => {
  await freshScreen();
  await run(`exec("def f():\\n return input('in f: ')")`);
  await freshScreen();
  await cancelInput("f()");
  const text = await screenText();
  if (!text.includes('  File "<string>", line 2, in f')) throw new Error(show(await tail(8)));
  if (!/KeyboardInterrupt/.test(text)) throw new Error(show(await tail(8)));
});
await check("C2 프롬프트 인자와 입력이 `in f: abc` 한 행이다(기대값 갱신)", async () => {
  const t = await tail(7);
  if (!same(t, [
    ">>> f()",
    "in f: abc",
    TRACEBACK_HEAD,
    CONSOLE_FRAME,
    '  File "<string>", line 2, in f',
    "KeyboardInterrupt",
    ">>>",
  ]))
    throw new Error(show(t));
});

// ── D1(RD-012c·RD-006b): sys.stdin.readline()
await check("D1 `sys.stdin.readline()` 취소도 같은 트레이스백이다(EOFError·빈 문자열이 아니다)", async () => {
  await freshScreen();
  await cancelInput("import sys; sys.stdin.readline()");
  const t = await tail(6);
  if (!same(t, [">>> import sys; sys.stdin.readline()", "abc", TRACEBACK_HEAD, CONSOLE_FRAME, "KeyboardInterrupt", ">>>"]))
    throw new Error(show(t));
  if ((await screenText()).includes("EOFError")) throw new Error("EOFError가 났다");
});

// ── E(RD-012c·RD-006b): 정상 input()과 history
await check("E1 정상 `input()`은 입력한 값을 돌려준다", async () => {
  await freshScreen();
  await type("ans_e = input()");
  await enter();
  await typeWhenReading("hello");
  await enter();
  await waitPrompt(">>>", 15000);
  await freshScreen();
  await run("ans_e");
  const t = await tail(3);
  if (!same(t, [">>> ans_e", "'hello'", ">>>"])) throw new Error(show(t));
});
await check("E2 취소한 입력은 history에 없고 제출한 문장은 남아 있다", async () => {
  await freshScreen();
  await cancelInput("ans_h = input()", "secret-h");
  await waitPrompt(">>>", 15000);
  const recalled = [];
  for (let i = 0; i < 30; i += 1) {
    await press("ArrowUp");
    await page.waitForTimeout(120);
    recalled.push(await lastLine());
  }
  await press("Control+u");
  if (recalled.some((l) => l.includes("secret-h"))) throw new Error(`취소한 입력이 돌아왔다 ${show([...new Set(recalled)].slice(0, 6))}`);
  if (!recalled.includes(">>> ans_h = input()")) throw new Error(`제출한 문장이 없다 ${show([...new Set(recalled)].slice(0, 6))}`);
});

// ── F×3(RD-006b F, RD-012c F): 취소 연타 뒤 생존. `^C`는 판정이 아니라 기록(편차 36).
const burstNotes = {};
async function storm(id, label2, fire) {
  await check(`${id} ${label2}: 트레이스백 1개·프롬프트 복귀·뒤이은 실행 생존`, async () => {
    await freshScreen();
    await type("ans_s = input()");
    await enter();
    await typeWhenReading("ab");
    await fire();
    await waitPromptTail(15000);
    await settled(250).catch(() => {});
    burstNotes[id] = { carets: await caretCount(), tracebacks: await countTracebacks() };
    if (burstNotes[id].tracebacks !== 1) throw new Error(`트레이스백 ${burstNotes[id].tracebacks}개 — ${show(await tail(6))}`);
    await freshScreen();
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
await storm("F1", "0ms 2회", () => ctrlCBurst(2));
await storm("F2", "0ms 5회", () => ctrlCBurst(5));
await storm("F3", "키 반복 20회", () => holdCtrlC(20));

// ── G(RD-012c): 기존 동작 유지
await check("G1 실행 중 Ctrl+C는 KeyboardInterrupt 트레이스백으로 중단된다", async () => {
  await freshScreen();
  await startBlockLine("while True: pass");
  await page.waitForTimeout(400);
  await ctrlC();
  await waitPromptTail(15000);
  if ((await countTracebacks()) !== 1) throw new Error(`트레이스백 ${await countTracebacks()}개`);
});
await check("G2 중단 뒤에도 입력을 계속 받는다", async () => {
  await freshScreen();
  await run("print(1)");
  const t = await tail(3);
  if (!same(t, [">>> print(1)", "1", ">>>"])) throw new Error(show(t));
});
await check("G3 REPL 프롬프트 Ctrl+C는 KeyboardInterrupt 한 줄로 취소한다", async () => {
  await freshScreen();
  await type("abc");
  await ctrlC();
  await waitPrompt(">>>", 8000);
  const t = await tail(3);
  if (!same(t, [">>> abc", "KeyboardInterrupt", ">>>"])) throw new Error(show(t));
});

// ── H(RD-012c·RD-006b): 블록 안 두 번째 input() 취소
await check("H1 블록 안 두 번째 `input()` 취소: 첫 값은 출력되고 트레이스백 뒤 `>>> `로 돌아온다(기대값 갱신)", async () => {
  await freshScreen();
  await type("for n in range(3): print(input())");
  await enter();
  await waitPrompt("...", 8000);
  await enter();
  await typeWhenReading("a");
  await enter();
  await cancelWhenReading("b");
  await waitPromptTail(15000);
  const t = await tail(9);
  if (!same(t, [
    ">>> for n in range(3): print(input())",
    "...",
    "a",
    "a",
    "b",
    TRACEBACK_HEAD,
    CONSOLE_FRAME,
    "KeyboardInterrupt",
    ">>>",
  ]))
    throw new Error(show(t));
});
await check("H2 취소 뒤에도 제출한 블록이 history에 남아 있다(RD-014 조건부)", async () => {
  const recalled = [];
  for (let i = 0; i < 4; i += 1) {
    await press("ArrowUp");
    await page.waitForTimeout(150);
    recalled.push(await lastLine());
  }
  await press("Control+u");
  if (!recalled.some((l) => l.includes("for n in range(3): print(input())"))) throw new Error(show(recalled));
});

// ── EC(확정 7, 판정): `except`로 취소를 잡은 뒤 이어지는 계산 중 Ctrl+C가 곧 중단한다
await check("EC `except KeyboardInterrupt` 뒤 4초 계산 중 Ctrl+C가 1초(× E2E_TIME_SCALE) 이내에 중단한다", async () => {
  await freshScreen();
  await type(
    `exec("import time\\ntry:\\n input()\\nexcept KeyboardInterrupt:\\n pass\\nt = time.time()\\nwhile time.time() - t < 4: pass\\nprint('loop-done')")`,
  );
  await enter();
  await cancelWhenReading("z");
  // 제출한 소스 줄이 `KeyboardInterrupt`·`loop-done`을 글자로 담고 있다(줄이 80열에서 감겨 `KeyboardInterrupt`는 첫 행에
  // `except`와 함께 있다). 첫 취소는 `except`가 잡아 트레이스백이 없으므로, 소스 줄을 뺀(`exclude: "except"`) 행에서
  // `KeyboardInterrupt`가 나오면 그것이 중단 트레이스백이다. `loop-done`은 눌림 직전의 개수를 기준선으로 증가분만 본다.
  await page.waitForTimeout(1200);
  const baseDone = await countOf("loop-done");
  // Ctrl+C `keydown`의 페이지 시각부터 재므로 Node↔CDP 왕복과 폴링 간격이 값에 섞이지 않는다(TRP-022).
  await markText("KeyboardInterrupt", { exclude: "except", startOnKey: { key: "c", ctrlKey: true } });
  await ctrlC();
  let elapsed = -1;
  try {
    ({ elapsedMs: elapsed } = await readMark({ timeoutMs: 15000 }));
  } catch (err) {
    if ((await countOf("loop-done")) > baseDone) throw new Error("Ctrl+C가 무시돼 loop-done이 나왔다");
    throw err;
  }
  burstNotes.EC = { elapsedMs: Math.round(elapsed * 10) / 10 };
  if ((await countOf("loop-done")) > baseDone) throw new Error(`Ctrl+C가 무시돼 loop-done이 나왔다(중단 표시 ${elapsed}ms)`);
  // 응답성 수치 자체가 요구 사항이라 9.7 2항의 상한 예외다(`ROADMAP.md:184` RD-009 시나리오의 Ctrl+C 응답성 요구). 결함(Ctrl+C 무시·지연)이면
  // 값이 `loop-done`이 나오는 4초 근처로 뛰므로 1초로 가른다. 정상 쪽에는 동시 실행 부하 여유를 둔다(L0 SIGINT 상한도 1초).
  // 느린 장비는 `E2E_TIME_SCALE`로 곱한다(기본 1).
  const limitMs = 1000 * h.timeScale;
  if (elapsed > limitMs) throw new Error(`중단까지 ${elapsed.toFixed(1)}ms(상한 ${limitMs}ms = 1000 × 배율 ${h.timeScale} 초과)`);
  await waitPromptTail(15000);
});

// ── T35(양성 대조 ② 전용): 실행 중 눌림을 한 번 처리한 뒤의 취소도 처리된다
await check("T35 실행 중 눌림을 처리한 뒤의 `input()` 취소도 무시되지 않는다", async () => {
  await freshScreen();
  await startBlockLine("while True: pass");
  await page.waitForTimeout(400);
  await ctrlC();
  await waitPromptTail(15000);
  await freshScreen();
  await cancelInput("ans_t = input()");
  const t = await tail(6);
  if (!same(t, [">>> ans_t = input()", "abc", TRACEBACK_HEAD, CONSOLE_FRAME, "KeyboardInterrupt", ">>>"]))
    throw new Error(show(t));
});

await step("대상 pageerror가 없다(webloop 재보고 제외)", async () => {
  const errs = h.otherPageErrors();
  if (errs.length > 0) throw new Error(show(errs));
});

console.log(`관찰  수치: ${JSON.stringify(burstNotes)}`);
const ok = await h.finish({ label, burstNotes });
exitWith(ok);
