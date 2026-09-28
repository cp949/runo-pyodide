// @vitest-environment node
/**
 * dom-bridge 패키지 경계. coincident는 이 패키지에만 있다(ADR-0006). 여기서는 두 가지를 강제한다.
 * ① dom-bridge 자신의 의존 선언: coincident·reflected-ffi 정확한 버전, core는 peer(타입만 쓴다), REPL·터미널·pyodide 비의존.
 * ② 다른 패키지(core·terminal·repl·react·xterm-readline)의 의존 트리에 dom-bridge·coincident가 새지 않는다(기존 금지 보장 유지).
 * core·terminal·repl·react 자신의 `package-boundary.test.ts`는 그대로 두고, 여기서는 반대 방향(dom-bridge가 생긴 뒤에도
 * 그 트리들에 dom-bridge가 없다)을 본다.
 * ③ `check-dist`의 허용 모드 플래그(`--allow-sync-bridge`)가 다른 5개 패키지의 `scripts`로 새지 않는다.
 * ④ 배포 패키지 6종 모두 `publishConfig.exports`의 키가 `exports`와 같고 `development` 조건이 없다. 키가 어긋나면 tarball에서 진입점이
 * 빠진다. `smoke:pack`도 `ENTRY_EXPORTS`에 선언된 진입점이 tarball `exports`에 없으면 선언 대조에서 실패하지만 수동 L0라, 여기서
 * `pnpm test`로 막는다(`docs/design/09-testing.md` 9.8.3).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  collectInstalledDependencyNames,
  findForbiddenDependencies,
  type PackageManifest,
} from "@repo/pyodide-testkit/package-boundary";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(
  readFileSync(`${PACKAGE_DIR}/package.json`, "utf8"),
) as PackageManifest & {
  scripts?: Record<string, string>;
  sideEffects?: unknown;
  exports?: Record<string, Record<string, string> | string>;
  publishConfig?: { exports?: Record<string, Record<string, string> | string> };
};

describe("dom-bridge 자신의 의존 선언", () => {
  test("coincident 4.1.1·reflected-ffi 0.7.2를 정확한 버전으로 고정한다", () => {
    expect(manifest.dependencies).toEqual({
      "@cp949/runo-coincident": "file:/work/cp949/runo/runo-coincident/packages/coincident",
      "reflected-ffi": "0.7.2",
    });
  });

  test("core는 peer + dev로 두고 dependencies에 넣지 않는다(WorkerPlugin 타입만 쓴다)", () => {
    expect(manifest.peerDependencies?.["@cp949/runo-pyodide-core"]).toBe(
      "workspace:*",
    );
    expect(manifest.devDependencies?.["@cp949/runo-pyodide-core"]).toBe(
      "workspace:*",
    );
    expect(manifest.dependencies?.["@cp949/runo-pyodide-core"]).toBeUndefined();
  });

  test("의존 트리에 REPL·터미널·xterm이 없고 pyodide를 직접 의존으로 선언하지 않는다", () => {
    const { names } = collectInstalledDependencyNames(PACKAGE_DIR);

    for (const name of [
      "@cp949/runo-pyodide-repl",
      "@cp949/runo-pyodide-terminal",
      "@cp949/runo-pyodide-repl-react",
      "@cp949/runo-xterm-readline",
      "@xterm/xterm",
    ])
      expect(names.has(name), name).toBe(false);
    // `pyodide`는 core의 optional peer라 트리에 이름이 잡힐 수 있다. 이 패키지가 직접 선언하는 것은 devDependencies(시험용)뿐이다.
    expect(manifest.dependencies?.pyodide).toBeUndefined();
    expect(manifest.peerDependencies?.pyodide).toBeUndefined();
  });

  test("의존 트리를 실제로 따라갔다(coincident·reflected-ffi·core가 잡힌다)", () => {
    // 아무것도 따라가지 못해 빈 집합이 되면 위 단언이 항상 통과하므로, 트리를 걸었다는 증거를 함께 단언한다.
    const { names } = collectInstalledDependencyNames(PACKAGE_DIR);

    expect(names).toContain("@cp949/runo-coincident");
    expect(names).toContain("reflected-ffi");
    expect(names).toContain("@cp949/runo-pyodide-core");
    // FORBIDDEN_RUNTIME_DEPENDENCIES(@repo/pyodide-testkit)는 리터럴 "coincident"만 안다 — 이름을
    // "@cp949/runo-coincident"로 바꾸면 이 상수도 갱신해야 같은 보증이 유지된다(스파이크 범위 밖, 별도 기록).
    expect(findForbiddenDependencies(names)).toEqual(["reflected-ffi"]);
  });

  test("sideEffects는 worker 진입점과 관찰기 설치 모듈(import 시점 리스너, dist의 해시 청크 포함)을 트리셰이킹에서 지키는 배열이다", () => {
    expect(manifest.sideEffects).toEqual([
      "./dist/worker.mjs",
      "./dist/bootstrap-observer-install*.mjs",
      "./src/worker.ts",
      "./src/bootstrap-observer-install.ts",
    ]);
  });

  test("tarball exports(publishConfig)는 development 조건을 뺀 같은 진입점이다", () => {
    const workspaceExports = manifest.exports ?? {};
    const publishExports = manifest.publishConfig?.exports ?? {};

    expect(Object.keys(publishExports)).toEqual(Object.keys(workspaceExports));
    expect(Object.keys(workspaceExports)).toEqual([
      ".",
      "./worker",
      "./package.json",
    ]);
    expect(JSON.stringify(publishExports)).not.toContain("development");
    expect(JSON.stringify(publishExports)).not.toContain("/src/");
  });
});

describe("다른 패키지의 의존 트리에는 dom-bridge·coincident가 없다", () => {
  test.each([
    ["core", "../../pyodide-core"],
    ["terminal", "../../pyodide-terminal"],
    ["repl", "../../pyodide-repl"],
    ["react", "../../pyodide-repl-react"],
    ["xterm-readline", "../../xterm-readline"],
  ])("%s", (_이름, relative) => {
    const dir = fileURLToPath(new URL(`${relative}/`, import.meta.url));

    const { names } = collectInstalledDependencyNames(dir);

    expect(findForbiddenDependencies(names)).toEqual([]);
    expect(names.has("@cp949/runo-pyodide-dom-bridge")).toBe(false);
  });
});

/** 저장소 안 패키지 폴더(`../../<name>/`)의 `package.json`. */
function readManifest(relative: string) {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`${relative}/package.json`, import.meta.url)),
      "utf8",
    ),
  ) as PackageManifest & {
    name: string;
    scripts?: Record<string, string>;
    exports?: Record<string, unknown>;
    publishConfig?: { exports?: Record<string, unknown> };
  };
}

