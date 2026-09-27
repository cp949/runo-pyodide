// dom-bridge-judge.mjs 판정 함수 시험. 통과 입력뿐 아니라 실패해야 하는 입력(양성 대조)도 확인한다: 판정이 항상 통과하는 함수라면 아래 실패 시험이
// 잡는다. `pnpm --filter demo test`가 실행한다.
import { describe, expect, it } from "vitest";
import {
  judgeAfterCallReturn,
  judgeOrderPath,
  judgeLoadFailedRows,
  judgeOrder,
  judgeStatusSubsequence,
  judgeStopBeforeCallReturn,
  squashRows,
  userLine,
} from "./dom-bridge-judge.mjs";

const out = (text) => ({ type: "out", data: { stream: "stdout", text } });
const dom = (title) => ({ type: "dom", data: title });

describe("userLine", () => {
  it("main.py 마지막 프레임의 줄 번호를 돌려준다", () => {
    const tb = 'Traceback (most recent call last):\n  File "main.py", line 4, in <module>\nKeyboardInterrupt\n';
    expect(userLine(tb)).toBe(4);
  });
  it("여러 프레임이면 마지막 것이다", () => {
    const tb = '  File "main.py", line 9, in <module>\n  File "main.py", line 2, in f\n';
    expect(userLine(tb)).toBe(2);
  });
  it("main.py 프레임이 없거나 입력이 없으면 null이다", () => {
    expect(userLine('  File "other.py", line 3')).toBeNull();
    expect(userLine(undefined)).toBeNull();
  });
});

describe("judgeOrder", () => {
  it("출력이 항상 DOM보다 먼저면 역전 0·누락 0이다", () => {
    const events = [out("p0\n"), dom("d0"), out("p1\n"), dom("d1")];
    expect(judgeOrder(events, 2)).toEqual({ pairs: 2, inversions: 0, missing: 0 });
  });
  it("DOM이 출력보다 먼저 도착하면 역전으로 센다(양성 대조)", () => {
    const events = [out("p0\n"), dom("d0"), dom("d1"), out("p1\n")];
    expect(judgeOrder(events, 2)).toEqual({ pairs: 2, inversions: 1, missing: 0 });
  });
  it("한 청크에 여러 줄이 와도 각각 센다", () => {
    const events = [out("p0\np1\n"), dom("d0"), dom("d1")];
    expect(judgeOrder(events, 2)).toEqual({ pairs: 2, inversions: 0, missing: 0 });
  });
  it("p1과 p10을 혼동하지 않는다", () => {
    const events = [out("p10\n"), dom("d1"), out("p1\n"), dom("d10")];
    // d1이 o1보다 앞이라 역전 1, o10은 d10보다 앞이라 정상. o0·d0 등 나머지는 누락이다.
    const r = judgeOrder(events, 11);
    expect(r.inversions).toBe(1);
    expect(r.missing).toBe(9);
  });
  it("출력이나 DOM이 없으면 누락으로 센다(빈 통과 방지)", () => {
    expect(judgeOrder([], 3)).toEqual({ pairs: 3, inversions: 0, missing: 3 });
    expect(judgeOrder([out("p0\n")], 1).missing).toBe(1);
  });
  it("title이 아닌 dom 값(from-python 등)은 무시한다", () => {
    expect(judgeOrder([out("p0\n"), dom("from-python"), dom("d0")], 1)).toEqual({ pairs: 1, inversions: 0, missing: 0 });
  });
});

describe("judgeAfterCallReturn", () => {
  const start = { type: "slowStart", data: { id: 1, ms: 2000 } };
  const done = { type: "slowDone", data: { id: 1, ms: 2000 } };
  const interrupted = { type: "outcome", data: { kind: "interrupted" } };
  it("결말이 slowDone 뒤에 오고 interrupted면 통과다", () => {
    expect(judgeAfterCallReturn([{ type: "runStart" }, start, done, interrupted], 1, "interrupted").ok).toBe(true);
  });
  it("결말이 slowDone보다 앞이면(호출 도중 전달) 실패다(양성 대조)", () => {
    const r = judgeAfterCallReturn([start, interrupted, done], 1, "interrupted");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("호출 도중");
  });
  it("slowDone이 없으면 실패다", () => {
    expect(judgeAfterCallReturn([start, interrupted], 1, "interrupted").ok).toBe(false);
  });
  it("결말 종류가 다르면 실패다", () => {
    const r = judgeAfterCallReturn([start, done, { type: "outcome", data: { kind: "ok" } }], 1, "interrupted");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("kind = ok");
  });
  it("slowStart나 결말이 없으면 실패다", () => {
    expect(judgeAfterCallReturn([], 1).ok).toBe(false);
    expect(judgeAfterCallReturn([start, done], 1).ok).toBe(false);
  });
  it("중단 요청이 호출 도중(slowStart와 slowDone 사이)이면 통과다", () => {
    const events = [start, { type: "ctrlC" }, done, interrupted];
    expect(judgeAfterCallReturn(events, 1, "interrupted", "ctrlC").ok).toBe(true);
  });
  it("중단 요청이 호출 반환 뒤에 들어갔으면 시험 불성립으로 실패다(빈 통과 방지)", () => {
    const r = judgeAfterCallReturn([start, done, { type: "ctrlC" }, interrupted], 1, "interrupted", "ctrlC");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("시험 불성립");
  });
  it("중단 요청 기록이 없으면 실패다", () => {
    expect(judgeAfterCallReturn([start, done, interrupted], 1, "interrupted", "ctrlC").ok).toBe(false);
  });
  it("다른 id의 slowDone은 세지 않는다", () => {
    const other = { type: "slowDone", data: { id: 2, ms: 1 } };
    expect(judgeAfterCallReturn([start, other, interrupted], 1, "interrupted").ok).toBe(false);
  });
});

