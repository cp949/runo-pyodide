# pyodide-repl

브라우저 Python REPL 코어. main 스레드의 터미널과 worker의 pyodide를 잇는다. 이 문서는 코드·문서·시험 이름에 쓰는 용어를 정의한다. 프로토콜·worker 커널·main 세션은 `@cp949/runo-pyodide-core`가 소유하고 repl은 그 위에 REPL driver(`repl-main-driver.ts`·`worker/repl-driver.ts`)와 REPL 프런트를 얹는다. driver·게이트·출력 조각 같은 core 용어는 `packages/pyodide-core/CONTEXT.md`를 따른다.

## Language

### 실행 주체

**main**:
브라우저 메인 스레드. 터미널·줄 편집·인터럽트 송신을 맡는다.
_Avoid_: UI 스레드, 호스트, 클라이언트

**worker**:
pyodide와 콘솔이 도는 Web Worker. 세션마다 하나.
_Avoid_: 백엔드, 런타임 스레드

**세션**:
worker 하나의 생애. 변수·import·들여쓰기 단위·history 기준점이 세션에 속한다. 화면(스크롤백)은 세션에 속하지 않는다.
_Avoid_: 커널, 인스턴스

**리셋**:
세션을 새 worker로 바꾸는 것. 화면은 남는다.
_Avoid_: 재시작(크래시 복구를 가리킬 때만), 화면 지우기(Ctrl+L, 별개 동작)

**상태**:
`ReplStatus`. 세션의 생애를 앱에 알리는 값(`loading`·`ready`·`load-failed`·`not-isolated`·`terminated`·`crashed`).
_Avoid_: 단계, 페이즈

### 읽기

**REPL 읽기**:
worker가 다음 입력 줄을 요청하는 것(`readLine`). 비동기이며 worker는 기다리는 동안 살아 있다.
_Avoid_: 프롬프트 읽기, 콘솔 입력

**stdin 읽기**:
Python `input()`·`sys.stdin`이 한 줄을 요구하는 것(`readInput`). worker가 멈춘 채 메일박스로 응답을 받는다.
_Avoid_: input 읽기, 동기 읽기

**취소**:
읽기 중 Ctrl+C로 그 읽기를 `null`로 끝내는 것. 벤더 `Readline`의 cancelable 읽기가 `^C`·history 없이 `\r\n` 뒤 `null`로 이행한다.
REPL 읽기의 취소는 `readLine` 응답 `null` → worker `run(null)`이 미완성 블록을 버리고 빨간 `KeyboardInterrupt` 한 줄을 낸다.
stdin 읽기의 취소는 메일박스 CANCELLED → worker 콜백이 `signalInterrupt` → `checkInterrupt()`로 바꿔 `input()` 호출 지점의 `KeyboardInterrupt`가 된다.
취소는 **읽기를 끝내는 것**이고 중단은 **돌고 있는 코드를 끊는 것**이다. 취소는 interrupt buffer를 main에서 쓰지 않는다(REPL 취소는 버퍼를 전혀 쓰지 않고, stdin 취소는 worker 콜백이 쓰고 그 자리에서 소비한다).
_Avoid_: 중단(실행 중 Ctrl+C를 가리키는 말), abort

**EOF(빈 입력줄, RD-048)**:
빈 버퍼에서 실제로 친 Ctrl+D가 읽기를 끝내는 것 — 취소와 값이 다르다(`STDIN_EOF`, core `CONTEXT.md`). 규칙 정의는
`docs/design/06-editing.md` 6.9 한 곳.
_Avoid_: 취소(값이 다르다), 종료(EOF는 `>>>`에서만 세션을 끝낸다)

**read-guard**:
REPL 읽기가 활성인 동안 도착한 stdin 읽기를 그 REPL 읽기가 끝난 뒤로 미루고, 미룬 읽기의 접두를 떼어 프롬프트로 넘기거나 세션이
끝났으면 뗀 조각을 그리는 규칙(`docs/design/04-stdin-input.md` 3.2).

**꼬리**:
직전 출력에서 마지막 개행 뒤(그 안에서 마지막 `\r` 뒤)에 남은 텍스트. 읽기의 프롬프트로 다시 그려진다.
_Avoid_: 잔여 출력, 부분 줄

**접두**(열린 읽기의 프롬프트 앞 접두):
프롬프트가 그려진 뒤(열린 읽기 중) 온 배경 출력의 미종결 부분. 꼬리와 같은 규칙으로 계산하지만(`\r`로 끝나면 마지막으로 보이는 `\r` 구간) 꼬리 추적기에 넣지 않고 벤더
`Readline`이 읽기마다 보관해(`abovePrefix()`) 프롬프트 앞에 그린다(`tick>>> pri`). 읽기가 끝나면 그 행째 화면에 남는다. 정의는
`docs/design/05-output.md` 4.4.
_Avoid_: 꼬리(읽기 시작 전 출력의 미종결 부분만 꼬리라 부른다)

