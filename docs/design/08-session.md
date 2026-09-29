# 세션: 리셋·이중 마운트·종료 후 상태

> 이 문서의 규칙·상수 근거는 CPython 3.14.4 pty 실측과 브라우저 회귀다.

## 8.1 리셋 = worker 교체(`ReplHandle.reset()`, RD-010)

소유권:

- `readline`(벤더 `Readline`)·Ctrl+C 핸들러·`surface`(따라서 `promptRow`, RD-027)는 핸들(`index.ts`) 소유다. 리셋을 넘어 산다.
- interrupt buffer·송신기는 세션(`session.ts`) 소유다. 세션마다 새로 만든다(아래 5번).
- `Terminal`(화면)은 호출자 소유다. 마운트 시 1회만 만든다.
- 세션 1개(worker·RPC·sink·가드·게이트)는 `session.ts`의 `startSession()`이 만든다. `reset()`이 통째로 교체하는 단위다(`00-architecture.md` 4.2).

`startSession()`은 두 부분을 조립한다.

- core 세션(`startCoreSession`, core `session/core-session.ts`)이 맡는 것:
  - worker·`MessageChannel`·메일박스·초기화 프레임.
  - RPC(core 핸들러 + driver 핸들러 합성).
  - `readInput` 처리·게이트 `alive`·`inputReadsPending`·크래시·종료.
- REPL main driver(`createReplMainDriver`, `repl-main-driver.ts`)가 맡는 것:
  - sink·`surface.promptRow`로 낸 읽기·가드.
  - 줄 편집기(`terminal/line-editor.ts`, `06-editing.md` 6.8).
  - 읽기 phase(아래)로 파생하는 게이트.
  - `readLine`/`writeOutput`/`writeError` 핸들러.
  - 종료 시 읽기 정리.

`promptRow`는 세션마다 새로 만들지 않는다. 위젯 수명이다. `surface.openIo()`가 세션마다 새로 여는 "현재 io"만 본다(RD-027).

**REPL 읽기 phase**(`repl-main-driver.ts`, RD-029). driver 안 변수 하나 `phase: "idle" | "opening" | "open" | "closing" | "cancel-settling"`가 읽기 상태를 나타낸다.

- `idle`: 열린 REPL 읽기가 없다.
- `opening`: `readLine` 요청을 수락해 벤더 읽기를 열었지만 아직 화면에 그려지지 않았다.
- `open`: 그려져 입력을 기다린다(`runSource`가 가져갈 수 있다).

  `opening → open` 전이와 결말 정착(`link.settle()`)은 벤더 사건이 아니라 `promptRow.read`의 `onOpen` 안에서 건 `io.terminal.write("", cb)`의 FIFO 순서로 잰다.

  - 첫 콜백: 벤더가 활성 읽기를 세운 뒤.
  - 둘째 콜백: 그리기 바이트를 처리한 뒤.

  "그려짐"을 prompt row·벤더의 사건(`ReadOptions.onActive` 등)으로 내는 안은 기각했다.

  - driver가 쓰는 시점이 셋(벤더 promise 종료·활성·그리기 처리)이다.
  - `onOpen`을 지우려면 소비자 1개를 위한 사건 3개가 필요하다.
  - 사건 하나만 내면 줄어드는 코드가 얼마 되지 않는다.
  - 같은 FIFO 가정은 `rewind-tail.ts`·벤더 `read()`에도 남는다.

  재검토 조건:

  - 그려짐 시점이 필요한 두 번째 소비자(예: `terminal-runner`)가 생긴다.
  - xterm 갱신으로 write 콜백 FIFO 순서가 깨진다.

  그때는 벤더 공개 API로 낸다. prompt row가 `write("", cb)`를 대신 거는 것은 위치만 옮긴다.

