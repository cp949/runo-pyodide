// RD-022b 브라우저 확인: 열린 읽기(REPL `>>> `, REPL `input()`) 위 배경 출력 조율. 실제 xterm 6 + 실제 브라우저 + 실제 CDN
// pyodide. 열린 읽기 중 배경 출력은 입력줄을 지우고 출력을 쓴 뒤 프롬프트·입력·커서를 그 아래에 다시 그린다. 개행 없는 조각은 프롬프트
// 앞 접두가 된다(checklist 확정 1·4). 화면은 xterm 행(`.xterm-rows > div`)으로 판정한다.
//
// 배경 출력 만들기: 초기 단계에서 Python에 BroadcastChannel(`bgout`) 수신기를 두고, 수신한 문자열을 asyncio 콜백(`loop.call_soon`)에서
// `print(d, end="", flush=True)`로 낸다. 페이지가 같은 이름 채널로 문자열을 보내면(`emit`) 입력이 화면에 그려진 **뒤에** 배경 출력이
// 난다 — `call_later(지연)`은 입력 전에 출력이 올 수 있어(느린 장비) 시간에 기대지 않으려고 바꿨다(9.7).
// REPL `input()` 대기 중에는 worker가 메일박스(`Atomics.wait`)에 멈춰 배경 출력을 낼 수 없으므로, B04만 main 포트에 `write` 알림을
// 합성해 넣는다(`injectRpcNotice`, 실제 알림과 같은 핸들러 경로).
//
// 셀:
//   B01 `pri` 입력 중 배경 `B01T\n` → 행 `B01T`, 마지막 행 `>>> pri`(커서 열 7), `>>> priB01T` 행 없음
//   B02 같은 상태(`B02T\n`) 뒤 Backspace 2회 → `B02T` 행 보존, 마지막 행 `>>> p`(커서 열 5)
//   B03 개행 없는 `B03T` → `B03T>>> pri`(커서 열 11), Backspace → `B03T>>> pr`(조각 유실 없음), `int(3)` 입력 → Enter →
//       `B03T>>> print(3)` / `3` / `>>>`(다음 프롬프트에 접두 중복 없음)
//   B04 `input("x: ")`에 `ab`를 친 상태에서 배경 `B04T\n`(합성 `write` 알림) → 행 `B04T` 아래 `x: ab`(커서 열 5), Enter → `got ab`
//   B05 `pri` 입력 중 배경 `B05T\n` 뒤 `runSource("print(5)")` → `B05T` / `5` / `>>> pri`, 옛 `>>> pri`·`>>> priB05T` 흔적 없음
//   B06 맨 아래 행(24행째) 프롬프트에서 배경 1행·2행 출력(스크롤) → 입력줄이 맨 아래 행에 한 번만, 출력 행 순서 보존, 이어 편집·Enter
//       (checklist 멈추는 지점 3)
//   B07 `pri` 입력 중 `\r`로 끝나는 진행률 조각 `B07 50%\r`·`B07 100%\r` → `B07 100%>>> pri`(제자리 갱신, 커서 열 15), 이어 `\n` →
//       `B07 100%` / `>>> pri`(`\r` 끝 조각이 사라지지 않고 그 행이 남는다, RD-022b 리뷰 SO-T1)
//   B08 `pri` 입력 중 커서 숨김 진행률 조각 `\x1b[?25lB08 50%\r` → `B08 50%>>> pri`, 커서 열 14(실제 글자 끝). 벤더 폭 계산이 CSI 사설
//       접두(`\x1b[?25l`)를 글자로 세면 `25l`이 3칸이 되어 커서가 열 17로 어긋난다(이슈 15). 이어 Backspace → 열 13, `\n` → `B08 50%` / `>>> pr`(열 6)
//   B09 (`FIT=1`일 때만) `?fit=1`에서 `pri` 입력 중 아주 긴 배경 출력(재그리기 write 콜백이 오래 걸린다)을 합성 알림으로 넣고 곧바로 창
//       너비를 줄인다 → 리사이즈가 재그리기 대기 중에 들어와도 입력줄 흔적 행이 남지 않는다(`>>> pri` 행 1개, 커서 열 7, 이슈 10). 수정 전에는
//       `onResize`가 화면에 없는 입력줄을 콜백보다 먼저 그렸다. 기본 모드(`FIT` 미설정)에서는 B01~B08만, `FIT=1`에서는 B09만 실행한다.
//       **양성 대조 미검출**: 수정 전 코드에서도 통과했다(창 크기 변경이 재그리기 대기 창에 들었는지 셀이 기록하지 않는다). 결함 10의 판정은
//       jsdom 시험(벤더 `print-above-raw.test.ts`·`take-read.test.ts`)이 하고 이 셀은 `BASELINE.md`의 기대에 넣지 않는다
//   끝  콘솔 경고·오류·pageerror 0
//
// 시간 판정(`docs/design/09-testing.md` 9.7): 고정 대기·ms 상한을 쓰지 않는다. 배경 출력은 조건 대기(`waitTail`·`waitLineWithCursor`)로
// 기다리고, 입력한 코드 행과 출력 행은 행 정확일치로 구별한다(TRP-011). 셀은 Ctrl+L로 시작해 전체 행 목록을 단언한다(TRP-008).
//
// 사용: node bg-output-check.mjs [url](생략 시 http://localhost:5173)     ONLY=B01,B04 node bg-output-check.mjs
//       FIT=1 node bg-output-check.mjs   (B09: 페이지를 `/?fit=1`로 열고 창 크기를 바꾼다. 초기·끝 확인은 함께 돈다)
// 결과 파일 label은 url 포트 4173이면 preview, 그 밖은 dev(RD-018 결정과 같은 규칙). `FIT=1`이면 앞에 `fit-`을 붙인다.
import { checkEntry, exitWith, serverLabel } from "../check-runner.mjs";
import { injectRpcNotice, installRpcTap, open, same, show } from "../lib.mjs";

