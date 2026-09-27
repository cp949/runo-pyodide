# pyodide-core

REPL·실행 driver가 공유하는 프로토콜·worker 커널·main 세션. UI·xterm·coincident에 의존하지 않는다. private이고 공개 API로 확정하지 않은 내부 계약이다(RD-020). 코드·문서·시험 이름에 쓰는 용어를 정의한다. main·worker·세션·읽기·인터럽트·채널의 일반 용어는 `packages/pyodide-repl/CONTEXT.md`를 따르고, 여기서는 core가 도입한 용어만 정의한다.

## Language

### 경계

**core**:
`@cp949/runo-pyodide-core`. 프로토콜(RPC·메일박스·interrupt buffer·초기화 프레임), worker 커널, main 세션을 한 벌로 가진다. 화면·줄 편집·REPL 루프는 모른다.
_Avoid_: 엔진, 런타임

**driver**:
core가 세션 동안 부르는, 소비자(REPL 등)가 채우는 인터페이스. main 쪽 `MainDriver`(`session/driver.ts`)와 worker 쪽 `WorkerDriver`(`worker/driver.ts`) 둘이 한 쌍이다. driver가 화면 상호작용과 세션 제어 흐름을 내고, core가 공통 순서·게이트·종료를 소유한다.
_Avoid_: 플러그인(`plugins`는 별개 개념, 아래 **worker 플러그인**), 콜백 모음, 어댑터

**driver 옵션**:
초기화 프레임의 `driver` 필드(`InitFrame.driver: unknown`). core는 값의 모양을 모르고 필드가 있는지만 검증한다. worker 쪽 `WorkerDriver.parseOptions(frame.driver)`가 값을 검증한다. REPL은 `{ topLevelAwait }`, 실행 driver는 `{ filename, topLevelAwait }`(`parseRunDriverOptions`).
_Avoid_: 설정, config

### main 쪽

**core 세션**:
`startCoreSession`이 만드는 main 쪽 세션 한 개. worker·`MessageChannel`·메일박스·초기화 프레임·RPC·`readInput` 처리·게이트·크래시·종료를 소유한다. `reset()`은 core 세션을 통째로 교체한다.
_Avoid_: 세션 매니저

**게이트**:
core 세션의 `pythonRunning = alive && inputReadsPending === 0 && !driver.isIdle()`. 거짓이면 Ctrl+C를 에코도 전송도 하지 않는다. `alive`·`inputReadsPending`은 core가, `isIdle`은 driver가 낸다.
_Avoid_: running 플래그

**`isIdle`**:
driver가 내는 "대상 Python 코드가 없어 Ctrl+C를 보낼 곳이 없는 구간인가". REPL은 `phase !== "idle"`(REPL 읽기
phase, `packages/pyodide-repl/CONTEXT.md`·`docs/design/08-session.md` 8.1)이다.

**출력 조각**:
`OutputChunk = { stream: "stdout" | "stderr", text }`. core가 `write`·`writeErrorRaw` 알림을 세션 `output` 콜백에 넘기는 형식. Python이 쓴 원문이며 줄 끝 처리·색은 소비자가 정한다. `writeOutput`·`writeError`(값 에코·트레이스백)는 core가 아니라 driver 핸들러다.
_Avoid_: 로그 줄

**핸들러 합성**:
RPC 끝점을 만들 때 core 핸들러 표와 driver 핸들러 표를 `composeRpcHandlers`로 한 표로 합치는 것. 이름이 겹치면 생성 시 예외이고 늦은 등록 API는 없다. main 쪽 core 표(`CORE_MAIN_HANDLER_NAMES`, worker → main)와 worker 쪽 core 표(main → worker)는 방향이 반대인 별개 끝점의 표다.
_Avoid_: 등록, 미들웨어

**읽기 seam**:
`MainDriver.readInput(cancelable, sessionEnded)`. `input()`·`sys.stdin` 읽기 한 건을 driver가 수행해 줄, `null`(취소), `STDIN_EOF`(입력 끝, RD-048)로 돌려주는 내부 경계다. 공개 `InputProvider`가 아니라 core 내부 seam이고, `createRunner`가 이 seam 위에 공개 `InputProvider`를 얹는다(RD-022). 세션이 끝난 뒤의 결과 폐기는 core가 자기 플래그(`ended || crashed`)만으로 판정한다(`docs/design/08-session.md` 8.1 D1~D5) — driver는 오류 종류를 알리지 않는다. `sessionEnded`는 같은 판정의 조회 함수다(8.1 D6).