- `closing`: 벤더 읽기가 끝났거나(줄 제출·취소) `sendSource()`가 가져갔지만, 바깥 promise 처리(`readLine` 핸들러의 `.then`, 줄/취소 응답)는 아직이다.
  - 벤더 read promise가 끝나는 시점에 이 phase로 전이한다.
  - 그 전이가 바깥 promise 처리보다 몇 마이크로태스크 앞선다.
  - `promptRow.read`가 `async` 함수라 바깥 promise는 벤더 원시 promise보다 정확히 1틱 늦게 정착한다.
  - `sourcePrompt()`가 이 창에서 `open`이 아니라 `busy`를 내는 근거다.
- `cancel-settling`: `null` 응답(Ctrl+C 취소) 또는 `{ eof: true }` 응답(`>>>` 빈 줄 Ctrl+D, RD-048) 뒤부터 다음 `readLine` 요청·`inputRequested`·`inputResumed` 중 먼저 오는 것까지.
  - 이 구간에는 벤더에 활성 읽기가 없다.
  - Ctrl+C가 `setCtrlCHandler`로 온다. 그 눌림을 보내면 아무도 소비하지 않은 SIGINT가 남는다. 다음 `push`가 죽는다(TRAP-04).
  - EOF 응답은 새 phase를 만들지 않고 이 방어를 재사용한다.
  - `sessionTerminated`가 올 때까지 phase가 남아 있어도 그 구간의 Ctrl+C·`runSource()`·`reset()`은 기존 취소 경로와 같은 모양으로 안전하다(`06-editing.md` 6.9).

파생 값:

- `isIdle() = phase !== "idle"`. `03-ctrl-c.md` 2.7의 게이트 `pythonRunning`이 이 값을 합성한다.
- `sourcePrompt()`(`SourcePrompt = "wait" | "busy" | "open"`):
  - `wait`: 첫 `readLine` 요청 전.
  - `open`: `phase === "open"`이고 블록 입력 중이 아니고 stdin 대기가 없고 Tab 왕복 중(`lineEditor.requesting`)이 아닐 때.
  - `busy`: 그 밖.

`terminate()`의 줄 편집기 정리 `lineEditor.dispose(readOpen)`는 `readOpen = phase ∈ {"opening", "open", "closing"}`를 쓴다.

- `readOpen`이면 대기 중이던 블록을 history에서 버린다(`blockHistory.discard()`).
- Tab 왕복은 `readOpen`과 무관하게 항상 동기로 끝낸다(`tabReader.readEnded(null)`).
  - 뒤이은 `rpc.dispose()`의 `complete` 요청 reject가 취소된 세션 상태를 건드리지 못하게 막는다.

`reset()` 순서. 자동 들여쓰기 단위(`lastUsedIndentation`)는 세션 소유(`createAutoIndent`, RD-013)다.

- 별도 초기화 단계가 없다.
- 5번이 새 세션을 만들 때 REPL main driver가 `createAutoIndent(readline)`을 다시 불러 새 객체(4칸)가 된다.

