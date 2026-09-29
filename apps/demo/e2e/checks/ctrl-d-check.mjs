// RD-048 브라우저 확인: 빈 입력줄 Ctrl+D를 EOF로(REPL `>>>` 세션 종료, `input()`·`sys.stdin` 읽기는
// `EOFError`/루프 종료, 실행창은 `EOFError` 결과). pty 3.14.4 실측(`pty/rd-048/results.md`)의 H3 네 항목과
// 화면 기대값을 맞춘다. 트레이스백 프레임 모양(`File "<console>"` 한 줄, `_pyrepl` 내부 프레임 없음)은 기존 편차(35 계열)로
// 흡수돼 이 스크립트는 대조하지 않는다(입력-취소 확인 스크립트 `input-cancel-check.mjs`와 같은 `TRACEBACK_HEAD`·`CONSOLE_FRAME`).
//
// 셀:
//   D02 `if True:` Enter → `...`에서 빈 줄 Ctrl+D → 입력줄·프롬프트 불변(무동작), `pass` Enter Enter → 블록 생존·`>>>`
//   D03 `x = input("p: ")` → 빈 줄 Ctrl+D → `EOFError` 트레이스백(P3 대조), `>>>` 복귀, x 미정의(NameError)
//   D04 `x = input("p: ")` → `ab` 커서 끝에서 Ctrl+D → 무동작, Enter → `print(x)` → `ab`
//   D05 `for line in sys.stdin: print(line, end="")` 블록 → `a` Enter `b` Enter → 빈 줄 Ctrl+D → 루프 종료·`>>>`
//   D06 `import time; time.sleep(1)` 실행 중 Ctrl+D → `>>>` 복귀 뒤 세션 유지(`1+1` → `2`)
//   D07 실행창(`/?view=runner`): `input()` 실행 중 빈 줄 Ctrl+D → 결과·화면 모두 `EOFError`, 실행 종료
//   D01(맨 나중에 실행) 빈 `>>>`에서 Ctrl+D → 데모 종료 안내("Python session terminated.", `ReplView.tsx`) → 리셋 버튼 →
//     새 `>>>`에서 `1+1` → `2`
//
// 시간 판정(`docs/design/09-testing.md` 9.7): 고정 대기 뒤 부재 확인을 쓰지 않는다. 무동작 셀(D02·D04)은 Ctrl+D 직후
// 스냅샷을 즉시 비교하고, 뒤이어 정상 입력(`pass` 실행·`print(x)`)이 성립하는 것을 마커로 삼아 상태가 깨지지 않았음을 확인한다.
// EOF로 끝낼 빈 버퍼 읽기는 프롬프트 문자열 신호가 없거나(무인자 `input()`·`sys.stdin`) 신호가 읽기 시작보다 먼저 그려질 수 있어
// (RD-006 TRP-005), 글자 하나를 쳐 에코로 읽기 시작을 확인한 뒤(`typeWhenReading`) Backspace로 지워 실제로 열린 빈 버퍼를 만든다
// (`openEmptyRead`). REPL 자체가 그리는 `>>>`·`...` 프롬프트는 `read()` 호출과 함께 동기로 그려지므로 이 확인이 필요 없다.
//
// 사용: node ctrl-d-check.mjs <url>(생략 시 http://localhost:5173)     ONLY=D03,D07 node ctrl-d-check.mjs
// 결과 파일: `ctrl-d-check-dev.json`(REPL 셀 D01~D06)·`ctrl-d-check-runner-dev.json`(D07, 실행창).
import { checkEntry, currentOnly, exitWith, pageSelected } from "../check-runner.mjs";
import { open, same, show } from "../lib.mjs";

const { url } = checkEntry();
const only = currentOnly();

const TRACEBACK_HEAD = "Traceback (most recent call last):";
const CONSOLE_FRAME = '  File "<console>", line 1, in <module>';
/** worker 부팅 대기용 정지 감지 timeout(판정선이 아니다). */
const BOOT_TIMEOUT_MS = 90000;