**메일박스 응답**:
`input()` 읽기 한 건에 main이 메일박스로 돌려주는 결말: 줄(`line`)·취소(`cancelled`)·입력 끝(`eof`)·오류(`error`). 규칙:
`docs/design/01-protocols.md` 2.2·2.5. worker 쪽 실제 경로는 `wait()`, main 쪽 시험용 관찰은 `takeMailboxResponse`·`peekMailbox`(`./test-utils`로만).

**`STDIN_EOF`**:
`protocol/stdin-eof.ts`가 내보내는 `unique symbol`. 빈 입력줄의 실제로 친 Ctrl+D가 만드는 입력 끝 표식(RD-048, `docs/design/06-editing.md` 6.9) — `null`(취소)과 값이 다르다. `InputProvider`가 EOF를 알리려면 이 값을 돌려준다(`docs/traps/TRP-044`).

### worker 쪽

**worker 커널**:
`runWorker({ driver, plugins? })`·`bootWorker`. 초기화 프레임 수신 → driver 옵션 검증 → RPC 생성 → pyodide 로드 → interrupt 공개 API 확인 → `plugins` 준비 → `driver.createConsole` → `driver.probe` → **`attachRuntime`** → `ready` → 감시 타이머 → `driver.run` 순서를 소유한다.
_Avoid_: 부트로더, 런처

**`attachRuntime`**:
`worker/runtime-attach.ts`의 `attachRuntime(pyodide, pyconsole, { interruptBuffer, stdin, report })` → `{ interruptIdle, destroy() }`. Python 런타임 연결(WebLoop 재보고 억제·SIGINT·stdin)의 유일한 진입점이다. 순서·실패 처리는 `docs/design/03-ctrl-c.md` 2.6.
_Avoid_: 초기화

**init 필터**:
core `./worker` 모듈이 평가될 때 worker 전역에 거는 `message` 리스너(`init-receiver.ts`). 먼저 온 프레임은 버퍼에 두고 `runWorker`가 꺼내 부팅한다. `core/worker`는 top-level await가 있는 모듈의 import보다 앞선 정적 import여야 하고(dom-bridge를 쓰면 dom-bridge `./worker` 다음), 이 순서를 지키면 `runWorker` 호출 시점은 자유다. 리스너는 `runWorker`를 부르지 않아도 import 시점에 걸린다. `kind: "init"`인 객체만 소비한다. 배열 메시지(다른 프로토콜)는 넘기고, `kind`가 다른 메시지는 오류를 남기되 리스너를 유지한다. init 후보를 받으면 리스너를 뗀다.
_Avoid_: 첫 메시지 리스너, once 리스너

**worker 플러그인(`WorkerPlugin`)**:
`runWorker({ driver, plugins })`에 넘기는 `{ name, prepare({ pyodide }) }`. `bootWorker`가 `loadPyodide`와 interrupt 공개 API 확인 뒤, `driver.createConsole` 앞에서 배열 순서로 하나씩 `prepare`를 await한다. 던지거나 reject하면 `loadFailed`이고 페이로드는 `Error: plugin "<name>": <원인>`이다. 해제 훅은 없다(worker는 terminate로 끝난다). 소비자 예: `@cp949/runo-pyodide-dom-bridge`의 `domBridge()`.
_Avoid_: driver(화면 상호작용·세션 제어 흐름을 채우는 별개 인터페이스), 미들웨어

**콘솔 뼈대**:
`installStdioWriters`(전역 stdout/stderr Writer)와 `createCoreConsole`(`PyodideConsole` 생성 + 콜백, 파일명 기본 `<console>`). `sys.ps1/ps2`·TLA 비트·헬퍼 namespace는 driver가 그 사이·뒤에 끼운다.
_Avoid_: 콘솔 베이스

**worker 세션**:
`WorkerDriver.createSession(options)`가 돌려주는 worker 한 개의 driver 상태(`handlers`·`createConsole`·`run`·`atPrompt`). 상태는 클로저에 둔다. worker 하나마다 새로 만든다.
_Avoid_: 싱글턴 driver

### 소비자 요구