**pending**:
블록 입력 중 이미 제출된 `... ` 줄들을 개행으로 이은 텍스트. 자동 들여쓰기·Tab 완성·블록 히스토리가 쓴다.
_Avoid_: 버퍼(콘솔 내부 `buffer`와 혼동)

**블록 history 기준점**:
`createBlockHistory`가 소유하는 세션 상태(`blockBase`·`pendingBlock`). 블록 첫 줄이 append되기 직전의
`entries` 스냅샷이고, 이어지는 제출마다 이 기준점으로 되돌린 뒤 다시 기록한다("진행형 교체"). 취소·리셋의
`discard()`가 이 기준점으로 복원한다. 세션이 바뀌면(리셋) 새 `createBlockHistory` 객체가 되어 사라진다.
_Avoid_: 스냅샷(코드 안에서는 이 이름을 쓰지만 용어로는 "기준점"을 쓴다)

**`historyEntry`**:
벤더 `ReadOptions.historyEntry`. Enter 분기에서 `skipBlankHistory`가 거른 뒤·`history.append` 직전에 불려
돌려준 문자열이 기록된다(`resolve`는 원래 줄 그대로). 블록 히스토리가 이 훅으로 진행형 교체를 구현한다.

**줄 편집기**:
`terminal/line-editor.ts`의 `createLineEditor`(세션 소유). autoIndent·blockHistory·tabReader 세 정책을 묶어
`begin`·`end`·`dispose`·`requesting` 넷으로 낸다. `begin(pending, restore)`가 세 정책의 `ReadOptions` 조각을
합성해 `promptRow.read`의 `readOptions` thunk로 넘긴다(flush 뒤, `readline.read()` 직전에 평가된다 — restore
소비·Tab 세대가 이 시점에 묶여 있다). `onKey`는 앞에서부터 먼저 소비한 쪽이 이기고, `prefill`·`historyEntry`는
뒤가 이긴다. 옛 `terminal/read-options.ts`의 `mergeReadOptions` 순수 함수를 흡수했다(RD-029, `docs/design/06-editing.md`
6.8).

### 실행

**제출**:
Enter 한 번으로 worker에 넘어가는 입력 단위. 한 줄이거나 개행이 든 여러 줄이다.
_Avoid_: 커맨드, 셀

**블록**:
`... ` 프롬프트로 이어지는 미완성 복합문 입력. 제출이 아니라 판정(`incomplete`)의 결과다.

**프리필**:
`... ` 다음 입력줄에 자동으로 채워 넣는 들여쓰기 텍스트(`terminal/auto-indent.ts`의 `nextIndentation`).
벤더 `ReadOptions.prefill`로 넣는다. 일반 Enter·붙여넣기·`input()`에는 넣지 않는다.
_Avoid_: 자동완성(Tab 완성과 혼동), 힌트

**`lastUsedIndentation`**:
세션이 사는 동안 유지되는 "마지막으로 본 들여쓰기 단위"(`_pyrepl`의 `last_used_indentation`과 같은 개념).
`createAutoIndent(readline)`가 소유하는 클로저 상태이고, 세션 리셋은 새 객체를 만들어 4칸(`DEFAULT_UNIT`)으로
되돌린다. 취소로는 지워지지 않는다.
_Avoid_: 들여쓰기 폭(단위 자체를 가리킬 때는 이 말을 쓴다. 상태 이름과 섞지 않는다)

**`onKey`**:
벤더 `ReadOptions.onKey`. 활성 읽기의 키마다 벤더 처리 앞에서 불려 `true`를 돌려주면 그 키를 소비한다.
자동 들여쓰기(Shift/Alt+Enter·Backspace)와 Tab 완성이 같은 훅을 쓴다.
_Avoid_: 키 핸들러(범용 이벤트 핸들러와 혼동)

**중단**:
실행 중 Ctrl+C로 사용자 코드에 `KeyboardInterrupt`를 올리는 것.
_Avoid_: 취소, 인터럽트(신호 자체를 가리킬 때만)

**정지한 실행**:
사용자 코드가 실행 중이지만 Python이 돌지 않는 상태(`run_sync`·`asyncio.run`·top-level await 대기). SIGINT 폴링이 없어 감시 타이머가 깨운다.
_Avoid_: idle(프롬프트 유휴와 혼동)

