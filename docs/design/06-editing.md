# 편집: 벤더링한 xterm-readline·자동 들여쓰기·블록 히스토리·붙여넣기·선택 복사

> 이 문서의 규칙·상수 근거는 CPython 3.14.4 pty 실측과 브라우저 회귀다.

## 6.1 xterm-readline 사용 방식

- 소스를 **`packages/xterm-readline`(`@cp949/runo-xterm-readline`)으로 벤더링**한다([ADR-0003](../adr/0003-vendor-xterm-readline.md)).
  - upstream은 strtok/xterm-readline 1.2.2(MIT)다.
  - `LICENSE-MIT`와 저작권 고지를 패키지에 유지한다.
- 수정 방침:
  - 아래 6.2 표의 수정 중 **TRAP-13(`readPaste` 탭 보존)·TRAP-15/TRAP-12(재그리기 전제)·TRAP-17(`moveCursorBack` 단위)은 소스에서 직접 고친다**.
  - `read()`의 write 콜백 타이밍(TRAP-14)은 공개 옵션 `ReadOptions.prefill?: string`으로 계약을 명시한다.
    - RD-013 완료: write 콜백 안, `new State` 직후 1회 채운다.
    - "onInputReady 콜백/ready Promise" 초안은 채택하지 않았다(6.3).
  - `InputType`은 export해 상수 복제를 없앤다.
  - `History`에 삭제 API(`replaceFrom`·`truncate` 류)는 추가하지 않았다(RD-014 결정).
    - 블록 히스토리는 `restore(entries)`로 스냅샷을 되돌리는 것만으로 충분하다.
    - 삭제 전용 API는 코어가 쓸 일이 없다.
- `History`의 `localStorage` 자동 저장·복원은 옵션으로 끈다. no-op 덮어쓰기 대신 생성자 옵션 `persist: false`를 쓴다.
- `Readline.dispose()`:
  - 리스너를 해제하고 `term`을 비운다.
  - 대기 중인 읽기를 `Error("readline disposed")`로 reject한다. write 콜백 대기 중이라 `activeRead`가 없는 읽기도 포함한다.
  - 두 번째 호출은 무동작이다(RD-003). `term.dispose()`가 로드된 addon을 다시 dispose하므로 멱등이 필수다.
  - dispose 뒤 `read()`는 reject한다. `println`·`print`는 터미널에 쓰지 않는다.
  - 실제 xterm 6은 `term.dispose()` 뒤에도 write 콜백을 돌린다. 그 안의 `term.buffer` 읽기는 `DisposableStore` 경고를 낸다.
- `Tty`·`State`·`InputType`·`History`를 패키지에서 export한다.
  - 코어(`packages/pyodide-repl`)는 이 export만 쓰고 private 멤버에 손대지 않는다.
  - 코어가 필요로 하는 진입점은 벤더에 **공개 훅**으로 추가한다.
  - 입력 준비 알림(프리필): `ReadOptions.prefill`, RD-013 완료.
  - 키 가로채기: `ReadOptions.onKey`. RD-013이 범용으로 추가했다. Tab은 RD-015가 그 훅을 그대로 쓴다(`07-tab-completion.md` 7.1).
  - 입력줄 위 출력: `Readline.printAbove(text: string): Promise<void>`, RD-015 완료.
    - 활성 읽기를 그대로 둔 채 입력줄 위에 텍스트를 찍고 같은 읽기로 다시 그린다.
    - 재그리기 중 들어온 키는 큐에 쌓았다가 순서대로 재생한다.
    - 활성 읽기가 없으면 `println`과 같다.
    - 규칙은 `07-tab-completion.md` 7.3. 겹침·접두 규칙은 아래 RD-022b 항목.
  - 열린 읽기 위 원시 출력: `isReading`·`abovePrefix`·`printAboveRaw`, RD-022b 완료, 아래 항목.
  - 키 이벤트 가로채기: `ReadlineOptions.onKeyEvent?: (event: KeyboardEvent) => boolean`, RD-017 완료.
    - xterm `attachCustomKeyEventHandler` 수준에서 벤더 처리 앞에 불린다.
    - `true`면 xterm 기본 처리를 생략한다.
    - 선택 중 Ctrl+C 복사가 쓴다(6.6).
  - 붙여넣기 탭 보존(TRAP-13)은 훅이 아니라 `readPaste` 소스 수정으로 했다(RD-011 완료).
    - `readPaste`의 매핑 단계에서 `UnsupportedControlChar` + 단일 `\t` 토큰만 `Text`로 승격한다.
    - Tab은 REPL 읽기의 `onKey`(Tab 리더, `createTabReader`)가 소비한다.
    - `input()` 읽기는 `readOptions`가 없어 벤더가 그대로 무시한다(RD-015 완료).
- RD-019가 소스에 더한 내부 동작: 활성 읽기가 없는 구간에 들어온 키를 `Readline`이 쌓았다가 다음 읽기에서 재생한다.
  - 공개 API 추가는 없다. `index.ts` 값 export 목록은 불변이다.
  - 규칙은 6.7.
- RD-022가 소스에 더한 공개 옵션: `ReadlineOptions.typeAhead?: boolean`.
  - 기본 `true`는 위 type-ahead 동작 그대로다. `=== false`일 때만 끈다.
  - 끄면 활성 읽기가 없는 구간에 들어온 입력(키·붙여넣기·IME `onData`·Shift+Enter)을 쌓지 않고 버린다.
  - Ctrl+C·Ctrl+L 단독 입력은 그대로 즉시 처리한다. Ctrl+C는 `setCtrlCHandler` 핸들러를 부른다.
  - `printAbove` 재그리기 중 `queued`는 대상이 아니다.
  - 생성 시 고정이다. 런타임 토글은 없다.
  - 실행창(`createTerminalRunner`)이 `false`로 만든다(`14-runner.md` 14.5.2).
  - 차단은 `pushTypeAhead` 한 곳이다.
  - 변경 목록은 `packages/xterm-readline/README.md`.
- RD-008이 소스에 더한 공개 API: `read(prompt: string): Promise<string>` / `read(prompt: string, options: ReadOptions): Promise<string | null>` 오버로드와 `ReadOptions = { cancelable?: boolean }`.
  - `cancelable` 기본값 `false`는 원본 `^C` + 같은 프롬프트 재그리기다.
  - `cancelable`이면 활성 읽기 중 Ctrl+C가 읽기를 `null`로 끝낸다(6.3).
  - 오버로드라 기존 `read(prompt)` 호출부의 반환형은 `Promise<string>`으로 남는다.
  - `ReadOptions`도 export한다.
- RD-010이 더한 `cancelRead(options?: { settle?: boolean }): boolean`.
  - 열린 읽기(활성 읽기 + `read()`의 write 콜백을 기다리는 읽기)를 `ReadCancelledError`(export)로 끝내는 **프로그램에 의한** 취소다.
  - `dispose()`와 달리 리스너·`term`·history·state는 건드리지 않는다.
  - `settle`을 주지 않거나 `false`면 화면에 아무것도 쓰지 않고 `false`를 돌려준다.
    - 커서 이동·개행·재그리기가 없다. 개행 여부는 호출자가 결정한다(`08-session.md`).
    - RD-010 계약 그대로다. `dispose()`·크래시·`terminate` 훅 경로가 쓴다.
  - 콜백이 아직 오지 않은 읽기는 `dispose()`처럼 콜백 안에서 취소 여부를 확인한다. 늦게 온 콜백이 `activeRead`를 되살리지 않는다.
  - 열린 읽기가 없으면 읽기·화면에 대해서는 무동작이다.
  - 단 쌓인 type-ahead·`offscreen.queued`를 비우고 `offscreen`을 무효화하는 일은 열린 읽기 유무와 무관하게 먼저 실행된다(6.7, `docs/traps/TRP-053`).
  - 코어의 `reset()`(settle 취소)과 실행창 abort가 열린 읽기를 끝내는 데 쓴다(`08-session.md` 8.1, `14-runner.md` 14.5.3).
  - **`settle: true`**: 열린 읽기를 떼기 **전에** 취소 시점 상태를 보고 화면을 정리한다(private `settleScreen()`).
    - 반환값은 "호출 뒤 커서가 입력·접두 아래 행 머리임을 Readline이 보장했는가"다.

    | 취소 시점 상태                                                              | 쓰는 것                                                                                                                            | 반환    |
    | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------- |
    | 재그리기 대기 중 + 접두 있음(`printAboveRaw`)                               | 아직 그리지 않은 접두 + `"\x1b[0m\r\n"`(접두가 자기 행에 남는다)                                                                   | `true`  |
    | 재그리기 대기 중 + 접두 없음(`printAbove` 또는 접두 `""`)                   | 없음(커서는 이미 출력 아래 행 머리)                                                                                                | `true`  |
    | 그려진 활성 읽기                                                            | `moveCursorToEnd()` → `refreshUnhighlighted()` → `"\r\n"`(private `commitDrawnLine()`, 취소 가능한 Ctrl+C와 같은 함수·같은 바이트) | `true`  |
    | write 콜백을 기다리는 읽기만 / 열린 읽기 없음 / `term` 없음(`dispose()` 뒤) | 없음                                                                                                                               | `false` |

    `false`일 때:
    - 행 머리 여부를 Readline이 모른다. 그리기 전 읽기는 화면에 이전 출력 꼬리가 있을 수 있다.
    - 필요한 개행은 `promptRow`가 벤더 `hasPendingRead()`(취소 **앞**에서 읽는다)로 정한다.
      - 그리기 전 읽기가 있었으면 무조건 낸다.
      - 없었으면 현재 io 꼬리에 보이는 글자가 있을 때만 낸다.
      - 실행창·REPL `reset()` 공통 재료다(RD-028).
      - 그리기 전 읽기가 감긴 꼬리를 되감았으면 개행 앞에 커서를 꼬리 끝 행으로 내린다(`04-stdin-input.md` 3.3 "되감은 읽기의 그리기 전 창 종료").

    settle은 종료 경로 중 **가장 먼저** 불러야 한다.
    - 상태 판정(`hasPendingRead()`)은 열린 읽기를 떼기 전이어야 한다.
    - 같은 동기 블록에서 다른 `cancelRead()`·`takeRead()`·`dispose()`가 먼저 돌면 settle할 읽기가 없어 조용히 `false`가 된다. `hasPendingRead()`도 거짓이 된다.
    - 소비자의 대체 경로가 꼬리 기준으로 그대로 처리한다. 대부분의 시험이 통과한다.
    - REPL `reset()`이 `session.terminate()` 앞에서 부르는 이유다(`08-session.md` 8.1, `docs/traps/TRP-083`).

    `refreshUnhighlighted()`는 강조가 없어도 입력줄을 항상 다시 그린다.
    - `State.refreshUnhighlighted()`가 강조기를 잠시 바꾸고 `refresh()`를 무조건 부른다.
    - 그려진 활성 읽기 분기의 원시 쓰기는 입력줄 재그리기 조각 + `"\r\n"`이다.
    - 화면에는 `"\r\n"`만 쓴다.
    - 원시 쓰기를 단언하는 시험은 `"\r\n"` 개수·마지막 조각으로 본다.

  - **settle이 막는 결함**: 소비자(REPL `reset()`, 실행창 abort)가 `undrawnAbovePrefix()`를 `cancelRead()` 앞에서 읽어 접두를 다시 쓰고 `"\r\n"`을 직접 쓰면 두 문제가 생긴다.
    - 커서가 감긴 입력의 중간 행에 있으면 그 `"\r\n"`이 입력 둘째 행 위에서 났다.
    - 뒤 출력(트레이스백·리셋 안내 줄)이 입력 위에 겹쳤다. 예: 열 20·30자 입력·Home 뒤 abort → `"Traceback0123"`.
    - 커서가 입력 끝에 있는 시험만 있으면 통과한다.
    - settle은 입력 끝으로 옮긴 뒤 개행해 이 결함을 없앤다.
    - 시험(VtScreen): terminal `terminal-runner.test.ts`의 abort 뒤 출력 위치, repl `create-repl/run-source.test.ts`의 감긴 입력 중간 커서 reset.
  - **공통 상태 정리**: `cancelRead()`·`takeRead()`·`dispose()`는 열린 읽기를 떼는 상태 정리를 private `endOpenReads(error, queued, typeAhead)` 하나로 한다.
    - 순서: 그리기 전 읽기에 `cancelled` 표시 → `offscreen` 무효화 → reject.
    - 경로별 차이는 인자다.
      - `cancelRead()`: `queued` 폐기, type-ahead 폐기, `ReadCancelledError`.
      - `takeRead()`: `queued`를 type-ahead로, type-ahead 유지, `ReadTakenError`. 화면 지우기는 그 전에 한다.
      - `dispose()`: 둘 다 폐기, `Error("readline disposed")`. 리스너·`term` 해제는 그 전이다.
    - 취소 가능한 Ctrl+C는 reject가 아니라 `resolve(null)`이고 활성 읽기만 끝낸다. 이 함수를 쓰지 않고 화면 정리(`commitDrawnLine()`)만 settle과 공유한다.
