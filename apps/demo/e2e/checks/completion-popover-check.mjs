// RD-049 DELTA-03 브라우저 확인: `?completionPopover=1`의 completion popover(DOM 오버레이, `role=listbox`).
// 실제 xterm 6 + 실제 브라우저 + 실제 CDN pyodide. 규칙 정의: `docs/design/07-tab-completion.md` 7.6(이관 전에는
// `_works/20260928-64-rd-049-completion-popover/design.md`, 규칙 ID K1~K5·M1~M3·C1~C6·L1~L3).
//
// 화면 둘을 각각 새 브라우저로 연다(RD-024 `react-fit-check.mjs`와 같은 구조): POP(`/?completionPopover=1`,
// P1~P7·H3)·OFF(`/`, P8 회귀 — 옵션 꺼짐은 지금 텍스트 목록 그대로).
//
// 셀(POP):
//   P1  `os.pa` + Tab·Tab → `[role=listbox]` 보임(`os.path` 포함), 첫 항목 `aria-selected="true"`,
//       스크롤백에 텍스트 목록(`os.pardir` 등) 없음
//   H3  (가설) 배경 출력 없이 연 뒤 다음 키(↓) 전까지 listbox가 유지된다 — 연속 폴링으로 확인한다(9.7,
//       "마커 배리어"가 없는 자리라 고정 대기 뒤 단발 확인 대신 짧은 창 동안 계속 존재를 샘플링한다.
//       "## 결정" 참고)
//   P2a K1·K2(Enter): ↓ → 두 번째 항목 선택 → Enter → 입력줄 `>>> <두 번째 후보>`, 행 수 불변(미제출),
//       listbox 없음
//   P2b K2(Tab): 다시 연 뒤 Tab → 첫 항목 적용, 행 수 불변(미제출), listbox 없음
//   P3  K3·H1: 연 뒤 Esc → listbox 없음, 입력줄 완전 불변(`>>> os.pa`), 화면에 `^[` 없음, 이어지는 `t` 입력이
//       깨끗이 삽입됨(buffer 오염 간접 확인, "## 결정" 참고)
//   P4  K4: 연 뒤 `t` → listbox 없음, 입력줄에 `t`가 그대로 삽입(`>>> os.pat`, 벤더로 전달)
//   P5  C2: 배경 출력 수신기(BroadcastChannel `popbg`) 설치 뒤 연 상태에서 배경 `P5T\n` → listbox 없음,
//       `P5T` 행 아래 입력줄 `>>> os.pa` 보존
//   P6  C3·H2: 스크롤백을 만들고(`print("\n" * 30)`) 연 뒤 `.xterm-viewport` 휠(popover와 안 겹치는 좌표) → listbox 없음
//   P7  M1·M2: 연 뒤 두 번째 항목 클릭 → 적용·닫힘(행 수 불변), `document.activeElement`가 xterm textarea
//   끝  콘솔 경고·오류·pageerror 0
// 셀(OFF, 옵션 꺼짐 회귀):
//   P8  `os.pa` + Tab·Tab → 텍스트 목록(`os.pardir`·`os.path` 포함), `[role=listbox]` 없음
//   끝  콘솔 경고·오류·pageerror 0
//
// 시간 판정(`docs/design/09-testing.md` 9.7): 고정 대기·ms 상한을 쓰지 않는다. listbox 존재·행 텍스트는
// `waitFor` 조건 대기, H3만 예외적으로 연속 폴링(아래 `assertStaysOpen`, "## 결정")을 쓴다.
//
// 사용: node completion-popover-check.mjs [devURL](생략 시 http://localhost:5173)
//   ONLY=POP 또는 ONLY=OFF로 화면 하나만, ONLY=P1,P3처럼 셀 접두어로도 거른다("초기"는 항상 실행).
// 결과 파일: `completion-popover-check-pop-dev.json`·`completion-popover-check-off-dev.json`.
import { checkEntry, exitWith, pageSelected } from "../check-runner.mjs";
import { open, show } from "../lib.mjs";

const { url: baseUrl } = checkEntry();
const only = (process.env.ONLY ?? "").split(",").filter(Boolean);
/** worker 부팅(pyodide 로드) 대기용 정지 감지 timeout(판정선이 아니다). */
const BOOT_TIMEOUT_MS = 90000;
/** 배경 출력 채널 이름(P5). bg-output-check.mjs의 `bgout`과 겹치지 않게 다른 이름을 쓴다. */
const CHANNEL = "popbg";

