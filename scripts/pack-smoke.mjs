#!/usr/bin/env node
// tarball 스모크: xterm-readline·core·terminal·repl·react·dom-bridge를 `pnpm pack`으로 묶어 저장소 밖 임시 소비자 프로젝트에 설치하고
// 실제로 쓸 수 있는지 본다. 소비자는 둘이다: 주 소비자(dom-bridge를 뺀 다섯 패키지)와 dom-bridge 소비자(core + dom-bridge). coincident는
// dom-bridge에만 있어야 하므로, 주 소비자 트리의 "coincident·reflected-ffi 없음" 검사는 그대로 두고(다른 패키지의 금지 보장 유지)
// dom-bridge는 따로 설치해 자기 검사(정확한 버전·CSP 정적 규칙)를 받는다(RD-023). 절차·근거: `docs/design/09-testing.md` 9.8.3.
//   1. 여섯 패키지 `pnpm pack`, tarball 매니페스트 정적 검사(`pack-smoke/manifest.mjs`: `workspace:`·`catalog:` 잔존, `exports` 대상이
//      tarball 파일에 있는지, 패키지별 정책 표 `MANIFEST_POLICY`)
//   2. 진입점 도출: tarball `exports` 키(`null`·`./package.json` 제외)와 아래 `ENTRY_EXPORTS` 선언을 양방향 대조한다
//   3. 소비자마다(`pack-smoke/consumer.mjs`): 작성(`file:` tarball + 작업공간 파일 `overrides`) → `pnpm install` → node ESM `import`(도출
//      진입점의 기대 export) → `tsc --noEmit`(`skipLibCheck: false`) → Vite dev 해석(client 환경, Node·tsc가 쓰지 않는 `development`
//      조건의 결함을 잡는다, 이슈 react-package-followups/05)
//   4. 설치된 트리 검사: 주 소비자 = `coincident`·`reflected-ffi` 없음(lockfile·`.pnpm`·설치된 dist 문자열), dom-bridge 소비자 =
//      coincident·reflected-ffi 포크(file: 로컬 경로) 설치 하나씩, dom-bridge dist의 CSP 정적 규칙, core dist 엄격 검사
// 사용: pnpm smoke:pack (= pnpm build && node scripts/pack-smoke.mjs). 약 15초, L0 수동 실행이며 `pnpm test`·turbo 기본
// 파이프라인에는 넣지 않는다. 네트워크가 필요하다(`@xterm/xterm`·`@xterm/addon-fit`·`react`·`react-dom`·`string-width`·`typescript`·`pyodide`를 레지스트리에서 받는다,
// `--prefer-offline`이라 pnpm 저장소에 있으면 다시 받지 않는다).
// 환경 변수: SMOKE_TMPDIR(임시 폴더를 만들 상위 경로, 기본 os.tmpdir()), KEEP=1(성공해도 임시 폴더를 지우지 않음).
// 임시 폴더는 성공하면 지운다. 실패하면 원인 조사용으로 남기고 경로를 출력한다.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { smokeConsumer } from "./pack-smoke/consumer.mjs";
import {
  checkPackedManifest,
  collectExportTargets,
  compareEntryDeclarations,
  entrySpecifiers,
} from "./pack-smoke/manifest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN = ["coincident", "reflected-ffi"];

const READLINE = "@cp949/runo-xterm-readline";
const CORE = "@cp949/runo-pyodide-core";
const TERMINAL = "@cp949/runo-pyodide-terminal";
const REPL = "@cp949/runo-pyodide-repl";
const REACT = "@cp949/runo-pyodide-repl-react";
const DOM_BRIDGE = "@cp949/runo-pyodide-dom-bridge";
const DOM_BRIDGE_DIR = "packages/pyodide-dom-bridge";

/** pack 대상(의존 순서). `dir`은 저장소 루트 기준. */
const PACKAGES = [
  { name: READLINE, dir: "packages/xterm-readline" },
  { name: CORE, dir: "packages/pyodide-core" },
  { name: TERMINAL, dir: "packages/pyodide-terminal" },
  { name: REPL, dir: "packages/pyodide-repl" },
  { name: REACT, dir: "packages/pyodide-repl-react" },
  { name: DOM_BRIDGE, dir: DOM_BRIDGE_DIR },
];