- RD-013이 소스에 더한 공개 API:
  - `ReadOptions.prefill?: string`: `read()`의 write 콜백 안, `new State` 직후 1회 `state.update(prefill)`로 채운다.
    - 커서는 끝이다.
    - 빈 문자열·미지정은 원본과 같이 `state.refresh()`만 부른다.
    - `cancelable`이 아닌 읽기의 `^C` 재그리기는 다시 채우지 않는다.
  - `ReadOptions.onKey?: (input: Input) => boolean`: 활성 읽기의 키마다 벤더 처리 앞에서 부른다. `true`면 처리를 생략한다.
    - `readPaste`가 `editInsert`로 바로 넣는 `Text` 토큰은 거치지 않는다.
    - 활성 읽기가 없으면 부르지 않는다.
  - `Readline.getCursor(): number`(UTF-16 커서 위치, `State.cursor()` 경유)·`editInsert(text)`·`editBackspace(n)`: `getLine`·`updateLine`과 같은 수준으로 활성 읽기가 없어도 현재 state에 작용한다.
  - `ReadlineOptions.skipBlankHistory?: boolean`: 기본값 `false`.
    - 켜면 Enter 분기에서 trim 결과가 빈 문자열인 제출을 `history.append` 대신 `history.resetCursor()`만 한다.
  - `Input` 타입도 export한다. 값 export 목록은 불변이다.
- RD-014가 소스에 더한 공개 API:
  - `Readline.getHistory(): History`: history 객체를 그대로 돌려준다. 코어의 블록 히스토리가 `entries` 스냅샷·`restore`에 쓴다.
  - `History.restore(entries: string[]): void`: 복사본 대입 → `resetCursor()` → `saveToLocalStorage()`. 넘긴 배열과 공유하지 않는다.
  - `ReadOptions.historyEntry?: (line: string) => string`: Enter 분기에서 `skipBlankHistory`가 공백뿐인 제출을 거른 **뒤**, `history.append` 직전에 불린다.
    - 돌려준 문자열이 기록된다.
    - `resolve`는 원래 줄 그대로 돌려준다.
    - 취소(`cancelable` Ctrl+C)에는 부르지 않는다.
- 2026-09-26 readline 읽기 종료 작업이 더한 공개 옵션: `ReadOptions.history?: false`. 생략하면 기록한다(원본 동작).
  - `false`면 그 읽기의 Enter 제출을 history에 넣지 않고 `historyEntry`도 부르지 않는다.
  - history 탐색 커서는 `skipBlankHistory`가 거른 공백 제출처럼 `history.resetCursor()`로 처음으로 되돌린다.
  - 읽는 동안 ↑·↓ 탐색은 그대로 된다.
  - 읽기 단위 옵션이라 `ActiveRead`가 값을 들고 있다.
  - `historyEntry`가 빈 값을 돌려주면 기록하지 않는 방식은 쓰지 않았다. 한 훅이 "기록할 문자열"과 "기록 여부" 두 뜻을 갖게 된다.
  - 실행창의 `input()` 읽기가 쓴다(`14-runner.md` 14.5.2). `promptRow.read("", { cancelable, signal, history: false })`가 호출 단위로 전달한다(RD-027).
  - REPL의 `input()` 읽기는 옵션을 넘기지 않아 기록한다. 사양 미정이라 바꾸지 않았다.
  - 블록 히스토리의 `restore`(여러 줄 블록 병합, 6.4)는 그대로다.
- RD-022a가 소스에 더한 공개 API(REPL `runSource`가 쓴다, `02-console-core.md` 5.6): `Readline.takeRead(): { text: string; cursor: number } | undefined`, 오류 클래스 `ReadTakenError`(export), `ReadOptions.prefillCursor?: number`.
  - **`takeRead()`**: 열린 읽기를 제출·history 없이 끝내고 그 읽기의 입력 상태를 가져간다.
    - 열린 읽기(활성 읽기 또는 write 콜백을 기다리는 읽기)가 없으면 아무것도 하지 않고 `undefined`다.
    - 활성 읽기면 화면에서 프롬프트 첫 행부터 입력 마지막 행까지(감긴 행·멀티라인 버퍼 포함)를 지운다.
      - `\x1b[<행>A` + `\r\x1b[J`.
      - `refreshLine` 3·4단계와 같은 계산을 `Tty.eraseLine(layout)`으로 뗀 것이다. 새 비공개 레이아웃 상태에 의존하지 않는다.
    - 커서를 프롬프트 첫 행 열 0에 둔다.
    - 지우기 전의 `{ text, cursor }`(커서는 UTF-16 인덱스)를 돌려준다.
    - 프롬프트 앞에 붙은 꼬리(`a>>> `의 `a`)도 프롬프트라 함께 지워진다. 복원은 호출자 몫이다.
    - history는 건드리지 않는다.
  - **읽기 promise**: `ReadTakenError`로 reject한다. `ReadCancelledError`의 하위 클래스가 아니다.
    - 소비자(REPL `readLine` 핸들러)가 `ReadCancelledError`(리셋 경로, 응답 없이 끝냄)와 구분해 `{ source }`로 응답해야 한다.
    - 하위 클래스로 만들면 기존 `instanceof ReadCancelledError` 분기가 삼킨다.
    - `read()`의 반환 타입 `Promise<string | null>`은 그대로다.
  - **경계**:
    - (a) write 콜백 전의 읽기(`pendingReads`)는 그려지지 않았다. `{ text: "", cursor: 0 }`을 돌려준다. `prefill`은 반영하지 않는다.
      - 늦게 오는 콜백은 `cancelRead()`와 같은 `cancelled` 표시로 읽기를 되살리지 않는다.
      - 활성 읽기와 그리기 전 읽기가 함께 있으면(오용) 활성 읽기의 값을 돌려주고 둘 다 끝낸다.
    - (b) 재그리기를 기다리는 중이면 화면을 지우지 않는다.
      - 재그리기 전의 논리 커서(`offscreen.cursor`, 겹친 호출은 처음 값 유지)와 텍스트를 돌려준다.
      - 재그리기를 무효로 해 늦게 오는 콜백은 입력줄을 다시 그리지 않는다.
      - Tab `printAbove` 재그리기 중이면 옛 입력줄 아래에 이미 출력이 써져 있어 지울 수 없다. 옛 입력줄은 화면에 남는다.
      - `printAboveRaw` 재그리기 중이면 입력줄·접두가 이미 지워졌고 아직 다시 그려지지 않아 지울 것이 없다. 접두는 호출자가 `takeRead()` 전에 `abovePrefix()`로 읽어 다시 쓴다(RD-022b, `02-console-core.md` 5.6.3).
    - (c) 재그리기 중 쌓인 `offscreen.queued`는 type-ahead로 옮겨 다음 읽기가 재생한다(6.7). `typeAhead: false`이면 버린다. 이미 쌓인 type-ahead는 비우지 않는다.
    - (d) `takeRead()` 직후 `cancelRead()`는 이미 끝난 읽기를 `ReadCancelledError`로 바꾸지 않고 화면에 쓰지 않는다. type-ahead·`offscreen.queued`는 비운다(위 RD-010 항목, `TRP-053`).
    - (e) 입력이 뷰포트보다 커서 위쪽 행이 스크롤백으로 넘어갔으면 화면에 남은 행만 지운다. 스크롤백은 지울 수 없다(`02-console-core.md` 5.6.7).
  - **`prefillCursor`**: `prefill`을 채운 직후 커서를 그 위치에 둔다.
    - `Math.trunc` 뒤 `[0, prefill 길이]`로 자른다. `NaN`·`undefined`는 끝이다.
    - `prefill`이 없거나 빈 문자열이면 무시한다.
    - `State.update(text, cursor = text.length)`로 한 번의 `refresh()`에 그린다.
    - 서로게이트 쌍 중간의 값은 검사하지 않는다(UTF-16 인덱스 그대로).
    - `takeRead()`가 돌려준 `cursor`를 그대로 넘기면 커서가 복원된다.
  - 변경 목록은 `packages/xterm-readline/README.md`. 시험은 `take-read.test.ts`(jsdom + `VTerm`).
