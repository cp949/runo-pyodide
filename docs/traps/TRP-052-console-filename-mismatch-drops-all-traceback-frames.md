# TRP-052 `CodeRunner` 파일명이 `console.filename`과 다르면 트레이스백 프레임이 전부 사라진다

- 상태: ACTIVE
- 적용 조건: `exec_in_console`·`CodeRunner`에 `console.filename`(REPL 콘솔은 `<console>`)과 다른 파일명을 넘겨 실행하는 코드. runner의 `filename` 옵션과 콘솔 `filename`을 따로 만드는 코드, REPL `runSource`에 파일명 인자를 더하는 변경, 시험에서 임의 파일명(`explicit.py` 등)으로 런타임 오류를 내는 경우.

## 오해하기 쉬운 신호

- 예외가 나지 않는다. 결말은 정상 `error{ errorType: "ZeroDivisionError" }`이고 `errorType`만 단언하는 시험은 통과한다.
- `traceback`이 `ZeroDivisionError: division by zero\n` 한 줄뿐이다(`Traceback (most recent call last):`·`File "…", line N`이 없다). 같은 파일명으로 낸 문법 오류는 위치가 남아(`formatsyntaxerror`는 이 규칙과 무관) 오류 종류에 따라 증상이 갈린다.

## 원인

pyodide 314.0.7 `pyodide/console.py`의 `Console.num_frames_to_keep(tb)`가 트레이스백에서 `co_filename == self.filename`(콘솔의 `filename`)이거나 `"<exec>"`인 프레임부터만 남기고 앞 프레임을 자른다(`python_stdlib.zip` 안 `pyodide/console.py`). 사용자 코드의 파일명이 그 둘 중 하나가 아니면 남는 프레임이 0이다. SIGINT 규칙 ①이 같은 일치에 의존하는 것(`docs/traps/TRP-020`)과 같은 뿌리의 다른 증상이다.

## 탐지/회피

- 코드 파일명은 `console.filename`을 그대로 쓴다. `exec_in_console`은 `filename`을 생략하면 그 값이고 REPL `runSource`는 생략한다. runner는 콘솔 `filename`과 `CodeRunner` 파일명을 같은 옵션에서 만든다(`docs/design/14-runner.md` 14.2.2).
- 파일명이 다른 경로의 시험은 런타임 오류의 `traceback`에 `File "…"` 줄이 있는지 단정한다. `errorType`만 보면 놓친다.
- 관찰 조건: `exec_in_console(console, "1 / 0", false, "explicit.py")`(콘솔 `<console>`)의 `traceback`이 예외 줄 한 줄이었다. `packages/pyodide-core/src/worker/run-driver-exec-in-console.test.ts`의 파일명 절은 이 때문에 문법 오류 위치(`File "explicit.py", line 1`)로 인자 전달을 단정한다(런타임 오류 트레이스백으로는 확인되지 않는다).
