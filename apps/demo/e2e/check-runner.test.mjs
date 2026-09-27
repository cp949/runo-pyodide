// check-runner.mjs 진입 규약(K1~K7) 단위 시험. 가짜 argv·env로 순수 함수만 확인한다(브라우저 없음).
// 판정 규칙 정의는 `docs/design/09-testing.md` 9.6.5(K1~K7).
// 실패해야 하는 입력(양성 대조)도 함께 둔다 — 항상 통과하는 판정이면 아래 시험이 잡는다. `pnpm --filter demo test`가 실행한다.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DEV_URL,
  checkEntry,
  currentOnly,
  exitWith,
  parseArgs,
  pageSelected,
  previewOnlyTokens,
  runDevPreview,
  sectionEnabled,
  serverLabel,
} from "./check-runner.mjs";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseArgs", () => {
  it("[K1] URL 인자가 없으면 기본 dev URL을 쓴다", () => {
    expect(parseArgs(["node", "script.mjs"])).toEqual({
      url: DEFAULT_DEV_URL,
      previewUrl: undefined,
      mode: undefined,
      rest: [],
    });
  });

  it("[K1] argv[2]가 dev URL, argv[3]이 preview URL이다", () => {
    expect(parseArgs(["node", "script.mjs", "http://localhost:5173", "http://localhost:4173"])).toEqual({
      url: "http://localhost:5173",
      previewUrl: "http://localhost:4173",
      mode: undefined,
      rest: [],
    });
  });

  it("[K1] mode 스크립트는 argv[2]가 mode, 뒤로 URL·나머지 인자다", () => {
    expect(
      parseArgs(["node", "script.mjs", "normal", "http://localhost:5173", "extra"], {
        modes: ["normal", "cdn-blocked", "not-isolated"],
      }),
    ).toEqual({
      mode: "normal",
      url: "http://localhost:5173",
      previewUrl: undefined,
      rest: ["extra"],
    });
  });

  it("[K1] mode가 허용 목록 밖이면 사용법 안내 + exit 2용 결과를 돌려준다(양성 대조)", () => {
    const result = parseArgs(["node", "script.mjs", "bogus"], { modes: ["normal", "cdn-blocked"] });
    expect(result.error).toBeTruthy();
    expect(result.exitCode).toBe(2);
  });

  it("[K1] mode 스크립트도 URL 인자가 없으면 기본 dev URL을 쓴다(runner-check처럼 URL 생략 허용)", () => {
    expect(parseArgs(["node", "script.mjs", "normal"], { modes: ["normal"] }).url).toBe(DEFAULT_DEV_URL);
  });
});

describe("checkEntry", () => {
  it("[K1] process.argv를 기본으로 읽어 파싱 결과를 돌려준다(정상 입력)", () => {
    const result = checkEntry({}, ["node", "script.mjs", "http://localhost:5173"]);
    expect(result.url).toBe("http://localhost:5173");
  });

  it("[K1] mode가 허용 목록 밖이면 사용법을 출력하고 exit 2를 실제로 호출한다", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    checkEntry({ modes: ["normal"] }, ["node", "script.mjs", "bogus"]);
    expect(exit).toHaveBeenCalledWith(2);
    expect(errorLog).toHaveBeenCalled();
  });
});

describe("currentOnly", () => {
  it("ONLY가 없으면 빈 배열이다", () => {
    expect(currentOnly({})).toEqual([]);
  });
  it("호출 시점의 env.ONLY를 다시 읽는다(같은 env 객체를 두 번 호출하면 값이 다를 수 있다)", () => {
    const env = { ONLY: "C1" };
    expect(currentOnly(env)).toEqual(["C1"]);
    env.ONLY = "초기,C1";
    expect(currentOnly(env)).toEqual(["초기", "C1"]);
  });
});

describe("serverLabel", () => {
  it("[K2] :4173을 포함한 URL은 preview다", () => {
    expect(serverLabel("http://localhost:4173")).toBe("preview");
  });
  it("[K2] :4173이 없으면 dev다(4174 static 포함)", () => {
    expect(serverLabel("http://localhost:5173")).toBe("dev");
    expect(serverLabel("http://localhost:4174")).toBe("dev");
  });
  it("[K2] mode가 있으면 <mode>-<dev|preview>다", () => {
    expect(serverLabel("http://localhost:5173", "normal")).toBe("normal-dev");
    expect(serverLabel("http://localhost:4173", "normal")).toBe("normal-preview");
  });
});

