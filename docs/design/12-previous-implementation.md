# 이전 구현(apps/repl) 인벤토리

재개발의 출발점이 된 이전 구현의 기능 목록·상태·모듈 지도다. 새 ROADMAP 항목은 이 문서의 RD 번호를 "이전: RD-0NN"으로 참조한다. 이전 구현 경로는 `/work/cp949/pyodide-samples/apps/repl`(읽기 전용 참고).

## 1. 제품 정의(이전 구현 기준)

브라우저에서 Pyodide(배포판 `314.0.7`, 번들 Python 3.14.2)를 Web Worker 안에서 실행하고, 메인 스레드의 xterm.js 터미널(`@xterm/xterm` 6 + `xterm-readline` 1.2.2, MIT, npm 패키지를 포팅 없이 사용)로 입출력을 연결해, 실제 터미널에서 `python`을 실행한 CPython 3.14 기본 대화형 REPL과 같은 조작감을 목표로 하는 로컬 데모다. REPL 코어는 직접 만든 `compile(..., "single")` 루프가 아니라 Pyodide 공식 `pyodide.console.PyodideConsole`이고, UI는 Vite 8 + React 19 + TypeScript 6 + MUI v9 셸이다. 실행 환경은 로컬 `vite dev`(포트 4321 고정, `strictPort`)로 한정하고 COOP/COEP 헤더(`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`)를 dev 서버에 건다. "동등성"은 주관 판단이 아니라 실측으로 판정한다: 기준은 CPython 3.14.4를 pty로 띄워 `pyte`로 화면을 렌더링하는 측정 하니스(`ptyrepl.py`, `TERM=xterm`)로 얻은 화면 행이고, 웹 쪽은 Playwright(Chromium headless)로 `.xterm-rows > div`의 텍스트 행을 읽어 같은 시나리오의 기대 행과 대조한다. 두 화면이 다르면 "편차"로 문서에 남기고, 재현할 수 없거나 시나리오에 닿지 않는 차이는 "범위 밖"으로 확정한다. Tab 완성처럼 후보 집합 비교가 필요한 항목은 pty 케이스(예: 37케이스 + 추가 4)와 네이티브 대 Pyodide 대조(95케이스), 게이트 코퍼스(53줄)까지 따로 측정했다. 이전 구현은 Worker↔Main 사이에 coincident 동기 브리지를 썼고 새 구현은 쓰지 않는다.

참고: `/work/cp949/pyodide-samples/apps/repl/README.md`, `/work/cp949/pyodide-samples/apps/repl/DESIGN.md`, `/work/cp949/pyodide-samples/README.md`

---

## 2. RD 항목별 인벤토리(이전 번호)

### RD-001 프로젝트 스캐폴딩

**사용자 시나리오**: 개발 서버를 띄우면 빈 화면이 뜬다.
**규칙·결정**

- Vite 8 + React 19 + TypeScript 6, 공용 eslint/tsconfig 프리셋(`./react`, `react-app.json`) 연결.

**완료 기준**

- `dev`로 화면이 뜨고 `lint`·`check-types`가 통과한다.

**이전 구현 상태**: 완료

### RD-002 Worker↔Main 동기 브리지 검증 (핵심 리스크)

**사용자 시나리오**: 화면 상단 Chip 두 개(`crossOriginIsolated`, `worker sync`)가 모두 `true`로 표시된다.
**규칙·결정**

- COOP/COEP 헤더가 없으면 동기 모드가 비동기로 폴백하고 stdin 브리지가 깨진다 — 헤더는 필수 전제.
- 이 단계에서 `sync === true`(SharedArrayBuffer/Atomics 사용 가능)를 가장 먼저 확인한다.

**완료 기준**

- 최소 worker로 왕복 호출이 되고 worker 쪽 `sync`가 참이다.

**이전 구현 상태**: 완료 (새 구현에서는 동기 브리지 자체가 대체 대상)

### RD-003 xterm.js 터미널 마운트

**사용자 시나리오**: 화면에 터미널이 뜨고 타이핑한 글자가 그대로 보인다.
**완료 기준**: 입력 에코가 보인다.
**이전 구현 상태**: 완료

### RD-004 줄 편집·히스토리(readline) 확보

**사용자 시나리오**: 백스페이스·←/→로 줄을 고치고 ↑/↓로 이전 줄을 불러온다. Enter를 누르면 그 한 줄이 프로그램으로 전달된다.
**규칙·결정**

- `xterm-readline`(MIT)을 npm 의존성으로 설치해 그대로 쓴다. 소스 포팅 금지(포크 검토는 보류, 3절).
- `History`의 `localStorage` 자동 저장/복원은 no-op으로 덮어써 비활성화(히스토리 영구 저장은 범위 밖).
- 필요한 API: `read(prompt): Promise<string>`, `println`/`print`, `setCtrlCHandler`.

**완료 기준**

- 줄 편집·히스토리가 동작하고 Enter로 한 줄을 받을 수 있다(아직 Python 연결 없음).

**이전 구현 상태**: 완료

### RD-005 pyodide 로드 및 출력 연결

**사용자 시나리오**: 페이지를 열면 잠시 뒤 터미널에 Python 실행 결과가 출력된다.
**규칙·결정**

- pyodide는 npm 런타임 의존이 아니라 CDN 동적 `loadPyodide`. `pyodide` 패키지는 타입·Node 시험용 devDependency로만 둔다.
- 버전 상수 `314.0.7`을 worker에 고정.

**완료 기준**: 출력만으로 pyodide 실행 결과가 보인다.
**이전 구현 상태**: 완료

### RD-006 stdin 브리지 (이전 시도가 막혔던 지점)

**사용자 시나리오**: `name = input()`을 실행하면 터미널이 입력을 기다리고, 값을 치고 Enter를 누르면 그 값이 Python 변수에 들어가 실행이 이어진다.
**규칙·결정**

- `pyodide.setStdin`의 stdin 콜백은 동기로 문자열을 돌려줘야 한다 — CPython이 동기로 부르므로 이 경로만은 블로킹이어야 한다(RD-021에서도 이 결론은 유지).
- `input()`·`sys.stdin.readline()/read()/readlines()`·`for line in sys.stdin`은 전부 같은 stdin 콜백이라 서로 구분할 수 없다. 규칙은 하나로 통일한다.
- Pyodide의 `sys.stdin.isatty()`가 거짓이라 `input()`도 non-tty 경로로 `readline()`을 거친다(실측).

**완료 기준**: `input()`이 든 코드가 실제 값을 받아 이어서 실행된다.
**이전 구현 상태**: 완료

### RD-006a `input()` 읽기 줄의 프롬프트 표기

**사용자 시나리오**: `input("x: ")`를 실행하고 `abc`를 치면 화면에 `x: abc` **한 줄**로 보인다(고치기 전에는 `x: ` 다음 줄에 `>>> abc`가 떴다).
**규칙·결정**

