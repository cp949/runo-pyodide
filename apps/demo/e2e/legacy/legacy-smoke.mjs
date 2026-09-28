// 구버전 Chromium 실측(`docs/adr/0008-chrome84-build-floor-and-pyodide-runtime-floor.md`). `docker/chromium-legacy/`로 빌드한 이미지(`chromium-legacy:<84|93|97>`)를
// `--network host`로 띄우고(CDP 포트 127.0.0.1:9222) 이 스크립트가 Playwright `chromium.connectOverCDP()`로 붙는다.
// 컨테이너 안에는 node·Playwright가 없다 — 이미지를 미리 빌드해 뒀어야 한다:
//   docker build --build-arg SNAPSHOT_TIME=<시각> --build-arg CHROMIUM_VERSION=<버전> -t chromium-legacy:<84|93|97> \
//     -f docker/chromium-legacy/Dockerfile docker/chromium-legacy
// 페이지는 `pnpm --filter demo build && pnpm --filter demo preview`(기본 4173)가 이미 떠 있어야 한다(dev 서버는
// `build.target`을 적용하지 않아 하향 검증이 안 된다).
//
// 사용: node e2e/legacy/legacy-smoke.mjs <84|93|97> [previewURL](생략 시 http://localhost:4173)
//
// 판정(ADR-0008 표):
//   84(빌드 floor): REPL·runner 뷰는 `[data-testid=status]` === "unsupported". dom-bridge 뷰는 미지원이면
//     `<PythonRunner>` 자체를 안 그려 `status` testid가 없다(`DomBridgeView.tsx`) — 대신
//     `[data-testid=supported]` === "false" + `[data-testid=unsupported]` 안내 문구로 판정한다. 셋 다
//     pageerror 0, worker 0(`window.Worker` 생성 횟수로 직접 센다 — Playwright `worker` 이벤트는 페이지를
//     일찍 닫으면 놓칠 수 있다, opus 리뷰 지적).
//   93(격리 O·wasm X): 위와 같되 `[data-testid=cross-origin-isolated]` === "true"(격리는 됐지만 wasm 미지원이라
//     `not-isolated`가 아니라 `unsupported`).
//   97(런타임 floor): runner `print(1+1)` → 출력 행 `2`, `input()` 왕복, `while True: pass` + Ctrl+C →
//     KeyboardInterrupt 트레이스백. REPL `1+1` → `2`. dom-bridge는 관찰만(GitHub 이슈 #1, 완료 조건 아님) — 상태만 기록한다.
//   CDP로 붙은 브라우저의 `/json/version` `Browser` 문자열이 요청한 버전과 일치하는지 먼저 확인한다(9222
//   포트에 이전 실행의 낡은 컨테이너가 남아 있으면 다른 버전에 거짓 통과할 수 있다, opus 리뷰 지적).
//
// 시간 판정(`docs/design/09-testing.md` 9.7): 고정 대기 없이 이벤트·상태로 판정한다(`waitFor`·상태 전이).
import { spawn } from "node:child_process";
import { open } from "../lib.mjs";
import { chromium } from "playwright";

const CDP_PORT = 9222;
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;
const VERSIONS = ["84", "93", "97"];
/** 부팅(pyodide 로드)·컨테이너 기동 대기용 정지 감지 timeout(판정선이 아니다). */
const BOOT_TIMEOUT_MS = 90000;

// 버전은 위치 인자 또는 `CHROMIUM_VERSION` 환경변수로 받는다(`package.json`의 `e2e:legacy`는
// `CHROMIUM_VERSION=84|93|97 pnpm --filter demo e2e:legacy` 형태로 호출한다). 첫 위치
// 인자가 유효한 버전이면 그것을 쓰고(그러면 다음 인자가 URL), 아니면 환경변수를 쓰고 첫 위치 인자를 URL로 본다.
const rest = process.argv.slice(2);
const versionArg = VERSIONS.includes(rest[0]) ? rest[0] : process.env.CHROMIUM_VERSION;
const urlArg = VERSIONS.includes(rest[0]) ? rest[1] : rest[0];
if (!VERSIONS.includes(versionArg)) {
  console.error(`사용법: CHROMIUM_VERSION=<${VERSIONS.join("|")}> node legacy-smoke.mjs [previewURL]`);
  console.error(`     또는: node legacy-smoke.mjs <${VERSIONS.join("|")}> [previewURL]`);
  process.exit(2);
}
const baseUrl = (urlArg ?? "http://localhost:4173").replace(/\/$/, "");

