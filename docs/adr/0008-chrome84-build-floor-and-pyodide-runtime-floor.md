# 빌드 floor는 Chrome 84로 못박고, pyodide가 정하는 런타임 floor는 따로 기록한다

빌드 floor 선언이 없어 tsdown·Vite가 `dist`의 문법·런타임 API(`??=`·`Object.hasOwn`·`.at`·`replaceAll` 등)를 하향하지 않았다. 구버전 브라우저는 `SyntaxError`로 하얀 화면이 되거나, 문법은 통과해도 pyodide의 wasm(`pyodide.asm.wasm`)이 요구하는 기능(reference types·legacy Wasm 예외 처리 등)이 없어 `WebAssembly.compile`이 실패한다 — 두 실패는 원인이 다르고 안내도 달라야 한다. 2026-09-28 브레인스토밍으로 둘을 분리하기로 확정했다. 아래 결정이 유일한 장기 기록이다.

결정:

1. **엔진 범위: Chrome 전용.** Firefox·Safari는 floor를 선언하지 않고 미검증으로 둔다. `runo-coincident`·`geul`과 같은 범위 선언 방식이다.
2. **빌드 floor Chrome 84.** 이 저장소 모든 라이브러리 `dist`의 문법·ECMAScript API를 Chrome 84 기준으로 하향하고 정적 게이트(아래 4)로 강제한다(`browser-target.mts`의 `BROWSER_TARGET = ["chrome84"]`, `runo-coincident`와 같은 값).
3. **런타임 floor는 pyodide가 정하고 따로 기록한다.** pyodide 버전은 바꾸지 않는다([ADR-0007](./0007-pyodide-single-version-policy.md) 유지, 현재 314.0.7). 빌드 floor ≤ 브라우저 < 런타임 floor 구간에서는 wasm 기능을 부팅 전에 감지해 명시적 `unsupported` 상태로 멈춘다(`CompileError`·빈 화면 대신, 판정 규칙은 [`docs/design/14-runner.md`](../design/14-runner.md) 14.3.1 한 곳 — `detectRuntimeSupport()`).
4. **정적 게이트는 `eslint-plugin-es-x` + Web API 정규식.** `scripts/check-escompat.mjs`가 `flat/restrict-to-es2020`(Chrome 84 이하가 이미 지원하는 것만 개별로 끔) + es-x가 못 보는 Web API 짧은 목록을 각 패키지 `check-dist` 뒤에 건다. `geul/scripts/check-escompat.mjs` 패턴을 따른다.
5. **실측 범위: Chrome 84 + 런타임 floor.** 구버전 Chromium을 컨테이너(`docker/chromium-legacy/`)에서 띄우고 호스트 Playwright가 CDP로 붙어 수동 스크립트(`apps/demo/e2e/legacy/legacy-smoke.mjs`, `pnpm --filter demo e2e:legacy`)로 확인한다. CI 게이트가 아니다 — 릴리스 전·호환 관련 변경 뒤 수동 실행.

## 런타임 floor: 정적 판정과 실측을 분리해서 적는다

pyodide 314.0.7의 `pyodide.asm.wasm`이 요구하는 wasm 기능 중 최초 지원 Chrome 버전이 가장 늦은 것이 판정을 정한다: reference types(96) > legacy Wasm 예외 처리(95) > `Object.hasOwn` 런타임 API(93) > cross-origin isolation/SharedArrayBuffer 게이팅(92). **정적 판정 = Chrome 96.**

실측은 Debian snapshot(`snapshot.debian.org`)에 보관된 버전으로만 가능했다 — 84.0.4147.105-1·93.0.4577.82-1·97.0.4692.71-0.1 세 개뿐이고 **94~96은 snapshot에 없어 미실측이다.** 97에서 runner(`print(1+1)`→`2`, `input()` 왕복, `while True: pass` 중 Ctrl+C → `KeyboardInterrupt`)와 REPL(`1+1`→`2`)이 정상 동작했다. **런타임 floor 공식 값 = 실측 통과 최저 버전 Chrome 97.** 96은 정적 판정상 지원 가능하나 실측하지 않았으므로 "지원한다"고 서술하지 않는다. 84·93은 판정 함수(`WASM_RUNTIME_PROBE`, `packages/pyodide-core/src/runtime-support.ts`)가 `false`를 내 `unsupported`로 멈추는 것을 실측으로 확인했다(84는 비격리 상태에서도, 93은 cross-origin isolated가 참이어도 `unsupported` — wasm 판정이 격리 판정보다 먼저라는 순서 규칙의 근거).

## dom-bridge는 이 런타임 floor를 그대로 물려받지 않는다

