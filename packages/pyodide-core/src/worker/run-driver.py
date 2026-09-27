# 실행 driver의 Python 쪽(RD-022). 코드 한 덩어리를 `exec` 모드로 실행하고 결말을 분류한다. 두 함수로 나뉜다:
# `exec_in_console`(컴파일 + `console.runcode` + 분류, runner와 REPL `runSource`가 공용. `SystemExit` 결말에서 닫힌 stdin
# 되살림도 여기서 한다, 14-runner.md 14.2.2)과 `run_code`(runner 전용: 새 stdin·새 globals를 만든 뒤 `exec_in_console`을 부른다).
# REPL의 `ConsoleFuture`·`runsource` 경로를 거치지 않는다: `CodeRunner`를 직접 만들어 `console.runcode(source, runner)`를 부른다.
# `sigint-handler.py`가 인스턴스 속성으로 바꿔 둔 `console.runcode` 래퍼(`active` task 기록)와 `console.formattraceback`(우리 프레임
# 절단·`IdleInterrupt` → `KeyboardInterrupt` 한 줄)를 그대로 재사용한다.
#
# 결과는 `[kind, error_type, traceback, code]` 리스트다(None은 JS `undefined`). kind는 ok / error / interrupted / exit.
# 트레이스백과 `SystemExit` 메시지는 stderr에도 쓴다(결과와 양쪽).
import ast
import builtins
import io
import sys
import traceback

from pyodide.code import CodeRunner
from pyodide.ffi import to_js


def _new_globals(filename):
    """CPython이 스크립트를 실행할 때의 `__main__` 이름공간. `__loader__`는 넣지 않는다."""
    return {
        "__name__": "__main__",
        "__doc__": None,
        "__file__": filename,
        "__builtins__": builtins,
        "__spec__": None,
    }


def _is_interrupt(exc):
    # `IdleInterrupt`는 정지한 콘솔 task를 깨울 때 `sigint-handler.py`가 올리는 표지 예외다(KeyboardInterrupt의 하위 클래스가
    # 아니다: Task가 KeyboardInterrupt로 끝나면 WebLoop가 다시 던진다). 공개 이름이 없어 클래스 이름으로 알아본다.
    # 판정을 `sigint-handler.py`에서 받아 오지 않는다: 두 파일은 별도 namespace라 import 경로가 없고, TS 전달·모듈 등록은
    # 이 결합 하나보다 비싸다(arch-review 04 후보 5 기각, `docs/traps/TRP-040`).
    return isinstance(exc, KeyboardInterrupt) or type(exc).__name__ == "IdleInterrupt"


def _error_type(exc):
    """결과의 `errorType`. `SyntaxError`의 하위 클래스(`IndentationError`·`TabError`)는 `"SyntaxError"`로 통일한다(구체 이름은
    트레이스백 텍스트에 남는다). 컴파일 단계와 실행 중(`exec("if x:")` 등) 어느 쪽에서 나든 같다."""
    return "SyntaxError" if issubclass(type(exc), SyntaxError) else type(exc).__name__


def _safe_str(value):
    """`str(value)`. 사용자 객체의 `__str__`이 던지면 종료 처리가 망가지지 않게 클래스 이름으로 대신한다."""
    try:
        return str(value)
    except Exception:
        return f"<{type(value).__name__} 객체를 문자열로 바꿀 수 없다>"


# pyodide가 `int`를 JS `number`로 바꾸는 범위 밖(±(2**53 - 1) 이상)은 `BigInt`가 되어 결과 타입 `code: number`와 어긋난다.
# OS가 종료 코드로 받는 것은 C `int`(32비트) 하위 8비트이므로 int32 밖의 값은 `& 0xFF`로 줄인다(범위 안은 그대로 둔다).
_INT32_MIN = -(2**31)
_INT32_MAX = 2**31 - 1


def _exit_status(exc):
    """`SystemExit`의 종료 코드와 stderr에 낼 메시지. CPython 규칙: None -> 0, int -> 그 값, 그 밖 -> 1 + str(code)."""
    code = exc.code
    if code is None:
        return 0, None
    if isinstance(code, int):
        value = int(code)
        if not _INT32_MIN <= value <= _INT32_MAX:
            value &= 0xFF
        return value, None
    return 1, _safe_str(code)


def _open_stdin():
    """원래 pyodide stdin(fd 0, `<stdin>`, 라인 버퍼)과 같은 모양으로 새 `TextIOWrapper`를 만든다. `closefd=False`라 옛 객체가
    정리돼도 fd 0은 열려 있다."""
    raw = io.FileIO(0, "r", closefd=False)
    raw.name = "<stdin>"
    return io.TextIOWrapper(
        io.BufferedReader(raw), encoding="utf-8", errors="strict", line_buffering=True
    )


