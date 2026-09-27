/**
 * `?view=dom-bridge`의 관찰 기록(시험 훅). e2e가 `window.__domBridge.events`를 읽어 **순서**로 판정한다(`docs/design/09-testing.md` 9.7:
 * 시각이 아니라 이벤트 열의 앞뒤). 기록하는 사건:
 * - `runStart`·`outcome`: 실행 시작과 결말(`run()`이 정착한 시점, React 상태 반영 전)
 * - `out`: core `onOutput` 청크(`{ stream, text }`)
 * - `status`: `onStatus` 전이
 * - `dom`: `<title>` 변경 시점의 `document.title`(Python이 `document.title = …`로 바꾼 효과가 main에 도착한 순서)
 * - `slowStart`·`slowDone`: `mode=slow`의 main 쪽 `slow` 핸들러 시작·종료(`{ id, ms }`)
 * - `ctrlC`: Ctrl+C 키 눌림(캡처 단계), `stop`: stop 버튼 클릭. 중단 요청이 동기 호출 도중에 들어갔는지 순서로 보이려는 기록이다.
 */
export interface DomBridgeLogEvent {
  type: string;
  data?: unknown;
}

export const events: DomBridgeLogEvent[] = [];

export function log(type: string, data?: unknown): void {
  events.push({ type, data });
}

(
  window as unknown as { __domBridge: { events: DomBridgeLogEvent[] } }
).__domBridge = { events };

// `<title>` 텍스트가 바뀔 때마다 기록한다. 변경은 main 태스크 하나(coincident 호출 처리)마다 일어나고 관찰기 콜백은 그 태스크 직후
// 마이크로태스크라, 기록 순서가 도착 순서다.
const titleElement = document.querySelector("title");
if (titleElement !== null) {
  new MutationObserver(() => log("dom", document.title)).observe(titleElement, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

// 중단 요청 시점 기록(S5). 캡처 단계라 xterm이 키를 처리하기 전에 남는다.
window.addEventListener(
  "keydown",
  (event) => {
    if (event.ctrlKey && event.key === "c") log("ctrlC");
  },
  true,
);
