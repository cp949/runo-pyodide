# 콘솔 코어: PyodideConsole·제출 실행·top-level await·종료

> 이 문서의 규칙·상수는 이전 구현(`/work/cp949/pyodide-samples/apps/repl`, 읽기 전용 참고)이 CPython 3.14.4 pty 실측과 브라우저 회귀로 확정한 것이다. 새 구현은 통신 계층만 바꾸고(`docs/design/00-architecture.md`, `01-protocols.md`) 이 규칙은 그대로 지킨다. 절 끝의 "참고:" 경로는 이전 구현의 근거 위치다.

worker 안에서 도는 REPL 코어의 규칙이다. 5.6(`runSource`, RD-022a)은 이전 구현에 없는 신규 절이다. main과의 통신은 `01-protocols.md`의 RPC(`readLine` 요청, 출력 알림)와 무관하게 이 규칙만으로 결정된다.

## 5.1 PyodideConsole 사용법

- 콘솔은 `pyodide.console.PyodideConsole`. `stdin_callback`은 넘기지 않고, `stdout_callback`/
  `stderr_callback`만 sink에 연결한다(`write`/`writeErrorRaw`).
- `push(line) -> ConsoleFuture`. `syntax_check`는 `'incomplete' | 'syntax-error' | 'complete'`,
  오류 문자열은 `formatted_error`. 미완성 블록의 줄은 `console.buffer`(접근할 때마다 새 proxy이므로
  쓴 뒤 `destroy()`), 비우기는 `buffer.clear()`.
- **`ConsoleFuture`를 JS에서 직접 `await`하면 안 된다**(TRP-003): 내부 프레임이 트레이스백에 남고 예외 뒤
  `formatted_error`를 읽으면 이미 파괴된 프록시다. Python 쪽 `await_fut(fut, echo=True)` 헬퍼 하나를 별도
  namespace에 두고 그것으로만 await한다. 헬퍼는 `[echo | None, exited, error | None]` 세 값을 돌려준다(JS에서
  `None`은 `undefined`). `SystemExit`은 따로 잡아 `[None, True, None]`(문자열 파싱 대신 `isinstance` 판별), 값이
  `None`이면 `[None, False, None]`이다. 그 밖의 값은 `repr(값)` **전체**가 `echo`다(절단 없음, `repr_shorten`은
  쓰지 않는다). `builtins._`는 `repr`가 성공한 뒤에만 갱신한다. `repr`가 예외를 내면 `error`에 트레이스백을 담고
  (`__traceback__.tb_next`로 `await_fut` 프레임 한 칸을 뗀다) `_`는 건드리지 않는다. JS에는 `PyProxy` 값이 오지 않는다.
  `echo` 인자(RD-011)가 거짓이면 `repr()`·`builtins._` 갱신을 건너뛰고 `[None, exited, None]`만 돌려준다 —
  여러 줄 분할 재생에서 에코하지 않는 중간 문장에 쓴다(5.2 `runChunk`). 기본값 `True`라 기존 한 줄 경로는
  그대로다.
- **`runLine(source, options?: { echo?: boolean })`**(repl `worker/console.ts`의 `createConsole(pyodide, sinks,
{ topLevelAwait })`가 돌려주는 `ReplConsole`, RD-004, `echo` 옵션은 RD-011 추가): `push`와 `await_fut`를 묶은
  한 줄 실행이다. `echo`(기본 `true`)는 그대로 `await_fut(fut, echo)`에 전달된다. 결과 `RunLineResult`는
  `{ kind: 'incomplete' }`, `{ kind: 'syntax-error', formattedError }`, `{ kind: 'complete', echo, exited }`,
  `{ kind: 'error', formattedError }` 넷이다. `echo`는 값의 `repr()` 전체이고 값이 `None`이거나 `exited`이거나
  `options.echo === false`이면 `null`이다. `formattedError`는 `fut.formatted_error`(내부 프레임이 잘린 것,
  `e.message`가 아니다)를 아래 정규화만 거친 값이라 끝 개행을 포함하고(`repr` 예외는 `await_fut`가 만든
  트레이스백), 제거는 호출부가 한다. `fut.destroy()`는 `finally`에서 부른다. `await_fut`·`format_syntax_error`·
  `retrieve_exception` 소스는 repl `worker/console.ts`에 TS 템플릿 문자열로 인라인돼 있고 별도 namespace에 정의한다
  (사용자 globals를 오염시키지 않는다). `createConsole`의 순서는 전역 stdout/stderr Writer 등록 → `sys.ps1/ps2`
  → `PyodideConsole(pyodide.globals)` + 콜백 → TLA 비트 → 헬퍼 namespace다. 이 중 Writer 등록(`installStdioWriters`)과 `PyodideConsole` 생성 + 콜백(`createCoreConsole(pyodide, sinks, { filename? })`, 기본 `<console>`)은 core `worker/core-console.ts`가 함수로 제공하고, REPL `createConsole`이 두 함수를 부르며 `sys.ps1/ps2`·TLA 비트·헬퍼 namespace를 위 순서로 그 사이·뒤에 끼운다. `sys.ps1/ps2`를 콘솔 생성 앞에 두는 것은 이전 구현 순서를 따른 것이고 기능 제약은 아니다(pyodide 314.0.7 `pyodide/console.py`는 `ps1`·`ps2`를 읽지 않는다). 뼈대 순서(Writer 등록 → 콘솔 생성)를 core 부팅이 소유하지 않는다(arch-review 04 후보 3 기각, 2026-09-27): 순서가 driver `createConsole` 한 함수에서 위에서 아래로 읽히고, Writer 누락은 driver 시험(core `run-driver.test.ts`의 `createConsole` 절, repl `worker/console.test.ts` "콘솔 밖 출력은 전역 Writer로 같은 sink에 온다")이 잡는다. 세 번째 driver가 생기면 재검토한다. 부팅 시퀀스에서 이 함수를 부르는 것은 core `bootWorker`가 부르는 `WorkerDriverSession.createConsole`이다(`00-architecture.md` 3.1). 취소·안전망·값 에코 표시(5.2)는
  이 위에 `createSubmissionRunner`가 얹고, 여러 줄 분할은 RD-011이 더했다.
