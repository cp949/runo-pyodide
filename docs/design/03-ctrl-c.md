# Ctrl+C / SIGINT 프로토콜

> 이 문서의 규칙·상수는 이전 구현(`/work/cp949/pyodide-samples/apps/repl`, 읽기 전용 참고)이 CPython 3.14.4 pty 실측과 브라우저 회귀로 확정한 것이다. 새 구현은 통신 계층만 바꾸고(`docs/design/00-architecture.md`, `01-protocols.md`) 이 규칙은 그대로 지킨다. 절 끝의 "참고:" 경로는 이전 구현의 근거 위치다.

interrupt buffer의 슬롯 배치와 전달 경로 자체는 `01-protocols.md` 3절에 있다. 이 문서는 그 위의 프로토콜(요청 번호·ack·재전송, Python 핸들러, 감시 타이머, 연결 순서)이다. 새 구현에서 달라지는 점은 하나다: `readInput` 진입은 main이 메일박스 요청 알림을 받는 시점이다.

## 2.1 버퍼 슬롯

- `createInterruptBuffer()` = `new Int32Array(new SharedArrayBuffer(4 * 4))`,
  `INTERRUPT_BUFFER_LENGTH = 4`.
- `SIGNAL = 0` — main이 `2`를 쓰고 pyodide 폴링이 읽고 비운다.
- `ACK = 1` — 눌림이 worker에 전달됐다는 표시. **worker 스레드 한 곳만** 올린다.
- `SEQ = 2` — 요청 번호. 새 눌림마다 +1, 재전송은 같은 번호.
- `[3]` 예약.
- pyodide에는 **진짜 `Int32Array`를 그대로** 넘긴다. 접근자/Proxy를 끼우면 소실은 0이 되지만
  폴링 경로 비용이 통과선(plain 대비 1.05)을 넘는다(하한 1.095, TRP-024).
- `hasProtocolSlots(buffer) = buffer.length > SEQ`. 길이 3 미만 버퍼(옛 하니스)에서는 ack·번호·재전송이
  모두 no-op이고 SIGINT 슬롯만 동작한다.

## 2.2 쓰기·ack 규칙

- `signalInterrupt(buffer)`: **`Atomics.add(SEQ, 1)`을 먼저** 하고 그다음 `Atomics.store(SIGNAL, 2)`.
  SIGINT가 보이는 순간 핸들러가 읽는 번호가 이 눌림의 것이어야 새 눌림이 직전 눌림의 재전송으로 오인되지 않는다.
  새 SIGINT를 쓰는 경로는 main 송신기와 core `worker/stdin-callback.ts` 두 곳뿐이다(후자는 RD-008이 넣었다: core `worker/boot.ts`가
  주입한 `signalInterrupt` 클로저가 취소 표식을 받은 콜백 안에서 쓰고 `checkInterrupt()`가 그 자리에서 소비한다).
- 재전송은 번호를 올리지 않고 `Atomics.compareExchange(SIGNAL, 0, 2)`만 한다.
- ack를 올리는 지점은 셋뿐이다: ① 핸들러 진입(스택 검사·예외보다 먼저, 버려지는 SIGINT도 ack),
  ② 감시 타이머의 소비 성공(`compareExchange(2→0)`가 성공했을 때만), ③ 폐기(`discardPendingInterrupt`,
  `attachInterruptBuffer`)가 실제로 `2`를 지웠을 때만.
- 폐기가 ack 없이 슬롯만 지우면 송신기가 "소실"로 오판해 `2`를 되살린다(TRP-027).

## 2.3 main 송신기 상태기계(`createInterruptSender`)

- 옵션 기본값: `intervalMs = 5`, `maxResends = 10`. 타이머는 주입(`setTimer`/`clearTimer`,
  프로덕션은 `window.setTimeout`).
- `send()`: ack 값을 스냅샷 → `signalInterrupt` → 5ms마다 점검.
- 점검 1틱의 읽기 **순서는 `SIGNAL` 먼저, `ACK` 나중**. 반대로 읽으면 낡은 ack와 비워진 슬롯을
  소실로 오판한다.
  - ack ≠ 스냅샷 → 전달됨, 종료.
  - `buf[SIGNAL] === 2` → 아직 소비 전(블로킹 C 호출 등), 재전송하지 않고 다음 틱.
  - `buf[SIGNAL] === 0`인데 ack 그대로 → 폴링이 읽고 비우는 사이에 쓴 값이 지워진 것.
    같은 번호로 `compareExchange(0→2)`(최대 10회).
- 새 `send()`는 이전 요청을 교체한다.
- `cancel()` 지점: ack 증가(점검이 스스로 끝낸다), `readLine` 요청 도착, `readInput` 알림 도착,
  `sessionTerminated`, `loadFailed`, `dispose()`, 새 눌림. 새 worker 직전(슬롯 비우기 전)은 RD-010.
