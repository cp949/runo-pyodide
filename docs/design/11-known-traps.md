# 알려진 함정 (이전 구현 35건 중 유효 33건 이관)

번호 `TRAP-NN`은 이 문서 안의 식별자이고 괄호의 `TRP-0NN`은 이전 구현(`/work/cp949/pyodide-samples/docs/repl/traps/`)의 원본 번호다. 새 구현에서 새로 승격하는 함정은 `docs/agents/rubber-workflow.md`에 따라 `docs/traps/TRP-001`부터 따로 번호를 매긴다(이 문서와 번호가 겹치지 않는다).

## 목록

| 번호              | 범주     | 증상                                                                                            |
| ----------------- | -------- | ----------------------------------------------------------------------------------------------- |
| TRAP-01 (TRP-002) | runtime  | `input()` 프롬프트가 Enter 뒤에야 다음 출력과 함께 늦게 나타난다                                |
| TRAP-02 (TRP-003) | runtime  | 예외가 날 때만 트레이스백에 pyodide 내부 프레임이 다 보이고 proxy가 이미 파괴돼 있다            |
| TRAP-03 (TRP-007) | runtime  | `await asyncio.sleep(1)`이 top-level에서 오류 없이 실행돼 CPython REPL과 다르다                 |
| TRAP-04 (TRP-009) | runtime  | 실행 구간 밖에서 쓴 SIGINT가 남아 다음 문장 실행 때 worker가 죽는다                             |
| TRAP-05 (TRP-014) | runtime  | stdin 콜백의 취소 신호 대부분이 HANG·`OSError`·`EOFError`·fatal로 엉뚱하게 끝난다               |
| TRAP-06 (TRP-019) | runtime  | `^C`가 찍히고 버퍼도 0인데 루프가 계속 돈다(신호 폴링 비원자성)                                 |
| TRAP-07 (TRP-020) | runtime  | `await asyncio.sleep(5); print('done')`이 `^Cdone`이 되고 `sleep` 루프는 프롬프트가 안 돌아온다 |
| TRAP-08 (TRP-021) | runtime  | 드물게 눌림이 조용히 사라지거나 시험이 시간 초과로 멈춘다                                       |
| TRAP-09 (TRP-022) | runtime  | 기대한 트레이스백 앞에 `CancelledError` 트레이스백이 하나 더 화면에 나온다                      |
| TRAP-10 (TRP-032) | runtime  | `import collections.a` 완성 후보가 예외 없이 `[]`다                                             |
| TRAP-11 (TRP-001) | readline | dispose된 `Readline`의 지연 콜백이 `DisposableStore` 경고를 남긴다                              |
| TRAP-12 (TRP-004) | readline | 개행 없이 끝난 출력이 다음 읽기의 첫 재그리기에서 통째로 지워진다                               |
| TRAP-13 (TRP-006) | readline | 붙여넣은 탭이 조용히 사라져 들여쓰기가 깨진다                                                   |
| TRAP-14 (TRP-008) | readline | `read()` 직후의 입력 버퍼 조작이 조용히 사라진다                                                |
| TRAP-15 (TRP-016) | readline | 폭을 넘는 프롬프트의 첫 재그리기가 앞 행을 남겨 중복된다                                        |
| TRAP-16 (TRP-017) | readline | 화면은 멀쩡한데 스크롤백에서 꼬리 1행이 사라진다                                                |
| TRAP-17 (TRP-030) | readline | 재그리기 뒤 커서 복원이 줄 맨 앞으로 가거나 이모지 뒤에서 어긋난다                              |
| TRAP-18 (TRP-011) | harness  | pty로 띄운 3.14 `_pyrepl`이 화살표 키를 오류 없이 무시해 "↑ 무동작"으로 오인된다                |
| TRAP-19 (TRP-013) | harness  | pty CPython의 stderr 무개행 쓰기가 안 보여 "출력 안 됨"으로 오인된다                            |
| TRAP-20 (TRP-015) | harness  | 배경 실행한 pty 자식이 SIGINT를 무시해 Ctrl+C가 오류 없이 무반응이다                            |
| TRAP-21 (TRP-018) | harness  | Ctrl+C 연타 측정이 눌림 합쳐짐·에코 합쳐짐·소표본 때문에 성공처럼 보인다                        |
| TRAP-22 (TRP-023) | harness  | `unhandledRejection` 리스너를 붙인 시험이 vitest 집계에서 빠진다                                |
| TRAP-23 (TRP-024) | harness  | 폴링 경로 JS 훅이 맨몸 루프 +10%로 보이지만 `str(i)` 루프는 2.9배다                             |
| TRAP-24 (TRP-025) | harness  | 가짜 재전송이 섞여 재전송 횟수를 소실·복구로 읽게 된다                                          |
| TRAP-25 (TRP-028) | harness  | 눌림 시각 고정·소표본 측정이 통과해 최대 지연 13배가 안 보인다                                  |
| TRAP-26 (TRP-029) | harness  | 블로킹 대기 위의 `setTimeout` 눌림 시험이 끊기지 않았는데 통과한다                              |
| TRAP-27 (TRP-034) | harness  | 모듈 완성 후보 개수·목록 단정이 cwd와 환경마다 깨진다                                           |
| TRAP-28 (TRP-035) | harness  | 요청 번호 없이 심은 SIGINT를 핸들러가 무시해 "영향 없음"으로 오판된다                           |
| TRAP-29 (TRP-012) | protocol | 끝 개행을 붙여 넘겨도 시험이 통과한 채 프롬프트 앞에 빈 줄만 생긴다                             |
| TRAP-30 (TRP-026) | protocol | 읽기 진입에서 취소한 인터럽트 송신기가 곧바로 되살아난다                                        |
| TRAP-31 (TRP-027) | protocol | SIGINT 슬롯을 ack 없이 지우면 부팅 중 Ctrl+C가 worker를 죽인다                                  |
| TRAP-32 (TRP-031) | protocol | Python 인덱스를 JS 문자열에 그대로 써서 이모지 뒤가 한 칸씩 어긋난다                            |
| TRAP-33 (TRP-033) | protocol | 단어 경계 정규식 게이트가 `1import os`에서 건전하지 않다                                        |

## runtime — pyodide/CPython 런타임 함정

### TRAP-01 (TRP-002) batched stdout이 개행 없는 프롬프트를 지연시킴