**깨우기**:
정지한 실행을 취소해 사용자 지점에서 `KeyboardInterrupt`가 나게 하는 것. Python `interrupt_idle()`(TS 타입 `InterruptIdle`)이 진입점이고 감시 타이머와 핸들러 규칙 ③이 부른다(`run_sync` 래퍼의 C 변환 구간에서 처리된 눌림도 규칙 ①이 아니라 규칙 ③의 미룬 깨우기로 온다). 깨웠으면 참을 돌려주지만 **거짓이 "깨우지 못했다"를 뜻하지는 않는다**(핸들러 규칙 ③이 한 틱 미뤄 둔 깨우기가 먼저 돈 경우가 있다).
_Avoid_: 인터럽트, 재개

**`time.sleep` 조각**:
`time.sleep`을 20ms 조각으로 나누고 조각마다 `checkInterrupt()`를 부르는 래퍼(`worker/sleep-slice.py`). 원본은 `time.sleep.__wrapped__`이고 JSPI 유무와 무관하게 항상 교체한다. 조각이 있으면 sleep 중에도 사용자 스택이 살아 있어 깨우기가 아니라 일반 중단 경로로 끊긴다.
_Avoid_: 슬라이스 sleep, 청크

**`IdleInterrupt`**:
top-level await 대기를 깨울 때 콘솔 task를 끝내는 표지 예외(`Exception` 계열이라 webloop 재던짐 경로를 피한다). `formattraceback`이 `KeyboardInterrupt` 한 줄로 바꿔 보여 준다.

**프롬프트 유휴**:
REPL 읽기를 기다리며 사용자 코드가 없는 상태(`ReplLoopDeps.setAtPrompt(true)` 구간). 여기서 남은 SIGINT는 폐기한다.

### `runSource`(RD-022a)

**`runSource`**:
`ReplHandle.runSource(code): Promise<RunResult>`. 호스트가 REPL 세션의 globals에서 코드를 실행시키는 공개 API. 입력 줄 에코 없이 출력만 내고 치던 줄을 보존해 다시 그린다. 규칙은 `docs/design/02-console-core.md` 5.6.
_Avoid_: 실행 API(runner의 `run`과 혼동), 원격 실행, 주입

**`busy`(게터)**:
`ReplHandle.busy`. 지금 `runSource()`를 부르면 `RunRejectedError("busy")`가 되는가. `runSource()`의 거부 판정(`judge()`)과 같은 함수를 읽는다. 대기로 받아들여질 시점(`loading`)·`unavailable`·`disposed`는 거짓이다.
_Avoid_: 게이트(Ctrl+C 송신 판정 `pythonRunning`), 실행 중 플래그

**슬롯**:
`runSource` 하나가 차지하는 자리(핸들이 소유, `run-source.ts`의 `createSourceSlot`). 단계는 `waiting`(첫 `readLine` 요청 전, worker에 아직 보내지 않음)·`sent`(`{ source }`를 보냈고 결말 도착 전)·`settling`(결말 도착, 복원한 줄이 그려지기 전). 세션(worker)을 넘어 산다: 대기 중인 코드가 `reset()`을 넘겨 새 worker의 첫 프롬프트에서 실행된다.
_Avoid_: 큐(대기열이 아니라 한 자리다), 작업

**루프 명령**:
`readLine` 응답 `{ source }`. worker 루프가 줄 제출 한 건처럼 받아 REPL 콘솔에서 실행한다(`setAtPrompt(false)` → `discardPendingInterrupt()` → 실행). 그래서 Ctrl+C·`input()`·type-ahead가 평소 명령 실행과 같은 경로다.
_Avoid_: 원격 호출, 동시 RPC

**결말 운반**:
`{ source }` 실행의 결말(`RunOutcome`)을 다음 `readLine` 요청의 네 번째 인자 `outcome`으로 main에 돌려주는 것. 결말이 새 읽기가 열리기 전에 도착해야 정착 시점(아래)을 지킬 수 있다.
_Avoid_: 결과 알림

**가져가기**(`takeRead`):
main이 열린 REPL 읽기를 제출·history 없이 끝내 프롬프트·입력 행을 지우고 텍스트·커서를 보존하는 것(벤더 `Readline.takeRead()`, `ReadTakenError`로 끝남). 취소(`ReadCancelledError`, 리셋 경로)와 다르다.
_Avoid_: 중단, 취소

**정착**:
`runSource` Promise가 결말로 resolve하는 시점. 결말이 도착하고 보존한 줄로 다음 `>>> ` 읽기가 화면에 그려진 뒤(벤더 write 콜백 뒤)다.
_Avoid_: 완료(실행이 끝난 시점과 구분한다)

