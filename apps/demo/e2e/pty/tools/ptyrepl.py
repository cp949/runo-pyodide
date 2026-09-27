"""CPython _pyrepl을 pty로 구동하고 pyte로 화면을 렌더링하는 하니스(측정용).

실행 전제
- 하니스(이 파일을 실행하는 파이썬)에는 requirements.txt(pyte==0.8.2, wcwidth==0.8.4)를 설치한다.
  단 **대상 인터프리터(자식 REPL이 뜨는 쪽)에는 설치하지 않는다.** 자식의 sys.path/site-packages가 바뀌면
  ModuleCompleter 후보 집합이 달라져 기준 데이터와 어긋난다(TRAP-27). 그래서 하니스는 venv에서 돌리고,
  대상 인터프리터는 아래 3단으로 따로 지정한다. venv 인터프리터를 대상으로 지정하면 중단한다.
- 대상 인터프리터 해석 순서: (1) --python <path> (2) 환경변수 PTY_PYTHON (3) PATH의 python3.14
- 시작 시 대상 인터프리터의 sys.version을 읽어 기대 버전(EXPECTED_VERSION)과 다르면 중단한다.
  --allow-version-mismatch가 있을 때만 경고 후 진행한다.
- 직접 실행하면 셀프테스트를 돈다: python ptyrepl.py [--python P] [--allow-version-mismatch] [--check-only]
"""
import argparse
import fcntl
import json
import os
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from dataclasses import dataclass

try:
    import pyte
except ImportError:  # 게이트 단계(인터프리터 해석·버전 확인)는 pyte 없이도 돈다
    pyte = None

EXPECTED_VERSION = "3.14.4"
ENV_PYTHON = "PTY_PYTHON"
WHICH_NAME = "python3.14"

LEFT = b"\x1bOD"   # TERM=xterm의 kcub1
RIGHT = b"\x1bOC"  # kcuf1
UP = b"\x1bOA"
DOWN = b"\x1bOB"
TAB = b"\t"
ENTER = b"\r"
# Shift+Enter: xterm-readline에서는 \x1b[13;2u 류일 수 있으나 _pyrepl에서는 paste 또는 개행 삽입 키가 없다.
# 여러 줄 버퍼는 bracketed paste(\x1b[200~ ... \x1b[201~)로 만든다.
PASTE_BEGIN = b"\x1b[200~"
PASTE_END = b"\x1b[201~"


class InterpreterError(RuntimeError):
    """대상 인터프리터를 해석하지 못했거나 게이트를 통과하지 못했다."""


@dataclass
class Interpreter:
    path: str      # 자식 REPL을 띄울 실행 파일 경로(realpath 처리하지 않는다: venv 판별이 경로에 의존한다)
    source: str    # 어느 단계에서 정해졌는가: "--python" | "PTY_PYTHON" | "PATH"
    version: str   # 대상의 sys.version 전체 문자열(산출물 메타에 기록용)
    release: str   # "3.14.4" 형태
    mismatch: bool # release != EXPECTED_VERSION (--allow-version-mismatch로 통과한 경우 True)


_ORDER_HELP = (
    "대상 인터프리터 해석 순서:\n"
    "  1. --python <path>\n"
    f"  2. 환경변수 {ENV_PYTHON}\n"
    f"  3. PATH의 {WHICH_NAME}(shutil.which)\n"
    "홈 절대경로 기본값은 없다."
)

_current = None  # setup()이 확정한 인터프리터(프로세스당 하나)


def resolve_python(cli=None):
    """(경로, 출처)를 돌려준다. 실행 가능하지 않으면 해석 순서를 담아 InterpreterError."""
    if cli:
        cand, source = cli, "--python"
    elif os.environ.get(ENV_PYTHON):
        cand, source = os.environ[ENV_PYTHON], ENV_PYTHON
    else:
        cand, source = shutil.which(WHICH_NAME), "PATH"
    if not cand:
        raise InterpreterError(f"대상 인터프리터를 찾지 못했다: PATH에 {WHICH_NAME} 없음.\n{_ORDER_HELP}")
    cand = os.path.abspath(cand)
    if not (os.path.isfile(cand) and os.access(cand, os.X_OK)):
        raise InterpreterError(f"대상 인터프리터가 실행 파일이 아니다({source}): {cand}\n{_ORDER_HELP}")
    return cand, source


# 대상 인터프리터에서 한 번 실행해 버전·환경을 읽는다. -I는 PYTHON* 환경변수·사용자 site를 무시한다.
_PROBE_CODE = (
    "import sys, json, importlib.util as u\n"
    "print(json.dumps({'version': sys.version,"
    " 'release': '%d.%d.%d' % sys.version_info[:3],"
    " 'venv': sys.prefix != sys.base_prefix,"
    " 'prefix': sys.prefix,"
    " 'polluted': [m for m in ('pyte', 'wcwidth') if u.find_spec(m)]}))\n"
)


