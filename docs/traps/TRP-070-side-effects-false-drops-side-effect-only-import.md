# TRP-070 `sideEffects: false` 패키지의 부수효과 전용 import는 번들에서 통째로 사라져 worker 부트스트랩 리스너가 빠진다

- 상태: ACTIVE
- 적용 조건: 모듈 평가 시점의 부수효과(리스너 등록·전역 패치)에 의존하는 패키지 진입점을 `import "…/worker"` 형태로 쓰는 소비자, 그런 진입점을 가진 패키지의 `package.json` `sideEffects`를 고칠 때(dom-bridge `./worker`와 `bootstrap-observer-install`). 새 부수효과 진입점·청크를 tsdown에 추가할 때.

## 오해하기 쉬운 신호

- jsdom·node 시험과 `check-types`·`build`는 통과한다. 결함은 소비자 번들(Vite 프로덕션 빌드)에서만 나타나고, 브라우저에서 부트스트랩 미수신(`load-failed`)으로만 드러난다.
- 스크래치 Vite 빌드 측정: `import "@cp949/runo-pyodide-dom-bridge/worker";`만 쓰는 진입점이 `sideEffects: false`에서 70B(리스너·coincident 코드 0), 배열 설정에서 10,147B(`capture: true` 1, coincident 리스너 2; 이는 관찰기를 캡처 리스너로 걸던 시점의 측정)였다. `domBridge()`를 실제로 쓰는 진입점은 두 설정 모두 105,297B로 같았다. 즉 `domBridge()`를 같은 파일에서 쓰면 문제가 가려진다.

## 원인

- `sideEffects: false`는 "import한 이름을 쓰지 않으면 모듈을 통째로 지워도 된다"는 선언이다. 이름이 없는 `import "…"`는 그대로 제거 대상이다.
- worker 파일이 첫 import만 두고 `domBridge`는 다른 파일에서 조립하는 구조에서 발생한다.

## 탐지/회피

- `packages/pyodide-dom-bridge/package.json`의 `sideEffects`만 배열이다: `["./dist/worker.mjs", "./dist/bootstrap-observer-install*.mjs", "./src/worker.ts", "./src/bootstrap-observer-install.ts"]`. 작업공간 소스(`development` 조건)와 dist 양쪽 경로가 필요하다. 관찰기 청크는 파일 이름에 해시가 붙어 글로브(`bootstrap-observer-install*.mjs`)로 덮는다. 다른 패키지는 `false`다.
- `packages/pyodide-dom-bridge/src/package-boundary.test.ts`와 `pnpm smoke:pack`의 dom-bridge 소비자(tarball `sideEffects`가 배열이고 `./dist/worker.mjs`를 포함하는지)가 이를 고정한다.
- 소비자 번들러 설정이 이 패키지의 `sideEffects`를 무시하거나 `false`로 덮으면 같은 결과가 날 수 있다(추정, 측정한 것은 패키지 자신이 `false`일 때다). `docs/design/16-dom-bridge.md` 16.1·16.3.