- 증상: `input("이름: ")`의 프롬프트가 사용자가 입력하기 전이 아니라 Enter 뒤 다음 출력과 함께 나타난다. 값 전달은 정확하고 오류도 없어 "프롬프트 없이 입력받는 버그"로 오인한다.
- 원인: `pyodide.setStdout({ batched })`는 개행이 나올 때까지 버퍼링한다. `input(prompt)`가 쓰는 프롬프트에는 개행이 없다. `PyodideConsole`의 `stdout_callback`(`console.py`의 `_WriteStream`)은 `write()`마다 즉시 콜백을 부르는 별개 경로다.
- 새 구현이 지킬 규칙: 전역 스트림은 `setStdout({ batched })`를 쓰지 않고 `write` 단위 콜백으로 등록한다. 콘솔 콜백과 전역 stdout·stderr를 같은 sink로 보낸다(프롬프트 대기 중 도는 콜백의 출력은 전역 스트림을 탄다).
- 검증 방법: `input("p: ")` 실행 후 메일박스에 값을 넣기 _전에_ 터미널에 `p: `가 도달했는지 화면 행으로 단언한다.

### TRAP-02 (TRP-003) raw ConsoleFuture를 JS에서 직접 await하면 트레이스백이 깨지고 proxy가 조기 파괴됨

- 증상: 정상 경로는 잘 동작하고 예외가 날 때만 터진다. `e.message`에 `_runcode_with_lock`/`runcode`/`run_async` 프레임이 그대로 보이고, 직후 `fut.formatted_error`를 읽으면 `Error: Object has already been destroyed`가 난다.
- 원인: 내부 프레임 제거 결과(`Console.formattraceback`의 `num_frames_to_keep`)는 `ConsoleFuture.formatted_error`에만 들어 있다. JS 네이티브 `await`(thenable 프로토콜)로 Python Future를 소비하면 완료 시점에 pyodide가 그 proxy를 파괴한다.
- 새 구현이 지킬 규칙: Python 쪽에 `await_fut(fut)` 헬퍼(`res = await fut; return to_js([res], depth=1)`)를 한 번 정의하고 `fut`를 직접 await하지 않는다. 오류 문자열은 `e.message`가 아니라 `fut.formatted_error`를 쓴다.
- 검증 방법: `1/0` 제출의 트레이스백 문자열에 pyodide 내부 프레임 이름이 없음을 단언한다.

### TRAP-03 (TRP-007) Console은 top-level await가 기본 ON이라 CPython REPL과 조용히 다름

- 증상: `await asyncio.sleep(1)`이 오류 없이 실행된다. 실제 `python`은 `SyntaxError: 'await' outside function`인데 어긋났다는 신호가 없다.
- 원인: `Console.__init__`(stdlib `pyodide/console.py`)가 항상 `_CommandCompiler(flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)`를 만든다. 끄는 생성자 인자도 공개 API도 없다.
- 새 구현이 지킬 규칙: 콘솔 생성 직후 한 번만 private `_compile.compiler.flags`의 해당 비트를 끈다. 실행 중에는 바꾸지 않는다(`... ` 블록 입력 중 다음 push가 `_IncompleteInputError`로 실패하고 buffer가 비워진다). 값을 바꾸려면 worker를 새로 만든다.
- 검증 방법: 비공개 속성 경로 존재를 단정하는 시험을 따로 둔다. pyodide 버전을 올리면 이 시험이 먼저 실패한다.

### TRAP-04 (TRP-009) 실행 구간 밖에서 쓴 SIGINT가 남아 다음 문장에서 worker를 죽임

- 증상: 화면에는 `^CKeyboardInterrupt` 한 줄만 어색하게 찍히고 오류가 없다. worker는 다음 문장을 실행할 때 죽어 원인과 증상이 떨어져 보인다.
- 원인: SIGINT는 소비되기 전까지 버퍼에 남는다. 다음 `pyconsole.push`가 컴파일(`tokenize`) 중 신호를 폴링해 `KeyboardInterrupt`를 던지는데, 그 호출이 `try` 밖이면 worker 스크립트가 종료된다.
- 새 구현이 지킬 규칙: `push`/`runsource` 호출 전체를 `try`로 감싼다. 매 실행 직전 interrupt buffer 슬롯 0을 비운다(비울 때 ack 규칙은 TRAP-31). worker SIGINT 핸들러는 스택에 `<console>` 프레임이 없는 SIGINT를 버린다. 실행할 코드가 없는 구간(취소 직후 ~ 다음 읽기 활성화 전)의 Ctrl+C는 SIGINT를 쓰지 않는다.
- 검증 방법: 브라우저에서 Ctrl+C를 0ms 간격으로 2회 이상 누른 뒤 `print(1)`과 짧은 `for` 루프가 죽지 않는지 확인한다(화면과 단위 시험만으로는 안 드러난다).

### TRAP-05 (TRP-014) stdin 콜백에서 취소를 알리는 방법 대부분이 오류 없이 엉뚱하게 동작함

- 증상: 취소 신호 방식마다 다르게 실패한다. `buf[0]=2` 후 정상 반환은 HANG·엉뚱한 프레임이 섞여 실행마다 결과가 다르고, `throw new Error(...)`는 `OSError: [Errno 29]`, `null`/`undefined` 반환은 `EOFError`, `errno`만 가진 `Error`는 `Pyodide already fatally failed`, `FS.ErrnoError(EINTR)`만 던지면 CPython이 무한 재시도한다.
- 원인: pyodide `readWriteHelper`가 콜백 예외를 매핑한다(`err.code`가 `ERRNO_CODES`면 `ErrnoError`, `errno` 속성만 있으면 그대로 다시 던져 fatal, 나머지는 EIO(29), `EAGAIN`은 100ms 뒤 재시도). 올바른 경로는 `pyodide.checkInterrupt()`가 던지는 `ErrnoError(EINTR)`를 CPython `_Py_read`(PEP 475)가 받아 `PyErr_CheckSignals()`로 소비하는 것이다.
- 새 구현이 지킬 규칙: 취소는 `interruptBuffer[0] = 2` 뒤 `pyodide.checkInterrupt()` 하나만 쓴다. 버퍼는 main이 아니라 stdin 콜백(worker)이 쓴다. 메일박스가 돌려준 취소 표식을 `null`/예외로 바꿔 pyodide에 넘기지 않는다.
- 검증 방법: 실제 pyodide 시험으로 취소 뒤 `interruptBuffer[0] === 0`, `input()`과 `sys.stdin.readline()`이 호출 지점에서 `KeyboardInterrupt`를 내며, `except Exception`이 삼키지 않고 20회 반복에도 멈추지 않는지 확인한다.

