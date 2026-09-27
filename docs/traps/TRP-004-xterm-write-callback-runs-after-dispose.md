# TRP-004 xterm write 콜백은 `term.dispose()` 뒤에도 실행되고, 그 안의 `buffer` 접근은 경고만 남긴다

- 상태: ACTIVE
- 적용 조건: `term.write(text, callback)`의 콜백 안에서 `term`(`buffer`, `cols` 등)에 접근하는 코드를 추가하거나 고칠 때(`Readline.read()`, 꼬리 재그리기, sink, tab-reader). 마운트 직후 읽기를 시작하는 코드를 React StrictMode(mount → cleanup → mount) 아래에서 쓸 때.

## 오해하기 쉬운 신호

- 예외가 나지 않는다. dev 브라우저 콘솔에 `console.warn`(`Trying to add a disposable to a DisposableStore that has already been disposed of. The added object will be leaked!`)만 남고 동작은 정상으로 보인다.
- jsdom + 가짜 터미널 시험은 통과한다. 가짜가 dispose 뒤 콜백을 막거나 `buffer` 접근을 세지 않으면 이 결함은 시험에 보이지 않는다.
- 꼬리가 짧거나 없으면 통과한다. `rewindTail`은 짧은 꼬리(`tail.length * 2 < term.cols`)에서 flush 없이 반환해 dispose 뒤 콜백이 `Readline.read()`의 것뿐이고, 벤더가 `term === undefined`로 막는다. 폭을 넘는 꼬리가 flush를 기다리는 중에 dispose되는 경로만 결함이 드러난다(동기 write 모드에서는 콜백이 dispose 전에 실행돼 보이지 않는다).
- 프로덕션 번들은 StrictMode 이중 마운트를 하지 않아 preview에서는 나타나지 않는다.

## 원인

xterm의 `write`는 파싱을 타이머로 미루고 `term.dispose()`는 대기 중인 write 콜백을 취소하지 않는다. 콜백이 뒤늦게 실행되어 이미 dispose된 `Terminal`의 `buffer` getter를 읽으면 해제된 `DisposableStore`에 항목을 등록하려다 경고한다. `Readline.read()`는 입력 상태를 이 콜백 안에서 만든다.

## 탐지/회피

- 회피: 콜백 시작부에서 해제 여부를 보고 되돌아간다. `Readline.dispose()`는 `term`을 비우고(콜백의 `term === undefined` 가드가 작동한다) 대기 중인 읽기(콜백 대기 중인 것 포함)를 reject한다. 새 콜백 소비자도 같은 가드를 둔다.
- 회피(꼬리 정리): `rewindTail`의 flush 콜백은 해제 여부를 알 수 없다. terminal 패키지 surface(`packages/pyodide-terminal/src/surface.ts`)의 `openIo()`가 `close()` 뒤에는 write 콜백을 전달하지 않는 터미널 뷰(`io.terminal`)를 돌려주고, `createRepl`(세션 `terminate` 훅)과 `createTerminalRunner`(`dispose()`)가 수명이 끝나는 지점에서 `io.close()`를 부른다. `rewindTail` 시그니처는 바꾸지 않는다. `promptRow`(RD-027, `packages/pyodide-terminal/src/prompt-row.ts`)가 "현재 io"로 보는 `PromptRowIo.terminal`도 같은 뷰를 받는다.
- 탐지(단위): surface 시험(`surface.test.ts`)과 소비자 시험이 가짜 터미널의 `disposedBufferReads`를 본다. 가짜 터미널이 `dispose()` 뒤에도 콜백을 돌리고 그때의 `buffer` 읽기를 `disposedBufferReads`로 센다. `createRepl`의 "`dispose` 직후 `terminal.dispose()`" 시험이 이 값이 0인지 본다. 꼬리 정리 경로는 비동기 모드에서 100자 꼬리를 쓰는 "폭을 넘는 꼬리를 정리하려고 flush를 기다리는 중에 dispose해도 …" 시험이 본다(터미널 뷰의 해제 가드를 지우면 이 시험 하나가 `disposedBufferReads` 3으로 실패한다).
- 탐지(브라우저): dev(StrictMode)에서 콘솔 warning이 0건인지 확인한다. 벤더 `dispose()`의 `term` 해제를 지우면 이 확인이 실패한다(양성 대조).
- 재현: 실제 `@xterm/xterm` 6.0.0을 jsdom에서 `open()` 없이 만들어 `write("", cb)` 직후 `dispose()`하고 콜백에서 `term.buffer`를 읽으면 경고가 난다.