- RD-022b가 소스에 더한 공개 API(terminal sink가 쓴다, `05-output.md` 4.4): `Readline.isReading(): boolean`, `Readline.abovePrefix(): string`, `Readline.printAboveRaw(lines: string, prefix: string): Promise<void>`, `State.setPromptPrefix(prefix: string): void`·`State.promptPrefix(): string`.
  - `takeRead()` 반환 형태는 그대로다.
  - RD-026이 `Readline.undrawnAbovePrefix(): string`과 `Readline.hasQueuedInput(): boolean`을 더했다(아래). `undrawnAbovePrefix()`는 2026-09-26 private으로 내렸다.
  - **`isReading()`**: `activeRead !== undefined`.
    - 재그리기 대기 중 `true`다. `read()` write 콜백 전(`pendingReads`)은 `false`다.
    - Enter·취소·`takeRead`·`cancelRead`·`dispose` 뒤 `false`다.
    - 취소 불가 Ctrl+C(같은 읽기 재시작)는 `true`로 남는다.
  - **`abovePrefix()`**: 활성 읽기의 프롬프트 앞 접두(`State.promptPrefix()`). 활성 읽기가 없으면 `""`다.
    - 재그리기 대기 중이면 아직 그리지 않은 새 접두다.
  - **`undrawnAbovePrefix()`**(private, `settleScreen()`만 쓴다): `abovePrefix()` 중 아직 화면에 그리지 않은 것.
    - 재그리기(`printAboveRaw`)의 write 콜백을 기다리는 동안(`Readline.offscreen`이 있을 때)에만 `abovePrefix()`를 돌려준다. 그 밖에는 `""`다.
    - 재그리기 대기 중에는 입력줄이 접두째 지워져 접두가 화면에 없다.
    - 콜백 뒤에는 접두가 프롬프트 행에 이미 그려져 있다.
    - settle 없는 `cancelRead()`는 화면에 쓰지 않는다. 콜백 전에 취소하면 접두가 사라진다.
    - `cancelRead({ settle: true })`가 벤더 안에서 이 값을 다시 쓴다(위 RD-010 항목, `05-output.md` 4.4).
    - `abovePrefix()`를 그대로 다시 쓰면 재그리기가 끝난 뒤 취소에서 접두가 두 번 나온다(`tick>>> pritick`).
    - settle 없는 `cancelRead()`의 계약(화면에 아무것도 쓰지 않는다)은 바뀌지 않는다.
  - **`hasQueuedInput()`**(RD-026): `LineView` 위임. `Offscreen`은 `this.queued.length > 0`, `DRAWN`은 `false`다.
    - 재그리기 대기 중 들어온 키는 `offscreen.queued`에만 있다. 콜백에서 재생되기 전까지 버퍼에 없어 `getLine()`·`getCursor()` 비교로는 보이지 않는다.
    - 버퍼 비교로 경합을 판정하는 호출자(Tab 완성 응답, `07-tab-completion.md` 7.3)가 이 값을 함께 본다.
    - 재그리기 중이 아니거나 큐가 비었으면 `false`다.
    - 활성 읽기가 없을 때 쌓이는 type-ahead 버퍼(6.7)는 포함하지 않는다.
    - 큐의 **내용**은 보지 않는다. `dispatch`가 재그리기 대기 중에는 Ctrl+C·Ctrl+L 같은 즉시 키도 큐에 쌓는다. 버퍼를 바꾸지 않는 키도 경합으로 센다(한계, `07-tab-completion.md` 7.3).
  - **`printAboveRaw(lines, prefix)`**:
    - 활성 읽기(또는 `term`)가 없으면 `write(lines + prefix)` 후 바로 resolve한다.
    - 있으면 저장할 커서를 `state.cursor()`로 먼저 읽어 둔다. 합류 중이면 버려진다.
    - 재그리기 대기 중이 아닐 때만 다음을 한다.
      - `State.erase()`: 레이아웃 기준으로 접두째 프롬프트 첫 행까지 올라가 지우고 레이아웃을 초기화한다.
      - `lines`가 비어 있지 않으면 `write(lines + "\x1b[0m")`.
      - `setPromptPrefix(prefix)`.
      - 재그리기 예약. 새로 만드는 `Offscreen`의 커서는 위에서 읽은 값이다.
    - 재그리기 대기 중이면 입력줄이 화면에 없으므로 지우지 않는다. `lines`만 쓰고 접두를 바꿔 합류한다.
    - 인자 계약:
      - `lines`는 `""`이거나 `\n`으로 끝나는 완성 행이다.
      - 앞 접두를 이어 쓰려면 호출자가 `abovePrefix()`를 앞에 붙인다. 벤더는 접두를 지우기만 한다.
      - `prefix`에는 `\n`·`\r`이 없어야 한다.
      - 벤더는 둘 다 검사하지 않는다.
  - **`State.setPromptPrefix(prefix)`**: 생성자 프롬프트를 `basePrompt`(private)로 보관한다.
    - 프롬프트를 `prefix === "" ? basePrompt : prefix + "\x1b[0m" + basePrompt`로 바꾼다.
    - 그 뒤 `promptSize`를 다시 계산한다. `layout.promptSize`도 맞춘다.
    - 화면에는 쓰지 않는다. 다음 `refresh()`가 새 프롬프트로 그린다.
    - 폭보다 긴 접두는 감긴 프롬프트로 계산된다.
    - 새 `State`(`read()`, 취소 불가 Ctrl+C의 재시작)는 접두 `""`로 시작한다.
    - Ctrl+L(`clearScreen`)은 같은 `State`를 다시 그리므로 접두째 맨 위에 다시 그린다.
  - **재그리기 병합과 뷰 위임**(2026-09-26 RD-030):
    - 재그리기 대기 상태를 객체 하나로 모았다: `Offscreen { calls, waiters, queued, cursor }`(벤더 `line-view.ts`, 패키지 밖으로 export하지 않는다).
      - 초기화 누락으로 조각이 어긋나는 버그를 객체 하나로 구조상 막는다.
    - 객체 identity가 무효화 토큰이다.
      - `cancelRead()`·`takeRead()`·`dispose()`가 `Readline.offscreen`에서 떼어 내면 무효다.
      - 필드는 `private offscreen: Offscreen | undefined`이고 활성 읽기가 있을 때만 있다.
    - 콜백을 기다리는 동안 들어온 `printAbove`·`printAboveRaw`는 새 `Offscreen`을 만들지 않고 합류한다.
      - 각자 `term.write("", cb)`를 건다.
      - 합류는 커서를 덮어쓰지 않는다(아래 "저장 커서").
    - 콜백(`finishRedraw`)은 다음 순서다.
      1. 자기 `Offscreen`이 무효(`run !== this.offscreen`)면 그리지 않고 그 재그리기의 프로미스를 모두 resolve한다.
      2. 자기 순번이 마지막이 아니면 아무것도 하지 않는다.
      3. 마지막이면 `anchorRow = term.buffer.active.cursorY` → `restoreCursor(offscreen.cursor)` → `resetLayout()` → `refresh()` → `offscreen.queued` 재생 → 모든 프로미스 resolve.
    - 앞선 호출의 프로미스도 합친 재그리기가 끝난 뒤에 resolve한다.
      - 합류한 재그리기가 남은 채 Tab 리더 규칙이 깨지지 않게 하려는 것이다.
      - Tab 리더는 `printAbove` 프로미스가 끝난 뒤 다음 Tab을 처리한다(`07-tab-completion.md` 7.3).
    - 무효 재그리기의 콜백은 뒤 읽기가 시작한 재그리기를 건드리지 않는다.
    - 조회·편집 6곳은 `LineView` interface(`DRAWN`·`Offscreen implements LineView`, 둘 다 `line-view.ts`)로 위임한다.
      - 6곳: `getCursor`·`updateLine`·`editInsert`·`editBackspace`·`hasQueuedInput`·private `undrawnAbovePrefix`.
      - `Readline.view()`가 `this.offscreen ?? DRAWN`을 고른다. 각 공개 메서드는 `this.view().xxx(this.state, ...)` 한 줄이다.
      - `state`는 읽기마다 새로 만들어진다. 그래서 호출마다 넘기고 뷰가 필드로 잡지 않는다.
    - 전이 6곳은 `Offscreen`을 만들거나 떼는 지점이다. `Readline`에 남고 `this.offscreen` 유무만 판정한다.
      - 6곳: `onResize` 리스너·`settleScreen`·`takeRead`·`printAbove`·`printAboveRaw`·`dispatch`.
    - 나누는 기준:
      - 상태를 "읽고 편집"하느냐: 뷰. 부작용이 없다.
      - "만들고 없애느냐": 수명. `printAbove`·`printAboveRaw`가 `activeRead` 확인 뒤에만 만들고 `finishRedraw`·`endOpenReads`가 없앤다.
  - **저장 커서**: 겹친 호출에서 `offscreen.cursor`는 처음 값 하나다. 합류 시 덮어쓰지 않는다. 콜백이 그 값으로 되돌린다.
    - 덮어쓰면 겹친 두 번째 `printAbove`가 첫 호출의 `moveCursorToEnd()`로 끝으로 옮겨진 커서를 저장한다. 커서가 끝으로 간다.
  - **Tab `printAbove`와 접두**:
    - 재그리기 대기 중이 아니면 기존 순서(저장 커서 계산 → `moveCursorToEnd()` → `"\r\n" + text + "\r\n"`) 뒤 접두를 비운다.
      - 옛 입력행에 접두가 남으므로 새 입력행은 접두 없이 그린다(`10-parity-deviations.md` 편차 55).
      - 비우기는 `moveCursorToEnd()` 뒤다. 먼저 비우면 끝으로 옮기는 재그리기가 화면의 접두를 지운다.
    - 재그리기 대기 중이면 입력줄이 화면에 없고 커서는 앞 출력 아래 행 머리다.
      - `moveCursorToEnd()`를 부르지 않는다. 저장 커서를 덮어쓰지 않는다(합류).
      - **앞 `\r\n` 없이** 쓴다.
      - 아직 그리지 않은 접두가 있으면 먼저 `prefix + "\x1b[0m\r\n"`으로 자기 행에 쓰고 이어 `text + "\r\n"`을 쓴다. 버리면 출력이 유실된다.
    - 겹친 Tab 두 번은 `> abc` / `A` / `B` / `> abc`로 빈 행이 없다.
    - 반대로 `printAbove` 재그리기 대기 중 `printAboveRaw`는 목록을 지우지 않고 그 아래에 쓴다.
  - **앵커**: 콜백이 `anchorRow`를 새 커서 행으로 옮긴 뒤 `resetLayout()`·`refresh()`한다.
    - 이후 편집 재그리기·`eraseLine()`이 출력 행을 지우지 않는다.
    - 맨 아래 행에서 여러 행을 써 스크롤해도 입력줄은 마지막 행에 하나다.
    - 벤더 `VTerm` 시험과 브라우저 `bg-output-check.mjs`가 확인한다.
  - **재그리기 대기 중 공개 편집 API**(RD-022b 리뷰 반영): 재그리기 대기 중(`Readline.offscreen`이 있을 때) 키는 `offscreen.queued`로 간다. 조회·편집 6곳은 위 "뷰 위임"대로 `Offscreen`에 위임한다.
    - `editInsert`·`editBackspace`·`updateLine`은 입력줄이 화면에 없으므로 그리지 않는다.
      - 저장 커서(`offscreen.cursor`) 자리의 버퍼만 고친다.
      - 그 뒤 `offscreen.cursor`를 편집 뒤 커서로 바꾼다.
      - 구현은 `State.insertOffscreen`·`backspaceOffscreen`·`updateOffscreen`이다.
      - 편집 모드 플래그는 평상시 편집과 같다. 삽입·Backspace는 켜고 `updateLine`은 끈다.
    - 콜백은 그 커서로 다시 그린다.
    - 재그리기 대기 중 `takeRead()`·`getCursor()`도 그 커서를 돌려준다.
      - Tab `printAbove` 재그리기 중에는 논리 커서가 `moveCursorToEnd()`로 끝에 가 있다.
      - `getCursor()`가 끝을 돌려주면 편집이 들어갈 자리와 달라진다.
      - 편집은 끝이 아니라 저장 커서 자리에 들어간다.
    - 이 규칙이 막는 결함:
      - 편집이 곧바로 그려지면 실 xterm에서 그 바이트가 콜백이 읽는 앵커 뒤에 놓인다.
      - 콜백의 `restoreCursor(offscreen.cursor)`가 편집 전 커서로 되돌린다.
      - 한 행 입력에서도 Tab 완성 삽입(`tab-reader.ts` `applyResume` → `editInsert`)이 배경 출력 재그리기 콜백 전에 오면 커서가 `imp` 뒤에 남는다.
      - 이어 친 ` os`가 `imp osort`로 제출된다.
    - jsdom에서 재현했다. 감긴 입력의 흔적 행은 스텁에서 재현되지 않았다.
  - **재그리기 대기 중 리사이즈·취소·큐**(RD-026):
    - (1) `onResize`는 크기(`tty.col`·`tty.row`·`anchorRow`)를 갱신한다. 재그리기 대기 중(`Readline.offscreen`이 있을 때)이면 `state.refresh()`를 생략한다.
      - 입력줄이 화면에 없는데 지금 그리면 출력 아래에 흔적 행이 남는다. 감긴 입력이면 첫 행이 흔적이다.
      - 콜백(`finishRedraw`)의 `resetLayout()` + `refresh()`가 새 크기로 그린다.
      - 같은 가드가 재그리기 대기 중 리사이즈 뒤 `takeRead()`에 입력줄 잔여가 남는 것도 없앤다.
    - (2) 콜백 전 `cancelRead()`가 아직 그리지 않은 접두를 잃는 문제는 `cancelRead({ settle: true })`가 벤더 안에서 복원한다.
      - settle 없는 `cancelRead()`는 이를 쓰지 않는다(`05-output.md` 4.4).
    - (3) 재그리기 대기 중 `offscreen.queued`에 쌓인 키는 버퍼에 아직 없다. 경합 판정 호출자는 `hasQueuedInput()`이 참이면 편집을 하지 않는다(`07-tab-completion.md` 7.3).
      - 오프스크린 편집은 곧바로 버퍼에 들어간다.
      - 큐의 키는 콜백에서 뒤에 재생돼 도착 순서(키 → 편집)가 뒤집힌다.
      - 호출자가 이 값을 보지 않으면 `imp` → Tab → 배경 출력 → `x` → 완성 응답에서 `importx`가 제출된다.
  - **알려진 경계**: (1)의 리사이즈 흔적은 jsdom `StubTerminal`에서 재현하고 고쳤다. 실제 xterm에서는 재현하지 못했다.
    - 브라우저 `bg-output-check.mjs`의 `FIT=1` 셀이 수정 전 코드에서도 통과했다.
    - 창 크기 변경이 재그리기 대기 창에 들었는지 셀이 기록하지 않는다.
    - 가설: 실제 xterm에서는 `onResize`의 `refresh()` 출력이 쓰기 큐에서 콜백의 앵커 읽기 뒤에 놓여 같은 자리에 겹쳐 그려진다. 결함이 눈에 보이지 않는다.
    - 판정은 jsdom 시험이 한다.
  - 시험:
    - 벤더 `print-above-raw.test.ts`(`StubTerminal` + `VTerm`): `isReading`·`abovePrefix` 수명, 지우기·쓰기·다시 그리기, 재그리기 대기, 재그리기 대기 중 공개 편집 API, 읽기 밖, Tab `printAbove`와 접두, `onResize` 재그리기 가드, `hasQueuedInput`, 아직 그리지 않은 접두와 settle 취소.
    - 벤더 `take-read.test.ts`: 재그리기 대기 중 리사이즈 뒤 `takeRead()` 포함.
    - 벤더 `tty.test.ts`: `width()`의 CSI 사설 접두·중간 바이트·최종 바이트 폭 0.
    - repl `create-repl/run-source.test.ts`: Tab 완성 응답과 배경 출력 재그리기의 겹침, 재그리기 대기 중 reset()의 접두 복원.
    - 변경 목록은 `packages/xterm-readline/README.md`.