### TRAP-06 (TRP-019) 신호 폴링이 읽기와 비우기를 나눠 해서 그 사이에 쓴 Ctrl+C가 사라짐

- 증상: `^C`는 찍히고 `interruptBuffer[0]`도 0으로 돌아왔는데 루프가 계속 돈다. 트레이스백도 오류도 없고 다시 누르면 멈춰서 "일시 지연"으로 읽힌다.
- 원인: `pyodide.asm.mjs`의 `_Py_CheckEmscriptenSignals_Helper`가 `r = buf[0]; buf[0] = 0; return r`로 읽기와 비우기를 나눠 하며 원자적이지 않다. 업스트림 python/cpython#157548(열림, 영향 버전 main·3.15·3.14·3.13), 수정 PR python/cpython#157553(읽기·비우기를 `Atomics.exchange()` 한 번으로, main 대상, 3.14·3.13 백포트 표지 없음). 실측 소실률은 `while True: pass` 단일 눌림 3.3~4.7%.
- 새 구현이 지킬 규칙: interrupt buffer를 3슬롯(`[signal, ack, seq]`)으로 두고, main이 `Atomics.add(buffer, 2, 1)` → `Atomics.store(buffer, 0, 2)` 순서로 쓴 뒤 5ms마다 ack를 점검해 같은 요청 번호로 재전송한다(상한 10회). worker 핸들러는 이미 처리한 요청 번호의 재도착을 무시한다. 첫 눌림 뒤 이후 눌림을 버리는 게이트는 두지 않는다(소실된 눌림이 영구 HANG이 된다).
- 검증 방법: 재전송을 끈 채 Node `while True: pass` 단일 눌림 N=3000에서 소실 0이면 업스트림 수정이 들어온 것이고, 그때 재전송 송신기·ack·요청 번호 슬롯을 함께 제거한다.

### TRAP-07 (TRP-020) `time.sleep`이 `run_sync`로 바뀌어 SIGINT가 사용자 프레임 없는 콜백에서 소비됨

- 증상: `^C`가 찍히고 오류도 없다. `await asyncio.sleep(5); print('done')`은 `^Cdone`이 찍혀 Ctrl+C가 통째로 무시된 것이 드러나고, `while True: time.sleep(0.1)`은 프롬프트가 안 돌아오며 두 번째 Ctrl+C도 먹지 않는다. `while True: pass`만 검증하면 못 본다.
- 원인: JSPI가 가능하면 pyodide가 `time.sleep`을 `run_sync(asyncio.sleep(t))`로 교체하고(`webloop.py` `_sleep`), `asyncio.run`도 `WebLoop.run_until_complete` → `run_sync`로 간다. 대기 중 사용자 `<console>` 스택은 JSPI로 정지하고 폴링은 다른 콜백(`run_handle`)에서 일어나므로 "스택에 `<console>` 프레임이 있을 때만"인 핸들러가 그 SIGINT를 버린다.
- 새 구현이 지킬 규칙: `time.sleep`을 20ms 블로킹 조각 래퍼로 감싸고 조각마다 `pyodide_js.checkInterrupt()`를 부른다. 핸들러 규칙에 "사용자 실행 중(`runcode` 안)이면 사용자 스택이 없어도 정지한 실행을 깨운다"를 더한다. 이벤트 루프가 비는 구간은 worker JS 감시 타이머(20ms)가 맡는다.
- 검증 방법: 시나리오에 `time.sleep` 루프·단발, `asyncio.run`, top-level await `await`를 모두 넣는다.

### TRAP-08 (TRP-021) 핸들러가 소비한 SIGINT는 되돌릴 수 없음

- 증상: 대부분의 시행이 통과하고(프로토타입 60/60) 드물게 두 모양으로 실패한다 — 눌림이 조용히 사라지거나(화면에 `^C`만) 시험이 시간 초과로 멈춘다.
- 원인: 폴링이 이미 버퍼를 비운 뒤 Python 핸들러가 돈다. 깨울 Task의 코루틴이 `CORO_RUNNING`이면 `task.cancel()`이 `_must_cancel`만 세워 `pyodide.console`의 `done_cb`가 `CancelledError`를 만나 `ConsoleFuture`가 영영 끝나지 않는다. 대기 Task가 막 `fut.done()`이면 깨울 대상이 없고 SIGINT를 되돌릴 수 없다.
- 새 구현이 지킬 규칙: 취소는 `inspect.getcoroutinestate(task.get_coro()) == inspect.CORO_SUSPENDED`인 Task에만 한다. 깨울 수 없는 순간에 소비한 SIGINT는 `pending`으로 표시하고 재개하는 `run_sync` 래퍼가 `KeyboardInterrupt`로 올린다. 표시는 `runcode` 진입·종료에서 지운다.
- 검증 방법: `signal.raise_signal(signal.SIGINT)`로 두 순간을 결정적으로 고정한 시험을 둔다(코루틴은 `<console>`이 아닌 파일명으로 정의). 무작위 N=60 반복으로는 이 경합을 못 잡는다.

### TRAP-09 (TRP-022) pyodide가 예외를 JS로 변환할 때 트레이스백을 stderr에 찍음

- 증상: 기대한 `KeyboardInterrupt` 트레이스백 앞에 `Traceback…` + `File ".../asyncio/tasks.py", line 702, in sleep` + `asyncio.exceptions.CancelledError`가 한 번 더 붉게 나온다. 하니스가 stderr를 버리면 안 보인다.
- 원인: `_pyodide/__init__.py`가 `sys.excepthook = traceback.print_exception`으로 두고 C의 `wrap_exception()`이 `PyErr_Print()`으로 그 훅을 부른다. `runcode` 중에는 `sys.stderr`가 `stderr_callback`으로 리다이렉트돼 있어 화면으로 샌다(`runcode` 밖에서는 안 나온다).
- 새 구현이 지킬 규칙: 정지한 대기를 깨울 때 그 Task를 취소·예외로 끝내지 않고 센티널 정상 값으로 끝낸 뒤 사용자 스택에서 `KeyboardInterrupt`를 올린다. `checkInterrupt()` 호출 동안만 `sys.excepthook`을 no-op으로 바꿨다가 되돌린다(`run_sync` 대기 전체를 덮으면 그 창에서 도는 사용자 콜백이 바뀐 훅을 쓴다).
- 검증 방법: 시험·측정 하니스의 화면 단언에 `writeError`와 `stderr_callback` 출력을 함께 모은다.

