# TRP-056 데모 버튼 클릭·`page.fill`이 xterm의 포커스를 가져가 뒤따르는 키가 터미널로 가지 않는다

- 상태: ACTIVE
- 적용 조건: 터미널 옆에 `textarea`·`button` 같은 폼 요소를 두고 브라우저 하니스(Playwright)가 그 요소를 조작(`page.fill`·`page.click`)한 뒤 이어서 `keyboard.type`·`keyboard.press`로 터미널에 키를 보낼 때. REPL 화면의 `run-source` 버튼처럼 앱이 클릭 뒤 터미널에 포커스를 되돌리지 않는 화면.

## 오해하기 쉬운 신호

- 요소 조작·호출·결과 칸·화면 갱신은 모두 정상이고 그 뒤 키만 사라진다. 예외도 오류 표시도 없다.
- 시간 초과 메시지가 "프롬프트 `>>>`를 기다림"·"입력이 커서 행에 그려짐"처럼 프로그램 결함으로 읽힌다. "키가 아무 일도 하지 않았다"를 단정하는 부정 확인은 조용히 통과한다.

## 원인

`fill`·`click`은 포커스를 `textarea`·`button`으로 옮긴다. 터미널 입력은 xterm의 `.xterm-helper-textarea`가 포커스일 때만 받는다. `RunnerView`는 `run()`에서 앱이 `terminal.focus()`를 부르지만 REPL 화면의 `run-source` 버튼은 치던 줄을 방해하지 않으려고 포커스를 옮기지 않는다.

## 탐지/회피

- 폼 요소를 조작한 뒤 터미널에 키를 보내기 전에 하니스의 `focus()`(`apps/demo/e2e/lib.mjs`)로 터미널 포커스를 되돌린다(`run-source-check.mjs`의 `startSource`, `reset` 버튼을 누른 셀의 `recover()`).
- 키가 사라진 실패는 시간 초과 메시지를 믿기 전에 `document.activeElement`가 `.xterm-helper-textarea`인지 확인한다.
