// e2e check 스크립트 진입 규약 라이브러리 — URL/mode 인자 파싱, label, ONLY 판정(sectionEnabled·pageSelected),
// dev/preview 반복(runDevPreview), 종료 코드(exitWith). 규칙 정의: `docs/design/09-testing.md` 9.6.5
// (K1~K7, RD-044). argv·env를 명시 인자로 받는 함수(`parseArgs`·`serverLabel`·`sectionEnabled`·`pageSelected`·
// `previewOnlyTokens`)는 순수해 단위 시험 대상이다. `checkEntry`·`currentOnly`·`runDevPreview`(기본 `process.env`)·`exitWith`는
// `process.*`를 직접 읽거나 부작용(exit·console.log·env 변형)을 낸다 — 스크립트가 `process.argv`·`process.env.ONLY`를
// 직접 쓰지 않도록 이 넷이 그 자리를 대신한다.

export const DEFAULT_DEV_URL = "http://localhost:5173";

/** [K1] argv(=process.argv 형태)를 파싱한다. mode 스크립트는 `{ modes: [...] }`로 허용 목록을 준다. */
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

/** [K1] 얇은 편의 함수: `process.argv`를 읽고, mode가 목록 밖이면 사용법을 출력하고 exit 2 한다. */
export function checkEntry(opts = {}, argv = process.argv) {
  const parsed = parseArgs(argv, opts);
  if (parsed.error) {
    console.error(parsed.error);
    process.exit(parsed.exitCode);
  }
  return parsed;
}

/** 얇은 편의 함수: `process.env.ONLY`를 현재 값으로 읽어 토큰 배열로 돌려준다(호출 시점마다 다시 읽는다 — K5 덮어쓰기 반영). */
export function currentOnly(env = process.env) {
  return (env.ONLY ?? "").split(",").filter(Boolean);
}

/** [K2] URL(과 mode)로 결과 파일 label을 만든다. */
export function serverLabel(url, mode) {
  const base = url.includes(":4173") ? "preview" : "dev";
  return mode ? `${mode}-${base}` : base;
}

/** [K3] ONLY 토큰과 정확히 일치하는 절만 켠다("초기"류 처리는 `lib.mjs`의 `step` 접두어 규칙이 담당, 여기서는 안 다룬다). */
export function sectionEnabled(only, name) {
  return only.length === 0 || only.includes(name);
}

/** [K4] ONLY 토큰과 prefix 중 하나가 다른 하나의 접두어면 페이지를 켠다(양방향 접두어). */
export function pageSelected(only, ...prefixes) {
  return only.length === 0 || only.some((o) => prefixes.some((p) => p.startsWith(o) || o.startsWith(p)));
}

/**
 * [K6] preview 단계에서 쓸 ONLY 토큰을 계산한다.
 * declaredList(선언한 preview 절 목록)가 없으면 사용자 ONLY 그대로.
 * declaredList가 있고 사용자 ONLY가 없으면 declaredList 전체.
 * 둘 다 있으면 "초기" + (사용자 토큰 ∩ declaredList, 정확 일치). "초기" 제외 교집합이 비면 건너뛴다(2026-09-27 사용자 확정).
 */
export function previewOnlyTokens(userOnly, declaredList) {
  if (!declaredList) return { tokens: userOnly, skip: false };
  if (userOnly.length === 0) return { tokens: declaredList, skip: false };
  const matched = declaredList.filter((p) => p !== "초기" && userOnly.includes(p));
  const tokens = declaredList.includes("초기") ? ["초기", ...matched] : matched;
  return { tokens, skip: matched.length === 0 };
}

/**
 * [K5] dev를 실행하고, previewUrl이 있으면 이어서 preview를 실행한다. preview 동안만 env.ONLY를
 * previewSections(K6)에 따라 바꾸고 끝나면 원래 값(없었으면 삭제)으로 되돌린다. 결과 = 두 실행 모두 통과.
 * `run(url, phase)`의 phase는 `"dev"`|`"preview"` — dev·preview 본문이 다른 스크립트는 URL 비교 대신 이것으로 가른다.
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

/** [K7] 통과 여부로 프로세스를 종료한다. */
export function exitWith(ok) {
  process.exit(ok ? 0 : 1);
}
