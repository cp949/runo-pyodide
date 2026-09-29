# CPython 3.14 기본 REPL 대비 편차와 범위 밖

동등성 기준은 CPython 3.14.4를 pty(24×80, `TERM=xterm`)로 띄운 실측이다.

- 아래는 확정한 편차·범위 밖 목록이다.
- 정책을 바꾸려면 이 문서에 근거를 기록한다.

## 1. 문서화된 편차

비동기 채널·구조 선택에서 온 것:

1. **프롬프트 대기 중 asyncio 콜백이 돈다**(RD-021).
   - 3.14 기본 REPL은 돌 루프가 없다. `python -m asyncio`는 돈다.
   - `python -m asyncio` 쪽으로 정렬한 의도적 선택이다.
2. **배경 콜백이 CPU를 잡으면 프롬프트에서 Ctrl+C가 2회 필요**하다. 첫 번째는 읽기 취소, 두 번째가 SIGINT.
3. **배경 콜백의 `input()`은 REPL 줄을 Enter한 뒤에야 시작**한다(REPL 읽기 활성 중 stdin 읽기를 미루는 가드).
4. **프롬프트가 열린 채 온 배경 출력은 입력줄 위에 나오고 입력줄은 그 아래에 다시 그려진다**(RD-022b).
   - 3.14 기본 REPL은 프롬프트 대기 중 배경 콜백이 돌지 않아(편차 1) 대응 동작이 없다.
   - 규칙: asyncio task·`call_later` 콜백·전역 stdout/stderr 출력이 오면 입력줄(프롬프트 첫 행부터 입력 마지막 행까지)을 지운다.
     - 출력을 쓴 뒤 같은 읽기(버퍼·커서)를 그 아래에 다시 그린다.
     - 예: `>>> pri` + `tick\n` → `tick` / `>>> pri`.
   - 개행 없이 끝난 조각은 프롬프트 앞 접두로 그린다.
     - 예: `tick>>> pri`. `\r`은 제자리 갱신이다(`50%>>> pri`).
     - 다음 출력이 그 행을 이어 쓴다. ` tock\n`이 오면 `tick tock` / `>>> pri`다.
   - `\r`로 끝나는 진행률 조각(`print(f"{p}%", end="\r")`)은 마지막으로 보이는 값을 접두로 보관한다.
     - 예: `100%>>> pri`. 실제 터미널이라면 커서가 행 머리라 프롬프트가 덮어쓴다.
     - 다음 조각은 행 머리부터 계산한다. 이어지는 `\n`이 `100%` 행을 남긴다.
   - 접두 안의 `\r` 갱신은 겹쳐 쓰기가 아니라 꼬리 규칙이다.
     - 긴 값 뒤 짧은 값은 뒷글자가 남지 않는다. 예: `tick` 뒤 `\r50%` → `50%`.
     - 실제 터미널은 `50%k`가 된다.
   - 접두의 제어 문자도 같은 꼬리 규칙에서 정규화한다.
     - BS는 본문 마지막 글자를 지운다. 예: `|\b/` → `/`. 실제 터미널은 커서만 옮겨 `ab\b`가 `ab`로 남지만 우리는 `a`다.
     - BEL 등 나머지 C0·DEL은 제거한다. 실제 터미널은 BEL을 울린다.
     - CSI 시퀀스(`\x1b[?25l` 등)는 폭 0으로 센다(`05-output.md` 4.4).
   - Enter·취소 뒤 접두는 그 행과 함께 남고 다음 프롬프트는 `>>> `다(`05-output.md` 4.4).
   - 브라우저 확인: `bg-output-check.mjs` B01~B08.
   - **`python -m asyncio`(3.14)가 같은 상황에서 그리는 모양은 측정하지 않았다.** 편차 1의 정렬 기준이지만 이 화면 규칙은 3.14와 대조한 것이 아니다.
   - 편차 54·55는 이 규칙의 세부 차이다.
   - `input()` 읽기 위 배경 출력은 현재 worker 출력으로는 생기지 않는다. worker가 `input()` 동안 멈춰 있다(`05-output.md` 4.4 "적용 범위").

버퍼링:

5. **stdout 버퍼링 미모사**: flush 없는 `print("t", end="")` 뒤 `input()`을 읽으면 웹은 `t`를 즉시 내고 3.14는 입력이 끝난 뒤에 낸다. `input("x: ")`는 3.14처럼 `x: abc` 한 줄이다.
6. **stderr line buffering 미모사**: 개행 없는 `sys.stderr.write("raw-err")`를 웹은 즉시 내 `raw-err7`이 되고, 3.14는 다음 flush에 낸다.

history·입력:

7. **붙여넣기·Shift+Enter·재호출한 블록의 실행이 Enter 1회**(3.14는 한 번 더).
8. **블록 안에서 history에 닿을 수 없다**(3.14는 ↑ 두 번). Ctrl+C로 취소한 뒤 ↑를 쓴다.
9. **history가 중복을 제거한다**(3.14는 안 한다). 다중 줄 항목에서 편집 전 ↑는 바로 이전 항목으로 넘어간다(3.14는 줄 단위 이동).
10. **붙여넣은/Shift+Enter로 만든/재호출한 블록의 둘째 줄부터 `... ` 접두사가 없다**.
11. **문법 오류가 즉시 표시된다**(3.14는 다중 줄 입력에서 빈 줄 뒤).
12. **Backspace dedent 단위 차이**: 웹은 단위 배수까지, 3.14는 이전 줄들의 더 얕은 수준까지. 2칸·4칸 혼용 블록에서 다르다. 탭 들여쓰기는 1글자씩.
    - `pending` + 현재 버퍼로 3.14 `backspace_dedent`를 이식하는 것은 원리적으로 가능해 보인다. 후속 후보다.
    - 현재는 단위 배수를 유지한다.
