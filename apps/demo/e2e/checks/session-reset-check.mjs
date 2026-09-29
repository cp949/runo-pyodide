// RD-010 브라우저 확인. ROADMAP 시나리오 5종 + 이월 6건 + StrictMode + 크래시 유발 실측.
// 출처 RD-010에서 이관(RD-018).
//
// 사용법(dev, `pnpm --filter demo dev`가 떠 있어야 함):
//   node session-reset-check.mjs [devURL] [previewURL]
// ONLY=<절 이름,…>로 절만 분리 실행할 수 있다(reset·cursor·ctrll·carry·ccreset·ccafter·exit·crash·strict) —
// preview에도 그대로 적용된다(이 스크립트는 preview 전용 절 목록을 선언하지 않는다, RD-044 K6).
// preview는 devURL·previewURL 둘 다 있을 때만 돈다(`pnpm --filter demo build && pnpm --filter demo preview`).
// 결과 파일 label은 url 포트 4173이면 preview, 그 밖은 dev(RD-018 결정과 같은 규칙).
import { open, hasFg, same, show } from "../lib.mjs";
import { checkEntry, currentOnly, exitWith, pageSelected, runDevPreview, serverLabel } from "../check-runner.mjs";

const RESET_NOTICE = "[세션 리셋됨 — 이전 변수/import가 모두 초기화되었습니다]";
const BANNER = [
  "Python 3.14.2 (main, Sep 14 2026 03:03:51) on WebAssembly/Emscripten",
  'Type "help", "copyright", "credits" or "license" for more information.',
];
const TERMINATED_TEXT =
  'Python session terminated. "세션 리셋" 버튼으로 새 세션을 시작하세요.';