- **`compilerFlags(): number`**(`ReplConsole`, RD-011): `pyconsole._compile.compiler.flags &
~INCOMPLETE_INPUT_FLAGS`(문법 오류 정규화가 쓰는 것과 같은 `0x4200` 마스크). `createSubmissionRunner`가 여러
  줄 분할(5.2) 직전에 불러 `split_paste`에 넘긴다 — TLA 스위치(5.4)가 켜져 있으면 이 값도 그 비트를 포함한다.
- **`pending()`/`clearPending()`**: `pending()`은 블록 입력 중이면 콘솔 `buffer`의 줄들을 `\n`으로 이은 텍스트, 아니면
  `undefined`다. `clearPending()`은 `buffer.clear()`로 미완성 블록을 버리며 블록이 없어도 안전하다. `buffer`는 접근할
  때마다 새 proxy라 둘 다 쓴 뒤 `destroy()`한다. 러너와 루프는 `pyconsole.buffer`를 직접 만지지 않고 이 둘을 쓴다.
- **문법 오류 정규화**: pyodide 314.0.7 콘솔은 EOF에서 끊긴 문법 오류(`1 +`, `foo bar`)와 본문 없는 중첩 블록을
  `_IncompleteInputError: incomplete input`으로 표시한다(3.14 REPL은 `SyntaxError: invalid syntax`, 중첩 블록은
  `IndentationError`). `runLine`이 `push` 직전에 `pending`을 읽어 두고(`push`가 끝나면 buffer는 비워진다), 결과가
  `syntax-error`이며 `formatted_error`의 마지막 줄이 `_IncompleteInputError: incomplete input`이면 Python 헬퍼
  `format_syntax_error(source, flags)`로 바꾼다. 헬퍼는 `compile(source + "\n", "<console>", "single", flags & ~0x4200, True)`를
  다시 시도해 `SyntaxError`의 `traceback.format_exception_only` 문자열을 돌려준다. `source`는 `pending`이 있으면
  `pending + "\n" + line`, 없으면 `line`이고 `flags`는 호출 시점의 `pyconsole._compile.compiler.flags`(TLA 비트 유지)다.
  `0x4200`은 codeop이 최종 컴파일에서 끄는 `ALLOW_INCOMPLETE_INPUT`(0x4000)와 `DONT_IMPLY_DEDENT`(0x200)다.
  **`source`에 끝 개행을 붙여야 한다**: 없으면 `offset=0`이 되어 캐럿 줄이 사라진다(3.14 pyrepl도 끝 개행이 있는 소스를
  쓴다). 재컴파일이 예외 없이 끝나거나 `SyntaxError`가 아닌 예외를 내면 pyodide 원문을 그대로 쓴다. 마지막 줄이 마커가
  아닌 오류(`x = = 1`은 `SyntaxError: invalid syntax`, `)`는 `SyntaxError: unmatched ')'`)도 원문 그대로다. 결과: `1 +`는
  `    1 +` 아래 `       ^`(7칸)와 `SyntaxError: invalid syntax`, `foo bar`와 블록 안 `1 +`도 3.14.4 pty와 캐럿 위치까지
  같고, 본문 없는 중첩 블록은 `IndentationError: expected an indented block after 'if' statement on line 2`다.
- **문법 오류 future 회수**: `syntax-error` future는 await하지 않으므로 `runLine`이 Python 헬퍼 `retrieve_exception(fut)`
  (`fut.exception()`)로 예외를 회수한다. 회수하지 않으면 사이클 GC 때 asyncio가 `ConsoleFuture exception was never
retrieved`와 트레이스백(브라우저에서 24행을 넘었다)을 `sys.stderr`로 내 터미널에 끼어든다(브라우저 콘솔 로그가
  아니라 터미널 stderr로 온다). JS에서 `fut.exception()`을 부르면 예외 proxy를 `destroy()`해야 해서 Python에 둔다.

## 5.2 `createSubmissionRunner(pyodide, repl, io, deps: { splitPaste })` — `run(line: string | null)`

- 반환은 `{ prompt, exit, pending? }`. `PS1 = '>>> '`, `PS2 = '... '`. `pending`은 블록 입력 중일 때만
  있고 `repl.pending()` 그대로(콘솔 buffer의 줄들을 `\n`으로 이은 텍스트)다(main의 자동 들여쓰기·Tab 완성이 쓴다).
  `repl`은 `ReplConsole`의 `runLine`·`pending`·`clearPending`·`compilerFlags`만 쓴다. 러너는 콘솔 buffer proxy를
  직접 만지지 않는다. `deps.splitPaste`(repl `worker/multiline.ts`의 `loadSplitPaste(pyodide)`, repl `worker/repl-driver.ts`가 배선,
  RD-011)는 `(source, flags) => [error, chunks]`다.
- **분기 순서**(`run()` 맨 앞부터, RD-011): `line === null`(취소) → `repl.pending() !== undefined`(블록 입력 중
  줄 흘림, 아래) → `/[\r\n]/.test(line)`(여러 줄 분할, 아래) → 그 외 한 줄. 순서가 중요하다 — 취소를 맨 먼저
  걸러 `push(null)`이 콘솔 buffer를 `JsNull`로 오염시키지 않게 하고(`/[\r\n]/.test(null)`은 `"null"`을 검사해
  통과해 버린다), 블록 입력 중이면 개행이 있어도 분할하지 않는다. worker 루프는 분기 없이
  `run(await readLine(...))`이다.
- **`null`(취소) 분기**: `repl.clearPending()`(`buffer.clear()`) → `writeError('KeyboardInterrupt')`(개행 없음,
  빨강) → `{ prompt: '>>> ' }`.
