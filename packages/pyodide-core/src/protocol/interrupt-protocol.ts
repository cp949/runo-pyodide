/**
 * interrupt buffer 슬롯 규약(01-protocols.md 3절, 03-ctrl-c.md 2.1·2.2). pyodide는 [0]만 읽는다.
 * 나머지는 소실된 눌림을 main이 알아채고 다시 보내기 위한 것이다.
 *
 * - [0] SIGNAL: main이 2를 쓰고 pyodide 폴링이 읽어 비운다.
 * - [1] ACK: 눌림이 worker에 전달됐다는 표시. worker 스레드 한 곳만 올린다.
 * - [2] SEQ: 요청 번호. 새 눌림마다 +1, 재전송은 같은 번호.
 * - [3] 예약.
 */
export const SIGNAL = 0;
export const ACK = 1;
export const SEQ = 2;
export const INTERRUPT_BUFFER_LENGTH = 4;

export function createInterruptBuffer(): Int32Array {
  return new Int32Array(
    new SharedArrayBuffer(
      INTERRUPT_BUFFER_LENGTH * Int32Array.BYTES_PER_ELEMENT,
    ),
  );
}

/** ack·요청 번호 슬롯이 있는 버퍼인지. 범위를 벗어난 Atomics 접근은 RangeError라 두 슬롯을 만지기 전에 확인한다. */
export function hasProtocolSlots(buffer: Int32Array): boolean {
  return buffer.length > SEQ;
}

/**
 * SIGINT(2)를 쓰는 경로. 번호를 먼저 올려야 한다: SIGINT가 보이는 순간 핸들러가 읽는 번호는 이 눌림의 것이어야
 * 새 눌림을 직전 눌림의 재전송으로 오인하지 않는다.
 */
export function signalInterrupt(buffer: Int32Array): void {
  if (hasProtocolSlots(buffer)) Atomics.add(buffer, SEQ, 1);
  Atomics.store(buffer, SIGNAL, 2);
}

/** 현재 요청 번호(슬롯 [2]). 프로토콜 슬롯이 없는 버퍼면 0. 핸들러가 재전송과 새 눌림을 구분할 때 읽는다. */
export function readRequestSeq(buffer: Int32Array): number {
  return hasProtocolSlots(buffer) ? Atomics.load(buffer, SEQ) : 0;
}

/** 눌림이 worker 스레드에 전달됐다고 표시한다. worker 스레드 한 곳에서만 부른다. */
export function acknowledgeInterrupt(buffer: Int32Array): void {
  if (hasProtocolSlots(buffer)) Atomics.add(buffer, ACK, 1);
}

/** 대상 코드가 없는 SIGINT를 지운다. 2를 지웠을 때만 ack한다(이미 처리된 눌림을 두 번 ack하면 ack가 낡은 값이 된다). */
export function discardPendingInterrupt(buffer: Int32Array): void {
  if (Atomics.exchange(buffer, SIGNAL, 0) === 2) acknowledgeInterrupt(buffer);
}

/** SIGINT 슬롯이 2(전달 대기)인가. 감시 타이머의 엿보기(03-ctrl-c.md 2.5). */
export function hasPendingInterrupt(buffer: Int32Array): boolean {
  return Atomics.load(buffer, SIGNAL) === 2;
}

/**
 * 2 → 0 비교 교환이 성공했을 때만 ack하고 true를 돌려준다. 폴링이 먼저 비웠으면(핸들러가 이미 ack했다) false —
 * 감시 타이머가 되살리거나 다시 ack하지 않는다(03-ctrl-c.md 2.2 ack 지점 ②).
 */
export function consumeInterrupt(buffer: Int32Array): boolean {
  if (Atomics.compareExchange(buffer, SIGNAL, 2, 0) !== 2) return false;
  acknowledgeInterrupt(buffer);
  return true;
}