### Tab 완성

**Tab 리더**:
`createTabReader`(`terminal/tab-reader.ts`)가 만드는 세션 소유 정책 객체. Tab 키를 `onKey`로 가로채
삽입·목록 표시·큐잉·취소 인터럽트를 담당한다. `createAutoIndent`·`createBlockHistory`와 같은 패턴이다.
_Avoid_: 완성기(worker `complete_source`를 가리킬 때만 이 말을 쓴다)

**세대**(`generation`):
Tab 리더가 `readOptions(pending)`마다 1 증가시키는 카운터. `complete` 응답이 요청 때와 다른 세대면 버린다.

**큐 Tab**(`queuedTabs`):
`complete` 왕복(`requesting`)이나 벤더 `printAbove` 재그리기 중 눌린 Tab. 왕복·재그리기가 끝난 뒤(성공·
실패 모두) 순서대로 이어 처리한다. 다른 세대의 큐 항목은 버린다.

**`printAbove`**:
벤더 `Readline.printAbove(text: string): Promise<void>`. 활성 입력줄 위에 `text`를 찍고 같은 읽기로
다시 그린다(State 재생성 없음). 활성 읽기가 없으면 `println`과 같다. 재그리기가 끝난 뒤에만 resolve한다.
배경 출력(`printAboveRaw`)의 재그리기를 기다리는 중이면 그 재그리기에 합류하고, 접두를 비운다(`docs/design/06-editing.md` 6.1).
_Avoid_: `println`(세션 밖 출력, 재그리기 없음)

**완성 popover**:
옵션(`ReplOptions.completionPopover`)을 켰을 때 두 번째 Tab의 후보 목록을 텍스트 대신 커서 옆에 띄우는
선택 상자(`terminal/completion-popover.ts`). 규칙 정의는 `docs/design/07-tab-completion.md` 7.6 한 곳.

**`complete_source`**:
worker `worker/complete-source.py`의 진입 함수. `console.complete(source)`를 후처리(정렬·내부 이름
(`INTERNAL_PREFIXES`) 제외·예외 삼킴·경고 억제)해 `(completions, start)`를 돌려준다. `KeyboardInterrupt`는
`except Exception`을 지나 그대로 전파된다.

**Python 소스**:
worker가 pyodide에 넣는 Python 코드. TS 문자열이 아니라 `.py` 파일(REPL 전용은 repl `src/worker/*.py`, 공통 `sigint-handler.py`·`sleep-slice.py`·`webloop-reraise.py`는 core `src/worker/`)이고 `import SOURCE from "./x.py?raw"`로 가져온다(tsdown `load` 훅 + `src/py-modules.d.ts`). `runPython(SOURCE, { globals, filename })`의 `filename`은 `<console-helpers>`처럼 **`<…>` 꺾쇠 이름**을 쓴다 — 트레이스백에 새면 알아보기 위한 것이고, 절단은 문자열이 아니라 코드 객체로 한다.
_Avoid_: 인라인 스크립트, 템플릿 문자열

### 인터럽트

**눌림**:
사용자의 Ctrl+C 한 번. 요청 번호 하나에 대응한다.
_Avoid_: 시그널, 이벤트

**SIGINT**:
interrupt buffer 슬롯 `[0]`의 값 2. pyodide 폴링이 소비한다.

**요청 번호**:
슬롯 `[2]`. 눌림마다 1 증가하고 재전송은 같은 번호다.
_Avoid_: seq(코드 상수명으로만), 시퀀스 ID

**ack**:
슬롯 `[1]`. worker가 눌림을 받았다는 표시. 핸들러 진입·감시 타이머 소비·폐기 지점에서만 올린다.

**재전송**:
송신기가 소실로 판정한 눌림을 같은 요청 번호로 다시 쓰는 것(5ms 점검, 최대 10회).
_Avoid_: 재시도

**폐기**:
대상 코드가 없는 SIGINT를 지우고 ack하는 것(실행 직전은 repl `worker/repl-loop.ts`, 버퍼 연결 직전은 core `worker/runtime-attach.ts`의 `attachRuntime`, 프롬프트 유휴는 core `worker/interrupt-watch.ts`의 감시 타이머). 핸들러의 "`<console>` 프레임 없으면 버린다"도 같은 목적이다.

**송신기**:
main의 눌림 전송·점검·재전송 상태기계(core `protocol/interrupt-sender.ts`).

