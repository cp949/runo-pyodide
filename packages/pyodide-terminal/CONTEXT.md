# pyodide-terminal

xterm 실행창(`createTerminalRunner`)과 repl이 공유하는 xterm 결합 부품 5종. core 위에 얹히고 coincident에 의존하지 않는다. private이고 공개 API로 확정하지 않은 내부 계약이다(RD-022). 코드·문서·시험 이름에 쓰는 용어를 정의한다. main·worker·세션·읽기·인터럽트·꼬리의 일반 용어는 `packages/pyodide-repl/CONTEXT.md`, driver·core 세션·`InputProvider`는 `packages/pyodide-core/CONTEXT.md`를 따르고, 여기서는 terminal이 도입한 용어만 정의한다. 규칙 본문은 `docs/design/14-runner.md`.

## Language

### 실행창

**실행창(terminal runner)**:
`createTerminalRunner(options)`가 만드는 핸들. core `createRunner`를 호출자 소유 xterm `Terminal`에 붙여 코드 한 덩어리를 실행하고 `input()`만 한 줄 읽는다. REPL과 달리 프롬프트도 history도 없다. `Terminal`은 dispose하지 않는다.
_Avoid_: 콘솔, 터미널 REPL

**runner**:
core `createRunner`가 돌려주는 UI 비의존 실행 핸들(`run`·`stop`·`interrupt`·`reset`·`dispose`·`status`). 실행창은 runner 위에 화면·입력을 얹는다. 상태 8종·결과 유니온·`RunRejectedError`는 core 용어다.
_Avoid_: 세션(세션은 core 세션 = worker 한 개), 실행기

**읽기 밖 입력**:
`input()` 읽기가 열려 있지 않은 구간(실행 중·로딩 중·결과 뒤)에 들어온 문자·붙여넣기·IME 조합 결과·Shift+Enter. 실행창은 벤더 `Readline`을 `typeAhead: false`로 만들어 이를 버린다. REPL의 type-ahead(쌓았다가 재생)와 반대다.
_Avoid_: 무시된 키, 유실 키(의도된 동작이다)

**Ctrl+C 분기**:
읽기 밖 Ctrl+C(벤더 `setCtrlCHandler`)에서 core `interrupt()`의 반환값(`InterruptResult`)으로 화면 동작(`^C` 에코 여부)을 가르는 규칙(`docs/design/14-runner.md` 14.5.3).

**abort 정리**:
기본 입력 provider가 `signal` abort에서 하는 일. `promptRow.endRead(disposed ? { screen: false } : { screen: true })`
(RD-027·RD-028)로 열린 읽기를 끝내고 벤더가 화면을 정리하게 한다(아직 그리지 않은 배경 출력 접두는 자기 행으로, 그려진
입력은 감긴 입력의 끝 아래 행 머리로). settle이 실패하면 벤더 `hasPendingRead()`(그리기 전 읽기 유무)로 나눈다 — 있었으면
무조건 개행, 없었으면 현재 io 꼬리에 보이는 글자가 있을 때만 개행한다(행 머리 보장 규칙, RD-028). `dispose()` 중(`screen: false`)에는
화면에 쓰지 않는다. 안 하면 다음 Enter가 죽은 읽기로 들어가고, 커서가 감긴 입력 중간이면 트레이스백이 입력 위에 겹친다
(`14-runner.md` 14.5.3).

**꼬리 개행**(구 "커서 줄바꿈"):
`run()` 시작 시 현재 io 꼬리에 보이는 글자가 있으면(`leavesVisibleText`, SGR만 남은 꼬리는 "없음", DELTA-05) `\r\n`을
한 번 쓰고 그 꼬리를 비우는 규칙(`promptRow.breakLine()`, RD-028 — 커서(`cursorX`)는 더 이상 보지 않는다, xterm의 비동기
파싱 때문에 같은 태스크에서는 낡을 수 있다). `clearOnRun`이면 대신 화면을 지운다. 거부될 `run()`은 화면을 건드리지 않는다.
_Avoid_: 커서 줄바꿈(옛 이름, 커서 기준이 아니다)

**거부 예측**:
core가 코드를 실행하지 않고 거부할 `run()`에서 화면을 준비하지 않게 하는 판정(`willBeRejected`). core `run()`과 같은 재료(`status`·`busy`)를 그 시점에 읽는다. `loading`·`restarting` 중 대기하는 run의 슬롯 점유는 상태로 알 수 없어 core `busy`가 알려 준다.
_Avoid_: 사전 검증

### 공통 부품

**`./internal`**:
`@cp949/runo-pyodide-terminal/internal` 서브패스. `sinks`·`rewind-tail`·`selection-copy`·`surface`·`prompt-row`를 `export *`로 낸다. repl 전용이고 두 패키지가 lockstep으로 바뀌며 안정성을 보장하지 않는다. 앱 코드는 `.` 진입점만 쓴다.
_Avoid_: 공개 API, 유틸

**sink**:
main이 터미널에 쓰는 함수 4종(`writeOutput`·`writeError`·`write`·`writeErrorRaw`, `TerminalSinks`). 실행창은 stdout을 `write`, stderr를 `writeErrorRaw`로 그린다. 열린 읽기 중에는 4종 모두 벤더 `printAboveRaw`로 입력줄 위에 쓰고 꼬리를 건드리지 않는다(`splitAboveRead`). 꼬리 추적(`tail`·`resetTail`)과 열린 읽기의 접두를 꼬리로 옮기는 `moveAbovePrefixToTail`은 `TerminalSinksInternal`이 낸다 — 프롬프트 행(`promptRow`, RD-027) 전용 내부 재료이고 소비자 타입(`SurfaceIo.sinks`)에는 없다. 정의는 `05-output.md`(열린 읽기는 4.4).

