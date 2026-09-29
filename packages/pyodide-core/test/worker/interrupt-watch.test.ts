// @vitest-environment jsdom
/**
 * 감시 타이머(`startInterruptWatch`) 시험(03-ctrl-c.md 2.5, 09-testing.md 9.2).
 * - `protocol/interrupt-protocol`의 실제 함수를 buffer에 묶어 deps로 주입한다.
 * - `interruptIdle`·`atPrompt`만 `vi.fn`으로 흉내낸다.
 * - 가짜 타이머(`vi.useFakeTimers`)로 20ms 틱을 진행한다.
 *
 * `startInterruptWatch`는 `protocol/`을 import하지 않는다.
 * 버퍼를 모르고 deps 클로저로만 움직인다.
 * 이 시험이 그 배선(주입)을 대신 맡는다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACK,
  SIGNAL,
  consumeInterrupt,
  createInterruptBuffer,
  discardPendingInterrupt,
  hasPendingInterrupt,
  signalInterrupt,
} from "../../src/protocol/interrupt-protocol";
import { startInterruptWatch } from "../../src/worker/interrupt-watch";

/** `setup`이 돌려주는 시험 도구 묶음. */
interface Rig {
  buffer: Int32Array;
  interruptIdle: ReturnType<typeof vi.fn<() => boolean>>;
  atPrompt: ReturnType<typeof vi.fn<() => boolean>>;
  stop: () => void;
}

/**
 * 실제 버퍼 함수를 deps로 묶어 감시 타이머를 켠다.
 * `buffer`·`interruptIdle`·`atPrompt`를 안 주면 새 버퍼와 항상 거짓인 `vi.fn`을 쓴다.
 * `stop`은 타이머 중지 함수다.
 */
function setup(
  options: {
    buffer?: Int32Array;
    interruptIdle?: ReturnType<typeof vi.fn<() => boolean>>;
    atPrompt?: ReturnType<typeof vi.fn<() => boolean>>;
  } = {},
): Rig {
  const buffer = options.buffer ?? createInterruptBuffer();
  const interruptIdle = options.interruptIdle ?? vi.fn(() => false);
  const atPrompt = options.atPrompt ?? vi.fn(() => false);
  const stop = startInterruptWatch({
    interruptIdle,
    atPrompt,
    hasPending: () => hasPendingInterrupt(buffer),
    consume: () => consumeInterrupt(buffer),
    discard: () => discardPendingInterrupt(buffer),
  });
  return { buffer, interruptIdle, atPrompt, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startInterruptWatch", () => {
  it("버퍼가 2가 아니면 interruptIdle을 부르지 않는다", () => {
    const { interruptIdle } = setup();

    vi.advanceTimersByTime(100);

    expect(interruptIdle).not.toHaveBeenCalled();
  });

  it("20ms 간격으로 엿본다", () => {
    const buffer = createInterruptBuffer();
    signalInterrupt(buffer);
    const { interruptIdle } = setup({ buffer });

    vi.advanceTimersByTime(19);
    expect(interruptIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(interruptIdle).toHaveBeenCalledTimes(1);
  });

  it("깨웠으면(true) SIGINT를 소비한다(SIGNAL 0)", () => {
    const buffer = createInterruptBuffer();
    signalInterrupt(buffer);
    setup({ buffer, interruptIdle: vi.fn(() => true) });

    vi.advanceTimersByTime(20);

    expect(buffer[SIGNAL]).toBe(0);
    expect(buffer[ACK]).toBe(1);
  });

  it("깨울 것이 없으면(false) 남기고 다음 틱에 다시 시도한다", () => {
    const buffer = createInterruptBuffer();
    signalInterrupt(buffer);
    const interruptIdle = vi.fn(() => false);
    setup({ buffer, interruptIdle });

    vi.advanceTimersByTime(20);
    expect(buffer[SIGNAL]).toBe(2);

    vi.advanceTimersByTime(20);
    expect(interruptIdle).toHaveBeenCalledTimes(2);
    expect(buffer[SIGNAL]).toBe(2);
  });

  it("부르는 동안 버퍼가 바뀌었으면(interruptIdle 안에서 SIGNAL을 0으로) 덮어쓰지 않고 ack하지 않는다", () => {
    const buffer = createInterruptBuffer();
    signalInterrupt(buffer);
    // 핸들러가 이 호출 자체(Python 진입)에서 이미 소비·ack까지 마친 경합을 흉내낸다.
    Atomics.store(buffer, ACK, 1);
    const interruptIdle = vi.fn(() => {
      Atomics.store(buffer, SIGNAL, 0);
      return true;
    });
    setup({ buffer, interruptIdle });

    vi.advanceTimersByTime(20);

    expect(buffer[SIGNAL]).toBe(0);
    expect(buffer[ACK]).toBe(1);
  });

  it("interruptIdle이 던져도 계속 돌고 매 틱 console.error 한 번만 남긴다", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const buffer = createInterruptBuffer();
    signalInterrupt(buffer);
    const interruptIdle = vi.fn(() => {
      throw new Error("boom");
    });
    setup({ buffer, interruptIdle });

    vi.advanceTimersByTime(20);
    vi.advanceTimersByTime(20);

    expect(interruptIdle).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(consoleError.mock.calls[0]?.[0]).toBe("[interrupt-watch]");
  });

  it("중지 함수 뒤에는 부르지 않는다", () => {
    const buffer = createInterruptBuffer();
    const interruptIdle = vi.fn(() => false);
    const { stop } = setup({ buffer, interruptIdle });

    stop();
    signalInterrupt(buffer);
    vi.advanceTimersByTime(100);

    expect(interruptIdle).not.toHaveBeenCalled();
  });
});

