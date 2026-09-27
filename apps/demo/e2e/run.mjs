#!/usr/bin/env node
// RD-018 DELTA-01: apps/demo/e2e 묶음 실행기(node 전용, playwright 미사용). checks/·measure/ 아래의
// 개별 스크립트가 playwright로 실제 확인을 수행하고, 이 파일은 그 스크립트들을 순서대로 부르며 서버
// (5173 dev · 4173 preview · 4174 비격리 정적)를 관리하고 결과를 대조한다.
//
// 사용법: node apps/demo/e2e/run.mjs baseline|measure|check
//
// 서버가 이미 응답하면("기존 사용") 그대로 쓰고 이 실행기가 내리지 않는다. 이 실행기가 새로 띄운
// 서버만 끝에 내린다. TRP-015(에이전트 세션에 딸린 nohup 백그라운드는 세션 종료로 죽어 로그만으론
// 정상 종료와 구별이 안 됨)를 피하려고 nohup 없이 이 프로세스의 직접 자식으로 spawn하고
// (`detached: false`), 이 프로세스가 명시적으로 SIGTERM(3초 뒤 SIGKILL)으로 끝낸다.
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile, readdir, rm, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DEV_URL, PREVIEW_URL, STATIC_URL, SETS, MEASURE_SET } from "./sets.mjs";

const execFileAsync = promisify(execFile);

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.dirname(e2eDir); // apps/demo
const repoRoot = path.resolve(demoDir, "..", ".."); // 저장소 루트
const resultsDir = process.env.E2E_RESULTS_DIR ?? path.join(e2eDir, "results");
const distDir = path.join(demoDir, "dist");

/** url에 짧은 타임아웃으로 요청해 응답이 오는지(포트가 이미 쓰이고 있는지) 본다. 응답만 오면 상태 코드는 무관하다. */
async function probe(url, timeoutMs = 1000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status;
  } catch {
    return null;
  }
}

