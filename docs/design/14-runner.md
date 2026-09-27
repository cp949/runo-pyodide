# 실행 driver와 실행창(runner)

> RD-022 신규 절이다. 이전 구현에 대응 기능이 없어 `12-previous-implementation.md`의 참고 경로가 없다. 기준은 CPython 3.14의 `python main.py`(스크립트 한 파일 실행)이고 REPL 기준(`02`~`08`)과 다르다. 코드 한 덩어리를 새 이름공간에서 실행하고, `input()`·Ctrl+C만 받는 소비자(호스트 페이지의 iframe·canvas·xterm 실행창)를 위한 경로다. `run`·`stop`·`interrupt`·`reset`·`dispose`의 이름과 상태·이유 문자열은 코드 export와 일치해야 하며 `apps/demo`의 `?view=runner`와 `e2e:runner-check`가 브라우저에서 확인한다.

## 14.1 구성과 패키지 배치

| 층                 | 위치                                                                    | 역할                                                                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| worker 실행 driver | core `./worker`의 `runDriver`(`worker/run-driver.ts` + `run-driver.py`) | RPC `runCode(source)`를 받아 새 globals에서 실행하고 결말(`RunOutcome`)을 돌려준다                                                                                                           |
| main 실행 핸들     | core `.`의 `createRunner`(`session/runner.ts`)                          | worker 생성·재생성, interrupt buffer·송신기, core 세션, 상태 8종, `run`·`stop`·`interrupt`·`reset`·`dispose`, `InputProvider` 호출                                                           |
| xterm 실행창       | terminal `.`의 `createTerminalRunner`(`src/terminal-runner.ts`)         | `createRunner`를 호출자 소유 `Terminal`에 붙인다: sink 출력, `input()` 한 줄 읽기, Ctrl+C, 선택 복사                                                                                         |
| 데모               | `apps/demo`의 `?view=runner`(`RunnerView.tsx`, `runner.worker.ts`)      | plain 요소로 실행창 조작·결과를 노출한다(14.6). RD-024부터 `RunnerView`는 `createTerminalRunner`를 직접 부르지 않고 `<PythonRunner>`(`@cp949/runo-pyodide-repl-react`, `15-react.md`)를 쓴다 |

`createRunner`는 xterm·React를 모른다. canvas 같은 소비자는 `onOutput`·`InputProvider`만 채워 쓴다. 앱의 worker 파일과 main 사용은 다음과 같다(`worker.format`은 REPL과 같은 이유로 `'es'`, `00-architecture.md` 4.1).

```ts
// runner.worker.ts
// core/worker는 top-level await가 있는 모듈의 import보다 앞선 정적 import로 둔다(모듈이 평가될 때 init 프레임 수신기가 걸린다).
// dom-bridge를 쓰면 dom-bridge `./worker`가 이 파일의 첫 정적 import이고 core/worker는 그 다음이다(`16-dom-bridge.md` 16.3).
// 이 순서를 지키면 runWorker 호출 시점(파일 안의 await 뒤 등)은 자유다(늦게 불러도 버퍼에서 부팅한다, `01-protocols.md` 4절).
import { runDriver, runWorker } from "@cp949/runo-pyodide-core/worker";
runWorker({ driver: runDriver });

// main (UI 비의존)
import { createRunner } from "@cp949/runo-pyodide-core";
const runner = createRunner({
  createWorker: () =>
    new Worker(new URL("./runner.worker.ts", import.meta.url), {
      type: "module",
    }),
  onOutput: ({ stream, text }) => {
    /* stdout·stderr 원문 조각 */
  },
  inputProvider: async (prompt, signal) => "한 줄", // 생략하면 input()이 읽기 취소를 받는다(14.4)
});
const result = await runner.run('print("hi")'); // { kind: "ok" }
```

## 14.2 worker 실행 driver

### 14.2.1 실행 경로

- driver Python(`run-driver.py`)은 두 함수로 나뉜다. `run_code(console, source, filename, top_level_await)`는 runner 전용 준비(새 `sys.stdin`·새 globals, 14.2.2)를 한 뒤 공용 함수 `exec_in_console(console, source, top_level_await, filename=None)`을 부른다. `exec_in_console`이 컴파일·실행·결말 분류·stderr 쓰기를 한다: `CodeRunner(source, mode="exec", return_mode="none", dedent=False, dont_inherit=True, filename=filename, flags=flags).compile()`을 만들고 `await console.runcode(source, runner)`로 실행한다. `filename`이 `None`(기본)이면 `console.filename`이고 `run_code`만 자기 인자를 넘긴다(runner에서는 둘이 같다). 이 함수는 `console.globals`와 열린 `sys.stdin`을 건드리지 않으며(`SystemExit` 뒤 닫힌 stdin 되살림만 한다, 14.2.2) REPL `runSource`(`02-console-core.md` 5.6)가 그대로 쓴다. 분류 규칙(`_is_interrupt`·`_error_type`·`_exit_status`)은 이 한 곳이다. TS 쪽은 core `./worker`가 `loadExecInConsole(pyodide)`(버리는 이름공간에 Python 소스를 올리고 함수를 돌려준다)·`toRunOutcome(raw)`·타입 `ExecInConsolePy`·`RawOutcome`을 export한다(`runDriver`와 REPL이 함께 쓴다). 옵션 세 개는 스크립트 실행 의미를 맞춘다: `CodeRunner` 기본값 `dedent=True`는 들여쓴 첫 줄을 조용히 통과시키고 `return_mode="last_expr"`는 마지막 식을 값으로 바꾼다(`docs/traps/TRP-041`).
- REPL의 `push()`·`ConsoleFuture`·`runsource` 경로를 거치지 않는다. 이유: `PyodideConsole`의 `_CommandCompiler`는 미완성 입력에 `None`("입력 계속")을 돌려주고 `_compile`은 항상 `PyCF_ALLOW_TOP_LEVEL_AWAIT`를 켠다(pyodide 314.0.7 `console.py`). 스크립트 한 덩어리는 둘 다 맞지 않는다.
- `console.runcode`는 core `sigint-handler.py`가 인스턴스 속성으로 바꿔 둔 래퍼다(`active` task 기록, 정지한 `await`를 깨우는 `interrupt_idle`이 의존). `console.formattraceback`도 core가 바꾼 버전이다(우리 프레임 절단, 깨운 중단 `IdleInterrupt` → `"KeyboardInterrupt\n"`). 실행 driver는 인스턴스의 메서드를 그대로 불러 두 확장을 상속한다. SIGINT 계층·`sigint-handler.py`는 이 RD에서 바뀌지 않았고 실제 pyodide 시험(가설 8항목)이 `while` 루프·`time.sleep`·TLA `await`·`asyncio.run`·`input()` 취소를 확인한다.
- 예외는 `console.formattraceback(exc)`, 문법 오류는 `console.formatsyntaxerror(exc)`로 포맷하고 결과 `traceback`과 stderr에 함께 쓴다. `filename`이 `<…>` 꺾쇠 형태가 아니면 `CodeRunner`가 소스를 `linecache`에 등록하므로(`_set_linecache`) `File "main.py", line N` 밑에 소스 줄이 나온다. 3.13+ 트레이스백은 그 줄 밑에 `~^~` 형태의 캐럿 줄을 붙인다.
- 하나의 결말 분류:

