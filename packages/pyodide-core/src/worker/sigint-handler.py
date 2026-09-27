# - 요청 번호(`seq()`)가 마지막으로 처리한 것과 같으면 main의 재전송이다: ack도 예외도 없다. 같은 눌림이 두 번 중단되는
#   것을 막는다(TRP-025). 다르면 새 눌림이라 스택 검사·예외보다 먼저 ack한다: 아래에서 버려지는 SIGINT도 전달된 것이라
#   ack가 없으면 main이 소실로 오판해 같은 번호로 다시 쓴다(TRP-019).
# - `frame.f_back` 사슬에 `console.filename`(`<console>`)과 같은 파일명의 프레임이 하나라도 있으면 사용자 코드 실행 중이다.
#   `signal.default_int_handler`는 반드시 예외를 던져야 한다(`input()` 취소가 기대는 EINTR 경로, PEP 475).
# - 사용자 프레임이 없어도 `runcode` 안이면(= `active`가 있으면) 사용자 코드가 정지한 채 실행 중이다: `interrupt_idle()`로
#   깨운다. `asyncio.run`·`run_until_complete`·`run_sync` 대기는 JSPI로 사용자 스택이 정지하고, top-level await 대기는
#   콘솔 task가 멈춰 있어 폴링이 사용자 프레임 없는 콜백에서 일어난다(TRP-020). 깨우기는 핸들러 자리에서 하지 않고
#   `call_soon`으로 한 틱 미룬다: 핸들러는 asyncio 콜백의 bytecode 사이에서 돌아, 그 자리의 Task 취소가 콜백의
#   검사-설정(`_set_result_unless_cancelled`)을 깨뜨린다. 이미 깨운 대기가 있으면 미루지 않고 `pending`만 세운다
#   (그 대기가 올릴 KeyboardInterrupt에 합친다).
# - 예외: `run_sync` 래퍼가 C `run_sync`를 부르는 동안(`converting`) 사슬에서 `<console>`보다 안쪽에 래퍼 프레임이 있고 그
#   사이에 사용자 프레임이 없으면(= C가 대기 Task를 JS로 바꾸는 중 `Generator` 추상 클래스 검사 같은 Python 프레임에서
#   처리된 눌림) 규칙 ①로 올리지 않는다. 거기서 올린 KeyboardInterrupt는 C 변환이 `ConversionError`로 감싸고, 그 과정의
#   `PyErr_Print()`가 excepthook 출력을 콘솔 `sys.stderr`로 흘린다. 이 눌림은 아래 규칙 ③과 같은 미룬 깨우기로 보내,
#   대기 Task를 취소하면 래퍼가 사용자 스택에서 KeyboardInterrupt를 올린다.
# - 그 밖(트레이스백 생성 중, 다음 문장 컴파일 중, 시작 코드)에는 버린다.
# - `formattraceback`은 가장 안쪽 프레임이 우리 코드일 때만(핸들러·래퍼·조각에서 시작한 예외, 핸들러 실행 중에 또
#   눌림이 도착하면 핸들러 프레임이 겹치므로 안쪽 하나만 자르면 샌다) 첫 우리 프레임부터 안쪽 전부를 자르고, 자른
#   자리 바로 바깥에 붙은 `webloop.py` 프레임(`run_until_complete`)도 뗀다. 바깥의 내부 프레임(`runcode` 등)은
#   원본 `formattraceback`이 `<console>` 첫 프레임부터 남긴다. 그 뒤 남은 프레임 중 우리 프레임 개별(`run_sync`
#   래퍼 — `guard`가 나른 예외는 `trim`이 이미 다듬었다)과 그 바로 바깥에 붙은 `webloop.py` 프레임을 뗀다(awaitable
#   안에서 난 `webloop.py` 프레임은 우리 프레임 바깥이 아니라 남는다).
#
# - `extra_own_codes`는 다른 모듈이 심은 우리 코드 객체다(`sleep-slice.py`의 `sleep`·`poll`). 절단 규칙은 같으므로
#   `own_codes`에 합치기만 한다. 설치 순서상 조각 교체가 먼저라 여기서는 이미 만들어진 tuple을 받는다.
#
# 깨우기 세부:
#   - `run_sync` 래퍼(`pyodide.webloop.run_sync`·`pyodide.ffi.run_sync` 교체): 대기 awaitable을 `guard` 코루틴 Task로
#     감싼다. 깨울 때 그 Task를 취소해 취소 처리(`finally` 등)를 끝낸 뒤 `guard`가 `CancelledError`를 정상 값 `WOKEN`으로
#     바꾸고, 래퍼가 사용자 스택(대기 호출 지점)에서 `KeyboardInterrupt`를 올린다. awaitable이 낸 그 밖의 예외
#     (`KeyboardInterrupt`·`SystemExit`·사용자 `CancelledError`·일반 예외)도 `guard`가 홀더 `Raised(exc)`에 담아 정상
#     값으로 끝내고 래퍼가 `raise result.exc`로 그 객체를 사용자 스택에서 올린다(`from None` 없음 — 인자·`__context__`·
#     `__cause__` 보존). `GeneratorExit`만 재raise한다. Task가 예외로 끝나면 pyodide가 Promise 변환(`FutureDoneCallback`
#     → `wrap_exception`)에서 `PyErr_Print()`로 `sys.excepthook`을 부르고, 콘솔 실행 중에는 `sys.stderr`가 콜백
#     스트림이라 그것이 화면에 새기 때문에(TRP-021, 편차 28 해소) 값으로 나른다. 나르기 전 `trim(exc)`으로 트레이스백
#     머리의 우리 프레임(`guard`)을 떼고 첫 우리 프레임(조각·핸들러)부터 안쪽 전부를 잘라 사용자·라이브러리 프레임만
#     남긴다.
#   - `runcode` 래퍼(인스턴스 속성 교체): 실행 중인 콘솔 task를 `active`로 기록한다. top-level await 대기 중에는 그 task를
#     취소하고 표지 예외 `IdleInterrupt`로 끝낸다. 취소로 끝난 task는 `ConsoleFuture`의 done 콜백이 `fut.exception()`에서
#     `CancelledError`를 만나 영영 끝나지 않는다(HANG).
#   - 취소는 await 지점에서 멈춘(`CORO_SUSPENDED`) Task에만 안전하다. 깨울 수 없는 순간(대기 코루틴 실행 중, 재개 직전)에
#     핸들러가 소비한 SIGINT는 `pending`으로 표시해 두었다가 재개하는 `run_sync` 래퍼가 올린다(TRP-021).
#   - 이벤트 루프가 비어 폴링이 아예 일어나지 않는 구간은 JS 감시 타이머가 `interrupt_idle()`을 불러 같은 일을 한다.
#   - 설치 가드 3종에 걸리면 깨우기만 건너뛴다(`active`가 늘 `None`이라 `interrupt_idle()`은 언제나 거짓이고 위 규칙
#     ①②④는 그대로다). 어긋난 이름마다 `report('run-sync', 이름)`을 부른다.
#   - `pyodide.webloop.__file__`이 `pyodide/webloop.py`로 끝나지 않으면 `report('webloop-filename', 경로)`를 부른다: `formattraceback`이
#     `webloop.py` 프레임을 떼는 규칙(`is_webloop`)이 무효가 될 뿐 끌 기능은 없다.
import asyncio
import inspect
import signal

