// @vitest-environment node
/**
 * interrupt buffer 슬롯 규약 시험(01-protocols.md 3절, 03-ctrl-c.md 2.1·2.2).
 * 슬롯 배치는 pyodide와 Python 핸들러가 기대하는 계약이다. 상수 대신 인덱스 값을 그대로 쓴다.
 * - [0] SIGINT: pyodide가 읽고 비운다.
 * - [1] ack: worker가 올린다.
 * - [2] 요청 번호.
 * - [3] 예약.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeInterrupt,
  consumeInterrupt,
  createInterruptBuffer,
  discardPendingInterrupt,
  hasPendingInterrupt,
  hasProtocolSlots,
  readRequestSeq,
  signalInterrupt,
} from "../../src/protocol/interrupt-protocol";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createInterruptBuffer", () => {
  it("SharedArrayBuffer 위의 슬롯 4개짜리 Int32Array를 0으로 채워 만든다", () => {
    const buffer = createInterruptBuffer();

    expect(buffer).toBeInstanceOf(Int32Array);
    expect(buffer.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(Array.from(buffer)).toEqual([0, 0, 0, 0]);
  });
});

describe("signalInterrupt", () => {
  it("눌림을 쓰면 요청 번호가 1 오르고 SIGINT 슬롯이 2가 된다", () => {
    const buffer = createInterruptBuffer();

    signalInterrupt(buffer);

    expect(buffer[2]).toBe(1);
    expect(buffer[0]).toBe(2);
  });

  it("눌림마다 요청 번호가 오른다", () => {
    const buffer = createInterruptBuffer();

    signalInterrupt(buffer);
    signalInterrupt(buffer);
    signalInterrupt(buffer);

    expect(buffer[2]).toBe(3);
  });

  // SIGINT가 보이는 순간 핸들러가 읽는 번호는 이 눌림의 것이어야 한다.
  // 번호가 낡았으면 핸들러가 새 눌림을 직전 눌림의 재전송으로 오인한다.
  // 두 슬롯의 쓰기 순서는 메모리에서 직접 관찰할 수 없다.
  // SIGINT 슬롯을 쓰는 순간의 번호를 가로채 기록한다.
  it("SIGINT 슬롯을 쓰는 순간에는 요청 번호가 이미 올라 있다", () => {
    const buffer = createInterruptBuffer();
    // Atomics.store는 오버로드라 타입이 마지막 시그니처(BigInt)로 추론된다. Int32Array 시그니처만 골라 쓴다.
    type Int32Store = (
      array: Int32Array,
      index: number,
      value: number,
    ) => number;
    const realStore = Atomics.store as Int32Store;
    const seqWhenSignalWritten: number[] = [];
    vi.spyOn(Atomics as { store: Int32Store }, "store").mockImplementation(
      (array, index, value) => {
        if (index === 0 && value === 2)
          seqWhenSignalWritten.push(Atomics.load(array, 2));
        return realStore(array, index, value);
      },
    );

    signalInterrupt(buffer);

    expect(seqWhenSignalWritten).toEqual([1]);
  });
});

// 핸들러는 SIGINT를 받으면 이번 눌림의 번호를 읽어 재전송(같은 번호)과 새 눌림을 구분한다.
// 세 슬롯의 값을 모두 다르게 만든다. 그래야 SIGINT·ack 슬롯을 잘못 읽는 경우가 드러난다.
describe("readRequestSeq", () => {
  it("요청 번호 슬롯 [2]를 읽는다", () => {
    const buffer = createInterruptBuffer();
    signalInterrupt(buffer);
    signalInterrupt(buffer);
    signalInterrupt(buffer);
    acknowledgeInterrupt(buffer);

    expect(Array.from(buffer)).toEqual([2, 1, 3, 0]);
    expect(readRequestSeq(buffer)).toBe(3);
  });
});

describe("acknowledgeInterrupt", () => {
  it("ack 슬롯을 1 올린다", () => {
    const buffer = createInterruptBuffer();

    acknowledgeInterrupt(buffer);
    acknowledgeInterrupt(buffer);

    expect(buffer[1]).toBe(2);
  });

  it("SIGINT 슬롯과 요청 번호는 건드리지 않는다", () => {
    const buffer = createInterruptBuffer();
    signalInterrupt(buffer);

    acknowledgeInterrupt(buffer);

    expect(buffer[0]).toBe(2);
    expect(buffer[2]).toBe(1);
  });
});

// worker가 실행 직전에 남은 SIGINT를 버리는 규칙.
// 버린 눌림도 main의 재전송 대상에서 빠지도록 ack를 올린다.
// ack 없이 지우면 송신기가 소실로 오판해 2를 되살린다(TRAP-31).
// 지울 것이 없었으면 ack하지 않는다. 이미 처리된 눌림을 다시 ack하면 ack가 낡은 값이 된다.
describe("discardPendingInterrupt", () => {
  it("SIGINT를 지웠으면 ack를 1 올린다", () => {
    const buffer = createInterruptBuffer();
    signalInterrupt(buffer);

    discardPendingInterrupt(buffer);

    expect(buffer[0]).toBe(0);
    expect(buffer[1]).toBe(1);
  });

  it("지울 SIGINT가 없었으면 ack하지 않는다", () => {
    const buffer = createInterruptBuffer();

    discardPendingInterrupt(buffer);

    expect(buffer[0]).toBe(0);
    expect(buffer[1]).toBe(0);
  });

  it("요청 번호는 건드리지 않는다", () => {
    const buffer = createInterruptBuffer();
    signalInterrupt(buffer);

    discardPendingInterrupt(buffer);

    expect(buffer[2]).toBe(1);
  });
});

// 감시 타이머(03-ctrl-c.md 2.5)의 엿보기. 실제로 지우지는 않는다.
describe("hasPendingInterrupt", () => {
  it("SIGINT 슬롯이 2이면 참이다", () => {
    const buffer = createInterruptBuffer();
    signalInterrupt(buffer);

    expect(hasPendingInterrupt(buffer)).toBe(true);
  });

  it("SIGINT 슬롯이 2가 아니면 거짓이다", () => {
    const buffer = createInterruptBuffer();

    expect(hasPendingInterrupt(buffer)).toBe(false);
  });
});

// 감시 타이머가 정지한 실행을 깨웠을 때만 부른다.
// 비교 교환이 실패하면(폴링이 먼저 비웠다) ack를 또 올리지 않는다.
describe("consumeInterrupt", () => {
  it("SIGINT 슬롯이 2면 지우고 ack를 올리고 true를 돌려준다", () => {
    const buffer = createInterruptBuffer();
    signalInterrupt(buffer);

    expect(consumeInterrupt(buffer)).toBe(true);

    expect(buffer[0]).toBe(0);
    expect(buffer[1]).toBe(1);
  });

  it("SIGINT 슬롯이 2가 아니면 건드리지 않고 false를 돌려준다", () => {
    const buffer = createInterruptBuffer();

    expect(consumeInterrupt(buffer)).toBe(false);

    expect(buffer[0]).toBe(0);
    expect(buffer[1]).toBe(0);
  });
});

// 길이 3 미만 버퍼에는 ack·요청 번호 슬롯이 없다.
// 그 슬롯을 다루는 함수는 아무것도 하지 않고 SIGINT 슬롯만 동작한다.
// 범위를 벗어난 Atomics 접근은 RangeError라 슬롯이 있는지 먼저 확인해야 한다.
describe("hasProtocolSlots", () => {
  // 길이 1 버퍼. SIGINT 슬롯만 있다.
  const shortBuffer = () => new Int32Array(new SharedArrayBuffer(4));

  it("길이 4 버퍼는 슬롯이 있고 길이 3 이하는 없다", () => {
    // SharedArrayBuffer 인자는 바이트 수다. 12바이트는 길이 3, 8바이트는 길이 2다.
    expect(hasProtocolSlots(createInterruptBuffer())).toBe(true);
    expect(hasProtocolSlots(new Int32Array(new SharedArrayBuffer(12)))).toBe(
      true,
    );
    expect(hasProtocolSlots(new Int32Array(new SharedArrayBuffer(8)))).toBe(
      false,
    );
    expect(hasProtocolSlots(shortBuffer())).toBe(false);
  });

  it("짧은 버퍼에서 눌림은 SIGINT 슬롯에 2를 쓰고 요청 번호는 건너뛴다", () => {
    const buffer = shortBuffer();

    signalInterrupt(buffer);

    expect(Array.from(buffer)).toEqual([2]);
  });

  it("짧은 버퍼에서 요청 번호 읽기는 0이다", () => {
    const buffer = shortBuffer();
    signalInterrupt(buffer);

    expect(readRequestSeq(buffer)).toBe(0);
  });

  it("짧은 버퍼에서 ack는 아무것도 하지 않는다", () => {
    const buffer = shortBuffer();

    expect(() => acknowledgeInterrupt(buffer)).not.toThrow();

    expect(Array.from(buffer)).toEqual([0]);
  });

  it("짧은 버퍼에서 폐기는 SIGINT를 지우지만 ack는 하지 않는다", () => {
    const buffer = shortBuffer();
    buffer[0] = 2;

    expect(() => discardPendingInterrupt(buffer)).not.toThrow();

    expect(Array.from(buffer)).toEqual([0]);
  });
});
