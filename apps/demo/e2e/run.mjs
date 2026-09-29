#!/usr/bin/env node
// RD-018: apps/demo/e2e 묶음 실행기. node 전용이며 playwright를 쓰지 않는다.
// - `checks/`·`measure/`의 개별 스크립트가 playwright로 실제 확인을 수행한다.
// - 이 파일은 그 스크립트를 순서대로 부른다.
// - 서버를 관리하고 결과를 대조한다. 서버는 5173 dev · 4173 preview · 4174 비격리 정적이다.
//
// 사용법: node apps/demo/e2e/run.mjs baseline|measure|check
// - `baseline`: `SETS` 전체를 돌리고 `results/summary.json`을 쓴다.
// - `measure`: `MEASURE_SET`을 돌린다. exit code만 본다.
// - `check`: `checks/`·`measure/`·`node/`의 `.mjs`를 `node --check`로 검사한다.
//
// 서버 수명:
// - 이미 응답하는 서버는 그대로 쓰고 내리지 않는다("기존 사용").
// - 이 실행기가 띄운 서버만 끝에 내린다.
// - nohup을 쓰지 않고 이 프로세스의 직접 자식으로 spawn한다(`detached: false`). TRP-015.
// - 종료는 이 프로세스가 명시적으로 SIGTERM으로 한다. 3초 안에 안 끝나면 SIGKILL이다.
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

/** url에 짧은 타임아웃으로 요청해 응답 상태 코드를 돌려준다. 응답이 없으면 null. 포트가 쓰이는지 보는 데 쓴다. */
async function probe(url, timeoutMs = 1000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status;
  } catch {
    return null;
  }
}

