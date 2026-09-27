# TRP-062 `@xterm/addon-fit`은 xterm 비공개 API에 기대고, jsdom 시험은 그 경로의 생사를 구분하지 못한다(경로가 사라지면 브라우저에서 `TypeError`)

- 상태: ACTIVE
- 적용 조건: `@xterm/xterm` 또는 `@xterm/addon-fit` 버전을 올릴 때(현재 6.0.0 + 0.11.0), 렌더러를 DOM에서 addon-webgl·canvas로 바꿀 때, `pyodide-repl-react`의 `fit` 경로(`attachFit`)를 바꿀 때.

## 오해하기 쉬운 신호

- `pnpm check-types`·`lint`·`test`·`build`·`smoke:pack`이 모두 통과한다. jsdom에서는 셀 크기가 0이라 `proposeDimensions()`가 `undefined`를 돌려주고 `fit()`이 원래 무동작이라(80×24 유지) 시험이 경로의 생사를 구분하지 못한다. 타입(`ITerminalAddon`)도 맞는다.
- `fit()`이 무동작인 것은 jsdom처럼 셀 크기가 0일 때(`proposeDimensions()`가 `undefined`)와 `cols`·`rows`가 `NaN`일 때뿐이다. 실제 브라우저에서 비공개 경로가 사라진 경우는 무동작이 아니라 예외다(아래 원인).

## 원인

`@xterm/addon-fit` 0.11.0 `lib/addon-fit.mjs`가 `terminal._core._renderService.dimensions.css.cell`과 `.clear()`를 쓴다(소스 주석 "TODO: Remove reliance on private API"). 이 접근에 try/catch가 없고 `pyodide-repl-react`의 `fitNow`(`terminal-view.ts`)도 예외를 삼키지 않는다. 비공개 경로가 바뀌거나 사라지면 `TypeError`가 그대로 난다.

- 마운트 때 `attachFit`의 첫 `fitNow()`: `mountTerminalView`가 만든 `Terminal`을 dispose하고 다시 던지므로 컴포넌트의 마운트 effect가 실패한다(오류 경계가 없으면 트리 전체가 언마운트된다).
- 이후 `ResizeObserver` → `requestAnimationFrame` 경로의 `fitNow()`: rAF 콜백의 uncaught 예외(`pageerror`)가 되고 `fit`만 동작하지 않는다. 다음 통지에서 다시 던진다.

xterm 6.0.0에는 그 경로가 있다(2026-09-25 실측). 이 문서의 예외 동작은 `fit()` 소스와 `terminal-view.ts` 코드 읽기에서 유도했고, 경로를 지운 xterm으로 브라우저에서 재현하지는 않았다.

## 탐지/회피

- 버전을 올린 뒤 브라우저에서 `pnpm --filter demo e2e:react-fit`(L1)을 돌린다. 창 크기를 바꿔 `cols`가 바뀌는지(2026-09-25 실측: `cols` 138 → 67 → 107, 입력 대기 중 107 → 52)와 그 뒤 입력이 정상인지 본다. jsdom 시험은 대체가 되지 않는다.
- 렌더러를 바꾸면 `react-fit-check`의 `cols` 측정(`.xterm-screen`·`.xterm-char-measure-element` 기하)이 셀렉터 불일치로 `NaN`이 되어 측정 실패로 실패한다. 이 경우는 조용하지 않다.
- 업그레이드 절차 문서(`docs/design/13-version-upgrade.md`)는 pyodide 대상이다. xterm·addon-fit 업그레이드는 이 함정이 확인 지점이다.