- **한 줄 제출**: `runOne(line, { echo: true })`(아래 공유 함수)의 결과를 화면에 옮긴다. `incomplete`면
  `{ prompt: '... ', pending }`, `syntax-error`·`error`면 `formattedError`의 끝 개행 **하나만** 떼어 `writeError`
  (메시지 안의 개행은 CPython처럼 남긴다. sink가 `\r\n`을 붙이므로 그대로 넘기면 프롬프트 앞에 빈 줄이 하나 더
  생긴다, `05-output.md` 4.1), `complete`면 `echo`가 `null`이 아닐 때 `writeOutput(echo)`(값 에코)이고 `exited`
  이면 `exit: true`다. 다음 프롬프트는 `incomplete` 외에는 `>>> `다. `runOne`은 이 한 줄 규칙을 뽑은 공유
  함수이고 줄 흘림·분할 재생과 같이 쓴다.
- **줄 단위 흘림**(`repl.pending() !== undefined`, `replayLines`, RD-011): `line.replace(/\r\n?/g, "\n")
.split("\n")`을 차례로 `runOne(l, { echo: true })`한다. 각 push가 블록을 완성하면 **타이핑과 동일하게** 그때
  실행·값 에코·오류 표시가 나온다. `syntax-error`·`error`에서 그 결과를 표시한 뒤 남은 줄을 버리고 끝내며,
  `exited`도 남은 줄을 버리고 `{ exit: true }`다. 마지막 결과가 `incomplete`면 `{ prompt: '... ', pending }`.
  블록 입력 중(`... `)에 붙여넣은 여러 줄은 **분할하지 않고** 이 경로로 한 줄씩 흘려 넣는다(이미 열린 블록과
  어긋나면 `IndentationError`). 블록 안 빈 줄이 블록을 끝내는 한계(5.3)는 이 경로에만 남는다.
- **여러 줄 분할**(`/[\r\n]/.test(line)`, `runMultiline`, RD-011): `deps.splitPaste(line, repl.compilerFlags())`
  로 `[error, chunks]`를 얻는다. `error`면(파싱 또는 2차 `compile` 단계 오류, 아래 `split_paste`) 끝 개행을 떼어
  `writeError` + `>>> `로 끝낸다 — **어느 청크도 실행하지 않는다**. `error`가 없으면 청크마다
  `runChunk(lines, echo)`(`echo`는 그 청크가 **마지막 청크일 때만** `true`)한다: 줄을 차례로
  `runOne(l, { echo })`하고, 마지막 줄이 `incomplete`(복합문, 예: `def`·`class`·`for`)면 빈 줄 하나를
  `runOne("", { echo })`로 한 번 더 push해 블록을 닫는다. `error`·`syntax-error`가 나오면 표시하고 남은 청크를
  버린 채 `{ prompt: '>>> ' }`로 끝내며, `exited`이면 `{ exit: true }`다. 값 에코는 **마지막 청크의 마지막
  문장만**(`echo`가 그 청크에서만 `true`이므로 `await_fut`가 그 문장에서만 `repr`·`builtins._`를 갱신한다,
  5.1). 빈 청크 배열(공백·주석만 있는 제출)은 아무것도 push하지 않고 `>>> `(무동작). 런타임 트레이스백의
  `File "<console>", line N`은 그 청크 안 상대 번호다(3.14는 붙여넣은 전체 기준, 편차 41,
  `10-parity-deviations.md`). 붙여넣기·Shift+Enter·히스토리 재호출은 모두 개행이 든 문자열 하나로 러너에
  오므로 이 경로 하나로 처리하고 셋을 구분하지 않는다. 붙여넣은 뒤 Enter 1회로 실행한다(3.14는 한 번 더
  요구, 편차 7).
- **`split_paste(source, flags)`**(Python, `worker/multiline.py?raw`, RD-011): `\r\n`/`\r`을 `\n`으로
  정규화하고, **비어 있지 않은 모든 줄이 공통 들여쓰기를 가질 때만** dedent한다(`textwrap.dedent`는 공백
  줄을 항상 바꿔 쓰지 않는다). 파싱은 `ast.parse(source, "<console>")`이되, `flags`에 TLA 비트(`0x2000`)가
  있으면 `ast.parse`가 임의 플래그를 받지 않으므로 `compile(source, "<console>", "exec",
flags | ast.PyCF_ONLY_AST, True)`로 AST를 얻는다(top-level `await`를 통과시키려면 이 경로가 필요하다).
  얻은 AST를 **2차 검사**로 `compile(tree, "<console>", "exec", flags, True)`에 다시 넣는다 — `ast.parse`
  단계는 통과하지만 컴파일 단계에서만 걸리는 오류(함수 밖 `return`, TLA 꺼진 채의 top-level `await`)를 잡기
  위해서다. 어느 단계든 `SyntaxError`·`ValueError`·`OverflowError`가 나면
  `"".join(traceback.format_exception_only(error))`를 `error`로 돌려주고 **청크는 만들지 않는다**
  (`chunks == []`). `warnings.catch_warnings()` + `simplefilter("ignore")`가 파싱과 2차 `compile` 둘 다
  감싼다(같은 경고가 실제 `push` 시점에 다시 나온다). top-level 문장 경계·블록 안 빈 줄 제외·여러 줄 문자열
  안의 줄 보존·데코레이터 줄 포함·세미콜론 문장 묶기·`ast.Constant` 안쪽 줄 보존은 이 AST를 순회해 정한다.
  반환은 `to_js([error 또는 None, chunks], depth=3)`(`chunks`는 청크마다 줄 배열).
- `flags`는 `repl.compilerFlags()`(5.1)로 얻어 `runMultiline`이 매 호출 전달한다 — TLA 스위치(5.4)가 켜져
  있으면 `split_paste`도 top-level `await`를 통과시킨다.
- 실행 규칙 요약: 파싱·컴파일 단계 오류가 하나라도 있으면 **아무 문장도 실행하지 않고** 오류만 낸다. 값
  에코는 마지막 청크의 마지막 문장만. 런타임 예외(`KeyboardInterrupt` 포함)나 `exit()`가 나면 나머지 청크를
  중단한다. 공백·빈 줄·주석만 있는 제출은 무동작.
