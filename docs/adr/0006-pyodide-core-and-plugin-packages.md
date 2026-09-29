# pyodide-core를 한 벌로 두고 REPL·실행창·DOM 브리지·React를 그 위의 패키지로 나눈다

REPL 외에 두 소비자가 생겼다.

1. **실행창**: host(`example.com`)의 monaco에서 작성한 코드를 iframe(`sandbox.example.com`)에서 실행한다. `input()`·Ctrl+C만 받는다.
2. **DOM 실행창**: coincident로 worker에서 main의 DOM을 동기 프록시로 쓴다. canvas 저장소가 예시다.

두 소비자 모두 이 저장소가 RD-002~009에서 확정한 기능이 필요하다.

- `input()`: 메일박스.
- Ctrl+C: interrupt buffer·SIGINT 핸들러·`time.sleep` 조각.

canvas 저장소는 같은 사실을 다시 발견하던 중이었다: `time.sleep`의 interrupt 무시, 20ms 조각, SIGINT 핸들러 누락 시 누수.

모드 플래그로 REPL/실행창을 한 패키지에서 분기하면 이미 큰 `session.ts`·`worker/boot.ts`가 더 커진다.

결정: 패키지를 다음으로 나눈다. 이름은 `@cp949/runo-pyodide-*`이고 전부 이 저장소 `packages/`에 둔다. 버전은 동기다.

| 패키지               | 내용                                                                                                                        | xterm | coincident |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----- | ---------- |
| `xterm-readline`     | 벤더링 줄 편집기(기존)                                                                                                      | O     | X          |
| `pyodide-core`       | 프로토콜(RPC·메일박스·interrupt), worker 커널(로드·출력·stdin·SIGINT·sleep 조각·webloop), 실행 driver, main 세션. UI 비의존 | X     | X          |
| `pyodide-terminal`   | xterm 실행창: `input()` 중에만 한 줄 입력, 그 외 키 무시, Ctrl+C                                                            | O     | X          |
| `pyodide-repl`       | REPL driver + REPL 프런트(기존 패키지 축소, 공개 API 유지)                                                                  | O     | X          |
| `pyodide-dom-bridge` | coincident로 `runo.browser`(window/document) 프록시만                                                                       | X     | O          |
| `pyodide-repl-react` | `<PythonRepl>`·`<PythonRunner>`·hook                                                                                        | —     | —          |

- core는 한 벌이다.
  - coincident는 core의 변형이 아니다. DOM 접근 전용 플러그인이다.
  - `input()`·출력·중단은 coincident를 거치지 않고 core 채널로 간다.
  - core·repl·terminal·react는 coincident에 의존하지 않는다(시험으로 강제).
- REPL + dom-bridge 조합은 지원하지 않는다(문서화만).
  - REPL은 프롬프트 대기 중 main→worker 요청(Tab 완성)이 필요하다.
  - coincident 동기 대기가 그것을 막는다([ADR-0001](./0001-no-sync-bridge-library.md), `docs/design/11-known-traps.md` "새 구조에서 제거됨").
- 입력 UI seam은 main 쪽 `InputProvider(prompt, signal) => Promise<string | null>`이다.
  - `prompt`는 pyodide가 이미 stdout에 쓴 미종결 꼬리다(참고값).
- worker 파일은 앱이 조립한다(`runWorker({ driver, plugins })`, `createWorker` 주입 유지).
  - `core/worker`는 top-level await가 있는 모듈의 import보다 앞선 정적 import로 둔다.
  - 이 순서를 지키면 `runWorker` 호출 시점은 자유다. core가 모듈 평가 시점에 init 프레임을 버퍼링한다(아래 "갱신(RD-023)").
  - dom-bridge를 쓰면 dom-bridge `./worker`가 worker 파일의 첫 정적 import여야 한다. coincident가 `coincident/window/worker` 평가 때 부트스트랩 리스너를 한 번만 걸기 때문이다.
  - core init 리스너는 `kind: "init"` 객체만 받는다. 첫 메시지를 무조건 소비하지 않는다.
- 배포는 당분간 `pnpm pack` tarball이다. npm 공개 배포는 하지 않는다(`docs/history/first-roadmap.md` "범위 밖" 절).

