# TRP-021 `run_sync`에 들어간 awaitable의 예외가 JS 경계를 넘으면 트레이스백이 두 번 찍히고 끝만 보는 단언은 통과한다

- 상태: ACTIVE
- 적용 조건: `sigint-handler.py`의 `guard`·`run_sync` 래퍼·`formattraceback`을 바꿀 때, 정지한 대기(`asyncio.run`·`run_until_complete`·`run_sync`)의 화면 형식을 시험·하니스로 판정할 때.

## 오해하기 쉬운 신호

- `expect(screen.stderr.endsWith(CONSOLE_TRACEBACK)).toBe(true)`가 **통과**한다. 화면의 **마지막** 트레이스백은 콘솔 `formattraceback`이 만든 3줄 표준형이라 끝만 보는 단언은 전부 통과한다.
- 나머지 판정도 전부 정상이다: 프롬프트 복귀 20/20, 복귀 지연 중앙값 26~27ms(문턱 안), `pageerror` 0.
- 같은 모양의 다른 조합은 깨끗해서 "이 경로는 문제 없다"고 일반화하기 쉽다. `async def main(): while True: await asyncio.sleep(0.1)`(await만 하는 코루틴)은 트레이스백 1개·우리 프레임 0으로 20/20 통과한다.
- `except … as e`로 잡은 객체를 보면 `__context__`·인자가 정상이라 예외 자체는 멀쩡해 보인다.

## 원인

화면에 트레이스백이 **둘** 나오고 첫째에 우리 내부 파일명이 그대로 있다(고치기 전 예시):

```txt
Traceback (most recent call last):
  File "<sigint-handler>", line 133, in guard
  File "<console>", line 5, in main
  File "<sleep-slice>", line 109, in sleep
  File "<sleep-slice>", line 69, in poll
  File "…/pyodide.asm.mjs", line 1, in checkInterrupt
  File "wasm://wasm/…", line 1, in null.<anonymous>
  File "<sigint-handler>", line 110, in sigint_handler
KeyboardInterrupt
Traceback (most recent call last):
  File "<console>", line 1, in <module>
KeyboardInterrupt
```

실측 기전(2026-09-22, node, pyodide 314.0.7): 찍는 주체는 pyodide C `src/core/error_handling.c`의 `wrap_exception_inner()`가 부르는 `PyErr_Print()`(= `sys.excepthook`, `_pyodide/__init__.py`의 `set_excepthook()`이 건 `traceback.print_exception`)다. 호출 경로는 C `run_sync`(`_pyodide_core`, `src/core/jsproxy.c`) → `python2js(ensure_future(x))` → `JsvPromise_Syncify` → PyProxy `.then` → `_pyproxy_ensure_future` → 실패한 Task의 done 콜백 `FutureDoneCallback_call_reject` → `wrap_exception()`이고, Task 취소·`guard`와 무관하다(원본 `run_sync`도 두 번 찍는다). 화면에 새는 이유는 pyodide `capture_stderr()`가 **fd 2만** 리다이렉트하는데, 콘솔 `runcode`의 `redirect_streams()`는 `sys.stderr`를 `_WriteStream(stderr_callback)`으로 바꿔 `print_exception`이 콜백으로 직행하기 때문이다(`runPython`처럼 fd 2를 그대로 쓰는 경로에서는 캡처된다). 범위는 KeyboardInterrupt에 한정되지 않는다 — `run_sync` 계열로 들어간 awaitable이 **어떤 예외로든** 끝나면 발생했다(ValueError·SystemExit도 같았다).

사용자 코드가 `await`로만 기다리면 조각 래퍼 프레임 자체가 없어 이 경로를 타지 않는다. 즉 조건은 "코루틴을 감싸 도는 것"이 아니라 **"감싸인 코루틴 프레임 안에서 동기 sleep 조각을 직접 부르는 것"**이었다(둘 다 `run_sync` 계열 대기가 예외로 끝나면 발생하는 더 넓은 결함의 한 사례였다).

## 탐지/회피

- 화면 형식 판정에 **우리 프레임 부재를 별도 단언으로** 넣는다: 화면 전체에 `<sigint-handler>`·`<sleep-slice>`·`<webloop-reraise>`·`webloop.py`가 없다. `endsWith(CONSOLE_TRACEBACK)`만으로는 잡히지 않는다.
- 트레이스백 **개수**를 센다(시간 기반 중단은 정확히 1개).
- 이 조합은 알려진 편차였다(`docs/design/10-parity-deviations.md` 28, RD-009a로 해소).
- **해소(RD-009a)**: `guard`가 `BaseException`을 `Raised(exc)`로 나르고 래퍼가 사용자 스택에서 올린다(Task를 정상 값으로 끝내 예외가 JS 경계를 넘지 않는다). 재발 조건: `guard`가 잡지 않는 예외(`GeneratorExit`)나 래퍼를 우회하는 경로(설치 가드 발동, 사용자가 `_pyodide_core.run_sync`를 직접 부름)에서는 다시 생긴다. 새 깨우기·대기 경로를 추가하면 "트레이스백 개수 1 + 우리 프레임 0" 단언을 함께 넣는다.