const REPL_CELLS = ["D01", "D02", "D03", "D04", "D05", "D06"];

async function runRepl(baseUrl) {
  const h = await open(baseUrl);
  const {
    step,
    waitPrompt,
    waitLastEndsWith,
    waitFor,
    clear,
    type,
    enter,
    press,
    tail,
    rows,
    trimmedRows,
    cursorRow,
    focus,
    typeWhenReading,
    settled,
    snapshot,
    countTracebacks,
    startBlockLine,
    page,
  } = h;

  const pressCtrlD = () => press("Control+d");
  /**
   * stdin 읽기가 실제로 열린 빈 버퍼를 만든다: 글자 하나를 쳐 에코로 읽기 시작을 확인한 뒤(TRP-005, RD-019는 읽기 전 키를
   * 버리지 않고 쌓아 재생하지만 그 재생은 origin이 "replay"라 EOF를 내지 않는다 — 실제로 친 키(origin "live")를 확인해야 한다)
   * Backspace로 지운다.
   */
  async function openEmptyRead() {
    await typeWhenReading("z");
    await press("Backspace");
    await settled();
  }
  /** 화면을 지우고 문장을 제출해 stdin 읽기가 시작될 때까지 기다린다(`stdin-input-check.mjs`의 `startInput`과 같은 모양). */
  async function startInput(code, promptSuffix) {
    await clear();
    await type(code);
    await enter();
    if (promptSuffix) await waitLastEndsWith(promptSuffix);
    await settled(150);
  }
  /** stdin 읽기에 입력한 줄을 Enter로 끝내고 REPL 프롬프트가 돌아올 때까지 기다린다. */
  async function finishRead() {
    await enter();
    await waitPrompt(">>>");
  }
  /** `>>>`에서 문장을 실행하고 다음 프롬프트까지 기다린다. */
  async function run(code) {
    await type(code);
    await enter();
    await waitPrompt(">>>");
  }
  const screenText = async () => (await rows()).join("\n");
  /** 확인이 실패해 읽기가 열린 채 남았으면 Enter로 끝내 다음 확인이 이어지게 한다. */
  async function recover() {
    for (let i = 0; i < 8; i += 1) {
      const all = await rows();
      let last = all.length - 1;
      while (last >= 0 && all[last] === "") last -= 1;
      if (last >= 0 && all[last] === ">>>" && (await cursorRow()) === last) return;
      await press("Enter");
      await page.waitForTimeout(400);
    }
  }
  async function d(name, fn) {
    await step(name, fn);
    if (h.checks[name] === false) await recover();
  }

  const statusText = () => page.locator('[data-testid="status"]').textContent();
  const terminatedText = () => page.locator('[data-testid="terminated"]').textContent();
  const click = async (testid) => {
    await page.click(`[data-testid="${testid}"]`);
    await focus();
  };
  /** 리셋 버튼 클릭 → `loading` → `ready`/`load-failed` → 새 프롬프트까지 기다린다(`session-reset-check.mjs`와 같은 모양). */
  async function resetAndWait() {
    await click("reset");
    await waitFor(async () => (await statusText()) === "loading", "reset: loading 상태");
    await waitFor(async () => ["ready", "load-failed"].includes(await statusText()), "reset: ready/load-failed 상태", 30000);
    await waitPrompt(">>>", 30000);
  }

  await step("초기: 프롬프트가 뜬다", async () => {
    await waitPrompt(">>>", BOOT_TIMEOUT_MS);
    await focus();
  });

  await d("D02 `if True:` 블록의 `...` 빈 줄 Ctrl+D는 무동작(화면 불변), `pass` Enter Enter로 블록이 산다", async () => {
    await clear();
    await type("if True:");
    await enter();
    await waitPrompt("...");
    const before = await snapshot();
    await pressCtrlD();
    if ((await snapshot()) !== before) throw new Error(`Ctrl+D가 화면을 바꿨다 — ${show(await tail(4))}`);
    await type("pass");
    await enter();
    await waitPrompt("...");
    await enter();
    await waitPrompt(">>>");
    if ((await countTracebacks()) !== 0) throw new Error(`블록이 죽었다 — ${show(await tail(6))}`);
    const all = await rows();
    if (all[0] !== ">>> if True:" || all.filter((r) => r === ">>> if True:").length !== 1) {
      throw new Error(`첫 행 = ${show(all[0])} — ${show(await tail(6))}`);
    }
  });

  await d('D03 `x = input("p: ")` 빈 줄 Ctrl+D → EOFError 트레이스백(P3 대조), `>>>` 복귀, x 미정의', async () => {
    await startInput('x = input("p: ")', "p:");
    await openEmptyRead();
    await pressCtrlD();
    await waitPrompt(">>>");
    const t = await tail(6);
    // CPython의 input() EOF는 KeyboardInterrupt와 달리 메시지가 있다("EOF when reading a line", 실측).
    if (!same(t, ['>>> x = input("p: ")', "p:", TRACEBACK_HEAD, CONSOLE_FRAME, "EOFError: EOF when reading a line", ">>>"])) {
      throw new Error(show(t));
    }
    await run("x");
    if (!(await screenText()).includes("NameError: name 'x' is not defined")) {
      throw new Error(`x가 정의됐다 — ${show(await tail(5))}`);
    }
  });

  await d('D04 `x = input("p: ")`에 `ab`를 친 뒤 커서 끝 Ctrl+D는 무동작, Enter → `print(x)` → `ab`', async () => {
    await startInput('x = input("p: ")', "p:");
    await typeWhenReading("ab");
    await settled();
    const before = await snapshot();
    await pressCtrlD();
    if ((await snapshot()) !== before) throw new Error(`Ctrl+D가 화면을 바꿨다 — ${show(await tail(3))}`);
    await finishRead();
    await run("print(x)");
    const t = await tail(3);
    if (!same(t, [">>> print(x)", "ab", ">>>"])) throw new Error(show(t));
  });

  await d('D05 `for line in sys.stdin: print(line, end="")` 블록 → a Enter b Enter → 빈 줄 Ctrl+D → 루프 종료·`>>>`', async () => {
    await clear();
    await type("import sys");
    await enter();
    await waitPrompt(">>>");
    await startBlockLine('for line in sys.stdin: print(line, end="")');
    await typeWhenReading("a");
    await enter();
    await settled();
    await typeWhenReading("b");
    await enter();
    await settled();
    await openEmptyRead();
    await pressCtrlD();
    await waitPrompt(">>>");
    if ((await countTracebacks()) !== 0) throw new Error(`트레이스백 발생 — ${show(await tail(8))}`);
    const all = await rows();
    const countExact = (s) => all.filter((r) => r === s).length;
    if (countExact("a") !== 2 || countExact("b") !== 2) {
      throw new Error(`a·b 행 개수 = ${countExact("a")}·${countExact("b")} — ${show(await tail(8))}`);
    }
  });

  await d("D06 `import time; time.sleep(1)` 실행 중 Ctrl+D는 세션을 끝내지 않는다(`>>>` 복귀 뒤 1+1 → 2)", async () => {
    await clear();
    await type("import time; time.sleep(1)");
    await enter();
    // 활성 읽기가 없는 구간(실행 중)에 친 Ctrl+D는 type-ahead로 쌓였다가 다음 읽기(`>>>`)에서 origin="replay"로
    // 재생돼 EOF를 내지 않는다([V5], `xterm-readline` origin 판정). sleep(1) 안에 확실히 들어가도록 Enter 직후
    // 곧바로 누른다(추가 대기 없음).
    await pressCtrlD();
    await waitPrompt(">>>", 5000);
    await run("1+1");
    const t = await tail(3);
    if (!same(t, [">>> 1+1", "2", ">>>"])) throw new Error(show(t));
  });

  await d('D01 빈 `>>>`에서 Ctrl+D → 종료 안내("Python session terminated.") → 리셋 → 새 `>>>`에서 1+1 → 2', async () => {
    await clear();
    await pressCtrlD();
    await waitFor(async () => (await statusText()) === "terminated", "status = terminated", 10000);
    const text = await terminatedText();
    const expected = 'Python session terminated. "세션 리셋" 버튼으로 새 세션을 시작하세요.';
    if (text !== expected) throw new Error(`terminated 문구 = ${show(text)}`);
    const t = await trimmedRows();
    if (!same(t, [">>>"])) throw new Error(`터미널 = ${show(t)}(추가 출력 없어야 한다)`);
    await resetAndWait();
    const terminatedCount = await page.locator('[data-testid="terminated"]').count();
    if (terminatedCount !== 0) throw new Error("리셋 뒤에도 terminated Alert가 보인다");
    await run("1+1");
    const t2 = await tail(3);
    if (!same(t2, [">>> 1+1", "2", ">>>"])) throw new Error(show(t2));
  });

  await step("콘솔 경고·오류·pageerror가 없다", async () => {
    if (h.problemLogs().length > 0 || h.pageErrors.length > 0) {
      throw new Error(JSON.stringify({ problemLogs: h.problemLogs(), pageErrors: h.pageErrors }));
    }
  });

  return h.finish({ label: "dev" });
}