def setup(python=None, allow_version_mismatch=False):
    """대상 인터프리터를 해석하고 게이트(버전·환경)를 통과시킨 뒤 확정한다. 자식 REPL은 띄우지 않는다."""
    global _current
    path, source = resolve_python(python)
    try:
        cp = subprocess.run([path, "-I", "-c", _PROBE_CODE], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise InterpreterError(f"대상 인터프리터 실행 실패({source}): {path}: {e!r}\n{_ORDER_HELP}")
    if cp.returncode != 0:
        raise InterpreterError(f"대상 인터프리터가 sys.version 조회에 실패했다({source}): {path}\n{cp.stderr.strip()}")
    info = json.loads(cp.stdout)
    # venv나 pyte·wcwidth 설치 환경이면 자식의 모듈 후보 집합이 오염된다(TRAP-27). 버전 불일치와 달리 우회 옵션이 없다.
    if info["venv"]:
        raise InterpreterError(
            f"대상 인터프리터가 venv다({source}): {path} (prefix={info['prefix']}).\n"
            "하니스만 venv에서 돌리고, 대상은 venv 밖 인터프리터를 --python 또는 "
            f"{ENV_PYTHON}으로 지정한다. venv를 활성화한 채 PATH 해석에 맡기지 않는다."
        )
    if info["polluted"]:
        raise InterpreterError(
            f"대상 인터프리터에 {', '.join(info['polluted'])}가 설치돼 있다({source}): {path}.\n"
            "자식 REPL의 sys.path 후보 집합이 기준 데이터와 달라진다. 대상에서 제거하고 하니스 venv에만 설치한다."
        )
    mismatch = info["release"] != EXPECTED_VERSION
    if mismatch:
        if not allow_version_mismatch:
            raise InterpreterError(
                f"대상 인터프리터 버전 불일치({source}): {path}\n"
                f"  기대 {EXPECTED_VERSION}, 실제 {info['release']} ({info['version']})\n"
                "  다른 버전으로 진행하려면 --allow-version-mismatch를 붙인다."
            )
        print(
            f"경고: 버전 불일치({info['release']} != {EXPECTED_VERSION}) — --allow-version-mismatch로 진행: {path}",
            file=sys.stderr,
        )
    _current = Interpreter(path, source, info["version"], info["release"], mismatch)
    return _current


def get_interpreter():
    """확정된 인터프리터. setup()이 안 불렸으면 환경변수·PATH로 해석하고 엄격한 게이트를 건다."""
    return _current or setup()


def add_interpreter_args(parser):
    """실행기 공용 인터프리터 인자(--python, --allow-version-mismatch)."""
    parser.add_argument(
        "--python", default=None,
        help=f"대상 인터프리터 경로. 없으면 환경변수 {ENV_PYTHON}, 그것도 없으면 PATH의 {WHICH_NAME}",
    )
    parser.add_argument(
        "--allow-version-mismatch", action="store_true",
        help=f"대상 버전이 {EXPECTED_VERSION}이 아니어도 경고만 하고 진행한다",
    )


def setup_from_args(args):
    """파싱된 인자로 setup()을 부르고, 실패하면 메시지를 stderr에 내고 종료 코드 2로 끝낸다."""
    try:
        return setup(args.python, args.allow_version_mismatch)
    except InterpreterError as e:
        print(f"오류: {e}", file=sys.stderr)
        sys.exit(2)


class Session:
    def __init__(self, rows=24, cols=80, term="xterm", extra_env=None, args=("-q",), cwd=None, with_mc=False):
        if pyte is None:
            raise RuntimeError("pyte를 import할 수 없다. 하니스 venv에서 `pip install -r requirements.txt`를 실행한다.")
        interp = get_interpreter()
        self.python = interp.path
        self.python_version = interp.version  # 산출물 메타에 기록할 대상 sys.version
        self.rows, self.cols = rows, cols
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.raw = b""
        self._reaped = False
        hist = tempfile.NamedTemporaryFile(delete=False, suffix=".hist")
        hist.close()
        env = {
            "TERM": term,
            "PATH": os.environ["PATH"],
            "HOME": tempfile.mkdtemp(),
            "PYTHON_HISTORY": hist.name,
            "PYTHON_COLORS": "0",
            "NO_COLOR": "1",
            "LANG": "C.UTF-8",
        }
        if with_mc:
            env["PTY_HOOK_MC"] = "1"  # hook_startup.py가 log 항목에 mc 필드를 기록한다
        if extra_env:
            env.update(extra_env)
        # 재현성: 자식 REPL의 cwd는 빈 임시 폴더로 고정한다. sys.path[0]==''이라 ModuleCompleter가
        # cwd의 .py 파일·패키지를 모듈 후보로 나열한다(하니스 폴더에서 돌리면 import 빈 스템이 192 -> 196개가 된다).
        self.cwd = cwd or tempfile.mkdtemp()
        py = self.python
        pid, fd = pty.fork()
        if pid == 0:
            try:
                os.chdir(self.cwd)
                # TRP-015: 백그라운드 실행 대비 SIGINT를 기본값으로 되돌린다
                signal.signal(signal.SIGINT, signal.SIG_DFL)
                os.execve(py, [py, *args], env)
            finally:
                os._exit(127)  # execve 실패 시 자식이 하니스 코드를 계속 실행하지 않게 한다
        self.pid, self.fd = pid, fd
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.kill(pid, signal.SIGWINCH)
        self.settle(1.5)

    def _drain(self, timeout):
        got = False
        while True:
            r, _, _ = select.select([self.fd], [], [], timeout)
            if not r:
                return got
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                return got
            if not data:
                return got
            got = True
            self.raw += data
            self.stream.feed(data)

    def settle(self, quiet=0.4, maxwait=6.0):
        end = time.time() + maxwait
        while time.time() < end:
            if not self._drain(quiet):
                return

    def send(self, data, quiet=0.4):
        if isinstance(data, str):
            data = data.encode()
        os.write(self.fd, data)
        self.settle(quiet)

    def type(self, text, quiet=0.15):
        """글자를 한 번에 보낸다(_pyrepl은 bracketed paste 시퀀스가 없으면 각 키를 개별 처리한다)."""
        self.send(text.encode(), quiet=quiet)

    def lines(self, keep_blank_tail=False):
        out = [ln.rstrip() for ln in self.screen.display]
        if not keep_blank_tail:
            while out and out[-1] == "":
                out.pop()
        return out

    def show(self, title="", cursor=True):
        ls = self.lines()
        print(f"--- {title} ---")
        for i, ln in enumerate(ls):
            print(f"{i:2d}|{ln}")
        if cursor:
            print(f"cursor(row={self.screen.cursor.y}, col={self.screen.cursor.x})")

    def clear_line(self):
        # Ctrl+A, Ctrl+K: 줄 처음으로 가서 줄 끝까지 지운다(_pyrepl kill-line)
        self.send(b"\x01\x0b", 0.2)

    def wait_exit(self, timeout=5.0):
        """자식이 스스로 끝나기를 기다려 종료 코드를 돌려준다(시간 초과·신호 종료는 None)."""
        end = time.time() + timeout
        while time.time() < end:
            self._drain(0.1)
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self._reaped = True
                return os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else None
        return None

    def close(self):
        if not self._reaped:
            try:
                os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(self.pid, 0)
            except ChildProcessError:
                pass
            self._reaped = True
        try:
            os.close(self.fd)
        except OSError:
            pass


def probe():
    s = Session()
    s.show("boot")
    s.close()


def selftest():
    """프롬프트 확인 -> os.getc + Tab -> os.getcwd 행 확인 -> Ctrl+D 종료 코드 0. 통과하면 True."""
    s = Session()
    print(f"대상: {s.python}\n버전: {s.python_version}")
    s.show("boot")
    ok_prompt = any(ln.startswith(">>>") for ln in s.lines())  # lines()가 rstrip하므로 '>>> '는 '>>>'로 보인다
    s.send(b"import os\r", 0.25)
    s.type("os.getc")
    s.send(TAB, 0.4)
    s.show("os.getc + Tab")
    ok_tab = any("os.getcwd" in ln for ln in s.lines())
    s.clear_line()
    s.send(b"\x04", 0.2)  # Ctrl+D: 빈 줄에서 REPL 종료
    code = s.wait_exit()
    s.close()
    print(f"프롬프트 '>>>': {ok_prompt}")
    print(f"Tab 뒤 os.getcwd 행: {ok_tab}")
    print(f"자식 종료 코드: {code}")
    return ok_prompt and ok_tab and code == 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="pty 하니스 셀프테스트")
    add_interpreter_args(ap)
    ap.add_argument("--check-only", action="store_true", help="인터프리터 해석·게이트만 확인하고 pty를 띄우지 않는다")
    args = ap.parse_args(argv)
    interp = setup_from_args(args)
    print(f"인터프리터({interp.source}): {interp.path}")
    print(f"버전: {interp.version} (기대 {EXPECTED_VERSION}, 불일치={interp.mismatch})")
    if args.check_only:
        return 0
    ok = selftest()
    print("셀프테스트:", "통과" if ok else "실패")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
