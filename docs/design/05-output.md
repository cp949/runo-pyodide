# 출력: sink 4종·전역 스트림·배너·열린 읽기 위 출력

> 이 문서의 규칙·상수는 이전 구현(`/work/cp949/pyodide-samples/apps/repl`, 읽기 전용 참고)이 CPython 3.14.4 pty 실측과 브라우저 회귀로 확정한 것이다. 새 구현은 통신 계층만 바꾸고(`docs/design/00-architecture.md`, `01-protocols.md`) 이 규칙은 그대로 지킨다. 절 끝의 "참고:" 경로는 이전 구현의 근거 위치다.

새 구현에서 sink 4종은 worker→main **단방향 RPC 알림**(`notify`)으로 전달된다. 이전 구현은 조각마다 worker를 멈추는 동기 호출이었고, 그 동기성은 요구사항이 아니었다. 순서 보장은 같은 MessagePort의 FIFO에 의존한다(`01-protocols.md` 1절).

## 4.1 sink 4종(`createTerminalSinks(readline)`)

sink 4종은 terminal 패키지 `packages/pyodide-terminal/src/sinks.ts`가 소유한다(surface `openIo()`가 세션마다 새로 만든다. `createRepl`은 세션마다, `createTerminalRunner`는 runner당 한 번 연다). `write`·`writeErrorRaw`는 core 세션이 `write`·`writeErrorRaw` 알림을 `{ stream: "stdout" | "stderr", text }`로 넘기는 `output` 콜백을 REPL main driver가 연결한 것이고(`stdout` → `write`, `stderr` → `writeErrorRaw`), `writeOutput`·`writeError`는 core가 아니라 REPL main driver의 RPC 핸들러가 부른다(`01-protocols.md` 1.2, `00-architecture.md` 4.1 core export). 꼬리 추적기 `createOutputTail`(`output-tail`)은 터미널에 의존하지 않는 순수 모듈이라 core `terminal/output-tail.ts`에 있고 `sinks.ts`가 import한다.

| sink            | 구현                          | 개행        | 색                 | 용도                                                                  |
| --------------- | ----------------------------- | ----------- | ------------------ | --------------------------------------------------------------------- |
| `writeOutput`   | `readline.println(text)`      | 강제 `\r\n` | 없음               | 식 값 에코, 시작 배너                                                 |
| `writeError`    | `println("\x1b[31m…\x1b[0m")` | 강제 `\r\n` | 빨강(한 번 감쌈)   | 트레이스백, SyntaxError, 붙여넣기 파싱 오류, 취소 `KeyboardInterrupt` |
| `write`         | `readline.print(text)`        | 없음        | 없음               | `stdout_callback` 조각, `^C` 에코, 전역 stdout                        |
| `writeErrorRaw` | `print("\x1b[31m…\x1b[0m")`   | 없음        | 조각마다 열고 닫음 | `stderr_callback` 조각, 전역 stderr                                   |

- **개행 계약**: println 계열 sink가 `\r\n`을 붙이므로 호출부는 **끝 개행 없는 텍스트**를 넘긴다. 붙이면
  프롬프트 앞에 빈 줄이 하나 더 생긴다(TRP-012). 트레이스백/SyntaxError는 `formatted_error`의 **끝 개행
  하나만** 제거하고 메시지 자체의 개행은 보존한다.
- `writeErrorRaw`는 Python이 쓴 조각 그대로(개행 추가·제거 없음) 낸다. **빈 조각(`print(end="")`의 `end`,
  `write("")`)은 아무것도 내지 않는다.** 빨강은 조각마다 열고 닫는 무상태 방식이고 main sink가 입힌다
  (worker는 텍스트만 넘긴다). 한계: stderr 텍스트 자체의 SGR이 조각 경계를 넘으면 조각 끝 `\x1b[0m`에서 끊긴다.
- `\r` 진행률: `write`/`writeErrorRaw`가 개행을 강제하지 않으므로 `\r30%` 같은 한 줄 갱신이 그대로 반영된다.
  꼬리 계산은 마지막 `\r` 뒤를 취한다.
