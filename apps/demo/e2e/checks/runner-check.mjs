// RD-022 DELTA-07 브라우저 확인: 실행창 데모(`?view=runner`, `createTerminalRunner`). 실제 xterm 6 + 실제 브라우저 + 실제 CDN pyodide.
// 코드를 `textarea`에 넣고 `run` 버튼으로 실행하는 데모 화면을 plain 요소(testid `code`·`run`·`stop`·`reset`·`clear`·`status`·
// `result`·`copy-result`·`terminal`)로 조작하고 xterm 화면 행(`.xterm-rows > div`)으로 판정한다. `result`는 `run()`이 돌려준
// 결과 유니온의 JSON 텍스트이고 거부는 `{"rejected":"<reason>"}`다.
//
//   normal       : 5173 dev(또는 격리 서버) — 초기 4개 + R01~R13
//     R01 `input("이름: ")` 프롬프트 뒤 입력 → 출력, R02 `while True: pass` + Ctrl+C → 트레이스백·`interrupted`,
//     R03 같은 코드 + `stop` → `interrupted`, R04 KeyboardInterrupt를 삼키는 루프 + `stop` → `restarted`·상태 `restarting` → `ready`,
//     R05 실행 중 `run` 두 번째 → `busy`, R06 실행 중 친 글자·붙여넣기가 화면에도 다음 `input()`에도 없음, R07 `ready`의 Ctrl+C 무동작,
//     R08 출력 드래그 → 클립보드, R09 `sys.exit(3)` → `exit{ code: 3 }`, R10 `1/0` 트레이스백에 `main.py` 프레임과 소스 줄,
//     R11 두 번째 run에서 이전 변수 `NameError`·`__main__`·`__file__`, R12 미종결 줄 뒤 run → 새 줄에서 시작, R13 콘솔 경고·오류 없음
//   not-isolated : 4174 헤더 없는 정적 서버 — 경고 문구·상태 `not-isolated`·`run` → `unavailable`·worker 없음
//
// 사용: node runner-check.mjs <normal|not-isolated> [url](생략 시 http://localhost:5173)
//   url은 서버 루트다(스크립트가 `/?view=runner`를 붙인다). ONLY=R01,R05 처럼 이름 접두어로 셀을 거른다("초기"는 항상 실행).
//   결과 파일 label은 `<모드>-<서버>`(서버는 url 포트 4173이면 preview, 그 밖은 dev, repl-check와 같은 규칙):
//   `runner-check-normal-dev.json`·`runner-check-not-isolated-dev.json`.
//
// 시간 판정(`docs/design/09-testing.md` 9.7): 고정 대기·ms 상한을 쓰지 않는다. 실행이 "진행 중"임은 출력 행 마커(`go`)로 확인하고, 결말은
// `result`·`status`·화면 행이 조건을 만족할 때까지 `waitFor`로 기다린다. "친 키가 없다"(R06)·"Ctrl+C가 무동작이다"(R07)는 뒤따르는
// 마커(`^C`·`mark` 출력)나 다음 실행의 결과로 확인한다. 실행 중 Ctrl+C/`stop` → 중단은 "응답성" 요구지만 이 스크립트는 ms 상한을 두지
// 않는다(정지 감지용 timeout만). 코드 텍스트는 xterm 화면에 나오지 않으므로(에코 없음) 마커 행은 출력 행만이다(TRP-011 해당 없음).
import { checkEntry, exitWith, serverLabel } from "../check-runner.mjs";
import { hasFg, open, readClipboard, same, seedClipboard, selectRows, show } from "../lib.mjs";

const { mode, url: urlArg } = checkEntry({ modes: ["normal", "not-isolated"] });
const label = serverLabel(urlArg, mode);
const url = new URL("/?view=runner", urlArg).href;

const NOT_ISOLATED_WARNING =
  "경고: cross-origin isolation이 꺼져 있어 Python 세션을 시작하지 않습니다. 서버가 COOP/COEP 헤더를 보내야 합니다.";
/** worker 부팅(pyodide 로드)·재시작 대기용 정지 감지 timeout(판정선이 아니다). */
const BOOT_TIMEOUT_MS = 90000;