describe("프롬프트 유휴 SIGINT 폐기", () => {
  it("atPrompt 참 + 깨울 것 없음 → 버리고 ack 1", () => {
    const buffer = createInterruptBuffer();
    signalInterrupt(buffer);
    setup({
      buffer,
      interruptIdle: vi.fn(() => false),
      atPrompt: vi.fn(() => true),
    });

    vi.advanceTimersByTime(20);

    expect(buffer[SIGNAL]).toBe(0);
    expect(buffer[ACK]).toBe(1);
  });

  it("atPrompt 거짓(실행 중) → 남기고 ack 없음", () => {
    const buffer = createInterruptBuffer();
    signalInterrupt(buffer);
    setup({
      buffer,
      interruptIdle: vi.fn(() => false),
      atPrompt: vi.fn(() => false),
    });

    vi.advanceTimersByTime(20);

    expect(buffer[SIGNAL]).toBe(2);
    expect(buffer[ACK]).toBe(0);
  });

  it("atPrompt 참이어도 깨웠으면 소비하고 ack는 한 번만", () => {
    const buffer = createInterruptBuffer();
    signalInterrupt(buffer);
    setup({
      buffer,
      interruptIdle: vi.fn(() => true),
      atPrompt: vi.fn(() => true),
    });

    vi.advanceTimersByTime(20);

    expect(buffer[SIGNAL]).toBe(0);
    expect(buffer[ACK]).toBe(1);
  });

  it("상태는 틱마다 재확인(실행 중 남은 SIGINT가 프롬프트로 돌아온 뒤 버려진다)", () => {
    const buffer = createInterruptBuffer();
    signalInterrupt(buffer);
    let promptNow = false;
    setup({
      buffer,
      interruptIdle: vi.fn(() => false),
      atPrompt: vi.fn(() => promptNow),
    });

    vi.advanceTimersByTime(20);
    expect(buffer[SIGNAL]).toBe(2);

    promptNow = true;
    vi.advanceTimersByTime(20);
    expect(buffer[SIGNAL]).toBe(0);
    expect(buffer[ACK]).toBe(1);
  });

  it("폴링이 먼저 소비하고 핸들러가 ack했으면(interruptIdle 안에서 SIGNAL 0·ack+1 흉내) ack를 또 올리지 않는다", () => {
    const buffer = createInterruptBuffer();
    signalInterrupt(buffer);
    const interruptIdle = vi.fn(() => {
      Atomics.store(buffer, SIGNAL, 0);
      Atomics.add(buffer, ACK, 1);
      return false;
    });
    setup({ buffer, interruptIdle, atPrompt: vi.fn(() => true) });

    vi.advanceTimersByTime(20);

    expect(buffer[SIGNAL]).toBe(0);
    expect(buffer[ACK]).toBe(1);
  });
});

describe("ack", () => {
  it("깨워 소비하면 ack 1", () => {
    const buffer = createInterruptBuffer();
    signalInterrupt(buffer);
    setup({ buffer, interruptIdle: vi.fn(() => true) });

    vi.advanceTimersByTime(20);

    expect(buffer[ACK]).toBe(1);
  });

  it("남겨 두면 ack 없음", () => {
    const buffer = createInterruptBuffer();
    signalInterrupt(buffer);
    setup({
      buffer,
      interruptIdle: vi.fn(() => false),
      atPrompt: vi.fn(() => false),
    });

    vi.advanceTimersByTime(20);

    expect(buffer[ACK]).toBe(0);
  });

  it("깨우는 동안 폴링이 먼저 소비했으면 ack를 또 올리지 않는다", () => {
    const buffer = createInterruptBuffer();
    signalInterrupt(buffer);
    Atomics.add(buffer, ACK, 1);
    const interruptIdle = vi.fn(() => {
      Atomics.store(buffer, SIGNAL, 0);
      return true;
    });
    setup({ buffer, interruptIdle });

    vi.advanceTimersByTime(20);

    expect(buffer[ACK]).toBe(1);
  });
});
