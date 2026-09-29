// RD-023(`@cp949/runo-pyodide-dom-bridge` 실행창)을 실제 브라우저로 검증한다. 데모는 `?view=dom-bridge`다. 규칙은 docs/design/16-dom-bridge.md.
// 실제 xterm 6, 실제 브라우저, 실제 CDN pyodide, 실제 포크(`@cp949/runo-coincident`)를 쓴다.
// S1~S7은 RD-023 스파이크의 시나리오다. `native: false`와 늦은 import 양성 대조를 더했다.
//
// 조작과 판정:
// - 조작: `textarea`에 코드를 넣고 `run` 버튼으로 실행한다.
// - 판정: xterm 화면 행, `result`, `window.__domBridge.events`(순서 기록)로 한다.
// - dev 서버 전용이다. StrictMode 이중 마운트에서의 worker 수도 함께 본다.
//
// 페이지(=새 브라우저) 7개. 아래 순서로 돈다. 페이지마다 새 브라우저라 서로 상태를 공유하지 않는다.
// - plain `?view=dom-bridge`:
//   - 초기: 격리와 main native·supported.
//   - S1: 부팅, worker 수.
//   - S2: document·canvas·guarded window.
//   - S3: input 전달, 취소 2종, 재입력.
//   - S4: `while True` Ctrl+C, `time.sleep` Ctrl+C, 중단 뒤 실행.
//   - S7: 전역 패치 뒤 core 채널.
//   - 마지막: 콘솔 경고·오류·pageerror 없음.
// - slow `&mode=slow`:
//   - S5: 동기 호출 도중 interrupt는 호출 반환 뒤에 결말이 난다. `stop()`은 `restarted`와 새 `ready`다. 옛 worker가 끝난 뒤에도 오류가 없다.
//   - S6 view 경로: `<PythonRunner>` + terminal의 출력·DOM 도착 순서.
// - core `&mode=slow&runner=core`: S6 core 경로(`createRunner` 직접, terminal 없음).
// - native0g `&native=0`: N0a. main native false, `isDomBridgeSupported` false, worker를 만들지 않고 이유를 보인다.
// - native0 `&native=0&gate=off`: N0b. worker가 만들어져 `load-failed`와 명시 문구가 나온다(worker realm native false의 근거).
// - late `&mode=late`: LATE. dom-bridge를 늦게 import하는 양성 대조. `load-failed`와 첫 정적 import 문구가 나온다.
// - runlate `&mode=late-run`: RUNLATE. `runWorker`를 늦게 불러도 `ready`(init 버퍼링).
//
// S6 판정: 두 경로 모두 기록 누락 0과 모든 `ok`가 필수다. 역전 수는 기록만 한다(16.9).
//
// 시간 판정은 docs/design/09-testing.md 9.7을 따른다. 고정 대기·ms 상한이 없다.
// - 순서(S5·S6)는 이벤트 열의 앞뒤로 판정한다.
// - 상태는 `waitFor` 조건 대기로 본다. `timeoutMs`는 정지 감지용이다.
// - S5 호출 길이(2000ms·8000ms)는 시험이 만드는 상황이다. 판정 상한이 아니다.
// - 옛 worker는 `terminate()` 뒤 최대 약 2초 살아 있다(TRP-049). worker 수는 옛 worker가 사라지는 조건을 기다린다.
// - 판정 함수는 apps/demo/e2e/dom-bridge-judge.mjs(순수 함수)다. 시험은 `dom-bridge-judge.test.mjs`.
//
// 사용법·`ONLY`는 apps/demo/e2e/README.md.
// - `ONLY`는 페이지를 `pageSelected`(양방향 접두어)로, 확인을 `step()`의 접두어로 거른다. 초기는 페이지마다 실행한다.
// - 결과 파일은 `dom-bridge-check-<label>.json`이다. label은 페이지 이름(plain·slow·core·native0g·native0·late·runlate)이고 `-dev` 접미가 없다.
import { open, same, show } from "../lib.mjs";
import {
  judgeAfterCallReturn,
  judgeLoadFailedRows,
  judgeOrder,
  judgeOrderPath,
  ORDER_METHODS,
  judgeStatusSubsequence,
  judgeStopBeforeCallReturn,
  squashRows,
  userLine,
} from "../dom-bridge-judge.mjs";
import { checkEntry, currentOnly, exitWith, pageSelected } from "../check-runner.mjs";

const { url: baseUrl } = checkEntry();
const only = currentOnly();
/** worker 부팅(pyodide 로드)·재시작·옛 worker 종료 대기용 정지 감지 timeout(판정선이 아니다). */
const BOOT_TIMEOUT_MS = 90000;
/** 실패(load-failed) 도착을 기다리는 정지 감지 timeout. 정상 실패는 pyodide 로드 뒤 곧 오므로 부팅보다 짧게 둔다(판정선이 아니다). */
const FAIL_TIMEOUT_MS = 60000;