const { url: baseUrl } = checkEntry();
/** `FIT=1`이면 `?fit=1`로 열어 xterm이 창 크기를 따르게 하고 B09만 돈다. 그 밖에는 기본 80×24 화면으로 B01~B08을 돈다. */
const fit = process.env.FIT === "1";
const url = fit ? new URL("/?fit=1", baseUrl).href : baseUrl;
const label = `${fit ? "fit-" : ""}${serverLabel(baseUrl)}`;
/** worker 부팅(pyodide 로드)·리셋 대기용 정지 감지 timeout(판정선이 아니다). */
const BOOT_TIMEOUT_MS = 90000;
/** 배경 출력 채널 이름(Python 수신기와 같다). */
const CHANNEL = "bgout";

const h = await open(url, { before: installRpcTap, ...(fit ? { viewport: { width: 1280, height: 720 } } : {}) });
const { page, step, waitFor, waitPrompt, waitLastEndsWith, waitStatus, rows, trimmedRows, tail, cursorRow, focus, type, enter, press, submit, typeWhenReading, clear } = h;

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

/** 행 하나가 `text`와 정확히 같은지(입력 행과 출력 행을 구별하려면 전체 일치여야 한다, TRP-011). */
const hasRow = async (text) => (await rows()).some((r) => r === text);
/** `text`와 정확히 같은 행의 개수. */
const countRow = async (text) => (await rows()).filter((r) => r === text).length;
/** 이어붙인 화면에서 `needle`이 나오는 횟수(행이 감겨도 놓치지 않는다). */
const countOf = async (needle) => (await rows()).join("").split(needle).length - 1;

/** 페이지의 BroadcastChannel로 문자열을 보낸다. Python 수신기가 asyncio 콜백에서 그대로(`end=""`) 출력한다. */
const emit = (text) =>
  page.evaluate(
    ([name, t]) => {
      window.__bgOut ??= new BroadcastChannel(name);
      window.__bgOut.postMessage(t);
    },
    [CHANNEL, text],
  );

