# TRP-071 reflected-ffi 원격 창 프록시를 JS `Proxy`로 감싸면 비설정 속성(`window.document`·`location`)의 Python 접근이 불변식 오류로 실패한다

- 상태: ACTIVE
- 적용 조건: worker에서 본 main `window`(reflected-ffi 원격 프록시)를 JS `Proxy`로 감싸는 코드(dom-bridge `guardedWindow`), 원격 프록시를 다른 `Proxy`의 target으로 쓰는 코드. 그 감싼 객체를 Python(`registerJsModule`·`JsProxy`)에 넘길 때. 이 코드의 시험을 쓸 때.

## 오해하기 쉬운 신호

- 가드 없는 원격 창은 `document`·`location.href`가 Python에서 동작한다. 원격 프록시를 target으로 둔 `get` 전용 `Proxy`로 감싸면 `window.document`를 읽는 순간 `TypeError: 'getOwnPropertyDescriptor' on proxy: trap reported non-configurability for property 'document' which is either non-existent or configurable in the proxy target`가 난다.
- 함수 속성(`window.spikeMark` 등)·`innerWidth`·`dir(window)`는 통과한다. 함수 속성만 시험한 스파이크와 L0(가짜 창 객체·jsdom)는 통과해 결함을 놓친다.
- L0 대역은 평범한 객체를 target으로 쓴다. 평범한 객체는 target이 곧 값의 원천이라 불변식에 걸리지 않는다.

## 원인

- reflected-ffi 원격 프록시는 자기 target이 비어 있는데도 `getOwnPropertyDescriptor`가 실제 창의 설명자를 돌려준다. 실제 `window.document`·`location`은 비설정(non-configurable) own 속성이라, 원격 프록시에 설명자를 묻는 순간 "target에 없거나 설정 가능한 속성을 비설정으로 보고"한 것이 되어 원격 프록시 자신의 불변식 위반(`TypeError`)으로 던진다.
- 설명자를 묻는 쪽은 Python `JsProxy`가 아니라 **바깥 `Proxy`의 `[[Get]]` 불변식 검사**다. 원격 프록시를 target으로 둔 감싸는 `Proxy`는 `get` trap 결과를 검사하려고 target에 `getOwnPropertyDescriptor`를 묻는다. 그래서 `get` trap만 있는 감싸기로도 순수 JS에서 재현된다: `new Proxy(remote, { get: (t, k) => Reflect.get(t, k) }).document`(실제 reflected-ffi 0.7.2 local/remote 쌍, `_works/_completed/20260925-32-rd-023-dom-bridge/verify/post-review/a1-defect-probe.mjs`). Python에서는 `window.document` 읽기가 이 경로로 실패한다.

## 탐지/회피

- `packages/pyodide-dom-bridge/src/guarded-window.ts`: 감싸는 프록시의 target을 **빈 일반 객체**로 두고 `get`·`set`·`has`(심볼 키 포함)·`deleteProperty`·`ownKeys`·`getPrototypeOf`를 원격에 직접 위임한다. 빈 target을 바꾸는 `defineProperty`·`setPrototypeOf`·`preventExtensions`는 `false`로 거부한다(빈 target에 비설정 속성이 생기거나 확장 불가가 되면 뒤의 설명자·나열이 불변식 오류로 영구히 깨진다). `has`가 심볼 키를 위임해야 메서드 호출 receiver로 넘어간 guard를 reflected-ffi가 `reflected in value` 검사로 원격 창 참조로 되돌려 main 쪽 `this`가 원본 창이 된다. `getOwnPropertyDescriptor`는 원격 설명자를 묻지 않고 값에서 만든 설정 가능한(`configurable: true`) 데이터 설명자로 돌려준다. `parent`·`top`·`opener`는 `get`에서 명시 오류, 설명자·나열에서는 없는 속성처럼 처리한다.
- L0는 "빈 target 프록시 + 비설정 속성 설명자" 대역과 실제 reflected-ffi 0.7.2 local/remote 쌍(메서드 호출 receiver)을 쓴다(`packages/pyodide-dom-bridge/src/guarded-window.test.ts`). 실제 원격 프록시의 동작은 브라우저에서만 나오므로 `pnpm --filter demo e2e:dom-bridge` S2 guarded 셀(guarded `window`의 `document` 읽기와 `parent` 차단)이 확인한다.
- 알려진 차이: `dir(window)` 길이가 가드 없는 창보다 3개 적다(차단 3개, 프로브 기준 1289 → 1286). `docs/design/16-dom-bridge.md` 16.6.