- **main 게이트 `pythonRunning`**(RD-007, 2.7): 거짓이면 `send()` 자체를 하지 않는다. 그래서 `exit()`·로드
  실패 뒤의 눌림이 슬롯에 SIGNAL 2를 영원히 남겨 5ms 점검이 무한히 도는 일이 없다(이전 구현 RD-012h(a)).

## 2.4 worker 핸들러(core `worker/sigint-handler.py`, `worker/sleep-slice.py`)

Python 소스는 `.py` 파일이고 TS가 `?raw`로 가져와 `runPython(source, { globals, filename })`에 넘긴다. 파일명은
`<sigint-handler>`·`<sleep-slice>`(트레이스백에 새면 알아보기 위한 이름이고, 절단은 문자열이 아니라 코드
객체로 한다).

- `sigint-handler.py`의 `install(console, ack, seq, report, extra_own_codes=())` → `interrupt_idle`.
  아래 규칙 ①~④, `run_sync`/`runcode` 래퍼, `pending`, `formattraceback` 확장, 설치 가드 3종이 여기 있다.
  `extra_own_codes`는 다른 모듈이 심은 우리 코드 객체 tuple이고 절단 목록(`own_codes`)에 합쳐진다.
- `sleep-slice.py`의 `install(report)` → 우리 코드 객체 tuple(`sleep`·`poll`) 또는 건너뛰었으면 `None`.
  `time.sleep` 20ms 조각과 설치 가드 2종은 이 파일이 가진다. `attachRuntime`(2.6)이 핸들러 설치 **전에**
  불러 돌려받은 tuple을 `installSigintHandler`의 `extraOwnCodes`로 넘긴다 — 그래야 sleep 중 중단 트레이스백에서
  조각 래퍼 프레임이 잘린다.

TS 쪽 표면은 `installSigintHandler(pyodide, pyconsole, deps, extraOwnCodes?)`(`deps` = `ack`·`seq`·`report`)와
`installSleepSlice(pyodide, { report })`이고, 둘 다 별도 namespace(빈 dict)에서 실행해 사용자 globals를
오염시키지 않는다.

1. **진입 첫 줄에서 `seq()` 확인**. `last_seq`와 같으면 ack도 예외도 없이 무시(재전송). 다르면
   `last_seq` 갱신 후 ack. `last_seq` 초기값은 설치 시점의 `buf[SEQ]`다. 두 경로 모두 worker(세션)마다 새 interrupt
   buffer를 만들어 이전 세션의 번호와 섞이지 않지만, 로딩 중 눌림(2.7 게이트는 `ready` 전에 참)이 있었으면 0이 아니다.
   그 번호를 처리한 것으로 보기 때문에, 부팅 중 눌림의 재전송(송신기는 ack 없이 같은 번호로 다시 쓴다, 2.3)이 연결 뒤
   시작 코드를 끊지 않는다(2.6의 `discard()`는 연결 순간의 SIGNAL만 지운다). 이 저장소의 `install(console, ack, seq, report, extra_own_codes=())`은
   `ack`·`seq`가 항상 필수 인자이고 `sigint_handler`가 무조건 호출한다 — 번호·ack 없이 동작하는 분기는 없다.
   (REPL `createRepl`의 `startSession`과 실행 driver의 `createRunner` 모두 worker마다 새 interrupt buffer·송신기를 만든다. 옛 worker가
   `terminate()` 뒤에도 최대 약 2초 살아 같은 buffer의 눌림을 가로채는 것을 막기 위해서다, `14-runner.md` 14.3.5.)
2. `frame.f_back`을 따라 `co_filename`이 콘솔의 `filename`(REPL은 `<console>`, 실행 driver는 `filename` 옵션 값 — 기본 `main.py`, `14-runner.md` 14.2.2)인 프레임이 **하나라도 있으면**
   `signal.default_int_handler`로 `KeyboardInterrupt`를 올린다(예외: `run_sync` 래퍼의 C 변환 구간, 아래 "깨우기 세부"). 정상 반환 후 다른 경로로 올리면 안 된다:
   `input()` 취소의 EINTR 경로에서 예외를 못 보면 CPython이 읽기를 다시 시도한다(PEP 475).
