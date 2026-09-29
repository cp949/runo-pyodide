/**
 * 패키지 경계 시험 도우미. 패키지가 소비자에게 끌고 가는 런타임 의존 이름 집합을 모은다.
 *
 * 따라가는 규칙:
 * - `dependencies`·`peerDependencies`·`optionalDependencies`를 설치된 `node_modules`에서 끝까지 내려간다.
 * - `devDependencies`는 소비자에게 가지 않으므로 따라가지 않는다.
 * - 작업공간 내부 패키지는 `node_modules` 심볼릭 링크로 해석되므로 같은 규칙으로 따라간다.
 *
 * Node 전용(`node:fs`)이라 `// @vitest-environment node` 시험에서 쓴다.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 이 저장소의 패키지가 런타임에 끌고 가서는 안 되는 이름. 동기 브리지 라이브러리다(ADR-0001).
 * - `coincident`·`reflected-ffi`: 옛 upstream 이름.
 * - `@cp949/runo-coincident`·`@cp949/runo-reflected-ffi`: 2026-09-28에 대체한 포크 이름(`docs/design/16-dom-bridge.md` 16.1).
 *
 * 어느 쪽 이름으로 다시 끌려와도 잡도록 둘 다 둔다.
 */
export const FORBIDDEN_RUNTIME_DEPENDENCIES = [
  "coincident",
  "@cp949/runo-coincident",
  "reflected-ffi",
  "@cp949/runo-reflected-ffi",
] as const;

/** `package.json`에서 의존 검사가 읽는 필드만. */
export interface PackageManifest {
  /** 소비자에게 함께 설치되는 의존. 따라간다. 해석하지 못하면 오류다. */
  dependencies?: Record<string, string>;

  /** 소비자가 제공하는 의존. 따라간다. 설치돼 있지 않아도 된다. */
  peerDependencies?: Record<string, string>;

  /** 없어도 되는 의존. 따라간다. 설치돼 있지 않아도 된다. */
  optionalDependencies?: Record<string, string>;

  /** 개발 전용 의존. 소비자에게 가지 않아 따라가지 않는다. */
  devDependencies?: Record<string, string>;
}

/** 위치가 붙은 매니페스트. */
export interface ResolvedManifest {
  /** 패키지의 실제 경로. 다음 의존 해석의 기준 위치다. */
  dir: string;

  /** `dir/package.json` 내용 */
  manifest: PackageManifest;
}

/** `fromDir`에서 본 의존 `name`의 설치된 매니페스트. 설치돼 있지 않으면 `undefined`. */
export type ManifestResolver = (
  name: string,
  fromDir: string,
) => ResolvedManifest | undefined;

/** 의존 트리를 따라간 결과. */
export interface DependencyTree {
  /** 루트 패키지가 끌고 가는 모든 의존 이름(전이 포함, 루트 자신은 제외). */
  names: Set<string>;
  /** 설치돼 있지 않아 더 내려가지 못한 peer·optional 의존 이름. */
  unresolved: string[];
}

/**
 * `root`에서 시작해 의존 트리를 끝까지 따라간다(너비 우선, 같은 `dir`은 한 번만).
 * - `dependencies`를 해석하지 못하면 던진다. 설치가 덜 된 트리에서 금지 이름이 가려지는 것을 막는다.
 * - peer·optional은 설치되지 않을 수 있다. `unresolved`에 적고 넘어간다. 이름은 `names`에 들어간다.
 */
export function collectDependencyNames(
  root: ResolvedManifest,
  resolve: ManifestResolver,
): DependencyTree {
  const names = new Set<string>();
  const unresolved: string[] = [];
  const visited = new Set<string>([root.dir]);
  const queue: ResolvedManifest[] = [root];

  for (
    let current = queue.shift();
    current !== undefined;
    current = queue.shift()
  ) {
    const { dir, manifest } = current;
    const edges: Array<[Record<string, string> | undefined, boolean]> = [
      [manifest.dependencies, true],
      [manifest.peerDependencies, false],
      [manifest.optionalDependencies, false],
    ];
    for (const [table, required] of edges) {
      for (const name of Object.keys(table ?? {})) {
        names.add(name);
        const found = resolve(name, dir);
        if (found === undefined) {
          if (required)
            throw new Error(
              `의존 ${name}을(를) 해석하지 못했다(설치 기준 위치: ${dir})`,
            );
          unresolved.push(name);
          continue;
        }
        if (visited.has(found.dir)) continue;
        visited.add(found.dir);
        queue.push(found);
      }
    }
  }
  return { names, unresolved };
}

/** `names` 중 `FORBIDDEN_RUNTIME_DEPENDENCIES`와 정확히 일치하는 이름만 돌려준다. 없으면 빈 배열. */
export function findForbiddenDependencies(
  names: ReadonlySet<string>,
): string[] {
  return FORBIDDEN_RUNTIME_DEPENDENCIES.filter((name) => names.has(name));
}

/**
 * `fromDir`의 실제 경로에서 위로 올라가며 `node_modules/<name>/package.json`을 찾는다.
 * pnpm 링크는 실제 위치로 푼다. 루트까지 없으면 `undefined`.
 */
export function resolveInstalledManifest(
  name: string,
  fromDir: string,
): ResolvedManifest | undefined {
  let dir = realpathSync(fromDir);
  for (;;) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) {
      return {
        dir: realpathSync(dirname(candidate)),
        manifest: JSON.parse(
          readFileSync(candidate, "utf8"),
        ) as PackageManifest,
      };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** `packageDir/package.json`에서 시작해 설치된 `node_modules`를 따라 의존 트리를 모은다. 해석 규칙은 `collectDependencyNames`다. */
export function collectInstalledDependencyNames(
  packageDir: string,
): DependencyTree {
  const dir = realpathSync(packageDir);
  const manifest = JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8"),
  ) as PackageManifest;
  return collectDependencyNames({ dir, manifest }, resolveInstalledManifest);
}