- 모든 sink는 열린 읽기 밖에서 화면에 낸 바이트를 `output-tail`(core `terminal/output-tail.ts`)에 먹인다(`println`은 `text + '\n'`을 먹인다).
  열린 읽기 중 출력은 먹이지 않고 벤더 `printAboveRaw`로 보낸다(4.4). `tail()`/`resetTail()`을 함께 노출한다. **sink 세트는
  worker(세션)마다 새로 만든다** — 새 세션이 이전 꼬리를 물려받지 않게.
- 위 표의 "구현" 열(`readline.print`/`println`)은 읽기 밖 경로다. 4종 모두 내부의 `print`/`println` 두 함수를 거치고, 그 두 함수가
  `readline.isReading()`으로 4.4 경로와 갈린다.
- **안내 줄**(`promptRow.notice(text, kind)`, RD-027·RD-028, `packages/pyodide-terminal/src/prompt-row.ts`. 구 `packages/pyodide-terminal/src/notice.ts`의
  `writeNotice(readline, text, kind)`): 세션 밖에서 main이 찍는 개행으로 끝나는
  한 줄이다. 비격리 경고는 노랑(`warning`, `\x1b[33m…\x1b[0m`), RD-010의 리셋 안내는 청록(`info`, `\x1b[36m`)이다.
  현재 io가 있으면 그 꼬리(`io.sinks.tail()`)를 거친다 — 꼬리에 보이는 글자가 있으면(core `leavesVisibleText`, DELTA-05:
  색을 안 닫고 개행으로 끝난 출력은 꼬리 문자열이 비지 않아도 화면에 보이는 글자가 없다) `\r\n`을 선행해 `io.sinks.write(...)`로
  쓰고 그 꼬리를 비운다. 보이는 글자가 없으면 바이트는 `println`과 같다(RD-028 `design.md` §3). 현재 io가 없으면(세션이 없거나
  리셋으로 io가 이미 닫힌 자리) `readline.println`으로 낸다(현행 유지) — 끝 개행 없는 텍스트를 받아 개행을 붙이고 부분 줄은
  내지 않는다.
  `11-known-traps.md`의 TRAP-12 규칙(sink를 거치지 않는 출력 경로 금지)의 예외는 이제 없다: 현재 io가 있으면 그 sink를
  거치고, 없으면 애초에 거칠 sink가 없다.

## 4.2 batched vs raw, 전역 스트림

- `PyodideConsole`은 `runcode()` 동안에만 `sys.stdout`/`sys.stderr`를 `stdout_callback`/`stderr_callback`
  (순수 Python `_WriteStream`)으로 리다이렉트한다. 이 콜백은 `write()` 호출마다 버퍼링 없이 즉시 실행되며
  FS 레벨 `setStdout`의 `batched`/`raw` 설정과 **완전히 독립**이다. 스트리밍 문제의 원인은 pyodide 설정이
  아니라 브리지가 `println`(개행 강제)을 거치는 것이었다.
- 콘솔 리다이렉트 **밖**(프롬프트 대기 중 배경 콜백 출력, asyncio 예외 로그, 패키지 로딩 메시지)은 전역
  스트림을 탄다. `createSinkWriter(sink)`(core `worker/sink-writer.ts`)가 pyodide `Writer`로 바이트를 받아
  `TextDecoder({ stream: true })`로 조각 경계를 잇고 콘솔 콜백과 **같은 sink**(`write`, `writeErrorRaw`)로
  보낸다. `write`는 받은 바이트 수를 돌려줘야 한다(0을 돌려주면 호출한 쪽이 같은 바이트를 다시 쓴다).
  잘린 상태는 Writer마다 따로 둔다. 프롬프트가 열린 채 온 배경 출력의 화면 규칙은 4.4다.
- Python 쪽 stdout 버퍼는 건드리지 않는다: `flush=True` 없는 `print(..., end='')`는 CPython처럼 개행·flush
  까지 보이지 않는다.
