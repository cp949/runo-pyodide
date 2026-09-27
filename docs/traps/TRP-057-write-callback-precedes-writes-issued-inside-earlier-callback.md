# TRP-057 앞선 write 콜백 안에서 낸 write는 뒤에 건 `write("", cb)`보다 늦게 처리되고, 콜백 사이에 마이크로태스크가 돌 수 있다

- 상태: ACTIVE
- 적용 조건: 벤더 `Readline.read()`처럼 write 콜백 안에서 화면을 그리는 코드 뒤에 `terminal.write("", cb)`를 하나 걸어 "그려진 뒤"를 판정할 때. 그 콜백에서 promise를 resolve하거나 다른 promise 상태(`read.then(...)`로 내리는 플래그)나 `cursorY`(앵커)를 읽을 때.

## 오해하기 쉬운 신호

- 가짜 터미널 시험은 동기·비동기 write 두 모드 모두 통과한다. 동기 모드는 콜백을 `write` 안에서 바로 부르고, 비동기 모드의 `flush()`는 쌓인 콜백을 한 번에 부른다. 둘 다 콜백 사이에 마이크로태스크가 돌지 않고, 화면 모델(`VtScreen`)은 `write`를 부르는 순간 반영한다.
- 실제 xterm도 대부분 한 macrotask 안에서 write를 차례로 처리해 증상이 거의 보이지 않는다.
- 콜백에서 `term.buffer.active.cursorY`를 읽는 코드(벤더 재그리기 콜백의 앵커 갱신)도 같다: 벤더 `StubTerminal`·testkit `FakeTerminal`+`VtScreen`은 write를 부르는 순간 커서를 옮기고 콜백만 미루므로, `write("", cb)`를 건 **뒤**에 낸 쓰기까지 반영된 `cursorY`를 콜백이 읽는다. 실제 xterm의 콜백은 그 앞 쓰기까지만 반영된 커서를 본다. 그래서 "재그리기 대기 중 입력줄을 그리는 쓰기"(콜백 전 공개 편집 API·리사이즈)가 실제로는 앵커 뒤에 놓여 흔적 행을 남겨도 스텁 화면 시험은 통과할 수 있다(RD-022b 리뷰: 감긴 입력의 콜백 전 `editInsert` 흔적 가설이 스텁에서 재현되지 않았다).

## 원인

xterm `WriteBuffer`는 write를 순서대로 파싱하고, 각 write를 처리한 직후 그 콜백을 부른다. 콜백 안에서 낸 write는 큐 끝에 붙는다. 그래서 `read()`(그리기 콜백 A 등록) 직후에 건 `write("", B)`의 B는 A 뒤에 불리지만, A 안에서 낸 프롬프트 그리기 write보다는 앞에 불린다. 또 처리가 시간 예산(12ms)을 넘으면 `setTimeout`으로 넘기므로 A와 B 사이에 마이크로태스크가 돌 수 있다. 예를 들어 A가 재생한 type-ahead Enter로 읽기가 끝나면 `read.then`의 정리가 B보다 먼저 돈다.

## 탐지/회피

- "그려진 뒤"는 B 안에서 `write("", C)`를 한 번 더 걸어 C에서 판정한다. C는 A 안에서 낸 그리기 write보다 뒤에 큐에 선다.
- B에서는 `read.then`이 내리는 상태 플래그에 의존하지 않는다. 세대 번호(`seq`)로 늦은 콜백만 거른다.
- 시험은 write를 하나씩 화면에 반영하고 콜백 뒤 macrotask를 넘기는 모델로 쓴다. repl `run-source.test.ts`의 `serialWrites`, 사후 리뷰 describe가 예다.
- 콜백이 앵커(`cursorY`)를 읽는 경로는 화면이 아니라 쓰기 바이트로 단정한다: `write("", cb)`를 건 뒤 콜백 전까지 입력줄을 그리는 바이트가 없어야 한다(`term.log`를 비우고 콜백 전 호출 뒤 빈 문자열인지 확인). 예: 벤더 `print-above-raw.test.ts` "재그리기 대기 중 editInsert·editBackspace·updateLine은 화면에 아무것도 쓰지 않는다".
- 사례: RD-022a `runSource` 정착(`packages/pyodide-repl/src/repl-main-driver.ts`의 `readLine` 핸들러 `onOpen` 콜백, RD-029로
  `terminal/source-bridge.ts` `readOpened`를 흡수), `docs/design/02-console-core.md` 5.6.4.
