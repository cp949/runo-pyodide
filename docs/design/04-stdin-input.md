# stdin: input() 읽기·취소·read-guard·프롬프트 꼬리

> 이 문서의 규칙·상수는 이전 구현(`/work/cp949/pyodide-samples/apps/repl`, 읽기 전용 참고)이 CPython 3.14.4 pty 실측과 브라우저 회귀로 확정한 것이다. 새 구현은 통신 계층만 바꾸고(`docs/design/00-architecture.md`, `01-protocols.md`) 이 규칙은 그대로 지킨다. 절 끝의 "참고:" 경로는 이전 구현의 근거 위치다.

새 구현에서 `readInput(cancelable)`은 coincident proxy 호출이 아니라 **stdin 메일박스**(`01-protocols.md` 2절)다: worker가 RPC 알림 `readInput`을 보낸 뒤 `Atomics.wait`로 멈추고, main이 메일박스에 줄(또는 취소 표식)을 써서 깨운다. worker 쪽 `stdin-callback`(core `worker/stdin-callback.ts`)은 `createStdinCallback({ requestInput, wait, signalInterrupt, checkInterrupt })`다. core `worker/boot.ts`가 `requestInput`에 `rpc.notify("readInput", cancelable)`를, `wait`에 `createMailboxReader(...).wait`를, `signalInterrupt`에 `() => signalInterrupt(interruptBuffer)`를, `checkInterrupt`에 `() => pyodide.checkInterrupt()`를 주입하고 `readInput` 알림 → `wait()` 순서는 이 모듈이 소유한다(3.1).

## 3.1 stdin 콜백과 취소 변환 규칙(`createStdinCallback`)

- `createStdinCallback({ requestInput, wait, signalInterrupt, checkInterrupt })`. 호출마다 `requestInput(true)`(= `readInput` 알림) → `wait()`(메일박스 `Atomics.wait`) 순서로 돌고 `wait()`가 돌려준 결과(`{kind:"line",text}` | `{kind:"cancelled"}` | `{kind:"eof"}`, `01-protocols.md` 2.2)를 해석해 반환한다: `line`은 그 텍스트, `eof`는 SIGINT 없이 `null`(pyodide가 EOF로 해석, RD-048·`06-editing.md` 6.9), `cancelled`는 아래 취소 변환을 거친다. 순서를 이 모듈이 소유하므로 알림을 `wait()` 뒤로 옮기면 worker가 알림 없이 정지한다. `wait()`가 던진 오류(main의 `fail`)는 그대로 전파되어 `input()`에서 `OSError`가 된다.
- `pyodide.setStdin({ stdin })`만 쓴다(기본 `isatty: false`, `autoEOF: true`, pyodide 314.0.7 `LegacyReader`). 콜백이 돌려준 문자열 끝에 `\n`이 없으면 pyodide가 붙이고 마지막 바이트가 `\n`이면 EOF를 넣지 않으므로 콜백은 `\n`을 붙이지 않는다. `input()`은 `"abc"`, `readline()`은 `"abc\n"`이다. `read()`·`readlines()`·`for line in sys.stdin`도 빈 입력줄의 실제로 친 Ctrl+D가 이 콜백의 `null` 반환(EOF)에 닿으면 3.14처럼 끝난다(RD-048 전에는 EOF 표식이 없어 줄마다 콜백을 다시 불러 끝나지 않았다 — 해소, `10-parity-deviations.md` 편차 34). `read(n)`은 줄 끝 `\n`을 남겨 다음 읽기를 콜백 없이 채운다(`docs/traps/TRP-010`).
- 취소 변환(RD-008). 의존성은 **객체가 아니라 클로저 둘**(`signalInterrupt`·`checkInterrupt`)로 받는다: core `worker/stdin-callback.ts`는 `protocol/`을 import하지 않고(`00-architecture.md` 4.2), 실제 pyodide 없이도 변환 순서와 "재시도 없음"을 단위로 고정할 수 있다.
- `readInput(true)`(취소 가능)로 읽는다. 프롬프트는 넘기지 않는다(main이 꼬리로 정한다).
- 결과가 `cancelled`(Ctrl+C 취소)이면 **`signalInterrupt(interruptBuffer)` → `pyodide.checkInterrupt()`**.
  stdin 콜백은 GIL이 풀린 상태라 `checkInterrupt()`가 `FS.ErrnoError(EINTR)`를 던지고, CPython이
  EINTR 뒤 `PyErr_CheckSignals()`로 버퍼를 소비해 **`input()` 호출 지점에서** `KeyboardInterrupt`를
  올린다(PEP 475). 콜백 안에서 쓰고 바로 소비되므로 잔류 SIGINT가 없다.
