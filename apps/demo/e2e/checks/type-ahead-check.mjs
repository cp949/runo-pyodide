// RD-019 브라우저 확인: 읽기가 없는 구간(실행 중·Enter 직후·부팅 중·리셋 직후)에 친 키를
// 벤더 Readline이 쌓았다가 다음 활성 읽기에서 순서대로 재생한다. 규칙은 `docs/design/06-editing.md` 6.7.
// 3.14 tty 입력 큐와 같은 결과를 기대한다(편차 32 해소).
//
// 셀 T01~T12:
//   T01 실행 중 `abc` → 종료 뒤 마지막 행 `>>> abc`, 커서가 그 끝(브라우저 양성 대조 대상)
//   T02 실행 중 `print(...)`+Enter → 종료 뒤 제출돼 출력 행과 새 프롬프트
//   T03 실행 중 `ab`+Enter+`cd` → 첫 줄만 제출(NameError), `>>> cd`가 남는다(읽기당 소비)
//   T04 Enter 직후(지연 0ms) `z` 1회 → 다음 프롬프트 `>>> z`
//   T05 실행 중 친 줄이 다음 읽기 `input()`의 값이 된다
//   T06 실행 중 `abc` 뒤 Ctrl+C → KeyboardInterrupt, 쌓인 `abc` 폐기
//   T07 실행 중 붙여넣기(합성 paste 이벤트) → 낡은 State에 그려지지 않고 다음 프롬프트에 들어온다
//   T08 부팅 중(첫 프롬프트 전) 키 → 첫 프롬프트에서 재생
//   T09 리셋: 리셋 전에 쌓인 키는 폐기(a), 리셋 뒤 부팅 중 친 키는 유지(b)
//   T10 상한 4096 초과 덩어리 폐기. 브라우저 셀이 없다.
//       - 벤더 단위 시험(`packages/xterm-readline/test/type-ahead.test.ts`)이 같은 결과를 결정적으로 고정한다.
//       - 그 시험은 상한 경계(4096 정확히)·초과 덩어리 폐기·앞 유지·작은 덩어리 수용을 본다.
//       - 브라우저에서 4096자를 넘겨 치면 시간만 들고 새로 아는 것이 없다.
//   T11 실행 중 Tab 포함 입력 → Tab 리더 훅을 거쳐 재생(완성이 적용된다)
//   T12 실행 중 `if 1:`+Shift+Enter+`pass` → 재생된 Shift+Enter가 자동 들여쓰기를 거쳐 `>>> if 1:` / `    pass`
//
// 실행 순서: T08 → 초기 → T01~T07 → T09a → T09b → T11 → T12.
// T08은 `open()` 직후(첫 프롬프트 전)에 키를 쳐야 하므로 "초기"보다 먼저 돈다.
//
// 시간 판정은 `docs/design/09-testing.md` 9.7을 따른다. 판정은 마커 배리어·`waitFor`로만 한다.
// - 실행이 "진행 중"임은 출력 행 마커(`RUNnn`)가 보인 뒤에 키를 쳐 확인한다.
// - 재생 결과는 마지막 행이 기대 프롬프트가 될 때까지 기다린다.
// - "쌓인 키가 없다"는 판정(T06·T09a)은 프롬프트 뒤 마커 명령(`print('…M')`)을 제출해 본다.
//   그 입력 행에 옛 글자가 끼지 않았는지가 판정이다.
// - 입력 행도 마커 문자열을 포함하므로 출력 행만 센다(TRP-011).
//
// 사용: `node type-ahead-check.mjs [url]`. `ONLY=T01,T05`로 셀을 고른다.
// 결과 파일 규칙은 README "결과 파일 규칙".
import { checkEntry, exitWith, serverLabel } from "../check-runner.mjs";
import { open, same, show } from "../lib.mjs";

const { url } = checkEntry();
const label = serverLabel(url);

const h = await open(url);
const { page, step, waitPrompt, waitFor, waitStatus, statusText, rows, tail, cursorRow, clear, type, enter, press, focus, submit, ctrlC } = h;

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

/** 마지막 텍스트 행이 `expected`이고 커서가 그 행의 끝에 있을 때까지 기다린다(재생된 줄이 다 그려진 상태). */
async function waitLineEnd(expected, timeoutMs = 20000) {
  await waitPrompt(expected, timeoutMs);
  await waitFor(async () => (await cursorCol()) === expected.length, `커서가 ${JSON.stringify(expected)}의 끝(열 ${expected.length})`, 5000);
}

