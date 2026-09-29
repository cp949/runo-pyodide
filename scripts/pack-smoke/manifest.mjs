// tarball 매니페스트 정적 검사(`smoke:pack` 1단계, `docs/design/09-testing.md` 9.8.3). 부수효과 없는 판정 함수만 둔다 — pack·tar 읽기는
// 진입 파일(`scripts/pack-smoke.mjs`)이 하고, 판정은 `packages/pyodide-testkit/test/pack-smoke-script.test.ts`가 L0로 고정한다.

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * 패키지별 매니페스트 정책(pack 결과 기준). 표에 없는 패키지는 공통 규칙만 받는다. 규칙:
 * - `peers`: `peerDependencies`에 있어야 하고 `dependencies`에는 없어야 하는 의존. `range: "^"`이면 범위가 `^`로 시작하고,
 *   `optional: true`이면 `peerDependenciesMeta.<dep>.optional === true`.
 * - `dependencies`: `dependencies`의 키가 정확히 이 목록이어야 한다.
 * - `exact`: `dependencies`의 값이 정확 버전(`x.y.z`)이고 작업공간 `package.json` 선언과 같아야 한다.
 * - `sideEffects`: `sideEffects`가 배열이고 이 경로를 모두 포함해야 한다.
 * `pyodide` peer는 표가 선언한 패키지(core)에만 허용한다(repl 등은 pyodide 타입을 노출하지 않는다).
 */
export const MANIFEST_POLICY = {
  // core는 pyodide 타입을 노출하므로 optional peer로 선언한다(RD-021).
  "@cp949/runo-pyodide-core": {
    peers: { pyodide: { range: "^", optional: true } },
  },
  // react·react-dom·@xterm/xterm은 소비자 것 한 벌로 쓴다(15-react.md 15.1). 소비자가 셋을 직접 설치하므로 선언이 빠지거나 dependencies로
  // 옮겨져도 설치·import는 통과한다(React가 두 벌이면 hook이 깨진다). addon-fit은 비공개 API를 써서(TRP-062) 정확 버전으로 고정한다.
  "@cp949/runo-pyodide-repl-react": {
    peers: { react: {}, "react-dom": {}, "@xterm/xterm": {} },
    exact: ["@xterm/addon-fit"],
  },
  // coincident·reflected-ffi 둘 다 2026-09-28에 포크(@cp949/runo-coincident·@cp949/runo-reflected-ffi)로 대체했고 file:
  // 로컬 경로로 고정한다(16-dom-bridge.md 16.1) — semver가 아니라 `exact`(정확 버전 정규식) 대상에서는 둘 다 뺀다.
  // core는 타입만 쓰므로 peer. `sideEffects`는 import 시점 부트스트랩 관찰 리스너(worker 진입점)가 번들에서 빠지지 않게 배열이다.
  "@cp949/runo-pyodide-dom-bridge": {
    peers: { "@cp949/runo-pyodide-core": {} },
    dependencies: ["@cp949/runo-coincident", "@cp949/runo-reflected-ffi"],
    sideEffects: ["./dist/worker.mjs"],
  },
};

/** `exports` 값에서 파일 경로 대상(`./…` 문자열)을 조건 이름과 무관하게 모두 모은다. `null`(비공개 표시)은 건너뛴다. */
export function collectExportTargets(value, path = "exports") {
  if (typeof value === "string") return [{ path, target: value }];
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      collectExportTargets(item, `${path}[${index}]`),
    );
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) =>
      collectExportTargets(item, `${path}.${key}`),
    );
  return [];
}

/** 패키지 정책 한 건의 위반 메시지 목록. */
function policyErrors(name, manifest, source, policy) {
  const errors = [];
  const dependencies = manifest.dependencies ?? {};
  const peerDependencies = manifest.peerDependencies ?? {};
  const peers = policy.peers ?? {};
  for (const [peer, { range, optional } = {}] of Object.entries(peers)) {
    const value = peerDependencies[peer];
    if (typeof value !== "string" || (range && !value.startsWith(range)))
      errors.push(
        `${name} tarball에 peerDependencies.${peer}${range ? `(${range}범위)` : ""}가 없다: ${value}`,
      );
    if (optional && manifest.peerDependenciesMeta?.[peer]?.optional !== true)
      errors.push(
        `${name} tarball에 peerDependenciesMeta.${peer}.optional=true가 없다`,
      );
    if (dependencies[peer] !== undefined)
      errors.push(
        `${name} tarball의 dependencies에 peer여야 할 ${peer}가 있다`,
      );
  }
  if (!("pyodide" in peers) && peerDependencies.pyodide !== undefined)
    errors.push(
      `${name} tarball에 예상하지 않은 peerDependencies.pyodide가 있다: ${peerDependencies.pyodide}`,
    );
  if (
    policy.dependencies &&
    JSON.stringify(Object.keys(dependencies).sort()) !==
      JSON.stringify([...policy.dependencies].sort())
  )
    errors.push(
      `${name} tarball의 dependencies가 ${policy.dependencies.join("·")}가 아니다: ${JSON.stringify(dependencies)}`,
    );
  for (const dep of policy.exact ?? []) {
    const value = dependencies[dep];
    if (!EXACT_VERSION.test(String(value)))
      errors.push(`${name} tarball의 ${dep}가 정확 버전이 아니다: ${value}`);
    else if (value !== source.dependencies?.[dep])
      errors.push(
        `${name} tarball의 ${dep}(${value})가 작업공간 선언(${source.dependencies?.[dep]})과 다르다`,
      );
  }
  for (const path of policy.sideEffects ?? []) {
    if (
      !Array.isArray(manifest.sideEffects) ||
      !manifest.sideEffects.includes(path)
    )
      errors.push(
        `${name} tarball의 sideEffects에 ${path}가 없다: ${JSON.stringify(manifest.sideEffects)}`,
      );
  }
  return errors;
}

