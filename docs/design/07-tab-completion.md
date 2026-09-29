# Tab 완성

> 이 문서의 규칙·상수는 이전 구현(`/work/cp949/pyodide-samples/apps/repl`, 읽기 전용 참고)이 CPython 3.14.4 pty 실측과 브라우저 회귀로 확정한 것이다. 새 구현은 통신 계층만 바꾸고(`docs/design/00-architecture.md`, `01-protocols.md`) 이 규칙은 그대로 지킨다. 절 끝의 "참고:" 경로는 이전 구현의 근거 위치다.

`complete(source, pending)` 요청은 main→worker RPC 요청이다(`01-protocols.md` 1절).

- worker는 프롬프트 대기 중(`readLine` 요청을 보내고 응답을 기다리는 동안)에만 답한다.
- `input()` 메일박스 대기 중에는 worker가 멈춰 있어 답하지 못한다. 그 구간의 Tab은 main이 무동작 처리한다.
- `pending`은 main이 넘긴다. worker는 RD-016 전까지 무시한다.

## 7.1 요청 프로토콜

- 요청: `complete(source, pending)` → 응답 `{ completions: string[], start: number }`(repl `worker/complete-source.ts`
  의 `SourceCompletion`). `source`는 커서 앞 텍스트(`buf.slice(0, pos)`), `pending`은 `... ` 블록의 이전 줄들
  (`\n`으로 이음).
- worker 핸들러: repl `worker/repl-driver.ts`가 `WorkerDriverSession.handlers`로 내고, core `bootWorker`가 core 표와 합성해 `createRpc(frame.rpcPort, …)`로 등록한다.
  - **프롬프트를 기다리는 동안(`atPrompt`)에만** 실제로 계산한다.
  - `completer`가 아직 없거나(로드 중) 실행 중에 늦게 도착한 요청은 `{ completions: [], start: 0 }`로 돌린다. 사용자 코드와 겹쳐 돌지 않게 한다.
- main: `terminal/tab-reader.ts`의 `createTabReader(readline, { complete, interruptCompletion })`가 Tab을 가로챈다.
  - `createTabReader`는 세션 소유 정책 객체다. 줄 편집기 `terminal/line-editor.ts`가 `blockHistory`·`autoIndent` 옆에서 만든다(`06-editing.md` 6.8).
  - 가로채는 수단은 벤더 readline의 **키 가로채기 공개 훅**(`ReadOptions.onKey`)이다. RD-013이 범용으로 이미 추가했다.
  - 가로채는 키는 Tab(`UnsupportedControlChar`, `data: ['\t']`)이다.
  - 이전 구현은 private `readKey`를 런타임 래핑했다. 벤더링 뒤에는 `06-editing.md` 6.1 규칙대로 private 멤버를 쓰지 않는다.
  - 노출은 둘뿐이다.
    - `readOptions(pending)`: 세대 `generation` +1, `ended=false`, `pendingBlock` 저장, `lastKeyWasTab=false`, `queuedTabs=[]`. 줄 편집기의 `begin(pending, restore)`가 `blockHistory.readOptions(pending)`·`autoIndent.readOptions(pending)`과 함께 3항을 합성한다. 합성 결과를 `promptRow.read`(RD-027, 구 `createReplReader`)의 `readOptions` thunk로 넘긴다(`06-editing.md` 6.8).
    - `readEnded(line)`: 줄 편집기의 `end(result)`가 부른다. `result.kind === "cancel"`이면 `readEnded(null)` 다음 `blockHistory.discard()`를 부른다(`06-editing.md` 6.8).
  - `getLine`·`getCursor`·`editInsert`·`tty`·`printAbove`(RD-013·RD-015가 더한 접근자)로 버퍼·커서를 읽고 고친다.
  - 응답(`applyResume`)은 **세대가 같고, 읽기가 끝나지 않았고(`!ended`), 버퍼·커서가 요청 때와 같을 때만** 적용한다.
  - 하나라도 어긋나면 완성을 버린다. 예: Enter·Ctrl+C로 읽기가 그 사이 끝났거나 다른 입력이 버퍼를 바꿨다.
  - 요청이 reject되면 무동작이고 입력은 그대로다.