| Python 쪽 결말                                                                           | `RunOutcome`                              |
| ---------------------------------------------------------------------------------------- | ----------------------------------------- |
| 예외 없이 끝남                                                                           | `{ kind: "ok" }`                          |
| 처리되지 않은 `KeyboardInterrupt`, 또는 정지한 `await`를 깨워 끝낸 중단(`IdleInterrupt`) | `{ kind: "interrupted", traceback }`      |
| `SystemExit`                                                                             | `{ kind: "exit", code }`(14.2.4)          |
| 그 밖의 처리되지 않은 예외(문법 오류 포함)                                               | `{ kind: "error", errorType, traceback }` |

`IdleInterrupt`는 공개 이름이 없는 표지 예외라 클래스 이름 문자열로 알아본다(`_is_interrupt`, `docs/traps/TRP-040`).

### 14.2.2 새 globals와 `filename`

- run마다 `console.globals`를 새 dict로 교체한다: `{ "__name__": "__main__", "__doc__": None, "__file__": filename, "__builtins__": builtins, "__spec__": None }`. `__loader__`는 넣지 않는다. `pyodide.globals`는 그대로라 이전 run의 변수는 `NameError`가 되고 `pyodide.globals`에는 새지 않는다. `sys.modules`(과 나머지 인터프리터 상태)는 유지된다(`10-parity-deviations.md` 편차 51).
- `filename`은 runner 단위 옵션이다(생성 시 고정, 기본 `"main.py"`, `DEFAULT_RUN_FILENAME`). 같은 값을 세 곳에 쓴다: 콘솔 `filename`(`createCoreConsole(pyodide, sinks, { filename })`), `CodeRunner`의 소스 파일명, 트레이스백 표시. SIGINT 규칙 ①은 실행 프레임 사슬에 `co_filename == console.filename`인 프레임이 있을 때만 `KeyboardInterrupt`를 올린다(`03-ctrl-c.md` 2.4). 둘이 어긋나면 취소가 버려져 `input()` 읽기가 재시도 루프가 된다(`docs/traps/TRP-020`, 시험은 변이로 확인).
- run 시작마다 `sys.stdin`을 새 `TextIOWrapper`(fd 0, `<stdin>`, 라인 버퍼)로 교체한다. 이전 run이 `sys.stdin.read(3)`으로 줄 일부만 읽어 남긴 버퍼가 다음 `input()`으로 새는 것(`docs/traps/TRP-010`)과, `exit()`·`quit()`이 stdin을 닫아 다음 `input()`이 `ValueError: I/O operation on closed file.`이 되는 것을 함께 막는다.
- `exec_in_console`은 `SystemExit` 결말에서 `sys.stdin`이 닫혀 있거나 없을 때만(`closed` 또는 `None`) 같은 모양으로 다시 연다(`exit()`·`quit()`이 닫는다, TRP-054). `exit` 아닌 결말에서 사용자가 닫은 stdin, `exit` 결말이어도 열린 stdin은 건드리지 않는다. `closed`를 읽을 수 없는 객체(예: `sys.stdin = object()`)는 닫히지 않은 것으로 보고 그대로 둔다(판정 실패가 `exit` 결말을 예외로 뒤집지 않게). 두 경로는 `_open_stdin()` 하나로 연다. REPL `runSource`는 이 되살림으로 세션을 잇고, runner는 `exit()` 직후 남은 배경 task의 `input()`이 읽힌다(다음 run은 위 교체). 시험: `run-driver-exec-in-console.test.ts` `[S1]`~`[S5]`.

### 14.2.3 옵션과 TLA

- `driver` 필드는 `{ filename?: string, topLevelAwait?: boolean }`이고 `parseRunDriverOptions`(`protocol/run-driver-options.ts`)가 검증한다. 값은 객체여야 하고 두 필드는 생략할 수 있다(`filename` 기본 `"main.py"`, `topLevelAwait` 기본 `false`). `filename`이 빈 문자열·문자열 아님, `topLevelAwait`가 boolean 아님이면 필드 이름을 담아 던진다. 알 수 없는 필드는 무시한다.
- 옵션이 틀린 worker는 `loadFailed`도 `ready`도 알리지 않고 부팅이 거부된다(`bootWorker`가 `parseOptions`를 RPC 생성 앞에 둔다). 그래서 main `createRunner`가 worker를 만들기 전에 같은 파서로 먼저 검증하고 동기로 던진다(`docs/traps/TRP-042`).
- `topLevelAwait: true`이면 컴파일 플래그 `ast.PyCF_ALLOW_TOP_LEVEL_AWAIT`를 `CodeRunner`에 직접 넘긴다. 기본(`false`)이면 최상위 `await`는 `SyntaxError: 'await' outside function`이다(CPython 스크립트와 같다). REPL의 콘솔 TLA 비트(`02-console-core.md` 5.4)는 쓰지 않는다.

### 14.2.4 종료 코드와 문법 오류

- `SystemExit` 코드는 CPython 규칙이다: `None` → 0, `int` → 그 값, 그 밖(문자열 등) → 1이고 `str(코드)`를 stderr에 쓴다(`str()`이 던지면 클래스 이름으로 대신). `exit()`·`quit()`도 같다. 처리된 뒤 상태는 `ready`다(세션은 끝나지 않는다).
- **좁은 예외**: 정수 코드가 int32(`-2**31` ~ `2**31 - 1`) 밖이면 `& 0xFF`로 줄인다. pyodide가 `|x| ≥ 2**53 - 1`인 `int`를 JS `BigInt`로 바꿔 `code: number`를 깨기 때문이고(`docs/traps/TRP-043`) OS가 종료 코드로 보는 값이 하위 8비트이기 때문이다(`SystemExit(2**70 + 7)` → 7). 범위 안은 그대로다. 원값이 필요하면 `code` 타입을 바꿔야 한다.
- 문법 오류(구문 분석·컴파일 단계, `exec("if x:")` 같은 실행 중 오류 포함)는 `errorType: "SyntaxError"`로 통일한다. `IndentationError`·`TabError`의 구체 이름은 `traceback`에 남는다. `SyntaxError`가 아닌 컴파일 단계 오류(`ValueError`·`OverflowError`·`RecursionError`·`MemoryError`)는 클래스 이름을 그대로 내고 `traceback`은 예외 줄만이다(프레임이 전부 우리 것). 매우 깊게 중첩된 식은 `RecursionError` 대신 pyodide 치명 오류로 worker를 죽일 수 있고 이때 main은 `crashed`로 처리한다(14.3.6).