**`test-utils/worker` subpath**:
`@cp949/runo-pyodide-core/test-utils/worker`(core `test/worker-internals.ts`, `development`·`types` 둘 다 소스,
`publishConfig.exports`는 `null`). repl 시험이 core worker 내부 부품(`attachRuntime`·`installSigintHandler`·
`installSleepSlice`·`createStdinCallback`·`suppressWebLoopReraise`·`createSinkWriter`)과 눌림 스레드 역할 URL
(`INTERRUPT_PRESSER_ROLE`)을 상대 경로 없이 가져다 쓰는 통로다. 옆의 `test-utils`(가짜 worker·부팅 하니스, `fake-worker.ts`)와
같은 패턴이지만 별도 subpath로 뗐다.
_Avoid_: 시험 전용 export

**core 타입 소비자**:
core `./worker`의 `.d.mts`를 import하는 코드. 그 파일이 `pyodide`·`pyodide/ffi` 타입을 import한다. core는 `pyodide`를 배포 `dependencies`가 아니라 optional peer(`^` 범위, Python 3.14 minor `314.x` 안의 타입 호환)로 선언하므로, 소비자가 같은 minor의 `pyodide`(+`@types/node`·`@types/emscripten`)를 직접 설치해야 한다(`README.md`, `docs/design/00-architecture.md` 4.4, `09-testing.md` 9.8.3, `13-version-upgrade.md` 13.7). repl만 쓰는 소비자는 해당하지 않는다.

### 실행 driver와 runner(RD-022)

**실행 driver(`runDriver`)**:
`WorkerDriver<RunDriverOptions>` 구현. 앱 worker 파일이 `runWorker({ driver: runDriver })`로 쓴다. RPC `runCode(source)`를 받아 run마다 새 globals에서 `CodeRunner(exec)` + `console.runcode`로 실행하고 결말을 돌려준다. REPL driver와 달리 제어 흐름이 없고 요청 단위로 일한다. `probe`는 없다.
_Avoid_: 스크립트 러너, 실행 엔진

**공용 실행 함수(`exec_in_console`)**:
core `run-driver.py`의 함수. 컴파일(`CodeRunner`, exec)·`await console.runcode`·결말 분류·stderr 쓰기를 한다. runner(`run_code`가 새 globals·새 stdin을 준비한 뒤 부른다)와 REPL `runSource`(REPL globals·stdin을 그대로 두고 부른다)가 함께 쓴다. TS 쪽 `loadExecInConsole`·`toRunOutcome`은 `./worker`가 export한다. 파일명은 `console.filename`이 기본이다.
_Avoid_: run_code(runner 전용 준비까지 포함한 함수)

**runner(`createRunner`)**:
main 쪽 UI 비의존 실행 핸들. worker 생성·재생성, worker마다 새 interrupt buffer·송신기, core 세션, 상태 8종, `run`·`stop`·`interrupt`·`reset`·`dispose`, 슬롯 점유 `busy`를 맡는다. `MainDriver`를 구현해 core 세션 위에 얹힌다. xterm 실행창(`createTerminalRunner`, terminal 패키지)과 다른 소비자가 이것을 쓴다. `interrupt()`는 `InterruptResult`(`"sent" | "input-cancelled" | "ignored"`)를 돌려준다(`docs/design/14-runner.md` 14.3.3).
_Avoid_: 세션 매니저, 실행기

**runner 상태**:
`RunnerStatus` = `loading`·`ready`·`running`·`waiting-input`·`restarting`·`load-failed`·`crashed`·`not-isolated`. REPL의 `ReplStatus`(6종)와 다르다(`terminated` 없음, 앞의 세 개가 새것). 전이표는 `docs/design/14-runner.md` 14.3.1.

**결말(`RunResult`)**:
`run()`이 코드가 실행됐을 때 돌려주는 값. worker가 만드는 `RunOutcome`(`ok`·`error{ errorType, traceback }`·`interrupted{ traceback }`·`exit{ code }`)에 main이 만드는 `restarted`를 더한 것이다. 코드가 실행되지 못했거나 실행 중 worker가 사라지면 값이 아니라 `RunRejectedError`로 reject한다.
_Avoid_: 반환값, 종료 상태

**`RunRejectedError`**:
`reason`이 `busy`·`unavailable`·`disposed`·`crashed`인 오류. `busy` = 이미 슬롯을 차지한 run이 있다(대기 중 포함), `unavailable` = 지금 실행할 수 없는 상태(`not-isolated`·`load-failed`·`crashed`, 대기 중 취소)다.

**실행 슬롯**:
runner가 한 번에 하나만 허용하는 실행 자리. 로딩·재시작 대기 중인 run도 차지한다. 슬롯이 차 있거나 `waiting-input`이면 새 `run()`은 `busy`다.