/**
 * `docker run --rm --network host --name <name> chromium-legacy:<version>`를 자식 프로세스로 띄운다. `--init`은
 * entrypoint(chromium)가 PID 1이라 신호를 무시할 수 있는 것을 막는다(opus 리뷰 지적 — 없으면 `finally`의
 * `child.kill("SIGTERM")`이 컨테이너 프로세스에 안 전달돼 다음 실행 때 9222 포트에 낡은 컨테이너가 남을 수 있다).
 */
function dockerRun(version, name) {
  const child = spawn(
    "docker",
    ["run", "--rm", "--init", "--network", "host", "--name", name, `chromium-legacy:${version}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) console.error(`컨테이너 종료(exit ${code}): ${log.slice(-2000)}`);
    else if (signal) console.error(`컨테이너가 신호로 종료됨(${signal})`);
  });
  return { child, getLog: () => log };
}

/** CDP `/json/version`이 응답할 때까지 폴링한다(컨테이너 기동 대기, 정지 감지용 timeout). */
async function waitCdpReady(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${CDP_ENDPOINT}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return await res.json();
    } catch {
      /* 컨테이너가 아직 CDP 포트를 열지 않았다 — 계속 폴링한다. */
    }
    if (Date.now() > deadline) throw new Error(`시간 초과: CDP 포트 준비 안 됨(${CDP_ENDPOINT})`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function dockerStop(name) {
  return new Promise((resolve) => {
    const p = spawn("docker", ["stop", "-t", "3", name]);
    p.on("exit", () => resolve());
    p.on("error", () => resolve());
  });
}

/**
 * `locator`의 텍스트가 `predicate`를 만족할 때까지 폴링한다(`docs/design/09-testing.md` 9.7 "조건 대기" —
 * `page.goto`의 `load` 뒤 React 초기 렌더·effect가 아직 안 끝났을 수 있어 한 번만 읽으면 낡은 값을 볼 수 있다).
 * 시간 초과면 마지막으로 읽은 값을 그대로 돌려준다(호출부가 실패로 판정해 그 값을 보고한다).
 */
async function pollText(locator, predicate, timeoutMs = 20000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await locator.textContent({ timeout: 2000 }).catch((e) => `<읽기 실패: ${e.message}>`);
    if (predicate(last)) return last;
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * 84·93 공통: REPL(`/`)·runner(`?view=runner`)·dom-bridge(`?view=dom-bridge`) 세 뷰를 한 CDP 연결(한 browser)
 * 안에서 순서대로 열어 `[data-testid=status]`가 `unsupported`인지, pageerror·worker가 0인지 본다. 세 뷰를
 * 각각 별도 CDP 연결로 열면(오래된 Chromium이 browser-level CDP 클라이언트를 여러 개 동시에 받는지 불확실—
 * H4 인접 위험) 불필요한 위험이 늘어나므로 browser 하나, page만 뷰마다 새로 연다.
 */
async function runUnsupportedSmoke(version) {
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const pageErrors = [];
  let workersCreated = 0;
  const results = {};
  let ok = true;

  // repl·runner 뷰는 `<PythonRunner>`가 항상 렌더돼 `[data-testid=status]`가 상태 문자열 그대로 나온다.
  // dom-bridge 뷰는 다르다(`DomBridgeView.tsx`): `isDomBridgeSupported()`가 false면 `<PythonRunner>` 자체를
  // 만들지 않고 `[data-testid=unsupported]` 안내 문단만 그린다 — `status` testid가 아예 없다. 그 문단 텍스트로
  // `detectRuntimeSupport()`의 세 갈래(`unsupported`·`not-isolated`·growable 실패) 중 `unsupported`인지 가른다
  // (`unsupportedReason()` 첫 문장, `DomBridgeView.tsx`).
  const DOM_BRIDGE_UNSUPPORTED_TEXT = "이 브라우저는 pyodide 런타임이 요구하는 기능을 지원하지 않아";
  const views = [
    { view: null, name: "repl", kind: "status" },
    { view: "runner", name: "runner", kind: "status" },
    { view: "dom-bridge", name: "dom-bridge", kind: "dom-bridge" },
  ];

  for (const { view, name, kind } of views) {
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    // opus 리뷰 지적: Playwright의 `worker` 이벤트는 status가 `unsupported`로 확정된 뒤 곧장 `page.close()`하면
    // 늦게 생긴 worker의 이벤트가 도착하기 전에 페이지가 닫혀 놓칠 수 있다. `window.Worker` 생성자를 페이지
    // 안에서 직접 세면(초기 스크립트라 앱 코드보다 먼저 걸린다) close 직전에 동기로 읽을 수 있어 놓치지 않는다.
    await page.addInitScript(() => {
      window.__workerCount = 0;
      const OrigWorker = window.Worker;
      window.Worker = new Proxy(OrigWorker, {
        construct(target, args) {
          window.__workerCount += 1;
          return Reflect.construct(target, args);
        },
      });
    });
    const url = view ? `${baseUrl}/?view=${view}` : `${baseUrl}/`;
    await page.goto(url, { waitUntil: "load", timeout: BOOT_TIMEOUT_MS });
    const coi = await page
      .locator('[data-testid="cross-origin-isolated"]')
      .textContent({ timeout: 10000 })
      .catch((e) => `<읽기 실패: ${e.message}>`);
    if (kind === "status") {
      // `createRunner`는 `detectRuntimeSupport()`를 생성 시점에 동기로 판정해 초기 status에 바로 반영한다
      // (`loading`을 거치지 않는다, `runner.ts` "let status = supported ? loading : support") — 그래도
      // React 초기 커밋이 `load` 이벤트와 정확히 같은 tick이 아닐 수 있어 한 번만 읽지 않고 짧게 폴링한다.
      const status = await pollText(page.locator('[data-testid="status"]'), (t) => t === "unsupported", 15000);
      results[name] = { status, coi };
      if (status === "unsupported") console.log(`PASS  ${name}: status=unsupported`);
      else {
        ok = false;
        console.log(`FAIL  ${name}: status=${JSON.stringify(status)}(기대 "unsupported")`);
      }
    } else {
      const supported = await pollText(page.locator('[data-testid="supported"]'), (t) => t === "false", 15000);
      const reason = await page
        .locator('[data-testid="unsupported"]')
        .textContent({ timeout: 10000 })
        .catch((e) => `<읽기 실패: ${e.message}>`);
      results[name] = { supported, reason, coi };
      if (supported === "false" && String(reason).startsWith(DOM_BRIDGE_UNSUPPORTED_TEXT)) {
        console.log(`PASS  ${name}: supported=false, unsupported 안내(wasm 미지원)`);
      } else {
        ok = false;
        console.log(`FAIL  ${name}: supported=${JSON.stringify(supported)} reason=${JSON.stringify(reason)}`);
      }
    }
    workersCreated += await page.evaluate(() => window.__workerCount ?? 0);
    await page.close();
  }

  if (version === "93") {
    if (results.repl.coi === "true") console.log(`PASS  cross-origin-isolated=true(격리 O·wasm X 구간)`);
    else {
      ok = false;
      console.log(`FAIL  cross-origin-isolated=${JSON.stringify(results.repl.coi)}(기대 "true")`);
    }
  }

  if (workersCreated === 0) console.log(`PASS  workers.created=0`);
  else {
    ok = false;
    console.log(`FAIL  workers.created=${workersCreated}(기대 0)`);
  }
  if (pageErrors.length === 0) console.log(`PASS  pageErrors=0`);
  else {
    ok = false;
    console.log(`FAIL  pageErrors=${JSON.stringify(pageErrors)}`);
  }

  await browser.close();
  return { ok, results, pageErrors, workersCreated };
}

/** 97(런타임 floor): runner `print(1+1)`·`input()` 왕복·`while True: pass` + Ctrl+C, REPL `1+1`. dom-bridge는 관찰만. */
async function runRuntimeFloorSmoke() {
  let ok = true;

  // runner 뷰
  {
    const h = await open(`${baseUrl}/?view=runner`, { cdpEndpoint: CDP_ENDPOINT });
    const { page, waitFor, rows, trimmedRows, tail, focus, type, enter, ctrlC } = h;
    const statusText = () => page.locator('[data-testid="status"]').textContent();
    const resultText = () => page.locator('[data-testid="result"]').textContent();
    async function waitStatus(values, timeoutMs = BOOT_TIMEOUT_MS) {
      await waitFor(async () => values.includes(await statusText()), `status가 ${JSON.stringify(values)} 중 하나`, timeoutMs);
    }
    async function waitResult(timeoutMs = 30000) {
      await waitFor(async () => (await resultText()) !== "", "result 채워짐", timeoutMs);
      return JSON.parse(await resultText());
    }
    async function startRun(code) {
      await page.fill('[data-testid="code"]', code);
      await page.click('[data-testid="run"]');
    }

    try {
      await waitStatus(["ready"], BOOT_TIMEOUT_MS);
      console.log("PASS  runner: 초기 status=ready");
    } catch (e) {
      ok = false;
      console.log(`FAIL  runner 초기: ${e.message}`);
    }

    await (async () => {
      try {
        await startRun('print(1+1)');
        const r = await waitResult();
        if (r.kind !== "ok") throw new Error(`result=${JSON.stringify(r)}`);
        // `result`(JS 상태)와 xterm 렌더는 다른 tick일 수 있다 — 단발 읽기 대신 조건 대기(9.7, Ctrl+C
        // 판정과 같은 이유로 opus 리뷰가 지적한 레이스).
        await waitFor(async () => (await trimmedRows()).includes("2"), "출력 행 2", 5000);
        console.log("PASS  runner: print(1+1) → 2");
      } catch (e) {
        ok = false;
        console.log(`FAIL  runner print(1+1): ${e.message}`);
      }
    })();

    await (async () => {
      try {
        await waitStatus(["ready"]);
        await startRun('name = input("이름: ")\nprint("안녕 " + name)');
        await waitStatus(["waiting-input"]);
        await h.waitPrompt("이름:", 15000);
        await focus();
        await type("kim");
        await enter();
        const r = await waitResult();
        if (r.kind !== "ok") throw new Error(`result=${JSON.stringify(r)}`);
        await waitFor(async () => (await trimmedRows()).includes("안녕 kim"), "출력 행 안녕 kim", 5000);
        console.log("PASS  runner: input() 왕복");
      } catch (e) {
        ok = false;
        console.log(`FAIL  runner input(): ${e.message}`);
      }
    })();

    await (async () => {
      try {
        await waitStatus(["ready"]);
        await startRun('print("go")\nwhile True: pass');
        await waitFor(async () => (await rows()).some((r) => r === "go"), "출력 행 go", 30000);
        await waitStatus(["running"]);
        await focus();
        await ctrlC();
        const r = await waitResult(BOOT_TIMEOUT_MS);
        if (r.kind !== "interrupted" || !String(r.traceback ?? "").endsWith("KeyboardInterrupt\n")) {
          throw new Error(`result=${JSON.stringify(r)}`);
        }
        // `result`(JS 상태) 갱신과 xterm 화면 렌더는 서로 다른 tick일 수 있다 — 화면도 조건 대기로 확인한다
        // (`docs/design/09-testing.md` 9.7, 고정 후 단발 읽기 금지).
        await waitFor(async () => (await tail(1))[0] === "KeyboardInterrupt", "마지막 행이 KeyboardInterrupt", 5000);
        console.log("PASS  runner: while True: pass + Ctrl+C → KeyboardInterrupt");
      } catch (e) {
        ok = false;
        console.log(`FAIL  runner Ctrl+C: ${e.message}`);
      }
    })();

    // Playwright 1.63의 `connectOverCDP` browser.close()는 transport만 끊고 원격 페이지는 안 닫는다(opus
    // 리뷰 확인, `coreBundle.js` — launch()와 다르다) — 다음 `open()`이 새 페이지를 여는 동안 이 페이지의
    // pyodide worker가 계속 살아 있지 않도록 명시적으로 닫는다.
    await h.page.close();
    await h.browser.close();
  }

  // REPL 뷰
  {
    const h = await open(`${baseUrl}/`, { cdpEndpoint: CDP_ENDPOINT });
    const { tail, type, enter, waitPrompt } = h;
    try {
      await waitPrompt(">>>", BOOT_TIMEOUT_MS);
      await type("1+1");
      await enter();
      await waitPrompt(">>>");
      // 배너(행 0~1) 뒤 첫 프롬프트가 행 2이므로 `1+1` 제출 뒤 꼬리 3행은 [">>> 1+1", "2", ">>>"]다(커서는
      // 자연히 행 4 — repl-check.mjs① 검증). 커서 절대 행은 이 판정과 무관해 보지 않는다.
      const t = await tail(3);
      if (t[0] !== ">>> 1+1" || t[1] !== "2" || t[2] !== ">>>") throw new Error(`행=${JSON.stringify(t)}`);
      console.log("PASS  REPL: 1+1 → 2");
    } catch (e) {
      ok = false;
      console.log(`FAIL  REPL 1+1: ${e.message}`);
    }
    await h.page.close();
    await h.browser.close();
  }

  // dom-bridge 뷰(H5, 관찰만 — 완료 조건 아님. 실패해도 ok를 바꾸지 않는다)
  {
    const h = await open(`${baseUrl}/?view=dom-bridge`, { cdpEndpoint: CDP_ENDPOINT });
    try {
      // `status`는 부팅이 끝나야 `ready`/`load-failed`로 정착한다 — 부팅 전 스냅샷(`loading`)을 관찰로
      // 오인하지 않도록 짧게 폴링한다(완료 조건이 아니므로 실패해도 기록만 하고 `ok`는 바꾸지 않는다).
      const status = await pollText(
        h.page.locator('[data-testid="status"]'),
        (t) => t === "ready" || t === "load-failed",
        20000,
      );
      const supported = await h.page.locator('[data-testid="supported"]').textContent({ timeout: 5000 }).catch(() => "<없음>");
      console.log(`관찰  dom-bridge(97, H5, 완료 조건 아님): status=${status} supported=${supported}`);
    } catch (e) {
      console.log(`관찰  dom-bridge(97) 읽기 실패(완료 조건 아님): ${e.message}`);
    }
    await h.page.close();
    await h.browser.close();
  }

  return { ok };
}

const containerName = `chromium-legacy-${versionArg}-${process.pid}`;
const { child, getLog } = dockerRun(versionArg, containerName);
let ok = false;
try {
  const version = await waitCdpReady(BOOT_TIMEOUT_MS);
  console.log(`CDP 준비됨: ${version.Browser}`);
  // opus 리뷰 지적(Major): 9222에서 응답하는 브라우저가 이번에 띄운 컨테이너라는 보장이 없었다 — `--network
  // host`에서 이전 실행이 비정상 종료해 컨테이너가 남아 있거나(신호가 PID 1에 안 먹혀 `finally`가 못 지운
  // 경우), 다른 프로세스가 9222를 먼저 쓰고 있으면 그 브라우저에 붙어 버전이 다른 채로 거짓 통과할 수 있다.
  const versionMatch = new RegExp(`^HeadlessChrome/${versionArg}\\.`).test(version.Browser ?? "");
  if (!versionMatch) {
    throw new Error(
      `CDP로 붙은 브라우저(${version.Browser})가 요청한 버전(${versionArg})과 다르다 — ` +
        `9222 포트에 이전 실행의 낡은 컨테이너나 다른 프로세스가 떠 있을 수 있다.`,
    );
  }

  const result =
    versionArg === "97" ? await runRuntimeFloorSmoke() : await runUnsupportedSmoke(versionArg);
  ok = result.ok;
} catch (e) {
  console.error(`실패: ${e.stack ?? e}`);
  console.error(`컨테이너 로그(끝부분): ${getLog().slice(-2000)}`);
} finally {
  await dockerStop(containerName);
  child.kill("SIGTERM");
}

console.log(ok ? `Chrome ${versionArg}: 통과` : `Chrome ${versionArg}: 실패`);
process.exit(ok ? 0 : 1);
