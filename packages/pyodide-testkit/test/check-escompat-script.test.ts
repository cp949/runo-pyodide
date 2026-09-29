// @vitest-environment node
/**
 * 루트 `scripts/check-escompat.mjs` 시험.
 * - 게이트: 빌드 floor Chrome 84를 넘는 런타임 API 사용을 막는다(ADR-0008).
 * - 스크립트를 자식 프로세스로 실행해 종료 코드와 메시지를 본다.
 * - 실제 패키지의 `dist` 검사는 각 패키지의 `check-dist` 스크립트가 `check-dist.mjs` 뒤에 이어 돌린다.
 *   turbo `check-dist`가 `build` 뒤에 실행한다.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const SCRIPT = fileURLToPath(
  new URL("../../../scripts/check-escompat.mjs", import.meta.url),
);

// 시험마다 만든 임시 폴더. 끝나면 지운다.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** 임시 폴더를 만들고 `files`(상대 경로 → 내용)를 쓴다. */
function makeDist(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "check-escompat-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

/** 스크립트를 자식 프로세스로 실행해 종료 코드와 stdout·stderr 합본을 돌려준다. `target`이 없으면 인자 없이 실행한다. */
function run(target?: string) {
  const args = target === undefined ? [] : [target];
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** 검사가 스스로 실패했다는 표식. 스크립트 부재로 난 종료 코드 1과 구분한다. */
const FAIL_MARK = "check-escompat 실패";

describe("check-escompat 스크립트", () => {
  test("대상 폴더를 주지 않으면 실패한다", () => {
    const { status, output } = run();

    expect(status).toBe(1);
    expect(output).toContain(FAIL_MARK);
  });

  test("dist 폴더가 없으면 건너뛰지 않고 실패한다", () => {
    const dist = makeDist({});
    rmSync(dist, { recursive: true });

    const { status, output } = run(dist);

    expect(status).toBe(1);
    expect(output).toContain(FAIL_MARK);
    expect(output).toContain("pnpm build");
  });

  test("dist 폴더가 비어 있으면 실패한다(검사 대상 0건은 게이트 무력화)", () => {
    const dist = makeDist({});

    expect(run(dist).output).toContain(FAIL_MARK);
  });

  describe("Chrome 84 초과 런타임 API 검출", () => {
    test.each([
      ["Array.prototype.at", "export const f = (a) => a.at(0);\n"],
      ["logical assignment ??=", "export let x; x ??= 1;\n"],
      ["Object.hasOwn", "export const f = (o, k) => Object.hasOwn(o, k);\n"],
      ["Error cause", 'export const f = () => new Error("m", { cause: 1 });\n'],
      ["top-level await", "await Promise.resolve();\nexport {};\n"],
      [
        "structuredClone(Web API)",
        "export const f = (x) => structuredClone(x);\n",
      ],
      [
        "String.prototype.replaceAll",
        'export const f = (s) => s.replaceAll("a", "b");\n',
      ],
      ["Promise.any", "export const f = (ps) => Promise.any(ps);\n"],
      [
        "class static block",
        "export class C {\n  static x;\n  static {\n    C.x = 1;\n  }\n}\n",
      ],
    ])("%s가 있으면 실패한다", (name, code) => {
      const dist = makeDist({ "index.mjs": code });

      const { status, output } = run(dist);

      expect(status, name).toBe(1);
      expect(output).toContain(FAIL_MARK);
    });

    test("주석 속 Web API 이름 언급은 오탐하지 않는다", () => {
      const dist = makeDist({
        "index.mjs":
          "// structuredClone(x)는 Chrome 98+\n/* crypto.randomUUID() 참고 */\nexport const a = 1;\n",
      });

      const { status, output } = run(dist);

      expect(status, output).toBe(0);
    });
  });

  describe("Chrome 84 지원 범위는 통과", () => {
    test("optional chaining·nullish coalescing", () => {
      const dist = makeDist({
        "index.mjs": "export const f = (a) => a?.b ?? 0;\n",
      });

      expect(run(dist).status).toBe(0);
    });

    test("private method·필드", () => {
      const dist = makeDist({
        "index.mjs":
          "export class C {\n  #x = 1;\n  #m() { return this.#x; }\n  run() { return this.#m(); }\n}\n",
      });

      const { status, output } = run(dist);

      expect(status, output).toBe(0);
    });

    test("class field(public)", () => {
      const dist = makeDist({
        "index.mjs": "export class C {\n  x = 1;\n  static y = 2;\n}\n",
      });

      expect(run(dist).status).toBe(0);
    });

    test("WeakRef", () => {
      const dist = makeDist({
        "index.mjs": "export const f = (o) => new WeakRef(o);\n",
      });

      expect(run(dist).status).toBe(0);
    });

    // Iterator helper·Set 메서드 규칙을 끈 것의 회귀 시험. 켜면 이름이 겹치는 평범한 메서드 호출이 오탐된다.
    test("Iterator helper·Set 메서드와 이름이 겹치는 배열·도메인 메서드 호출은 오탐하지 않는다", () => {
      const dist = makeDist({
        "index.mjs":
          "export const f = (a) => a.map((x) => x).filter(Boolean).forEach(() => {});\nexport const g = (receiver) => receiver.take((frame) => frame);\n",
      });

      const { status, output } = run(dist);

      expect(status, output).toBe(0);
    });
  });

  test("정상 dist는 통과한다", () => {
    const dist = makeDist({
      "index.mjs": "export const a = [1, 2].flat();\n",
      "index.d.mts": "export declare const a: number[];\n",
    });

    const { status, output } = run(dist);

    expect(status, output).toBe(0);
  });

  test("소스맵(.map)·타입 선언(.d.mts)은 대상이 아니다(금지 API가 있어도 통과)", () => {
    const dist = makeDist({
      "index.mjs": "export const a = 1;\n",
      "index.mjs.map": '{"sourcesContent":["a.at(0)"]}',
      "index.d.mts":
        "declare function f(a: unknown[]): unknown; export { f };\n// a.at(0)\n",
    });

    const { status, output } = run(dist);

    expect(status, output).toBe(0);
  });

  test("하위 폴더 안의 파일도 검사한다", () => {
    const dist = makeDist({
      "index.mjs": "export const a = 1;\n",
      "chunks/deep/x.mjs": "export const f = (o, k) => Object.hasOwn(o, k);\n",
    });

    const { status, output } = run(dist);

    expect(status).toBe(1);
    expect(output).toContain("x.mjs");
  });

  test("Atomics.waitAsync는 기능 탐지 예외로 통과한다(stdin-mailbox 폴백)", () => {
    const dist = makeDist({
      "index.mjs":
        'export const f = (i, idx, v) => typeof Atomics.waitAsync === "function" ? Atomics.waitAsync(i, idx, v) : null;\n',
    });

    const { status, output } = run(dist);

    expect(status, output).toBe(0);
  });

  test("growable SharedArrayBuffer는 기능 탐지 예외로 통과한다(dom-bridge의 canCreateGrowableSharedArrayBuffer)", () => {
    const dist = makeDist({
      "index.mjs":
        "export const f = () => { try { new SharedArrayBuffer(4, { maxByteLength: 8 }); return true; } catch { return false; } };\n",
    });

    const { status, output } = run(dist);

    expect(status, output).toBe(0);
  });
});