### 14.2.5 자동 패키지 로드

`PyodideConsole.runcode`는 먼저 `loadPackagesFromImports(source)`를 부른 뒤 실행한다. 소스의 `import`가 가리키는 pyodide 배포 패키지(numpy 등)가 첫 run에서 자동으로 내려받아진다(네트워크 필요, 로드 중에는 상태가 `running`이다). CPython은 `ImportError`다(`10-parity-deviations.md` 편차 53).

### 14.2.6 worker 세션

- `createRunSession(options)`이 세션을 만든다. `run(ctx)`는 끝나지 않는 Promise다: 제어 흐름이 없고 요청(`runCode`)마다 일하며, 종료는 main이 worker를 끝낼 때다. `runDriver`는 `sessionTerminated`를 보내지 않는다.
- `atPrompt()` = `!running`. 실행 중이 아니면 감시 타이머가 대상 코드 없는 SIGINT를 폐기한다(`03-ctrl-c.md` 2.5). `run()`이 끝난 뒤 남은 asyncio task·JS 타이머가 도는 동안도 참이다(편차 50).
- 진입 폐기는 두지 않는다. REPL 루프는 `readLine` 응답 직후 낡은 눌림을 명시적으로 비운다(TRP-009, `03-ctrl-c.md` 2.6 끝). 반면 `runCode`에는 그 단계가 없다. 앞 run 끝에 도착한 눌림이 틱(20ms) 폐기보다 먼저 온 다음 `runCode`에 남아도, `<console>` 프레임 전의 driver Python(`run_code`의 globals·stdin 준비, `CodeRunner` 컴파일)에서 폴링되어 핸들러 규칙 ④(시작 코드는 ack 뒤 버림)가 버린다. 시험: `run-driver-pyodide.test.ts` "틱 폐기 전에 다음 실행이 들어와도 남은 눌림은 그 실행을 끊지 않는다". 이 보호는 driver Python 머리가 pyodide 폴링 간격보다 길다는 사실에 기댄다. core가 "대상 코드 창"(진입 폐기 + `atPrompt` 내림)을 소유하는 안(arch-review 04 후보 7)은 기각했다: 결함이 없고, 명시 구현이 REPL 한 곳뿐이며, 폐기가 core 콜백 뒤로 숨는다. 재검토 조건: 위 시험 실패, 세 번째 driver 추가, `run-driver.py` 준비·컴파일 단계를 줄이거나 JS로 옮길 때.
- `runCode`는 실행 중 재진입을 `Error("runCode 재진입 거부 …")`로 거부한다(main의 `busy` 검사가 놓친 경우의 방어).
- `probe`는 두지 않는다. driver가 쓰는 pyodide 지점은 공개 API(`pyodide.code.CodeRunner`, `Console.runcode`·`formattraceback`·`formatsyntaxerror`·`globals`)이고 비공개 지점(깨우기·프레임 절단)은 core가 이미 탐지·보고한다(`13-version-upgrade.md` 13.6).

## 14.3 `createRunner`(core main)

옵션: `createWorker`(필수, worker를 만들 때마다 부른다), `onOutput`(필수), `pyodide?: { indexURL? }`, `filename?`, `topLevelAwait?`, `inputProvider?`, `onStatus?`, `onCrash?`, `onLoadFailed?`, `onRunAccepted?`. 핸들: `run(code)`·`stop()`·`interrupt()`·`reset()`·`dispose()`·`status`·`busy`. `busy`는 지금 `run()`을 부르면 `busy`로 거부되는가다(run이 실행 슬롯을 차지함 — 로딩·재시작 대기 포함 — 또는 `waiting-input`). `status`만으로는 대기 run의 슬롯 점유를 알 수 없다. 옵션 검증 오류(14.2.3)는 worker·버퍼를 만들기 전에 동기로 던진다. 첫 상태(`loading` 또는 `not-isolated`)는 `createRunner`가 반환하기 전에 `onStatus`로 동기 통지한다. `onLoadFailed(message)`는 `onStatus("load-failed")` 앞에 온다(core는 로드 실패 사유를 훅으로만 알린다). `onCrash(message)`는 `crashed` 다음에 부른다. `onRunAccepted()`는 `run()`이 코드를 받아들인 순간(거부 아님) 그 호출 안에서 동기로 한 번, 슬롯을 차지한 뒤·`runCode` 전송 앞에서 부른다(인자 없음, `loading`·`restarting`에서 수락돼도 즉시 부르고 `ready`에서 실행이 시작될 때는 다시 부르지 않는다).

### 14.3.1 상태 8종

| 상태            | 들어가는 때                                                                                                 | 나가는 때                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `loading`       | 격리된 페이지에서 첫 worker를 만든 직후                                                                     | `ready`(`ready` 알림), `load-failed`, `crashed`                                                                         |
| `ready`         | worker `ready`, 실행 종료, run 없는 입력 읽기 종료                                                          | `running`(run 전송), `restarting`, `crashed`                                                                            |
| `running`       | `runCode` 전송                                                                                              | `ready`(결말), `waiting-input`, `restarting`, `crashed`                                                                 |
| `waiting-input` | worker가 `input()`·`sys.stdin` 읽기로 메일박스에서 정지(`readInput` 알림)                                   | `running`(응답·취소 뒤, run 있음) 또는 `ready`(run 없음), `restarting`, `crashed`                                       |
| `restarting`    | `reset()` 또는 `stop()` 폴백이 worker를 교체(새 worker를 만든 뒤 통지. 생성이 던지면 거치지 않고 `crashed`) | `ready`, `load-failed`, `crashed`                                                                                       |
| `load-failed`   | pyodide 로드 실패(worker는 살아 있다)                                                                       | `reset()`                                                                                                               |
| `crashed`       | worker `error` 이벤트·`crashed` 알림, 재생성 중 `createWorker` 예외                                         | `reset()`(크래시 뒤 도착한 입력 읽기는 core의 D1(`08-session.md` 8.1)이 버려 공급자를 부르지 않고 상태가 바뀌지 않는다) |
| `not-isolated`  | `crossOriginIsolated !== true`(worker를 만들지 않는다)                                                      | 없음(`reset()`도 no-op)                                                                                                 |

