// @vitest-environment node
/**
 * 루트 `scripts/check-dist.mjs`(빌드 산출물에 `coincident`·`reflected-ffi` 문자열이 없는지, `.mjs`에 `pyodide` 런타임 import가 없는지 검사) 시험. 스크립트를 자식
 * 프로세스로 실행해 종료 코드와 메시지를 본다. 실제 패키지의 `dist`를 검사하는 것은 각 패키지의 `check-dist` 스크립트다(turbo
 * `check-dist`가 `build` 뒤에 돌린다).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const SCRIPT = fileURLToPath(
  new URL("../../../scripts/check-dist.mjs", import.meta.url),
);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** 임시 폴더를 만들고 `files`(상대 경로 → 내용)를 쓴다. */
function makeDist(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "check-dist-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function run(...targets: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...targets], {
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** 동기 브리지 허용 패키지(dom-bridge)용 옵션으로 실행한다. */
function runAllowSyncBridge(...targets: string[]) {
  return run("--allow-sync-bridge", ...targets);
}

/** 스크립트가 없어서(MODULE_NOT_FOUND) 종료 코드 1이 나오는 경우와 구분하려고, 검사가 스스로 실패했다는 표식을 함께 본다. */
const FAIL_MARK = "check-dist 실패";

describe("check-dist 스크립트", () => {
  test("금지 문자열이 없는 dist는 통과한다", () => {
    const dist = makeDist({
      "index.mjs": "export const a = 1;\n",
      "index.d.mts": "export declare const a: number;\n",
    });

    const { status, output } = run(dist);

    expect(status, output).toBe(0);
  });

  test("산출물 한 파일에 coincident 문자열이 있으면 실패하고 그 파일 이름을 알린다", () => {
    const dist = makeDist({
      "index.mjs": "export const a = 1;\n",
      "worker.mjs": 'import coincident from "coincident";\n',
    });

    const { status, output } = run(dist);

    expect(status).toBe(1);
    expect(output).toContain(FAIL_MARK);
    expect(output).toContain("worker.mjs");
    expect(output).toContain("coincident");
  });

  test("하위 폴더 안의 파일도 검사한다", () => {
    const dist = makeDist({
      "index.mjs": "ok\n",
      "chunks/deep/x.mjs": "// coincident\n",
    });

    expect(run(dist).output).toContain(FAIL_MARK);
  });

  test("소스맵(.map) 안의 문자열도 잡는다", () => {
    const dist = makeDist({
      "index.mjs": "ok\n",
      "index.mjs.map": '{"sources":["../node_modules/coincident/index.js"]}',
    });

    expect(run(dist).output).toContain(FAIL_MARK);
  });

  test("대문자가 섞인 표기도 잡는다", () => {
    const dist = makeDist({ "index.mjs": "// Coincident 브리지\n" });

    expect(run(dist).output).toContain(FAIL_MARK);
  });

  test("reflected-ffi 문자열도 실패시킨다", () => {
    const dist = makeDist({ "index.mjs": 'import "reflected-ffi";\n' });

    expect(run(dist).output).toContain(FAIL_MARK);
  });

  test("dist 폴더가 없으면 건너뛰지 않고 실패한다", () => {
    const dist = makeDist({});
    rmSync(dist, { recursive: true });

    const { status, output } = run(dist);

    expect(status).toBe(1);
    expect(output).toContain(FAIL_MARK);
    expect(output).toContain("pnpm build");
  });

  test.each([
    ["정적 import(큰따옴표)", 'import { loadPyodide } from "pyodide";\n'],
    ["정적 import(작은따옴표)", "import { loadPyodide } from 'pyodide';\n"],
    ["서브패스 import", 'import { x } from "pyodide/ffi";\n'],
    ["동적 import", 'const m = await import("pyodide");\n'],
    ["부수효과 import", 'import "pyodide";\n'],
  ])(
    "`.mjs`에 pyodide 런타임 import(%s)가 있으면 실패하고 그 파일 이름을 알린다",
    (_이름, 내용) => {
      const dist = makeDist({ "index.mjs": "ok\n", "worker.mjs": 내용 });

      const { status, output } = run(dist);

      expect(status).toBe(1);
      expect(output).toContain(FAIL_MARK);
      expect(output).toContain("worker.mjs");
      expect(output).toContain("pyodide 런타임 import");
    },
  );

  test("`.d.mts`의 pyodide 타입 import와 `.mjs` 안 Python 코드 문자열은 통과한다", () => {
    const dist = makeDist({
      "worker.d.mts": 'import type { PyodideInterface } from "pyodide";\n',
      "index.mjs":
        'export const py = "from pyodide.ffi import to_js";\nexport const name = "pyodide-lock";\n',
    });

    const { status, output } = run(dist);

    expect(status, output).toBe(0);
  });

  test("dist 폴더가 비어 있으면 실패한다", () => {
    const dist = makeDist({});

    expect(run(dist).output).toContain(FAIL_MARK);
  });

  test("대상 폴더를 하나도 주지 않으면 실패한다", () => {
    expect(run().output).toContain(FAIL_MARK);
  });
});

describe("check-dist 스크립트: --allow-sync-bridge(dom-bridge 예외)", () => {
  test("허용 진입점(coincident/window/main·worker) import는 통과한다", () => {
    const dist = makeDist({
      "index.mjs": 'import coincident from "coincident/window/main";\n',
      // 관찰기 설치 import가 coincident보다 앞선다(아래 "관찰기 import 순서" 규칙).
      "worker.mjs":
        'import "./bootstrap-observer-install.mjs";\nimport coincident from "coincident/window/worker";\n',
    });

    const { status, output } = runAllowSyncBridge(dist);

    expect(status, output).toBe(0);
  });

  describe("관찰기 import 순서(coincident/window/worker보다 먼저 bootstrap-observer-install)", () => {
    test("번들러가 붙인 해시 이름의 청크를 앞에 import해도 통과한다", () => {
      const dist = makeDist({
        "worker.mjs":
          'import { t as observer } from "./bootstrap-observer-install-Ce5xa7ii.mjs";\nimport coincident from "coincident/window/worker";\n',
      });

      const { status, output } = runAllowSyncBridge(dist);

      expect(status, output).toBe(0);
    });

    test("coincident import가 관찰기 import보다 앞이면 실패한다(번들러가 외부 import를 위로 올린 모양)", () => {
      const dist = makeDist({
        "worker.mjs":
          'import coincident from "coincident/window/worker";\nimport "./bootstrap-observer-install.mjs";\n',
      });

      const { status, output } = runAllowSyncBridge(dist);

      expect(status).toBe(1);
      expect(output).toContain(FAIL_MARK);
      expect(output).toContain("worker.mjs");
      expect(output).toContain("뒤에 있다");
    });

    test("관찰기 import가 없으면 실패한다(인라인된 경우)", () => {
      const dist = makeDist({
        "worker.mjs":
          'import coincident from "coincident/window/worker";\nconst observer = 1;\n',
      });

      const { status, output } = runAllowSyncBridge(dist);

      expect(status).toBe(1);
      expect(output).toContain(FAIL_MARK);
      expect(output).toContain("bootstrap-observer-install import가 없다");
    });

    test("주석에만 있는 관찰기 import는 세지 않는다", () => {
      const dist = makeDist({
        "worker.mjs":
          '// import "./bootstrap-observer-install.mjs";\nimport coincident from "coincident/window/worker";\n',
      });

      const { status } = runAllowSyncBridge(dist);

      expect(status).toBe(1);
    });

    test("coincident/window/worker를 import하지 않는 파일(main 진입점 등)은 대상이 아니다", () => {
      const dist = makeDist({
        "index.mjs": 'import coincident from "coincident/window/main";\n',
      });

      const { status, output } = runAllowSyncBridge(dist);

      expect(status, output).toBe(0);
    });

    test("옵션 없는 검사에는 이 규칙이 없다(다른 패키지는 coincident 문자열 자체가 실패다)", () => {
      const dist = makeDist({ "index.mjs": "export const a = 1;\n" });

      const { status } = run(dist);

      expect(status).toBe(0);
    });
  });

  test("옵션 없이는 같은 dist가 그대로 실패한다(다른 패키지의 금지 보장은 약해지지 않는다)", () => {
    const dist = makeDist({
      "index.mjs": 'import coincident from "coincident/window/main";\n',
    });

    const { status, output } = run(dist);

    expect(status).toBe(1);
    expect(output).toContain(FAIL_MARK);
  });

  test.each([
    ["coincident/sync", 'import "coincident/sync";\n'],
    ["coincident/sw", 'import "coincident/sw";\n'],
    ["coincident/main", 'import c from "coincident/main";\n'],
    ["coincident/server/worker", 'import c from "coincident/server/worker";\n'],
    ["coincident/window/sync", 'import c from "coincident/window/sync";\n'],
    ["coincident", 'import c from "coincident";\n'],
    ["동적 import", 'const c = await import("coincident/sync");\n'],
    ["reflected-ffi", 'import r from "reflected-ffi/remote";\n'],
  ])("허용 밖 진입점(%s)은 실패한다", (이름, 내용) => {
    const dist = makeDist({ "worker.mjs": 내용 });

    const { status, output } = runAllowSyncBridge(dist);

    expect(status, 이름).toBe(1);
    expect(output).toContain(FAIL_MARK);
    expect(output).toContain("worker.mjs");
    expect(output).toContain("CSP");
  });

  test.each([
    ["evaluate", "const r = ffi.evaluate('1');\n"],
    ["serviceWorker", "const o = { serviceWorker: '/sw.js' };\n"],
    ["window.import", "await window.import('x');\n"],
    ["멤버 import 호출", "await w.import('x');\n"],
  ])("CSP 금지 사용(%s)이 있으면 실패한다", (이름, 내용) => {
    const dist = makeDist({ "worker.mjs": 내용 });

    const { status, output } = runAllowSyncBridge(dist);

    expect(status, 이름).toBe(1);
    expect(output).toContain("CSP");
  });

  test("주석 안의 금지 표현과 동적 import()는 통과한다", () => {
    const dist = makeDist({
      "worker.mjs":
        "// ffi.evaluate와 serviceWorker는 쓰지 않는다\n/* window.import, coincident/sync */\nconst m = await import('./x.mjs');\n",
    });

    const { status, output } = runAllowSyncBridge(dist);

    expect(status, output).toBe(0);
  });

  describe("주석 제거가 코드를 지우지 않는다", () => {
    // 줄 주석 속 `/*`가 블록 주석 시작으로 잡히면 다음 `*/`(번들러의 `/* @__PURE__ */` 등)까지 실제 코드가 사라진다.
    test("줄 주석 속 `/*` 뒤의 금지 import는 여전히 실패한다", () => {
      const dist = makeDist({
        "worker.mjs":
          '// 예: dist/*.mjs 파일\nimport "coincident/sync";\nconst x = /* @__PURE__ */ f();\n',
      });

      const { status, output } = runAllowSyncBridge(dist);

      expect(status, output).toBe(1);
      expect(output).toContain("coincident/sync");
    });

    test("줄 주석 속 `/*` 뒤의 관찰기 import 순서 위반도 실패한다", () => {
      const dist = makeDist({
        "worker.mjs":
          '// 예: dist/*.mjs 파일\nimport coincident from "coincident/window/worker";\nimport "./bootstrap-observer-install.mjs";\nconst x = /* @__PURE__ */ f();\n',
      });

      const { status, output } = runAllowSyncBridge(dist);

      expect(status, output).toBe(1);
      expect(output).toContain("뒤에 있다");
    });

    test("블록 주석 속 `//`는 뒤 코드를 가리지 않는다", () => {
      const dist = makeDist({
        "worker.mjs":
          '/* 주소: https://예시.test // 끝 */ import "coincident/sync";\n',
      });

      const { status, output } = runAllowSyncBridge(dist);

      expect(status, output).toBe(1);
      expect(output).toContain("coincident/sync");
    });

    test("주석을 지운 뒤 남은 올바른 코드는 통과한다(줄 주석 속 `/*`와 뒤의 `/* @__PURE__ */`)", () => {
      const dist = makeDist({
        "worker.mjs":
          '// 예: dist/*.mjs 파일\nimport "./bootstrap-observer-install.mjs";\nimport coincident from "coincident/window/worker";\nconst x = /* @__PURE__ */ f();\n',
      });

      const { status, output } = runAllowSyncBridge(dist);

      expect(status, output).toBe(0);
    });
  });

  describe("템플릿 리터럴 지정자", () => {
    test.each([
      ["import(`coincident/sw`)", "const m = await import(`coincident/sw`);\n"],
      [
        "require(`reflected-ffi/remote`)",
        "const r = require(`reflected-ffi/remote`);\n",
      ],
    ])(
      "`${` 없는 템플릿 리터럴 지정자(%s)도 허용 밖이면 실패한다",
      (이름, 내용) => {
        const dist = makeDist({ "worker.mjs": 내용 });

        const { status, output } = runAllowSyncBridge(dist);

        expect(status, 이름).toBe(1);
        expect(output).toContain("CSP");
      },
    );

    test("`${`가 있는 템플릿 import(런타임 경로)는 지정자로 보지 않는다", () => {
      const dist = makeDist({
        "worker.mjs": "const m = await import(`${base}pyodide-x.mjs`);\n",
      });

      const { status, output } = runAllowSyncBridge(dist);

      expect(status, output).toBe(0);
    });
  });

  describe("코드 확장자 밖 파일", () => {
    test.each([
      ["worker.tsx", 'import c from "coincident/sw";\n'],
      ["worker.jsx", 'import c from "coincident/sw";\n'],
    ])("%s도 CSP 규칙을 받는다", (파일, 내용) => {
      const dist = makeDist({ [파일]: 내용 });

      const { status, output } = runAllowSyncBridge(dist);

      expect(status, 파일).toBe(1);
      expect(output).toContain(파일);
      expect(output).toContain("CSP");
    });

    test.each([
      [
        "page.html",
        '<script type="module">import "coincident/sync";</script>\n',
      ],
      ["bridge.json", '{"entry":"reflected-ffi/remote"}\n'],
    ])(
      "코드도 소스맵도 아닌 파일(%s)은 금지 문자열 검사를 받는다",
      (파일, 내용) => {
        const dist = makeDist({ "worker.mjs": "ok\n", [파일]: 내용 });

        const { status, output } = runAllowSyncBridge(dist);

        expect(status, 파일).toBe(1);
        expect(output).toContain(파일);
        expect(output).toContain("금지 문자열");
      },
    );

    test("시험 파일(.test.tsx)은 CSP 검사에서 제외한다", () => {
      const dist = makeDist({
        "worker.mjs": "ok\n",
        "worker.test.tsx": 'import "coincident/sync";\n',
      });

      const { status, output } = runAllowSyncBridge(dist);

      expect(status, output).toBe(0);
    });
  });

  test("소스맵과 시험 파일은 CSP 검사에서 제외한다", () => {
    const dist = makeDist({
      "worker.mjs": "ok\n",
      "worker.mjs.map": '{"sourcesContent":["import \\"coincident/sync\\""]}',
      "worker.test.ts": 'import "coincident/sync";\n',
    });

    const { status, output } = runAllowSyncBridge(dist);

    expect(status, output).toBe(0);
  });

  test(".ts 소스도 검사한다(src 폴더 검사)", () => {
    const src = makeDist({
      "worker.ts": 'import "coincident/sync";\n',
      "coincident.d.ts": 'declare module "coincident/window/main" {}\n',
    });

    const { status, output } = runAllowSyncBridge(src);

    expect(status).toBe(1);
    expect(output).toContain("worker.ts");
    expect(output).not.toContain("coincident.d.ts");
  });

  test("pyodide 런타임 import는 이 옵션에서도 실패한다", () => {
    const dist = makeDist({
      "worker.mjs": 'import { loadPyodide } from "pyodide";\n',
    });

    const { status, output } = runAllowSyncBridge(dist);

    expect(status).toBe(1);
    expect(output).toContain("pyodide 런타임 import");
  });

  test("dist 폴더가 없으면 이 옵션에서도 건너뛰지 않고 실패한다", () => {
    const dist = makeDist({});
    rmSync(dist, { recursive: true });

    const { status, output } = runAllowSyncBridge(dist);

    expect(status).toBe(1);
    expect(output).toContain("pnpm build");
  });

  test("옵션만 주고 폴더를 주지 않으면 실패한다", () => {
    expect(runAllowSyncBridge().output).toContain(FAIL_MARK);
  });
});
