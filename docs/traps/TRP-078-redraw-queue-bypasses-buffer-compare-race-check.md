# TRP-078 재그리기 대기 중 친 키는 벤더 큐에만 있어 버퍼 비교 경합 판정을 통과한다

- 상태: ACTIVE
- 적용 조건: 비동기 응답(Tab 완성 등)을 `readline.getLine()`·`getCursor()`를 응답 전 스냅샷과 비교해 적용할지 판정하는 코드를 추가·수정할 때(`packages/pyodide-repl/src/terminal/tab-reader.ts` `applyResume`), 배경 출력(`printAboveRaw`)·Tab `printAbove` 재그리기 대기 중 공개 편집 API(`editInsert`·`editBackspace`·`updateLine`)를 부르는 호출자를 추가할 때.

## 오해하기 쉬운 신호

- 배경 출력이 없으면 같은 시나리오(`imp` → Tab 왕복 중 `x` → 완성 응답)에서 버퍼가 달라져 완성을 버리고 `impx`가 제출되므로 판정이 정상으로 보인다. 배경 출력 없는 대조 시험이 통과한다.
- 재그리기 콜백 전에 친 키만 다르다: 완성 삽입이 먼저 버퍼에 들어가고 `x`는 콜백에서 뒤에 재생돼 `importx`(Enter면 `import`)가 제출된다. 사용자는 치지 않은 코드가 제출된다.
- 실제 브라우저에서는 창이 `printAboveRaw`와 그 write 콜백 사이의 메시지 태스크 한 번이라 e2e로는 보이지 않는다.

## 원인

- 재그리기 대기 중(`redrawing`) 도착한 키는 벤더 `queued`에 원본 문자열째 쌓였다가 write 콜백에서 재생된다. 그때까지 버퍼(`getLine()`)와 커서(`getCursor()`)에 반영되지 않아 버퍼 비교가 경합을 보지 못한다.
- 공개 편집 API는 재그리기 대기 중 곧바로 버퍼에 들어가므로 도착 순서(키 → 편집)가 뒤집힌다.

## 탐지/회피

- 경합 판정에 `readline.hasQueuedInput()`(`redrawing && queued.length > 0`)을 함께 넣고, 참이면 삽입·목록 둘 다 버린다(`applyResume` 현재 구현). 목록만 살리면 큐 재생 뒤 버퍼와 맞지 않는 목록이 화면에 남는다.
- 시험은 write 콜백을 미루는 하니스가 필요하다(벤더 `print-above-raw.test.ts`의 `asyncWrite`·`flush()`, repl `run-source.test.ts` "Tab 완성 응답과 배경 출력 재그리기의 겹침"). 대조(배경 출력 없음)와 겹침 시험을 짝으로 둔다.
- 활성 읽기가 없을 때 쌓이는 type-ahead 버퍼는 `hasQueuedInput()`에 포함되지 않는다. Tab 왕복은 읽기 중이라 그 버퍼와 겹치지 않는다.
- `hasQueuedInput()`은 큐의 **내용**을 보지 않는다. `dispatch`가 재그리기 대기 중에는 Ctrl+C·Ctrl+L 같은 즉시 키도 큐에 쌓으므로, Tab 왕복 중 Ctrl+L은 배경 출력이 있을 때만 완성을 버리게 한다(RD-026 사후 리뷰). 결과가 보수적(완성 폐기)이라 고치지 않았다 — "배경 출력 유무와 무관하게 같은 결과"를 시험 제목·문서에 쓸 때는 버퍼를 바꾸는 키로 한정한다.