- `waiting-input`은 run 없이도 나타난다: `run()`이 끝난 뒤 남은 asyncio task가 `input()`을 부르면 worker가 메일박스에 정지한다. 이때 provider가 그대로 불리고, 새 `run()`은 `busy`, `stop()`은 그 읽기만 취소하고 `"idle"`, `interrupt()`도 읽기를 취소하며, 읽기가 끝나면 `ready`로 돌아온다(복구는 `reset()`이기도 하다).
- 로딩·재시작 대기 중이던 `run()`이 `ready`에서 시작되면 `ready` → `running` 두 상태를 차례로 통지한다. `onStatus("ready")` 콜백이 `reset()`을 부르면 대기 run은 옛 세션으로 보내지 않고 새 worker의 `ready`까지 기다린다.
- REPL의 `ReplStatus`(6종)와 달리 `terminated`가 없다(`runDriver`가 `sessionTerminated`를 보내지 않고 `exit`는 결과 값이다). `running`·`waiting-input`·`restarting`이 더해졌다.

### 14.3.2 `run(code)`와 결과

- 결과 유니온 `RunResult` = `RunOutcome`(14.2.1의 4종) + `{ kind: "restarted" }`. 코드가 실행됐을 때의 결말만 담는다.
- 코드가 실행되지 않았거나 실행 도중 worker가 사라지면 `RunRejectedError { reason }`으로 reject한다(`reason`: `"busy"` | `"unavailable"` | `"disposed"` | `"crashed"`).

| `run()` 호출 시점·사건                                                      | 결과                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `code`가 문자열이 아님                                                      | `TypeError`로 reject                                                                             |
| `dispose()` 뒤                                                              | `RunRejectedError("disposed")`                                                                   |
| 상태 `not-isolated`·`load-failed`·`crashed`                                 | `RunRejectedError("unavailable")`                                                                |
| 이미 실행 슬롯을 차지한 run이 있음(대기 중 포함), 또는 상태 `waiting-input` | `RunRejectedError("busy")`                                                                       |
| 상태 `loading`·`restarting`                                                 | 대기(슬롯 점유). `ready`가 되면 실행한다                                                         |
| 대기 중 `stop()`                                                            | 대기 취소, `RunRejectedError("unavailable")`, `stop()`은 `"idle"`                                |
| 대기 중 `load-failed`                                                       | `RunRejectedError("unavailable")`                                                                |
| 실행 중·대기 중 `dispose()`                                                 | `RunRejectedError("disposed")`                                                                   |
| 실행 중·대기 중 worker 크래시                                               | `RunRejectedError("crashed")`(자동 재생성 없음)                                                  |
| 실행 중 `reset()`·`stop()` 폴백                                             | `{ kind: "restarted" }`로 resolve                                                                |
| 대기 중 `reset()`                                                           | 취소하지 않고 새 worker가 `ready`가 되면 실행한다(아직 실행되지 않았으므로 `restarted`가 아니다) |

### 14.3.3 `stop()`과 `interrupt()`

- `interrupt(): InterruptResult`(Ctrl+C용, `InterruptResult = "sent" | "input-cancelled" | "ignored"`, `packages/pyodide-core/src/index.ts`에서 `RunnerStatus`·`StopResult` 옆에 export). 평가 순서대로 I1~I4(연타 보호 재전송도 I3이면 `"sent"`다 — `send()`는 항상 새 요청으로 교체한다, `protocol/interrupt-sender.ts`):

| ID  | 조건(평가 순서대로)                                    | 동작                                                                                                       | 반환                |
| --- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------- |
| I1  | `disposed`                                             | 없음                                                                                                       | `"ignored"`         |
| I2  | 열린 입력 읽기(`pendingInput`)가 있음                  | `pendingInput.abandon()`(worker는 메일박스에 정지해 SIGINT를 폴링하지 못한다)                              | `"input-cancelled"` |
| I3  | `active?.phase === "sent" && session?.pythonRunning()` | `interruptSender.send()`(REPL과 같은 송신기·연타 보호·5ms 점검·재전송, `03-ctrl-c.md` 2.3, terminate 없음) | `"sent"`            |
| I4  | 그 밖                                                  | 없음                                                                                                       | `"ignored"`         |

게이트는 core 세션 `pythonRunning = alive && inputReadsPending === 0 && !driver.isIdle()`이고 runner의 `isIdle()`은 `active?.phase !== "sent"`다.

- `stop(): Promise<"idle" | "stopped" | "restarted">`:

| 호출 시점                        | 동작                                                                                                                                                               | 반환          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| 실행 없음(`ready` 등)            | 배경 task의 열린 읽기가 있으면 그것만 취소                                                                                                                         | `"idle"`      |
| 로딩·재시작 대기 중인 run        | 대기 취소(위 표)                                                                                                                                                   | `"idle"`      |
| 실행 중                          | 열린 입력 읽기가 있으면(`waiting-input`) 읽기 취소(`KeyboardInterrupt`), 없으면 interrupt 송신. **호출 시각부터 1000ms**(`STOP_FALLBACK_MS`) 안에 `run()`이 끝나면 | `"stopped"`   |
| 실행 중, 1000ms 안에 끝나지 않음 | worker를 terminate하고 새로 만든다(`restarting`). `run()`은 `{ kind: "restarted" }`. 새 worker 생성(`createWorker`)이 던져 `crashed`가 돼도 같다                   | `"restarted"` |
| `dispose()` 뒤                   | —                                                                                                                                                                  | `"idle"`      |

`stop()`을 겹쳐 부르면 첫 호출의 Promise를 공유하고 타이머는 첫 호출 시각부터다. `stop()` 중에 새로 시작된 읽기(`KeyboardInterrupt`를 잡고 다시 `input()`을 부른 프로그램)는 provider를 거치지 않고 즉시 취소한다. `"stopped"`는 결말이 무엇이든(`interrupted`이든 크래시·`dispose()`이든) worker 교체 없이 실행이 끝났다는 뜻이다.

- `KeyboardInterrupt`를 삼키는 루프(`while True: try: … except KeyboardInterrupt: pass`)는 interrupt로 끝나지 않으므로 `stop()`은 폴백(`"restarted"`)이 되고 Ctrl+C만으로는 끝낼 수 없다.

### 14.3.4 `reset()`·`dispose()`·크래시