13. **본문 없는 중첩 블록**(`if True:` / `    if True:` / `    pass`)의 문구는 3.14와 같은 `IndentationError`다. 즉시 표시(편차 11)만 남는다.
    - pyodide 콘솔이 내는 `_IncompleteInputError: incomplete input`은 재컴파일로 표준 문구로 바꾼다(`02-console-core.md` 5.1).
    - `1 +`·`foo bar`·블록 안 `1 +`는 3.14.4 pty와 캐럿 위치까지 같다.
14. **프리필이 있는 동안 ↑가 history를 탐색하지 않는다**. `... ` 입력줄의 ↑는 무동작(3.14는 이전 줄로 커서 이동).
15. `input()` 대기 중 붙여넣은 여러 줄은 첫 줄만 값으로 쓰인다. 탭은 8칸 폭으로 표시된다.

블록 히스토리(RD-014, `06-editing.md` 6.4):

- `... `에서 Enter 1회로 제출한 여러 줄(붙여넣기·Shift+Enter)은 블록 항목 하나에 이어진다.
- 블록을 끝낸 뒤의 top-level 문장도 같은 항목에 남는다.
- 3.14도 붙여넣기는 한 항목이다. 이 규칙 자체는 편차가 아니다.
- `>>> `에서 블록을 열어 둔 채 끝나는 붙여넣기 뒤 `... ` 줄이 같은 항목에 이어지는 경로는 **구조적으로 불가능하다**(재현 실패가 아니다).
  - 이유: `worker/submission-runner.ts`의 `runMultiline`/`runChunk`이 `pending`을 돌려주는 경로가 없다.
  - Python 버전과 무관하다.

Tab 완성:

16. **`[ not unique ]`·`[ complete but not unique ]` 계열 메시지가 없다.**
    - 목록이 스크롤백에 남고 입력줄이 목록 위아래로 중복된다.
    - 메뉴 필터·쪽 넘김·선택 UI가 없다.
17. **`input()` 안 Tab 무동작**(3.14는 완성한다).
18. **환경 모듈 집합 차이**: 빈 cwd 기준 3.14 pty `import ` 후보 192개(3.14.4), pyodide 178개(314.0.7).
    - pyodide에 없는 것: 네이티브에만 있는 밑줄 없는 모듈(`curses`, `dbm`, `ensurepip`, `grp`, `idlelib`, `pip`, `pwd`, `pydoc_data`, `readline`, `resource`, `syslog`, `tkinter`, `turtle`, `turtledemo`, `venv`)과 밑줄 모듈.
    - pyodide에만 있는 것 중 `pyodide`는 `import ` 빈 스템 후보에 남는다.
    - `_test*`는 `import _` 스템에서 후보에 남는다. `INTERNAL_PREFIXES`가 `_pyodide`·`___`로 시작하는 것만 거른다.
    - 집합은 `ModuleCompleter().get_completions('import ')`로 실측했다.
    - `import ` 목록: 3.14는 쪽으로 넘기고 `N more...`를 붙인다. 이 저장소는 후보를 한 번에 그린다(편차 16).
19. **번들 pyodide는 Python 3.14.2, 기준 pty는 3.14.4**.
    - 코퍼스 대조에서 zip 보정 뒤 파서 결과 차이는 없었다.
    - 소스 차이 자체를 배제하지는 않았다.
20. **미로드 배포 패키지는 후보에 없다**(numpy 등).
21. **열 정렬은 문자열 길이 근사**(전각 문자 2칸 미반영).
22. **새 세션에서 `sys`가 REPL 전역에 있어 `s` 후보에 섞인다.**(해소)
    - `createConsole`이 `sys.ps1/ps2`를 `pyimport("sys")` proxy에 JS에서 대입한다. `__main__`에 `sys`가 남지 않는다.
    - 새 세션·세션 리셋 뒤 `"sys" in globals()`는 `False`다(`worker/console.test.ts`, `e2e/checks/tab-check.mjs` C11a).
    - 번호는 다른 문서가 참조하므로 유지한다.
23. (동등) 3.14의 삽입 quirk는 그대로 따른다: `import os.pa  # c` Tab → `import os.pa  # cs.path`.

Tab 완성 배선(RD-015, `07-tab-completion.md` 7.1·`06-editing.md` 6.5):

- **붙여넣기 토큰이 Tab 판정을 건너뛴다.**
  - 벤더 `readPaste`는 `onKey`를 거치지 않는다.
  - Tab, 붙여넣기, Tab 순서로 치면 `lastKeyWasTab`이 붙여넣기에 반응하지 않고 유지된다.
  - 두 번째 Tab도 "연속 두 번째"로 판정된다. 첫 Tab처럼 삽입/공백이 아니라 목록이 열린다.
