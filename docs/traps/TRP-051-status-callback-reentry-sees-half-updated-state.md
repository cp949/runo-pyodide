# TRP-051 상태 콜백(`onStatus`) 안에서 `reset()`·`dispose()`를 부르면 절반만 갱신된 내부 상태를 본다

- 상태: ACTIVE
- 적용 조건: 소비자 콜백(`onStatus` 등)을 동기로 부르는 상태 기계(core `createRunner`, REPL 핸들, RD-024 React 래퍼)에서 콜백 호출 앞뒤로 슬롯·세션·`stop()` 결말을 바꾸는 코드를 추가·수정할 때.

## 오해하기 쉬운 신호

- 시험이 결과를 `await`한 뒤 다음 조작을 하는 순서만 보면 모두 통과한다. 콜백 안에서 동기로 `reset()`·`dispose()`를 부르는 소비자(`s === "crashed" && runner.reset()` 같은 자동 복구)에서만 드러난다.
- 결과는 조용하다: 실행 중 run이 `crashed` 대신 `restarted`로 끝나고 `onCrash`가 사라지거나, 준비되지 않은 새 worker로 `runCode`가 가거나, `dispose()` 뒤에 worker가 새로 만들어져 terminate되지 않는다.

## 원인

- `setStatus(next)`가 소비자 콜백을 부르는 순간 내부 상태가 아직 옛 값이다(슬롯에 run이 남아 있음, 새 세션을 만들기 전, `stop()` 결말 미정). 콜백이 부른 `reset()`·`dispose()`가 그 상태를 기준으로 동작하고, 콜백이 끝난 뒤 호출자가 옛 가정(`session`, `active`, 세대)으로 나머지를 이어 간다.
- `dispose()`가 세대(`generation`)를 올리지 않으면 열린 읽기를 버린 뒤의 재개 알림(`inputResumed`)이 `dispose()` 뒤에 상태를 바꾼다.

## 탐지/회피

- `setStatus` 전에 슬롯·`stop()` 결말을 확정하고(`takeActive()`·`resolveStop()`), `setStatus` 뒤에는 세대·상태·슬롯을 다시 확인한다. 새 세션은 만든 뒤에 `restarting`을 알리고, `runCode`는 `running` 알림 전에 보낸다(`packages/pyodide-core/src/session/runner.ts`).
- `dispose()`는 세대를 올려 옛 세션의 뒤늦은 콜백을 모두 버린다.
- 시험: `packages/pyodide-core/src/session/runner.test.ts`의 "상태 콜백 안의 재진입과 dispose 뒤 알림" 절(콜백별 `reset()`·`dispose()` 조합, 변이 9종 killed).