/** 출력 행 `go` 뒤 무한 루프. 실행이 진행 중임을 `go`로 확인한다. */
const SPIN = 'print("go")\nwhile True: pass';
/**
 * S5 호출 길이(ms). main이 이만큼 뒤에 Promise를 정착한다.
 * 시험이 만드는 상황이고 판정 상한이 아니다.
 * - interrupt 셀은 호출이 끝날 때까지 기다린다.
 * - stop 셀은 호출이 끝나기 전에 끝난다. `STOP_FALLBACK_MS`(1초)에 worker를 교체하기 때문이다.
 */
const SLOW_INTERRUPT_MS = 2000;
const SLOW_STOP_MS = 8000;

/** 모든 페이지가 통과했는지. 종료 코드로 쓴다. */
let allOk = true;
/** 이 실행에서 남기는 측정·관찰 기록(판정이 아니다). 페이지별로 `finish`의 extra에 실린다. */
const record = {};

/**
 * S6 측정 코드. 매 반복 `print(f"p{i}", flush=True)` 직후 DOM 효과 하나를 낸다. 방식은 셋이다(16.9).
 * - C: `document.title` 대입.
 * - Ag: guarded `window`로 main 함수 호출.
 * - Ar: 가드 없는 창(`runo_test.raw_window`, `mode=slow`)으로 main 함수 호출.
 */
const ORDER_CODES = {
  C: (iters) => ["from runo.browser import document", `for i in range(${iters}):`, "    print(f'p{i}', flush=True)", "    document.title = f'd{i}'"].join("\n"),
  Ag: (iters) => ["from runo.browser import window", `for i in range(${iters}):`, "    print(f'p{i}', flush=True)", "    window.__domBridgeMark(i)"].join("\n"),
  Ar: (iters) => ["import runo_test", "w = runo_test.raw_window", `for i in range(${iters}):`, "    print(f'p{i}', flush=True)", "    w.__domBridgeMark(i)"].join("\n"),
};
/** 방식마다 실행하는 횟수. */
const ORDER_RUNS = 5;

/** 한 실행의 출력·DOM 쌍 수. */
const ORDER_ITERS = 20;

/**
 * 방식 C·Ag·Ar 각각 `ORDER_RUNS`회 × `ORDER_ITERS`쌍의 출력·DOM 도착 순서를 잰다.
 * 방식별 `{ pairs, inversions, missing, outcomes, perRun }`을 돌려준다. 판정은 호출자가 `judgeOrderPath`로 한다.
 * - 준비: 메인 창에 `window.__domBridgeMark(i)`를 심는다. Python이 부르면 이벤트 열에 DOM 도착(`dom`, `d<i>`)으로 기록한다(스파이크의 `spikeMark`).
 * - `runOne(code)`는 코드를 실행해 결말을 돌려준다. `getEvents`는 이벤트 열을 돌려준다.
 * - 결말은 같은 core 포트의 마지막 메시지다. 그래서 앞선 `out` 알림은 이미 기록됐다.
 * - DOM 효과는 동기 호출이 돌아온 시점에 기록됐다.
 */
async function measureOrder(page, runOne, getEvents) {
  await page.evaluate(() => {
    window.__domBridgeMark = (i) => {
      window.__domBridge.events.push({ type: "dom", data: `d${i}` });
    };
  });
  const methods = {};
  for (const name of ORDER_METHODS) {
    const perRun = [];
    const outcomes = [];
    for (let k = 0; k < ORDER_RUNS; k += 1) {
      const from = (await getEvents()).length;
      const outcome = await runOne(ORDER_CODES[name](ORDER_ITERS));
      outcomes.push(outcome?.kind ?? String(outcome));
      perRun.push(judgeOrder((await getEvents()).slice(from), ORDER_ITERS));
    }
    methods[name] = {
      pairs: perRun.reduce((a, r) => a + r.pairs, 0),
      inversions: perRun.reduce((a, r) => a + r.inversions, 0),
      missing: perRun.reduce((a, r) => a + r.missing, 0),
      outcomes,
      perRun,
    };
  }
  return methods;
}

/**
 * 페이지 하나를 열어 `body(c)`를 돌리고 결과 JSON을 남긴다.
 * `ONLY`가 이 페이지의 `prefixes`와 맞지 않으면 열지 않는다(`pageSelected`).
 * `body`는 하니스 핸들 `h`와 페이지 도우미 묶음 `c`를 받는다. 결과는 `allOk`에 반영한다.
 * `record[label]`이 있으면 결과 JSON의 `record`로 싣는다. label은 결과 파일 이름에도 쓰인다.
 */