### TRAP-10 (TRP-032) zip stdlib에서 ModuleCompleter가 HARDCODED_SUBMODULES를 잃음

- 증상: `import collections.a`가 예외 없이 `[]`를 돌려준다(네이티브 3.14는 `collections.abc`). `[]`는 "후보 없음"과 같은 모양이라 오류로 안 보이고, `import os.p` 같은 흔한 스모크는 통과한다.
- 원인: `_pyrepl._module_completer.ModuleCompleter`의 `_is_stdlib_module`이 `module_info.module_finder`가 `FileFinder`이고 `path == _stdlib_path`일 때만 stdlib로 본다. pyodide stdlib는 zipimporter라 False가 되어 `HARDCODED_SUBMODULES` 확장이 적용되지 않는다.
- 새 구현이 지킬 규칙: 서브클래스에서 `_is_stdlib_module`만 오버라이드해 zipimporter의 `archive == _stdlib_path`도 stdlib로 더한다(vendoring·원본 수정·`importlib` 패치는 하지 않는다). `_pyrepl` import 실패는 try/except로 삼키지 않고 worker 시작을 실패시킨다(조용한 기능 상실보다 낫다).
- 검증 방법: 오버라이드 없는 원본이 해당 4줄에서 `[]`라는 사전 조건과, 의존하는 비공개 이름(`_stdlib_path`가 `str`, `_is_stdlib_module` 존재)을 각각 따로 단정한다(`get_completions`가 `AttributeError`를 삼켜 런타임에서는 조용히 실패한다).

참고: `/work/cp949/pyodide-samples/docs/repl/traps/` 의 TRP-002, TRP-003, TRP-007, TRP-009, TRP-014, TRP-019, TRP-020, TRP-021, TRP-022, TRP-032

## readline — xterm-readline 함정 7건과 이전 우회 방식

벤더링 결정 근거: 아래 7건 중 4건(TRAP-13·14·15·17)의 우회가 라이브러리 비공개 내부에 의존한다.
TRAP-13은 `readPaste` 런타임 패치와 `InputType` enum 값, TRAP-14는 `read()`의 write 콜백 타이밍과 `activeRead`/`State` 생성 순서,
TRAP-15는 `Tty`가 export되지 않아 레이아웃 계산을 자체 재구현, TRAP-17은 `readline.state`(`moveCursorBack`, `editing`)와 `line.pos`의 단위에 의존한다.
TRAP-12는 공개 `read(prompt)`만 쓰지만 `refreshLineInner`의 재그리기 전제에 기댄다. TRAP-11은 `dispose()`의 미완 정리, TRAP-16은 수정 없이 한계로 기록했다.
벤더링하면 TRAP-13·15·17은 소스 직접 수정으로 단순해지고 TRAP-14는 타이밍 계약을 명시할 수 있다. 벤더링하지 않으면 이 4건은 라이브러리 업그레이드마다 재검증 대상이다.

### TRAP-11 (TRP-001) StrictMode 이중 마운트 + `read()` 재귀 루프 경합

- 증상: 콘솔에 `Trying to add a disposable to a DisposableStore that has already been disposed of` 경고만 뜨고 화면과 왕복 결과는 정상이다. dev(StrictMode)에서만 재현된다.
- 원인: `xterm-readline`(1.2.2)의 `Readline.dispose()`가 `disposables` 배열만 정리하고 `this.term`을 `undefined`로 만들지 않는다. `read()` 내부 `term.write("", cb)` 콜백이 `this.term === undefined`만 검사해 이미 dispose된 xterm에 접근한다.
- 새 구현이 지킬 규칙: `read()`는 RPC 요청이 올 때만 호출하고 마운트 effect 안에서 재귀 루프를 돌리지 않는다. `cancelled` 플래그를 `read()` 호출 *전*에도 검사한다.
- 검증 방법: dev StrictMode 마운트 후 콘솔 경고 0건인지 확인한다.
- 이전 우회: 재귀 `while` 루프 자체를 제거하고 worker RPC가 필요할 때만 `read()`를 부르게 바꿨다. 비공개 API 의존 없음.

### TRAP-12 (TRP-004) `read()`가 커서 열을 0으로 간주해 개행 없는 출력을 지움

- 증상: `print("x", end="")` 단독 실행 뒤 프롬프트가 뜨면 `x`가 화면에서 완전히 사라진다. 마지막 출력이 개행으로 끝나는 테스트(`print("x", end=""); print("y")`)는 통과한다.
- 원인: `Tty.refreshLineInner`가 `read()` 시점의 `term.buffer.active.cursorY`만 `anchorRow`로 기억하고, 그 행을 항상 `\r\x1b[J`(열 0 이동 후 지우기)부터 다시 그린다. 커서가 중간 열에 있으면 그 행의 기존 텍스트는 보존 없이 지워진다.
- 새 구현이 지킬 규칙: 모든 읽기는 sink가 추적한 꼬리를 프롬프트 앞에 합성해 그 자리에 다시 그린다. sink를 거치지 않는 `readline.print()`/`term.write()` 출력 경로를 만들지 않는다. `cursorX !== 0`이면 개행을 넣는 방식은 쓰지 않는다(xterm이 비동기 파싱한 버퍼 값이라 낡을 수 있다).
- 검증 방법: `print("x", end="")` 단독 실행 뒤 프롬프트 행이 `x>>> `인지 화면 행으로 단언한다(프롬프트만 넘기는 변이로 RED 확인).
- 이전 우회: 자체 리더 래퍼(`stdin-reader.ts`·`repl-reader.ts`)가 sink의 `tail()`을 합성 프롬프트로 넘겼다. 공개 `read(prompt)`만 쓰지만 `refreshLineInner`의 재그리기 전제에 의존.

### TRAP-13 (TRP-006) 붙여넣은 탭을 조용히 버림

- 증상: 붙여넣기 자체는 성공해 보이고(글자가 나오고 오류 없음) 들여쓰기만 사라져 `IndentationError`나 블록 구조가 바뀐 실행으로 뒤늦게 드러난다.
- 원인: `keymap.js`의 `parseInput`이 0x09를 `UnsupportedControlChar` 토큰으로 분류하고, `readPaste`가 Text·Enter가 아닌 토큰을 `readKey`로 넘기는데 `readKey`가 무시한다(`readline.js` 344-346).
- 새 구현이 지킬 규칙(RD-011 완료): 벤더 소스(`packages/xterm-readline/src/readline.ts`)의 `readPaste`에서
  붙여넣기 경로의 `UnsupportedControlChar`+단일 `\t` 토큰만 `Text`로 승격한다 — 래퍼가 아니라 소스를 직접
  고친다. 직접 Tab 키 입력(`readKey`의 `UnsupportedControlChar` 분기)은 REPL 읽기의 `onKey`(Tab 리더,
  `createTabReader`)가 소비한다(RD-015 완료, `07-tab-completion.md` 7.1).
