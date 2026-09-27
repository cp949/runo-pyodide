"""3.14.4 실제 REPL의 취소 화면을 pty로 재측정한다(RD-008 확정 8).

RD-006a `reference/pty_input.py` 형식을 케이스마다 여러 단계를 보내는 형태로 늘렸다. 자식은 `pty.fork()`가
새 세션으로 띄우므로 `\\x03`은 이 스크립트가 아니라 자식의 포그라운드 프로세스 그룹으로 간다.
`signal.signal(SIGINT, SIG_DFL)`을 exec 전에 걸어 부모가 물려준 핸들러 설정을 지운다(09-testing.md 9.5의 3번).

사용: python3 pty_cancel.py            (기본 인터프리터는 /home/jjfive/.local/bin/python3.14)
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

# (라벨, [(보낼 바이트, 단계 설명), ...])
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
    env = dict(
        os.environ,
        TERM="xterm",
        PYTHON_COLORS="0",
        NO_COLOR="1",
        PYTHON_HISTORY=tempfile.mktemp(),
    )
    pid, fd = pty.fork()
    if pid == 0:
        signal.signal(signal.SIGINT, signal.SIG_DFL)
        os.execvpe(PYTHON, [PYTHON, "-q"], env)

    def drain(t=0.8):
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

    banner = drain(1.5)
    out = []
    for label, steps in CASES:
        captured = []
        for payload, note in steps:
            os.write(fd, payload)
            captured.append((note, payload, drain()))
        out.append((label, captured))
    os.write(fd, b"\x04")
    time.sleep(0.3)
    try:
        os.close(fd)
    except OSError:
        pass
    return banner, out


def main():
    banner, cases = run()
    print("버전 확인:", repr(banner[:200]))
    for label, steps in cases:
        print(f"\n=== {label}")
        for note, payload, data in steps:
            print(f"  [{note}] 보냄={payload!r}")
            print(f"    받음={data!r}")


if __name__ == "__main__":
    sys.exit(main())