async function runPage({ label, path, prefixes, before, body }) {
  if (!pageSelected(only, ...prefixes)) return;
  const h = await open(new URL(path, baseUrl).href, { before });
  const { page, waitFor, waitStatus, statusText, rows, trimmedRows, focus, ctrlC } = h;

  const resultText = () => page.locator('[data-testid="result"]').textContent();
  // `result`가 비어 있지 않을 때까지 기다려 JSON으로 파싱해 돌려준다.
  // 새 실행을 시작하면 앱이 이전 결과를 지운다.
  async function waitResult(description, timeoutMs = 30000) {
    await waitFor(async () => (await resultText()) !== "", `result: ${description}`, timeoutMs);
    return JSON.parse(await resultText());
  }
  // 코드를 `textarea`에 넣고 `run` 버튼을 누른다. 앱이 터미널에 포커스를 준다.
  async function startRun(code) {
    await page.fill('[data-testid="code"]', code);
    await page.click('[data-testid="run"]');
  }
  async function clearScreen() {
    await page.click('[data-testid="clear"]');
    await waitFor(async () => (await trimmedRows()).length === 0, "clear 뒤 빈 화면", 5000);
  }
  const waitRow = (text, timeoutMs = 30000) => waitFor(async () => (await rows()).some((r) => r === text), `출력 행 ${show(text)}`, timeoutMs);
  // 첫 `ready`를 기다린다.
  // `load-failed`·`crashed`가 되면 90초를 다 기다리지 않고 바로 던진다. 정지 감지용 timeout이 실패를 늦추지 않게 한다.
  async function waitReady(timeoutMs = BOOT_TIMEOUT_MS) {
    let status = "";
    await waitFor(
      async () => {
        status = await statusText();
        return status === "ready" || status === "load-failed" || status === "crashed";
      },
      "status = ready",
      timeoutMs,
    );
    if (status !== "ready") throw new Error(`status = ${status}(ready 기대)`);
  }
  // 셀 시작 상태를 만든다. `ready`가 된 뒤 화면을 지운다.
  // - 이전 셀이 남긴 실행·입력 대기는 `stop`으로 끝낸다.
  // - `crashed`는 `reset`으로 복구한다.
  // - `load-failed`는 세션 시작 자체가 실패한 것이라 `reset`해도 같은 실패다. 재시도하지 않고 던진다.
  //   뒤 셀이 90초씩 기다리며 연쇄 실패하지 않게 한다.
  async function freshCell() {
    const current = await statusText();
    if (current === "load-failed") throw new Error("status load-failed: 세션을 시작하지 못했다(reset 재시도 없음)");
    if (current === "running" || current === "waiting-input") await page.click('[data-testid="stop"]');
    else if (current === "crashed") await page.click('[data-testid="reset"]');
    await waitStatus(["ready"], "셀 시작: status = ready", BOOT_TIMEOUT_MS);
    await clearScreen();
  }
  // 페이지의 관찰 기록(apps/demo/src/dom-bridge-log.ts)을 돌려준다. 순서 판정의 재료다.
  const getEvents = () => page.evaluate(() => window.__domBridge.events.map((e) => ({ type: e.type, data: e.data })));
  const waitEvent = (pred, description, timeoutMs = 30000) => waitFor(async () => pred(await getEvents()), description, timeoutMs);
  // 데모가 표시하는 값(`cross-origin-isolated`·`native`·`supported`)의 텍스트를 읽는다.
  const cross = async (testid) => page.locator(`[data-testid="${testid}"]`).textContent();
  // 화면 행에 문구가 나타날 때까지 기다린 뒤 행 전체를 돌려준다. 터미널 렌더가 비동기라서다.
  // 비교는 공백을 뺀 행(`squashRows`)으로 한다.
  async function waitSquashed(needle, timeoutMs = 15000) {
    await waitFor(async () => squashRows(await rows()).includes(squashRows([needle])), `화면에 ${show(needle)}`, timeoutMs);
    return await rows();
  }
  // `load-failed`가 오는지 결말 기반으로 판정한다. `ready`가 되거나 도착하지 않고 대기 상태로 남으면 던진다.
  async function expectLoadFailed(timeoutMs = FAIL_TIMEOUT_MS) {
    let status = "";
    try {
      await waitFor(
        async () => {
          status = await statusText();
          return status === "load-failed" || status === "ready" || status === "crashed";
        },
        "status가 load-failed",
        timeoutMs,
      );
    } catch {
      throw new Error(`load-failed가 오지 않고 status ${show(status)}에 머문다(대기 상태)`);
    }
    if (status !== "load-failed") throw new Error(`status = ${status}(load-failed 기대)`);
  }
  // 이벤트 열에서 status 이력만 문자열로 뽑는다.
  const statuses = async () => (await getEvents()).filter((e) => e.type === "status").map((e) => String(e.data));

  await body({ h, page, step: h.step, waitFor, waitStatus, statusText, rows, trimmedRows, focus, ctrlC, resultText, waitResult, startRun, clearScreen, waitRow, waitReady, freshCell, getEvents, waitEvent, cross, waitSquashed, expectLoadFailed, statuses });

  const ok = await h.finish({ label, mode: label, ...(record[label] ? { record: record[label] } : {}) });
  allOk = allOk && ok;
}

// ---------------------------------------------------------------- plain

