# TRP-058 스텁 터미널에서 "콜백 하나 실행"은 재그리기 콜백이 아니라 앞에 쌓인 워터마크 콜백을 실행한다

- 상태: ACTIVE
- 적용 조건: 벤더 `Readline` 시험에서 write 콜백을 미루는 스텁 터미널(`asyncWrite`)의 대기열을 `shift()` 한 번 등으로 하나씩 실행해 "재그리기 콜백 하나"·"`read()` 그리기 콜백 하나"의 순서를 재현할 때(겹친 `printAbove`·`printAboveRaw`, 재그리기 대기 중 `takeRead`·키 큐 시험).

## 오해하기 쉬운 신호

- 수정 전 소스에서 시험이 기대한 단정으로 실패해(`expected 3 to be 2`) 결함 재현(RED)처럼 보인다. 실제로는 재그리기 콜백이 한 번도 돌지 않은 상태의 값이다 — 이유가 다른 RED다.
- 구현 뒤에도 GREEN이 되지 않아 구현 결함을 찾게 된다(같은 하니스로 쓴 `flushOne()` 시험 여러 건이 함께 실패한다).

## 원인

벤더 `Readline.write()`는 비어 있지 않은 모든 쓰기에 워터마크용 write 콜백을 건다. 그래서 대기열에는 재그리기·`read()`의 빈 write 콜백(`term.write("", cb)`) 앞에 출력 쓰기의 워터마크 콜백이 먼저 쌓여 있다. 대기열 머리 하나를 실행하면 워터마크 콜백만 실행된다.

## 탐지/회피

- 대기열 항목에 쓰기 텍스트를 함께 두고, 빈 write(`text === ""`)의 콜백을 만날 때까지 앞 항목을 실행한다. 예: `packages/xterm-readline/src/print-above-raw.test.ts`의 `StubTerminal.flushOne()`.
- 하니스를 고친 뒤에는 RED를 원래 소스에서 다시 확인한다(`git stash push <소스 파일>` → 시험 → `git stash pop`). 처음 본 RED는 근거로 쓰지 않는다.
- 콜백 순서가 핵심인 시험은 실행한 콜백 수가 아니라 화면·커서 상태(`VTerm`)로 단정한다.