- 전역 스트림은 `isatty()`가 False여도 pyodide 기본으로 `line_buffering=True`, `write_through=False`다(node 프로브,
  pyodide 314.0.7). 그래서 전역 stdout의 `print("t", end="")`는 다음 개행까지 Writer에 오지 않고(`"tline\n"` 한
  조각) 개행·`\r`·`flush=True`에서 나온다. 전역 stderr도 같아 `sys.stderr.write("raw-err")`는 flush 전까지 오지
  않는다. 버퍼링이 없는 쪽은 콘솔 콜백 경로(`runcode()` 중)뿐이다.
- stderr 버퍼링(`line_buffering=True`)은 모사하지 않는다 — 콘솔 콜백 경로의 웹은 즉시 낸다(TRP-013).

## 4.3 BANNER / 프롬프트 문자열

- 시작 배너는 `pyodide.console` 모듈의 `BANNER`를 `writeOutput`으로 그대로 낸다(sink가 개행을 붙이므로
  배너에 개행을 더하지 않는다). 가짜 리눅스/GCC 배너를 흉내내지 않는다. `BANNER`는 `pyodide.pyimport("pyodide.console")`
  모듈의 속성이고 끝 개행이 없다: `Python 3.14.2 (main, Sep 14 2026 03:03:51) on WebAssembly/Emscripten\nType "help",
"copyright", "credits" or "license" for more information.`(pyodide 314.0.7, 2행).
- worker 시작 시 `sys.ps1 = ">>> "`, `sys.ps2 = "... "`를 직접 설정한다(pyodide 기본은 `None`이라
  `hasattr(sys, 'ps1')`로 REPL을 판정하는 코드가 어긋난다).

## 4.4 열린 읽기 위 출력(RD-022b)

열린 읽기 = 벤더 `Readline`에 활성 읽기가 있는 상태(`Readline.isReading() === true`): 프롬프트가 그려진 REPL `>>> `·`... ` 읽기,
REPL `input()` 읽기, 실행창 `input()` 읽기. `printAbove`·`printAboveRaw` 재그리기를 기다리는 동안도 포함한다. `read()`를 부른 뒤
벤더 write 콜백이 프롬프트를 그리기 전(그리기 전 창)은 포함하지 않는다.

- **경로**: sink의 `print`/`println`(4.1의 4종이 모두 거친다)은 `readline.isReading()`이면
  `readline.printAboveRaw(lines, prefix)`를 부른다. `{ lines, prefix }`는 `splitAboveRead(앞 원문, text)`이고 앞 원문은
  `readline.abovePrefix()`다(예외: 아래 "`\r`로 끝난 조각"의 `resume`). `println`은 `text + "\n"`을 넘긴다. 프로미스는 기다리지 않는다(`void`). 읽기 밖이면 4.1 경로(꼬리 공급 + `readline.print`/`println`)
  그대로다. 빈 조각은 `write`·`writeErrorRaw`가 먼저 거른다.