- 업스트림 추적: 원격을 연결하지 않는다(runo-coincident와 같은 방식). 업스트림 변경을 가져올 때는 `CHANGELOG.md`의 버전 기준으로 수동 diff한다.

## 6.2 벤더링한 xterm-readline에 적용한 수정(무엇을 / 어떤 방법으로)

| 항목    | 증상                                                                              | 들어간 방법                                                                                                                                                                             |
| ------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TRAP-12 | `read(prompt)`가 커서 행을 열 0부터 다시 그려(`\r\x1b[J`) 개행 없는 출력이 지워짐 | 브리지에서 꼬리를 프롬프트로 넘겨 그 자리에 다시 그린다(`promptRow.read`, RD-027). 라이브러리는 고치지 않는다. `cursorX`로 개행을 가르지 않는다. `cursorX`는 비동기 파싱 값이라 낡는다. |
| TRAP-14 | `read()`가 입력 상태를 **비동기로** 만들어 직후의 버퍼 조작이 사라짐              | `ReadOptions.prefill`이 write 콜백 안에서 처리한다(RD-013). 코어가 콜백 타이밍을 알 필요가 없다.                                                                                        |
| TRAP-15 | 여러 행으로 감기는 프롬프트의 첫 재그리기가 앞 행을 남김                          | `read()` 앞에 `rewindTail`이 `\x1b[nA`로 첫 행까지 올린다. flush 후 `isWrapped` 카운트를 쓴다.                                                                                          |
| TRAP-16 | 뷰포트를 채운 레이아웃에서 행이 늘 때 스크롤백 맨 윗행이 사라짐                   | **미해결**. 보이는 화면은 정상이라 관찰로만 남겼다.                                                                                                                                     |
| TRAP-17 | `moveCursorBack(0)`은 줄 맨 앞으로 가고 `n`은 코드포인트 수                       | 목록 재그리기 뒤 커서 복원에서 0이면 호출을 생략한다. 개수는 `[...text]` 코드포인트로 센다.                                                                                             |
| TRAP-13 | `readPaste`가 붙여넣은 `\t`를 버림                                                | 벤더 `readPaste`가 `UnsupportedControlChar` + 단일 `\t` 토큰만 `Text`로 승격해 버퍼에 보존한다(RD-011).                                                                                 |
| TRAP-11 | StrictMode 이중 마운트에서 dispose된 인스턴스의 지연 콜백                         | `Readline.dispose()`가 `term`을 비워 소스에서 막는다(6.1). 마운트 직후 읽기를 시작해도 안전하다.                                                                                        |

## 6.3 자동 들여쓰기 규칙(`createAutoIndent(readline)`, RD-013 완료)

- 기준은 `_pyrepl/readline.py`의 `maybe_accept`·`backspace_dedent`다.
  - `terminal/auto-indent.ts`의 순수 함수(`nextIndentation`·`backspaceCount`·`indentUnitWidth`, `DEFAULT_UNIT = '    '`)가 `_get_previous_line_indent`·`_get_first_indentation`·`_should_auto_indent`를 그대로 옮겼다.
  - 줄 끝 `#` 주석을 무시하고, 문자열 안 `#`를 주석으로 오인하는 한계까지 같다.
  - pyodide에 든 `_pyrepl.readline`과 차분 검증한다(`auto-indent-parity.test.ts`).
- `createAutoIndent(readline)`는 이 순수 함수를 **세션 소유** 상태(`lastUsedIndentation: string | null`)와 묶어 벤더 `ReadOptions`로 바꾸는 정책 객체다.
  - 유일한 진입점은 `readOptions(pending): { prefill?, onKey }`다.
  - `lastUsedIndentation`은 이 객체가 사는 동안(세션 하나) 유지된다. 2칸으로 쓴 블록 뒤의 새 블록도 2칸이다.
  - 새 세션(`startSession()`이 다시 부르는 `createAutoIndent`)은 4칸으로 돌아간다.
  - `reset()` 순서에 별도 초기화 단계는 없다. 세션이 통째로 바뀌면서 새 객체가 되기 때문이다(`08-session.md` 8.1).
