// @vitest-environment node
/**
 * interrupt 송신기 시험(03-ctrl-c.md 2.2·2.3, TRAP-06·TRAP-24).
 * - 대상: main이 Ctrl+C마다 SIGINT를 쓰고 전달(ack)을 점검한다. 소실이면 같은 요청 번호로 다시 쓴다.
 * - 이 규칙을 결정적으로 고정한다.
 * - 타이머는 주입한 가짜를 손으로 돌린다.
 * - pyodide 폴링과 Python 핸들러는 버퍼를 직접 바꿔 흉내낸다.
 * - 진짜 경합의 소실률·이중 중단은 이 시험이 아니라 node 측정 하니스가 잰다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACK,
  acknowledgeInterrupt,
  createInterruptBuffer,
  SIGNAL,
  signalInterrupt,
} from "../../src/protocol/interrupt-protocol";
import { createInterruptSender } from "../../src/protocol/interrupt-sender";

afterEach(() => {
  vi.restoreAllMocks();
});

/** 가짜 타이머. `tick()`이 대기 중인 점검 하나를 실행한다. */
function createFakeTimer() {
  const scheduled = new Map<number, { callback: () => void; ms: number }>();
  let nextId = 1;
  return {
    setTimer(callback: () => void, ms: number): number {
      const id = nextId++;
      scheduled.set(id, { callback, ms });
      return id;
    },
    clearTimer(id: number): void {
      scheduled.delete(id);
    },
    get pending(): number {
      return scheduled.size;
    },
    get pendingDelays(): number[] {
      return [...scheduled.values()].map((timer) => timer.ms);
    },
    tick(): void {
      const next = scheduled.entries().next();
      if (next.done) throw new Error("대기 중인 타이머가 없다");
      const [id, timer] = next.value;
      scheduled.delete(id);
      timer.callback();
    },
  };
}

/** pyodide가 SIGINT를 읽어 비우고 핸들러가 돌아 ack가 오른 상태(전달됨). */
function deliver(buffer: Int32Array): void {
  Atomics.store(buffer, 0, 0);
  acknowledgeInterrupt(buffer);
}

/** 폴링이 읽고 비우는 사이에 main이 쓴 값이 지워진 상태(소실). 핸들러가 돌지 않아 ack는 그대로다. */
function lose(buffer: Int32Array): void {
  Atomics.store(buffer, 0, 0);
}

/** 가짜 타이머를 주입한 송신기를 만든다. `buffer`·`maxResends`·`intervalMs`로 기본값을 바꾼다. */
function setup({
  buffer = createInterruptBuffer(),
  maxResends,
  intervalMs,
}: {
  buffer?: Int32Array;
  maxResends?: number;
  intervalMs?: number;
} = {}) {
  const timer = createFakeTimer();
  const sender = createInterruptSender(buffer, {
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    maxResends,
    intervalMs,
  });
  return { buffer, timer, sender };
}

describe("send", () => {
  it("눌림을 보내면 SIGINT 슬롯이 2가 되고 요청 번호가 오른다", () => {
    const { buffer, sender } = setup();

    sender.send();

    expect(buffer[0]).toBe(2);
    expect(buffer[2]).toBe(1);
  });

  it("전달을 확인하는 점검을 5ms 뒤로 예약한다", () => {
    const { timer, sender } = setup();

    sender.send();

    expect(timer.pendingDelays).toEqual([5]);
  });

  it("점검 간격은 옵션으로 바꾼다", () => {
    const { timer, sender } = setup({ intervalMs: 20 });

    sender.send();

    expect(timer.pendingDelays).toEqual([20]);
  });
});

