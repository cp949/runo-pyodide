// @vitest-environment node
/**
 * 의존 트리 수집 도우미(`src/package-boundary.ts`) 시험.
 * - 가짜 매니페스트와 임시 `node_modules` 배치로 도우미 자체를 검증한다.
 * - 실제 패키지에 대한 단언은 각 패키지의 `package-boundary.test.ts`에 있다.
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  collectDependencyNames,
  collectInstalledDependencyNames,
  findForbiddenDependencies,
  type PackageManifest,
  type ResolvedManifest,
} from "../src/package-boundary";

/** 이름 → 매니페스트 표로 만든 가짜 해석기. 표에 없는 이름은 해석되지 않는다. */
function fakeResolver(table: Record<string, PackageManifest>) {
  return (name: string): ResolvedManifest | undefined => {
    const manifest = table[name];
    return manifest === undefined
      ? undefined
      : { dir: `/fake/${name}`, manifest };
  };
}

describe("collectDependencyNames", () => {
  test("dependencies·peerDependencies·optionalDependencies 이름을 모두 모은다", () => {
    const root: ResolvedManifest = {
      dir: "/fake/root",
      manifest: {
        dependencies: { a: "1" },
        peerDependencies: { b: "1" },
        optionalDependencies: { c: "1" },
      },
    };
    const table = { a: {}, b: {}, c: {} };

    const { names } = collectDependencyNames(root, fakeResolver(table));

    expect([...names].sort()).toEqual(["a", "b", "c"]);
  });

  test("devDependencies는 따라가지 않는다", () => {
    const root: ResolvedManifest = {
      dir: "/fake/root",
      manifest: {
        dependencies: { a: "1" },
        devDependencies: { coincident: "1" },
      },
    };
    const table = { a: { devDependencies: { "reflected-ffi": "1" } } };

    const { names } = collectDependencyNames(root, fakeResolver(table));

    expect([...names]).toEqual(["a"]);
  });

  test("의존하는 패키지의 의존을 끝까지 따라간다", () => {
    const root: ResolvedManifest = {
      dir: "/fake/root",
      manifest: { dependencies: { a: "1" } },
    };
    const table = {
      a: { dependencies: { b: "1" } },
      b: { peerDependencies: { c: "1" } },
      c: { optionalDependencies: { d: "1" } },
      d: {},
    };

    const { names } = collectDependencyNames(root, fakeResolver(table));

    expect([...names].sort()).toEqual(["a", "b", "c", "d"]);
  });

  test("의존이 순환해도 끝난다", () => {
    const root: ResolvedManifest = {
      dir: "/fake/root",
      manifest: { dependencies: { a: "1" } },
    };
    const table = {
      a: { dependencies: { b: "1" } },
      b: { dependencies: { a: "1" } },
    };

    const { names } = collectDependencyNames(root, fakeResolver(table));

    expect([...names].sort()).toEqual(["a", "b"]);
  });

  test("dependencies 항목을 해석하지 못하면 부분 결과로 통과하지 않고 던진다", () => {
    const root: ResolvedManifest = {
      dir: "/fake/root",
      manifest: { dependencies: { missing: "1" } },
    };

    expect(() => collectDependencyNames(root, fakeResolver({}))).toThrow(
      /missing/,
    );
  });

  test("설치되지 않은 peerDependencies·optionalDependencies는 이름만 남기고 unresolved에 적는다", () => {
    const root: ResolvedManifest = {
      dir: "/fake/root",
      manifest: {
        peerDependencies: { p: "1" },
        optionalDependencies: { o: "1" },
      },
    };

    const { names, unresolved } = collectDependencyNames(
      root,
      fakeResolver({}),
    );

    expect([...names].sort()).toEqual(["o", "p"]);
    expect(unresolved.sort()).toEqual(["o", "p"]);
  });
});

describe("findForbiddenDependencies", () => {
  test("repl package.json 사본의 dependencies에 coincident를 넣으면 찾아낸다", () => {
    const replCopy: ResolvedManifest = {
      dir: "/fake/repl",
      manifest: {
        dependencies: {
          "@cp949/runo-pyodide-core": "0.0.0",
          coincident: "^2.0.0",
        },
      },
    };
    const table = { "@cp949/runo-pyodide-core": {}, coincident: {} };

    const { names } = collectDependencyNames(replCopy, fakeResolver(table));

    expect(findForbiddenDependencies(names)).toEqual(["coincident"]);
  });

  test("깊은 곳(전이 의존)에 숨은 reflected-ffi도 찾아낸다", () => {
    const root: ResolvedManifest = {
      dir: "/fake/root",
      manifest: { dependencies: { a: "1" } },
    };
    const table = {
      a: { dependencies: { b: "1" } },
      b: { optionalDependencies: { "reflected-ffi": "1" } },
      "reflected-ffi": {},
    };

    const { names } = collectDependencyNames(root, fakeResolver(table));

    expect(findForbiddenDependencies(names)).toEqual(["reflected-ffi"]);
  });

  test("금지 이름이 없으면 빈 배열이다", () => {
    expect(findForbiddenDependencies(new Set(["a", "b"]))).toEqual([]);
  });

  test("이름이 비슷한 다른 패키지는 걸리지 않는다", () => {
    expect(
      findForbiddenDependencies(new Set(["coincident-utils", "my-coincident"])),
    ).toEqual([]);
  });
});

describe("collectInstalledDependencyNames", () => {
  // 시험마다 만든 임시 폴더. 끝나면 지운다.
  const roots: string[] = [];
  afterEach(() => {
    for (const dir of roots.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  /** `dir/package.json`에 매니페스트를 쓴다. 폴더가 없으면 만든다. */
  function writeManifest(
    dir: string,
    manifest: PackageManifest & { name: string },
  ): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  }

  test("node_modules를 위로 올라가며 의존을 해석하고 심볼릭 링크 너머의 의존도 따라간다", () => {
    const base = mkdtempSync(join(tmpdir(), "boundary-fs-"));
    roots.push(base);
    // 작업공간처럼 실제 위치(real)와 소비 위치(app/node_modules의 심볼릭 링크)를 나눈다.
    writeManifest(join(base, "app"), {
      name: "app",
      dependencies: { lib: "1" },
    });
    writeManifest(join(base, "real", "lib"), {
      name: "lib",
      dependencies: { leaf: "1" },
    });
    writeManifest(join(base, "real", "node_modules", "leaf"), {
      name: "leaf",
      dependencies: { coincident: "1" },
    });
    writeManifest(join(base, "real", "node_modules", "coincident"), {
      name: "coincident",
    });
    mkdirSync(join(base, "app", "node_modules"), { recursive: true });
    symlinkSync(
      join(base, "real", "lib"),
      join(base, "app", "node_modules", "lib"),
    );
    // leaf는 lib의 실제 위치(real/lib) 기준으로 찾는다(real/node_modules/leaf).

    const { names } = collectInstalledDependencyNames(join(base, "app"));

    expect([...names].sort()).toEqual(["coincident", "leaf", "lib"]);
    expect(findForbiddenDependencies(names)).toEqual(["coincident"]);
  });

  test("dependencies가 설치돼 있지 않으면 던진다", () => {
    const base = mkdtempSync(join(tmpdir(), "boundary-fs-"));
    roots.push(base);
    writeManifest(join(base, "app"), {
      name: "app",
      dependencies: { absent: "1" },
    });

    expect(() => collectInstalledDependencyNames(join(base, "app"))).toThrow(
      /absent/,
    );
  });
});
