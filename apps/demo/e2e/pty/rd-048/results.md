# 3.14.4 pty 빈 입력줄 Ctrl+D(EOF) 실측 (RD-048, 가설 H3)

- 측정 2026-09-28. 스크립트 `pty_ctrl_d.py`, 원시 로그 `raw.txt`(재현: `PTY_PYTHON=<3.14.4 경로> <하니스 venv>/bin/python
apps/demo/e2e/pty/rd-048/pty_ctrl_d.py`가 같은 폴더의 `raw.txt`를 다시 만들고 같은 내용을 표준출력에도 낸다, 약 15초).
- 인터프리터: `Python 3.14.4 (main, Apr 14 2026, 14:26:14) [Clang 22.1.3]`, 경로
  `/home/jjfive/.local/share/uv/python/cpython-3.14.4-linux-x86_64-gnu/bin/python3.14`(`uv python install 3.14.4`로 설치, venv
  아님·`pyte`·`wcwidth` 없음, `ptyrepl.setup()` 게이트 통과, 불일치=False).
- 하니스: `tools/ptyrepl.py`의 `Session`(pty.fork + pyte). 하니스 venv는 `uv venv --python 3.12`로 만들고
  `pip install -r tools/requirements.txt`(`pyte==0.8.2`·`wcwidth==0.8.4`, `system python3.12`에 `ensurepip`이 없어 uv로 만듦 — 아래
  "## 결정" 대신 여기만 기록: venv 도구가 `uv`로 바뀐 것 외 README 절차와 동일, 대상 인터프리터에는 영향 없음).
- 환경: `TERM=xterm`, 24x80, `PYTHON_COLORS=0`, `NO_COLOR=1`, `PYTHON_HISTORY`는 임시 파일, `-q`, cwd 빈 임시 폴더 — 전부
  `Session.__init__` 기본값(`../README.md` 실행 전제표와 동일). 케이스마다 새 `Session`.

## 요지 (결론 먼저)

**H3 네 항목 전부 참** — 화면 기대값을 그대로 확정해도 된다.

| 항목 | 서술                                                       | 케이스 | 판정   |
| ---- | ---------------------------------------------------------- | ------ | ------ |
| H3-1 | `>>>` 빈 줄 Ctrl+D → 개행 한 번 뒤 종료                    | P1     | **참** |
| H3-2 | `input()` 빈 줄 Ctrl+D → 입력줄 아래 `EOFError` 트레이스백 | P3     | **참** |
| H3-3 | `...` 연속줄 빈 줄 Ctrl+D → 무동작                         | P2     | **참** |
| H3-4 | 글자 있는 `input()` 줄의 Ctrl+D → 커서 뒤 글자 삭제        | P4     | **참** |

## 케이스별 화면·판정

원시 화면 전체는 `raw.txt`. 아래는 판정에 쓴 전이만 옮긴다(`Session.lines()`, rstrip 후 빈 꼬리 제거).

### P1 — `>>>` 빈 줄 Ctrl+D

```
boot:        0|>>>                              cursor(0,4)
Ctrl+D 직후: 0|>>>                              cursor(1,0)   # 개행 한 번, 프롬프트 재출력 없음
종료 코드: 0
```

H3-1 확인: 개행 한 번 뒤 그대로 프로세스 종료(`wait_exit()` 0).

### P2 — `if True:` → `...` 빈 줄 Ctrl+D(무동작) → `pass` Enter Enter(블록 생존)

```
if True: Enter 뒤: 0|>>> if True:          1|...                cursor(1,8)
... Ctrl+D 뒤:      0|>>> if True:          1|...                cursor(1,8)   # 화면 불변
pass Enter Enter 뒤: ...  3|>>>                                  cursor(3,4)
```

H3-3 확인: `...` 빈 줄 Ctrl+D는 화면·커서 완전히 불변(무동작). 블록은 살아 있다 — 이어서 `pass` Enter Enter로 정상 실행되고
다음 `>>>`로 돌아온다.

### P3 — `x = input("p: ")` 빈 줄 Ctrl+D → `EOFError`

```
input() 제출 뒤: 0|>>> x = input("p: ")   1|p:                   cursor(1,3)
Ctrl+D 뒤:       0|p:
                 1|Traceback (most recent call last):
                 2|  File "<python-input-0>", line 1, in <module>
                 3|    x = input("p: ")
                 ...(_pyrepl 내부 프레임 readline.py/reader.py/commands.py)...
                21|EOFError
                22|>>>                                            cursor(23,4)
```