await runPage({
  label: "plain",
  path: "/?view=dom-bridge",
  prefixes: ["S1", "S2", "S3", "S4", "S7"],
  // coincident가 평가되기 전의 원본 `addEventListener`를 붙잡아 둔다(S7: 전역 패치 여부의 기록용).
  before: async (page) => {
    await page.addInitScript(() => {
      window.__nativeAEL = EventTarget.prototype.addEventListener;
    });
  },
  async body(c) {
    const { h, page, step, waitFor, waitStatus, waitReady, rows, trimmedRows, focus, ctrlC, waitResult, startRun, waitRow, freshCell, getEvents, cross } = c;
    record.plain = {};

    await step("초기 페이지가 cross-origin isolated고 main native·supported가 true다", async () => {
      const t = { coi: await cross("cross-origin-isolated"), native: await cross("native"), supported: await cross("supported") };
      if (t.coi !== "true" || t.native !== "true" || t.supported !== "true") throw new Error(show(t));
    });

    await step("S1 초기화가 ready가 되고 화면이 비어 있다(배너·프롬프트 없음)", async () => {
      await waitReady();
      const t = await trimmedRows();
      if (t.length !== 0) throw new Error(`행 = ${show(t)}`);
    });

    await step("S1 print(1+1) → 결과 ok·출력 2, pageerror 0", async () => {
      await freshCell();
      await startRun("print(1+1)");
      const r = await waitResult("ok");
      if (r.kind !== "ok") throw new Error(`결과 = ${show(r)}`);
      await waitRow("2");
      if (h.pageErrors.length > 0) throw new Error(`pageErrors = ${show(h.pageErrors)}`);
    });

    await step("S1 터미널 1개·worker 1개만 살아 있다(StrictMode·coincident 재생성 잔재 없음)", async () => {
      const count = await page.locator(".xterm").count();
      if (count !== 1) throw new Error(`.xterm 요소 ${count}개`);
      // 옛 worker는 terminate() 뒤 최대 약 2초 살아 있다(TRP-049): 사라지는 조건을 기다린다.
      // 판정 범위의 한계(TRP-061): `workers().length === 1`은 최종 개수만 본다. 재생성 잔재(worker 누수)는 잡지만, StrictMode 이중 마운트가
      // 실제로 일어나 worker를 만들고 치웠는지는 구분하지 못한다. 이중 마운트가 없었던 경우(예: StrictMode가 빠진 빌드)에도 이 셀은 통과한다.
      await waitFor(() => page.workers().length === 1, "workers().length === 1", BOOT_TIMEOUT_MS);
    });

    await step("S2 Python이 document.title·canvas 픽셀을 바꾼다(from runo.browser import document)", async () => {
      await freshCell();
      await startRun(
        [
          "from runo.browser import document",
          "d = document",
          'd.title = "from-python"',
          'ctx = d.getElementById("dom-canvas").getContext("2d")',
          'ctx.fillStyle = "rgb(255,0,0)"',
          "ctx.fillRect(0, 0, 10, 10)",
          'print("py-title", d.title, flush=True)',
        ].join("\n"),
      );
      const r = await waitResult("ok");
      if (r.kind !== "ok") throw new Error(`결과 = ${show(r)}`);
      const title = await page.title();
      if (title !== "from-python") throw new Error(`main title = ${show(title)}`);
      // getImageData를 여러 번 부르면 Chromium이 willReadFrequently 경고를 콘솔에 남기므로(콘솔 0 판정과 충돌) 한 번에 읽는다.
      const { pixel, untouched } = await page.evaluate(() => {
        const data = document.getElementById("dom-canvas").getContext("2d").getImageData(0, 0, 60, 60).data;
        const at = (x, y) => Array.from(data.slice((y * 60 + x) * 4, (y * 60 + x) * 4 + 4));
        return { pixel: at(5, 5), untouched: at(50, 50) };
      });
      if (!same(pixel, [255, 0, 0, 255])) throw new Error(`픽셀(5,5) = ${show(pixel)}`);
      if (!same(untouched, [0, 0, 0, 0])) throw new Error(`칠하지 않은 픽셀(50,50) = ${show(untouched)}`);
      await waitRow("py-title from-python");
    });

    await step("S2 guarded window가 Python JsProxy로 변환돼 document를 읽고, parent 접근은 Python 예외다", async () => {
      await freshCell();
      await startRun(
        [
          "from runo.browser import window",
          'window.document.title = "via-window"',
          'print("win-title", window.document.title, flush=True)',
          "try:",
          "    window.parent",
          "except BaseException as e:",
          '    print("guard", type(e).__name__, "window.parent" in str(e), flush=True)',
          "else:",
          '    print("guard-none", flush=True)',
        ].join("\n"),
      );
      const r = await waitResult("ok");
      if (r.kind !== "ok") throw new Error(`결과 = ${show(r)}`);
      const title = await page.title();
      if (title !== "via-window") throw new Error(`main title = ${show(title)}`);
      await waitRow("win-title via-window");
      const guard = (await rows()).find((row) => row.startsWith("guard"));
      if (guard === undefined || !guard.endsWith(" True")) throw new Error(`guard 행 = ${show(guard)}, 화면 = ${show(await trimmedRows())}`);
      record.plain.guardRow = guard;
    });

    await step("S3 input('q? ') → 붙여넣은 `hello 한글`이 Python에 전달된다", async () => {
      await freshCell();
      await startRun('x = input("q? ")\nprint("got", x, flush=True)');
      await waitStatus(["waiting-input"], "입력 대기 상태");
      await h.waitPrompt("q?", 15000);
      await focus();
      await h.paste("hello 한글");
      await h.enter();
      const r = await waitResult("ok");
      if (r.kind !== "ok") throw new Error(`결과 = ${show(r)}`);
      await waitRow("got hello 한글");
      await waitStatus(["ready"], "입력 뒤 ready");
    });

    await step("S3 취소 ①: 읽기 중 Ctrl+C → interrupted, 상태 ready", async () => {
      await freshCell();
      await startRun('input("c1? ")');
      await waitStatus(["waiting-input"], "입력 대기 상태");
      await h.waitPrompt("c1?", 15000);
      await focus();
      await ctrlC();
      const r = await waitResult("interrupted", BOOT_TIMEOUT_MS);
      if (r.kind !== "interrupted") throw new Error(`결과 = ${show(r)}`);
      await waitStatus(["ready"], "취소 뒤 ready");
    });

    await step("S3 취소 ②: 읽기 중 stop 버튼 → interrupted, 상태 ready", async () => {
      await freshCell();
      await startRun('input("c2? ")');
      await waitStatus(["waiting-input"], "입력 대기 상태");
      await h.waitPrompt("c2?", 15000);
      await page.click('[data-testid="stop"]');
      const r = await waitResult("interrupted", BOOT_TIMEOUT_MS);
      if (r.kind !== "interrupted") throw new Error(`결과 = ${show(r)}`);
      await waitStatus(["ready"], "취소 뒤 ready");
    });

    await step("S3 취소 뒤 재입력이 정상 전달된다", async () => {
      await freshCell();
      await startRun('y = input("again? ")\nprint("again-got", y, flush=True)');
      await waitStatus(["waiting-input"], "입력 대기 상태");
      await h.waitPrompt("again?", 15000);
      await focus();
      await h.type("again");
      await h.enter();
      const r = await waitResult("ok");
      if (r.kind !== "ok") throw new Error(`결과 = ${show(r)}`);
      await waitRow("again-got again");
    });

    await step("S4 `while True: pass` + Ctrl+C → ^C·KeyboardInterrupt 트레이스백, interrupted, ready", async () => {
      await freshCell();
      await startRun(SPIN);
      await waitRow("go");
      await waitStatus(["running"], "실행 중 상태");
      await focus();
      await ctrlC();
      const r = await waitResult("interrupted", BOOT_TIMEOUT_MS);
      if (r.kind !== "interrupted") throw new Error(`결과 = ${show(r)}`);
      if (!r.traceback.includes('File "main.py", line 2, in <module>') || !r.traceback.endsWith("KeyboardInterrupt\n")) throw new Error(`traceback = ${show(r.traceback)}`);
      await waitStatus(["ready"], "중단 뒤 ready");
      const counts = { caret: await h.caretCount(), traceback: await h.countTracebacks(), interrupt: await h.interruptCount() };
      if (counts.caret !== 1 || counts.traceback !== 1 || counts.interrupt !== 1) throw new Error(`개수 = ${show(counts)}`);
    });

    await step("S4 `time.sleep(10)` + Ctrl+C → interrupted(10초를 채우고 ok로 끝나지 않는다), ready", async () => {
      await freshCell();
      await startRun('import time\nprint("zzz", flush=True)\ntime.sleep(10)');
      await waitRow("zzz");
      await waitStatus(["running"], "실행 중 상태");
      await focus();
      await ctrlC();
      const r = await waitResult("interrupted", BOOT_TIMEOUT_MS);
      if (r.kind !== "interrupted") throw new Error(`결과 = ${show(r)}`);
      await waitStatus(["ready"], "중단 뒤 ready");
    });

    await step("S4 중단 뒤 다음 실행이 정상이다(2+2)", async () => {
      await freshCell();
      await startRun('print("after", 2+2)');
      const r = await waitResult("ok");
      if (r.kind !== "ok") throw new Error(`결과 = ${show(r)}`);
      await waitRow("after 4");
    });

    await step("S7 coincident 전역 패치 뒤에도 MessagePort·AbortSignal 리스너가 정상이고 core 실행이 정상이다", async () => {
      const patch = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const patched = EventTarget.prototype.addEventListener !== window.__nativeAEL;
            const ch = new MessageChannel();
            const ch2 = new MessageChannel();
            const seen = { viaAEL: 0, viaOnmessage: 0 };
            let doneAEL = false;
            let doneOn = false;
            const finish = () => {
              if (doneAEL && doneOn) resolve({ patched, ...seen });
            };
            // 도착 확인은 고정 대기가 아니라 뒤따르는 "MARK" 메시지(같은 포트, 순서 보장)로 한다.
            ch.port1.addEventListener("message", (e) => e.data !== "MARK" && (seen.viaAEL += 1), { once: true });
            ch.port1.addEventListener("message", (e) => {
              if (e.data === "MARK") {
                doneAEL = true;
                finish();
              }
            });
            ch.port1.start();
            ch2.port1.onmessage = (e) => {
              if (e.data === "MARK") {
                doneOn = true;
                finish();
              } else seen.viaOnmessage += 1;
            };
            ch.port2.postMessage(1);
            ch.port2.postMessage(2);
            ch.port2.postMessage("MARK");
            ch2.port2.postMessage(1);
            ch2.port2.postMessage("MARK");
          }),
      );
      record.plain.patch = patch;
      if (patch.viaAEL !== 1) throw new Error(`MessagePort addEventListener {once}: ${patch.viaAEL}건 수신(기대 1) — ${show(patch)}`);
      if (patch.viaOnmessage !== 1) throw new Error(`MessagePort onmessage: ${patch.viaOnmessage}건 수신(기대 1) — ${show(patch)}`);
      const abortCount = await page.evaluate(() => {
        let n = 0;
        const ac = new AbortController();
        ac.signal.addEventListener("abort", () => (n += 1), { once: true });
        ac.abort();
        ac.abort();
        return n;
      });
      if (abortCount !== 1) throw new Error(`AbortSignal {once} 리스너 ${abortCount}회(기대 1)`);
      await freshCell();
      await startRun("print(1+1)");
      const r = await waitResult("ok");
      if (r.kind !== "ok") throw new Error(`결과 = ${show(r)}`);
      await waitRow("2");
    });

    await step("콘솔 경고·오류·pageerror가 없다", async () => {
      if (h.problemLogs().length > 0 || h.pageErrors.length > 0) throw new Error(JSON.stringify({ problemLogs: h.problemLogs(), pageErrors: h.pageErrors }));
    });
  },
});