- 프리필: `readOptions(pending)`의 동작.
  - `pending`은 worker가 보낸, 아직 제출되지 않은 블록 줄들이다.
  - `pending`이 있으면 `nextIndentation(pending, pending.length, lastUsedIndentation)`으로 `lastUsedIndentation`을 갱신한다. 결과를 `prefill`로 준다. 빈 문자열이면 생략한다.
  - `pending`이 없으면(새 `>>> ` 줄) `prefill`을 주지 않는다.
  - 벤더 `read()`가 `ReadOptions.prefill`을 write 콜백 안, `new State` 직후 1회 넣는다(6.1, TRAP-14 문제 해소).
- Backspace: `onKey`가 `InputType.Backspace`를 받으면 다음을 계산한다.
  - `backspaceCount(getLine(), getCursor(), indentUnitWidth(lastUsedIndentation), pendingBlock !== "")`.
  - 값이 1보다 클 때만 `editBackspace(n)`을 부르고 `true`(소비)를 돌려준다.
  - 커서 앞이 스페이스뿐이고 `... ` 입력줄이거나(`pendingBlock` 있음) 여러 줄 버퍼의 첫 줄이 아니면 직전 단위 배수까지 지운다.
  - `>>> ` 첫 줄·탭 혼합·글자 뒤·줄 시작은 1이다. 미소비이고 벤더가 원본대로 처리한다.
- Shift+Enter·Alt+Enter: `onKey`가 두 타입 모두에서 다음을 한다.
  - `prefix = pendingBlock ? pendingBlock + "\n" : ""`로 이미 제출된 줄을 앞에 붙인다.
  - `nextIndentation(prefix + getLine(), prefix.length + getCursor(), lastUsedIndentation)`을 계산한다.
  - `editInsert("\n" + indentation)` 한 번으로 개행과 들여쓰기를 같이 넣고 `true`를 돌려준다.
  - `lastUsedIndentation`도 이 호출에서 갱신한다.
  - **일반 Enter와 붙여넣기는 채우지 않는다**. `onKey`는 그 둘을 소비하지 않고 `false`를 돌려준다.
  - 자동 dedent는 없다. 켜고 끄는 스위치도 없다.
- `input()` 읽기(stdin 리더)에는 `prefill`도 `onKey`도 넘기지 않는다.
  - 프리필·Shift+Enter 들여쓰기·Backspace 단위 삭제가 모두 없다.
  - 벤더 원본 동작이다. 개행만 삽입하고 Backspace는 1글자를 지운다.
- 취소(`cancelable` 읽기의 Ctrl+C)는 **벤더 `Readline` 소스**가 처리한다(6.1).
  - 순서는 Enter 분기와 같다: `state.moveCursorToEnd()` → `state.refreshUnhighlighted()` → `term.write("\r\n")` → `activeRead`를 먼저 비우고 `resolve(null)`.
  - reject는 쓰지 않는다. 값이 RPC로 그대로 가야 한다.
  - `^C`를 찍지 않는다(3.14 프롬프트는 raw mode, pty 실측).
  - history에도 넣지 않는다. 벤더는 Enter에서만 `history.append`한다.
  - 화면은 `KeyboardInterrupt`(빨강) + 새 `>>> `이다. 그 줄은 worker의 `run(null)`이 낸다(`02-console-core.md` 5.2).
  - `lastUsedIndentation`은 세션이 그대로라 취소로 사라지지 않는다. 벤더는 들여쓰기 상태를 모른다.
- REPL 읽기 phase `cancel-settling`은 **벤더 readline이 아니라 main 게이트의 항**이다(`08-session.md` 8.1, `03-ctrl-c.md` 2.7).
  - 취소 응답 뒤 다음 요청이 도착하기 전의 Ctrl+C를 에코도 전송도 하지 않는다.
  - `read()` 호출과 입력 상태 생성 사이에 비동기 창이 있다(TRAP-14). `activeRead`로는 이 창을 판단할 수 없다.
  - phase가 `opening`·`open`·`closing`인 구간(요청 도착 → 응답)이 그 창을 덮는다. 두 구간이 이어져 빈틈이 없다.
  - 벤더 readline은 REPL 정책을 모른다.
  - `input()` 취소에는 이 phase를 세우지 않는다(`04-stdin-input.md` 3.1).
- 훅 호출 지점은 벤더 `readKey`에서 `activeRead === undefined` 검사 뒤, `switch` 앞이다.
  - 모든 `InputType`(CtrlC·Enter 포함)을 넘긴다.
  - `readPaste`의 `Text` 토큰은 훅을 거치지 않는다. 붙여넣기 프리필 없음이 자동으로 성립한다.
- 모듈 경계(RD-027·RD-029): `repl-main-driver.ts`가 `guard.readLine(prompt, { cancelable, eof, readOptions, onOpen })`을 부른다.
  - `readOptions` thunk가 `lineEditor.begin(pending, restore)`를 부른다.
  - 합성 프롬프트는 `promptRow`가 꼬리 + 프롬프트로 만든다.
  - 세 정책 합성과 restore 우선은 줄 편집기가 낸다(6.8).
  - 가드(`read-guard.ts`)와 RPC `readLine(prompt, pending, cancelable)` 핸들러는 `pending`을 그대로 통과시킨다.
  - stdin 읽기(`promptRow.read("", { cancelable })`, 실행창·REPL `input()` 공용)는 줄 편집기를 받지 않는다.

## 6.4 블록 히스토리 규칙(`createBlockHistory(readline)`, RD-014 완료)

- 블록(`... `) 입력의 줄들을 history 항목 하나로 묶는 **세션 소유** 정책 객체다(`terminal/block-history.ts`).
  - `createLineEditor`가 `createAutoIndent` 옆에서 만든다(`08-session.md` 8.1).
  - 노출은 `readOptions(pending): Pick<ReplReadOptions, "historyEntry" | "onKey">`와 `discard(): void` 둘뿐이다.
  - 블록 시작을 알리는 별도 메서드는 없다. 매 REPL 읽기가 `readOptions(pending)` 호출 자체로 시작을 겸한다.
- 기록 방식은 **"진행형 교체"**다.
  - 블록 첫 줄이 append되기 직전의 `entries` 스냅샷(`beforeFirstLine`)을 기준점(`blockBase`)으로 잡는다.
  - 이어지는 줄을 제출할 때마다 `history.restore(blockBase)`로 되돌린다.
  - 그 뒤 `(pendingBlock + '\n' + 방금 줄).trimEnd()`를 `historyEntry` 훅이 돌려줘 기록한다. 항상 최신 블록 항목 하나다.
  - "블록이 끝난 뒤 1회 기록"은 채택하지 않았다. `exit()`로 끝난 블록이 유실된다.
  - `readOptions(pending)`: `pendingBlock = pending ?? ""`.
    - `pending`이 없으면(새 `>>> ` 줄) `blockBase = null`(기준점 해제).
    - 있으면(`... ` 줄) `blockBase ??= beforeFirstLine`(이미 있으면 유지).
  - `historyEntry(line)`:
    - `blockBase === null`이면 `beforeFirstLine = getHistory().entries.slice()`(다음 블록을 위한 스냅샷)를 잡고 `line`을 그대로 반환한다.
    - `blockBase`가 있으면 `getHistory().restore(blockBase)` 후 `(pendingBlock + '\n' + line).trimEnd()`를 반환한다.
- 블록 텍스트는 worker가 준 `pending`에서 만든다. 프로토콜 변경은 없다.
  - 종료용 공백 줄은 `skipBlankHistory`가 걸러 훅이 안 불린다. 항목은 불변이다.
  - 블록 안 빈 줄은 보존한다.
  - 문법 오류·예외로 끝난 블록도 전체가 남는다.
- `discard()`: `blockBase !== null`이면 `getHistory().restore(blockBase)` 후 `blockBase = null`. 블록이 없으면 무동작이다.
  - 스냅샷 복원이므로 첫 줄 append가 밀어낸 항목(50개 제한)·중복 제거로 옮겨진 옛 항목도 함께 복구된다.
  - 호출 지점은 둘이다.
    - **취소**: 줄 편집기(`terminal/line-editor.ts`, 6.8)의 `end({ kind: "cancel" })`.
    - **리셋**: REPL main driver의 `terminate` 훅(core 세션 `terminate()`가 부른다)이 `readline.cancelRead()` **앞**에서 `lineEditor.dispose(readOpen)`이 `readOpen`이면 부른다.
      - `reset()`이 훅보다 먼저 같은 동기 블록에서 `cancelRead({ settle: true })`로 읽기를 끝내도 읽기 phase는 read promise가 마이크로태스크에서 `idle`로 내려간다. 훅에서는 아직 열린 값이다.
      - `readOpen = phase ∈ {"opening","open","closing"}`은 REPL 읽기 전용 판정이다. `input()` 대기 중·실행 중·`exit()`로 끝난 블록은 자동 제외된다(`08-session.md` 8.1).
- `... ` 입력줄의 ↑ 삼킴 판정은 **공개 API만으로** 한다.
  - `onKey`가 `pending`이 있고(`pendingBlock !== ""`) `getLine()`에 `"\n"`이 없으면 ArrowUp을 삼킨다(`true`).
  - 벤더 내부 `state.editing`(private)과의 동치 근거:
    - `editing === true`인 한 줄 버퍼에서 벤더 ↑는 원래 무동작이다. 삼켜도 화면이 같다.
    - `... `의 여러 줄 버퍼는 Shift+Enter·붙여넣기(둘 다 `editInsert` → `editing = true`)로만 생긴다.
  - `getLine()`에 개행이 있으면(여러 줄 버퍼) 삼키지 않는다. 벤더 줄 이동에 맡긴다.
  - ↓는 읽기 시작 시 `history.cursor === -1`이라 따로 막지 않는다.
- `skipBlankHistory`(RD-013 완료)와 합성한다. `Readline` 생성자 옵션 `ReadlineOptions.skipBlankHistory`가 벤더 안에서 처리한다(6.1).
  - `createRepl`이 surface에 `readline: { persist: false, skipBlankHistory: true }`를 넘긴다. surface(`createTerminalSurface`)가 `new Readline`을 만든다.
  - 블록 히스토리는 이 옵션이 이미 거른 뒤의 Enter 제출(`historyEntry` 호출)만 본다.
