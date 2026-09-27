// e2e check 스크립트 등록 4곳(package.json e2e:*·sets.mjs SETS·README.md 명령 표·BASELINE.md 2절 표)이
// `checks/` 디렉터리의 실제 파일 집합과 같은지 대조한다. 등록 누락이 조용히 L2에서만 드러난 전례
// (`.scratch/repl-run-source-followups/issues/11`, run-source가 SETS에서 빠져 baseline 미실행)를
// L0에서 잡는다. `pnpm --filter demo test`가 실행한다. 양성 대조 포함: 각 소스에서 파일 하나를
// 메모리 사본으로 지워보고 본 판정과 같은 함수(`registryMismatches`·`modeEntriesWithDevPreview`)가
// 실패를 내는지 확인한다(실제 저장소 파일은 건드리지 않는다).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETS } from "./sets.mjs";

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.dirname(e2eDir);

function checksFilesFromPackageJson(pkg) {
  const out = new Set();
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    if (!name.startsWith("e2e:")) continue;
    const m = cmd.match(/e2e\/checks\/([a-z0-9-]+\.mjs)/);
    if (m) out.add(m[1]);
  }
  return out;
}

function checksFilesFromSets(sets) {
  const out = new Set();
  for (const entry of sets) {
    const m = entry.file.match(/^checks\/([a-z0-9-]+\.mjs)$/);
    if (m) out.add(m[1]);
  }
  return out;
}

function checksFilesFromReadme(readme) {
  const out = new Set();
  for (const m of readme.matchAll(/e2e\/checks\/([a-z0-9-]+\.mjs)/g)) out.add(m[1]);
  return out;
}

function checksFilesFromBaseline(baseline) {
  const out = new Set();
  for (const line of baseline.split("\n")) {
    const m = line.match(/^\| `([a-z0-9-]+\.mjs)/);
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * `checks/`만 대조한다(RD-044 범위). `measure/*.mjs` 7개와 `cpu-throttle-probe`
 * (SETS·baseline 미등록, package.json·README에는 기록용으로만 있다 — 검증이 L3에 걸려 이 시험의 L0
 * 범위 밖, `.scratch/e2e-check-runner-followups/issues/02-measure-entry-boilerplate.md`)는 이 네 소스의 비교
 * 대상에서 자연히 빠진다(정규식이 `checks/`만 잡는다) — 별도 허용 목록이 필요 없다.
 */
function loadSources() {
  const pkg = JSON.parse(readFileSync(path.join(demoDir, "package.json"), "utf8"));
  const readme = readFileSync(path.join(e2eDir, "README.md"), "utf8");
  const baseline = readFileSync(path.join(e2eDir, "BASELINE.md"), "utf8");
  return {
    dir: new Set(readdirSync(path.join(e2eDir, "checks")).filter((f) => f.endsWith(".mjs"))),
    packageJson: checksFilesFromPackageJson(pkg),
    sets: checksFilesFromSets(SETS),
    readme: checksFilesFromReadme(readme),
    baseline: checksFilesFromBaseline(baseline),
  };
}

/**
 * `checks/` 디렉터리 실측(`dir`)과 파일 집합이 다른 등록 소스 이름을 돌려준다(빈 배열 = 일치). 기준을
 * 디렉터리로 두므로 새 스크립트를 넣고 네 곳 모두에 등록을 빠뜨린 경우도 잡는다.
 */
function registryMismatches({ dir, ...registered }) {
  const expected = [...dir].sort().join(",");
  return Object.entries(registered)
    .filter(([, files]) => [...files].sort().join(",") !== expected)
    .map(([name]) => name);
}

/**
 * mode 인자(`args`)와 `server: "dev+preview"`를 함께 쓴 SETS 항목. `parseArgs`는 mode 경로에서
 * `previewUrl`을 항상 비우므로 `runOneScript`가 붙인 preview URL이 스크립트의 `rest[0]`(예: repl-check의
 * screenshot 경로)로 잘못 흘러든다(`sets.mjs` SETS 머리 주석).
 */
function modeEntriesWithDevPreview(sets) {
  return sets.filter((e) => e.args && e.args.length > 0 && e.server === "dev+preview");
}

describe("registry: checks/ 파일 등록 4곳 대조", () => {
  it("package.json e2e:* ↔ SETS ↔ README ↔ BASELINE이 checks/ 디렉터리의 파일 집합과 같다", () => {
    const sources = loadSources();
    expect(sources.dir.size).toBeGreaterThan(0);
    expect(registryMismatches(sources)).toEqual([]);
  });

  it("양성 대조: SETS에서 파일 하나가 빠지면 대조가 실패한다", () => {
    const sources = loadSources();
    const sets = checksFilesFromSets(SETS.filter((e) => e.file !== "checks/tab-check.mjs"));
    expect(registryMismatches({ ...sources, sets })).toEqual(["sets"]);
  });

  it("양성 대조: README 표에서 행 하나가 빠지면 대조가 실패한다", () => {
    const sources = loadSources();
    const readmeText = readFileSync(path.join(e2eDir, "README.md"), "utf8")
      .split("\n")
      .filter((line) => !line.includes("e2e/checks/tab-check.mjs"))
      .join("\n");
    expect(registryMismatches({ ...sources, readme: checksFilesFromReadme(readmeText) })).toEqual(["readme"]);
  });

  it("양성 대조: checks/에 파일이 새로 생기고 네 곳 모두 등록을 빠뜨리면 대조가 실패한다", () => {
    const sources = loadSources();
    const dir = new Set([...sources.dir, "new-check.mjs"]);
    expect(registryMismatches({ ...sources, dir })).toEqual(["packageJson", "sets", "readme", "baseline"]);
  });

  it("SETS 항목 중 args(mode)가 있으면 server는 dev+preview가 아니다", () => {
    expect(modeEntriesWithDevPreview(SETS)).toEqual([]);
  });

  it("양성 대조: args + dev+preview 조합이 섞이면 시험이 실패한다", () => {
    const bad = { file: "checks/repl-check.mjs", args: ["normal"], server: "dev+preview" };
    expect(modeEntriesWithDevPreview([...SETS, bad])).toEqual([bad]);
  });
});

describe("registry: 소스 파일 존재", () => {
  it("README.md·BASELINE.md·package.json이 실제로 있다(경로 전제 확인)", () => {
    expect(existsSync(path.join(e2eDir, "README.md"))).toBe(true);
    expect(existsSync(path.join(e2eDir, "BASELINE.md"))).toBe(true);
    expect(existsSync(path.join(demoDir, "package.json"))).toBe(true);
  });
});