/**
 * tarball 안 `package.json` 하나를 판정한다. `files`는 tarball 파일 목록(`package/…`), `source`는 작업공간 `package.json`이다.
 * `errors`는 즉시 실패할 위반(진입 파일이 던진다), `missingExports`는 끝까지 실행한 뒤 함께 보고할 `exports` 대상 누락이다.
 */
export function checkPackedManifest({ name, manifest, files, source }) {
  const errors = [];
  const leftovers = ["dependencies", "peerDependencies", "optionalDependencies"]
    .flatMap((field) =>
      Object.entries(manifest[field] ?? {}).map(([dep, range]) => [
        field,
        dep,
        range,
      ]),
    )
    .filter(([, , range]) => String(range).startsWith("workspace:"));
  if (leftovers.length > 0)
    errors.push(
      `${name} tarball에 workspace: 의존이 남았다: ${JSON.stringify(leftovers)}`,
    );
  // pnpm이 `catalog:`를 치환하지 않으면 소비자 설치가 깨진다. 모든 필드(devDependencies 포함)에서 확인한다.
  if (JSON.stringify(manifest).includes("catalog:"))
    errors.push(`${name} tarball package.json에 catalog:가 남았다`);
  errors.push(
    ...policyErrors(name, manifest, source, MANIFEST_POLICY[name] ?? {}),
  );
  // 작업공간 소스용 `development` 조건(`./src/…ts`)이 tarball에 남으면 `files: ["dist"]`라 없는 파일을 가리킨다(Vite dev가 이 조건을 쓴다).
  const missingExports = collectExportTargets(manifest.exports)
    .filter(
      ({ target }) => !files.has(`package/${target.replace(/^\.\//, "")}`),
    )
    .map(({ path, target }) => `${path} -> ${target}`);
  return { errors, missingExports };
}

/**
 * tarball `exports`에서 소비자가 import할 진입점 지정자를 도출한다: 값이 `null`(비공개 표시)이 아니고 `./package.json`이 아닌 키.
 * `.`은 패키지 이름, `./x`는 `<이름>/x`다. 단축형(문자열 등 조건 객체가 아닌 값)은 `.` 하나로 본다. `exports`가 없으면 던진다 — 목록이
 * 비면(`{}`·모든 키가 `null`·`./package.json`뿐) import·Vite 검사가 조용히 빠진다.
 */
export function entrySpecifiers(name, exports) {
  if (exports === undefined || exports === null)
    throw new Error(
      `${name} tarball에 exports가 없다(진입점을 도출할 수 없다)`,
    );
  const isSubpathMap =
    typeof exports === "object" &&
    !Array.isArray(exports) &&
    Object.keys(exports).every((key) => key.startsWith("."));
  if (!isSubpathMap) return [name];
  const specifiers = Object.entries(exports)
    .filter(([key, value]) => value !== null && key !== "./package.json")
    .map(([key]) => (key === "." ? name : `${name}/${key.slice(2)}`));
  if (specifiers.length === 0)
    throw new Error(`${name} tarball exports에 공개 진입점이 없다`);
  return specifiers;
}

/**
 * 도출한 진입점과 기대 export 선언(`scripts/pack-smoke.mjs` `ENTRY_EXPORTS`)을 양방향으로 대조한다. 진입점을 더하고 선언을 잊거나,
 * 진입점을 지우고 선언을 남기면 오류 메시지를 돌려준다(`docs/design/09-testing.md` 9.8.3).
 */
export function compareEntryDeclarations(specifiers, declared) {
  const derived = new Set(specifiers);
  const known = new Set(declared);
  return [
    ...specifiers
      .filter((specifier) => !known.has(specifier))
      .map(
        (specifier) =>
          `진입점 ${specifier}이(가) tarball exports에 있는데 기대 export 선언(ENTRY_EXPORTS)이 없다`,
      ),
    ...declared
      .filter((specifier) => !derived.has(specifier))
      .map(
        (specifier) =>
          `기대 export를 선언한 진입점 ${specifier}이(가) tarball exports에 없다`,
      ),
  ];
}
