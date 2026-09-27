# @cp949/runo-pyodide-dom-bridge

worker의 Python에서 main 페이지의 `window`·`document`를 동기 프록시로 쓰게 하는 플러그인(`from runo.browser import document`). [coincident](https://github.com/WebReflection/coincident) `4.1.1`(upstream 그대로, 포크 없음)과 `reflected-ffi` `0.7.2`를 정확한 버전으로 고정해 쓴다. core(`@cp949/runo-pyodide-core`) 위에 얹히고, `input()`·출력·Ctrl+C는 core 채널로 가며 coincident를 거치지 않는다. **coincident는 이 패키지에만 있다**: core·terminal·repl·react는 coincident에 의존하지 않고 시험·`check-dist`·`smoke:pack`이 이를 강제한다. private이고 공개 API로 확정하지 않은 내부 계약이다. 배포는 `pnpm pack` tarball이다.

규칙 본문은 `docs/design/16-dom-bridge.md`. 검증 범위: Chromium(스파이크 결과 `제한 있는 지원`). Firefox·Safari는 검증하지 않았다. UA를 판별하지 않고 기능 탐지(`native`)로만 판정한다. REPL과 함께 쓰는 조합은 지원하지 않는다(REPL은 프롬프트 대기 중 main→worker 요청이 필요한데 coincident 동기 대기가 이를 막는다, ADR-0006).

## 진입점

| 진입점                                  | 내용                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@cp949/runo-pyodide-dom-bridge`        | `createBridgeMain(): { Worker, native }`, `isDomBridgeSupported(): boolean`, 타입(`BridgeMain`·`BridgeMainWorker`) |
| `@cp949/runo-pyodide-dom-bridge/worker` | `domBridge(): WorkerPlugin`, `bridge(): Promise<{ proxy, window, native }>`, 타입(`WorkerBridge`)                  |

## 사용

worker 파일에서 `./worker`를 **첫 정적 import**로 둔다. coincident는 이 모듈이 평가될 때 부트스트랩 메시지 리스너를 한 번 건다. main이 보낸 부트스트랩은 worker 생성 직후 도착하므로 import가 늦으면(동적 import 포함) 메시지를 놓치고 대기가 끝나지 않는다. 이 경우 `domBridge().prepare`가 명시 오류로 실패해 세션이 `load-failed`가 된다. main이 `createBridgeMain()`의 `Worker`가 아니라 전역 `Worker`로 worker를 만들어도 부트스트랩이 오지 않아 같은 오류가 난다(문구가 두 원인을 함께 알린다).

```ts
// app.worker.ts
import { domBridge } from "@cp949/runo-pyodide-dom-bridge/worker"; // 첫 줄
import { runDriver, runWorker } from "@cp949/runo-pyodide-core/worker";
runWorker({ driver: runDriver, plugins: [domBridge()] });
```

```ts
// main
import {
  createBridgeMain,
  isDomBridgeSupported,
} from "@cp949/runo-pyodide-dom-bridge";

if (!isDomBridgeSupported()) {
  // crossOriginIsolated가 아니거나 growable SharedArrayBuffer를 만들 수 없다. worker를 만들기 전에 거른다.
}
const { Worker } = createBridgeMain(); // 지역 이름을 Worker로 받는다(Vite가 worker 번들로 알아본다)
const createWorker = () =>
  new Worker(new URL("./app.worker.ts", import.meta.url), { type: "module" });
```

```python
from runo.browser import document, window
document.title = "완료"
```

- `runo.browser`에는 `window`(guard 적용)와 `document`만 있다. `window.parent`·`window.top`·`window.opener`를 읽으면 오류다. 얕은 차단이라 `window.frames`·`document.defaultView.parent` 같은 우회는 막지 않는다(보안 경계가 아니라 실수 방지, 경계는 iframe sandbox·origin 분리).
- `native === false`(growable SharedArrayBuffer 불가)이면 `prepare`가 명시 오류로 실패한다. 서비스워커 경로는 지원하지 않는다. `load-failed`의 원인 문구는 `Error: plugin "dom-bridge": <원인>` 형태다.
- 동기 호출 중에는 `interrupt()`(Ctrl+C)가 호출이 반환된 뒤에야 전달된다(호출 길이에 종속). 즉시 끝내려면 `stop()`(worker 재생성, Python 상태 유실).
- 출력(core 채널, 비동기)과 DOM 호출(coincident 채널, 동기)의 도착 순서는 보장하지 않는다. 실측(100쌍당 역전): core 직접 경로 0~5, `<PythonRunner>`+terminal 경로 60~90(`document.title` 대입 방식), 함수 호출 방식은 두 경로 모두 0이고 원인은 확인하지 않았다.
- 재시작 직후 약 2초 동안 옛 worker와 새 worker가 함께 있다(Chromium이 유휴가 아닌 worker의 terminate를 늦춘다, `docs/traps/TRP-049`).
- `bridge()`는 `coincident()`를 worker당 한 번만 부르고 결과를 공유한다. `ffi`(임의 코드 평가 등)는 노출하지 않는다.
- `createBridgeMain()`은 `coincidentMain()`을 옵션 없이 부른다. 돌려준 `Worker`의 두 번째 인자는 런타임에 coincident로 그대로 가므로(`serviceWorker`·`import`·`reflected_ffi_timeout`도 걸러내지 않는다) 표준 `WorkerOptions`(`{ type: "module" }` 등)만 넘긴다. 타입이 `WorkerOptions`로 제한해 TS 초과 속성 검사가 1차로 막을 뿐 런타임 차단은 없다.

## CSP

`worker-src 'self'` 같은 CSP에서 위반이 없는 coincident 진입점만 쓴다: `coincident/window/main`·`coincident/window/worker`. 소스·dist에 `coincident/sync`·서비스워커 옵션·`evaluate`·`window.import`가 없어야 하고, `scripts/check-dist.mjs --allow-sync-bridge`(패키지 `check-dist`)와 `src/csp-static.test.ts`가 검사한다.

## 시험

`pnpm --filter @cp949/runo-pyodide-dom-bridge test`(jsdom·node, 가짜 coincident·가짜 pyodide). coincident·실제 pyodide·브라우저 동작(`from runo.browser import document`, guarded Proxy → Python `JsProxy` 변환, `input()`·Ctrl+C, 첫 import 규칙 위반)은 demo `?view=dom-bridge`와 `pnpm --filter demo e2e:dom-bridge`(Chromium, dev 서버)가 본다.
