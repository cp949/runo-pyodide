"""3.14.4 실제 REPL의 type-ahead(실행 중에 친 키) 동작을 pty로 실측한다(RD-019 확정 10).

역할:
- 실행 중인 문장 위에 키를 보내고, REPL이 프롬프트로 돌아온 뒤 화면과 입력 버퍼가 어떻게 되는지 적는다.
- 웹 type-ahead 규칙(docs/design/06-editing.md 6.7)이 맞출 기준이다.
- 짝이 되는 웹 확인은 `checks/type-ahead-check.mjs`다.

시나리오:
- 필수:
  - P1 실행 중 `abc`.
  - P2 실행 중 `print('P2OUT')` + Enter.
  - P3 실행 중 `xyz` + Enter. 실행이 `input()`으로 이어져 다음 읽기가 된다.
  - P4 실행 중 `abc` 뒤 Ctrl+C(0x03).
- 관찰:
  - C1 Backspace(0x7f).
  - C2 ←(ESC[D) + 글자. C2b는 애플리케이션 모드 ←(ESC O D).
  - C3 Ctrl+U(0x15).
  - C4a 글자 뒤 Ctrl+D(0x04). C4b 빈 입력의 Ctrl+D.
  - C5a Tab(0x09)이 마지막 키. C5b Tab 뒤에 키가 이어진다.
  - L1 실행 중 5000자 + Enter.
    - 웹 상한 4096(`TYPE_AHEAD_LIMIT`)을 넘는 덩어리 폐기와 대조한다.
    - 벨 바이트(0x07)가 나오는지 본다.

시나리오 한 개의 진행:
1. 새 인터프리터를 띄운다. 시나리오당 한 번이다.
2. 실행 줄 `import time; print('RUNnn'); time.sleep(...)`을 제출한다.
   마커 행 `RUNnn`이 읽힐 때까지 기다린다. 웹 하니스의 `startRunning`과 같은 배리어다.
3. 실행이 진행 중인 동안 바이트를 한 번에 쓴다. 이후 0.4초 동안 읽은 바이트가 실행 중 에코다.
4. 프롬프트가 돌아올 때까지 읽는다. P4는 Ctrl+C를 보낸다. 이어서 0.6초 더 읽는다.
5. 화면을 해석한다. 후속 단계(Enter 제출, 값 조회)가 있으면 보내고 화면을 다시 해석한다.

전제:
- 인터프리터는 환경변수 `PY314`로 정한다. 기본값은 /home/jjfive/.local/bin/python3.14다.
- 환경: `TERM=xterm`, `PYTHON_COLORS=0`, `NO_COLOR=1`, `PYTHON_HISTORY`는 임시 파일.
- 창은 24x80이고 인터프리터는 `-q`로 띄운다.
- 자식은 exec 전에 `SIGINT`를 기본 처리로 되돌린다(09-testing.md 9.5의 3번).
- 화면 해석에 pyte를 쓰지 않는다. 이 파일의 `Screen`이 처리하지 못한 시퀀스는 `unhandled`에 기록한다.
- rd-008 `pty_cancel.py`와 달리 `tools/ptyrepl.py`를 쓰지 않고 시나리오마다 새 인터프리터를 띄운다.

사용: python3 apps/demo/e2e/pty/rd-019/pty_type_ahead.py
결과: 같은 폴더의 `raw.txt`를 다시 만들고 같은 내용을 표준출력에도 낸다.
판정은 사람이 `results.md`에 적는다.
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
# 프롬프트를 그린 직후의 꼬리다. _pyrepl이 `>>> ` 뒤에 커서를 켠다.
# 프롬프트 복귀 판정에 쓴다.
PROMPT_TAIL = b">>> \x1b[?12l\x1b[?25h"


class Screen:
    """_pyrepl이 pty로 내는 이스케이프만 처리하는 최소 터미널 에뮬레이터.

    - 폭은 80열이다. 행은 필요한 만큼 늘어난다.
    - 처리하는 것: CR·LF·BS·TAB, CSI `A B C D @ P K G m`, `ESC =`·`ESC >`.
    - `K`는 모드 0(커서부터 줄 끝)과 2(줄 전체)만 처리한다.
    - `?`로 시작하는 CSI(모드 설정)는 화면 내용과 무관해 무시한다.
    - 처리하지 못한 시퀀스와 제어 문자는 `unhandled`에 적는다.
    - NUL은 폭 0이라 `nul`에 개수만 센다.
    """

    COLS = 80

    def __init__(self):
        self.rows = [[]]
        self.r = 0
        self.c = 0
        self.unhandled = []
        self.nul = 0

    def _row(self):
        """현재 행을 돌려준다. 행이 모자라면 빈 행으로 채운다."""
        while len(self.rows) <= self.r:
            self.rows.append([])
        return self.rows[self.r]

    def _put(self, ch):
        """커서 위치에 글자를 덮어쓰고 커서를 한 칸 옮긴다. 80열을 넘으면 다음 행 처음으로 간다."""
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
        """pty에서 읽은 바이트를 화면에 반영한다."""
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
                # C4의 Ctrl+D가 버퍼에 남기는 글자다. 화면에는 안 보이니 개수만 센다.
                self.nul += 1
            elif ord(ch) < 0x20:
                self.unhandled.append(repr(ch))
            else:
                self._put(ch)
            i += 1

    def _csi(self, params, final):
        """CSI 시퀀스 하나를 반영한다. 인자 `params`는 파라미터 문자열, `final`은 끝 글자다."""
        if params.startswith("?"):
            # bracketed paste·application cursor·커서 표시 같은 모드 설정이다.
            return
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
        """화면의 행 목록을 돌려준다. 각 행의 오른쪽 공백은 뗀다."""
        return ["".join(r).rstrip() for r in self.rows]


def spawn():
    """인터프리터를 pty 자식으로 띄운다. `(pid, 마스터 fd)`를 돌려준다."""
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
        # 자식: SIGINT 처분을 기본값으로 되돌리고 창을 24x80으로 맞춘 뒤 REPL로 바꾼다.
        signal.signal(signal.SIGINT, signal.SIG_DFL)
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        os.execvpe(PYTHON, [PYTHON, "-q"], env)
    return pid, fd


class Session:
    """pty 자식 REPL 한 개와 마스터에서 읽은 전체 바이트 로그."""

    def __init__(self):
        self.pid, self.fd = spawn()
        self.log = b""

    def read_until(self, pattern, timeout, count=1):
        """`pattern`이 이번 호출 뒤로 `count`번 더 나올 때까지 읽는다(시간 초과가 있다).

        기준은 누적 로그 `self.log`의 개수다. 이번 호출에서 받은 바이트를 돌려준다.
        """
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
        """`quiet`초 동안 새 바이트가 없을 때까지 읽는다. 최대 `limit`초다."""
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
        """바이트를 pty 마스터에 쓴다. 응답은 읽지 않는다."""
        os.write(self.fd, payload)

    def close(self):
        """Ctrl+D로 REPL을 끝내고 fd를 닫는다. 자식이 아직 안 끝나도 기다리지 않는다."""
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


# 시나리오 목록. 필드:
# - `id`·`title`: 식별자와 제목.
# - `setup`: 실행 줄 앞에 제출할 준비 줄(선택).
# - `run`: 실행 줄. `{m}`에 `marker`가 들어간다.
# - `marker`: 실행이 진행 중임을 알리는 출력 마커. 이 행이 읽힌 뒤에 키를 보낸다.
#   웹 하니스의 `startRunning`과 같은 배리어다.
# - `typed`: 실행 중 보낼 바이트.
# - `interrupt`: 참이면 실행 중 입력 뒤 Ctrl+C를 보낸다(선택).
# - `after`: 프롬프트 복귀 뒤 이어서 보낼 `(바이트, 설명)` 단계.
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
    # 한 줄 5000자(4096 초과) + Enter다.
    # `input()`이 받은 길이와 `a` 개수로 tty가 몇 글자까지 받았는지 본다.
    # 실행 중 에코에 벨(0x07)이 있는지도 본다.
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
    """시나리오 한 개를 새 인터프리터에서 돌리고 결과 dict를 돌려준다.

    반환 키:
    - `case`: 시나리오 정의.
    - `steps`: `(설명, 보낸 바이트, 받은 바이트)` 목록.
    - `marker_seen`: 실행 줄의 마커 행이 로그에 있었는가.
    - `elapsed`: 실행 중 입력을 보낸 뒤 프롬프트 복귀와 잔여 읽기까지 걸린 초.
    - `prompt_screen`: 프롬프트 복귀 직후의 화면 해석.
      `(행 목록, 커서 행, 커서 열, 처리 못한 시퀀스, NUL 수)`.
    - `final`: 후속 단계 뒤의 화면 해석. 형식은 `prompt_screen`과 같다.
    - `bytes_total`·`run_start_offset`: 로그 총 길이와 실행 줄 제출 직전 로그 길이.
      `render`는 출력하지 않는다.
    """
    s = Session()
    steps = []
    # 첫 프롬프트를 읽어 버린다.
    s.read_until(PROMPT_TAIL, 8.0)
    s.drain(0.3)
    # 준비 줄을 실행한다.
    for line in case.get("setup", []):
        s.send(line.encode() + ENTER)
        s.read_until(PROMPT_TAIL, 5.0)
        s.drain(0.3)
    # 실행 줄을 제출하고 마커 행이 보일 때까지 기다린다.
    mark_before_run = len(s.log)
    cmd = case["run"].format(m=case["marker"]).encode()
    s.send(cmd + ENTER)
    started = s.read_until((case["marker"] + "\r\n").encode(), 8.0)
    steps.append(("실행 줄 제출", cmd + ENTER, started))
    marker_seen = (case["marker"] + "\r\n").encode() in s.log
    # 실행 중 입력: 마커가 보인 뒤 바이트를 보낸다. sleep은 2초 이상 남았다.
    # 이후 0.4초 동안 받은 바이트가 실행 중 에코다.
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
        # sleep이 끝나 프롬프트가 돌아오길 기다린다. sleep 2초에 여유를 더한다.
        back = s.read_until(PROMPT_TAIL, 6.0, count=1)
        steps.append(("종료 뒤 프롬프트", b"", back))
    # 프롬프트 뒤에 이어 오는 바이트를 모은다.
    settled = s.drain(0.6)
    if settled:
        steps.append(("프롬프트 뒤 잔여", b"", settled))
    elapsed = time.time() - t0
    # 프롬프트 복귀 직후의 화면을 해석한다.
    snapshot = Screen()
    snapshot.feed(s.log)
    after_typed_screen = (snapshot.lines(), snapshot.r, snapshot.c, list(snapshot.unhandled), snapshot.nul)
    # 후속 단계를 보내고 최종 화면을 해석한다.
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
    """뒤쪽 빈 행을 떼고 마지막 `n`행을 돌려준다."""
    trimmed = list(lines)
    while trimmed and trimmed[-1] == "":
        trimmed.pop()
    return trimmed[-n:]


def short(data):
    """바이트열의 `repr`를 돌려준다.

    400바이트를 넘으면(L1의 수천 자 에코) 앞뒤 120바이트와 총 길이·벨 개수로 줄인다.
    """
    if len(data) <= 400:
        return repr(data)
    bel = data.count(b"\x07")
    return f"{data[:120]!r} ...(총 {len(data)}바이트, 벨 x07 {bel}개, 'a' {data.count(b'a')}개)... {data[-120:]!r}"


def short_list(items):
    """목록의 `repr`를 돌려준다.

    5개를 넘으면(L1의 긴 줄 재그리기가 내는 CUP `ESC[행;열H`) 개수와 앞 3개만 적는다.
    """
    if len(items) <= 5:
        return repr(items)
    return f"{len(items)}개 {items[:3]!r}..."


def render(results, version):
    """시나리오 결과 목록을 `raw.txt`에 쓸 텍스트로 만든다. `version`은 첫 줄에 적는다."""
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
    """모든 시나리오를 돌려 `raw.txt`를 다시 쓰고 같은 내용을 표준출력에 낸다."""
    # 버전 확인용 세션: 첫 바이트를 기록한다.
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