- 입력 줄의 프롬프트 = **직전 출력의 개행 없는 꼬리**(tail). 3.14.4 pty 실측과 같다: `input("x: ")` → `x: abc`, `input()`·`sys.stdin.readline()` → 프롬프트 없이 `abc`, flush한 `print("t", end="")` 뒤 → `tabc`.
- worker는 프롬프트 문자열을 넘기지 않는다. worker는 `readInput(cancelable)`만 부르고, main이 출력 sink가 추적한 꼬리(열린 SGR 보존)로 입력 줄을 그 자리에 다시 그린다.
- 꼬리가 터미널 폭을 넘으면 읽기 전에 첫 행까지 커서를 올려 앞 행 중복을 막는다.
- 색이 있는 프롬프트는 색을 유지하고 입력한 글자는 기본색이다.

**완료 기준**

- `x: abc` 한 줄, 프롬프트 없는 `input()`, `tabc`·`tp: abc` 이어붙임, 130자·200자·전각·정확히 폭과 같은 프롬프트에서 앞 행 중복 없음.
- 실행 중 Ctrl+C의 `^C`를 `except`로 잡은 뒤 읽으면 `t^Cx: abc`.
- 브라우저 52개 시나리오 통과.

**이전 구현 상태**: 완료 (한계: 꼬리 안의 `\b`·OSC로 열 어긋남, Chromium만 확인)

### RD-006b REPL 프롬프트의 같은 줄 이어붙임

**사용자 시나리오**: `print("t", end="")`를 실행하면 다음 프롬프트가 `t>>> `로 같은 줄에 붙고, 이어 치면 `t>>> abc`가 된다.
**규칙·결정**

- REPL 읽기도 RD-006a의 꼬리 방식으로 `프롬프트 = 꼬리 + ">>> "`(또는 `"... "`)를 그 자리에 다시 그린다.
- 3.14는 프롬프트 직전에 stdout을 flush하므로 flush 없는 `print(end="")`도 `t>>> `다.
- `cursorX !== 0`이면 개행을 넣던 가드는 제거한다(`cursorX`는 xterm이 비동기로 파싱한 값이라 낡을 수 있다).

**완료 기준**

- `t>>> `, 빈 Enter 뒤 열 0의 `>>> `, 블록 실행 뒤 `012>>> `, stderr 꼬리 뒤 `e>>> `(`e`만 빨강), 닫히지 않은 색 뒤 기본색, `\r30%` → `\r100%` 뒤 `100%>>> `.
- 100·130·200자·전각·정확히 80자 꼬리에서 앞 행 중복 없음(정확히 80자는 `>>> `가 다음 행 열 0).
- 세션 리셋 뒤 프롬프트가 이전 꼬리를 물려받지 않는다. 브라우저 74개 시나리오 통과(이후 모든 RD의 회귀 기준선으로 쓰인다).

**이전 구현 상태**: 완료

### RD-007 REPL 루프

**사용자 시나리오**: `>>> `에 `1 + 1`을 치면 `2`가 나오고 다시 `>>> `가 뜬다.
**규칙·결정**

- 식의 값은 `sys.displayhook`이 `repr()`로 출력한다(`None`·대입문은 출력 없음). `runPythonAsync`만 쓰면 값이 안 보인다.
- 변수·import 상태는 세션 동안 유지(persistent interpreter session).

**완료 기준**: 여러 줄을 연속 입력/실행할 수 있다(이 단계에서 블록은 범위 밖).
**이전 구현 상태**: 완료

### RD-008 MUI 셸

**사용자 시나리오**: AppBar 아래 `crossOriginIsolated`·`worker sync` 상태 Chip 두 개가 보이고 그 아래 터미널이 있다.
**완료 기준**: 레이아웃 안에 터미널이 자리잡고 동기화 상태가 화면에 표시된다.
**이전 구현 상태**: 완료

### RD-009 에러 처리

**사용자 시나리오**: CDN 접근이 막혀 pyodide 로드가 실패해도 앱이 죽지 않고 터미널에 에러가 찍힌다. worker가 죽으면 재시작 버튼이 뜬다.
**규칙·결정**

- pyodide 로드 실패는 catch해 터미널 출력. Python 예외는 트레이스백을 빨강으로 출력. worker `error` 이벤트는 main이 감지해 재시작 버튼 제공.
- `crossOriginIsolated`/`sync` 중 하나라도 거짓이면 터미널에 경고를 출력한다.

**완료 기준**: 세 실패 상황을 재현해도 앱이 죽지 않는다.
**이전 구현 상태**: 완료

### RD-010 스모크 테스트·문서

**완료 기준**: 렌더링 스모크 테스트 통과, 실행 방법 문서화.
**이전 구현 상태**: 완료

### RD-011 `PyodideConsole` 기반 REPL 코어 전환 (핵심 리스크)

**사용자 시나리오**: 빈 줄에서 Enter를 눌러도 에러가 나지 않는다. `if True:` Enter → `... ` 프롬프트에서 들여쓴 문장 → 빈 줄로 블록이 끝나고 실행된다. 시작하면 `Python <버전> (...) on <platform>` 배너가 뜬다.
**규칙·결정**

- 수작업 `compile(source, "<stdin>", "single") + exec()` 루프를 버리고 `pyodide.console.PyodideConsole`로 교체한다. 이 전환 하나로 빈 줄 버그, 여러 줄 블록(`if`/`def`/`for`/`while`/`class`/`try`/`with`/`match`, 괄호 미닫힘), 트레이스백의 래퍼 프레임 노출이 함께 해소된다.
- `sys.ps1`/`sys.ps2`(`>>> `/`... `)와 시작 배너를 함께 설정한다.

**완료 기준**

- 빈 줄 무해, 블록 실행, 미완성 블록은 계속 입력, 문법 오류는 즉시 표시, 트레이스백에 `__repl_run`/`push`/`runcode` 프레임 없음, 배너 출력.

**이전 구현 상태**: 완료

### RD-011a 출력 끝 개행 이중 출력 제거

**사용자 시나리오**: `1 + 1` Enter → `2` 바로 다음 줄에 `>>> `가 온다(고치기 전에는 빈 줄이 하나 더 있었다).
**규칙·결정**

- 원인은 이중 개행이다: 호출부가 끝 개행을 붙여 넘기는데 main sink가 `println`이라 또 붙였다.
- 계약 통일: `writeOutput`/`writeError`에는 **끝 개행 없는 텍스트**를 넘긴다. 오류 문자열은 끝 개행을 **정확히 1개만** 떼어 메시지 자체의 개행은 보존한다.
- 적용 경로: 식 값 에코, 트레이스백, SyntaxError, 붙여넣기 파싱 오류, 시작 배너.
- 테스트 fake가 `println`의 개행 추가를 모사하지 않아 이 버그를 못 잡았다 — fake는 실제 sink 동작을 모사해야 한다.

