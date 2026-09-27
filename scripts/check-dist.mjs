#!/usr/bin/env node
// 빌드 산출물(dist)에 동기 브리지 라이브러리 이름(coincident·reflected-ffi, ADR-0001)이 들어 있지 않은지, `.mjs`가 `pyodide`를
// 런타임에 import하지 않는지(ADR-0007: worker는 CDN에서 불러오고 버전 값만 `pyodide/package.json`에서 인라인한다) 검사한다.
// 사용: node scripts/check-dist.mjs [--allow-sync-bridge] <dist 폴더>...   (패키지 폴더에서는 `node ../../scripts/check-dist.mjs dist`)
// `--allow-sync-bridge`는 dom-bridge(RD-023, ADR-0006) 전용이다. 코드 파일의 coincident 금지 문자열 검사를 끄는 대신 CSP 정적 규칙을 건다:
// 코드 파일(`.mjs`·`.ts`·`.tsx` 등, 시험·소스맵 제외)의 coincident 모듈 지정자는 `coincident/window/main`·`coincident/window/worker`뿐이고
// (`reflected-ffi`를 직접 import하지 않는다), 주석을 뺀 코드에 `evaluate`·`serviceWorker`·`coincident/sync`·`window.import`가 없어야
// 한다. 또 `coincident/window/worker`를 import하는 `.mjs`는 그보다 **앞서** `bootstrap-observer-install` 모듈(부트스트랩 관찰기 설치, 별도
// 파일)을 import해야 한다: 관찰 리스너가 coincident의 부트스트랩 리스너보다 먼저 등록돼야 메시지를 본다(번들러가 외부 import를 위로 올리면
// 순서가 뒤집힌다). 코드도 소스맵도 아닌 파일(`.html`·`.json` 등)은 이 옵션에서도 금지 문자열 검사를 받는다: CSP 규칙은 코드 문법만
// 보므로 그런 파일을 건너뛰면 아무 검사도 받지 않는다. 다른 패키지는 이 옵션 없이 검사하므로 금지 보장이 그대로다. `pyodide` 런타임
// import 금지는 이 옵션에서도 유지한다.
// 폴더가 없거나 파일이 하나도 없으면 건너뛰지 않고 실패한다 — 빌드 전에 돌린 것을 통과로 착각하지 않게 한다(turbo `check-dist`가
// `build` 뒤에 돌린다). 소스맵(.map)까지 모든 파일을 본다. 대소문자는 구분하지 않는다.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const FORBIDDEN = ["coincident", "reflected-ffi"];
const ALLOW_SYNC_BRIDGE_FLAG = "--allow-sync-bridge";

/** CSP(`worker-src 'self'` 등)에서 위반을 내지 않는 coincident 진입점(canvas 저장소 실측 F23). 이 밖의 coincident 지정자는 위반이다. */
const CSP_ALLOWED_SPECIFIERS = new Set([
  "coincident/window/main",
  "coincident/window/worker",
]);
/**
 * CSP 규칙을 적용하는 코드 파일(`.d.mts`·`.d.ts`·`.tsx`·`.jsx` 포함). 소스맵(`.map`)은 원문 주석을 담으므로 대상이 아니다(실행되지
 * 않는다). 이 밖의 파일(소스맵 제외)은 허용 모드에서도 금지 문자열 검사를 받는다.
 */
const CSP_CODE_FILE = /\.(?:mjs|cjs|js|jsx|mts|cts|ts|tsx)$/;
const CSP_SKIP_FILE = /\.test\.(?:mjs|cjs|js|jsx|mts|cts|ts|tsx)$/;
const SOURCE_MAP_FILE = /\.map$/;
/**
 * 모듈 지정자를 담는 문법: `from "x"`·`import "x"`·`import("x")`·`declare module "x"`·`require("x")`, 그리고 `${` 없는 템플릿
 * 리터럴 `import(\`x\`)`·`require(\`x\`)`(`${`가 있으면 런타임에 정해지는 경로라 지정자로 보지 않는다).
 */