- `checkInterrupt()`가 던지지 않고 돌아오면 `console.warn("[worker] checkInterrupt가 SIGINT를 소비하지 않아 입력 취소를 EOF로 처리한다")`를 남기고 `null`을 돌려준다(→ `EOFError`). 버퍼가 아직 연결되지 않은 구간(`attachRuntime`의 `setInterruptBuffer` 전, `03-ctrl-c.md` 2.6)에 콜백이 불리는 경우다.
- `signalInterrupt`로 써서 **요청 번호를 반드시 올린다**. 번호를 올리지 않으면 핸들러가 직전 눌림의
  재전송으로 보고 이 취소를 무시한다(TRP-035).
- 금지된 대안 5종(실측으로 탈락, TRP-014): `buf[0]=2` 뒤 정상 반환(신호가 임의 지점에서 소비돼 HANG·엉뚱한
  프레임), 일반 `Error`(→ `OSError`가 되어 `except Exception`이 삼킴), `null` 그대로(→ EOF), `errno`만 가진
  `Error`(pyodide 사망), 버퍼 없이 `ErrnoError`만(무한 재시도).
- main은 이 경로에서 버퍼를 쓰지 않는다.
- `input()` 취소에는 main 게이트의 REPL 읽기 phase를 `cancel-settling`으로 세우지 않는다(`08-session.md` 8.1,
  `06-editing.md` 6.3, `03-ctrl-c.md` 2.7):
  취소 뒤에도 사용자 코드가 계속 돌기 때문에 그 구간의 Ctrl+C는 실행 중단이어야 한다. 실측: 방어를 걸면
  `except KeyboardInterrupt` 뒤 4초 계산 중 Ctrl+C가 3.0초 무시되고(이전 구현), 걸지 않으면 33~58ms에
  중단된다(RD-008 브라우저 판정 항목).
- 의미: `try/except KeyboardInterrupt`가 잡고 `except Exception`은 못 잡으며 `with.__exit__`·`finally`가
  실행된다. `input()`/`sys.stdin.readline()/read()/readlines()`/`for line in sys.stdin`은 같은 콜백이라
  구분하지 않는다.
- worker는 `PyodideConsole`에 `stdin_callback`을 넘기지 않는다. 넘기지 않으면 콘솔이 `sys.stdin`을
  건드리지 않아 전역 `setStdin` 설정이 그대로 쓰인다.

## 3.2 read-guard(`createReadGuard(promptRow)`)

- REPL 읽기와 stdin 읽기가 같은 `readline`을 쓰고, `readline.read()`는 이미 열린 읽기를 교체하면서
  옛 읽기의 promise를 영영 끝내지 않는다. 프롬프트 대기 중 배경 콜백이 `input()`을 부르면 REPL 읽기가
  고아가 되어 입력이 멈춘다.
- 규칙: 돌려받은 `readLine`이 반환 promise를 "활성 REPL 읽기"로 추적하고, `readInput`은 **그 결과가
  정해진 뒤에** 시작한다. 결과가 입력 줄이든 취소(`null`)든 실패든 stdin 읽기는 진행한다.
- `readLine` 자체는 기다리지 않고 즉시 부른다(시작 타이밍 불변). stdin 읽기끼리는 직렬화하지 않는다
  (worker가 동기 대기라 겹치지 않는다).