/** 출력 행(`text` 전체가 한 행)이 화면에 있는지. 입력 행(`>>> …`)과 구별한다(TRP-011). */
const hasOutputRow = async (text) => (await rows()).some((r) => r === text);

/**
/**
 * 실행을 시작한다: `time.sleep(seconds)` 앞에 출력 마커 `marker`를 찍고, 마커 행이 보일 때까지 기다린다.
 * 마커 행이 실행이 진행 중이라는 배리어다. `after`는 마커 뒤 같은 줄에 이어 붙일 문장이다(`; v = input()` 등).
 */
async function startRunning(marker, seconds, after = "") {
  await clear();
  await type(`import time; print('${marker}'); time.sleep(${seconds})${after}`);
  await enter();
  await waitFor(() => hasOutputRow(marker), `실행 마커 ${marker}`, 15000);
}

/**
 * 셀이 실패한 뒤 남은 상태를 빈 프롬프트로 되돌린다. `taStep`이 실패 때만 부른다. 최대 4바퀴 돈다.
 * - 입력이 남은 프롬프트(`>>> …`, 커서가 그 행): Ctrl+U.
 * - 그 밖: Ctrl+C.
 */
async function recover() {
  for (let i = 0; i < 4; i += 1) {
    const all = await rows();
    let last = all.length - 1;
    while (last >= 0 && all[last] === "") last -= 1;
    if (last >= 0 && all[last] === ">>>" && (await cursorRow()) === last) return;
    if (last >= 0 && all[last].startsWith(">>>") && (await cursorRow()) === last) {
      await press("Control+u");
    } else {
      await ctrlC();
    }
    await waitFor(
      async () => {
        const r = await rows();
        let l = r.length - 1;
        while (l >= 0 && r[l] === "") l -= 1;
        return l >= 0 && r[l].endsWith(">>>") && (await cursorRow()) === l;
      },
      "복구: 프롬프트",
      8000,
    ).catch(() => {});
  }
}
/** 셀을 실행한다. 실패하면 `recover()`로 빈 프롬프트를 되돌린다. */
async function taStep(name, fn) {
  await step(name, fn);
  if (h.checks[name] === false) await recover();
}
/** 줄 지우기(Ctrl+U) 뒤 빈 프롬프트가 될 때까지 기다린다(다음 셀이 깨끗하게 시작하게 한다). */
async function clearInput() {
  await press("Control+u");
  await waitPrompt(">>>", 5000);
}
/**
 * 쌓인 키가 없음을 마커 명령으로 확인한다: 프롬프트가 `>>>`(빈 줄)로 보인 뒤 `print('<marker>')`를 제출하고 그 입력 행이
 * 정확히 `>>> print('<marker>')`인지(옛 글자가 앞에 끼지 않았는지)와 출력 행·새 프롬프트를 본다.
 */
async function assertNoLeftover(marker) {
  await waitPrompt(">>>", 20000);
  await submit(`print('${marker}')`);
  const t = await tail(3);
  if (!same(t, [`>>> print('${marker}')`, marker, ">>>"])) throw new Error(`마커 제출 뒤 마지막 3행 = ${show(t)}`);
}

// ── T08: 부팅 중 키. open() 직후(첫 프롬프트 전)에 쳐야 하므로 "초기" 확인보다 먼저 둔다 ──
await step("T08 부팅 중(첫 프롬프트 전) 친 키가 첫 프롬프트에서 재생된다", async () => {
  await waitFor(() => page.evaluate(() => document.querySelector(".xterm-helper-textarea") !== null), "xterm textarea", 15000);
  await focus();
  const before = await statusText();
  if (before !== "loading") throw new Error(`부팅이 이미 끝나 있어 시나리오 전제가 성립하지 않는다(status=${show(before)})`);
  await page.keyboard.type("abc");
  await waitLineEnd(">>> abc", 60000);
});
await step("초기: 프롬프트가 뜬다", async () => {
  await waitFor(
    async () => {
      const all = await rows();
      let last = all.length - 1;
      while (last >= 0 && all[last] === "") last -= 1;
      return last >= 0 && all[last].startsWith(">>>") && (await cursorRow()) === last;
    },
    "첫 프롬프트",
    60000,
  );
  await focus();
  const all = await rows();
  if (all.some((r) => r === ">>> abc")) await clearInput();
  await submit("import os");
});