**완료 기준**: 위 다섯 경로 뒤에 빈 줄이 없다(3.14 pty 실측과 같다). 예외 메시지 자체의 끝 개행은 유지. 브라우저 16개 시나리오 행 diff.
**이전 구현 상태**: 완료

### RD-011b stderr 조각의 개행

**사용자 시나리오**: `print("err", file=sys.stderr)` 뒤에 빈 줄 없이 프롬프트가 온다(고치기 전에는 빈 행 2개).
**규칙·결정**

- stderr 조각은 Python이 쓴 그대로(개행 추가·제거 없음) `print` 경로로 낸다.
- 빨강은 조각마다 열고 닫는 **무상태** 방식이며 색은 main sink가 입힌다(worker는 텍스트만 넘긴다). 빈 조각은 아무것도 내지 않는다.
- 트레이스백·SyntaxError는 `stderr_callback`이 아니라 `formatted_error` → `writeError` 경로다. `stderr_callback`은 사용자가 쓴 조각만 받는다.
- sink 4종(`writeOutput`/`writeError`/`write`/`writeErrorRaw`)을 한 모듈로 분리해 실제 sink + Readline으로 시험한다.
- 3.14.4 pty 기준표: `print("err", file=sys.stderr)` → `err\r\n`, `warnings.warn("w")` → `<python-input-N>:1: UserWarning: w\r\n`, `sys.stderr.write("a\nb\n")` → `a\r\nb\r\n4\r\n`.

**완료 기준**: 위 세 호출 뒤 빈 줄 없음, `\r` 진행률 조각 그대로, stdout/stderr 교차 출력 순서 보존, stderr만 빨강. 브라우저 23개 시나리오.
**이전 구현 상태**: 완료 (편차: 개행 없는 조각을 즉시 출력 — 4절)

### RD-012 실행 중 Ctrl+C

**사용자 시나리오**: `while True: pass` 실행 중 Ctrl+C를 누르면 `^C` + `KeyboardInterrupt` 트레이스백이 나오고 REPL이 죽지 않고 다시 입력을 받는다.
**규칙·결정**

- `SharedArrayBuffer` 기반 `Int32Array`를 main↔worker가 공유하고 worker가 `pyodide.setInterruptBuffer`로 연결한다. main은 `buf[0] = 2`(SIGINT)를 쓴다. (RD-012e에서 4칸으로 확장.)
- main의 Ctrl+C 훅은 readline의 `setCtrlCHandler`(읽는 중이 아닐 때만 불린다).
- 세션 리셋/스위치로 worker를 바꿔도 같은 버퍼를 재사용한다. 남은 SIGINT가 새 worker의 시작 코드를 죽이므로 ① main이 넘기기 직전 `buf[0] = 0`으로 비우고 ② worker는 버퍼 연결을 시작 코드 뒤 REPL 루프 직전으로 미루고 연결 전 눌림을 버리며 **버린 눌림도 ack**한다.

**완료 기준**: 무한 루프 중 Ctrl+C로 트레이스백이 나오고 REPL이 계속 산다.
**이전 구현 상태**: 완료

### RD-012a 정지한 실행(sleep/await) 중 Ctrl+C

**사용자 시나리오**: `while True: time.sleep(0.1)` 실행 중 Ctrl+C 한 번 → 200ms 안에 `^C` + `Traceback…KeyboardInterrupt`가 나오고 `>>> `가 돌아온다. top-level await의 `await` 대기는 트레이스백 없이 `KeyboardInterrupt` 한 줄이다.
**규칙·결정**

- 원인: pyodide가 `time.sleep`을 `run_sync(asyncio.sleep(t))`로 바꿔 대기 중 사용자 스택이 정지하고, SIGINT 폴링 지점이 사라진다.
- 채택: worker JS **감시 타이머** + Python SIGINT 핸들러 보완 + `run_sync`·`runcode` 래퍼. 사용자 코드가 실행 중이면 사용자 스택이 없어도 정지한 실행을 깨운다.
- 부수: WebLoop의 `_keyboard_interrupt_handler`·`_system_exit_handler`를 no-op으로 만들어 재보고 `pageerror`(시행당 1~2건)를 없앴다.

**완료 기준**

- 신규 10조합(`time.sleep` 루프 0.1·0.01·1초, 단발 5초, `asyncio.run`, `run_until_complete`, `run_sync`, top-level await 단발·루프, TLA 켜짐의 sleep 루프) 각 N=20 → 220/220, 프롬프트 복귀 최대 27.7ms, `pageerror` 0.
- `KeyboardInterrupt`를 잡고 도는 프로그램이 눌림 3회를 모두 잡는다. 회귀 3종 기준선 유지.

**이전 구현 상태**: 완료

### RD-012b 입력줄 Ctrl+C가 미완성 블록을 취소

**사용자 시나리오**: `if True:` Enter → `... `에서 Ctrl+C → 커서 아래 줄에 빨간 `KeyboardInterrupt` → `>>> `로 복귀 → `print(1)`을 치면 `1`이 나온다(고치기 전에는 `IndentationError`).
**규칙·결정**

- 편집 버퍼와 worker의 `pyconsole.buffer`(미완성 블록)를 함께 버린다.
- 출력 형식(3.14 pty 실측): 프롬프트에서는 `^C`를 찍지 않고 `KeyboardInterrupt` 한 줄만 내며 빈 줄도 없다.
- `>>> ` 입력줄에서도 같다. 취소해도 자동 들여쓰기 단위는 유지한다.

**완료 기준**: 본문이 쌓인 블록·Shift+Enter 버퍼·세션 리셋 뒤에도 같은 동작, 다음 입력에 취소된 글자가 섞이지 않음. 브라우저 24개 시나리오 중 22 통과(E1·E2는 기준선 실패로 고정).
**이전 구현 상태**: 완료

### RD-012c `input()` 중 Ctrl+C

**사용자 시나리오**: `x = input()` 대기에서 `abc`를 치다 Ctrl+C → 입력 줄 아래에 `Traceback (most recent call last):` / `File "<console>", line 1, in <module>` / `KeyboardInterrupt`(빨강, `^C` 없음) → `>>> `로 복귀하고 `x`는 대입되지 않는다.
**규칙·결정**

- 3.14 pty 실측(`x: abcTraceback…`가 개행 없이 붙고 `_pyrepl` 프레임 4~5개)은 **흉내내지 않고** pyodide 표준 트레이스백을 입력 줄 아래에 낸다.
- 메커니즘: worker의 stdin 콜백이 취소 가능한 읽기를 부르고 `null`을 받으면 `interruptBuffer[0] = 2` 뒤 `pyodide.checkInterrupt()`를 부른다. `null`을 그대로 돌려주면 EOF(`EOFError`), 일반 `Error`는 `OSError`가 된다.
- 예외는 호출 지점의 진짜 `KeyboardInterrupt`라 `try/except KeyboardInterrupt`가 잡고 `except Exception`은 못 잡는다.
- 취소한 입력은 history에 남지 않는다.

