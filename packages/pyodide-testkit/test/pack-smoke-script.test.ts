// @vitest-environment node
/**
 * 루트 `scripts/pack-smoke/manifest.mjs`(tarball 매니페스트 정적 검사) 시험. `smoke:pack`은 수동 L0라 pack·설치 없이 판정 함수만
 * 여기서 고정한다: 모든 패키지 공통 규칙(`workspace:`·`catalog:` 잔존, `exports` 대상 누락), 패키지별 정책 표(`MANIFEST_POLICY`),
 * 소비자가 import할 진입점의 도출(tarball `exports` 키)과 기대 export 선언 표와의 양방향 대조.
 * 정책 표는 패키지 이름이 키라 이름이 틀리면 조용히 검사가 빠진다 — 표의 키가 작업공간 배포 패키지 이름인지도 본다.
 * 실제 tarball을 검사하는 것은 `pnpm smoke:pack`이다(`docs/design/09-testing.md` 9.8.3).
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

type Manifest = Record<string, unknown>;
type CheckResult = { errors: string[]; missingExports: string[] };
type ManifestModule = {
  MANIFEST_POLICY: Record<string, unknown>;
  checkPackedManifest: (input: {
    name: string;
    manifest: Manifest;
    files: Set<string>;
    source: Manifest;
  }) => CheckResult;
  entrySpecifiers: (name: string, exports: unknown) => string[];
  compareEntryDeclarations: (
    specifiers: string[],
    declared: string[],
  ) => string[];
};

const ROOT = new URL("../../../", import.meta.url);
const {
  MANIFEST_POLICY,
  checkPackedManifest,
  entrySpecifiers,
  compareEntryDeclarations,
} = (await import(
  new URL("scripts/pack-smoke/manifest.mjs", ROOT).href
)) as ManifestModule;

const CORE = "@cp949/runo-pyodide-core";
const REACT = "@cp949/runo-pyodide-repl-react";
const BRIDGE = "@cp949/runo-pyodide-dom-bridge";
const PLAIN = "@cp949/runo-pyodide-terminal";

/** 정책을 모두 만족하는 pack 결과 매니페스트(패키지별). 시험은 여기서 한 곳만 바꿔 규칙 하나를 어긴다. */
function validManifest(name: string): Manifest {
  const base = {
    name,
    version: "0.0.0",
    exports: {
      ".": { types: "./dist/index.d.mts", default: "./dist/index.mjs" },
      "./test-utils": null,
      "./package.json": "./package.json",
    },
  };
  if (name === CORE)
    return {
      ...base,
      peerDependencies: { pyodide: "^314.0.7" },
      peerDependenciesMeta: { pyodide: { optional: true } },
    };
  if (name === REACT)
    return {
      ...base,
      dependencies: { [CORE]: "0.0.0", "@xterm/addon-fit": "0.11.0" },
      peerDependencies: {
        react: "^19.0.0",
        "react-dom": "^19.0.0",
        "@xterm/xterm": "^6.0.0",
      },
    };
  if (name === BRIDGE)
    return {
      ...base,
      dependencies: {
        "@cp949/runo-coincident":
          "file:/work/cp949/runo/runo-coincident/packages/coincident",
        "@cp949/runo-reflected-ffi":
          "file:/work/cp949/runo/runo-reflected-ffi/packages/reflected-ffi",
      },
      peerDependencies: { [CORE]: "0.0.0" },
      sideEffects: [
        "./dist/worker.mjs",
        "./dist/bootstrap-observer-install*.mjs",
      ],
    };
  return { ...base, dependencies: { [CORE]: "0.0.0" } };
}

/** 작업공간 `package.json`(정확 버전 대조의 원천). */
const SOURCE: Manifest = {
  dependencies: {
    "@cp949/runo-coincident":
      "file:/work/cp949/runo/runo-coincident/packages/coincident",
    "@cp949/runo-reflected-ffi":
      "file:/work/cp949/runo/runo-reflected-ffi/packages/reflected-ffi",
    "@xterm/addon-fit": "0.11.0",
  },
};

const FILES = new Set([
  "package/package.json",
  "package/dist/index.mjs",
  "package/dist/index.d.mts",
]);