근거: 2026-09-24 공존 스파이크(Chromium)에서 같은 worker의 다음 다섯이 공존했다. 스파이크 기록 파일은 이 저장소에 없다.

- coincident 부트스트랩.
- core 초기화.
- 메일박스 `input()`.
- interrupt Ctrl+C.
- DOM 프록시.

조건은 core init 리스너의 동기 등록이었다. 매크로태스크 뒤에 등록하면 프레임이 소실된다. RD-023이 이 조건을 core의 모듈 평가 시점 버퍼링으로 바꿨다(아래 "갱신(RD-023)").

## Considered Options

- 모드 플래그(`mode: "repl" | "run"`)로 한 패키지에서 분기: 기각. 공통과 REPL 전용이 한 파일에 섞인 상태가 커진다.
- coincident가 있는 core와 없는 core 두 벌: 기각. `input()`·Ctrl+C 구현이 두 벌이 된다.
- coincident 경로에서 `input()`을 `window.prompt`로 대체: 기각.
  - 모달이 main을 멈춘다.
  - `allow-modals` 없는 iframe·cross-origin iframe에서 막힐 수 있다(canvas D7).
  - 실행창의 `input()`은 REPL 읽기와 경쟁하지 않는다. 메일박스로 충분히 단순하다.
- terminal 코어와 worker 코어를 별도 패키지로: 기각.
  - Ctrl+C 한 동작이 main 송신기·SAB·worker 핸들러를 관통한다.
  - 대신 core는 UI 비의존으로 두고 xterm 부분만 terminal·repl로 뺀다.

## Consequences

- RD-020(core 추출)은 완료된 RD 17건의 코드를 옮긴다. 전체 기준선(`e2e:baseline`)으로 판정한다.
- coincident 동기 호출 중에는 Ctrl+C가 닿지 않는다.
  - 호출이 반환된 직후 `KeyboardInterrupt`가 난다.
  - 대기 중에는 `Atomics.pause` busy-wait다.
  - 끝나지 않는 main 함수를 끊는 길은 terminate 폴백뿐이다.
- Firefox·`native: false`(서비스워커 없음)는 착수 조건이 아니다.
- Chromium 스파이크 판정은 `제한 있는 지원`이다.
- Firefox 공존 실측과 서비스워커 경로는 `docs/history/first-roadmap.md` "보류" 절에 있다.

## 갱신(RD-022, 2026-09-24)

RD-022가 실행 driver와 `pyodide-terminal`을 만들며 위 결정을 구체화했다. 패키지 분리 자체는 바뀌지 않았다. 규칙 본문은 `docs/design/14-runner.md`.

- **repl → terminal 의존**
  - xterm 결합 공통 부품 5종을 terminal의 서브패스 `@cp949/runo-pyodide-terminal/internal`로 낸다: `sinks`·`rewind-tail`·`selection-copy`·`surface`·`prompt-row`.
  - `stdin-reader`·`notice`는 RD-027이 `prompt-row`로 흡수하며 없앴다.
  - repl이 이 부품을 쓴다. terminal → repl 의존은 없다(시험이 강제).
  - `./internal`은 repl 전용이다. 두 패키지가 lockstep으로 함께 바뀐다. 안정성을 보장하지 않는다.
  - 기각한 대안:
    - 부품을 repl에 두고 terminal이 repl에 의존: 실행창이 REPL 코드를 끌어온다.
    - 별도 공유 패키지: 부품이 작고 소비자가 둘뿐이라 패키지 수만 늘어난다.
    - 부품 복제: 두 벌이 어긋난다.
- **runner는 core에 둔다**
  - UI 비의존 `createRunner`(상태 8종·`run`·`stop`·`InputProvider`)가 core에 있다. 상태는 이후 ADR-0008이 `unsupported`를 더해 9종이다.
  - terminal의 `createTerminalRunner`가 그것을 xterm에 붙인다.
  - canvas 같은 xterm 없는 소비자가 core만으로 실행할 수 있다.
  - 위 표의 core "실행 driver, main 세션" 항목과 같다.