**수락(accept)**:
`run()`이 실행 슬롯을 차지하기로 확정된 것. 거부(`busy`·`unavailable`·`disposed`·비문자열)의 반대다. 수락된 `run()`마다 `onRunAccepted`가 슬롯 점유 뒤·`runCode` 전송 앞에서 동기로 한 번 불린다. `loading`·`restarting` 대기 중 수락도 즉시 불리고, 대기가 끝나 `ready`에서 실행이 시작될 때는 다시 불리지 않는다. 소비자(terminal 실행창)는 이 시점에만 화면을 준비한다.
_Avoid_: 시작(dispatch — `runCode`를 worker에 보내는 것. 대기 run은 수락과 시작 시점이 다르다), 승인

**폴백(stop fallback)**:
`stop()`이 interrupt를 보낸 뒤 `STOP_FALLBACK_MS`(1000ms) 안에 `run()`이 끝나지 않으면 worker를 terminate하고 새로 만드는 것. `stop()`은 `"restarted"`, 그 `run()`은 `{ kind: "restarted" }`. 타이머는 `stop()` 호출 시각부터다.
_Avoid_: 강제 종료, kill

**`InputProvider`**:
`(prompt, signal) => Promise<string | null | typeof STDIN_EOF>`. runner가 `input()`·`sys.stdin` 읽기 한 건마다 부르는 공개 입력 seam. `prompt`는 화면의 미종결 마지막 줄(출력 꼬리), `null`은 읽기 취소, `STDIN_EOF`는 입력 끝(RD-048, `docs/design/06-editing.md` 6.9), `signal`은 Ctrl+C·`stop()`·`reset()`·`dispose()`·크래시에서 abort된다. provider 생략과 `null`은 `KeyboardInterrupt`(`interrupted`)이지 `EOFError`가 아니다 — EOF가 필요한 provider는 `STDIN_EOF`를 돌려준다(`docs/traps/TRP-044`).
_Avoid_: 입력 콜백, 프롬프트 핸들러

**세션마다 새 interrupt buffer**:
runner와 REPL이 worker를 만들 때마다 interrupt buffer와 송신기를 새로 만드는 규칙. 옛 worker가 `terminate()` 뒤에도 Chromium에서 최대 약 2초 살아 같은 buffer의 눌림을 가로채는 것을 막는다. REPL은 `startSession`이 같은 규칙을 지킨다(이전에는 핸들 수명 buffer를 재사용했다).

### 호환 탐지

**`ready` 페이로드**:
`ReadyPayload = { pyodideVersion, versionMismatch, degraded, details? }`. worker가 부팅 중 한 번 탐지한 pyodide 호환 결과를 `ready` 알림에 싣는다(`docs/design/01-protocols.md` 1.2). 공개 API가 아닌 내부 계약이다.
_Avoid_: 상태 객체, 헬스 체크

**`versionMismatch`**:
로드된 `pyodide.version`이 core `PYODIDE_VERSION`과 다르다(완전 일치 비교, 범위 없음). 거부하지 않고 경고만 낸다.

**`degraded`**:
pyodide 비공개 API 지점이 기대와 달라 **해당 기능만 꺼진** 지점의 식별자 배열(`compiler-flags`·`incomplete-input-message`·`webloop-handlers`·`run-sync`·`sleep-slice`·`webloop-filename`). 표는 `docs/design/13-version-upgrade.md` 13.6. interrupt 공개 API 부재는 `degraded`가 아니라 시작 거부(`loadFailed`)다.
_Avoid_: 오류, 실패, unsupported

**`probe`**:
`WorkerDriverSession.probe?(context: { pyodide, pyconsole }): string[]`. driver가 자기 비공개 API 지점을 탐지해 `degraded` 식별자 배열을 돌려주는 선택 메서드다. core가 `createConsole` 직후 한 번 부르고 결과를 core 지점 4개와 합쳐 `ready`로 보낸다. 콘솔·전역 상태를 바꾸지 않아야 하고 던지면 `loadFailed`다.

**호환 경고**:
main core 세션의 `ready` 핸들러가 `versionMismatch` 또는 `degraded`가 비어 있지 않을 때만 세션당 1회 내는 `console.warn("[session] pyodide 호환 경고", { expected, actual, degraded, details })`. worker는 경고를 내지 않고 `report(id, detail)`로 수집기에 보고한다.