- 검증 방법: 탭으로 들여쓴 여러 줄을 실제 `Readline`에 붙여넣어 버퍼에 `\t`가 남는지 단언한다. `InputType` enum 값을 통합 시험으로 고정해 라이브러리 업그레이드 시 먼저 깨지게 한다.
- 이전 우회: `preservePastedTabs`가 `readPaste`를 런타임 패치했다. 비공개 `InputType` enum 값과 `readPaste` 내부 흐름에 의존.

### TRAP-14 (TRP-008) `read()`는 입력 상태를 비동기로 만들어 직후의 버퍼 조작이 사라짐

- 증상: `read()` 직후의 `updateLine()`이 예외 없이 지나가지만 이전 `State`를 갱신하고 새 `State`가 덮어써서 프리필이 조용히 사라진다. 동기 write 콜백 가짜 터미널에서는 통과한다. 재그리기 중 들어온 키는 옛 읽기로 가서 `readLine` RPC가 영영 pending으로 남는다.
- 원인: `Readline.read()`가 `term.write("", cb)` 콜백 안에서 `new State(...)`와 `activeRead`를 만든다. 실제 xterm은 이 콜백을 쓰기 순서대로 나중에 부른다.
- 새 구현이 지킬 규칙: `read()` 직후 `term.write("", cb)`를 하나 더 예약하고 그 콜백 안에서만 버퍼를 조작한다. 재그리기 구간에 들어온 키는 큐에 넣고 콜백에서 상태를 복원한 뒤 순서대로 처리한다.
- 검증 방법: 가짜 터미널을 `asyncWrite: true`로 두고 시험한다. 콜백 없는 `updateLine`으로 되돌리는 변이와 큐를 제거하는 변이에서 RED인지 확인한다.
- 이전 우회: 자체 리더 래퍼(`auto-indent-reader.ts`의 write 콜백 예약, `tab-reader.ts`의 `redrawing` 키 큐). `activeRead`/`State` 생성 타이밍이라는 내부 구현에 의존.

### TRAP-15 (TRP-016) 여러 행 프롬프트의 첫 재그리기가 앞 행을 남겨 중복됨

- 증상: 폭을 넘는 프롬프트의 첫 그리기 직후에만 앞 행이 중복된다. 글자를 치기 시작하면 라이브러리가 스스로 올라가 맞아 보이고, 전체 바이트에 `toContain('\x1b[nA')`를 쓰는 시험은 Enter 시점의 라이브러리 자체 이동으로 충족돼 통과한다.
- 원인: `read()`가 시작 시점 `cursorY`를 `anchorRow`로 잡고, 첫 재그리기는 oldLayout 커서 행이 0이라 위로 올라가지 않은 채 커서 행부터 `\r\x1b[J`로 지우고 프롬프트 전체를 다시 쓴다(`tty.js` `refreshLineInner`).
- 새 구현이 지킬 규칙: `read()` 앞에 `\x1b[nA`로 커서를 프롬프트 첫 행까지 올린다. n은 `term.write('', cb)`로 flush를 기다린 뒤 화면 버퍼에서 커서 행부터 `isWrapped`를 위로 센 값이다(`baseY + cursorY` 기준, `cursorY` 상한).
- 검증 방법: 첫 재그리기(`\r\x1b[J`) _앞에_ 나간 `\x1b[nA`만 센다. 커서 올리기 제거, 행 수 고정, `baseY` 무시, `cursorY` 상한 제거 변이로 실제로 걸리는지 확인한다.
- 이전 우회: 자체 `rewindTail` 구현이 xterm `buffer.active`의 `isWrapped`를 직접 순회했다. `Tty`가 export되지 않고 `string-width`가 선언 의존성이 아니라 라이브러리 레이아웃 규칙을 재구현한 형태.

### TRAP-16 (TRP-017) 뷰포트를 채운 레이아웃에서 맨 윗행이 스크롤백에 안 감

- 증상: 보이는 화면은 항상 정상이고 스크롤백을 올려야 꼬리 1행이 사라진 구멍이 보인다. 짧은 꼬리(16행)는 통과하고 400·800·3000토큰에서만 나온다.
- 원인: `refreshLineInner`가 뷰포트 행 수 안에서만 레이아웃을 그린다. 앵커가 0보다 크면 행이 늘 때 `\n`으로 스크롤해 스크롤백에 보내지만, 앵커가 0이면 스크롤 없이 창만 밀어 맨 윗행을 그 자리에서 덮어쓴다(코드 읽기 기준 추정, 실험 결과와 일치).
- 새 구현이 지킬 규칙: 꼬리 행 수를 `rows - 2` 이하로 제한할지 결정하고, 제한하지 않으면 알려진 한계로 DESIGN에 명시한다(제한은 문턱만 옮기는 부분 완화다). 꼬리 상한을 "스크롤백이 넘친다"는 이유로 두지 않는다 — 그 예측은 틀렸다(500k자 꼬리에서도 키당 15~25ms, 중복 없음).
- 검증 방법: `term.buffer.active`를 스크롤백까지 읽어 꼬리 400·800·3000토큰에서 고유 토큰의 소실·중복을 센다.
- 이전 우회: 없음(RD-006b에서 알려진 한계로 기록하고 고치지 않음). 비공개 API 의존 없음.

### TRAP-17 (TRP-030) `moveCursorBack(0)`은 줄 맨 앞으로 가고 `n`은 코드포인트 수