**프롬프트 행(`surface.promptRow`)**:
커서 행의 프롬프트 앞 글자(꼬리·접두), 열린 읽기, 읽기가 끝난 뒤 행 머리 보장을 소유하는 surface의 부분(RD-027, `createPromptRow`). 위젯 수명이고 "현재 io"(가장 최근 `openIo()`로 연 io, `close()`되지 않은 동안)의 꼬리를 본다. `read(prompt, options)`(직전 출력의 꼬리를 프롬프트 앞에 합성해 한 줄 읽는다. `options.signal`은 꼬리 정리(flush) 대기 뒤 abort 여부를 다시 확인하는 데만 쓴다. `options.history === false`일 때만 벤더 옵션에 `history: false`를 넣는다 — 실행창 `readInput`만 넘기고 REPL `input()`은 생략해 기록한다. `options.eof === true`면 벤더 `READ_EOF`를 core `STDIN_EOF`로 바꿔 돌려준다 — 변환은 이 함수 한 곳뿐이다, RD-048·`docs/design/06-editing.md` 6.9)·`take()`(읽기가 끝난 줄을 꺼내며 지운 접두·꼬리를 재출력)·`detachPrefix()`(열린 읽기의 접두를 꼬리로 옮기고, 떼는 순간의 io에 묶인 `DetachedPrefix`를 돌려준다. `draw()`는 규칙 `docs/design/04-stdin-input.md` 3.2)·`endRead(options)`(읽기를 끝내고, `screen: true`면 settle 실패 시 벤더 `hasPendingRead()`로 나눠 대체 개행 — 그리기 전 읽기가 있었으면 무조건, 없었으면 현재 io 꼬리에 보이는 글자가 있을 때만)·`breakLine()`(현재 io 꼬리에 보이는 글자가 있을 때만 개행, 인자 없음)·`clear()`·`notice(text, kind)`(구 `writeNotice`. 현재 io가 있으면 그 꼬리에 보이는 글자가 있을 때만 `\r\n`을 선행해 쓰고, 없으면 `readline.println`)로 이 모든 연산을 한곳에 모은다.
**행 머리 보장 규칙**(RD-028): 판정 재료는 항상 **현재 io 꼬리에 보이는 글자가 있는가**(core `leavesVisibleText`,
DELTA-05)다 — xterm의 `write`가 파싱을 `setTimeout`으로 미뤄 같은 태스크의 `cursorX`가 낡을 수 있어(F3) 커서 판정은
쓰지 않는다. 꼬리 문자열이 비어 있는가만으로는 틀린다 — 색을 안 닫고 개행으로 끝난 출력은 꼬리에 열린 SGR만 남아 문자열은
비지 않지만 화면에는 보이는 글자가 없다. 호출자마다 다른 재료를 쓰던 옛 임시 인자 두 종(무조건 개행 여부·조건부 개행
재료)과 커서(`cursorX`) 판정은 없앴다(`14-runner.md` 14.5.3·`08-session.md` 8.1 1번,
`_works/_completed/20260926-39-rd-028-prompt-row-newline/design.md` §3).
_Avoid_: 입력줄(벤더 용어), 프롬프트 영역

**선택 복사(`createSelectionCopy`)**:
드래그 선택 시 자동 복사와 선택 중 Ctrl+C 복사(Shift 무관)를 처리하는 정책 객체. `Readline`보다 먼저 만든다(`06-editing.md` 6.6). 이 순서는 surface가 소유하므로 소비자가 직접 만들지 않는다.

**surface**:
`createTerminalSurface(terminal, options)`가 만드는 xterm 화면 조립·수명 객체(`src/surface.ts`). 선택 복사 → `Readline` → `loadAddon` 순으로 조립하고 `Readline`의 `onKeyEvent`를 선택 복사에 묶는다. `dispose()`는 선택 복사 → `Readline` 순으로 정리하며 열린 `io`는 닫지 않는다. 수명은 두 겹이다: 위젯 수명(`createTerminalRunner`·`createRepl`과 같다: `readline`·`promptRow`·`setCopyOnSelect`·`dispose`)과 세션 수명(`openIo()`). `readline`은 편집 정책(auto-indent·block-history·tab-reader·Ctrl+C)이 쓰는 멤버만 내는 좁힌 타입(`SurfaceReadline`)이고, 프롬프트 행 연산(읽기·take·행 머리 보장)은 `promptRow`만 쓸 수 있다(RD-027, 컴파일 단계에서 막는다). 소비자는 정책만 넘긴다(`Readline` 옵션 `persist`·`typeAhead`·`skipBlankHistory`, `io.close()`·`dispose()`를 부르는 시점).
_Avoid_: 위젯, 화면 매니저

**io**:
`surface.openIo()`가 호출마다 새로 만드는 세션 수명 입출력 `{ terminal, sinks, close }`. `terminal`은 `close()` 뒤 write 콜백을 전달하지 않는 뷰이고(xterm write 콜백은 `term.dispose()` 뒤에도 돈다, TRP-004) `sinks`(쓰기 4종만)는 `io`마다 따로다. `promptRow`가 내부적으로 보는 꼬리 재료(`tail`·`resetTail`·`moveAbovePrefixToTail`)는 `io.sinks`에 없다 — "현재 io"로 `promptRow`만 본다(RD-027). `close()`는 멱등이고 다른 `io`에 영향을 주지 않는다(더 오래된 `io`의 `close()`는 현재 io를 바꾸지 않는다). 실행창은 runner당 한 번, repl은 세션마다 연다.
_Avoid_: 세션(세션은 core 세션 = worker 한 개), 스트림