describe("점검", () => {
  it("점검 전에 ack가 오르면 재전송 없이 끝나고 타이머를 남기지 않는다", () => {
    const { buffer, timer, sender } = setup();
    sender.send();
    deliver(buffer);

    timer.tick();

    expect(buffer[0]).toBe(0);
    expect(buffer[2]).toBe(1);
    expect(timer.pending).toBe(0);
  });

  // pyodide가 SIGINT를 읽어 비우는 사이에 main이 쓴 값이 지워진 경우다.
  // 슬롯은 0인데 핸들러가 돌지 않아 ack가 그대로다.
  // 재전송이 번호를 올리면 핸들러가 재전송을 새 눌림으로 센다.
  // 그러면 catch-loop에서 한 번의 눌림이 두 번 중단된다(03-ctrl-c.md 2.2).
  it("SIGINT 슬롯이 비었는데 ack가 그대로면 같은 요청 번호로 다시 쓰고 다음 점검을 예약한다", () => {
    const { buffer, timer, sender } = setup();
    sender.send();
    lose(buffer);

    timer.tick();

    expect(buffer[0]).toBe(2);
    expect(buffer[2]).toBe(1);
    expect(timer.pendingDelays).toEqual([5]);
  });

  it("재전송이 전달되면(ack가 오르면) 거기서 끝난다", () => {
    const { buffer, timer, sender } = setup();
    sender.send();
    lose(buffer);
    timer.tick();
    deliver(buffer);

    timer.tick();

    expect(buffer[0]).toBe(0);
    expect(timer.pending).toBe(0);
  });

  // 비폴링 C 호출(`sum(range(...))` 등) 중에는 SIGINT가 그대로 남는다.
  // 소실이 아니므로 다시 쓰지 않는다. 재전송 예산도 쓰지 않는다.
  it("SIGINT 슬롯이 2로 남아 있으면 오래 점검해도 재전송하지 않고 포기하지도 않는다", () => {
    const { buffer, timer, sender } = setup();
    sender.send();

    for (let i = 0; i < 30; i++) timer.tick();

    expect(buffer[0]).toBe(2);
    expect(buffer[2]).toBe(1);
    expect(timer.pending).toBe(1);
    // 뒤늦게 소실돼도 예산이 남아 있어 재전송한다.
    lose(buffer);
    timer.tick();
    expect(buffer[0]).toBe(2);
  });
});

describe("재전송 상한", () => {
  it("재전송을 10번 하고도 소실이면 포기하고 타이머를 남기지 않는다", () => {
    const { buffer, timer, sender } = setup();
    sender.send();

    for (let i = 0; i < 10; i++) {
      lose(buffer);
      timer.tick();
      expect(buffer[0]).toBe(2);
    }
    lose(buffer);
    timer.tick();

    expect(buffer[0]).toBe(0);
    expect(timer.pending).toBe(0);
  });

  it("상한은 옵션으로 바꾼다", () => {
    const { buffer, timer, sender } = setup({ maxResends: 2 });
    sender.send();

    for (let i = 0; i < 2; i++) {
      lose(buffer);
      timer.tick();
    }
    lose(buffer);
    timer.tick();

    expect(buffer[0]).toBe(0);
    expect(timer.pending).toBe(0);
  });

  // 연타에서 앞선 눌림이 예산을 다 썼더라도 다음 눌림의 소실은 복구돼야 한다.
  it("새 눌림은 이전 요청이 쓴 재전송 예산을 물려받지 않고 새로 받는다", () => {
    const { buffer, timer, sender } = setup({ maxResends: 2 });
    sender.send();
    for (let i = 0; i < 2; i++) {
      lose(buffer);
      timer.tick();
    }

    sender.send();
    lose(buffer);
    timer.tick();

    expect(buffer[0]).toBe(2);
    expect(timer.pending).toBe(1);
  });
});

describe("cancel", () => {
  // worker가 프롬프트나 입력을 기다리기 시작하면 Python이 멈춘 것이라 눌림을 더 다시 쓸 이유가 없다.
  it("취소하면 예약한 점검이 사라져 이후 재전송이 없다", () => {
    const { buffer, timer, sender } = setup();
    sender.send();
    lose(buffer);

    sender.cancel();

    expect(timer.pending).toBe(0);
    expect(buffer[0]).toBe(0);
  });

  it("보낸 눌림이 없을 때 취소해도 아무 일도 없다", () => {
    const { buffer, timer, sender } = setup();

    expect(() => sender.cancel()).not.toThrow();

    expect(timer.pending).toBe(0);
    expect(Array.from(buffer)).toEqual([0, 0, 0, 0]);
  });
});

describe("요청 교체", () => {
  it("새 눌림을 보내면 이전 요청의 점검을 정리하고 요청 번호를 올린다", () => {
    const { buffer, timer, sender } = setup();
    sender.send();

    sender.send();

    expect(timer.pending).toBe(1);
    expect(buffer[2]).toBe(2);
  });

  // 낡은 ack를 기준으로 삼으면 이전 눌림의 전달을 새 눌림의 전달로 오판해 새 눌림을 점검하지 않는다.
  it("새 눌림은 이전 눌림의 ack가 아니라 새 눌림을 보낼 때의 ack를 기준으로 삼는다", () => {
    const { buffer, timer, sender } = setup();
    sender.send();
    deliver(buffer);

    sender.send();
    timer.tick();

    expect(timer.pending).toBe(1);
    expect(buffer[0]).toBe(2);
  });

  it("전달로 끝난 뒤 보낸 눌림도 새 요청으로 점검한다", () => {
    const { buffer, timer, sender } = setup();
    sender.send();
    deliver(buffer);
    timer.tick();

    sender.send();
    lose(buffer);
    timer.tick();

    expect(buffer[0]).toBe(2);
    expect(buffer[2]).toBe(2);
  });
});

