#!/usr/bin/env node
// 빌드 floor(Chrome 84, ADR-0008) ES 호환성 게이트. tsdown·Vite `target`(browser-target.mts)은 문법만 하향하고 런타임 API
// 호출(`Object.hasOwn`·`.at`류)은 그대로 남기므로, 이 스크립트가 dist의 런타임 API 사용을 검사한다.
// 사용: node scripts/check-escompat.mjs <dist 폴더>   (패키지 폴더에서는 `node ../../scripts/check-escompat.mjs dist`)
// 대상: `.mjs`/`.js`(소스맵·`.d.mts`·`.d.ts` 제외). 대상 0건이면 건너뛰지 않고 실패한다(빌드 전에 돌린 것을 통과로
// 착각하지 않게 한다 — `check-dist.mjs`와 같은 원칙).
//
// 규칙: `eslint-plugin-es-x`의 `flat/restrict-to-es2020`(ES2020까지 허용)을 베이스로, Chrome 84 이하가 이미 지원하지만
// ES2020 프리셋이 막는 기능만 개별로 끈다(근거는 MDN의 최초 지원 Chrome 버전). `settings.es-x.aggressive`는 receiver 타입을
// 모르는 dist JS에서 변수 receiver 호출(`x.at(0)`)도 잡기 위해 켠다(기본 모드는 리터럴 receiver만 본다). `allowInlineConfig:
// false`로 dist 안 eslint-disable 주석(번들러 잔재 포함)이 게이트를 뚫지 못하게 한다.
// Web API(ES 표준 밖)는 es-x가 보지 않으므로 정규식으로 따로 본다.
// 참고 구현(읽기 전용): `/work/cp949/geul/scripts/check-escompat.mjs`.
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { ESLint } from "eslint";
import esX from "eslint-plugin-es-x";

/**
 * ES2020+ 분류라 restrict-to-es2020이 막지만 Chrome 84 이하가 이미 지원하는 기능 — floor 기준으로는 허용이 맞아 규칙을
 * 해제한다. 값은 MDN의 최초 지원 Chrome 버전.
 */
const ALLOWED_BELOW_FLOOR_RULES = {
  "es-x/no-numeric-separators": "off", // Chrome 75
  "es-x/no-weakrefs": "off", // Chrome 84(WeakRef·FinalizationRegistry)
  "es-x/no-class-instance-fields": "off", // Chrome 72
  "es-x/no-class-static-fields": "off", // Chrome 72
  "es-x/no-class-private-fields": "off", // Chrome 74
  "es-x/no-class-private-methods": "off", // Chrome 84(private 메서드·접근자)
};

/**
 * 기능 탐지 뒤 사용하는 API. 소스에서 `typeof`·존재 검사로 감싸고 폴백이 있어 게이트 대상이 아니다. 규칙을 끌 때는 이
 * 목록에만 둔다(design.md D2).
 */
const FEATURE_DETECTED_RULES = {
  // `pyodide-core/src/protocol/stdin-mailbox.ts`가 `Atomics.waitAsync` 존재 검사 후 `setTimeout` 폴백을 쓴다.
  "es-x/no-atomics-waitasync": "off",
  // `pyodide-dom-bridge/src/index.ts`의 `canCreateGrowableSharedArrayBuffer()`가 growable `SharedArrayBuffer` 생성을
  // try/catch로 감싸 지원 여부만 boolean으로 돌려준다(미지원 엔진에서 던지는 것 자체가 판정 수단이다, design.md D2 계획에
  // 없던 발견, 2026-09-28 DELTA-03에서 실측).
  "es-x/no-resizable-and-growable-arraybuffers": "off",
};

/**
 * aggressive 모드는 receiver를 보지 않아 이름이 겹치는 규칙이 오탐을 낸다(2026-09-28 실측, geul
 * `scripts/check-escompat.mjs`와 같은 문제): 이 저장소의 `createInitReceiver().take(...)`(`pyodide-core/src/worker/init-receiver.ts`)가
 * ES2025 `Iterator.prototype.take`로 잘못 잡힌다(`worker.mjs`). Iterator helper·Set 메서드(ES2025)류 규칙을 해제해도 잃는 것이
 * 없다: 이 저장소의 `tsconfig`(`packages/typescript-config/base.json`)가 `lib: ["es2022", ...]`로 그 API 자체를 타입 수준에서
 * 이미 막는다(소스에서 실제로 쓸 수 없다).
 */