**완료 기준**: 위 형식, 함수 안 취소는 그 프레임 표시, `sys.stdin.readline()`도 같음, Ctrl+C 연타(0ms 2회·5회, 키 반복 20회)에도 REPL 생존. 브라우저 24개 중 20 통과(A1·C2·H1·J1 고정 실패).
**이전 구현 상태**: 완료

### RD-012d 실행 중 Ctrl+C 연타·키 반복

**사용자 시나리오**: `while True: pass` 중 Ctrl+C를 누르고 있어도(키 반복 30회) 트레이스백이 나오고 프롬프트가 돌아온다(고치기 전 5/5에서 멈춤 또는 worker 크래시).
**규칙·결정**

- 원인: 첫 SIGINT가 사용자 코드를 끊은 뒤 트레이스백 생성 코드(`traceback.py`, `linecache.py`)나 다음 문장 컴파일에 뒤이은 SIGINT가 떨어진다.
- 채택 규칙(Python SIGINT 핸들러): **스택에 사용자 프레임(`<console>`)이 있을 때만** `KeyboardInterrupt`를 올리고, 없으면 그 SIGINT를 버린다.
- 매 실행 직전 `interruptBuffer[0] = 0`으로 비운다. `run()` 전체를 `try`로 감싸 새는 `KeyboardInterrupt`를 취소와 같이 처리한다. 트레이스백에서 핸들러 프레임 줄을 뺀다.

**완료 기준**: 콜드 (a) 0ms 30회, (b) 1·5·20·50ms 30회, (c) 키 반복, (d) 0ms 2·5회, 웜 (a), TLA 켜짐 (a) 각 20/20 → 200/200(수정 전 61/200), 대상 `pageerror` 0건.
**이전 구현 상태**: 완료

### RD-012e Ctrl+C 한 번의 소실 완화

**사용자 시나리오**: `while True: pass` 중 Ctrl+C 한 번이 약 3%에서 조용히 사라져 루프가 계속 돌던 것이 사라진다.
**규칙·결정**

- 원인은 pyodide 폴링(`_Py_CheckEmscriptenSignals_Helper`)이 `r = buf[0]; buf[0] = 0; return r`로 읽기와 비우기를 나눠 그 사이 값이 지워지는 것. pyodide는 고치지 않는다.
- 공유 버퍼 **4칸**: `[0]` SIGINT, `[1]` ack, `[2]` 요청 번호.
- 핸들러·감시 타이머·폐기가 ack를 올리고, main 송신기가 **5ms마다** 점검해 소실된 눌림을 **같은 요청 번호**로 다시 쓴다(**최대 10회**).
- 핸들러는 이미 처리한 번호의 두 번째 도착을 무시한다 → `KeyboardInterrupt`를 잡고 계속 도는 프로그램이 눌림 한 번에 한 번만 중단된다.
- 기각된 대안: 폴링 경로에 접근자 설치(소실 0이지만 폴링당 약 117ns, 3M 루프 1.095~1.118배, `str(i)`류 2.9배).

**완료 기준**: 단일 눌림 소실 0(Node N=3000에서 141·31건 → 0, Chromium N=200에서 5건 → 0), 누락·이중 0, 재전송 복구 지연 Node 최대 15.2ms / Chromium 17.5~20.1ms, 성능 ×1.012·×0.992, 부팅 중 Ctrl+C 30/30 정상.
**이전 구현 상태**: 완료 (한계: 사용자 코드가 스스로 일으킨 SIGINT 무시 등 — 4절)

### RD-012f `time.sleep`을 20ms 블로킹 조각으로 교체

**사용자 시나리오**: JSPI가 없는 환경에서도 `time.sleep(5)` 단발이 Ctrl+C로 끊긴다. sleep 중에는 `create_task`·`call_later` 콜백이 돌지 않고 sleep이 끝난 뒤 진행한다(CPython과 같다).
**규칙·결정**

- `time.sleep(t)`를 JSPI 유무와 관계없이 **20ms 블로킹 조각**의 반복으로 바꾼다. 조각마다 `pyodide_js.checkInterrupt()`로 폴링한다.
- **20ms 이하**는 원본에 위임하되 끝난 뒤 폴링 1회를 넣는다(넣지 않으면 지연이 반복 시간의 약 **13배**까지 늘어난다).
- 무효 인자(`-1`·`'a'`·NaN·inf)는 원본에 넘겨 CPython과 같은 예외를 내고 `0`·`True`는 오류 없음.
- `checkInterrupt()`를 지난 `KeyboardInterrupt`가 남기는 추가 트레이스백은 **폴링 동안만** `sys.excepthook`을 비워 없앤다.

**완료 기준**: Node(JSPI 없음·있음, N=30) `sleep(5)` 단발과 `0.1`·`0.02`·`0.015`·`0.01` 루프 30/30 중단, 눌림→출력 최대 12.4~25.8ms, `stderr`가 표준 트레이스백과 정확히 일치. 브라우저 12조합 N=20 → 240/240, 복귀 중앙값 13.1~26.5ms·최대 32.3ms.
**이전 구현 상태**: 완료

### RD-012g 동기 XHR 대기 중 Ctrl+C

**상태**: 보류(범위 밖 확정). 3절 참고.

### RD-012h Python이 돌지 않는 구간의 Ctrl+C 잔류

**사용자 시나리오**: 부팅 중(worker가 버퍼를 연결한 뒤 핸들러 설치 전) Ctrl+C를 눌러도 시작 코드가 죽지 않는다.
**규칙·결정**

- (b) **핸들러를 버퍼 연결보다 먼저 설치**한다(연결 전에는 폴링이 없다). worker는 둘을 묶은 함수 하나만 부른다. — 완료.
- (a) `readLine` 진입 갭(17~33ms)의 송신기 되살아남, `exit()`·로드 실패 뒤 송신기 잔류 → "Python 정지" 플래그 후보. 미검증, RD-021 뒤 재평가(RD-021의 프롬프트 유휴 SIGINT 폐기로 잔류 (1)은 해소).

**완료 기준**: (b)는 실제 pyodide 시험 4개 + 브라우저 `boot-press` N=30 30/30. (a)는 미정.
**이전 구현 상태**: 일부 ((b) 완료, (a) 대기)

### RD-012i `asyncio.run` 코루틴 안 KeyboardInterrupt의 중복 트레이스백

**사용자 시나리오**: `asyncio.run(main())`의 `main` 안에서 Ctrl+C를 누르면 표준 트레이스백 **앞에** `<sigint-handler>` 프레임이 낀 트레이스백이 한 번 더 나온다.
**규칙·결정**

