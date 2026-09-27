# pyodide-repl-react

React 컴포넌트·hook(`PythonRunner`·`PythonRepl`·`usePythonRunner`)으로 core·terminal·repl을 감싸는 패키지(RD-024). 컴포넌트가 xterm `Terminal` 생성·`FitAddon` 리사이즈·dispose·StrictMode 이중 마운트를 처리한다. coincident에 의존하지 않는다. main·worker·세션·읽기·인터럽트 용어는 `packages/pyodide-repl/CONTEXT.md`, runner·실행창은 `packages/pyodide-terminal/CONTEXT.md`, driver·core 세션·`InputProvider`는 `packages/pyodide-core/CONTEXT.md`를 따르고, 여기서는 react가 도입한 용어만 정의한다. 규칙 본문은 `docs/design/15-react.md`.

## Language

### 컴포넌트와 handle

**컴포넌트(`PythonRunner`·`PythonRepl`)**:
컨테이너 `div` 하나를 렌더링하고 마운트 effect 안에서 xterm `Terminal`과 하위 핸들(`createTerminalRunner`·`createRepl`)을 만든다. props는 하위 옵션에서 유도하고 `Terminal`은 노출하지 않는다.
_Avoid_: 위젯, 터미널 컴포넌트

**handle**:
`ref`로 얻는 명령 객체(`PythonRunnerHandle`·`PythonReplHandle`). 컴포넌트 수명 내내 같은 참조이고 호출을 "살아 있는 하위 핸들"로 위임한다. 하위 핸들과 다른 객체다.
_Avoid_: 인스턴스, API 객체

**터미널 위젯**:
`useTerminalWidget`(`use-terminal-widget.ts`, RD-038)이 감싸는 내부 합성물 — xterm 화면(`terminal-view.ts`)과 하위 핸들 하나를 묶어 부착·실패 되돌리기·dispose 순서·`focus`·`copyOnSelect`를 흡수한다. `PythonRunner`·`PythonRepl`이 각자 만들어 쓰고 밖에 노출하지 않는다. **컴포넌트**와 다른 대상이다(그 항목의 _Avoid_ "위젯"은 컴포넌트를 가리키는 동의어를 막는 것이지 이 내부 합성물과는 무관하다).
_Avoid_: 컴포넌트(둘을 같은 말로 섞지 않는다)

**살아 있는 핸들**:
마운트 effect가 만들었고 아직 cleanup되지 않은 하위 핸들(과 그 `Terminal`). StrictMode에서는 mount → cleanup → mount 사이에 교체된다. 없는 구간(마운트 전·cleanup과 재마운트 사이·언마운트 뒤)에는 handle이 "핸들 없음 규칙"을 적용한다.
_Avoid_: 현재 세션(세션은 worker 한 개)

**핸들 없음 규칙**:
살아 있는 핸들이 없을 때 handle의 결과: `run`·`runSource`는 `RunRejectedError("disposed")`, `stop()`은 `"idle"`, `busy`는 `false`, `status`는 마지막 통지 값, 나머지는 no-op. 하위 핸들의 `dispose()` 뒤 규칙(14.3.4)과 같다. 첫 동기 상태 통지 안의 호출도 이 규칙이다(핸들이 반환되기 전이다).

### props 변경

**latest-ref 콜백**:
`onStatus`·`onOutput`·`onCrash`·`onCopy`·`inputProvider`. 하위 옵션에는 마운트 때 만든 래퍼를 한 번만 넘기고, 래퍼가 부를 때마다 최신 렌더의 함수를 부른다. 인라인 람다여도 재마운트가 없다.

**생성 옵션**:
`createWorker`·`indexURL`·`filename`·`topLevelAwait`·`clearOnRun`·`terminalOptions`·`fit`. 마운트 때만 읽는다. 바꾸려면 소비자가 `key`로 재마운트한다. REPL의 `topLevelAwait`는 세션 도중 `reset({ topLevelAwait })`로만 바꾼다.

**반응형 prop**:
`copyOnSelect` 하나. 값이 바뀌면 재마운트 없이 `setCopyOnSelect`를 부른다.

### 화면

**fit**:
`FitAddon`으로 컨테이너 크기에 맞춰 열·행을 조절하는 동작(`fit?: boolean`, 기본 `true`). 컨테이너 `ResizeObserver` 통지를 `requestAnimationFrame` 한 번으로 합치고 크기가 0이면 건너뛴다. 데모 기본 화면은 `fit={false}`(80×24)다.

**이중 마운트**:
StrictMode(dev)의 mount → cleanup → mount. worker가 2개 생성되고 1개가 terminate되어 살아 있는 것은 1개다. 첫 worker의 pyodide 로드 낭비는 수용한다(`08-session.md` 8.2와 같은 판단).
_Avoid_: 두 번 렌더(렌더가 아니라 effect가 두 번 도는 것이다)