- **안전망**: `run()` 전체를 `try`로 감싸 사용자 코드 밖(`runLine` 안의 `push` 컴파일, `pending()`,
  `clearPending()`)에서 새는 `KeyboardInterrupt`를 취소와 같은 출력으로 처리한다. `replayLines`·`runMultiline`을
  부르는 자리는 **`return await ...`로 반환해야 한다** — `await` 없이 async 함수를 그냥 반환하면 그 안에서 새는
  예외가 이 `try`를 비켜간다(async 함수 반환값의 채택이 `try` 블록 밖에서 일어나는 JS 스펙 동작, RD-011 발견).
  `cancel()` 안에서 끊기면 예외가 `pyodide.ffi.ConversionError`로 감싸이므로 `err.type`과 메시지의
  `/^KeyboardInterrupt\s*$/m`으로 판별한다. 취소 처리가 다시 끊기면 `cancel()`을 한 번 더 시도하고 그래도
  끊기면 출력만 낸다. `KeyboardInterrupt`가 아닌 오류는 그대로 던진다.
  이 안전망은 사용자 코드 밖에서 새는 예외용이다. `runcode` 안에서 사용자 코드가 부른 `run_sync` 래퍼의 JS 변환 구간(대기
  Task를 JS로 바꾸는 동안)에서 처리된 눌림은 `ConversionError`로 새지 않고 표준 `KeyboardInterrupt`가 된다: 핸들러가 그 구간의
  규칙 ①을 미루고 미룬 깨우기로 보낸다(`03-ctrl-c.md` 2.4 "깨우기 세부"의 `run_sync` 래퍼 항목). `run_sync` 래퍼 밖의 일반
  Python→JS 변환 지점(`js.fn(py_obj)` 등)은 처리하지 않았다(`.scratch/sigint-test-isolation/issues/08-conversion-error-outside-run-sync-wrapper.md`, `deferred`).

## 5.3 multiline 판정

- 여러 줄 블록 판정은 하드코딩된 키워드가 아니라 `ConsoleFuture.syntax_check === 'incomplete'`다
  (괄호 미닫힘 포함). 공백뿐인 줄에서 Enter를 누르면 블록이 끝난다(본문이 없으면 `incomplete`가 유지된다).

## 5.4 top-level await

- **기본 OFF**. 콘솔은 부모 `Console.__init__`이 `PyCF_ALLOW_TOP_LEVEL_AWAIT`를 항상 켜므로 기본이 ON이고
  생성자로 끌 수 없다(TRP-007). 생성 직후 `pyconsole._compile.compiler.flags == 0x6200`
  (0x2000 TLA | 0x4000 ALLOW_INCOMPLETE_INPUT | 0x200 DONT_IMPLY_DEDENT).
- `setTopLevelAwait(pyconsole, enabled)`(repl `worker/top-level-await.ts`)가 **TLA 비트만** 켜고 끈다. 다른 비트는 여러 줄 입력
  판정에 쓰이므로 건드리지 않는다. `_Compile.__call__`이 매 호출 flags를 읽으므로 다음 `push`부터 반영된다.
- **적용 시점**: worker가 시작할 때 초기화 프레임 `driver` 필드의 `topLevelAwait`(`WorkerDriver.parseOptions`가 검증해 `createSession(options)`로 넘긴다)를 **콘솔 생성 직후 한 번만** 적용한다
  (main에 되묻지 않는다, `01-protocols.md` 4절). 값을 바꾸려면
  worker를 새로 만든다(실행 중 콘솔의 플래그를 바꾸면 다음 `push`가 buffer 전체를 새 플래그로 재컴파일해
  `_IncompleteInputError`가 나고 buffer가 비워진다). `=== true`일 때만 ON으로 취급한다.
- **`_compile.compiler.flags` 부재 fallback**(RD-021, 저하 식별자 `compiler-flags`): 이 경로는 pyodide 비공개 속성이다. REPL 콘솔은
  `createConsole`에서 `setTopLevelAwait` 직전에 `hasCompilerFlags`(repl `worker/top-level-await.ts`)로 경로가 number인지 판정한다.
  아니면 세 가지가 바뀐다. (1) `setTopLevelAwait`를 건너뛴다(pyodide 기본이 TLA 켬이라 `topLevelAwait: false`는 무시된다).
  (2) `normalizeSyntaxError`가 재컴파일하지 않고 원문(`_IncompleteInputError: incomplete input`)을 돌려준다.
  (3) `compilerFlags()`는 상수 `TOP_LEVEL_AWAIT_FLAG`(0x2000)를 돌려줘 `split_paste`의 붙여넣기 분할이 유지된다.
  판정을 건너뛰면 `flags`만 없는 경우 `undefined & ~비트`가 0이 되어 `compiler.flags = 0`이 조용히 써지므로 판정이 앞이어야 한다.
  결과는 driver `probe`가 `compiler-flags`로 돌려주고 main이 경고를 낸다(`13-version-upgrade.md` 13.6). 문구 탐지
  (`incomplete-input-message`)는 이와 독립이다.
- ON은 컴파일 플래그만 켠다. `asyncio` 선주입·배너 변경 등 `python -m asyncio`의 나머지는 흉내내지 않는다.
  설정은 저장하지 않아 페이지를 다시 열면 OFF다.
