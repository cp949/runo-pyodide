/**
 * coincident 부트스트랩 관찰기. coincident는 worker 전역에서 main이 생성자 안에서 동기로 보내는 부트스트랩 메시지(배열
 * `[UID, serviceWorker, ffi_timeout]`)를 받아야 `coincident()`가 풀린다. worker 모듈이 이 메시지보다 늦게 평가되면(첫 정적
 * import 규칙 위반) 부트스트랩을 놓쳐 영원히 대기하므로, "배열 메시지가 도착했는가"만 기록해 `prepare`가 명시 오류로 실패할 수
 * 있게 한다(고정 대기를 쓰지 않는다).
 *
 * 성립 조건은 **등록 순서**다: coincident 리스너는 `stopImmediatePropagation()`으로 메시지를 삼키므로 관찰 리스너가 coincident
 * 리스너보다 먼저 등록돼야 메시지를 본다(같은 대상에서 리스너는 등록 순서대로 호출된다). 캡처 단계로 걸어 순서를 피하려는 방식은
 * Chromium worker 전역에서 성립하지 않았다(대상 자신에서는 캡처·비캡처 구분 없이 등록 순서로 호출됨, 실측). 그래서 이 관찰기는
 * `bootstrap-observer-install.ts`가 `coincident/window/worker`보다 먼저 평가되는 별도 모듈(dist에서도 별도 파일)에서 만든다.
 * 메시지를 소비하지도(`stopImmediatePropagation`·`preventDefault` 금지) `once`로 떼지도 않는다. core init 프레임(객체)은 세지 않는다.
 */

/** 관찰기가 리스너를 거는 대상. worker 전역이 기본이고 시험은 DOM 노드를 준다. */
export interface ObservedTarget {
  addEventListener(type: "message", listener: (event: Event) => void): void;
}

export interface BootstrapObserver {
  /** 부트스트랩(배열) 메시지를 한 번이라도 받았는가. */
  readonly received: boolean;
}

export function createBootstrapObserver(
  target: ObservedTarget,
): BootstrapObserver {
  let received = false;
  target.addEventListener("message", (event) => {
    if (Array.isArray((event as MessageEvent).data)) received = true;
  });
  return {
    get received() {
      return received;
    },
  };
}
