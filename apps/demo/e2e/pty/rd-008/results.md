# 3.14.4 pty 취소 재측정 (RD-008 확정 8)

- 측정 2026-09-22. 스크립트 `pty_cancel.py`, 원시 로그 `raw.txt`(`python3 pty_cancel.py > raw.txt`).
- 인터프리터: `Python 3.14.4 (main, Apr 14 2026, 14:26:14) [Clang 22.1.3]`,
  경로 `/home/jjfive/.local/bin/python3.14`(실체는 uv가 깐 `cpython-3.14.4-linux-x86_64-gnu`).
  트레이스백에 그 실체 경로가 그대로 찍히므로 아래 표에서는 `…/python3.14/_pyrepl/`로 줄였다.
- 환경: `TERM=xterm`, `PYTHON_COLORS=0`, `NO_COLOR=1`, `PYTHON_HISTORY`는 임시 파일. `-q`로 배너 없음.
  자식은 `pty.fork()`가 새 세션으로 띄우고 exec 전에 `signal(SIGINT, SIG_DFL)`을 건다.
- 프롬프트 재그리기 이스케이프는 케이스마다 같아서 표에서 `<프롬프트>`로 줄였다:
  `\x1b[?2004h\x1b[?1h\x1b=\x1b[?25l>>> \x1b[?12l\x1b[?25h`. 취소 직전에는 언제나
  `\x1b[?2004l\x1b[?1l\x1b>`(bracketed paste·application cursor key 해제)가 먼저 나온다.

## 케이스별 Ctrl+C 응답 바이트