describe("읽기 순서", () => {
  // 점검이 두 슬롯을 읽는 사이에 pyodide가 SIGINT를 비우고 핸들러가 ack를 올릴 수 있다.
  // SIGINT 슬롯을 먼저 읽으면 2(미소비)를 보고, 이어 읽은 ack는 이미 올라 있어 전달로 끝난다.
  // ack를 먼저 읽으면 낡은 ack와 비워진 슬롯(0)을 보고 소실로 오판해 다시 쓴다.
  // 핸들러는 재전송을 요청 번호로 무시한다. 그래도 재전송은 예산을 쓴다.
  // 요청 번호를 확인하지 않는 경로는 그 2를 새 눌림으로 소비할 수 있다.
  it("SIGINT 슬롯을 먼저 읽고 ack를 나중에 읽어, 두 읽기 사이에 핸들러가 돌아도 재전송하지 않는다", () => {
    const { buffer, timer, sender } = setup();
    sender.send();
    // Atomics.load는 오버로드라 타입이 마지막 시그니처(BigInt)로 추론된다. Int32Array 시그니처만 골라 쓴다.
    type Int32Load = (array: Int32Array, index: number) => number;
    const realLoad = Atomics.load as Int32Load;
    let reads = 0;
    vi.spyOn(Atomics as { load: Int32Load }, "load").mockImplementation(
      (array, index) => {
        const value = realLoad(array, index);
        if (++reads === 1) deliver(buffer);
        return value;
      },
    );

    timer.tick();

    expect(buffer[0]).toBe(0);
    expect(timer.pending).toBe(0);
  });
});

// worker의 stdin 취소 콜백도 같은 버퍼에 SIGINT를 쓴다(RD-008).
// 콜백은 요청 번호를 올려 쓰고, `checkInterrupt()`가 그 자리에서 소비해 핸들러가 ack한다.
// main 송신기가 점검을 예약해 둔 사이에 이 일이 끼어들 수 있다.
describe("취소 콜백과의 동시 쓰기", () => {
  it("콜백이 쓴 눌림이 소비돼 ack가 오르면 송신기는 재전송하지 않고 끝난다", () => {
    const { buffer, timer, sender } = setup();
    sender.send();

    signalInterrupt(buffer);
    deliver(buffer);

    timer.tick();

    // 송신기의 눌림과 콜백의 눌림이 따로 소비되지 않았어도 ack 하나가 스냅샷을 벗어나게 한다.
    // 그래서 점검은 전달로 끝난다.
    // 의도된 동작이다. 이 구간의 재전송은 이미 중단된 Python에 SIGINT를 남길 뿐이다.
    // 그 잔류는 worker의 `discardPendingInterrupt`가 지운다.
    expect(Atomics.load(buffer, SIGNAL)).toBe(0);
    expect(Atomics.load(buffer, ACK)).toBe(1);
    expect(buffer[2]).toBe(2);
    expect(timer.pending).toBe(0);
  });
});

// 번호·ack 슬롯이 없는 버퍼다.
// 전달을 확인할 수 없으므로 재전송하지 않고 한 번만 쓴다.
describe("길이 3 미만 버퍼", () => {
  it("SIGINT를 한 번만 쓰고 점검을 예약하지 않는다", () => {
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    const { timer, sender } = setup({ buffer });

    sender.send();

    expect(Array.from(buffer)).toEqual([2]);
    expect(timer.pending).toBe(0);
  });
});

// 타이머를 주입하지 않으면 전역 타이머를 쓴다.
// 가짜 전역 타이머로 5ms 뒤 점검이 실제로 도는지 본다.
describe("기본 타이머", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("옵션 없이 만들면 globalThis.setTimeout으로 점검을 예약한다", () => {
    vi.useFakeTimers();
    const buffer = createInterruptBuffer();
    const sender = createInterruptSender(buffer);
    sender.send();
    lose(buffer);

    vi.advanceTimersByTime(5);

    expect(buffer[0]).toBe(2);
    expect(buffer[2]).toBe(1);
  });

  it("옵션 없이 만들어도 취소하면 예약한 점검이 사라진다", () => {
    vi.useFakeTimers();
    const sender = createInterruptSender(createInterruptBuffer());
    sender.send();

    sender.cancel();

    expect(vi.getTimerCount()).toBe(0);
  });
});
