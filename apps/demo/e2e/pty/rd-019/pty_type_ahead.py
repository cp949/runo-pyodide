"""3.14.4 실제 REPL의 type-ahead(실행 중에 친 키) 동작을 pty로 실측한다(RD-019 확정 10).

rd-008 `pty_cancel.py`와 같은 방식이다: `pty.fork()`로 자식을 새 세션으로 띄우고 exec 전에 `SIGINT`를 기본 처리로 되돌린다
(09-testing.md 9.5의 3번). 창 크기는 24x80으로 맞춘다. 시나리오마다 새 인터프리터를 띄운다(시나리오당 1회).

시나리오
  필수: P1 실행 중 `abc` / P2 실행 중 `print('P2OUT')`+Enter / P3 실행 중 `xyz`+Enter 뒤 `input()`이 다음 읽기 /
        P4 실행 중 `abc` 뒤 Ctrl+C(0x03)
  관찰: C1 Backspace(0x7f) / C2 ←(ESC[D)+글자 / C3 Ctrl+U(0x15) / C4a·C4b Ctrl+D(0x04) / C5a·C5b Tab(0x09)
        L1 실행 중 5000자+Enter(웹 상한 4096 초과 덩어리 폐기와 대조, 벨 바이트 `\x07` 유무)

실행 중 "에코"는 실행 중(시나리오의 `time.sleep` 동안)에 자식이 pty 마스터로 내보낸 바이트다. 화면 해석은 pyte 없이 이 파일의
`Screen`(_pyrepl이 내는 이스케이프만 처리하는 최소 에뮬레이터)으로 한다. 처리하지 못한 시퀀스는 `unhandled`로 기록한다.

사용: python3 apps/demo/e2e/pty/rd-019/pty_type_ahead.py   (같은 폴더의 `raw.txt`를 다시 만들고 같은 내용을 표준출력에도 낸다)
      기본 인터프리터는 /home/jjfive/.local/bin/python3.14 (PY314 환경 변수로 바꿀 수 있다)
"""

import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import tempfile
import termios
import time

PYTHON = os.environ.get("PY314", "/home/jjfive/.local/bin/python3.14")
HERE = os.path.dirname(os.path.abspath(__file__))

ENTER = b"\r"
CTRL_C = b"\x03"
# 프롬프트가 그려진 직후에 나오는 꼬리(_pyrepl이 `>>> ` 뒤에 커서를 켠다). 프롬프트 복귀 판정에 쓴다.
PROMPT_TAIL = b">>> \x1b[?12l\x1b[?25h"