function check(name: string, patch: (manifest: Manifest) => void = () => {}) {
  const manifest = structuredClone(validManifest(name));
  patch(manifest);
  return checkPackedManifest({ name, manifest, files: FILES, source: SOURCE });
}

const deps = (manifest: Manifest, field = "dependencies") =>
  manifest[field] as Record<string, string>;

describe("pack-smoke 매니페스트 판정 — 공통 규칙", () => {
  test.each([PLAIN, CORE, REACT, BRIDGE])(
    "정책을 모두 만족하는 %s 매니페스트는 오류가 없다",
    (name) => {
      expect(check(name)).toEqual({ errors: [], missingExports: [] });
    },
  );

  test.each(["dependencies", "peerDependencies", "optionalDependencies"])(
    "%s에 workspace: 범위가 남으면 오류다",
    (field) => {
      const { errors } = check(PLAIN, (m) => {
        m[field] = { ...(m[field] as object), "@cp949/x": "workspace:*" };
      });
      expect(errors.join("\n")).toContain("workspace:");
    },
  );

  test("어느 필드든 catalog:가 남으면 오류다(devDependencies 포함)", () => {
    const { errors } = check(PLAIN, (m) => {
      m.devDependencies = { typescript: "catalog:" };
    });
    expect(errors.join("\n")).toContain("catalog:");
  });

  test("exports 대상이 tarball 파일에 없으면 조건 이름과 무관하게 누락 목록에 들고, null은 건너뛴다", () => {
    const result = check(PLAIN, (m) => {
      m.exports = {
        ".": {
          development: "./src/index.ts",
          types: "./dist/index.d.mts",
          default: "./dist/index.mjs",
        },
        "./test-utils": null,
        "./package.json": "./package.json",
      };
    });
    expect(result).toEqual({
      errors: [],
      missingExports: ["exports...development -> ./src/index.ts"],
    });
  });
});

describe("pack-smoke 매니페스트 판정 — 패키지별 정책 표", () => {
  test("정책 표의 키는 모두 pack 대상(publishConfig.exports가 있는 작업공간 패키지) 이름이다(이름이 틀리면 검사가 조용히 빠진다)", () => {
    const names = readdirSync(new URL("packages/", ROOT))
      .map(
        (dir) =>
          JSON.parse(
            readFileSync(new URL(`packages/${dir}/package.json`, ROOT), "utf8"),
          ) as { name: string; publishConfig?: { exports?: unknown } },
      )
      .filter((manifest) => manifest.publishConfig?.exports !== undefined)
      .map((manifest) => manifest.name);
    expect(Object.keys(MANIFEST_POLICY).length).toBeGreaterThan(0);
    for (const name of Object.keys(MANIFEST_POLICY))
      expect(names).toContain(name);
  });

  test("core는 peerDependencies.pyodide가 ^ 범위여야 한다", () => {
    expect(
      check(CORE, (m) => {
        deps(m, "peerDependencies").pyodide = "314.0.7";
      }).errors.join("\n"),
    ).toContain("peerDependencies.pyodide");
    expect(
      check(CORE, (m) => {
        delete m.peerDependencies;
      }).errors.join("\n"),
    ).toContain("peerDependencies.pyodide");
  });

  test("core는 peerDependenciesMeta.pyodide.optional=true여야 한다", () => {
    const { errors } = check(CORE, (m) => {
      delete m.peerDependenciesMeta;
    });
    expect(errors.join("\n")).toContain("optional");
  });

  test("정책 표가 pyodide peer를 선언하지 않은 패키지에 peerDependencies.pyodide가 있으면 오류다", () => {
    const { errors } = check(PLAIN, (m) => {
      m.peerDependencies = { pyodide: "^314.0.7" };
    });
    expect(errors.join("\n")).toContain("peerDependencies.pyodide");
  });

  test.each(["react", "react-dom", "@xterm/xterm"])(
    "react는 %s를 peer로 선언하고 dependencies에 두지 않는다",
    (peer) => {
      expect(
        check(REACT, (m) => {
          delete deps(m, "peerDependencies")[peer];
        }).errors.join("\n"),
      ).toContain(`peerDependencies.${peer}`);
      expect(
        check(REACT, (m) => {
          deps(m)[peer] = "^1.0.0";
        }).errors.join("\n"),
      ).toContain(`dependencies에 peer여야 할 ${peer}`);
    },
  );

  test("react의 @xterm/addon-fit은 작업공간 선언과 같은 정확 버전이어야 한다", () => {
    expect(
      check(REACT, (m) => {
        deps(m)["@xterm/addon-fit"] = "^0.11.0";
      }).errors.join("\n"),
    ).toContain("@xterm/addon-fit");
    expect(
      check(REACT, (m) => {
        deps(m)["@xterm/addon-fit"] = "0.10.0";
      }).errors.join("\n"),
    ).toContain("@xterm/addon-fit");
  });

  test("dom-bridge의 dependencies는 @cp949/runo-coincident·@cp949/runo-reflected-ffi 둘뿐이다", () => {
    const { errors } = check(BRIDGE, (m) => {
      deps(m).extra = "1.0.0";
    });
    expect(errors.join("\n")).toContain("dependencies");
  });

  test("dom-bridge는 core를 peer로만 선언한다", () => {
    expect(
      check(BRIDGE, (m) => {
        delete m.peerDependencies;
      }).errors.join("\n"),
    ).toContain(`peerDependencies.${CORE}`);
    expect(
      check(BRIDGE, (m) => {
        deps(m)[CORE] = "0.0.0";
      }).errors.join("\n"),
    ).toContain(`dependencies에 peer여야 할 ${CORE}`);
  });

  test("dom-bridge의 sideEffects는 ./dist/worker.mjs를 포함한 배열이어야 한다", () => {
    expect(
      check(BRIDGE, (m) => {
        m.sideEffects = false;
      }).errors.join("\n"),
    ).toContain("sideEffects");
    expect(
      check(BRIDGE, (m) => {
        m.sideEffects = ["./dist/other.mjs"];
      }).errors.join("\n"),
    ).toContain("sideEffects");
  });
});

