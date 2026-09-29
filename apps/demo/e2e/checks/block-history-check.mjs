// RD-014 브라우저 검증. 출처 RD-014에서 이관(RD-018).
// 이전 RD-020 A0~J1 25개 + RD-006b X2·X3
// (RD-008 건너뜀 ID) + 붙여넣기 2건(P1·P2)을 이식한다.
// ONLY=<절 이름,…>로 절만 분리 실행한다: 초기,A,B,C,D,E,F,G,H,I,J,X,P
// 사용: node block-history-check.mjs <devURL> [previewURL]
// 결과 파일 label은 url 포트 4173이면 preview, 그 밖은 dev(RD-018 결정과 같은 규칙).
//
// 절 사이는 각 절 시작에서 reset()(ctrlC → waitPrompt(">>>") → clear())으로 정리한다. reset()의
// Ctrl+C는 커밋된 history 항목을 지우지 않고 열려 있던 읽기만 취소한다 — 그래서 G가 F의 블록을,
// J가 I의 블록을 그대로 이어 참조할 수 있다(절이 서로 독립이 아니라 한 세션의 history 흐름을
// 공유한다). F·G는 계획대로 resetSession()으로 절을 연다(exit()·세션 리셋 시나리오 자체가 절의
// 본문이라 reset()으로는 전제를 만들 수 없다).
import { open, same, show } from "../lib.mjs";
import { checkEntry, exitWith, runDevPreview, serverLabel } from "../check-runner.mjs";