H3-2 확인: 입력줄(`p: `) 바로 아래에서 트레이스백이 시작해 `EOFError`로 끝나고 다음 `>>>`로 돌아온다. 트레이스백 프레임 자체(파일 경로
`_pyrepl/readline.py`·`reader.py`·`commands.py`, `File "<python-input-0>"`)는 웹이 안 내는 3.14 고유 값 — 이미 등록된 편차(트레이스백
모양, 편차 35와 같은 뿌리, checklist 허용 편차)에 해당하고 이 측정으로 새로 바뀌는 결정은 없다.

### P4 — `x = input("p: ")` `abc` ← ← Ctrl+D(커서 뒤 삭제) → Enter → `x` 값

```
abc 입력 뒤: 1|p: abc                             cursor(1,6)
← ← 뒤:      1|p: abc                             cursor(1,4)   # a와 b 사이
Ctrl+D 뒤:   1|p: ac                              cursor(1,4)   # 'b' 삭제(커서 뒤 글자)
Enter 뒤:    1|p: ac    2|>>>                      cursor(2,4)
x 값:        3|'ac'
```

H3-4 확인: 커서 뒤 글자(`b`)만 삭제되고 커서 위치는 그대로. `x`는 `'ac'`.

### P5 — `x = input("p: ")` `abc` Ctrl+D(커서 끝, 무동작 여부)

```
abc 입력 뒤(커서 끝): 1|p: abc                     cursor(1,6)
Ctrl+D 뒤:            1|p: abc                     cursor(1,6)   # 화면 불변
x 값:                 3|'abc'
```

완료 기준 밖(H3 네 항목에 없음)이지만 참고 관찰: 커서가 줄 끝일 때 Ctrl+D는 지울 글자가 없어 무동작 — P1·P2와 같은 "지울 것 없으면
무동작" 결이다(설계 전제의 `Line.delete` 사실과 일치).

### P6 — `import sys; d = sys.stdin.read()` → `l1` Enter → 빈 줄 Ctrl+D → `print(repr(d))`

```
l1 Enter 뒤:  1|l1
빈 줄 Ctrl+D 뒤: 2|>>>                              cursor(2,4)   # EOF로 read() 종료, 다음 프롬프트
repr(d):      3|'l1\n'
```

관찰(완료 기준 밖): `sys.stdin.read()`는 EOF까지 읽은 값을 돌려준다 — 마지막 Enter가 낸 개행까지 포함해 `'l1\n'`(꼬리 개행 있음).

### P7 — `for line in sys.stdin: print(line, end="")` 블록 → `a` Enter `b` Enter → 빈 줄 Ctrl+D → 루프 종료, 이어서 `input()`

```
블록 제출 뒤(대기): cursor(4,0)
a Enter 뒤:  4|a   5|a                              # 4행 입력 에코, 5행 print(line, end="") 출력
b Enter 뒤:  6|b   7|b
빈 줄 Ctrl+D 뒤: 8|>>>                              cursor(8,4)   # 루프 EOF로 종료, 다음 >>>
input() 재호출 뒤: 8|>>> input()                     cursor(9,0)   # 새 프롬프트로 대기(즉시 EOFError 아님)
정리용 Ctrl+D 뒤: Traceback ... EOFError   ...       cursor(23,4)  # 이 Ctrl+D에서야 EOFError
```

관찰(H1 재료, 완료 기준 밖): 루프가 EOF로 끝난 뒤 같은 실행 안에서 `input()`을 다시 부르면 **즉시 `EOFError`가 나지 않고** 새 읽기로
대기한다 — CPython `io`/`_pyrepl` 층이 EOF를 "기억"하지 않고 매 읽기마다 새로 판정한다. `input()`이 실제 `EOFError`를 내려면 그 읽기에
다시 빈 줄 Ctrl+D를 보내야 했다. H1(같은 run에서 EOF 뒤 `input()`이 콜백을 다시 부른다)과 같은 방향의 네이티브 증거 — `[C8]`(실제 pyodide) 확인 대상이다.

## 웹 결정과 다른 점 (편차 재료)

- 트레이스백 모양(P3·P7): `File "<python-input-N>"`·`_pyrepl` 내부 프레임 3~4겹. 웹은 `File "<console>"` 한 줄, 내부 프레임 없음 —
  기존 편차(35 계열)와 같은 뿌리, 새 편차 아님.
- 그 외 H3 네 항목·P5·P6·P7의 루프 종료/재읽기 모양은 설계가 이미 기대하는 값과 어긋나지 않았다. 이 측정만으로 새로 등록할 편차는
  트레이스백 모양 하나뿐이다.
