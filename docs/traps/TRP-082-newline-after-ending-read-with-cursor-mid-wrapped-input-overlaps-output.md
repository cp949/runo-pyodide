# TRP-082 커서가 감긴 입력 중간에 있을 때 읽기를 끝내고 바로 개행하면 뒤 출력이 입력 위에 겹친다

- 상태: ACTIVE
- 적용 조건: 활성 읽기를 코드로 끝낸 뒤(`cancelRead()`·`takeRead()`·새 종료 경로) 화면에 개행·출력을 이어 쓰는 코드를 추가·수정할 때, 그 경로의 시험을 쓸 때. 입력이 터미널 폭보다 길어 여러 행으로 감길 수 있는 모든 읽기(REPL 줄, 실행창 `input()`)에 해당한다.

## 오해하기 쉬운 신호

- 입력을 친 뒤 바로 취소하는 시험은 커서가 입력 끝(감긴 입력의 마지막 행)에 있어 개행이 입력 아래 행에서 난다. 한 행 입력이나 커서 끝 시나리오만 있으면 전부 통과한다.
- 커서가 감긴 입력의 첫 행에 있으면(Home, ←) 개행이 입력 둘째 행 위에서 나고 뒤 출력이 그 행을 덮는다. 열 20·30자 입력·Home 뒤 실행창 abort + `Traceback` 출력 → 화면 `"x: abcdefghijklmnopq"` / `"Traceback0123"`. REPL 리셋은 입력 둘째 행이 안내 줄 `[세션 리셋됨 — …]`에 덮여 사라진다. 원시 바이트(`"\r\n"` 한 번)는 커서 끝 경우와 같아 바이트 단언으로도 구분되지 않는다.

## 원인

- 벤더 `State`의 물리 커서는 논리 커서 자리(감긴 입력의 중간 행)에 있다. 읽기를 끝내는 것만으로는 커서가 움직이지 않는다. 벤더 Enter·취소 가능한 Ctrl+C·`printAbove`는 쓰기 전에 `moveCursorToEnd()`를 부르지만 소비자가 직접 쓴 `"\r\n"`은 그러지 않았다.

## 탐지/회피

- 화면에 남기는 종료는 벤더 `cancelRead({ settle: true })`를 쓴다(그려진 활성 읽기면 `moveCursorToEnd()` → `refreshUnhighlighted()` → `"\r\n"`, `docs/design/06-editing.md` 6.1). 새 벤더 종료 경로도 쓰기 전에 커서를 입력 끝으로 옮긴다.
- 시험은 VtScreen(`@repo/pyodide-testkit/vt-screen`)으로 좁은 폭(열 20)·감긴 입력·Home 커서 시나리오와 커서 끝 대조를 짝으로 둔다. 입력 두 행과 뒤 출력이 서로 다른 행에 온전히 남는지 행 단위로 본다(terminal `terminal-runner.test.ts` "abort 뒤 출력 위치: 벤더 settle·그리기 전 대체 개행", repl `run-source.test.ts` "감긴 입력 중간 커서에서 reset()", 벤더 `cancel-settle.test.ts` "cancelRead({ settle: true }) 그려진 활성 읽기").