- **분리**(`splitAboveRead(prefix, text): { lines, prefix, resume? }`, `packages/pyodide-terminal/src/sinks.ts`, `./internal`로 나간다):
  `full = prefix + text`. `lines`는 `full`의 마지막 `\n`까지(포함, 없으면 `""`)다. 새 접두는 새 `createOutputTail()`에 `full`을
  먹인 `value()`다 — 꼬리 규칙(`04-stdin-input.md` 3.3: 마지막 `\n` 뒤, 그 안에서 마지막 `\r` 뒤, 줄 경계를 넘어 열린 SGR을 앞에
  이어 붙임)을 새로 구현하지 않고 그대로 쓴다. 벤더가 앞 접두를 화면에서 지우므로 앞 접두는 `lines` 앞에 이어 쓴다: 접두 `tick` +
  ` tock\n` → `lines = "tick tock\n"`, 새 접두 `""`. `\r50%`는 새 접두 `50%`(제자리 갱신)다(앞 접두 `tick`도 `50%`로 바뀐다 — 터미널
  겹쳐 쓰기라면 `50%k`지만 읽기 시작 꼬리와 같은 꼬리 규칙을 따른다). 완성 행 안의 `\r`은 터미널이 겹쳐 쓴다(`abc\rX\n` → `Xbc` 행).
  `\n` → `\r\n` 정규화는 벤더 `write`가 한다.
  - **`\r`로 끝난 조각**(RD-022b 리뷰 반영, 사용자 확정): `print(f"{p}%", end="\r")`처럼 마지막 행의 마지막 `\r` 뒤에 보이는 글자가
    없으면(SGR만 있어도) 꼬리 규칙은 빈 접두를 내 조각이 사라지고 뒤따르는 `\n`도 빈 행만 남겼다. 이때 새 접두는 그 행에서
    **마지막으로 보이는 `\r` 구간**까지 먹인 꼬리 값이고(`100%\r` → `100%`, `10%\r20%\r` → `20%`, `\x1b[31m100%\r\x1b[0m` →
    `\x1b[31m100%`), `splitAboveRead`는 그 구간 뒤(`\r`부터)를 붙인 원문을 `resume`으로 준다(`100%\r`). sink는 `resume`과 그때 넘긴
    접두를 보관하고, 다음 조각 때 벤더 접두가 그 값 그대로면 `abovePrefix()` 대신 `resume`을 앞 원문으로 쓴다(Tab 목록·새 읽기가 접두를
    비웠으면 버린다). 보관할 때 `\r`부터의 나머지(`\r`·SGR뿐)는 연속 `\r`을 하나로, SGR을 꼬리 추적기 순효과(`\x1b[0m` + 열린 SGR,
    `MAX_ACTIVE_SGR` 상한)로 줄인다 — 보이지 않는 조각(`\r`, `\x1b[0m`)이 이어져도 보관 원문이 자라지 않는다. 그래서 다음 조각은 행 머리부터 계산된다: `20%\r` → 접두 `20%`(`10%20%`로 이어 붙지 않음), `\n` →
    `lines = "100%\r\n"` → `100%` 행이 남는다(읽기 밖에서 같은 입력을 쓴 것과 같은 행). 보이는 구간이 하나도 없으면(`\r`뿐) 꼬리 규칙
    그대로(접두 `""`)다. `\r` 뒤 SGR이 아닌 CSI 시퀀스(`\x1b[K`·`\x1b[?25l` 등)는 본문에 남고 벤더 폭 계산이 폭 0으로 센다(아래 "접두 안의 제어 문자와 폭").
    "보이는 글자"는 꼬리 정규화와 같은 기준(core `leavesVisibleText`)이다: 정규화가 지우는 BEL·나머지 C0는 세지 않고 BS는 앞 글자를
    하나 무른다. 어긋나면 `50%\r\x07`처럼 `\r` 뒤가 제거 대상뿐인 조각에서 접두가 빈 문자열이 되어 화면의 `50%`가 사라진다(RD-026 사후 리뷰).
  - 열린 프롬프트 화면: `100%\r` 뒤에는 보관한 접두를 프롬프트 앞에 그린다(`100%>>> pri`). 실제 터미널이라면 커서가 행 머리라
    프롬프트가 `100%`를 덮어쓰겠지만, 벤더는 접두를 프롬프트 앞 글자로만 그리므로(`\r`을 접두에 넣지 않는다, 6.1 `setPromptPrefix`)
    진행률 값을 보이게 둔다. `\r`의 효과(행 머리)는 다음 조각의 계산에만 반영된다.
- **화면**(벤더 동작은 `06-editing.md` 6.1): 입력줄(프롬프트 첫 행부터 입력 마지막 행까지, 접두 포함)을 지우고 그 자리에
  `lines`를 쓴 뒤, 접두를 프롬프트 앞에 붙여 같은 읽기(버퍼·커서)를 그 아래에 다시 그린다. 흔적 행을 남기지 않는다.
  - `>>> pri` + `tick\n` → `tick` / `>>> pri`(커서 `pri` 뒤, 줄 중간 커서도 보존).
  - `print("tick", end="", flush=True)` → `tick>>> pri`. 이어 ` tock\n` → `tick tock` / `>>> pri`.
  - 비어 있지 않은 접두와 프롬프트 사이에는 `\x1b[0m`이 들어간다(접두의 색이 프롬프트로 새지 않는다, `promptRow.read`(RD-027)의 꼬리 합성 규칙과 같다).