- `reset()`은 옛 세션을 끝내고(열린 읽기 버림, 송신기 취소, RPC dispose, worker `terminate()`) 새 세션을 시작한다(`restarting`). 변수·import가 모두 초기화된다. `crashed`·`load-failed`에서도 복구한다. `dispose()` 뒤·`not-isolated`에서는 no-op. `stop()` 폴백도 같은 교체 경로다.
- `dispose()`는 worker·RPC를 정리하고 실행·대기 중 run을 `RunRejectedError("disposed")`로 끝낸다. 두 번 불러도 안전하다. `dispose()` 뒤에는 `onStatus`·`onOutput`·`onCrash`를 부르지 않고 `status`도 바뀌지 않는다(열린 읽기를 버린 뒤의 재개 알림 포함).
- 크래시: worker `error` 이벤트나 `crashed` 알림이 오면 열린 읽기를 버리고(판정 규칙은 `08-session.md` 8.1 D1~D5) 상태 `crashed` → 실행·대기 중 run은 `RunRejectedError("crashed")`. 크래시 뒤 새 `run()`은 `unavailable`이다. 자동 재생성은 없고 복구는 `reset()`이다(REPL `08-session.md`와 같다). 재생성 중 `createWorker`가 던져도 `crashed`가 된다(첫 생성이 던지면 `createRunner`가 던진다).

- 상태 콜백 재진입: `onStatus` 콜백 안에서 `run()`·`stop()`·`reset()`·`dispose()`를 불러도 된다. `createRunner`는 콜백을 부르기 전에 슬롯·`stop()` 결말을 확정하고 콜백 뒤에 세션·슬롯을 다시 확인한다. 그래서 `crashed` 콜백 안의 `reset()`(자동 복구)에서도 실행 중이던 run은 `crashed`로 거부되고 `onCrash`는 불리며, `load-failed` 콜백 안의 `reset()`에서도 대기 run은 `unavailable`이다. `ready` 콜백 안의 `reset()`은 대기 run을 새 worker의 `ready`까지 미루고, `running` 콜백 안의 `reset()`·`dispose()`는 그 run을 `restarted`·`disposed`로 끝낸다(`runCode`는 알림 전에 옛 worker로 이미 보냈다). `restarting` 콜백 안의 `dispose()`·`reset()`은 방금 만든 worker를 정리한다(누수 없음). `onRunAccepted` 콜백도 같은 규칙이다: 콜백 안의 `run()`은 `busy`로 거부되고, 콜백 뒤에 `disposed`·슬롯·세션이 바뀌었으면 `runCode`를 보내지 않으며(`stop()`은 `unavailable`, `dispose()`는 `disposed`, `reset()`은 새 worker의 `ready`까지 미룬다), 콜백이 던지면 슬롯을 풀고 그 오류로 `run()`을 reject한다. `onStatus`·`onCrash`·`onLoadFailed`가 던지는 경우는
  다르다(`onRunAccepted`는 대상이 아니다) — 규칙: `08-session.md` 8.5.

### 14.3.5 worker(세션)마다 새 interrupt buffer

`createRunner`는 worker(세션)를 만들 때마다 interrupt buffer와 송신기를 새로 만든다. 옛 worker는 `terminate()` 뒤에도 Chromium에서 스크립트가 끝나지 않는 상태(Python 루프)이면 최대 약 2초 살아 있다(실측: Playwright `close` 이벤트가 `terminate()`로부터 약 2.0초). 그동안 옛 worker의 SIGINT 폴링이 같은 buffer의 눌림을 소비·ack하고 `KeyboardInterrupt`를 삼키면 새 worker의 첫 눌림(Ctrl+C·`stop()`)이 유실된다(폴백 프로브 N=8 중 수정 전 6회 유실, 수정 후 0회). node의 `worker.terminate()`는 즉시라 node 시험만으로는 재현되지 않는다(`docs/traps/TRP-049`). 메일박스는 이미 세션마다 새로 만들었다(`00-architecture.md` 3.4).

REPL(`createRepl`)도 같다: `startSession`(`session.ts`)이 세션마다 buffer·송신기를 만들고 `ReplSession.interrupt()`가 그 송신기로 보낸다(`08-session.md` 8.1 4번). 이전에는 REPL이 buffer를 핸들 수명으로 한 번 만들어 리셋 사이에 재사용했고, 브라우저 `session-reset-check.mjs`의 `ccafter`(실행 중 리셋 직후 첫 Ctrl+C, N=8)에서 유실 1/8이 관찰됐다(수정 후 0/8). `Atomics.store(SIGNAL, 0)`으로 옛 SIGINT를 지우는 단계는 없어졌다. runner는 소유 주체가 `createRunner`이고 REPL은 `startSession`이다. buffer·송신기 생성 두 줄이 두 곳에 남아 있고 공통 도우미 추출은 하지 않았다.

### 14.3.6 알려진 경계

- 폴백 재생성은 실제 브라우저 worker에서 옛 worker가 닫히는 순서까지 관측하지 않았다. node worker 스레드(옛 worker의 `terminate()`를 지연시키는 시험 공장)와 브라우저 프로브·`runner-check` R04~R06으로 확인했다.
- `stop()` 폴백이 1000ms 안에 끝나는지는 제품 사양의 시간 의존이다. 매우 느린 장비에서는 정상 중단도 `"restarted"`가 될 수 있다(e2e는 ms 상한을 두지 않는다, `09-testing.md` 9.7).
- 깊게 중첩된 식은 컴파일 중 pyodide 치명 오류로 worker를 죽일 수 있다(14.2.4). 입력 길이·중첩의 사전 검사는 없다.

## 14.4 `InputProvider`

```ts
type InputProvider = (
  prompt: string,
  signal: AbortSignal,
) => Promise<string | null | typeof STDIN_EOF>;
```

- 호출 시점: Python이 `input()`·`sys.stdin` 읽기를 시작해 worker가 메일박스에서 정지했을 때 한 번(읽기 한 건당).
- `prompt`: 그 시점 화면의 미종결 마지막 줄(stdout·stderr를 화면 순서로 먹인 core `createOutputTail`의 값, SGR 포함). 새 run 시작(`runCode` 전송 시점)과 읽기 시작에 꼬리를 비운다. 실행 시작에 꼬리가 비어 있다는 전제이므로 소비자는 이전 run이 미종결 줄로 끝났다면 실행 전에 줄바꿈을 처리한다(terminal은 14.5.4).
- 반환: 개행 없는 한 줄이면 그 줄이 `input()`의 값, `null`이면 읽기 취소, `STDIN_EOF`(`@cp949/runo-pyodide-core`)면 입력 끝(EOF, RD-048, `06-editing.md` 6.9)다. 문자열·`null`·`STDIN_EOF`가 아닌 값은 `null`로 본다. provider가 reject하거나 동기 throw하면 `input()`은 `OSError`로 끝난다(`mailbox.fail`).
- **provider 생략 또는 `null` → 읽기 취소 → `input()`은 `KeyboardInterrupt`이고 결과는 `interrupted`다. `EOFError`가 아니다.** `null`은 여전히 취소 전용이다 — EOF가 필요한 provider는 `STDIN_EOF`를 돌려줘야 한다(`null`을 EOF 대신 쓰지 않는다, `docs/traps/TRP-044`). CANCELLED는 worker stdin 콜백이 `signalInterrupt` + `checkInterrupt`로 `KeyboardInterrupt`로 바꾸고, `STDIN_EOF`는 메일박스 EOF 표식을 거쳐 SIGINT 없이 pyodide `null`(EOF로 해석됨)이 된다(`04-stdin-input.md` 3.1).
- `signal`: 다음 사건에서 abort된다 — Ctrl+C(`interrupt()`)·`stop()`·`reset()`·`dispose()`·크래시. abort될 때 core가 이미 읽기를 끝냈으므로(살아 있으면 메일박스 cancel, 세션이 사라졌으면 `08-session.md` 8.1 D2가 버린다) 그 뒤 provider가 돌려주는 값은 버려진다. 사건 종류는 알려 주지 않는다. provider는 abort에서 자기 입력 UI를 정리해야 한다(안 하면 다음 입력이 죽은 읽기로 들어간다, `docs/traps/TRP-045`).
- `interrupt()`·`stop()`이 열린 읽기를 취소하면 provider의 `signal`이 abort되고 Python에는 `KeyboardInterrupt`가 간다.

