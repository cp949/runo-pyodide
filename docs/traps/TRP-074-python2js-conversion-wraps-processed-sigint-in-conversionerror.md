# TRP-074 Python→JS 변환 중 처리된 SIGINT는 ConversionError로 감싸여 `except KeyboardInterrupt`를 비켜간다

- 상태: ACTIVE
- 적용 조건: C `python2js` 변환 중에 실행되는 Python 프레임(`ABCMeta.__subclasscheck__` 등)에서 SIGINT가 처리되고, 그 프레임 사슬에 `<console>` 프레임이 있을 때. 대표 경로는 `run_sync` 래퍼가 부른 C `run_sync`가 대기 Task를 JS로 바꾸는 구간이다. SIGINT 핸들러(`packages/pyodide-core/src/worker/sigint-handler.py`)의 사슬 순회·`run_sync` 래퍼를 고칠 때, 변환 지점에서 나온 `KeyboardInterrupt`를 다루는 시험을 쓸 때도 해당한다.

## 오해하기 쉬운 신호

- 자연 재현이 거의 없다. 처리 위치가 interrupt buffer 폴링 위상에 좌우되고(TRP-030), 변환 구간의 Python 프레임은 짧다. 전체 시험에서 드물게 한 번 실패하고 단독 재실행은 통과해 무시하기 쉽다.
- 나타나도 마지막 줄이 `pyodide.ffi.ConversionError: Conversion from python to javascript failed`이고 앞에 `Traceback (most recent call last):` 블록이 여러 개라 평범한 트레이스백처럼 읽힌다. 실제로는 `KeyboardInterrupt`가 `__cause__`로만 남았다.
- 사용자 코드의 `except KeyboardInterrupt:`는 `ConversionError`를 잡지 못해 조용히 우회된다. Ctrl+C가 "먹은 것처럼" 보이지만 사용자 처리기가 실행되지 않는다.
- 첫 블록(`sys.excepthook` 출력)이 콘솔 `sys.stderr`로 이미 새어 나가 결말 stderr에 트레이스백 블록이 2~3개 남는다(TRP-021의 중복 블록과 같은 경로).

## 원인

pyodide 314.0.7(태그 `b1e4fcc2488962f6360a97f19b9982d6fdb5d16f`)의 `src/core/`와 대조한 결과다.

- C `run_sync`가 `asyncio.ensure_future` 뒤 `python2js(ensured_future)`를 부른다(`jsproxy.c:4572`). 이어 `pyproxy_getflags` → `type_getflags`가 `PyObject_IsSubclass(obj_type, Generator)`·`AsyncGenerator`를 부른다(`pyproxy.c:215-218`). 정확 타입 `dict`·`tuple`·`list`만 캐시가 있어 Task 타입은 매번 검사한다. `PyObject_IsSubclass`는 `ABCMeta.__subclasscheck__` Python 프레임(`<frozen abc>`)을 연다.
- 핸들러는 그 프레임에서 SIGINT를 처리하면 사슬에 `<console>` 프레임이 있어 규칙 ①(사용자 코드 실행 중)로 `KeyboardInterrupt`를 올린다.
- 변환이 실패하면 `python2js_inner`의 `ON_FAIL`이 `_PyErr_FormatFromCause(conversion_error, "Conversion from python to javascript failed")`로 예외를 `ConversionError`(`__cause__` = `KeyboardInterrupt`)로 바꾼다(`python2js.c:580`, `:892`에도 같은 호출).
- 그 전에 JS `pyproxy_new`가 실패하면 `_pythonexc2js()` → `wrap_exception_inner`가 `PyErr_Print()`를 부른다(`error_handling.c:179`). `capture_stderr()`는 fd 2만 잡으므로 `sys.excepthook` 출력이 콘솔 `sys.stderr`로 나간다. 이 출력이 첫 블록이다. 이 연결은 프레임 구조·코드 읽기·관찰된 stderr 모양에서 추론했고 `PyErr_Print` 시점의 `sys.stderr`를 직접 관측하지는 않았다.

## 탐지/회피

- 결정적 주입 시험으로 확인한다. `abc.ABCMeta.__subclasscheck__`를 교체해 조건 `cls is collections.abc.Generator and subclass is pyodide.webloop.PyodideTask`에서 1회 `press(); signal.raise_signal(signal.SIGINT)`를 실행하고, 주입 횟수(`== 1`)를 단언한다(TRP-031). 기대 결말은 stderr가 표준 `KeyboardInterrupt` 트레이스백과 정확히 같고, `ConversionError`·`<sigint-handler>`·`<frozen abc>` 문자열이 없으며, `except KeyboardInterrupt:`가 한 번 잡는 것이다. 시험은 `packages/pyodide-repl/src/worker/sigint-handler-idle.test.ts`의 `asyncio 콜백 경합 지점에서 처리된 SIGINT(주입)` 묶음에 있다.
- 처리: `run_sync` 래퍼가 C `run_sync`를 부르는 동안(`converting`) 핸들러가 사슬에서 `run_sync` 래퍼 프레임(`f.f_code is run_sync_code`)을 `<console>`보다 먼저 만나면 규칙 ①로 올리지 않고 미룬 깨우기(규칙 ③)로 보낸다. 대기 Task가 취소되고 래퍼가 사용자 스택에서 `KeyboardInterrupt`를 올린다. 핸들러 사슬 순회나 래퍼를 바꿀 때 이 시험 묶음을 유지한다.
- 미처리 범위: `run_sync` 래퍼 밖 변환 지점(`js.fn(py_obj)`, 콘솔 `ConsoleFuture` 변환 등)은 같은 창이 있을 수 있으나 처리하지 않았고 재현하지도 않았다. `.scratch/sigint-test-isolation/issues/08-conversion-error-outside-run-sync-wrapper.md`(`deferred`)에 재개 조건이 있다. 래퍼 프레임보다 안쪽에 사용자 프레임이 있으면(사용자 ABC의 `__subclasshook__` 등) 규칙 ①이 그대로 올려 `ConversionError`로 감싸일 수 있다. 시험하지 않았다.
- 관련: 폴링 위상(TRP-030), 주입 시험의 공회전 방지(TRP-031), 중복 블록(TRP-021).