class Screen:
    """_pyrepl이 pty로 내는 이스케이프만 처리하는 최소 터미널 에뮬레이터(80열, 행은 무제한으로 늘어난다)."""

    COLS = 80

    def __init__(self):
        self.rows = [[]]
        self.r = 0
        self.c = 0
        self.unhandled = []
        self.nul = 0

    def _row(self):
        while len(self.rows) <= self.r:
            self.rows.append([])
        return self.rows[self.r]

    def _put(self, ch):
        if self.c >= self.COLS:
            self.r += 1
            self.c = 0
        row = self._row()
        while len(row) < self.c:
            row.append(" ")
        if self.c < len(row):
            row[self.c] = ch
        else:
            row.append(ch)
        self.c += 1

    def feed(self, data):
        text = data.decode("utf-8", errors="replace")
        i = 0
        n = len(text)
        while i < n:
            ch = text[i]
            if ch == "\x1b":
                m = re.compile(r"\x1b\[([?0-9;]*)([@-~])").match(text, i)
                if m:
                    self._csi(m.group(1), m.group(2))
                    i = m.end()
                    continue
                if i + 1 < n and text[i + 1] in "=>":
                    i += 2
                    continue
                self.unhandled.append(repr(text[i : i + 6]))
                i += 1
                continue
            if ch == "\r":
                self.c = 0
            elif ch == "\n":
                self.r += 1
                self._row()
            elif ch == "\b":
                self.c = max(0, self.c - 1)
            elif ch == "\t":
                self.c = min(self.COLS - 1, (self.c // 8 + 1) * 8)
            elif ch == "\x07":
                pass
            elif ch == "\x00":
                self.nul += 1  # 폭 0인 NUL(C4의 Ctrl+D가 버퍼에 남기는 글자). 화면에는 안 보이고 개수만 센다.
            elif ord(ch) < 0x20:
                self.unhandled.append(repr(ch))
            else:
                self._put(ch)
            i += 1

    def _csi(self, params, final):
        if params.startswith("?"):
            return  # 모드 설정(bracketed paste·application cursor·커서 표시)은 화면 내용과 무관
        nums = [int(p) if p else 0 for p in params.split(";")] if params else []
        n = nums[0] if nums and nums[0] else 1
        row = self._row()
        if final == "D":
            self.c = max(0, self.c - n)
        elif final == "C":
            self.c = min(self.COLS - 1, self.c + n)
        elif final == "A":
            self.r = max(0, self.r - n)
        elif final == "B":
            self.r += n
            self._row()
        elif final == "@":
            while len(row) < self.c:
                row.append(" ")
            for _ in range(n):
                row.insert(self.c, " ")
        elif final == "P":
            del row[self.c : self.c + n]
        elif final == "K":
            mode = nums[0] if nums else 0
            if mode == 0:
                del row[self.c :]
            elif mode == 2:
                row.clear()
        elif final == "G":
            self.c = max(0, n - 1)
        elif final == "m":
            pass
        else:
            self.unhandled.append(f"CSI {params}{final}")

    def lines(self):
        return ["".join(r).rstrip() for r in self.rows]


def spawn():
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
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        os.execvpe(PYTHON, [PYTHON, "-q"], env)
    return pid, fd


class Session:
    def __init__(self):
        self.pid, self.fd = spawn()
        self.log = b""  # 마스터에서 읽은 전체 바이트

    def read_until(self, pattern, timeout, count=1):
        """`pattern`이 누적 로그 안에서 `count`번 나올 때까지(또는 시간 초과) 읽는다. 이번 호출에서 받은 바이트를 돌려준다."""
        got = b""
        end = time.time() + timeout
        base = self.log.count(pattern)
        while time.time() < end and self.log.count(pattern) - base < count:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if r:
                try:
                    d = os.read(self.fd, 65536)
                except OSError:
                    break
                if not d:
                    break
                self.log += d
                got += d
        return got

    def drain(self, quiet=0.5, limit=8.0):
        """`quiet`초 동안 더 오는 바이트가 없을 때까지(최대 `limit`초) 읽는다."""
        got = b""
        start = time.time()
        end = start + quiet
        while time.time() < end and time.time() < start + limit:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if r:
                try:
                    d = os.read(self.fd, 65536)
                except OSError:
                    break
                if not d:
                    break
                self.log += d
                got += d
                end = time.time() + quiet
        return got

    def send(self, payload):
        os.write(self.fd, payload)

    def close(self):
        try:
            os.write(self.fd, b"\x04")
        except OSError:
            pass
        time.sleep(0.2)
        try:
            os.close(self.fd)
        except OSError:
            pass
        try:
            os.waitpid(self.pid, os.WNOHANG)
        except ChildProcessError:
            pass


# 시나리오: (ID, 제목, 준비 줄, 실행 줄(마커 포함), 실행 중 보낼 바이트, 실행 뒤 이어서 보낼 단계)
# `RUN`은 실행이 진행 중임을 알리는 출력 마커라 그 줄이 보인 뒤에 키를 보낸다(웹 하니스의 `startRunning`과 같은 배리어).
SLEEP2 = "import time; print('{m}'); time.sleep(2)"
SLEEP30 = "import time; print('{m}'); time.sleep(30)"
CASES = [
    dict(id="P1", title="필수: 실행 중 `abc`", run=SLEEP2, marker="RUN01", typed=b"abc", after=[]),
    dict(id="P2", title="필수: 실행 중 `print('P2OUT')`+Enter", run=SLEEP2, marker="RUN02", typed=b"print('P2OUT')" + ENTER, after=[]),
    dict(
        id="P3",
        title="필수: 실행 중 `xyz`+Enter, 다음 읽기가 `input()`",
        run=SLEEP2 + "; v = input()",
        marker="RUN03",
        typed=b"xyz" + ENTER,
        after=[(b"repr(v)" + ENTER, "repr(v) 조회")],
    ),
    dict(
        id="P4",
        title="필수: 실행 중 `abc` 뒤 Ctrl+C(0x03)",
        run=SLEEP30,
        marker="RUN04",
        typed=b"abc",
        interrupt=True,
        after=[(b"print('P4M')" + ENTER, "폐기 확인: 마커 제출")],
    ),
    dict(id="C1", title="관찰: Backspace `abx`+0x7f+`c`", run=SLEEP2, marker="RUN11", typed=b"abx\x7fc", after=[]),
    dict(
        id="C2",
        title="관찰: ←(ESC[D)+글자 `ab`+ESC[D+`c`, 이어서 Enter로 제출된 버퍼 확인",
        run=SLEEP2,
        marker="RUN12",
        typed=b"ab\x1b[Dc",
        after=[(ENTER, "Enter 제출(실제 버퍼 확인)")],
    ),
    dict(
        id="C2b",
        title="관찰: 애플리케이션 모드 ←(ESC O D)+글자 `ab`+ESC O D+`c`, 이어서 Enter",
        run=SLEEP2,
        marker="RUN18",
        typed=b"ab\x1bODc",
        after=[(ENTER, "Enter 제출(실제 버퍼 확인)")],
    ),
    dict(id="C3", title="관찰: Ctrl+U `abc`+0x15+`de`", run=SLEEP2, marker="RUN13", typed=b"abc\x15de", after=[]),
    dict(id="C4a", title="관찰: Ctrl+D `abc`+0x04", run=SLEEP2, marker="RUN14", typed=b"abc\x04", after=[(ENTER, "Enter 제출(실제 버퍼 확인)")]),
    dict(id="C4b", title="관찰: Ctrl+D 단독 0x04(빈 입력)", run=SLEEP2, marker="RUN15", typed=b"\x04", after=[(ENTER, "Enter 제출(실제 버퍼 확인)")]),
    dict(id="C5a", title="관찰: Tab이 마지막 키 `os.getc`+Tab", run=SLEEP2, marker="RUN16", typed=b"os.getc\t", setup=["import os"], after=[]),
    dict(id="C5b", title="관찰: Tab 뒤 키가 이어짐 `os.getc`+Tab+`()`", run=SLEEP2, marker="RUN17", typed=b"os.getc\t()", setup=["import os"], after=[]),
    # 한 줄 5000자(4096 초과) + Enter. `input()`이 받은 길이·`a` 개수로 tty가 몇 글자까지 받았는지, 실행 중 에코에 벨(\x07)이 있는지 본다.
    dict(
        id="L1",
        title="관찰: 실행 중 한 줄 5000자+Enter(4096 초과), 다음 읽기가 `input()`",
        run=SLEEP2 + "; v = input()",
        marker="RUN19",
        typed=b"a" * 5000 + ENTER,
        after=[(b"repr((len(v), v.count('a')))" + ENTER, "받은 길이 조회")],
    ),
]


def run_case(case):
    s = Session()
    steps = []
    s.read_until(PROMPT_TAIL, 8.0)
    s.drain(0.3)
    for line in case.get("setup", []):
        s.send(line.encode() + ENTER)
        s.read_until(PROMPT_TAIL, 5.0)
        s.drain(0.3)
    mark_before_run = len(s.log)
    cmd = case["run"].format(m=case["marker"]).encode()
    s.send(cmd + ENTER)
    started = s.read_until((case["marker"] + "\r\n").encode(), 8.0)
    steps.append(("실행 줄 제출", cmd + ENTER, started))
    marker_seen = (case["marker"] + "\r\n").encode() in s.log
    # 실행 중 입력: 마커가 보인 뒤(실행 진행 중) 바이트를 보내고 0.4초 동안 받은 바이트가 실행 중 에코다(sleep은 2초 이상 남았다).
    t0 = time.time()
    s.send(case["typed"])
    echo = s.drain(0.4, limit=0.6)
    steps.append(("실행 중 입력", case["typed"], echo))
    interrupt_traceback = b""
    if case.get("interrupt"):
        s.send(CTRL_C)
        interrupt_traceback = s.read_until(PROMPT_TAIL, 6.0)
        steps.append(("실행 중 Ctrl+C", CTRL_C, interrupt_traceback))
    else:
        # sleep이 끝나 프롬프트가 돌아오길 기다린다(sleep 2초 + 여유).
        back = s.read_until(PROMPT_TAIL, 6.0, count=1)
        steps.append(("종료 뒤 프롬프트", b"", back))
    settled = s.drain(0.6)
    if settled:
        steps.append(("프롬프트 뒤 잔여", b"", settled))
    elapsed = time.time() - t0
    snapshot = Screen()
    snapshot.feed(s.log)
    after_typed_screen = (snapshot.lines(), snapshot.r, snapshot.c, list(snapshot.unhandled), snapshot.nul)
    for payload, note in case["after"]:
        s.send(payload)
        got = s.drain(0.8)
        steps.append((note, payload, got))
    final = Screen()
    final.feed(s.log)
    s.close()
    return dict(
        case=case,
        steps=steps,
        marker_seen=marker_seen,
        elapsed=elapsed,
        prompt_screen=after_typed_screen,
        final=(final.lines(), final.r, final.c, list(final.unhandled), final.nul),
        bytes_total=len(s.log),
        run_start_offset=mark_before_run,
    )


def tail_nonempty(lines, n):
    trimmed = list(lines)
    while trimmed and trimmed[-1] == "":
        trimmed.pop()
    return trimmed[-n:]


def short(data):
    """긴 바이트열(L1의 수천 자 에코·재그리기)을 앞뒤 일부와 총 길이·벨 개수로 줄여 적는다."""
    if len(data) <= 400:
        return repr(data)
    bel = data.count(b"\x07")
    return f"{data[:120]!r} ...(총 {len(data)}바이트, 벨 x07 {bel}개, 'a' {data.count(b'a')}개)... {data[-120:]!r}"


def short_list(items):
    """처리 못한 시퀀스 목록이 길면(L1의 긴 줄 재그리기가 내는 CUP `ESC[행;열H`) 개수와 앞 3개만 적는다."""
    if len(items) <= 5:
        return repr(items)
    return f"{len(items)}개 {items[:3]!r}..."


def render(results, version):
    out = []
    w = out.append
    w("버전 확인: " + repr(version))
    w(f"인터프리터: {PYTHON}")
    for res in results:
        case = res["case"]
        w("")
        w(f"=== {case['id']} {case['title']}")
        w(f"  실행 줄: {case['run'].format(m=case['marker'])!r} (마커 {case['marker']!r} 확인={res['marker_seen']})")
        for note, payload, data in res["steps"]:
            w(f"  [{note}] 보냄={short(payload)}")
            w(f"    받음={short(data)}")
        lines, r, c, unhandled, nul = res["prompt_screen"]
        tail = tail_nonempty(lines, 6)
        w(f"  화면 해석(프롬프트 복귀 직후): 마지막 행={tail!r} 커서=(행 {r}, 열 {c}) NUL {nul}개 처리 못한 시퀀스={short_list(unhandled)}")
        if case["after"]:
            lines, r, c, unhandled, nul = res["final"]
            w(f"  화면 해석(후속 단계 뒤): 마지막 행={tail_nonempty(lines, 6)!r} 커서=(행 {r}, 열 {c}) NUL {nul}개 처리 못한 시퀀스={short_list(unhandled)}")
    return "\n".join(out) + "\n"


def main():
    probe = Session()
    banner = probe.read_until(PROMPT_TAIL, 8.0)
    probe.close()
    v = os.popen(f"{PYTHON} -V").read().strip()
    results = [run_case(c) for c in CASES]
    text = render(results, v + " / 첫 바이트 " + repr(banner[:60]))
    with open(os.path.join(HERE, "raw.txt"), "w", encoding="utf-8") as f:
        f.write(text)
    sys.stdout.write(text)


if __name__ == "__main__":
    sys.exit(main())