## 14.5 실행창 `createTerminalRunner`(terminal)

`createTerminalRunner(options): TerminalRunnerHandle`(terminal `.` 진입점, `src/terminal-runner.ts`).

옵션: `terminal`(필수, 호출자 소유 xterm `Terminal`, dispose하지 않는다)·`createWorker`(필수)·`pyodide?`·`filename?`·`topLevelAwait?`·`clearOnRun?`(기본 `false`, `=== true`만 켠다)·`copyOnSelect?`(기본 `true`, `=== false`만 끈다)·`onCopy?`·`inputProvider?`(주면 xterm 입력 대신 이것이 받는다)·`onStatus?`·`onOutput?`·`onCrash?`. 핸들: `run`·`stop`·`reset`·`clear`·`dispose`·`status`·`setCopyOnSelect`(`interrupt()`는 핸들에 없다: Ctrl+C가 부른다). terminal `.`는 core의 `RunRejectedError`(값)와 `InputProvider`·`OutputChunk`·`RunRejectedReason`·`RunResult`·`RunnerStatus`·`StopResult`·`CopyResult` 타입을 다시 내보낸다(같은 클래스라 `instanceof`가 성립한다). 옵션이 틀리면(빈 `filename` 등) core가 동기로 던지고 그 전에 붙인 줄 편집기·선택 복사는 정리된다.

### 14.5.1 구성

- 화면 조립은 terminal `./internal`의 surface(`createTerminalSurface(terminal, { copyOnSelect, onCopy, readline })`, `src/surface.ts`)가 소유한다(REPL과 같은 module). surface가 선택 복사(`createSelectionCopy`)를 `Readline`보다 먼저 만들고 `Readline`의 `onKeyEvent`를 선택 복사에 묶은 뒤 `terminal.loadAddon`한다. 실행창은 정책만 넘긴다: `readline: { persist: false, typeAhead: false }`. `typeAhead: false`는 벤더 옵션이다(`06-editing.md` 6.1).
- 세션 입출력은 `surface.openIo()`가 준다: `{ terminal, sinks, close }`(RD-027 뒤 `sinks`는 쓰기 4종만, `inputReader` 필드는 삭제됐다). 실행창은 runner당 한 번 열고 `dispose()`의 `disposed = true` 다음 줄(`core.dispose()` 앞)에서 `io.close()`를 부른다. `io.terminal`은 `close()` 뒤에 write 콜백을 전달하지 않는 터미널 뷰다(TRP-004, 14.5.5).
- 출력: `onOutput`의 stdout은 `sinks.write`(개행 강제 없음), stderr는 `sinks.writeErrorRaw`(조각마다 빨강)로 그린다. 로드 실패는 빨강 한 줄 `pyodide 로드 실패: <message>`(REPL과 같은 문구), 비격리는 노란 안내(14.5.6).
- 기본 입력 provider는 `surface.promptRow`(RD-027, 구 `stdin-reader`의 `createInputReader`)의 `read("", { cancelable, signal, history: false })`다: 직전 출력의 꼬리를 프롬프트로 그 자리에 다시 그려 한 줄을 읽는다(`04-stdin-input.md` 3.3, "현재 io"의 꼬리를 쓰고 core가 넘긴 `prompt`는 무시한다). 프롬프트는 REPL `>>> `가 아니라 직전 출력의 꼬리다(`input("이름: ")`이면 `이름: `).

### 14.5.2 키 정책

- 입력은 `input()` 읽기가 열린 동안에만 받는다(한 줄 편집: 커서 이동·Backspace·Ctrl+U 등 벤더 동작, Enter로 제출). 읽기가 없는 구간(실행 중, 로딩 중, 결과 뒤 `ready`)에 들어온 문자·붙여넣기·IME 조합 결과·Shift+Enter는 버린다. 쌓았다가 다음 읽기에서 재생하지 않는다(REPL의 type-ahead `06-editing.md` 6.7과 반대, 편차 52).
- 차단 기준은 "`input()` 대기 중인가"가 아니라 벤더의 `activeRead === undefined`다. `input()` 프롬프트를 그리는 `read()`도 write 콜백이 오기 전(수 ms)에는 활성 읽기가 아니라서 그 사이 친 키도 버려진다. 브라우저 자동화는 프롬프트가 화면에 그려진 뒤(입력줄이 보인 뒤)에 입력한다(`apps/demo/e2e/checks/runner-check.mjs`의 `waitPrompt`). REPL 하니스의 `typeWhenReading()`·`clear()`는 실행창에서 쓸 수 없다(첫 글자가 버려져 에코 대기가 시간 초과, `clear()`는 프롬프트 재그리기를 기다린다).
- 붙여넣기·IME 덩어리 안의 Ctrl+C(다중 토큰)는 읽기가 없으면 핸들러 없이 버려진다. 단독 `\x03`(Ctrl+C)·단독 Ctrl+L만 읽기 밖에서도 즉시 처리한다(`isImmediateKey`).
- history는 남기지 않는다. 기본 provider가 `promptRow.read("", { cancelable: true, signal, history: false })`로 부르고 `promptRow`가 벤더 `read()`에 `ReadOptions.history: false`를 넘겨 Enter 제출을 history에 넣지 않는다(`06-editing.md` 6.1). `persist: false`는 localStorage 저장만 끄므로 이것만으로는 막지 못한다(`docs/traps/TRP-046`). 2026-09-26 전에는 벤더에 건너뛰는 옵션이 없어 읽기 앞 `getHistory().entries.slice()`를 잡고 읽기 뒤(정상·취소·예외) `history.restore(snapshot)`로 되돌렸다. 차이: 옛 `restore`는 취소로 끝난 읽기에서도 탐색 커서를 처음으로 되돌렸고 새 경로는 Enter에서만 되돌린다 — 실행창 history는 항상 비어 있어(`persist: false`, 유일한 append 경로였던 Enter가 생략되고 `readline`을 밖에 내보내지 않는다) ↑가 커서를 옮기지 못하므로 관찰 가능한 차이는 없다(코드 읽기 근거).