- 왕복 중 들어온 Tab은 **버리지 않고 큐에 둔다**(`requesting`, `queuedTabs`).
  - 왕복이 끝난 뒤(`drainQueue`, 성공·실패 모두) 그 읽기에 이어 처리한다.
  - 다른 세대의 큐 항목은 버린다.
  - 목록 재그리기 중 들어온 키는 코어가 아니라 **벤더 `printAbove`**가 큐에 두고 순서대로 재생한다(6.1·7.3).
  - 이전 구현의 재그리기 대기 불리언·큐 이름에 해당하는 상태는 벤더 쪽 `Offscreen`(`queued`, `06-editing.md` 6.1 "재그리기 병합과 뷰 위임")으로 옮겨졌다.
  - 코어 `tab-reader.ts`에는 이 상태가 없다.
- 무동작인 Tab: `\t`도 넣지 않는다.
  - `input()` 읽기: `promptRow.read("", { cancelable })`는 `readOptions`를 넘기지 않는다. Tab이 `onKey`에 닿지 않아 벤더가 무시한다.
  - 실행 중.
  - 읽기 시작 전: 활성 읽기가 없어 벤더가 `onKey` 자체를 부르지 않는다.
- 완성 요청 중 읽기가 Ctrl+C로 취소되면(`readEnded(null)`이 `requesting === true`일 때) `interruptCompletion`(= `interruptSender.send()`)이 1회 worker의 후보 계산(무한 루프인 `__getattr__` 등)을 끊는다.
  - 사용자 프레임이 `<console>`이라 핸들러가 `KeyboardInterrupt`를 올린다.
  - `complete_source`의 `except Exception`은 `BaseException`을 잡지 않는다. 요청이 reject된다.
  - 요청이 없을 때·이미 끝난 뒤·Enter로 끝난 읽기에는 보내지 않는다.
  - `exec()`/`eval()`로 정의된 코드(파일명이 `<console>`이 아님)는 이 인식이 걸리지 않는다. 좁은 경계 사례가 남는다(`10-parity-deviations.md`).

## 7.2 스템과 공백(32칸 규칙)

