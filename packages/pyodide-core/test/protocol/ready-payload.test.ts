// @vitest-environment node
/**
 * `ready` 알림 페이로드 조립(`createReadyPayload`) 시험. 판정은 순수 함수라 가짜 입력으로 전수 본다:
 * `versionMismatch`는 `pyodide.version`과 core 고정 버전의 완전 일치 비교이고(정책 Q3), `details`는 있을 때만 싣는다.
 */
import { describe, expect, test } from "vitest";
import { createReadyPayload } from "../../src/protocol/ready-payload";

// 판정은 문자열 완전 일치라 실제 pyodide 버전이 아니어도 된다(버전 리터럴은 코드·시험에 두지 않는다, ADR-0007).

describe("createReadyPayload", () => {
  test("실제 버전이 기대 버전과 같으면 versionMismatch가 거짓이다", () => {
    const payload = createReadyPayload({
      actual: "1.2.3",
      expected: "1.2.3",
      degraded: [],
    });

    expect(payload).toEqual({
      pyodideVersion: "1.2.3",
      versionMismatch: false,
      degraded: [],
    });
  });

  test("실제 버전이 기대 버전과 다르면 versionMismatch가 참이고 pyodideVersion은 실제 값이다", () => {
    const payload = createReadyPayload({
      actual: "1.2.4",
      expected: "1.2.3",
      degraded: [],
    });

    expect(payload.versionMismatch).toBe(true);
    expect(payload.pyodideVersion).toBe("1.2.4");
  });

  test.each([
    ["patch가 다르다", "1.2.2", "1.2.3"],
    ["minor가 다르다", "1.3.3", "1.2.3"],
    ["접두사만 같다", "1.2.3.dev0", "1.2.3"],
    ["빈 문자열이다", "", "1.2.3"],
  ])(
    "versionMismatch는 부분 일치가 아니라 완전 일치로 본다: 실제 값이 %s",
    (_name, actual, expected) => {
      expect(
        createReadyPayload({ actual, expected, degraded: [] }).versionMismatch,
      ).toBe(true);
    },
  );

  test("degraded와 details가 있으면 그대로 싣는다", () => {
    const payload = createReadyPayload({
      actual: "1.2.3",
      expected: "1.2.3",
      degraded: ["run-sync", "sleep-slice"],
      details: { "run-sync": ["pyodide.ffi.run_sync"] },
    });

    expect(payload.degraded).toEqual(["run-sync", "sleep-slice"]);
    expect(payload.details).toEqual({ "run-sync": ["pyodide.ffi.run_sync"] });
  });

  test("details가 없으면 키 자체를 싣지 않는다", () => {
    const payload = createReadyPayload({
      actual: "1.2.3",
      expected: "1.2.3",
      degraded: ["compiler-flags"],
    });

    expect("details" in payload).toBe(false);
  });

  test("degraded는 입력 배열의 사본이다", () => {
    const degraded = ["run-sync"];

    const payload = createReadyPayload({
      actual: "1.2.3",
      expected: "1.2.3",
      degraded,
    });
    degraded.push("sleep-slice");

    expect(payload.degraded).toEqual(["run-sync"]);
  });
});