**게이트**:
main이 보는 "Python 실행 중"(core 세션의 `pythonRunning`. REPL은 `ReplSession.interrupt()`가 읽는다). core 세션의 식 `alive && inputReadsPending === 0 && !driver.isIdle()`이고, REPL driver의 `isIdle`은 `phase !== "idle"`(REPL 읽기 phase, 아래)이다. 즉 worker가 살아 있고(`alive`) 대기 중인 `readLine`·`readInput` 읽기가 없고 취소 직후 구간이 아니면(`phase !== "cancel-settling"`) 참이다. 거짓이면 Ctrl+C를 에코도 전송도 하지 않는다. 로딩 중은 참이다(부팅 중 눌림은 worker의 연결 단계가 폐기한다).
_Avoid_: running 플래그, busy(`ReplHandle.busy`는 게이트가 아니라 `runSource()` 거부 판정이다)

**REPL 읽기 phase**:
`repl-main-driver.ts`가 소유하는 변수 하나(`"idle" | "opening" | "open" | "closing" | "cancel-settling"`, RD-029).
옛 driver의 `reading`·`readLinePending`·`cancelSettling`과 흡수된 `source-bridge.ts`의 `readState`를 대체한다.
`cancel-settling`은 REPL 읽기가 취소 **또는 EOF**(RD-048, `06-editing.md` 6.9)로 끝난 뒤 다음 요청이 도착하기 전까지의
값이다(`readLine` 도착·`readInput` 도착·`inputReadsPending → 0`에서 `idle`로 내려간다). 이 구간의 Ctrl+C는 SIGINT를
남겨 다음 실행을 죽이므로 막는다. `input()` 취소·EOF에는 이 값을 세우지 않는다(취소 뒤에도 사용자 코드가 계속 돈다,
EOF는 취소와 같은 이유로 세우지 않는다). 정의는 `docs/design/08-session.md` 8.1.
_Avoid_: `readLinePending`·`cancelSettling`·`reading`(리팩터 전 이름), guardAfterCancel(이전 구현의 벤더 인자 이름)

**감시 타이머**:
worker의 20ms 타이머. 정지한 실행 중 SIGINT를 엿보고 깨우며, 프롬프트 유휴 SIGINT를 폐기한다.
_Avoid_: 워치독, 폴러

### 채널

**RPC**:
전용 MessagePort 위의 요청/응답/알림. 비동기.
_Avoid_: 브리지, 프록시

**메일박스**:
stdin 읽기 응답을 담는 SharedArrayBuffer. worker가 `Atomics.wait`로 기다린다.
_Avoid_: 동기 브리지, 채널

**interrupt buffer**:
pyodide `setInterruptBuffer`에 넘기는 `Int32Array(4)`. 세션 간 재사용한다.

**초기화 프레임**:
worker 생성 직후 main이 보내는 단 하나의 네이티브 메시지. 포트·버퍼·driver 옵션(`driver` 필드, REPL은 `{ topLevelAwait }`)을 담는다.
_Avoid_: handshake

### 출력

**sink**:
main이 터미널에 쓰는 함수 4종(`write`, `writeErrorRaw`, `writeOutput`, `writeError`). 개행·색 규칙을 가진다.
_Avoid_: 로거, 출력 콜백

**값 에코**:
식의 결과를 `repr()`로 `writeOutput`에 내는 것. `None`은 내지 않는다.
_Avoid_: displayhook, 결과 출력

**전역 스트림**:
콘솔 리다이렉트 밖에서 Python이 쓰는 stdout/stderr. 배경 콜백 출력이 여기로 온다.

**안내 줄**:
세션 밖에서 main이 찍는 개행으로 끝나는 한 줄(비격리 경고·리셋 안내). `promptRow.notice`(RD-027·RD-028, 구 `writeNotice`)로
낸다 — 현재 io가 있으면 그 꼬리를 거쳐(꼬리에 보이는 글자가 있으면 `\r\n` 뒤에 쓰고 비우며, 없으면 `println`과 같은 바이트) 쓰고, 현재 io가
없으면 `readline.println`으로 낸다. TRAP-12(sink를 거치지 않는 출력 경로 금지)의 예외였던 것은 RD-028에서 없어졌다
(`05-output.md` 4.1).
_Avoid_: 시스템 메시지, 로그

### 동등성

**동등성 기준**:
CPython 3.14.4 `_pyrepl`을 pty 24×80으로 띄운 실측 화면.
_Avoid_: 레퍼런스, 원본 동작

**편차**:
동등성 기준과 다르다고 확인하고 문서에 남긴 동작.
_Avoid_: 버그, 한계(원인이 라이브러리 제약일 때만)

**범위 밖**:
편차 중 재현하지 않기로 확정한 것. 로드맵에 등록하지 않는다.
