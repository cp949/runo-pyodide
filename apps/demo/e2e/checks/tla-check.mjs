// RD-012 브라우저 확인: top-level await(TLA) 옵션. 규칙은 `docs/design/02-console-core.md` 5.4. RD-012에서 이관했다(RD-018).
// 절 5개를 `ONLY=<절 이름,…>`로 고를 수 있다.
//   scenario    RD-012 시나리오. OFF에서 SyntaxError → ON 리셋·실행 → 새로고침 뒤 OFF
//   smoke       TLA ON에서 기존 동작 5건
//   arun        `asyncio.run(main())` OFF·ON 각 1건
//   toggle-off  ON→OFF 전환이 리셋을 일으키고 그 뒤 `await` 줄이 SyntaxError
//   sticky      세션 리셋·크래시 재시작 뒤에도 ON 유지
// preview는 "초기"와 scenario만 돈다(`previewSections`).
//
// `defineMain()`과 smoke의 for 블록은 RD-013 자동 들여쓰기 프리필(4칸)을 그대로 쓴다.
// - 콜론 뒤 다음 줄에 프리필이 이미 채워져 있다. 수동 4칸을 더 치면 한 단계 더 들어간다.
// - 콜론 없는 줄 뒤 프리필은 직전 줄의 실제 들여쓰기를 그대로 잇는다(`auto-indent.ts`의 `nextIndentation`).
// - 수동 4칸을 치면 `defineMain()`의 둘째(`await …`)·셋째(`return 42`) 줄이 8칸·12칸으로 달라져 `IndentationError`가 난다(실측).
// - `ctrl-c-check.mjs`·`auto-indent-check.mjs`의 `multiline-shift` 절과 같은 패턴이다. 프리필 위에 본문만 친다.
//
// 사용: `node tla-check.mjs [devURL] [previewURL]`
// 결과 파일 규칙은 README "결과 파일 규칙".
import { open, same, show } from "../lib.mjs";
import { checkEntry, currentOnly, exitWith, pageSelected, runDevPreview, serverLabel } from "../check-runner.mjs";

/** 세션 리셋 안내 줄. */
const RESET_NOTICE = "[세션 리셋됨 — 이전 변수/import가 모두 초기화되었습니다]";
/** TLA가 꺼져 있을 때 `await` 줄이 내는 오류 행. */
const SYNTAX_ERROR_ROW = "SyntaxError: 'await' outside function";

/** 화면 전체(이어붙인 문자열)에서 needle이 나온 횟수. 행이 감겨도 놓치지 않는다. */
const countOf = (rowsArr, needle) => rowsArr.join("").split(needle).length - 1;

/** async def main(): await asyncio.sleep(0); return 42 블록을 입력한다(줄마다 Enter, 빈 줄로 종료). */
async function defineMain(h) {
  const { type, enter, waitPrompt } = h;
  await type("async def main():");
  await enter();
  await waitPrompt("...");
  await type("await asyncio.sleep(0)"); // 들여쓰기 직접 입력 없음 — 프리필이 채운다(RD-013)
  await enter();
  await waitPrompt("...");
  await type("return 42"); // 프리필이 같은 레벨(4칸)을 유지한다(콜론 없는 줄 뒤)
  await enter();
  await waitPrompt("...");
  await enter();
  await waitPrompt(">>>");
}

