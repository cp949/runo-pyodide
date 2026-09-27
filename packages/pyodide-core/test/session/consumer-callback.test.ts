/**
 * `callConsumer` 시험(규칙 `docs/design/08-session.md` 8.1, X1·X3). jsdom 기본 환경(`reportError` 없음, `vi.stubGlobal`로
 * 있는 경우를 흉내 낸다).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { callConsumer } from "../../src/session/consumer-callback";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("callConsumer", () => {
  test("[X1] 정상 콜백은 인자를 그대로 받고 보고 수단은 불리지 않는다", () => {
    const report = vi.fn();
    vi.stubGlobal("reportError", report);
    const callback = vi.fn();

    callConsumer(callback, "loading");

    expect(callback).toHaveBeenCalledWith("loading");
    expect(report).not.toHaveBeenCalled();
  });

  test("[X1] undefined 콜백은 무동작이다", () => {
    expect(() => callConsumer(undefined)).not.toThrow();
  });

  test("[X1] 던지는 콜백을 불러도 callConsumer는 던지지 않고 보고 수단이 그 오류로 한 번 불린다", () => {
    const report = vi.fn();
    vi.stubGlobal("reportError", report);
    const failure = new Error("소비자 콜백 실패");
    const callback = vi.fn(() => {
      throw failure;
    });

    expect(() => callConsumer(callback)).not.toThrow();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(failure);
  });

  test("[X3] reportError가 있으면 그것으로 보고하고 console.error는 부르지 않는다", () => {
    const report = vi.fn();
    vi.stubGlobal("reportError", report);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("boom");

    callConsumer(() => {
      throw failure;
    });

    expect(report).toHaveBeenCalledWith(failure);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("[X3] reportError가 없으면 console.error로 보고한다", () => {
    vi.stubGlobal("reportError", undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("boom");

    callConsumer(() => {
      throw failure;
    });

    expect(errorSpy).toHaveBeenCalledWith(failure);
  });
});
