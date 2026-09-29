# DOM 브리지(`pyodide-dom-bridge`)

> RD-023로 추가한 절이다.
>
> - 이름·옵션·오류 문구는 `packages/pyodide-dom-bridge/src/`의 export와 일치해야 한다.
> - `apps/demo`의 `?view=dom-bridge`와 `e2e:dom-bridge`가 브라우저에서 확인한다.
> - 결정 배경: [ADR-0006](../adr/0006-pyodide-core-and-plugin-packages.md) "갱신(RD-023)".
> - 착수 조건 스파이크는 Chromium 한정이다(16.11).

## 16.1 구성과 패키지 배치

`@cp949/runo-pyodide-dom-bridge`(`packages/pyodide-dom-bridge`, private, 버전 동기)는 worker의 Python이 main 페이지의 `window`·`document`를 동기 프록시로 쓰게 한다(`from runo.browser import document`).

- 이력: upstream [coincident](https://github.com/WebReflection/coincident) `4.1.1`과 `reflected-ffi` `0.7.2`를 그대로 쓰다가, 2026-09-28에 TypeScript 포크로 대체했다.
- 현재: `@cp949/runo-coincident`(`0.1.0`)·`@cp949/runo-reflected-ffi`(`0.1.1`).
- 고정: 각각 `file:/work/cp949/runo/runo-coincident/packages/coincident`·`file:/work/cp949/runo/runo-reflected-ffi/packages/reflected-ffi`로 `dependencies`에 둔다.
  - 로컬 경로라 semver 정확 버전 대조가 아니라 경로 고정이다.
- 표기: 이 문서는 모듈 지정자를 `coincident/window/worker`처럼 옛 이름으로 줄여 쓴다. 실제 지정자는 `@cp949/runo-coincident/window/worker`다.
- **coincident 계열에 의존하는 저장소 유일의 패키지**다.
  - core·terminal·repl·react는 coincident 계열에 의존하지 않는다.
  - 시험·`check-dist`·`smoke:pack`이 이를 강제한다(16.12).

| 층                       | 위치                                                             | 역할                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| main 진입점 `.`          | `src/index.ts`                                                   | coincident `Worker`를 만든다(`createBridgeMain`). worker를 만들기 전에 쓸 수 있는 페이지인지 판정한다(`isDomBridgeSupported`) |
| worker 진입점 `./worker` | `src/worker.ts`                                                  | `runWorker({ plugins })`에 넘기는 플러그인(`domBridge`)과 coincident 핸들(`bridge`)                                           |
| 플러그인 본체            | `src/dom-bridge-plugin.ts`                                       | `prepare`: 부트스트랩 수신 확인 → `bridge()` → `native` 확인 → `runo` 모듈 등록                                               |
| 부트스트랩 관찰기        | `src/bootstrap-observer.ts`, `src/bootstrap-observer-install.ts` | coincident 부트스트랩 메시지 도착 기록(16.5). dist에서도 별도 진입점 파일이다                                                 |
| guarded window           | `src/guarded-window.ts`                                          | `parent`·`top`·`opener` 접근을 막는 얕은 `window` 프록시(16.6)                                                                |
| worker 브리지 타입       | `src/worker-bridge.ts`                                           | `WorkerBridge` 인터페이스                                                                                                     |
| coincident 타입          | —                                                                | `@cp949/runo-coincident/window/{main,worker}`가 자체 타입을 배포한다. 손으로 쓴 선언 파일은 두지 않는다                       |

core는 `WorkerPlugin` 타입만 쓴다. 런타임 import는 없다. `peerDependencies`(+`devDependencies`)다.

- 소비자가 core를 한 벌만 설치한다.
- `pyodide`는 core의 optional peer로 전이된다. 이 패키지는 `devDependencies`(시험)로만 둔다.
- tarball의 peer 범위는 `workspace:*`가 정확 버전으로 치환된다(버전 동기 전제).

`sideEffects`는 이 패키지만 배열이다. 다른 패키지는 `false`다.

- 현재 배열: `["./dist/worker.mjs", "./dist/bootstrap-observer-install*.mjs", "./src/worker.ts", "./src/bootstrap-observer-install.ts"]`.
- `false`이면 `import "…/worker"`처럼 부수효과만 쓰는 import가 번들에서 통째로 지워진다. 부트스트랩 리스너가 빠진다.
- 관찰기 청크는 파일 이름에 해시가 붙는다. 글로브(`bootstrap-observer-install*.mjs`)가 필요하다.
- 글로브를 빼면 산출물에 관찰기가 0이 된다.
- 측정 조건: 스크래치 Vite 프로덕션 빌드(lib, dist 소비)로 부수효과 전용 진입점 산출물을 쟀다(RD-023).
  - 배열: 관찰기 1개와 coincident 부트스트랩 리스너 2개가 남는다. 관찰기가 앞이다.
  - `sideEffects: false`: 산출물이 비어 남는 것이 없다.
- 배열 전체(글로브 포함)를 고정하는 것은 `test/package-boundary.test.ts`뿐이다.
- `smoke:pack`은 tarball의 `sideEffects`가 배열이고 `./dist/worker.mjs`를 포함하는지만 본다(`scripts/pack-smoke/manifest.mjs` `MANIFEST_POLICY`).

## 16.2 공개 API

내부 계약이고 공개 API로 확정하지 않았다. 이름은 `src/index.ts`·`src/worker.ts`의 export와 같다.

| 진입점                                  | export                 | 시그니처·내용                                                                                                                                                                       |
| --------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cp949/runo-pyodide-dom-bridge`        | `createBridgeMain`     | `(): BridgeMain` = `{ Worker, native }`. coincident main(`coincidentMain()`)을 옵션 없이 한 번만 부르고 결과를 공유한다. `Worker` 생성자의 옵션 처리는 표 아래 "옵션 통과"를 따른다 |
|                                         | `isDomBridgeSupported` | `(): boolean`. `detectRuntimeSupport() === "supported"`(판정 규칙: `14-runner.md` 14.3.1)이고 growable `SharedArrayBuffer` 생성이 성공하면 참. UA를 판별하지 않는다                 |
|                                         | 타입                   | `BridgeMain`·`BridgeMainWorker`(`Worker` + `proxy: Record<string, unknown>`)                                                                                                        |
| `@cp949/runo-pyodide-dom-bridge/worker` | `domBridge`            | `(): WorkerPlugin`. `name: "dom-bridge"`                                                                                                                                            |
|                                         | `bridge`               | `(): Promise<WorkerBridge>` = `{ proxy, window, native }`. `coincident()`를 worker당 한 번만 부르고 결과를 공유한다(메모이즈, reject도 공유). `ffi`는 노출하지 않는다               |
|                                         | 타입                   | `WorkerBridge`                                                                                                                                                                      |

옵션 통과:

- 돌려준 `Worker` 생성자의 두 번째 인자는 런타임에 coincident로 그대로 간다.
- `serviceWorker`·`import`·`reflected_ffi_timeout`도 걸러내지 않는다.
- 타입이 표준 `WorkerOptions`로 좁혀 TS 초과 속성 검사가 1차로 막을 뿐이다. 런타임 차단은 없다.

main 도우미는 Worker를 대신 만들어 주지 않는다.

- Vite가 worker를 번들하려면 소비자가 `new Worker(new URL(리터럴, import.meta.url), { type: "module" })`를 직접 써야 한다.
- 생성자의 지역 이름이 `Worker`여야 Vite가 알아본다.

```ts
import {
  createBridgeMain,
  isDomBridgeSupported,
} from "@cp949/runo-pyodide-dom-bridge";

if (!isDomBridgeSupported()) {
  // worker를 만들기 전에 거른다(이유 표시). 만들면 세션이 load-failed가 된다(16.7).
}
const { Worker } = createBridgeMain(); // 이름을 Worker로 받는다(Vite의 worker 인식)
const createWorker = () =>
  new Worker(new URL("./app.worker.ts", import.meta.url), { type: "module" });
```

`createWorker`는 `<PythonRunner createWorker={…}>`·core `createRunner({ createWorker })`에 그대로 넘긴다.

- 세션(재시작 포함)마다 `Worker`를 새로 만든다.
- coincident `Worker` 생성자가 그 안에서 동기로 부트스트랩 메시지를 `postMessage`한다.
- core init 프레임은 `createWorker()`가 반환된 뒤 `postInitFrame`으로 보낸다.
- 따라서 부트스트랩이 init 프레임보다 항상 먼저 도착한다.

## 16.3 worker 파일 조립과 첫 정적 import 규칙

```ts
// app.worker.ts
import { domBridge } from "@cp949/runo-pyodide-dom-bridge/worker"; // 첫 정적 import
import { runDriver, runWorker } from "@cp949/runo-pyodide-core/worker"; // 그 다음, top-level await가 있는 모듈의 import보다 앞
runWorker({ driver: runDriver, plugins: [domBridge()] });
```

- **dom-bridge `./worker`가 worker 파일의 첫 정적 import여야 한다.**
  - coincident는 `coincident/window/worker`가 평가될 때 부트스트랩 리스너를 `{ once: true }`로 한 번만 건다.
  - 이 모듈이 늦게 평가되면 이미 도착한 부트스트랩을 놓친다. 다른 모듈의 top-level await 뒤이거나 동적 `import()`인 경우다.
  - 놓치면 `coincident()`가 영원히 대기한다.
  - 위반은 `prepare`가 명시 오류로 알린다(16.5).
- **`core/worker`는 top-level await가 있는 모듈의 import보다 앞선 정적 import여야 한다(dom-bridge `./worker` 다음).**
  - 이 순서를 지키면 `runWorker` 호출 시점(파일 안의 `await` 뒤 등)은 자유다.
  - core `./worker`가 모듈 평가 시점에 init 프레임을 버퍼링한다. `runWorker`를 늦게 불러도 버퍼에서 부팅한다.
  - top-level await 모듈을 core `./worker`보다 먼저 import하면 Vite 번들에서 수신기 등록 문장이 그 `await` 뒤로 밀린다.
  - 번들 순서는 확인했다. 그 사이 init 유실은 추정이고 브라우저 미실측이다(`01-protocols.md` 4절).
  - 브라우저 확인: `?mode=late-run`(init 프레임이 도착한 뒤 `runWorker`를 부르는 worker)이 `ready`가 된다.
  - "모듈 본문에서 동기로 부른다"를 규칙으로 요구하지 않는다.
- 첫 import는 `import "…/worker"` 부수효과 전용 형태여도 된다. `sideEffects` 배열(16.1)이 전제다.
  - 소비자 번들러 설정이 이 패키지의 `sideEffects`를 무시하거나 `false`로 덮으면 부수효과 전용 import가 지워진다. 관찰기와 부트스트랩 리스너가 빠질 수 있다.
  - 측정한 것은 이 패키지 자신이 `sideEffects: false`일 때다.
- coincident는 평가될 때 전역 `EventTarget.prototype.addEventListener`를 패치한다.
  - 전역 패치 뒤에도 core 채널은 정상이다. `MessagePort` `{ once }`·`onmessage`·`AbortSignal` `{ once }` 리스너를 확인했다(`e2e:dom-bridge` S7).
  - REPL·실행창 같은 다른 화면이 패치를 받지 않게 한다.
  - demo는 dom-bridge 화면만 그 모듈을 평가하도록 `React.lazy`로 지연 import한다(`App.tsx`).
- Vite dev는 worker에서만 import되는 bare 모듈(`coincident/window/worker`)을 브라우저가 처음 요청할 때 발견한다.
  - "의존성 최적화 → 전체 다시 불러오기"가 일어난다(`docs/traps/TRP-072`).
  - demo는 `vite.config.ts`의 `optimizeDeps.entries`에 `src/*.worker.ts`를 두어 서버 시작 때 미리 최적화한다.
  - 소비자도 같은 설정이 필요할 수 있다.

## 16.4 core `plugins` 계약

```ts
// '@cp949/runo-pyodide-core/worker'
interface WorkerPlugin {
  name: string;
  prepare(context: { pyodide: PyodideInterface }): void | Promise<void>;
}
function runWorker(options: {
  driver: WorkerDriver;
  plugins?: readonly WorkerPlugin[];
}): void;
```

순서:

- `bootWorker`가 `loadPyodide`와 interrupt 공개 API 확인(`findMissingInterruptApi`) 뒤, `driver.createConsole` 앞에서 `plugins` 배열 순서대로 **하나씩 await**한다.
- 앞 `prepare`의 Promise가 풀리기 전에 다음이 불리지 않는다.
- 이 시점에는 `attachRuntime`(`03-ctrl-c.md` 2.6) 전이다. 정리할 부분 설치가 없다.
- `plugins`가 없거나 `[]`이면 부팅 순서·결과가 이전과 같다.

실패:

- `prepare`가 던지거나 reject하면 `bootWorker`가 `plugin "<name>": <원인>` 문구의 `Error`로 감싸 `loadFailed`로 알린다.
  - 원인은 `cause` 속성에 담는다. Error 생성자의 `{ cause }` 옵션은 Chrome 93+라 빌드 floor(ADR-0008)를 넘어 쓰지 않는다.
  - 원인이 `Error`가 아니면(`reject("문자열")`) `String(value)`를 쓴다.
- 페이로드는 다른 모든 `loadFailed`처럼 `String(error)`다. **`Error: plugin "<name>": <원인>`**이다(`Error: ` 접두 포함).
- 앞 플러그인이 실패하면 뒤 플러그인은 부르지 않는다. `createConsole`도 불리지 않는다.
- main은 `onLoadFailed(message)`로 같은 문자열을 받는다(`createRunner`의 상태는 `load-failed`).

기타 규칙:

- 훅은 `prepare` 하나뿐이다. 해제 훅은 없다. worker는 terminate로 끝난다.
- 문구를 시험할 때 `startsWith('plugin "<name>": ')`은 항상 거짓이다. `Error: ` 접두를 포함하거나 `toContain`에 원인 문구를 더해 단정한다.
- `runWorker`는 worker당 한 번만 부를 수 있다.
  - 두 번째 호출은 `runWorker는 worker당 한 번만 부를 수 있다`를 던진다.
  - 이전에는 같은 프레임으로 부팅이 두 번 일어났다.
- REPL의 `runReplWorker()`는 인자가 없는 래퍼다. `plugins`를 받지 않는다(16.11).

## 16.5 부트스트랩 관찰기

worker의 `prepare`는 부트스트랩이 도착했는지 알아야 한다. 그래야 첫 정적 import 위반을 고정 대기 없이 명시 오류로 만들 수 있다.

- 부트스트랩 메시지: 배열 `[UID, serviceWorker, ffi_timeout]` + 포트 1개.
- core init 프레임(`kind: "init"` 객체)과 다른 메시지다.
- coincident의 리스너가 `stopImmediatePropagation()`으로 메시지를 삼킨다.
- 관찰 리스너는 **coincident 리스너보다 먼저 등록**돼야 한다.

관찰기 설치는 별도 모듈(`bootstrap-observer-install`)이다. `src/worker.ts`가 `coincident/window/worker`보다 먼저 import한다.

- 모듈이 평가될 때(worker 전역일 때만) `message` 리스너를 건다.
- 배열 메시지가 왔는지만 기록하고 소비하지 않는다.
- `prepare` 시점에는 init 프레임이 이미 도착해 있다(부트스트랩이 항상 먼저).
- 기록이 없으면 원인은 둘 중 하나다.
  - 첫 정적 import 위반.
  - main이 `createBridgeMain()`이 돌려준 `Worker`가 아니라 전역 `Worker`로 worker를 만들어 부트스트랩이 아예 오지 않았다.
- 문구: `coincident 부트스트랩 메시지를 받지 못했다. 가능한 원인은 둘이다. ① dom-bridge ./worker가 worker 파일의 첫 정적 import가 아니다: … ② main이 createBridgeMain()이 돌려준 Worker가 아니라 전역 Worker로 worker를 만들었다: …`
- 이때 `bridge()`는 부르지 않는다. 부르면 영원히 대기한다.

**캡처 옵션은 쓰지 않는다.**

- 처음 설계는 캡처 단계 리스너였다. DOM 표준상 같은 대상에서 캡처 리스너가 먼저 호출된다.
- 이 설계는 jsdom에서만 성립했다. Chromium worker 전역에서는 성립하지 않았다.
- 대상 자신(`eventPhase=2`)에서 캡처·비캡처 구분 없이 **등록 순서**로 호출됐다.
- 성립 조건은 등록 순서다.
- jsdom 시험은 그 순서(가짜 대상·평가 순서)만 고정한다.
- worker 전역에서의 성립은 `e2e:dom-bridge` S1이 확인한다.

dist 순서:

- 번들러가 외부 import(`coincident/window/worker`)를 파일 맨 위로 올리면 순서가 뒤집힌다.
- 그래서 관찰기 모듈은 dist에서도 별도 진입점 파일로 남는다(`tsdown.config.ts`의 `entry`).
- `scripts/check-dist.mjs --allow-sync-bridge`가 검사한다.
  - `dist/worker.mjs`가 `import … from "./bootstrap-observer-install-<해시>.mjs"`를 `coincident/window/worker` import보다 앞에 두는지 본다.
- `sideEffects` 글로브가 해시 청크까지 덮어야 한다. 그래야 부수효과 전용 import에서 관찰기가 사라지지 않는다.
- 이 순서 검사가 없으면 소스 순서가 맞아도 번들 결과가 틀릴 수 있다.
- demo 프로덕션 빌드의 worker 청크에서도 관찰기가 coincident보다 앞임을 정적으로 확인했다.

## 16.6 `runo.browser`와 guarded window

`prepare`의 마지막 단계가 `pyodide.registerJsModule("runo", { browser: { window: guardedWindow(window), document: window.document } })`를 부른다.

- `runo.browser`에는 **`window`와 `document`만** 있다.
- `canvas` 같은 앱 고유 이름과 확장 옵션은 없다.
- `import js`는 쓰지 않는다.

```python
from runo.browser import document, window
document.title = "완료"
ctx = document.getElementById("c").getContext("2d")
```

`guardedWindow`는 `window.parent`·`window.top`·`window.opener`를 읽으면 `runo.browser: window.<이름> 접근은 막혀 있다`를 던진다. Python에는 예외 메시지로 전달된다.

- **얕은 차단이다.** `window.frames`·`window.self.parent`·`document.defaultView.parent` 같은 우회는 막지 않는다.
- 보안 경계가 아니다. iframe 안 실행에서 상위 문서로 올라가는 가장 흔한 길을 실수로 열지 않기 위한 장치다.
- 경계는 iframe `sandbox`·origin 분리가 맡는다.

**원격 창 프록시를 JS `Proxy`로 직접 감싸면 비설정 속성 접근이 실패한다.**

- reflected-ffi의 원격 창 프록시는 자기 target이 비어 있다. 그런데도 `getOwnPropertyDescriptor`가 실제 창의 설명자를 돌려준다.
- 실제 `window.document`·`location`은 비설정(non-configurable) own 속성이다.
- 원격 프록시를 target으로 삼은 `get` 전용 `Proxy`에서 Python이 `window.document`를 읽으면 실패한다.
  - 오류: `TypeError: 'getOwnPropertyDescriptor' on proxy: trap reported non-configurability for property 'document' …`.
- 가드 없는 원격 창은 같은 접근이 통과했다(Chromium 프로브).

그래서 `guardedWindow`는 target을 **빈 일반 객체**로 둔다.

- 모든 연산(`get`·`set`·`has`·`deleteProperty`·`ownKeys`·`getPrototypeOf`)을 원격에 직접 위임한다.
- 설명자는 원격에 묻지 않는다. 값에서 만든 설정 가능한 데이터 설명자로 돌려준다.
- 차단 대상 처리:
  - `get`: 명시 오류.
  - 설명자 요청: `undefined`.
  - 나열(`ownKeys`): 제외.
- `get`은 receiver를 넘기지 않는다. 접근자의 `this`가 원본이 된다.

알려진 차이: 나열(`dir(window)`) 길이가 가드 없는 창보다 3개 적다. 차단 3개가 빠진다(프로브 기준 1289 → 1286).

시험:

- L0(jsdom·가짜 창)는 평범한 객체를 target으로 써서 이 결함을 놓친다. 실제 원격 프록시의 동작은 브라우저에서만 나온다.
- 그래서 시험을 둘로 나눈다.
  - "빈 target 프록시 + 비설정 속성 설명자" 대역: `guarded-window.test.ts`.
  - `e2e:dom-bridge` S2 guarded 셀.

`bridge()`가 돌려주는 `window`는 가드 없는 원격 창이다.

- 앱이 그 값을 Python에 그대로 등록하면 guard를 우회한다.
- demo의 시험 worker `dom-bridge-slow.worker.ts`가 원인 분리용 대조로 그렇게 한다.
- guard가 필요한 앱은 `runo.browser`만 쓴다.

## 16.7 `native: false`

`native`는 coincident 옵션이 아니다.

- `@webreflection/utils`가 모듈 평가 시점에 정하는 탐지 결과다.
- 조건은 `new SharedArrayBuffer(4, { maxByteLength: 8 })`의 성공 여부다(`docs/traps/TRP-066`).

`false`(growable `SharedArrayBuffer` 불가, 서비스워커 없음)이면 DOM 프록시 동기식 코드가 예외 없이 무효가 된다. 오류가 뒤 줄에서 다른 모양으로 나온다(`docs/traps/TRP-065`).

방침: **`native === false`이면 `prepare`가 명시 오류로 조기 실패한다.** 세션은 `load-failed`가 된다. 새 상태는 만들지 않는다.

- 문구: `동기 DOM 브리지(native)를 쓸 수 없다. growable SharedArrayBuffer가 필요하다(cross-origin isolation: COOP same-origin·COEP require-corp, 지원 브라우저). 서비스워커 경로는 지원하지 않는다. …`
- 이때 `runo` 모듈은 등록하지 않는다.
- 서비스워커(sabayon) 경로와 `await` 전용 API는 만들지 않는다(`docs/history/first-roadmap.md` "보류" 절).

소비자는 worker를 만들기 전에 `isDomBridgeSupported()`로 거를 수 있다.

- UA를 판별하지 않는다. 기능 탐지(`detectRuntimeSupport()`·growable `SharedArrayBuffer`)만 쓴다.
- 미검증 브라우저도 막지 않는다.

시험 훅 `?native=0`(demo): main·worker **양쪽 realm**에서 growable 생성만 던지는 `SharedArrayBuffer` Proxy를 coincident import보다 먼저 적용한다.

- 고정 길이 생성은 통과해야 한다. 그래야 core의 interrupt buffer·메일박스가 동작한다.
- 한쪽만 바꾸면 양쪽 `native`가 갈린다.
- N0a: `&native=0`에서 main의 `native`·`isDomBridgeSupported()`가 `false`이고 worker를 만들지 않는다.
- N0b: `&native=0&gate=off`에서 worker가 만들어져 `load-failed`와 명시 문구가 나온다.

## 16.8 동기 호출 중 중단(S5)

coincident 동기 호출 동안 worker는 `Atomics.pause` 바쁜 루프처럼 대기한다. 그 사이 `interrupt()`(Ctrl+C)는 worker의 Python에 닿지 않는다.

`interrupt()`의 결말은 **호출이 반환된 뒤**다.

- 호출이 끝난 다음 줄에서 `KeyboardInterrupt`(결과 `interrupted`)가 나온다.
- 결말이 호출 길이에 종속된다.
- 스파이크(호출 8초, 500ms 뒤 `interrupt()`, N=10 × 4조합): 40/40회 결말이 호출 반환 뒤였다. 중단 요청에서 결말까지 중앙 7501.2~7503.7ms였다.
- 저장소 시험 `e2e:dom-bridge`의 S5가 이 동작을 고정한다.
  - main 쪽 Promise 핸들러 `proxy.slow(2000)`을 Python에 노출하는 시험 플러그인(`runo_test.slow`)을 쓴다.
  - 판정: 중단 요청이 `slowStart`와 `slowDone` 사이이고, 결말이 `slowDone` 뒤이며, 중단 줄이 호출 줄의 다음 줄이다.
- 제품 동작은 바꾸지 않았다. 에스컬레이션·호출 길이 상한은 범위 밖이다.

`reflected_ffi_timeout` 옵션은 완화책이 아니다.

- 원격 값 캐시 수명이지 호출 대기 상한이 아니다(`docs/traps/TRP-067`).
- 옵션 유무와 무관하게 결말은 호출 반환 뒤였다.

**즉시 끝내는 경로는 `stop()`뿐이다.** worker를 terminate하고 다시 만든다. Python 상태(변수·import)를 잃는다.

- 스파이크: 결말 중앙 약 1.0초, 새 `ready` 약 1.8초, 20/20 `restarted`.
- 저장소 시험 판정:
  - `slow(8000)` 도중 `stop()` → `restarted`.
  - 상태 `restarting` → 새 `ready`.
  - 새 worker의 DOM 호출 정상.
  - 옛 slow가 끝난 뒤 pageerror 0.

호출 길이(추정, 측정하지 않았다):

- `window`·`document` 접근·호출은 main이 처리하는 시간만큼만 걸린다. 그래서 main이 바쁠 때만 길어진다고 추정한다.
- main이 유휴이면 호출이 짧아 `interrupt()` 지연이 눈에 띄지 않을 것이다.
- S5 시험이 호출을 길게 만든 것은 main 쪽 Promise 핸들러를 쓴 인위적 조건이다.

## 16.9 출력·DOM 도착 순서 보장 없음

- 출력(`print(..., flush=True)`): core `MessagePort` RPC 알림.
- DOM 효과: coincident 동기 호출 채널.
- **두 채널 사이의 도착 순서는 보장되지 않는다.**
- 소비자는 "화면 출력이 나온 뒤에 DOM이 바뀐다" 같은 순서에 의존하면 안 된다.
- 어떤 조건에서 역전이 0이었어도 보장으로 읽지 않는다.

`e2e:dom-bridge` S6은 경로 두 개와 DOM 효과 방식 세 개별로 5회 × 20쌍을 잰다.

- 경로:
  - core `createRunner` 직접.
  - `<PythonRunner>` + terminal.
- 방식:
  - C: `document.title` 대입 + `MutationObserver`.
  - Ag: guarded `window`로 main 함수 호출.
  - Ar: 가드 없는 창으로 호출.
- **역전 수(DOM 효과가 출력보다 먼저 main에 도착한 쌍)를 판정 없이 기록**한다.
- 필수: 기록 누락 0·모든 실행 `ok`·방식 세 개·쌍 수 충족.

실측(100쌍당 역전 수, 실행마다 변동한다):

| 경로                        | C(title 대입) | Ag  | Ar  |
| --------------------------- | ------------- | --- | --- |
| core `createRunner` 직접    | 0~5           | 0   | 0   |
| `<PythonRunner>` + terminal | 60~90         | 0   | 0   |

- 스파이크(core 직접, `native: true`)의 0/500은 가드 없는 창의 함수 호출(`browser.window.spikeMark`) 방식으로 잰 값이다(RD-023 스파이크 결과 E4).
  - 같은 함수 호출 방식인 Ag·Ar은 core 직접 0/100이다. 스파이크와 어긋나지 않는다.
  - core 직접 C의 0~5/100은 스파이크가 재지 않은 방식(title 대입 + `MutationObserver`)의 값이다. 스파이크 0/500과 직접 비교할 수 없다.
- 원인 미확인:
  - core 직접 경로에서 C의 0~5/100 변동.
  - view 경로에서 C만 역전이 큰 이유. 가설: terminal 출력 렌더 지연. 검증하지 않았다.
- Ag·Ar은 두 경로 모두 0이었다.
- 재측정과 원인 조사는 보류한다. 재개 조건은 순서에 의존하는 소비자 요구가 생길 때다.

## 16.10 재시작과 옛 worker

Chromium은 terminate 요청 뒤 유휴가 아닌 worker를 약 2초 늦게 끝낸다(`docs/traps/TRP-049`).

- 유휴가 아닌 worker: `input()` 대기·`time.sleep`·실행 중·동기 호출 중.
- 재시작(`stop()` 폴백·`reset()`·크래시 복구) 직후 약 2초 동안 옛 worker와 새 worker가 동시에 존재한다.
- coincident 동기 호출 중 terminate도 같은 규모(약 1.9초)다. core 단독에서도 재현된다.
- dom-bridge가 지연을 늘렸다는 증거는 없다.
- 사라진 worker의 재등장은 0회였다. 누적은 없다(스파이크 20회 반복 뒤 최종 1개).

dom-bridge가 재사용하는 배타 자원은 없다.

- coincident `Worker`는 인스턴스마다 자기 `MessageChannel`과 `proxy`를 만든다(coincident `src/main.ts` 읽기로 확인).
- core도 세션마다 새 `MessageChannel`·interrupt buffer를 만든다(`14-runner.md` 14.3.5).
- 옛 worker의 동기 호출에 대한 main 응답이 종료된 worker에 닿아도 pageerror·콘솔 오류는 없었다(`e2e:dom-bridge` S5 stop 셀).

worker 수를 세는 시험은 고정 대기가 아니라 옛 targetId가 사라질 때까지 조건 대기로 판정한다(`09-testing.md` 9.7).

## 16.11 비지원과 검증 범위

- **REPL + dom-bridge는 지원하지 않는다.**
  - REPL은 프롬프트 대기 중 main→worker 요청(Tab 완성)이 필요하다.
  - coincident 동기 대기가 그것을 막는다(ADR-0006, ADR-0001).
  - `runReplWorker()`는 `plugins`를 받지 않는다.
  - 문서화만 하고 코드로 막지는 않는다.
- **Chromium에서만 검증했다.** 엔진 범위 결정은 [ADR-0008](../adr/0008-chrome84-build-floor-and-pyodide-runtime-floor.md)이다. Firefox·Safari는 검증하지 않았다.
  - coincident가 Firefox에서 worker 전역 `postMessage` 우회 경로를 쓴다. S1·S6 경로가 달라질 수 있다.
  - `native`는 기능 탐지로만 판정한다. UA는 판별하지 않는다.
  - Firefox 공존 실측은 착수 조건이 아니다. `docs/history/first-roadmap.md` "보류" 절 항목이다.
- 서비스워커(sabayon) 경로는 측정하지 않았다(`docs/history/first-roadmap.md` "보류" 절). `native: false`는 16.7의 명시 오류다.
- CSP 헤더를 실제로 건 브라우저 실측은 하지 않았다.
  - `worker-src 'self'`에서 위반 0건은 canvas 저장소의 실측(F23)이다. 이 저장소에서 재확인하지 않았다.
  - 이 저장소가 하는 것은 16.12의 정적 검사다.
- 재생성 20회 누수·S5 N=10 반복은 스파이크 결과의 인용이다. 저장소에서 다시 재지 않았다.
- 통과 셀의 반복 안정성은 전체 재실행으로만 봤다. 기록은 `apps/demo/e2e/BASELINE.md`다.

## 16.12 CSP 금지 목록과 경계 검사

CSP(`worker-src 'self'` 등)에서 위반을 내지 않는 coincident 진입점만 쓴다: `coincident/window/main`·`coincident/window/worker`.

- 금지: `coincident/sync`, `serviceWorker` 옵션, `ffi.evaluate`(`evaluate`), blob `sync.js`, `window.import`.
- `bridge()`가 `ffi`를 노출하지 않는 이유도 같다.

| 검사                    | 대상                                                | 위치                                                                                                       |
| ----------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| CSP 정적 검사(소스)     | `packages/pyodide-dom-bridge/src` 코드 파일         | `test/csp-static.test.ts`가 `scripts/check-dist.mjs --allow-sync-bridge`를 자식 프로세스로 실행            |
| CSP 정적 검사(dist)     | `packages/pyodide-dom-bridge/dist`                  | 패키지 `check-dist` 스크립트(`--allow-sync-bridge`), 루트 `pnpm test`의 `check-dist`                       |
| 규칙 자체               | 합성 파일                                           | `packages/pyodide-testkit/test/check-dist-script.test.ts`                                                  |
| 다른 패키지의 금지 유지 | core·terminal·repl·react 의존 트리·dist·소비자 트리 | 각 `package-boundary.test.ts`, 옵션 없는 `check-dist`, `pnpm smoke:pack` 주 소비자(dom-bridge를 뺀 패키지) |
| dom-bridge 자기 검사    | 의존 이름·`file:` 고정 값·`sideEffects`·core는 peer | `test/package-boundary.test.ts`, `pnpm smoke:pack` dom-bridge 소비자                                       |

규칙(`--allow-sync-bridge`): 코드 파일에서 주석을 지운 뒤 아래를 검사한다.

- 코드 파일: `.mjs`·`.cjs`·`.js`·`.jsx`·`.mts`·`.cts`·`.ts`·`.tsx`. `.d.mts`·`.d.ts`를 포함한다. 시험·소스맵은 제외한다.
- (a) coincident·reflected-ffi 모듈 지정자가 위 두 개 밖이면 위반이다. 직접 `reflected-ffi` import도 위반이다.
- (b) `evaluate`·`serviceWorker`·`coincident/sync`·`window.import`·멤버 `.import(`가 있으면 위반이다.
- (c) `coincident/window/worker`를 import하는 `.mjs`는 그보다 앞서 `bootstrap-observer-install`을 import해야 한다(16.5).

세부:

- 모듈 지정자는 따옴표 문자열과 `${`가 없는 템플릿 리터럴(``import(`x`)``·``require(`x`)``)을 인식한다.
  - `${`가 있으면 런타임 경로라 지정자로 보지 않는다.
- 주석 제거는 블록 주석과 줄 주석을 한 정규식의 대안으로 앞에서부터 지운다.
  - 줄 주석 속 `/*`가 다음 `*/`까지 실제 코드를 지우지 않는다.
- 코드도 소스맵도 아닌 파일(`.html`·`.json` 등)은 허용 모드에서도 coincident 금지 문자열 검사를 받는다.
  - CSP 규칙은 코드 문법만 보므로 건너뛰면 아무 검사도 받지 않는다.
- `--allow-sync-bridge`가 다른 패키지의 `check-dist` 스크립트에 없음은 dom-bridge `test/package-boundary.test.ts`가 고정한다.
- `pyodide` 런타임 import 금지는 옵션에서도 유지한다.
- 넓은 토큰(`evaluate`)은 이 패키지 전용이다. 거짓 위반이 나면 소스 표현을 바꾼다.
- 한계: 주석 제거가 정규식이라 코드의 문자열 리터럴 속 `/*`·` //`를 파싱하지 않는다.
  - 현재 소스·dist에서 오판은 재현되지 않았다.
  - 변이 검사는 killed다.
  - 추적하는 이슈는 없다.

## 16.13 데모와 검증

`?view=dom-bridge`(`DomBridgeView.tsx`): `<PythonRunner createWorker={createDomBridgeWorker}>` + `<canvas>` + `RunnerView`와 같은 plain 조작 요소다. 조작 요소는 코드 입력·`run`·`stop`·`reset`·`clear`·상태·결과다.

- `isDomBridgeSupported()`가 false면 worker를 만들지 않고 이유만 표시한다.
- react 패키지 변경 없이 연결된다.
- 기존 `RunnerView`·`ReplView`는 바꾸지 않았다.
- 시험 훅은 쿼리(`native=0`·`gate=off`·`mode=`·`runner=core`)와 시험 전용 worker 파일이다.
  - `dom-bridge.worker.ts`: 기본.
  - `dom-bridge-slow.worker.ts`: S5.
  - `dom-bridge-native0.worker.ts`: `native=0`.
  - `dom-bridge-late.worker.ts`: dom-bridge 늦은 import.
  - `dom-bridge-late-run.worker.ts`: 늦은 `runWorker`.

| 계층 | 위치                                                                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L0   | dom-bridge `test/*.test.ts`: 플러그인·부팅 조합(core `bootWorker`)·관찰기·guarded window·진입점·CSP 정적 검사·패키지 경계. core `worker/init-receiver.test.ts`·`boot-plugins.test.ts`·`run-worker-buffering.test.ts` |
| L0   | `pnpm smoke:pack`: 패키지 tarball, 주 소비자 + dom-bridge 소비자, exports 정적 검사·Vite 해석 검사                                                                                                                   |
| L1   | `pnpm --filter demo e2e:dom-bridge`(`apps/demo/e2e/checks/dom-bridge-check.mjs`, 판정 함수 `apps/demo/e2e/dom-bridge-judge.mjs`+`.test.mjs`, dev 전용). `ONLY=S5`·`S6`·`N0`·`LATE`·`RUNLATE`로 줄여 돌 수 있다       |

`e2e:dom-bridge` 셀:

- 초기: 격리·`native` true.
- S1: `ready`·`print(1+1)`·worker 1개.
- S2: `document.title`·canvas 픽셀·guarded `window`의 `document` 읽기와 `parent` 차단.
- S3: `input()` 전달 `hello 한글`·취소 2종·재입력.
- S4: `while True`·`time.sleep` Ctrl+C·이후 실행.
- S5: 16.8.
- S6: 16.9.
- S7: 전역 패치 뒤 core 채널.
- N0a·N0b: 16.7.
- LATE: dom-bridge를 `prepare` 안에서 동적 import → `load-failed`와 첫 정적 import 문구.
- RUNLATE: 늦은 `runWorker` → `ready`.
- 끝: 콘솔·pageerror 0.

판정 규칙:

- 시간 판정은 이벤트 열의 앞뒤·결말로 한다. ms 상한은 없다(9.7).
- 결과 기록은 `apps/demo/e2e/BASELINE.md` 해당 행이다.
- 양성 대조: `prepare`의 부트스트랩 검사를 제거하면 LATE가 실패한다. `load-failed`가 오지 않고 `loading`에 머문다.
- 회귀 확인 대상: `runner-check`(normal·not-isolated)·`repl-check`·`session-reset`·`react-strictmode`.
- 원시 결과 로그는 보관하지 않는다. 요약은 `docs/history/first-roadmap.md` RD-023이다.
