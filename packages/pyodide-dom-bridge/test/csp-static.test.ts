// @vitest-environment node
/**
 * CSP 정적 검사(RD-023 확정 11). 소스의 coincident import는 `coincident/window/main`·`coincident/window/worker`뿐이고
 * `evaluate`·`serviceWorker`·`coincident/sync`·`window.import` 사용은 0건이다. 이 규칙이 `worker-src 'self'` 같은 CSP에서 위반을
 * 내지 않는 진입점만 쓴다는 근거다(canvas 저장소 실측 F23). 검사기는 `scripts/check-dist.mjs --allow-sync-bridge`이고, 빌드 산출물
 * 검사는 패키지 `check-dist` 스크립트가 같은 옵션으로 한다. 규칙 자체(합성 파일)는 testkit `check-dist-script.test.ts`가 본다.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const SCRIPT = fileURLToPath(
  new URL("../../../scripts/check-dist.mjs", import.meta.url),
);
const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function check(dir: string) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--allow-sync-bridge", dir],
    { encoding: "utf8" },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** 소스 폴더를 임시 폴더로 복사하고 `guard.ts` 등에 한 줄을 덧붙인다(변이 확인용). */
function copySrcWith(file: string, line: string): string {
  const dir = mkdtempSync(join(tmpdir(), "csp-src-"));
  dirs.push(dir);
  cpSync(SRC_DIR, dir, { recursive: true });
  appendFileSync(join(dir, file), `\n${line}\n`);
  return dir;
}

describe("dom-bridge 소스 CSP 정적 검사", () => {
  test("현재 소스는 통과한다", () => {
    const { status, output } = check(SRC_DIR);

    expect(status, output).toBe(0);
  });

  test("소스에 coincident/sync import가 한 줄 들어가면 실패한다", () => {
    const dir = copySrcWith("index.ts", 'import "coincident/sync";');

    const { status, output } = check(dir);

    expect(status).toBe(1);
    expect(output).toContain("coincident/sync");
  });

  test("허용 목록 밖 coincident 진입점(서비스워커·서버)을 import하면 실패한다", () => {
    for (const specifier of [
      "coincident/sw",
      "coincident/server/main",
      "coincident/main",
    ]) {
      const dir = copySrcWith(
        "worker.ts",
        `import bad from "${specifier}"; void bad;`,
      );

      const { status, output } = check(dir);

      expect(status, specifier).toBe(1);
      expect(output).toContain(specifier);
    }
  });

  test("ffi.evaluate·serviceWorker 옵션·window.import 사용이 들어가면 실패한다", () => {
    for (const line of [
      "const run = (ffi: { evaluate(code: string): unknown }) => ffi.evaluate('1');",
      "const options = { serviceWorker: '/sw.js' }; void options;",
      "const load = () => window.import('x');",
    ]) {
      const dir = copySrcWith("worker.ts", line);

      expect(check(dir).status, line).toBe(1);
    }
  });
});