def _reset_stdin():
    """run마다 `sys.stdin`을 새로 연다. CPython은 스크립트 실행마다 프로세스가 새로라 stdin 버퍼가 이어지지 않는다: 이전 run이
    `sys.stdin.read(3)`으로 줄 일부만 읽었다면 남은 줄이 `TextIOWrapper` 버퍼에 남아 다음 run의 `input()`이 그것을 먼저 읽는다
    (TRP-010). 사용자 코드가 `sys.stdin`을 바꿔 놓은 경우도 되돌린다. `exit()`·`quit()`(site.Quitter)가 stdin을 닫아도 같은
    교체로 복구된다."""
    sys.stdin = _open_stdin()


def _reopen_stdin_if_closed():
    """`SystemExit` 결말에서만 부른다: `sys.stdin`이 닫혀 있거나 없을 때만 `_open_stdin()`으로 다시 연다(`exit()`·`quit()`이
    닫는다, `docs/design/14-runner.md` 14.2.2, `docs/traps/TRP-054`). 사용자가 연 stdin은 건드리지 않는다. 사용자 코드가
    `sys.stdin`을 `closed` 속성이 없는 객체(예: `sys.stdin = 5`)로 바꿔 판정이 안 되면 "닫히지 않음"으로 보고 그대로 둔다
    (여기서 `AttributeError`가 나면 `exit` 결말이 예외로 뒤집힌다)."""
    stdin = sys.stdin
    if stdin is None:
        sys.stdin = _open_stdin()
        return
    try:
        closed = stdin.closed
    except Exception:
        return
    if closed:
        sys.stdin = _open_stdin()


def _write_stderr(text):
    sys.stderr.write(text)
    sys.stderr.flush()


def _result(kind, error_type=None, text=None, code=None):
    return to_js([kind, error_type, text, code], depth=1)


async def exec_in_console(console, source, top_level_await, filename=None):
    """runner와 REPL `runSource`가 함께 쓰는 실행·분류. 컴파일(`CodeRunner`) + `await console.runcode` + 결말 분류 + stderr 쓰기.
    이름공간(`console.globals`)과 열린 `sys.stdin`은 건드리지 않는다: 그 준비는 호출자 몫이다(runner는 `run_code`, REPL은 하지
    않는다). 예외: `SystemExit` 결말에서 닫힌 stdin만 되살린다(`exit()`·`quit()`이 닫는다, `docs/design/14-runner.md` 14.2.2).
    파일명은 `console.filename`이다. `runcode`·SIGINT 규칙 ①이 이 값과 `co_filename`의 일치에 의존하므로(TRP-020) 호출자가 따로 정하지
    않는 것이 기본이고, `filename`은 `run_code`가 자기 인자를 그대로 넘기는 호환 경로다(실제 콘솔에서는 둘이 같다)."""
    if filename is None:
        filename = console.filename
    # `return_mode="none"`: 마지막 식을 값으로 돌려주거나 raise로 바꾸지 않는다. `dedent=False`: 첫 줄 들여쓰기를 없애지 않는다.
    # `dont_inherit=True`: 호출 모듈의 `__future__` 플래그를 사용자 코드가 물려받지 않는 방어다(현재 고정 버전 pyodide의 `_base.py`·
    # `console.py`에는 `__future__`가 없어 지금은 결과가 같다).
    flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT if top_level_await else 0
    try:
        # 구문 분석 오류는 생성자에서, 컴파일 단계 오류(`return` 밖 등)는 `compile()`에서 난다.
        runner = CodeRunner(
            source,
            return_mode="none",
            mode="exec",
            filename=filename,
            flags=flags,
            dont_inherit=True,
            dedent=False,
        ).compile()
    except (SyntaxError, OverflowError, ValueError) as exc:
        text = console.formatsyntaxerror(exc)
        _write_stderr(text)
        return _result("error", _error_type(exc), text)
    except Exception as exc:
        # 컴파일러가 낼 수 있는 그 밖의 오류(너무 깊게 중첩된 식의 `RecursionError`, `MemoryError`). 잡지 않으면 RPC 오류가 되어
        # 사용자 코드의 결과가 아니라 실행 driver 고장처럼 보인다. 프레임이 전부 우리 것이라 예외 줄만 낸다.
        text = "".join(traceback.format_exception_only(type(exc), exc))
        _write_stderr(text)
        return _result("error", type(exc).__name__, text)
    try:
        await console.runcode(source, runner)
    except SystemExit as exc:
        _reopen_stdin_if_closed()
        status, message = _exit_status(exc)
        if message is not None:
            _write_stderr(message + "\n")
        return _result("exit", code=status)
    except BaseException as exc:
        text = console.formattraceback(exc)
        _write_stderr(text)
        if _is_interrupt(exc):
            return _result("interrupted", None, text)
        return _result("error", _error_type(exc), text)
    return _result("ok")


async def run_code(console, source, filename, top_level_await):
    """runner 전용: 새 stdin·새 globals를 만든 뒤 `exec_in_console`로 실행한다."""
    _reset_stdin()
    # 새 globals는 `console.globals` 교체로 만든다(`runcode`가 `self.globals`에서 실행한다). `sys.modules`는 그대로다.
    console.globals = _new_globals(filename)
    return await exec_in_console(console, source, top_level_await, filename)
