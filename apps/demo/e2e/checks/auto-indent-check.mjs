// RD-013(자동 들여쓰기)을 실제 브라우저로 검증한다. 규칙은 docs/design/06-editing.md 6.3.
//
// 절 구성(확인 이름의 접두어가 절 이름이다):
// - prefill: `:`로 끝난 줄 다음 줄에 4칸이 채워진다.
// - backspace: Backspace가 들여쓰기 단위까지 지운다.
// - unit: 들여쓰기 단위가 세션 동안 유지되고, 세션 리셋 뒤 4칸으로 돌아온다.
// - history: 블록을 공백 줄로 끝낸 뒤 ↑가 블록 전체를 돌려준다(RD-014).
// - shift·alt: Shift+Enter·Alt+Enter도 같은 규칙으로 채운다.
// - paste: 붙여넣은 블록은 들여쓰기를 더하지 않는다.
// - cancel: 취소해도 들여쓰기 단위와 화면 형식은 그대로다(RD-012b 이월, RD-008이 건너뛴 ID).
// - input: `input()` 읽기에는 자동 들여쓰기가 없다.
// - multiline-shift: `multiline-check.mjs`의 shift 절 복원.
//
// 실행 순서: 위 순서대로 한 세션에서 이어 돈다. 순서가 들여쓰기 단위(`lastUsedIndentation`) 상태를 만든다.
// - unit D1이 단위를 2칸으로 바꾼다. D2가 새 블록에서 2칸이 유지되는지 본다. D3가 리셋해 4칸으로 되돌린다.
// - cancel G1이 다시 2칸으로 바꾼다. 4칸을 전제하는 cancel C1은 앞에서 리셋한다.
// - 각 확인은 `reset()`(Ctrl+C, 프롬프트, Ctrl+L)으로 시작한다.
// - 예외: 앞 확인의 화면 상태를 잇는 확인(shift F2, alt F4, cancel D2, input 8칸).
// - 예외: 세션 리셋으로 시작하는 확인(unit D3, cancel C1).
//
// dev와 preview를 한 프로세스에서 돈다. preview는 초기·prefill·shift·unit만 돈다(RD-044 K6).
// 사용법·`ONLY`·결과 파일 이름은 apps/demo/e2e/README.md.
import { open, same, show } from "../lib.mjs";
import { checkEntry, exitWith, runDevPreview, serverLabel } from "../check-runner.mjs";

/**
 * 서버 하나(dev 또는 preview)에서 `ONLY`로 고른 확인을 위 순서대로 실행하고 결과 JSON을 남긴다.
 * `ONLY`는 `lib.mjs` `step()`의 접두어 검사로 확인 이름을 거른다. 초기는 항상 실행한다.
 */