3. 사용자 프레임이 없고 **사용자 실행 중**(= `runcode` 안, 시간 조건 없음)이면 `interrupt_idle()`로
   정지한 실행을 깨운다. 깨우기는 핸들러 자리에서 하지 않고 `loop.call_soon`으로 한 틱 미룬다(미룬 콜백은 그 사이
   실행이 끝났거나 바뀌었으면 버리고, 깨울 것이 없으면 `pending`을 세운다). 핸들러는 asyncio 콜백의 bytecode 사이에서
   돌기 때문에 그 자리에서 Task를 취소하면 `_set_result_unless_cancelled`의 `cancelled()` 검사와 `set_result()` 사이에
   끼어 `InvalidStateError: invalid state`가 stderr에 찍힌다. 이미 깨운 대기(`woken`)가 있으면 미루지 않고 `pending`만
   세운다 — 그 대기가 올릴 `KeyboardInterrupt`에 합치며, 미루면 미룬 콜백이 그 전달 뒤에 돌아 한 번 더 올린다.
   감시 타이머 경로(`interrupt_idle()` 직접 호출)는 신호 처리 문맥이 아니라 JS 콜백이라 그대로 동기 취소한다.
4. 그 밖(트레이스백 생성 중, 다음 문장 컴파일 중)에는 **버린다**. 허용 목록 방식이고 arm/disarm 상태가
   없어 `KeyboardInterrupt`를 잡고 계속 도는 프로그램은 다음 SIGINT에 다시 중단된다.

깨우기 세부:

- `run_sync` 래퍼(`pyodide.webloop.run_sync`, `pyodide.ffi.run_sync` 교체): 대기 awaitable을 `guard`
  코루틴 Task로 감싼다. 깨울 때 Task를 취소해 `finally`를 돌린 뒤 `guard`가 `CancelledError`를 정상 값
  `WOKEN`으로 바꾸고, 래퍼가 사용자 스택(대기 호출 지점)에서 `KeyboardInterrupt`를 올린다. awaitable이 낸
  그 밖의 예외(`KeyboardInterrupt`·`SystemExit`·사용자 `CancelledError`·일반 예외)는 `guard`가 `Raised(exc)`에
  담아 정상 값으로 끝내고 래퍼가 `raise result.exc`로 그 객체를 올린다(인자·`__context__` 보존). Task가
  예외로 끝나면 pyodide가 Promise 변환에서 `PyErr_Print()`로 `sys.excepthook`을 부르고 콘솔 실행 중에는
  그것이 화면에 새기 때문이다(편차 28 해소, TRP-021). `GeneratorExit`만 재raise한다(코루틴 `close()` 신호를
  값으로 바꾸면 `RuntimeError`가 된다). 나르기 전 `trim(exc)`으로 트레이스백 머리의 우리 프레임(`guard`)을
  떼고 첫 우리 프레임(조각·핸들러)부터 안쪽 전부를 잘라 사용자·라이브러리 프레임만 남긴다. 래퍼의
  `ensure_future` 안에서 눌림이 처리돼 규칙 ①의 `KeyboardInterrupt`가 나면, 그 `guard` 코루틴을 소유한 Task가
  없을 때(Task 생성 전)만 `guard`와 시작 전(`CORO_CREATED`) awaitable 코루틴을 `close()`하고 다시 올린다 —
  버려진 코루틴의 `RuntimeWarning: coroutine ... was never awaited`가 트레이스백 앞에 찍히는 것을 막는다. Task를
  만든 뒤면 그 Task가 `guard`를 돌리므로 닫지 않는다.
  - **C 변환 구간**: 래퍼는 원본 C `run_sync`를 부르는 동안 `converting` 표시를 세우고 `finally`에서 내린다. C `run_sync`는
    대기 Task를 JS로 바꾸는 중(`python2js` → `pyproxy_getflags` → `type_getflags`, pyodide 314.0.7) `PyObject_IsSubclass`로
    `collections.abc.Generator`·`AsyncGenerator`를 검사하고, 이것이 `ABCMeta.__subclasscheck__` Python 프레임을 연다.
    그 프레임에서 처리된 눌림을 규칙 ①로 올리면 C 변환이 예외를 `ConversionError`(`__cause__` = `KeyboardInterrupt`)로
    감싸고, 이어지는 `PyErr_Print()`가 `sys.excepthook` 출력을 콘솔 `sys.stderr`로 흘린다(TRP-021과 같은 경로). 사용자
    `except KeyboardInterrupt:`도 이 `ConversionError`를 비켜 간다. 그래서 핸들러는 `converting`이 참이고 사슬에서
    `<console>` 프레임보다 안쪽에서 래퍼 프레임(`run_sync.__code__`)을 만나면 순회를 멈추고 규칙 ③으로 넘긴다:
    `call_soon(interrupt_deferred, active)` → 대기 Task 취소 → 래퍼가 `WOKEN`을 보고 사용자 스택에서 표준
    `KeyboardInterrupt`를 올린다. 깨울 수 없는 순간이면 `pending`이고 재개하는 래퍼가 올린다. 눌림 처리는 한 틱 늦다.
    표시와 사슬 검사가 둘 다 필요하다: 사슬만 보면 래퍼의 `ensure_future`(Task 생성 전 눌림, 규칙 ① 유지)도 미뤄지고,
    표시만 보면 대기 중 콜백 사슬의 `<console>` 프레임에도 규칙 ①이 미뤄질 수 있다. 래퍼 프레임보다 안쪽에 사용자 프레임이
    있으면(예: 사용자 ABC의 `__subclasshook__`) 규칙 ①이 그대로 올린다. 이 창은 자연 재현이 어려워
    `sigint-handler-idle.test.ts`의 `abc.ABCMeta.__subclasscheck__` 교체 주입 시험으로 확인한다(`09-testing.md` 9.1).
    `run_sync` 래퍼 밖 변환 지점은 같은 창이 있을 수 있으나 처리하지 않았다(`.scratch/sigint-test-isolation/issues/08-conversion-error-outside-run-sync-wrapper.md`, `deferred`).