// ---------------------------------------------------------------- slow (S5)

await runPage({
  label: "slow",
  path: "/?view=dom-bridge&mode=slow",
  prefixes: ["S5", "S6"],
  async body(c) {
    const { h, page, step, waitFor, waitStatus, waitResult, startRun, freshCell, getEvents, waitEvent, focus, ctrlC } = c;
    record.slow = {};

    // 실행을 시작하고 main의 `slowStart`가 기록될 때까지 기다린다.
    // 그 호출의 id와 실행 시작 이벤트 위치를 돌려준다.
    async function startSlow(ms) {
      await freshCell();
      const from = (await getEvents()).length;
      const code = ["import runo_test", 'print("S5-START", flush=True)', `runo_test.slow(${ms})`, 'print("S5-AFTER", flush=True)'].join("\n");
      await startRun(code);
      await waitEvent((evs) => evs.slice(from).some((e) => e.type === "slowStart"), "main slowStart 기록", BOOT_TIMEOUT_MS);
      const id = (await getEvents()).slice(from).find((e) => e.type === "slowStart").data.id;
      return { from, id };
    }

    await step(`S5 동기 호출(slow ${SLOW_INTERRUPT_MS}ms) 도중 Ctrl+C: 결말이 호출 반환 뒤(main slowDone 뒤)이고 다음 줄에서 interrupted`, async () => {
      const { from, id } = await startSlow(SLOW_INTERRUPT_MS);
      await waitStatus(["running"], "실행 중 상태");
      await focus();
      await ctrlC();
      const r = await waitResult("interrupted", BOOT_TIMEOUT_MS);
      const events = (await getEvents()).slice(from);
      const judged = judgeAfterCallReturn(events, id, "interrupted", "ctrlC");
      record.slow.interrupt = { id, outcome: r.kind, userLine: userLine(r.traceback), judged: judged.reason };
      if (!judged.ok) throw new Error(judged.reason);
      // 호출은 3번째 줄이고 중단은 그 다음 줄(4)에서 난다(스파이크: 호출 줄 6 → 결말 줄 7).
      if (userLine(r.traceback) !== 4) throw new Error(`중단 줄 = ${userLine(r.traceback)}(기대 4: 호출 반환 직후 다음 줄), traceback = ${show(r.traceback)}`);
      await waitStatus(["ready"], "중단 뒤 ready");
    });

    await step(`S5 별도 실행에서 slow ${SLOW_STOP_MS}ms 도중 stop() → restarted, 상태 restarting → 새 ready, 새 worker의 DOM 호출이 동작한다`, async () => {
      const { from, id } = await startSlow(SLOW_STOP_MS);
      await waitStatus(["running"], "실행 중 상태");
      const at = (await getEvents()).length;
      await page.click('[data-testid="stop"]');
      const r = await waitResult("restarted", BOOT_TIMEOUT_MS);
      if (r.kind !== "restarted") throw new Error(`결과 = ${show(r)}`);
      await waitStatus(["ready"], "재시작 뒤 ready", BOOT_TIMEOUT_MS);
      const seq = judgeStatusSubsequence(await getEvents(), at, ["restarting", "ready"]);
      if (!seq.ok) throw new Error(`status 이력 = ${show(seq.seen)}`);
      // 옛 호출은 결말 전에 끝나지 않았다(이벤트 열에서 slowDone이 없거나 restarted 결말 뒤에 온다) — 호출 도중에 worker가 종료됐다는 근거.
      // `ready` 시점에 slowDone이 이미 기록됐는지는 보지 않는다: 새 worker 재부팅이 길면 결말 뒤 slowDone이 먼저 올 수 있고, 그것을 실패로 보면
      // 재부팅 시간이 판정선이 된다(9.7 위반). 판정은 결말과 slowDone의 순서다(`judgeStopBeforeCallReturn`).
      const evsStop = (await getEvents()).slice(from);
      const judged = judgeStopBeforeCallReturn(evsStop, id);
      record.slow.stop = { id, outcome: r.kind, statuses: seq.seen, judged: judged.reason };
      if (!judged.ok) throw new Error(judged.reason);
      // 새 worker는 브리지도 새로 만들었다.
      await startRun('from runo.browser import document\ndocument.title = "after-stop"\nprint("after-stop", flush=True)');
      const after = await waitResult("ok", BOOT_TIMEOUT_MS);
      if (after.kind !== "ok") throw new Error(`재시작 뒤 결과 = ${show(after)}`);
      const title = await page.title();
      if (title !== "after-stop") throw new Error(`재시작 뒤 main title = ${show(title)}`);
      await waitFor(() => page.workers().length === 1, "옛 worker 소멸(workers().length === 1)", BOOT_TIMEOUT_MS);
    });

    await step("S5 옛 worker의 slow가 끝난 뒤에도 pageerror·콘솔 오류가 없다(종료된 worker에 대한 main 응답)", async () => {
      const id = record.slow.stop?.id;
      if (id === undefined) throw new Error("앞 셀이 실행되지 않아 id를 모른다");
      await waitEvent((evs) => evs.some((e) => e.type === "slowDone" && e.data.id === id), "옛 slow의 main slowDone", BOOT_TIMEOUT_MS);
      // slowDone 다음 실행이 정상이다(같은 채널에서 순서가 보장되는 마커).
      await startRun('print("mark", flush=True)');
      const r = await waitResult("ok");
      if (r.kind !== "ok") throw new Error(`결과 = ${show(r)}`);
      if (h.problemLogs().length > 0 || h.pageErrors.length > 0) throw new Error(JSON.stringify({ problemLogs: h.problemLogs(), pageErrors: h.pageErrors }));
    });

    // 판정 기준(2026-09-25 사용자 확정): 역전 수는 두 경로 모두 판정 없이 기록만 한다. 필수는 기록 누락 0과 모든 실행 `ok`다.
    // 출력은 core MessagePort로, DOM 호출은 coincident 채널로 간다. 두 채널 사이의 도착 순서는 보장되지 않는다(16.9).
    // 역전의 원인은 실측하지 않았다. view 경로의 가설은 terminal 출력 렌더 지연이다.
    await step("S6 view 경로(<PythonRunner> + terminal): 방식 C·Ag·Ar 각 5회 × 20쌍, 기록 누락 0·모든 ok는 필수, 역전 수는 기록만", async () => {
      await freshCell();
      const runOne = async (code) => {
        await freshCell();
        await startRun(code);
        return await waitResult("ok", BOOT_TIMEOUT_MS);
      };
      const methods = await measureOrder(page, runOne, getEvents);
      const judged = judgeOrderPath(methods);
      record.slow.orderView = { summary: judged.summary, outcomes: Object.fromEntries(Object.entries(methods).map(([k, v]) => [k, v.outcomes])), perRun: Object.fromEntries(Object.entries(methods).map(([k, v]) => [k, v.perRun])) };
      console.log(`S6 view 경로 기록: ${judged.reason}`);
      if (!judged.ok) throw new Error(judged.reason);
    });
  },
});