const h = await open(url);
const { page, step, waitFor, waitStatus, statusText, rows, rowClasses, trimmedRows, tail, cursorRow, focus, type, enter, ctrlC } = h;

const resultText = () => page.locator('[data-testid="result"]').textContent();
const copyResultText = () => page.locator('[data-testid="copy-result"]').textContent();
/** `result`가 비어 있지 않을 때까지 기다려 JSON으로 파싱해 돌려준다(새 실행을 시작하면 앱이 이전 결과를 지운다). */
async function waitResult(description, timeoutMs = 30000) {
  await waitFor(async () => (await resultText()) !== "", `result: ${description}`, timeoutMs);
  return JSON.parse(await resultText());
}
/** 코드를 `textarea`에 넣고 `run` 버튼을 누른다(앱이 터미널에 포커스를 준다). */
async function startRun(code) {
  await page.fill('[data-testid="code"]', code);
  await page.click('[data-testid="run"]');
}
/** `clear` 버튼을 누르고 화면이 비워질 때까지 기다린다(입력 읽기가 열려 있으면 무동작이므로 `ready`에서만 부른다). */
async function clearScreen() {
  await page.click('[data-testid="clear"]');
  await waitFor(async () => (await trimmedRows()).length === 0, "clear 뒤 빈 화면", 5000);
}
/** 화면에 출력 행(`text` 전체가 한 행)이 나타날 때까지 기다린다. */
const waitRow = (text, timeoutMs = 30000) =>
  waitFor(async () => (await rows()).some((r) => r === text), `출력 행 ${show(text)}`, timeoutMs);
/**
 * 셀 시작 상태를 만든다: 이전 셀이 실행 중이거나 입력 대기로 남았으면 `stop`으로 끝내고, 끝 상태(`crashed`·`load-failed`)면 `reset`으로 복구해
 * `ready`가 된 뒤 화면을 지운다. 앞 셀의 실패가 뒤 셀로 번지지 않게 한다.
 */