1. `promptRow.endRead({ screen: true })`(RD-027·RD-028). 열린 읽기를 끝내며 화면을 정리한다.
   - `session.terminate()` 앞, 같은 동기 블록이어야 한다.
     - 훅 안 `endRead({ screen: false })`가 먼저 돌면 settle할 읽기가 남지 않아 조용히 `settled = false`가 된다(`06-editing.md` 6.1, `docs/traps/TRP-083`).
   - 훅의 줄 편집기 폐기 조건(읽기 phase가 `opening`·`open`·`closing`)은 같은 동기 블록에서는 아직 열린 값이다.
     - read promise는 마이크로태스크에서 settle되며 그때 `idle`로 내려간다.
     - Tab 대기열 정리도 그대로 된다.
     - 시험: `repl-main-driver.test.ts` [P17], `create-repl/tab-completion.test.ts`, `create-repl/reset.test.ts`(옛 세션을 끝내는 순서).
   - `endRead`는 벤더 `readline.hasPendingRead()`를 `cancelRead({ settle: true })` **앞**에서 읽는다. "그리기 전 읽기가 있었는가"를 확정한 뒤 `cancelRead`를 부른다.
   - `settled`면 끝이다. 아니면 다음과 같다.
     - `hasPendingRead()`가 참이었으면 무조건 개행한다. 열린 읽기가 write 콜백을 기다리는 상태라 행 머리 여부를 벤더가 모른다.
     - 거짓이었으면(열린 읽기 없음) 현재 io 꼬리에 보이는 글자가 있을 때만 개행한다.
   - 판정 재료는 항상 현재 io 꼬리다(RD-028).
     - xterm 6.0.0의 `write`는 파싱을 `setTimeout`으로 미룬다. 같은 태스크의 `buffer.active.cursorX`가 낡을 수 있어 커서 판정을 쓰지 않는다.
     - 개행은 "현재 io"가 있으면 그 꼬리에 공급한다.
   - 그리기 전 창(write 콜백 대기 중)에서 reset하면 꼬리가 비어 있어도 무조건 개행이 난다. 안내 앞에 빈 행이 하나 더 생긴다. 의도한 화면 바이트다.
   - settle 자체는 취소 시점 상태에 따라 화면을 정리한다(`06-editing.md` 6.1 상태표).
     - 배경 출력 재그리기 콜백 전이라 아직 그리지 않은 접두가 있으면 `접두 + "\x1b[0m\r\n"`을 써 자기 행으로 남긴다(`05-output.md` 4.4).
     - 그려진 읽기면 커서를 감긴 입력의 끝으로 옮겨 다시 그린 뒤 `\r\n`을 쓴다.
2. `session.terminate()`. 옛 세션을 끝낸다.
   - core 세션(`terminate()`)의 순서:
     1. `ended=true`.
     2. REPL main driver의 `terminate` 훅.
     3. `endSession()`(`alive=false`, `interruptSender.cancel()`).
     4. worker `error` 리스너 제거.
     5. `rpc.dispose()`.
     6. `worker.terminate()`.
   - `rpc.dispose()`가 `worker.terminate()`보다 앞이어야 한다.
   - 훅의 순서: `io.close()` → `lineEditor.dispose(readOpen)` → `promptRow.endRead({ screen: false })`.
     - `io.close()`: 게이트를 닫아 `promptRow`의 "현재 io"에서 빠진다.
     - `lineEditor.dispose(readOpen)`: `readOpen`이면 `blockHistory.discard()`로 대기 중 블록 history를 첫 줄까지 버린다(RD-014, `06-editing.md` 6.4·6.8).
     - `readOpen`과 무관하게 `tabReader.readEnded(null)`: `ended=true`·큐 비움을 동기로 확정한다. 뒤이은 `rpc.dispose()`의 `complete` 요청 reject가 취소된 세션의 버퍼·커서로 큐를 다시 처리하는 것을 막는다(RD-015).
     - `promptRow.endRead({ screen: false })`: settle 없음. 화면·history·리스너·`term`은 건드리지 않는다(`06-editing.md` 6.1).
   - 훅은 화면에 쓰지 않는다. `io.close()`·history 폐기·`tabReader` 종료·`endRead({ screen: false })`·`endSession`·`rpc.dispose`·`worker.terminate` 전부 무출력이다.
   - REPL 리셋에서는 1번의 settle 취소가 이미 읽기를 끝냈다. 이 호출은 무동작이다(type-ahead·`queued`도 이미 비었다).
3. `session = undefined`. 새 worker 생성이 실패해도 끝난 옛 세션을 가리키지 않게 한다.
4. `promptRow.notice(RESET_NOTICE, "info")`(RD-027). 청록 안내 줄 `[세션 리셋됨 — 이전 변수/import가 모두 초기화되었습니다]`.
   - 이 호출은 2번의 `io.close()` 뒤라 현재 io가 없다. `notice`는 io 없음 경로(`readline.println`, RD-028)를 탄다.
   - 이 시점의 행 머리는 1번 `endRead`가 이미 보장했다.
