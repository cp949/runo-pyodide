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
    # with_mc=True면 훅이 log 항목에 mc(ModuleCompleter 원시 결과)를 함께 기록한다(rd-016 재생성용)
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
    out = []
    if os.path.exists(s.log):
        for ln in open(s.log):
            ln = ln.strip()
            if ln:
                out.append(json.loads(ln))
    return out

def sh(s, label, quiet=False):
    rows = s.lines()
    print(f"--- {label} ---")
    for i, ln in enumerate(rows):
        print(f"{i:2d}|{ln}|")
    print(f"cursor(row={s.screen.cursor.y}, col={s.screen.cursor.x})")

# ---- 실행기 공용 CLI 헬퍼(runcases*.py가 DELTA-02·03에서 사용) ----

def add_out_arg(parser, default=None):
    """--out <path>: 결과 JSON 출력 경로. 기준 데이터 파일명과 실행기 기본 출력명이 어긋나는 경우를 흡수한다."""
    parser.add_argument(
        "--out", default=default,
        help="결과 JSON 출력 경로(기본: %s)" % (default if default else "실행기가 정한 이름"),
    )

def add_with_mc_arg(parser):
    """--with-mc: 훅이 log 항목에 mc 필드를 기록하게 한다(기본 꺼짐. rd-016 재생성에서만 켠다)."""
    parser.add_argument("--with-mc", action="store_true", help="훅 log 항목에 mc 필드 기록(PTY_HOOK_MC=1)")

def resolve_out(out, default):
    """--out 값(없으면 default)을 절대경로로 바꾸고 상위 폴더를 만든다."""
    path = os.path.abspath(out or default)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path
