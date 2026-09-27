// `smoke:pack`의 임시 소비자 프로젝트(`docs/design/09-testing.md` 9.8.3). 소비자 선언 하나를 받아 저장소 밖 폴더에 package.json·
// 작업공간 yaml(overrides)·tsconfig·check.ts·check.mjs·check-vite.mjs를 쓰고, 설치 → node ESM import → `tsc --noEmit` → Vite dev 해석을
// 차례로 돌린다. 설치된 트리 검사(금지 의존·정확 버전·check-dist)는 소비자마다 달라 진입 파일(`scripts/pack-smoke.mjs`)에 남는다.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 소비자 `tsconfig.json`(`skipLibCheck: false`로 배포된 `.d.mts`와 그 의존 타입의 오류를 가리지 않는다). */
const CONSUMER_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      // pyodide 타입이 `Symbol.dispose`(ES2026 explicit resource management)를 쓰므로 `ESNext`가 필요하다.
      lib: ["ESNext", "DOM", "DOM.Iterable"],
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      types: ["node", "emscripten"],
    },
    include: ["check.ts"],
  },
  null,
  2,
);

/** 소비자 `pnpm-workspace.yaml`: 내부 패키지 의존이 레지스트리로 가지 않고 tarball을 가리키게 고정한다. */
const overridesYaml = (names, fileDep) =>
  `overrides:\n${names.map((name) => `  "${name}": "${fileDep(name)}"`).join("\n")}\n`;

/**
 * node ESM import 검사 스크립트: 진입점마다 import해 기대 export의 `typeof`를 본다. `workerGlobal` 진입점은 평가 때 worker 전역의
 * `addEventListener`를 부르므로 Node에서는 그 전역만 스텁으로 세우고 import한다(export 모양·의존 해석만 본다, 동작은 브라우저 L1이 본다).
 * `asserts`는 소비자별 추가 단언 줄이다(`failed = true`로 실패를 표시한다).
 */
const importCheckScript = (entries, asserts) =>
  [
    `const entries = ${JSON.stringify(entries)};`,
    `let failed = false;`,
    `for (const [specifier, expected, workerGlobal] of entries) {`,
    `  if (workerGlobal) globalThis.addEventListener ??= () => {};`,
    `  const mod = await import(specifier);`,
    `  for (const [name, type] of Object.entries(expected)) {`,
    `    if (typeof mod[name] !== type) { failed = true; console.error(\`FAIL \${specifier}: \${name}은(는) \${type}이어야 한다(실제 \${typeof mod[name]})\`); }`,
    `  }`,
    `  console.log(\`import 통과: \${specifier} (export \${Object.keys(mod).length}개)\`);`,
    `}`,
    ...asserts,
    `if (failed) process.exit(1);`,
    ``,
  ].join("\n");

/**
 * Vite dev 해석 검사 스크립트: client 환경 해석기(`createServer` middleware 모드)로 `specifiers`를 풀고 결과 파일이 설치본에 있는지
 * 본다. Vite는 dev에서 `development` 조건을 기본으로 넣으므로, tarball `exports`가 배포되지 않은 `./src/…ts`를 가리키면 여기서 드러난다.
 */
const viteCheckScript = (specifiers) =>
  [
    `import { existsSync } from "node:fs";`,
    `import { join } from "node:path";`,
    `import { createServer } from "vite";`,
    `const specifiers = ${JSON.stringify(specifiers)};`,
    `const server = await createServer({ root: process.cwd(), configFile: false, appType: "custom", logLevel: "error", server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] } });`,
    `let failed = false;`,
    `try {`,
    `  for (const specifier of specifiers) {`,
    `    const resolved = await server.environments.client.pluginContainer.resolveId(specifier, join(process.cwd(), "index.js"));`,
    `    const file = resolved?.id?.split("?")[0];`,
    `    const found = typeof file === "string" && existsSync(file);`,
    `    console.log(\`\${found ? "통과" : "FAIL"} vite 해석: \${specifier} -> \${resolved?.id ?? "(해석 실패)"}\`);`,
    `    if (!found) failed = true;`,
    `  }`,
    `} finally {`,
    `  await server.close();`,
    `}`,
    `if (failed) process.exit(1);`,
    ``,
  ].join("\n");