### 14.5.3 Ctrl+C

| 상태                                                                                                                                          | Ctrl+C 동작                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 텍스트 선택이 있음(모든 상태)                                                                                                                 | 복사하고 선택을 지운다. 인터럽트·취소 없음(`06-editing.md` 6.6이 가로챈다)                                                                                                                                                               |
| `waiting-input`, 읽기가 화면에 열려 있음                                                                                                      | 벤더가 `cancelable` 읽기를 `null`로 끝낸다(`^C` 표시 없음, 줄바꿈만). `input()`은 `KeyboardInterrupt`, 결과 `interrupted`. 벤더가 core `interrupt()`를 부르기 전에 가로챈다(`setCtrlCHandler`는 활성 읽기가 없을 때만 불린다, 아래 참고) |
| C1: 그 밖, `runner.interrupt()`가 `"sent"`를 돌려줌(`running`)                                                                                | 전송 뒤 `^C`를 개행 없이 화면에 쓴다(꼬리에 남아 다음 `input()` 프롬프트에 이어진다, `t^Cx`)                                                                                                                                             |
| C2: 그 밖, `runner.interrupt()`가 `"input-cancelled"`를 돌려줌(`waiting-input`, 읽기가 아직 그려지기 전이거나 `inputProvider`를 직접 준 경우) | `^C`를 쓰지 않는다. 기본 provider의 그리기 전 읽기는 아래 abort 정리가 줄바꿈을 낸다. 직접 준 `inputProvider`는 화면에 쓰지 않는다                                                                                                       |
| C3: 그 밖, `runner.interrupt()`가 `"ignored"`를 돌려줌(`ready`·`loading` 등)                                                                  | 무동작(`^C`도 없음)                                                                                                                                                                                                                      |

`setCtrlCHandler`는 벤더에 활성 읽기가 없을 때만 불린다(읽기 중 Ctrl+C는 위 행처럼 벤더가 직접 처리한다). 불렸을 때의 화면 동작은 core `interrupt()`의 반환값(결과) 기준이다 — 호출 시점의 `status`를 따로 읽지 않는다(규칙: `interrupt()` 정의는 14.3.3, 판정 ID는 C1~C3).

읽기가 열린 채 `signal`이 abort되면(`stop()`·`reset()`·크래시·`interrupt()`) 기본 provider가
`promptRow.endRead(disposed ? { screen: false } : { screen: true })`(RD-027·RD-028, 구
`readline.cancelRead({ settle: !disposed })`)로 열린 읽기를 끝낸다(history는 건드리지 않는다). settle이 화면을 정리한다
(`06-editing.md` 6.1 상태표): 배경 출력 재그리기 콜백 전이라 아직 그리지 않은 접두가 있으면 접두를 자기 행으로 남기고
(`05-output.md` 4.4), 그려진 읽기면 커서를 감긴 입력의 끝으로 옮겨 다시 그린 뒤 `\r\n`을 쓴다. settle이 실패하면 벤더
`hasPendingRead()`(취소 앞에서 읽은 값)로 나눈다: 그리기 전 읽기가 있었으면 무조건 `promptRow`의 "개행 쓰기"(현재 io가 있으면
`sinks.write("\r\n")`, 없으면 `readline.write("\r\n")`)를 내고, 없었으면 현재 io 꼬리에 보이는 글자가 있을 때만 낸다(RD-028
`design.md` §3 — REPL reset(`08-session.md` 8.1 1번)·`repl-main-driver.ts`의 `runSource` 대기 슬롯 실행(`breakLine()`,
RD-029로 `terminal/source-bridge.ts` 흡수)과 같은 재료로 통일했다. 옛
`"always"` 인자는 없앴다). 판정은 `tail() !== ""`가 아니라 core `leavesVisibleText(tail())`다(DELTA-05) — 색을 안 닫고
개행으로 끝난 출력은 꼬리에 열린 SGR만 남아 문자열은 비지 않지만 화면에는 보이는 글자가 없다. abort 경로에서 settle이 실패하는
경우는 거의 항상 "그리기 전 읽기 있음"이라(그 읽기 자체가 취소 대상) 이
바이트는 옛 `"always"`와 실무상 같다 — 실행창 abort의 빈 행(이슈 01 가설)은 결함이 아니라 그려진 읽기를 settle한 결과(F1)와
같은 행 수를 만드는 것뿐이다(design.md Q1). `screen: false`(`dispose()` 중)에는 settle하지 않고 화면에 쓰지 않는다.
그래야 이어질 `KeyboardInterrupt` 트레이스백이 입력줄에 붙거나 감긴 입력 위에 겹치지 않고(커서가 입력 중간 행에 있어도 입력
아래 행에서 시작한다), 다음 Enter가 죽은 읽기로 들어가지 않는다. RD-026까지는 provider가 `undrawnAbovePrefix()`를 취소 앞에서
벤더 `write`로 남기고 취소 뒤 `\r\n`을 직접 썼다 — 커서가 감긴 입력 중간이면 트레이스백이 입력 둘째 행에 겹쳤다. 사유는
provider가 구분하지 못하므로 `reset()`·크래시 뒤에도 줄바꿈이 남고 다음 `run()`은 커서가 행 머리라 줄바꿈을 더하지 않는다.

### 14.5.4 `run()` 시작 화면 규칙

`run()`이 받아들여질 때 화면을 준비한다.

- `clearOnRun: true`이면 `promptRow.clear()`(RD-027)가 화면과 스크롤백을 지우고(`\x1b[H\x1b[2J\x1b[3J`) 꼬리를 비운다.
- 아니면(기본) `promptRow.breakLine()`(RD-027·RD-028)가 현재 io 꼬리에 보이는 글자가 있을 때만(`leavesVisibleText`, SGR만
  남은 꼬리는 "없음", DELTA-05) `\r\n` 한 번을 쓰고 그 꼬리를 비운다(보이는 글자가 없으면 무동작 — 조건 없는 `resetTail()`은
  없앴다, RD-010 세션 리셋과 같은 재료, `08-session.md` 8.1 1번). 커서(`cursorX`)는
  더 이상 보지 않는다(xterm의 비동기 파싱 때문에 같은 태스크에서는 낡을 수 있다, `design.md` F3). 실제 xterm이 이미 파싱을
  마친 대부분의 상황에서는 바이트가 커서 기준과 같다(`design.md` §5 B2). 이전 run이 `print("a", end="")`로 끝났어도 새 실행은
  새 줄에서 시작한다.