const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(?\s*["']([^"']+)["']/g,
  /\bdeclare\s+module\s+["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']/g,
  // 템플릿 리터럴: 백틱 사이에 `${`·`\`가 없는 것만(`$` 단독은 허용).
  /\bimport\s*\(\s*`((?:[^`$\\]|\$(?!\{))+)`/g,
  /\brequire\s*\(\s*`((?:[^`$\\]|\$(?!\{))+)`/g,
];
/** 주석을 뺀 코드에 있으면 안 되는 표현. `.import(`는 `window.import`류 동적 원격 import의 멤버 호출을 넓게 잡는다(`import()` 문법은 아니다). */
const CSP_FORBIDDEN_TOKENS = [
  ["evaluate", /\bevaluate\b/],
  ["serviceWorker", /\bserviceWorker\b/],
  ["coincident/sync", /coincident\/sync/],
  ["window.import", /\bwindow\s*\.\s*import\b/],
  [".import(", /\.\s*import\s*\(/],
];

/**
 * 블록 주석과 줄 주석을 지운다. 두 주석을 한 정규식의 대안으로 두어 앞에서부터 먼저 시작한 주석 하나씩 지운다: 줄 주석 속 `/*`는
 * 줄 주석과 함께 사라지고(블록 주석 시작으로 잡아 다음 `*\/`까지 실제 코드를 지우지 않는다), 블록 주석 속 `//`는 블록 주석과 함께
 * 사라진다. 줄 주석은 줄 머리나 공백 뒤의 `//`만 본다(`https://` 같은 문자열 속 `//`를 주석으로 오인해 뒤 코드를 가리지 않으려는
 * 것이다). 문자열 리터럴을 파싱하는 것은 아니므로 코드의 문자열 속 `/*`·` //`가 있으면 어긋날 수 있다(이슈 `dom-bridge-followups/01`).
 */
function stripComments(text) {
  return text.replace(
    /\/\*[\s\S]*?\*\/|(^|\s)\/\/.*$/gm,
    (_, lineCommentLead) => lineCommentLead ?? "",
  );
}

/** 부트스트랩 관찰기 설치 모듈의 지정자(`./bootstrap-observer-install.mjs`·번들러가 붙인 해시 이름 포함). */
const OBSERVER_SPECIFIER = /(?:^|\/)bootstrap-observer-install[^/]*\.mjs$/;

/**
 * 코드에서 지정자가 나타나는 첫 위치(문자 오프셋). `match`가 함수면 지정자 문자열로 판정한다. 없으면 -1.
 * `from "x"`·`import "x"`·`import("x")` 모두 지정자 문자열의 위치를 돌려주므로 서로 비교할 수 있다.
 */
function firstSpecifierIndex(code, match) {
  let first = -1;
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const m of code.matchAll(pattern)) {
      if (!match(m[1])) continue;
      if (first < 0 || m.index < first) first = m.index;
    }
  }
  return first;
}

/**
 * `coincident/window/worker`를 import하는 `.mjs`에서 관찰기 설치 모듈 import가 그보다 앞에 없으면 위반 설명을, 아니면 `null`을 돌려준다
 * (coincident를 import하지 않는 파일은 대상이 아니다).
 */
function findObserverOrderViolation(text) {
  const code = stripComments(text);
  const coincident = firstSpecifierIndex(
    code,
    (specifier) => specifier === "coincident/window/worker",
  );
  if (coincident < 0) return null;
  const observer = firstSpecifierIndex(code, (specifier) =>
    OBSERVER_SPECIFIER.test(specifier),
  );
  if (observer < 0)
    return "coincident/window/worker를 import하지만 bootstrap-observer-install import가 없다";
  if (observer > coincident)
    return "bootstrap-observer-install import가 coincident/window/worker import보다 뒤에 있다(관찰 리스너가 coincident 리스너보다 늦게 등록된다)";
  return null;
}

/** `text`(코드 파일 내용)의 CSP 위반 설명 목록. */
function findCspViolations(text) {
  const code = stripComments(text);
  const violations = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1];
      const bridge =
        specifier === "coincident" ||
        specifier.startsWith("coincident/") ||
        specifier === "reflected-ffi" ||
        specifier.startsWith("reflected-ffi/");
      if (bridge && !CSP_ALLOWED_SPECIFIERS.has(specifier))
        violations.push(`허용 밖 모듈 지정자 "${specifier}"`);
    }
  }
  for (const [label, pattern] of CSP_FORBIDDEN_TOKENS)
    if (pattern.test(code)) violations.push(`금지 표현 "${label}"`);
  return violations;
}

