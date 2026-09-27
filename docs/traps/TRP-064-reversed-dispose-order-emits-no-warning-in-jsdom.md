# TRP-064 컴포넌트 정리 순서(하위 핸들 → `Terminal`)를 뒤집어도 콘솔 경고·예외가 없어 경고 단언으로는 순서 회귀를 못 잡는다

- 상태: ACTIVE
- 적용 조건: `pyodide-repl-react` 컴포넌트(`PythonRunner`·`PythonRepl`)의 cleanup 순서를 바꾸거나 새 컴포넌트에 같은 정리 코드를 만들 때, 또는 그 순서를 지키는지 시험할 때(`docs/design/14-runner.md` 14.5.5: runner를 먼저 끝내고 화면을 뗀다).

## 오해하기 쉬운 신호

- `terminal.dispose()`를 하위 핸들 `dispose()`보다 먼저 불러도 jsdom 실제 xterm에서 `console.warn`(`docs/traps/TRP-004`의 `DisposableStore`)·예외가 나지 않는다. 코드 주석 "순서를 바꾸면 TRP-004 경고가 난다"를 믿고 콘솔 warn 수집 단언만 시험에 두면 순서를 뒤집은 변이가 통과한다(경고 단언만 남기고 순서 단언을 지워 직접 확인).
- StrictMode 브라우저 L1(콘솔 warning 0)도 통과한다.

## 원인

두 `dispose()`가 같은 동기 cleanup 안에 있어 그 사이에 xterm write 콜백이 끼지 않는다. terminal 러너의 `disposed` 가드는 `runner.dispose()`가 세우고 벤더 `Readline.dispose()`가 `term`을 비우므로, 순서를 뒤집어도 dispose된 `Terminal`을 만지는 콜백이 없다. 순서 규칙은 열린 읽기의 abort가 `cancelRead()`를 돌리는 것이 화면 정리보다 앞서야 한다는 계약이지 경고로 드러나는 결함이 아니다.

## 탐지/회피

- `Terminal.prototype.dispose`를 `vi.spyOn`으로 감싸 호출 시점의 살아 있는 worker 수를 기록한다. 기대 `[0, 0]`, 뒤집으면 `[1, 1]`(`packages/pyodide-repl-react/src/terminal-component.contract.test.tsx`의 `$name: xterm·worker 수명` > "정리 순서는 하위 먼저 terminal 나중이다(…)"가 `PythonRunner`·`PythonRepl` 두 adapter 모두에서 같은 시험, RD-038 계약 suite로 통합).
- 변이 검사에 "cleanup 순서 뒤집기"를 넣고 killed인지 확인한다. 경고 단언만으로 killed를 판정하지 않는다.