async function run(url) {
  const h = await open(url);
  const {
    page, step, waitPrompt, waitStatus, clear, type, enter, press, paste,
    tail, rows, lastLine, focus, statusText, ctrlC, resetPrompt,
  } = h;

  /**
   * 다음 확인을 깨끗한 `>>> `에서 시작한다. 앞 확인이 단언 실패로 도중에 멈추면(`... ` 등 열린 읽기가
   * 남는다) `clear()`(Ctrl+L)만으로는 화면만 지워질 뿐 읽기가 안 끝나 다음 확인의 `clear()`가 시간
   * 초과한다 — 먼저 Ctrl+C로 취소한다(비어 있는 `>>> `에서도 안전, RD-008 B0와 같다).
   */
  async function reset() {
    await ctrlC();
    await waitPrompt(">>>", 8000);
    await page.waitForTimeout(250); // 취소 직후의 재그리기가 비동기라 바로 Ctrl+L을 누르면 놓친다
    await clear();
  }
  /** 리셋 버튼을 누르고 새 세션의 첫 프롬프트까지 기다린다(TRP-024: 안내 줄 개수가 아니라 status로 판정). */
  async function resetSession() {
    await page.click('[data-testid="reset"]');
    await waitStatus(["loading"], "리셋: loading 상태");
    await waitStatus(["ready", "load-failed"], "리셋: ready 상태", 30000);
    if ((await statusText()) === "load-failed") throw new Error("리셋 뒤 load-failed");
    await focus();
    await waitPrompt(">>>", 30000);
  }
  /** 입력 줄을 지우고(Ctrl+U) 빈 줄을 제출해 `>>> `로 돌아온다(절 안에서 recall 단언 뒤 다음 단언 전 정리용). */
  async function navReset() {
    await press("Control+u");
    await enter();
    await waitPrompt(">>>", 8000);
  }

  const pasteFallback = [];

  await step("초기", async () => {
    await waitPrompt(">>>", 60000);
    await focus();
  });

  // ── A. 블록을 끝낸 뒤 ↑는 블록 전체(한 항목)를 돌려주고 Enter 1회로 다시 실행된다. ──
  await step("A A0 블록이 실행된다(0, 1 출력)", async () => {
    await reset();
    await type("x = 1");
    await enter();
    await waitPrompt(">>>", 8000);
    await type("for i in range(2):");
    await enter();
    await waitPrompt("...", 8000);
    await type("print(i)"); // 프리필(4칸) 위에 그대로 친다(RD-013 프리필, 직접 들여쓰기 치지 않음)
    await enter();
    await waitPrompt("...", 8000);
    await enter(); // 프리필만 있는 빈 줄 — 블록 종료
    await waitPrompt(">>>", 8000);
    const t = await tail(3);
    if (!same(t, ["0", "1", ">>>"])) throw new Error(show(t));
  });
  await step("A A1 블록을 끝낸 뒤 ↑는 블록 전체(개행이 든 한 항목)를 돌려준다", async () => {
    await press("ArrowUp");
    await page.waitForTimeout(300);
    const t = await tail(2);
    if (!same(t, [">>> for i in range(2):", "    print(i)"])) throw new Error(show(t));
  });
  await step("A A2 ↑를 한 번 더 누르면 줄 조각이 아니라 블록 이전 항목이 나온다", async () => {
    await press("ArrowUp");
    await page.waitForTimeout(300);
    const t = await tail(1);
    if (!same(t, [">>> x = 1"])) throw new Error(show(t));
  });
  await step("A A3 재호출한 블록이 Enter 1회로 다시 실행된다", async () => {
    await press("ArrowDown");
    await page.waitForTimeout(300);
    await enter();
    await waitPrompt(">>>", 8000);
    const t = await tail(5);
    if (!same(t, [">>> for i in range(2):", "    print(i)", "0", "1", ">>>"])) throw new Error(show(t));
  });

  // ── B. Ctrl+C로 취소한 블록은 history에 남지 않는다(첫 줄 포함). ──
  await step("B B1 취소: KeyboardInterrupt가 나오고 `>>> `로 돌아온다", async () => {
    await reset();
    await type("y = 2");
    await enter();
    await waitPrompt(">>>", 8000);
    await type("if True:");
    await enter();
    await waitPrompt("...", 8000);
    await type("print(1)");
    await enter();
    await waitPrompt("...", 8000);
    await ctrlC();
    await waitPrompt(">>>", 8000);
    const t = await tail(2);
    if (!same(t, ["KeyboardInterrupt", ">>>"])) throw new Error(show(t));
  });
  await step("B B2 취소한 블록은 남지 않는다: ↑는 블록 이전 항목", async () => {
    await press("ArrowUp");
    await page.waitForTimeout(300);
    const t = await tail(1);
    if (!same(t, [">>> y = 2"])) throw new Error(show(t));
  });
  await step("B B3 취소 뒤 입력이 이전 블록에 붙지 않는다", async () => {
    await press("Control+u");
    await type("print(1)");
    await enter();
    await waitPrompt(">>>", 8000);
    const t = await tail(3);
    if (!same(t, [">>> print(1)", "1", ">>>"])) throw new Error(show(t));
  });

  // ── C. `... ` 입력줄에서 ↑는 history를 탐색하지 않는다. ──
  await step("C C1 프리필이 없는 `... ` 줄에서 ↑는 history를 탐색하지 않는다", async () => {
    await reset();
    await type("w = 5");
    await enter();
    await waitPrompt(">>>", 8000); // ↑가 탐색할 항목을 둔다
    await type("x = [");
    await enter();
    await waitPrompt("...", 8000);
    await press("ArrowUp");
    await page.waitForTimeout(300);
    const last = await lastLine();
    if (last !== "...") throw new Error(show(last));
  });
  await step("C C2 프리필을 지운 `... ` 줄에서도 ↑는 history를 탐색하지 않는다", async () => {
    await ctrlC();
    await waitPrompt(">>>", 8000);
    await type("if True:");
    await enter();
    await waitPrompt("...", 8000);
    await press("Control+u");
    await page.waitForTimeout(200);
    await press("ArrowUp");
    await page.waitForTimeout(300);
    const last = await lastLine();
    if (last !== "...") throw new Error(show(last));
  });
  await step("C C3 취소 뒤 `>>> `의 ↑는 다시 탐색한다(블록이 아닌 직전 항목)", async () => {
    await ctrlC();
    await waitPrompt(">>>", 8000);
    await press("ArrowUp");
    await page.waitForTimeout(300);
    const last = await lastLine();
    if (last !== ">>> w = 5") throw new Error(show(last));
  });

  // ── D. 괄호 안의 빈 줄이 보존된다. ──
  await step("D D0 괄호 블록이 오류 없이 끝난다", async () => {
    await reset();
    await type("x = [");
    await enter();
    await waitPrompt("...", 8000);
    await enter(); // 괄호가 안 닫혀 계속 `... `
    await waitPrompt("...", 8000);
    await type("1]");
    await enter();
    await waitPrompt(">>>", 8000);
    if ((await rows()).some((r) => /Error/.test(r))) throw new Error(show(await tail(4)));
  });
  await step("D D1 ↑는 빈 줄까지 그대로 돌려준다", async () => {
    await press("ArrowUp");
    await page.waitForTimeout(300);
    const t = await tail(3);
    if (!same(t, [">>> x = [", "", "1]"])) throw new Error(show(t));
  });

  // ── E. 문법 오류나 예외로 끝난 블록도 전체가 남는다. ──
  await step("E E0 문법 오류가 표시된다", async () => {
    await reset();
    await type("if True:");
    await enter();
    await waitPrompt("...", 8000);
    await type("x = = 1");
    await enter();
    await waitPrompt(">>>", 8000);
    if (!(await rows()).some((r) => /SyntaxError/.test(r))) throw new Error(show(await tail(3)));
  });
  await step("E E1 문법 오류로 끝난 블록도 오류가 난 줄까지 전체가 남는다", async () => {
    await press("ArrowUp");
    await page.waitForTimeout(300);
    const t = await tail(2);
    if (!same(t, [">>> if True:", "    x = = 1"])) throw new Error(show(t));
  });
  await step("E E2a 예외가 표시된다", async () => {
    await navReset();
    await type("for i in range(2):");
    await enter();
    await waitPrompt("...", 8000);
    await type("1/0");
    await enter();
    await waitPrompt("...", 8000);
    await enter();
    await waitPrompt(">>>", 8000);
    if (!(await rows()).some((r) => /ZeroDivisionError/.test(r))) throw new Error(show(await tail(3)));
  });
  await step("E E2 예외로 끝난 블록도 전체가 남는다", async () => {
    await press("ArrowUp");
    await page.waitForTimeout(300);
    const t = await tail(2);
    if (!same(t, [">>> for i in range(2):", "    1/0"])) throw new Error(show(t));
  });

  // ── F. exit()로 끝난 블록은 세션 리셋 뒤에도 남는다. ──
  await step("F F0 exit() 뒤 종료 안내가 뜬다", async () => {
    await resetSession();
    await type("if True:");
    await enter();
    await waitPrompt("...", 8000);
    await type("exit()");
    await enter();
    await waitPrompt("...", 8000);
    await enter(); // 빈 줄로 블록 종료 → exit() 실행
    await waitStatus(["terminated"], "exit() 뒤 terminated 상태", 8000);
    if (!(await page.locator('[data-testid="terminated"]').isVisible())) {
      throw new Error("terminated 안내가 보이지 않는다");
    }
  });
  await step("F F1 exit()로 끝난 블록은 세션 리셋 뒤에도 history에 남는다", async () => {
    await resetSession();
    await press("ArrowUp");
    await page.waitForTimeout(300);
    const t = await tail(2);
    if (!same(t, [">>> if True:", "    exit()"])) throw new Error(show(t));
  });

  // ── G. 입력을 기다리던 블록은 세션 리셋 때 버려진다. ──
  await step("G G1 입력을 기다리던 블록은 세션 리셋 뒤 history에 없다: ↑는 F의 블록", async () => {
    await resetSession();
    await type("if True:");
    await enter();
    await waitPrompt("...", 8000);
    await type("print(9)");
    await enter();
    await waitPrompt("...", 8000); // 아직 블록이 안 닫힌 채 대기 중
    await resetSession();
    await press("ArrowUp");
    await page.waitForTimeout(300);
    const t = await tail(2);
    if (!same(t, [">>> if True:", "    exit()"])) throw new Error(show(t));
  });

  // ── H. 한 줄 입력은 그대로 남고 빈/공백 제출은 남지 않는다. ──
  await step("H H1 한 줄 입력은 그대로 남고 빈/공백 제출은 남지 않는다", async () => {
    await reset();
    await type("z = 1");
    await enter();
    await waitPrompt(">>>", 8000);
    await enter();
    await waitPrompt(">>>", 8000);
    await page.keyboard.type("   "); // 공백뿐 — lib.mjs의 type()은 대기 없이 바로 돌아온다
    await page.waitForTimeout(300);
    await enter();
    await waitPrompt(">>>", 8000);
    await press("ArrowUp");
    await page.waitForTimeout(300);
    const t = await tail(1);
    if (!same(t, [">>> z = 1"])) throw new Error(show(t));
  });

  // ── I. Shift+Enter로 만든 여러 줄 입력이 블록 항목에 이어 붙는다. ──
  await step("I I0 두 줄이 모두 실행된다", async () => {
    await reset();
    await type("if True:");
    await enter();
    await waitPrompt("...", 8000);
    await type("print(1)");
    await press("Shift+Enter");
    await type("print(2)"); // 둘째 줄도 프리필 위에 그대로 친다
    await enter();
    await waitPrompt("...", 8000);
    await enter(); // 빈 줄로 블록 종료
    await waitPrompt(">>>", 8000);
    const t = await tail(3);
    if (!same(t, ["1", "2", ">>>"])) throw new Error(show(t));
  });
  await step("I I1 ↑는 Shift+Enter로 만든 줄까지 한 항목으로 돌려준다", async () => {
    await press("ArrowUp");
    await page.waitForTimeout(300);
    const t = await tail(3);
    if (!same(t, [">>> if True:", "    print(1)", "    print(2)"])) throw new Error(show(t));
  });

  // ── J. input()은 블록 항목에 영향을 주지 않는다. ──
  await step("J J1 input() 뒤에도 앞선 블록 항목이 그대로 남는다(↑ 3회: q, x = input(), 블록)", async () => {
    await reset();
    await type("x = input()");
    await enter();
    await page.waitForTimeout(800);
    await type("q");
    await enter();
    await waitPrompt(">>>", 8000);
    for (let i = 0; i < 3; i += 1) {
      await press("ArrowUp");
      await page.waitForTimeout(250);
    }
    const t = await tail(3);
    if (!same(t, [">>> if True:", "    print(1)", "    print(2)"])) throw new Error(show(t));
  });

  // ── X(RD-006b 이식). 블록 재호출·재실행 뒤 프롬프트가 출력 꼬리를 물고 있어도 같다. ──
  await step("X X1 `012>>> ` 프롬프트가 뜬다", async () => {
    await reset();
    await type("for i in range(3):");
    await enter();
    await waitPrompt("...", 8000);
    await type('print(i, end="")');
    await enter();
    await waitPrompt("...", 8000);
    await enter(); // 빈 줄 — 블록 종료·실행, 개행 없는 출력이 프롬프트와 한 행에 붙는다
    await waitPrompt("012>>>", 8000);
    const last = await lastLine();
    if (last !== "012>>>") throw new Error(show(last));
  });
  await step("X X2 ↑는 블록 전체를 돌려준다(꼬리 붙은 프롬프트에서도)", async () => {
    await press("ArrowUp");
    await page.waitForTimeout(300);
    if (!(await rows()).some((r) => r === "012>>> for i in range(3):")) {
      throw new Error(show(await tail(4)));
    }
  });
  await step("X X3 재호출한 블록도 Enter 1회로 다시 실행되고 `012>>> `로 돌아온다", async () => {
    await enter();
    await waitPrompt("012>>>", 8000);
    const last = await lastLine();
    if (last !== "012>>>") throw new Error(show(last));
    await resetPrompt();
  });

  // ── P(확정 4). 붙여넣기는 개행을 문자 그대로(LF) 받아 xterm.js의 LF→CR 전처리에 의존한다(남은 위험). ──
  await step("P P1 `... `에서 붙여넣은 여러 줄이 top-level 문장까지 블록에 이어진다", async () => {
    await reset();
    await type("for i in range(2):");
    await enter();
    await waitPrompt("...", 8000);
    const { usedFallback } = await paste("print(i)\n\nx = 1");
    if (usedFallback) pasteFallback.push("P1");
    await enter();
    await waitPrompt(">>>", 8000);
    const out = await tail(3);
    if (!same(out, ["0", "1", ">>>"])) throw new Error(`출력 불일치 ${show(out)}`);
    await press("ArrowUp");
    await page.waitForTimeout(300);
    const t = await tail(4);
    if (!same(t, [">>> for i in range(2):", "    print(i)", "", "x = 1"])) throw new Error(show(t));
  });
  // 계획(RD-014 그릴링 확정 4)은 이 붙여넣기가 블록을 "열어 둔 채" 끝나 다음
  // `... ` 읽기로 이어질 것을 기대했다. 실측 결과 다르다: 실제 `push()`(worker/console.ts
  // `runLine` → `pyconsole.push(source)`)는 개행이 든 하나의 제출 텍스트를 항상 그 자리에서
  // 최종 판정한다 — 계속(`... `)으로 넘어가는 경우가 없다(같은 전제로 시도한 괄호 미종결·삼중
  // 따옴표 미종결·괄호 함수 호출도 전부 즉시 SyntaxError로 판정됐다).
  // 그래서 이 절은 계획의 `... ` 대기 대신 실제로 벌어지는 일(즉시 실행, 그래도 한 항목으로
  // 기록됨)을 확인한다.
  await step("P P2(실측) `>>> `에서 붙여넣은 여러 줄은 즉시 완결되지만 한 항목으로 기록된다", async () => {
    await reset();
    await type("q = 0");
    await enter();
    await waitPrompt(">>>", 8000);
    const { usedFallback } = await paste("for i in range(2):\n    print(i)");
    if (usedFallback) pasteFallback.push("P2");
    await enter();
    await waitPrompt(">>>", 8000); // 계획은 `...`를 기대했으나 실제로는 바로 `>>>`로 완결된다
    const out = await tail(3);
    if (!same(out, ["0", "1", ">>>"])) throw new Error(`출력 불일치(실측) ${show(out)}`);
    await press("ArrowUp");
    await page.waitForTimeout(300);
    const t = await tail(2);
    if (!same(t, [">>> for i in range(2):", "    print(i)"])) throw new Error(show(t));
    await press("ArrowUp");
    await page.waitForTimeout(300);
    const last = await lastLine();
    if (last !== ">>> q = 0") throw new Error(show(last));
  });

  const label = serverLabel(url);
  return h.finish({ label, pasteFallback });
}

const { url: devUrl, previewUrl } = checkEntry();

// preview는 초기·A·B·C 절만 돈다(계획, K6 선언 목록).
const ok = await runDevPreview({
  url: devUrl,
  previewUrl,
  run,
  previewSections: ["초기", "A", "B", "C"],
});
exitWith(ok);