- 거부될 `run()`은 화면을 건드리지 않는다: 실행 중인 프로그램의 출력 한가운데서 화면이 지워지면 안 된다. core가 `run()`을 받아들인 순간을 `onRunAccepted`로 알리고(14.3) 실행창은 그 콜백에서만 화면을 준비한다. 실행창은 거부 조건(`disposed`·비문자열·`not-isolated`·`load-failed`·`crashed`·`busy`)을 다시 판정하지 않는다. `reset()` 직후 같은 틱의 `run()`과 대기 run이 있는 `onStatus("ready")` 콜백 안의 `run()`도 별도 예외 없이 core의 수락 판정을 따른다. 결과 Promise 정착 뒤 풀리는 플래그로 거부를 예측하면 이 두 경우에서 낡는다(`docs/traps/TRP-047`).
- `clear()`: 화면과 스크롤백을 지우고 꼬리를 리셋한다. 입력 읽기가 열려 있는 동안과 `dispose()` 뒤에는 무동작이다(활성 읽기의 앵커 행이 어긋나 입력줄이 사라진다. 벤더 Ctrl+L은 읽기 상태를 다시 잡지만 공개 API가 아니다). 사용자가 입력 대기 중 Clear를 눌러도 반응이 없다.
- `reset()`은 화면에 아무것도 내지 않는다(REPL의 `RESET_NOTICE`가 없다). 앱이 `onStatus("restarting")`으로 표시한다.

### 14.5.5 `dispose()`

`disposed = true` 다음에 `io.close()`로 터미널 뷰의 게이트를 닫고, runner를 끝낸다(열린 읽기의 `signal`이 abort돼
`promptRow.endRead({ screen: false })`(settle 없음)가 돈다 — `disposed`가 이미 참이다). 이어서 `surface.dispose()`가 선택
복사·줄 편집기를 뗀다(surface가 소유하는 순서는 이 둘뿐이고 서로 독립이다). runner를 먼저 끝내 화면을 나중에 떼는 순서(TRP-064)는
소비자가 소유한다. `Terminal`은 dispose하지 않는다. 두 번 불러도 안전하다. `promptRow`에는 dispose 뒤 write 콜백을 전달하지
않는 터미널 뷰(`io.terminal`)를 준다(xterm은 `term.dispose()` 뒤에도 write 콜백을 돌린다, `docs/traps/TRP-004`).

### 14.5.6 비격리

`crossOriginIsolated !== true`이면 worker를 만들지 않고 노란 안내 한 줄(`경고: cross-origin isolation이 꺼져 있어 Python 세션을 시작하지 않습니다. 서버가 COOP/COEP 헤더를 보내야 합니다.`, REPL `NOT_ISOLATED_WARNING`과 같은 문구, ADR-0004)을 쓰고 상태 `not-isolated`가 된다. `run()`은 `RunRejectedError("unavailable")`이고 화면·상태는 그대로다. 문구 상수는 terminal 안에 복제돼 있다(repl이 terminal에 의존하고 반대 방향 의존은 경계 시험이 막는다).

## 14.6 데모와 검증

- `apps/demo`의 `?view=runner`가 `RunnerView`를 렌더링한다(쿼리 없으면 REPL). plain 요소: `textarea`(`data-testid="code"`), 버튼 `run`·`stop`·`reset`·`clear`, `status`, 마지막 결과 `result`(JSON 텍스트, 거부는 `{"rejected":"<reason>"}`), 선택 복사 결과 `copy-result`, `terminal`. 새 실행을 시작하면 이전 결과를 지운다. 페이지당 xterm은 1개다(`lib.mjs` 셀렉터 `.xterm-rows > div`·`[data-testid="status"]`가 그대로 통한다). `createTerminalRunner`는 effect 안에서 만들고 cleanup에서 `dispose()`한다(StrictMode 이중 마운트에서 worker가 남지 않는다). RD-024부터 이 수명은 `<PythonRunner>` 컴포넌트가 맡고 `RunnerView`는 handle(`run`·`stop`·`reset`·`clear`·`focus`)만 부른다.
- 브라우저: `pnpm --filter demo e2e:runner-check`(normal 고정, 초기 3 + R01~R13 = 16셀), 비격리는 `pnpm --filter demo exec node e2e/checks/runner-check.mjs not-isolated http://localhost:4174`(N01~N05, 5셀). 기대 개수와 판정은 `apps/demo/e2e/BASELINE.md`. 실행창 화면에서 결과 칸(React 상태)은 xterm 화면 행보다 먼저 갱신될 수 있고 `result`는 마지막 값만 갖는다(`docs/traps/TRP-048`·`TRP-050`).
- node 시험: core `worker/run-driver-pyodide.test.ts`(실제 pyodide, 가설 8항목 + 분류·stdin·재진입), `run-driver-classify.test.ts`(실제 pyodide + 가짜 콘솔, 분기 전수), `run-driver.test.ts`(가짜 pyodide, 옵션·세션·export), `session/runner.test.ts`(가짜 worker·가짜 타이머), `session/runner-pyodide.test.ts`(실제 pyodide worker 스레드, `input()` 왕복·`stop()`·폴백·`reset()`·옛 worker 지연 종료 시뮬레이션). terminal `terminal-runner.test.ts`·`terminal-runner-screen.test.ts`(둘 다 jsdom + 실제 core `createRunner` + 공용 가짜 worker `@cp949/runo-pyodide-core/test-utils`, 공용 setup은 `./test/runner-setup`; 전자는 화면(sink)·입력(`Readline`)·Ctrl+C·선택 복사, 후자는 14.5.4 화면 준비 규칙 14건). 벤더 `type-ahead.test.ts`(`typeAhead` 옵션).
- 경계: terminal `package-boundary.test.ts`, `pnpm check-dist`(terminal 포함), `pnpm smoke:pack`(terminal tarball, `09-testing.md` 9.8).

## 14.7 등록한 편차와 인접 규칙

- `10-parity-deviations.md` 50~53: 뒤늦은 비동기 출력, `sys.modules` 유지, `input()` 밖 키 무시, import 기반 자동 패키지 로드.
- 종료 코드 int32 밖 `& 0xFF`(14.2.4)와 provider 생략 시 `KeyboardInterrupt`(14.4)는 사양 문구와 다른 결정이고 이 문서가 기준이다.
- REPL `runSource`(REPL globals에서 같은 `exec_in_console` 경로로 실행)는 `02-console-core.md` 5.6이다. 결과 유니온·거부 사유·`busy` 게터의 뜻은 14.3.2와 같고 표는 5.6.2에 있다.