async function runDev(url) {
  const h = await open(url);
  const {
    page,
    rows,
    rowClasses,
    tail,
    trimmedRows,
    cursorRow,
    waitFor,
    waitPrompt,
    waitPromptTail,
    waitLastEndsWith,
    type,
    press,
    enter,
    submit,
    clear,
    focus,
    startBlockLine,
    ctrlC,
    cancelWhenReading,
    typeWhenReading,
    step,
  } = h;

  const statusText = () => page.locator('[data-testid="status"]').textContent();
  const terminatedText = () =>
    page.locator('[data-testid="terminated"]').textContent();
  const crashedText = () => page.locator('[data-testid="crashed"]').textContent();
  const crashedVisible = () => page.locator('[data-testid="crashed"]').count();
  const rawClick = (testid) => page.click(`[data-testid="${testid}"]`);
  // 버튼 클릭은 xterm의 숨은 textarea에서 포커스를 가져간다 — 클릭 뒤 focus()로 되돌린다.
  const click = async (testid) => {
    await rawClick(testid);
    await focus();
  };
  /**
   * 리셋(또는 재시작) 버튼 클릭 → `loading` → `ready`/`load-failed` → 새 프롬프트까지 기다린다.
   * 발견: 화면 행(`세션 리셋됨` 안내 줄) 개수로 "새 리셋이 끝났다"를 판정하면, xterm이 뷰포트(기본 24행)
   * 밖으로 스크롤된 옛 행을 DOM에서 지워 버려 여러 번 리셋한 뒤에는 안내 줄 개수가 더 늘지 않을 수
   * 있다(관찰: 3번째 리셋까지는 각 ~1.3초로 통과, 4번째는 60초를 줘도 통과하지 못함) — 상태 텍스트
   * (`data-testid=status`)는 스크롤과 무관한 단일 엘리먼트라 이 문제가 없다.
   */
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

  // ── reset: 변수·import 소실, 안내 줄 뒤 배너 순서, 이전 출력 스크롤 유지 ──
  await step("reset: 리셋 전 상태(변수·import)", async () => {
    await submit("x = 1");
    await submit("import math");
  });
  const beforeResetRows = await rows();
  await step("reset: 리셋 버튼 → 안내 줄·배너·프롬프트 순서(마지막 4행)", async () => {
    await resetAndWait();
    const t = await tail(4);
    if (!same(t, [RESET_NOTICE, ...BANNER, ">>>"])) {
      throw new Error(`마지막 4행 = ${show(t)}`);
    }
    if ((await cursorRow()) !== (await rows()).length - 1) {
      // trimmedRows가 아니라 rows() 기준으로 커서가 마지막 텍스트 행에 있는지 tail()로 이미 보장되지만
      // 명시적으로 한 번 더 확인한다(TRP-006).
      const all = await rows();
      let last = all.length - 1;
      while (last >= 0 && all[last] === "") last -= 1;
      if ((await cursorRow()) !== last) throw new Error("커서가 마지막 프롬프트 행에 없다");
    }
  });
  await step("reset: 안내 줄이 청록(xterm-fg-6)", async () => {
    const classes = await rowClasses();
    const rowsNow = await rows();
    const idx = rowsNow.findIndex((r) => r.includes("세션 리셋됨"));
    if (idx < 0) throw new Error("안내 줄을 못 찾았다");
    if (!hasFg(classes[idx] ?? [], 6)) throw new Error(`안내 줄 클래스 = ${show(classes[idx])}`);
  });
  await step("reset: 리셋 전 출력이 스크롤백에 남음(행 수 감소 없음)", async () => {
    const afterRows = await rows();
    if (afterRows.length < beforeResetRows.length) {
      throw new Error(`행 수 감소: ${beforeResetRows.length} → ${afterRows.length}`);
    }
    if (!afterRows.some((r) => r === ">>> x = 1")) {
      throw new Error("리셋 전 입력 행(>>> x = 1)이 사라졌다");
    }
  });
  await step("reset: 변수 소실(NameError)", async () => {
    await submit("x");
    if (!(await rows()).some((r) => r.includes("NameError"))) {
      throw new Error(`x → NameError가 안 보인다 — ${show((await tail(6)))}`);
    }
  });
  await step("reset: import 소실(NameError)", async () => {
    await submit("math");
    if (!(await rows()).some((r) => r.includes("NameError"))) {
      throw new Error(`math → NameError가 안 보인다 — ${show((await tail(6)))}`);
    }
  });

  // ── cursor: 리셋 직전 커서 행 처리(TRP-006), 미제출 입력 폐기 ──
  // 꼬리 없음 분기(개행으로 끝난 출력 직후, 프롬프트가 그려지기 전에 리셋)는 Enter와 reset 클릭을 경합시켜도
  // (Promise.all) 매번 프롬프트가 먼저 그려져 실사용 경로로는 재현되지 않는다(디버그 스크립트로 4회 확인). 행 머리
  // 판정은 커서가 아니라 현재 io 꼬리다(RD-028). 이 분기는 `index.test.ts`의 "리셋 안내 줄: 꼬리가 있으면…"(TRP-006)
  // 단위 시험으로만 고정한다.
  await step('cursor: 개행 없는 출력(end="") 뒤 리셋 — 꼬리("t>>>")가 있어도 개행 1개', async () => {
    await type('print("t", end="")');
    await enter();
    await waitLastEndsWith(">>>");
    await resetAndWait();
    const t = await tail(5);
    if (!same(t, ["t>>>", RESET_NOTICE, ...BANNER, ">>>"])) {
      throw new Error(`마지막 5행 = ${show(t)}`);
    }
  });
  await step("cursor: 프롬프트에 타이핑 중 리셋 — 미제출 입력은 화면에 남고 다음 프롬프트가 물려받지 않음", async () => {
    await type("abc", { sync: true });
    const beforeClick = await rows();
    let last = beforeClick.length - 1;
    while (last >= 0 && beforeClick[last] === "") last -= 1;
    if (beforeClick[last] !== ">>> abc") throw new Error(`리셋 전 마지막 행 = ${show(beforeClick[last])}`);
    await resetAndWait();
    const t = await tail(5);
    if (!same(t, [">>> abc", RESET_NOTICE, ...BANNER, ">>>"])) {
      throw new Error(`마지막 5행 = ${show(t)}`);
    }
  });
  await step("cursor: 미제출 abc는 history에 없다(↑에 안 보임)", async () => {
    await press("ArrowUp");
    await page.waitForTimeout(100);
    const all = await rows();
    const cur = await cursorRow();
    const line = all[cur] ?? "";
    if (line.includes("abc")) throw new Error(`↑ 뒤 프롬프트 = ${show(line)}`);
    await page.evaluate(() => {
      const ta = document.querySelector(".xterm-helper-textarea");
      ta?.focus();
    });
    await press("Control+u");
    await press("Escape");
    await resetPromptClean();
  });
  async function resetPromptClean() {
    // ArrowUp이 올린 history 줄을 지우고 빈 프롬프트로 되돌린다(다음 절이 깨끗하게 시작하도록).
    await press("Control+u");
    await enter();
    await waitPrompt(">>>");
  }

  // ── ctrll: 화면만 지운다(벤더 동작, 변경 없음) ──
  await step("ctrll: Ctrl+L은 화면만 지우고 상태는 ready", async () => {
    await submit("x = 5");
    await clear();
    const status = await statusText();
    if (status !== "ready") throw new Error(`status = ${show(status)}`);
    await submit("x", ">>>");
    const t = await tail(3);
    if (!t.some((r) => r === "5")) throw new Error(`x → 5가 안 보인다 — ${show(t)}`);
  });

  // ── carry: 이월 6건(RD-012b J1·J2, RD-012c J1·J2, RD-006b J3·AC1) ──
  await step("carry: 리셋 뒤 옛 세션 꼬리를 새 프롬프트가 물려받지 않는다(AC1)", async () => {
    await type('print("v", end="")');
    await enter();
    await waitLastEndsWith(">>>");
    await resetAndWait();
    const t = await tail(5);
    // 옛 세션의 꼬리("v")가 새 프롬프트에 물려("v>>> ") 그려지지 않고, 옛 꼬리 행("v>>>")은 그대로 남아
    // 있어야 한다(TRP-006 케이스와 같은 화면이지만 여기서는 "새 프롬프트가 꼬리를 안 물려받는다"에 초점).
    if (!same(t, ["v>>>", RESET_NOTICE, ...BANNER, ">>>"])) {
      throw new Error(`마지막 5행 = ${show(t)}`);
    }
  });
  await step("carry: 리셋 뒤 블록(... ) Ctrl+C 취소 → print(1)(RD-012b J1·J2)", async () => {
    await type("if True:");
    await enter();
    await waitPrompt("...");
    await ctrlC();
    await waitFor(
      async () => (await rows()).some((r) => r.includes("KeyboardInterrupt")),
      "블록 취소 KeyboardInterrupt",
    );
    const kCount = (await rows()).join("").split("KeyboardInterrupt").length - 1;
    await h.settled();
    await submit("print(1)");
    const t = await tail(3);
    if (!t.some((r) => r === "1")) throw new Error(`print(1) → 1이 안 보인다 — ${show(t)}`);
    h.notes["carry: KeyboardInterrupt 참고 개수(정보용)"] = `${kCount}`;
  });
  await step("carry: 리셋 뒤 input() Ctrl+C 취소 트레이스백 → print(1)(RD-012c J1·J2)", async () => {
    await resetAndWait();
    await type("ans = input()");
    await enter();
    await cancelWhenReading("a");
    await waitFor(
      async () => (await rows()).some((r) => r.includes("KeyboardInterrupt")),
      "input() 취소 트레이스백",
    );
    // 취소 트레이스백 렌더링과 겹치는 창에 친 첫 글자는 RD-019 이전에는 드롭될 수 있었다(TRP-005류). 지금은 읽기 없는
    // 구간의 키를 벤더가 쌓아 재생하므로 유실되지 않지만, 화면이 안정된 뒤에 타이핑하는 순서는 유지한다.
    await h.settled();
    await submit("print(1)");
    const t = await tail(3);
    if (!t.some((r) => r === "1")) throw new Error(`print(1) → 1이 안 보인다 — ${show(t)}`);
  });
  await step('carry: 리셋 뒤 input("x: ") → x: abc(RD-006b J3)', async () => {
    await resetAndWait();
    await type('input("x: ")');
    await enter();
    await typeWhenReading("abc");
    await waitLastEndsWith("x: abc");
    await enter();
    await waitPrompt(">>>");
  });

  // ── ccreset: 리셋 직전 Ctrl+C가 새 세션의 시작 코드를 죽이지 않는다(N=10) ──
  await step("ccreset: while True: pass → Ctrl+C 직후 리셋 클릭 → N=10 정상", async () => {
    for (let i = 0; i < 10; i += 1) {
      await startBlockLine("while True: pass");
      await Promise.all([ctrlC(), rawClick("reset")]);
      await focus();
      await waitFor(async () => (await statusText()) === "loading", `${i}번째 loading 상태`);
      await waitFor(
        async () => ["ready", "load-failed"].includes(await statusText()),
        `${i}번째 ready 상태`,
        30000,
      );
      await waitPrompt(">>>", 30000);
      const banner = await tail(3);
      if (!same(banner, [...BANNER, ">>>"])) {
        throw new Error(`${i}번째 배너 = ${show(banner)}`);
      }
      // 배너 뒤(prompt 앞)에 KeyboardInterrupt·Traceback이 새지 않아야 한다. lastIndexOf로 "이번" 리셋이
      // 방금 그린 배너(가장 최근 것)를 찾는다 — findIndex는 첫 배너(맨 처음 부팅)에 걸린다.
      const afterBannerIdx = (await rows()).lastIndexOf(BANNER[1]);
      const afterBanner = (await rows()).slice(afterBannerIdx + 1).join("");
      if (afterBanner.includes("KeyboardInterrupt") || afterBanner.includes("Traceback")) {
        throw new Error(`${i}번째: 배너 뒤에 잔재가 있다 — ${show(afterBanner)}`);
      }
    }
  });

  // ── ccafter: 실행 중 리셋 직후 새 세션의 첫 Ctrl+C가 옛 worker에 가로채이지 않는다(N=8) ──
  // 배경: Chromium은 `worker.terminate()` 뒤에도 Python 루프 중인 worker를 최대 약 2초 살려 둔다(TRP-049).
  // 옛 worker가 새 세션과 같은 interrupt buffer를 공유하면 그 창 안의 첫 SIGINT를 ack하고 `KeyboardInterrupt`를
  // 삼킨다. 삼키는 루프를 돌리는 채로 리셋하고, 곧바로 새 세션에서 첫 Ctrl+C를 눌러 "먹음"/"유실"을 센다.
  // 판정은 이벤트·상태로만 한다(9.7): 눌림이 유실되면 옛 worker가 ack해 재전송이 없으므로 루프가 스스로 끝나지
  // 않는 영구 상태다 — `waitFor` 제한 시간은 그 정지를 감지하는 용도이고 판정선이 아니다(9.7 4). 시간 값(ms)은
  // 판정이 아니라 관찰로만 남긴다(9.7 6).
  await step("ccafter: 삼키는 루프 실행 중 리셋 → 새 세션 첫 Ctrl+C N=8 유실 0", async () => {
    const N = 8;
    const STALL_MS = 15000;
    // gb 출력 행 뒤에 KeyboardInterrupt 행이 생기고 새 프롬프트(`>>>`, 커서 있음)가 마지막 텍스트 행일 때 참이다.
    const interruptedAfter = async (marker) => {
      const all = await rows();
      const idx = all.lastIndexOf(marker);
      if (idx < 0) return false;
      if (!all.slice(idx + 1).some((r) => r.includes("KeyboardInterrupt"))) return false;
      let last = all.length - 1;
      while (last >= 0 && all[last] === "") last -= 1;
      return last > idx && all[last] === ">>>" && (await cursorRow()) === last;
    };
    let lost = 0;
    const lostRounds = [];
    for (let i = 0; i < N; i += 1) {
      await clear();
      // 삼키는 루프: KeyboardInterrupt를 받아도 안쪽 루프를 다시 돈다. `\n`은 Python 문자열 이스케이프라 한 줄로 친다.
      await type(
        `exec("print('ga${i}')\\nwhile True:\\n    try:\\n        while True: pass\\n    except KeyboardInterrupt: pass")`,
      );
      await enter();
      await waitFor(async () => (await rows()).includes(`ga${i}`), `${i}번째 삼키는 루프 시작(ga${i} 출력 행)`);
      const tClick = Date.now();
      await resetAndWait();
      const tReady = Date.now();
      if ((await statusText()) !== "ready") {
        throw new Error(`${i}번째: 리셋 뒤 status = ${await statusText()}(ready 아님) — 회차 판정 불가`);
      }
      // 옛 worker가 사는 창(약 2초) 안에 눌러야 하므로 이 구간에 고정 대기를 넣지 않는다.
      await type(`exec("print('gb${i}')\\nwhile True: pass")`);
      await enter();
      await waitFor(async () => (await rows()).includes(`gb${i}`), `${i}번째 새 세션 실행 시작(gb${i} 출력 행)`);
      const tPress = Date.now();
      await ctrlC();
      let eaten = true;
      try {
        await waitFor(() => interruptedAfter(`gb${i}`), `${i}번째 첫 Ctrl+C 중단`, STALL_MS);
      } catch {
        eaten = false;
      }
      if (!eaten) {
        lost += 1;
        lostRounds.push(i);
        // 유실 회차 복구: 옛 worker는 이미 닫혔으니 두 번째 눌림이 먹어야 한다. 안 먹으면 리셋으로 복구한다.
        await ctrlC();
        try {
          await waitFor(() => interruptedAfter(`gb${i}`), `${i}번째 복구 Ctrl+C 중단`, STALL_MS);
          console.log(`  회차 ${i} 복구: 두 번째 Ctrl+C로 중단`);
        } catch {
          console.log(`  회차 ${i} 복구: 두 번째 Ctrl+C도 실패 → 리셋으로 복구`);
          await resetAndWait();
        }
      }
      const pe = h.pageErrors.length;
      console.log(`회차 ${i}: ${eaten ? "먹음" : "유실"}, pageErrors=${pe}`);
      const obs = `클릭→ready ${tReady - tClick}ms, ready→Ctrl+C ${tPress - tReady}ms, 클릭→Ctrl+C ${tPress - tClick}ms`;
      console.log(`  관찰: ${obs}`);
      h.notes[`ccafter: 회차 ${i} 관찰(정보용)`] = `${eaten ? "먹음" : "유실"}, ${obs}, pageErrors=${pe}`;
    }
    h.notes["ccafter: 유실 수"] = `유실 ${lost}/${N}${lost > 0 ? ` (회차 ${lostRounds.join(",")})` : ""}`;
    console.log(`ccafter: 유실 ${lost}/${N}`);
    if (lost > 0) throw new Error(`유실 ${lost}/${N} — 회차 ${lostRounds.join(",")}`);
  });

  // ── exit: exit() → 종료 Alert → 무응답 → 리셋으로 복구 ──
  await step("exit: exit() → terminated 상태와 Alert 문구", async () => {
    await type("exit()");
    await enter();
    await waitFor(async () => (await statusText()) === "terminated", "status = terminated", 10000);
    const text = await terminatedText();
    if (text !== TERMINATED_TEXT) throw new Error(`terminated 문구 = ${show(text)}`);
  });
  await step("exit: terminated에서 입력은 완전 무응답(에코도 없음)", async () => {
    // terminated 뒤에는 활성 읽기가 없어(8.3) 키가 화면에 아무 흔적도 안 남긴다 — echo도 없다. RD-019 뒤에는 이 키를 버리지
    // 않고 벤더 Readline이 쌓아 두지만(그리지 않는다) 리셋(`cancelRead`)이 폐기한다.
    // type()은 에코를 기다리므로 여기서는 쓰지 않는다(에코가 없는 게 기대 동작이라 항상 타임아웃한다).
    const before = await rows();
    await page.keyboard.type("1+1");
    await press("Enter");
    await page.waitForTimeout(500);
    const after = await rows();
    if (after.join("\n") !== before.join("\n")) {
      throw new Error(`terminated인데 화면이 바뀌었다(무응답이어야 한다) — ${show(after.slice(-3))}`);
    }
  });
  await step("exit: 리셋 버튼으로 복구 → Alert 사라짐 → 1+1 → 2", async () => {
    await resetAndWait();
    if ((await crashedVisible()) !== 0) throw new Error("복구 뒤에도 crashed Alert가 보인다");
    const terminatedCount = await page.locator('[data-testid="terminated"]').count();
    if (terminatedCount !== 0) throw new Error("복구 뒤에도 terminated Alert가 보인다");
    await submit("1+1");
    const t = await tail(3);
    if (!t.some((r) => r === "2")) throw new Error(`1+1 → 2가 안 보인다 — ${show(t)}`);
  });

  // ── crash: worker 크래시 유발 → crashed Alert → 재시작 → 복구 ──
  await step("crash: 강제 크래시 → crashed 상태와 메시지(forced 포함)", async () => {
    await type(
      'import pyodide.code; pyodide.code.run_js("setTimeout(() => { throw new Error(\'forced\') }, 0)")',
    );
    await enter();
    await waitFor(async () => (await statusText()) === "crashed", "status = crashed", 10000);
    const text = await crashedText();
    if (!text.includes("forced")) throw new Error(`crashed 문구 = ${show(text)}`);
  });
  await step("crash: 재시작 버튼 → 배너 → 1+1 → 2", async () => {
    await resetAndWait("restart");
    if ((await crashedVisible()) !== 0) throw new Error("재시작 뒤에도 crashed Alert가 보인다");
    await submit("1+1");
    const t = await tail(3);
    if (!t.some((r) => r === "2")) throw new Error(`1+1 → 2가 안 보인다 — ${show(t)}`);
  });

  // ── strict: StrictMode 이중 마운트 — worker 1개, .xterm 1개, 콘솔 경고 0 ──
  await step("strict: 로드 직후 worker 1개·.xterm 1개", async () => {
    if (h.workers.created > 2) {
      // StrictMode의 mount→cleanup→mount로 2개까지는 생성될 수 있으나 page.workers()는 살아있는 것만 센다.
    }
    const liveWorkers = page.workers().length;
    if (liveWorkers !== 1) throw new Error(`page.workers().length = ${liveWorkers}`);
    const xtermCount = await page.locator(".xterm").count();
    if (xtermCount !== 1) throw new Error(`.xterm 개수 = ${xtermCount}`);
  });
  await step("strict: 리셋 뒤에도 worker 1개", async () => {
    await resetAndWait();
    const liveWorkers = page.workers().length;
    if (liveWorkers !== 1) throw new Error(`리셋 뒤 page.workers().length = ${liveWorkers}`);
  });
  await step("strict: 콘솔 경고·오류 0", async () => {
    const problems = h.problemLogs();
    if (problems.length !== 0) throw new Error(`콘솔 문제 ${problems.length}건 — ${show(problems.slice(0, 3))}`);
  });

  // crash 절이 실제로 돈 경우에만(ONLY로 다른 절만 골랐으면 forced는 0이 맞다) pageerror 총계를 판정한다.
  const crashRan = pageSelected(currentOnly(), "crash");
  if (crashRan) {
    const forcedErrors = h.pageErrors.filter((e) => e.includes("forced"));
    const otherErrors = h.pageErrors.filter((e) => !e.includes("forced"));
    h.checks["pageerror: forced 1건만, 나머지 0"] =
      forcedErrors.length === 1 && otherErrors.length === 0;
    if (!h.checks["pageerror: forced 1건만, 나머지 0"]) {
      h.notes["pageerror: forced 1건만, 나머지 0"] =
        `forced=${forcedErrors.length}, 기타=${otherErrors.length} — ${show(otherErrors.slice(0, 3))}`;
      console.log(
        `FAIL  pageerror: forced 1건만, 나머지 0  — ${h.notes["pageerror: forced 1건만, 나머지 0"]}`,
      );
    } else {
      console.log("PASS  pageerror: forced 1건만, 나머지 0");
    }
  }

  // finish()의 ok는 pageErrors 총계가 0이어야 한다고 보지만, crash 절은 forced 오류 1건을 의도적으로
  // 낸다(위 checks에서 이미 "forced 1건만, 나머지 0"으로 별도 판정했다) — 전체 ok는 checks 기준으로 낸다.
  const label = serverLabel(url);
  await h.finish({ label });
  return Object.values(h.checks).every(Boolean);
}