describe("judgeStopBeforeCallReturn", () => {
  const start = { type: "slowStart", data: { id: 3, ms: 8000 } };
  const done = { type: "slowDone", data: { id: 3, ms: 8000 } };
  const stop = { type: "stop" };
  const restarted = { type: "outcome", data: { kind: "restarted" } };
  const st = (s) => ({ type: "status", data: s });
  // 옛 셀 구현: 새 worker `ready`까지 기다린 뒤 이벤트 열에 그 id의 slowDone이 **있는지만** 봤다(순서를 보지 않음).
  const oldJudge = (events) => ({ ok: events.findIndex((e) => e.type === "slowDone" && e.data?.id === 3) < 0 });

  it("slowDone이 아직 없으면 성립이다", () => {
    const events = [{ type: "runStart" }, start, stop, st("restarting"), restarted, st("ready")];
    const r = judgeStopBeforeCallReturn(events, 3);
    expect(r.ok).toBe(true);
    expect(r.reason).toContain("아직 없음");
  });
  it("slowDone이 restarted 결말 뒤면(재부팅이 길어 ready 전에 기록돼도) 성립이다", () => {
    const events = [{ type: "runStart" }, start, stop, st("restarting"), restarted, done, st("ready")];
    const r = judgeStopBeforeCallReturn(events, 3);
    expect(r.ok).toBe(true);
    expect(r.reason).toContain("결말 뒤");
  });
  it("옛 판정(ready 뒤 slowDone 존재만 봄)은 slowDone이 결말 뒤인 성립 경우를 잘못 실패시킨다", () => {
    const events = [{ type: "runStart" }, start, stop, st("restarting"), restarted, done, st("ready")];
    expect(oldJudge(events).ok).toBe(false);
    expect(judgeStopBeforeCallReturn(events, 3).ok).toBe(true);
  });
  it("slowDone이 결말보다 앞이면 호출 도중 종료가 아니라 불성립이다(양성 대조)", () => {
    const r = judgeStopBeforeCallReturn([start, stop, done, restarted, st("ready")], 3);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("시험 불성립");
  });
  it("결말 이벤트가 없으면 실패다", () => {
    const r = judgeStopBeforeCallReturn([start, stop, st("restarting")], 3);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("결말(outcome)이 없다");
  });
  it("결말이 restarted가 아니면 실패다", () => {
    const r = judgeStopBeforeCallReturn([start, stop, { type: "outcome", data: { kind: "interrupted" } }], 3);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("kind = interrupted");
  });
  it("stop 요청이 없거나 결말 뒤에만 있으면 실패다", () => {
    expect(judgeStopBeforeCallReturn([start, restarted], 3).ok).toBe(false);
    expect(judgeStopBeforeCallReturn([start, restarted, stop], 3).ok).toBe(false);
  });
  it("slowStart가 없으면 실패다", () => {
    expect(judgeStopBeforeCallReturn([stop, restarted], 3).ok).toBe(false);
  });
  it("다른 id의 slowDone이 결말 앞에 있어도 불성립으로 세지 않는다", () => {
    const other = { type: "slowDone", data: { id: 2, ms: 1 } };
    expect(judgeStopBeforeCallReturn([start, stop, other, restarted], 3).ok).toBe(true);
  });
});

