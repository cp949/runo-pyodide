// e2e check 스크립트 등록 4곳이 `checks/` 디렉터리의 실제 파일 집합과 같은지 대조한다.
// 4곳:
// - package.json의 `e2e:*`.
// - sets.mjs의 `SETS`.
// - README.md 명령 표.
// - BASELINE.md 2절 표.
//
// 등록 누락은 L2에서만 조용히 드러난 전례가 있다(run-source가 `SETS`에서 빠져 baseline에서 안 돌았다). 이 시험이 L0에서 잡는다.
// 양성 대조: 각 소스의 메모리 사본에서 파일 하나를 지운다. 본 판정과 같은 함수(`registryMismatches`·`modeEntriesWithDevPreview`)가 실패를 내는지 본다.
// 실제 저장소 파일은 건드리지 않는다.
// `pnpm --filter demo test`가 실행한다.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETS } from "./sets.mjs";

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.dirname(e2eDir);

/** package.json의 `e2e:*` 스크립트가 가리키는 `checks/` 파일 이름 집합. */
function checksFilesFromPackageJson(pkg) {
  const out = new Set();
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    if (!name.startsWith("e2e:")) continue;
    const m = cmd.match(/e2e\/checks\/([a-z0-9-]+\.mjs)/);
    if (m) out.add(m[1]);
  }
  return out;
}

/** `SETS` 항목이 가리키는 `checks/` 파일 이름 집합. */
function checksFilesFromSets(sets) {
  const out = new Set();
  for (const entry of sets) {
    const m = entry.file.match(/^checks\/([a-z0-9-]+\.mjs)$/);
    if (m) out.add(m[1]);
  }
  return out;
}

/** README.md가 언급하는 `e2e/checks/*.mjs` 파일 이름 집합. */
function checksFilesFromReadme(readme) {
  const out = new Set();
  for (const m of readme.matchAll(/e2e\/checks\/([a-z0-9-]+\.mjs)/g)) out.add(m[1]);
  return out;
}

/** BASELINE.md 표에서 행 머리에 적힌 `*.mjs` 파일 이름 집합. */
function checksFilesFromBaseline(baseline) {
  const out = new Set();
  for (const line of baseline.split("\n")) {
    const m = line.match(/^\| `([a-z0-9-]+\.mjs)/);
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * 네 소스와 `checks/` 디렉터리 실측을 읽는다. 대조 범위는 `checks/`뿐이다(RD-044).
 * `measure/*.mjs` 7개는 정규식이 `checks/`만 잡아 비교에서 빠진다. 별도 허용 목록이 필요 없다.
 * - `cpu-throttle-probe`도 그중 하나다. `SETS`·baseline에 없고 package.json·README에 기록용으로만 있다. 검증이 L3라 이 L0 시험의 범위 밖이다.
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
 * `checks/` 디렉터리 실측(`dir`)과 파일 집합이 다른 등록 소스 이름을 돌려준다. 빈 배열이면 모두 일치한다.
 * 기준이 디렉터리라 새 스크립트를 넣고 네 곳 모두에 등록을 빠뜨린 경우도 잡는다.
 */
function registryMismatches({ dir, ...registered }) {
  const expected = [...dir].sort().join(",");
  return Object.entries(registered)
    .filter(([, files]) => [...files].sort().join(",") !== expected)
    .map(([name]) => name);
}

/**
 * mode 인자(`args`)와 `server: "dev+preview"`를 함께 쓴 `SETS` 항목을 돌려준다.
 * `parseArgs`는 mode 경로에서 `previewUrl`을 비운다. 그러면 `runOneScript`가 붙인 preview URL이 스크립트의 `rest[0]`로 흘러든다.
 * 예: `repl-check`의 screenshot 경로. 자세한 이유는 `sets.mjs` `SETS`의 머리 주석.
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