await taStep("T01 실행 중 `abc` → 종료 뒤 마지막 행 `>>> abc`, 커서가 그 끝", async () => {
  await startRunning("RUN01", 2);
  await page.keyboard.type("abc");
  await waitLineEnd(">>> abc");
  await clearInput();
});

await taStep("T02 실행 중 `print('T02OUT')`+Enter → 종료 뒤 제출되어 출력 행과 새 프롬프트", async () => {
  await startRunning("RUN02", 2);
  await page.keyboard.type("print('T02OUT')");
  await press("Enter");
  await waitPrompt(">>>", 20000);
  const t = await tail(4);
  if (!same(t, ["RUN02", ">>> print('T02OUT')", "T02OUT", ">>>"])) throw new Error(`마지막 4행 = ${show(t)}`);
});

await taStep("T03 실행 중 `ab`+Enter+`cd` → 첫 줄 `ab`만 제출(NameError), `>>> cd`가 남는다", async () => {
  await startRunning("RUN03", 2);
  await page.keyboard.type("ab");
  await press("Enter");
  await page.keyboard.type("cd");
  await waitLineEnd(">>> cd");
  const all = await rows();
  if (!all.includes(">>> ab")) throw new Error(`제출된 첫 줄(>>> ab)이 없다 — ${show(all.slice(-8))}`);
  if (!all.some((r) => r.startsWith("NameError:"))) throw new Error(`NameError 행이 없다 — ${show(all.slice(-8))}`);
  await clearInput();
});

// 이 셀은 Enter 직후(지연 0ms)에 키 1개를 친다.
// 수정 전(RD-019 이전) 측정에서 0ms 유입이 1/10이었다(편차 32 실측, `docs/design/10-parity-deviations.md`).
// - 유입은 `z`가 다음 프롬프트에 들어온 것이다. 성공이다.
// - 수정 전 코드에서는 10회 중 9회 `z`가 유실된다. 그래서 회귀가 있으면 이 셀 한 번이 실패할 확률이 약 90%다.
// 회귀 검출력은 아래 둘이 결정적으로 맡는다.
// - 벤더 단위 "콜백 대기 중 키" 시험
// - T01의 `sleep` 셀
await taStep("T04 Enter 직후(지연 0ms) `z` 1회 → 다음 프롬프트 `>>> z`", async () => {
  await clear();
  await press("Enter");
  await page.keyboard.type("z");
  await waitLineEnd(">>> z");
  await clearInput();
});

await taStep("T05 실행 중 친 줄 `xyz`+Enter가 다음 읽기 input()의 값이 된다", async () => {
  await startRunning("RUN05", 2, "; v = input()");
  await page.keyboard.type("xyz");
  await press("Enter");
  await waitPrompt(">>>", 20000);
  await submit("repr(v)");
  const t = await tail(3);
  if (!same(t, [">>> repr(v)", `"'xyz'"`, ">>>"])) throw new Error(`repr(v) 뒤 마지막 3행 = ${show(t)}`);
});

await taStep("T06 실행 중 `abc` 뒤 Ctrl+C → KeyboardInterrupt, 쌓인 `abc`는 폐기", async () => {
  await startRunning("RUN06", 30);
  await page.keyboard.type("abc");
  await ctrlC();
  await waitFor(async () => (await rows()).some((r) => r === "KeyboardInterrupt"), "KeyboardInterrupt 행", 15000);
  await assertNoLeftover("T06M");
});