describe("sectionEnabled", () => {
  it("[K3] ONLY가 비면 항상 참이다", () => {
    expect(sectionEnabled([], "C1")).toBe(true);
  });
  it("[K3] 토큰과 정확히 일치해야 참이다", () => {
    expect(sectionEnabled(["C1"], "C1")).toBe(true);
  });
  it("[K3] C1이 C11을 켜지 않는다(양성 대조 — 접두어 일치가 아니다)", () => {
    expect(sectionEnabled(["C1"], "C11")).toBe(false);
  });
  it("[K3] C11이 등록돼도 C1을 켜지 않는다(역방향 접두어 변이를 잡는 시험)", () => {
    expect(sectionEnabled(["C11"], "C1")).toBe(false);
  });
});

describe("pageSelected", () => {
  it("[K4] ONLY가 비면 항상 참이다", () => {
    expect(pageSelected([], "S5")).toBe(true);
  });
  it("[K4] 토큰이 prefix의 접두어면 참이다(양방향 접두어)", () => {
    expect(pageSelected(["S"], "S5", "S6")).toBe(true);
  });
  it("[K4] prefix가 토큰의 접두어면 참이다(S5가 slow 페이지를 켠다)", () => {
    expect(pageSelected(["S5"], "S5", "S6")).toBe(true);
  });
  it("[K4] 토큰이 prefix보다 길어도 접두어면 참이다(ONLY=N0a가 N0 선언 페이지를 켠다, 단방향 변이를 잡는 시험)", () => {
    expect(pageSelected(["N0a"], "N0")).toBe(true);
  });
  it("[K4] 겹치지 않으면 거짓이다(양성 대조)", () => {
    expect(pageSelected(["N0"], "S5", "S6")).toBe(false);
  });
  it("[K4] 부분 문자열 포함만으로는 켜지지 않는다(startsWith가 아니라 includes로 바꾸는 변이를 잡는 시험)", () => {
    expect(pageSelected(["XLATEY"], "LATE")).toBe(false);
  });
  it("[K4] ONLY=LATE는 RUNLATE를 켜지 않는다(checklist 명시 사례)", () => {
    expect(pageSelected(["LATE"], "RUNLATE")).toBe(false);
  });
  it("[K4] 토큰 여러 개 중 하나만 맞아도 참이다(some을 every로 바꾸는 변이를 잡는 시험)", () => {
    expect(pageSelected(["ZZZ", "S5"], "S5", "S6")).toBe(true);
  });
});

describe("previewOnlyTokens", () => {
  it("[K6] preview 목록 선언이 없으면 사용자 ONLY를 그대로 돌려준다", () => {
    expect(previewOnlyTokens(["C1"], undefined)).toEqual({ tokens: ["C1"], skip: false });
  });
  it("[K6] 목록이 있고 사용자 ONLY가 없으면 목록 전체를 쓴다", () => {
    expect(previewOnlyTokens([], ["초기", "C1", "C3"])).toEqual({ tokens: ["초기", "C1", "C3"], skip: false });
  });
  it("[K6] 둘 다 있으면 초기 + (사용자 토큰 ∩ 목록)이다", () => {
    expect(previewOnlyTokens(["C1", "C99"], ["초기", "C1", "C3"])).toEqual({ tokens: ["초기", "C1"], skip: false });
  });
  it("[K6] 교집합이 초기뿐이면 건너뛴다", () => {
    expect(previewOnlyTokens(["C99"], ["초기", "C1", "C3"])).toEqual({ tokens: ["초기"], skip: true });
  });
  it("[K6] 교집합은 정확 일치다(C1이 C11을 끌어오지 않는다 — 접두어 일치로 바꾸는 변이를 잡는 시험)", () => {
    expect(previewOnlyTokens(["C1"], ["초기", "C1", "C11"])).toEqual({ tokens: ["초기", "C1"], skip: false });
  });
});