- 증상: `n = 0`(커서가 줄 끝)이면 커서가 줄 맨 앞으로 가서 다음 글자가 앞에 들어간다. 커서 뒤에 이모지가 있으면 이모지 하나당 한 칸씩 어긋난다. 예외는 없고 바이트·행 단정은 통과한다. `updateLine` 뒤에는 ↑/↓가 줄 이동이 아니라 history 탐색이 된다.
- 원인: `lib/line.js`의 `prevPos(n)`이 `[...buf].slice(-n)`이라 `n = 0`이면 배열 전체가 되고, `[...buf]`는 코드포인트 단위인데 `pos`·`buf.length`는 UTF-16 코드 유닛이다. `lib/state.js`의 `update(text)`가 `editing = false`로 되돌린다.
- 새 구현이 지킬 규칙: `[...buf.slice(pos)].length`(코드포인트 수)를 넘기고 0이면 `moveCursorBack`을 아예 부르지 않는다. `updateLine` 전에 `state.editing`을 저장해 복원한다.
- 검증 방법: 커서 끝·중간·커서 뒤 이모지 세 경우에서 다음 글자의 위치를 단언하고, 여러 줄 버퍼 재그리기 뒤 ↑의 결과를 단언한다(각 가드를 제거하는 변이로 RED 확인).
- 이전 우회: 호출부(`tab-reader.ts`의 `showList`)가 `state.moveCursorBack`·`state.editing`을 직접 조작했다. `Readline.state`와 `line.pos` 단위 등 비공개 내부에 의존.

참고: `/work/cp949/pyodide-samples/docs/repl/traps/` 의 TRP-001, TRP-004, TRP-006, TRP-008, TRP-016, TRP-017, TRP-030

## 검증 하니스 설계 규칙 (harness 11건 압축)

측정·테스트 방법론 함정은 전부 "측정이 통과했는데 사실이 아니다"라는 같은 모양이다. 규칙으로 압축한다.

1. **TRAP-18 (TRP-011) pty `_pyrepl` 화살표는 `TERM`에 맞춰 보낸다.** `TERM=xterm`이면 ↑ `\x1bOA`·↓ `\x1bOB`, `TERM=linux`면 `\x1b[A`·`\x1b[B`. 다른 쪽은 오류 없이 버려져 "↑ 무동작"으로 오인된다. 인식 여부는 "직전 입력이 다시 그려지는지"로 판정하고 `PYTHON_COLORS=0`·`NO_COLOR=1`로 색을 끈다(색 이스케이프가 `print(12345)` 부분 문자열 검사를 오탐으로 만든다). 홈 오염 방지로 `PYTHON_HISTORY`는 임시 파일로 고정한다. 시퀀스를 바꿔 한 번 확인하기 전에는 실측 결론을 쓰지 않는다.
2. **TRAP-19 (TRP-013) pty CPython의 무개행 stderr·stdin 중 stdout은 명시 flush로 잰다.** `sys.stderr.line_buffering=True`, `write_through=False`라 `\n`·`\r` 없는 조각은 다음 flush까지 안 나오고, 그 텍스트가 다음 케이스 바이트에 섞여 나온다. 실측 문장에 `sys.stderr.flush()`(또는 `flush=True`)를 명시하고, 바이트가 섞여 보이면 이전 케이스의 잔류부터 의심한다. 웹 REPL은 stderr 버퍼가 없어 무개행 조각을 즉시 표시하는 의도된 편차다.
3. **TRAP-20 (TRP-015) 배경 실행 pty 자식은 SIGINT 처분을 먼저 확인한다.** 비대화형 셸이 `&` 비동기 명령의 SIGINT를 SIG_IGN으로 두고 exec 뒤에도 유지된다. `pty.fork()` 자식에서 exec 전에 `signal.signal(signal.SIGINT, signal.SIG_DFL)`를 부르고, 스크립트 시작 시 자식의 `signal.getsignal(signal.SIGINT)`가 SIG_DFL인지 단언한다.
4. **TRAP-21 (TRP-018) Ctrl+C 연타는 간격을 스윕하고 눌림이 아니라 `KeyboardInterrupt` 수로 센다.** 간격 0(실제 약 1µs)은 쓰기가 합쳐져 눌림 한 번과 같아지고, pty의 0ms 송신은 커널이 `^C` 에코를 합친다. 간격 0·0.2·0.5·1·2·5·20·50ms를 스윕하되 0은 "합쳐짐" 셀로 따로 읽고, 실제 대상의 이벤트 타임스탬프로 간격 분포를 먼저 잰다. 결과를 종류별로 집계하고 종류가 모두 드러날 때까지 표본을 늘린다(3.14 pty는 50회에서 세 종류, 확률 3% 셀은 20회로는 안 보인다). 콜드(세션 첫 트레이스백)와 웜을 구분한다.
5. **TRAP-22 (TRP-023) `unhandledRejection` 리스너를 붙인 시험은 집계에 기대지 않는다.** vitest의 `catchError`가 해당 이벤트 프로세스 리스너 수가 1을 넘으면 집계하지 않는다(vitest 5.0.1). 리스너로 모은 목록의 단언(`expect(rejections).toEqual([])`)이 유일한 신호다. 리스너는 `onTestFinished`로 반드시 뗀다. vitest를 올릴 때 이 판정이 바뀌었는지 확인한다.
6. **TRAP-23 (TRP-024) 폴링 경로에는 JS 코드를 더하지 않는다.** 접근자·Proxy 비용은 폴링 횟수에 비례하고 폴링 밀도가 작업량마다 약 100배 다르다(맨몸 `while` 반복당 0.02~0.04회 대 `str(i)` 반복당 약 2.04회). 3M회 맨몸 루프 +10%만 보면 통과처럼 보이지만 `''.join(str(i) …)`는 2.93배다. 소실은 폴링 쪽이 아니라 눌림 쪽(ack + 재전송)에서 푼다. 폴링 경로를 건드리는 변경은 `str(i)` 루프로도 재고(plain 대비 1.03 이내, 10회 교차), 폴링 횟수는 카운터 래퍼로 센다.
7. **TRAP-24 (TRP-025) 재전송 횟수를 소실로 세지 않는다.** 폴링이 슬롯을 비운 뒤 핸들러가 ack를 올리기 전 약 40µs 창에 점검이 걸리면 가짜 재전송이 생긴다(5ms 점검에서 발생률 0.8%, 추적 11/11이 이 창). 소실은 `KeyboardInterrupt`가 0인 눌림이나 감시견이 살려야 했던 라운드로 센다. 통과선을 "재전송 0"이 아니라 "미소비 구간(슬롯이 2인 동안)의 재전송 0 + 중단 정확히 1회"로 나눠 잰다.
8. **TRAP-25 (TRP-028) 지연 측정은 눌림 시각을 무작위로 두고 N≥30의 최대값으로 판정한다.** 폴링을 pyodide 틱 클럭에 맡긴 대기는 최대 지연이 (반복 1회 시간)×12.5~13.1까지 늘어나는데, 눌림 시각 고정 하니스(브라우저 `sleep-0.01` 166ms)와 판정선 1초 단위 시험은 통과한다. 눌림 시각이 고정인 결과는 "위상 하나"임을 적고, 대기 시간 조합을 20ms 경계 근처까지 넓힌다. 시험은 지연 시간이 아니라 폴링 호출 횟수로 가른다.
9. **TRAP-26 (TRP-029) 블로킹 대기의 눌림은 별도 스레드로 넣는다.** 블로킹 대기 동안 Node 이벤트 루프가 멈춰 `setTimeout` 눌림이 대기가 끝난 뒤 도착하므로 `pressed > 0` 그리고 `sincePress < 1s`가 끊기지 않았는데도 만족된다(`time.sleep(3)`이 3006ms 걸렸는데 통과). `worker_threads` 눌림 스레드와 `process.hrtime.bigint()` 공유 시계를 쓰고, 눌림 뒤 지연뿐 아니라 실행 전체 시간과 `screen.stderr`(트레이스백)도 단언한다. 새 시험은 기준선 코드에서 RED인지 확인한다.
10. **TRAP-27 (TRP-034) 모듈 완성 후보는 개수·전체 목록을 단정하지 않는다.** `sys.path[0] == ''`라 cwd의 `.py` 파일이 후보가 되고 환경 모듈 집합도 다르다(3.14.4 네이티브 192개, pyodide 178개, 하니스 폴더 pty 196개). 시험·문서는 접두사·포함 여부·삽입 결과·구조(열 우선 배치, 200개 상한)를 단정하고, 후보 리터럴은 네이티브와 pyodide가 같은 케이스에만 쓴다. 문서에 개수를 적을 때는 측정 환경(빈 임시 cwd, 번들 버전)을 함께 적고, pty 측정 하니스는 자식 REPL의 cwd를 빈 임시 폴더로 고정한다.
11. **TRAP-28 (TRP-035) SIGINT를 심는 프로브는 실제 경로와 같은 순서로 쓰고 ack로 판정한다.** 핸들러가 요청 번호(슬롯 2)가 그대로면 재전송으로 보고 무시하므로, 슬롯 0에만 쓴 프로브는 "영향 없음"으로 오판된다. 프로브도 `Atomics.add(buffer, 2, 1)` 뒤 `Atomics.store(buffer, 0, 2)` 순서로 쓰고, 소비 여부는 슬롯 0이 아니라 ack(슬롯 1) 증가로 본다. "영향 없음" 결론 전에 같은 대상이 실제 Ctrl+C 경로에서는 끊기는지 양성 대조를 둔다.