// ---------------------------------------------------------------- core (S6)

await runPage({
  label: "core",
  path: "/?view=dom-bridge&mode=slow&runner=core",
  prefixes: ["S6"],
  async body(c) {
    const { step, page, waitReady, getEvents } = c;
    record.core = {};
    // core `createRunner` 직접 경로(terminal 없음). view 경로와 같은 기준이다. 필수는 누락 0과 모든 ok, 역전 수는 기록만 한다.
    // 관측은 0~5/100이고 스파이크는 0/500이었다.
    await step("S6 core createRunner 직접 경로: 방식 C·Ag·Ar 각 5회 × 20쌍, 기록 누락 0·모든 ok는 필수, 역전 수는 기록만", async () => {
      await waitReady();
      const runOne = (code) => page.evaluate((src) => window.__domBridgeCore.run(src), code);
      const methods = await measureOrder(page, runOne, getEvents);
      const judged = judgeOrderPath(methods);
      record.core.order = { summary: judged.summary, outcomes: Object.fromEntries(Object.entries(methods).map(([k, v]) => [k, v.outcomes])), perRun: Object.fromEntries(Object.entries(methods).map(([k, v]) => [k, v.perRun])) };
      console.log(`S6 core 경로 기록: ${judged.reason}`);
      if (!judged.ok) throw new Error(judged.reason);
    });
  },
});