- 목록 재그리기로 읽기가 새로 시작돼도 `readLine`이 돌려주는 promise는 바뀌지 않으므로
  (`tab-reader.ts`의 `ReadHandle.result`) 그 promise가 최종 종료 시점이다.
- 교착 없음: worker는 `readInput` 동안 동기 대기하고 `readLine` 응답은 포트에 큐잉된다.
  화면 순서는 REPL 줄 → 배경 `input` 줄 → 콜백 출력 → REPL 줄 실행.
- 겹침 거절(열린 읽기 위에 `readLine` 요청이 또 오면 `Error("이미 읽는 중")`)은 REPL main driver(`repl-main-driver.ts`)가
  가드 **바깥**에서 검사한다. 거절된 promise를 가드가 활성 읽기로 추적하면 진짜 활성 REPL 읽기를 잃어 stdin 읽기가
  앞당겨진다. 순서: 읽기 phase가 `opening`·`open`·`closing`인지 검사(`08-session.md` 8.1) → `guard.readLine(prompt, options)` →
  phase를 `idle`/`cancel-settling`으로 정리.
- stdin 읽기가 실패(reject)하면 `createRepl`의 `readInput` 핸들러가 `disposed`가 아닐 때만 `mailbox.fail(String(error))`로 worker를 깨워 Python `OSError`로 드러낸다. `disposed`면 쓰지 않는다: worker는 이미 `terminate()`됐고 `fail()`의 `untilIdle`이 영영 안 풀릴 수 있다. `Readline.dispose()`가 대기 중인 읽기를 reject하므로 dispose 때는 항상 이 분기다.
- interface(RD-045): `readLine(prompt: string, options: PromptReadOptions): Promise<string | null>` — 즉시 `promptRow.read(prompt, options)`를 불러 그 promise를 활성 REPL 읽기로 추적한다. `options`(`readOptions`·`onOpen` 포함, `06-editing.md` 6.3)는 REPL main driver가 조립해 그대로 넘긴다 — read-guard는 `pending`을 모른다. `readInput(cancelable: boolean, sessionEnded: () => boolean): Promise<string | null>` — `sessionEnded`는 필수다(유일 호출자 core가 항상 넘긴다, RD-034, 아래 "미룬 뒤 열기 직전 세션 종료").
- **미루는 순간의 접두 인계**(RD-022b·RD-045): 활성 REPL 읽기가 있을 때(`replOpen`) read-guard가 `readInput` 도착 즉시(동기,
  `await` 앞) `promptRow.detachPrefix()`(RD-027, 구 `sinks.moveAbovePrefixToTail()`)를 불러 접두를 떼고, 떼는 순간의 io에
  묶인 핸들 `DetachedPrefix`를 쥔다(`draw()`는 아래 "버린 미룬 읽기의 꼬리 그리기"). `replOpen`은 각 `readLine`이 세우고, 그
  읽기의 끝 처리가 `replRead === settled`일 때만 내린다(끝난 옛 읽기가 뒤에 열린 새 읽기의 표시를 내리지 않게). 이유: 배경
  `input("bg> ")`이 먼저 쓴 `bg> `는 열린 REPL 읽기 위 출력이라 꼬리가 아니라 REPL 줄의 접두가 된다(`05-output.md` 4.4).
  미뤄진 stdin 읽기가 프롬프트를 잃지 않게 REPL 줄이 끝나기 전에 넘겨받는다. 동기여야 하는 이유: REPL 줄 Enter 뒤에는 벤더
  활성 읽기가 없어 `abovePrefix()`가 `""`다. `detachPrefix()`는 내부적으로 `readline.abovePrefix()`가 비어 있지 않을 때만
  `printAboveRaw("", "")`(접두 없이 다시 그림) → 꼬리 `reset()` → `feed(접두)`이고, 접두가 없으면(열린 읽기가 없을 때 포함)
  무동작이다(핸들은 이때도 준다 — 그리기 전 창에서 꼬리에 들어갔다 지워진 조각도 그려야 한다, 아래). 꼬리를 이어 먹이지 않고
  바꾸는 이유: 열린 읽기의 행에는 접두 뒤 프롬프트뿐이고, 그리기 전 창에 꼬리에 들어간 조각은 프롬프트 그리기(`\r\x1b[J`)가
  이미 지웠다.
