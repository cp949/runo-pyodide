/**
 * 동기 stdin 콜백(`createStdinCallback`) 시험. 취소 변환 순서(`requestInput` → `wait` → `signalInterrupt` →
 * `checkInterrupt`)와 `checkInterrupt()`가 던지지 않을 때의 EOF 폴백 경고를 본다(04-stdin-input.md 3.1).
 * 경고 접두어는 core 로그 규칙(`[worker]`)을 따른다 — core는 REPL 없이도 쓰이므로(`14-runner.md`) `[repl.worker]`를 쓰지 않는다.
 */
import { afterEach, expect, test, vi } from "vitest";
import { createStdinCallback } from "../../src/worker/stdin-callback";

afterEach(() => {
  vi.restoreAllMocks();
});

test("한 줄을 받으면 그대로 돌려주고 SIGINT를 쓰지 않는다", () => {
  const signalInterrupt = vi.fn();
  const checkInterrupt = vi.fn();
  const requestInput = vi.fn();
  const stdin = createStdinCallback({
    requestInput,
    wait: () => ({ kind: "line", text: "abc" }),
    signalInterrupt,
    checkInterrupt,
  });

  expect(stdin()).toBe("abc");
  expect(requestInput.mock.calls).toEqual([[true]]);
  expect(signalInterrupt).not.toHaveBeenCalled();
  expect(checkInterrupt).not.toHaveBeenCalled();
});

test("취소 표식이면 요청 번호를 올린 SIGINT를 쓰고 checkInterrupt가 던진 오류를 전파한다", () => {
  const boom = new Error("EINTR");
  const signalInterrupt = vi.fn();
  const stdin = createStdinCallback({
    requestInput: vi.fn(),
    wait: () => ({ kind: "cancelled" }),
    signalInterrupt,
    checkInterrupt: () => {
      throw boom;
    },
  });

  expect(() => stdin()).toThrow(boom);
  expect(signalInterrupt).toHaveBeenCalledTimes(1);
});

test("checkInterrupt가 던지지 않으면 [worker] 접두 경고를 남기고 null을 돌려준다", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const stdin = createStdinCallback({
    requestInput: vi.fn(),
    wait: () => ({ kind: "cancelled" }),
    signalInterrupt: vi.fn(),
    checkInterrupt: vi.fn(),
  });

  expect(stdin()).toBeNull();
  expect(warn.mock.calls).toEqual([
    [
      "[worker] checkInterrupt가 SIGINT를 소비하지 않아 입력 취소를 EOF로 처리한다",
    ],
  ]);
});

test("[C3] eof 표식이면 null을 돌려주고 SIGINT를 쓰지 않는다", () => {
  const signalInterrupt = vi.fn();
  const checkInterrupt = vi.fn();
  const stdin = createStdinCallback({
    requestInput: vi.fn(),
    wait: () => ({ kind: "eof" }),
    signalInterrupt,
    checkInterrupt,
  });

  expect(stdin()).toBeNull();
  expect(signalInterrupt).not.toHaveBeenCalled();
  expect(checkInterrupt).not.toHaveBeenCalled();
});