- `... `에서 Enter 1회로 제출된 여러 줄(붙여넣기·Shift+Enter)은 제출 텍스트 전체를 블록에 잇는다. `(pendingBlock + '\n' + 제출텍스트).trimEnd()`.
  - 붙여넣은 텍스트가 블록을 끝내고 top-level 문장까지 포함하면 그것도 같은 항목에 남는다. main은 블록 종료를 판정할 수 없다(`docs/traps/TRP-005`).
  - 3.14도 붙여넣기는 한 항목이다. 이 규칙은 편차가 아니다(`10-parity-deviations.md`).
  - **`>>> `에서 붙여넣은 여러 줄이 블록을 "열어 둔 채" 끝나고 다음 `... ` 읽기가 그 `pending`을 이어받는 경로는 구조적으로 불가능하다.**
    - `worker/submission-runner.ts`의 `runMultiline`은 어느 반환 경로에서도 `pending`을 싣지 않는다.
    - Python 버전과 무관한 코드 구조상의 제약이다. 재현 실패가 아니다(`10-parity-deviations.md`).
    - 붙여넣기가 즉시 완결되지 않고 `... `로 이어지는 유일한 경로는 애초에 `... ` 프롬프트에서 붙여넣는 경우뿐이다.
- 재호출한 블록은 Enter 1회로 실행된다(여러 줄 제출 경로). history는 중복을 제거한다. 3.14는 안 한다(편차 9).
- 리더 합성 순서는 줄 편집기(`terminal/line-editor.ts`, 6.8)가 `blockHistory` → `autoIndent` → `tabReader` 순으로 낸다.
  - blockHistory가 먼저다. ↑ 삼킴은 blockHistory만 보고 겹치는 키가 없다.

## 6.5 붙여넣기

- 개행은 `\n`으로 편집 버퍼에 삽입되고 자동 제출하지 않는다. Enter 1회로 실행한다(러너의 여러 줄 분할 규칙은 `02-console-core.md` 5.2).
- `\t`는 벤더 `readPaste`가 보존한다(6.1·6.2, RD-011).
  - 직접 Tab 키 입력은 REPL 읽기의 `onKey`(Tab 리더)가 소비한다(RD-015 완료, `07-tab-completion.md` 7.1).
  - 탭은 8칸 폭으로 표시된다.
- 붙여넣기 토큰(`readPaste`)은 `onKey`를 거치지 않는다. Tab 리더의 `lastKeyWasTab` 판정에도 반영되지 않는다.
  - Tab, 붙여넣기, Tab 순서로 치면 두 번째 Tab도 "연속 두 번째"로 판정돼 목록이 열린다(RD-015 등록, `10-parity-deviations.md`).
- 붙여넣은 블록의 둘째 줄부터 `... ` 접두사가 없다. `State`가 첫 줄에만 prompt를 렌더링한다. 라이브러리 제약이다.
- 프리필된 `... ` 줄에 들여쓴 여러 줄을 붙여넣으면 이중 들여쓰기가 된다. 3.14도 같다.
- 붙여넣은 탭 뒤 커서 위치(RD-011 관찰):
  - 붙여넣기 직후 커서는 붙여넣은 텍스트의 마지막 줄 끝에 있다. 정상이다. 붙여넣기는 삽입 지점에 커서를 남긴다.
  - 화면 표시는 xterm 탭 스톱(8칸)으로 렌더링된다. 버퍼 원문은 `\t`를 그대로 유지한다.
  - 커서를 탭이 있는 줄 중간으로 옮긴 뒤(예: 화살표 키) Backspace로 그 탭을 지울 때, 벤더 레이아웃(`state.ts`)이 탭의 실제 폭(가변, 탭 스톱에 따라 달라짐)을 아는지는 확인하지 않았다.
  - 관찰만 했고 고치지 않았다.

## 6.6 선택 복사(RD-017 완료 — 선택 시 자동 복사, 선택 중 Ctrl+C는 복사)

규칙(사용자 결정 2026-09-23). Windows Terminal·VS Code 터미널의 "선택 있으면 Ctrl+C=복사, 없으면 SIGINT" 관례를 따른다.

- **선택 시 자동 복사**: 마우스 드래그·더블클릭(단어)·트리플클릭(줄)으로 선택을 만들고 버튼을 뗀 순간 `term.getSelection()`을 `navigator.clipboard.writeText`로 복사한다.
  - 기본 켜짐이다. 앱이 끌 수 있다(`ReplOptions.copyOnSelect`, `ReplHandle.setCopyOnSelect(on)`, `00-architecture.md` 4.1).
  - 선택은 지우지 않는다. 강조가 남아 있어야 사용자가 무엇을 복사했는지 안다.
- **선택 중 Ctrl+C = 복사**: `ctrlKey && !altKey && !metaKey && key.toLowerCase() === "c" && term.hasSelection()`이면 다음을 한다. Shift 유무는 무관하다. Ctrl+Shift+C도 같다.
  - 복사한다.
  - **`term.clearSelection()`**으로 선택을 지운다.
  - 이벤트를 끝낸다(`preventDefault`, xterm 기본 처리 생략).
  - 실행 중이면 SIGINT를 보내지 않고 `^C`도 찍지 않는다.
  - `>>> `·`... `·`input()` 읽기 중이면 취소하지 않는다.
  - 자동 복사가 켜져 있으면 이 경로는 "재복사 + 선택 해제"다.
  - 선택을 지우는 이유: 지우지 않으면 선택이 남아 있는 동안 Ctrl+C가 계속 복사만 한다. 무한 루프 실행을 끊을 수 없다.
  - `copyOnSelect`와 무관하게 항상 켜져 있다.
- **선택 없는 Ctrl+C**: 기존 그대로다(RD-007 인터럽트, RD-008 취소, `03-ctrl-c.md`, 6.3).
  - Mac의 Cmd+C는 xterm이 ETX로 바꾸지 않고 브라우저 네이티브 복사가 이미 된다. 그래서 `metaKey`는 조건에서 제외한다.
- **알림**: 복사 결과를 `ReplOptions.onCopy?: (result: CopyResult) => void`로 앱에 알린다. `CopyResult = { ok: true; chars: number } | { ok: false; error: unknown }`.
  - `chars`는 **코드포인트 수**다(`[...text].length`, `"😀"`은 1).
  - 여러 줄 선택의 개행이 포함된다. `getSelection()`은 행을 `\n`으로 잇고 행 끝 공백을 지운다.
  - 코어는 DOM 오버레이를 그리지 않는다. Terminal과 컨테이너는 앱 소유다.
  - 데모는 우측 하단 고정 `<div role="status" data-testid="copy-toast">`에 `copied N chars to clipboard` 또는 `copy failed`를 1초 표시한다(`00-architecture.md` 4.3).
  - 실패는 조용히 무시하지 않는다. 사용자가 복사됐다고 오해하는 것을 막는다.

기전(terminal 패키지 `packages/pyodide-terminal/src/selection-copy.ts`). `createRepl`이 surface(`surface.ts`, 핸들 수명)를 통해 만든다. 세션이 아니다.

- 키 가로채기는 **벤더 공개 훅** `ReadlineOptions.onKeyEvent?: (event: KeyboardEvent) => boolean`이다.
  - `Readline.handleKeyEvent`(xterm `attachCustomKeyEventHandler`에 등록된 벤더 핸들러)가 자기 처리(Shift+Enter) **앞에서** 부른다. `true`(소비)면 xterm에 `false`를 돌려준다.
  - xterm 6은 커스텀 핸들러가 `false`를 주면 `evaluateKeyboardEvent`(ETX 변환)·`onData`·`preventDefault` 전부를 건너뛴다. 그래서 벤더 `readKey`에 `CtrlC`가 도달하지 않는다.
  - `keydown`·`keypress`·`keyup` 모두 이 훅을 거친다. 훅은 `event.type === "keydown"`만 본다.
  - 코어가 `attachCustomKeyEventHandler`를 직접 걸면 벤더 것을 덮어쓴다. 그래서 쓰지 않는다.
  - 6.1의 "공개 훅" 목록에 이 훅을 더한다.
  - 캡처 단계 `keydown` 리스너 설계는 기각했다. `terminal.element` 존재와 DOM 순서에 의존한다.
- 네이티브 `copy` 경로는 쓰지 않는다. xterm이 `element`의 `copy` 이벤트에서 `hasSelection()`이면 선택 텍스트를 `clipboardData`에 넣는 경로다.
  - 성공·실패를 알 수 없어 `onCopy`를 채울 수 없다.
  - 자동 복사 경로와 기전이 둘로 갈린다.
  - 훅이 `preventDefault()`를 불러 네이티브 복사가 중복으로 일어나지 않게 한다.
- 자동 복사는 리스너 둘로 건다.
  - `terminal.element`에 `mousedown`: `button === 0`이면 `dragging = true`.
  - **`element.ownerDocument`에 `mouseup`**: xterm 자신도 드래그 중 `mouseup`을 `document`에서 듣는다. 터미널 밖에서 버튼을 떼는 드래그가 흔하다.
  - `mouseup`에서 `dragging`이었고 `hasSelection()`이면 복사한다. 단순 클릭은 xterm이 `mousedown`에서 선택을 지우므로 복사하지 않는다.
  - `mouseup`에서 `getSelection()`을 **동기로** 읽는다. xterm이 드래그 중 `mousemove`마다 선택 모델을 갱신하므로 `mouseup` 시점에 이미 최종값이다.
    - 브라우저 실측에서 낡은 값이 관찰된 적이 없다. `setTimeout(0)` 우회는 필요하지 않았고 실장에도 없다.
  - `onSelectionChange`는 드래그 중 이동마다 발화한다. 복사 트리거로 쓰지 않는다.
  - `createRepl` 시점에 `terminal.element`가 없으면(`open()` 전) 자동 복사를 걸지 않는다. 데모는 `open()` 뒤에 부른다. `<PythonRepl>`도 `terminal.open()` 뒤에 `createRepl`을 부른다(RD-024).
  - 터치·키보드 선택(`selectAll` API)은 범위 밖이다.
- 정책 객체 `createSelectionCopy(terminal, { copyOnSelect, onCopy, writeText })`는 `onKeyEvent(event)`·`setCopyOnSelect(on)`·`dispose()`를 노출한다.
  - `writeText`는 시험용 주입이다. 기본은 `navigator.clipboard.writeText`.
  - 판정은 순수 함수(`decideKey({ ctrlKey, altKey, metaKey, key, type }, hasSelection) → "copy" | "pass"`)로 분리해 node 시험한다.
  - `dispose()`가 리스너 둘을 뗀다. 이후 `onKeyEvent`는 항상 `false`다.
  - `createRepl.dispose()` 순서: `session.terminate()` → **`surface.dispose()`**(선택 복사 → `readline`). 둘은 서로 독립이고 surface가 순서를 소유한다.
  - `reset()`은 건드리지 않는다(핸들 수명).
