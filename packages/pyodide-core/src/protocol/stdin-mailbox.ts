/**
 * stdin 메일박스(01-protocols.md 2절, ADR-0002).
 * - `input()`·`sys.stdin` 읽기 한 건의 응답을 main이 worker에 동기적으로 넘긴다. worker는 `Atomics.wait`로 정지해 있다.
 * - 단방향 우편함이다. 세션(worker)마다 새로 만든다.
 *
 * 공유하는 해석 단계:
 * - worker `wait()`(2.2)와 main 쪽 시험용 `takeMailboxResponse`(2.5)는 `consumeReady` 하나를 공유한다.
 * - 시험용 `peekMailbox`(2.5)는 소비하지 않는다. `readReadyChunk`·`readErrorMessage`만 공유한다.
 * - take·peek는 `./test-utils`로만 나간다.
 *
 * 배치:
 * - 제어 `Int32Array(4)` = [STATE, BYTE_LENGTH, FLAGS, 예약].
 * - 데이터 `Uint8Array(CAPACITY)`.
 * - growable `SharedArrayBuffer`는 쓰지 않고 고정 할당한다.
 * - STATE 값: IDLE 0·READY 1·CANCELLED 2·ERROR 3·EOF 4.
 */
const CAPACITY = 64 * 1024;
const HEADER_BYTES = 16;

/** `Atomics.waitAsync`가 없는 환경에서 IDLE 복귀를 확인하는 간격(ms). */
const POLL_INTERVAL_MS = 1;

// ctrl 인덱스
const STATE = 0;
const BYTE_LENGTH = 1;
const FLAGS = 2;

// ctrl[STATE] 값
const IDLE = 0;
const READY = 1;
const CANCELLED = 2;
const ERROR = 3;
const EOF = 4;

// ctrl[FLAGS] 비트: 마지막 청크
const FLAG_LAST = 1;

/** 초기화 프레임의 `stdinCtrl`·`stdinData`가 되는 두 뷰. 같은 SharedArrayBuffer를 가리킨다. */
export interface StdinMailboxBuffers {
  /** 제어 슬롯 [STATE, BYTE_LENGTH, FLAGS, 예약] */
  ctrl: Int32Array;

  /** 청크 데이터. 최대 `CAPACITY`바이트 */
  data: Uint8Array;
}

/** 빈 메일박스(STATE = IDLE)를 새로 만든다. */
export function createStdinMailbox(): StdinMailboxBuffers {
  const sab = new SharedArrayBuffer(HEADER_BYTES + CAPACITY);
  return {
    ctrl: new Int32Array(sab, 0, 4),
    data: new Uint8Array(sab, HEADER_BYTES, CAPACITY),
  };
}

/** main 쪽. `readInput` 알림을 받은 뒤에만 쓴다. */
export interface MailboxWriter {
  /** 한 줄을 전달한다. 64KiB를 넘으면 청크로 나눠 worker가 가져갈 때마다 다음 청크를 쓴다. */
  deliver(text: string): Promise<void>;
  /** worker의 `wait()`를 취소 표식으로 끝낸다(읽기 취소). */
  cancel(): Promise<void>;
  /** worker의 `wait()`를 EOF로 끝낸다(입력 끝, 취소가 아니다). */
  eof(): Promise<void>;
  /** worker의 `wait()`가 `message`를 가진 Error를 던지게 한다. 데이터 영역을 넘는 메시지는 문자 경계에서 자른다. */
  fail(message: string): Promise<void>;
}

// Atomics.waitAsync는 lib.es2022 타입에 없다. 지원 여부는 호출 시점에 확인한다.
type WaitAsync = (
  typedArray: Int32Array,
  index: number,
  value: number,
) =>
  | { async: false; value: "not-equal" | "timed-out" }
  | { async: true; value: Promise<"ok" | "timed-out"> };

/**
 * `isWaiting(현재 STATE)`가 참인 동안 기다린다.
 * - `Atomics.waitAsync`가 있으면 그것으로 기다린다.
 * - 없으면 `POLL_INTERVAL_MS` 폴링으로 기다린다.
 * - 깨어날 때마다 값을 다시 읽어 확인한다(스퓨리어스 웨이크에도 안전).
 */