/**
 * 진입점별 기대 export(이름 → typeof). 진입점 목록 자체는 tarball `exports`에서 도출하고 이 표와 양방향으로 맞아야 한다 — 진입점을
 * 더하거나 지우면 이 표도 고친다(안 고치면 설치 전에 실패한다).
 */
const ENTRY_EXPORTS = {
  [READLINE]: {
    Readline: "function",
    ReadCancelledError: "function",
    History: "function",
  },
  [CORE]: {
    startCoreSession: "function",
    composeRpcHandlers: "function",
    createRpc: "function",
    postInitFrame: "function",
    PYODIDE_VERSION: "string",
    DEFAULT_PYODIDE_INDEX_URL: "string",
  },
  [`${CORE}/worker`]: {
    runWorker: "function",
    bootWorker: "function",
    createCoreConsole: "function",
    composeRpcHandlers: "function",
  },
  [TERMINAL]: {
    createTerminalRunner: "function",
    RunRejectedError: "function",
  },
  [`${TERMINAL}/internal`]: {
    createTerminalSinks: "function",
    createTerminalSurface: "function",
    createPromptRow: "function",
    splitAboveRead: "function",
    rewindTail: "function",
    createSelectionCopy: "function",
    decideKey: "function",
  },
  [REPL]: { createRepl: "function", DEFAULT_PYODIDE_INDEX_URL: "string" },
  [`${REPL}/worker`]: { runReplWorker: "function" },
  [REACT]: {
    PythonRepl: "function",
    PythonRunner: "function",
    usePythonRunner: "function",
    RunRejectedError: "function",
  },
  [DOM_BRIDGE]: {
    createBridgeMain: "function",
    isDomBridgeSupported: "function",
  },
  [`${DOM_BRIDGE}/worker`]: { bridge: "function", domBridge: "function" },
};

/** 평가 때 worker 전역의 `addEventListener`를 부르는 진입점. Node import 검사가 그 전역만 스텁으로 세운다. */
const NEEDS_WORKER_GLOBAL = new Set([`${DOM_BRIDGE}/worker`]);

/**
 * 소비자 선언. 외부 의존 버전은 저장소 매니페스트가 원천이다(`versions`, 스모크가 따로 정하지 않는다). `treeChecks`는 설치된 트리
 * 검사(소비자마다 다르다).
 */