- `runcode` 래퍼(인스턴스 속성 교체): 실행 중인 콘솔 task를 `active`로 기록. top-level await 대기 중에는
  그 task를 취소하고 표지 예외 `IdleInterrupt`(`Exception` 계열 — webloop 재던짐 경로를 피함)로 끝낸다.
- 취소는 `CORO_SUSPENDED` Task에만. 깨울 수 없는 순간(대기 코루틴 실행 중, 재개 직전)에는 `pending`
  플래그로 표시하고 재개하는 `run_sync` 래퍼가 `KeyboardInterrupt`로 올린다.
- **`time.sleep` 20ms 조각**(JSPI 유무와 무관하게 항상 교체): 원본은 `time.sleep.__wrapped__`(pyodide가
  `@wraps`로 남긴 원본 C 함수), 래퍼는 `functools.wraps(원본)`. 위치 인자 하나가 유한 양수 `int`/`float`
  (`bool` 제외) 또는 `__index__` 객체이고 9.2e9초 미만일 때만 조각한다. 그 밖(0·음수·NaN·inf·비수치·
  키워드·인자 개수 오류)은 원본에 그대로 넘겨 CPython 그대로의 예외 문구를 낸다. 20ms 초과는
  `end = monotonic() + secs`까지 `원본(min(20ms, 남은 시간))` + `poll()` 반복, **20ms 이하도 원본이 끝난 뒤
  `poll()`을 한 번 한다**(생략하면 지연이 반복 1회 시간의 약 13배까지 늘어난다, TRP-028).
  `poll()`은 `pyodide_js.checkInterrupt()`이고, 그 예외가 `sys.excepthook`으로 stderr에 트레이스백을
  찍으므로(TRP-022) 호출 동안만 `sys.excepthook`을 no-op으로 바꿨다 되돌린다.
- `formattraceback` 래퍼: **가장 안쪽 프레임이 우리 코드일 때만**(예외가 핸들러·래퍼·조각에서 시작)
  첫 우리 프레임부터 안쪽 전부를 절단하고, 자른 자리 바로 바깥에 붙은 `webloop.py` 프레임
  (`run_until_complete`)도 뗀다. 그 뒤 남은 프레임 중 **우리 프레임 개별**(`run_sync` 래퍼 등)을 떼고, 그
  바로 바깥에 붙은 `webloop.py` 프레임도 함께 뗀다(awaitable 안에서 난 `webloop.py` 프레임, 예:
  `call_later`의 `TypeError` 자리는 남긴다). 예: `[<module>, webloop _run, webloop run_until_complete,
run_sync 래퍼, main]` → `[<module>, main]`(래퍼가 나른 예외는 안쪽 끝이 사용자 프레임이라 첫 단계 절단에
  걸리지 않고, 개별 제거 단계만 적용된다). `IdleInterrupt`는 `KeyboardInterrupt` 한 줄로 만든다. 문자열에서
  `File "<sigint-handler>"` 줄을 지우는 방식보다 견고하다. 안쪽만 자르는 규칙은 연타에서 우리 프레임이
  샜다(2/10 → 0/10, RD-009a 전까지의 규칙이 첫 단계만이었을 때의 실측). 절단 규칙(`trim`·`formattraceback`)은
  `install()` 클로저 안에 두고 시험은 repl `sigint-handler*.test.ts` 시나리오가 맡는다. 모듈 수준 순수 함수와 core 표
  시험은 이 규칙을 다음에 고칠 때 그 수정에서 함께 한다(arch-review 04 후보 5 기각: 규칙이 바뀌지 않는 동안 분리하면
  "우리 프레임 판정"(`own_codes`)과 "절단"을 두 곳으로 가르고 시험을 이중 유지하게 한다).
