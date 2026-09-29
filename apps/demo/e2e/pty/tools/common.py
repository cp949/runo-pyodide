"""runcases*.py가 함께 쓰는 세션 헬퍼와 CLI 인자 헬퍼(RD-015·RD-016 캡처 공용).

- 전제: 하니스 venv에서 import한다(`ptyrepl`이 pyte를 쓴다). 도구 표는 pty/tools/README.md "도구와 입출력".
- `from ptyrepl import *`로 `Session`·키 상수(`TAB`·`PASTE_BEGIN` 등)를 다시 내보낸다.
- 실행기는 `from common import *`만 쓴다.
- `SETUP`: `fresh()`의 기본 준비 5줄. 케이스 파일의 `setup`과 뜻이 같다(따옴표 표기만 다를 수 있다).
- `runcases*.py`는 `fresh()`에 케이스 파일의 `setup`을 넘기므로 `SETUP` 기본값을 쓰지 않는다.
- 자식 REPL 환경은 `ptyrepl.Session`이, 훅은 `hook_startup.py`가 정한다.
"""
import json, os, tempfile
from ptyrepl import *

SETUP = [
    "import os",
    "x = [1, 2]; _x = 1; __y__ = 2",
    "f = lambda a: a",
    'A = type("A", (), {"attr_one": 1, "_priv": 2, "meth": lambda self: 0, "prop": property(lambda self: 1)})',
    "a = A()",
]

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hook_startup.py")

def fresh(setup=SETUP, hook=True, with_mc=False, **kw):
    """새 pty 세션을 띄워 `setup`을 실행하고 Ctrl+L로 화면을 비운다. 세션을 돌려준다.

    - `hook`: 참이면 `PYTHONSTARTUP`에 `hook_startup.py`를 걸어 `get_completions` 호출을 기록한다.
    - `with_mc`: 참이면 훅이 log 항목에 `mc`(ModuleCompleter 원시 결과)를 더한다. rd-016 재생성용이다.
    - `kw`: `Session`에 넘긴다.
    - 부수 효과: 기록 파일을 임시로 만들고 경로를 `s.log`에 둔다. 읽는 쪽은 `log_entries()`다.
    """
    log = tempfile.NamedTemporaryFile(delete=False, suffix=".log").name
    env = {"COMPLOG": log}
    if hook:
        env["PYTHONSTARTUP"] = HOOK
    s = Session(extra_env=env, with_mc=with_mc, **kw)
    s.log = log
    for c in setup:
        s.send(c.encode() + b"\r", 0.25)
    s.send(b"\x0c", 0.2)
    return s

def log_entries(s):
    """`fresh()`가 만든 세션의 훅 기록(`s.log`)을 항목 목록으로 읽는다. 파일이 없으면 빈 목록이다."""
    out = []
    if os.path.exists(s.log):
        for ln in open(s.log):
            ln = ln.strip()
            if ln:
                out.append(json.loads(ln))
    return out

def sh(s, label, quiet=False):
    """현재 화면을 행 번호와 함께 출력하고 커서 위치를 덧붙인다. 탐색용이다. `quiet`는 쓰이지 않는다."""
    rows = s.lines()
    print(f"--- {label} ---")
    for i, ln in enumerate(rows):
        print(f"{i:2d}|{ln}|")
    print(f"cursor(row={s.screen.cursor.y}, col={s.screen.cursor.x})")

# ---- 실행기 공용 CLI 헬퍼(runcases*.py가 사용) ----

def add_out_arg(parser, default=None):
    """`--out <경로>`를 파서에 더한다. 결과 JSON 출력 경로다.

    기준 데이터 파일명과 실행기 기본 출력명이 어긋나는 경우를 흡수한다.
    """
    parser.add_argument(
        "--out", default=default,
        help="결과 JSON 출력 경로(기본: %s)" % (default if default else "실행기가 정한 이름"),
    )

def add_with_mc_arg(parser):
    """`--with-mc`를 파서에 더한다. 훅이 log 항목에 `mc` 필드를 기록하게 한다.

    기본은 꺼짐이다. rd-016 재생성에서만 켠다(`runcases_import.py`는 반대로 `--no-mc`를 쓴다).
    """
    parser.add_argument("--with-mc", action="store_true", help="훅 log 항목에 mc 필드 기록(PTY_HOOK_MC=1)")

def resolve_out(out, default):
    """`out`(없으면 `default`)을 절대경로로 바꾸고 상위 폴더를 만든다. 절대경로를 돌려준다."""
    path = os.path.abspath(out or default)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path
