# TRP-066 coincident `native`는 옵션이 아니라 모듈 로드 시 탐지라, `native: false` 시험이 옵션 무시로 `native: true`를 재고 통과한다

- 상태: ACTIVE
- 적용 조건: Chromium(`SharedArrayBuffer` growable 지원)에서 coincident의 `native: false` 경로(서비스워커 없는 조건)를 재현하는 시험·하니스를 만들 때. Firefox·WebKit 대신 Chromium 대리 측정을 쓸 때.

## 오해하기 쉬운 신호

- `createCoincident`·`Worker` 옵션에 `native`가 있을 것이라 가정해 쿼리 파라미터(`?native=0`)나 옵션으로 넘기면 아무 오류도 나지 않는다. 옵션이 없으므로 `native: true`로 돌고 S1·S3·S4·S6이 전부 통과해 "`native: false`에서 통과"로 읽힌다.
- 한쪽 realm(main 또는 worker)만 바꾸면 양쪽 `native`가 갈려 동기 호출의 `wait`가 끝나지 않을 수 있다(코드 읽기 추정, 실행하지 않았다).

## 원인

- `coincident@4.1.1`의 `native`는 `@webreflection/utils/shared-array-buffer`(0.1.2)가 import 시점에 `new SharedArrayBuffer(4, { maxByteLength: 8 })`를 시도해 성공 여부로 정한다. 실패하면 `native = false`와 `ArrayBuffer` 기반 대체 클래스를 쓴다. main은 `native`가 `false`일 때만 서비스워커 옵션을 읽는다(`coincident/src/main.js:57`). 값이 모듈 평가 시점에 고정되므로 나중에 옵션으로 바꿀 수 없다.

## 탐지/회피

- main·worker 진입 파일 양쪽에서 coincident import보다 먼저 `globalThis.SharedArrayBuffer`를 `maxByteLength` 옵션 생성만 던지는 Proxy로 바꾼다(2026-09-25 스파이크는 이 방식을 썼고, worker는 `location` 쿼리가 없어 `Worker`의 `name`으로 조건을 전달했다). 고정 길이 생성은 계속 되어야 한다(core의 interrupt buffer·mailbox가 쓴다).
- 적용됐는지를 항목으로 판정한다: main `coincidentMain().native === false`(`nativeConfirm.main.coincidentMainEvent.native`), worker 쪽 `native` 값이 `False`, growable 생성이 던지고 고정 생성은 성공(`growableCtorThrows`·`fixedCtorWorks`), 서비스워커 등록 0. 이 항목 없이 "통과"만 기록하지 않는다.
- dom-bridge demo의 `?native=0`(`apps/demo/src/force-non-native.ts`)은 이 방식의 구현이다: `SharedArrayBuffer` 생성자를 growable 옵션 생성만 던지는 Proxy로 가려 **main·worker 양쪽 realm**에 적용한다. main은 `DomBridgeView.tsx`의 첫 import가 쿼리 `native=0`일 때만 적용하고, worker는 `native=0`일 때만 만들어지는 별도 worker 파일(`dom-bridge-native0.worker.ts`)이 첫 import로 적용한다. worker realm에서 `native === false`가 적용됐는지는 `prepare`의 `!native` 분기 문구(`동기 DOM 브리지(native)를 쓸 수 없다`)가 `load-failed`로 나오는 것으로 판정한다(`e2e:dom-bridge` N0b). main은 `native`·`isDomBridgeSupported()`가 `false`인지 본다(N0a). `docs/design/16-dom-bridge.md` 16.7.
- 이 조건은 Chromium 대리 측정이다. 실제 Firefox·WebKit의 worker 전역 `postMessage` 우회 경로와 다를 수 있다.