import pyodide.ffi
import pyodide.webloop as webloop


# `formattraceback`이 pyodide webloop 프레임을 알아보는 파일명 끝. `install`이 `webloop.__file__`도 이 값으로 확인한다.
WEBLOOP_FILE_SUFFIX = 'pyodide/webloop.py'

# 깨운 대기가 정상 값으로 끝났다는 표지. 사용자 awaitable이 돌려줄 수 없는 고유한 객체다.
WOKEN = object()


class Raised:
    """guard가 나르는 예외. run_sync 래퍼가 사용자 스택에서 그 객체를 다시 올린다.
    Task 결과(정상 값)로 JS 경계를 넘으므로 pyodide가 excepthook으로 트레이스백을 찍지 않는다."""

    __slots__ = ('exc',)

    def __init__(self, exc):
        self.exc = exc


class IdleInterrupt(Exception):
    """정지한 콘솔 task를 취소해 중단했다는 표지. formattraceback이 KeyboardInterrupt 한 줄로 바꾼다.
    KeyboardInterrupt를 쓰지 않는 것은 Task가 KeyboardInterrupt로 끝나면 webloop가 다시 던지기 때문이다."""


def find_problems(console):
    """정지한 실행 깨우기가 기대하는 고정 버전(`PYODIDE_VERSION`) pyodide 내부 형태와 다른 지점의 이름들. 비어 있으면 설치할 수 있다."""
    problems = []
    if not callable(getattr(webloop, 'run_sync', None)):
        problems.append('pyodide.webloop.run_sync')
    if not callable(getattr(pyodide.ffi, 'run_sync', None)):
        problems.append('pyodide.ffi.run_sync')
    if not inspect.iscoroutinefunction(getattr(console, 'runcode', None)):
        problems.append('console.runcode')
    return problems