async function waitWhile(
  ctrl: Int32Array,
  isWaiting: (state: number) => boolean,
): Promise<void> {
  for (;;) {
    const state = Atomics.load(ctrl, STATE);
    if (!isWaiting(state)) return;
    const waitAsync = (Atomics as unknown as { waitAsync?: WaitAsync })
      .waitAsync;
    if (waitAsync) {
      const result = waitAsync(ctrl, STATE, state);
      if (result.async) await result.value;
    } else {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, POLL_INTERVAL_MS),
      );
    }
  }
}

/** 직전 청크를 worker가 가져가 STATE가 IDLE로 돌아올 때까지 기다린다(writer 쪽). */
async function untilIdle(ctrl: Int32Array): Promise<void> {
  await waitWhile(ctrl, (state) => state !== IDLE);
}

/** STATE를 바꾸고 기다리는 쪽을 깨운다. 양쪽이 서로의 전이를 기다리므로 IDLE로 되돌릴 때도 부른다. */
function setState(ctrl: Int32Array, state: number): void {
  Atomics.store(ctrl, STATE, state);
  Atomics.notify(ctrl, STATE);
}

/** main 쪽 writer를 만든다. 모든 쓰기는 먼저 STATE가 IDLE로 돌아오길 기다린다. */
export function createMailboxWriter({
  ctrl,
  data,
}: StdinMailboxBuffers): MailboxWriter {
  return {
    async deliver(text) {
      const bytes = new TextEncoder().encode(text);
      // 빈 문자열도 빈 청크 하나로 보낸다(do-while).
      // 마지막 청크에만 FLAG_LAST를 세운다.
      let offset = 0;
      do {
        await untilIdle(ctrl);
        const end = Math.min(offset + CAPACITY, bytes.length);
        data.set(bytes.subarray(offset, end));
        Atomics.store(ctrl, BYTE_LENGTH, end - offset);
        Atomics.store(ctrl, FLAGS, end === bytes.length ? FLAG_LAST : 0);
        setState(ctrl, READY);
        offset = end;
      } while (offset < bytes.length);
    },
    async cancel() {
      await untilIdle(ctrl);
      setState(ctrl, CANCELLED);
    },
    async eof() {
      await untilIdle(ctrl);
      setState(ctrl, EOF);
    },
    async fail(message) {
      await untilIdle(ctrl);
      // encodeInto는 완전한 문자만 쓰므로 넘치는 메시지도 깨진 문자 없이 잘린다.
      const { written } = new TextEncoder().encodeInto(message, data);
      Atomics.store(ctrl, BYTE_LENGTH, written);
      setState(ctrl, ERROR);
    },
  };
}

/** `input()` 읽기 한 건에 main이 돌려준 결말(`deliver`·`cancel`·`eof`·`fail`). 규칙은 `docs/design/01-protocols.md` 2.2. */
export type MailboxResponse =
  | { kind: "line"; text: string }
  | { kind: "cancelled" }
  | { kind: "eof" }
  | { kind: "error"; message: string };

/** 소비하지 않고 본 현재 메일박스 상태. `chunk`는 줄 일부일 수 있다(`last`가 false면 다음 청크가 남았다). */
export type MailboxPeek =
  | { kind: "none" }
  | { kind: "chunk"; text: string; last: boolean }
  | { kind: "cancelled" }
  | { kind: "eof" }
  | { kind: "error"; message: string };

/** {@link consumeReady}의 결과. `idle`은 스퓨리어스 웨이크(STATE가 여전히 IDLE), `pending`은 마지막이 아닌 청크. */
type ReadyStep =
  { kind: "idle" } | { kind: "pending"; text: string } | MailboxResponse;

/**
 * 현재 READY 청크(바이트·마지막 여부)를 읽는다. STATE·데이터는 바꾸지 않는다.
 * `TextDecoder`가 SharedArrayBuffer 뷰를 받지 않는 브라우저가 있어 바이트를 복사해 돌려준다.
 */
function readReadyChunk(
  ctrl: Int32Array,
  data: Uint8Array,
): { bytes: Uint8Array; last: boolean } {
  return {
    bytes: data.slice(0, Atomics.load(ctrl, BYTE_LENGTH)),
    last: (Atomics.load(ctrl, FLAGS) & FLAG_LAST) !== 0,
  };
}

/** 현재 ERROR 메시지를 디코드한다. STATE·데이터는 바꾸지 않는다. */
function readErrorMessage(ctrl: Int32Array, data: Uint8Array): string {
  return new TextDecoder().decode(
    data.slice(0, Atomics.load(ctrl, BYTE_LENGTH)),
  );
}