const consumers = (versions) => [
  {
    label: "주 소비자",
    dir: "consumer",
    // coincident는 dom-bridge에만 있어야 하므로 dom-bridge를 뺀다(금지 판정이 이 트리에 걸린다).
    packages: [READLINE, CORE, TERMINAL, REPL, REACT],
    dependencies: {
      "@xterm/xterm": versions.xterm,
      react: versions.react,
      "react-dom": versions.reactDom,
      // core `worker.d.mts`가 `pyodide`·`pyodide/ffi` 타입을 import한다(core는 pyodide를 배포 의존으로 선언하지 않는다).
      pyodide: versions.pyodide,
    },
    devDependencies: { "@types/react": versions.typesReact },
    checkTs: [
      `import { Readline, type ReadOptions } from "@cp949/runo-xterm-readline";`,
      `import { startCoreSession, composeRpcHandlers as composeMain, type MainDriver } from "@cp949/runo-pyodide-core";`,
      `import { runWorker, createCoreConsole, type WorkerDriver, type PyodideConsoleProxy } from "@cp949/runo-pyodide-core/worker";`,
      `import { createTerminalSinks, type TerminalSinks } from "@cp949/runo-pyodide-terminal/internal";`,
      `import { createTerminalRunner, type TerminalRunnerHandle, type TerminalRunnerOptions } from "@cp949/runo-pyodide-terminal";`,
      `import { createRepl, type ReplHandle, type ReplOptions } from "@cp949/runo-pyodide-repl";`,
      `import { runReplWorker } from "@cp949/runo-pyodide-repl/worker";`,
      `import * as reactPackage from "@cp949/runo-pyodide-repl-react";`,
      `import type { PythonReplHandle, PythonReplProps, PythonRunnerHandle, PythonRunnerProps, UsePythonRunnerOptions, UsePythonRunnerResult } from "@cp949/runo-pyodide-repl-react";`,
      `import type { PyodideInterface } from "pyodide";`,
      ``,
      `// core worker 타입이 소비자의 pyodide 타입으로 해석되는지(any로 무너지지 않는지) 본다.`,
      `const makeConsole: (pyodide: PyodideInterface) => PyodideConsoleProxy = (pyodide) =>`,
      `  createCoreConsole(pyodide, { write() {}, writeError() {} } as never);`,
      `export const used: unknown[] = [Readline, startCoreSession, composeMain, runWorker, makeConsole, createTerminalSinks, createTerminalRunner, createRepl, runReplWorker, reactPackage];`,
      `export type Used = [ReadOptions, MainDriver, WorkerDriver, TerminalSinks, TerminalRunnerHandle, TerminalRunnerOptions, ReplHandle, ReplOptions, PythonReplHandle, PythonReplProps, PythonRunnerHandle, PythonRunnerProps, UsePythonRunnerOptions, UsePythonRunnerResult];`,
      // 컴포넌트 props가 소비자의 xterm·react 타입으로 해석되는지(any로 무너지지 않는지, 필수 옵션·init 전용 옵션이 맞는지) 본다.
      `export const runnerProps: PythonRunnerProps = { createWorker: () => new Worker("worker.js"), terminalOptions: { cols: 80, rows: 24, cursorBlink: true }, fit: false, onStatus: (status) => void status.length };`,
      `// @ts-expect-error createWorker는 필수다`,
      `export const missingWorker: PythonRunnerProps = {};`,
      `export const replProps: PythonReplProps = { createWorker: () => new Worker("worker.js"), terminalOptions: { cols: 80, rows: 24, cursorBlink: true }, fit: false, topLevelAwait: true, onStatus: (status) => void status.length };`,
      `// @ts-expect-error createWorker는 필수다`,
      `export const missingReplWorker: PythonReplProps = {};`,
      `export const replRun = (handle: PythonReplHandle) => handle.runSource("1 + 1");`,
    ],
    // core가 인라인한 고정 버전이 catalog 버전과 같은지(소비자 설치 뒤에도 값이 유지되는지) 본다.
    importAsserts: [
      `const core = await import("@cp949/runo-pyodide-core");`,
      `if (core.PYODIDE_VERSION !== ${JSON.stringify(versions.pyodide)}) { failed = true; console.error(\`FAIL PYODIDE_VERSION: \${core.PYODIDE_VERSION}\`); }`,
      `if (core.DEFAULT_PYODIDE_INDEX_URL !== \`https://cdn.jsdelivr.net/pyodide/v\${core.PYODIDE_VERSION}/full/\`) { failed = true; console.error(\`FAIL DEFAULT_PYODIDE_INDEX_URL: \${core.DEFAULT_PYODIDE_INDEX_URL}\`); }`,
    ],
    treeChecks: checkNoSyncBridge,
  },
  // coincident는 이 소비자 트리에만 있어야 하고, dom-bridge는 coincident·reflected-ffi 포크를 file: 로컬 경로로 끌고 온다.
  // 위 주 소비자의 "coincident 없음" 검사는 그대로라 core·terminal·repl·react·xterm-readline의 금지 보장은 약해지지 않는다.
  {
    label: "dom-bridge 소비자",
    dir: "consumer-dom-bridge",
    // dom-bridge는 core를 peer로 요구한다.
    packages: [CORE, DOM_BRIDGE],
    // core `worker.d.mts`가 `pyodide` 타입을 import한다(주 소비자와 같은 이유).
    dependencies: { pyodide: versions.pyodide },
    devDependencies: {},
    checkTs: [
      `import { createBridgeMain, isDomBridgeSupported, type BridgeMain, type BridgeMainWorker } from "@cp949/runo-pyodide-dom-bridge";`,
      `import { bridge, domBridge, type WorkerBridge } from "@cp949/runo-pyodide-dom-bridge/worker";`,
      `import { runWorker, runDriver, type WorkerPlugin } from "@cp949/runo-pyodide-core/worker";`,
      ``,
      `// dom-bridge 플러그인이 소비자의 core 타입(\`WorkerPlugin\`)으로 해석되는지(any로 무너지지 않는지) 본다.`,
      `export const plugin: WorkerPlugin = domBridge();`,
      `export const start = () => runWorker({ driver: runDriver, plugins: [plugin] });`,
      `export const supported: boolean = isDomBridgeSupported();`,
      `export const main: BridgeMain = createBridgeMain();`,
      `export const makeWorker = (): BridgeMainWorker => new main.Worker("worker.js", { type: "module" });`,
      `export const loadBridge: () => Promise<WorkerBridge> = bridge;`,
      `// @ts-expect-error coincident 옵션(serviceWorker 등)은 통과시키지 않는다`,
      `export const withOptions = createBridgeMain({ serviceWorker: "/sw.js" });`,
      `export const readFfi = async () =>`,
      `  // @ts-expect-error ffi(임의 코드 평가 등)는 노출하지 않는다`,
      `  (await bridge()).ffi;`,
    ],
    importAsserts: [
      `const worker = await import("@cp949/runo-pyodide-dom-bridge/worker");`,
      `if (worker.domBridge().name !== "dom-bridge") { failed = true; console.error("FAIL domBridge().name"); }`,
    ],
    treeChecks: checkBridgeTree,
  },
];

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/**
 * `pnpm-workspace.yaml`의 `catalog:` 절에서 `name`의 버전을 읽는다(pyodide 버전의 유일한 원천, ADR-0007). YAML 파서 의존을
 * 늘리지 않으려고 `catalog:` 절(들여쓴 줄)에서 `name: <버전>` 한 줄만 정규식으로 찾고, 못 찾으면 던진다.
 */