- 원인: `run_sync(guard(…))`가 예외로 끝난 Task를 JS로 변환할 때 `PyErr_Print`이 `sys.excepthook`으로 stderr에 찍는다.
- 후보: `guard`가 코루틴 안의 `KeyboardInterrupt`를 예외 대신 **값**으로 돌려주고 `run_sync` 래퍼가 사용자 스택에서 다시 올린다(예외 정체성·`finally` 순서 확인 필요).
- 기각: `run_sync` 대기 전체 동안 `sys.excepthook`을 비우는 안(JSPI 정지 중 다른 콜백이 훅이 바뀐 채 돈다).

**완료 기준**: 착수 시 확정(중단 뒤 stderr가 표준 트레이스백과 정확히 일치).
**이전 구현 상태**: 대기(미착수)

### RD-012j `time.sleep` 대기 중 워커 CPU 점유

**상태**: 보류. 3절 참고.

### RD-013 선택 영역 복사

**사용자 시나리오**: 마우스로 출력 텍스트를 선택한 뒤 복사 단축키를 누르면 클립보드에 그대로 들어간다(고치기 전에는 Ctrl+C가 전부 SIGINT류로 소비돼 복사가 안 됐다).
**완료 기준**: 선택 텍스트가 정확히 복사되고 기존 Ctrl+C(실행 중단/줄 취소)는 그대로다.
**이전 구현 상태**: 완료

### RD-014 세션 리셋 + 종료 정책

**사용자 시나리오**: 상단 `세션 리셋` 버튼을 누르면 변수·import가 전부 사라지고(화면 스크롤 기록은 유지) 새 세션이 시작된다. `exit()`/`quit()`/`raise SystemExit()`를 실행하면 "Python session terminated." 안내가 뜨고 리셋 버튼으로 새 세션을 연다.
**규칙·결정**

- "화면 지우기"(Ctrl+L, main 쪽 순수 UI 동작 — Python 상태를 건드리지 않음)와 별개 기능이다.
- RD-009의 크래시-재시작 메커니즘을 재사용한다. `SystemExit`은 평범한 예외로 잡혀 REPL이 죽지 않음을 실측으로 확인했으므로 `on_fatal` 훅은 불필요.
- 세션 리셋 때 입력을 기다리던 블록은 버리고 이미 제출된 블록은 남긴다.

**완료 기준**: 위 두 시나리오.
**이전 구현 상태**: 완료

### RD-015 출력 스트리밍 (raw stdout, `\r` 진행률)

**사용자 시나리오**: `print("x", end="")`가 다음 개행을 기다리지 않고 바로 보인다. `for i in range(5): print(i); time.sleep(1)`이 1초 간격으로 하나씩 나온다. `print("\rProgress 50%", end="")`가 같은 줄에서 갱신된다.
**규칙·결정**

- `setStdout`의 `batched` 모드를 버리고 raw 모드로 전환한다.
- 정책: stdout 버퍼링은 모사하지 않는다(웹은 즉시 출력, 3.14는 flush 없는 `print(end="")`를 입력 뒤에 낸다) — 4절 편차.

**완료 기준**: 위 세 가지.
**이전 구현 상태**: 완료

### RD-016 Tab 완성 (이름·속성)

**사용자 시나리오**: `>>> a.` 뒤 Tab을 누르면 후보가 하나면 즉시 삽입되고, 여럿이면 공통 접두사만 채워진다. 같은 자리에서 Tab을 한 번 더 누르면 후보 목록이 열 우선으로 출력되고 입력줄이 새 행에 다시 그려진다.
**규칙·결정**

- 동등성 기준은 CPython 3.14 `_pyrepl`의 pty 실측.
- 후보 1개 → 삽입. 여럿 → 공통 접두사만 채움(`[ not unique ]` 메시지는 만들지 않는다).
- 두 번째 연속 Tab → 열 우선 목록. **셀 폭 = 최장 후보 + 2**, **200개 상한**과 `...N개 더`.
- 스템이 빈 곳은 `4 - (열 % 4)`칸 공백을 main에서 바로 넣는다(worker 왕복 없음).
- worker 후처리: 이름 후보 전체 정렬, 예외 삼킴, 경고 억제, `_pyodide*`·`___*` 제외(`INTERNAL_PREFIXES = ('_pyodide', '___')`).
- 왕복 중 입력이 바뀌면 완성을 버린다. Enter·Ctrl+C가 먼저면 그 결과를 돌려준다.
- (이전 구현 한정) 첫 시도는 main→worker 호출이 worker의 동기 대기에 막혀 보류됐고, `readLine` 반환값에 센티널(`\x00TAB\x00` + JSON)을 실어 우회했다. 이 프로토콜은 RD-021에서 전용 RPC의 `complete` 요청으로 대체됐다.

**완료 기준**: 브라우저 58개 시나리오 통과(후보 1개 삽입, 접두사 채움, 두 번째 Tab 목록이 3.14 pty 화면과 같은 행, 후보 없음, 빈 스템 공백, 커서 중간, 여러 줄 버퍼·`... ` 줄, 경합 Tab→Enter·Tab→Ctrl+C 각 20회 정지 0, `input()` 무동작, 후처리, 세션 리셋·`exit()` 뒤). 왕복 지연 중앙값 25.5ms·최대 32.4ms.
**이전 구현 상태**: 완료

### RD-016a `import`/`from` 줄의 모듈 완성

**사용자 시나리오**: `import os.pa` 뒤 Tab → `import os.path`. `import xml.dom.m` 뒤 Tab → `xml.dom.mini`. `import ` 뒤 Tab 두 번 → 모듈 목록(빈 cwd 기준 178개, 4열 × 45행).
**규칙·결정**

- 3.14 `readline.py`와 같은 판정 순서: `ModuleCompleter` → 판정이 `None`이고 스템이 비면 `4-(열%4)`칸 공백 → 그 외 `console.complete`(`import os; os.pa`는 속성 완성).
- `ModuleCompleter`가 이름 완성보다 먼저 판정하므로 `from os import pa`가 `['path']`다. 빈 리스트는 무동작이며 이름 완성으로 폴백하지 않는다.
- 콤마·`as` 뒤는 마지막 이름만 스템. `;`·여러 줄·`... ` 블록·`yield from`도 모듈 완성. `... ` 블록은 이전 줄(`pending`)을 입력 앞에 붙인다.
- 호출마다 `ModuleCompleter` **새 인스턴스**를 만든다(재사용하면 `loadPackage`·micropip 뒤 패키지를 놓친다).
- main 사전 게이트는 커서 앞 텍스트(+pending)에 대한 **부분 문자열** `/import|from/`이다. 단어 경계 게이트는 숫자 리터럴 뒤 키워드(`1import os`)에서 건전하지 않아 기각했고, 대가는 `important = ` 같은 줄의 worker 왕복 1회(약 23ms) 추가다.
- pyodide stdlib가 zip이라 원본이 잃는 `collections.abc` 등은 `_is_stdlib_module` 판정만 오버라이드한 서브클래스로 되살린다.