describe("pack-smoke 진입점 도출과 선언 대조", () => {
  test("진입점은 exports 키에서 null·./package.json을 뺀 것이고 .은 패키지 이름이다", () => {
    expect(
      entrySpecifiers(CORE, {
        ".": { types: "./dist/index.d.mts", default: "./dist/index.mjs" },
        "./worker": "./dist/worker.mjs",
        "./test-utils": null,
        "./package.json": "./package.json",
      }),
    ).toEqual([CORE, `${CORE}/worker`]);
  });

  test("exports가 문자열(단축형)이면 진입점은 패키지 이름 하나다", () => {
    expect(entrySpecifiers(PLAIN, "./dist/index.mjs")).toEqual([PLAIN]);
  });

  test("조건 객체만 있는 exports(단축형)도 진입점은 패키지 이름 하나다", () => {
    expect(
      entrySpecifiers(PLAIN, {
        types: "./dist/index.d.mts",
        default: "./dist/index.mjs",
      }),
    ).toEqual([PLAIN]);
  });

  test.each([{}, { ".": null }, { "./package.json": "./package.json" }])(
    "공개 진입점이 하나도 없는 exports(%j)는 던진다",
    (exports) => {
      expect(() => entrySpecifiers(PLAIN, exports)).toThrow(PLAIN);
    },
  );

  test("exports가 없으면 진입점이 없다는 오류로 던진다(도출 목록이 비면 import 검사가 조용히 빠진다)", () => {
    expect(() => entrySpecifiers(PLAIN, undefined)).toThrow(PLAIN);
  });

  test("도출과 선언이 같으면 오류가 없다(순서 무관)", () => {
    expect(
      compareEntryDeclarations(
        [CORE, `${CORE}/worker`],
        [`${CORE}/worker`, CORE],
      ),
    ).toEqual([]);
  });

  test("tarball exports에 있는데 기대 export 선언이 없는 진입점은 오류다", () => {
    const errors = compareEntryDeclarations([CORE, `${CORE}/worker`], [CORE]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`${CORE}/worker`);
  });

  test("선언했는데 tarball exports에 없는 진입점은 오류다", () => {
    const errors = compareEntryDeclarations([CORE], [CORE, `${CORE}/gone`]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`${CORE}/gone`);
  });
});