- 설치 가드(pyodide 내부 의존) 5종. 핸들러(`sigint-handler.py`)의 셋: ① `pyodide.webloop.run_sync`
  ② `pyodide.ffi.run_sync` ③ `console.runcode`가 코루틴 함수. 조각(`sleep-slice.py`)의 둘:
  ④ `time.sleep.__wrapped__`가 원본 C 함수(`inspect.isbuiltin`) ⑤ `pyodide_js.checkInterrupt` 호출 가능.
  하나라도 다르면 **해당 부분만** 건너뛰고 어긋난 이름마다 `report(id, detail)`을 부른다(핸들러 가드 = `run-sync`, 조각 가드 =
  `sleep-slice`, core `boot.ts`가 수집기의 `report`를 넣는다). worker는 경고를 내지 않고 결과가 `ready` 페이로드 `degraded`·`details`로
  main에 가서 main이 `console.warn`을 1회 낸다(`01-protocols.md` 1.2, `13-version-upgrade.md` 13.6). 핸들러 가드가 걸려도 바쁜
  루프 중단과 조각은 살아 있고, 조각 가드가 걸려도 깨우기는 살아 있다.
- 트레이스백 파일명 가드(`webloop-filename`): `install`이 `pyodide.webloop.__file__`이 `pyodide/webloop.py`로 끝나는지 확인하고
  아니면 `report('webloop-filename', 경로)`를 부른다. 절단 규칙 `is_webloop`이 무효가 될 뿐 끌 기능이 없어 보고만 한다.

## 2.5 감시 타이머(`startInterruptWatch(deps)` → 중지 함수)

- `deps` = `interruptIdle`·`atPrompt`·`hasPending`·`consume`·`discard`·`tickMs = 20`. core `worker/interrupt-watch.ts`는 `protocol/`을
  import하지 않으므로 버퍼가 아니라 클로저를 받는다(core `boot.ts`가 넣는다): `hasPending` =
  `hasPendingInterrupt(buffer)`(`Atomics.load(SIGNAL) === 2`), `consume` =
  `consumeInterrupt(buffer)`(`compareExchange(2 → 0) === 2`이면 ack 후 `true`), `discard` =
  `discardPendingInterrupt(buffer)`, `atPrompt`는 `WorkerDriverSession.atPrompt()`가 돌려주는 값이다(REPL은 루프의 `setAtPrompt`가 갱신하는 변수를 읽는다).
- 이벤트 루프가 비는 구간(정지한 `run_sync`·`asyncio.run` 대기, top-level await 대기)에만 실제로 돈다.
- 엿보기는 `hasPending()`, 소비는 **깨웠을 때만** `consume()`. 깨울 수 없으면 SIGINT를 남겨 재개한 사용자 스택의
  폴링이 받게 한다. 소비 성공 시에만 ack.
- `interruptIdle()`의 **반환값에는 경합이 있다**: 핸들러 규칙 ③이 앞서 미뤄 둔 깨우기가 먼저 돌았으면 이 호출은
  깨울 것이 없어 거짓을 돌려줄 수 있다(SIGINT를 쓴 직후의 호출 안에서 폴링이 일어나면 핸들러는 깨우기를 예약만 하고
  이 호출의 본문이 깨운다). 거짓이 "깨우지 못했다"를 뜻하지 않는다. 결과는 어느 경로든 같다(깨어나고 ack는 정확히 한 번) — `consume()`의 비교 교환이 중복 ack를
  막는다. 깨어남은 경과 시간·화면으로, ack는 슬롯으로 본다.
- **프롬프트 유휴 폐기**: `atPrompt`가 참인데 깨울 것 없이 남은 SIGINT는 대상 코드가 없는 낡은 눌림이라
  그 틱에서 버린다(2를 지웠을 때만 ack). 실행 중(`atPrompt` 거짓) 규칙은 위와 같다.
- 타이머는 요청 번호를 확인하지 않는다(알려진 한계).
- 틱 콜백의 예외는 잡아 로그만 남기고 다음 틱에 재시도한다.
- `ready` 알림 뒤·`driver.run` 직전에 켜고(REPL은 배너·러너 생성 앞, 그 사이에 `await`가 없다), `driver.run`이 끝나면(REPL은 루프가 `exit()`로 끝날 때) 끈다. 세션 리셋은 worker 교체라 함께 사라진다.

## 2.6 연결 순서와 시작 코드 보호

