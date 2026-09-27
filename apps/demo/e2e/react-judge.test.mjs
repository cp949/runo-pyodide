// react-judge.mjs 판정 함수 시험. 가짜 입력으로 통과 입력뿐 아니라 실패해야 하는 입력(양성 대조)도 확인한다:
// 판정이 항상 통과하는 함수라면 아래 실패 시험이 잡는다. `pnpm --filter demo test`가 실행한다.
import { describe, expect, it } from "vitest";
import {
  colsFromGeometry,
  countWarnings,
  judgeColsChange,
  judgeStrictModeWorkers,
  judgeWrapMatchesGeometry,
  tallyWorkerCalls,
  tallyWorkers,
  wrappedRowCols,
} from "./react-judge.mjs";

const created = (id) => ({ type: "created", id });
const closed = (id) => ({ type: "closed", id });

describe("tallyWorkers", () => {
  it("이벤트가 없으면 전부 0이다", () => {
    expect(tallyWorkers([])).toEqual({ created: 0, closed: 0, live: 0 });
  });
  it("StrictMode 정상 열(생성 2, 첫 worker 종료)은 live 1이다", () => {
    expect(tallyWorkers([created(1), created(2), closed(1)])).toEqual({ created: 2, closed: 1, live: 1 });
  });
  it("종료 이벤트가 오기 전(옛 worker가 terminate 뒤 최대 2초 살아 있다)에는 live 2다", () => {
    expect(tallyWorkers([created(1), created(2)]).live).toBe(2);
  });
  it("같은 id의 종료가 중복돼도 한 번으로 센다", () => {
    expect(tallyWorkers([created(1), created(2), closed(1), closed(1)]).live).toBe(1);
  });
  it("생성 이벤트가 없던 id의 종료는 무시한다(live가 음수가 되지 않는다)", () => {
    expect(tallyWorkers([created(1), closed(9)])).toEqual({ created: 1, closed: 0, live: 1 });
  });
  it("전부 닫히면 live 0이다", () => {
    expect(tallyWorkers([created(1), closed(1)]).live).toBe(0);
  });
});

describe("tallyWorkerCalls", () => {
  it("StrictMode 정상 열(new, terminate, new)은 생성 2·종료 1·논리적 live 1이다", () => {
    expect(tallyWorkerCalls(["new", "terminate", "new"])).toEqual({ constructed: 2, terminated: 1, logicalLive: 1 });
  });
  it("호출이 없으면 전부 0이다", () => {
    expect(tallyWorkerCalls([])).toEqual({ constructed: 0, terminated: 0, logicalLive: 0 });
  });
});