def install(console, ack, seq, report, extra_own_codes=()):
    user_filename = console.filename
    # 사용자 코드를 실행 중인 콘솔 task. runcode 래퍼가 들어갈 때 정하고 나올 때 비운다(시간 조건 없이 이것만이 "실행 중"의 정의다).
    active = None
    waiters = set()  # run_sync 래퍼가 기다리는 대기 Task
    woken = set()  # 이미 깨운 대기(중복 취소를 막고, 그 CancelledError가 우리 것임을 표시한다)
    cancelled = set()  # 이미 취소한 콘솔 task(중복 취소 방지)
    # 설치 시점의 번호는 이미 처리한 것으로 본다: 부팅 중(설치 전) 눌림의 재전송이 연결 뒤 시작 코드를 끊으면 안 된다.
    # buffer는 세션마다 새로 만들므로 이전 세션의 번호는 섞이지 않는다(03-ctrl-c.md 2.4 1번).
    last_seq = seq()
    # 깨울 수 없는 순간에 핸들러가 소비한 SIGINT가 있다. 재개하는 run_sync 래퍼가 KeyboardInterrupt로 올리고,
    # runcode 경계에서 지운다.
    pending = False
    # `run_sync` 래퍼가 C `run_sync`(대기 Task를 JS로 바꾸고 JSPI로 기다린다)를 부르는 동안 참이다. 그 구간에서 처리된
    # 눌림을 규칙 ①로 올리지 않기 위한 표시다. 래퍼 코드 객체는 래퍼를 만든 뒤에 정한다(설치 가드에 걸리면 None이다).
    converting = False
    run_sync_code = None

    def wakeable(task):
        # 취소는 await 지점에서 멈춘(CORO_SUSPENDED) Task에만 안전하다. 코루틴이 실행 중(CORO_RUNNING)인 Task를 취소하면
        # `_must_cancel`만 서서 코루틴이 끝나는 순간 Task가 취소로 끝나고, 그 Task를 기다리는 쪽이 끝나지 않는다(HANG).
        # 아직 시작하지 않은(CORO_CREATED) Task를 취소하면 코루틴이 실행되지 않은 채 닫힌다.
        return not task.done() and inspect.getcoroutinestate(task.get_coro()) == inspect.CORO_SUSPENDED

    def interrupt_idle():
        """정지한 사용자 실행을 깨운다. 깨웠으면 True(부른 쪽이 SIGINT를 소비한다), 깨울 것이 없으면 False(SIGINT는 그대로 둔다)."""
        if active is None:
            return False
        woke = False
        for fut in list(waiters):
            # 깨울 수 없는 대기(실행 중, 이미 끝나 재개 직전)는 건너뛴다. 부른 쪽이 JS 감시 타이머면 SIGINT가 버퍼에
            # 남아 재개한 사용자 스택의 폴링이 받는다.
            if fut not in woken and wakeable(fut):
                woken.add(fut)
                fut.cancel()
                woke = True
        if woke:
            return True
        if active not in cancelled and wakeable(active):
            cancelled.add(active)
            active.cancel()
            return True
        return False

    def sigint_handler(signum, frame):
        nonlocal pending, last_seq
        s = seq()
        if s == last_seq:
            return
        last_seq = s
        ack()
        f = frame
        while f is not None:
            if converting and f.f_code is run_sync_code:
                # C 변환 구간: 이 래퍼 프레임보다 안쪽에 사용자 프레임이 없다(있었다면 위에서 이미 올렸다). 바깥의
                # `<console>` 프레임은 보지 않고 규칙 ③으로 넘긴다.
                break
            if f.f_code.co_filename == user_filename:
                signal.default_int_handler(signum, frame)
            f = f.f_back
        # 사용자 프레임이 없다. 실행 중이 아니면 다음 문장 컴파일·트레이스백 생성·시작 코드 중이므로 버린다.
        if active is None:
            return
        if woken:
            # 이미 깨운 대기가 곧 사용자 스택에서 KeyboardInterrupt를 올린다. 이 눌림은 그것에 합친다(같은 raise가
            # pending을 지운다). 미루면 미룬 콜백이 그 전달 뒤에 돌아 KeyboardInterrupt를 한 번 더 만든다.
            pending = True
            return
        # 사용자 코드가 실행 중이면(정지한 대기, await 중) 그 실행을 깨우되 이 자리에서 취소하지 않고 한 틱 미룬다.
        # 핸들러는 asyncio 콜백의 bytecode 사이에서 돈다: 예를 들어 `_set_result_unless_cancelled`의 `cancelled()` 검사와
        # `set_result()` 사이에서 대기 Task를 취소하면 그 sleep future가 취소된 뒤 `set_result`가 InvalidStateError를
        # 내고 WebLoop가 그것을 stderr에 찍는다. WebLoop의 call_soon은 공유 큐 없이 JS에 예약만 해 여기서 불러도 안전하다.
        active.get_loop().call_soon(interrupt_deferred, active)

    def interrupt_deferred(task):
        """핸들러가 미룬 규칙 ③. 그 사이 실행이 끝났거나 바뀌었으면 버린다. 깨울 수 없는 순간이면 재개하는 run_sync
        래퍼가 올리도록 표시한다."""
        nonlocal pending
        if active is not task:
            return
        if not interrupt_idle():
            pending = True

    own_codes = {sigint_handler.__code__, *extra_own_codes}

    webloop_file = getattr(webloop, '__file__', None)
    if not (isinstance(webloop_file, str) and webloop_file.endswith(WEBLOOP_FILE_SUFFIX)):
        # 트레이스백의 webloop 프레임 떼기만 무효가 된다. 끌 기능은 없어 알리기만 한다.
        report('webloop-filename', str(webloop_file))

    problems = find_problems(console)
    if problems:
        # 깨우기 없이 규칙 ①②④만 남는다: active가 None이라 interrupt_idle()은 아무것도 하지 않는다.
        for problem in problems:
            report('run-sync', problem)
    else:
        original_run_sync = webloop.run_sync
        original_runcode = console.runcode

        def trim(exc):
            """나르는 예외의 트레이스백을 사용자 쪽 프레임까지만 남긴다: 머리의 우리 프레임(guard)을 떼고, 첫 우리
            프레임(sleep·poll·핸들러)부터 안쪽 전부를 자른다. 그 안쪽에는 JS 가짜 프레임(pyodide.asm.mjs·wasm://)도 있다."""
            tb = exc.__traceback__
            while tb is not None and tb.tb_frame.f_code in own_codes:
                tb = tb.tb_next
            prev = None
            entry = tb
            while entry is not None:
                if entry.tb_frame.f_code in own_codes:
                    if prev is None:
                        tb = None
                    else:
                        prev.tb_next = None
                    break
                prev = entry
                entry = entry.tb_next
            return exc.with_traceback(tb)

        async def guard(awaitable):
            try:
                return await awaitable
            except asyncio.CancelledError as exc:
                # 우리가 깨운 취소는 정상 값으로 끝낸다. 취소는 awaitable 안으로 전달돼 finally 등의 취소 처리가 끝난
                # 뒤에야 여기에 도착한다. 사용자 코드가 낸 CancelledError는 다른 예외와 같이 나른다.
                if asyncio.current_task() in woken:
                    return WOKEN
                return Raised(trim(exc))
            except GeneratorExit:
                # 코루틴 close()의 신호다. 값으로 바꾸면 RuntimeError("coroutine ignored GeneratorExit")가 된다.
                raise
            except BaseException as exc:
                # KeyboardInterrupt(조각 폴링·바쁜 루프의 핸들러가 코루틴 프레임에서 올린 것, 사용자가 직접 올린 것)·
                # SystemExit·일반 예외 전부. 예외로 끝난 Task는 pyodide가 Promise로 바꾸며 sys.excepthook으로 한 번 더
                # 찍고 콘솔 실행 중에는 그것이 화면에 새므로(TRP-021) 값으로 나른다.
                return Raised(trim(exc))

        def run_sync(awaitable):
            nonlocal pending, converting
            coro = guard(awaitable)
            try:
                fut = asyncio.ensure_future(coro)
            except BaseException:
                # ensure_future 안에서 눌림이 처리돼 규칙 ①의 KeyboardInterrupt가 났다. Task를 만들기 전이면 guard와 시작 전
                # awaitable 코루틴을 닫아 둔다: 버려지면 GC가 `coroutine ... was never awaited` 경고를 트레이스백 앞에
                # 찍는다. Task를 만든 뒤면 그 Task가 guard를 돌리므로 닫지 않는다(닫으면 Task가 닫힌 코루틴을 재개하다
                # `RuntimeError: cannot reuse already awaited coroutine`을 낸다).
                if not any(task.get_coro() is coro for task in asyncio.all_tasks(asyncio.get_event_loop())):
                    coro.close()
                    if inspect.iscoroutine(awaitable) and inspect.getcoroutinestate(awaitable) == inspect.CORO_CREATED:
                        awaitable.close()
                raise
            waiters.add(fut)
            converting = True
            try:
                result = original_run_sync(fut)
            finally:
                converting = False
                waiters.discard(fut)
                woken.discard(fut)
            if isinstance(result, Raised):
                # awaitable이 낸 예외를 그 객체 그대로 올린다(from None 없음 — __context__·__cause__ 보존). pending은
                # 건드리지 않는다: 예외로 끝난 실행의 표시는 runcode 경계가 지운다.
                raise result.exc
            if result is WOKEN or pending:
                # 깨운 대기와 깨울 수 없는 순간에 소비된 SIGINT는 사용자 스택(대기 호출 지점)에서 KeyboardInterrupt로 올린다.
                pending = False
                raise KeyboardInterrupt from None
            return result

        async def runcode(source, code):
            nonlocal active, pending
            task = asyncio.current_task()
            active = task
            pending = False
            try:
                return await original_runcode(source, code)
            except asyncio.CancelledError:
                if task in cancelled:
                    # 우리가 취소한 것이면 표지 예외로 끝낸다. 취소로 끝난 task는 ConsoleFuture가 fut.exception()에서
                    # CancelledError를 만나 끝나지 않는다.
                    raise IdleInterrupt from None
                raise
            finally:
                cancelled.discard(task)
                active = None
                pending = False

        # webloop의 run_until_complete는 모듈 전역 run_sync를 부르고, 사용자는 `from pyodide.ffi import run_sync`로
        # 가져간다. 사용자 코드는 worker 시작 뒤에 실행되므로 지금 교체하면 두 경로 모두 래퍼를 가리킨다.
        webloop.run_sync = run_sync
        pyodide.ffi.run_sync = run_sync
        console.runcode = runcode
        run_sync_code = run_sync.__code__
        own_codes.add(run_sync_code)
        own_codes.add(guard.__code__)

    format_traceback = console.formattraceback

    def formattraceback(exc):
        if isinstance(exc, IdleInterrupt):
            return 'KeyboardInterrupt\n'
        entries = []
        tb = exc.__traceback__
        while tb is not None:
            entries.append(tb)
            tb = tb.tb_next
        ours = lambda entry: entry.tb_frame.f_code in own_codes
        is_webloop = lambda entry: entry.tb_frame.f_code.co_filename.endswith(WEBLOOP_FILE_SUFFIX)
        if entries and ours(entries[-1]):
            # 예외가 우리 코드에서 시작했다(핸들러·래퍼·조각): 첫 우리 프레임부터 안쪽 전부를 자른다. 그 안쪽은 우리가
            # 부른 라이브러리·JS 가짜 프레임·핸들러다(연타면 핸들러 프레임이 겹친다). 나른 예외(guard가 다듬은 것)는
            # 안쪽 끝이 사용자·라이브러리 프레임이라 여기에 걸리지 않는다.
            cut_at = next(i for i, entry in enumerate(entries) if ours(entry))
            entries = entries[:cut_at]
            # 자른 자리 바로 바깥에 붙은 pyodide webloop 프레임(run_until_complete)도 뗀다(지금 규칙 그대로).
            while entries and is_webloop(entries[-1]):
                entries.pop()
        kept = []
        for entry in entries:
            if ours(entry):
                # 우리 프레임(run_sync 래퍼)과 그 바로 바깥에 붙은 pyodide webloop 프레임(_run·run_until_complete)을
                # 뗀다. awaitable 안에서 난 webloop.py 프레임(call_later 등)은 우리 프레임 바깥이 아니라 남는다.
                while kept and is_webloop(kept[-1]):
                    kept.pop()
                continue
            kept.append(entry)
        if kept:
            for outer, inner in zip(kept, kept[1:]):
                outer.tb_next = inner
            kept[-1].tb_next = None
        return format_traceback(exc)

    console.formattraceback = formattraceback
    signal.signal(signal.SIGINT, sigint_handler)
    return interrupt_idle
