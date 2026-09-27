# TRP-045 읽기가 열리기 전에 온 abort는 `cancelRead()`가 무동작이라 죽은 읽기가 나중에 열린다

- 상태: ACTIVE
- 적용 조건: `InputProvider`가 `signal` abort 시 `Readline.cancelRead()`로 읽기를 끝내는 구조에서, provider 안에서 `readline.read()`를 부르기 전에 `await`가 있는 경우. `promptRow.read()`(RD-027, 구 `stdin-reader`)는 시작에 `await rewindTail(...)`(긴 꼬리면 write 콜백 flush 대기)를 거친 뒤에야 `readline.read()`를 연다.

## 오해하기 쉬운 신호

- abort 리스너가 `cancelRead()`를 부르고 "읽기를 끝냈다"고 보이지만, 그 시점에 열린 읽기가 없으면 `cancelRead()`는 아무것도 하지 않는다. flush가 끝난 뒤 `readline.read()`가 열려 아무도 끝내지 않는 읽기가 남고, 사용자가 다음에 친 Enter가 이 죽은 읽기에 들어간다.
- 꼬리가 짧으면(`tail.length * 2 < cols`) flush를 기다리지 않아 재현되지 않고, 꼬리가 폭의 절반 이상일 때만 나타난다. 짧은 꼬리 시험은 모두 통과한다.

## 원인

- abort 검사와 읽기 열기 사이에 `await`가 있다.

## 탐지/회피

- `promptRow.read(prompt, options)`가 flush 대기 뒤 `options.signal?.aborted`를 다시 보고 열지 않은 채 `null`을 돌려준다. 새 provider를 만들 때도 마지막 `await` 뒤 abort를 다시 확인한다.
- 시험: `prompt-row/read.test.ts`(RD-027, 구 `stdin-reader.test.ts`)의 "꼬리 정리를 기다리는 사이 signal이 abort되면 읽기를 열지 않고 null을 돌려준다", `terminal-runner.test.ts`의 "긴 꼬리를 정리(flush 대기)하는 사이 abort되면…"(비동기 write 콜백 + 꼬리 50자).