async function freshCell() {
  const current = await statusText();
  if (current === "running" || current === "waiting-input") await page.click('[data-testid="stop"]');
  else if (current === "crashed" || current === "load-failed") await page.click('[data-testid="reset"]');
  await waitStatus(["ready"], "셀 시작: status = ready", BOOT_TIMEOUT_MS);
  await clearScreen();
}
/** 페이지 안 status 표시가 바뀐 이력. `installStatusLog()`가 MutationObserver로 기록한다(순간 상태 `restarting`을 폴링으로 놓치지 않게). */
async function installStatusLog() {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="status"]');
    window.__statusLog = [el.textContent];
    new MutationObserver(() => {
      const t = el.textContent;
      if (window.__statusLog.at(-1) !== t) window.__statusLog.push(t);
    }).observe(el, { childList: true, characterData: true, subtree: true });
  });
}
const statusLogLength = () => page.evaluate(() => window.__statusLog.length);
const statusLogSince = (index) => page.evaluate((i) => window.__statusLog.slice(i), index);
/** 실행 중(읽기 없음)에 붙여넣기: `paste()` 헬퍼는 화면 변화를 기다리다 던지므로 합성 이벤트를 직접 보낸다(type-ahead-check와 같은 방식). */
const pasteSilently = async (text) => {
  await focus();
  await page.evaluate((t) => {
    const ta = document.querySelector(".xterm-helper-textarea");
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
};

const SPIN = 'print("go")\nwhile True: pass';

if (mode === "normal") {
  await installStatusLog();

  await step("초기 페이지가 cross-origin isolated다", async () => {
    const text = await page.locator('[data-testid="cross-origin-isolated"]').textContent();
    if (text !== "true") throw new Error(`cross-origin-isolated = ${text}`);
  });

  await step("초기 상태가 ready가 되고 화면이 비어 있다(배너·프롬프트 없음)", async () => {
    await waitStatus(["ready"], "status = ready", BOOT_TIMEOUT_MS);
    const t = await trimmedRows();
    if (t.length !== 0) throw new Error(`행 = ${show(t)}`);
  });

  await step("초기 터미널이 하나, worker가 하나만 살아 있다(StrictMode 잔재 없음)", async () => {
    const count = await page.locator(".xterm").count();
    if (count !== 1) throw new Error(`.xterm 요소 ${count}개`);
    await waitFor(() => page.workers().length === 1, "workers().length === 1", 5000);
  });

  await step("R01 `input(\"이름: \")` → 프롬프트 뒤에 입력하면 출력에 반영된다", async () => {
    await freshCell();
    await startRun('name = input("이름: ")\nprint("안녕 " + name)');
    await waitStatus(["waiting-input"], "입력 대기 상태");
    // 프롬프트 행이 화면에 보인 뒤에 친다(읽기가 열린 뒤다, pending-traps/12 — 열리기 전 키는 버려지고 echo가 없으면 type이 던진다).
    await h.waitPrompt("이름:", 15000);
    await focus();
    await type("kim");
    await enter();
    const r = await waitResult("ok");
    if (r.kind !== "ok") throw new Error(`결과 = ${show(r)}`);
    await waitStatus(["ready"], "입력 뒤 ready");
    const t = await trimmedRows();
    if (!same(t, ["이름: kim", "안녕 kim"])) throw new Error(`행 = ${show(t)}`);
  });

  await step("R02 `while True: pass` + Ctrl+C → ^C·KeyboardInterrupt 트레이스백, 결과 interrupted", async () => {
    await freshCell();
    await startRun(SPIN);
    await waitRow("go");
    await waitStatus(["running"], "실행 중 상태");
    await focus();
    await ctrlC();
    const r = await waitResult("interrupted", BOOT_TIMEOUT_MS);
    if (r.kind !== "interrupted") throw new Error(`결과 = ${show(r)}`);
    if (!r.traceback.includes('File "main.py", line 2, in <module>') || !r.traceback.endsWith("KeyboardInterrupt\n")) {
      throw new Error(`traceback = ${show(r.traceback)}`);
    }
    await waitStatus(["ready"], "중단 뒤 ready");
    const all = await rows();
    // tty 로컬 에코 `^C`가 꼬리에 남고 트레이스백이 같은 행에서 이어진다(CPython 스크립트 실행과 같다).
    if (all[0] !== "go" || all[1] !== "^CTraceback (most recent call last):") {
      throw new Error(`행 = ${show(await trimmedRows())}`);
    }
    const last = (await tail(1))[0];
    if (last !== "KeyboardInterrupt") throw new Error(`마지막 행 = ${show(last)}`);
    const counts = { caret: await h.caretCount(), traceback: await h.countTracebacks(), interrupt: await h.interruptCount() };
    if (counts.caret !== 1 || counts.traceback !== 1 || counts.interrupt !== 1) throw new Error(`개수 = ${show(counts)}`);
  });

  await step("R03 `while True: pass` + stop 버튼 → KeyboardInterrupt, 결과 interrupted(^C 없음)", async () => {
    await freshCell();
    await startRun(SPIN);
    await waitRow("go");
    await waitStatus(["running"], "실행 중 상태");
    await page.click('[data-testid="stop"]');
    const r = await waitResult("interrupted", BOOT_TIMEOUT_MS);
    if (r.kind !== "interrupted") throw new Error(`결과 = ${show(r)}`);
    await waitStatus(["ready"], "stop 뒤 ready");
    const counts = { caret: await h.caretCount(), traceback: await h.countTracebacks(), interrupt: await h.interruptCount() };
    if (counts.caret !== 0 || counts.traceback !== 1 || counts.interrupt !== 1) throw new Error(`개수 = ${show(counts)}`);
    if ((await tail(1))[0] !== "KeyboardInterrupt") throw new Error(`행 = ${show(await trimmedRows())}`);
  });

  await step("R04 KeyboardInterrupt를 삼키는 루프 + stop → restarted, 상태 restarting → ready, 이어서 새 run이 실행된다", async () => {
    await freshCell();
    await startRun('print("go")\nwhile True:\n    try:\n        while True: pass\n    except KeyboardInterrupt:\n        pass');
    await waitRow("go");
    await waitStatus(["running"], "실행 중 상태");
    const index = await statusLogLength();
    await page.click('[data-testid="stop"]');
    const r = await waitResult("restarted", BOOT_TIMEOUT_MS);
    if (r.kind !== "restarted") throw new Error(`결과 = ${show(r)}`);
    await waitStatus(["ready"], "재시작 뒤 ready", BOOT_TIMEOUT_MS);
    const seen = await statusLogSince(index);
    const restarting = seen.indexOf("restarting");
    if (restarting < 0 || seen.lastIndexOf("ready") < restarting) throw new Error(`status 이력 = ${show(seen)}`);
    // 재시작한 worker가 새 run을 실행한다(이전 worker의 상태는 없다).
    await startRun('print("after")');
    const after = await waitResult("ok");
    if (after.kind !== "ok") throw new Error(`재시작 뒤 결과 = ${show(after)}`);
    const t = await trimmedRows();
    if (!same(t, ["go", "after"])) throw new Error(`행 = ${show(t)}`);
  });

  await step("R05 실행 중 run을 한 번 더 누르면 busy로 거부되고 화면은 그대로다", async () => {
    await freshCell();
    await startRun(SPIN);
    await waitRow("go");
    await waitStatus(["running"], "실행 중 상태");
    await page.click('[data-testid="run"]');
    const r = await waitResult("busy");
    if (r.rejected !== "busy") throw new Error(`결과 = ${show(r)}`);
    const t = await trimmedRows();
    if (!same(t, ["go"])) throw new Error(`거부된 run이 화면을 바꿨다: ${show(t)}`);
    // 첫 run은 계속 실행 중이다. stop으로 끝낸다.
    if ((await statusText()) !== "running") throw new Error(`status = ${await statusText()}`);
    await page.click('[data-testid="stop"]');
    // `result`에는 거부(busy)가 남아 있으므로 첫 run의 결말(kind가 있는 결과)로 바뀔 때까지 기다린다.
    await waitFor(async () => "kind" in JSON.parse((await resultText()) || "{}"), "첫 run의 결말", BOOT_TIMEOUT_MS);
    const end = JSON.parse(await resultText());
    if (end.kind !== "interrupted") throw new Error(`첫 run 결과 = ${show(end)}`);
  });

  await step("R06 실행 중 친 글자·붙여넣기는 화면에도 다음 input()에도 없다", async () => {
    await freshCell();
    await startRun(SPIN);
    await waitRow("go");
    await waitStatus(["running"], "실행 중 상태");
    await focus();
    await page.keyboard.type("abc");
    await pasteSilently("xyz");
    // Ctrl+C가 마커다: 같은 입력 경로에서 앞선 키 뒤에 처리되므로 `^C` 행이 보이면 abc·xyz는 이미 처리됐다.
    await ctrlC();
    const r = await waitResult("interrupted", BOOT_TIMEOUT_MS);
    if (r.kind !== "interrupted") throw new Error(`결과 = ${show(r)}`);
    await waitStatus(["ready"], "중단 뒤 ready");
    const joined = (await rows()).join("\n");
    if (!joined.includes("^C")) throw new Error(`마커 ^C가 없다: ${show(await trimmedRows())}`);
    for (const typed of ["abc", "xyz"]) {
      if (joined.includes(typed)) throw new Error(`실행 중 친 ${typed}가 화면에 있다: ${show(await trimmedRows())}`);
    }
    // 쌓였다가 다음 읽기에서 재생되지 않는다(REPL type-ahead와 다른 실행창 사양).
    await freshCell();
    await startRun('v = input("q: ")\nprint(repr(v))');
    await h.waitPrompt("q:", 15000);
    await focus();
    await type("ok");
    await enter();
    const r2 = await waitResult("ok");
    if (r2.kind !== "ok") throw new Error(`두 번째 결과 = ${show(r2)}`);
    // 결과(React 상태)가 화면 행(xterm DOM 렌더러의 rAF 갱신)보다 먼저 보일 수 있다: 마지막 출력 행을 조건 대기한 뒤 전체 행을 대조한다.
    await waitRow("'ok'");
    const t = await trimmedRows();
    if (!same(t, ["q: ok", "'ok'"])) throw new Error(`행 = ${show(t)}`);
  });

  await step("R07 ready에서 Ctrl+C는 아무 일도 하지 않는다(^C 없음, 다음 run은 정상)", async () => {
    await freshCell();
    await focus();
    await ctrlC();
    // 뒤따르는 run이 마커다: 이 줄이 화면에 나온 뒤에도 행이 `mark` 하나뿐이면 앞선 Ctrl+C는 화면에도 실행에도 영향이 없다.
    await startRun('print("mark")');
    const r = await waitResult("ok");
    if (r.kind !== "ok") throw new Error(`결과 = ${show(r)}`);
    const t = await trimmedRows();
    if (!same(t, ["mark"])) throw new Error(`행 = ${show(t)}`);
  });

  await step("R08 출력 행 드래그 선택 → 클립보드에 복사된다", async () => {
    await freshCell();
    await startRun('print("hello world")');
    const r = await waitResult("ok");
    if (r.kind !== "ok") throw new Error(`결과 = ${show(r)}`);
    await waitRow("hello world");
    await seedClipboard(page, "seed");
    await selectRows(page, 0, 0, 0, 5);
    const text = await waitFor(
      async () => {
        const t = await readClipboard(page);
        return t === "hello" ? t : null;
      },
      "클립보드가 hello",
      5000,
    );
    if (text !== "hello") throw new Error(`클립보드 = ${show(text)}`);
    const copied = await copyResultText();
    if (copied !== "copied 5 chars") throw new Error(`copy-result = ${show(copied)}`);
  });

  await step("R09 sys.exit(3) → 결과 exit{ code: 3 }, 상태 ready, 화면 출력 없음", async () => {
    await freshCell();
    await startRun("import sys\nsys.exit(3)");
    const r = await waitResult("exit");
    if (!same(r, { kind: "exit", code: 3 })) throw new Error(`결과 = ${show(r)}`);
    await waitStatus(["ready"], "exit 뒤 ready");
    const t = await trimmedRows();
    if (t.length !== 0) throw new Error(`행 = ${show(t)}`);
  });

  await step("R10 1/0 트레이스백에 main.py 프레임·소스 줄이 있고 내부 프레임이 없다(빨강)", async () => {
    await freshCell();
    await startRun("def f():\n    return 1 / 0\nf()");
    const r = await waitResult("error");
    if (r.kind !== "error" || r.errorType !== "ZeroDivisionError") throw new Error(`결과 = ${show(r)}`);
    await waitStatus(["ready"], "오류 뒤 ready");
    const all = await rows();
    for (const line of [
      "Traceback (most recent call last):",
      '  File "main.py", line 3, in <module>',
      "    f()",
      '  File "main.py", line 2, in f',
      "    return 1 / 0",
      "ZeroDivisionError: division by zero",
    ]) {
      if (!all.includes(line)) throw new Error(`행 ${show(line)} 없음: ${show(await trimmedRows())}`);
    }
    const frames = all.filter((row) => row.startsWith('  File "'));
    const foreign = frames.filter((row) => !row.includes('"main.py"'));
    if (foreign.length > 0) throw new Error(`main.py 밖 프레임 노출: ${show(foreign)}`);
    const classes = await rowClasses();
    const errorRow = all.indexOf("ZeroDivisionError: division by zero");
    if (!hasFg(classes[errorRow] ?? [], 1)) throw new Error(`오류 행 클래스 = ${show(classes[errorRow])}(빨강 아님)`);
  });

  await step("R11 두 번째 run에서 이전 변수는 NameError, __name__·__file__은 실행창 값이다", async () => {
    await freshCell();
    await startRun("x = 42\nprint(__name__, __file__)");
    const first = await waitResult("첫 run");
    if (first.kind !== "ok") throw new Error(`첫 결과 = ${show(first)}`);
    await waitRow("__main__ main.py");
    await freshCell();
    await startRun("print(x)");
    const second = await waitResult("두 번째 run");
    if (second.kind !== "error" || second.errorType !== "NameError") throw new Error(`두 번째 결과 = ${show(second)}`);
    await waitStatus(["ready"], "오류 뒤 ready");
    if ((await tail(1))[0] !== "NameError: name 'x' is not defined") throw new Error(`행 = ${show(await trimmedRows())}`);
  });

  await step("R12 개행 없이 끝난 출력 뒤 run → 새 줄에서 시작한다", async () => {
    await freshCell();
    await startRun('print("a", end="")');
    const first = await waitResult("첫 run");
    if (first.kind !== "ok") throw new Error(`첫 결과 = ${show(first)}`);
    await waitRow("a");
    await waitStatus(["ready"], "첫 run 뒤 ready");
    await startRun('print("b")');
    const second = await waitResult("두 번째 run");
    if (second.kind !== "ok") throw new Error(`두 번째 결과 = ${show(second)}`);
    await waitStatus(["ready"], "두 번째 run 뒤 ready");
    const t = await trimmedRows();
    if (!same(t, ["a", "b"])) throw new Error(`행 = ${show(t)}`);
    // 개행 수는 커서 행 번호로도 단언한다(TRP-006): "a" 행 0, "b" 행 1, 커서는 다음 행(2).
    const cur = await cursorRow();
    if (cur !== 2) throw new Error(`커서 행 = ${cur}(기대 2)`);
  });

  await step("R13 콘솔 경고·오류·pageerror가 없다", async () => {
    if (h.problemLogs().length > 0 || h.pageErrors.length > 0) {
      throw new Error(JSON.stringify({ problemLogs: h.problemLogs(), pageErrors: h.pageErrors }));
    }
  });
}

if (mode === "not-isolated") {
  await step("N01 페이지가 cross-origin isolated가 아니다", async () => {
    const text = await page.locator('[data-testid="cross-origin-isolated"]').textContent();
    if (text !== "false") throw new Error(`cross-origin-isolated = ${text}`);
  });

  await step("N02 상태 표시가 not-isolated다", async () => {
    await waitStatus(["not-isolated"], "status = not-isolated", 10000);
  });

  await step("N03 첫 행부터 노란 경고 한 줄이 찍힌다(80열에서 감김)", async () => {
    const all = await rows();
    const end = all.findIndex((r) => r === "");
    const warningRows = all.slice(0, end < 0 ? all.length : end);
    // 한글은 2열이라 여러 행으로 감기고 감기는 위치의 공백이 사라질 수 있어 공백을 뺀 문자열로 비교한다.
    const joined = warningRows.join("").replace(/\s/g, "");
    if (joined !== NOT_ISOLATED_WARNING.replace(/\s/g, "")) throw new Error(`경고 행 = ${show(warningRows)}`);
    const classes = await rowClasses();
    const notYellow = warningRows.map((_, i) => i).filter((i) => !hasFg(classes[i] ?? [], 3));
    if (notYellow.length > 0) throw new Error(`xterm-fg-3 없는 행 = ${show(notYellow)}`);
    h.notes["경고 행 수(참고)"] = warningRows.length;
  });

  await step("N04 run → 결과 rejected unavailable, 화면·상태는 그대로다", async () => {
    const before = await trimmedRows();
    await page.fill('[data-testid="code"]', 'print("never")');
    await page.click('[data-testid="run"]');
    const r = await waitResult("unavailable", 10000);
    if (r.rejected !== "unavailable") throw new Error(`결과 = ${show(r)}`);
    const t = await trimmedRows();
    if (!same(t, before)) throw new Error(`거부된 run이 화면을 바꿨다: ${show(t)}(전 ${show(before)})`);
    if ((await statusText()) !== "not-isolated") throw new Error(`status = ${await statusText()}`);
  });

  await step("N05 worker가 없고 콘솔 오류·pageerror가 없다", async () => {
    // 위 N04의 거부 응답(이벤트)이 도착한 뒤다: worker 생성 이벤트는 그보다 먼저 왔어야 한다.
    if (page.workers().length !== 0) throw new Error(`workers().length = ${page.workers().length}`);
    const errors = h.logs.filter((l) => l.type === "error");
    if (errors.length > 0 || h.pageErrors.length > 0) {
      throw new Error(JSON.stringify({ errors, pageErrors: h.pageErrors }));
    }
  });
}

const ok = await h.finish({ label, mode });
exitWith(ok);