"런타임 floor 97"은 core 실행 경로(`createRunner`·`createRepl`·`createTerminalRunner`)의 값이다. `pyodide-dom-bridge`는 그 위에 growable `SharedArrayBuffer`(`maxByteLength` 옵션)가 더 필요하고, 이 기능은 Chrome 111부터다. `isDomBridgeSupported()`의 판정 함수(`canCreateGrowableSharedArrayBuffer()`)는 두 번째 인자를 모르는 구버전 엔진에서도 예외를 던지지 않아 Chrome 97~110 구간에서 `true`로 오탐할 수 있다(GitHub 이슈 #1, 실측: Chrome 97에서 `status=ready supported=true`가 관찰됨 — 실제 growable 동작은 검증하지 않았다). **dom-bridge를 쓰는 조합의 실질 런타임 floor는 미확정이며 97보다 높을 수 있다** — README·문서에서 "런타임 floor 97"을 dom-bridge에 그대로 적용해 서술하지 않는다.

## 탐지 바이트는 pyodide 버전에 묶여 있다

`WASM_RUNTIME_PROBE`(`(module (func (param externref) try catch_all end))`, 29바이트)는 reference types + legacy Wasm 예외 처리라는 **pyodide 314가 요구하는 두 기능**을 검사하도록 만든 것이다. pyodide를 업그레이드해 wasm이 요구하는 기능 집합이 바뀌면(예: exnref로 전환) 이 바이트가 더 이상 올바른 판정을 하지 못한다. pyodide 업그레이드 절차([`docs/design/13-version-upgrade.md`](../design/13-version-upgrade.md))에 이 재검증 단계를 넣는다.

## Chrome 밖 엔진은 `unsupported`가 아니라 `load-failed`가 된다

`detectRuntimeSupport()`의 판정 바이트가 `true`를 낸다고 해서(예: 최신 Safari·Firefox가 우연히 두 wasm 기능을 지원) pyodide의 문법·API 요구사항 전체가 충족된다는 보장은 없다 — 이 저장소는 Chrome에서만 그 전체 요구사항을 실측했다(결정 1). Chrome이 아닌 엔진에서 실제로 부족한 것이 있으면 worker 부팅이 진행되다 pyodide 로드 실패로 `load-failed`가 된다(`unsupported`는 부팅 전 wasm 기능 부재로 worker 자체를 안 만드는 상태이고, `load-failed`는 worker가 살아서 로드를 시도했으나 실패한 상태 — `docs/design/14-runner.md` 14.3.1). 이 구분과 범위는 "Chromium에서만 검증"이라는 결정 1의 범위와 같다.

## Considered Options

- **빌드 floor = 런타임 floor로 통합**(하나의 값만 관리): 기각. pyodide 요구사항(Chrome 96/97)이 라이브러리 자체 문법 요구사항(84로 충분)보다 훨씬 높아, 통합하면 84~96 사이 브라우저를 문법상 지원 가능한데도 빌드 단계에서 미리 포기하게 된다. 두 floor를 분리해야 "문법은 되는데 wasm이 안 된다"는 실제 원인을 안내할 수 있다.
- **core-js 등 전역 polyfill로 격차를 메움**: 기각. DOM API(`replaceChildren`)는 core-js가 다루지 않는 영역이라(실측: Chrome 84 데모 첫 렌더 실패 원인이 `Element.prototype.replaceChildren` 부재였고 core-js를 넣어도 고쳐지지 않았다) 전역 polyfill로는 근본 해결이 안 되고, 라이브러리 `dist`에 전역 polyfill을 넣지 않는다는 기존 원칙과도 충돌한다. 데모 전용 DOM 폴리필만 예외로 허용한다(`apps/demo/src/main.tsx`).
- **CI에 구버전 브라우저 자동 실측을 넣음**: 기각. 컨테이너 빌드·CDP 연결에 수 분이 걸리고 pyodide 버전이 자주 바뀌지 않아 CI 상시 게이트의 비용 대비 이득이 작다. 릴리스 전·호환 관련 변경 뒤 수동 실행으로 충분하다(결정 5).
- **Web API까지 포함하는 완전한 정적 게이트**: 부분 채택. `eslint-plugin-es-x`가 못 보는 Web API는 정규식 목록으로 보완했지만 `Intl` 네임스페이스·`replaceChildren`·`AbortSignal.abort` 등 일부가 빠져 있다(GitHub 이슈 #2). 현재 라이브러리 `src`에 실사용이 0건이라 지금 게이트를 넓히지 않고 이슈로 관리한다.

## Consequences

- pyodide를 업그레이드해 wasm 요구 기능이 바뀌면 `WASM_RUNTIME_PROBE`와 런타임 floor 판정 모두 재확인이 필요하다(`13-version-upgrade.md`에 단계 추가).
- dom-bridge의 실제 안전 floor는 미확정 상태로 남는다(이슈 #1). 판정 정확도 개선은 이 결정의 범위 밖이다.
- `check-escompat` 게이트는 ECMAScript 표준 밖 API(`Intl.*` 등) 일부를 못 잡는다(이슈 #2). 현재 위반 0건이므로 즉시 위험은 없다.
- 94~96은 Debian snapshot에 해당 버전이 없어 실측이 불가능하다 — 새 snapshot이 생기거나 다른 배포판 아카이브를 쓰기로 하지 않는 한 미실측 상태가 유지된다.
- 구버전 실측은 CI 게이트가 아니므로 사람이 릴리스 전·호환 관련 변경 뒤 수동으로 `pnpm --filter demo e2e:legacy`를 돌려야 한다 — 자동 회귀 방지는 없다.