function readCatalogVersion(name) {
  const yaml = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const section = yaml.match(
    /^catalog:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$)|[ \t]*\r?\n)*)/m,
  );
  const line = section?.[1].match(
    new RegExp(`^[ \\t]+["']?${name}["']?:[ \\t]*["']?([^\\s"'#]+)`, "m"),
  );
  if (!line)
    throw new Error(
      `pnpm-workspace.yaml catalog:에서 ${name} 버전을 찾지 못했다`,
    );
  return line[1];
}

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const step = (message) => console.log(`\n[${elapsed()}] ${message}`);

/** 자식 프로세스를 실행하고 출력을 그대로 흘린다. 실패하면 던진다. */
function run(command, args, cwd) {
  console.log(`$ ${command} ${args.join(" ")}   (cwd: ${cwd})`);
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, CI: "true" },
  });
}

/** 패키지 폴더 이름(scope 제거·`/` → `-`)과 버전으로 `pnpm pack`이 만드는 tarball 파일명을 만든다. */
const tarballName = (name, version) =>
  `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;

/** 주 소비자 트리 검사: 설치된 트리에 coincident·reflected-ffi가 없다(lockfile·`node_modules` 이름·설치된 dist 문자열). */
function checkNoSyncBridge(dir, packages) {
  step("설치된 트리에 coincident·reflected-ffi 없음");
  const lock = readFileSync(join(dir, "pnpm-lock.yaml"), "utf8").toLowerCase();
  const storeNames = readdirSync(join(dir, "node_modules/.pnpm")).map((entry) =>
    entry.toLowerCase(),
  );
  const topLevel = readdirSync(join(dir, "node_modules")).map((entry) =>
    entry.toLowerCase(),
  );
  for (const needle of FORBIDDEN) {
    if (lock.includes(needle))
      throw new Error(`pnpm-lock.yaml에 ${needle}이(가) 있다`);
    const hit = [...storeNames, ...topLevel].find((entry) =>
      entry.includes(needle),
    );
    if (hit) throw new Error(`node_modules에 ${needle}이(가) 있다: ${hit}`);
  }
  console.log(
    `통과: lock·node_modules(.pnpm ${storeNames.length}개 항목)에 ${FORBIDDEN.join("·")} 없음`,
  );
  // 설치된(=tarball에서 풀린) dist 문자열도 같은 검사를 쓴다.
  run(
    "node",
    [
      join(ROOT, "scripts/check-dist.mjs"),
      ...packages.map((name) => join(dir, "node_modules", name, "dist")),
    ],
    dir,
  );
}

/** dom-bridge 소비자 트리 검사: coincident·reflected-ffi 포크가 각각 하나만 설치됐는지, dist 검사 두 모드. */
function checkBridgeTree(dir) {
  step("dom-bridge 소비자: coincident·reflected-ffi 포크 설치 하나씩, dist 검사");
  const bridgeSource = readJson(join(ROOT, DOM_BRIDGE_DIR, "package.json"));
  const store = readdirSync(join(dir, "node_modules/.pnpm")).map((entry) =>
    entry.toLowerCase(),
  );
  // 대상은 dom-bridge 작업공간 선언의 dependencies 키(현재 @cp949/runo-coincident·@cp949/runo-reflected-ffi 포크)다. 둘 다
  // 2026-09-28부터 `file:` 로컬 경로로 고정한다 — pnpm이 절대 경로를 작업공간 상대 경로로 바꿔 스토어 폴더 이름을 인코딩하므로
  // (예: `file:/work/.../packages/coincident` → `file+..+runo-coincident+packages+coincident`) 원본 선언 문자열과 직접 문자열
  // 대조를 할 수 없다. 그래서 "정확 버전 일치"가 아니라 "설치본이 정확히 하나(중복·드리프트 없음)"만 본다.
  for (const dep of Object.keys(bridgeSource.dependencies)) {
    const prefix = `${dep.toLowerCase().replace("/", "+")}@`;
    const installed = store.filter((entry) => entry.startsWith(prefix));
    console.log(`${dep} 설치된 항목: ${installed.length}개 (${installed.join(", ") || "없음"})`);
    if (installed.length !== 1)
      throw new Error(
        `dom-bridge 소비자에 설치된 ${dep}이(가) 하나가 아니다: ${installed.join(", ")}`,
      );
  }
  // dom-bridge dist는 coincident를 허용하되 CSP 정적 규칙과 pyodide 런타임 import 금지를 받는다. core dist는 여전히 금지 문자열을 받는다.
  run(
    "node",
    [
      join(ROOT, "scripts/check-dist.mjs"),
      "--allow-sync-bridge",
      join(dir, "node_modules", DOM_BRIDGE, "dist"),
    ],
    dir,
  );
  run(
    "node",
    [
      join(ROOT, "scripts/check-dist.mjs"),
      join(dir, "node_modules", CORE, "dist"),
    ],
    dir,
  );
}

async function main(tmp) {
  /** 끝까지 실행한 뒤 함께 보고할 검사 실패(정적 exports 검사·Vite 해석 검사). */
  const problems = [];
  const rootManifest = readJson(join(ROOT, "package.json"));
  const reactManifest = readJson(
    join(ROOT, "packages/pyodide-repl-react/package.json"),
  );
  const versions = {
    pyodide: readCatalogVersion("pyodide"),
    xterm: readJson(join(ROOT, "packages/pyodide-repl/package.json"))
      .devDependencies["@xterm/xterm"],
    // react 패키지는 react·react-dom을 peer로만 선언하므로 소비자가 직접 설치한다(버전은 react 패키지 devDependencies가 원천).
    react: reactManifest.devDependencies.react,
    reactDom: reactManifest.devDependencies["react-dom"],
    typesReact: reactManifest.devDependencies["@types/react"],
  };
  const shared = {
    packageManager: rootManifest.packageManager,
    // pyodide 자체 타입(`pyodide.d.ts`)이 `node:*` 모듈 타입과 전역 `FS`(emscripten)를 참조한다. TypeScript 6은 `types`를
    // 자동 포함하지 않으므로 소비자가 직접 설치하고 tsconfig `types`에 적는다. `@types/node`는 engines 주 버전(24)에 맞춘다.
    // Vite 해석 검사는 demo가 쓰는 vite와 같은 버전으로 한다(원천은 demo 매니페스트).
    devDependencies: {
      typescript: rootManifest.devDependencies.typescript,
      "@types/node": "24",
      "@types/emscripten": "^1.41.4",
      vite: readJson(join(ROOT, "apps/demo/package.json")).devDependencies.vite,
    },
  };
  const declared = consumers(versions);
  const unused = PACKAGES.filter(
    ({ name }) => !declared.some(({ packages }) => packages.includes(name)),
  );
  if (unused.length > 0)
    throw new Error(
      `어느 소비자에도 설치하지 않는 pack 대상이 있다: ${unused.map(({ name }) => name).join(", ")}`,
    );

  step("dist 확인(없으면 실패: 먼저 pnpm build)");
  for (const { dir } of PACKAGES) {
    if (!existsSync(join(ROOT, dir, "dist")))
      throw new Error(`${dir}/dist가 없다. 먼저 pnpm build를 실행한다`);
  }

  step(`pnpm pack ${PACKAGES.length}개`);
  const tarballDir = join(tmp, "tarballs");
  await mkdir(tarballDir);
  const tarballs = {};
  for (const { name, dir } of PACKAGES) {
    const version = readJson(join(ROOT, dir, "package.json")).version;
    run("pnpm", ["pack", "--pack-destination", tarballDir], join(ROOT, dir));
    const file = join(tarballDir, tarballName(name, version));
    if (!existsSync(file)) throw new Error(`tarball이 없다: ${file}`);
    tarballs[name] = file;
  }

  step(
    "tarball 안 package.json 점검: workspace:·catalog: 의존이 실제 버전으로 치환됐는지, exports 대상, 패키지별 정책(MANIFEST_POLICY)",
  );
  const packedExports = {};
  for (const { name, dir } of PACKAGES) {
    const manifest = JSON.parse(
      execFileSync("tar", ["-xzOf", tarballs[name], "package/package.json"], {
        encoding: "utf8",
      }),
    );
    packedExports[name] = manifest.exports;
    const files = new Set(
      execFileSync("tar", ["-tzf", tarballs[name]], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean),
    );
    console.log(
      `${name}@${manifest.version} private=${manifest.private} dependencies=${JSON.stringify(manifest.dependencies ?? {})}`,
    );
    console.log(
      `${name} peerDependencies=${JSON.stringify(manifest.peerDependencies ?? {})} peerDependenciesMeta=${JSON.stringify(manifest.peerDependenciesMeta ?? {})}`,
    );
    const { errors, missingExports } = checkPackedManifest({
      name,
      manifest,
      files,
      source: readJson(join(ROOT, dir, "package.json")),
    });
    console.log(
      `${name} exports 대상 ${collectExportTargets(manifest.exports).length}개, tarball 파일 ${files.size}개, 없는 대상 ${missingExports.length}개`,
    );
    // 뒤 단계(Vite 해석 검사)의 결과도 한 번에 보도록 exports 누락은 모아 두었다가 마지막에 던진다. 뒤 단계가 먼저 던지면 모은 목록이
    // 보이지 않으므로 목록은 발견 즉시 로그로도 찍는다.
    if (missingExports.length > 0) {
      const problem = `${name} tarball exports에 배포 파일에 없는 대상이 있다:\n  ${missingExports.join("\n  ")}`;
      console.error(problem);
      problems.push(problem);
    }
    if (errors.length > 0) throw new Error(errors.join("\n"));
  }

  step(
    "진입점 도출(tarball exports 키)과 기대 export 선언(ENTRY_EXPORTS) 대조",
  );
  const specifiers = Object.fromEntries(
    PACKAGES.map(({ name }) => [
      name,
      entrySpecifiers(name, packedExports[name]),
    ]),
  );
  const mismatches = compareEntryDeclarations(
    Object.values(specifiers).flat(),
    Object.keys(ENTRY_EXPORTS),
  );
  if (mismatches.length > 0) throw new Error(mismatches.join("\n"));
  console.log(`통과: 진입점 ${Object.keys(ENTRY_EXPORTS).length}개 선언 일치`);

  for (const consumer of declared) {
    const entries = consumer.packages
      .flatMap((name) => specifiers[name])
      .map((specifier) => [
        specifier,
        ENTRY_EXPORTS[specifier],
        NEEDS_WORKER_GLOBAL.has(specifier),
      ]);
    const result = await smokeConsumer({
      tmp,
      consumer,
      tarballs,
      entries,
      shared,
      io: { run, step },
    });
    problems.push(...result.problems);
    consumer.treeChecks(result.dir, consumer.packages);
  }

  if (problems.length > 0) throw new Error(problems.join("\n"));
}

const base = process.env.SMOKE_TMPDIR ?? tmpdir();
await mkdir(base, { recursive: true });
const tmp = await mkdtemp(join(base, "pack-smoke-"));
let ok = false;
try {
  console.log(`임시 폴더: ${tmp}`);
  await main(tmp);
  ok = true;
  console.log(`\n[${elapsed()}] pack-smoke 통과`);
} catch (error) {
  console.error(
    `\n[${elapsed()}] pack-smoke 실패: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
} finally {
  if (ok && process.env.KEEP !== "1") {
    await rm(tmp, { recursive: true, force: true });
    console.log(`임시 폴더를 지웠다: ${tmp}`);
  } else {
    console.log(`임시 폴더를 남겼다(조사용): ${tmp}`);
  }
}
