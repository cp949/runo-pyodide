// RD-010 DELTA-00: RD-009 하니시(`_works/_completed/20260922-09-rd-009-idle-ctrl-c/verify/lib.mjs`)를
// 저장소 devDependency(`playwright`, apps/demo/package.json)로 옮긴 것. 이후 각 RD의 브라우저 확인
// 스크립트는 `_works/<작업>/verify/`에 두고 이 파일만 import한다(복사하지 않는다).
//
// 사용법:
//   import { open, hasFg, same, show } from "<repo>/apps/demo/e2e/lib.mjs";
//   const h = await open("http://localhost:5173"); // dev 서버 URL
//   await h.waitPrompt(">>>");
//   ...
//   await h.finish(); // pageErrors 계수 포함 결과를 JSON으로 출력하고 브라우저를 닫는다
//   await h.finish({ label: "preview" }); // 결과 파일 이름에만 쓰이는 label(기본 "dev")
//
// 전제: `pnpm --filter demo dev`(또는 `preview`)가 떠 있고, `pnpm exec playwright install chromium`이
// 끝나 있어야 한다.
//
// 결과 파일(RD-018 DELTA-01): `finish()`가 stdout JSON을 그대로 찍으면서 같은 내용을
// `process.env.E2E_RESULTS_DIR`(기본 `apps/demo/e2e/results/`)에 `<호출 스크립트 파일명>-<label>.json`으로도
// 쓴다. 같은 프로세스에서 같은 조합이 반복되면 `-2`·`-3` 접미가 붙는다.
//
// 규칙(RD-004 DELTA-08 계승): 고정 sleep 대신 조건이 참이 될 때까지 폴링한다. 행 텍스트는 `.xterm-rows > div`(NBSP → 공백,
// 행 끝 공백 제거), 색은 span 클래스(`xterm-fg-1` 빨강, `xterm-fg-2` 초록). 개행 수는 커서 행 번호로 단언한다(TRP-006).
// 입력은 새 프롬프트 행(`>>> ` 또는 꼬리+`>>> `)이 보인 뒤에 보낸다(TRP-005). 읽기가 없는 구간의 키는 벤더 Readline이
// 쌓았다가 다음 읽기에서 재생하므로(RD-019) 재시도로 키를 다시 치면 글자가 중복된다.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = path.dirname(fileURLToPath(import.meta.url));

// RD-018 DELTA-01: finish()가 결과 파일을 쓸 때 호출 스크립트 파일명을 기준으로 삼는데, 같은 프로세스에서
// 같은 스크립트가 label을 바꿔가며(또는 같은 label로) finish()를 여러 번 부를 수 있다(dev·preview 등). 그
// 반복을 세어 `-2`·`-3` 접미를 붙이는 카운터. 모듈 스코프라 프로세스 하나당 하나만 존재한다.
const resultFileCounts = new Map();

/** `<스크립트 파일명>-<label>[-N].json` 형태의 결과 파일 이름을 만든다(같은 조합 반복 시 N을 2부터 붙인다). */
function resultFileName(label) {
  const scriptPath = process.argv[1] ?? "script";
  const base = path.basename(scriptPath, path.extname(scriptPath));
  const key = `${base}-${label}`;
  const count = (resultFileCounts.get(key) ?? 0) + 1;
  resultFileCounts.set(key, count);
  return count === 1 ? `${key}.json` : `${key}-${count}.json`;
}

/**
 * 환경변수 `name`을 `min` 이상의 유한한 수로 읽는다(없거나 빈 문자열이면 기본값 1). 잘못된 값은 조용히 1로 되돌리지
 * 않고 던진다 — 감속·배율을 켰다고 믿고 실행했는데 실제로는 꺼져 있는 상황을 막는다.
 */