- `attachRuntime(pyodide, pyconsole, { interruptBuffer, stdin: { requestInput, wait }, report })` →
  `{ interruptIdle, destroy() }`가 Python 런타임 연결의 유일한 진입점이다(core `worker/runtime-attach.ts`). `ack`·`seq`·
  `discard`·`signalInterrupt`는 attach가 `protocol/interrupt-protocol`에서 직접 import해 `interruptBuffer`로 묶는다 —
  호출자(core `boot.ts`, 시험 하니스)는 버퍼·`stdin`(전송 수단과 무관한 `requestInput`/`wait`)·`report`만 넘긴다. 부품
  `sigint-handler.ts`·`sleep-slice.ts`·`stdin-callback.ts`·`webloop-reraise.ts`는 여전히 `protocol/`을 import하지 않는다.
- 부팅 순서에서 위치는 `driver.createConsole`·`driver.probe` 뒤·`ready` 알림 앞이고(그보다 앞서 `loadPyodide` 직후 interrupt
  공개 API `setInterruptBuffer`·`checkInterrupt`가 함수인지 확인하고, 없으면 `loadFailed`로 시작을 거부한다) `try` 안이라
  실패하면 `loadFailed`다. 내부 규칙은 아래 표다(시험 제목의 `[A1]` 형식 ID, repl `worker/runtime-attach.test.ts`).

| ID  | 규칙                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | 순서: `suppressWebLoopReraise`(2.8) → `installSleepSlice` → `installSigintHandler` → `discardPendingInterrupt` → `setInterruptBuffer` → `setStdin(createStdinCallback(...))`. 폴링은 버퍼 연결 뒤에야 시작하므로 연결이 먼저이면 그 사이(Node 3.5~6.6ms)의 눌림을 pyodide 기본 핸들러가 받아 시작 코드가 죽는다(TRP-027) |
| A2  | `installSleepSlice`가 돌려준 코드 객체 tuple을 `installSigintHandler`의 `extraOwnCodes`로 넘긴다 — sleep 중 눌림 트레이스백에서 조각 래퍼 프레임이 잘린다(그래서 조각 교체가 핸들러보다 먼저다)                                                                                                                          |
| A3  | 연결 전에 쓰인 SIGINT(2)는 지우고 ack한다. 눌림이 없으면 ack는 그대로다                                                                                                                                                                                                                                                  |
| A4  | `setStdin`은 버퍼 연결 뒤다 — 그래야 stdin 취소 변환(`signalInterrupt(interruptBuffer)` → `checkInterrupt()`)이 `input()` 호출 지점의 `KeyboardInterrupt`가 된다                                                                                                                                                         |
| A5  | 핸들러 설치 뒤 단계(폐기·버퍼 연결·`setStdin`)가 던지면 `interruptIdle`(PyProxy)을 `destroy()`한 뒤 같은 오류를 다시 던진다 — 호출자가 부분 설치를 또 정리하지 않는다                                                                                                                                                    |
| A6  | `destroy()`는 `interruptIdle.destroy()`와 같다. `signal.signal`·`console.formattraceback`·`run_sync` 래퍼·`time.sleep` 조각 교체는 원복하지 않는다(`loadFailed` 뒤 worker는 main이 종료·재시작한다)                                                                                                                      |

- 돌려주는 `interrupt_idle` proxy는 감시 타이머가 쓰고 세션 끝(core `boot.ts`의 `finally`)에 `destroy()`로 놓는다.
- 시험 하니스(repl `test/console-harness.ts`, `worker/runtime-attach.test.ts`의 단위 시험)도 개별 설치를
  손으로 복제하지 않고 이 함수를 부른다 — 운영과 다른 조립이 시험을 못 잡는 사각지대가 없다.
- REPL 루프(repl `worker/repl-loop.ts`)는 `readLine`이 줄을 돌려준 직후, `runner.run` **전에** `discardPendingInterrupt(buffer)`로
  비운다(취소 `null`에도 적용). 읽는 동안이나 Enter 직후 쓴 SIGINT는 대상 코드가 없다(TRP-009).
  실행 driver(`runCode`)에는 이 단계가 없다. 틱 폐기 전에 온 다음 실행의 잔류 눌림은 `<console>` 프레임 전 driver Python에서
  규칙 ④가 버린다. 근거·시험·재검토 조건은 `14-runner.md` 14.2.6.
- 새 worker를 만들기 직전 main이 옛 세션의 `interruptSender.cancel()`로 재전송 타이머를 멈춘다. 새 세션은 새 buffer를 쓰므로 옛 buffer에 남은 SIGINT는 새 worker가 보지 못하고, `SIGNAL`을 지우는 단계는 없다(`08-session.md` 8.1).

## 2.7 main 쪽 Ctrl+C 처리

- `readline.setCtrlCHandler(...)`는 읽는 중이 아닐 때만 불린다. 눌림마다 `^C`를 **sink `write`로**
  에코하고(꼬리에 들어가야 한다) `interruptSender.send()`를 부른다. REPL은 게이트 → 에코 → 전송을 `ReplSession.interrupt()`
  (`session.ts`)가 한 연산으로 하고 핸들러는 `session?.interrupt()`만 부른다(RD-046).