- **Tab 완성 중 Ctrl+C는 `exec()`/`eval()` 경계에서 한계가 있다.**
  - 사용자 코드가 REPL 프롬프트에 직접 입력된 경로(컴파일 파일명이 `<console>`)에서는 완성 계산(`console.complete`) 중 Ctrl+C가 즉시 `KeyboardInterrupt`로 복귀한다(실측).
  - `exec()`/`eval()` 등으로 정의된 코드(파일명이 `<console>`이 아님)의 `__getattr__`/`__repr__`이 블로킹이면 완성 평가가 멎을 수 있다.
  - 이유: worker `sigint-handler.py`가 `co_filename == "<console>"` 규칙으로만 사용자 코드 실행 중을 인식한다. 그런 프레임을 못 알아본다.
  - RD-012 계열 기존 설계다.

Ctrl+C·sleep:

24. **사용자 코드가 스스로 일으킨 SIGINT 무시**: `signal.raise_signal(SIGINT)`·`_thread.interrupt_main()`. 사용자가 자기 SIGINT 핸들러를 걸면 연타 보호가 사라진다.
25. **동기 XHR 대기 중 Ctrl+C 미반영**(2절 "RD-012g" 참고).
26. **sleep 중 이벤트 루프 정지의 부작용**: `Future`·`js.setTimeout` 콜백·`pyodide.http` 요청도 진행하지 않는다. `while not task.done(): time.sleep(0.01)` 같은 루프는 CPython처럼 끝나지 않는다.
27. **`time.sleep` 대기 중 워커 스레드 한 코어 100% 점유**(JSPI 환경).
28. **코루틴 프레임 안의 동기 `time.sleep`을 중단하면 트레이스백이 두 번 나오고 첫째에 우리 내부 파일명이 보인다**(해소, RD-009a).
    - 증상: `async def main(): time.sleep(...)`처럼 코루틴 안에서 동기 `time.sleep`(조각 래퍼)을 직접 부른다.
      - 그 코루틴을 `asyncio.run(main())`·`run_sync(main())`으로 돌리면 트레이스백이 두 번 찍혔다.
      - 첫째에 `<sigint-handler>`·`<sleep-slice>` 프레임이 남았다.
    - 기전:
      - pyodide C `wrap_exception_inner()`의 `PyErr_Print()`가 `sys.excepthook`(`traceback.print_exception`)을 부른다.
      - 콘솔 실행 중에는 `sys.stderr`가 `_WriteStream` 콜백이다. pyodide `capture_stderr()`(fd 2만 리다이렉트)를 우회해 화면으로 샌다.
    - 범위:
      - `run_sync` 계열로 들어간 awaitable이 **어떤 예외로든** 끝나면 발생했다. KeyboardInterrupt 한정이 아니다. ValueError·SystemExit도 같았다.
      - 같은 코루틴이 `await`로만 기다리면 우리 프레임이 없었다(콜백 경계를 넘지 않는다).
    - 해소:
      - `guard`가 `BaseException`을 홀더 `Raised(exc)`로 담아 정상 값으로 Task를 끝낸다. 예외가 JS 경계를 넘지 않는다. excepthook은 건드리지 않는다.
      - `run_sync` 래퍼가 `raise result.exc`로 사용자 스택에서 그 객체를 올린다.
      - 나르기 전 우리 프레임만 다듬는다. `formattraceback` 절단 규칙을 바꿔 코루틴 안 사용자 프레임(`main` 등)은 남긴다.
    - 남는 것:
      - 설치 가드에 걸려 래퍼가 없으면 pyodide 원본 동작(중복 인쇄)으로 돌아간다.
      - 사용자가 직접 `traceback.print_exc()`를 부르면 `run_sync` 래퍼·`webloop.py` 프레임이 남는다. 실제 호출 경로라 다듬지 않는다.
29. **`<console>` 프레임 없는 콜백 안의 `time.sleep`**(예: `exec("async def …")`로 정의한 코루틴을 `asyncio.run`으로 실행)은 Ctrl+C가 sleep이 끝난 뒤에야 반영된다.
30. **`warnings` 출력의 파일명**이 `<console>`이다(3.14는 `<python-input-N>`). 범위 밖.
31. **확인 범위**: 위 측정은 모두 Chromium(대개 headless, 개발 서버) 한 대 기준이다. Firefox·Safari·`sync=false` 폴백은 미확인.

읽기 없는 구간:

32. **읽기가 활성이 아닌 동안 친 키는 버려진다**(해소, RD-019).
    - 벤더 `Readline`이 그 구간의 키를 쌓았다가 다음 읽기에서 순서대로 재생한다. 3.14의 tty 입력 큐와 같다(규칙은 `06-editing.md` 6.7).
    - 실행 중 `abc` → 다음 프롬프트 `>>> abc`(커서 끝).
    - 실행 중 `print(1)`+Enter → 끝난 뒤 제출. 다음 읽기가 `input()`이면 그 값이 된다.
    - 근거: 브라우저 `type-ahead-check.mjs` T01~T09·T11. 3.14.4 pty와 필수 4건이 일치한다(`apps/demo/e2e/pty/rd-019/results.md`).
    - 번호는 다른 문서가 참조하므로 유지한다.
    - 남은 차이는 45~49다.
    - Ctrl+C·Ctrl+L은 쌓지 않는다. 창 안 Ctrl+C는 에코·전송이 없다(RD-007, `03-ctrl-c.md` 2.7).
      - main 게이트(`pythonRunning`)가 `readLine` 요청 도착부터 응답까지 닫혀 있다(`03-ctrl-c.md` 2.7).
      - 이 Ctrl+C는 쌓인 키를 비운다(6.7).
    - 브라우저 하니스는 새 프롬프트가 보인 뒤에 입력한다(`docs/traps/TRP-005`). Ctrl+C에는 지금도 해당한다.