async function runRunner(baseUrl) {
  const runnerUrl = new URL("/?view=runner", baseUrl).href;
  const h = await open(runnerUrl);
  const { page, step, waitFor, waitStatus, typeWhenReading, press, focus, settled, tail } = h;
  const pressCtrlD = () => press("Control+d");
  const resultText = () => page.locator('[data-testid="result"]').textContent();
  async function waitResult(description, timeoutMs = 30000) {
    await waitFor(async () => (await resultText()) !== "", `result: ${description}`, timeoutMs);
    return JSON.parse(await resultText());
  }
  const waitRow = (text, timeoutMs = 30000) =>
    waitFor(async () => (await h.rows()).some((r) => r === text), `출력 행 ${show(text)}`, timeoutMs);

  await step("초기: status = ready", async () => {
    await waitStatus(["ready"], "status = ready", BOOT_TIMEOUT_MS);
  });

  await step("D07 실행창 `input()` 실행 중 빈 줄 Ctrl+D → 결과·화면 모두 EOFError, 실행 종료", async () => {
    await page.fill('[data-testid="code"]', "input()");
    await page.click('[data-testid="run"]');
    await waitStatus(["waiting-input"], "입력 대기 상태");
    await focus();
    // 인자 없는 input()은 프롬프트 문자 신호가 없다(RD-006 L1과 같은 사정) — 글자 하나로 읽기 시작을 확인한 뒤 지운다.
    await typeWhenReading("z");
    await press("Backspace");
    await settled();
    await pressCtrlD();
    const r = await waitResult("EOFError");
    if (r.kind !== "error" || r.errorType !== "EOFError") throw new Error(`결과 = ${show(r)}`);
    // CPython의 input() EOF는 메시지가 있다("EOF when reading a line", 실측 — D03과 같다).
    await waitRow("EOFError: EOF when reading a line");
    if (!(await h.rows()).some((row) => row === '  File "main.py", line 1, in <module>')) {
      throw new Error(`트레이스백 프레임이 없다 — ${show(await tail(6))}`);
    }
    await waitStatus(["ready"], "EOF 뒤 ready");
  });

  await step("콘솔 경고·오류·pageerror가 없다", async () => {
    if (h.problemLogs().length > 0 || h.pageErrors.length > 0) {
      throw new Error(JSON.stringify({ problemLogs: h.problemLogs(), pageErrors: h.pageErrors }));
    }
  });

  return h.finish({ label: "runner-dev" });
}

let replOk = true;
if (pageSelected(only, ...REPL_CELLS)) replOk = await runRepl(url);

let runnerOk = true;
if (pageSelected(only, "D07")) runnerOk = await runRunner(url);

exitWith(replOk && runnerOk);
