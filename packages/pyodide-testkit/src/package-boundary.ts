/**
 * 패키지 경계 시험 도우미: 패키지가 소비자에게 끌고 가는 런타임 의존 이름 집합을 모은다. `dependencies`·
 * `peerDependencies`·`optionalDependencies`를 따라 설치된 `node_modules`를 끝까지 내려간다(`devDependencies`는 소비자에게
 * 가지 않으므로 따라가지 않는다). 작업공간 내부 패키지도 `node_modules` 심볼릭 링크로 해석되므로 같은 규칙으로 따라간다.
 * Node 전용(`node:fs`)이라 `// @vitest-environment node` 시험에서 쓴다.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** 이 저장소의 패키지가 런타임에 끌고 가서는 안 되는 이름(동기 브리지 라이브러리, ADR-0001). */
export const FORBIDDEN_RUNTIME_DEPENDENCIES = [
  "coincident",
  "reflected-ffi",
] as const;

/** `package.json`에서 의존 검사에 쓰는 필드만. */
export interface PackageManifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** 위치(`dir`, 다음 해석의 기준)가 붙은 매니페스트. */
export interface ResolvedManifest {
  dir: string;
  manifest: PackageManifest;
}

/** `fromDir`에서 본 의존 `name`의 설치된 매니페스트. 설치돼 있지 않으면 `undefined`. */
export type ManifestResolver = (
  name: string,
  fromDir: string,
) => ResolvedManifest | undefined;

export interface DependencyTree {
  /** 루트 패키지가 끌고 가는 모든 의존 이름(전이 포함, 루트 자신은 제외). */
  names: Set<string>;
  /** 설치돼 있지 않아 더 내려가지 못한 peer·optional 의존 이름. */
  unresolved: string[];
}

/**
 * `root`에서 시작해 의존 트리를 끝까지 따라간다. `dependencies` 항목을 해석하지 못하면 부분 결과로 통과하지 않게 던진다
 * (설치가 덜 된 트리에서 금지 이름이 가려지는 것을 막는다). peer·optional은 설치되지 않을 수 있어 `unresolved`에 적고 넘어간다.
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

/** `names` 중 금지 이름(정확히 일치)만 골라 돌려준다. 없으면 빈 배열. */
export function findForbiddenDependencies(
  names: ReadonlySet<string>,
): string[] {
  return FORBIDDEN_RUNTIME_DEPENDENCIES.filter((name) => names.has(name));
}

/** `fromDir`(의 실제 경로)에서 위로 올라가며 `node_modules/<name>/package.json`을 찾는다. pnpm 링크를 실제 위치로 푼다. */
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

/** `packageDir/package.json`에서 시작해 설치된 `node_modules`를 따라 의존 트리를 모은다. */
export function collectInstalledDependencyNames(
  packageDir: string,
): DependencyTree {
  const dir = realpathSync(packageDir);
  const manifest = JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8"),
  ) as PackageManifest;
  return collectDependencyNames({ dir, manifest }, resolveInstalledManifest);
}
