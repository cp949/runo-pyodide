# TRP-069 worker 전역에서 리스너는 등록 순서로 호출되고 coincident 리스너가 `stopImmediatePropagation()`으로 뒤 리스너를 가린다

- 상태: ACTIVE
- 적용 조건: worker 파일에서 coincident 부트스트랩 메시지(배열 `[UID, serviceWorker, ffi_timeout]` + 포트)를 관찰하거나 그 도착을 전제하는 코드(dom-bridge `bootstrap-observer`·`prepare`). worker 전역 `message` 이벤트의 리스너 순서(캡처 옵션 포함)를 가정하는 코드·시험. 번들러가 import 순서를 바꿀 수 있는 worker 진입점을 고칠 때.

## 오해하기 쉬운 신호

- 관찰 리스너를 coincident보다 뒤에 등록하면 부트스트랩을 못 본다. coincident의 부트스트랩 리스너(`coincident/src/worker.js`)는 `{ once: true }`이고 `stopImmediatePropagation()`·`preventDefault()`를 부른다(`utils.js`의 `stop`). 같은 대상에서 이 리스너보다 뒤에 등록된 리스너는 어느 단계든 호출되지 않는다. 배열 메시지는 worker에 도착했는데 관찰기만 못 본다.
- "캡처 리스너는 DOM 표준상 등록 순서와 무관하게 먼저 호출된다"는 회피가 jsdom에서 통과한다. L0(jsdom) 시험과 변이 검사(캡처 옵션 제거 killed)가 모두 통과해 신호가 강했다. 같은 코드가 Chromium worker 전역에서는 정상 배치에서도 `prepare`가 "부트스트랩 미수신"으로 실패해 세션이 `load-failed`가 됐다.
- 계측(임시): worker 모듈 평가 맨 앞(coincident보다 먼저)에 건 캡처 리스너는 부트스트랩 배열과 core init 프레임을 모두 봤고, coincident 뒤에 건 캡처 리스너는 init만 봤다(`eventPhase=2`, 대상 자신).

## 원인

- worker 전역(대상 자신, `eventPhase=2`)에서 Chromium은 캡처/비캡처 구분 없이 **등록 순서**로 리스너를 부른다(관찰로 확인, 명세상 이유는 확인하지 않았다). 캡처 우선은 이벤트 대상이 DOM 노드이고 전파 경로에 조상이 있을 때의 규칙이다.
- 소스에서 관찰 코드를 앞 모듈로 옮겨도 번들 결과의 순서는 보장되지 않는다. tsdown·Vite 같은 번들러는 외부 import(`coincident/window/worker`)를 파일 맨 위로 올린다.

## 탐지/회피

- 관찰기는 coincident보다 먼저 평가되는 **별도 모듈**(`packages/pyodide-dom-bridge/src/bootstrap-observer-install.ts`)로 두고 `src/worker.ts`가 `coincident/window/worker`보다 먼저 import한다. 캡처 옵션은 쓰지 않는다. 관찰기는 메시지를 소비하지 않고 배열 도착만 기록한다(`docs/design/16-dom-bridge.md` 16.5).
- dist 순서는 `scripts/check-dist.mjs --allow-sync-bridge`가 검사한다. `dist/worker.mjs`가 `bootstrap-observer-install*.mjs`를 `coincident/window/worker`보다 먼저 import하지 않으면 실패한다. 관찰기 모듈은 `tsdown.config.ts`의 별도 진입점이라 dist에서도 별도 파일로 남는다.
- jsdom 시험(`packages/pyodide-dom-bridge/src/bootstrap-observer.test.ts`)은 등록 순서(가짜 대상·평가 순서)만 고정한다. worker 전역에서의 성립은 `pnpm --filter demo e2e:dom-bridge`의 S1(`ready`)과 LATE 양성 대조(부트스트랩 검사를 빼면 `load-failed`가 오지 않고 `loading`에 머문다)가 확인한다.
- worker 전역 이벤트 순서를 가정하는 시험은 jsdom 통과를 근거로 삼지 않고 브라우저에서 확인한다.