- Ctrl+L(화면 지우기)과 세션 리셋은 별개 기능으로 유지한다. Ctrl+D(빈 입력줄 EOF)는 6.9.

편차: 3.14 pty에는 선택 개념이 없다. Ctrl+C는 항상 SIGINT이고 자동 복사도 없다. `10-parity-deviations.md` 편차 43으로 등록했다.

## 6.7 읽기가 없는 구간의 키 버퍼링(type-ahead, RD-019 완료)

3.14는 실행 중 tty가 입력을 큐에 쌓고 다음 프롬프트가 그 큐를 읽는다. 벤더 `Readline`이 같은 일을 한다. 코어 래퍼가 아니다.

- 재생은 `read()` write 콜백 안, `new State`·`prefill` 직후여야 한다.
- 코어는 그 타이밍을 볼 수 없다.

공개 API 추가는 없다.

- **쌓는 구간**: `activeRead`가 없는 모든 때.
  - 실행 중.
  - Enter 직후 `read()` write 콜백 대기 중(약 20ms, `10-parity-deviations.md` 32의 옛 측정).
  - `cancelSettling`.
  - 부팅·로딩 중. 부팅 중 친 키는 쌓였다가 첫 프롬프트에서 재생한다. 별도 코드는 없다.
- **쌓는 대상**: `onData` 덩어리 중 아래 둘을 뺀 전부. 글자·Enter·Tab·방향키·Backspace·Ctrl+D·U·K·붙여넣기가 든다. 원본 문자열째 쌓는다.
  - **Shift+Enter**도 쌓는다.
    - `handleKeyEvent`가 `keydown`에서 `readData`와 같은 분기(`dispatch`)로 보낸다.
    - `Input` 항목(`InputType.ShiftEnter`, 길이 1)으로 쌓는다. 버퍼 항목 타입은 `string | Input`이다.
  - `parseInput` 결과가 토큰 1개이고 `CtrlC`·`CtrlL`일 때만 "즉시 처리"로 본다.
  - `ab\x03cd` 같은 다중 토큰 덩어리는 덩어리째 쌓이고 재생 때 활성 읽기의 Ctrl+C로 처리된다.
    - xterm은 키마다 `onData`를 따로 부른다. 덩어리는 붙여넣기에서만 오므로 드문 경우다.
  - 쌓인 Ctrl+D가 재생되거나 붙여넣기 덩어리 안의 `\x04`는 EOF가 아니다. 빈 입력줄 EOF는 실제로 친 키만이다(6.9).
- **쌓지 않는 것**:
  - **Ctrl+L**은 즉시 화면을 지운다. 실행 중 Ctrl+L의 꼬리 규칙은 편차 40.
  - **Ctrl+C**는 쌓지 않고 버퍼를 **무조건** 비운 뒤 `ctrlCHandler`를 부른다.
    - 게이트 결과와 무관하다. tty `ISIG`의 입력 큐 비움과 같다.
    - 창 안의 Ctrl+C 자체는 여전히 에코·전송이 없다(`03-ctrl-c.md` 2.7).
    - 그래서 Ctrl+C는 새 프롬프트가 보인 뒤에 보내야 한다(`docs/traps/TRP-005`).
- **상한**: 합계 4096 UTF-16 코드 유닛(`TYPE_AHEAD_LIMIT`).
  - 넘치는 덩어리는 **통째로** 버린다. 앞에 쌓인 것은 유지한다.
  - 이후의 작은 덩어리는 여전히 받는다. 알림이 없다.
  - 앞에서부터 잘라 채우지 않는다. 서로게이트 쌍·이스케이프 시퀀스 중간 절단을 막는다.
  - 3.14 tty는 한 줄 4095자까지 남기고 나머지를 버린다(편차 49).
- **수명 주기**:
  - `cancelRead()`가 버퍼를 비운다.
    - REPL에서는 세션 리셋이 유일한 호출처다: `reset()`의 `cancelRead({ settle: true })`.
    - 이어지는 `terminate` 훅의 `cancelRead()`는 이미 비어 무동작이다.
    - 리셋은 새 프로세스라 옛 맥락의 키를 넘기지 않는다. 이후 새 세션 부팅 중 친 키는 다시 쌓인다.
  - `cancelRead()` 이전에 `offscreen.queued`에 쌓인 키는 폐기한다(`offscreen`도 함께 비운다). 이후 `printAbove` 콜백 전에 도착한 키는 `typeAhead`에 쌓는다.
  - `cancelRead()`는 열린 읽기가 없어도 비운다.
    - `takeRead()` 직후 호출도 마찬가지다.
    - 그래서 `runSource` 진행 중에는 리셋 외에 부르지 않는다(5.6.5).
  - `takeRead()`는 이미 쌓인 type-ahead를 비우지 않는다. 재그리기 중 쌓인 `queued`를 type-ahead로 옮긴다.
  - `dispose()`는 비우고 재생하지 않는다.
  - `Readline`은 핸들이 하나만 만들어 세션 리셋 사이에도 공유한다. 이 두 곳이 버퍼의 유일한 폐기 지점이다(Ctrl+C 제외).
- **재생**: `read()`의 write 콜백에서 `activeRead` 설정·`new State`·`prefill` 뒤 동기로 한다.
  - 스냅샷을 먼저 꺼내 비운 뒤 덩어리마다 `readData`로 다시 넣는다. `onKey` 훅(Tab 리더·자동 들여쓰기)과 `readPaste` 경로를 그대로 탄다.
  - `Input` 항목(Shift+Enter)은 `readKey`로 가서 `onKey` 훅(자동 들여쓰기, 6.3)을 거친다.
    - 실행 중 `if 1:` Shift+Enter `pass`는 다음 프롬프트에 `>>> if 1:` / `    pass`(4칸 들여쓰기)로 재생된다.
  - 낡은 `State`에는 그리지 않는다(붙여넣기 포함).
- **읽기당 소비**: 재생 중 Enter로 읽기가 끝나면 남은 덩어리는 `activeRead`가 없어 다시 버퍼로 들어간다. 순서가 보존되고 다음 읽기가 받는다.
  - 실행 중 `ab⏎cd`는 첫 줄 `ab`가 제출되고 `cd`가 다음 프롬프트 `>>> cd`에 남는다.
  - 다음 읽기가 `input()`이면 첫 줄이 그 값이다.
  - read-guard는 stdin 읽기 시작을 활성 REPL 읽기가 끝난 뒤로 미룰 뿐 버퍼와 무관하다(`04-stdin-input.md`).
- **`printAbove`의 `offscreen.queued`와의 관계**: 별개로 둔다. 통합하지 않는다.
  - `offscreen.queued`는 재그리기 대기(`Readline.offscreen`) 중 도착한 키를 재그리기 콜백에서 재생한다.
  - type-ahead는 `activeRead`가 없을 때를 맡는다.
  - 재생 키가 `printAbove`(Tab 완성 목록 등)로 재그리기를 시작하면 남은 덩어리는 `dispatch`의 `offscreen` 분기로 새 `Offscreen`의 `queued`에 들어간다. 순서가 보존된다.
  - Shift+Enter도 같은 분기를 탄다. 재그리기 중 친 Shift+Enter가 먼저 친 키보다 앞서 적용되지 않고 `queued`를 거쳐 순서를 지킨다.
- **알려진 경계**: Tab 뒤에 키가 이어진 입력(`os.getc`+Tab+`()`)은 재생이 한 틱에 끝난다.
  - Tab의 worker 왕복 응답 전에 뒤 키가 들어가 완성이 버려진다(편차 48).
- **`typeAhead: false`**(RD-022, 실행창): 위 "쌓는 구간"의 입력을 쌓지 않고 버린다.
  - 차단 기준은 벤더의 `activeRead === undefined`다. 그래서 `read()`를 부른 직후 write 콜백이 오기 전에 친 키도 버려진다.
  - 기본값(`true`)은 그 창의 키를 콜백에서 재생한다(`14-runner.md` 14.5.2, 편차 52).
- **에코**: 실행 중에는 아무것도 그리지 않고 다음 읽기에서 입력줄로만 그린다. 3.14의 tty 에코는 따르지 않는다(편차 45). 실행 중 `←`·Ctrl+D·Tab 뒤 키는 편차 46~48이다.
- **시험**:
  - 벤더 `type-ahead.test.ts`: 재생·순서·Ctrl+C·Ctrl+L·`cancelRead`·`dispose`·붙여넣기·상한·`onKey`·`printAbove` 순서·pty 대조 값.
  - 브라우저 `apps/demo/e2e/checks/type-ahead-check.mjs`(`e2e:type-ahead`).
  - 3.14.4 pty 기준 `apps/demo/e2e/pty/rd-019/`.

## 6.8 줄 편집기(`createLineEditor(readline, deps)`, RD-029)

세션 소유 모듈이다(`terminal/line-editor.ts`). 6.3 자동 들여쓰기·6.4 블록 히스토리·7.1 Tab 리더 세 정책을 하나로 묶는다.

- `repl-main-driver.ts`의 편집 정책 접점을 `begin`·`end`·`dispose`·`requesting` 네 메서드로 줄인다.

- **생성 순서**: autoIndent → blockHistory → tabReader. 세 정책의 수명 = 편집기 수명 = 세션.
- **`begin(pending, restore?)`**: 읽기마다 한 번, `promptRow.read`의 `readOptions` thunk 안에서(flush 뒤, `readline.read()` 직전에) 부른다.
  - `blockHistory.readOptions(pending)` → `autoIndent.readOptions(pending)` → `tabReader.readOptions(pending)`을 **이 순서로** 불러 합성한다.
  - 부작용 순서가 중요하다. autoIndent의 `pendingBlock`·`lastUsedIndentation` 갱신, tabReader의 세대 증가.
  - `onKey`는 같은 순서로 불러 먼저 `true`(소비)를 돌려준 쪽에서 멈춘다.
    - 세 정책은 서로 다른 키 종류만 처리한다. 순서 자체는 운영에서 관측되지 않는다.
  - **E0**: 완성 popover(옵션, `07-tab-completion.md` 7.6)가 있으면 그 `onKey`를 이 합성 맨 앞에 둔다. 열린 동안 ↑↓ 등이 blockHistory보다 먼저 popover로 가야 한다.
  - `prefill`은 autoIndent, `historyEntry`는 blockHistory만 낸다.
  - `restore`가 있고 `restore.text !== ""`면 `prefill: restore.text`·`prefillCursor: restore.cursor`로 autoIndent의 `prefill`을 덮어쓴다. `text === ""`면 무시한다.
  - restore 소비는 이 `begin` 호출 시점이다. 요청 도착 시점이고 P3이 아니다.
