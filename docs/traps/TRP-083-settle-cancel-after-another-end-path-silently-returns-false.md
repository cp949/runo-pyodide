# TRP-083 `cancelRead({ settle: true })`를 다른 종료 경로 뒤에 부르면 조용히 `false`가 되어 화면 정리를 건너뛴다

- 상태: ACTIVE
- 적용 조건: settle 취소와 다른 종료 경로(`session.terminate()` 훅 안 `cancelRead()`, `takeRead()`, `dispose()`)를 한 동기 블록에서 차례로 부르는 소비자 코드를 추가하거나 순서를 바꿀 때(`packages/pyodide-repl/src/index.ts` `reset()`, `packages/pyodide-terminal/src/terminal-runner.ts` abort), core 세션 `terminate` 훅 순서를 고칠 때.

## 오해하기 쉬운 신호

- 앞 호출이 열린 읽기를 이미 끝내 settle은 아무것도 쓰지 않고 `false`를 돌려준다. 예외도 경고도 없다.
- 소비자의 `false` 대체 경로(RD-028부터 REPL·실행창 공통 재료: 벤더 `hasPendingRead()`가 참이면 무조건 `"\r\n"`, 거짓이면 현재 io 꼬리가 있을 때만 `"\r\n"`)가 커서가 입력 끝인 경우를 그대로 처리하므로 기존 시험 대부분이 통과한다. settle을 `session.terminate()` 뒤로 옮기는 변이에서 커서 끝 대조 시험은 통과했고 커서 중간·재그리기 대기 접두 시험만 실패했다.

## 원인

- settle의 상태 판정(`activeRead`·재그리기 대기)은 열린 읽기를 떼기 전이어야 한다. 앞선 종료 경로가 `activeRead`·`redraw`를 이미 비웠다.
- REPL은 core 계약상 `terminate` 훅이 settle 없는 `cancelRead()`를 부른다. 그래서 `reset()`은 `session.terminate()` **앞** 같은 동기 블록에서 settle을 부른다(`docs/design/08-session.md` 8.1).

## 탐지/회피

- settle을 종료 경로 중 가장 먼저 부른다.
- 호출 순서를 spy 인자로 단언한다(`packages/pyodide-repl/test/create-repl/reset.test.ts` "reset은 cancelRead → rpc dispose(port.close) → …": 호출 2회, 첫 호출 인자 `[{ settle: true }]`, 둘째 `[]`, 첫 호출이 `port.close`보다 앞).
- 커서 끝 시나리오만으로 판정하지 않는다. 커서 중간(`docs/traps/TRP-082`)·재그리기 대기 접두(`docs/traps/TRP-079`) VtScreen 시험을 함께 둔다.