**완료 기준**: 브라우저 129개 시나리오 통과, 3.14 pty 케이스 A01~A36 중 32개 + X01과 대조, 왕복 지연 중앙값 24.0ms. 빈 줄·`x = `의 Tab 8연타가 왕복 0회로 **32칸**. 3.14 삽입 quirk 동등(`import os.pa  # c` → `import os.pa  # cs.path`).
**이전 구현 상태**: 완료

### RD-016b `input()` 안 Tab

**상태**: 보류. 3절 참고.

### RD-016c 완성 중 Ctrl+C

**사용자 시나리오**: `__getattr__`가 무한 루프인 객체에서 `a.x` Tab을 누른 뒤 Ctrl+C를 누르면 세션 리셋 없이 `>>> `로 돌아온다.
**규칙·결정**: 완성 요청 진행 중 Ctrl+C가 SIGINT를 보내 worker의 후보 계산을 끊는다. SIGINT는 `complete_source`의 `except Exception`을 지나 RPC 실패로 끝나고 main은 무동작이다.
**이전 구현 상태**: RD-021에 흡수되어 구현·브라우저 확인 완료.

### RD-016d 후보 선택 UI(popover)

**상태**: 보류. 3절 참고.

### RD-016e 미로드 pyodide 배포 패키지의 import 후보

**상태**: 보류(범위 밖 확정). 3절 참고.

### RD-016f 게이트 참 빈 스템 줄의 Tab 연타 손실

**사용자 시나리오**: `important = ` 뒤 Tab **8연타(간격 0ms)**에 공백 **32칸**이 들어간다(동기 모드에서는 4칸만 들어갔다).
**규칙·결정**: 왕복 중 들어온 Tab을 버리지 않고 큐에 두어 이어 처리한다. (동기 모드 실측: 간격 0ms 8연타 4칸, 30ms·100ms는 32칸. `import ` 3연타 10ms는 왕복 2회에 목록 1번 — 버려진 Tab 뒤 `lastKeyWasTab`가 남아 세 번째가 `second: true`.)
**이전 구현 상태**: RD-021에 흡수되어 해소(브라우저에서 32칸 확인).

### RD-017 여러 줄 입력 제출 (붙여넣기·Shift+Enter·히스토리 재호출)

**사용자 시나리오**: `def add(a, b):\n    return a + b\n\nprint(add(1, 2))`를 붙여넣고 Enter 한 번을 누르면 `3`이 나오고 SyntaxError가 없다.
**규칙·결정**

- 개행이 든 입력은 **한 입력 단위**로 처리한다. 전체를 `ast`로 파싱해 top-level 문장 단위로 순서대로 실행한다(블록 안 빈 줄이 블록을 끊지 않는다).
- 파싱 오류가 있으면 **아무 문장도 실행하지 않는다**. 값은 **마지막 문장만** 에코한다(`1\n2\n3` → `3`).
- 예외·`KeyboardInterrupt`·`exit()`가 나면 나머지 문장은 실행하지 않는다. 붙여넣은 탭은 보존한다.
- 예외: 블록 입력 중(`... `)에 붙여넣은 여러 줄은 분할하지 않고 한 줄씩 흘려 넣는다(이 경우에만 블록 안 빈 줄이 블록을 끝낸다).
- worker는 붙여넣기/Shift+Enter/히스토리 재호출을 구분할 수 없다 — 규칙은 하나다.

**완료 기준**: 위 시나리오 + 클래스 메서드 사이 빈 줄, 탭 들여쓰기 유지, 한 줄 입력·빈 줄·`input()` 기존 동작 유지.
**이전 구현 상태**: 완료

### RD-018 top-level await (옵션, 기본 꺼짐)

**사용자 시나리오**: 상단 스위치가 꺼진 기본 상태에서 `await asyncio.sleep(1)`은 실제 `python`처럼 `SyntaxError: 'await' outside function`이 난다. 스위치를 켜면 `python -m asyncio`처럼 바로 실행된다. 스위치를 바꾸면 세션이 리셋되고 설정은 저장되지 않는다(새로고침하면 꺼짐).
**규칙·결정**

- `Console.__init__`이 플래그를 항상 켜므로 기본이 ON이었다 — 이 항목은 "기본 ON을 OFF로 바꾸고 켤 수 있게 하는 옵션"이다.
- ON은 **컴파일 플래그만** 켠다. `asyncio` 선주입, 배너 변경, Ctrl+C의 task 취소 같은 `python -m asyncio`의 나머지 동작은 흉내내지 않는다.
- 꺼짐에서 붙여넣은 여러 문장은 앞 문장을 실행한 뒤 `await` 문장에서 오류가 나고 이후는 실행되지 않는다.

**완료 기준**: 위 동작 + 꺼짐/켜짐 모두 `asyncio.run(main())` 동작, 한 줄/블록/`input()`/Ctrl+C 기존 동작 유지.
**이전 구현 상태**: 완료

### RD-019 자동 들여쓰기

**사용자 시나리오**: `for i in range(2):` Enter → `... ` 다음 줄에 **4칸**이 채워진다. `    print(i)` Enter 뒤에도 4칸이 유지된다. 공백뿐인 줄에서 Enter를 누르면 블록이 끝나 실행된다.
**규칙·결정**

- 3.14 실제 동작에 맞춘다: `:` 뒤 한 단위 증가 + **직전 줄 들여쓰기 유지**, 단위는 세션 동안 유지(2칸으로 쓴 블록 뒤 새 블록은 2칸, 세션 리셋 뒤 4칸).
- Backspace: 커서 앞이 스페이스뿐이고 `... ` 줄이거나 여러 줄 버퍼의 첫 줄이 아니면 직전 단위 배수까지 지운다(최소 1글자). `>>> ` 첫 줄·탭 혼용·글자 뒤는 1글자.
- Shift+Enter/Alt+Enter는 개행 뒤 같은 규칙으로 채운다. 일반 Enter와 붙여넣기·history 재호출·`input()`에는 채우지 않는다.
- 자동 dedent와 켜고 끄는 스위치는 만들지 않는다. 문자열 안 `#`를 주석으로 오인하는 한계까지 3.14와 같다.
- 채워진 공백뿐인 줄은 history에 남기지 않는다.

**완료 기준**: 위 규칙 전부 + 본문 없이 Enter를 반복하면 블록이 끝나지 않고 다시 채워짐(3.14와 같다).
**이전 구현 상태**: 완료

### RD-020 블록 입력의 줄들을 history 항목 하나로 묶기

**사용자 시나리오**: `for i in range(2):` / `    print(i)` / 빈 줄로 블록을 끝낸 뒤 ↑를 누르면 블록 **전체**(개행이 든 한 항목)가 돌아오고 Enter 한 번으로 다시 실행된다(고치기 전에는 `    print(i)` 조각만 돌아와 `IndentationError`).
**규칙·결정**