- **main 쪽 연동**(RD-012, `00-architecture.md` 4.1): `createRepl({ topLevelAwait })`와 `reset({ topLevelAwait })`가
  이 값을 초기화 프레임의 `driver` 필드(`{ topLevelAwait }`, REPL main driver의 `options`)에 싣는다. `reset()`은 `topLevelAwait`가 boolean이면 그 값으로 바꾸고, 생략·`undefined`면
  마지막으로 적용한 값을 그대로 유지한다(sticky, 핸들이 보관 — 값을 바꾸면 워커를 새로 만들어야 하므로 위 "적용
  시점" 제약과 같은 이유다). 데모(`ReplView.tsx`)의 top-level await 체크박스는 바뀔 때마다 즉시 무조건
  `reset({ topLevelAwait })`를 부른다(양방향, "스위치 변경 = 세션 리셋"). 터미널·배너에는 표시하지 않는다.

## 5.5 `exit()`/`quit()` 감지

- `await_fut`가 `SystemExit`을 잡아 구분값으로 돌려주고 `run()`이 `{ exit: true }`로 전한다.
- worker 루프는 `result.exit`이면 `sessionTerminated` 알림으로 세션 종료를 main에 알리고(`onTerminated`) 루프를
  `break`한다. 이후 `readLine`을 더 요청하지 않아 실제 인터프리터 종료와 동등해진다. 터미널에는 아무것도 쓰지 않고
  (3.14도 종료 메시지가 없다) worker는 살려 둔다(복구는 세션 리셋). main은 `onStatus('terminated')`만 부르고, 종료 뒤
  활성 읽기가 없어 키는 화면에 나오지 않는다(Ctrl+L만 즉시 동작하고 나머지는 벤더 type-ahead 버퍼에 쌓이며 다음 읽기가 없어 재생되지 않는다, 리셋의 `cancelRead()`가 비운다 — RD-019, `06-editing.md` 6.7). 루프가 `break`한 뒤 core `worker/boot.ts`(`bootWorker`)의 `finally`에서 `stopWatch()`·
  `interruptIdle.destroy()`로 감시 타이머와 깨우기 proxy를 정리한다(`03-ctrl-c.md` 2.5).
- 여러 줄 제출 중 `exit()`가 나면 나머지 문장은 실행하지 않는다.
- `runSource(code)`(5.6)가 실행한 코드의 `SystemExit`는 이 규칙을 따르지 않는다: `sessionTerminated`를 보내지 않고 루프를 끝내지 않으며 상태도 `terminated`가 되지 않는다(결과 `exit{ code }`, 세션 유지).

## 5.6 `runSource(code)` — 호스트가 REPL 세션에 코드를 실행시킨다(RD-022a)

`ReplHandle.runSource(code: string): Promise<RunResult>`와 `readonly busy: boolean`(`00-architecture.md` 4.1). 코드는 REPL globals(`pyodide.globals`)에서 실행되고 입력 줄 에코 없이 출력만 화면에 낸다. 치던 한 줄(텍스트·커서)은 보존해 출력 뒤 다시 그린다. CPython에 대응 기능이 없어 `10-parity-deviations.md`의 편차 대상이 아니다. 이름과 이유 문자열은 repl `dist/index.d.mts`와 일치해야 한다. 벤더 쪽 규칙은 `06-editing.md` 6.1(`takeRead`·`prefillCursor`), 프로토콜은 `01-protocols.md` 1.2(`readLine` 응답 `{ source }`)다.

### 5.6.1 실행 경로

- 프롬프트가 열려 있으면 main이 열린 `readLine` RPC에 줄 대신 `{ source }`로 응답한다. worker `runReplLoop`는 이를 제출 한 건처럼 받는다: `setAtPrompt(false)` → `discardPendingInterrupt()` → `runSource(source)` 순이고, 결말은 다음 `readLine` 요청의 네 번째 인자로 돌아온다. 그래서 Ctrl+C(core 게이트 `pythonRunning = alive && inputReadsPending === 0 && !isIdle()`, 감시 타이머)·`input()`(stdin 리더)·type-ahead가 평소 명령 실행과 같은 경로다. 프롬프트가 열린 채 동시 RPC 핸들러로 돌리는 방식은 쓰지 않는다.
- 실행·분류는 runner와 공용인 core `./worker`의 `exec_in_console`(Python, `run-driver.py`)이다(`14-runner.md` 14.2.1). `CodeRunner(source, mode="exec", return_mode="none", dedent=False, dont_inherit=True, filename=console.filename, flags=…)`로 컴파일하고 `await console.runcode(source, runner)`로 실행한다. TS는 `loadExecInConsole(pyodide)`·`toRunOutcome`이고 repl `worker/run-source.ts`의 `createSourceRunner`가 세션마다 한 번 올리고 세션이 끝나면 놓는다.
- runner와 다른 점: `console.globals`(= `pyodide.globals`)와 `sys.stdin`을 바꾸지 않는다. `runSource("x = 1")` 뒤 REPL 명령 `x`가 `1`을 돌려주는 것이 이 때문이다. 파일명은 `console.filename`(`<console>`)이다. SIGINT 규칙 ①(`03-ctrl-c.md` 2.4)과 트레이스백 프레임 유지가 이 일치에 의존한다(`docs/traps/TRP-020`, `TRP-052`).
- exec 의미: 마지막 식의 값을 출력하지 않고 `builtins._`를 바꾸지 않는다(`1 + 1`은 출력 없음). 오류 시 `sys.last_*`는 `formattraceback`의 부수 효과대로 설정된다(평소 REPL과 같다, 복원하지 않는다). 트레이스백은 REPL 형식(`File "<console>", line N`, 소스 줄 없음, stderr 빨강)으로 화면에 나가고 결과 `traceback`에도 실린다.
- TLA: 실행마다 콘솔 컴파일러 플래그(`_compile.compiler.flags & 0x2000`, 5.4)를 읽어 `top_level_await`로 넘긴다. `createRepl({ topLevelAwait })`·`reset({ topLevelAwait })`가 정한 값을 따른다. 플래그 경로가 없으면(`compiler-flags` 저하) 켬으로 본다. 끔이면 최상위 `await`는 `SyntaxError`이고 `errorType`은 `"SyntaxError"`다.
- 결말 분류는 runner와 같은 코드다(`14-runner.md` 14.2.1 표, 14.2.4): `KeyboardInterrupt`·정지한 `await`를 깨운 `IdleInterrupt`는 `interrupted{ traceback }`, `SystemExit`는 `exit{ code }`(코드 규칙·int32 밖 `& 0xFF` 포함), 그 밖의 예외는 `error{ errorType, traceback }`(`SyntaxError` 하위 클래스는 `errorType: "SyntaxError"`로 통일). worker 내부 오류(`runSource`가 던진 예외)만 REPL 고유다: 루프가 `onError`(stderr `repl 내부 오류: …`, 콘솔 미완성 블록 버림)를 부르고 결말 `{ kind: "error", errorType: "InternalError", traceback: "repl 내부 오류: …\n" }`를 싣는다. 이후 프롬프트는 `>>> `·`pending` 없음이다.
- history에 남기지 않는다. 입력 history도 블록 history(6.4)도 건드리지 않는다.

### 5.6.2 호출 시점별 결과와 거부

결과 유니온 `RunResult`는 core `createRunner`와 같다(`ok` / `error{ errorType, traceback }` / `interrupted{ traceback }` / `exit{ code }` / `restarted`). `RunRejectedError`·`RunResult`·`RunRejectedReason`은 core의 같은 클래스·타입을 repl `.`에서 다시 내보낸다(`instanceof` 성립). 판정은 위에서부터 첫 일치 행이다.

| `runSource()` 호출 시점·사건                                                                                                                                                                                                       | 결과                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`가 문자열이 아님                                                                                                                                                                                                             | `TypeError`로 reject                                                                                                                                                                  |
| `dispose()` 뒤                                                                                                                                                                                                                     | `RunRejectedError("disposed")`                                                                                                                                                        |
| 상태 `not-isolated`·`load-failed`·`crashed`·`terminated`                                                                                                                                                                           | `RunRejectedError("unavailable")`. `terminated`는 REPL 명령 `exit()`로 세션이 끝난 상태다                                                                                             |
| 다른 `runSource`가 슬롯을 차지함(대기·실행·정착 어느 단계든)                                                                                                                                                                       | `RunRejectedError("busy")`                                                                                                                                                            |
| 블록 입력 중(최근 `readLine` 요청의 `pending !== undefined`, `... `)                                                                                                                                                               | `RunRejectedError("busy")`                                                                                                                                                            |
| Python 실행 중(명령 실행), `readLine` 요청이 도착했지만 프롬프트가 아직 그려지기 전(write 콜백 전, 수 ms), `input()` 대기 중(프롬프트가 열린 채 worker의 배경 콜백이 `input()`을 불러 stdin 읽기가 대기함), Tab `complete` 왕복 중 | `RunRejectedError("busy")`                                                                                                                                                            |
| 첫 `readLine` 요청 전: `loading`(최초·리셋 직후), `ready` 알림 뒤 배너를 쓰는 구간                                                                                                                                                 | 대기(슬롯 점유). 첫 요청이 오면 읽기를 열지 않고 `{ source }`로 응답해 실행한다. 화면에 그린 것이 없어 꼬리가 남아 있으면 `\r\n`만 쓰고 출력을 시작하며 실행 뒤 `>>> `가 한 번 나온다 |
| 프롬프트가 그려져 열려 있음(`>>> `, 블록 아님)                                                                                                                                                                                     | 받아들인다: 읽기를 가져가고 실행한다(5.6.3)                                                                                                                                           |
| 대기 중 `reset()`                                                                                                                                                                                                                  | 취소하지 않고 새 worker의 첫 `>>> `에서 실행한다(아직 실행되지 않았으므로 `restarted`가 아니다). 그 리셋의 worker 생성이 실패하면 `RunRejectedError("crashed")`(`08-session.md` 8.1)  |
| 대기 중 `load-failed`                                                                                                                                                                                                              | `RunRejectedError("unavailable")`                                                                                                                                                     |
| 실행 중(`{ source }`를 보낸 뒤 결말 도착 전) `reset()`                                                                                                                                                                             | `{ kind: "restarted" }`로 resolve. 새 세션에서 다시 실행하지 않는다                                                                                                                   |
| 실행 중·대기 중 worker 크래시                                                                                                                                                                                                      | `RunRejectedError("crashed")`                                                                                                                                                         |
| 실행 중·대기 중 `dispose()`                                                                                                                                                                                                        | `RunRejectedError("disposed")`                                                                                                                                                        |
| 결말이 도착한 뒤 복원한 줄이 그려지기 전(정착 전)의 `reset()`·`dispose()`·크래시                                                                                                                                                   | 그 결말로 resolve한다. 코드는 이미 끝까지 실행됐으므로 `restarted`·거부로 바꾸지 않는다                                                                                               |

- `busy` 게터: 지금 `runSource()`를 부르면 `RunRejectedError("busy")`가 되는가(runner의 `busy`와 같은 뜻). 판정은 `runSource()`와 같은 함수(`judge()`)라 둘이 어긋나지 않는다(`docs/traps/TRP-047`). 대기로 받아들여질 시점(`loading`)·`unavailable`·`disposed`는 `false`다. `status` 게터는 없다(상태는 `onStatus`).
- 슬롯은 핸들이 하나 소유하고 세션(worker)을 넘어 산다. 대기 중인 코드가 `reset()`을 넘겨 새 worker의 첫 `>>> `에서 실행되기 때문이다. 슬롯을 비우는 사건(크래시·`load-failed`·`exit()`로 `terminated`·`reset()`·`dispose()`)은 소비자 콜백을 부르기 전에 슬롯을 비우고 결과는 콜백 뒤에 낸다(`docs/traps/TRP-051`).

### 5.6.3 화면 규칙

- 받아들이면 벤더 `Readline.takeRead()`로 열린 읽기를 제출·history 없이 끝내고 그 읽기의 프롬프트·입력 행(줄이 감겼거나 여러 행이어도 전부)을 화면에서 지운다. 커서는 프롬프트 첫 행 열 0에 놓이고 출력은 그 자리부터 시작한다. 텍스트·커서는 보존한다.
- 꼬리가 붙은 프롬프트(`a>>> pri`, 직전 출력이 미종결 줄로 끝남)와 배경 출력 접두(`tick>>> pri`, 열린 읽기 중 온 미종결 조각, `05-output.md` 4.4): 벤더는 둘 다 프롬프트로 보고 함께 지우므로 main(`repl-main-driver.ts`의 `sendSource()`가 부르는 `promptRow.take()`, RD-027·RD-029로
  `terminal/source-bridge.ts` 흡수)이 지운 것을 화면 순서(접두 → 꼬리 → 프롬프트)대로 다시 쓴다. 형식은 `접두\x1b[0m꼬리\x1b[0m\r\n`이다: 비어 있지 않은 조각만 `\x1b[0m`으로 잇고 끝에 `\x1b[0m\r\n`을 붙인다(접두만 있으면 `tick\x1b[0m\r\n`, 꼬리만 있으면 `a\x1b[0m\r\n`, 둘 다 비면 쓰지 않는다). 조각 사이 `\x1b[0m`은 벤더가 그린 프롬프트(`접두\x1b[0m꼬리\x1b[0m>>> `, `State.setPromptPrefix`·`promptRow.read`)와 같은 색 경계다 — 없으면 접두가 연 색(빨강 stderr 조각)이 꼬리로 번진다. 끝의 `\x1b[0m\r\n`은 꼬리가 열어 둔 SGR을 닫고 새 행에서 출력을 시작한다(`14-runner.md` 14.5.4 행 머리 규칙). 접두는 `takeRead()`가 읽기를 끝내면 읽을 수 없으므로 `promptRow.take()`는 `takeRead()` **직전에** `readline.abovePrefix()`로 읽는다(배경 출력의 재그리기를 기다리는 중이면 아직 그리지 않은 값이고, 그때 `takeRead()`는 지울 것이 없다, `06-editing.md` 6.1 경계 (b)). 열린 읽기가 끝난 뒤의 쓰기라 sink의 읽기 밖 경로(꼬리 공급)로 간다. 화면: `>>> pri` 위 배경 `tick\n` 뒤 `runSource("print(1)")` → `tick` / `1` / `>>> pri`, 개행 없는 `tick`이면 같은 모양(접두가 한 행으로 남는다), 접두 + 꼬리면 `ta` / `1` / `>>> pri`(편차 54의 화면 순서 그대로). `>>> pritick`·옛 `>>> pri` 흔적 행은 없다.
- 출력이 끝나면 worker가 결말을 실어 다음 `readLine` 요청을 보낸다. `promptRow.read`(RD-027)가 평소처럼 꼬리(출력이 미종결이면 그 꼬리, prompt-join 규칙 `04-stdin-input.md` 3.3) + `>>> `로 읽기를 열되 보존한 텍스트를 `prefill`, 커서를 `prefillCursor`로 넘긴다. 이 복원은 자동 들여쓰기 프리필(6.3)보다 우선하고, 보존한 텍스트가 빈 문자열이면 복원하지 않는다. 결과는 `>>> pri`(커서 위치 유지)가 출력 아래에 다시 그려진다. 입력 줄 에코 행(`>>> x = 1`)은 생기지 않는다.

### 5.6.4 정착 시점

`runSource` Promise는 worker 결말이 도착하고 보존한 줄로 다음 `>>> ` 읽기가 화면에 그려진 뒤에 resolve한다. main은 REPL reader가 `readline.read()`를 연 직후 `terminal.write("", callback)`를 하나 더 쓴다. xterm은 쓰기 콜백을 쓰기 순서로 부르고 벤더는 `read()` 안에서 이미 자기 그리기 콜백을 큐에 넣었으므로, 이 콜백은 벤더 그리기 콜백(프롬프트·복원한 줄을 그리는 write를 내고 쌓인 type-ahead를 재생) 뒤에 온다. 그리기 write는 벤더 콜백 안에서 나와 이 콜백보다 뒤에 큐에 서므로, 이 콜백은 `write("", settle)`를 한 번 더 써서 그것들이 처리된 뒤에 정착한다. 정착은 읽기 상태와 무관하다: xterm이 write 처리를 시간 예산(12ms)에서 끊어 콜백 사이에 마이크로태스크가 돌면 type-ahead의 Enter로 복원한 읽기가 이미 끝나 있을 수 있는데, 그 읽기도 그려졌으므로 그 자리에서 정착한다(다음 읽기로 미루면 제출된 명령이 끝날 때까지 resolve하지 않는다). 동기·비동기 write 두 모드와 write를 하나씩 macrotask로 처리하는 모델을 시험이 확인한다(repl `run-source.test.ts` "runSource 정착·정리 경계(사후 리뷰)"). 단 xterm DOM 행은 다음 프레임에 그려지므로 결과를 받은 직후 `.xterm-rows`를 읽으면 마지막 행이 없을 수 있다(`docs/traps/TRP-050`).

### 5.6.5 실행 중 키

평소 명령 실행과 같다. 실행 중 친 키는 type-ahead(`06-editing.md` 6.7)에 쌓였다가 복원한 커서 위치에 재생되고, Enter가 섞이면 `pri…` 줄이 제출된다. Ctrl+C는 `^C` 에코 + 중단 송신이고 결과는 `interrupted`다(트레이스백 `File "<console>", line N` + `KeyboardInterrupt`). `input()`은 stdin 리더로 읽는다. `runSource`가 진행 중일 때 main은 리셋(`terminate`) 외에는 `cancelRead()`를 부르지 않는다: `cancelRead()`는 열린 읽기가 없어도 쌓인 type-ahead를 비운다(`docs/traps/TRP-053`).

### 5.6.6 `SystemExit`와 stdin

- `SystemExit`는 `{ kind: "exit", code }`이고 세션을 유지한다(`sessionTerminated`를 보내지 않고, 루프가 `onTerminated()`를 부르지 않고, `ReplStatus`가 `terminated`가 되지 않는다). 프롬프트를 다시 그린다. 비정수 코드의 stderr 출력은 runner 규칙이다(14.2.4).
- `exit()`·`quit()`은 `SystemExit`를 올리기 전에 `sys.stdin`을 닫는다(`_sitebuiltins.Quitter`). 평소 명령의 `exit()`는 세션이 끝나 상관없고, 세션이 이어지는 `{ source }` 경로에서는 다음 `input()`이 `ValueError: I/O operation on closed file.`이 된다(`docs/traps/TRP-054`). 그래서 core `exec_in_console`이 `SystemExit` 결말에서 닫힌 stdin을 되살린다(규칙: `14-runner.md` 14.2.2).

### 5.6.7 알려진 경계

- **뷰포트보다 큰 입력**: 입력이 화면 행 수를 넘어 위쪽 행이 스크롤백으로 넘어간 상태에서 `runSource`를 부르면 그 행은 지워지지 않는다(스크롤백은 ANSI 시퀀스로 지울 수 없다). "스크롤백에 흔적이 남지 않는다"(5.6.3)는 입력이 뷰포트 안일 때만 성립한다. 화면에 남은 행만 지운다.
- **프롬프트가 그려지기 전 구간**은 `busy`다(5.6.2). 명령 출력 직후 곧바로 호출하는 소비자는 드물게 `busy`를 받는다. 호출은 프롬프트가 화면에 보인 뒤에 하는 것이 안전하다(입력 타이밍 규칙, `docs/traps/TRP-005`와 같은 취지).
- **interrupt buffer는 세션마다 새로 만든다**: `reset()`은 새 세션에 새 interrupt buffer·송신기를 싣는다(`08-session.md` 8.1 4번, `14-runner.md` 14.3.5). 실행 중(`runSource` 포함) `reset()` 직후 첫 Ctrl+C가 아직 종료되지 않은 옛 worker에 가로채이지 않도록 buffer를 나눈다(`docs/traps/TRP-049`). 이전에는 REPL이 buffer를 재사용해 `session-reset-check.mjs`의 `ccafter` 절에서 8회 중 1회 유실이 관찰됐고(`runSource`가 아닌 REPL 명령 경로), 수정 뒤 0/8이다. `runSource` 경로는 같은 `reset()`을 쓰지만 전용 브라우저 셀이 없다: S08은 `restarted` 뒤 REPL 명령만 돌리고 Ctrl+C 셀이 없다.
- Tab `printAbove` 재그리기 중의 `takeRead()`는 옛 입력줄을 지우지 못한다(`06-editing.md` 6.1). Tab `complete` 왕복 중은 `busy`로 거부하므로 실경로에서 닿지 않는다. 배경 출력(`printAboveRaw`)의 재그리기를 기다리는 중이면 입력줄이 이미 지워져 있어 받아들여도 흔적이 없다(repl `run-source.test.ts` "재그리기 콜백 전에 runSource하면 …").
- 꼬리 다시 쓰기는 꼬리가 `\r`로 덮어쓴 텍스트를 가진 경우 화면과 꼬리 추적기(마지막 `\r` 뒤만 보관)가 어긋날 수 있다. 관찰한 적은 없다.
- **그리기 전 창의 배경 출력**: `readLine` 요청으로 main이 `readline.read()`를 부른 뒤 벤더 write 콜백이 프롬프트를 그리기 전(수 ms)에 온 개행 없는 배경 조각은 열린 읽기 위 출력 경로(`05-output.md` 4.4)를 타지 않고, 곧 그려지는 프롬프트의 `\r\x1b[J`에 지워진다. 이 구간의 `runSource`는 `busy`라 5.6.3 복원과는 무관하다. 고치지 않았다(`.scratch/repl-run-source-followups/issues/09-*.md`, `deferred`).
- 브라우저 셀이 없는 경로: 뷰포트 초과 입력, `loading` 중 호출, Tab 왕복 중 호출, 크래시 중 호출, 리셋 뒤 Ctrl+C. 앞의 넷은 jsdom·node 시험이 고정한다.

### 5.6.8 시험과 확인

- core: `worker/run-driver-exec-in-console.test.ts`(실제 pyodide + 실제 `PyodideConsole`, globals·열린 stdin 불변·`SystemExit` 뒤 되살림·`console.filename`·exec 의미·TLA 인자).
- 벤더: `take-read.test.ts`(지움·커서·history·type-ahead·`prefillCursor`, jsdom + `VTerm`).
- repl worker: `worker/run-source.test.ts`(실제 pyodide: globals 공유, `_` 불변, `<console>` 트레이스백, `sys.exit(3)`, `exit()` 뒤 stdin, SIGINT·정지한 `await` 중단, TLA 켬·끔, `input()`), `worker/repl-loop.test.ts`(가짜 deps: 호출 순서·결말 운반·`onTerminated` 미호출), `worker/boot.test.ts`(실제 `MessageChannel`에서 결말이 네 번째 인자로 도착), `worker/repl-driver-source-runner.test.ts`.
- repl main: `create-repl/run-source.test.ts`(jsdom + 실제 `Readline` + 가짜 worker + `@repo/pyodide-testkit/vt-screen`의 `VtScreen`: 시나리오·거부 표·`busy`·정착 시점·꼬리·커서·생애 사건, 열린 읽기 위 배경 출력 뒤 `runSource`·접두 복원 바이트). `VtScreen`은 SGR을 무시하므로 색 경계는 쓰기 바이트로 단정한다(`docs/traps/TRP-060`).
- 브라우저: `apps/demo`의 REPL 화면 plain 요소 `source`(textarea)·`run-source`(버튼)·`source-result`(JSON 텍스트, 거부는 `{"rejected":"<reason>"}`)와 `pnpm --filter demo e2e:run-source`(S01~S10, `apps/demo/e2e/BASELINE.md`). 배경 출력 뒤 `runSource`는 `e2e:bg-output` B05(`B05T` / `5` / `>>> pri`).

참고: `/work/cp949/pyodide-samples/apps/repl/docs/design/01-console-core.md`,
이전 구현 설계 문서 `07-multiline-submit.md`, `08-top-level-await.md`,
`/work/cp949/pyodide-samples/apps/repl/src/repl/{submission-runner,multiline,top-level-await}.ts`,
`/work/cp949/pyodide-samples/apps/repl/src/repl/multiline.py`
