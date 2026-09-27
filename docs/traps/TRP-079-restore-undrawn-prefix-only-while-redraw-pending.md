# TRP-079 재그리기 대기 중 cancelRead() 뒤 접두 복원은 abovePrefix()가 아니라 undrawnAbovePrefix()여야 한다

- 상태: ACTIVE
- 적용 조건: settle 없이 `Readline.cancelRead()`를 부르는 곳(현재 REPL main driver의 `terminate` 훅 — REPL 리셋에서는 앞선 `cancelRead({ settle: true })`가 이미 읽기를 끝내 무동작이다 — 과 `dispose()` 중 실행창 abort)에서 배경 출력 접두를 화면에 남기려 할 때, `cancelRead()` 호출자를 새로 더할 때, 벤더 `settleScreen()`의 재그리기 대기 분기(private `undrawnAbovePrefix()`)를 고칠 때.
- 갱신(2026-09-26): 접두 복원을 소비자(`packages/pyodide-repl/src/index.ts` `reset()`, `packages/pyodide-terminal/src/terminal-runner.ts` 실행창 abort)에서 벤더 `cancelRead({ settle: true })`로 옮기고 `undrawnAbovePrefix()`를 private으로 내렸다. 아래 신호·원인은 settle 없는 취소와 `settleScreen()` 구현에 그대로 해당한다. 당시 적용 조건은 "`cancelRead()`를 부르는 곳(`reset()`, 실행창 abort)에서 배경 출력 접두를 화면에 남기는 코드를 추가·수정할 때"였다.

## 오해하기 쉬운 신호

- `abovePrefix() !== ""`이면 접두를 쓰는 코드가 재그리기 콜백 전 취소(접두가 화면에서 사라지는 결함) 시험을 통과한다.
- 같은 코드가 재그리기가 끝난 뒤 취소에서는 접두를 두 번 낸다(`tick>>> pritick`). 콜백 뒤 접두는 프롬프트 행에 이미 그려져 있는데 `abovePrefix()`는 콜백 전후 같은 값이다. 재그리기 뒤 취소를 확인하는 대조 시험이 없으면 통과처럼 보인다.
- 실행창 abort에서 `sinks.write`로 접두를 쓰면 열린 읽기가 아직 남아 있어 그 쓰기가 `printAboveRaw` 경로로 가 다시 재그리기를 건다.

## 원인

- 벤더 `cancelRead()`는 화면에 아무것도 쓰지 않는 것이 계약이다. 재그리기 대기 중에는 입력줄이 접두째 지워져 있고 취소가 그 재그리기를 무효로 만들어 접두가 화면에 없게 된다.
- 재그리기 대기 여부는 벤더 밖에서 알 수 없다.

## 탐지/회피

- 화면에 남겨야 하는 취소는 `cancelRead({ settle: true })`를 부른다. 벤더가 private `undrawnAbovePrefix()`(재그리기 대기 중일 때만 `abovePrefix()`, 그 밖에는 `""`)로 판정해 재그리기 대기 중에만 `prefix + "\x1b[0m\r\n"`을 벤더 `write`로 쓴다. 소비자가 `abovePrefix()`로 접두를 직접 복원하지 않는다. settle은 종료 경로 중 가장 먼저 부른다(다른 `cancelRead()` 뒤면 조용히 `false`).
- RD-026 당시 회피(소비자 코드): `undrawnAbovePrefix()`를 `cancelRead()` 앞에서 읽어 비어 있지 않으면 `prefix + "\x1b[0m"`을 썼다. `reset()`은 뒤에 `\r\n`을 붙이고 실행창 abort는 뒤이은 기존 `\r\n`에 이었다. 실행창 abort는 벤더 `write`로 직접 썼다.
- `dispose()`·terminate 훅의 settle 없는 `cancelRead()`는 화면에 쓰지 않는 규칙이라 복원하지 않는다.
- 시험은 재그리기 콜백 전 취소(접두가 남는다)와 재그리기가 끝난 뒤 취소(접두를 다시 쓰지 않는다) 대조를 짝으로 둔다(repl `run-source.test.ts` "재그리기 대기 중 reset()의 접두 복원(이슈 13)", terminal `terminal-runner.test.ts` "재그리기 대기 중 abort의 접두 복원(이슈 13)", 벤더 `print-above-raw.test.ts` "아직 그리지 않은 접두와 settle 취소(이슈 13)"·`cancel-settle.test.ts` "cancelRead({ settle: true }) 재그리기 대기 중").