- main 단독의 "진행형 교체"로 기록한다(worker 프로토콜 변경 없음): 블록 첫 줄 append 직전의 entries를 기준점으로 잡고, `... ` 줄을 제출할 때마다 기준점으로 되돌린 뒤 블록 전체를 다시 append한다(`History`에 삭제 API가 없다).
- Ctrl+C 취소와 세션 리셋은 기준점으로 복원한다 → 취소된 블록(첫 줄 포함)이 남지 않는다.
- `... ` 입력줄의 ↑는 history 탐색이 아니라 **무동작**으로 정했다(진행형 항목이 작성 중인 블록 자신이라 자기 자신이 들어온다). 편집 버퍼 안 줄 이동은 유지.
- 괄호 안 빈 줄은 보존. 문법 오류·예외·`exit()`로 끝난 블록도 전체가 남는다. 공백만 있는 제출은 history에 남지 않는다.

**완료 기준**: 위 전부.
**이전 구현 상태**: 완료

### RD-021 REPL 프롬프트 읽기를 비동기 채널로 전환

**사용자 시나리오**: (1) `important = ` 뒤 Tab 8연타(0ms)에 공백 32칸이 들어간다. (2) `__getattr__`가 무한 루프인 객체에서 `a.x` Tab 뒤 Ctrl+C가 세션 리셋 없이 `>>> `로 돌아온다. (3) 프롬프트 대기 중 `asyncio.get_event_loop().call_later(2, print, 'TICK')`의 출력이 2초 뒤 바로 보이고, 그 콜백이 `input()`을 불러도 REPL이 멈추지 않는다.
**규칙·결정**

- REPL 프롬프트 읽기와 완성 요청을 **전용 `MessageChannel` 위 비동기 RPC** 하나로 옮긴다. 센티널·resume 코덱, 플래그, 우회 모듈은 전부 제거한다.
- `input()`의 stdin 읽기는 CPython이 동기로 부르므로 **동기 경로에 남긴다**(대기 중 다른 콜백이 돌면 CPython 의미가 깨진다 — `time.sleep`을 블로킹으로 둔 것과 같은 근거).
- 치르는 대가: 프롬프트 대기 중 worker 이벤트 루프가 살아 있어 asyncio 콜백이 돈다. 3.14 기본 REPL은 돌 루프가 없고 `python -m asyncio`는 돈다 → **`python -m asyncio` 쪽으로 정렬**(사용자 결정).
- **백그라운드 `input()` 가드**: REPL 읽기가 활성인 동안 들어온 stdin 읽기는 그 REPL 읽기가 끝난 뒤 시작한다(없으면 REPL 읽기가 고아가 되어 세션 리셋 전까지 멈춘다).
- **전역 스트림**: `PyodideConsole`이 `runcode()` 동안만 리다이렉트하므로, 프롬프트 대기 중 배경 콜백 출력·asyncio 예외 로그는 전역 stdout/stderr를 탄다. 전역 `setStdout`/`setStderr`를 콘솔 콜백과 **같은 sink**로 보낸다(pyodide `Writer`로 바이트를 받아 `TextDecoder({ stream: true })`로 조각 경계를 잇는다). Python 쪽 stdout 버퍼는 건드리지 않는다 → 개행 없는 배경 출력은 `flush=True`가 필요하다.
- **프롬프트 유휴 SIGINT 폐기**: 프롬프트 대기 중 깨울 정지한 실행이 없는 SIGINT는 감시 타이머가 폐기하고 ack한다(송신기가 멈춘다). 실행 중 규칙(깨울 수 없으면 남겨 둔다)은 그대로.

**완료 기준**

- 비동기 RPC가 REPL 프롬프트 읽기의 유일한 경로다(동기 `readLine`이 proxy에 남지 않는다).
- 가드·전역 스트림·유휴 폐기·완성 중 취소에 단위 시험(RED 확인 + 변이 검사)이 있다.
- 브라우저 회귀가 기준선과 같다: RD-016 58/58, RD-016a 129/129, RD-012b 22/24(E1·E2), RD-012c 20/24(A1·C2·H1·J1), RD-006b 74/74, boot-press N=30 전부 복귀. Tab 왕복 지연 중앙값 25ms 안팎.
- `test`·`check-types`·`lint` 통과(종료 시점 32파일 / 781개).

**이전 구현 상태**: 완료. RD-016c·RD-016f를 흡수했고 RD-012h (a)는 이후 재평가 대상으로 남았다.

참고: `/work/cp949/pyodide-samples/apps/repl/ROADMAP.md`, `/work/cp949/pyodide-samples/apps/repl/docs/design/`(01~12 절 파일)

---

## 3. 보류 항목과 등록 규칙(범위 밖 확정은 10-parity-deviations.md)

### 3.2 보류

- **RD-016b `input()` 안 Tab**: 3.14는 `input()` 안에서도 완성한다(pty 실측: `[ not unique ]` → 두 번째 Tab 목록). 이전 구현은 무동작이고 `\t`도 넣지 않는다. `input()`은 동기 stdin 콜백이라 worker가 멈춰 있어 **비동기 채널로도 풀리지 않는다** — main 쪽 완성이나 별도 배선이 필요하다. 이 읽기는 REPL 읽기와 프롬프트 합성·취소 처리가 다르다.
- **RD-012i `asyncio.run` 코루틴 안 중복 트레이스백**: 실작업으로 분류됐으나 착수 전(대기). 완료 기준 미확정.
- **RD-012j `time.sleep` 대기 중 워커 CPU 점유**: Node 측정으로 `sleep(1.0)`이 벽시계 1000ms에 CPU 1115ms(기본 JSPI는 1003ms에 5ms). 눌림 지연·화면·정확성에 영향이 없는 CPU 점유만이라 재측정 비용(Node 10분 + 브라우저 50분)이 이득보다 크다. 후보: 조각을 원본 C 대신 사설 `SharedArrayBuffer`의 `Atomics.wait`로 재운다.
- **RD-016d 후보 선택 UI(popover, 필터·쪽 넘김)**: 3.14 동등 밖의 UI 기능. 시나리오와 완료 기준이 정해지면 재등록.
- **RD-012h (a) "Python 정지" 플래그**: 정확성 영향이 없는 송신기 잔류만 없애므로 문제로 드러날 때까지 미룸.
- **readline 라이브러리 포크**: `xterm-readline` 소스를 저장소에 포팅하지 않기로 확정(npm 패키지 그대로 사용). 포팅했다면 풀렸을 항목들(`... ` 접두사 미표시, 다중 줄 항목의 줄 단위 history 이동, `History` 삭제 API 부재로 인한 진행형 교체 우회)은 편차·우회로 남겼다.
- **v1 범위 밖으로 처음부터 제외**: 히스토리 영구 저장(`~/.python_history` 상당), Ctrl+R 역검색(`xterm-readline`에 없음), syntax highlighting·bracket matching, session export/import, 패키지 설치 UI, 파일시스템, 터미널 명령, 디버거, 정적 호스팅/Service Worker COOP/COEP 우회, 자동화 E2E(Playwright를 상시 CI로 두는 것), 서버 CPython 프로세스 아키텍처.