// ---------------------------------------------------------------- native0 (N0)

await runPage({
  label: "native0g",
  path: "/?view=dom-bridge&native=0",
  prefixes: ["N0a"],
  async body(c) {
    const { h, page, step, waitFor, cross } = c;
    await step("N0a `?native=0`: main native·supported가 false이고 worker를 만들지 않고 이유만 보인다", async () => {
      await waitFor(async () => (await page.locator('[data-testid="unsupported"]').count()) === 1, "unsupported 안내", 30000);
      const t = { native: await cross("native"), supported: await cross("supported") };
      if (t.native !== "false" || t.supported !== "false") throw new Error(`main ${show(t)}(둘 다 false 기대)`);
      const reason = await page.locator('[data-testid="unsupported"]').textContent();
      if (!reason.includes("growable SharedArrayBuffer")) throw new Error(`이유 문구 = ${show(reason)}`);
      // 안내는 PythonRunner 없이 그려지므로(같은 렌더에서 worker 생성 effect가 없다) worker·터미널이 없는 것이 구조적으로 확정이다.
      if (page.workers().length !== 0) throw new Error(`workers().length = ${page.workers().length}`);
      if ((await page.locator(".xterm").count()) !== 0) throw new Error(".xterm이 있다");
      if (h.pageErrors.length > 0) throw new Error(`pageErrors = ${show(h.pageErrors)}`);
    });
  },
});