describe("check-dist 허용 모드 플래그는 dom-bridge에만 있다", () => {
  test.each([
    ["core", "../../pyodide-core"],
    ["terminal", "../../pyodide-terminal"],
    ["repl", "../../pyodide-repl"],
    ["react", "../../pyodide-repl-react"],
    ["xterm-readline", "../../xterm-readline"],
  ])(
    "%s의 package.json scripts에 --allow-sync-bridge가 없고 check-dist는 금지 문자열 검사를 받는다",
    (_이름, relative) => {
      const scripts = readManifest(relative).scripts ?? {};

      // check-dist가 있어야 "플래그 없음"이 금지 문자열 검사를 받는다는 뜻이 된다(스크립트가 사라지면 이 단언이 빈 통과가 된다).
      expect(scripts["check-dist"]).toContain("scripts/check-dist.mjs");
      for (const [name, command] of Object.entries(scripts))
        expect(command, name).not.toContain("--allow-sync-bridge");
    },
  );

  test("dom-bridge 자신은 허용 모드로 검사한다(대조)", () => {
    expect(manifest.scripts?.["check-dist"]).toContain("--allow-sync-bridge");
  });
});

describe("배포 패키지 6종의 tarball exports(publishConfig)는 작업공간 exports와 키가 같고 development 조건이 없다", () => {
  test.each([
    ["core", "../../pyodide-core"],
    ["terminal", "../../pyodide-terminal"],
    ["repl", "../../pyodide-repl"],
    ["react", "../../pyodide-repl-react"],
    ["xterm-readline", "../../xterm-readline"],
    ["dom-bridge", ".."],
  ])("%s", (_이름, relative) => {
    const target = readManifest(relative);
    const workspaceExports = target.exports ?? {};
    const publishExports = target.publishConfig?.exports;

    expect(publishExports, target.name).toBeDefined();
    expect(Object.keys(publishExports ?? {}).sort()).toEqual(
      Object.keys(workspaceExports).sort(),
    );
    // 값을 모두 훑어 `development` 조건 키가 어느 깊이에도 없음을 본다.
    const conditionKeys: string[] = [];
    const walk = (value: unknown) => {
      if (value === null || typeof value !== "object") return;
      for (const [key, inner] of Object.entries(value)) {
        conditionKeys.push(key);
        walk(inner);
      }
    };
    walk(publishExports);
    expect(conditionKeys).not.toContain("development");
    expect(Object.keys(workspaceExports).length).toBeGreaterThan(0);
  });
});