- **미룬 뒤 열기 직전 세션 종료**: `readInput(cancelable, sessionEnded)`는 `await replRead` 뒤 원본 `promptRow.read("", …)`를
  부르기 직전 `sessionEnded()`를 보고, 참이면 원본을 부르지 않고 `null`로 끝낸다(`08-session.md` 8.1 D6).
- **버린 미룬 읽기의 꼬리 그리기**(이슈 prompt-row-followups/07, RD-045): 미룬 읽기(도착 때 접두를 뗀 읽기)를 D6으로 열지
  않으면 read-guard가 그때 쥔 핸들의 `detached.draw()`를 부른다. 미루지 않은 읽기의 D6, 세션이 살아 있어 연 경우에는 부르지
  않는다(핸들 자체가 없거나, `draw()`를 부르지 않는다). 이 시점의 꼬리는 **화면에 없는 글자**다: `detachPrefix()`가 뗀 접두,
  또는 그리기 전 창에 꼬리로 들어갔다가 프롬프트 그리기(`\r\x1b[J`)가 지운 조각. 미룬 읽기가 열렸으면 `promptRow.read("")`가
  그 꼬리를 프롬프트로 그렸을 것이므로, 읽기 없이 같은 글자를 출력으로 그린다. 그리기 가부는 핸들 자신이 판정한다(`draw()`,
  `prompt-row.ts`): 묶인 io가 아직 현재 io이면 그 io 꼬리를 `readline.write`로 그리고 꼬리는 그대로 두며(꼬리가 비었으면
  무동작), 묶인 io가 더 이상 현재 io가 아니면(driver `terminate` 훅의 `io.close()`로 닫혔거나, reset·dispose로 새 io가
  열렸으면) 무동작이다 — driver는 플래그를 갖지 않는다. 전제: 미룬 동안 worker는 `input()`에서 동기 대기라 출력이 없고,
  D6은 REPL 읽기 끝의 마이크로태스크에서 돌아 그 사이 출력이 끼지 않는다. 결과(크래시, 8.4): 크래시 → REPL 줄 Enter는
  `bg> ` 행을 남기고 이어지는 reset 안내는 그 아래 행에 온다. 크래시 뒤 Enter 없이 reset하면 D6이 io가 닫힌 뒤 돌아 `bg> `는
  그려지지 않는다(수용한 차이). 시험: repl `terminal/read-guard.test.ts`(`[R1]`)·`create-repl/reset.test.ts`(`[R3]`·`[R4]`),
  terminal `prompt-row/prefix.test.ts`(`[R2]`) — driver `repl-main-driver.test.ts`에는 판정이 없어 이 시험이 없다.