5. `startSession(...)`로 새 세션을 만든다.
   - 새로 만드는 것: `MessageChannel`·메일박스·interrupt buffer·송신기·`InitFrame`·RPC·worker(`createWorker()`)·sink 세트·`promptRow`가 보는 새 `io`·가드·게이트.
   - 옛 buffer에 남은 SIGINT는 새 worker가 보지 못한다. 그래서 리셋이 `SIGNAL`을 지우는 단계는 없다.
   - 옛 worker가 `terminate()` 뒤에도 Chromium에서 최대 약 2초 살아 같은 buffer의 눌림을 가로챌 수 있다. buffer 분리가 이를 막는다(`14-runner.md` 14.3.5, `docs/traps/TRP-049`).
   - 리셋 직전 Ctrl+C가 새 세션의 시작 코드를 죽이지 않는 것도 이 분리가 보장한다(브라우저 `session-reset-check.mjs`의 `ccreset`·`ccafter`).
6. `onStatus("loading")`을 동기로 발행한다. 이후 새 worker의 `ready`/`loadFailed` 알림이 `ready`/`load-failed`를 재발행한다.

5번에서 `createWorker()`가 던지면(잘못된 URL, `SecurityError`) `reset()`은 던지지 않는다.

- 핸들의 세션을 비운다.
- 6번 대신 `onStatus("crashed")` → `onCrash?.(String(error))` 순으로 부른다. `dispose()` 뒤면 `onCrash`를 생략한다.
  - core `createRunner.reset()`의 `restart()`와 같은 계약이다(`14-runner.md`).
- 그 뒤 `busy`는 `false`다. `runSource()`는 `unavailable`로 거부한다. 복구는 다시 `reset()`이다.
- 소비자가 `onCrash` 안에서 동기로 `reset()`을 부르면 생성이 계속 실패할 때 재귀한다. 데모(`ReplView`)는 `onCrash`에서 메시지만 저장하고 재시작은 버튼으로 한다.
- `crashed` 콜백 안에서 `reset()`을 부르면 그 리셋의 `loading`이 먼저 나가고 실패한 생성의 `onCrash`는 그 뒤에 온다(runner와 같다, `14-runner.md` "상태 콜백 재진입").
- 세션이 없는 채로 다음 `reset()`이 오면 1번의 `promptRow.endRead(...)`만 부른다. 2번 `session.terminate()`는 `session`이 이미 `undefined`라 건너뛴다. `crashed` 동안 쌓인 type-ahead 키를 버린다.
  - 열린 읽기가 없어 settle은 화면에 쓰지 않고 `settled = false`다. 1번의 대체 개행 규칙을 탄다.
  - 커서는 실제 터미널이 아니라 꼬리로 판정한다. 실패한 `startSession`이 `createWorker()` 전에 `openIo()`를 불렀고 그 io는 닫히지 않는다. "현재 io"는 그 io다. 개행은 그 꼬리에 공급된다.
- worker를 만든 뒤 프레임 전송이 던지면 core 세션(`startCoreSession`)이 정리한 뒤 던진다.
  - 그 worker의 `error` 리스너를 떼고 `rpc.dispose()`·`worker.terminate()`를 부른다. 남은 worker의 뒤늦은 `error`가 다음 세션을 `crashed`로 바꾸지 않게 한다.
  - REPL은 이것도 같은 `crashed` 경로로 받는다.
- 화면에는 이미 `RESET_NOTICE`가 찍혀 있다(4번이 5번보다 앞이다).

`dispose()` 뒤 `reset()`은 no-op이다. `!isolated`(worker가 없다)에서도 no-op이다. 그 외 상태(`ready`·`terminated`·`crashed`·`load-failed`·`loading`)는 전부 허용한다.