function readEnvNumber(name, min) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return 1;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name}=${JSON.stringify(raw)}는 ${min} 이상의 수가 아니다`);
  }
  return value;
}

/**
 * 브라우저를 띄워 url을 연다. 반환한 객체의 헬퍼가 화면·입력·콘솔 기록·페이지 내부 시계를 다룬다.
 *
 * 환경변수(이슈 `.scratch/e2e-time-dependence/` 02·03, 판정 규칙은 `docs/design/09-testing.md` 9.7):
 * - `E2E_CPU_THROTTLE`(기본 1): 1보다 크면 CDP `Emulation.setCPUThrottlingRate`로 CPU를 그 배율만큼 감속한다.
 *   감속은 `waitPrompt()`가 **처음 성공한 시점에 1회** 적용한다(부팅 구간은 감속하지 않는다). 기본값(1)에서는 CDP 세션을
 *   만들지 않아 기존 동작이 그대로다.
 * - `E2E_TIME_SCALE`(기본 1): e2e 스크립트가 응답성 상한(9.7 2항)에 곱할 배율. 핸들의 `timeScale`로 노출한다. e2e 전용이며
 *   L0(vitest) 상수에는 적용되지 않는다.
 * 두 값은 결과 JSON `notes`에 기본값이어도 항상 기록되고, 기본값이 아니면 시작 시 콘솔 경고를 한 줄 낸다.
 */
export async function open(url, { viewport, before, waitUntil = "load" } = {}) {
  const cpuThrottle = readEnvNumber("E2E_CPU_THROTTLE", 1);
  const timeScale = readEnvNumber("E2E_TIME_SCALE", Number.MIN_VALUE);
  if (cpuThrottle !== 1 || timeScale !== 1) {
    console.warn(`경고: E2E_CPU_THROTTLE=${cpuThrottle} E2E_TIME_SCALE=${timeScale} (기본 1이 아님, 결과 notes에 기록됨)`);
  }
  const browser = await chromium.launch();
  const page = await browser.newPage(viewport ? { viewport } : undefined);
  // CDP 세션은 감속이 켜졌을 때만 만든다. 첫 프롬프트 성공 시점(waitPrompt)에 감속을 1회 적용한다.
  const cdp = cpuThrottle > 1 ? await page.context().newCDPSession(page) : null;
  let throttleApplied = false;
  const logs = [];
  const pageErrors = [];
  const workers = { created: 0 };
  page.on("console", (msg) => logs.push({ source: "page", type: msg.type(), text: msg.text() }));
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("worker", (w) => {
    workers.created += 1;
    w.on("console", (msg) => logs.push({ source: "worker", type: msg.type(), text: msg.text() }));
  });
  // 클립보드 붙여넣기(paste())가 쓰는 권한. headless Chromium이 거부해도(구버전 등) paste()가 fallback으로
  // 넘어가므로 여기서는 실패를 삼킨다.
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"])
    .catch(() => {});
  if (before) await before(page);
  // `commit`은 문서 응답이 오자마자 돌아온다. 부팅 중(pyodide 로드 중)에 무언가를 하려면 이것이 필요하다.
  await page.goto(url, { waitUntil });

  // 페이지 내부 타이머(TRP-022): Node↔페이지 CDP 왕복을 측정값에서 빼기 위해, Ctrl+C(`c` keydown, ctrlKey)의
  // 실제 타임스탬프와 프롬프트 복귀 순간을 같은(페이지 내부) 시계로 잰다. armMeasurement()/readElapsed()가 쓴다.
  await page.evaluate(() => {
    window.__ctrlCAt = [];
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.ctrlKey && e.key === "c") window.__ctrlCAt.push(performance.now());
      },
      true,
    );
    window.__armPrompt = () => {
      window.__promptReadyAt = null;
      const root = document.querySelector(".xterm-rows");
      const text = (el) => (el.textContent ?? "").replace(/ /g, " ").replace(/\s+$/, "");
      const check = () => {
        const rowsEls = [...root.querySelectorAll(":scope > div")];
        let last = rowsEls.length - 1;
        while (last >= 0 && text(rowsEls[last]) === "") last -= 1;
        if (last >= 0 && text(rowsEls[last]) === ">>>" && rowsEls[last].querySelector(".xterm-cursor")) {
          if (window.__promptReadyAt == null) window.__promptReadyAt = performance.now();
        }
      };
      if (window.__promptObserver) window.__promptObserver.disconnect();
      window.__promptObserver = new MutationObserver(check);
      window.__promptObserver.observe(root, { childList: true, subtree: true, characterData: true });
      check();
    };
  });
  /** 눌림 전에 부른다: 복귀 관측을 무장하고 이전 눌림 기록을 비운다. */
  async function armMeasurement() {
    await page.evaluate(() => {
      window.__armPrompt();
      window.__ctrlCAt.length = 0;
    });
  }
  /** 눌림·복귀가 끝난 뒤 페이지 시계로 잰 경과(ms)를 읽는다. `which`: "last"(기본, 단발·다중 눌림의 마지막) | "first"(연타 시작). */
  async function readElapsed(which = "last") {
    const r = await page.evaluate(() => ({ promptReadyAt: window.__promptReadyAt, ctrlCAt: window.__ctrlCAt.slice() }));
    const at = which === "first" ? r.ctrlCAt[0] : r.ctrlCAt.at(-1);
    return r.promptReadyAt - at;
  }

  /** 화면 행 텍스트(NBSP는 공백으로, 행 끝 공백은 제거). */
  const rows = () =>
    page.$$eval(".xterm-rows > div", (els) =>
      els.map((e) => (e.textContent ?? "").replace(/ /g, " ").replace(/\s+$/, "")),
    );
  /** 행별 span 클래스 목록. */
  const rowClasses = () =>
    page.$$eval(".xterm-rows > div", (els) =>
      els.map((e) => [...e.querySelectorAll("span")].flatMap((s) => s.className.split(/\s+/).filter(Boolean))),
    );
  /** 텍스트를 가진 마지막 행의 span별 {text, cls}. */
  const spansOf = (needle) =>
    page.evaluate((n) => {
      const row = [...document.querySelectorAll(".xterm-rows > div")]
        .filter((d) => (d.textContent ?? "").includes(n))
        .pop();
      return row
        ? [...row.querySelectorAll("span")].map((s) => ({ text: (s.textContent ?? "").replace(/ /g, " "), cls: s.className }))
        : [];
    }, needle);
  /** 커서가 있는 행 번호(없으면 -1). */
  const cursorRow = () =>
    page.evaluate(() => [...document.querySelectorAll(".xterm-rows > div")].findIndex((el) => el.querySelector(".xterm-cursor")));
  /** 끝쪽 빈 행을 자른 행 목록(출력 사이의 빈 행은 보존한다). */
  const trimmedRows = async () => {
    const r = await rows();
    while (r.length && r[r.length - 1] === "") r.pop();
    return r;
  };
  const nonEmpty = async () => (await rows()).filter((l) => l !== "");
  const lastLine = async () => {
    const r = await nonEmpty();
    return r[r.length - 1] ?? "";
  };
  const tail = async (n) => (await trimmedRows()).slice(-n);

  /** 조건이 참이 될 때까지 폴링한다. 시간 초과면 설명과 화면 끝을 담아 던진다. */
  async function waitFor(check, description, timeoutMs = 30000, intervalMs = 40) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await check();
      if (result) return result;
      if (Date.now() > deadline) {
        throw new Error(`시간 초과: ${description} — 화면 끝 ${JSON.stringify((await trimmedRows()).slice(-6))}`);
      }
      await page.waitForTimeout(intervalMs);
    }
  }
  /**
   * 마지막 텍스트 행이 `expected`(끝 공백 무시)이고 커서가 그 행에 있을 때까지 기다린다. 프롬프트 행이 보이면 읽기가
   * 시작된 것이다(TRP-005). 첫 프롬프트는 pyodide 로드가 수 초라 기본 30초.
   *
   * `E2E_CPU_THROTTLE`이 1보다 크면 이 함수가 **처음 성공한 시점에 1회** CPU 감속을 건다(부팅 뒤부터 감속하려는
   * 것이다). 이후 호출은 감속을 다시 보내지 않는다. 프롬프트를 기다리지 않는 스크립트는 감속이 걸리지 않는다.
   */
  async function waitPrompt(expected = ">>>", timeoutMs = 30000) {
    await waitFor(
      async () => {
        const all = await rows();
        let last = all.length - 1;
        while (last >= 0 && all[last] === "") last -= 1;
        return last >= 0 && all[last] === expected && (await cursorRow()) === last;
      },
      `프롬프트 ${JSON.stringify(expected)}`,
      timeoutMs,
    );
    if (cdp && !throttleApplied) {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
      throttleApplied = true;
    }
  }
  /** 마지막 텍스트 행이 suffix로 끝나고 커서가 그 행에 있을 때까지 기다린다(꼬리가 길어 행 전체를 모를 때). */
  async function waitLastEndsWith(suffix, timeoutMs = 15000) {
    await waitFor(
      async () => {
        const all = await rows();
        let last = all.length - 1;
        while (last >= 0 && all[last] === "") last -= 1;
        return last >= 0 && all[last].endsWith(suffix) && (await cursorRow()) === last;
      },
      `마지막 행이 ${JSON.stringify(suffix)}로 끝남`,
      timeoutMs,
    );
  }

  /** `[data-testid=status]` 텍스트. */
  const statusText = () => page.locator('[data-testid="status"]').textContent();
  /** `statusText()`가 `values` 중 하나가 될 때까지 기다린다(RD-012). */
  async function waitStatus(values, label, timeoutMs = 30000) {
    await waitFor(
      async () => values.includes(await statusText()),
      label ?? `status가 ${show(values)} 중 하나`,
      timeoutMs,
    );
  }

  const focus = () => page.evaluate(() => document.querySelector(".xterm-helper-textarea")?.focus());
  /**
   * 텍스트를 입력하고 커서 행이 그 끝 글자로 끝나도록 그려질 때까지 기다린다. xterm은 키를 비동기로 그려서, 그리기 전에
   * 화면을 읽으면 낡은 프롬프트 행에 통과한다. 행을 넘겨 감기는 긴 입력은 `sync: false`로 호출자가 따로 기다린다.
   */
  const type = async (text, { sync = true } = {}) => {
    await page.keyboard.type(text);
    const tailChars = text.trimEnd().slice(-10);
    if (!sync || tailChars === "") return;
    await waitFor(async () => {
      const all = await rows();
      const cur = await cursorRow();
      return cur >= 0 && (all[cur] ?? "").endsWith(tailChars);
    }, `입력 ${JSON.stringify(tailChars)}가 커서 행에 그려짐`, 5000);
  };
  const press = (key) => page.keyboard.press(key);
  /**
   * xterm의 `paste` 이벤트 경로(RD-011): 클립보드에 쓰고 Control+V로 붙여넣는다(`\n`→`\r` 변환은 벤더
   * `readPaste`가 한다). headless Chromium은 Control+V가 실제 OS 클립보드 붙여넣기를 일으키지 않는다(실측,
   * DELTA-04 "## 결정") — 화면이 안 바뀌면 `textarea`에 `ClipboardEvent("paste")`를 직접 dispatch하는
   * fallback으로 대체한다. `page.keyboard.insertText`는 대신 쓰지 않는다: CDP `Input.insertText`가 `\n`을
   * 삽입 이벤트에서 지워버려(실측) 여러 줄 소스가 한 줄로 뭉개진다. 합성 `paste` 이벤트는 xterm이 실제로
   * 듣는 이벤트(`qs` 핸들러, `event.clipboardData.getData("text/plain")`)라 실제 붙여넣기와 같은 코드 경로를
   * 지난다. 반환값의 `usedFallback`으로 호출부가 기록할 수 있다.
   */
  const paste = async (text) => {
    const before = await snapshot();
    let usedFallback = false;
    try {
      await page.evaluate((t) => navigator.clipboard.writeText(t), text);
      await focus();
      await press("Control+V");
      const changed = await waitFor(
        async () => (await snapshot()) !== before,
        "붙여넣기 반영",
        1500,
      ).then(
        () => true,
        () => false,
      );
      if (!changed) throw new Error("clipboard paste가 화면을 바꾸지 않았다(headless Control+V)");
    } catch {
      usedFallback = true;
      await focus();
      await page.evaluate((t) => {
        const ta = document.querySelector(".xterm-helper-textarea");
        const dt = new DataTransfer();
        dt.setData("text/plain", t);
        const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
        ta.dispatchEvent(ev);
      }, text);
      await waitFor(
        async () => (await snapshot()) !== before,
        "합성 paste 이벤트 반영",
        1500,
      );
    }
    return { usedFallback };
  };
  /** 화면 스냅샷(행 + 커서 행). Enter가 화면을 바꿨는지 보는 데 쓴다. */
  const snapshot = async () => JSON.stringify([await rows(), await cursorRow()]);
  /**
   * Enter를 치고 화면이 실제로 바뀔 때까지 기다린다. Enter는 항상 개행을 그리므로 바뀌지 않으면 아직 처리되지 않은 것이다.
   * 이 뒤에 새 프롬프트를 기다리면 낡은 프롬프트 행에 통과하지 않는다.
   */
  const enter = async () => {
    const before = await snapshot();
    await press("Enter");
    await waitFor(async () => (await snapshot()) !== before, "Enter 뒤 화면 변화", 5000);
  };
  /** 코드를 입력하고 Enter를 친 뒤 다음 프롬프트를 기다린다. */
  async function submit(code, expectedPrompt = ">>>") {
    await type(code);
    await enter();
    await waitPrompt(expectedPrompt);
  }
  /** 화면을 지우고(Ctrl+L) 맨 윗 행에 `>>>`가 다시 그려질 때까지 기다린다. 24행을 넘는 출력이 스크롤로 행 비교를 깨지 않게 한다. */
  async function clear() {
    await focus();
    await press("Control+l");
    await waitFor(async () => (await rows())[0] === ">>>" && (await cursorRow()) === 0, "Ctrl+L 뒤 첫 행의 >>>", 5000);
  }
  /**
   * top-level await 체크박스를 `on`에 맞춘다(RD-012). 이미 같으면 무동작. 다르면 클릭 → `reset()`이 동기로
   * 발행하는 `loading` → `ready`/`load-failed` → 새 프롬프트까지 기다린다. 클릭이 xterm의 숨은 textarea에서
   * 포커스를 가져가므로 끝에 되돌린다. `load-failed`면 던진다.
   */
  async function setTopLevelAwait(on) {
    const checked = await page.locator('[data-testid="top-level-await"]').isChecked();
    if (checked === on) return;
    await page.click('[data-testid="top-level-await"]');
    await waitStatus(["loading"], "top-level await 전환: loading 상태");
    await waitStatus(["ready", "load-failed"], "top-level await 전환: ready/load-failed 상태");
    await focus();
    if ((await statusText()) === "load-failed") {
      throw new Error("top-level await 전환 뒤 load-failed");
    }
    await waitPrompt(">>>", 30000);
  }

  /** 빈 Enter로 프롬프트를 `>>>`로 되돌린다(꼬리가 든 `t>>>` 뒤 다음 시나리오가 깨끗하게 시작하게 한다). */
  async function resetPrompt() {
    await enter();
    await waitPrompt(">>>");
  }
  /** 입력 줄을 지우고(Ctrl+U) 프롬프트만 남긴다. */
  async function killLine() {
    await press("Control+u");
  }
  /**
   * stdin 읽기가 시작되기 전에 친 키는 벤더 readline이 버리지 않고 쌓았다가 읽기가 시작될 때 재생한다(RD-019 type-ahead,
   * TRP-005). 프롬프트 글자(`x: `)는 `write` 알림으로 읽기 시작보다 먼저 화면에 나오고 프롬프트 없는 `input()`은 화면
   * 신호가 없어, 화면만으로는 읽기가 시작됐는지 알 수 없다. 그래서 첫 글자를 **한 번만** 치고 그 에코(재생 시점 = 읽기 시작)가
   * 화면에 나타날 때까지 기다린다. 재시도하지 않는다: 첫 글자가 버려지지 않고 쌓이므로 다시 치면 글자가 중복된다(`x: `에
   * `abc` → `aabc`). 나머지 글자는 에코 뒤에 친다.
   */
  async function typeWhenReading(text, { timeoutMs = 15000 } = {}) {
    const before = await snapshot();
    await page.keyboard.type(text[0]);
    await waitFor(async () => (await snapshot()) !== before, "첫 글자 에코(쌓인 키가 읽기 시작에서 재생됨)", timeoutMs);
    if (text.length > 1) await type(text.slice(1));
  }
  /** 화면(행 + 커서 행)이 `quietMs` 동안 바뀌지 않을 때까지 기다린다. 긴 프롬프트의 재그리기가 끝난 뒤 행을 읽을 때 쓴다. */
  async function settled(quietMs = 200, timeoutMs = 5000) {
    let last = await snapshot();
    let since = Date.now();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(40);
      const now = await snapshot();
      if (now !== last) {
        last = now;
        since = Date.now();
      } else if (Date.now() - since >= quietMs) {
        return;
      }
    }
    throw new Error("화면이 안정되지 않았다");
  }

  /**
   * 페이지 시계(`performance.now()`) 마크: `pattern`을 포함하고 `exclude`는 포함하지 않는 행이 화면에 **처음** 나타난
   * 시각을 페이지 안 `MutationObserver`로 기록한다. Node↔페이지 CDP 왕복(폴링 1회에 수 ms~수십 ms, 감속 시 더 커진다)이
   * 측정값에 섞이지 않게 하려는 것이다(TRP-022). `armMeasurement()`/`readElapsed()`는 `>>>` 프롬프트 복귀만 감지하므로
   * 다른 문구(예: `KeyboardInterrupt` 출현)를 잴 때 이 쌍을 쓴다.
   *
   * - `exclude`: 이 문자열을 포함한 행은 대상이 아니다. 제출한 소스 줄(`>>> print('X')`)이 대상 문자열을 그대로 담아
   *   호출 즉시 참이 되는 함정(TRP-011)을 피하려고 입력 줄에만 있는 부분(예: `>>>`)을 준다.
   * - 무장 시점에 화면에 이미 있는 행도 검사한다. 이전 출력이 남아 있으면 `exclude`나 `clear()`로 거른다.
   * - 한 번에 하나만 무장한다. 다시 부르면 이전 마크와 시작 기준이 초기화된다.
   * - 시작 기준(`startedAt`)은 세 가지 중 하나다.
   *   1. 기본: 이 함수를 부른 페이지 시각.
   *   2. `startOnKey: { key, ctrlKey = false }`: 무장 뒤 **처음** 눌린 그 키의 `keydown`(캡처 단계) 페이지 시각. 예: Enter를
   *      누른 시각(`{ key: "Enter" }`)·Ctrl+C를 누른 시각(`{ key: "c", ctrlKey: true }`). 키 입력이 CDP를 거쳐 들어오는
   *      지연이 시작에 섞이지 않는다. 이 옵션을 주면 키가 눌리기 전에는 `startedAt`이 `null`이고, 키 없이 마크가
   *      찍히면 `readMark()`가 던진다.
   *   3. `markStart()`: 호출 시각으로 다시 잡는다(키가 아닌 동작 기준일 때).
   */
  async function markText(pattern, { exclude, startOnKey } = {}) {
    await page.evaluate(
      ([pat, excl, keySpec]) => {
        if (window.__markObserver) window.__markObserver.disconnect();
        if (window.__markKeyListener) window.removeEventListener("keydown", window.__markKeyListener, true);
        window.__markKeyListener = null;
        const root = document.querySelector(".xterm-rows");
        window.__mark = { markedAt: null, startedAt: keySpec ? null : performance.now() };
        if (keySpec) {
          window.__markKeyListener = (e) => {
            if (e.key !== keySpec.key || e.ctrlKey !== keySpec.ctrlKey) return;
            if (window.__mark.startedAt == null) window.__mark.startedAt = performance.now();
          };
          window.addEventListener("keydown", window.__markKeyListener, true);
        }
        const check = () => {
          if (window.__mark.markedAt != null) return;
          const hit = [...root.querySelectorAll(":scope > div")].some((el) => {
            const t = (el.textContent ?? "").replace(/\u00a0/g, " ");
            return t.includes(pat) && (excl == null || !t.includes(excl));
          });
          if (hit) window.__mark.markedAt = performance.now();
        };
        window.__markObserver = new MutationObserver(check);
        window.__markObserver.observe(root, { childList: true, subtree: true, characterData: true });
        check();
      },
      [pattern, exclude ?? null, startOnKey ? { key: startOnKey.key, ctrlKey: startOnKey.ctrlKey ?? false } : null],
    );
  }
  /**
   * `markText()`의 시작 기준을 지금(페이지 시각)으로 다시 잡는다. 반환값은 그 페이지 시각(ms). 키 입력 기준은
   * `markText`의 `startOnKey`가 더 정확하다. 이 함수는 키가 아닌 동작(예: `page.evaluate`로 발행한 이벤트) 직전에 쓴다.
   * `markText()` 뒤에 불러야 한다.
   */
  async function markStart() {
    return page.evaluate(() => {
      if (!window.__mark) throw new Error("markStart: markText()로 먼저 무장해야 한다");
      window.__mark.startedAt = performance.now();
      return window.__mark.startedAt;
    });
  }
  /**
   * 마크가 찍힐 때까지 기다려(`timeoutMs`는 정지 감지용이며 판정선이 아니다, 9.7 4항) `{ markedAt, startedAt, elapsedMs }`
   * (모두 페이지 시계 ms, `elapsedMs = markedAt - startedAt`)를 돌려준다. 시간 초과면 던진다. `startOnKey`를 줬는데
   * 키가 눌리지 않았으면 던진다. `markStart()`를 마크가 찍힌 뒤에 부르면 `elapsedMs`가 음수가 되므로 호출 순서를 지킨다.
   */
  async function readMark({ timeoutMs = 15000 } = {}) {
    await waitFor(
      async () => {
        const at = await page.evaluate(() => (window.__mark ? window.__mark.markedAt : undefined));
        if (at === undefined) throw new Error("readMark: markText()로 먼저 무장해야 한다");
        return at != null;
      },
      "markText()가 기다리는 행이 나타남",
      timeoutMs,
    );
    const m = await page.evaluate(() => ({ markedAt: window.__mark.markedAt, startedAt: window.__mark.startedAt }));
    if (m.startedAt == null) throw new Error("readMark: startOnKey로 지정한 키가 눌리지 않은 채 행이 나타났다");
    return { ...m, elapsedMs: m.markedAt - m.startedAt };
  }

  /**
   * 복합문 한 줄(`while True: pass`)을 제출해 실행을 시작한다. 3.14 REPL처럼 첫 Enter는 `... `를 내고
   * 빈 줄 Enter가 있어야 블록이 끝나 실행이 시작된다. 이 단계를 빼면 Ctrl+C가 활성 읽기(프롬프트)로 가
   * 벤더 경로에서 `... ^C`만 찍힌다.
   */
  async function startBlockLine(code) {
    await type(code);
    await enter();
    await waitPrompt("...");
    await enter();
  }
  /** Ctrl+C 한 번. 실행 중이면 `^C` 에코 + SIGINT 전송, 활성 읽기 중이면 벤더가 같은 프롬프트를 다시 그린다. */
  const ctrlC = () => page.keyboard.press("Control+c");
  /**
   * Ctrl을 누른 채 `c`를 `count`번 친다(키 반복·연타). `gapMs`가 0이면 브라우저가 낼 수 있는 최속으로,
   * `leadMs`는 첫 타와 나머지 사이의 간격이다(OS 키 반복의 첫 지연을 흉내낸다).
   */
  async function holdCtrlC(count, { gapMs = 0, leadMs = 0 } = {}) {
    await page.keyboard.down("Control");
    try {
      for (let i = 0; i < count; i += 1) {
        if (i === 1 && leadMs > 0) await page.waitForTimeout(leadMs);
        else if (i > 0 && gapMs > 0) await page.waitForTimeout(gapMs);
        await page.keyboard.down("c");
        await page.keyboard.up("c");
      }
    } finally {
      await page.keyboard.up("Control");
    }
  }
  /**
   * 마지막 텍스트 행이 프롬프트로 끝날 때까지 기다린다. 중단 직후의 프롬프트 행은 앞에 `^C`가 붙을 수 있고
   * (`^C>>> `, 연타면 여러 개) 꼬리가 남아 있을 수도 있다.
   */
  async function waitPromptTail(timeoutMs = 15000) {
    await waitFor(
      async () => {
        const all = await rows();
        let last = all.length - 1;
        while (last >= 0 && all[last] === "") last -= 1;
        return last >= 0 && all[last].endsWith(">>>") && (await cursorRow()) === last;
      },
      "프롬프트로 끝나는 마지막 행",
      timeoutMs,
    );
  }
  /**
   * stdin 읽기가 열린 것을 첫 글자 에코로 확인한 뒤 Ctrl+C를 누른다. 읽기가 열리기 전의 Ctrl+C는 쌓이지 않고
   * 쌓인 키를 비운 채 `ctrlCHandler`로 가 게이트에 막혀 버려진다(TRP-005, RD-019). 그러면 다음에 열리는 읽기가
   * 취소되지 않고, 글자를 쳐 둔 경우 그 글자도 함께 사라진다. 인자 없는 `input()`은 프롬프트 글자가 없어 화면만으로는 읽기
   * 시작을 알 수 없으므로, 글자 하나를 **한 번** 쳐서 에코를 확인한 뒤(`typeWhenReading`, 재시도 없음) Ctrl+C를 누른다.
   * `text`는 최소 한 글자이어야 한다(그 글자가 읽기 확인용이다).
   */
  async function cancelWhenReading(text) {
    if (!text) throw new Error("cancelWhenReading에는 읽기를 확인할 글자가 최소 하나 필요하다");
    await typeWhenReading(text);
    await ctrlC();
  }
  /** Ctrl+C를 `count`번 따로 누른다(누른 채 반복하는 `holdCtrlC`와 달리 매번 Control을 떼고 다시 누른다). */
  async function ctrlCBurst(count, gapMs = 0) {
    for (let i = 0; i < count; i += 1) {
      if (i > 0 && gapMs > 0) await page.waitForTimeout(gapMs);
      await ctrlC();
    }
  }
  /** 화면 전체의 `^C` 개수. 행이 감겨도 놓치지 않게 이어붙여 센다. */
  const caretCount = async () => (await rows()).join("").split("^C").length - 1;
  /** 화면의 `KeyboardInterrupt` 개수. 프롬프트 취소는 눌림을 몇 번 하든 1이어야 한다. */
  const interruptCount = async () => (await rows()).join("").split("KeyboardInterrupt").length - 1;

  /**
   * 화면의 트레이스백 머리글 수. 정상 중단은 정확히 1이어야 한다(연타가 여러 번 중단하면 늘어난다).
   * 행 단위가 아니라 이어붙인 화면에서 센다: 꼬리(`^C` 30개 = 60칸)에 머리글이 붙으면 80칸을 넘어 행이
   * 감기고(`Traceback (most rece` / `nt call last):`) 행 단위 검사는 0을 센다.
   */
  const countTracebacks = async () =>
    (await rows()).join("").split("Traceback (most recent call last):").length - 1;
  /** 화면에 핸들러 내부가 샜는지(절단 실패). 정상이면 빈 배열이다. 감긴 행을 놓치지 않게 이어붙여서도 본다. */
  const handlerLeaks = async () => {
    const all = await rows();
    const joined = all.join("");
    const leaked = /sigint_handler|<sigint-handler>/.test(joined);
    if (!leaked) return [];
    const lines = all.filter((r) => /sigint_handler|<sigint-handler>/.test(r));
    return lines.length > 0 ? lines : ["(감긴 행에 걸쳐 있음)"];
  };

  const checks = {};
  // 두 환경변수 값은 기본값(1)이어도 항상 남긴다. 값이 다른 실행의 결과를 섞어 비교하지 않으려는 것이다.
  const notes = { E2E_CPU_THROTTLE: cpuThrottle, E2E_TIME_SCALE: timeScale };
  /** 확인 하나를 실행해 통과·실패와 사유를 기록한다(하나가 실패해도 뒤 확인을 계속한다). */
  async function step(name, fn) {
    // ONLY=W4,T1 처럼 이름이 그 접두어로 시작하는 확인만 실행한다(양성 대조에서 확인을 분리해 볼 때 쓴다). "초기"는 항상 실행한다.
    const only = (process.env.ONLY ?? "").split(",").filter(Boolean);
    if (only.length > 0 && !name.startsWith("초기") && !only.some((prefix) => name.startsWith(prefix))) return;
    try {
      await fn();
      checks[name] = true;
      console.log(`PASS  ${name}`);
    } catch (e) {
      checks[name] = false;
      notes[name] = String(e.message ?? e);
      console.log(`FAIL  ${name}  — ${notes[name]}`);
    }
  }
  const problemLogs = () => logs.filter((l) => l.type === "warning" || l.type === "error");
  /**
   * webloop 재보고인지. 정상 중단·`exit()`마다 asyncio Task가 `KeyboardInterrupt`·`SystemExit`을 다시 던져
   * `run_handle`에서 JS unhandled rejection이 된다(설계 2.8, `webloop-reraise` 억제가 있으면 나지 않는다).
   */
  const isWebLoopReraise = (text) =>
    /webloop\.py/.test(text) && /(KeyboardInterrupt|SystemExit)/.test(text);
  /** 재보고를 뺀 pageerror. 진단용(판정은 `pageErrors` 총계로 한다). */
  const otherPageErrors = () => pageErrors.filter((e) => !isWebLoopReraise(e));

  /**
   * 결과를 JSON으로 출력하고 브라우저를 닫는다. 종료 코드는 호출자가 정한다.
   * `ok`는 `pageErrors`(전체, 재보고 포함) 0도 요구한다. `webLoopReraises`는 진단용으로만 남긴다.
   *
   * RD-018 DELTA-01: `label`(기본 `"dev"`)은 stdout에는 찍히지 않고, 결과 파일 이름(`<호출 스크립트
   * 파일명>-<label>.json`, `resultFileName` 참고)에만 쓰인다. stdout JSON 자체는 이전과 같은 모양이고
   * (기존 호출자가 `label` 없이 부르면 파일은 `dev`로 저장돼 호환된다), 파일 내용은 그 stdout JSON과
   * 동일하다(`checks` 전체 맵도 함께 담아 실행기(`run.mjs`)가 ID 단위로 대조할 수 있게 한다).
   */
  async function finish({ label = "dev", ...extra } = {}) {
    const finalRows = (await rows()).filter((r) => r !== "");
    await browser.close();
    const ok = Object.values(checks).every(Boolean) && pageErrors.length === 0;
    const result = {
      url,
      ok,
      passed: Object.values(checks).filter(Boolean).length,
      total: Object.keys(checks).length,
      failed: Object.entries(checks)
        .filter(([, v]) => !v)
        .map(([k]) => k),
      notes,
      finalRows: finalRows.slice(-8),
      problemLogs: problemLogs(),
      webLoopReraises: pageErrors.length - otherPageErrors().length,
      pageErrors,
      checks,
      ...extra,
    };
    const json = JSON.stringify(result, null, 2);
    console.log(json);
    const resultsDir = process.env.E2E_RESULTS_DIR ?? path.join(e2eDir, "results");
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(path.join(resultsDir, resultFileName(label)), json);
    return ok;
  }

  return {
    browser,
    page,
    logs,
    pageErrors,
    workers,
    rows,
    rowClasses,
    spansOf,
    cursorRow,
    trimmedRows,
    nonEmpty,
    lastLine,
    tail,
    waitFor,
    waitPrompt,
    waitLastEndsWith,
    statusText,
    waitStatus,
    setTopLevelAwait,
    waitPromptTail,
    startBlockLine,
    ctrlC,
    holdCtrlC,
    cancelWhenReading,
    ctrlCBurst,
    caretCount,
    interruptCount,
    countTracebacks,
    handlerLeaks,
    focus,
    type,
    press,
    paste,
    enter,
    submit,
    clear,
    resetPrompt,
    killLine,
    typeWhenReading,
    settled,
    snapshot,
    step,
    checks,
    notes,
    problemLogs,
    isWebLoopReraise,
    otherPageErrors,
    armMeasurement,
    readElapsed,
    markText,
    markStart,
    readMark,
    timeScale,
    finish,
  };
}

// RD-017: 선택 복사 도우미. `open()`이 반환하는 핸들의 클로저가 아니라 `page`를 인자로 받는 독립 함수다
// (계획서 DELTA-04 "가정" — `open` 자체와 같은 형태). 좌표는 실제 마우스 이벤트로 드래그를 만들기 위해
// `.xterm-rows > div`의 `getBoundingClientRect()`를 쓴다(데모에 `window.__term`이 없다).

/**
 * `endOutside`용 x좌표: `.xterm` 요소 오른쪽 바깥, 뷰포트 안쪽 중간. `.xterm-screen`보다 오른쪽이라 터미널
 * 요소 밖에서 mouseup이 일어나 document 리스너 경로를 탄다(실측, DELTA-04 2차 정정). 같은 행 y를 유지해야
 * 한다 — 터미널 위쪽(y가 작은 곳)으로 떼면 xterm이 선택 방향을 뒤집어 드래그한 텍스트 자체가 선택에서
 * 빠지고 스크롤 위치에 따라 클립보드가 달라진다.
 *
 * 주의(DELTA-04 2차 정정 — "선택 범위를 안 건드린다"는 최초 서술은 틀렸다): 이 x좌표로 마우스를 이동하면
 * xterm은 **열 좌표를 그 행 끝으로 clamp**한다. 즉 `toCol`은 무시되고 "`fromCol`부터 그 행 끝까지"가
 * 선택된다(실측 반례: `hello world` 행에서 `selectRows(r,0,r,5)`가 `endOutside:false`면 `"hello"`,
 * `endOutside:true`면 `"hello world"`). `toCol`이 그 행의 마지막 글자가 아닌 한 이 옵션으로 정확한 부분
 * 문자열을 검증할 수 없다 — "행 전체" 또는 "그 행 끝까지"를 확인하고 싶을 때만 `endOutside: true`를 써라.
 *
 * 전제: 뷰포트 폭이 `.xterm-screen`의 오른쪽 경계(80열 고정, body 기본 여백 8px 기준 대략 735px)보다
 * 충분히 넓어야 한다. 좁으면 mouseup이 `.xterm` 요소 **안**(`.xterm-screen` 위)에서 일어나 버려 document
 * 리스너 경로가 검증되지 않는다(조용한 거짓 양성 — clamp 때문에 클립보드 값 자체는 우연히 맞을 수 있다).
 * `selectRows`는 이 경우를 `elementFromPoint`로 확인해 에러를 던진다. 기본 뷰포트(1280×720)에서는 안전하다.
 */
async function xtermOutsideRightX(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".xterm");
    if (!el) throw new Error(".xterm 요소가 없다");
    const rect = el.getBoundingClientRect();
    return rect.right + (window.innerWidth - rect.right) / 2;
  });
}

/** `.xterm-rows > div`의 `row`번째 행에서 `col`번째 칸 중심 좌표(px). 셀 폭 = 행 폭 / 80(xterm 기본 cols, `ReplView` 참고). */
async function cellCenter(page, row, col) {
  const box = await page.evaluate((r) => {
    const el = document.querySelectorAll(".xterm-rows > div")[r];
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
  }, row);
  if (box === null) throw new Error(`행 ${row}이 없다(.xterm-rows > div)`);
  const cellWidth = box.width / 80;
  return { x: box.left + cellWidth * col + cellWidth / 2, y: box.top + box.height / 2 };
}

/**
 * `fromRow`행 `fromCol`열에서 `toRow`행 `toCol`열까지 마우스로 드래그해 선택을 만든다(`mouse.move → down →
 * move(steps: 5) → up`). `endOutside`가 참이면 같은 행의 y를 유지한 채 `.xterm` 요소 오른쪽 바깥(뷰포트
 * 안)에서 뗀다 — xterm의 드래그 종료 리스너는 `document`에 걸려 있어 터미널 밖에서 떼도 선택이 확정된다
 * (S11). 단, 이 좌표에서는 xterm이 열 좌표를 그 행 끝으로 **clamp**한다 — `toCol`은 무시되고 `fromCol`부터
 * 그 행 끝까지가 선택된다(`xtermOutsideRightX` 참고, DELTA-04 2차 정정). "행 전체/행 끝까지"를 확인하고
 * 싶을 때만 `endOutside: true`를 써라. 뷰포트가 좁아 mouseup이 실제로 `.xterm` 안에서 일어나면(전제:
 * `xtermOutsideRightX` 참고) 조용히 넘어가지 않고 에러를 던진다.
 */
export async function selectRows(page, fromRow, fromCol, toRow, toCol, { endOutside = false } = {}) {
  const from = await cellCenter(page, fromRow, fromCol);
  const to = await cellCenter(page, toRow, toCol);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  if (endOutside) {
    const outsideX = await xtermOutsideRightX(page);
    await page.mouse.move(outsideX, to.y, { steps: 2 });
    const stillInsideXterm = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el != null && el.closest(".xterm") != null;
      },
      [outsideX, to.y],
    );
    if (stillInsideXterm) {
      await page.mouse.up();
      throw new Error(
        "selectRows: endOutside 좌표가 .xterm 안쪽입니다(뷰포트가 좁아 .xterm-screen이 오른쪽 여백을 다 채웠습니다). " +
          "뷰포트를 넓히세요(기본 1280x720이면 안전).",
      );
    }
  }
  await page.mouse.up();
}

/** `row`행 `col`열 칸을 더블클릭한다(xterm의 단어 선택, S06). */
export async function dblclickCell(page, row, col) {
  const { x, y } = await cellCenter(page, row, col);
  await page.mouse.dblclick(x, y);
}

/** 클립보드 텍스트를 읽는다(`open()`이 이미 `clipboard-read` 권한을 받아 둔다). */
export const readClipboard = (page) => page.evaluate(() => navigator.clipboard.readText());

/** 시험 전 클립보드에 사전 값을 넣는다(복사가 안 일어났음을 대조하는 시나리오용, 예: S07). */
export const seedClipboard = (page, text) =>
  page.evaluate((t) => navigator.clipboard.writeText(t), text);

/**
 * "선택 시 자동 복사" 체크박스(`data-testid=copy-on-select`)를 `on`에 맞춘다. `setTopLevelAwait`와 달리
 * 이 체크박스는 세션을 리셋하지 않으므로 상태 전환을 기다릴 필요가 없다 — 이미 같으면 무동작, 다르면
 * 클릭만 한다. 클릭이 xterm의 숨은 textarea에서 포커스를 가져가므로 끝에 되돌린다.
 */
export async function setCopyOnSelect(page, on) {
  const checkbox = page.locator('[data-testid="copy-on-select"]');
  const checked = await checkbox.isChecked();
  if (checked !== on) await checkbox.click();
  await page.evaluate(() => document.querySelector(".xterm-helper-textarea")?.focus());
}

/**
 * 토스트(`data-testid=copy-toast`) 텍스트. 떠 있지 않으면 `null`. Locator로 존재 확인(`count()`)과 텍스트
 * 읽기(`textContent()`)를 나눠 부르면(DELTA-04 3차 정정 전 구현) 그 사이에 토스트가 1초 자동 소멸 타이머로
 * 사라져 `textContent()`가 요소를 못 찾고 기본 타임아웃까지 기다리다 던지는 경쟁 조건이 있었다(재현: 6회
 * 반복 중 1회, locator timeout 30000ms). `page.evaluate`로 존재 확인과 텍스트 읽기를 같은 DOM 스냅샷 안에서
 * 동기로 끝내 경쟁 조건을 없앤다.
 */
export async function toastText(page) {
  return page.evaluate(() => document.querySelector('[data-testid="copy-toast"]')?.textContent ?? null);
}

// RD-022b DELTA-04: main 쪽 RPC 알림 관찰·주입. 화면에 신호가 없는 제품 이벤트(배경 `input()`의 `readInput` 알림이 main에
// 도착해 처리됨)를 조건 대기로 기다리고(9.7 "판정은 이벤트·상태로"), worker가 낼 수 없는 시점의 출력(`input()` 대기 중 worker는
// 메일박스 `Atomics.wait`에 멈춰 있다)을 main 경로 그대로 흉내 낸다. 알림 모양은 `packages/pyodide-core/src/protocol/rpc.ts`
// (`{ kind: "ntf", name, args }`)와 `CORE_MAIN_HANDLER_NAMES`(`write`·`readInput` 등)를 따른다.

/**
 * `open(url, { before: installRpcTap })`로 부른다(문서 스크립트보다 먼저 실행돼야 한다). `MessagePort.prototype.onmessage`
 * 설정자를 감싸 모든 포트 핸들러가 **처리를 마친 뒤**(동기 부분) RPC 알림 이름을 `window.__rpcTap.notices`에 쌓고, 마지막으로
 * 알림을 받은 포트를 `window.__rpcTap.port`에 둔다. RPC가 아닌 메시지(React 스케줄러의 `MessageChannel` 등)는 건드리지 않는다.
 */
export async function installRpcTap(page) {
  await page.addInitScript(() => {
    const desc = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage");
    window.__rpcTap = { notices: [], port: null };
    Object.defineProperty(MessagePort.prototype, "onmessage", {
      configurable: true,
      enumerable: desc.enumerable,
      get() {
        return desc.get.call(this);
      },
      set(fn) {
        if (typeof fn !== "function") {
          desc.set.call(this, fn);
          return;
        }
        const port = this;
        desc.set.call(this, function tapped(event) {
          try {
            return fn.call(this, event);
          } finally {
            const d = event.data;
            if (d !== null && typeof d === "object" && d.kind === "ntf" && typeof d.name === "string") {
              window.__rpcTap.notices.push(d.name);
              window.__rpcTap.port = port;
            }
          }
        });
      },
    });
  });
}

/** `installRpcTap` 뒤: main이 처리한 RPC 알림 중 이름이 `name`인 것의 개수. */
export const rpcNoticeCount = (page, name) =>
  page.evaluate((n) => (window.__rpcTap?.notices ?? []).filter((x) => x === n).length, name);

/**
 * `installRpcTap` 뒤: 마지막으로 RPC 알림을 받은 포트에 worker → main 알림 하나를 합성해 보낸다(`dispatchEvent`, 실제 알림과 같은
 * `onmessage` 핸들러를 지난다). 알림을 받은 포트가 아직 없으면 던진다.
 */
export async function injectRpcNotice(page, name, ...args) {
  await page.evaluate(
    ([n, a]) => {
      const port = window.__rpcTap?.port;
      if (!port) throw new Error("RPC 알림을 받은 포트가 없다(installRpcTap·세션 부팅 확인)");
      port.dispatchEvent(new MessageEvent("message", { data: { kind: "ntf", name: n, args: a } }));
    },
    [name, args],
  );
}

export const hasFg = (classes, n) => classes.includes(`xterm-fg-${n}`);
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const show = (v) => JSON.stringify(v);