값 에코:

33. **값 에코가 `sys.displayhook`을 거치지 않는다.**
    - worker가 값의 `repr()` 전체를 만들어 `writeOutput`으로 낸다. `builtins._`는 `repr` 성공 뒤 갱신한다. 절단은 없다.
    - 사용자가 `sys.displayhook`을 바꿔도 반영되지 않는다.
    - `repr()`가 예외를 내면 트레이스백은 `__repr__` 프레임부터 나온다. 3.14의 첫 프레임(`File "<console>", line 1, in <module>`)이 없다.
    - 이유: 값이 이미 반환된 뒤 `repr`를 부른다.

stdin 읽기의 끝:

34. **(해소, RD-048)** ~~`sys.stdin.read()`·`readlines()`·`for line in sys.stdin`은 EOF(Ctrl+D)가 없어 줄마다 다시 읽고 끝나지 않는다~~
    - 빈 입력줄의 실제로 친 Ctrl+D가 메일박스 EOF 표식(`STATE_EOF`)을 거쳐 pyodide EOF가 된다. 셋 다 3.14처럼 끝난다(`06-editing.md` 6.9, `01-protocols.md` 2.2).
    - `input()`·`readline()`도 같은 규칙이다. pyodide 314.0.7 `LegacyReader`가 콜백의 `null`을 EOF로 해석한다.
    - `read(n)`·`readlines(hint)`처럼 상한이 있는 읽기가 한 줄 뒤 콜백 없이 채워지는 것은 그대로다(`docs/traps/TRP-010`).
    - 남은 편차 하나: **`read()` 중 글자가 있는 미완성 줄에서 Ctrl+D를 치면 3.14 cooked tty는 그 줄을 개행 없이 즉시 그 읽기로 넘긴다(부분 줄 flush). 웹은 커서 뒤 글자만 지운다.**
      - 웹 동작은 6.1 `Line.delete`다. `input()`에서도 같다.
      - `input()` 쪽은 pty P4·P5로 3.14와 일치를 확인했다.
      - 이 cooked flush 동작은 RD-048 범위 밖이다.
    - pty 실측 P6은 웹과 일치했다. `sys.stdin.read()`가 EOF까지 읽은 값을 그대로 돌려준다. 마지막 Enter의 개행을 포함해 `'l1\n'`이다.
    - pty 실측 P7은 웹과 일치했다. `for line in sys.stdin`이 EOF로 끝나고 이어지는 `input()`이 즉시 `EOFError`를 내지 않는다(H1).
    - P6·P7의 시험은 `runner-pyodide.test.ts` "[C8]"이다.

`input()` 취소:

35. **`input()` 취소의 트레이스백이 입력 줄 아래에서 시작하고 `_pyrepl` 프레임·소스 줄이 없다.**
    - 3.14.4 pty 실측(RD-008): Ctrl+C 응답이 개행 없이 `Traceback (most recent call last):\r\n`부터 시작한다.
      - 화면에서는 `x: abcTraceback (most recent call last):`처럼 입력 줄에 붙는다.
    - 3.14 프레임은 4개다.
      - `File "<python-input-0>", line 1, in <module>` + 소스 줄.
      - `_pyrepl/readline.py`(`input`).
      - `reader.py`(`readline`).
      - `reader.py`(`handle1`).
      - `unix_console.py`(`wait`).
    - 우리는 `\r\n` 뒤 다음 줄에서 시작한다. 3줄뿐이다(소스 줄·`_pyrepl` 프레임 없음).
      - `Traceback (most recent call last):`
      - `  File "<console>", line 1, in <module>`
      - `KeyboardInterrupt`
    - 함수 안 취소는 그 프레임(`File "<string>", line 2, in f`)이 더해진다.
    - 프레임 흉내는 범위 밖이다.
    - 개행은 sink의 println 계약(끝 개행을 sink가 붙인다)과 얽혀 있다.
36. **`input()` 취소 직후 연타의 두 번째 눌림부터 `^C`가 에코되어 트레이스백 앞에 붙는다.**
    - 취소에는 게이트 항 `cancelSettling`을 세우지 않는다(`04-stdin-input.md` 3.1).
    - 두 번째 눌림은 `setCtrlCHandler` 경로로 가 `^C`를 꼬리에 남긴다(`^CTraceback (most recent call last):` 형태).
    - RD-008 브라우저 실측(N=20, 에코된 `^C` 수의 중앙값): 0ms 간격 2회는 1, 5회는 4, 키 반복 20회는 19다.
    - 트레이스백은 모든 셀·모든 시행에서 정확히 1개였다.
    - 3.14도 cooked mode에서 실행 중 `^C`를 에코한다. "Python이 도는 중" 표시로는 옳다.
    - 방어를 걸면 `except KeyboardInterrupt` 뒤 계산 중 Ctrl+C가 무시된다. 걸지 않는 쪽을 골랐다.