await runPage({
  label: "native0",
  path: "/?view=dom-bridge&native=0&gate=off",
  prefixes: ["N0b"],
  async body(c) {
    const { h, step, rows, expectLoadFailed, waitSquashed, cross, statuses } = c;
    await step("N0b `?native=0`(검사 우회): worker가 만들어져 load-failed, 명시 문구(worker realm native false 근거)", async () => {
      // main realm: 강제가 적용됐다.
      const main = { native: await cross("native"), supported: await cross("supported") };
      if (main.native !== "false" || main.supported !== "false") throw new Error(`main ${show(main)}(둘 다 false 기대)`);
      await expectLoadFailed();
      // worker realm: `!native` 분기의 문구만이 여기 나온다(부트스트랩 미수신 분기는 다른 문구). worker의 native가 true였다면 ready가 됐을 것이다.
      await waitSquashed("pyodide 로드 실패");
      const judged = judgeLoadFailedRows(await rows(), "dom-bridge", ["동기 DOM 브리지(native)를 쓸 수 없다", "growable SharedArrayBuffer"]);
      if (!judged.ok) throw new Error(judged.reason);
      const seen = await statuses();
      if (seen.includes("ready")) throw new Error(`status 이력에 ready가 있다: ${show(seen)}`);
      if (h.pageErrors.length > 0) throw new Error(`pageErrors = ${show(h.pageErrors)}`);
    });
  },
});

// ---------------------------------------------------------------- late (LATE) · runlate

await runPage({
  label: "late",
  path: "/?view=dom-bridge&mode=late",
  prefixes: ["LATE"],
  async body(c) {
    const { h, step, rows, expectLoadFailed, waitSquashed, statuses } = c;
    await step("LATE dom-bridge를 늦게 import(prepare 안 동적 import): load-failed + 첫 정적 import 문구, ready 없음", async () => {
      await expectLoadFailed();
      await waitSquashed("pyodide 로드 실패");
      const judged = judgeLoadFailedRows(await rows(), "dom-bridge", ["coincident 부트스트랩 메시지를 받지 못했다", "첫 정적 import"]);
      if (!judged.ok) throw new Error(judged.reason);
      const seen = await statuses();
      if (seen.includes("ready")) throw new Error(`status 이력에 ready가 있다: ${show(seen)}`);
      if (h.pageErrors.length > 0) throw new Error(`pageErrors = ${show(h.pageErrors)}`);
    });
  },
});

await runPage({
  label: "runlate",
  path: "/?view=dom-bridge&mode=late-run",
  prefixes: ["RUNLATE"],
  async body(c) {
    const { h, page, step, waitReady, waitResult, startRun, freshCell, waitRow } = c;
    await step("RUNLATE `runWorker`를 init 프레임이 온 뒤 늦게 불러도 ready(init 버퍼링), print·DOM 호출 정상", async () => {
      await waitReady();
      // 시험이 성립했는지: runWorker 호출 시점에 init 프레임이 이미 도착해 있었다(worker 콘솔 기록).
      const line = h.logs.find((l) => l.source === "worker" && l.text.includes("[late-run]"));
      if (line === undefined) throw new Error(`worker 콘솔에 [late-run] 기록이 없다: ${show(h.logs.filter((l) => l.source === "worker"))}`);
      if (!line.text.includes("init 도착=true")) throw new Error(`init 프레임이 runWorker 호출 전에 도착하지 않았다(시험 불성립): ${line.text}`);
      await freshCell();
      await startRun('from runo.browser import document\ndocument.title = "late-run"\nprint("late-run-ok", 1+1, flush=True)');
      const r = await waitResult("ok");
      if (r.kind !== "ok") throw new Error(`결과 = ${show(r)}`);
      await waitRow("late-run-ok 2");
      const title = await page.title();
      if (title !== "late-run") throw new Error(`main title = ${show(title)}`);
      if (h.pageErrors.length > 0) throw new Error(`pageErrors = ${show(h.pageErrors)}`);
    });
  },
});

exitWith(allOk);
