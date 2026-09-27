# TRP-053 `Readline.cancelRead()`는 열린 읽기가 없어도 type-ahead·`queued`를 비운다

- 상태: ACTIVE
- 적용 조건: 벤더 `Readline.cancelRead()`를 호출하는 코드. 세션 리셋 밖에서(읽기가 없는 실행 중 구간, `takeRead()`로 읽기를 가져간 직후, 정리 코드에서 방어적으로) 부르면서 그 사이 쌓인 키를 다음 읽기가 재생하길 기대할 때.

## 오해하기 쉬운 신호

- `cancelRead()`의 주석·문서는 "열린 읽기가 없으면 아무것도 하지 않는다"이다. 호출은 예외 없이 끝나고 화면도 변하지 않으며 읽기·화면만 보는 시험은 통과한다.
- 다음 읽기를 열었을 때 그 사이 친 키가 재생되지 않는다. 키가 사라진 이유가 `cancelRead()` 호출이라는 단서가 없다.

## 원인

구현이 열린 읽기 검사보다 먼저 `clearTypeAhead()`·`queued = []`·`redrawing = false`를 실행한다. 리셋이 옛 맥락의 키를 새 세션에 넘기지 않게 하려는 의도이고, "무동작"은 읽기 promise와 화면에 대해서만 참이다(`docs/design/06-editing.md` 6.1, 6.7).

## 탐지/회피

- 읽기가 없는 구간에 리셋 외 이유로 `cancelRead()`를 부르지 않는다. 키를 보존해야 하는 읽기 종료는 `takeRead()`다(재그리기 중 쌓인 `queued`를 type-ahead로 옮기고 이미 쌓인 type-ahead는 비우지 않는다).
- REPL `runSource`가 진행되는 동안 main은 리셋(`terminate`) 외에 `cancelRead()`를 부르지 않는다(`docs/design/02-console-core.md` 5.6.5).
- 시험: `packages/xterm-readline/src/take-read.test.ts`의 "takeRead 직후 cancelRead는 읽기·화면에 아무 일도 하지 않는다"(type-ahead가 비는 것까지 확인).