describe("judgeStatusSubsequence", () => {
  const st = (s) => ({ type: "status", data: s });
  it("restarting 뒤 ready가 순서대로 있으면 통과다", () => {
    const events = [st("running"), st("restarting"), st("ready")];
    expect(judgeStatusSubsequence(events, 0, ["restarting", "ready"]).ok).toBe(true);
  });
  it("ready가 restarting보다 앞에만 있으면 실패다", () => {
    const events = [st("ready"), st("restarting")];
    expect(judgeStatusSubsequence(events, 0, ["restarting", "ready"]).ok).toBe(false);
  });
  it("from 이전 전이는 세지 않는다", () => {
    const events = [st("restarting"), st("ready"), st("running")];
    expect(judgeStatusSubsequence(events, 2, ["restarting", "ready"]).ok).toBe(false);
  });
});

describe("judgeLoadFailedRows", () => {
  const rows = [
    "pyodide 로드 실패: Error: plugin \"dom-bridge\": 동기 DOM 브리지(native)를 쓸 수 없다. gr",
    "owable SharedArrayBuffer가 필요하다.",
  ];
  it("접두와 원인 문구가 있으면(행이 감겨도) 통과다", () => {
    expect(judgeLoadFailedRows(rows, "dom-bridge", ["동기 DOM 브리지(native)를 쓸 수 없다"]).ok).toBe(true);
  });
  it("Error: 접두가 없으면 실패다", () => {
    const r = judgeLoadFailedRows(['pyodide 로드 실패: plugin "dom-bridge": 원인'], "dom-bridge", ["원인"]);
    expect(r.ok).toBe(false);
  });
  it("다른 플러그인 이름이면 실패다", () => {
    expect(judgeLoadFailedRows(rows, "other", ["동기 DOM"]).ok).toBe(false);
  });
  it("원인 문구가 다르면 실패다(빈 통과 방지)", () => {
    const r = judgeLoadFailedRows(rows, "dom-bridge", ["부트스트랩"]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("원인 문구");
  });
  it("load-failed 문구가 아예 없으면 실패다", () => {
    expect(judgeLoadFailedRows(["go"], "dom-bridge", ["x"]).ok).toBe(false);
  });
  it("접두 뒤가 아니라 다른 위치에만 원인 문구가 있으면 실패다", () => {
    const r = judgeLoadFailedRows(["부트스트랩 pyodide 로드 실패: Error: plugin \"dom-bridge\": 다른 원인"], "dom-bridge", ["부트스트랩"]);
    expect(r.ok).toBe(false);
  });
});

describe("squashRows", () => {
  it("공백을 모두 지우고 이어붙인다", () => {
    expect(squashRows(["a b", " c"])).toBe("abc");
  });
});

describe("judgeOrderPath", () => {
  const method = (over = {}) => ({ pairs: 100, inversions: 0, missing: 0, outcomes: ["ok", "ok", "ok", "ok", "ok"], ...over });
  const all = (over = {}) => ({ C: method(over.C), Ag: method(over.Ag), Ar: method(over.Ar) });

  it("누락 0·모든 ok·세 방식이 있으면 역전이 없어도 통과다", () => {
    expect(judgeOrderPath(all()).ok).toBe(true);
  });
  it("역전이 있어도 통과다(판정 없음): 수는 summary와 reason에 기록된다", () => {
    const r = judgeOrderPath(all({ C: { inversions: 5 }, Ag: { inversions: 90 } }));
    expect(r.ok).toBe(true);
    expect(r.summary.C.inversions).toBe(5);
    expect(r.summary.Ag.inversions).toBe(90);
    expect(r.reason).toContain("C 5/100");
    expect(r.reason).toContain("Ag 90/100");
    expect(r.reason).toContain("판정 없음");
  });
  it("모든 쌍이 역전이어도 누락이 없고 ok면 통과다(역전은 필수 조건이 아니다)", () => {
    expect(judgeOrderPath(all({ C: { inversions: 100 } })).ok).toBe(true);
  });
  it("기록 누락이 있으면 실패다", () => {
    const r = judgeOrderPath(all({ Ag: { missing: 2 } }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("Ag: 기록 누락 2/100");
  });
  it("결말이 ok가 아닌 실행이 있으면 실패다", () => {
    const r = judgeOrderPath(all({ Ar: { outcomes: ["ok", "error"] } }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("Ar: 모든 실행이 ok가 아니다");
  });
  it("방식 하나가 빠지면 실패다(빈 통과 방지)", () => {
    const r = judgeOrderPath({ C: method(), Ag: method() });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("Ar");
  });
  it("쌍이 0이거나 결말 목록이 비면 실패다", () => {
    expect(judgeOrderPath(all({ C: { pairs: 0 } })).ok).toBe(false);
    expect(judgeOrderPath(all({ C: { outcomes: [] } })).ok).toBe(false);
  });
  it("측정 자체가 없으면 실패다", () => {
    expect(judgeOrderPath(undefined).ok).toBe(false);
  });
});