- **`end(result)`**: 읽기 하나가 끝났다. `result.kind`에 따라 다음을 부른다.
  - `"line"`(Enter로 제출): `tabReader.readEnded(line)`.
  - `"cancel"`(Ctrl+C 취소): `tabReader.readEnded(null)` → `blockHistory.discard()`(대기 중 블록을 첫 줄까지 history에서 버린다, 6.4).
    - 두 호출은 서로 다른 상태(왕복 중 완성 인터럽트 vs history 스냅샷)를 건드린다. 순서 자체는 관측되지 않는다.
  - `"taken"`(`runSource`가 `sendSource()`로 읽기를 가져감): `tabReader.readEnded("")`.
  - `"eof"`(빈 `>>>` 줄의 Ctrl+D, 6.9): `tabReader.readEnded(null)`. 열린 블록이 없어 `discard()`를 부르지 않는다. 취소와 다른 점이다.
  - 분기와 무관하게 popover가 열려 있으면 먼저 닫는다(`07-tab-completion.md` 7.6 C1).
- **`dispose(readOpen)`**: 세션 종료다(REPL main driver의 `terminate` 훅, `08-session.md` 8.1).
  - `readOpen`(읽기 phase가 `opening`·`open`·`closing`)이면 `blockHistory.discard()`를 부른다.
  - `tabReader.readEnded(null)`은 `readOpen`과 **무관하게 항상** 부른다.
  - 뒤이은 core `rpc.dispose()`가 대기 중인 `complete` 요청을 reject한다. `.catch().finally(drainQueue)`가 마이크로태스크에서 큐를 다시 처리하려 든다.
  - 여기서 먼저 tabReader를 끝내 두지 않으면 그 처리가 취소된 세션의 buffer·cursor를 읽어 엉뚱한 삽입을 터미널에 쓴다(RD-015).
- **`requesting`**: `tabReader.requesting`을 그대로 낸다(`sourcePrompt()`의 busy 재료, `08-session.md` 8.1).
- **시험**: `terminal/line-editor.test.ts`(실제 surface `Readline` 위에서).
  - `block-history.test.ts`·`tab-reader.test.ts`는 옵션 합성을 `createLineEditor(...).begin(pending)`으로 받는다.

## 6.9 Ctrl+D(빈 입력줄 EOF, RD-048)

3.14.4 pty 실측(`apps/demo/e2e/pty/rd-048/results.md`)이 화면 기대값을 확정했다(가설 H3, 아래 "pty 대조").

**규칙 정의(이 절 한 곳)**: 빈 입력줄의 Ctrl+D는, 그 Ctrl+D가 실제로 친 키일 때만 EOF다.

- REPL `>>>`에서는 세션 종료다(`exit()`와 같은 결말).
- `input()`·`sys.stdin` 읽기(REPL·실행창)에서는 pyodide EOF다. `input()`은 `EOFError`, `for line in sys.stdin`은 종료.
- 글자가 있는 줄의 Ctrl+D는 커서 뒤 글자 삭제다(6.1 `Line.delete`). 지울 게 없으면 무동작이다.

- **조건**: 벤더 `ReadOptions.eof: true`를 받은 읽기에서 다음 둘이 모두 참일 때만 EOF다.
  - (1) 버퍼가 빈 문자열이다.
  - (2) 그 Ctrl+D가 실제로 친 키(`origin === "live"`)다.
  - 읽기는 `@cp949/runo-xterm-readline`의 `READ_EOF` symbol로 끝난다.
  - 재생(`replayTypeAhead`, `origin === "replay"`)으로 들어온 Ctrl+D는 제외한다.
  - 붙여넣기(`readPaste`가 덩어리 안 제어 토큰을 넘길 때, `origin === "paste"`)로 들어온 Ctrl+D도 제외한다.
  - 3.14 cooked tty의 Ctrl+D도 그 자리의 키 눌림만 본다(`docs/traps/TRP-032`). 실행 중 쌓인 입력이나 붙여넣은 덩어리의 `\x04`는 EOF가 아니다(6.7).
  - `onKey` 훅이 먼저 소비하면(Tab 리더 등) EOF가 아니다(6.3 훅 순서와 같다).
- **결말(벤더 → promptRow → core → worker)**:
  - 벤더 `readKey`가 취소 Ctrl+C와 같은 private `endActiveRead()`로 끝낸다.
    - `commitDrawnLine()`(커서 끝으로 → 강조 벗김 → `\r\n`).
    - `activeRead` 비움.
    - `resolve(READ_EOF)`. history에 기록하지 않는다.
  - terminal `promptRow`가 벤더 `READ_EOF`를 core `STDIN_EOF`(`@cp949/runo-pyodide-core`의 `unique symbol`, `protocol/stdin-eof.ts`)로 바꾼다.
    - 변환은 이 한 곳뿐이다. 빠뜨리면 EOF가 조용히 취소로 떨어진다.
  - core 세션 `readInput` 핸들러가 `STDIN_EOF`를 메일박스 `MailboxWriter.eof()`로 싣는다(`01-protocols.md` 2.1 STATE `EOF = 4`). worker stdin 콜백에 `{ kind: "eof" }`로 도착한다.
  - 콜백은 SIGINT를 쓰지 않고 pyodide에 `null`을 그대로 돌려준다(`04-stdin-input.md` 3.1).
  - pyodide `LegacyReader`가 `null`을 EOF로 해석한다. `input()`은 `EOFError`, `sys.stdin` 읽기는 그 시점에서 끝난다.
  - `>>>` 읽기의 EOF는 메일박스를 거치지 않는다.
    - read-guard가 `promptRow.read("", { eof: true })`로 여는 stdin 읽기와 다르다.
    - REPL main driver의 `readLine` 핸들러가 직접 `STDIN_EOF`를 받아 응답 `{ eof: true }`로 바꾼다.
    - worker REPL 루프가 그 응답을 보면 Python을 실행하지 않고 바로 `onTerminated()` → `sessionTerminated`로 끝낸다.
    - `02-console-core.md` 5.2 `run(reply)` 분기와 다른 경로다.
- **읽기별 켜짐**:

  | 읽기                                     | `eof` | 빈 줄 Ctrl+D 결말                                                |
  | ---------------------------------------- | ----- | ---------------------------------------------------------------- |
  | REPL `>>>`(요청 `pending === undefined`) | 켜짐  | `{ eof: true }` 응답 → `sessionTerminated`(`exit()`와 같은 결말) |
  | REPL `...`(요청에 `pending` 있음)        | 꺼짐  | 무동작(3.14도 무동작, pty P2)                                    |
  | REPL `input()`(read-guard stdin 읽기)    | 켜짐  | `STDIN_EOF` → `EOFError`                                         |
  | 실행창 stdin 기본 공급자                 | 켜짐  | `STDIN_EOF` → `EOFError`(또는 `for line in sys.stdin` 종료)      |

  `>>>` 읽기의 `{ eof: true }` 응답 뒤 phase는 취소와 같은 `cancel-settling`이다. 새 phase를 만들지 않는다.
  - `sessionTerminated` 도착 전의 Ctrl+C가 에코·전송 없이 막힌다(`08-session.md` 8.1).
  - `input()` 읽기의 EOF에는 이 phase를 세우지 않는다. 취소와 같다(`04-stdin-input.md` 3.1).

- **재생·붙여넣기를 EOF에서 빼는 근거**: 재생(type-ahead)·붙여넣기로 들어온 Ctrl+D까지 EOF로 처리하면 문제가 생긴다.
  - 실행 중이나 붙여넣기 도중 우연히 낀 `\x04` 한 글자가 다음 프롬프트나 `input()` 읽기를 조용히 끝낸다.
  - 사용자가 "지금 이 키를 쳐서" 세션을 끝낸다는 동작 모델(3.14 tty의 실시간 Ctrl+D)과 어긋난다.
  - `origin` 판정 하나로 live·replay·paste 세 경로를 가른다(6.7 "쌓는 대상").
- **pty 대조**(3.14.4, `apps/demo/e2e/pty/rd-048/results.md`, 가설 H3 전부 참):
  - `>>>` 빈 줄 Ctrl+D → 개행 한 번 뒤 프로세스 종료(P1).
  - `input()` 빈 줄 Ctrl+D → 입력줄 아래에서 시작하는 `EOFError` 트레이스백(P3). 프레임 모양은 웹과 달라 편차 35 계열로 흡수한다.
  - `...` 빈 줄 Ctrl+D → 화면·커서 완전히 불변(P2).
  - 글자 있는 `input()` 줄의 Ctrl+D → 커서 뒤 글자만 삭제(P4).
  - 같은 run에서 EOF 뒤 `input()`을 다시 부르면 즉시 `EOFError`가 나지 않고 새 읽기로 대기한다(P6·P7).
    - pyodide 314.0.7도 같다. `runner-pyodide.test.ts`가 고정한다.
    - EOF를 세션 안에서 "기억"하지 않고 매 읽기마다 새로 판정한다.
- **허용 편차**:
  - `read()` 중 글자가 있는 줄에서 Ctrl+D가 재생·붙여넣기 조각 경계를 넘어가는 동작(`10-parity-deviations.md` 편차 34).
  - 트레이스백 프레임 모양(편차 35 계열).
- **시험**:
  - 벤더 `test/ctrl-d-eof.test.ts`.
  - core: stdin 메일박스·stdin 콜백·core 세션·runner 시험(`test/protocol/stdin-mailbox.test.ts`, `test/worker/stdin-callback.test.ts`, `test/session/`).
  - terminal: `test/prompt-row/read.test.ts`·`test/terminal-runner.test.ts`.
  - REPL: `test/repl-main-driver.test.ts`·`test/terminal/read-guard.test.ts`·`test/worker/repl-loop.test.ts`·`test/terminal/line-editor.test.ts`·`test/create-repl/`.
  - 브라우저 `apps/demo/e2e/checks/ctrl-d-check.mjs`(`e2e:ctrl-d`).
  - pty `apps/demo/e2e/pty/rd-048/`.

참고: `apps/demo/e2e/pty/rd-048/results.md`, `docs/traps/TRP-032`(pty 실행 중 키와의 차이).
