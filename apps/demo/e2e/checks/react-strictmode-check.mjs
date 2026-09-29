// RD-024 브라우저 확인: `@cp949/runo-pyodide-repl-react` 컴포넌트(`<PythonRepl>`·`<PythonRunner>`)가 dev 서버의 `<StrictMode>`
// 이중 마운트(mount → cleanup → mount)에서 worker·xterm을 남기지 않는지. 실제 xterm 6 + 실제 브라우저 + 실제 CDN pyodide.
// dev 전용: 프로덕션 빌드(preview·정적 서버)는 StrictMode 이중 마운트가 없어 이 확인이 성립하지 않는다(`bg-output-check` 선례).
//
// 화면 두 개를 각각 새 브라우저로 연다: `REPL`(기본 화면 `/`), `RUNNER`(`/?view=runner`).
//   S01 `new Worker`가 2회 이상(이중 마운트가 실제로 일어났다)이고 살아 있는 worker가 1이 된다. 살아 있는 수는 Playwright
//       `page.on('worker')` 생성·`worker.on('close')` 종료 이벤트와 페이지 안 `Worker` 계측(생성 − `terminate()` 호출) 둘 다 1이어야 하며
//       폴링한다(옛 worker는 `terminate()` 뒤 최대 약 2초 살아 있다, TRP-049). Playwright는 생성 직후 terminate된 첫 worker를 관측하지
//       못해(생성 이벤트 1개, `new Worker` 2회 실측) 이중 마운트 확인은 계측이 맡는다
//   S02 status `ready`가 된 뒤에도 살아 있는 worker 1개·생성 수 불변(부팅 중 재생성·누수 없음, 마커 배리어)
//   S03 `.xterm` 요소 1개(Terminal 잔재 없음)
//   S04 콘솔 warning 중 `DisposableStore` 포함 0건(TRP-004: dispose 뒤 xterm write 콜백). 콘솔 warning 0 확인일 뿐 정리 순서 회귀는 검출하지 못한다
//       (TRP-064: 순서를 뒤집어도 경고가 없다). 정리 순서 방어는 L0(`Terminal.dispose` 시점의 live worker 수 시험) 몫이다
//   S05 콘솔 warning·error 0, pageerror 0
// 언마운트 정리는 페이지 안에서 뷰를 교체하지 않아 브라우저로 보지 않는다(L0 `python-repl.test.tsx`·`python-runner.test.tsx`가 맡는다).
//
// 시간 판정(`docs/design/09-testing.md` 9.7): 고정 대기·ms 상한을 쓰지 않는다. worker 수는 조건 대기(`waitFor`)로 기다리고
// `timeoutMs`는 정지 감지용이다. 판정 함수는 `../react-judge.mjs`(순수 함수, `react-judge.test.mjs`가 가짜 입력으로 시험).
//
// 사용: node react-strictmode-check.mjs [url](생략 시 http://localhost:5173)     ONLY=REPL 또는 ONLY=RUNNER 로 화면 하나만(ONLY=REPL-S01 처럼 셀 접두어도 된다. S02는 S01이 기록한 `new Worker` 수에 의존하므로 단독 `ONLY=REPL-S02`는 실패하고 `ONLY=REPL-S01,REPL-S02`처럼 S01과 함께 실행한다)
// 결과 파일: `react-strictmode-check-<repl|runner>-dev.json`
import { open } from "../lib.mjs";
import { countWarnings, judgeStrictModeWorkers, tallyWorkerCalls, tallyWorkers } from "../react-judge.mjs";
import { checkEntry, currentOnly, exitWith, pageSelected } from "../check-runner.mjs";

const { url: baseUrl } = checkEntry();
// ONLY는 lib.mjs `step`의 접두어 규칙과 같다(`ONLY=REPL`·`ONLY=RUNNER-S01`). 화면 하나만 돌릴 때 그 화면의 브라우저만 연다.
const only = currentOnly();
/** worker 부팅(pyodide 로드)·옛 worker 종료 대기용 정지 감지 timeout(판정선이 아니다). */
const BOOT_TIMEOUT_MS = 90000;