- `{ topLevelAwait? }` 옵션은 새 프레임에 실린다. 생략하면 마지막 값을 유지한다(RD-012).
- 확인 대화상자·디바운스는 없다.

세션 소유 vs 핸들 소유(`session.ts`·`repl-main-driver.ts`·core `session/core-session.ts`):

- 세션이 소유한다:
  - 게이트(`alive`·`inputReadsPending`·REPL 읽기 phase, 위)·`ended`.
  - sink(`surface.openIo()`의 `io`)·가드.
  - 줄 편집기(`terminal/line-editor.ts`, `06-editing.md` 6.8):
    - `autoIndent`의 `lastUsedIndentation`(RD-013).
    - `blockHistory`의 기준점 `blockBase`·`pendingBlock`(RD-014).
    - `tabReader`의 세대·큐·왕복 상태 `requesting`(RD-015).
  - 메일박스·RPC·worker·interrupt buffer·송신기.
- 리셋마다 전부 초기값으로 새로 만든다. 옛 세션의 상태(예: 취소 응답 직후의 phase `cancel-settling`)가 새 세션으로 새지 않는다.
- 핸들이 소유한다: `readline`·`surface.promptRow`(RD-027, 읽기·take·행 머리 보장을 낸다)·Ctrl+C 핸들러·`dispose()`·`reset()`.
  - Ctrl+C 핸들러는 `session?.interrupt()`를 현재 세션 변수로 늦게 읽는다. 리셋으로 세션이 바뀌어도 다시 등록할 필요가 없다.
  - 게이트·에코·전송은 세션이 한다(`03-ctrl-c.md` 2.7).

화면·history는 유지된다. `Readline`이 핸들 소유라 벤더 `History`(`persist: false`, 메모리만)가 세션을 넘어 산다.

- 리셋 시 미제출 입력·대기 읽기·쌓인 type-ahead 키(`06-editing.md` 6.7)는 버린다. history에는 기록하지 않고 화면에는 남긴다.
- 이유: `cancelRead({ settle: true })`가 벤더 읽기를 history를 건드리지 않고 끝내며 입력줄을 화면에 확정한다.

**옛 세션의 열린 읽기(정의 절): 판정 규칙 D1~D6.** "끝남" = core 세션의 `ended || crashed`뿐이다. driver는 오류 종류로 폐기를 알리지 않는다. core가 자기 플래그만으로 판정한다(`session/core-session.ts` `readInput` 핸들러).

| ID  | 사건                                     | 규칙                                                                                                                       |
| --- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| D1  | `readInput` 알림 도착 시 끝남            | 아무것도 하지 않는다. `interruptSender.cancel()`·`inputRequested`·`inputReadsPending` 증가·`driver.readInput`이 모두 없다. |
| D2  | 열린 읽기가 resolve(줄·`null`)할 때 끝남 | 메일박스에 기록하지 않는다(`deliver`·`cancel` 없음).                                                                       |
| D3  | 열린 읽기가 reject할 때                  | 끝났으면 기록하지 않는다. 살아 있으면 오류 종류와 무관하게 `fail(String(error))`을 쓴다.                                   |
| D4  | D2·D3의 `finally`                        | `inputReadsPending -= 1` 뒤 `inputResumed?.()`를 부른다. 끝난 세션에서도 부른다.                                           |
| D5  | runner `PendingInput.abandon()`          | 공급자 `AbortController.abort()` 뒤 `null`로 resolve한다.                                                                  |
| D6  | driver가 미룬 읽기를 열려는 시점에 끝남  | driver는 읽기를 열지 않고 `null`로 resolve한다(D2가 버리고 D4가 돈다).                                                     |