37. **`... ` 프롬프트 취소 연타는 여러 눌림이 `KeyboardInterrupt` 한 줄로 합쳐진다.** `cancelSettling`이 취소 응답 뒤 구간을 덮어 `^C`도 찍히지 않는다.
    - RD-008 실측(N=20): 0ms 2회·5회·키 반복 20회 모두 `^C`가 0개다.
    - `KeyboardInterrupt` 줄 수 중앙값은 1이다. 5회·키 반복에서 드물게 2가 나온다. 두 번째 취소가 새 읽기가 열린 뒤에 떨어진 경우다.
    - 3.14는 눌림마다 한 줄을 낸다. 줄 수 차이가 남는다.

정지한 실행 중 Ctrl+C:

38. **Task 밖 콜백(`call_later` 등)에서 난 `KeyboardInterrupt`·`SystemExit`은 조용히 버려진다**(RD-009).
    - 원인: webloop 재보고 억제(`03-ctrl-c.md` 2.8)가 WebLoop의 `_keyboard_interrupt_handler`·`_system_exit_handler`를 no-op으로 바꾼다.
    - 3.14에서는 배경 콜백의 `KeyboardInterrupt`가 프로세스로 올라가 보인다.
    - 웹에서는 콜백 경계에서 사라진다. 콘솔 실행 안에서 난 것은 그대로 화면에 나온다.
    - 이 억제는 정상 중단·`input()` 취소·`exit()`마다 남던 브라우저 `pageerror`를 없애는 대가다.
    - 그 재보고에는 화면에 이미 나간 것 말고 새 정보가 없다.
39. **콘솔 실행 중 JS→Python 콜백이 낸 예외는 트레이스백이 두 번 찍힌다**.
    - `js.Array.of(1).map(lambda *a: 1/0)`처럼 JS가 부른 Python 콜백의 예외를 pyodide가 JS Error로 바꾸며 `PyErr_Print()`로 한 번 찍는다(28번과 같은 기전). 콘솔이 다시 찍는다.
    - 우리 프레임은 없다.
    - `run_sync` 래퍼 밖이라 RD-009a가 다루지 않는다.
    - `sys.excepthook`을 콘솔 실행 전체에 바꾸는 안은 사용자가 바꾼 훅과 충돌해 쓰지 않는다.
    - 3.14에는 대응 경로가 없다.

세션 리셋:

40. **실행 중 Ctrl+L 뒤 꼬리는 다음 프롬프트에 합성된다**(pty는 리셋 대응이 없어 기준 없음).
    - Ctrl+L(화면 지우기)은 벤더 `Readline` 동작 그대로다. 코어는 손대지 않는다(RD-010).
    - 세션 리셋(Python 상태 초기화)과는 별개 기능이다(`08-session.md` 8.1).

여러 줄 제출:

41. **분할 재생의 런타임 트레이스백 줄 번호는 청크 기준**(3.14는 붙여넣은 전체 기준).
    - `split_paste`가 top-level 문장 단위 청크마다 `push`한다. `File "<console>", line N`의 N은 그 청크 안 상대 번호다(RD-011).
    - 파싱·컴파일 단계 오류의 줄 번호는 전체 기준이다. `split_paste`가 청크로 나누기 전에 전체 소스를 검사한다(`02-console-core.md` 5.2).
42. **`input()` 중 Shift+Enter는 개행만 삽입한다**(RD-013).
    - 자동 들여쓰기 프리필·Backspace 단위 삭제와 함께 `input()` 읽기에는 전부 꺼져 있다(`06-editing.md` 6.3). 벤더 원본 동작(개행만) 그대로다.
    - 3.14의 `raw_input`은 Enter로만 제출받고 편집 중 개행 삽입이 없다. 대응하는 3.14 동작이 없다.

선택 복사:

43. **선택이 있으면 Ctrl+C(Shift 무관)가 SIGINT·취소 대신 복사하고 선택을 지운다.**
    - 실행 중이면 인터럽트하지 않는다.
    - `>>> `·`... `·`input()` 읽기 중이면 취소하지 않는다. `^C`도 찍지 않는다(`decideKey`가 선택 유무로 분기, `06-editing.md` 6.6).
    - 선택 시 자동 복사(마우스를 뗀 순간의 `mouseup`)도 3.14 pty에는 없는 동작이다.
    - 3.14 pty에는 선택 개념이 없다. Ctrl+C는 항상 SIGINT다.
    - RD-017. Windows Terminal·VS Code 통합 터미널의 "선택 있으면 Ctrl+C=복사, 없으면 SIGINT" 관례를 따른 의도적 선택이다.

화면 지우기(Ctrl+L):

44. **꼬리가 든 프롬프트(`t>>> `)에서 입력 중인 줄을 두고 Ctrl+L을 누르면 꼬리가 지워지지 않고 그대로 남는다**(3.14는 꼬리까지 지워 `>>> ` + 입력만 남긴다).
    - 실측(`e2e/checks/prompt-join-check.mjs` AD 절): `print("t", end="")` 뒤 `t>>> foo`(입력 `foo`, 아직 제출 전)에서 Ctrl+L을 누른다.
    - 우리 화면: 스크롤백 전체를 지우고 `t>>> foo` 한 행만 남긴다(행 목록 `["t>>> foo"]`, 커서는 그 행 0).
    - 3.14: 화면을 지워 `>>> foo`만 남긴다. 꼬리 `t`가 사라진다.
    - Ctrl+L은 벤더 `Readline`의 화면 지우기 그대로다(편차 40과 같은 코어 정책, RD-010).
    - 지우는 단위가 "입력줄만"이다.
      - 코어가 앞서 합성해 그린 꼬리(`t`)는 입력줄의 일부가 아니라 그 앞 프롬프트 꼬리다. 같이 지워지지 않는다.
      - 코어에 꼬리를 인식해 걷어내는 로직이 없다.
    - `prompt-join-check.mjs` AD 절이 이 실측값을 기대값으로 고정해 회귀를 감시한다.