const VIEWS = [
  { name: "POP", path: "/?completionPopover=1", label: "pop-dev" },
  { name: "OFF", path: "/", label: "off-dev" },
].filter((v) => pageSelected(only, v.name));

let allOk = true;

for (const view of VIEWS) {
  const h = await open(new URL(view.path, baseUrl).href);
  const { page, step, waitFor, waitPrompt, rows, trimmedRows, lastLine, cursorRow, focus, type, press, enter, submit, clear } = h;

  /** `[role=listbox]` 안의 `role=option` 항목 텍스트·선택 상태. 없으면 `null`(DOM 존재만으로 판정 — 스크롤 위치와 무관). */
  const listboxInfo = () =>
    page.evaluate(() => {
      const el = document.querySelector('[role="listbox"]');
      if (!el) return null;
      const items = [...el.querySelectorAll('[role="option"]')].map((it) => ({
        text: it.textContent ?? "",
        selected: it.getAttribute("aria-selected") === "true",
      }));
      return { items };
    });
  const waitListboxVisible = (description, timeoutMs = 15000) =>
    waitFor(async () => (await listboxInfo()) !== null, `${description}: listbox 보임`, timeoutMs);
  const waitListboxGone = (description, timeoutMs = 15000) =>
    waitFor(async () => (await listboxInfo()) === null, `${description}: listbox 없음`, timeoutMs);
  /** 마지막 텍스트 행이 `expected`와 정확히 같을 때까지 기다린다(TRP-011: 전체 일치로 입력 행과 구별). */
  const waitInputLine = (expected, description, timeoutMs = 15000) =>
    waitFor(async () => (await lastLine()) === expected, `${description}: 입력줄 = ${show(expected)}`, timeoutMs);
  /** 입력 줄을 지운다(커서 앞 Ctrl+U, 뒤 Ctrl+K). 빈 `>>>`가 될 때까지 기다린다. */
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
  /** `os.pa` + Tab·Tab으로 completion popover를 연다(공통 접두 없음 — `os.pardir`·`os.path`·`os.pathsep` 3개가
   * 갈라지므로 첫 Tab은 무동작, 둘째 Tab이 연다, `tab-check.mjs` C3f와 같은 픽스처). */
  async function openPopover() {
    await type("os.pa");
    await press("Tab");
    await press("Tab");
    await waitListboxVisible("os.pa 두 번째 Tab");
  }
  /** H3: 배경 출력·스크롤·리사이즈 같은 닫기 신호가 전혀 없는 동안 listbox가 스스로 닫히지 않는지, `windowMs` 동안
   * 짧은 간격으로 계속 관찰한다(9.7 "## 결정" — 단발 확인이 아니라 창 전체를 샘플링해 도중에 닫히면 그 자리에서 잡는다).
   * 상수 근거(리뷰 지적: 숫자 자체의 근거가 없었다): 두 번째 Tab이 여는 completion 왕복(popover가 열리는 그 동작)의
   * 실측 지연은 `tab-check.mjs` C12 기록(`BASELINE.md`, a. 속성 후보 중앙값 25.2·최대 35.8ms)과 같은 worker 왕복
   * 경로다. 샘플 간격 30ms는 그 왕복 1회 정도, 창 300ms는 그 최댓값의 약 8배 — H3가 실패한다면(연 직후 지연 파싱
   * 대기 쓰기로 곧장 닫힘) 왕복 시간 안에 드러날 결함이라 이 배율이면 충분히 여유 있게 잡는다. */
  async function assertStaysOpen(windowMs, description) {
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
      if ((await listboxInfo()) === null) throw new Error(`${description}: listbox가 도중에 사라짐(H3 반증)`);
      await page.waitForTimeout(30);
    }
  }

  if (view.name === "POP") {
    await step("초기 프롬프트 표시 + os 임포트 + 배경 출력 수신기 설치", async () => {
      await waitPrompt(">>>", BOOT_TIMEOUT_MS);
      await focus();
      await submit("import os");
      await submit("import asyncio, js; from pyodide.ffi import create_proxy");
      await submit("bgl = asyncio.get_event_loop()");
      await submit('bgp = lambda d: print(d, end="", flush=True)');
      await submit(`bgc = js.BroadcastChannel.new("${CHANNEL}")`);
      await submit("bgc.onmessage = create_proxy(lambda e: bgl.call_soon(bgp, e.data))");
      await clear();
    });

    await step("P1 os.pa Tab·Tab → listbox 보임(os.path 포함)·첫 항목 선택·텍스트 목록 없음", async () => {
      await freshCell();
      await openPopover();
      const info = await listboxInfo();
      if (!info.items.some((it) => it.text === "os.path")) {
        throw new Error(`listbox 항목에 os.path 없음: ${show(info.items.map((it) => it.text))}`);
      }
      if (info.items[0]?.selected !== true) {
        throw new Error(`첫 항목이 선택 상태가 아님: ${show(info.items)}`);
      }
      if ((await rows()).some((r) => r.includes("os.pardir"))) {
        throw new Error("텍스트 목록(os.pardir 포함 행)이 화면에 남아 있다(popover 대신 printAbove가 돈 흔적)");
      }
    });

    await step("H3 배경 출력 없이 연 상태가 다음 키 전까지 유지된다", async () => {
      // 위 P1이 이미 열어 둔 상태를 이어 쓴다(재호출 없이 이 시점의 listbox가 P1이 연 것과 같은지가 판정 대상).
      await assertStaysOpen(300, "P1 직후");
    });

    await step("P2a K1·K2(Enter) ↓ → 두 번째 후보 적용, 미제출·listbox 없음", async () => {
      const before = await listboxInfo();
      if (before === null) throw new Error("P1이 연 listbox가 이 시점에 이미 없다(H3 반증)");
      const candidate = before.items[1]?.text;
      if (!candidate) throw new Error(`두 번째 후보 없음: ${show(before.items)}`);
      const rowsBefore = (await trimmedRows()).length;
      await press("ArrowDown");
      await waitFor(
        async () => (await listboxInfo())?.items[1]?.selected === true,
        "ArrowDown 뒤 두 번째 항목 선택(H3: listbox가 그동안 안 사라짐)",
      );
      await enter();
      await waitInputLine(`>>> ${candidate}`, "Enter 적용 뒤");
      await waitListboxGone("Enter 적용 뒤");
      if ((await trimmedRows()).length !== rowsBefore) {
        throw new Error("Enter가 새 행을 만들었다(제출됨) — K2는 제출하지 않아야 한다");
      }
      await wipeInput();
    });

    await step("P2b K2(Tab) 첫 후보 적용, 미제출·listbox 없음", async () => {
      await openPopover();
      const before = await listboxInfo();
      const candidate = before?.items[0]?.text;
      if (!candidate) throw new Error(`첫 번째 후보 없음: ${show(before?.items)}`);
      const rowsBefore = (await trimmedRows()).length;
      await press("Tab");
      await waitInputLine(`>>> ${candidate}`, "Tab 적용 뒤");
      await waitListboxGone("Tab 적용 뒤");
      if ((await trimmedRows()).length !== rowsBefore) {
        throw new Error("Tab 적용이 새 행을 만들었다(제출됨)");
      }
      await wipeInput();
    });

    await step("P3 K3·H1 Esc → listbox 없음, 입력줄 완전 불변, 화면에 ^[ 없음, 이어지는 입력도 깨끗하다", async () => {
      await openPopover();
      await press("Escape");
      await waitListboxGone("Esc 뒤");
      await waitInputLine(">>> os.pa", "Esc 뒤 입력줄 불변");
      if ((await rows()).some((r) => r.includes("^["))) {
        throw new Error("화면에 ^[가 남았다(H1 반증 — Esc가 \\x1b 한 바이트가 아니었을 가능성)");
      }
      // xterm은 실제 VT 파서라 제어문자를 `^[` 글리프로 렌더링하지 않는다 — 위 화면 검사만으로는
      // `\x1b`가 buffer에 조용히 섞여 들어갔는지 잡지 못한다(리뷰 지적). K3가 Esc를 온전히 삼키지
      // 못하고 buffer가 오염됐다면, 바로 뒤 정상 글자 입력이 그 오염된 지점에서부터 어긋난 자리에
      // 붙는다 — 이어지는 삽입이 P4와 똑같이 깨끗한지(`>>> os.pat`)로 buffer 상태를 간접 확인한다.
      await type("t");
      await waitInputLine(">>> os.pat", "Esc 뒤 이어지는 입력도 정상 삽입");
      await wipeInput();
    });

    await step("P4 K4 그 밖의 입력(t) → listbox 없음, 벤더로 전달되어 t가 삽입됨", async () => {
      await openPopover();
      await type("t");
      await waitListboxGone("t 입력 뒤");
      await waitInputLine(">>> os.pat", "t 삽입 뒤");
      await wipeInput();
    });

    await step("P5 C2 배경 출력(BroadcastChannel) → listbox 없음, 입력줄 os.pa 보존", async () => {
      await openPopover();
      await page.evaluate(
        ([name, text]) => {
          window.__popBg ??= new BroadcastChannel(name);
          window.__popBg.postMessage(text);
        },
        [CHANNEL, "P5T\n"],
      );
      await waitFor(async () => (await rows()).some((r) => r === "P5T"), "배경 출력 행 P5T");
      await waitListboxGone("배경 출력 뒤");
      await waitInputLine(">>> os.pa", "배경 출력 뒤 입력줄 보존");
      await wipeInput();
    });

    await step("P6 C3·H2 휠 스크롤(.xterm-viewport, popover 밖 좌표) → listbox 없음", async () => {
      await freshCell();
      await submit('print("\\n" * 30)');
      await openPopover();
      const box = await page.locator(".xterm-viewport").boundingBox();
      if (!box) throw new Error(".xterm-viewport bounding box 없음");
      // 휠 좌표가 popover 위라면 휠이 M3(목록 안쪽 스크롤)로 먹혀 C3(뷰포트 스크롤)를 시험하지 못한다
      // — 세로 중앙·위쪽 두 후보 중 popover `boundingBox()`와 안 겹치는 쪽을 고른다(리뷰 지적).
      const popBox = await page.locator('[role="listbox"]').boundingBox();
      const overlapsPop = (y) => popBox !== null && y >= popBox.y && y <= popBox.y + popBox.height;
      const candidateYs = [box.y + box.height / 2, box.y + 10];
      const wheelY = candidateYs.find((y) => !overlapsPop(y));
      if (wheelY === undefined) throw new Error(`휠 좌표 후보가 모두 popover와 겹친다: viewport=${show(box)} popover=${show(popBox)}`);
      await page.mouse.move(box.x + box.width / 2, wheelY);
      await page.mouse.wheel(0, -200);
      await waitListboxGone("휠 스크롤 뒤");
      // 다음 셀을 위해 뷰포트를 맨 아래로 되돌린다(popover 위치 계산과 무관 — DOM 판정은 스크롤 위치에
      // 의존하지 않지만, 이어지는 셀은 `.xterm-rows`로 입력줄을 읽어야 하므로 가시 범위로 복귀한다).
      await page.mouse.wheel(0, 100000);
      await waitFor(async () => (await cursorRow()) >= 0, "휠 복귀 뒤 입력줄 다시 보임");
      await wipeInput();
    });

    await step("P7 M1·M2 두 번째 항목 클릭 → 적용·닫힘, 포커스는 xterm textarea", async () => {
      await openPopover();
      const before = await listboxInfo();
      const candidate = before?.items[1]?.text;
      if (!candidate) throw new Error(`두 번째 후보 없음: ${show(before?.items)}`);
      const rowsBefore = (await trimmedRows()).length;
      await page.locator('[role="option"]').nth(1).click();
      await waitInputLine(`>>> ${candidate}`, "클릭 적용 뒤");
      await waitListboxGone("클릭 적용 뒤");
      if ((await trimmedRows()).length !== rowsBefore) {
        throw new Error("클릭 적용이 새 행을 만들었다(제출됨)");
      }
      const activeIsTerminal = await page.evaluate(
        () => document.activeElement?.classList.contains("xterm-helper-textarea") === true,
      );
      if (!activeIsTerminal) throw new Error("클릭 뒤 포커스가 xterm textarea에 없다(M2 반증)");
      await wipeInput();
    });
  }

  if (view.name === "OFF") {
    await step("초기 프롬프트 표시 + os 임포트", async () => {
      await waitPrompt(">>>", BOOT_TIMEOUT_MS);
      await focus();
      await submit("import os");
      await clear();
    });

    await step("P8 옵션 꺼짐: os.pa Tab·Tab → 텍스트 목록, listbox 없음", async () => {
      await type("os.pa");
      await press("Tab");
      await press("Tab");
      await waitFor(async () => (await rows()).some((r) => r.includes("os.pardir") && r.includes("os.path")), "os. 텍스트 목록");
      if ((await listboxInfo()) !== null) throw new Error("옵션이 꺼졌는데 listbox가 떴다");
    });
  }

  await step("끝 콘솔 경고·오류·pageerror가 없다", async () => {
    if (h.problemLogs().length > 0 || h.pageErrors.length > 0) {
      throw new Error(JSON.stringify({ problemLogs: h.problemLogs(), pageErrors: h.pageErrors }));
    }
  });

  const ok = await h.finish({ label: view.label });
  allOk &&= ok;
}

exitWith(allOk);