async function runPreview(url) {
  const h = await open(url);
  const {
    page,
    rows,
    tail,
    waitFor,
    waitPrompt,
    type,
    enter,
    submit,
    focus,
    step,
  } = h;
  const statusText = () => page.locator('[data-testid="status"]').textContent();
  const crashedText = () => page.locator('[data-testid="crashed"]').textContent();
  const click = async (testid) => {
    await page.click(`[data-testid="${testid}"]`);
    await focus();
  };
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

  await step("초기: 첫 프롬프트", async () => waitPrompt(">>>"));
  await step("reset: 리셋 → 새 배너·프롬프트", async () => {
    await submit("x = 1");
    await resetAndWait();
    await submit("x");
    if (!(await rows()).some((r) => r.includes("NameError"))) {
      throw new Error("preview: 리셋 뒤 x가 NameError가 아니다");
    }
  });
  await step("exit: exit() → terminated → 리셋 복구", async () => {
    await type("exit()");
    await enter();
    await waitFor(async () => (await statusText()) === "terminated", "status = terminated", 10000);
    await resetAndWait();
    await submit("1+1");
    const t = await tail(3);
    if (!t.some((r) => r === "2")) throw new Error("preview: 리셋 복구 뒤 1+1 != 2");
  });
  await step("crash: 강제 크래시 → 재시작 → 복구", async () => {
    await type(
      'import pyodide.code; pyodide.code.run_js("setTimeout(() => { throw new Error(\'forced\') }, 0)")',
    );
    await enter();
    await waitFor(async () => (await statusText()) === "crashed", "status = crashed", 10000);
    const text = await crashedText();
    if (!text.includes("forced")) throw new Error(`preview crashed 문구 = ${show(text)}`);
    await resetAndWait("restart");
    await submit("1+1");
    const t = await tail(3);
    if (!t.some((r) => r === "2")) throw new Error("preview: 재시작 복구 뒤 1+1 != 2");
  });

  // finish()의 ok는 pageErrors 총계가 0이어야 한다고 보지만, crash 절은 forced 오류 1건을 의도적으로
  // 낸다(위 checks에서 이미 "forced 1건만, 나머지 0"으로 별도 판정했다) — 전체 ok는 checks 기준으로 낸다.
  const label = serverLabel(url);
  await h.finish({ label });
  return Object.values(h.checks).every(Boolean);
}

const { url: devURL, previewUrl: previewURL } = checkEntry();

const ok = await runDevPreview({
  url: devURL,
  previewUrl: previewURL,
  run: (u, phase) => (phase === "dev" ? runDev(u) : runPreview(u)),
});
exitWith(ok);