- **붙박이 프롬프트**: 벤더에 넘긴 프롬프트 문자열 전체가 접두 뒤에 그대로 붙는다 — 읽기 시작 꼬리가 합성된 `a\x1b[0m>>> `,
  `input("x: ")`의 `x: `. `input("x: ")` 중 `tick\n` → `tick` / `x: 입력`. 읽기 시작 꼬리와 배경 미종결 조각이 함께 있으면
  `ta>>> pri`처럼 시간 순서가 뒤집혀 보인다(`10-parity-deviations.md` 편차 54).
- **꼬리 추적기에 먹이지 않는다**: 열린 읽기의 출력은 벤더(`State`)가 보관하는 접두로만 관리한다. 새 `read()`는 접두 없이 시작한다.
  - Enter·Ctrl+C 취소: 접두는 그 행(`tick>>> pri`)과 함께 화면에 남고 다음 읽기의 꼬리는 비어 있다(다음 프롬프트는 `>>> `, `tick>>> `
    중복 없음).
  - `takeRead()`(REPL `runSource`): 벤더가 접두째 지우므로 브리지가 `abovePrefix()`를 먼저 읽어 다시 쓴다(`02-console-core.md` 5.6.3).
  - `cancelRead()`: settle 없이 부르면 벤더는 화면을 건드리지 않는다(행이 그대로 남는다, `06-editing.md` 6.1). 배경 출력 재그리기 콜백
    전(입력줄이 접두째 지워지고 아직 다시 그려지지 않은 창)에 오면 그 재그리기가 무효가 되어 입력줄도 아직 그리지 않은 접두도 화면에 없다
    (jsdom 재현: `> abc` → `printAboveRaw("", "tick")` 콜백 전 `cancelRead()` → 화면 `""`). 그래서 화면에 남겨야 하는 취소(REPL
    `reset()`·실행창 abort)는 `cancelRead({ settle: true })`를 부른다: 벤더가 재그리기 대기 중이면 아직 그리지 않은 접두를
    `prefix + "\x1b[0m\r\n"`으로 자기 행에 확정하고(private `undrawnAbovePrefix()` — 재그리기 대기 중일 때만 접두), 그려진 읽기면 입력 끝
    아래 행 머리로 옮긴다(`06-editing.md` 6.1 상태표). 재그리기가 끝난 뒤 취소에는 접두가 이미 프롬프트 행에 그려져 있으므로 다시 쓰지
    않는다(`abovePrefix()`를 쓰면 `tick>>> pritick`으로 중복된다). `dispose()`·terminate(`repl-main-driver`)의 `cancelRead()`는 settle
    없는 경로라 복원하지 않는다(REPL 리셋은 훅보다 먼저 settle 취소를 부르므로 훅의 호출은 무동작이다). RD-026에서는 호출자가
    `undrawnAbovePrefix()`(당시 공개)를 취소 앞에서 읽어 `prefix + "\x1b[0m"`을 벤더 `write`로 썼다: `reset()`은 `\r\n`을 붙였고 실행창
    abort는 뒤이은 기존 `\r\n`에 이었다(`sinks.write`는 `printAboveRaw` 경로로 가 다시 재그리기를 걸어 쓸 수 없었다). 2026-09-26 이
    호출자 규칙을 벤더 settle로 옮겼다.
  - 미뤄진 stdin 읽기: 활성 REPL 읽기 중 배경 `input("bg> ")`의 `bg> `는 REPL 줄의 접두가 되므로, read-guard가 stdin 읽기를 미루는
    순간 그 접두를 꼬리로 옮겨 stdin 읽기의 프롬프트로 쓴다(`promptRow.detachPrefix()`, RD-027, 구 `TerminalSinks.moveAbovePrefixToTail()`, `04-stdin-input.md` 3.2·3.3).