/**
 * 소비자 프로젝트 하나를 만들고 검사한다.
 * - `consumer`: `{ label, dir, packages, dependencies, devDependencies, checkTs, importAsserts }`. `packages`는 설치할 내부 패키지 이름
 *   (tarball `file:` 의존 + overrides), `dependencies`·`devDependencies`는 그 밖의 소비자 의존, `checkTs`는 `tsc` 대상 `check.ts` 줄.
 * - `entries`: `[지정자, 기대 export, workerGlobal]` — 이 소비자 패키지들의 도출 진입점. Vite 해석 대상은 이 지정자와 각 패키지의
 *   `./package.json`이다.
 * - `shared`: 모든 소비자에 같은 `packageManager`·devDependencies(typescript·@types/node·@types/emscripten·vite).
 * 설치·import·tsc 실패는 던진다. Vite 해석 실패는 끝까지 실행한 뒤 함께 보고하도록 돌려준다. 반환: `{ dir, problems }`.
 */
export async function smokeConsumer({
  tmp,
  consumer,
  tarballs,
  entries,
  shared,
  io: { run, step },
}) {
  const { label, packages } = consumer;
  step(`${label} 프로젝트 작성(${packages.length}개 패키지)`);
  const dir = join(tmp, consumer.dir);
  await mkdir(dir);
  const fileDep = (name) => `file:${tarballs[name]}`;
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: `pack-smoke-${consumer.dir}`,
        private: true,
        type: "module",
        // pnpm 11로 고정한다: 11은 package.json의 `pnpm` 필드(pnpm.overrides)를 읽지 않으므로 overrides는 작업공간 파일에 둔다.
        packageManager: shared.packageManager,
        dependencies: {
          ...Object.fromEntries(packages.map((name) => [name, fileDep(name)])),
          ...consumer.dependencies,
        },
        devDependencies: {
          ...shared.devDependencies,
          ...consumer.devDependencies,
        },
      },
      null,
      2,
    ),
  );
  // tarball의 내부 의존(`@cp949/runo-pyodide-core@0.0.0` 등)이 레지스트리로 가지 않고 tarball을 가리키게 고정한다.
  await writeFile(
    join(dir, "pnpm-workspace.yaml"),
    overridesYaml(packages, fileDep),
  );
  await writeFile(join(dir, "tsconfig.json"), CONSUMER_TSCONFIG);
  await writeFile(join(dir, "check.ts"), [...consumer.checkTs, ""].join("\n"));
  await writeFile(
    join(dir, "check.mjs"),
    importCheckScript(entries, consumer.importAsserts),
  );
  await writeFile(
    join(dir, "check-vite.mjs"),
    viteCheckScript([
      ...entries.map(([specifier]) => specifier),
      ...packages.map((name) => `${name}/package.json`),
    ]),
  );

  step(`pnpm install (${label})`);
  run("pnpm", ["install", "--prefer-offline"], dir);

  step(`node ESM import (${label}, 진입점 ${entries.length}개)`);
  run("node", ["check.mjs"], dir);

  step(`tsc --noEmit (${label}, skipLibCheck: false)`);
  run("pnpm", ["exec", "tsc", "--noEmit", "-p", "tsconfig.json"], dir);

  step(`Vite dev 해석(${label}, client 환경)`);
  const problems = [];
  try {
    run("node", ["check-vite.mjs"], dir);
  } catch (error) {
    problems.push(
      `${label} Vite dev 해석 검사 실패: ${error instanceof Error ? error.message : error}`,
    );
  }
  return { dir, problems };
}