- **`InputProvider` 생략의 의미**
  - provider를 생략하거나 `null`을 돌려주면 읽기 취소(메일박스 cancel)다.
  - `input()`은 `KeyboardInterrupt`이고 결과는 `interrupted`다. `EOFError`가 아니다.
  - 결정 당시(사용자 확정 2026-09-24) 메일박스에는 EOF 상태가 없었다. REPL과 공유하는 계층이라 이 RD에서 바꾸지 않았다.
  - RD-048이 EOF 상태를 더했다. EOF는 `null`이 아니라 별도 값 `STDIN_EOF`로 알린다. `null`은 지금도 취소 전용이다(`docs/traps/TRP-044`, `docs/design/14-runner.md` 14.4).
- **interrupt buffer는 worker마다 새로 만든다**
  - 옛 worker가 `terminate()` 뒤에도 Chromium에서 최대 약 2초 살아 같은 buffer의 눌림을 가로챈다.
  - runner가 먼저 이렇게 했고 REPL도 같은 규칙으로 고쳤다(`docs/design/14-runner.md` 14.3.5).

## 갱신(RD-023, 2026-09-25)

RD-023이 `pyodide-dom-bridge`를 만들며 위 표의 `pyodide-dom-bridge` 행을 구체화했다. 패키지 분리 자체와 "REPL + dom-bridge 비지원"은 바뀌지 않았다. 규칙 본문은 `docs/design/16-dom-bridge.md`.

- **패키지·진입점**
  - `@cp949/runo-pyodide-dom-bridge`(private, 버전 동기).
  - 진입점 `.`(main): `createBridgeMain`·`isDomBridgeSupported`.
  - 진입점 `./worker`: `domBridge`·`bridge`.
  - core는 `WorkerPlugin` 타입만 쓴다(런타임 import 0). `peerDependencies`(+`devDependencies`)로 둔다.
  - 의존 선언은 아래 "갱신(2026-09-28)"이 정정한다.
- **core `plugins`**
  - `runWorker({ driver, plugins? })`, `WorkerPlugin { name; prepare({ pyodide }): void | Promise<void> }`.
  - 순서: `loadPyodide` → interrupt 공개 API 확인 → 플러그인 → `driver.createConsole`.
  - 플러그인은 배열 순서로 하나씩 await한다.
  - 실패는 `Error: plugin "<name>": <원인>` 페이로드의 `loadFailed`다.
  - 훅은 `prepare` 하나뿐이다. 해제 훅은 없다.
  - 이 자리인 이유:
    - `createConsole`이 동기다. 비동기 준비를 기다릴 수 있는 지점이 그 앞뿐이다.
    - 이 시점에는 `connectInterrupts` 전이라 정리할 부분 설치가 없다.
- **init 버퍼링(규칙 변경)**
  - 위 결정의 "core init 리스너는 모듈 본문에서 동기 등록"을 바꿨다.
  - core `./worker` 모듈이 평가될 때(worker 전역일 때만) `message` 리스너를 걸어 init 프레임을 버퍼에 둔다.
  - 앱은 `core/worker`를 top-level await가 있는 모듈의 import보다 앞선 정적 import로 둔다(dom-bridge를 쓰면 dom-bridge `./worker` 다음). 이 순서를 지키면 `runWorker` 호출 시점(파일 안의 `await` 뒤 등)은 자유다.
  - 순서 조건은 RD-023 사후 리뷰(2026-09-25)에서 더했다.
    - Vite 8(rolldown) 번들은 모듈 코드를 import 순서대로 이어 붙인다. 번들 순서는 확인했다.
    - top-level await 모듈이 먼저면 수신기 등록 문장이 그 `await` 뒤에 놓인다.
    - 그 사이에 init이 유실되는지는 추정이다. 브라우저에서 실측하지 않았다(`docs/design/01-protocols.md` 4절).
  - 두 번째 `runWorker` 호출은 명시 오류다(이중 부팅 방지).
  - 기각한 대안: 동기 등록 규칙 유지(2026-09-25 그릴링 확정). dom-bridge의 "첫 정적 import" 규칙과 겹쳐 규칙이 두 겹이 된다.