| 케이스                                               | Ctrl+C 뒤 받은 바이트(이스케이프 축약)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ① 빈 `>>> `                                          | `\r\nKeyboardInterrupt\r\n` + `<프롬프트>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ② `>>> abc`                                          | `\r\nKeyboardInterrupt\r\n` + `<프롬프트>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ③ `if True:` → `... `                                | `\r\nKeyboardInterrupt\r\n` + `<프롬프트>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ④ 본문(`    print(2)`)까지 쌓인 블록                 | `\r\nKeyboardInterrupt\r\n` + `<프롬프트>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ⑤ `x = input("x: ")` 중 `abc`                        | `Traceback (most recent call last):\r\n  File "<python-input-0>", line 1, in <module>\r\n    x = input("x: ")\r\n  File "…/python3.14/_pyrepl/readline.py", line 377, in input\r\n    result = reader.readline(startup_hook=self.startup_hook)\r\n  File "…/reader.py", line 758, in readline\r\n    self.handle1()\r\n    ~~~~~~~~~~~~^^\r\n  File "…/reader.py", line 713, in handle1\r\n    self.console.wait(100)\r\n    ~~~~~~~~~~~~~~~~~^^^^^\r\n  File "…/unix_console.py", line 446, in wait\r\n    or bool(self.pollob.poll(timeout))\r\n            ~~~~~~~~~~~~~~~~^^^^^^^^^\r\nKeyboardInterrupt\r\n` + `<프롬프트>` |
| ⑥ `def f(): return input("in f: ")` → `f()` 중 `abc` | ⑤와 같은 꼬리. 앞에 사용자 프레임 둘: `  File "<python-input-3>", line 1, in <module>\r\n    f()\r\n    ~^^\r\n  File "<python-input-2>", line 1, in f\r\n    def f(): return input("in f: ")\r\n                    ~~~~~^^^^^^^^^^\r\n`                                                                                                                                                                                                                                                                                                                                                                                        |
| ⑦ `y = sys.stdin.readline()` 중 `abc`                | `^CTraceback (most recent call last):\r\n  File "<python-input-5>", line 1, in <module>\r\n    y = sys.stdin.readline()\r\nKeyboardInterrupt\r\n` + `<프롬프트>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

부수 관측:

- ⑤ 이어서 `x` 조회 → `NameError: name 'x' is not defined`(취소된 `input()`은 대입하지 않는다).
- ⑤·⑥의 `input()` 프롬프트(`x: `, `in f: `)는 raw mode에서 `\x1b[?25l`로 감싸 나오고, 타이핑한
  `abc`는 `\x1b[1@a\x1b[1@b\x1b[1@c`(삽입 모드 에코 = _pyrepl이 그린다).
- ⑦의 `abc`는 `b'abc'` 그대로 돌아온다(tty 드라이버의 cooked mode 에코). `^C`도 드라이버가 찍는다.

## 요지 표

| 케이스                   | `KeyboardInterrupt` 앞 개행   | 뒤 개행 | `^C` 에코 | 프레임 수(사용자 + `_pyrepl`) | 소스 줄 |
| ------------------------ | ----------------------------- | ------- | --------- | ----------------------------- | ------- |
| ① 빈 `>>> `              | 1 (`\r\n`)                    | 1       | 없음      | 0                             | 없음    |
| ② `>>> abc`              | 1                             | 1       | 없음      | 0                             | 없음    |
| ③ `... `                 | 1                             | 1       | 없음      | 0                             | 없음    |
| ④ 블록                   | 1                             | 1       | 없음      | 0                             | 없음    |
| ⑤ `input(prompt)`        | **0** (입력 줄에 바로 붙는다) | 1       | 없음      | 1 + 4                         | 있음    |
| ⑥ 함수 안 `input()`      | **0**                         | 1       | 없음      | 2 + 4                         | 있음    |
| ⑦ `sys.stdin.readline()` | 0 (`^C` 뒤 바로)              | 1       | **있음**  | 1 + 0                         | 있음    |

## 설계 문서(02a·02b) 서술과의 대조

| 서술                                                                                        | 측정                                                                                                   | 판정          |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------- |
| 프롬프트 취소는 빈 버퍼여도 `\r\nKeyboardInterrupt\r\n`이다("빈 버퍼면 생략"은 배제된 변이) | ① 그대로                                                                                               | **일치**      |
| 프롬프트 취소에 `^C` 에코가 없다(raw mode)                                                  | ①②③④ 전부 없음                                                                                         | **일치**      |
| 프롬프트 취소는 블록 깊이와 무관하게 같은 한 줄이다                                         | ②③④가 ①과 바이트 동일                                                                                  | **일치**      |
| `input()` 취소의 트레이스백은 입력 줄에 **개행 없이 붙는다**                                | ⑤⑥ 앞 개행 0                                                                                           | **일치**      |
| `input()` 취소는 `_pyrepl` 프레임 4~5개를 노출한다                                          | ⑤⑥ 모두 4개(`readline.py input` → `reader.py readline` → `reader.py handle1` → `unix_console.py wait`) | **일치**(4개) |
| 함수 안 `input()` 취소는 그 프레임을 남긴다                                                 | ⑥에 `in f` 프레임                                                                                      | **일치**      |
| `sys.stdin.readline()` 취소는 `^C`를 에코한다(cooked mode)                                  | ⑦ 그대로                                                                                               | **일치**      |
| 취소는 항상 다음 `>>> `로 돌아온다                                                          | 7건 전부                                                                                               | **일치**      |

**어긋나는 항목 없음.** DELTA-05의 "멈추고 보고" 조건(계획 `checklist.md` 인계 안내)에 해당하지 않아
설계 변경·`pending-issues/` 기록 없이 진행했다.

## 우리 구현과의 차이(편차 등록 근거, DELTA-06)

RD-008 구현이 내는 바이트는 `stdin-callback.test.ts`의 `CONSOLE_TRACEBACK`과 `06-editing.md` 규칙이다.

| 항목                             | 3.14.4 pty                                | RD-008 구현                                                  | 편차              |
| -------------------------------- | ----------------------------------------- | ------------------------------------------------------------ | ----------------- |
| 프롬프트 취소                    | `\r\n` + `KeyboardInterrupt` + `\n`       | 같음(`run(null)` → `writeError`)                             | 없음              |
| `input()` 취소 위치              | 입력 줄에 이어 붙는다(`x: abcTraceback…`) | `\r\n` 뒤 다음 줄에서 시작                                   | **35**            |
| `input()` 취소 프레임            | 사용자 프레임 + `_pyrepl` 4개 + 소스 줄   | `  File "<console>", line 1, in <module>` 하나, 소스 줄 없음 | **35**            |
| `sys.stdin.readline()` 취소 `^C` | 있음                                      | 없음                                                         | 범위 밖 확정(2절) |
