# TRP-086 latest-ref를 렌더 본문(effect 밖)에서 읽으면 한 commit 늦은 값이 된다

- 상태: ACTIVE
- 적용 조건: `useLatest`(또는 같은 패턴의 latest-ref: `useLayoutEffect`에서 `ref.current`를 갱신하는 ref)를 effect 콜백 밖, 즉 컴포넌트·hook의 렌더 본문에서 `ref.current`로 읽는 코드를 추가하거나 리뷰할 때.

## 오해하기 쉬운 신호

- 첫 마운트(`useRef(value)` 초깃값이 곧 현재 props)와 StrictMode의 mount → cleanup → mount(같은 commit 안에서 재실행)는 값이 어긋나지 않는다. 일반적인 시험·수동 확인으로는 문제가 드러나지 않는다.
- eslint `react-hooks` 규칙이 없는 저장소에서는 정적 검출도 안 된다.

## 원인

`useLatest`는 `useLayoutEffect`에서 갱신되므로 렌더 본문 실행 시점에는 아직 갱신되지 않은 직전 commit 값이다. 재렌더 뒤 같은 마운트 effect가 다시 도는 드문 경로(React `<Activity>` hidden→visible, Fast Refresh 등)에서, 렌더 중 읽은 값과 effect 안에서 읽은 값이 서로 다른 렌더의 props를 가리킬 수 있다.

관찰된 사례(RD-038, `packages/pyodide-repl-react/src/use-terminal-widget.ts`를 쓰는 `python-runner.tsx`·`python-repl.tsx`): `view` 옵션을 `latest.current.terminalOptions`/`latest.current.fit`으로 만들었다가(렌더 본문에서 읽음) opus 리뷰가 지적해 렌더 스코프 구조분해 값(`terminalOptions`·`fit`)으로 고쳤다.

## 탐지/회피

- latest-ref 값은 effect 콜백(또는 effect 콜백에 전달되는 클로저) 안에서만 읽는다. 렌더 본문에서 값이 필요하면 원래 prop·렌더 스코프 변수를 직접 쓴다.
- 정적 검출이 없는 저장소에서는 리뷰에서 `latest.current`(또는 같은 이름의 latest-ref) 사용 위치가 렌더 본문인지 effect 콜백인지 눈으로 확인한다.