- D1: 메일박스에는 기록하지 않는다. worker는 메일박스에 정지한 채 남는다. `reset()`의 `worker.terminate()`가 정리한다.
- D5: 세션이 살아 있으면(Ctrl+C·`stop()`) core가 메일박스에 `cancel`을 쓴다. 끝났으면(크래시·`terminate()`) D2가 버린다.
- D6: 판정은 core가 `driver.readInput`에 넘긴 `sessionEnded()`(`ended || crashed`)가 한다. 미루는 driver는 REPL read-guard뿐이다(`terminal/read-guard.ts`).

REPL에서는 두 호출이 열린 읽기를 `ReadCancelledError`로 끝낸다.

- `reset()`의 `endRead({ screen: true })`.
- driver `terminate` 훅의 `endRead({ screen: false })`. `reset()`·`dispose()`가 `session.terminate()`로 부른다.

`reset()`은 `endRead`를 `session.terminate()` 바로 앞 같은 동기 블록에서 부른다. reject는 마이크로태스크에서 처리되므로 core가 오류를 볼 때 세션은 이미 `ended`다(D3에서 기록 없음).

- D1~D3은 오류 종류를 보지 않는다. REPL은 별도 판정을 내지 않는다.
- D1~D4는 core `readInput` 핸들러 몫이다. D5는 runner `PendingInput.abandon()` 전용이다. D6은 REPL read-guard 전용이다.
- `ended`면 `fail()`도 쓰지 않는다. worker는 이미 terminate됐고 `fail()`의 `untilIdle`이 영영 안 풀릴 수 있다(`docs/traps/TRP-003`).

REPL `readLine` 핸들러(core `readInput` 경로 밖)는 `ReadCancelledError`를 driver가 직접 판정한다.

- 영영 안 풀리는 Promise를 돌려줘 RPC가 응답을 보내지 않는다(`repl-main-driver.ts`).
- 옛 worker는 이미 종료 중이라 응답을 기다리지 않는다.

`runSource`(RD-022a, `02-console-core.md` 5.6)의 슬롯은 핸들 소유라 리셋을 넘어 산다.

- 세션 순서에서 슬롯을 비우는 시점은 `onStatus` 콜백 앞이다. 결과는 콜백 뒤에 낸다(`docs/traps/TRP-051`). 콜백이 던져도 결말은 온다(8.5 X2).
- 리셋:
  - 실행 중(`{ source }`를 보낸 뒤 결말 도착 전)이면 `restarted`로 resolve한다.
  - 대기 중(첫 프롬프트 전)이면 유지한다. 새 세션의 첫 `>>> `에서 실행한다.
- 리셋 중 worker 생성이 실패하면 실행 중은 `restarted`, 대기 중은 `crashed`다. `crashed` 발행이 대기 슬롯을 끝낸다.
- 옛 세션 정리(`session.terminate()`) 자체가 던지면 그 예외는 호출자에게 간다.
  - 슬롯에서 뗀 실행은 `finally`에서 `restarted`(리셋)·`disposed`(`dispose()`)로 끝난다.
  - 이때 상태는 옛 값으로 남는다.
  - 실제 `worker.terminate()`·`cancelRead()`는 던지지 않아 닿지 않는 경로다.
- 크래시(8.4)는 실행 중·대기 중 모두 `crashed`다.
  - `dispose()`는 `disposed`로 거부한다.
  - 결말이 이미 도착한 슬롯은 그 결말로 resolve한다.
  - 대기 중 `load-failed`는 `unavailable`이다.
- "비우기 → 콜백 → 결말" 순서는 슬롯(`run-source.ts`)이 아니라 세 호출자(`index.ts`의 `emitStatus`·`reset`·`dispose`)가 쓴다.
  - 셋의 모양이 다르다(사건이 있을 때만 비움 / 대기 슬롯 유지·`finally` / 무조건 비움·`finally`).
  - 리셋 본문이 위 결말 규칙 그대로 한 흐름으로 읽혀야 한다.
  - 이 순서를 슬롯 안으로 합치는 안은 기각했다.
- 슬롯을 끝내는 네 번째 호출자가 생기거나 core `createRunner` 슬롯과 합칠 때 다시 본다.

