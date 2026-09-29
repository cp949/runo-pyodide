# cross-origin isolated 페이지를 전제로 하고 비격리 폴백을 만들지 않는다

Ctrl+C(interrupt buffer)와 `input()`(메일박스)은 모두 `SharedArrayBuffer`와 `Atomics`를 요구한다.

폴백 후보는 둘 다 쓰지 않는다.

- coincident의 Service Worker 동기 XHR 우회: 이전 구현도 싣지 않았다([ADR-0001](./0001-no-sync-bridge-library.md)).
- 메일박스의 Promise 폴백: pyodide `setStdin` 콜백이 Promise를 돌려주게 되어 `input()`이 깨진다(이전 시도가 막힌 지점).

결정:

- `crossOriginIsolated`가 거짓이면 `createRepl`은 worker를 만들지 않는다.
  - 터미널에 경고 한 줄을 낸다.
  - `onStatus('not-isolated')`를 부른다.
- 비격리에서는 세션 자체가 없다. 초기화 프레임이 `SharedArrayBuffer` 뷰를 요구하기 때문이다([TRP-002](../traps/TRP-002-non-shared-view-breaks-sharing-silently.md)).
- 폴백 구현은 없다.
- dev·preview·정적 배포는 모두 두 헤더를 보낸다.
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`
- 이전 구현은 dev에만 헤더를 걸어 preview·빌드 산출물이 비격리였다.

정정(2026-09-22, RD-004): 이전 문구 "Ctrl+C·`input()` 없이 동작한다"를 "세션을 시작하지 않는다"로 바꿨다. 프레임 검증(`parseInitFrame`이 비공유 뷰를 거부한다)과 모순이었다.

추가(2026-09-28, [ADR-0008](./0008-chrome84-build-floor-and-pyodide-runtime-floor.md)): 격리 판정보다 먼저 보는 것이 있다.

- 브라우저가 pyodide 런타임이 요구하는 wasm 기능(런타임 floor)을 지원하지 않으면 `unsupported`다. `not-isolated`가 아니다.
- 두 상태 모두 worker를 만들지 않는다. 원인이 다르다.
- 판정 순서와 근거는 [`docs/design/14-runner.md`](../design/14-runner.md) 14.3.1 한 곳에 있다.

## Consequences

- CDN pyodide 등 교차 출처 자원은 `Cross-Origin-Resource-Policy: cross-origin`을 제공해야 한다(jsdelivr는 제공한다).
- 자체 호스팅으로 바꾸면 같은 헤더를 붙인다.
