import {
  ACK,
  hasProtocolSlots,
  SIGNAL,
  signalInterrupt,
} from "./interrupt-protocol";

/** {@link createInterruptSender}의 옵션. 시험이 간격·타이머를 바꿀 때 쓴다. */
export interface InterruptSenderOptions<Timer = unknown> {
  /** 점검 간격(ms). 기본 5. */
  intervalMs?: number;

  /** 같은 번호로 다시 쓰는 상한. 기본 10. */
  maxResends?: number;

  /** 타이머 예약 함수. 기본 `globalThis.setTimeout`. 시험이 가짜 타이머를 주입한다. */
  setTimer?: (callback: () => void, ms: number) => Timer;

  /** 타이머 해제 함수. 기본 `globalThis.clearTimeout`. */
  clearTimer?: (timer: Timer) => void;
}

/**
 * main의 눌림 송신기(03-ctrl-c.md 2.2·2.3, TRAP-06·TRAP-24).
 * - `send()`가 SIGINT(2)를 쓴다.
 * - 5ms마다 전달됐는지 점검한다.
 * - 소실됐으면 같은 요청 번호로 다시 쓴다.
 *
 * 소실:
 * - pyodide 폴링이 SIGINT 슬롯을 읽어 비우는 사이에 main이 쓴 2가 지워진 경우다.
 * - 핸들러가 돌지 않는다.
 *
 * 점검 종료:
 * - worker가 프롬프트·입력을 기다리기 시작하면 `cancel()`로 멈춘다.
 * - 세션이 끝난 뒤(core 세션 `alive`가 거짓)의 눌림은 main 게이트(`pythonRunning`, 03-ctrl-c.md 2.7)가 `send()` 전에 막는다.
 * - 끝난 세션의 잔여 눌림을 처리하는 일은 이 송신기의 몫이 아니다.
 */
export interface InterruptSender {
  /**
   * 눌림 하나를 보낸다. 이전 요청은 교체한다.
   * 순서: 점검 정리 → ack 스냅샷 → `resends = 0` → `signalInterrupt` → 점검 예약.
   * ack·요청 번호 슬롯이 없는 버퍼면 한 번 쓰고 끝낸다(전달 확인 불가).
   */
  send(): void;

  /** 예약한 점검을 지운다. 보낸 눌림이 없으면 아무 일도 없다. */
  cancel(): void;
}

/** `buffer`(interrupt 버퍼)에 눌림을 쓰는 송신기를 만든다. */
export function createInterruptSender<Timer = unknown>(
  buffer: Int32Array,
  options?: InterruptSenderOptions<Timer>,
): InterruptSender;
export function createInterruptSender(
  buffer: Int32Array,
  options: InterruptSenderOptions = {},
): InterruptSender {
  const { intervalMs = 5, maxResends = 10 } = options;
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number) => globalThis.setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ??
    ((timer: unknown) =>
      globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));

  // 예약한 점검. 없으면 undefined.
  let timer: unknown;

  // 이번 요청을 보낼 때의 ack. 이 값에서 올랐으면 전달된 것이다.
  let snapshot = 0;

  // 이번 요청에서 다시 쓴 횟수
  let resends = 0;

  // 예약한 점검을 지운다.
  function stop(): void {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  }

  // 점검 한 틱. 전달됐으면 끝내고, 소실이면 다시 쓰고, 아니면 다음 틱을 예약한다.
  function check(): void {
    timer = undefined;
    // 읽기 순서가 중요하다. SIGNAL을 먼저, ACK를 나중에 읽는다.
    // 두 읽기 사이에 pyodide가 SIGINT를 비우고 핸들러가 ack를 올릴 수 있다.
    // - SIGNAL 먼저: 2를 본다. 이어 읽는 ack는 이미 올라 있어 전달로 끝난다.
    // - ACK 먼저: 낡은 ack와 비워진 SIGNAL(0)을 본다. 소실로 오판해 전달된 눌림을 다시 쓴다.
    const signal = Atomics.load(buffer, SIGNAL);
    const ack = Atomics.load(buffer, ACK);
    if (ack !== snapshot) return;
    if (signal === 0) {
      if (resends >= maxResends) return;
      // 요청 번호를 올리지 않는다. 핸들러가 같은 번호의 재전송을 무시해야 한다.
      // 그래야 `KeyboardInterrupt`를 잡고 계속 도는 프로그램이 눌림 한 번에 한 번만 중단된다.
      // 비교 교환이라 그 사이 다른 쪽이 쓴 2는 덮어쓰지 않는다.
      Atomics.compareExchange(buffer, SIGNAL, 0, 2);
      resends++;
    }
    // SIGNAL이 2로 남아 있으면 소실이 아니라 아직 소비되지 않은 것이다(폴링하지 않는 블로킹 C 호출 등).
    // 재전송 횟수를 쓰지 않고, 포기하지도 않고 다음 점검으로 넘어간다.
    timer = setTimer(check, intervalMs);
  }

  return {
    send(): void {
      stop();
      // 슬롯이 없으면 전달을 확인할 수 없다. 한 번만 쓴다.
      if (!hasProtocolSlots(buffer)) {
        signalInterrupt(buffer);
        return;
      }
      // 스냅샷은 쓰기 전에 잡는다. 쓰자마자 핸들러가 돌아 ack가 오를 수 있다. 그 뒤에 잡으면 전달을 놓친다.
      snapshot = Atomics.load(buffer, ACK);
      resends = 0;
      signalInterrupt(buffer);
      timer = setTimer(check, intervalMs);
    },
    cancel: stop,
  };
}
