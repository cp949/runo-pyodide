/**
 * `?view=dom-bridge`의 관찰 기록 한 건(시험 훅).
 *
 * e2e가 `window.__domBridge.events`를 읽어 **순서**로 판정한다. 시각이 아니라 이벤트 열의 앞뒤를 본다(docs/design/09-testing.md 9.7).
 *
 * 기록하는 사건(`type`):
 * - `runStart`·`outcome`: 실행 시작과 결말. 결말은 `run()`이 정착한 시점이며 React 상태 반영 전이다.
 * - `out`: core `onOutput` 청크(`{ stream, text }`).
 * - `status`: `onStatus` 전이.
 * - `dom`: `<title>` 변경 시점의 `document.title`. Python이 `document.title = …`로 바꾼 효과가 main에 도착한 순서다.
 * - `slowStart`·`slowDone`: `mode=slow`의 main 쪽 `slow` 핸들러 시작·종료(`{ id, ms }`).
 * - `ctrlC`: Ctrl+C 키 눌림(캡처 단계).
 * - `stop`: stop 버튼 클릭.
 *
 * `ctrlC`·`stop`은 중단 요청이 동기 호출 도중에 들어갔는지 순서로 보이려는 기록이다.
 */
export interface DomBridgeLogEvent {
  /** 사건 종류 */
  type: string;

  /** 사건별 부가 값. 없을 수 있다. */
  data?: unknown;
}

/** 기록한 사건 열. 도착 순서대로 쌓이며 `window.__domBridge.events`로도 노출한다. */
export const events: DomBridgeLogEvent[] = [];

/** 사건 하나를 `events` 끝에 덧붙인다. */
export function log(type: string, data?: unknown): void {
  events.push({ type, data });
}

(
  window as unknown as { __domBridge: { events: DomBridgeLogEvent[] } }
).__domBridge = { events };

// `<title>` 텍스트가 바뀔 때마다 `dom`으로 기록한다.
// 변경은 main 태스크 하나(coincident 호출 처리)마다 일어난다.
// 관찰기 콜백은 그 태스크 직후 마이크로태스크로 돈다. 그래서 기록 순서가 도착 순서다.
const titleElement = document.querySelector("title");
if (titleElement !== null) {
  new MutationObserver(() => log("dom", document.title)).observe(titleElement, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

// Ctrl+C 시점을 `ctrlC`로 기록한다(S5). 캡처 단계라 xterm이 키를 처리하기 전에 남는다.
window.addEventListener(
  "keydown",
  (event) => {
    if (event.ctrlKey && event.key === "c") log("ctrlC");
  },
  true,
);