Ctrl+L(화면 지우기)과 리셋(Python 상태 초기화)은 별개 기능이다. Ctrl+L은 벤더 동작 그대로이고 코어는 손대지 않는다(`10-parity-deviations.md` 편차 40).

## 8.2 StrictMode 이중 마운트

- dev의 StrictMode는 mount → cleanup → mount를 한 번 더 돌린다.
- 버려지는 첫 인스턴스의 지연된 `term.write("", cb)` 콜백이 이미 dispose된 xterm에 접근하면 `DisposableStore` 경고가 난다(TRAP-11, throw는 아님).
- 벤더 `Readline.dispose()`가 `term`을 비우고 대기 읽기를 reject한다(`06-editing.md` 6.1). 마운트 직후 읽기를 시작해도 안전하다.
- **상시 `while read()` 재귀 루프를 두지 않는다.** worker가 필요할 때만 읽기를 요청한다.
- `dispose()` 뒤 읽기 promise는 `Error`로 reject된다. 읽기 루프는 dispose로 끝난 reject를 정상 종료로 처리한다.
- 이중 마운트로 interrupt buffer·송신기가 두 번 만들어지는 것은 수용한다. 정확성에 영향이 없다.
- 데모(`ReplView`)가 이 순서로 동작한다.
- 브라우저 확인: `apps/demo/e2e/checks/react-strictmode-check.mjs`가 콘솔 경고 0건과 `.xterm` 1개를 단정한다(`15-react.md` 15.6).

## 8.3 종료 후 상태

- `exit()`/`quit()`/`raise SystemExit()`와 `>>>` 빈 줄의 Ctrl+D(RD-048)가 일으키는 흐름:
  1. worker 루프가 끝나고 `sessionTerminated` 알림을 main에 보낸다.
  2. core 세션이 `endSession()`(`alive=false`)을 부르고 `onStatus("terminated")`를 낸다.
  3. 데모는 Alert로 `Python session terminated. "세션 리셋" 버튼으로 새 세션을 시작하세요.`를 띄운다.
- worker는 더 이상 읽기를 요청하지 않는다. 입력에 응답하지 않는다.
- 복구 경로는 세션 리셋뿐이다.
- 종료 뒤·pyodide 로드 실패 뒤에는 `alive=false`라 게이트가 닫힌다. Ctrl+C가 에코도 전송도 하지 않는다(`03-ctrl-c.md` 2.7).

## 8.4 크래시(RD-010)

worker가 죽거나(전역 `error` 이벤트) 부팅 뒤(REPL 루프)에서 잡히지 않은 예외가 나면(`crashed` 알림, `01-protocols.md` 1.2) core 세션(`session/core-session.ts`)의 `crash(message)`가 다음 순서로 부른다(`00-architecture.md` 3.4).

1. `endSession()`(`alive=false`).
2. `onStatus("crashed")`.
3. `onCrash?.(message)`.

- 둘 중 먼저 온 신호만 반영한다.
- 이미 크래시했거나 `terminate()`됐으면 `crash()`는 아무것도 하지 않는다.

크래시 뒤 상태:

- 터미널에는 아무것도 쓰지 않는다(앱의 Alert가 보여준다).
- worker는 terminate하지 않는다. 복구는 8.1의 `reset()`뿐이다.
- 열린 읽기도 끝내지 않는다.
  - `terminate()`를 부르지 않으므로 main driver `terminate` 훅의 `endRead({ screen: false })`가 돌지 않는다.
  - 읽기는 `reset()`의 `endRead({ screen: true })`가 끝낸다.
  - 크래시가 감긴 꼬리를 되감은 읽기의 그리기 전 창에 와도 같다(`04-stdin-input.md` 3.3 "되감은 읽기의 그리기 전 창 종료", 시험: repl `run-source.test.ts`).