### 3.3 후속 후보 등록 규칙 (재개발에도 적용 권장)

- RD로 등록하려면 **재현 가능한 사용자 시나리오**와 **관찰 가능한 완료 기준**이 둘 다 있어야 한다. 하나라도 없으면 설계 문서의 "알려진 한계·편차"에 한 줄로 남긴다.
- 완료 기준이 "착수 시 정한다"인 채로 등록하지 않는다.
- 위 "범위 밖" 목록의 차이는 등록하지 않는다.

참고: `/work/cp949/pyodide-samples/apps/repl/ROADMAP.md`(상단 "범위 밖"·"대기 항목 구조 분류"), `/work/cp949/pyodide-samples/apps/repl/DESIGN.md`("이번 범위 밖")

---

## 4. 이전 구현의 모듈 지도

### 입력/편집(main, xterm-readline 위)

| 파일                    | 역할                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `auto-indent.ts`        | 자동 들여쓰기 순수 계산(`nextIndentation`, `backspaceCount`, `indentUnitWidth`)             |
| `auto-indent-reader.ts` | `Readline.read()`/`readKey` 래핑. 프리필·Backspace·Shift+Enter·Ctrl+C 취소·`cancelSettling` |
| `block-history.ts`      | `history.append` 래핑. 블록 여러 줄을 history 항목 하나로 묶음(`beginRead`/`discard`)       |
| `history-filter.ts`     | `skipBlankHistory` — 공백만 있는 제출을 history에서 제외                                    |
| `paste-tabs.ts`         | `readPaste` 래핑. 붙여넣은 `\t` 보존(TRP-006)                                               |

### 실행/제출(worker)

| 파일                            | 역할                                                                        |
| ------------------------------- | --------------------------------------------------------------------------- |
| `submission-runner.ts`          | 제출 한 번의 실행 규칙(한 줄/여러 줄, 에코, 중단, 취소, 안전망)             |
| `multiline.ts` / `multiline.py` | `split_paste(source)` — `ast.parse`로 top-level 문장 경계 분할              |
| `top-level-await.ts`            | `setTopLevelAwait(pyodide, pyconsole, enabled)` — 컴파일 플래그 비트만 토글 |

### 중단(Ctrl+C)

| 파일                         | 역할                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `interrupt-protocol.ts`      | 버퍼 슬롯 규약과 원자 연산(`signalInterrupt`, `acknowledgeInterrupt`, `readRequestSeq`, `discardPendingInterrupt`) |
| `interrupt-sender.ts`        | main 송신기. 전송·점검·재전송 상태기계                                                                             |
| `interrupt-buffer.ts`        | `connectInterrupts`(핸들러 설치 → 버퍼 연결), `attachInterruptBuffer`                                              |
| `sigint-handler.ts` / `.py`  | Python SIGINT 핸들러 설치, 정지한 실행 깨우기, `time.sleep` 조각 래퍼, `formattraceback` 절단                      |
| `interrupt-watch.ts`         | worker 감시 타이머(정지 구간 엿보기·소비, 프롬프트 유휴 폐기)                                                      |
| `stdin-callback.ts`          | `input()` 취소(`null`)를 `KeyboardInterrupt`로 바꾸는 stdin 콜백                                                   |
| `webloop-reraise.ts` / `.py` | WebLoop의 `KeyboardInterrupt`·`SystemExit` 재보고 억제                                                             |

### 출력(main sink + worker 전역 스트림)

| 파일                | 역할                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `terminal-sinks.ts` | sink 4종(`writeOutput`/`writeError`/`write`/`writeErrorRaw`) + 꼬리 추적(`tail`/`resetTail`) |
| `output-tail.ts`    | `createOutputTail()` — 개행 없는 꼬리와 활성 SGR 추적(순수)                                  |
| `sink-writer.ts`    | `createSinkWriter(sink)` — 전역 stdout/stderr용 pyodide `Writer`                             |

### 읽기 브리지(main)

| 파일              | 역할                                                                           |
| ----------------- | ------------------------------------------------------------------------------ |
| `repl-reader.ts`  | `createReplBridge` — 꼬리 + `>>> `/`... ` 프롬프트 합성                        |
| `stdin-reader.ts` | `createInputReader`/`createStdinBridge`/`rewindTail` — `input()` 읽기          |
| `read-guard.ts`   | `createReadGuard(readLine, readInput)` — stdin 읽기를 활성 REPL 읽기 뒤로 미룸 |

### 완성(Tab)

| 파일                         | 역할                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `tab-completion.ts`          | 순수 로직(`planTab`, `mentionsImportKeyword`, `resolveCompletion`, `formatCompletionList`) |
| `tab-reader.ts`              | main의 Tab 가로채기, 요청 큐, 목록 재그리기                                                |
| `complete-source.ts` / `.py` | worker 후처리(`ZipStdlibModuleCompleter`, 모듈 완성 우선 판정)                             |

### 세션/배선

`ReplTerminal.tsx`(main 배선·UI), `pyodide-worker.ts`(worker 배선·REPL 루프), `rpc.ts`(통신, 범위 밖).

### 통신과 격리된 것 / 결합된 것

- **순수 함수 또는 콜백 주입으로 격리**: `auto-indent.ts`, `tab-completion.ts`, `output-tail.ts`,
  `interrupt-protocol.ts`, `interrupt-sender.ts`(`setTimer`/`clearTimer` 주입), `sink-writer.ts`(sink 주입),
  `read-guard.ts`(두 읽기 함수 주입), `stdin-callback.ts`(`readInput` 주입), `submission-runner.ts`
  (`SubmissionIO` 주입 — pyodide 프록시에만 의존), `multiline.py`·`complete-source.py`(문자열 in/out),
  `history-filter.ts`, `paste-tabs.ts`, `block-history.ts`(readline만 의존).
- **런타임·통신에 결합**: `auto-indent-reader.ts`·`tab-reader.ts`(xterm-readline 내부 멤버),
  `terminal-sinks.ts`·`repl-reader.ts`·`stdin-reader.ts`(`Readline`/`Terminal`),
  `interrupt-buffer.ts`·`sigint-handler.ts`·`webloop-reraise.ts`·`top-level-await.ts`·`complete-source.ts`
  (pyodide 내부), `interrupt-watch.ts`(`setInterval`), `ReplTerminal.tsx`, `pyodide-worker.ts`.

참고: `/work/cp949/pyodide-samples/apps/repl/src/repl/`, `/work/cp949/pyodide-samples/apps/repl/DESIGN.md`
