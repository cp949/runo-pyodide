// e2e check 스크립트 진입 규약 라이브러리(RD-044). 규칙은 `docs/design/09-testing.md` 9.6.5(K1~K7)다.
// 다루는 것:
// - URL·mode 인자 파싱(`parseArgs`, `checkEntry`).
// - 결과 파일 label(`serverLabel`).
// - ONLY 판정(`sectionEnabled`, `pageSelected`, `previewOnlyTokens`).
// - dev·preview 반복(`runDevPreview`).
// - 종료 코드(`exitWith`).
//
// 순수 함수: `parseArgs`·`serverLabel`·`sectionEnabled`·`pageSelected`·`previewOnlyTokens`. argv·env를 인자로 받는다. 단위 시험 대상이다.
// 부수 효과가 있는 함수: `checkEntry`·`currentOnly`·`runDevPreview`·`exitWith`.
// - `process.*`를 읽거나 exit·console.log·env 변형을 낸다.
// - 스크립트가 `process.argv`·`process.env.ONLY`를 직접 쓰지 않도록 이 넷이 그 자리를 대신한다.

/** URL 인자가 없을 때 쓰는 dev 서버 URL. */
export const DEFAULT_DEV_URL = "http://localhost:5173";

/**
 * [K1] argv(`process.argv` 형태)를 파싱한다.
 * mode 스크립트는 `{ modes: [...] }`로 허용 목록을 준다. 이 경로는 `previewUrl`이 항상 `undefined`다.
 * mode가 목록 밖이면 `{ error, exitCode: 2 }`를 돌려준다.
 */
export function parseArgs(argv, { modes } = {}) {
  const rest = argv.slice(2);
  if (modes) {
    const mode = rest[0];
    if (!modes.includes(mode)) {
      return { error: `사용법: node <script> <${modes.join("|")}> [devURL] [...args]`, exitCode: 2 };
    }
    return { mode, url: rest[1] ?? DEFAULT_DEV_URL, previewUrl: undefined, rest: rest.slice(2) };
  }
  return { mode: undefined, url: rest[0] ?? DEFAULT_DEV_URL, previewUrl: rest[1], rest: rest.slice(2) };
}

/** [K1] `parseArgs`에 `process.argv`를 넘긴다. mode가 목록 밖이면 사용법을 출력하고 exit 2로 끝낸다. */
export function checkEntry(opts = {}, argv = process.argv) {
  const parsed = parseArgs(argv, opts);
  if (parsed.error) {
    console.error(parsed.error);
    process.exit(parsed.exitCode);
  }
  return parsed;
}

/** `process.env.ONLY`를 토큰 배열로 돌려준다. 호출할 때마다 다시 읽는다. K5가 preview 동안 값을 덮어쓰기 때문이다. */
export function currentOnly(env = process.env) {
  return (env.ONLY ?? "").split(",").filter(Boolean);
}

/** [K2] URL(과 mode)로 결과 파일 label을 만든다. 4173이면 `preview`, 아니면 `dev`이고 mode가 있으면 앞에 붙는다. */
export function serverLabel(url, mode) {
  const base = url.includes(":4173") ? "preview" : "dev";
  return mode ? `${mode}-${base}` : base;
}

/** [K3] ONLY 토큰과 정확히 일치하는 절만 켠다. ONLY가 비면 모두 켠다. "초기" 처리는 `lib.mjs`의 `step`이 맡는다. */
export function sectionEnabled(only, name) {
  return only.length === 0 || only.includes(name);
}

/** [K4] ONLY 토큰과 `prefixes` 중 하나가 서로의 접두어면 페이지를 켠다(양방향). ONLY가 비면 켠다. */
export function pageSelected(only, ...prefixes) {
  return only.length === 0 || only.some((o) => prefixes.some((p) => p.startsWith(o) || o.startsWith(p)));
}

/**
 * [K6] preview 단계에서 쓸 ONLY 토큰을 계산한다. `{ tokens, skip }`을 돌려준다.
 * - `declaredList`(스크립트가 선언한 preview 절 목록)가 없으면 사용자 ONLY 그대로다.
 * - `declaredList`만 있으면 그 전체다.
 * - 둘 다 있으면 "초기" + (사용자 토큰 ∩ `declaredList`, 정확 일치)다.
 * - "초기"를 뺀 교집합이 비면 `skip: true`다. preview를 건너뛴다(2026-09-27 사용자 확정).
 */
export function previewOnlyTokens(userOnly, declaredList) {
  if (!declaredList) return { tokens: userOnly, skip: false };
  if (userOnly.length === 0) return { tokens: declaredList, skip: false };
  const matched = declaredList.filter((p) => p !== "초기" && userOnly.includes(p));
  const tokens = declaredList.includes("초기") ? ["초기", ...matched] : matched;
  return { tokens, skip: matched.length === 0 };
}

/**
 * [K5] dev를 실행하고, `previewUrl`이 있으면 이어서 preview를 실행한다. 두 실행이 모두 통과하면 참이다.
 * - preview 동안만 `env.ONLY`를 `previewSections`(K6)에 따라 바꾼다. 끝나면 원래 값으로 되돌린다. 원래 없었으면 지운다.
 * - `run(url, phase)`의 `phase`는 `"dev"` 또는 `"preview"`다. dev·preview 본문이 다른 스크립트는 URL 비교 대신 이것으로 가른다.
 */
export async function runDevPreview({ url, previewUrl, run, previewSections, env = process.env }) {
  const devOk = await run(url, "dev");
  if (!previewUrl) return devOk;

  const userOnly = (env.ONLY ?? "").split(",").filter(Boolean);
  const { tokens, skip } = previewOnlyTokens(userOnly, previewSections);
  if (skip) {
    console.log(`preview 건너뜀: ONLY 교집합이 "초기"뿐`);
    return devOk;
  }
  if (!previewSections) {
    const previewOk = await run(previewUrl, "preview");
    return devOk && previewOk;
  }

  const original = env.ONLY;
  env.ONLY = tokens.join(",");
  try {
    const previewOk = await run(previewUrl, "preview");
    return devOk && previewOk;
  } finally {
    if (original === undefined) delete env.ONLY;
    else env.ONLY = original;
  }
}

/** [K7] 통과 여부로 프로세스를 종료한다. 통과면 exit 0, 아니면 exit 1. */
export function exitWith(ok) {
  process.exit(ok ? 0 : 1);
}