/** url이 timeoutMs 안에 응답할 때까지 폴링한다. */
async function waitUp(url, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await probe(url, 1000);
    if (status !== null) return status;
    if (Date.now() > deadline) throw new Error(`시간 초과: ${url} 응답 없음`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** 명령 하나를 끝까지 실행하고 exit code가 0이 아니면 던진다(빌드처럼 완료를 기다려야 하는 단계용). */
function runToCompletion(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} 실패(exit ${code}, signal ${signal})`));
    });
  });
}

/** tcp `port`에서 LISTEN 중인 pid 목록(없으면 빈 배열). `lsof` 의존(TRP: pnpm 버전 관리자가 자기 재실행으로
 * 중간 프로세스를 하나 더 끼워 넣어 spawn이 돌려준 `child.pid`가 실제 서버 프로세스가 아닐 수 있다 — 그래서
 * 자식 핸들이 아니라 포트를 기준으로 실제 프로세스를 찾아 끝낸다). */
async function pidsOnPort(port) {
  try {
    const { stdout } = await execFileAsync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
    return stdout
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** `port`에서 듣고 있는 프로세스를 SIGTERM으로 내리고(3초 안에 안 끝나면 SIGKILL) 완전히 비워질 때까지 기다린다. */
async function killPort(port) {
  const pids = await pidsOnPort(port);
  if (pids.length === 0) return;
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {
      // 이미 죽었으면 무시
    }
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if ((await pidsOnPort(port)).length === 0) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const pid of await pidsOnPort(port)) {
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {
      // 이미 죽었으면 무시
    }
  }
}

// dev(5173)·preview(4173)는 이 저장소 스크립트를 그대로 쓴다. preview는 최신 dist가 있어야 하므로 이
// 실행기가 띄우는 경우에만(=포트가 비어 있을 때만) 먼저 build한다. static(4174)도 같은 dist를 쓰므로
// build는 프로세스당 한 번만(`builtPromise`로 공유) 한다.
let builtPromise = null;
function ensureBuiltOnce() {
  if (!builtPromise) builtPromise = runToCompletion("pnpm", ["--filter", "demo", "build"], repoRoot);
  return builtPromise;
}

function startDevServer() {
  spawn("pnpm", ["--filter", "demo", "dev"], { cwd: repoRoot, stdio: "ignore", detached: false });
  return { stop: () => killPort(5173) };
}

async function startPreviewServer() {
  await ensureBuiltOnce();
  spawn("pnpm", ["--filter", "demo", "preview"], { cwd: repoRoot, stdio: "ignore", detached: false });
  return { stop: () => killPort(4173) };
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/**
 * 4174: `apps/demo/dist`를 헤더 없이(COOP/COEP 등 교차출처 격리 헤더 없이) 서빙한다(`repl-check
 * not-isolated`용, 옛 `python3 -m http.server --directory` 대체). 이 프로세스 안의 `http.Server`라
 * child_process가 아니지만, 다른 서버와 같은 `{ stop }` 모양으로 감싼다.
 */
async function startStaticServer() {
  if (!existsSync(distDir)) await ensureBuiltOnce();
  const server = createServer(async (req, res) => {
    try {
      const reqPath = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
      let filePath = path.join(distDir, reqPath === "/" ? "index.html" : reqPath);
      if (!filePath.startsWith(distDir)) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (existsSync(filePath) && statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }
      const body = await readFile(filePath);
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(4174, resolve);
  });
  return { stop: () => new Promise((resolve) => server.close(() => resolve())) };
}

/**
 * 서버 하나를 준비한다. 이미 떠 있으면(probe 성공) 그대로 쓰고 `owned:false`를 돌려준다(이 실행기가
 * 내리지 않는다). 아니면 startFn으로 띄우고 url이 응답할 때까지 기다린 뒤 `owned:true`와 멈추는 함수를
 * 돌려준다.
 */
async function ensureServer(label, url, startFn, readyTimeoutMs = 60000) {
  const already = await probe(url);
  if (already !== null) {
    console.log(`[run.mjs] ${label}(${url}) 이미 떠 있음 — 기존 사용`);
    return { label, owned: false, stop: async () => {} };
  }
  console.log(`[run.mjs] ${label}(${url}) 기동 중...`);
  const started = await startFn();
  await waitUp(url, readyTimeoutMs);
  console.log(`[run.mjs] ${label}(${url}) 준비됨`);
  return {
    label,
    owned: true,
    stop: async () => {
      console.log(`[run.mjs] ${label}(${url}) 내리는 중...`);
      await started.stop();
    },
  };
}

const SERVER_STARTERS = {
  dev: () => startDevServer(),
  preview: () => startPreviewServer(),
  static: () => startStaticServer(),
};
const SERVER_URLS = { dev: DEV_URL, preview: PREVIEW_URL, static: STATIC_URL };
const SERVER_TIMEOUTS = { dev: 60000, preview: 180000, static: 30000 };

/** names에 해당하는 서버들을 준비한다. 도중 실패하면 이미 띄운 것만 내리고 다시 던진다. */
async function ensureServers(names) {
  const started = [];
  try {
    for (const name of names) {
      started.push(await ensureServer(name, SERVER_URLS[name], SERVER_STARTERS[name], SERVER_TIMEOUTS[name]));
    }
    return started;
  } catch (e) {
    await teardown(started);
    throw e;
  }
}

/** 이 실행기가 띄운(`owned`) 서버만 내린다. */
async function teardown(servers) {
  for (const s of servers) {
    if (s.owned) await s.stop();
  }
}

/**
 * `apps/demo/e2e/baseline.json`(DELTA-05가 채움, `BASELINE.md` 3절이 이 파일을 인용하는 원본): 허용 편차
 * 이름 접두어(`deviations`, 문자열 배열), 미실행 확인의 `{ prefix, rd }`(`unrun`), 다른 확인에 흡수된
 * 관찰 항목 `{ id, by }`(`absorbed`, 매칭에는 쓰지 않고 그대로 요약에 옮긴다 — 흡수된 항목은 애초에 독립된
 * 확인 이름으로 나타나지 않는다), 각 스크립트 자신의 판정이 이미 "의도된 forced 1건만" 확인으로 걸러낸
 * pageerror `{ file, count }`(`expectedPageErrors`, DELTA-03이 실측한 session-reset `crash` 절·tla `sticky`
 * 절 3건 — `pending-issues/05.md`). 이 개수만큼은 총 `pageerror` 집계에서 뺀다(그 이상 나오면 초과분이
 * 그대로 집계돼 회귀를 계속 잡아낸다). 파일이 없으면 전부 빈 값.
 */
function loadBaselineConfig() {
  const p = path.join(e2eDir, "baseline.json");
  if (!existsSync(p)) return { deviations: [], unrun: [], absorbed: [], expectedPageErrors: [] };
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  return { deviations: [], unrun: [], absorbed: [], expectedPageErrors: [], ...parsed };
}

/**
 * `results/*.json`(이 실행이 만든 것만 — `baseline` 시작 시 `results/`를 비운다)을 읽어 `failed`를
 * 모으고 `baseline.json`의 접두어와 대조해 `results/summary.json`을 쓴다. `measure/boot-press.mjs`는
 * `finish()`를 쓰지 않고 자기 `{ summary, results }` 포맷을 직접 쓴다(DELTA-04 결정, "동작 불변") — DELTA-05가
 * 이 스크립트를 baseline 세트에 배선하면서 그 포맷도 여기서 같이 해석한다.
 *
 * `runs`(`cmdBaseline()`이 기록한 `SETS` 항목별 `{ file, args, server, only, exitCode, newFiles }`)에서
 * exit ≠ 0인데 이 항목이 만든 새 결과 파일이 없는 실행(`finish()` 전 크래시 등)은 결과 파일 집계에
 * 나타나지 않으므로 `failed`에 따로 넣는다. `file`은 결과 파일 이름 대신 스크립트 경로다. 결과 파일이
 * 하나라도 있으면(정상적인 FAIL 보고) 그 파일로 집계하고 여기서 중복 항목을 만들지 않는다.
 */
async function writeSummary(runs = []) {
  const baseline = loadBaselineConfig();
  const files = (await readdir(resultsDir)).filter((f) => f.endsWith(".json") && f !== "summary.json");
  const scripts = [];
  const failed = [];
  let pageErrors = 0;
  for (const file of files) {
    const data = JSON.parse(readFileSync(path.join(resultsDir, file), "utf8"));
    if (data.summary && Array.isArray(data.results)) {
      // boot-press.mjs 전용 포맷: 표준 finish() 필드(passed/total/ok/failed/pageErrors 배열)가 없다.
      const s = data.summary;
      const okCount = s.outcomes?.OK ?? 0;
      scripts.push({ file, url: s.url, passed: okCount, total: s.trials, ok: s.allOk });
      pageErrors += Number(s.pageErrors ?? 0);
      if (!s.allOk) failed.push({ file, name: `boot-press allOk(outcomes=${JSON.stringify(s.outcomes)})` });
      continue;
    }
    scripts.push({ file, url: data.url, passed: data.passed, total: data.total, ok: data.ok });
    const rawPageErrors = Array.isArray(data.pageErrors) ? data.pageErrors.length : 0;
    const expected = baseline.expectedPageErrors.find((e) => e.file === file)?.count ?? 0;
    pageErrors += Math.max(0, rawPageErrors - expected);
    for (const name of data.failed ?? []) {
      const isDeviation = baseline.deviations.some((prefix) => name.startsWith(prefix));
      const isUnrun = baseline.unrun.some((u) => name.startsWith(u.prefix));
      if (!isDeviation && !isUnrun) failed.push({ file, name });
    }
  }
  // 결과 파일 없이 비정상 종료한 실행: 위 파일 집계로는 보이지 않아 `ok=true`로 새던 경우다.
  for (const r of runs) {
    if (r.exitCode === 0 || r.newFiles.length > 0) continue;
    const argv = [...r.args, r.only ? `ONLY=${r.only}` : ""].filter(Boolean).join(" ");
    failed.push({
      file: r.file,
      name: `결과 파일 없음(exit ${r.exitCode}, ${r.server}${argv ? `, ${argv}` : ""})`,
    });
  }
  const summary = {
    scripts,
    runs,
    failed,
    deviations: baseline.deviations,
    unrun: baseline.unrun,
    absorbed: baseline.absorbed,
    expectedPageErrors: baseline.expectedPageErrors,
    pageErrors,
    ok: failed.length === 0 && pageErrors === 0,
  };
  await mkdir(resultsDir, { recursive: true });
  writeFileSync(path.join(resultsDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(
    `[run.mjs] summary: 스크립트 ${scripts.length}개, 실패 ${failed.length}건, pageErrors ${pageErrors}, ok=${summary.ok}`,
  );
  for (const s of scripts) console.log(`  - ${s.file}: ${s.passed}/${s.total} (${s.ok ? "ok" : "fail"})`);
  for (const f of failed) if (!f.file.endsWith(".json")) console.log(`  - ${f.file}: ${f.name}`);
  return summary;
}

/**
 * `SETS` 항목 하나를 node 자식 프로세스로 돌린다(브라우저 자체는 각 스크립트가 playwright로 연다).
 * exit code로 흐름을 끊지 않는다 — FAIL이 있어도 스크립트는 정상적으로 exit 1을 돌려주는 게 정상이고,
 * 판정은 `finish()`가 쓴 `results/*.json`을 `writeSummary`가 나중에 모아서 한다. `spawn` 자체가 실패하면
 * (파일 없음 등) 그건 던진다. exit code(시그널로 끝나면 `null`)를 돌려주고, `cmdBaseline()`이 결과 파일
 * 없이 죽은 실행을 가리는 데 쓴다.
 */
function runOneScript({ file, args = [], server, only }) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(e2eDir, file);
    const env = { ...process.env };
    if (only) env.ONLY = only;
    else delete env.ONLY;
    const label = only ? ` (ONLY=${only})` : "";
    const argv = server === "dev+preview" ? [...args, DEV_URL, PREVIEW_URL] : [...args, SERVER_URLS[server]];
    console.log(`[run.mjs] ▶ ${file} ${argv.join(" ")}${label}`);
    const child = spawn(process.execPath, [scriptPath, ...argv], { cwd: e2eDir, stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      console.log(`[run.mjs] ◀ ${file}(${server}) exit ${code}${signal ? ` signal ${signal}` : ""}`);
      resolve(code);
    });
  });
}

/** `results/`의 결과 파일 이름 집합(`summary.json` 제외). 항목 실행 전후 차이로 "이 실행이 만든 새 파일"을 가린다. */
async function listResultFiles() {
  return new Set((await readdir(resultsDir)).filter((f) => f.endsWith(".json") && f !== "summary.json"));
}

async function cmdBaseline() {
  await rm(resultsDir, { recursive: true, force: true });
  await mkdir(resultsDir, { recursive: true });
  const servers = await ensureServers(["dev", "preview", "static"]);
  // SETS 항목별 exit code와 새 결과 파일. 결과 파일을 쓰기 전에 죽은 실행을 `writeSummary()`가 잡는 데 쓴다.
  const runs = [];
  try {
    for (const entry of SETS) {
      const before = await listResultFiles();
      const exitCode = await runOneScript(entry);
      const newFiles = [...(await listResultFiles())].filter((f) => !before.has(f));
      runs.push({
        file: entry.file,
        args: entry.args ?? [],
        server: entry.server,
        only: entry.only ?? null,
        exitCode,
        newFiles,
      });
    }
  } finally {
    await teardown(servers);
  }
  const summary = await writeSummary(runs);
  process.exitCode = summary.ok ? 0 : 1;
}

async function cmdMeasure() {
  const servers = await ensureServers(["dev"]);
  try {
    for (const entry of MEASURE_SET) {
      await runOneScript(entry);
    }
  } finally {
    await teardown(servers);
  }
  console.log(`[run.mjs] measure 완료(${MEASURE_SET.length}개 스크립트)`);
}

/** dir 아래(하위 폴더 포함)의 모든 `.mjs` 파일 경로. */
async function collectMjsFiles(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectMjsFiles(full)));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

/** `checks/`·`measure/`·`node/`의 `.mjs`를 `node --check`로 순회한다(정적 구문 검사만, 실행하지 않는다). */
async function cmdCheck() {
  const dirs = ["checks", "measure", "node"].map((d) => path.join(e2eDir, d));
  const files = (await Promise.all(dirs.map(collectMjsFiles))).flat();
  let failed = 0;
  for (const file of files) {
    try {
      await runToCompletion(process.execPath, ["--check", file], e2eDir);
      console.log(`OK    ${path.relative(e2eDir, file)}`);
    } catch (e) {
      failed += 1;
      console.log(`FAIL  ${path.relative(e2eDir, file)} — ${e.message}`);
    }
  }
  console.log(`[run.mjs] check: ${files.length}개 중 ${failed}개 실패`);
  process.exitCode = failed > 0 ? 1 : 0;
}

const subcommand = process.argv[2];
try {
  if (subcommand === "baseline") await cmdBaseline();
  else if (subcommand === "measure") await cmdMeasure();
  else if (subcommand === "check") await cmdCheck();
  else {
    console.error("사용법: node run.mjs baseline|measure|check");
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`[run.mjs] 실패: ${e.stack ?? e}`);
  process.exitCode = 1;
}