async function run(url) {
  const h = await open(url);
  const {
    page, step, waitPrompt, waitStatus, clear, type, enter, press, paste, tail, rows,
    cursorRow, focus, statusText, typeWhenReading, ctrlC,
  } = h;

  // 커서 행에서 커서 앞(DOM 순서상 앞) 텍스트의 길이(열 좌표)를 돌려준다. 커서 행이 없으면 -1.
  const cursorCol = () =>
    page.evaluate(() => {
      const rows = [...document.querySelectorAll(".xterm-rows > div")];
      const row = rows.find((r) => r.querySelector(".xterm-cursor"));
      if (!row) return -1;
      let col = 0;
      for (const child of row.childNodes) {
        if (child.nodeType === 1 && child.classList?.contains("xterm-cursor")) break;
        col += (child.textContent ?? "").length;
      }
      return col;
    });
  // 커서 행의 원문을 돌려준다. `rows()`와 달리 끝 공백을 자르지 않는다. 프리필이 공백뿐일 때 필요하다.
  const cursorLineRaw = () =>
    page.evaluate(() => {
      const rows = [...document.querySelectorAll(".xterm-rows > div")];
      const row = rows.find((r) => r.querySelector(".xterm-cursor"));
      return row ? row.textContent.replace(/ /g, " ") : null;
    });
  // 한 문장을 실행하고 다음 `>>> `를 기다린다.
  async function submitLine(code) {
    await type(code);
    await enter();
    await waitPrompt(">>>");
  }
  // `header`(기본 `if True:`)를 제출해 `... ` 프롬프트까지 간다.
  async function openBlock(header = "if True:") {
    await type(header);
    await enter();
    await waitPrompt("...");
  }
  // 다음 확인을 깨끗한 `>>> `에서 시작한다.
  // 앞 확인이 단언 실패로 도중에 멈추면 `... ` 같은 열린 읽기가 남는다.
  // 그때 `clear()`(Ctrl+L)만으로는 화면만 지워지고 읽기가 안 끝나 다음 확인의 `clear()`가 시간 초과한다.
  // 그래서 먼저 Ctrl+C로 취소한다. 빈 `>>> `에서도 안전하다(prompt-cancel-check.mjs B0과 같다).
  async function reset() {
    await ctrlC();
    await waitPrompt(">>>", 8000);
    await page.waitForTimeout(250); // 취소 직후의 재그리기가 비동기라 바로 Ctrl+L을 누르면 놓친다
    await clear();
  }
  // 리셋 버튼을 누르고 새 세션의 첫 프롬프트까지 기다린다. 끝은 안내 줄 개수가 아니라 status로 판정한다(TRP-024).
  async function resetSession() {
    await page.click('[data-testid="reset"]');
    await waitStatus(["loading"], "리셋: loading 상태");
    await waitStatus(["ready", "load-failed"], "리셋: ready 상태", 30000);
    if ((await statusText()) === "load-failed") throw new Error("리셋 뒤 load-failed");
    await focus();
    await waitPrompt(">>>", 30000);
  }

  await step("초기", async () => {
    await waitPrompt(">>>", 60000);
    await focus();
  });

  // ── prefill: `:`로 끝난 줄 다음 줄에 4칸이 채워지고, 본문 줄 뒤에도 유지된다. 본문이 있으면 공백뿐인 줄에서 Enter로 블록이 끝난다. ──
  await step("prefill 기본: `for i in range(2):` Enter 뒤 커서가 `... ` + 4칸 끝에 있다", async () => {
    await reset();
    await type("for i in range(2):");
    await enter();
    await waitPrompt("...");
    if ((await cursorCol()) !== 8) throw new Error(`cursorCol=${await cursorCol()}, 행=${show(await cursorLineRaw())}`);
    await ctrlC(); // 본문 없는 블록이라 Enter로 닫을 수 없다. 취소로 정리한다.
    await waitPrompt(">>>", 8000);
  });

  await step("prefill B1 본문 없이 Enter를 눌러도 블록이 유지되고 다시 4칸이 채워진다", async () => {
    await reset();
    await openBlock();
    await enter(); // 빈 프리필 줄에서 Enter. 블록이 끝나지 않는다.
    await waitPrompt("...");
    await type("z");
    if (!/^\.\.\. {5}z$/.test((await tail(1))[0] ?? "")) throw new Error(show(await tail(2)));
    await press("Backspace"); // z만 지운다(프리필 4칸은 남는다)
    await type("pass");
    await enter();
    await waitPrompt("...");
    await enter(); // 이제 본문이 있으니 빈 줄로 블록이 닫힌다.
    await waitPrompt(">>>");
  });

  await step("prefill B2 본문을 채우고 공백 줄에서 Enter하면 블록이 실행된다(0·1)", async () => {
    await reset();
    await type("for i in range(2):");
    await enter();
    await waitPrompt("...");
    await type("print(i)");
    await enter();
    await waitPrompt("...");
    await enter();
    await waitPrompt(">>>");
    const t = await tail(4);
    if (!same(t, ["...", "0", "1", ">>>"])) throw new Error(show(t));
  });

  // ── backspace: 단위 배수까지 지운다 ──
  await step("backspace C1 자동 4칸은 Backspace 한 번에 사라진다(커서가 프롬프트 바로 뒤)", async () => {
    await reset();
    await type("for i in range(2):");
    await enter();
    await waitPrompt("...");
    await press("Backspace");
    await page.waitForTimeout(300); // 재그리기가 비동기라 즉시 읽으면 낡은 커서 열을 본다
    if ((await cursorCol()) !== 4) throw new Error(`cursorCol=${await cursorCol()}`);
    await type("z");
    if (!/^\.\.\. z$/.test((await tail(1))[0] ?? "")) throw new Error(show(await tail(1)));
    // 여기까지는 본문이 없는 블록이다. z는 확인용으로 쳤다가 지운다.
    // 이 상태의 빈 줄 Enter는 블록을 닫지 않고 `... `를 다시 채운다(B1과 같다). 그래서 취소로 정리한다.
    await press("Backspace");
    await ctrlC();
    await waitPrompt(">>>", 8000);
  });

  await step("backspace C2 Backspace로 dedent한 뒤 빈 줄 Enter하면 블록이 끝나 실행된다(0·1)", async () => {
    await reset();
    await type("for i in range(2):");
    await enter();
    await waitPrompt("...");
    // 프리필(4칸) 위에 그대로 친다. 직접 들여쓰기를 더 치면 lastUsedIndentation이 8칸으로 오염된다.
    await type("print(i)");
    await enter();
    await waitPrompt("...");
    await press("Backspace"); // 4칸 → 0칸
    await enter(); // 빈 줄이라 블록 종료
    await waitPrompt(">>>");
    const t = await tail(3);
    if (!same(t, ["0", "1", ">>>"])) throw new Error(show(t));
  });

  await step("backspace C3 8칸에서 Backspace 한 번은 4칸만 지운다", async () => {
    await reset();
    await type("if True:");
    await enter();
    await waitPrompt("...");
    await type("if True:"); // 첫 프리필(4칸) 위에 이어 쳐서 "    if True:"를 제출한다. 다음 줄은 8칸이 된다.
    await enter();
    await waitPrompt("...");
    if ((await cursorCol()) !== 12) throw new Error(`중첩 프리필 cursorCol=${await cursorCol()}(기대 12 = 프롬프트 4 + 8칸)`);
    await press("Backspace");
    await page.waitForTimeout(300);
    if ((await cursorCol()) !== 8) throw new Error(`Backspace 뒤 cursorCol=${await cursorCol()}(기대 8 = 프롬프트 4 + 4칸)`);
    await type("z");
    if (!/^\.\.\. {5}z$/.test((await tail(1))[0] ?? "")) throw new Error(show(await tail(1)));
    // 여기서 "pass"를 그대로 채우면 중첩 if의 본문치고 얕아(4칸) IndentationError가 난다. C4가 그 경로를 본다.
    // 이 확인은 Backspace 폭만 보므로 취소로 정리한다.
    await press("Backspace");
    await ctrlC();
    await waitPrompt(">>>", 8000);
  });

  await step("backspace C4 잘못된 들여쓰기는 오류를 내고 `>>> `로 돌아온다", async () => {
    await reset();
    await type("if True:");
    await enter();
    await waitPrompt("...");
    await press("Backspace");
    await type("pass");
    await enter();
    await waitPrompt(">>>", 8000);
    if (!(await rows()).some((r) => /Error/.test(r))) throw new Error(show(await tail(4)));
  });

  // ── unit: 세션 동안 유지되는 들여쓰기 단위 ──
  await step("unit D1 2칸으로 쓴 줄 다음도 2칸이 유지된다(같은 블록)", async () => {
    await reset();
    await openBlock();
    await press("Backspace"); // 자동 4칸 → 0칸
    await type("  x = 1");
    await enter();
    await waitPrompt("...");
    await type("z");
    if (!/^\.\.\. {3}z$/.test((await tail(1))[0] ?? "")) throw new Error(show(await tail(1)));
    await press("Backspace");
    await enter();
    await waitPrompt(">>>");
  });

  await step("unit D2 이전 블록에서 본 2칸이 새 블록에도 쓰인다(세션 유지)", async () => {
    await reset();
    await openBlock();
    await type("z");
    if (!/^\.\.\. {3}z$/.test((await tail(1))[0] ?? "")) throw new Error(show(await tail(1)));
    await press("Backspace");
    await type("pass");
    await enter();
    await waitPrompt("...");
    await enter();
    await waitPrompt(">>>");
  });

  await step("unit D3 세션 리셋 뒤 단위가 다시 4칸이 된다", async () => {
    await resetSession();
    await type("if True:");
    await enter();
    await waitPrompt("...");
    await type("z");
    if (!/^\.\.\. {5}z$/.test((await tail(1))[0] ?? "")) throw new Error(show(await tail(1)));
    await press("Backspace");
    await ctrlC();
    await waitPrompt(">>>", 8000);
  });

  // ── history: 블록을 공백뿐인 줄로 끝내도 ↑는 블록 전체(한 항목)를 돌려준다 ──
  await step("history E1 블록을 공백 줄로 끝낸 뒤 ↑는 블록 전체를 돌려준다(RD-014 block-history)", async () => {
    await reset();
    await type("for i in range(2):");
    await enter();
    await waitPrompt("...");
    await type("print(i)");
    await enter();
    await waitPrompt("...");
    await enter();
    await waitPrompt(">>>");
    await press("ArrowUp");
    await page.waitForTimeout(300); // history 복귀 재그리기가 비동기다
    const t = await tail(2);
    if (!same(t, [">>> for i in range(2):", "    print(i)"])) throw new Error(show(t));
    await press("Control+u");
  });

  // ── shift·alt: Shift+Enter·Alt+Enter도 같은 규칙으로 채운다 ──
  await step("shift F1 Shift+Enter 다음 줄에 4칸이 채워진다", async () => {
    await reset();
    await type("for i in range(2):");
    await press("Shift+Enter");
    await type("print(i)");
    const t = await tail(2);
    if (!/^ {4}print\(i\)$/.test(t[1] ?? "")) throw new Error(show(t));
  });
  await step("shift F2 Shift+Enter로 만든 여러 줄이 Enter 1회로 실행된다(0·1)", async () => {
    await enter();
    await waitPrompt(">>>");
    const t = await tail(3);
    if (!same(t, ["0", "1", ">>>"])) throw new Error(show(t));
  });

  await step("alt F3 Alt+Enter도 다음 줄에 4칸이 채워진다", async () => {
    await reset();
    await type("if True:");
    await press("Alt+Enter");
    await type('print("alt")');
    const t = await tail(2);
    if (!/^ {4}print\("alt"\)$/.test(t[1] ?? "")) throw new Error(show(t));
  });
  await step('alt F4 Alt+Enter로 만든 줄이 Enter 1회로 실행된다("alt")', async () => {
    await enter();
    await waitPrompt(">>>");
    const t = await tail(2);
    if (!t.includes("alt")) throw new Error(show(t));
  });

  // ── paste: 붙여넣은 블록은 추가 들여쓰기를 받지 않는다(붙여넣기 토큰은 `onKey`를 거치지 않는다, 6.3·6.5) ──
  await step("paste G1 붙여넣은 여러 줄 블록은 들여쓰기를 더하지 않고 그대로 실행된다(3)", async () => {
    await reset();
    await paste("def add(a, b):\n    return a + b\n\nprint(add(1, 2))");
    await enter();
    await waitPrompt(">>>");
    const t = await tail(2);
    if (!t.includes("3")) throw new Error(show(t));
  });
  await step("paste G2 실행 중 Ctrl+C는 기존처럼 KeyboardInterrupt로 중단된다", async () => {
    await reset();
    await type("while True: pass");
    await enter();
    await waitPrompt("...");
    await enter();
    await page.waitForTimeout(600);
    await ctrlC();
    await waitPrompt(">>>", 15000);
    if (!(await rows()).some((r) => r === "KeyboardInterrupt")) throw new Error(show(await tail(4)));
  });

  // ── cancel(RD-012b 이월, RD-008이 건너뛴 ID): 취소해도 들여쓰기 단위·형식은 그대로 ──
  await step("cancel G1 2칸 블록을 취소해도 다음 블록의 프리필이 2칸이다", async () => {
    await reset();
    await openBlock();
    await press("Backspace"); // 자동 4칸 → 0칸
    await type("  x = 1");
    await enter(); // 2칸으로 다시 쓴다. lastUsedIndentation이 "  "가 된다.
    await waitPrompt("...");
    await ctrlC(); // 아직 열린 블록을 취소한다
    await waitPrompt(">>>", 8000);
    await openBlock();
    await type("z");
    if (!/^\.\.\. {3}z$/.test((await tail(1))[0] ?? "")) throw new Error(show(await tail(1)));
    await ctrlC();
    await waitPrompt(">>>", 8000);
  });

  await step("cancel C1 본문 줄(프리필 포함)이 쌓인 블록도 같은 형식으로 취소된다", async () => {
    // 앞 G1이 세션의 lastUsedIndentation을 2칸으로 남겨 둔다. 이 확인은 기본 4칸을 전제하므로 리셋한다.
    await resetSession();
    await openBlock();
    await type("print(2)"); // 프리필 4칸 위에 이어 친다.
    await enter();
    await waitPrompt("...", 8000);
    await ctrlC();
    await waitPrompt(">>>", 8000);
    const t = await tail(5);
    if (!same(t, [">>> if True:", "...     print(2)", "...", "KeyboardInterrupt", ">>>"])) throw new Error(show(t));
    await submitLine("print(1)");
    const t2 = await tail(3);
    if (!same(t2, [">>> print(1)", "1", ">>>"])) throw new Error(show(t2));
    if ((await rows()).some((r) => r === "2")) throw new Error("2가 출력됐다(취소된 본문이 실행됨)");
  });

  await step("cancel D1 Shift+Enter 둘째 행은 프리필로 `    print(3)`이고 Ctrl+C는 KeyboardInterrupt를 낸다", async () => {
    await reset();
    await type("if True:");
    await press("Shift+Enter");
    await type("print(3)");
    const before = await tail(2);
    if (!/^ {4}print\(3\)$/.test(before[1] ?? "")) throw new Error(show(before));
    await ctrlC();
    await waitPrompt(">>>", 8000);
    const t = await tail(4);
    if (!same(t, [">>> if True:", "    print(3)", "KeyboardInterrupt", ">>>"])) throw new Error(show(t));
  });
  await step("cancel D2 취소 뒤 print(1)이 1을 내고 3은 출력되지 않는다", async () => {
    await submitLine("print(1)");
    const t = await tail(3);
    if (!same(t, [">>> print(1)", "1", ">>>"])) throw new Error(show(t));
    if ((await rows()).some((r) => r === "3")) throw new Error("3이 출력됐다");
  });
  await step("cancel D3 커서가 버퍼 앞쪽이어도 마지막 줄 아래에 KeyboardInterrupt가 나온다", async () => {
    await reset();
    await type("if True:");
    await press("Shift+Enter");
    await type("print(3)");
    await press("Control+a");
    await ctrlC();
    await waitPrompt(">>>", 8000);
    const t = await tail(4);
    if (!same(t, [">>> if True:", "    print(3)", "KeyboardInterrupt", ">>>"])) throw new Error(show(t));
  });

  // ── input: `input()` 읽기에는 자동 들여쓰기가 전혀 없다(벤더 원본 동작, 6.3) ──
  await step("input 프리필이 없다(`... ` 아님) 그리고 Shift+Enter는 개행만 넣는다", async () => {
    await reset();
    await type("s = input()");
    await enter();
    await typeWhenReading("a");
    await press("Shift+Enter");
    await type("b");
    const t = await tail(2);
    // 자동 들여쓰기가 있었다면 둘째 줄이 공백으로 시작했을 것이다. 원본은 개행만 넣는다.
    if (t[1] !== "b") throw new Error(`Shift+Enter가 들여쓰기를 넣었다: ${show(t)}`);
    await press("Control+u");
    await press("Control+a");
    await press("Control+k");
  });
  await step("input 8칸 뒤 Backspace 한 번은 1글자만 지운다(단위 배수 아님)", async () => {
    await typeWhenReading("        "); // 공백 8칸
    // 첫 글자 뒤 나머지 7칸은 `type()`이 보낸다. `type()`은 공백뿐인 입력을 기다리지 않는다(`trimEnd()`가 빈 문자열이면 대기 생략).
    // 렌더가 따라올 시간을 직접 준다.
    await page.waitForTimeout(300);
    const before = await cursorCol();
    await press("Backspace");
    await page.waitForTimeout(300);
    const after = await cursorCol();
    if (before - after !== 1) throw new Error(`before=${before} after=${after}`);
    await press("Control+u");
    await type("done");
    await enter();
    await waitPrompt(">>>", 8000);
  });

  // ── multiline-shift: `multiline-check.mjs`(RD-011)의 shift 절 복원. 프리필 뒤 print(i)만 입력한다. ──
  await step("multiline-shift Shift+Enter 블록(프리필 사용) → 0·1(Enter 1회)", async () => {
    await reset();
    await type("for i in range(2):");
    await press("Shift+Enter");
    await type("print(i)"); // 들여쓰기를 직접 입력하지 않는다. 프리필이 채운다(RD-013).
    await enter();
    await waitPrompt(">>>", 8000);
    const t = await tail(3);
    if (!same(t, ["0", "1", ">>>"])) throw new Error(show(t));
  });

  const label = serverLabel(url);
  return h.finish({ label });
}

const { url: devUrl, previewUrl } = checkEntry();

// preview는 아래 절만 돈다. 사용자 `ONLY`가 있으면 이 목록과의 교집합만 돈다(RD-044 K6, `runDevPreview`가 계산·복원한다).
const ok = await runDevPreview({
  url: devUrl,
  previewUrl,
  run,
  previewSections: ["초기", "prefill", "shift", "unit"],
});
exitWith(ok);