/** url이 응답할 때까지 폴링해 상태 코드를 돌려준다. `timeoutMs`를 넘기면 던진다. */
async function waitUp(url, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await probe(url, 1000);
    if (status !== null) return status;
    if (Date.now() > deadline) throw new Error(`시간 초과: ${url} 응답 없음`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** 명령 하나를 끝까지 실행한다. exit code가 0이 아니면 던진다. 빌드처럼 완료를 기다릴 단계에 쓴다. */
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

/**
 * tcp `port`에서 LISTEN 중인 pid 목록. 없으면 빈 배열. `lsof`에 의존한다.
 * pnpm이 자기를 다시 실행해 중간 프로세스를 끼울 수 있다(TRP-027). `spawn`이 돌려준 `child.pid`는 실제 서버가 아닐 수 있다.
 * 그래서 자식 핸들이 아니라 포트로 실제 프로세스를 찾는다.
 */
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

/** `port`에서 듣는 프로세스에 SIGTERM을 보내고 포트가 빌 때까지 기다린다. 3초 안에 안 비면 SIGKILL을 보낸다. */
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

// dev(5173)·preview(4173)는 저장소의 pnpm 스크립트를 그대로 쓴다.
// preview는 최신 dist가 필요하다. 이 실행기가 preview를 띄울 때(포트가 비어 있을 때)만 먼저 build한다.
// static(4174)은 dist가 없을 때만 build한다.
// build는 프로세스당 한 번이다. `builtPromise`로 공유한다.
let builtPromise = null;

/** `pnpm --filter demo build`를 프로세스당 한 번만 돌린다. */
function ensureBuiltOnce() {
  if (!builtPromise) builtPromise = runToCompletion("pnpm", ["--filter", "demo", "build"], repoRoot);
  return builtPromise;
}

/** dev 서버(5173)를 띄운다. `stop`은 포트로 찾아 내린다. */
function startDevServer() {
  spawn("pnpm", ["--filter", "demo", "dev"], { cwd: repoRoot, stdio: "ignore", detached: false });
  return { stop: () => killPort(5173) };
}

/** build 뒤 preview 서버(4173)를 띄운다. */
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
 * 4174: `apps/demo/dist`를 교차출처 격리 헤더(COOP/COEP) 없이 서빙한다. `repl-check not-isolated`·`runner-check not-isolated`용이다.
 * 이 프로세스 안의 `http.Server`라 child_process가 아니다. 다른 서버와 같은 `{ stop }` 모양으로 돌려준다.
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
 * 서버 하나를 준비한다.
 * - 이미 떠 있으면(`probe` 성공) 그대로 쓰고 `owned: false`를 돌려준다. 이 실행기가 내리지 않는다.
 * - 아니면 `startFn`으로 띄우고 url이 응답할 때까지 기다린다. `owned: true`와 `stop`을 돌려준다.
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

/** `names`의 서버들을 순서대로 준비한다. 도중에 실패하면 이미 띄운 서버만 내리고 다시 던진다. */
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
 * `apps/demo/e2e/baseline.json`을 읽는다. `BASELINE.md` 3절이 이 파일을 인용하는 원본이다.
 *
 * 필드:
 * - `deviations`: 허용 편차의 확인 이름 접두어(문자열 배열).
 * - `unrun`: 미실행 확인 `{ prefix, rd }`.
 * - `absorbed`: 다른 확인에 흡수된 관찰 항목 `{ id, by }`. 매칭에 쓰지 않고 요약에 그대로 옮긴다.
 * - `expectedPageErrors`: 의도된 pageerror `{ file, count }`. 해당 스크립트 자신의 판정이 이미 확인한 건수다.
 *   - 실측: session-reset `crash` 절과 tla `sticky` 절의 3건.
 *   - 이 건수만큼 총 `pageerror` 집계에서 뺀다. 초과분은 그대로 집계돼 회귀를 잡는다.
 *
 * 파일이 없으면 모든 필드가 빈 배열이다.
 */
function loadBaselineConfig() {
  const p = path.join(e2eDir, "baseline.json");
  if (!existsSync(p)) return { deviations: [], unrun: [], absorbed: [], expectedPageErrors: [] };
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  return { deviations: [], unrun: [], absorbed: [], expectedPageErrors: [], ...parsed };
}

/**
 * `results/*.json`을 읽어 `failed`를 모으고 `baseline.json`의 접두어와 대조한 뒤 `results/summary.json`을 쓴다.
 * `baseline` 시작 시 `results/`를 비우므로 이 실행이 만든 파일만 집계한다.
 *
 * 결과 파일 형식은 둘이다.
 * - 표준: `finish()`가 쓴다. `passed`·`total`·`ok`·`failed`·`pageErrors`를 담는다.
 * - `measure/boot-press.mjs` 전용: `{ summary, results }`. `finish()`를 쓰지 않는다. 여기서 같이 해석한다.
 *
 * `runs`는 `cmdBaseline()`이 `SETS` 항목별로 기록한 `{ file, args, server, only, exitCode, newFiles }`다.
 * - exit ≠ 0이고 새 결과 파일이 없는 실행(`finish()` 전 크래시 등)은 파일 집계에 안 나타난다. `failed`에 따로 넣는다.
 * - 이때 `file`은 결과 파일 이름이 아니라 스크립트 경로다.
 * - 결과 파일이 하나라도 있으면(정상적인 FAIL 보고) 그 파일로 집계한다. 중복 항목을 만들지 않는다.
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
 * `SETS` 항목 하나를 node 자식 프로세스로 돌린다. 브라우저는 각 스크립트가 playwright로 연다.
 * - exit code로 흐름을 끊지 않는다. FAIL이 있으면 스크립트가 exit 1을 돌려주는 것이 정상이다.
 * - 판정은 나중에 `writeSummary`가 `results/*.json`을 모아서 한다.
 * - `spawn` 자체가 실패하면(파일 없음 등) 던진다.
 * - exit code를 돌려준다. 시그널로 끝나면 `null`이다. `cmdBaseline()`이 결과 파일 없이 죽은 실행을 가리는 데 쓴다.
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

/** `results/`의 결과 파일 이름 집합(`summary.json` 제외). 항목 실행 전후의 차이로 그 실행이 만든 새 파일을 가린다. */
async function listResultFiles() {
  return new Set((await readdir(resultsDir)).filter((f) => f.endsWith(".json") && f !== "summary.json"));
}

/**
 * `baseline` 하위 명령. `results/`를 비우고 서버 3개를 준비한 뒤 `SETS`를 순서대로 돌리고 요약을 쓴다.
 * 요약이 `ok`가 아니면 exit code를 1로 둔다.
 */
async function cmdBaseline() {
  await rm(resultsDir, { recursive: true, force: true });
  await mkdir(resultsDir, { recursive: true });
  const servers = await ensureServers(["dev", "preview", "static"]);
  // `SETS` 항목별 exit code와 새 결과 파일. 결과 파일을 쓰기 전에 죽은 실행을 `writeSummary()`가 잡는 데 쓴다.
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

/** `measure` 하위 명령. dev 서버를 준비하고 `MEASURE_SET`을 순서대로 돌린다. 결과 JSON은 대조하지 않는다. */
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

/** `dir` 아래(하위 폴더 포함)의 모든 `.mjs` 파일 경로. `dir`이 없으면 빈 배열. */
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

/** `check` 하위 명령. `checks/`·`measure/`·`node/`의 `.mjs`를 `node --check`로 검사한다. 구문만 보고 실행하지 않는다. */
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
