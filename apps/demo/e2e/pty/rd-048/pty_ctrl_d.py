"""3.14.4 실제 REPL의 빈 입력줄 Ctrl+D(EOF)를 pty로 실측한다(RD-048 DELTA-01, 가설 H3).

`../tools/ptyrepl.py`의 `Session`을 라이브러리로 쓴다(pty·pyte, 인터프리터 해석·버전 게이트는 그쪽이 한다). 케이스마다
새 `Session`을 띄운다(`../README.md` 실행 전제: TERM=xterm, 24x80, PYTHON_COLORS=0 등은 `Session.__init__`이 이미 맞춘다).

케이스(계획 DELTA-01.md)
  P1 `>>>` 빈 줄 Ctrl+D → 화면·종료 코드
  P2 `if True:` Enter → `...` 빈 줄 Ctrl+D → 화면(무동작 여부), `pass` Enter Enter로 블록 생존 확인
  P3 `x = input("p: ")` → 빈 줄 Ctrl+D → 화면(EOFError 트레이스백 위치), 다음 `>>>`
  P4 `x = input("p: ")` → `abc` ← ← Ctrl+D → 화면(커서 뒤 삭제) → Enter → x 값
  P5 `x = input("p: ")` → `abc` Ctrl+D(커서 끝) → 화면(무동작 여부)
  P6 `import sys; d = sys.stdin.read()` → `l1` Enter → 빈 줄 Ctrl+D → `print(repr(d))`
  P7 `for line in sys.stdin: print(line, end="")` 블록 → `a` Enter `b` Enter → 빈 줄 Ctrl+D → 루프 종료·다음 `>>>`,
     이어서 `input()`이 다시 읽는지(EOF 기억 여부)

결정을 바꾸지 않는다(그릴링 Q11) — 웹과 다르면 편차로 기록할 재료만 남긴다.

사용: PTY_PYTHON=<3.14.4 경로> <하니스 venv>/bin/python apps/demo/e2e/pty/rd-048/pty_ctrl_d.py
      (같은 폴더의 raw.txt를 다시 만들고 같은 내용을 표준출력에도 낸다)
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.abspath(os.path.join(HERE, "..", "tools"))
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

from ptyrepl import Session, add_interpreter_args, setup_from_args  # noqa: E402

CTRL_D = b"\x04"
LEFT = b"\x1bOD"

_log = []


def w(line=""):
    _log.append(line)


def snap(s, title):
    """`Session.show`와 같은 형식으로 화면을 버퍼에 적는다(표준출력·raw.txt는 `main`이 한 번에 낸다)."""
    lines = s.lines()
    w(f"--- {title} ---")
    for i, ln in enumerate(lines):
        w(f"{i:2d}|{ln}")
    w(f"cursor(row={s.screen.cursor.y}, col={s.screen.cursor.x})")


def case_p1():
    w("")
    w("=== P1 >>> 빈 줄 Ctrl+D ===")
    s = Session()
    snap(s, "P1 boot")
    s.send(CTRL_D, 0.3)
    snap(s, "P1 Ctrl+D 직후")
    code = s.wait_exit(3.0)
    w(f"종료 코드: {code}")
    s.close()


def case_p2():
    w("")
    w("=== P2 if True: ... 빈 줄 Ctrl+D(무동작), pass Enter Enter로 블록 생존 확인 ===")
    s = Session()
    s.send(b"if True:\r", 0.3)
    snap(s, "P2 if True: Enter 뒤(... 프롬프트)")
    s.send(CTRL_D, 0.3)
    snap(s, "P2 ... 빈 줄 Ctrl+D 뒤")
    s.send(b"pass\r\r", 0.3)
    snap(s, "P2 pass Enter Enter 뒤")
    s.send(CTRL_D, 0.3)
    s.wait_exit(3.0)
    s.close()


def case_p3():
    w("")
    w('=== P3 x = input("p: ") 빈 줄 Ctrl+D → EOFError ===')
    s = Session()
    s.send(b'x = input("p: ")\r', 0.3)
    snap(s, "P3 input() 제출 뒤(p: 프롬프트)")
    s.send(CTRL_D, 0.3)
    snap(s, "P3 빈 줄 Ctrl+D 뒤")
    s.send(CTRL_D, 0.3)
    s.wait_exit(3.0)
    s.close()


def case_p4():
    w("")
    w('=== P4 x = input("p: ") abc ← ← Ctrl+D(커서 뒤 삭제) → Enter → x 값 ===')
    s = Session()
    s.send(b'x = input("p: ")\r', 0.3)
    s.send(b"abc", 0.2)
    snap(s, "P4 abc 입력 뒤")
    s.send(LEFT, 0.15)
    s.send(LEFT, 0.15)
    snap(s, "P4 ← ← 뒤(커서 a와 b 사이)")
    s.send(CTRL_D, 0.3)
    snap(s, "P4 Ctrl+D 뒤(커서 뒤 글자 삭제 여부)")
    s.send(b"\r", 0.3)
    snap(s, "P4 Enter 뒤")
    s.send(b"print(repr(x))\r", 0.3)
    snap(s, "P4 x 값")
    s.send(CTRL_D, 0.3)
    s.wait_exit(3.0)
    s.close()


def case_p5():
    w("")
    w('=== P5 x = input("p: ") abc Ctrl+D(커서 끝, 무동작 여부) ===')
    s = Session()
    s.send(b'x = input("p: ")\r', 0.3)
    s.send(b"abc", 0.2)
    snap(s, "P5 abc 입력 뒤(커서 끝)")
    s.send(CTRL_D, 0.3)
    snap(s, "P5 Ctrl+D 뒤(커서 끝, 무동작 여부)")
    s.send(b"\r", 0.3)
    s.send(b"print(repr(x))\r", 0.3)
    snap(s, "P5 x 값")
    s.send(CTRL_D, 0.3)
    s.wait_exit(3.0)
    s.close()


def case_p6():
    w("")
    w('=== P6 import sys; d = sys.stdin.read() → l1 Enter → 빈 줄 Ctrl+D → print(repr(d)) ===')
    s = Session()
    s.send(b"import sys; d = sys.stdin.read()\r", 0.3)
    snap(s, "P6 sys.stdin.read() 제출 뒤(읽기 대기)")
    s.send(b"l1\r", 0.3)
    snap(s, "P6 l1 Enter 뒤")
    s.send(CTRL_D, 0.3)
    snap(s, "P6 빈 줄 Ctrl+D 뒤(EOF)")
    s.send(b"print(repr(d))\r", 0.3)
    snap(s, "P6 repr(d)")
    s.send(CTRL_D, 0.3)
    s.wait_exit(3.0)
    s.close()


def case_p7():
    w("")
    w('=== P7 for line in sys.stdin: print(line, end="") 블록 → a Enter b Enter → 빈 줄 Ctrl+D → 루프 종료, 이어서 input() ===')
    s = Session()
    s.send(b"import sys\r", 0.3)
    s.send(b"for line in sys.stdin:\r", 0.3)
    snap(s, "P7 for line in sys.stdin: Enter 뒤(... 프롬프트)")
    s.send(b'    print(line, end="")\r', 0.3)
    snap(s, "P7 print 본문 Enter 뒤")
    s.send(b"\r", 0.3)
    snap(s, "P7 빈 줄로 블록 제출 뒤(stdin 읽기 대기)")
    s.send(b"a\r", 0.3)
    snap(s, "P7 a Enter 뒤")
    s.send(b"b\r", 0.3)
    snap(s, "P7 b Enter 뒤")
    s.send(CTRL_D, 0.3)
    snap(s, "P7 빈 줄 Ctrl+D 뒤(루프 종료, 다음 >>> 여부)")
    s.send(b"input()\r", 0.3)
    snap(s, "P7 input() 재호출 뒤(EOF 기억 여부)")
    s.send(CTRL_D, 0.3)
    snap(s, "P7 정리용 Ctrl+D 뒤")
    s.close()


CASES = [case_p1, case_p2, case_p3, case_p4, case_p5, case_p6, case_p7]


def main(argv=None):
    import argparse

    ap = argparse.ArgumentParser(description=__doc__)
    add_interpreter_args(ap)
    args = ap.parse_args(argv)
    interp = setup_from_args(args)
    w(f"인터프리터({interp.source}): {interp.path}")
    w(f"버전: {interp.version} (기대 3.14.4, 불일치={interp.mismatch})")
    for case in CASES:
        case()
    text = "\n".join(_log) + "\n"
    with open(os.path.join(HERE, "raw.txt"), "w", encoding="utf-8") as f:
        f.write(text)
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