- 열린 읽기의 결과는 core가 버린다(8.1 D2). 화면에 남은 읽기에 Enter해도 worker에 전달되지 않는다.
- 크래시 뒤 도착한 새 `readInput` 알림은 D1이 버린다. 배경 `input()`이 화면을 열지 않는다.
- 크래시 전 도착해 REPL 읽기 뒤로 미룬 stdin 읽기는 D6이 막는다.
  - REPL 읽기를 Enter로 끝내도 배경 `input()`이 새 읽기를 열지 않는다.
  - read-guard가 화면에서 뗀 배경 프롬프트는 읽기 없이 출력으로 그려진다(`04-stdin-input.md` 3.2 "버린 미룬 읽기의 꼬리 그리기").
  - 화면은 `>>> x` / `bg> `이고, 이어진 `reset()`의 안내는 그 아래 행이다.
- 크래시 뒤 게이트(`pythonRunning`)는 `alive=false`라 닫힌다. Ctrl+C가 에코도 전송도 하지 않는다(`03-ctrl-c.md` 2.7).

`error` 리스너:

- core 세션이 worker 생성 직후 건다.
- `session.terminate()`(리셋·dispose 양쪽이 부른다)에서 뗀다.
- 안 떼면 다음 세션이 시작된 뒤 옛 worker가 뒤늦게 죽어도 리스너가 남는다(가비지 컬렉션 전).
- `crash()` 자체가 `ended` 가드로 막으므로 관찰 가능한 차이는 없다. 리스너 제거는 누수 방지 목적이다.

## 8.5 소비자 콜백 예외 격리(X1~X4)

소비자가 넘긴 `onStatus`·`onCrash`(REPL `ReplOptions`, core `RunnerOptions`)·`onLoadFailed`(core `RunnerOptions`)가 던지면 이 규칙으로 격리한다.

- 8.1의 6번·8.4의 `onCrash` 호출도 이 규칙을 따른다.
- 구현은 core `session/consumer-callback.ts`의 도우미 `callConsumer` 하나다. 공개 진입점에서 export하고 REPL(`index.ts`)이 가져다 쓴다.

| ID  | 규칙                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | 위 콜백이 던지면 그 예외를 보고 수단(X3)으로 한 번 보고한다. 호출자에게 다시 던지지 않는다.                                                                 |
| X2  | 던진 뒤에도 그 사건의 내부 흐름은 콜백이 정상 반환한 것과 같다. 대상은 슬롯 결말·이어지는 `onCrash`·대기 run 전송·`load-failed` 반영이다.                   |
| X3  | 보고 수단은 `globalThis.reportError`가 함수면 그것이다(브라우저: 콘솔 + `window` `error` 이벤트). 아니면 `console.error`다(Node·jsdom). 호출 시점에 읽는다. |
| X4  | `onRunAccepted`(core `RunnerOptions`)는 대상이 아니다. 던지면 슬롯을 풀고 그 오류로 `run()`을 reject한다(`14-runner.md` 14.3).                              |

- X2: `callConsumer`는 호출문 하나만 감싼다. 그 뒤 문장은 항상 실행된다.
- X3: 호출 시점에 읽는 이유는 시험의 `vi.stubGlobal`이 먹게 하기 위해서다.

대상: core `createRunner`의 `onStatus`(첫 상태 포함)·`onCrash`·`onLoadFailed`, REPL `createRepl`의 `onStatus`·`onCrash`.

제외:

- `onRunAccepted`(X4).
- `onOutput`·`onCopy`. 내부 갱신 뒤 마지막 호출이라 결말 누락이 없다. 던지면 그 갱신 호출자에게 그대로 전파된다.
- terminal(`createTerminalRunner`)·React(`PythonRepl`·`PythonRunner`). 각자 받은 `onStatus`·`onCrash`를 REPL·core 옵션으로 그대로 전달하기만 한다. 위 두 경계의 격리로 덮인다. 별도 처리가 없다.