/** dev 또는 preview 화면에서 절을 돌리고 모든 확인이 통과했는지 돌려준다. */
async function run(url) {
  const h = await open(url);
  const {
    page,
    rows,
    tail,
    trimmedRows,
    countTracebacks,
    type,
    press,
    enter,
    submit,
    focus,
    startBlockLine,
    ctrlC,
    typeWhenReading,
    cancelWhenReading,
    waitPrompt,
    waitFor,
    settled,
    setTopLevelAwait,
    statusText,
    step,
  } = h;

  const checkboxChecked = () => page.locator('[data-testid="top-level-await"]').isChecked();
  const click = async (testid) => {
    await page.click(`[data-testid="${testid}"]`);
    await focus();
  };
  // `testid` 버튼(`reset` 또는 `restart`)을 눌러 `loading` → `ready`/`load-failed` → 새 프롬프트까지 기다린다.
  async function resetAndWait(testid = "reset") {
    await click(testid);
    await waitFor(async () => (await statusText()) === "loading", `${testid}: loading 상태`);
    await waitFor(
      async () => ["ready", "load-failed"].includes(await statusText()),
      `${testid}: ready/load-failed 상태`,
      30000,
    );
    await waitPrompt(">>>", 30000);
  }

  await step("초기: 첫 프롬프트", async () => {
    await waitPrompt(">>>");
  });

  // ── scenario: RD-012 시나리오(OFF SyntaxError → ON 리셋·실행 → 새로고침 OFF) ──
  await step("scenario: OFF에서 await asyncio.sleep(1)은 SyntaxError 행", async () => {
    await submit("import asyncio");
    await type("await asyncio.sleep(1)");
    await enter();
    await waitFor(
      async () => (await rows()).includes(SYNTAX_ERROR_ROW),
      `SyntaxError 행(${show(SYNTAX_ERROR_ROW)})`,
    );
    if (!(await rows()).includes(SYNTAX_ERROR_ROW)) {
      throw new Error(`화면 끝 = ${show((await tail(5)))}`);
    }
  });
  await step("scenario: 스위치 ON → 리셋 → 같은 줄이 오류 없이 복귀(약 1초)", async () => {
    await setTopLevelAwait(true);
    if (!(await rows()).some((r) => r === RESET_NOTICE)) {
      throw new Error(`RESET_NOTICE가 안 보인다 — ${show((await tail(6)))}`);
    }
    await submit("import asyncio");
    const startedAt = Date.now();
    await type("await asyncio.sleep(1)");
    await enter();
    await waitPrompt(">>>", 5000);
    const elapsed = Date.now() - startedAt;
    if ((await countTracebacks()) !== 0) {
      throw new Error(`트레이스백이 남았다 — ${show((await tail(6)))}`);
    }
    // `rows()`(전체 스크롤백)가 아니라 최근 행만 본다.
    // 이전 절(OFF SyntaxError 확인)의 문구가 스크롤백에 남아 있어 전체 검사로는 이번 실행의 SyntaxError를 구분하지 못한다.
    const recent = await tail(6);
    if (recent.some((r) => r.includes("SyntaxError"))) {
      throw new Error(`SyntaxError가 남아 있다(TLA가 실제로 켜지지 않았다) — ${show(recent)}`);
    }
    // 실제 `sleep(1)`이 돌았다면 약 1초다. SyntaxError로 즉시 끝났다면 수십 ms다.
    // 시간으로도 실행 여부를 가른다.
    if (elapsed < 500) {
      throw new Error(`복귀가 너무 빠르다(${elapsed}ms) — await가 실제로 실행되지 않았을 수 있다`);
    }
    h.notes["scenario: 복귀까지 걸린 시간(정보용)"] = `${elapsed}ms`;
  });
  await step("scenario: page.reload() 뒤 체크박스 해제 + 다시 SyntaxError", async () => {
    await page.reload({ waitUntil: "load" });
    await waitPrompt(">>>", 30000);
    if (await checkboxChecked()) throw new Error("새로고침 뒤에도 체크박스가 켜져 있다");
    await submit("import asyncio");
    await type("await asyncio.sleep(1)");
    await enter();
    await waitFor(
      async () => (await rows()).includes(SYNTAX_ERROR_ROW),
      `SyntaxError 행(${show(SYNTAX_ERROR_ROW)})`,
    );
  });

  // ── smoke(ON): 기존 동작 유지 5건 ──
  await step("smoke: TLA ON 전환", async () => {
    await setTopLevelAwait(true);
  });
  await step("smoke: 1+1 → 2", async () => {
    await submit("1+1");
    const t = await tail(2);
    if (!t.some((r) => r === "2")) throw new Error(`1+1 → 2가 안 보인다 — ${show(t)}`);
  });
  await step("smoke: for 블록 1개 → 0·1", async () => {
    await type("for i in range(2):");
    await enter();
    await waitPrompt("...");
    await type("print(i)"); // 들여쓰기 직접 입력 없음 — 프리필이 채운다(RD-013)
    await enter();
    await waitPrompt("...");
    await enter();
    await waitPrompt(">>>");
    const t = await tail(4);
    if (!(t.includes("0") && t.includes("1"))) {
      throw new Error(`0·1이 안 보인다 — ${show(t)}`);
    }
  });
  await step("smoke: input() 1회 → 'abc'", async () => {
    await type("input('x: ')");
    await enter();
    await typeWhenReading("abc");
    await enter();
    await waitPrompt(">>>");
    const t = await tail(3);
    if (!t.some((r) => r === "'abc'")) throw new Error(`'abc'가 안 보인다 — ${show(t)}`);
  });
  await step("smoke: 입력줄 Ctrl+C 취소 1회 → 새 >>>, history 미기록", async () => {
    await type("ans2 = input()");
    await enter();
    await cancelWhenReading("z");
    await waitFor(
      async () => (await rows()).some((r) => r.includes("KeyboardInterrupt")),
      "input() 취소 트레이스백",
    );
    await settled();
    await press("ArrowUp");
    await page.waitForTimeout(100);
    const line = (await rows())[await h.cursorRow()] ?? "";
    if (line.includes("z")) throw new Error(`↑ 뒤 프롬프트에 취소된 글자가 남아 있다 — ${show(line)}`);
    await press("Control+u");
    await press("Escape");
    await enter();
    await waitPrompt(">>>");
  });
  await step("smoke: 실행 중 Ctrl+C 1회 → KeyboardInterrupt 1개", async () => {
    const before = await countTracebacks();
    await startBlockLine("while True: pass");
    await ctrlC();
    await waitFor(
      async () => (await countTracebacks()) === before + 1,
      "트레이스백 1개 증가",
    );
    await waitPrompt(">>>", 5000);
    if ((await countTracebacks()) !== before + 1) {
      throw new Error(`트레이스백 개수 증가분 = ${(await countTracebacks()) - before}(1 기대)`);
    }
  });

  // ── arun: asyncio.run(main()) OFF·ON 각 1건 ──
  await step("arun: TLA OFF에서도 asyncio.run(main()) → 42", async () => {
    await setTopLevelAwait(false);
    await submit("import asyncio");
    await defineMain(h);
    await submit("asyncio.run(main())");
    const t = await tail(2);
    if (!t.some((r) => r === "42")) throw new Error(`42가 안 보인다 — ${show(t)}`);
  });
  await step("arun: TLA ON에서도 asyncio.run(main()) → 42", async () => {
    await setTopLevelAwait(true);
    await submit("import asyncio");
    await defineMain(h);
    await submit("asyncio.run(main())");
    const t = await tail(2);
    if (!t.some((r) => r === "42")) throw new Error(`42가 안 보인다 — ${show(t)}`);
  });

  // ── toggle-off: ON→OFF 전환이 리셋을 일으키고 그 뒤 await 줄이 SyntaxError ──
  await step("toggle-off: ON→OFF 전환은 리셋을 일으키고 await는 SyntaxError", async () => {
    await setTopLevelAwait(true);
    // 화면을 비워 스크롤백 트리밍(TRP-024) 없이 "이번" 리셋의 안내 줄만 본다.
    await h.clear();
    await setTopLevelAwait(false);
    const t = await tail(5);
    if (!t.some((r) => r === RESET_NOTICE)) {
      throw new Error(`ON→OFF 전환 뒤 RESET_NOTICE가 안 보인다 — ${show(t)}`);
    }
    await type("await asyncio.sleep(0)");
    await enter();
    await waitFor(
      async () => (await rows()).some((r) => r.includes("SyntaxError")),
      "SyntaxError 행",
    );
  });

  // ── sticky: "세션 리셋"·크래시 "재시작" 뒤에도 ON 유지 ──
  await step("sticky: setTopLevelAwait(true) → 세션 리셋 → 체크박스 유지 → await 실행 OK", async () => {
    await setTopLevelAwait(true);
    await resetAndWait("reset");
    if (!(await checkboxChecked())) throw new Error("세션 리셋 뒤 체크박스가 꺼졌다");
    await submit("import asyncio");
    await type("await asyncio.sleep(0)");
    await enter();
    await waitPrompt(">>>", 5000);
    if ((await countTracebacks()) !== 0) throw new Error("await asyncio.sleep(0) 실행 중 오류");
  });
  await step("sticky: 강제 크래시 → 재시작 → 체크박스 유지 → await 실행 OK", async () => {
    await type(
      'import pyodide.code; pyodide.code.run_js("setTimeout(() => { throw new Error(\'forced\') }, 0)")',
    );
    await enter();
    await waitFor(async () => (await statusText()) === "crashed", "status = crashed", 10000);
    await resetAndWait("restart");
    if (!(await checkboxChecked())) throw new Error("재시작 뒤 체크박스가 꺼졌다");
    await submit("import asyncio");
    await type("await asyncio.sleep(0)");
    await enter();
    await waitPrompt(">>>", 5000);
    if ((await countTracebacks()) !== 0) throw new Error("재시작 뒤 await asyncio.sleep(0) 실행 중 오류");
  });

  const stickyRan = pageSelected(currentOnly(), "sticky");
  if (stickyRan) {
    const forcedErrors = h.pageErrors.filter((e) => e.includes("forced"));
    const otherErrors = h.pageErrors.filter((e) => !e.includes("forced"));
    h.checks["pageerror: forced 1건만, 나머지 0"] =
      forcedErrors.length === 1 && otherErrors.length === 0;
    if (!h.checks["pageerror: forced 1건만, 나머지 0"]) {
      h.notes["pageerror: forced 1건만, 나머지 0"] =
        `forced=${forcedErrors.length}, 기타=${otherErrors.length} — ${show(otherErrors.slice(0, 3))}`;
    }
    console.log(
      h.checks["pageerror: forced 1건만, 나머지 0"] ? "PASS  pageerror: forced 1건만, 나머지 0" : `FAIL  pageerror: forced 1건만, 나머지 0  — ${h.notes["pageerror: forced 1건만, 나머지 0"]}`,
    );
  }

  const label = serverLabel(url);
  await h.finish({ label });
  return Object.values(h.checks).every(Boolean);
}

const { url: devURL, previewUrl: previewURL } = checkEntry();

const ok = await runDevPreview({
  url: devURL,
  previewUrl: previewURL,
  run,
  previewSections: ["초기", "scenario"],
});
exitWith(ok);
