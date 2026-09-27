# pyodide-dom-bridge

worker의 Python이 main 페이지의 `window`·`document`를 동기 프록시로 쓰게 하는 플러그인 패키지(RD-023). core 위에 얹히고 coincident에 의존하는 유일한 패키지다(ADR-0006). private이고 공개 API로 확정하지 않은 내부 계약이다. 코드·문서·시험 이름에 쓰는 용어를 정의한다. main·worker·세션·인터럽트의 일반 용어는 `packages/pyodide-repl/CONTEXT.md`, driver·플러그인 계약(`WorkerPlugin`)·`loadFailed`는 `packages/pyodide-core/CONTEXT.md`를 따르고, 여기서는 dom-bridge가 도입한 용어만 정의한다. 규칙 본문은 `docs/design/16-dom-bridge.md`.

## Language

**dom-bridge 플러그인(`domBridge()`)**:
core `runWorker({ plugins })`에 넘기는 `WorkerPlugin`(`name: "dom-bridge"`). `prepare`가 부트스트랩 수신 확인 → 브리지 준비 → `native` 확인 → `runo` 모듈 등록을 이 순서로 한다. 하나라도 실패하면 세션은 `load-failed`이고 원인 문구는 `Error: plugin "dom-bridge": <원인>`이다.
_Avoid_: 어댑터, 래퍼

**부트스트랩(bootstrap)**:
coincident `Worker`가 생성자 안에서 동기로 보내는 첫 메시지(배열 `[UID, serviceWorker, ffi_timeout]` + 포트 1개). worker의 coincident 모듈은 평가 시점에 이를 받는 리스너를 한 번 건다. 놓치면 `coincident()`가 영원히 대기한다. core init 프레임(`kind: "init"` 객체)과 다른 메시지이고 항상 먼저 도착한다.
_Avoid_: 핸드셰이크

**부트스트랩 관찰기(`createBootstrapObserver`)**:
모듈 평가 시점에 `message` 리스너를 걸고 배열 메시지가 도착했는지만 기록한다. coincident 리스너가 `stopImmediatePropagation()`으로 메시지를 삼키므로 **coincident 리스너보다 먼저 등록**돼야 한다(성립 조건은 등록 순서다. 캡처 단계로 거는 방식은 Chromium worker 전역에서 성립하지 않았다). 그래서 별도 모듈(`bootstrap-observer-install`, dist에서도 별도 파일)로 두고 `worker.ts`가 `coincident/window/worker`보다 먼저 import한다. 메시지를 소비하지 않는다. `prepare`가 이 기록으로 첫 정적 import 위반을 고정 대기 없이 알아챈다.
_Avoid_: 감시자, 스니퍼

**첫 정적 import 규칙**:
dom-bridge `./worker`는 worker 파일의 첫 정적 import여야 한다. 늦게(다른 모듈의 top-level await 뒤·동적 import) 평가되면 부트스트랩을 놓친다. 위반은 `prepare`의 명시 오류로 드러난다.

**브리지(`bridge()`)**:
worker 쪽 coincident 핸들 `{ proxy, window, native }`. `coincident()`를 worker당 한 번만 부르고 결과를 공유한다. `ffi`는 CSP 때문에 노출하지 않는다.
_Avoid_: 프록시(`proxy`는 main이 등록한 함수 모음의 필드 이름이다)

**`native`**:
동기 DOM 호출이 되는 환경인가(growable SharedArrayBuffer). 옵션이 아니라 coincident 모듈 평가 시점에 고정되는 탐지 결과다(TRP-066). `false`이면 동기 DOM 코드가 오류 없이 무효가 되므로(TRP-065) 플러그인이 명시 오류로 조기 실패한다.

**`isDomBridgeSupported()`**:
main에서 worker를 만들기 전에 부르는 판정. `crossOriginIsolated === true`이고 growable SharedArrayBuffer 생성이 성공해야 참이다. UA를 판별하지 않는다.

**`runo.browser`**:
플러그인이 Python에 등록하는 JS 모듈(`registerJsModule("runo", { browser: { window, document } })`). `window`와 `document`만 있다.
_Avoid_: `js` 모듈(`import js`는 쓰지 않는다)

**guarded window(`guardedWindow`)**:
`parent`·`top`·`opener`를 읽으면 명시 오류를 던지는 얕은 `window` 프록시. 우회(`window.frames`·`document.defaultView.parent`)는 막지 않는다. 보안 경계가 아니라 실수 방지다. 감싸는 `Proxy`의 target은 원격 창 프록시가 아니라 빈 일반 객체이고 모든 연산을 원격에 위임한다(원격 창 프록시를 target으로 삼으면 Python이 비설정 속성 `window.document`를 읽을 때 `getOwnPropertyDescriptor` 불변식 오류가 난다).

**동기 호출 중 중단**:
coincident 동기 호출 동안 worker가 대기하므로 `interrupt()`는 호출이 반환된 뒤 다음 줄에서 `KeyboardInterrupt`(결과 `interrupted`)로 나타난다(결말이 호출 길이에 종속). 즉시 끝내는 경로는 `stop()`(worker 재생성, Python 상태 유실)뿐이다. `reflected_ffi_timeout`은 완화책이 아니다(`TRP-067`).

**도착 순서 보장 없음**:
출력(core `MessagePort`)과 DOM 호출(coincident 채널) 사이의 main 도착 순서는 보장되지 않는다. e2e S6은 역전 수를 판정 없이 기록한다. "0을 보장한다"고 쓰지 않는다.

**CSP 정적 검사**:
소스·dist의 coincident 모듈 지정자가 `coincident/window/main`·`coincident/window/worker`뿐이고 `evaluate`·`serviceWorker`·`coincident/sync`·`window.import`가 없는지 보는 검사(`scripts/check-dist.mjs --allow-sync-bridge`, `test/csp-static.test.ts`). 다른 패키지는 이 옵션 없이 coincident 문자열 자체를 금지한다.