/**
 * 현재 STATE를 한 번 소비한다.
 * - IDLE: 소비할 것이 없다(`idle`). 스퓨리어스 웨이크다.
 * - READY: 청크 하나. 스트리밍 디코더에 이어 붙이고, 마지막 청크면 응답(`line`), 아니면 `pending`.
 * - CANCELLED/EOF/ERROR: 응답.
 *
 * 소비하면 STATE를 IDLE로 되돌리고 notify한다(`setState`).
 * `wait()`(동기 `Atomics.wait` 뒤)와 `takeMailboxResponse()`(비동기 `waitWhile` 뒤)가 이 함수 하나를 공유한다.
 */
function consumeReady(
  { ctrl, data }: StdinMailboxBuffers,
  decoder: TextDecoder,
): ReadyStep {
  switch (Atomics.load(ctrl, STATE)) {
    case READY: {
      const { bytes, last } = readReadyChunk(ctrl, data);
      setState(ctrl, IDLE);
      const text = decoder.decode(bytes, { stream: !last });
      return last ? { kind: "line", text } : { kind: "pending", text };
    }
    case CANCELLED:
      setState(ctrl, IDLE);
      return { kind: "cancelled" };
    case EOF:
      setState(ctrl, IDLE);
      return { kind: "eof" };
    case ERROR: {
      const message = readErrorMessage(ctrl, data);
      setState(ctrl, IDLE);
      return { kind: "error", message };
    }
    default:
      return { kind: "idle" };
  }
}

/** worker 쪽 reader. `Atomics.wait`는 worker에서만 허용된다. */
export interface MailboxReader {
  /**
   * 응답 한 건이 올 때까지 정지한다.
   * `error` 응답은 반환하지 않고 `Error`로 던진다(반환 타입은 `MailboxResponse`에서 `error`를 뺀 나머지).
   */
  wait(): Exclude<MailboxResponse, { kind: "error" }>;
}

/** worker 쪽 reader를 만든다. */
export function createMailboxReader(
  buffers: StdinMailboxBuffers,
): MailboxReader {
  const { ctrl } = buffers;
  return {
    wait() {
      // 청크 경계는 바이트 단위라 UTF-8 시퀀스 중간일 수 있다. 디코더를 청크 사이에 이어 붙이고 마지막 청크에서 닫는다.
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        Atomics.wait(ctrl, STATE, IDLE);
        const step = consumeReady(buffers, decoder);
        switch (step.kind) {
          case "idle":
            // 스퓨리어스 웨이크. 다시 기다린다.
            break;
          case "pending":
            text += step.text;
            break;
          case "line":
            return { kind: "line", text: text + step.text };
          case "cancelled":
            return { kind: "cancelled" };
          case "eof":
            return { kind: "eof" };
          case "error":
            throw new Error(step.message);
        }
      }
    },
  };
}

/**
 * main 쪽(시험용) 응답 수신. 규칙은 `docs/design/01-protocols.md` 2.5.
 * - 실제 worker의 `wait()`처럼 청크를 모두 가져가고 STATE를 IDLE로 되돌린다.
 * - 시간 상한은 없다. 멈추면 시험 timeout이 잡는다.
 */
export async function takeMailboxResponse(
  buffers: StdinMailboxBuffers,
): Promise<MailboxResponse> {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    await waitWhile(buffers.ctrl, (state) => state === IDLE);
    const step = consumeReady(buffers, decoder);
    switch (step.kind) {
      case "idle":
        continue;
      case "pending":
        text += step.text;
        continue;
      case "line":
        return { kind: "line", text: text + step.text };
      case "cancelled":
      case "eof":
      case "error":
        return step;
    }
  }
}

/** main 쪽(시험용) 엿보기. 현재 STATE를 해석만 한다. STATE·데이터는 바꾸지 않는다. 규칙은 `docs/design/01-protocols.md` 2.5. */
export function peekMailbox({ ctrl, data }: StdinMailboxBuffers): MailboxPeek {
  switch (Atomics.load(ctrl, STATE)) {
    case READY: {
      const { bytes, last } = readReadyChunk(ctrl, data);
      return { kind: "chunk", text: new TextDecoder().decode(bytes), last };
    }
    case CANCELLED:
      return { kind: "cancelled" };
    case EOF:
      return { kind: "eof" };
    case ERROR:
      return { kind: "error", message: readErrorMessage(ctrl, data) };
    default:
      return { kind: "none" };
  }
}