- **dom-bridge 첫 정적 import 규칙**
  - coincident는 `coincident/window/worker`가 평가될 때 부트스트랩 리스너를 한 번만 건다. 그래서 dom-bridge `./worker`가 worker 파일의 첫 정적 import여야 한다.
  - 위반은 `prepare`가 명시 오류로 알린다.
    - 별도 모듈(부트스트랩 관찰기)이 coincident보다 먼저 리스너를 걸어 부트스트랩 도착을 기록한다.
    - `prepare` 시점에 기록이 없으면 던진다(고정 대기 없음).
  - 기각한 대안:
    - 캡처 단계 리스너: Chromium worker 전역에서 대상 자신은 캡처·비캡처 구분 없이 등록 순서로 호출돼 성립하지 않았다. L1 첫 실행이 정상 배치를 `load-failed`로 만들어 발견했다.
    - 관찰 없이 문서 규칙만.
- **실패 통지**
  - RD-023은 새 상태를 만들지 않았다. 당시 공개 상태 유니온(`RunnerStatus` 8종)은 그대로였다. 원인 문구는 `load-failed`(`onLoadFailed`)에 담는다.
  - 이후 ADR-0008이 `unsupported`를 더해 `RunnerStatus`는 9종이다.
  - main에서 미리 거를 수 있게 `isDomBridgeSupported()`를 낸다. 참 조건은 둘이다.
    - core `detectRuntimeSupport()`가 `supported`다(wasm 기능 + `crossOriginIsolated`).
    - growable `SharedArrayBuffer` 생성이 성공한다.
- **`native: false` 방침**
  - `native`가 `false`이면(growable `SharedArrayBuffer` 불가) 동기 DOM 코드가 오류 없이 무효가 된다(`docs/traps/TRP-065`).
  - `prepare`가 명시 오류로 조기 실패한다(`load-failed`).
  - 서비스워커(sabayon) 경로와 `await` 전용 API는 만들지 않는다.
  - 스파이크가 서비스워커 없는 조건만 측정했다. 필요해지면 그때 등록한다(`docs/history/first-roadmap.md` "보류" 절).
- **검증 범위**
  - 2026-09-25 Chromium 스파이크 판정은 `제한 있는 지원`이다.
  - Firefox 공존 실측과 서비스워커 경로는 RD-023 착수 조건이 아니다. `docs/history/first-roadmap.md` "보류" 절 항목이다.
  - Chromium에서만 검증했다(Firefox·Safari 미검증).
- **경계 예외**
  - coincident 금지는 dom-bridge를 뺀 패키지에 그대로 적용된다.
  - `scripts/check-dist.mjs`는 `--allow-sync-bridge`가 있을 때만 coincident 문자열 금지를 끈다. 대신 CSP 정적 규칙을 건다: 허용 지정자 2개, 금지 표현, 관찰기 import 순서.
  - `pnpm smoke:pack`은 소비자를 둘로 나눈다.
    - 주 소비자: dom-bridge를 뺀 5개 패키지. "coincident·reflected-ffi 없음"을 유지한다.
    - dom-bridge 소비자: core + dom-bridge를 따로 설치해 자기 검사를 받는다.
  - 기각한 대안: 한 소비자에서 dom-bridge를 예외로 빼는 판정. 금지 검사가 약해질 수 있다.
  - `sideEffects`는 dom-bridge만 배열이다. 부수효과 전용 import가 트리셰이킹되면 리스너가 빠진다.
- **React 결합**
  - `<PythonRunner createWorker={…}>`에 dom-bridge worker를 주입하는 조합은 react 패키지 변경 없이 동작한다. demo `?view=dom-bridge`가 시험한다.
  - REPL과의 조합은 여전히 비지원이다.
- **동기 호출 중 중단**
  - coincident 동기 호출 중에는 `interrupt()`가 호출 반환 뒤에야 전달된다.
  - 결정한 것은 문서화와 시험 고정뿐이다. 제품 동작은 바꾸지 않는다(에스컬레이션·호출 길이 상한은 범위 밖).
  - 즉시 끝내는 경로는 `stop()`이다(`16-dom-bridge.md` 16.8).

## 갱신(RD-024, 2026-09-25)

RD-024가 `pyodide-repl-react`를 만들고 demo를 옮기며 위 표의 `pyodide-repl-react` 행을 구체화했다. 패키지 분리 자체는 바뀌지 않았다. 규칙 본문은 `docs/design/15-react.md`.