describe("runDevPreview", () => {
  it("[K5] preview URL이 없으면 dev만 실행한다", async () => {
    const run = vi.fn().mockResolvedValue(true);
    const ok = await runDevPreview({ url: "http://localhost:5173", previewUrl: undefined, run, env: {} });
    expect(ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("http://localhost:5173", "dev");
  });

  it("[K5] preview URL이 있으면 dev 다음 preview를 실행하고 둘 다 통과해야 한다(dev 통과·preview 실패)", async () => {
    const run = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const env = {};
    const ok = await runDevPreview({ url: "http://localhost:5173", previewUrl: "http://localhost:4173", run, env });
    expect(ok).toBe(false);
    expect(run).toHaveBeenNthCalledWith(1, "http://localhost:5173", "dev");
    expect(run).toHaveBeenNthCalledWith(2, "http://localhost:4173", "preview");
  });

  it("[K5] dev가 실패하면 preview가 통과해도 전체는 실패다(devOk 무시 변이를 잡는 시험)", async () => {
    const run = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const env = {};
    const ok = await runDevPreview({ url: "http://localhost:5173", previewUrl: "http://localhost:4173", run, env });
    expect(ok).toBe(false);
  });

  it("[K5] preview 교집합이 초기뿐이면 preview를 건너뛰고(run을 다시 부르지 않고) dev 결과를 쓴다", async () => {
    const env = { ONLY: "C99" };
    const run = vi.fn().mockResolvedValue(true);
    const ok = await runDevPreview({
      url: "http://localhost:5173",
      previewUrl: "http://localhost:4173",
      run,
      env,
      previewSections: ["초기", "C1", "C3"],
    });
    expect(ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("http://localhost:5173", "dev");
  });

  it("[K5] preview를 건너뛸 때 dev가 실패했으면 전체도 실패다(devOk 무시 변이를 잡는 시험, skip 경로)", async () => {
    const run = vi.fn().mockResolvedValue(false);
    const ok = await runDevPreview({
      url: "http://localhost:5173",
      previewUrl: "http://localhost:4173",
      run,
      env: { ONLY: "C99" },
      previewSections: ["초기", "C1", "C3"],
    });
    expect(ok).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("[K5] previewSections가 있고 preview도 실행될 때, dev가 실패하면 preview가 통과해도 전체는 실패다(devOk 무시 변이를 잡는 시험, previewSections 경로)", async () => {
    const env = { ONLY: "C1" };
    const run = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const ok = await runDevPreview({
      url: "http://localhost:5173",
      previewUrl: "http://localhost:4173",
      run,
      env,
      previewSections: ["초기", "C1", "C3"],
    });
    expect(ok).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("[K5] preview 동안 ONLY를 바꿨다가 끝나면 원래 값으로 되돌린다(원래 있던 값)", async () => {
    const env = { ONLY: "C1" };
    const seenOnlyDuringPreview = [];
    const run = vi.fn(async (_url, phase) => {
      if (phase === "preview") seenOnlyDuringPreview.push(env.ONLY);
      return true;
    });
    await runDevPreview({
      url: "http://localhost:5173",
      previewUrl: "http://localhost:4173",
      run,
      env,
      previewSections: ["초기", "C1", "C3"],
    });
    expect(seenOnlyDuringPreview).toEqual(["초기,C1"]);
    expect(env.ONLY).toBe("C1");
  });

  it("[K5] preview 동안 ONLY를 바꿨다가 끝나면 원래 없던 값을 지운다(원복, 양성 대조)", async () => {
    const env = {};
    const run = vi.fn().mockResolvedValue(true);
    await runDevPreview({
      url: "http://localhost:5173",
      previewUrl: "http://localhost:4173",
      run,
      env,
      previewSections: ["초기", "C1"],
    });
    expect(env.ONLY).toBeUndefined();
  });

  it("[K5] preview 실행이 던져도 ONLY를 원래 값으로 되돌린다(finally 원복)", async () => {
    const env = { ONLY: "C1" };
    const run = vi.fn(async (_url, phase) => {
      if (phase === "preview") throw new Error("preview 실패");
      return true;
    });
    await expect(
      runDevPreview({
        url: "http://localhost:5173",
        previewUrl: "http://localhost:4173",
        run,
        env,
        previewSections: ["초기", "C1", "C3"],
      }),
    ).rejects.toThrow("preview 실패");
    expect(env.ONLY).toBe("C1");
  });
});

describe("exitWith", () => {
  it("[K7] 통과면 exit 0이다", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {});
    exitWith(true);
    expect(exit).toHaveBeenCalledWith(0);
  });
  it("[K7] 실패면 exit 1이다", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {});
    exitWith(false);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