- **게이트 `pythonRunning = alive && inputReadsPending === 0 && !driver.isIdle()`**(core 세션, RD-020). REPL driver의
  `isIdle = phase !== "idle"`(REPL 읽기 phase, `08-session.md` 8.1)이라 옛 식 `alive && !readLinePending && inputReadsPending
=== 0 && !cancelSettling`과 같은 불리언이다(`readLinePending`은 `phase ∈ {"opening","open","closing"}`, `cancelSettling`은
  `phase === "cancel-settling"`이었다, RD-029). 거짓이면 에코도 전송도 하지 않는다. `alive`·`inputReadsPending`은 core
  세션이, 읽기 phase는 REPL main driver(`repl-main-driver.ts`)가 소유한다. 각 항의 뜻:
  - `alive`: worker 생성부터 `sessionTerminated`·`loadFailed`·`dispose()` 전까지. 그 뒤에는 눌림이 닿을
    코드가 없다(3.14에도 프로세스가 없으므로 편차가 아니다).
  - `phase ∉ {"opening","open","closing"}`(`isIdle`의 첫 갈래): 수락한 `readLine`의 읽기가 끝나기 전. 요청 도착부터
    응답이 포트에 올라가기 전까지라 **읽기가 실제로 열리기 전의 갭(약 20ms)도 포함한다** — 그 사이 눌림은 에코 없이
    버려진다(Ctrl+C는 쌓이지 않는다. 대신 그때까지 쌓인 키를 비운다 — RD-019, `06-editing.md` 6.7. 편차 32 해소 뒤에도
    이 Ctrl+C 손실은 남는다, `docs/traps/TRP-005`).
  - `inputReadsPending === 0`: `readInput` 알림 도착부터 `deliver`/`fail`/`cancel`이 끝날 때까지. 값을 다 전달한
    시점이 worker가 깨어나 실행을 재개하는 시점이다.
  - `phase !== "cancel-settling"`(`isIdle`의 둘째 갈래, RD-008): REPL 읽기가 취소(`null` 응답)로 끝난 continuation에서
    이 phase가 되고, **`readLine` 도착·`readInput` 도착·`inputReadsPending → 0`** 세 지점에서 `idle`로 내려간다. 즉
    "취소 응답 → 다음 요청 도착" 구간을 덮는다. 위 첫 갈래가 덮는 "요청 도착 → 응답" 구간과 이어져 빈틈이 없다
    (`06-editing.md` 6.3). 불변식: worker가 코드를 돌리기 시작하는 모든 지점에서 게이트가 열린다. **`input()` 취소에는
    세우지 않는다** — 취소 뒤에도 사용자 코드가 계속 돌아 그 구간의 Ctrl+C는 중단이어야 한다(`04-stdin-input.md` 3.1의
    실측).
- 로딩 중(`ready` 전)은 참이다. 부팅 중 눌림이 실제로 버퍼에 써지고 worker의 연결 단계가 폐기한다(2.6).
  `readLine` 응답 뒤~다음 요청 전(배경 콜백이 CPU를 잡는 구간)도 참이다(편차 2).
- 입력줄 편집 중 Ctrl+C는 벤더 `Readline`의 cancelable 읽기가 처리한다(`06-editing.md` 6.1·6.3): 활성 읽기가
  있으면 `setCtrlCHandler`가 아예 불리지 않고 읽기가 `null`로 끝난다. worker는 `readLine`·`readInput`에
  `cancelable = true`를 보내며, `false`를 보내면 벤더 원본 동작(`^C` + 같은 프롬프트 재그리기)이다.

## 2.8 webloop 재보고 억제(`webloop-reraise.py`)

- WebLoop의 `_keyboard_interrupt_handler`·`_system_exit_handler`를 no-op으로 바꿔 `run_handle`이
  콜백 안의 `KeyboardInterrupt`·`SystemExit`을 다시 던지지 않게 한다. 정상 중단·`input()` 취소·`exit()`가
  내던 `pageerror`(시행당 2, 2, 1건)가 0이 된다. 화면 트레이스백과 `exit()` 종료는 그대로.
- pyodide private 속성이라 없으면 건너뛰고 없는 이름마다 `report('webloop-handlers', 이름)`을 부른다(main이 `console.warn` 1회, `13-version-upgrade.md` 13.6). 세션당 1회.
- 편차: Task 밖 콜백(`call_later` 등)에서 난 `KeyboardInterrupt`·`SystemExit`은 조용히 버려진다
  (`10-parity-deviations.md` 38).