- 화면(브라우저 확인, RD-022b 뒤): 활성 REPL 읽기 중 배경 `bg> `는 REPL 줄 앞 접두로 그려졌다가(`bg> >>> x = 41`) 이어 도착한 `readInput` 알림에서 떼어진다 — 화면은 `>>> x = 41`, 꼬리는 `bg> `. REPL 줄 Enter 뒤 다음 행에서 stdin 읽기가 `bg> `로 시작해 `bg> hello`가 남는다(`[">>> x = 41", "bg> hello"]`, repl `terminal/read-guard.test.ts` "배경 input()의 프롬프트는 REPL 줄에서 떼어져 …"). 두 쓰기 사이의 `bg> >>> …` 상태는 xterm DOM 렌더 프레임에 나타나지 않을 수 있어 브라우저 스크립트 `bg-input-guard-probe.mjs`는 화면 행 대신 main의 `readInput` 알림 처리를 기다린다(`apps/demo/e2e/lib.mjs` `installRpcTap`·`rpcNoticeCount`). RD-022b 전에는 `bg> `가 프롬프트 행 뒤에 붙었다(`>>> bg>`).
- **경합: 두 알림 사이의 Enter**(RD-022b 리뷰, jsdom 재현; 고치지 않고 편차 56으로 등록, RD-026 사용자 확정 2026-09-25): worker는 `write("bg> ")`와 `readInput` 알림을 같은 포트로 연달아 보낸다. 둘 사이(다음 메시지 태스크 한 번)에 REPL 줄 Enter가 처리되면 읽기가 끝나 `abovePrefix()`가 `""`이고, 접두 `bg> `는 확정된 행(`bg> >>> x = 41`)에만 남고 꼬리는 비어 있어(열린 읽기 출력은 꼬리에 먹이지 않는다) stdin 읽기가 프롬프트 없이 열린다: 화면 `["bg> >>> x = 41", "hello"]`, 경합 없는 경로는 `[">>> x = 41", "bg> hello"]`. 원인은 떼기 조건(도착 시 `replOpen`)이다: Enter 처리의 마이크로태스크가 `readInput` 메시지 태스크보다 먼저 돌아 도착 시 `replOpen`이 이미 false라 접두를 떼지 않는다(위 불릿의 "활성 REPL 읽기가 있을 때"). 벤더가 Enter 시점 접두를 보관해 `moveAbovePrefixToTail`이 폴백으로 꼬리를 채우는 방식을 구현·시험했으나 포기했다: 폴백에 닿으려면 호출 조건을 풀어야 하는데 그러면 접두가 남은 채 `input()` 코드를 Enter로 제출하는 정상 경로에서 접두가 stdin 프롬프트로 재그려지거나 `input("name: ")` 프롬프트를 덮을 수 있고(추정, 미시험), 기존 read-guard 시험 2건("활성 REPL 읽기가 없으면 …", "끝난 REPL 읽기 뒤에 온 readInput은 …")의 기대값을 바꿔야 한다. 경합과 정상 지연을 main이 구분할 수단이 없다. 재개 조건은 그 구분 수단이 생길 때다(`10-parity-deviations.md` 편차 56, `.scratch/repl-run-source-followups/issues/12-*.md`). RD-022b 전에는 sink가 읽기 중 출력도 꼬리에 먹여 이 경합에서도 `bg> `가 stdin 프롬프트가 됐다(코드 읽기).

## 3.3 프롬프트 꼬리(output-tail) 렌더링

- 꼬리 = 직전 출력의 **마지막 `\n` 뒤이면서 그 안에서 마지막 `\r` 뒤** 텍스트. 꼬리가 없으면 프롬프트 없이
  입력만 받는다. `input("x: ")`의 `x: `는 stdout으로 먼저 나가고, 읽기가 시작되면 그 꼬리를 프롬프트로
  같은 행에 다시 그린다(3.14의 `x: abc` 한 줄과 같다).
- 색: 줄 경계를 넘어 열린 SGR 시퀀스를 꼬리 앞에 이어 붙인다(시퀀스 목록으로 보관, 첫 파라미터가 0이거나
  비면 초기화, **상한 64개**). SGR 스캔은 정규식 없이 ESC + `[` + 숫자/`;`/`:` + `m`을 직접 읽는다.
  SGR 외 CSI(이동·지우기·`\x1b[?25l` 등)와 OSC는 걸러내지 않고 통과시킨다. 커서를 옮기지 않고 글자만 바꾸는 제어 문자는 정규화한다:
  BS(`\b`)는 본문 마지막 글자를 지우고, BEL 등 나머지 C0와 DEL은 제거한다(`05-output.md` 4.4 "접두 안의 제어 문자와 폭"; 접두와
  `input()` 프롬프트 꼬리가 같은 추적기를 쓴다). 단 문자열 시퀀스(OSC `\x1b]`·DCS 등) 안은 종료자(BEL·ST)까지 손대지 않는다 —
  종료자를 지우면 시퀀스가 열린 채 남아 터미널이 뒤따르는 프롬프트까지 삼킨다.
- 꼬리 초기화 시점: println 계열 sink(`writeOutput`/`writeError`), 텍스트 안 `\n`, 읽기 시작(REPL·stdin),
  새 worker. 읽기는 Enter뿐 아니라 **취소(Ctrl+C)로도 `\r\n`을 내고 끝나므로** 취소 뒤에도 꼬리가 남지 않는다.