- **Tab 후보 목록**: 접두가 있는 채 `printAbove`가 불리면 옛 입력행(`tick>>> pri`)이 목록 위에 남으므로 새 입력행은 접두 없이 그린다.
  그 뒤 이어지는 조각은 별도 행이 된다(편차 55).
- **적용 범위 — 사실과 가정**:
  - 사실: REPL `>>> `·`... ` 읽기 중에는 worker가 유휴이고 asyncio가 돌아(편차 1) asyncio task·`call_later` 콜백·전역 stdout/stderr
    출력이 실제로 온다. 브라우저 `apps/demo/e2e/checks/bg-output-check.mjs`(`e2e:bg-output`) B01~B03·B05~B08과
    `stdin-input-check.mjs` `TICK` 절이 이 경로다.
  - 사실: REPL·실행창 `input()` 읽기 중에는 worker가 stdin 메일박스 `Atomics.wait`에 멈춰 있어(`04-stdin-input.md` 3.1) WebLoop
    콜백·JS 이벤트가 돌지 않고, `input()` 앞에 낸 출력은 같은 포트 순서상 `readInput` 알림보다 먼저 도착해 꼬리(프롬프트)가 된다.
    그래서 "`input()` 읽기 위 배경 출력"은 **현재 제품에서 worker 출력으로는 발생하지 않는다**. 공용 sink 경로라 함께 조율되며,
    이 경로의 계약은 main 쪽 쓰기(RPC 핸들러 → sink → 벤더)에 대한 것이다. 시험은 main에 출력을 직접 넣는다: terminal
    `terminal-runner.test.ts` "input() 대기 중 배경 출력(RD-022b)", repl `run-source.test.ts` "REPL input('x: ') 대기 중 …", 브라우저
    B04는 main 포트에 가짜 `write` RPC 알림을 합성한다(`apps/demo/e2e/lib.mjs` `installRpcTap`·`injectRpcNotice`, 실제 알림과 같은
    `onmessage` 핸들러를 지난다).
  - 가정(확인 안 함): 이 경로가 실제로 쓰일 곳은 앞으로 생길 main 출처 출력이나 비차단 stdin(JSPI 등)이다. 지금은 없다.
