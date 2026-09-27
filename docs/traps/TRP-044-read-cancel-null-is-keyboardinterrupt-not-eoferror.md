# TRP-044 `input()` 읽기 취소(`null`)는 `EOFError`가 아니라 `KeyboardInterrupt`다

- 상태: ACTIVE
- 적용 조건: main 쪽에서 `readInput`·`InputProvider`의 결과 `null`을 "입력 없음(EOF)"의 뜻으로 쓰는 설계·소비자(`inputProvider`가 입력 끝을 `null`로 돌려주는 React·canvas 래퍼). provider 없는 runner의 `input()`을 기대할 때.

## 오해하기 쉬운 신호

- 설계 문서나 가짜 worker 시험(메일박스 `CANCELLED` 상태 확인)은 통과한다. 실제로는 `input()`이 `EOFError`가 아니라 `KeyboardInterrupt`로 끝나고 run의 결과는 `interrupted`이며 트레이스백이 나온다.
- 빈 문자열 `""`은 EOF가 아니다: pyodide가 `\n`을 붙여 빈 줄이 된다.
- RD-048로 메일박스에 EOF 상태(`STATE_EOF`)가 생긴 뒤에도 이 함정은 그대로다 — EOF 표식은 `null`이 아니라 별도 값 `STDIN_EOF`(`unique symbol`, `@cp949/runo-pyodide-core`)로 표현된다. `InputProvider`가 `null`을 돌려주면 지금도 취소다.

## 원인

- (RD-048 전) 메일박스 프로토콜에 EOF 상태가 없었다(IDLE·READY·CANCELLED·ERROR). CANCELLED = 읽기 취소이고 worker stdin 콜백이 이를 `signalInterrupt` + `checkInterrupt`로 바꿔 `input()` 호출 지점의 `KeyboardInterrupt`를 만든다(`docs/design/04-stdin-input.md` 3.1). `null`을 그대로 돌려 `EOFError`를 만드는 대안은 취소가 아니라는 이유로 기각된 경로였다.
- (RD-048 후) EOF 상태(`STATE_EOF = 4`)가 생겼지만 `null`의 뜻은 바뀌지 않았다 — `null`은 여전히 취소 전용이고, EOF는 `MailboxWriter.eof()`·`STDIN_EOF`라는 별도 값을 거친다(`docs/design/06-editing.md` 6.9, `01-protocols.md` 2.2). 값 하나(`null`)에 취소·EOF 두 뜻을 실은 적이 없다.

## 탐지/회피

- `InputProvider`가 입력 끝을 알리려면 `null`이 아니라 `STDIN_EOF`를 돌려준다(`docs/design/14-runner.md` 14.4). `null`을 돌려주면 `input()`은 `KeyboardInterrupt`이고 결과는 `interrupted`다.
- 시험은 가짜 worker가 아니라 실제 pyodide worker 스레드로 본다: `session/runner-pyodide.test.ts`의 "provider가 없으면 input()은 읽기 취소를 받는다"(취소)와 "EOFError를 잡은 뒤 같은 run에서 input()을 다시 부르면 provider가 다시 불린다"(EOF, `STDIN_EOF`)를 구분해서 본다.