- **열린 읽기 중 출력은 꼬리가 아니라 벤더 접두**(RD-022b, `05-output.md` 4.4): 프롬프트가 그려진 뒤 온 출력은 꼬리 추적기에 먹이지
  않는다. 개행 없이 끝난 부분은 같은 꼬리 규칙(`splitAboveRead`가 `createOutputTail`을 그대로 쓴다)으로 계산해 벤더가 프롬프트 앞
  접두로 보관하고(`\r`로 끝나 꼬리 규칙이 빈 값을 내는 조각은 마지막으로 보이는 `\r` 구간을 접두로 한다, `05-output.md` 4.4)(`Readline.abovePrefix()`), 읽기가 끝나면 그 행째 화면에 남으므로 다음 읽기의 꼬리가 되지 않는다. 예외 둘:
  `runSource`의 `takeRead()`는 접두를 지우므로 브리지가 다시 쓰고(그 쓰기는 읽기 밖 경로라 꼬리에 들어간다, `02-console-core.md`
  5.6.3), 미뤄지는 stdin 읽기는 REPL 줄의 접두를 꼬리로 넘겨받는다(3.2). 근거: 확정 7("읽기 중 출력은 꼬리에 먹이지
  않는다")을 지키면 배경 `input("bg> ")`의 `bg> `가 REPL 줄 접두로만 남아 미뤄진 stdin 읽기가 프롬프트 없이 열린다. 꼬리 규칙을
  바꾸지 않고(Enter·취소 뒤 접두를 꼬리로 옮기면 `tick>>> ` 행 뒤 다음 프롬프트에 `tick`이 중복된다) 인계가 필요한 한 경로에서만
  옮긴다(2026-09-24 사용자 확정).
- **붙박이 프롬프트**: 읽기가 시작되면 벤더에 넘긴 프롬프트 문자열 전체(REPL `꼬리\x1b[0m>>> `, stdin 경로의 꼬리 `x: `)가 그 읽기의
  고정 프롬프트다. 읽는 동안 온 출력은 그 앞 접두로만 붙고 프롬프트 자체를 바꾸지 않는다(`input("x: ")` 중 `tick\n` → `tick` 행 아래
  `x: 입력`). `input()` 읽기 중에는 worker가 멈춰 있어 worker 출력으로는 이 경우가 생기지 않는다(`05-output.md` 4.4 "적용 범위").
- 폭 초과 처리(`rewindTail`, `packages/pyodide-terminal/src/rewind-tail.ts`): 꼬리가 터미널 폭을 넘으면 `read()` 앞에 `\x1b[nA`로 첫 행까지 커서를
  올린다(TRP-016). 행 수는 `term.write('', cb)`로 flush를 기다린 뒤 화면 버퍼에서 커서 행(`baseY + cursorY`)부터 `isWrapped`를
  위로 세어 구하고, `cursorY`를 넘어 스크롤백으로는 올리지 않는다. **짧은 꼬리(`길이 × 2 < cols`)는 flush 없이 건너뛴다.**
  커서만 옮기므로 sink를 거치지 않는다. REPL 경로와 stdin 경로가 같은 `rewindTail`을 쓴다.
  **되감은 읽기의 그리기 전 창 종료**: `rewindTail`은 올린 행 수를 돌려주고 `promptRow`가 마지막 `read()`의 값으로 기억한다. 그 읽기가
  그려지기 전(벤더 write 콜백 전)에 `endRead({ screen: true })`로 끝나면 벤더는 그리지 않아 커서가 꼬리 첫 행에 남는다 — 대체 개행
  (`06-editing.md` 6.1) 앞에 같은 수만큼 `\x1b[nB`(`readline.write`, sink를 거치지 않는다)로 꼬리 끝 행으로 내린다. 열은 되감기 때
  그대로라 꼬리 끝 열이다. 없으면 개행이 꼬리 둘째 행 머리로 가 뒤 출력(traceback·리셋 안내)이 꼬리를 덮는다. 그려진 읽기의 settle은
  벤더가 꼬리부터 다시 그려 커서가 입력 끝에 있으므로 내리지 않는다.
  **flush 대기 중 abort**: `read()`가 `rewindTail`의 flush를 기다리는 사이 signal이 abort되면 읽기를 열지 않고 `null`로 끝나는데,
  되감았으면 같은 수만큼 `\x1b[nB`(`io.terminal`)를 곧바로 쓴다. abort 쪽 대체 개행이 `\x1b[nA`보다 먼저 큐에 들어갔을 수 있다 — xterm이
  `""` 콜백 직후 파싱을 끊으면(한 태스크 파싱 시간 한도) 행 수를 개행 전 버퍼로 센다. CUD가 CUU 바로 뒤에 큐잉되므로 파싱 순서와
  무관하게 상쇄된다.
- 두 경로 모두 `promptRow.read(prompt, options)`(RD-027, `packages/pyodide-terminal/src/prompt-row.ts`, "현재 io"에 묶인다) 하나로 합쳤다. 순서는
  공통이다: `rewindTail` → 꼬리 재조회(flush를 기다리는 사이 온 출력을 반영) → `resetTail` → `readline.read(합성, vendorOptions)`.
  합성 규칙: `prompt === ""`면 꼬리 그대로, 꼬리가 `""`면 프롬프트 그대로, 둘 다 있으면 `` `${꼬리}\x1b[0m${프롬프트}` ``(꼬리의 열린 색이
  프롬프트로 새지 않도록 SGR 리셋을 넣는다).
- REPL 경로: `repl-main-driver.ts`의 `guard.readLine`이 `promptRow.read(prompt, { cancelable, readOptions, onOpen })`를 부른다
  (`prompt`는 벤더 `>>> `/`... `, `readOptions`는 flush 뒤 평가하는 thunk). 꼬리 + `\x1b[0m` + 프롬프트로 합성된다.
- stdin 경로(`terminal-runner.ts`의 `readInput`, repl의 `guard.readInput`): `promptRow.read("", { cancelable, signal?,
history? })`를 부른다. `prompt === ""`이므로 합성 규칙에 따라 꼬리 그대로가 프롬프트의 전부가 되어 **SGR 리셋이 붙지 않는다**: 프롬프트의
  열린 색은 tty처럼 입력에 이어진다(색이 닫힌 프롬프트의 입력은 기본색, sink·꼬리 규칙은 `05-output.md`, 프롬프트 문자열은
  `02-console-core.md` 5.2 참고). 꼬리가 없으면 프롬프트 없이 읽는다. 실행창만 `history: false`를 넘긴다(REPL `input()`은 history
  기록을 유지한다).
  `promptRow`는 "현재 io"(surface `openIo()`가 갱신)의 `io.terminal`을 통해 "`dispose()`(`io.close()`) 뒤 write 콜백을 전달하지
  않는 터미널 뷰"(`packages/pyodide-terminal/src/surface.ts`, TRP-004)를 쓴다. 세션마다 새 `io`를 열고 `io.close()`는 core 세션의
  `terminate` 훅이 부른다.
  `rewindTail`의 flush 콜백은 해제 여부를 스스로 알 수 없다. `input()` 시작 전에 친 키(프롬프트 글자가 그려진 뒤 `readline.read()`가 시작되기 전, 실행 중 포함)는 벤더 readline이 버리지 않고 쌓았다가 읽기가 시작될 때 재생해 `input()` 값이 된다(RD-019, `06-editing.md` 6.7, 편차 32 해소). 읽기당 소비라 첫 줄만 값이 되고 나머지는 다음 읽기가 받는다.

참고: `/work/cp949/pyodide-samples/apps/repl/docs/design/02b-input-ctrl-c.md`,
이전 구현 설계 문서 `11-stdin-prompt.md`,
`/work/cp949/pyodide-samples/apps/repl/src/repl/{stdin-callback,read-guard,stdin-reader,output-tail}.ts`
