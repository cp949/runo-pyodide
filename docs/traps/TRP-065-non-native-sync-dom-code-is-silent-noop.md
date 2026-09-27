# TRP-065 `native: false`(서비스워커 없음)에서 DOM 프록시 동기식 코드는 예외 없이 무효가 되고, 오류는 뒤 줄에서 다른 모양으로 나온다

- 상태: ACTIVE
- 적용 조건: coincident 기반 DOM 프록시(dom-bridge, `from runo.browser import document`)를 `SharedArrayBuffer` growable 생성이 불가능한 환경(`native: false`, 서비스워커 미등록)에서 동기 API로 노출하거나 시험할 때. `native: false` 조건에서 S2(동기 DOM 그리기) 계열 시나리오를 재현하는 시험을 쓸 때.

## 오해하기 쉬운 신호

- 실행 결과가 `ok`이고 pageerror가 0이다. 2026-09-25 Chromium(`native: false` 강제, coincident 4.1.1, 서비스워커 없음)에서 `d.title = "x"`는 예외 없이 지나가고 main의 `document.title`이 바뀌지 않았다.
- 오류가 나더라도 원인 줄이 아니다. 같은 실행에서 다음 줄 `d.getElementById('c').getContext('2d')`가 `AttributeError: getElementById`로 끝났다. 그 줄이 없으면 아무 오류도 나지 않는다. 창 함수 호출 `browser.window.spikeMark(1)`은 `TypeError: Expected callable`이다.
- `browser.window`·`browser.document`는 `type()` 확인에서 `JsProxy`로 보여 "프록시는 설치됐다"로 읽힌다. `native: true`에서는 같은 코드가 통과한다(title 반영, 픽셀 `[255,0,0,255]`).

## 원인

- `native: false`에서 coincident 호출은 동기 반환이 아니라 Promise 성격이다(worker에서 `runo.mark` 반환 타입이 `PyodideFuture`). 동기 속성 대입은 main에 반영되지 않고, 동기 조회는 Promise 객체의 속성을 찾다 `AttributeError`로 실패한다(추정: 원인 코드 경로는 읽지 않았고 관찰한 동작만 확정이다). coincident worker는 `native` 또는 서비스워커(`SW`)가 있을 때만 직접(동기) 경로를 쓴다(`coincident/src/worker.js:47`). 서비스워커(sabayon) 경로는 2026-09-25 측정에서 등록하지 않아 재지 않았다.
- 같은 조건에서 출력(core 채널) 대 DOM(coincident 채널) 도착 순서도 `native: true`와 다르다: 500쌍 중 35건 역전(`native: true`는 0건). 이 측정의 DOM 호출은 창 경로가 아니라 coincident 자체 프록시(`runo.mark`)였고, 창 경로는 `native: false`에서 호출 자체가 `TypeError: Expected callable`이다.

## 탐지/회피

- `native: false`를 지원 대상에 넣는 설계는 (a) `runo` 등록 시 명시 오류로 조기 실패, (b) 서비스워커 경로 지원, (c) `await` 전용 API 중 하나를 정하고 그 결과를 시험으로 고정한다. "예외 없음"·"프록시 타입이 `JsProxy`"는 통과 근거로 쓰지 않는다.
- 채택한 방침은 (a)다. dom-bridge `prepare`(`packages/pyodide-dom-bridge/src/dom-bridge-plugin.ts`)는 `native === false`이면 `runo` 모듈을 등록하지 않고 `동기 DOM 브리지(native)를 쓸 수 없다. …`로 던져 세션이 `load-failed`가 된다(새 상태는 만들지 않는다). (b)·(c)는 만들지 않았다(`docs/history/first-roadmap.md` "보류" 절). 소비자는 worker를 만들기 전에 `isDomBridgeSupported()`로 거를 수 있다. 시험은 `pnpm --filter demo e2e:dom-bridge`의 N0b가 `load-failed`와 명시 문구를 확인한다. `docs/design/16-dom-bridge.md` 16.7.
- 시험은 main의 관찰 가능한 결과(`document.title`·canvas 픽셀)로 판정한다. Python 쪽 결말(`ok`)만 보면 무효가 된 코드도 통과한다.
- `native: false` 재현 방법은 `TRP-066`이다. `async def` 태스크 안 `await` 체인도 `AttributeError: getElementById`였으나 `run`의 `topLevelAwait` 옵션을 켜고 다시 보지는 않았다.