- `STEM_DELIMITERS`는 pyodide `Console.completer_word_break_characters`와 같은 **33자**
  (`` ` ``~`?`까지, 공백·탭·개행 포함). 스템은 커서가 있는 논리 줄에서 마지막 구분자 뒤이고 커서 뒤
  텍스트는 보지 않는다.
- 스템이 빈 곳은 공백 `' ' * (4 - 열 % 4)`를 넣는다(`TAB_STOP = 4`). 열은 현재 논리 줄 안 위치이고
  프롬프트는 세지 않으며 `\t`는 1로 센다.
- **32칸 규칙**: 왕복 중 Tab을 큐에 두어 이어 처리하므로 Tab 8회를 간격 0ms로 눌러도 공백이 **32칸**이다
  (옛 동기 모드는 버려진 Tab 때문에 4칸이었다). 게이트가 참인 빈 스템 줄(`important = ` 등)도 마찬가지.

## 7.3 후보 표시

- 삽입: `cand[len(stem):]`을 커서 위치에 넣는다(후보 하나면 그 후보, 여럿이면 공통 접두사). 채울 것이
  없을 때만 **연속 두 번째 Tab**(`second`)이 목록을 연다. 후보 하나가 이미 입력과 같으면 목록을 열지 않는다.
  옵션 `completionPopover`가 켜져 있으면 이 목록을 아래 텍스트 대신 커서 옆 선택 상자로 띄운다(7.6).
- 목록은 열 우선이다: `CELL_GAP = 2`, 셀 폭 = 최장 후보 길이 + 2, 열 수 = `floor(터미널 열 / 셀 폭)`
  (최소 1), 행 수 = `ceil(n / 열 수)`. 후보는 스템을 포함한 전체 문자열. `LIST_CAP = 200`을 넘으면
  `...N개 더` 한 행. 열 폭은 문자열 길이 근사(전각 미반영).
- 그리는 순서: 벤더 `printAbove(text)`(`06-editing.md` 6.1)가 **같은 읽기로 앵커만 갱신해 다시 그린다**(State 재생성 없음, TRAP-17 해당 없음).
  - `text`는 `formatCompletionList`가 만든 행을 `\n`으로 이은 문자열이다.
  - `printAbove`의 처리 순서:
    1. `state.moveCursorToEnd()`. 원래 논리 커서를 먼저 저장한다.
    2. `\r\n` + `text` + `\r\n` 원시 쓰기.
    3. `term.write("", cb)` 콜백에서 `Tty.anchorRow`를 실제 물리 커서(`term.buffer.active.cursorY`)로 갱신.
    4. `State.restoreCursor(cursor)`. 저장해 둔 논리 커서 위치로 되돌린다.
    5. `State.resetLayout()`. `moveCursorToEnd()`가 남긴 옛 레이아웃을 0으로 되돌린다. 다중 행 블록 입력에서 재그리기가 옛 줄을 지우지 않게 한다.
    6. `state.refresh()`.
  - `printAbove`가 돌려주는 `Promise<void>`는 이 전체가 끝난 뒤에만 resolve한다.
  - `tab-reader.ts`의 `applyResume`이 `list` 분기에서 이 프로미스를 그대로 반환한다.
  - `.finally(drainQueue)`가 재그리기가 실제로 끝난 뒤에야 큐의 다음 Tab을 처리한다. 재그리기 중 벤더 큐를 우회해 옮겨진 커서로 계산하는 것을 막는다.
  - 콜백을 기다리는 동안 도착한 키는 벤더 `queued`에 원본 문자열째 쌓인다. 콜백에서 순서대로 재생된다. 붙여넣기 덩어리도 하나로 `readPaste` 경로를 그대로 탄다.
  - 사이에 다른 키가 끼면(재그리기가 끝난 뒤 도착한 키) 첫 Tab 규칙으로 돌아간다.
- 배경 출력과의 겹침(RD-022b, `06-editing.md` 6.1): 위 순서는 재그리기를 기다리지 않을 때다.
  - 배경 출력(`printAboveRaw`)의 재그리기를 기다리는 중에 목록이 오면 `moveCursorToEnd()`·앞 `\r\n` 없이 목록을 쓴다. 그 재그리기에 합류한다. 프로미스는 합친 재그리기가 끝난 뒤 resolve한다.
  - 목록은 배경 출력의 프롬프트 앞 접두를 비운다. 옛 입력행에 남는다(`10-parity-deviations.md` 편차 55).
  - 완성 **삽입**(`applyResume` → `editInsert`)이 배경 출력 재그리기 콜백 전에 오면 벤더는 그리지 않는다. 저장 커서 자리의 버퍼에 넣은 뒤 저장 커서를 삽입 뒤로 옮긴다. 콜백이 그 커서로 다시 그린다.
  - RD-022b 리뷰 반영: 이전에는 콜백이 커서를 삽입 전으로 되돌렸다. `imp` → Tab → ` os`가 `imp osort`로 제출됐다.
  - 경합 판정(`getCursor() === snap.pos`)은 `printAboveRaw`가 논리 커서를 옮기지 않아 그대로 통과한다.
  - 시험: repl `run-source.test.ts` "Tab 완성 응답과 배경 출력 재그리기의 겹침".
  - **재그리기 큐도 경합으로 판정한다**(RD-026):
    - 재그리기 대기 중 친 키는 벤더 `queued`에만 있다. 콜백이 재생하기 전까지 버퍼에 없어 `getLine()`·`getCursor()` 비교를 통과한다.
    - `applyResume`은 위 비교에 더해 `readline.hasQueuedInput()`(`06-editing.md` 6.1)이 참이면 삽입·목록 **둘 다** 버린다.
    - 예: `>>> imp` → Tab(완성 왕복 중) → 배경 출력(재그리기 콜백 전) → `x` → 완성 응답 → 콜백이면 완성을 버려 `impx`가 제출된다(배경 출력이 없을 때와 같다). Enter를 쳤으면 `imp`다.
    - 목록만 살리면 큐 재생 뒤 버퍼와 맞지 않는 목록이 화면에 남는다. 그래서 목록도 버린다.
    - 이전에는 완성이 큐의 키보다 먼저 버퍼에 들어갔다. `x`가 콜백에서 뒤에 재생돼 `importx`(Enter는 `import`)가 제출됐다.
    - 판정 항은 `generation`·`ended`·`getLine()`·`getCursor()`·`hasQueuedInput()` 5개다.
    - 시험: repl `run-source.test.ts` "Tab 완성 응답과 배경 출력 재그리기의 겹침"(x·Enter·목록 3개, 배경 출력 없는 대조 2개), 벤더 `print-above-raw.test.ts` "hasQueuedInput".
    - jsdom 재현·수정이다. 브라우저는 관찰하지 않았다(창이 `printAboveRaw`와 그 write 콜백 사이 메시지 태스크 한 번이다).
    - 벤더 type-ahead 버퍼는 활성 읽기가 없을 때의 것이다. Tab 왕복(읽기 중)과 겹치지 않아 `hasQueuedInput()`에 포함하지 않는다.
  - **한계**(RD-026 사후 리뷰):
    - 판정이 큐의 내용을 보지 않아 버퍼를 바꾸지 않는 키까지 경합으로 센다.
    - `Readline.dispatch()`는 재그리기 대기 중이면 Ctrl+C·Ctrl+L 같은 즉시 키도 큐에 쌓는다.
    - Tab 왕복 중 Ctrl+L을 누르면 배경 출력이 있을 때만 완성이 버려진다(없으면 버퍼가 그대로라 적용된다).
    - 위 "배경 출력 유무와 무관하게 같은 결과"는 버퍼를 바꾸는 키에 한정된다.
    - Ctrl+C는 큐 재생에서 읽기를 끝내므로 어느 쪽이든 완성이 남지 않아 차이가 없다.
    - 결과가 보수적(완성 폐기)이다. 큐 항목을 `parseInput`으로 훑어 즉시 키를 빼려면 벤더 API 의미가 복잡해진다. 그래서 고치지 않았다(사용자 확정 2026-09-25). `docs/traps/TRP-078`.

## 7.4 인덱스 변환

- Python `start`는 **코드포인트 인덱스**, `xterm-readline`의 `pos`는 **UTF-16**이다.
  `resolveCompletion`이 `[...buf.slice(0, pos)].slice(start).join('')`로 스템을 구하고 공통 접두사도
  코드포인트 단위로 계산한다(서로게이트 쌍의 절반만 남기면 삽입이 깨진다, TRAP-32).

## 7.5 모듈(`import`/`from`) 후보

- main 사전 게이트: `mentionsImportKeyword(text) = /import|from/.test(text)` — **부분 문자열, 단어 경계 없음**.
  - 입력은 커서 앞 텍스트에 `pending`을 `\n`으로 앞에 붙인 것이다(worker가 `ModuleCompleter`에 넣는 것과 동일).
  - 거짓이고 스템이 비면 왕복 없이 main이 공백을 넣는다.
  - 거짓이고 스템이 있으면 요청한다.
  - 참이면 스템이 비어도 항상 worker가 판정한다.
  - `\b` 게이트는 쓸 수 없다. `1import os` 류 5줄에서 거짓인데 파서가 반응한다(TRAP-33).
- worker 판정 순서(`complete_source(console, source, pending=None)`):
  1. `ZipStdlibModuleCompleter().get_completions`에 `pending + '\n' + source`를 넣어 결과가 `None`이 아니면
     (`[]` 포함) **그것이 최종**이다(폴백 없음). `INTERNAL_PREFIXES = ('_pyodide', '___')`로 시작하는 후보만
     빼고 정렬하지 않은 ModuleCompleter 순서 그대로 돌려준다.
  2. `None`이고 스템이 비면 공백 후보 1개 `' ' * (4 - 열 % 4)`, `start = len(source)`(공백도 후보로 돌려
     프로토콜을 바꾸지 않는다).
  3. 그 외는 `console.complete` 경로(경고 억제, 예외 삼킴, 전체 정렬, 내부 이름 제외).
- **호출마다 `ZipStdlibModuleCompleter()`를 새로 만든다**. 인스턴스가 모듈 목록을 캐시한다. 재사용하면 `loadPackage`·micropip 뒤 설치된 패키지를 놓친다.
  - 클래스 import는 worker 시작 때 1회다.
  - 후보 계산은 `sys.modules`를 바꾸지 않는다.
- zip stdlib 보정: pyodide stdlib는 `/lib/python314.zip`(zipimporter)이다.
  - 원본 `_is_stdlib_module`은 `FileFinder`만 인정한다. `HARDCODED_SUBMODULES`가 빠진다.
  - **그 판정만 오버라이드**해 zipimporter의 `archive == _stdlib_path`도 인정한다(vendoring·`pkgutil` 패치 없음).
- 3.14의 삽입 quirk도 그대로 따른다. 스템이 파싱이 아니라 구분자 기반이라 생기는 어긋남이다.
- 구현 위치:
  - worker `packages/pyodide-repl/src/worker/complete-source.py`: `ZipStdlibModuleCompleter`·`complete_source`의 모듈 분기. 클래스 import 실패는 try/except 없이 `loadCompleteSource` 실패 = 부팅 실패다(TRAP-10).
  - main `packages/pyodide-repl/src/terminal/tab-completion.ts`: `mentionsImportKeyword`와 `planTab(buf, pos, pending?)`. 스템이 빈 분기에서만 게이트를 평가한다.
  - `terminal/tab-reader.ts`가 `pendingBlock || undefined`를 넘긴다.
  - RPC 변경 없음.
- 시험 위치:
  - `worker/module-completion-parity.test.ts`: 3.14.4 pty 기준 A01~A36·X01~X04, 실제 pyodide.
  - `worker/complete-source.test.ts`: 모듈 분기·zip 보정 사전 조건·새 인스턴스·정렬 없음·게이트 안전성·quirk A37·편차 23.
  - `terminal/import-gate.test.ts`: 코퍼스 55줄 `mentionsImportKeyword`.
  - `terminal/tab-completion.test.ts`·`terminal/tab-reader.test.ts`: `planTab` 게이트 분기·`pending`·연타 큐·오래된 응답 버리기.
  - 브라우저 `apps/demo/e2e/checks/tab-check.mjs` C15(6종 8개 확인).
  - 기준 데이터는 `apps/demo/e2e/pty/rd-016/`이다(재측정 없음). 시험은 이를 읽지 않고 케이스 ID와 리터럴로 옮겨 둔다.
- `completer_word_break_characters`(pyodide `Console`)와 `tab-completion.ts`의 `STEM_DELIMITERS`는 같은 33자 문자열이다(`Console({}).completer_word_break_characters === STEM_DELIMITERS`, 2026-09-24 pyodide 314.0.7 실측).
  - worker의 모듈 분기 `start` 계산은 이 문자열을 그대로 쓴다. 둘이 어긋나면 삽입 시작 위치가 어긋난다.
  - `tab-completion.test.ts`가 33자 개수와 구분자 뒤 `indent` 판정을 고정한다.
- 알려진 차이: 편차 18(모듈 집합 178 대 192)·19·20·21·23(`10-parity-deviations.md`).

## 7.6 완성 popover(옵션, RD-049)

`ReplOptions.completionPopover?: boolean`(기본 꺼짐, `createRepl` 때만 읽음, 세터 없음)이 `true`면 7.3의 목록을 텍스트(`printAbove`) 대신 커서 옆 선택 상자(popover)로 띄운다.

- 접근안: repl 새 모듈 `terminal/completion-popover.ts`(`createCompletionPopover`)가 그리기·키·마우스·닫기·위치를 전부 소유한다. 벤더·terminal·core·worker는 바꾸지 않는다.
- `tab-reader.ts`의 `applyResume` `list` 분기: popover가 있으면 `open(completions, stem)`을, 없으면 지금 `printAbove`를 부른다(열림 시점·5조건 경합 판정 불변, W1).
- `line-editor.ts`가 세션 하나당 하나 만들어 `end()`·`dispose()`에서 닫는다(수명 = line-editor = 세션, `08-session.md` 8.1).
- React `PythonRepl`은 이 prop을 마운트 때만 `createRepl`에 명시 배선한다(15.2).

이 절이 위 규칙의 유일한 정의다. 다른 문서·`CONTEXT.md`·코드 주석은 여기를 링크만 한다(rubber-workflow "문서 갱신: 규칙은 한 곳에").

**키**(popover가 열려 있을 때, `line-editor.ts` E0 — `composeOptions` 맨 앞에 두어 blockHistory 등보다 먼저 받는다):

| ID  | 입력                                                                 | 동작                                                                      | 반환    |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------- |
| K1  | `ArrowDown`/`ArrowUp`                                                | 선택 이동, 끝에서 반대 끝으로 순환, 선택 항목이 보이게 목록 안쪽만 스크롤 | `true`  |
| K2  | `Enter`/Tab(`UnsupportedControlChar` `"\t"`)                         | 닫은 뒤 `cand`의 스템 뒤 부분(코드포인트 기준)을 `editInsert`. 제출 안 함 | `true`  |
| K3  | Esc(`Text` 데이터가 `["\x1b"]`)                                      | 입력 불변으로 닫기만                                                      | `true`  |
| K4  | 그 밖의 모든 입력(글자·Backspace·화살표 좌우·Home/End·Ctrl+C/D/L 등) | 닫고 벤더에 전달(소비 안 함, W2 겸용)                                     | `false` |
| K5  | (닫혀 있을 때) 모든 입력                                             | 무동작                                                                    | `false` |

**마우스**:

| ID  | 입력                | 동작                                                                                                           |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| M1  | 항목 클릭           | K2와 같은 적용(닫은 뒤 삽입) + `onApplied` 통지                                                                |
| M2  | popover `mousedown` | `preventDefault` + `stopPropagation`(xterm textarea focus 유지, 같은 element의 `SelectionService`로 새지 않게) |
| M3  | popover 안 휠       | 목록 안쪽 스크롤(브라우저 기본 동작, 별도 처리 없음)                                                           |

- K1~K3(`onKey`가 `true`): line-editor가 반환값으로 "Tab 리더에 안 닿은 키"를 안다. `tabReader.resetTabStreak()`를 부른다. 연속 두 번째 Tab 판정이 낡지 않게 한다.
- M1: `onKey`를 거치지 않는다. `CompletionPopover.onApplied(listener)`로 같은 신호를 낸다. 클릭 적용 뒤 Tab 한 번이 "두 번째 Tab"으로 오판되는 것을 막는다(opus 리뷰 발견).

**닫기 신호**(구독은 `open`에서 걸고 `close`에서 푼다, 닫힌 상태의 리스너 0개):

| ID  | 신호                                    | 출처                                                |
| --- | --------------------------------------- | --------------------------------------------------- |
| C1  | 읽기 끝(제출·취소·EOF·가져감)·세션 종료 | `line-editor` `end()`·`dispose()`                   |
| C2  | 터미널 쓰기 파싱(배경 출력 포함)        | `terminal.onWriteParsed`                            |
| C3  | 스크롤                                  | `terminal.onScroll`                                 |
| C4  | 크기 변경                               | `terminal.onResize`                                 |
| C5  | focus 잃음                              | `terminal.textarea`의 `blur`                        |
| C6  | 터미널 안, popover 밖 클릭              | `terminal.element`의 `mousedown`(대상이 popover 밖) |

열린 동안 popover 자신은 터미널에 쓰지 않는다(K1·K3은 소비만, K2·M1의 `editInsert`는 이미 닫힌 뒤다).

**경합**:

- W1: popover는 `applyResume` 5조건 판정(7.1) 통과 뒤에만 연다. 새 판정 조건 없음.
- W2: 열린 동안 버퍼를 바꾸는 키는 먼저 닫는다(K4) → 적용 시점 버퍼·커서 = 열 때(K2/M1도 닫은 뒤 삽입해
  이 순서를 지킨다 — `editInsert`가 던져도 이미 닫혀 있다).
- W3: 열린 뒤 `drainQueue`가 꺼내는 큐 Tab은 버린다(`handleTab`이 `isOpen`이면 반환).
- W4: 배경 출력 재그리기 대기(`Offscreen`) 중에 열리면 그 재그리기 쓰기가 C2로 닫는다(허용).

**위치·표시**:

- 셀 크기 = `.xterm-screen`의 `getBoundingClientRect()` 너비·높이 ÷ `cols`·`rows`(비공개 `_core` 금지, 9.6.5
  `react-fit-check`와 같은 계산). 좌표는 `.xterm-screen` 기준으로 계산하고, `.xterm-screen`이 `terminal.element`
  padding box에서 떨어진 거리(호스트가 준 `.xterm` padding 등)를 더해 놓는다.
- 기준: 행 `buffer.active.cursorY`, 열 `cursorX − 스템 코드포인트 수`(음수면 0). 전각 미반영(텍스트 목록과
  같은 한계).
- L1: 표시 행 = `min(후보 수, 10, 놓는 쪽 남은 행)`(최소 1). 후보는 전부 DOM에 둔다(`LIST_CAP` 미적용).
  높이 = 표시 행 × 셀 높이 + 테두리 2px. `box-sizing: border-box`라 테두리를 더하지 않으면 내용이 2px 모자란다. 후보 10개 이하에서도 스크롤된다.
- L2: 기본은 커서 행 아래. 아래 남은 행 < `min(후보 수, 10)`이고 위쪽 행이 더 많으면 커서 행 위(아래 끝이
  커서 행 위 끝에 붙는다).
- L3: 너비 = 최장 후보 × 셀 너비 + 여백 8px + 테두리 2px + 세로 스크롤바 폭(붙인 뒤 `offsetWidth − clientWidth
− 테두리`로 재어 0보다 크면 한 번 넓힌다, overlay 스크롤바는 0), 상한 화면 너비. `overflow-x: hidden`.
  오른쪽 넘침이면 왼쪽으로 민다.
- 연 뒤 위치 재계산 없음.
- DOM: `terminal.element` 안 `position: absolute`, xterm 레이어 위 `z-index`. 컨테이너 `role="listbox"`,
  항목 `role="option"`, 선택 항목 `aria-selected="true"`. class `runo-completion-popover`,
  `runo-completion-popover__item`.
- 스타일은 `open()` 시점에 읽은 값을 고정해 쓴다. 연 뒤 theme 변경은 추적하지 않는다.
  - 글꼴: `terminal.options.fontFamily`·`fontSize`.
  - 행 높이 = 셀 높이.
  - 배경 `theme.background`, 글자 `theme.foreground`. 둘 다 미지정이면 xterm 실제 기본색 `#000000`/`#ffffff`를 쓴다. 빈 문자열이면 투명·상속돼 안 보인다(opus 리뷰 발견).
  - 선택 배경: `theme.selectionBackground`. 미지정이면 xterm 기본 `rgba(255, 255, 255, 0.3)`.
  - 테두리 1px.

**한계**(범위 밖, RD-049 착수 시점 결정): 필터링·자동 열림·PageUp/Down 쪽 넘김·열린 채 재배치·테마 변경
추적·렌더러 교체 훅·runner 실행창·`input()` 안 Tab(RD-016b)·전각 폭 계산·편차 문서 등록.

- 붙여넣기·IME 다중 문자 확정은 벤더 `readPaste()`가 `onKey`를 거치지 않는다. 그 순간에는 W2가 깨질 수 있다.
- 뒤이은 C2가 결국 닫는다.
- 벤더 불변 원칙상 고치지 않는다.

**시험 위치**: `terminal/completion-popover.test.ts`(K1~K5·M1~M3·C1~C6·닫힌 뒤 DOM·리스너 0·스타일·
`onApplied`, `placePopover` L1~L3 순수 함수), `terminal/tab-reader.test.ts`(옵션 켬 `open` 분기·W1·W3·
`onApplied` 리셋), `terminal/line-editor.test.ts`(E0·C1·W4), `apps/demo/e2e/checks/completion-popover-check.mjs`
(브라우저, `?completionPopover=1`).

참고: `/work/cp949/pyodide-samples/apps/repl/docs/design/06-tab-completion.md`,
`/work/cp949/pyodide-samples/apps/repl/src/repl/{tab-completion,tab-reader,complete-source}.ts`,
`/work/cp949/pyodide-samples/apps/repl/src/repl/complete-source.py`
