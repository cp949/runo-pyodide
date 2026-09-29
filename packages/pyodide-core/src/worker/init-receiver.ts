/**
 * worker init 프레임 수신기(RD-023, 01-protocols.md 4절).
 * `runWorker`가 부르기 전에 온 프레임을 잃지 않도록 message 리스너를 모듈 평가 시점에 걸고 프레임을 버퍼에 둔다.
 * `runWorker`는 `take`로 꺼내 부팅한다(먼저 왔으면 즉시, 나중에 오면 도착 때).
 *
 * 메시지 규칙은 `runWorker`가 직접 듣던 때와 같다.
 * - 배열(동기 브리지 등 다른 프로토콜): 조용히 무시한다.
 * - 객체가 아니거나 `kind`가 init이 아닌 값: 오류를 남긴다. 리스너를 유지해 뒤의 init을 받는다.
 * - init 후보(`kind === "init"`인 객체): 리스너를 뗀다(이후 네이티브 `message` 채널은 쓰지 않는다). `parseInitFrame`으로 검증한다.
 * - 필드 오류: 오류를 남기고 프레임을 버린다.
 */
import type { InitFrame } from "../protocol/init-frame";
import { parseInitFrame } from "../protocol/init-frame";

/** 수신기가 리스너를 걸고 뗄 대상. worker 전역이 기본이다. 시험은 가짜 `EventTarget`을 준다. */
export interface MessageSource {
  addEventListener(type: "message", listener: (event: Event) => void): void;
  removeEventListener(type: "message", listener: (event: Event) => void): void;
}

/** 검증을 통과한 init 프레임을 부팅에 넘기는 수신기 */
export interface InitReceiver {
  /**
   * 검증을 통과한 init 프레임을 받을 함수를 한 번만 등록한다.
   * 프레임이 이미 도착해 있으면 이 호출 안에서 즉시 부른다.
   * 두 번째 등록은 던진다(같은 프레임으로 두 번 부팅하지 않는다).
   */
  take(consume: (frame: InitFrame) => void): void;
}

/** 초기화 프레임이라고 주장하는 메시지(`kind === "init"`인 객체)인가. 필드 검증은 `parseInitFrame`이 한다. */
function isInitCandidate(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    (data as { kind?: unknown }).kind === "init"
  );
}

/**
 * 지금 전역이 worker 전역인가.
 * 브라우저 메인 스레드·jsdom·node 시험에서는 거짓이다. 모듈 평가 때 리스너를 걸지 않는다.
 * 시험이 남의 전역에 리스너를 흘리지 않게 하고, `runWorker` 호출 때 걸던 기존 동작을 유지한다.
 */
export function isWorkerGlobalScope(): boolean {
  const scope = (globalThis as { WorkerGlobalScope?: unknown })
    .WorkerGlobalScope;
  return typeof scope === "function" && globalThis instanceof scope;
}

/** `source`에 `message` 리스너를 걸어 init 프레임을 받는 수신기를 만든다. 만들자마자 듣기 시작한다. */
export function createInitReceiver(source: MessageSource): InitReceiver {
  // 소비자가 등록되기 전에 도착한 프레임
  let buffered: InitFrame | undefined;
  // `take`로 등록된 소비자
  let consumer: ((frame: InitFrame) => void) | undefined;
  let taken = false;
  const listener = (event: Event): void => {
    const data = (event as MessageEvent).data as unknown;
    if (Array.isArray(data)) return;
    if (isInitCandidate(data)) source.removeEventListener("message", listener);
    let frame: InitFrame;
    try {
      frame = parseInitFrame(data);
    } catch (error) {
      console.error("[worker] 초기화 프레임이 올바르지 않다", error);
      return;
    }
    if (consumer) consumer(frame);
    else buffered = frame;
  };
  source.addEventListener("message", listener);
  return {
    take(consume) {
      if (taken) throw new Error("runWorker는 worker당 한 번만 부를 수 있다");
      taken = true;
      if (buffered) {
        const frame = buffered;
        buffered = undefined;
        consume(frame);
      } else {
        consumer = consume;
      }
    },
  };
}
