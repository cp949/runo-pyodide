"""3.14.4 실제 REPL의 빈 입력줄 Ctrl+D(EOF)를 pty로 실측한다(RD-048, 가설 H3).

역할:
- 프롬프트 종류(`>>>`·`...`·`input()`·`sys.stdin` 읽기)별로 Ctrl+D 뒤의 화면과 종료 코드를 적는다.
- 웹 REPL의 Ctrl+D 규칙(docs/design/06-editing.md 6.9)이 맞출 기준이다.

전제:
- `../tools/ptyrepl.py`의 `Session`을 라이브러리로 쓴다(pty와 pyte).
- 인터프리터 해석과 버전 게이트도 그쪽이 한다.
- `--python`·`PTY_PYTHON`·버전 게이트 규칙은 `../tools/README.md`다.
- 케이스마다 새 `Session`을 띄운다.
- 실행 환경(`TERM=xterm`, 24x80, `PYTHON_COLORS=0` 등)은 `Session.__init__`이 맞춘다.
- 값은 `../README.md` 실행 전제와 같다.

케이스:
- P1 `>>>` 빈 줄 Ctrl+D. 화면과 종료 코드를 본다.
- P2 `if True:` Enter 뒤 `...` 빈 줄 Ctrl+D. 무동작인지 본다.
  `pass` Enter Enter로 블록이 살아 있는지 확인한다.
- P3 `x = input("p: ")` 뒤 빈 줄 Ctrl+D. EOFError 트레이스백 위치와 다음 `>>>`를 본다.
- P4 `x = input("p: ")` 뒤 `abc` ← ← Ctrl+D. 커서 뒤 글자가 지워지는지 보고, Enter 뒤 `x` 값을 본다.
- P5 `x = input("p: ")` 뒤 `abc` Ctrl+D(커서 끝). 무동작인지 본다.
- P6 `import sys; d = sys.stdin.read()` 뒤 `l1` Enter, 빈 줄 Ctrl+D. `print(repr(d))`로 읽은 값을 본다.
- P7 `for line in sys.stdin: print(line, end="")` 블록 뒤 `a` Enter `b` Enter, 빈 줄 Ctrl+D.
  - 루프가 끝나고 다음 `>>>`가 오는지 본다.
  - 이어서 `input()`이 다시 읽는지 본다(EOF를 기억하는지).

이 측정은 웹 결정을 바꾸지 않는다. 웹과 다르면 편차로 기록할 재료만 `results.md`에 남긴다.

사용: PTY_PYTHON=<3.14.4 경로> <하니스 venv>/bin/python apps/demo/e2e/pty/rd-048/pty_ctrl_d.py
결과: 같은 폴더의 `raw.txt`를 다시 만들고 같은 내용을 표준출력에도 낸다. 판정은 `results.md`다.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# `ptyrepl`을 import하도록 `../tools`를 검색 경로 앞에 둔다.
TOOLS = os.path.abspath(os.path.join(HERE, "..", "tools"))
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

from ptyrepl import Session, add_interpreter_args, setup_from_args  # noqa: E402

CTRL_D = b"\x04"
# TERM=xterm의 ← 시퀀스다(`../README.md` 실행 전제).
LEFT = b"\x1bOD"

# 출력 줄 버퍼. `main`이 raw.txt와 표준출력에 한 번에 낸다.
_log = []


def w(line=""):
    """출력 버퍼에 한 줄을 더한다."""
    _log.append(line)


def snap(s, title):
    """`Session.show`와 같은 형식으로 화면을 출력 버퍼에 적는다."""
    lines = s.lines()
    w(f"--- {title} ---")
    for i, ln in enumerate(lines):
        w(f"{i:2d}|{ln}")
    w(f"cursor(row={s.screen.cursor.y}, col={s.screen.cursor.x})")


def case_p1():
    """P1: `>>>` 빈 줄에서 Ctrl+D를 보내고 화면과 종료 코드를 적는다."""
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
    """P2: `...` 빈 줄의 Ctrl+D가 무동작인지 보고, 블록이 살아 있는지 확인한다."""
    w("")
    w("=== P2 if True: ... 빈 줄 Ctrl+D(무동작), pass Enter Enter로 블록 생존 확인 ===")
    s = Session()
    s.send(b"if True:\r", 0.3)
    snap(s, "P2 if True: Enter 뒤(... 프롬프트)")
    s.send(CTRL_D, 0.3)
    snap(s, "P2 ... 빈 줄 Ctrl+D 뒤")
    s.send(b"pass\r\r", 0.3)
    snap(s, "P2 pass Enter Enter 뒤")
    # 정리: 남은 `>>>`에서 Ctrl+D로 세션을 끝낸다.
    s.send(CTRL_D, 0.3)
    s.wait_exit(3.0)
    s.close()


def case_p3():
    """P3: `input()` 빈 줄의 Ctrl+D가 `EOFError`를 내는지 본다."""
    w("")
    w('=== P3 x = input("p: ") 빈 줄 Ctrl+D → EOFError ===')
    s = Session()
    s.send(b'x = input("p: ")\r', 0.3)
    snap(s, "P3 input() 제출 뒤(p: 프롬프트)")
    s.send(CTRL_D, 0.3)
    snap(s, "P3 빈 줄 Ctrl+D 뒤")
    # 정리: 남은 `>>>`에서 Ctrl+D로 세션을 끝낸다.
    s.send(CTRL_D, 0.3)
    s.wait_exit(3.0)
    s.close()


def case_p4():
    """P4: `input()` 입력 중 커서 뒤에서 Ctrl+D를 보내 글자가 지워지는지 본다."""
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
    # 정리: 남은 `>>>`에서 Ctrl+D로 세션을 끝낸다.
    s.send(CTRL_D, 0.3)
    s.wait_exit(3.0)
    s.close()


def case_p5():
    """P5: `input()` 입력 중 커서가 끝일 때 Ctrl+D가 무동작인지 본다."""
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
    # 정리: 남은 `>>>`에서 Ctrl+D로 세션을 끝낸다.
    s.send(CTRL_D, 0.3)
    s.wait_exit(3.0)
    s.close()


def case_p6():
    """P6: `sys.stdin.read()` 대기 중 빈 줄 Ctrl+D가 EOF인지 본다."""
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
    # 정리: 남은 `>>>`에서 Ctrl+D로 세션을 끝낸다.
    s.send(CTRL_D, 0.3)
    s.wait_exit(3.0)
    s.close()


def case_p7():
    """P7: `for line in sys.stdin` 루프가 Ctrl+D로 끝나는지, 이후 `input()`이 EOF를 기억하는지 본다."""
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


# 실행 순서다.
CASES = [case_p1, case_p2, case_p3, case_p4, case_p5, case_p6, case_p7]


def main(argv=None):
    """인터프리터를 정해 P1~P7을 돌리고 `raw.txt`를 다시 쓴다. 같은 내용을 표준출력에도 낸다."""
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
