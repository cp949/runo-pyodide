import builtins, traceback
from pyodide.ffi import to_js

# ConsoleFuture를 JS에서 직접 await하지 않는다(TRAP-02, worker/console.ts가 이 함수로만 await한다).
# 결과는 [echo, exited, error] 세 값이다(None은 JS의 undefined). SystemExit은 [None, True, None]으로
# 돌려 exit()/quit()를 구분한다. echo가 거짓이면(분할 재생의 마지막 아닌 문장) repr()·builtins._ 갱신을
# 건너뛰고 [None, exited, None]만 돌려준다(RD-011 확정 15, 에코하지 않은 문장은 `_`를 건드리지 않는다).
# echo가 참이고 값이 None이 아니면 repr() 전체를 echo로 만들고 성공한 뒤에만 builtins._를 갱신한다.
# repr가 예외를 내면 error에 트레이스백을 담고 _는 건드리지 않는다(echo일 때만 해당).
async def await_fut(fut, echo=True):
    try:
        res = await fut
    except SystemExit:
        return to_js([None, True, None], depth=1)
    if not echo or res is None:
        return to_js([None, False, None], depth=1)
    try:
        text = repr(res)
    except Exception as e:
        # 첫 프레임(이 함수)을 떼고 __repr__ 프레임부터 남긴다.
        tb = "".join(traceback.format_exception(type(e), e, e.__traceback__.tb_next))
        return to_js([None, False, tb], depth=1)
    builtins._ = res
    return to_js([text, False, None], depth=1)

# pyrepl처럼 끝 개행을 붙여(없으면 캐럿 줄이 사라진다) codeop의 최종 컴파일과 같은 플래그로 재컴파일해
# 표준 문구의 문법 오류를 만든다.
def format_syntax_error(source, flags):
    try:
        compile(source + "\n", "<console>", "single", flags, True)
    except SyntaxError as e:
        return "".join(traceback.format_exception_only(type(e), e))
    return None

# pyodide가 EOF에서 끊긴 입력(`1 +`)을 어떤 문구로 표시하는지 시작 시 한 번 확인한다(RD-021 `incomplete-input-message` 탐지).
# 실제 콘솔이 아니라 빈 globals의 독립 `PyodideConsole`에 push해서 실제 콘솔의 buffer·builtins._·전역을 건드리지 않는다.
# 같은 클래스라 같은 컴파일·`formatsyntaxerror` 경로다. 문법 오류가 아니면(문구를 판정할 수 없으면) None.
# `formatsyntaxerror`는 `sys.last_exc`·`last_type`·`last_value`·`last_traceback`을 설정한다. 그대로 두면 새 세션의
# `sys.last_value`·`pdb.pm()`에 탐지용 오류가 보이므로 호출 전 상태(없었으면 없음)로 되돌린다.
_LAST_EXC_NAMES = ("last_exc", "last_type", "last_value", "last_traceback")

def incomplete_input_message():
    import sys
    from pyodide.console import PyodideConsole
    saved = {name: getattr(sys, name) for name in _LAST_EXC_NAMES if hasattr(sys, name)}
    try:
        probe = PyodideConsole({})
        fut = probe.push("1 +")
        try:
            if fut.syntax_check != "syntax-error":
                return None
            return fut.formatted_error
        finally:
            # 사이클 GC 때 "exception was never retrieved"가 sys.stderr로 새지 않게 회수한다.
            if fut.done():
                fut.exception()
    finally:
        for name in _LAST_EXC_NAMES:
            if name in saved:
                setattr(sys, name, saved[name])
            elif hasattr(sys, name):
                delattr(sys, name)

# await하지 않는 문법 오류 future의 예외를 회수한다. 그대로 두면 사이클 GC 때 asyncio가
# "ConsoleFuture exception was never retrieved"를 sys.stderr로 내 터미널에 끼어든다
# (JS에서 부르면 예외 proxy를 destroy해야 해 Python에 둔다).
def retrieve_exception(fut):
    fut.exception()