- 이 억제 뒤 `vitest.config.ts`의 `onUnhandledError` 필터(`PythonError` + 줄 시작 `SystemExit|KeyboardInterrupt`)를
  실제로 제거했다. 억제 없이 필터만 떼면 스위트는 개별 시험이 다 통과해도 `Errors 210` + 종료코드 1이다(실측).
  억제를 넣으면 `Errors 0`이다. 시험 파일이 자기 pyodide 인스턴스를 만들 때는 그 조립에도
  `suppressWebLoopReraise`를 불러야 한다(core `boot.ts`의 배선은 그 인스턴스에 닿지 않는다).

## 2.9 텍스트 시퀀스

```
(A) 실행 중 정상 중단
main: Ctrl+C → pythonRunning() 확인 → sink.write("^C") → sender.send()
      SEQ+=1 → SIGNAL=2 → 5ms 타이머 시작
worker: 폴링이 SIGNAL을 읽고 0으로 비움 → 핸들러 진입
        seq 확인(새 번호) → ACK+=1 → 스택에 <console> 있음 → KeyboardInterrupt
        runcode 밖으로 전파 → formattraceback(우리 프레임 절단) → writeError
main: 다음 점검에서 ack ≠ 스냅샷 → 송신기 종료
      worker가 readLine 진입 → 송신기 cancel

(B) 눌림 소실 → 재전송
main: SEQ+=1 → SIGNAL=2
worker: 폴링이 SIGNAL을 읽고 비웠으나 KeyboardInterrupt가 나지 않음(TRP-019) → ACK 변화 없음
main: 5ms 점검 → SIGNAL===0 && ack 그대로 → 소실 판정 → compareExchange(0→2), 같은 SEQ
worker: 폴링 → 핸들러 → 새 번호이므로 처리 → ACK+=1 → KeyboardInterrupt
main: 점검에서 ack 증가 확인 → 종료 (재전송 최대 10회)

(C) 정지한 실행(time.sleep 밖의 await 대기)
main: SEQ+=1 → SIGNAL=2
worker: Python이 안 돌아 폴링 없음 → 20ms 감시 타이머가 hasPending()(Atomics.load===2) 확인
        interruptIdle() 호출 → 깨우기 성공 → consume()(compareExchange(2→0) 성공) → ACK+=1
        run_sync 래퍼 또는 콘솔 task 취소로 사용자 지점에서 중단
        (깨울 것이 없으면 소비하지 않는다. atPrompt()이면 그 틱에서 discard()한다)

(D) 입력줄(REPL 프롬프트) 취소 — 버퍼를 전혀 쓰지 않는다
main: Ctrl+C → 활성 읽기가 있으므로 setCtrlCHandler는 불리지 않는다
      벤더 readline: moveCursorToEnd → refreshUnhighlighted → "\r\n" → resolve(null)
      readLine 응답 = null → phase: idle → cancel-settling (SEQ·SIGNAL 불변)
worker: discardPendingInterrupt(잔류 없음) → run(null) → clearPending()
        → writeError("KeyboardInterrupt") → req readLine(">>> ")
main: 요청 도착 → phase: cancel-settling → idle → 게이트 다시 열림
      (그 사이의 Ctrl+C는 에코도 전송도 하지 않는다)

(E) input() 대기 중 취소 — 콜백이 버퍼를 쓰고 그 자리에서 소비한다
main: Ctrl+C → 활성 stdin 읽기가 null로 끝남 → "\r\n"
      readInput 핸들러: mailboxWriter.cancel() → finally에서 inputReadsPending-=1, phase: cancel-settling → idle
worker: wait()가 null → signalInterrupt()(SEQ+=1, SIGNAL=2) → checkInterrupt()
        → FS.ErrnoError(EINTR) → CPython이 EINTR 뒤 신호 처리(PEP 475)
        → 핸들러(새 번호, ACK+=1, 스택에 <console>) → input() 호출 지점에서 KeyboardInterrupt
        → 트레이스백 3줄(writeError) → req readLine(">>> ")
main: 이 구간의 Ctrl+C는 게이트가 열려 있어 에코·전송한다(취소 뒤 사용자 코드가 계속 돌 수 있다)
```

참고: `/work/cp949/pyodide-samples/apps/repl/docs/design/02-ctrl-c.md`,
이전 구현 설계 문서 `02a-prompt-cancel.md`, `02c-key-repeat.md`, `02d-idle-ctrl-c.md`, `02e-lost-press.md`,
이전 구현 설계 문서 `02f-sleep-slice.md`,
`/work/cp949/pyodide-samples/apps/repl/src/repl/{interrupt-protocol,interrupt-sender,interrupt-buffer,interrupt-watch,sigint-handler,webloop-reraise}.ts`,
`/work/cp949/pyodide-samples/apps/repl/src/repl/sigint-handler.py`