/**
 * `.mjs`의 `pyodide` 런타임 import: `from "pyodide"`·`from 'pyodide/ffi'`·`import("pyodide")`·`import "pyodide"`.
 * 따옴표 바로 뒤에 `pyodide`와 (`"`·`'`·`/`)가 오는 것만 잡아, Python 코드 문자열(`from pyodide.ffi import`)과
 * `pyodide-lock` 같은 다른 이름은 걸리지 않는다. `.d.mts`의 타입 import는 정상이라 검사하지 않는다.
 */
const PYODIDE_RUNTIME_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(?\s*)["']pyodide["'/]/;

/** `dir` 아래 모든 파일 경로(하위 폴더 포함). 폴더가 없으면 ENOENT를 그대로 던진다. */
async function listFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else files.push(path);
  }
  return files;
}

function fail(message) {
  console.error(`check-dist 실패: ${message}`);
  process.exitCode = 1;
}

const args = process.argv.slice(2);
const allowSyncBridge = args.includes(ALLOW_SYNC_BRIDGE_FLAG);
const targets = args.filter((arg) => arg !== ALLOW_SYNC_BRIDGE_FLAG);
if (targets.length === 0) {
  fail(
    "검사할 dist 폴더를 인자로 준다(예: node scripts/check-dist.mjs packages/pyodide-repl/dist)",
  );
} else {
  for (const target of targets) {
    let files;
    try {
      files = await listFiles(target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      fail(`${target} 폴더가 없다. 먼저 pnpm build를 실행한다`);
      continue;
    }
    if (files.length === 0) {
      fail(`${target}에 파일이 없다. 먼저 pnpm build를 실행한다`);
      continue;
    }
    let clean = true;
    for (const file of files) {
      const raw = await readFile(file, "utf8");
      if (file.endsWith(".mjs") && PYODIDE_RUNTIME_IMPORT.test(raw)) {
        clean = false;
        fail(`${file}에 pyodide 런타임 import가 있다`);
      }
      if (
        allowSyncBridge &&
        CSP_CODE_FILE.test(file) &&
        !CSP_SKIP_FILE.test(file)
      ) {
        for (const violation of findCspViolations(raw)) {
          clean = false;
          fail(`${file}에 CSP 정적 검사 위반이 있다: ${violation}`);
        }
      }
      if (allowSyncBridge && file.endsWith(".mjs")) {
        const violation = findObserverOrderViolation(raw);
        if (violation) {
          clean = false;
          fail(`${file}: ${violation}`);
        }
      }
      // 허용 모드에서 금지 문자열 검사를 건너뛰는 것은 코드 파일(CSP 규칙 대상, 시험 파일은 CSP에서도 제외)과 소스맵뿐이다.
      if (
        allowSyncBridge &&
        (CSP_CODE_FILE.test(file) || SOURCE_MAP_FILE.test(file))
      )
        continue;
      const text = raw.toLowerCase();
      for (const needle of FORBIDDEN) {
        if (!text.includes(needle)) continue;
        clean = false;
        fail(`${file}에 금지 문자열 "${needle}"이(가) 있다`);
      }
    }
    if (clean)
      console.log(
        allowSyncBridge
          ? `check-dist 통과: ${target} (${files.length}개 파일, 동기 브리지 허용 모드: CSP 정적 규칙 위반·관찰기 import 순서 위반·pyodide 런타임 import 0)`
          : `check-dist 통과: ${target} (${files.length}개 파일, 금지 문자열·pyodide 런타임 import 0)`,
      );
  }
}
