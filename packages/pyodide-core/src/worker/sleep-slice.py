# time.sleep을 20ms 블로킹 조각의 반복으로 바꿔 sleep 도중의 Ctrl+C가 사용자 코드를 끊게 한다(03-ctrl-c.md 2.4).
#
# pyodide는 time.sleep을 webloop의 _sleep으로 바꿔 둔다: JSPI가 있으면 run_sync(asyncio.sleep(t)), 없으면 원본 블로킹 sleep이다.
# 그대로 두면 두 경로 모두 문제가 있다. JSPI 경로는 사용자 스택이 정지해 SIGINT 폴링이 사용자 프레임 없는 콜백에서 일어나므로
# 핸들러가 그 눌림을 버리고(03-ctrl-c.md 2.4의 ④), sleep 중에 이벤트 루프가 다른 콜백을 돌려 CPython과 의미가 다르며, 무효 인자의
# 예외 문구도 asyncio의 것이 나온다. 블로킹 경로는 아예 폴링이 일어나지 않아 time.sleep(5)를 끝까지 못 끊는다.
#
# 그래서 원본 C 함수(time.sleep.__wrapped__ — pyodide가 @wraps로 남긴 것)를 SLEEP_SLICE 조각으로 나눠 부르고 조각마다
# pyodide_js.checkInterrupt()로 폴링을 강제한다. 사용자 스택이 정지하지 않으므로 핸들러가 조각 안의 사용자 프레임(time.sleep
# 호출 지점)에서 KeyboardInterrupt를 올린다. 블로킹 조각 동안에는 이벤트 루프가 멈춰 감시 타이머가 돌지 못하고 조각 폴링이 대신한다.
import functools
import inspect
import operator
import sys
import time

import pyodide_js

# time.sleep 한 조각의 길이(초). 조각마다 인터럽트를 확인하므로 눌림에서 중단까지 지연의 상한이 이 값이다.
SLEEP_SLICE = 0.02
# 이 값(초) 이상은 조각하지 않고 원본에 넘긴다(폴링도 없다). 원본 C 함수는 시간을 int64 나노초로 표현해 약 9.223e9초부터
# OverflowError를 낸다. 그보다 조금 낮게 두어 원본이 받아들이는 값은 거의 모두 조각해 끊고, 넘는 값은 원본이 CPython과 같은
# OverflowError를 내게 한다.
SLEEP_MAX = 9.2e9


def silent_excepthook(exc_type, exc, tb):
    """pyodide가 Python 예외를 JS로 바꿀 때 PyErr_Print()으로 부르는 sys.excepthook 자리에 임시로 두는 훅.
    pyodide_js.checkInterrupt()가 올리는 KeyboardInterrupt는 핸들러 프레임만 든 트레이스백이 sys.stderr(=runcode
    중에는 터미널)에 한 번 더 찍히는데, 화면의 트레이스백은 콘솔의 formattraceback이 한 번 만들므로 여기서는 아무것도
    출력하지 않는다."""


def find_problems():
    """조각 교체가 기대하는 고정 버전(`PYODIDE_VERSION`) pyodide 형태와 다른 지점의 이름들. 비어 있으면 교체할 수 있다."""
    problems = []
    # pyodide(webloop.py)는 time.sleep을 원본 C 함수를 @wraps로 감싼 _sleep으로 바꿔 두고, 조각 래퍼가 그 __wrapped__를 부른다.
    if not inspect.isbuiltin(getattr(time.sleep, '__wrapped__', None)):
        problems.append('time.sleep.__wrapped__')
    if not callable(getattr(pyodide_js, 'checkInterrupt', None)):
        problems.append('pyodide_js.checkInterrupt')
    return problems


def install(report):
    """time.sleep을 조각 래퍼로 바꾸고 (sleep.__code__, poll.__code__)를 돌려준다. 호출자가 이 tuple을
    installSigintHandler의 extra_own_codes로 넘겨 트레이스백에서 우리 프레임이 잘리게 한다. 가드에 걸리면
    어긋난 이름마다 report('sleep-slice', 이름)을 부르고 None(교체하지 않는다)."""
    problems = find_problems()
    if problems:
        # 조각 교체만 건너뛴다. time.sleep은 pyodide 기본으로 남고 SIGINT 핸들러는 그대로 설치된다.
        for problem in problems:
            report('sleep-slice', problem)
        return None

    original_sleep = time.sleep.__wrapped__
    monotonic = time.monotonic
    check_interrupt = pyodide_js.checkInterrupt

    def poll():
        # 폴링 호출 동안만 excepthook을 비운다. 그 창에서 도는 Python은 우리 핸들러뿐이라 사용자가 바꿔 둔 훅과 충돌하지
        # 않고, 사용자가 바꿨더라도 그대로 되돌린다.
        hook = sys.excepthook
        sys.excepthook = silent_excepthook
        try:
            check_interrupt()
        finally:
            sys.excepthook = hook

    # wraps는 __wrapped__에 원본 C 함수를 남긴다. 이미 조각 래퍼가 설치된 pyodide(같은 pyodide에 설치를 반복하는 시험)에서도
    # time.sleep.__wrapped__는 원본 C 함수라 래퍼가 겹쌓이지 않는다.
    @functools.wraps(original_sleep)
    def sleep(*args, **kwargs):
        # 원본 C 함수는 위치 인자 하나만 받는다. 개수·키워드 오류는 원본에 넘겨 예외 문구를 CPython과 같게 둔다.
        if kwargs or len(args) != 1:
            return original_sleep(*args, **kwargs)
        requested = args[0]
        secs = requested
        # 유한 양수 int/float(bool 제외)와 __index__ 객체(numpy 정수 등, 원본이 정수로 받는다)만 다룬다. 그 밖(0, 음수,
        # NaN, inf, bool, 다른 타입)은 원본에 넘겨 예외 종류와 메시지를 CPython과 같게 둔다.
        if isinstance(secs, bool):
            return original_sleep(requested)
        if not isinstance(secs, (int, float)):
            try:
                secs = operator.index(secs)
            except TypeError:
                secs = None
            if secs is None:
                # except 블록 밖에서 넘긴다: 안에서 원본이 예외를 내면 "During handling of the above exception"으로
                # 연쇄돼 화면에 추가 트레이스백이 붙는다.
                return original_sleep(requested)
        if not (0 < secs < SLEEP_MAX):
            return original_sleep(requested)
        if secs <= SLEEP_SLICE:
            # 한 조각 이하: 원본이 자고 나서 폴링을 한 번 한다. 폴링이 없으면 눌림 확인을 pyodide 틱에 맡겨
            # (반복 1회 시간)×13까지 늦는다.
            original_sleep(secs)
            poll()
            return None
        end = monotonic() + secs
        while True:
            remain = end - monotonic()
            if remain <= 0:
                return None
            original_sleep(min(SLEEP_SLICE, remain))
            poll()

    time.sleep = sleep
    return (sleep.__code__, poll.__code__)