const COLLISION_PRONE_PATTERN = /^es-x\/no-(?:iterator|set)-prototype-/;

/** es-x가 보지 않는 Web API. `[이름, 최초 지원 Chrome 버전, 정규식]`. */
const WEB_API_PATTERNS = [
  ["structuredClone", 98, /\bstructuredClone\s*\(/],
  ["crypto.randomUUID", 92, /\bcrypto\s*\.\s*randomUUID\s*\(/],
  ["AbortSignal.timeout", 103, /\bAbortSignal\s*\.\s*timeout\s*\(/],
  ["AbortSignal.any", 116, /\bAbortSignal\s*\.\s*any\s*\(/],
];

const DIST_JS_FILE = /\.(?:mjs|js)$/;

const collisionRuleOverrides = Object.fromEntries(
  Object.keys(esX.configs["flat/restrict-to-es2020"].rules ?? {})
    .filter((ruleId) => COLLISION_PRONE_PATTERN.test(ruleId))
    .map((ruleId) => [ruleId, "off"]),
);

/**
 * `cwd`: ESLint flat config의 base path 기준이다(생략하면 `process.cwd()`). 검사 대상 파일이 그 경로 밖이면 "File ignored
 * because outside of base path"로 조용히 건너뛴다 — 호출부(`main`)가 검사 대상 dist 폴더 자체를 넘긴다.
 */
export function createEscompatESLint(cwd = process.cwd()) {
  return new ESLint({
    cwd,
    // 저장소의 다른 eslint 설정을 찾지 않고 아래 baseConfig만 쓴다.
    overrideConfigFile: true,
    allowInlineConfig: false,
    baseConfig: [
      esX.configs["flat/restrict-to-es2020"],
      {
        languageOptions: { ecmaVersion: "latest", sourceType: "module" },
        settings: { "es-x": { aggressive: true } },
        rules: {
          ...collisionRuleOverrides,
          ...ALLOWED_BELOW_FLOOR_RULES,
          ...FEATURE_DETECTED_RULES,
        },
      },
    ],
  });
}

/** `dir` 아래 `.mjs`/`.js` 파일 경로(하위 폴더 포함, 소스맵·`.d.mts`·`.d.ts` 제외). 폴더가 없으면 빈 배열. */
async function listDistJsFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && DIST_JS_FILE.test(entry.name))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .sort();
}

/** `text`(파일 내용)에서 발견한 Web API 위반 설명 목록. */
function findWebApiViolations(text) {
  const violations = [];
  for (const [name, chromeVersion, pattern] of WEB_API_PATTERNS) {
    if (pattern.test(text)) {
      violations.push(`${name}(Chrome ${chromeVersion}+) 사용`);
    }
  }
  return violations;
}

function fail(message) {
  console.error(`check-escompat 실패: ${message}`);
  process.exitCode = 1;
}

async function main() {
  const targetArg = process.argv[2];
  if (!targetArg) {
    fail("검사할 dist 폴더를 인자로 준다(예: node scripts/check-escompat.mjs packages/pyodide-core/dist)");
    return;
  }
  const target = resolve(targetArg);
  const files = await listDistJsFiles(target);
  if (files.length === 0) {
    fail(`${target}에 검사할 .mjs/.js 파일이 없다. 먼저 pnpm build를 실행한다`);
    return;
  }

  let clean = true;
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const violation of findWebApiViolations(text)) {
      clean = false;
      fail(`${file}: ${violation}`);
    }
  }

  const eslint = createEscompatESLint(target);
  const results = await eslint.lintFiles(files);
  const violationCount = results.reduce(
    (sum, result) => sum + result.errorCount + result.warningCount,
    0,
  );
  if (violationCount > 0) {
    clean = false;
    const formatter = await eslint.loadFormatter("stylish");
    console.error(await formatter.format(results));
    fail(`${target}: Chrome 84 미지원 API 사용 ${violationCount}건`);
  }

  if (clean) {
    console.log(
      `check-escompat 통과: ${target} (${files.length}개 파일, Chrome 84 기준 위반 0)`,
    );
  }
}

await main();