/** 실행 중 화면을 바꾸지 않고 xterm에 합성 paste 이벤트를 보낸다. `lib.mjs`의 `paste()`는 화면 변화를 기다려 실행 중에는 쓸 수 없다. */
const pasteSilently = async (text) => {
  await focus();
  await page.evaluate((t) => {
    const ta = document.querySelector(".xterm-helper-textarea");
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
};
await taStep("T07 실행 중 붙여넣기(여러 줄) → 낡은 State에 그려지지 않고 다음 프롬프트에 들어온다", async () => {
  await startRunning("RUN07", 2);
  await pasteSilently("print('T07A')\nprint('T07B')");
  // 붙여넣은 두 줄이 하나의 여러 줄 입력으로 다음 프롬프트에 들어온다(마지막 행 = 둘째 줄, 커서가 그 끝).
  await waitLineEnd("print('T07B')");
  if (!(await rows()).includes(">>> print('T07A')")) throw new Error(`첫 줄 행(>>> print('T07A'))이 없다 — ${show((await rows()).slice(-6))}`);
  // Enter 한 번에 두 출력이 나온다(RD-011).
  await enter();
  await waitPrompt(">>>", 20000);
  const t = await tail(4);
  if (!t.includes("T07A") || !t.includes("T07B")) throw new Error(`두 출력 행이 없다 — ${show(t)}`);
});

await taStep("T09a 실행 중 쌓인 키는 리셋(새 프로세스)에서 폐기된다", async () => {
  await startRunning("RUN09", 30);
  await page.keyboard.type("old");
  await page.click('[data-testid="reset"]');
  await focus();
  await waitStatus(["loading"], "T09a: loading");
  await waitStatus(["ready", "load-failed"], "T09a: ready", 30000);
  await assertNoLeftover("T09AM");
});

await taStep("T09b 리셋 뒤 부팅 중(loading) 친 키는 새 세션 첫 프롬프트에서 재생된다", async () => {
  await page.click('[data-testid="reset"]');
  await focus();
  await waitStatus(["loading"], "T09b: loading");
  await page.keyboard.type("new");
  await waitLineEnd(">>> new", 60000);
  await clearInput();
  await submit("import os");
});

// Tab이 **마지막 키**인 입력만 판정한다. Tab 뒤에 키가 이어지면 다음이 일어난다.
// - 재생은 한 틱에 끝난다: `os.getc` → Tab(worker 왕복 시작) → `(`·`)`.
// - `(`·`)`가 왕복 응답 전에 삽입된다.
// - 응답 적용 조건에 걸린다. 버퍼·커서가 요청 시점과 같아야 한다(`tab-reader.ts` `applyResume`, `docs/design/07-tab-completion.md` 7.1).
// - 완성이 버려져 `>>> os.getc()`가 된다(실측).
// 사람이 왕복보다 빨리 이어 치는 경우와 같은 기존 경합 규칙이다. 이 셀에서 고치지 않는다.
// 왕복은 약 25ms다(`docs/design/09-testing.md` 9.6, `BASELINE.md` tab-check C12 실측 25.2ms).
await taStep("T11 실행 중 Tab 포함 입력 `os.getc`+Tab → Tab 리더 훅을 거쳐 `>>> os.getcwd`", async () => {
  await startRunning("RUN11", 2);
  await page.keyboard.type("os.getc");
  await press("Tab");
  await waitLineEnd(">>> os.getcwd");
  await clearInput();
});

// Shift+Enter는 xterm `onData`가 아니라 벤더 `handleKeyEvent`의 `keydown`으로 들어와 `Input` 항목으로 쌓인다.
// 재생은 `readKey`를 거치고 `onKey` 훅(자동 들여쓰기)이 개행 뒤 4칸을 넣는다(`docs/design/06-editing.md` 6.3·6.7).
// 단위 시험은 훅이 `ShiftEnter`를 받는 것까지만 본다. 실제 들여쓰기는 이 셀이 처음 확인한다.
// 웹은 Enter 1회로 여러 줄을 실행하고(편차 7) 둘째 줄에 `... ` 접두사가 없다(편차 10).
await taStep("T12 실행 중 `if 1:`+Shift+Enter+`pass` → 자동 들여쓰기를 거쳐 `>>> if 1:` / `    pass`", async () => {
  await startRunning("RUN12", 2);
  await page.keyboard.type("if 1:");
  await press("Shift+Enter");
  await page.keyboard.type("pass");
  // 마지막 행이 `    pass`이고 커서가 그 끝(열 8)일 때까지 기다린 뒤 첫 행을 확인한다(`waitLineEnd`는 마지막 행만 본다).
  await waitLineEnd("    pass");
  const t = await tail(2);
  if (!same(t, [">>> if 1:", "    pass"])) throw new Error(`마지막 2행 = ${show(t)}`);
  // Enter 1회로 실행되고(편차 7) 새 프롬프트가 뜬다. 그 사이에 오류 행이 없어야 한다(입력 행이 아니라 출력 행 기준).
  await enter();
  await waitPrompt(">>>", 20000);
  const after = await tail(4);
  if (after.some((r) => r.startsWith("SyntaxError") || r.startsWith("Traceback") || r.includes("IndentationError"))) {
    throw new Error(`실행 뒤 오류 행이 있다 — ${show(after)}`);
  }
});

await step("콘솔 경고·오류·pageerror가 없다", async () => {
  if (h.problemLogs().length > 0 || h.pageErrors.length > 0) {
    throw new Error(JSON.stringify({ problemLogs: h.problemLogs(), pageErrors: h.pageErrors }));
  }
});

const ok = await h.finish({ label });
exitWith(ok);
