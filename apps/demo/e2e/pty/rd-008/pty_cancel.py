"""3.14.4 실제 REPL의 취소(Ctrl+C) 화면을 pty로 실측한다(RD-008 확정 8).

역할:
- CPython 3.14.4 REPL(`_pyrepl`)을 pty로 띄운다.
- 케이스 ①~⑦에서 Ctrl+C(0x03)를 보내고 REPL이 돌려주는 바이트를 그대로 적는다.
- 웹 REPL의 취소 화면(`KeyboardInterrupt` 앞뒤 개행, `^C` 에코, 트레이스백 프레임)이 맞출 기준이다.

케이스:
- ①~④ 프롬프트 취소: 빈 `>>> `, `>>> abc`, `... `, 본문이 쌓인 블록.
- ⑤⑥ `input()` 취소: 최상위와 함수 안. 취소 뒤 `x`를 조회해 대입이 없었음을 본다.
- ⑦ `sys.stdin.readline()` 취소.

전제:
- 인터프리터는 환경변수 `PY314`로 정한다. 기본값은 /home/jjfive/.local/bin/python3.14다.
- `TERM=xterm`, `PYTHON_COLORS=0`, `NO_COLOR=1`, `PYTHON_HISTORY`는 임시 파일, 인터프리터는 `-q`로 띄운다.
- `tools/ptyrepl.py`와 pyte를 쓰지 않는다.
- `PY314` 규칙은 `tools/`의 `--python`·`PTY_PYTHON` 규칙과 다르다(`../README.md`).
- 세션 하나로 ①~⑦을 이어서 돌린다. 앞 케이스의 변수와 `<python-input-N>` 번호가 뒤로 이어진다.

Ctrl+C(0x03)가 자식의 포그라운드 프로세스 그룹으로 가는 이유:
- `pty.fork()`가 자식을 새 세션으로 띄운다.
- 그래서 이 스크립트가 아니라 자식이 SIGINT를 받는다.
- 부모가 물려준 SIGINT 처분(SIG_IGN 등)이 남지 않게 exec 전에 `signal.signal(SIGINT, SIG_DFL)`을 건다.
- 근거는 09-testing.md 9.5의 3번이다.

케이스마다 여러 단계를 보낸다.

사용: python3 pty_cancel.py > raw.txt
결과: `raw.txt`가 원시 로그다. 판정은 사람이 `results.md`에 적는다(`../README.md`).
"""

import os
import pty
import select
import signal
import sys
import tempfile
import time

PYTHON = os.environ.get("PY314", "/home/jjfive/.local/bin/python3.14")

ENTER = b"\r"
CTRL_C = b"\x03"

# 케이스 목록: (라벨, [(보낼 바이트, 단계 설명), ...]).
# 단계를 보낼 때마다 응답을 모은다. ⑤는 Ctrl+C 뒤에 `x`를 조회하는 단계가 더 있다.
CASES = [
    ("① 빈 >>> 에서 Ctrl+C", [(CTRL_C, "Ctrl+C")]),
    ("② >>> abc 뒤 Ctrl+C", [(b"abc", "abc 입력"), (CTRL_C, "Ctrl+C")]),
    (
        "③ if True: 뒤 ... 에서 Ctrl+C",
        [(b"if True:" + ENTER, "if True: Enter"), (CTRL_C, "Ctrl+C")],
    ),
    (
        "④ 본문이 쌓인 블록에서 Ctrl+C",
        [
            (b"if True:" + ENTER, "if True: Enter"),
            (b"    print(2)" + ENTER, "본문 Enter"),
            (CTRL_C, "Ctrl+C"),
        ],
    ),
    (
        '⑤ x = input("x: ") 중 abc 뒤 Ctrl+C',
        [
            (b'x = input("x: ")' + ENTER, "문장 Enter"),
            (b"abc", "abc 입력"),
            (CTRL_C, "Ctrl+C"),
            (b"x" + ENTER, "x 조회"),
        ],
    ),
    (
        "⑥ 함수 안 input() 취소",
        [
            (b'def f(): return input("in f: ")' + ENTER, "def Enter"),
            (ENTER, "빈 Enter"),
            (b"f()" + ENTER, "f() Enter"),
            (b"abc", "abc 입력"),
            (CTRL_C, "Ctrl+C"),
        ],
    ),
    (
        "⑦ sys.stdin.readline() 중 abc 뒤 Ctrl+C",
        [
            (b"import sys" + ENTER, "import Enter"),
            (b"y = sys.stdin.readline()" + ENTER, "문장 Enter"),
            (b"abc", "abc 입력"),
            (CTRL_C, "Ctrl+C"),
        ],
    ),
]


def run():
    """REPL 하나를 띄워 `CASES`를 차례로 돌리고 응답을 모은다.

    반환: `(첫 출력, [(라벨, [(단계 설명, 보낸 바이트, 받은 바이트), ...]), ...])`.
    부수 효과: 자식 프로세스를 띄우고 끝에서 Ctrl+D로 끝낸다.
    """
    env = dict(
        os.environ,
        TERM="xterm",
        PYTHON_COLORS="0",
        NO_COLOR="1",
        # 기록 파일이 홈을 오염시키지 않도록 임시 경로로 둔다.
        PYTHON_HISTORY=tempfile.mktemp(),
    )
    pid, fd = pty.fork()
    if pid == 0:
        # 자식: SIGINT 처분을 기본값으로 되돌린 뒤 REPL로 바꾼다.
        signal.signal(signal.SIGINT, signal.SIG_DFL)
        os.execvpe(PYTHON, [PYTHON, "-q"], env)

    def drain(t=0.8):
        # 새 바이트가 `t`초 동안 오지 않을 때까지 읽는다. 바이트가 올 때마다 기한을 `t`초 늘린다.
        buf = b""
        end = time.time() + t
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.1)
            if r:
                try:
                    d = os.read(fd, 65536)
                except OSError:
                    break
                if not d:
                    break
                buf += d
                end = time.time() + t
        return buf

    # 첫 프롬프트까지 읽는다. `-q`라 배너는 없다. `main`이 이 앞부분을 "버전 확인"으로 출력한다.
    banner = drain(1.5)
    out = []
    for label, steps in CASES:
        captured = []
        for payload, note in steps:
            os.write(fd, payload)
            captured.append((note, payload, drain()))
        out.append((label, captured))
    # Ctrl+D(EOF)로 REPL을 끝낸다.
    os.write(fd, b"\x04")
    time.sleep(0.3)
    try:
        os.close(fd)
    except OSError:
        pass
    return banner, out


def main():
    """`run()` 결과를 케이스·단계별로 표준출력에 쓴다(`raw.txt`가 되는 내용)."""
    banner, cases = run()
    print("버전 확인:", repr(banner[:200]))
    for label, steps in cases:
        print(f"\n=== {label}")
        for note, payload, data in steps:
            print(f"  [{note}] 보냄={payload!r}")
            print(f"    받음={data!r}")


if __name__ == "__main__":
    sys.exit(main())