describe("judgeStrictModeWorkers", () => {
  it("new 2회·terminate 1회·live 1은 통과다", () => {
    expect(judgeStrictModeWorkers({ constructed: 2, terminated: 1, live: 1 }).ok).toBe(true);
  });
  it("정리(dispose) 누락 변이: new 2회·terminate 0회·live 2는 실패다", () => {
    const r = judgeStrictModeWorkers({ constructed: 2, terminated: 0, live: 2 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("살아 있는 worker 2개");
  });
  it("Playwright는 1개로 보지만 terminate가 없으면(계측이 잡는 누수) 실패다", () => {
    const r = judgeStrictModeWorkers({ constructed: 2, terminated: 0, live: 1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("terminate 호출 0회");
  });
  it("new 1회(이중 마운트 미관측)는 live 1이어도 실패다(빈 통과 방지)", () => {
    const r = judgeStrictModeWorkers({ constructed: 1, terminated: 0, live: 1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("이중 마운트");
  });
  it("live 0은 실패다", () => {
    expect(judgeStrictModeWorkers({ constructed: 2, terminated: 2, live: 0 }).ok).toBe(false);
  });
});

describe("countWarnings", () => {
  const logs = [
    { source: "page", type: "warning", text: "An unexpected DisposableStore ... TRP-004" },
    { source: "page", type: "log", text: "DisposableStore 정보 로그" },
    { source: "worker", type: "warning", text: "다른 경고" },
    { source: "page", type: "error", text: "DisposableStore 오류" },
  ];
  it("warning 유형이고 문구를 포함한 것만 센다", () => {
    expect(countWarnings(logs, "DisposableStore")).toBe(1);
  });
  it("기록이 없으면 0이다", () => {
    expect(countWarnings([], "DisposableStore")).toBe(0);
  });
});

describe("colsFromGeometry", () => {
  it("화면 너비 ÷ 셀 너비(측정 요소 너비 ÷ 글자 수)를 반올림한다", () => {
    // 실측(2026-09-25 Chromium): 화면 1246px, 측정 요소 288.984375px(32자) → 138열
    expect(colsFromGeometry({ screenWidth: 1246, measureWidth: 288.984375, measureChars: 32 })).toBe(138);
  });
  it("측정 값이 0이거나 없으면 NaN이다", () => {
    expect(colsFromGeometry({ screenWidth: 0, measureWidth: 289, measureChars: 32 })).toBeNaN();
    expect(colsFromGeometry({ screenWidth: 1246, measureWidth: 0, measureChars: 32 })).toBeNaN();
    expect(colsFromGeometry({ screenWidth: 1246, measureWidth: 289, measureChars: 0 })).toBeNaN();
    expect(colsFromGeometry({ screenWidth: undefined, measureWidth: 289, measureChars: 32 })).toBeNaN();
  });
});

describe("judgeColsChange", () => {
  it("줄어들어야 할 때 줄면 통과다", () => {
    expect(judgeColsChange(138, 66, "shrink").ok).toBe(true);
  });
  it("늘어나야 할 때 늘면 통과다", () => {
    expect(judgeColsChange(66, 106, "grow").ok).toBe(true);
  });
  it("cols가 그대로면(fit 미동작) 실패다", () => {
    const r = judgeColsChange(80, 80, "shrink");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("바뀌지 않았다");
  });
  it("반대 방향으로 바뀌면 실패다", () => {
    expect(judgeColsChange(138, 150, "shrink").ok).toBe(false);
    expect(judgeColsChange(66, 50, "grow").ok).toBe(false);
  });
  it("NaN·0·소수는 측정 실패로 실패다", () => {
    expect(judgeColsChange(Number.NaN, 66, "shrink").ok).toBe(false);
    expect(judgeColsChange(138, 0, "shrink").ok).toBe(false);
    expect(judgeColsChange(138, 65.5, "shrink").ok).toBe(false);
  });
  it("알 수 없는 방향이면 던진다", () => {
    expect(() => judgeColsChange(1, 2, "sideways")).toThrow("direction");
  });
});

describe("wrappedRowCols·judgeWrapMatchesGeometry", () => {
  const full = "x".repeat(66);
  const rows = ['>>> print("x" * 400)', full, full, full, "x".repeat(4), ">>>", ""];
  it("꽉 찬 행이 이어지는 첫 구간의 행 길이를 돌려준다(입력 행은 x만이 아니라 건너뛴다)", () => {
    expect(wrappedRowCols(rows)).toBe(66);
  });
  it("줄바꿈이 없으면 null이다(행이 하나뿐인 x)", () => {
    expect(wrappedRowCols([">>> a", "xxxx", ">>>"])).toBeNull();
  });
  it("행 폭이 DOM 기하 cols와 같으면 통과다", () => {
    expect(judgeWrapMatchesGeometry(rows, 66).ok).toBe(true);
  });
  it("행 폭이 DOM 기하 cols와 다르면 실패다(fit 이전 80열 줄바꿈 등)", () => {
    const r = judgeWrapMatchesGeometry(rows, 138);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("66");
  });
  it("줄바꿈 구간이 없으면 실패다", () => {
    expect(judgeWrapMatchesGeometry([">>>"], 66).ok).toBe(false);
  });
});