참고: `/work/cp949/pyodide-samples/docs/repl/traps/` 의 TRP-011, TRP-013, TRP-015, TRP-018, TRP-023, TRP-024, TRP-025, TRP-028, TRP-029, TRP-034, TRP-035

## protocol — 자체 설계·프로토콜 함정

### TRAP-29 (TRP-012) sink가 개행을 붙이는데 호출부도 끝 개행을 붙임

- 증상: 단위 시험이 통과하고 화면에는 값·트레이스백·배너 뒤에 빈 줄이 하나 더 생긴다. 오류도 경고도 없다. 테스트 fake가 받은 텍스트를 그대로 누적하면 기대값과 맞아떨어지고, 빈 줄 허용 정규식을 쓴 브라우저 검증도 통과한다.
- 원인: `readline.println(text)`는 `write(text + "\r\n")`이고 `write()`가 `\n`을 `\r\n`으로 정규화한다. 호출부가 `text`에 `\n`을 붙이면 개행이 두 번 나간다. pyodide의 `formatted_error`에는 끝 개행이 이미 붙어 온다.
- 새 구현이 지킬 규칙: 줄 단위 출력(`writeOutput`/`writeError`)에는 끝 개행 없는 텍스트를 넘기고, 오류 문자열은 끝 개행 1개만 떼어 넘긴다. 조각 단위로 오는 출력(`stdout_callback`, `stderr_callback`)은 줄 단위 경로가 아니라 raw 경로로 보낸다. 개행 계약을 DESIGN의 표로 고정한다.
- 검증 방법: 테스트 fake가 `text + '\n'`을 누적해 sink를 모사하고, 새 출력 경로는 끝 개행까지 `toBe`로 단언한다. sink 시험은 fake가 아니라 실제 sink + 실제 `Readline`(가짜 터미널)의 터미널 바이트로 단언한다.

### TRAP-30 (TRP-026) 읽기 진입에서 취소한 인터럽트 송신기가 readline 활성화 전 눌림으로 되살아남

- 증상: 프롬프트가 뜬 뒤에도 5ms 점검 타이머가 남아 "취소 배선 결함"으로 읽힌다. 배선은 맞고 취소 뒤에 새 `send()`가 걸린 것이다. 가짜 타이머 단위 시험은 "진입이 `cancel()`을 부른다"만 확인하므로 통과한다.
- 원인: `read()`가 `activeRead`를 `term.write("", cb)` 콜백 안에서 세운다(TRAP-14와 같은 뿌리). 진입의 `cancel()`과 `activeRead` 설정 사이 간격(실측 17.0ms·32.7ms) 동안 들어온 Ctrl+C가 `activeRead === undefined` 분기를 타 송신기를 다시 건다.
- 새 구현이 지킬 규칙: 읽기 진입에서 "Python 정지" 플래그를 세우고 그 읽기가 끝날 때 내린다. 플래그가 선 동안 Ctrl+C 핸들러는 `^C` 에코만 하고 `send()`하지 않는다. 이 플래그는 REPL 프롬프트 읽기에만 걸고 `input()` 대기에는 걸지 않는다(그 구간은 사용자 프로그램이 실행 중이라 SIGINT가 전달돼야 한다). 같은 플래그로 부팅 중·`exit()` 뒤 잔류도 막는다.
- 검증 방법: 브라우저 측정에서 프롬프트 파싱 뒤 남은 점검 타이머 수(`leak>0`)를 센다. 5.5ms 간격 눌림 시나리오를 60시행 돌린다.

### TRAP-31 (TRP-027) SIGINT 슬롯을 ack 없이 지우면 송신기가 되살려 부팅 중 Ctrl+C가 worker를 죽임