/** 끝쪽 빈 행을 자른 화면의 마지막 `n`행이 `expected`가 될 때까지 기다린다. */
async function waitTail(expected, description, timeoutMs = 15000) {
  await waitFor(async () => same(await tail(expected.length), expected), `${description}: 마지막 ${expected.length}행 = ${show(expected)}`, timeoutMs);
}
/** 끝쪽 빈 행을 자른 화면 전체가 `expected`가 될 때까지 기다린다(셀은 Ctrl+L로 시작하므로 전체 행 목록을 단언한다). */
async function waitScreen(expected, description, timeoutMs = 15000) {
  await waitFor(async () => same(await trimmedRows(), expected), `${description}: 화면 = ${show(expected)}`, timeoutMs);
}
/** 마지막 텍스트 행과 커서가 그 행에 있는지. */
async function lastRowInfo() {
  const all = await rows();
  let last = all.length - 1;
  while (last >= 0 && all[last] === "") last -= 1;
  return { text: last >= 0 ? all[last] : "", index: last, isCursorRow: last >= 0 && (await cursorRow()) === last };
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
/** 셀 시작 상태: 화면을 지워 `>>>` 프롬프트가 맨 윗 행에 오게 한다. */
async function freshCell() {
  await waitPrompt(">>>", BOOT_TIMEOUT_MS);
  await clear();
}

const resultText = () => page.locator('[data-testid="source-result"]').textContent();
/** 코드를 `textarea`에 넣고 `run-source`를 누른 뒤 결과 칸의 JSON을 기다린다(클릭이 가져간 포커스는 터미널로 되돌린다). */
async function callSource(code, timeoutMs = 30000) {
  await page.fill('[data-testid="source"]', code);
  await page.click('[data-testid="run-source"]');
  await focus();
  await waitFor(async () => (await resultText()) !== "", `source-result: ${code}`, timeoutMs);
  return JSON.parse(await resultText());
}

/**
 * Python 쪽 배경 출력 수신기를 둔다. 각 줄은 한 행(80열) 안에 들어가게 짧게 나눴다(`submit`이 커서 행 끝 글자로 입력 완료를 본다).
 * 루프는 최상위에서 한 번 잡아 둔다(JS 콜백 안의 `get_event_loop()` 경고를 피한다).
 */
async function setupReceiver() {
  await submit("import asyncio, js; from pyodide.ffi import create_proxy");
  await submit("bgl = asyncio.get_event_loop()");
  await submit('bgp = lambda d: print(d, end="", flush=True)');
  await submit(`bgc = js.BroadcastChannel.new("${CHANNEL}")`);
  await submit("bgc.onmessage = create_proxy(lambda e: bgl.call_soon(bgp, e.data))");
}
/** 실패한 셀 뒤 복구: `reset`으로 새 세션을 열고 수신기를 다시 둔다(새 세션에는 이전 전역이 없다). */
async function recover() {
  await page.click('[data-testid="reset"]');
  await waitStatus(["ready", "load-failed"], "복구: 리셋 뒤 ready", BOOT_TIMEOUT_MS);
  await focus();
  await waitPrompt(">>>", BOOT_TIMEOUT_MS);
  await setupReceiver();
}
async function bgStep(name, fn) {
  await step(name, fn);
  if (h.checks[name] === false) await recover().catch((e) => console.log(`복구 실패: ${e.message}`));
}
/** 기본 모드(`FIT` 미설정) 전용 셀. `FIT=1`에서는 건너뛴다. */
const baseStep = (name, fn) => (fit ? undefined : bgStep(name, fn));
/** `FIT=1` 전용 셀. 기본 모드에서는 건너뛴다. */
const fitStep = (name, fn) => (fit ? bgStep(name, fn) : undefined);
/** 화면 열 수(DOM 기하: `.xterm-screen` 너비 ÷ 셀 너비). 데모가 `Terminal`을 노출하지 않아 `react-fit-check.mjs`와 같은 방법으로 잰다. */
const screenCols = () =>
  page.evaluate(() => {
    const screen = document.querySelector(".xterm-screen");
    const measure = document.querySelector(".xterm-char-measure-element");
    if (!screen || !measure) return Number.NaN;
    const cell = measure.getBoundingClientRect().width / (measure.textContent ?? "").length;
    return Math.round(screen.getBoundingClientRect().width / cell);
  });

await step("초기 프롬프트가 뜨고 배경 출력 수신기가 빈 프롬프트 위에 출력한다", async () => {
  await waitPrompt(">>>", BOOT_TIMEOUT_MS);
  await focus();
  await setupReceiver();
  await clear();
  await emit("B00T\n");
  await waitScreen(["B00T", ">>>"], "빈 프롬프트 위 배경 출력");
  const info = await lastRowInfo();
  if (!info.isCursorRow) throw new Error(`커서가 프롬프트 행에 없다 ${show(info)}`);
});

await baseStep("B01 `pri` 입력 중 배경 `B01T` 행 → 행 `B01T` 아래 `>>> pri`(커서 열 7), `>>> priB01T` 없음", async () => {
  await freshCell();
  await type("pri");
  await waitLineWithCursor(">>> pri", 7, "배경 출력 전 입력");
  await emit("B01T\n");
  await waitScreen(["B01T", ">>> pri"], "배경 출력 뒤");
  await waitLineWithCursor(">>> pri", 7, "다시 그린 입력줄");
  if (await hasRow(">>> priB01T")) throw new Error("`>>> priB01T` 행이 있다(입력줄 뒤에 이어 붙음)");
  if ((await countOf("B01T")) !== 1) throw new Error(`B01T ${await countOf("B01T")}번`);
  await wipeInput();
});

await baseStep("B02 배경 `B02T` 행 뒤 Backspace 2회 → `B02T` 행 보존, 마지막 행 `>>> p`(커서 열 5)", async () => {
  await freshCell();
  await type("pri");
  await waitLineWithCursor(">>> pri", 7, "배경 출력 전 입력");
  await emit("B02T\n");
  await waitScreen(["B02T", ">>> pri"], "배경 출력 뒤");
  await press("Backspace");
  await press("Backspace");
  await waitLineWithCursor(">>> p", 5, "Backspace 2회 뒤");
  await waitScreen(["B02T", ">>> p"], "Backspace 2회 뒤 화면");
  await wipeInput();
});

await baseStep("B03 개행 없는 배경 `B03T` → `B03T>>> pri`, Backspace·편집 뒤에도 접두 유지, Enter → 다음 `>>>`에 중복 없음", async () => {
  await freshCell();
  await type("pri");
  await waitLineWithCursor(">>> pri", 7, "배경 출력 전 입력");
  await emit("B03T");
  await waitScreen(["B03T>>> pri"], "개행 없는 배경 출력 뒤");
  await waitLineWithCursor("B03T>>> pri", 11, "접두 붙은 입력줄");
  // 프로브 P2(Backspace가 조각을 지움)의 회귀 확인: 재그리기가 접두를 함께 그린다.
  await press("Backspace");
  await waitLineWithCursor("B03T>>> pr", 10, "Backspace 뒤");
  await type("int(3)");
  await waitLineWithCursor("B03T>>> print(3)", 16, "편집 뒤");
  await waitScreen(["B03T>>> print(3)"], "편집 뒤 화면");
  // 프로브 P7(Enter가 조각을 지움)의 회귀 확인: 접두는 그 행과 함께 남고 다음 프롬프트에는 붙지 않는다.
  await enter();
  await waitPrompt(">>>");
  await waitScreen(["B03T>>> print(3)", "3", ">>>"], "Enter 뒤");
  if ((await countOf("B03T")) !== 1) throw new Error(`B03T ${await countOf("B03T")}번`);
});

await baseStep("B04 `input(\"x: \")`에 `ab` 입력 중 배경 `B04T` 행 → `B04T` 아래 `x: ab`(커서 열 5), Enter → `got ab`", async () => {
  await freshCell();
  await type('print("got", input("x: "))');
  await enter();
  await waitLastEndsWith("x:");
  await typeWhenReading("ab");
  await waitLineWithCursor("x: ab", 5, "stdin 입력");
  // worker는 `input()` 대기 중 메일박스에 멈춰 있어 배경 출력을 낼 수 없다 — main 포트에 `write` 알림을 합성한다.
  await injectRpcNotice(page, "write", "B04T\n");
  await waitScreen(['>>> print("got", input("x: "))', "B04T", "x: ab"], "배경 출력 뒤");
  await waitLineWithCursor("x: ab", 5, "다시 그린 stdin 입력줄");
  await enter();
  await waitPrompt(">>>");
  await waitScreen(['>>> print("got", input("x: "))', "B04T", "x: ab", "got ab", ">>>"], "Enter 뒤");
});

await baseStep("B05 `pri` 입력 중 배경 `B05T` 행 뒤 runSource(print(5)) → `B05T`·`5`·`>>> pri`, 옛 입력줄 흔적 없음", async () => {
  await freshCell();
  await type("pri");
  await waitLineWithCursor(">>> pri", 7, "배경 출력 전 입력");
  await emit("B05T\n");
  await waitScreen(["B05T", ">>> pri"], "배경 출력 뒤");
  const r = await callSource("print(5)");
  if (!same(r, { kind: "ok" })) throw new Error(`결과 = ${show(r)}`);
  await waitScreen(["B05T", "5", ">>> pri"], "runSource 뒤");
  await waitLineWithCursor(">>> pri", 7, "복원한 입력줄");
  if (await hasRow(">>> priB05T")) throw new Error("`>>> priB05T` 행이 있다");
  if ((await countRow(">>> pri")) !== 1) throw new Error(`\`>>> pri\` 행 ${await countRow(">>> pri")}개(옛 입력줄이 남았다)`);
  await wipeInput();
});

await baseStep("B06 맨 아래 행 프롬프트에서 배경 1행·2행 출력(스크롤) → 입력줄이 맨 아래 행에 하나, 이어 편집·Enter", async () => {
  await freshCell();
  await submit('print("\\n" * 30)');
  const total = (await rows()).length;
  if ((await cursorRow()) !== total - 1) throw new Error(`프롬프트가 맨 아래 행이 아니다: 커서 행 ${await cursorRow()} / 행 ${total}`);
  await type("pri");
  await waitLineWithCursor(">>> pri", 7, "배경 출력 전 입력");
  await emit("B06T\n");
  await waitTail(["B06T", ">>> pri"], "배경 1행 뒤");
  await waitLineWithCursor(">>> pri", 7, "배경 1행 뒤 입력줄");
  await emit("B06U\nB06V\n");
  await waitTail(["B06T", "B06U", "B06V", ">>> pri"], "배경 2행 뒤");
  await waitLineWithCursor(">>> pri", 7, "배경 2행 뒤 입력줄");
  const info = await lastRowInfo();
  if (info.index !== total - 1) throw new Error(`입력줄 행 ${info.index} ≠ 맨 아래 행 ${total - 1}(밀림)`);
  if ((await countRow(">>> pri")) !== 1) throw new Error(`\`>>> pri\` 행 ${await countRow(">>> pri")}개(겹침)`);
  // 앵커가 스크롤 뒤 행과 맞으면 이어지는 편집 재그리기도 같은 행에 그려진다.
  await type("nt(6)");
  await waitLineWithCursor(">>> print(6)", 12, "편집 뒤");
  await enter();
  await waitPrompt(">>>");
  await waitTail(["B06T", "B06U", "B06V", ">>> print(6)", "6", ">>>"], "Enter 뒤");
  if ((await cursorRow()) !== total - 1) throw new Error(`Enter 뒤 커서 행 ${await cursorRow()} ≠ ${total - 1}`);
});

await baseStep("B07 `\\r`로 끝나는 진행률 조각 → `B07 100%>>> pri`, 이어 `\\n` → `B07 100%` 행 아래 `>>> pri`", async () => {
  await freshCell();
  await type("pri");
  await waitLineWithCursor(">>> pri", 7, "배경 출력 전 입력");
  await emit("B07 50%\r");
  await waitScreen(["B07 50%>>> pri"], "첫 진행률 조각 뒤");
  await emit("B07 100%\r");
  await waitScreen(["B07 100%>>> pri"], "둘째 진행률 조각 뒤(제자리 갱신)");
  await waitLineWithCursor("B07 100%>>> pri", 15, "접두 붙은 입력줄");
  await emit("\n");
  await waitScreen(["B07 100%", ">>> pri"], "진행률 끝 개행 뒤");
  await waitLineWithCursor(">>> pri", 7, "다시 그린 입력줄");
  if ((await countOf("B07 50%")) !== 0) throw new Error("`B07 50%`가 남았다(제자리 갱신 안 됨)");
  await wipeInput();
});

await baseStep("B08 커서 숨김 진행률 조각 `\\x1b[?25lB08 50%\\r` → `B08 50%>>> pri`, 커서가 실제 글자 끝(열 14)", async () => {
  await freshCell();
  await type("pri");
  await waitLineWithCursor(">>> pri", 7, "배경 출력 전 입력");
  await emit("\x1b[?25lB08 50%\r");
  await waitScreen(["B08 50%>>> pri"], "진행률 조각 뒤");
  await waitLineWithCursor("B08 50%>>> pri", 14, "접두 붙은 입력줄");
  // 뒤이은 편집 재그리기도 같은 폭으로 커서를 놓는다.
  await press("Backspace");
  await waitLineWithCursor("B08 50%>>> pr", 13, "Backspace 뒤 입력줄");
  // 접두가 남은 채로는 `wipeInput`의 빈 `>>>` 대기가 통과하지 못하므로 `\n`으로 접두 행을 확정한 뒤 정리한다(B07과 같다).
  await emit("\n");
  await waitScreen(["B08 50%", ">>> pr"], "접두 확정 개행 뒤");
  await waitLineWithCursor(">>> pr", 6, "접두 없는 입력줄");
  await wipeInput();
});

await fitStep("B09 `?fit=1`에서 긴 배경 출력의 재그리기 대기 중 창 너비를 줄여도 입력줄 흔적 행이 없다(`>>> pri` 행 1개, 커서 열 7)", async () => {
  await freshCell();
  await type("pri");
  await waitLineWithCursor(">>> pri", 7, "배경 출력 전 입력");
  const before = await screenCols();
  // 긴 출력은 xterm이 여러 조각으로 나눠 해석하므로 그 뒤 재그리기 write 콜백이 수십 ms 뒤에 온다. 그 사이에 창 크기 리사이즈가 들어오게
  // 하려는 것이다(짧은 출력은 콜백이 창 리사이즈의 `requestAnimationFrame`보다 먼저 온다). 합성 알림은 실제 `write` 알림과 같은 핸들러를 지난다.
  const LINES = 200000;
  await page.evaluate((count) => {
    const port = window.__rpcTap?.port;
    if (!port) throw new Error("RPC 알림을 받은 포트가 없다");
    const text = Array.from({ length: count }, (_, i) => `B09 ${i}`).join("\n") + "\n";
    port.dispatchEvent(new MessageEvent("message", { data: { kind: "ntf", name: "write", args: [text] } }));
  }, LINES);
  await page.setViewportSize({ width: 800, height: 720 });
  await waitFor(async () => (await screenCols()) < before, `창 800px 뒤 cols가 ${before}보다 줄어듦`, 15000);
  // 출력이 끝까지 도착하고(`B09 199999` 다음 행) 재그리기가 끝나면 마지막 두 행이 이 모양이다.
  await waitTail([`B09 ${LINES - 1}`, ">>> pri"], "긴 배경 출력·재그리기 뒤", 60000);
  await waitLineWithCursor(">>> pri", 7, "재그리기 뒤 입력줄", 60000);
  const all = await rows();
  const stray = all.filter((r) => r.includes(">>> pri")).length;
  if (stray !== 1) throw new Error(`\`>>> pri\`가 ${stray}번 보인다(입력줄 흔적 행): ${show(all.filter((r) => r !== "").slice(-6))}`);
  if ((await countOf(">>> pri")) !== 1) throw new Error(`이어붙인 화면에서 \`>>> pri\` ${await countOf(">>> pri")}번`);
  await wipeInput();
});

await step("끝 콘솔 경고·오류·pageerror가 없다", async () => {
  if (h.problemLogs().length > 0 || h.pageErrors.length > 0) {
    throw new Error(JSON.stringify({ problemLogs: h.problemLogs(), pageErrors: h.pageErrors }));
  }
});

const ok = await h.finish({ label });
exitWith(ok);