const VIEWS = [
  { name: "REPL", path: "/", label: "repl" },
  { name: "RUNNER", path: "/?view=runner", label: "runner" },
].filter((v) => pageSelected(only, v.name));

let allOk = true;
for (const view of VIEWS) {
  /** `{ type: "created" | "closed", id }` 열. 페이지를 열기 전에 리스너를 걸어 첫 worker 생성 이벤트를 놓치지 않는다. */
  const events = [];
  const h = await open(new URL(view.path, baseUrl).href, {
    before: async (page) => {
      // 페이지 안 `Worker` 계측: 생성·`terminate()` 호출을 `window.__workerCalls`에 쌓는다(페이지 스크립트보다 먼저 심는다).
      await page.addInitScript(() => {
        const NativeWorker = window.Worker;
        window.__workerCalls = [];
        window.Worker = class extends NativeWorker {
          constructor(...args) {
            super(...args);
            window.__workerCalls.push("new");
            const terminate = this.terminate.bind(this);
            this.terminate = () => {
              window.__workerCalls.push("terminate");
              terminate();
            };
          }
        };
      });
      let nextId = 0;
      page.on("worker", (w) => {
        nextId += 1;
        const id = nextId;
        events.push({ type: "created", id });
        w.on("close", () => events.push({ type: "closed", id }));
      });
    },
  });
  const { page, step, waitFor, waitStatus } = h;
  const P = (id, text) => `${view.name}-${id} ${text}`;
  /** 판정 입력: 페이지 계측 + Playwright 이벤트. */
  const workerState = async () => ({
    ...tallyWorkerCalls(await page.evaluate(() => window.__workerCalls)),
    live: tallyWorkers(events).live,
    observed: tallyWorkers(events).created,
  });
  /** S01이 확인한 `new Worker` 호출 수. S02가 "불변"을 판정하는 기준이다. */
  let constructedAtSettle = -1;

  await step(P("S01", "new Worker가 2회 이상(StrictMode 이중 마운트)이고 살아 있는 worker가 1이 된다"), async () => {
    let last = { ok: false, reason: "" };
    await waitFor(
      async () => {
        last = judgeStrictModeWorkers(await workerState());
        return last.ok;
      },
      "살아 있는 worker 1개",
      BOOT_TIMEOUT_MS,
    ).catch((e) => {
      throw new Error(`${last.reason} — ${e.message}`);
    });
    const state = await workerState();
    constructedAtSettle = state.constructed;
    h.notes[P("S01", "worker")] = state;
  });

  await step(P("S02", "ready 뒤에도 살아 있는 worker 1개, new Worker 수 불변"), async () => {
    await waitStatus(["ready"], "status = ready", BOOT_TIMEOUT_MS);
    const state = await workerState();
    const verdict = judgeStrictModeWorkers(state);
    if (!verdict.ok) throw new Error(verdict.reason);
    if (state.constructed !== constructedAtSettle) throw new Error(`ready까지 worker가 더 생성됐다(${constructedAtSettle} → ${state.constructed})`);
    h.notes[P("S02", "worker")] = state;
  });

  await step(P("S03", ".xterm 요소가 1개다"), async () => {
    const count = await page.locator(".xterm").count();
    if (count !== 1) throw new Error(`.xterm 요소 ${count}개`);
  });

  await step(P("S04", "콘솔 warning 중 DisposableStore 포함이 0건이다"), async () => {
    const n = countWarnings(h.logs, "DisposableStore");
    if (n !== 0) throw new Error(`DisposableStore warning ${n}건: ${JSON.stringify(h.logs.filter((l) => l.type === "warning"))}`);
  });

  await step(P("S05", "콘솔 warning·error와 pageerror가 없다"), async () => {
    const problems = h.problemLogs();
    if (problems.length > 0 || h.pageErrors.length > 0) {
      throw new Error(JSON.stringify({ problems, pageErrors: h.pageErrors }));
    }
  });

  const ok = await h.finish({ label: `${view.label}-dev`, view: view.name });
  allOk &&= ok;
}

exitWith(allOk);