- **패키지·진입점**
  - `@cp949/runo-pyodide-repl-react`(private, 버전 동기).
  - 진입점은 `.` 하나다(서브패스 없음). `PythonRunner`·`PythonRepl`·`usePythonRunner`와 타입을 낸다. `RunRejectedError`도 재수출한다.
  - 컴포넌트가 xterm `Terminal` 생성·`FitAddon`·dispose 순서·StrictMode 이중 마운트를 처리한다.
- **의존**
  - core·terminal·repl은 `workspace:*`다.
  - `@xterm/addon-fit`은 직접 의존이다(`0.11.0` 고정). 소비자에게 fit을 따로 설치시키지 않는다.
  - peer는 `react`·`react-dom`(`^19.0.0`)과 `@xterm/xterm`(`^6.0.0`)이다.
  - `xterm.css`는 패키지가 import하지 않는다. 소비자가 import한다.
  - coincident·reflected-ffi 비의존은 세 곳이 강제한다: 시험(`test/package-boundary.test.ts`)·`check-dist`·`smoke:pack`.
- **컴포넌트는 하위 API를 그대로 위임한다**
  - `PythonRunner`는 terminal `createTerminalRunner`, `PythonRepl`은 repl `createRepl`의 옵션·핸들을 통과시킨다. 새 동작을 만들지 않는다.
  - terminal 핸들에 없는 `interrupt`·`busy`는 `PythonRunner`가 노출하지 않는다(terminal 핸들에 게터를 더하는 것은 별도 항목).
  - 이 RD는 REPL의 세션·송신기 배선을 바꾸지 않았다.
- **props 변경**
  - 콜백은 latest-ref다(인라인 람다여도 재마운트 없음).
  - 생성 옵션은 마운트 때만 읽는다(바꾸려면 `key`).
  - `copyOnSelect`만 반응형이다.
  - 개발 중 경고는 없다.
- **handle 수명**
  - handle은 컴포넌트 수명 내내 같은 객체다. "지금 살아 있는 하위 핸들"로 위임한다.
  - 핸들이 없는 구간의 규칙은 `15-react.md` 15.3이다.
    - `run`·`runSource`: `disposed` reject.
    - `stop()`: `"idle"`.
    - `busy`: `false`.
    - 나머지: no-op.
- **StrictMode**
  - worker 2개를 만들고 1개를 terminate한다(살아 있는 것 1개).
  - 첫 worker의 pyodide 로드 낭비를 수용한다(`08-session.md` 8.2와 같은 판단).
  - 기각한 대안(2026-09-25 그릴링 확정): 생성을 지연해 낭비를 없애는 것.
- **`usePythonRunner`**
  - xterm 없이 core `createRunner`를 감싸는 저수준 hook이다. 반환은 `{ status, run, stop, reset, interrupt, busy }`다.
  - `<PythonRunner>`는 이 hook을 쓰지 않고 terminal 실행창을 쓴다.
  - 수명·latest-ref 로직만 내부 공용 hook을 공유한다.
- **fit**
  - `fit?: boolean`(기본 `true`). 컨테이너 `ResizeObserver` + rAF 합침이다.
  - demo 기본 화면은 `fit={false}`(80×24)다. 기존 브라우저 기준선이 바뀌지 않는다.
  - `?fit=1`에서만 fit이다.
- **미결·범위 밖**
  - iframecall 어댑터(앱 계층).
  - `Terminal` 노출.
  - dom-bridge와 React의 결합(RD-023 뒤).

## 갱신(2026-09-28)

- **의존 선언 정정**
  - 위 RD-023 "패키지·진입점"은 dom-bridge가 coincident `4.1.1`·reflected-ffi `0.7.2`를 upstream 그대로 `dependencies`에 고정한다고 적었다. 낡은 문구다.
  - 2026-09-28에 둘 다 TypeScript 포크로 대체했다.
    - `@cp949/runo-coincident`(`0.1.0`): `file:/work/cp949/runo/runo-coincident/packages/coincident`.
    - `@cp949/runo-reflected-ffi`(`0.1.1`): `file:/work/cp949/runo/runo-reflected-ffi/packages/reflected-ffi`.
  - 로컬 경로라 정확 버전 문자열 대조가 아니라 경로 고정이다.
  - coincident 진입점은 `@cp949/runo-coincident/window/main`·`@cp949/runo-coincident/window/worker` 둘뿐이다.
  - 상세는 `docs/design/16-dom-bridge.md` 16.1.