읽기가 없는 구간의 키 버퍼링(type-ahead, RD-019):

45. **실행 중 친 키를 3.14는 tty가 에코하고, 웹은 다음 읽기에서 입력줄로만 그린다.**
    - 3.14는 실행 중 cooked 모드 tty가 입력을 에코한다.
      - `time.sleep(2)` 중 `abc`는 마스터에서 `abc` 그대로 읽힌다.
      - Enter는 `\r\n`, Backspace·Ctrl+U는 `\b \b`, ESC는 `^[`, Ctrl+C는 `^C`로 읽힌다.
    - 이 에코는 출력 행에 남는다. 프롬프트는 그 행 뒤에 이어 붙는다(`abc>>> abc`, 커서 열 10).
    - 웹은 실행 중 아무것도 그리지 않는다. 다음 프롬프트에서 `>>> abc`(커서 열 7)로 그린다. 벤더 `Readline`이 쌓았다가 재생한다(`06-editing.md` 6.7).
    - 프롬프트 줄의 내용·입력줄 끝 기준 커서 위치는 같다.
    - 3.14.4 pty 실측: `apps/demo/e2e/pty/rd-019/results.md` "실행 중 tty 에코", P1~P4·C1~C5.
46. **실행 중 친 `←`(ESC[D) 뒤 글자가 3.14에서는 사라진다.**
    - 3.14는 실행 시작 시 일반 커서 키 모드(`\x1b[?1l`)를 보낸다. 터미널이 `ESC[D`를 내보낸다.
    - 다음 프롬프트의 `_pyrepl`은 애플리케이션 모드 키(`ESC O D`)만 왼쪽으로 안다. `ESC[D`를 버리고 뒤의 `c`까지 잃는다. 예: 실행 중 `ab` `ESC[D` `c` → `>>> ab`.
    - 웹은 `ESC[D`를 왼쪽으로 해석해 `>>> acb`(커서 `c` 뒤)가 된다.
    - `ESC O D`를 보내면 3.14도 `>>> acb`다(pty C2b).
    - 웹은 이 결함을 따르지 않는다. 재생 결과가 사용자 의도와 같다.
    - 실측: `pty/rd-019/results.md` C2·C2b.
47. **실행 중 친 Ctrl+D는 3.14에서 프롬프트 입력에 NUL 한 개를 남기고, 웹은 아무것도 남기지 않는다.**
    - cooked 모드의 `0x04`(VEOF)가 큐에서 NUL로 남는다. `_pyrepl`이 폭 0 글자로 삽입한다.
    - 화면은 같다. `>>> abc`이고, 빈 입력이면 `>>>`이며, REPL은 종료하지 않는다.
    - 제출하면 3.14는 `SyntaxError: source code string cannot contain null bytes (<python-input-1>)`를 낸다.
    - 웹은 정상 제출한다. 끝에서의 Ctrl+D는 지울 글자가 없어 무동작이다(`06-editing.md` 6.9).
    - 실측: `pty/rd-019/results.md` C4a·C4b.
48. **실행 중 Tab 뒤에 키가 이어지면 웹은 완성을 버린다.** 실행 중 `os.getc` Tab `()`를 친 경우:
    - 3.14: 재생 중 Tab 완성을 동기로 끝내 `>>> os.getcwd()`.
    - 웹: Tab의 worker 왕복 응답 전에 `(`·`)`가 삽입된다.
      - 응답 적용 조건(버퍼·커서가 요청 시점과 같아야 함, `tab-reader.ts` `applyResume`, RD-015)에 걸려 `>>> os.getc()`가 된다.
    - 키 순서 역전·중복은 없다.
    - Tab이 마지막 키이면 둘 다 `>>> os.getcwd`다. 3.14는 아래에 `[ not unique ]` 힌트를 낸다(편차 16).
    - 사람이 왕복(약 25ms)보다 빨리 이어 치는 경우와 같은 기존 경합 규칙의 결과다.
    - 웹 값은 `type-ahead-check.mjs` T11의 실측이다. 타이밍에 의존한다. 3.14 값은 `pty/rd-019/results.md` C5a·C5b.
    - 고치려면 Tab 왕복 중 도착한 키를 왕복 뒤로 미루는 `tab-reader` 변경이 필요하다. 범위 밖이다.
49. **활성 읽기 없이 쌓인 입력이 4096 UTF-16 코드 유닛을 넘으면 웹은 그 덩어리를 통째로 버리고, 3.14는 한 줄 4095자까지 남기고 나머지를 버린다.**
    - 웹 버퍼는 합계 4096 코드 유닛이다.
      - 넘치는 덩어리는 통째로 버린다. 앞에 쌓인 것은 유지하고 이후 작은 덩어리는 수용한다. 알림은 없다.
      - 벤더 단위 시험 "상한 …"과 변이 검사로 고정한다.
    - 3.14.4 pty 실측(`pty/rd-019/results.md` "상한 4096 초과 입력"): 실행 중 `time.sleep(2); v = input()` 뒤 한 줄이 4095자를 넘어도 `input()`이 받은 값은 4095자다.
    - 붙여넣기(한 덩어리) 4096자 초과: 웹은 아무것도 남기지 않고 3.14는 앞 4095자를 남긴다.
    - 키 입력은 한 글자씩 온다. 웹은 앞 4096자를 남기고 이후를 버린다.
    - **여러 줄에 걸친 누적이 4096을 넘는 경우의 3.14 동작은 측정하지 않았다.**
    - 사람이 4096자 넘게 실행 중에 치거나 붙이는 일은 드물다. 웹 정책을 바꾸지 않는다. 서로게이트 쌍·이스케이프 시퀀스 중간 절단을 막기 위해서다.

실행창(RD-022, `14-runner.md`). 기준은 REPL이 아니라 `python main.py`(run마다 새 프로세스)다.

- 아래 편차는 pty 실측이 아니다.
- worker 하나를 재사용하는 구조와 입력 정책에서 오는 차이다.
- 3.14와 나란히 측정하지 않았다.

50. **`run()`이 끝난 뒤에도 남은 `asyncio` task·JS 타이머 콜백의 출력이 나온다.**
    - CPython 스크립트는 메인이 끝나면 프로세스가 종료돼 남은 task가 사라진다. non-daemon 스레드는 기다린다.
    - worker는 살아 있어 이벤트 루프가 계속 돈다.
    - `create_task`·`call_later`로 남긴 콜백은 상태가 `ready`인 동안에도 실행된다. 출력이 화면에 나온다. 취소·대기는 없다.
    - 그 콜백이 `input()`을 부르면 worker가 메일박스에서 정지한다. 상태가 `waiting-input`(run 없음)이 된다. 새 `run()`은 `busy`다(`14-runner.md` 14.3.1).
    - 정리는 `reset()`이다.
51. **`sys.modules`와 인터프리터 상태가 run 사이에 유지된다.**
    - run마다 새로 만드는 것은 `__main__` 이름공간(`console.globals`)뿐이다.
    - 시험이 확인한 것:
      - 이전 run의 변수는 `NameError`다.
      - `import`한 표준 모듈은 `sys.modules`에 남는다.
      - `pyodide.globals`는 오염되지 않는다.
    - 같은 인터프리터를 재사용한다. 모듈 전역 상태·`sys` 속성·`builtins` 수정 같은 인터프리터 수준 변경도 다음 run에 이어질 수 있다. 구조에서 오는 결과이고 항목별로는 확인하지 않았다.
    - CPython은 run마다 인터프리터가 새로다.
    - 초기화는 `reset()`이다.
52. **`input()` 밖에서 친 키·붙여넣기를 버린다.**
    - 3.14 tty는 실행 중 입력을 큐에 쌓아 다음 읽기가 받는다. REPL도 그것을 따른다(편차 32·45~49).
    - 실행창은 벤더 `Readline`을 `typeAhead: false`로 만든다.
      - 읽기 밖 입력(키·붙여넣기·IME 조합 결과·Shift+Enter)을 쌓지 않고 버린다.
      - Ctrl+C·Ctrl+L 단독 입력만 읽기 밖에서도 처리한다.
    - `input()` 프롬프트를 그리는 `read()`의 write 콜백이 오기 전(수 ms)에 친 키도 버려진다.
    - 사양이다. 실행창은 `input()` 중에만 입력을 받는다(ADR-0006, `14-runner.md` 14.5.2).
53. **`import`가 가리키는 pyodide 배포 패키지가 첫 실행에서 자동으로 로드된다.**
    - `PyodideConsole.runcode`가 실행 전에 `loadPackagesFromImports(source)`를 부른다.
    - `import numpy` 같은 줄이 네트워크로 패키지를 내려받은 뒤 성공한다. 로드 중 상태는 `running`이다.
    - CPython은 설치돼 있지 않으면 `ModuleNotFoundError`다.
    - REPL도 같은 `PyodideConsole.runcode`를 거치므로 같은 동작으로 보이나 REPL에서는 확인하지 않았다. 편차 20은 Tab 후보만 다룬다.

열린 읽기 위 배경 출력(RD-022b, 편차 4의 세부). 아래 편차는 3.14와 나란히 측정하지 않았다. 3.14 기본 REPL에는 대응 경로가 없고 `python -m asyncio`는 미측정이다.

54. **읽기 시작 꼬리와 배경 미종결 조각이 함께 있으면 시간 순서가 뒤집혀 보인다.**
    - 읽기를 시작할 때 벤더에 넘긴 프롬프트 문자열 전체(꼬리가 합성된 `a\x1b[0m>>> `)가 붙박이다. 배경 조각은 그 앞 접두로만 붙는다.
    - `print("a", end="")` 뒤 프롬프트에서 배경 `t`(개행 없음)가 오면 출력 순서(`a` → `t`)와 달리 `ta>>> pri`로 그려진다.
    - 완성 행이면 순서가 맞다(`tick` / `a>>> pri`).
    - `runSource`는 화면 순서 그대로 `ta`를 행으로 남긴다(`02-console-core.md` 5.6.3).
    - 시험: repl `run-source.test.ts` "접두와 읽기 시작 꼬리가 함께 있으면(ta>>> pri, 순서 뒤집힘 편차) …"(동기·비동기 write 두 모드).
    - 브라우저 셀은 없다.
55. **Tab 후보 목록 뒤에 이어진 배경 조각은 앞 조각에 이어 쓰이지 않고 별도 행이 된다.**
    - 접두가 있는 채 Tab 목록(`printAbove`)이 그려지면 옛 입력행(`tick>>> pri`)이 목록 위에 남는다. 새 입력행은 접두 없이 그린다.
    - 그 뒤 ` tock\n`이 오면 `tick tock`이 아니라 ` tock` 행이 된다.
    - 배경 출력의 재그리기를 기다리는 중(아직 다시 그리기 전) Tab 목록이 오면 그려지지 않은 접두를 먼저 자기 행으로 쓴다. 목록을 빈 행 없이 이어 쓴다(`t1` / `tick` / 목록 / `>>> pri`, `06-editing.md` 6.1).
    - 시험: 벤더 `print-above-raw.test.ts` "Tab printAbove와 접두".
    - 브라우저 셀은 없다.
56. **배경 `input()`의 `write`와 `readInput` 알림 사이에 REPL 줄 Enter가 끼면 stdin 읽기가 접두 없이 열린다.**
    - 열린 REPL 줄 `>>> x = 41` 위에서 배경 `input("bg> ")`이 `bg> `를 쓰면 접두가 되어 `bg> >>> x = 41`이 된다.
    - 두 알림 사이(다음 메시지 태스크 한 번)에 Enter가 오면 접두는 확정된 행에만 남는다. stdin 읽기에 프롬프트가 없다.
    - 화면은 `["bg> >>> x = 41", "hello"]`다. 경합 없는 경로는 `[">>> x = 41", "bg> hello"]`다.
    - 원인: Enter 처리의 마이크로태스크가 `readInput` 메시지 태스크보다 먼저 돈다. 도착 시 read-guard의 `replOpen`이 이미 false라 접두를 떼지 않는다(`promptRow.detachPrefix`, `04-stdin-input.md` 3.2).
    - 고치지 않는다.
      - 벤더가 Enter 시점 접두를 보관해 폴백으로 꼬리를 채우는 방식을 구현·시험했다(RD-026). 폴백에 닿으려면 떼기 호출 조건을 풀어야 한다.
      - 풀면 접두가 남은 채 `input()` 코드를 Enter로 제출하는 정상 경로에서 접두가 stdin 프롬프트로 다시 그려지거나 `input("name: ")` 프롬프트를 덮을 수 있다. 추정이고 시험하지 않았다.
      - 경합과 정상 지연을 main이 구분할 수단이 없다.
      - 기존 read-guard 시험의 기대값도 바꿔야 한다.
    - 재개 조건: 그 둘을 구분할 수단(알림에 응답 수신 표지 등)이 생길 때.
    - 브라우저 셀은 없다.

top-level await 대기 중 Ctrl+C는 **편차로 등록하지 않는다**.

- 현상: 트레이스백 없이 `KeyboardInterrupt` 한 줄로 끝난다. `except KeyboardInterrupt`로는 잡히지 않는다.
- 우리 구현: 콘솔 task를 취소하고 표지 예외 `IdleInterrupt`를 한 줄로 표시한다. `except asyncio.CancelledError`는 잡고 `finally`는 돈다.
- 이유:
  - 대기 중 Ctrl+C를 task 취소로 처리하고 한 줄만 내는 것은 3.14의 `python -m asyncio`와 같은 동작이다.
  - 우리 TLA 옵션의 기준이 기본 REPL이 아니라 `python -m asyncio`이기 때문이다(편차 1과 같은 정렬).
- 2절 "범위 밖"에도 넣지 않는다. 재현하지 않기로 한 차이가 아니라 차이가 아니다.

## 2. 범위 밖 확정

3.14 pty와의 차이 중 웹에서 원리적으로 재현하기 어렵거나 사용자 시나리오에 닿지 않는 것.

- **stdout 버퍼링 모사**: flush 없는 `print(end="")`를 입력 뒤에 내는 3.14 동작. 웹은 즉시 출력한다(RD-015 정책).
- **`sys.stdin.readline()`의 `^C` 에코**.
  - 3.14.4 pty 실측(RD-008): `abc` 입력 뒤 Ctrl+C가 `^CTraceback (most recent call last):\r\n  File "<python-input-5>", line 1, in <module>\r\n    y = sys.stdin.readline()\r\nKeyboardInterrupt\r\n`이다.
  - 원인은 tty 드라이버의 cooked mode 에코다. `_pyrepl` 프레임은 없다.
  - 우리는 `^C` 없이 같은 3줄 트레이스백을 낸다.
- **꼬리 뒤 블록의 `... `가 꼬리 폭만큼 밀리는 3.14 quirk**.
- **RD-012g 동기 XHR 대기 중 Ctrl+C**:
  - `pyodide.http.open_url`·`pyxhr.get`은 `req.open(…, False)`인 동기 XHR이다. 워커 스레드를 통째로 막는다. 폴링 지점도 감시 타이머도 없다.
  - 3초 지연 서버 N=5 실측: `pyxhr.get`은 응답 뒤 `KeyboardInterrupt`, `open_url`은 눌림 무시.
  - 동기 API 의미를 바꾸지 않는 설계가 필요하다. 시나리오가 드물다.
- **RD-016e 미로드 pyodide 배포 패키지의 import 후보**: 3.14 동등 범위 밖의 pyodide 확장.
  - lockfile 패키지명을 후보에 넣으면 후보 집합이 로드 상태에 의존한다.
  - `from numpy import <Tab>`은 로드 전 속성을 볼 수 없다. 일관성이 깨진다.