- **경계**:
  - 그리기 전 창: `read()` 뒤 벤더 write 콜백 전(`isReading() === false`)에 온 출력은 읽기 밖 경로로 가고, 개행 없는 조각은 곧 그려지는
    프롬프트의 `\r\x1b[J`에 지워진다. 고치지 않는다(`.scratch/repl-run-source-followups/issues/09-*.md`, `deferred`).
  - `lines`가 `\n`으로 끝나지 않으면 다음 재그리기가 그 행을 덮는다. 벤더는 검사하지 않고 `splitAboveRead`가 보장한다.
  - sink는 `printAboveRaw` 프로미스를 기다리지 않는다. 재그리기 대기 중 공개 편집 API(`editInsert` 등)는 리뷰 반영에서 고쳤다: 한 행
    입력에서도 Tab 완성 삽입이 콜백 전에 오면 커서가 삽입 전으로 되돌아가 이어 친 글자가 어긋나는 것이 jsdom으로 재현됐고(`imp osort`,
    기대 `import os`), 이제 버퍼만 고치고 콜백이 편집 뒤 커서로 그린다(`06-editing.md` 6.1). 재그리기 대기 중 리사이즈도
    고쳤다: 벤더 `onResize`가 그때는 `refresh()`를 생략하고 콜백이 새 크기로 그린다(jsdom 재현·수정, 브라우저 미재현, `06-editing.md` 6.1).
  - 출력으로 커지는 접두: 개행 없는 조각이 쌓여 접두+프롬프트+입력이 화면 행 수를 넘으면 읽는 동안 접두 윗행이 화면·스크롤백에 없다
    (다음 완성 행이 전부 다시 써 최종 유실은 없다). 조각마다 접두 전체를 지우고 다시 써 쓰기량이 조각 수에 대해 초선형이다(jsdom 관찰
    N=100 → 8879 B, N=400 → 97677 B). `.scratch/repl-run-source-followups/issues/14-*.md` `deferred`.
  - **접두 안의 제어 문자와 폭**(RD-026): 접두와 읽기 시작 꼬리는 같은 `createOutputTail()`이 만든다. 커서를 옮기지 않고 줄 위에서 글자만
    바꾸는 제어 문자는 꼬리 계산에서 정규화한다: BS(`\b`)는 본문 마지막 글자를 **적용해 지우고**(`|\b/` → `/`, 본문 끝의 SGR 등 CSI
    시퀀스는 건너뛰고 그 앞 글자 하나, 서로게이트 쌍은 함께; 본문이 비었거나 시퀀스뿐이면 무동작이고 줄 시작 SGR은 건드리지 않는다),
    BEL(`\x07`)·나머지 C0(`\x00`–`\x06`·`\x0B`·`\x0C`·`\x0E`–`\x1A`·`\x1C`–`\x1F`)·DEL(`\x7F`)은 **제거**한다. `\x1b` 시퀀스·`\t`·`\n`·`\r`은
    그대로다. 제거하지 않으면 벤더 폭 계산이 BS·BEL을 글자 폭으로 세거나(커서 열 어긋남) 편집 재그리기마다 BEL이 다시 울린다.
    **예외**(RD-026 사후 리뷰): 문자열 시퀀스(OSC `\x1b]`·DCS `\x1bP`·SOS·PM·APC) 안은 종료자(BEL 또는 ST `\x1b\`)까지 손대지 않는다 —
    BEL을 지우면 시퀀스가 열린 채 본문에 남아 터미널이 뒤따르는 프롬프트·입력까지 삼킨다(`\x1b]0;title\x07`). 줄이 바뀌면(`\n`·`\r`)
    열린 시퀀스도 끝난 것으로 보고 본문을 비운다. 시퀀스 안의 BS·C0는 적용·제거하지 않는다. 벤더 `Tty`
    폭 계산은 CSI를 ECMA-48대로 읽는다: 파라미터 바이트(0x30–0x3F: 숫자·`:`·`;`·사설 접두 `<=>?`)와 중간 바이트(0x20–0x2F)를 이어가고 최종
    바이트(0x40–0x7E)에서 폭 0으로 끝낸다(`\x1b[?25l`의 `25l`이 3칸으로 세어져 접두 `\x1b[?25l50%` 뒤 커서 열이 기대 8이 아니라 11이던 것을 없앴다). 한계: BS는 커서 이동이
    아니라 "마지막 글자 삭제"로 모사하므로 `ab\b`(BS 뒤 글자 없음)는 실제 터미널이 `ab`로 남기지만 접두는 `a`가 된다(`10-parity-deviations.md`
    편차 4). VT·FF 등 나머지 C0의 커서 이동, OSC·DCS 등 CSI 밖 시퀀스의 폭, 8비트 C1(0x80–0x9F)은 처리하지 않는다.
- **시험**: 벤더 `print-above-raw.test.ts`, terminal `sinks.test.ts`("열린 읽기 …" describe 5개, `\r`로 끝나는 조각 포함)·
  `terminal-runner.test.ts`, repl `run-source.test.ts`("열린 읽기 위 배경 출력" describe 2개, "Tab 완성 응답과 배경 출력 재그리기의 겹침")·
  `terminal/read-guard.test.ts`(RD-022b 절, `04-stdin-input.md` 3.2), 브라우저 `e2e:bg-output`(B01~B08, B07이 `\r`로 끝나는 진행률 조각, B08이 커서 숨김 진행률 조각의 커서 열, core `output-tail.test.ts` 제어 문자 정규화, terminal `sinks.test.ts` "접두의 제어 문자 정규화"·`terminal-runner.test.ts`·repl `run-source.test.ts`의 "재그리기 대기 중 abort·reset()의 접두 복원",
  `apps/demo/e2e/BASELINE.md`).

참고: `/work/cp949/pyodide-samples/apps/repl/docs/design/05-output-streaming.md`,
`/work/cp949/pyodide-samples/apps/repl/src/repl/{terminal-sinks,sink-writer,output-tail}.ts`