- 증상: 시험 전체·타입체크·lint·브라우저 매트릭스가 모두 통과한 채 남는다(그 측정들은 전부 프롬프트가 뜬 뒤에 누른다). 부팅 크래시 트레이스백이 시작 코드(`eval_code`, `signal.signal`) 안의 `KeyboardInterrupt`라 "pyodide 시작이 불안정하다"로 읽힌다. 실측 수정 전 30/30 크래시.
- 원인: 부팅 중 눌림이 SIGINT를 쓴 뒤 worker가 슬롯을 ack 없이 지우면, 다음 점검이 `signal === 0`·`ack === snapshot`을 소실로 읽고 같은 번호로 다시 쓴다. 그 2가 핸들러 설치 전 pyodide 기본 폴링에 걸린다(요청 번호 규칙은 핸들러 안에 있어 설치 전에는 못 막는다).
- 새 구현이 지킬 규칙: 슬롯을 지우는 모든 곳은 지운 값이 2일 때 ack를 올린다(지울 눌림이 없으면 ack하지 않는다 — 과잉 ack는 살아 있는 송신기가 미전달을 전달로 읽게 한다). 송신기가 살아 있을 수 있는 상태에서 슬롯을 비우거나 worker를 바꾸는 코드는 `cancel()`이나 ack 중 하나를 반드시 동반한다. 핸들러를 interrupt buffer 연결보다 먼저 설치한다.
- 검증 방법: 첫 프롬프트 _전에_ 누르는 브라우저 시나리오를 둔다(`page.goto`는 `waitUntil: 'commit'`, `waitForSelector`는 `state: 'attached'` — `domcontentloaded`는 늦고 xterm 헬퍼 textarea는 크기 0이라 기본 `visible`이 프롬프트까지 기다린다). 새 정리 지점을 더하면 "그 지점 전에 누른 눌림"을 시험한다.

### TRAP-32 (TRP-031) Python 코드포인트 인덱스를 JS UTF-16 문자열에 그대로 씀

- 증상: ASCII·한글(BMP)은 모든 시험이 통과한다. 이모지가 스템 앞에 있으면 삽입 글자가 이모지 하나당 한 글자씩 모자라거나 남고 예외는 나지 않는다. 공통 접두사를 `slice(0, -1)`로 줄이면 서로게이트 쌍 중간에서 끊겨 반쪽이 삽입된다.
- 원인: 이모지는 JS에서 2 코드 유닛, Python `str`에서 1 코드포인트다(같은 자리가 JS 11, Python `start` 10). `xterm-readline`의 `line.pos`는 UTF-16이라 main 쪽 인덱스는 JS 기준이고 Python이 돌려준 값만 코드포인트다.
- 새 구현이 지킬 규칙: Python이 준 인덱스는 값을 바꾸지 않고 그대로 RPC로 넘기고, JS에서 쓰는 한 곳에서만 `[...text].slice(start)`로 코드포인트 기준 해석한다. 공통 접두사도 코드포인트 단위로 구한다. 인덱스·길이를 RPC 경계로 새로 주고받는 코드는 단위를 프로토콜 문서에 명시한다.
- 검증 방법: worker·main 경계를 넘는 인덱스는 이모지가 든 입력으로 시험한다 — 순수 함수, 실제 pyodide의 `start` 값, 전체 흐름 3단계. `slice(start)`로 되돌리는 변이로 셋 다 RED인지 확인한다.

### TRAP-33 (TRP-033) 단어 경계 정규식은 tokenize 기반 판정의 사전 게이트로 건전하지 않음

- 증상: `/\b(import|from)\b/` 게이트가 일반 코드에서 옳아 보인다(게이트 거짓 30줄 중 25줄에서 파서도 `None`). 어긋나는 5줄은 전부 문법 오류 입력이라 손으로 고른 시험 입력에는 안 나온다.
- 원인: Python `tokenize`는 숫자 리터럴 바로 뒤 키워드를 `NUMBER` + `NAME('import')`로 나눈다. `1import os`, `1.5from os`, `0x1fimport os`는 숫자와 글자가 모두 `\w`라 `\b`가 경계로 안 보는데 파서는 후보를 낸다. 게이트가 거짓이면 파서를 건너뛰고 대체 동작을 해 오류 없이 3.14와 다른 결과가 나온다.
- 새 구현이 지킬 규칙: 게이트는 "토큰 글자열이 텍스트에 부분 문자열로 있어야 한다"는 필요조건만 쓴다(`/import|from/`). 건전성이 구조로 보장된다. 대가는 식별자 안 키워드가 든 빈 스템 줄의 worker 왕복 1회 추가다. 식별자 시작 위치만 배제하는 식으로 좁히지 않는다(`0x1fimport`가 앞 글자 검사로 구분되지 않아 같은 함정이다).
- 검증 방법: 실제 파서로 코퍼스(55줄 규모)를 돌려 게이트 거짓 줄이 전부 `None`임을 단정하고, 숫자 리터럴 5줄은 `\b` 게이트가 거짓인데 파서가 `None`이 아니며 부분 문자열 게이트는 참임을 단정한다. 게이트를 바꾸는 변경은 이 코퍼스를 통과해야 한다.

참고: `/work/cp949/pyodide-samples/docs/repl/traps/` 의 TRP-012, TRP-026, TRP-027, TRP-031, TRP-033

## 새 구조에서 제거됨

coincident 동기 브리지가 직접 원인이던 2건은 순수 Worker + MessageChannel 비동기 RPC 구조에서 사라진다.

- **TRP-005 (main→worker 호출이 worker의 동기 대기 중 응답하지 않음)**: 대부분 제거. 남는 축소된 형태는 `input()` 전용 SharedArrayBuffer 메일박스 대기 중에만 worker JS 스레드가 `Atomics.wait`로 정지해 main→worker RPC에 응답하지 못한다는 것이다. 그 구간에 main이 worker를 능동 호출하는 기능(완성 등)을 배치하지 않고, 메일박스 대기 중 Ctrl+C는 interrupt buffer 경로로만 전달한다.
- **TRP-010 (Error가 아닌 값으로 reject하면 worker가 함수 이름 문자열을 정상 반환값으로 받음)**: 제거. coincident `main.ts`의 `frame[2] || frame[1]` 응답 프레임 조립이 원인이므로 새 구조에는 없다. 대신 반환값·취소 표식의 인코딩은 자체 RPC·메일박스 프로토콜이 책임진다 — 취소를 예외나 `null`로 표현하지 말고 명시적 태그로 구분하고, 그 태그가 `pyodide.setStdin` 콜백 반환값으로 새지 않게 한다(`null`/`undefined`는 EOF가 된다, TRAP-05).

참고: `/work/cp949/pyodide-samples/docs/repl/traps/TRP-005-sync-bridge-main-to-worker-call-blocked.md`, `/work/cp949/pyodide-samples/docs/repl/traps/TRP-010-sync-bridge-reject-non-error.md`
