# 아키텍처

## 1. 목표와 제약

- 브라우저에서 pyodide(`314.0.7`, Python 3.14.2)를 Web Worker에서 실행하고, 메인 스레드의 xterm.js 터미널로 **CPython 3.14 기본 대화형 REPL(`python`)과 같은 조작감**을 제공한다. 동등성 판정은 주관이 아니라 3.14.4 pty 실측과의 화면 행 비교다(`09-testing.md`, `10-parity-deviations.md`).
- 프롬프트 대기 중 worker 이벤트 루프는 살아 있다(asyncio 콜백이 돈다). 이 점은 `python`이 아니라 `python -m asyncio` 쪽에 정렬한 의도적 선택이다([ADR-0005](../adr/0005-input-stays-blocking-prompt-stays-async.md)).
- `input()`·`sys.stdin` 읽기만 worker를 멈추는 동기 대기다. pyodide `setStdin` 콜백이 문자열 동기 반환을 요구하고, CPython 의미(대기 중 다른 콜백이 돌지 않음)를 지키기 위해서다.
- 실행 환경은 **cross-origin isolated** 페이지다(`SharedArrayBuffer` 필요, [ADR-0004](../adr/0004-cross-origin-isolation-required.md)). 격리되지 않은 페이지에서는 초기화 프레임이 요구하는 `SharedArrayBuffer` 뷰를 만들 수 없으므로 시작 시 감지해 worker 없이 터미널에 경고만 낸다(세션이 없다). Service Worker 우회는 범위 밖이다.
- 이전 구현(`/work/cp949/pyodide-samples/apps/repl`)이 쓰던 coincident 동기 브리지는 쓰지 않는다([ADR-0001](../adr/0001-no-sync-bridge-library.md)). 예외는 worker Python의 DOM 접근 전용 플러그인 `pyodide-dom-bridge`뿐이고 `input()`·출력·중단은 그 경우에도 core 채널로 간다([ADR-0006](../adr/0006-pyodide-core-and-plugin-packages.md), `16-dom-bridge.md`). 그 위의 기능 규칙은 그대로 계승한다(`02`~`08`).

## 2. 프로세스 모델과 채널

```text
┌──────────── main (브라우저 메인 스레드) ────────────┐   ┌──────────── worker ────────────┐
│ xterm.js Terminal                                    │   │ pyodide (CDN loadPyodide)       │
│ @cp949/runo-xterm-readline (벤더링)                  │   │ pyodide.console.PyodideConsole  │
│ 코어 main 쪽: sink·꼬리·읽기 브리지·자동 들여쓰기·  │   │ 코어 worker 쪽: REPL 루프·      │
│   블록 히스토리·Tab 리더·인터럽트 송신기            │   │   submission-runner·SIGINT 핸들러│
│ apps/demo: React 셸(버튼·Chip·스위치)                │   │   ·stdin 콜백·완성 후처리        │
└──────┬───────────────┬────────────────────┬─────────┘   └────┬──────────────┬─────────────┘
       │ ① RPC         │ ② stdin 메일박스   │ ③ interrupt buffer │              │
       │ MessagePort   │ SAB(제어 4칸+데이터)│ SAB Int32Array(4)  │              │
       └───────────────┴────────────────────┴────────────────────┘──────────────┘
```

| 채널               | 매체                                | 방향                                | 동기성                       | 나르는 것                                                                                                                             |
| ------------------ | ----------------------------------- | ----------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| ① RPC              | 전용 `MessageChannel` 포트          | 양방향                              | 비동기(요청/응답, 알림)      | `readLine` 요청(worker→main), `complete` 요청(main→worker), 출력 알림 4종, `ready`/`loadFailed`/`sessionTerminated`, `readInput` 알림 |
| ② stdin 메일박스   | `SharedArrayBuffer`                 | main→worker(응답만)                 | worker `Atomics.wait` 블로킹 | `input()` 한 줄(UTF-8 청크) 또는 취소·오류 표식                                                                                       |
| ③ interrupt buffer | `SharedArrayBuffer` `Int32Array(4)` | main→worker(신호), worker→main(ack) | pyodide 폴링(비동기)         | SIGINT(2)·ack·요청 번호                                                                                                               |

원칙:

- **기본은 비동기다.** 동기 대기는 ②의 `input()` 하나뿐이다. 출력 알림은 worker를 멈추지 않는다.
- **순서는 포트 하나로 보장한다.** 출력 알림과 `readInput` 알림, `readLine` 요청이 같은 포트를 타므로 main은 항상 "출력 → 읽기 요청" 순서로 받는다. `input("x: ")`의 `x: ` 꼬리가 읽기 시작 전에 도착한다는 규칙(`04-stdin-input.md` 3.3)은 여기에 의존한다.
- **worker가 ② 대기 중이면 ①에 답하지 못한다.** 그 구간에 main→worker 요청(`complete`)을 배치하지 않는다. main이 보내는 유일한 신호는 ③이다.
- ③은 postMessage로 대체할 수 없다. Python이 동기 실행 중이면 worker 이벤트 루프가 돌지 않아 메시지를 받지 못하고, pyodide는 `setInterruptBuffer`로 넘긴 버퍼를 실행 중간에 폴링한다.

프로토콜 세부(메시지 형식, 슬롯 배치, 상태 전이)는 `01-protocols.md`에 있다.

## 3. 생명주기

### 3.1 시작

0. `crossOriginIsolated`가 거짓이면 main은 worker를 만들지 않는다. 안내 줄(`promptRow.notice`, RD-027 구 `writeNotice`, `05-output.md` 4.1)로 경고만 내고 `onStatus('not-isolated')`를 부른 뒤 끝난다(ADR-0004). 아래 1~5는 격리된 페이지의 절차다.
1. main이 `Terminal`·`Readline`을 만든다(세션과 무관하게 마운트당 1회).
2. main이 `MessageChannel`, interrupt buffer, stdin 메일박스를 만들고 worker를 생성한다(`createWorker()` 팩토리).
3. main이 **초기화 프레임 하나**를 `worker.postMessage`로 보낸다: RPC 포트(transfer), interrupt buffer, 메일박스 두 뷰, `driver` 필드(driver 옵션, core는 모양을 모른다. REPL은 `{ topLevelAwait }`, 실행 driver는 `{ filename, topLevelAwait }`, `14-runner.md` 14.2.3), pyodide `indexURL`. worker 스크립트는 `core/worker`를 top-level await가 있는 모듈의 import보다 앞선 정적 import로 둔다(dom-bridge를 쓰면 dom-bridge `./worker` 다음, dom-bridge `./worker`는 첫 정적 import다, `16-dom-bridge.md` 16.3). 모듈이 평가될 때 `message` 리스너가 걸려 프레임을 버퍼에 두므로, 이 순서를 지키면 `runWorker` 호출 시점(파일 안의 `await` 뒤 등)은 자유다. 순서 조건의 근거(Vite 번들 순서)는 `01-protocols.md` 4절이다. 리스너는 `kind: "init"`인 객체만 소비하고 배열 같은 다른 메시지는 넘긴다(`01-protocols.md` 4절). 프레임은 하나뿐이다.
4. worker가 driver 옵션을 검증(`WorkerDriver.parseOptions(frame.driver)`)하고 pyodide를 로드하고(`B1`) 콘솔을 만든 뒤(`B2`) `ready` 알림(또는 `loadFailed`)을 보낸다. 로드 실패는 worker를 죽이지 않는다. 옵션 검증이 던지면 RPC 생성·pyodide 로드 없이 부팅이 거부되고 `console.error`만 남는다(`loadFailed`를 보낼 RPC가 아직 없다).
5. worker(core `bootWorker`)의 순서는 `WorkerDriver.parseOptions` → `createSession` → RPC 생성(core 핸들러 + driver 핸들러 합성) → `loadPyodide` → interrupt 공개 API 확인 → `plugins`(`WorkerPlugin.prepare`, 있을 때만, 배열 순서로 하나씩 await, `16-dom-bridge.md` 16.4) → `driver.createConsole` → `driver.probe` → `attachRuntime`(Python 런타임 연결 — WebLoop 재보고 억제·SIGINT 핸들러·stdin 배선을 한 번에 한다) → `ready` 알림 → 감시 타이머 시작 → `driver.run`(REPL: 배너 출력 → 제출 러너 생성 → REPL 루프 진입)이다(`attachRuntime` 내부 순서는 `03-ctrl-c.md` 2.6 — 실패 처리(`B3` setStdin·`B4` 버퍼 연결)·연결 순서(`B5`)·부팅 전 눌림 폐기(`B6`)는 core `worker/boot.test.ts`가 본다).
   `loadPyodide` 직후 interrupt 공개 API(`setInterruptBuffer`·`checkInterrupt`)가 함수인지 확인하고, 하나라도 아니면 콘솔을 만들기 전에 던져 `loadFailed`로 시작을 거부한다(Ctrl+C가 성립하지 않는다, `13-version-upgrade.md` 13.6). interrupt API 확인 뒤·`driver.createConsole` 앞에서 `plugins`(선택, RD-023)의 `prepare`를 배열 순서로 하나씩 await한다. 던지거나 reject하면 `loadFailed`이고 페이로드는 `Error: plugin "<name>": <원인>`이다(다른 `loadFailed`처럼 `String(error)`, 이때 `createConsole`은 불리지 않는다). 규칙은 `16-dom-bridge.md` 16.4. `driver.createConsole` 직후 `driver.probe?.({ pyodide, pyconsole })`(선택, REPL 비공개 API 지점 2개의 저하 식별자 배열, 던지면 `loadFailed`)를 부르고, 이어서
   `attachRuntime(pyodide, pyconsole, { interruptBuffer: frame.interruptBuffer, stdin: { requestInput, wait }, report })`(반환값은
   `{ interruptIdle, destroy() }`, 내부 순서·실패 처리는 `03-ctrl-c.md` 2.6)를 부른다(`requestInput` = `rpc.notify("readInput", …)`,
   `wait` = `createMailboxReader(...).wait`). `report`는 부팅 중 만든 저하 수집기(`worker/compat.ts` `createDegradedCollector`)의
   `report(id, detail)`이고, 수집 결과(`probe` 반환 + core 지점 4개)가 `ready` 페이로드 `{ pyodideVersion, versionMismatch, degraded, details? }`로
   나간다(`01-protocols.md` 1.2). worker는 경고를 내지 않고 main 세션이 문제가 있을 때만 `console.warn`을 1회 낸다. `ready` 알림까지
   전부 `try` 블록 안이라 던지면 `loadFailed`로 간다(`B1`~`B4`). 감시 타이머(`startInterruptWatch`)는 `ready` 뒤·`driver.run` 직전에 켠다(배너·러너
   생성보다 앞이지만 그 사이에 `await`가 없다). `driver.run`이 끝나면 `finally`에서 `stopWatch()`로 끄고(`B7`), `ready` 뒤 `driver.run`의 예외는
   바깥 `catch`에서 `crashed({ message })`로 나간다(`B8`). 부팅 전체의 `finally`에서 `attached.destroy()`로 정리한다.

시험: core `worker/boot.test.ts`(`B1`~`B8`).

### 3.2 REPL 루프(worker)

```text
loop:
  setAtPrompt(true)                                                      # 감시 타이머의 프롬프트 유휴 폐기가 읽는다
  line = await rpc.call('readLine', prompt, pending, cancelable=true)   # 비동기, 이벤트 루프 살아 있음
  setAtPrompt(false)                                                     # 응답(취소 null 포함) 직후, 폐기보다 먼저
  discardPendingInterrupt(buffer)                                       # 대상 코드 없는 SIGINT 폐기 (RD-007 완료)
  result = await runner.run(line)                                        # null이면 취소 처리
  if result.exit: notify('sessionTerminated'); break
  prompt, pending = result.prompt, result.pending
```

프롬프트 대기 중 main→worker `complete` 요청에 답한다(RD-015). 실행 중 도착한 요청은 빈 후보로 답한다.

루프(repl `worker/repl-loop.ts`의 `runReplLoop(deps)`)는 `complete` 응답(RD-015)을 빼면 위 그대로다. core 프로토콜을 import하지 않고 `readLine`·`setAtPrompt`(RD-009)·`discardPendingInterrupt`(RD-007)·`run`·`onTerminated`·`onError`를 주입받으며 repl `worker/repl-driver.ts`(`createReplSession`)가 RPC 래퍼와 `atPrompt` 변수를 만든다. `complete` 핸들러는 `createRpc` 생성 시에만 등록할 수 있어(core `protocol/rpc.ts`, 나중 등록 API 없음) `createReplSession`이 `atPrompt`·`completer`(콘솔 생성 뒤 `loadCompleteSource`가 채운다) 두 클로저 변수를 핸들러와 함께 세션 객체(`WorkerDriverSession.handlers`)로 내고, core `bootWorker`가 `composeRpcHandlers(core 표, session.handlers)`로 합성해 `createRpc`에 넘긴다. 핸들러는 `atPrompt && completer ? completer(source, pending) : emptyCompletion()`으로 답한다(RD-015, `07-tab-completion.md` 7.1). 호출 순서는 시험이 고정한다: `setAtPrompt(true)` → `readLine` → `setAtPrompt(false)` → `discardPendingInterrupt` → `run`. 오류 정책: `run`이 `KeyboardInterrupt`가 아닌 오류를 던지면 `onError`(`console.error` + 빨간 `repl 내부 오류: …` + `clearPending()`) 뒤 `>>> `로 계속한다. `readLine` 요청이 reject되면 `rpc disposed`(main의 `dispose()`)일 때는 조용히, 그 밖의 이유면 `console.error`만 남기고 루프를 끝낸다.

### 3.3 `input()`(worker, 동기)

```text
stdin 콜백(cancelable=true):
  rpc.notify('readInput', cancelable)      # 포트에 먼저 올린다(앞선 출력 뒤에 FIFO로 도착)
  text = mailbox.wait()                    # Atomics.wait — 이 사이 worker는 완전히 멈춘다
  null이면 signalInterrupt(buffer) → pyodide.checkInterrupt() → EINTR → KeyboardInterrupt
```

main은 `readInput` 알림을 받으면 read-guard(활성 REPL 읽기 뒤로 미룸)를 거쳐 readline으로 한 줄을 읽고 `mailbox.deliver(text)`, Ctrl+C면 `mailbox.cancel()`, 읽기가 실패하면(dispose가 아닐 때) `mailbox.fail(String(error))`로 worker를 깨워 `OSError`로 드러낸다(`04-stdin-input.md` 3.2). `stdin-callback`은 그 `null`을 `signalInterrupt()` → `checkInterrupt()`로 바꿔 `input()` 호출 지점의 `KeyboardInterrupt`를 만들고, `checkInterrupt()`가 던지지 않으면 `console.warn` 뒤 EOF로 떨어진다(RD-008, `04-stdin-input.md` 3.1).

### 3.4 세션 리셋·크래시·종료

- 리셋(`ReplHandle.reset()`, RD-010)은 worker 교체다. 화면·history는 유지된다. 자동 들여쓰기 단위
  (`lastUsedIndentation`)는 세션 소유(`createAutoIndent`, RD-013 완료)라 별도 초기화 단계가 없다 — 새
  세션을 만드는 자리에서 저절로 4칸으로 돌아간다. 순서: `promptRow.endRead({ screen: true })`로 옛 세션의 열린
  읽기를 history를 건드리지 않고 끝내며(벤더 `cancelRead({ settle: true })`) 입력줄·아직 그리지 않은 접두를 화면에 확정하고,
  settle이 행 머리를 보장하지 못했으면(`false`) 그리기 전 읽기였을 때 무조건, 아니면 현재 io 꼬리에 보이는 글자가 있을 때만
  개행한다(RD-028) → 인터럽트 송신기 취소 → RPC dispose → 이전 worker `terminate()`
  → 청록 안내 줄 → 새 worker + 새 초기화 프레임(`08-session.md` 8.1).
  interrupt buffer·송신기·메일박스·sink 세트는 worker마다 **새로** 만든다(REPL `startSession`·실행 driver `createRunner` 공통).
  옛 worker가 `terminate()` 뒤에도 Chromium에서 최대 약 2초 살아 같은 buffer의 눌림을 가로채기 때문이다(`14-runner.md` 14.3.5).
  옛 buffer에 남은 SIGINT는 새 worker가 보지 못하므로 리셋이 `SIGNAL`을 지우는 단계는 없다.
- worker `error` 이벤트·부팅 예외·`reset()` 중 worker 생성 실패 → `crashed` 상태 + `onCrash(message)` → 앱이 재시작 버튼을
  띄운다(RD-010, `08-session.md` 8.1·8.4).
- `exit()`/`quit()`/`SystemExit` → `sessionTerminated` 알림 → 앱이 안내를 띄우고, 복구 경로는 리셋뿐이다.

## 4. 패키지 구조와 공개 인터페이스

```text
packages/
  xterm-readline/        @cp949/runo-xterm-readline — strtok/xterm-readline 1.2.2 벤더링(TS 소스), ADR-0003
  pyodide-core/          @cp949/runo-pyodide-core — 프로토콜(RPC·메일박스·interrupt)·worker 커널·main 세션·실행 driver(`runDriver`)·`createRunner`. UI·xterm·coincident 비의존. private(RD-020, RD-022), ADR-0006
  pyodide-terminal/      @cp949/runo-pyodide-terminal — xterm 실행창 `createTerminalRunner`(RD-022) + repl과 공유하는 부품 5종(`./internal`). coincident 비의존. private, ADR-0006
  pyodide-repl/          @cp949/runo-pyodide-repl — REPL driver + REPL 프런트(main 쪽 + worker 쪽 + Python 스크립트). 프레임워크 무관, 공개 API 유지
  pyodide-repl-react/         @cp949/runo-pyodide-repl-react — `<PythonRunner>`·`<PythonRepl>`·`usePythonRunner`(RD-024). core·terminal·repl을 React 수명에 붙인다(xterm 생성·`FitAddon`·dispose 순서·StrictMode). coincident 비의존. private, ADR-0006, `15-react.md`
  pyodide-dom-bridge/    @cp949/runo-pyodide-dom-bridge — worker Python이 main의 `window`·`document`를 동기 프록시로 쓰는 플러그인(`runo.browser`, RD-023). coincident `4.1.1`·reflected-ffi `0.7.2` 고정, 저장소에서 coincident에 의존하는 유일한 패키지. private, ADR-0006, `16-dom-bridge.md`
  pyodide-testkit/       @repo/pyodide-testkit — 시험 전용 도우미(worker_threads 하니스·가짜 터미널·패키지 경계 도우미). private, 빌드·pack 없음
apps/
  demo/                  Vite + React 19 데모 셸. repl(`?view` 없음)과 terminal 실행창(`?view=runner`)을 `@cp949/runo-pyodide-repl-react`의 `<PythonRepl>`·`<PythonRunner>`로 소비한다(RD-024). core는 `runner.worker.ts`가 `./worker`(`runWorker`·`runDriver`)만, repl은 `repl.worker.ts`가 `./worker`(`runReplWorker`)만 직접 import한다. `?view=dom-bridge`(RD-023)는 `<PythonRunner>`에 dom-bridge worker(`dom-bridge.worker.ts` 등)를 주입하는 화면이고 이 화면만 dom-bridge(coincident)를 지연 import한다. UI 상태(Chip·버튼·스위치)만 가진다.
```

의존 방향: `pyodide-repl-react → pyodide-repl`, `pyodide-repl-react → pyodide-terminal`, `pyodide-repl-react → pyodide-core`, `pyodide-repl → pyodide-terminal`, `pyodide-repl → pyodide-core`, `pyodide-repl → xterm-readline`, `pyodide-terminal → pyodide-core`, `pyodide-terminal → xterm-readline`, `pyodide-core → (작업공간 의존 없음)`, `pyodide-dom-bridge → pyodide-core`(peer, `WorkerPlugin` 타입만 쓰고 런타임 import 없음), `pyodide-testkit → (없음)`. terminal은 repl에 의존하지 않는다(단방향, terminal 경계 시험이 강제). react는 다른 패키지가 의존하지 않는 끝점이다(demo만 소비한다). dom-bridge도 다른 패키지가 의존하지 않고 demo(`?view=dom-bridge`)만 소비한다. `pyodide-core`·`pyodide-terminal`·`pyodide-repl`·`pyodide-repl-react`·`pyodide-dom-bridge`의 devDependencies에 `@repo/pyodide-testkit`이 있다(시험 전용). core는 coincident(`reflected-ffi` 포함)와 `@cp949/runo-xterm-readline`에 의존하지 않고 terminal·repl·react는 coincident에 의존하지 않는다(coincident는 dom-bridge에만 있다). 모두 시험·스크립트로 강제하고 dom-bridge는 `scripts/check-dist.mjs --allow-sync-bridge`·`smoke:pack` 별도 소비자로 예외를 둔다(`09-testing.md` 9.8). repl이 terminal의 `./internal`(sinks·rewind-tail·selection-copy·surface·prompt-row)을 쓰는 것은 두 패키지가 lockstep으로 함께 바뀌는 조건의 공유이고 안정성을 보장하지 않는다(ADR-0006 갱신). `pyodide-repl-react`는 RD-024에서 추가됐고(ADR-0006 갱신, 4.5), `pyodide-dom-bridge`는 [ADR-0006](../adr/0006-pyodide-core-and-plugin-packages.md)이 정하고 RD-023에서 추가됐다(ADR-0006 갱신, 4.6).

### 4.1 `@cp949/runo-pyodide-repl` export

```ts
// main 쪽 진입점
export function createRepl(options: ReplOptions): ReplHandle;

interface ReplOptions {
  terminal: Terminal; // @xterm/xterm. 호출자가 만들고 dispose한다
  createWorker: () => Worker; // 리셋마다 다시 호출된다
  pyodide?: { indexURL?: string }; // 기본 CDN `DEFAULT_PYODIDE_INDEX_URL` = https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/ (13-version-upgrade.md 13.1)
  topLevelAwait?: boolean; // 기본 false. 바꾸려면 reset()
  onStatus?: (s: ReplStatus) => void; // 'loading' | 'ready' | 'load-failed' | 'not-isolated' | 'terminated' | 'crashed'
  onCrash?: (message: string) => void;
  copyOnSelect?: boolean; // 기본 true. 선택 시 자동 복사(RD-017). 바꾸려면 setCopyOnSelect()
  onCopy?: (result: CopyResult) => void; // 복사 시도마다. { ok: true; chars } | { ok: false; error } (RD-017)
}

interface ReplHandle {
  reset(options?: { topLevelAwait?: boolean }): void; // worker 교체. 화면 유지
  runSource(code: string): Promise<RunResult>; // REPL globals에서 코드 실행, 치던 줄 보존(RD-022a, 02 5.6)
  readonly busy: boolean; // 지금 runSource()를 부르면 RunRejectedError("busy")인가
  setCopyOnSelect(on: boolean): void; // 선택 시 자동 복사 on/off. 리셋 없음(RD-017)
  dispose(): void; // worker 종료·리스너 해제. Terminal은 호출자가 소유
  readonly crossOriginIsolated: boolean; // 거짓이면 worker가 없다(경고만 낸 상태)
}

// `RunRejectedError`·`RunResult`·`RunRejectedReason`은 core의 것을 repl `.`에서 다시 내보낸다(`instanceof` 성립)

// worker 쪽 진입점(앱의 얇은 worker 파일이 부른다)
export function runReplWorker(): void; // '@cp949/runo-pyodide-repl/worker'
```

`ReplOptions`는 `terminal`·`createWorker`(필수)·`pyodide?`·`onStatus?`·`onCrash?`(RD-010)·`topLevelAwait?`(RD-012, 기본 `false`, `=== true`만 켠다)·`copyOnSelect?`·`onCopy?`(RD-017, 기본 `true`·`=== false`일 때만 끈다, `06-editing.md` 6.6)이고 `ReplHandle`은 `dispose()`·`reset(options?)`·`setCopyOnSelect(on)`(RD-017, 세션·화면에 영향 없음, `disposed` 뒤 no-op)·`crossOriginIsolated`·`runSource(code)`·`busy`(RD-022a, 규칙은 `02-console-core.md` 5.6)다. 선택 복사 리스너는 핸들 수명이라 `reset()`이 건드리지 않고 `dispose()`가 뗀다(`selectionCopy.dispose()`는 `session.terminate()` 뒤, `readline.dispose()` 앞). RD-003·004의 임시 `readLine(prompt)` 핸들 API는 RD-005에서 빠졌다. 줄 읽기는 worker가 보내는 `readLine` 요청이 유일한 경로다. `onStatus`는 `loading`(`createRepl` 반환 전에 동기로)·`ready`·`load-failed`·`not-isolated`·`terminated`(`sessionTerminated` 알림)를 발행하고 `crashed`는 RD-010이 발행한다. `sessionTerminated`는 터미널에 쓰지 않고 worker도 종료하지 않는다. `ready`의 `pyodideVersion`은 main이 `console.info`로만 남긴다. 로드 실패는 worker를 죽이지 않고 main도 terminate하지 않는다. `dispose()`는 `rpc.dispose()` → `worker.terminate()` → `readline.dispose()` 순서이고 두 번 불러도 안전하다.

`reset(options?: { topLevelAwait?: boolean }): void`(RD-010이 무인자로 추가, RD-012가 옵션을 더했다). `topLevelAwait`가 boolean이면 그 값으로 바꾸고, 생략·`undefined`면 마지막으로 적용한 값을 유지한다(sticky, 핸들이 보관, getter는 없다). `disposed`·`!isolated`면 no-op, 그 외 상태는 전부 허용한다. 순서·게이트는 3.4·`08-session.md` 8.1.

main의 `readLine` 핸들러는 `promptRow.read`(RD-027, 구 `createReplReader`)로 꼬리 + 프롬프트를 그려 한 줄을 읽어 응답한다(`04-stdin-input.md` 3.3). 열린 읽기가 있는 동안 도착한 요청은 `Error("이미 읽는 중")`로 거절한다(벤더 `Readline`은 열린 읽기를 교체하고 앞 promise를 끝내지 않는다). 요청 시그니처는 `readLine(prompt, pending, cancelable, outcome?)`이고 `cancelable`은 `promptRow.read`의 `options.cancelable`로 그대로 전달한다(RD-008). 응답은 줄·`null`(취소)·`{ source }`(`runSource`의 루프 명령)이고 `outcome`은 바로 앞 `{ source }` 실행의 결말이다(RD-022a, `01-protocols.md` 1.2). `pending`은 줄 편집기(`terminal/line-editor.ts`의 `createLineEditor(...).begin(pending, restore)`)가 autoIndent·blockHistory·
tabReader 세 정책의 옵션으로 합성한다(RD-013·RD-014·RD-015 완료, RD-029로 합성 지점 이동, `06-editing.md` 6.8). 리더에는 `dispose()` 뒤 write 콜백을 전달하지 않는 터미널 뷰를 준다. xterm은 `term.dispose()` 뒤에도 대기 중인 write 콜백을 실행하므로, `rewindTail`이 flush를 기다리는 중에 dispose되면 그 콜백이 해제된 `buffer`를 읽는다(`docs/traps/TRP-004`). 뷰가 이 콜백을 막는다.

`readline?` 옵션은 두지 않는다. 호출자가 준 `Readline`은 `persist: false`를 보장할 수 없고, auto-indent·tab 래퍼는 코어가 만든 인스턴스를 감싼다. 코어는 `createTerminalSurface`로 `terminal.loadAddon(readline)`과 `readline.dispose()`(surface의 `dispose()`)만 하고 `Terminal`은 dispose하지 않는다. `term.dispose()`도 로드된 addon을 dispose하므로 `Readline.dispose()`는 멱등이다(`06-editing.md` 6.1).

앱의 worker 파일은 두 줄이다: `import { runReplWorker } from '@cp949/runo-pyodide-repl/worker'; runReplWorker()`. 앱은 `new Worker(new URL('./repl.worker.ts', import.meta.url), { type: 'module' })`로 만든다. worker 파일에 top-level `await`가 들어갈 수 있으므로 Vite `worker.format`은 `'es'`여야 한다. RD-001에서 확인했다: `es`는 빌드가 성공하고 번들 끝에 `await`가 남는다. 기본 `iife`는 `[UNSUPPORTED_FEATURE] Top-level await is currently not supported with the 'iife' output format`으로 실패한다. 앱의 얇은 worker 파일이 패키지 서브패스를 import하는 이 방식은 dev(소스 해석)와 build·preview(`dist` 해석) 양쪽에서 동작한다(4.4).

#### core export(`@cp949/runo-pyodide-core`, 내부 계약)

core는 `private`이고 이 인터페이스는 공개 API로 확정하지 않았다. REPL과 실행 driver(RD-022)가 실제로 쓰는 것만 낸다(`plugins`는 RD-023, `WorkerPlugin`). 진입점이 둘이라 worker 번들이 main 전용 코드(송신기·메일박스 writer)를 끌어오지 않는다.

```ts
// main 쪽: '@cp949/runo-pyodide-core'
export function startCoreSession(options: CoreSessionOptions): CoreSession;
interface CoreSessionOptions {
  createWorker: () => Worker; // 세션마다 호출
  indexURL: string; // 끝 '/'가 붙은 pyodide CDN 위치
  interruptBuffer: Int32Array; // 호출자 소유, 세션마다 새로 만든다(TRP-049)
  interruptSender: InterruptSender; // 호출자 소유, buffer와 짝
  driver: MainDriver; // 화면 상호작용 (아래)
  output: (chunk: { stream: "stdout" | "stderr"; text: string }) => void; // Python stdout·stderr 원문
  onStatus: (s: "ready" | "load-failed" | "terminated" | "crashed") => void;
  onCrash?: (message: string) => void;
}
interface CoreSession {
  pythonRunning(): boolean;
  endSession(): void;
  terminate(): void;
  readonly ended: boolean;
  call(name, ...args): Promise<T>;
}
// 그 밖에 프로토콜: postInitFrame·InitFrame, SIGNAL·ACK·SEQ·createInterruptBuffer·signalInterrupt, createInterruptSender, createRpc,
// createStdinMailbox·createMailboxWriter, composeRpcHandlers, createOutputTail, CORE_MAIN_HANDLER_NAMES

// 실행 핸들(RD-022, 14-runner.md 14.3): UI 비의존
export function createRunner(options: RunnerOptions): RunnerHandle; // { run, stop, interrupt, reset, dispose, status }
export class RunRejectedError extends Error {
  readonly reason: "busy" | "unavailable" | "disposed" | "crashed";
}
// 타입 RunnerOptions·RunnerHandle·RunnerStatus·RunResult·RunOutcome·StopResult·RunRejectedReason·InputProvider

// worker 쪽: '@cp949/runo-pyodide-core/worker'
export function runWorker(options: {
  driver: WorkerDriver;
  plugins?: readonly WorkerPlugin[]; // RD-023: loadPyodide·interrupt API 확인 뒤, createConsole 앞에서 배열 순서로 prepare를 await
}): void;
// 타입 WorkerPlugin { name, prepare({ pyodide }) }·PluginContext (`16-dom-bridge.md` 16.4)
// 실행 driver(RD-022): runDriver(WorkerDriver<RunDriverOptions>), 타입 RunDriverOptions·RunOutcome
// 그 밖에: bootWorker, parseInitFrame, InitFrame, createRpc, composeRpcHandlers, createMailboxReader,
// acknowledgeInterrupt·consumeInterrupt·discardPendingInterrupt·hasPendingInterrupt·readRequestSeq·signalInterrupt,
// installStdioWriters·createCoreConsole, 타입 WorkerDriver·WorkerDriverSession·ConsoleContext·RunContext·PyodideConsoleProxy 등
```

- `MainDriver`(`session/driver.ts`): `options: unknown`(초기화 프레임 `driver` 필드로 실린다), `handlers`(worker → main RPC 핸들러, core 핸들러와 합성), `isIdle()`, `readInput(cancelable, sessionEnded)`, 선택 훅 `inputRequested`·`inputResumed`·`onReady`·`onLoadFailed`·`terminate`. 이 `readInput`은 core 내부 seam이다. 공개 `InputProvider(prompt, signal)`는 `createRunner`가 이 seam 위에 얹는다(`14-runner.md` 14.4). 세션이 끝난 뒤의 결과는 core가 자기 플래그만으로 버린다(`08-session.md` 8.1 D1~D5) — driver는 오류 종류로 폐기를 알리지 않는다. `sessionEnded`는 읽기를 미루는 driver가 열기 직전 보는 core 판정이다(8.1 D6).
- `WorkerDriver<Options>`(`worker/driver.ts`): `parseOptions(raw): Options`(프레임 `driver` 필드 검증), `createSession(options): WorkerDriverSession`. 세션은 `handlers`(main → worker RPC 핸들러)·`createConsole(ctx)`·`run(ctx)`·`atPrompt()`를 낸다. 세션 상태는 클로저에 두어 worker 하나마다 새로 만든다.
- 핸들러 합성: main 쪽 core 핸들러 표(`CORE_MAIN_HANDLER_NAMES`: `write`·`writeErrorRaw`·`readInput`·`sessionTerminated`·`ready`·`loadFailed`·`crashed`, worker → main)와 worker 쪽 core 표(`worker/boot.ts`의 `CORE_WORKER_HANDLERS`, main → worker, 현재 비어 있다)는 방향이 반대인 두 RPC 끝점이라 표도 둘이다. 각 끝점에서 `composeRpcHandlers(core 표, driver 표)`가 이름 충돌을 검사하고, 겹치면 생성 시 `RPC 핸들러 이름이 겹친다: <name>` 예외를 던진다. 늦은 등록 API는 없다. main 쪽 합성은 `MessageChannel`·worker 생성 앞에서 하므로 충돌해도 자원이 새지 않는다.
- 출력 계약: core는 `write`·`writeErrorRaw` 알림을 `{ stream, text }`로 `output`에 넘긴다(원문, 줄 끝 처리·색은 소비자가 정한다). `writeOutput`·`writeError`(값 에코·트레이스백)는 core가 아니라 REPL driver 핸들러다(`05-output.md`).
- "Python 실행 중" 게이트: core `pythonRunning = alive && inputReadsPending === 0 && !driver.isIdle()`. REPL `isIdle = phase
!== "idle"`(REPL 읽기 phase, `08-session.md` 8.1·`03-ctrl-c.md` 2.7).
- repl의 공개 진입점(4.1)은 그대로다: `createRepl`은 core 세션(`startCoreSession`) + REPL main driver(`repl-main-driver.ts`)를 `session.ts`가 조립해 만들고, `runReplWorker`는 `runWorker({ driver: replDriver })`의 얇은 래퍼다.

#### terminal export(`@cp949/runo-pyodide-terminal`, private, RD-022)

```ts
// '@cp949/runo-pyodide-terminal'
export function createTerminalRunner(options: TerminalRunnerOptions): TerminalRunnerHandle
// TerminalRunnerHandle = { run, stop, reset, clear, dispose, status, setCopyOnSelect }
export { RunRejectedError }                       // core의 것을 다시 내보낸다(같은 클래스)
// 타입 InputProvider·OutputChunk·RunRejectedReason·RunResult·RunnerStatus·StopResult·CopyResult·TerminalRunnerOptions·TerminalRunnerHandle

// '@cp949/runo-pyodide-terminal/internal'      repl 전용 부품. 안정성 보장 없음, 두 패키지 lockstep
export * from sinks · rewind-tail · selection-copy · surface · prompt-row
```

옵션·상태·결과·키 정책은 `14-runner.md`. `./internal`은 repl만 쓰는 통로이고 앱 코드는 `.` 진입점만 쓴다.

### 4.2 코어 모듈 지도

깊은 모듈(작은 인터페이스, 큰 구현)을 seam으로 삼고 통신은 주입한다. 이전 구현에서 순수 함수·콜백 주입으로 격리돼 있던 모듈은 이름을 유지해 이식 비용을 줄인다(`12-previous-implementation.md` 4절). RD-020이 공통 부분(프로토콜·worker 커널·main 세션)을 `pyodide-core`로 옮겼다. 시험 파일은 지도에서 뺀다(`09-testing.md`).

```text
packages/pyodide-core/src/                      (공통. UI·xterm 비의존)
  index.ts                 main 쪽 진입점: 프로토콜 + startCoreSession + driver 타입 + PYODIDE_VERSION·DEFAULT_PYODIDE_INDEX_URL
  pyodide-version.ts       `pyodide/package.json`의 version에서 PYODIDE_VERSION·DEFAULT_PYODIDE_INDEX_URL 유도(tsdown이 JSON을 인라인)   ← 13-version-upgrade.md 13.1
  worker.ts                worker 쪽 진입점: runWorker·bootWorker + worker 쪽 프로토콜 + 콘솔 뼈대 + driver 타입
  protocol/
    rpc.ts                 MessagePort 위 요청/응답/알림          ← 01-protocols.md 1절
    rpc-handlers.ts        composeRpcHandlers: 핸들러 표 합성, 이름 충돌은 생성 시 예외   ← 아래 4.1 core export
    stdin-mailbox.ts       SAB 메일박스 (main: deliver/cancel/fail, worker: wait)   ← 01 2절
    interrupt-protocol.ts  interrupt buffer 슬롯·원자 연산         ← 01 3절, 03-ctrl-c.md
    interrupt-sender.ts    송신·점검·재전송 상태기계(main 절반)      ← 03 2.3
    init-frame.ts          초기화 프레임 타입·검증(`driver` 필드는 존재만)   ← 01 4절
    ready-payload.ts       `ReadyPayload`·`createReadyPayload`: `ready` 알림 페이로드와 `versionMismatch` 완전 일치 비교   ← 01 1.2, 13-version-upgrade.md 13.6
    run-outcome.ts         `RunOutcome`(실행 driver의 결말 4종, worker와 main이 공유하는 타입)   ← 14-runner.md 14.2.1
    run-driver-options.ts  `RunDriverOptions`·`parseRunDriverOptions`(worker 코드와 분리, main이 worker 생성 전에 검증)   ← 14-runner.md 14.2.3
  terminal/
    output-tail.ts         출력 꼬리 추적(순수 모듈)                  ← 04 3.3, 05-output.md 4.1
  session/                 main 쪽. worker 하나에 대응하는 공통 자원·게이트
    core-session.ts        startCoreSession: 채널·메일박스·프레임·RPC 합성·readInput·게이트·크래시·종료   ← 08-session.md 8.1
    driver.ts              MainDriver·OutputChunk·SessionStatus (driver 경계)
    runner.ts              createRunner·RunRejectedError·InputProvider·STOP_FALLBACK_MS: worker 생성·재생성, worker마다 새 interrupt buffer·송신기, 상태 8종, run/stop/interrupt/reset/dispose   ← 14-runner.md 14.3
  worker/                  worker 쪽. 대부분 pyodide 프록시에만 의존(boot.ts·run-worker.ts는 조립 모듈이라 예외, 아래)
    init-receiver.ts       createInitReceiver: init 프레임 수신기(필터 리스너 + 버퍼, `take`는 worker당 1회)·isWorkerGlobalScope   ← 01 4절
    run-worker.ts          모듈 최상위에서 worker 전역이면 수신기를 건다. runWorker: 수신기 버퍼에서 검증된 프레임을 꺼내(아직 없으면 도착 때) CDN 로더를 주입해 bootWorker 호출   ← 01 4절
    plugin.ts              WorkerPlugin·PluginContext(`name`·`prepare({ pyodide })`, RD-023)   ← 16-dom-bridge.md 16.4
    boot.ts                bootWorker: 부팅 시퀀스(옵션 검증 → RPC → 로드 → interrupt API 확인 → plugins prepare → 콘솔 → probe → 연결 → ready → 감시 → driver.run)   ← 01 5절 S1
    compat.ts              저하 수집기(`createDegradedCollector`)·`findMissingInterruptApi`·`CoreDegradedId`   ← 13-version-upgrade.md 13.6
    driver.ts              WorkerDriver·WorkerDriverSession·ConsoleContext·RunContext (driver 경계)
    run-driver.ts          runDriver(WorkerDriver)·createRunSession: RPC runCode, 재진입 거부, atPrompt. `loadExecInConsole`·`toRunOutcome`은 `./worker`로 export해 REPL이 쓴다   ← 14-runner.md 14.2
    run-driver.py          `exec_in_console`(CodeRunner(exec)·console.runcode·결말 분류, `SystemExit` 뒤 닫힌 stdin 되살림, runner·REPL `runSource` 공용)·`run_code`(runner 전용: 새 globals·stdin 교체 뒤 `exec_in_console`)(`.py?raw`)   ← 14-runner.md 14.2.1
    core-console.ts        installStdioWriters·createCoreConsole(PyodideConsole 뼈대)·콘솔 프록시 타입   ← 02 5.1
    load-pyodide.ts        CDN 동적 import(브라우저 전용, 시험은 npm loadPyodide 주입)
    runtime-attach.ts      attachRuntime(Python 런타임 연결)       ← 03 2.6
    sigint-handler.ts      SIGINT 핸들러(`sigint-handler.py`, `.py?raw`)  ← 03 2.4
    sleep-slice.ts         time.sleep 20ms 조각(`sleep-slice.py`)        ← 03 2.4
    interrupt-watch.ts     감시 타이머                                ← 03 2.5
    stdin-callback.ts      readInput 알림 → wait() → null이면 signal+check           ← 04 3.1
    sink-writer.ts         전역 stdout/stderr Writer                   ← 05 4.2
    webloop-reraise.ts     WebLoop 재보고 억제(`webloop-reraise.py`)     ← 03 2.8

packages/pyodide-core/test/                     (시험 전용. 모든 패키지가 시험을 src 밖 test/에 둔다, 09 머리 절)
  roles/                   시험 전용 worker_threads 역할(interrupt-presser·mailbox-reader·mailbox-writer·repl-worker·run-worker)   ← 09 9.1
  fake-worker.ts           시험 전용 진입점(`test-utils` subpath): 가짜 Worker + `boot-harness.ts`(부팅 하니스 createMainSide·createInitFrame, RD-040) 재수출   ← 09 머리 절
  worker-internals.ts      시험 전용 진입점(`test-utils/worker` subpath): attachRuntime·부품·눌림 스레드 역할 URL을 repl 시험에 낸다   ← 09 9.1

packages/pyodide-terminal/src/                  (xterm 실행창 + repl 공유 부품. coincident 비의존)
  index.ts                 공개 진입점: createTerminalRunner·RunRejectedError·타입   ← 14-runner.md 14.5
  terminal-runner.ts       createTerminalRunner(core createRunner를 Terminal에 붙인다: sink 출력·input() 한 줄 읽기·Ctrl+C 분기·clearOnRun·꼬리 개행·비격리 안내)   ← 14-runner.md 14.5.3
  internal.ts              `./internal` 진입점: 아래 5종을 `export *`(repl 전용, 안정성 보장 없음)
  sinks.ts                 sink 4종(`TerminalSinks`) + 꼬리 재료(`TerminalSinksInternal`: `tail`·`resetTail`·`moveAbovePrefixToTail`, promptRow 전용, core `createOutputTail`을 쓴다)   ← 05-output.md
  rewind-tail.ts           꼬리가 폭을 넘으면 첫 행까지 커서를 올림     ← 04 3.3 (promptRow 공용)
  prompt-row.ts            프롬프트 행 deep module(`createPromptRow`, RD-027): 읽기 열기·`take`·`detachPrefix`(떼는 순간의 io에 묶인 `DetachedPrefix` 핸들을 돌려준다, RD-045)·`endRead`·`breakLine`·`clear`·`notice`(구 `stdin-reader`·`repl-reader`·`sinks.moveAbovePrefixToTail`·`notice.ts`를 흡수)     ← `_works/_completed/20260926-38-rd-027-prompt-row/design.md`
  selection-copy.ts        선택 시 자동 복사·선택 중 Ctrl+C 복사(Shift 무관)   ← 06 6.6
  surface.ts               xterm 화면 조립·수명(`createTerminalSurface`: 선택 복사 → `Readline` → `loadAddon`과 정리, `openIo()`: 세션마다 sinks(쓰기 4종)·write 콜백 게이트가 걸린 터미널 뷰, `promptRow`가 "현재 io"로 본다)   ← 14 14.5.1, TRP-004

packages/pyodide-repl/src/                      (REPL driver + REPL 프런트)
  index.ts                 createRepl (main 쪽 조립: `createTerminalSurface`로 선택 복사·`Readline` 조립, Ctrl+C 핸들러·dispose·`runSource`/`busy` 판정)
  session.ts               core 세션(startCoreSession)과 REPL main driver를 조립해 ReplSession을 만든다(`interrupt`·`sourcePrompt`·`sendSource`·`terminate` 4개). 세션마다 interrupt buffer·송신기와 `surface.openIo()`의 `io`를 새로 만든다. reset()(RD-010)이 통째로 교체하는 단위   ← 08-session.md
  repl-main-driver.ts      REPL main driver: 세션 입출력 `io`(surface `openIo()`의 sink·터미널 뷰)와 `promptRow`(RD-027)를 받아 가드·줄 편집기(line-editor.ts)를 세션마다 만들고, 읽기 phase 하나(RD-029, 옛 source-bridge.ts 흡수)로 `readLine`·`writeOutput`·`writeError` 핸들러·`isIdle`·`sourcePrompt`·종료 시 읽기 정리를 낸다   ← 08 8.1
  driver-options.ts        REPL driver 옵션 타입(`{ topLevelAwait }`)·파서. main 쪽 driver가 싣고 worker 쪽 driver가 검증한다
  repl-protocol.ts         `readLine` 응답 `{ source }`·요청 4번째 인자 `outcome`의 타입·판별 함수(main·worker 공용)   ← 01 1.2
  run-source.ts            `runSource` 실행 슬롯(핸들 소유, 세션을 넘어 산다: 대기·실행·정착 단계)·`RunRejectedError` 생성   ← 02 5.6.2
  worker.ts                runReplWorker (core `runWorker({ driver: replDriver })`의 얇은 래퍼)
  terminal/                main 쪽. Terminal·Readline에만 의존. sinks·rewind-tail·selection-copy는 RD-022가, prompt-row(꼬리 + '>>> ' 합성 읽기 포함)는 RD-027이 terminal 패키지(`./internal`)로 옮겼다
    read-guard.ts          stdin 읽기를 활성 REPL 읽기 뒤로(순서만)    ← 04 3.2
    auto-indent.ts          순수 계산(`nextIndentation` 등) + `createAutoIndent`(세션 소유 정책 객체,
                             `readOptions(pending)` → 벤더 `ReadOptions`)   ← 06 6.3(RD-013 완료)
    line-editor.ts         autoIndent·blockHistory·tabReader 세 정책을 묶는 줄 편집기(createLineEditor, 세션 소유,
                             begin/end/dispose/requesting)   ← 06 6.8(RD-029, 구 read-options.ts·source-bridge.ts 흡수)
    block-history.ts       블록 → history 항목 하나(createBlockHistory, 세션 소유)  ← 06 6.4(RD-014 완료)
    tab-completion.ts      순수 로직                                  ← 07
    tab-reader.ts          Tab 가로채기·큐·complete RPC 왕복(목록 재그리기는 벤더 printAbove)
  worker/                  worker 쪽. REPL 전용. pyodide 프록시에만 의존(repl-driver.ts는 조립 모듈이라 예외, 아래)
    repl-driver.ts         replDriver(WorkerDriver): `complete` 핸들러·콘솔 확장·배너·러너·readLine 루프를 core 커널에 끼운다   ← 00 3.2
    repl-loop.ts           REPL 루프(readLine → run 또는 `{ source }` 실행, 종료·오류 정책)    ← 00 3.2
    console.ts             REPL 콘솔(createConsole: core 뼈대 + sys.ps1/ps2·헬퍼·TLA)·runLine·await_fut·정규화  ← 02 5.1
    console-helpers.py     `await_fut` 등 헬퍼 namespace(`.py?raw`)
    run-source.ts          `{ source }` 실행기(`createSourceRunner`: core `loadExecInConsole`·TLA 플래그)   ← 02 5.6.1
    submission-runner.ts   제출 실행 규칙(한 줄 제출 + 여러 줄 분할·줄 흘림, RD-011)  ← 02 5.2
    multiline.py           split_paste 본체(`.py?raw`, 파싱 + 2차 compile)         ← 02 5.2
    multiline.ts           loadSplitPaste(pyodide) — multiline.py를 별도 namespace에서 실행
    top-level-await.ts     setTopLevelAwait                           ← 02 5.4
    complete-source.ts     완성 후처리·ZipStdlibModuleCompleter(`complete-source.py`)   ← 07 7.5

packages/pyodide-repl/test/                     (시험 전용)
  console-harness.ts       REPL 콘솔 통합 하니스 `useConsoleHarness`(core `test-utils/worker` subpath로 attach를 가져다 쓴다)   ← 09 시험 배치(9.1 앞)
  create-repl/harness.ts   `createRepl` 시험 하니스(가짜 worker·세션 조립 `startSession`·`startResettableSession`·정리 등록 `useReplHarness`). `create-repl/*.test.ts`가 쓴다(`run-source.test.ts` 포함, RD-041)   ← 09 9.1
  worker/multiline-corpus.json  split_paste 코퍼스 27개(이름·소스, node + 실제 pyodide 차등 검증) ← 09 9.1

packages/pyodide-testkit/src/                   (시험 전용, exports가 소스를 직접 가리킨다)
  thread.ts                spawnRole: worker_threads 역할 하니스
  fake-terminal.ts         가짜 xterm Terminal
  vt-screen.ts             시험용 가상 화면 `VtScreen`(CUU·CUD·CUF·CUB·ED·EL·`\r`·`\n` 해석, SGR 무시)·`attachVtScreen(fake, vt)`(가짜 터미널 write를 화면에 반영). repl `run-source.test.ts`·`read-guard.test.ts`, terminal `sinks.test.ts`·`terminal-runner.test.ts`가 쓴다
  package-boundary.ts      의존 트리 수집 도우미   ← 09 9.8
  ts-resolve-hook.mjs      worker_threads 역할의 확장자 없는 상대 import 해석 훅
```

Python 소스는 `.py?raw`로 임포트한다(vite는 내장 지원, tsdown/rolldown은 각 패키지 `tsdown.config.ts`의 `raw-text` 플러그인 + `src/py-modules.d.ts` 타입 선언). 적용 파일: core `sigint-handler.py`·`sleep-slice.py`·`webloop-reraise.py`, repl `console-helpers.py`·`multiline.py`(RD-011)·`complete-source.py`(RD-015, `07-tab-completion.md` 7.1). `runPython(SOURCE, { globals, filename })`의 `filename`은 `<console-helpers>`처럼 `<…>` 꺾쇠 이름을 쓴다(트레이스백에 새면 알아보기 위한 것, 절단은 코드 객체로 한다).

헬퍼 로더(빈 namespace `toPy({})` → `runPython(SOURCE, { globals, filename })` → `namespace.get`)는 파일마다 따로 둔다: core `run-driver.ts`(`loadDriverFunction`)·`sigint-handler.ts`·`sleep-slice.ts`·`webloop-reraise.ts`, repl `console.ts`·`multiline.ts`·`complete-source.ts`. 모양은 둘이다 — 설치 뒤 버림(core `sigint-handler`·`sleep-slice`·`webloop-reraise`, namespace·`install` 모두 `finally`에서 `destroy`), 세션 동안 보유(`run-driver.ts`·`console.ts`·`multiline.ts`·`complete-source.ts`, 꺼낸 함수를 세션 내내 쓴다. namespace `destroy`는 `finally`·직후·안 함으로 갈리고 세션 끝에 `destroy`하는 함수는 `execInConsole` 하나). 공용 로더로 합치지 않는다(arch-review 04 Q-2 기각, 2026-09-27): worker 하나에 세션 하나라(`boot.ts`가 `createSession`을 1회 부르고 리셋은 worker 교체다, 3.4) 남은 proxy는 worker `terminate()`와 함께 사라져 수명 정책 차이가 관측되지 않고, repl이 쓰려면 core `./worker` 공개 표면이 하나 는다. 한 worker가 세션을 둘 이상 갖게 되면 수명 정책 통일과 함께 다시 본다.

의존 주입 규칙. repl `terminal/`은 core 프로토콜을 import하지 않는다(읽기 함수·sink를 `repl-main-driver.ts`가 주입하고, sink는 terminal `./internal`의 `sinks.ts`가 순수 모듈 `createOutputTail`만 core에서 import한다). terminal 패키지의 부품 5종도 core에서 `createOutputTail`(sinks)만 쓰고, core `createRunner`를 부르는 것은 `terminal-runner.ts`뿐이다. core `worker/`에서 `protocol/`을 import하는 모듈은 조립 모듈 `boot.ts`·`run-worker.ts`·`runtime-attach.ts`와 타입만 쓰는 `driver.ts`뿐이다. `runtime-attach.ts`는 `protocol/interrupt-protocol`에서 `acknowledgeInterrupt`·`readRequestSeq`·`discardPendingInterrupt`·`signalInterrupt`를 직접 import해 `interruptBuffer`로 묶는다(버퍼를 받는 함수가 클로저까지 소유해야 호출자의 조립 코드가 사라진다, `03-ctrl-c.md` 2.6) — 그래서 `boot.ts`와 시험 하니스는 이 네 함수를 몰라도 된다. `boot.ts`는 `createRpc`·`composeRpcHandlers`·`createMailboxReader`·`InitFrame`과 `hasPendingInterrupt`·`consumeInterrupt`·`discardPendingInterrupt`를 import해 감시 타이머의 클로저만 만들고, pyodide 로더는 `run-worker.ts`가 주입한다(브라우저는 CDN 로더, node 시험은 npm `loadPyodide`). 나머지 core `worker/` 모듈(`sigint-handler.ts`·`interrupt-watch.ts`·`stdin-callback.ts`·`sleep-slice.ts`·`webloop-reraise.ts` 등)은 `protocol/`을 import하지 않고 클로저를 받는다(`stdin-callback.ts`는 `requestInput`·`wait`·`signalInterrupt`·`checkInterrupt`, 뒤 둘은 `runtime-attach.ts`가 `() => signalInterrupt(interruptBuffer)`·`() => pyodide.checkInterrupt()`로 넣는다). repl `worker/`는 `repl-driver.ts`가 조립 모듈이라 core worker 진입점에서 `discardPendingInterrupt`와 driver 타입을 import하고, `repl-loop.ts`·`submission-runner.ts`는 `readLine`·`run`·출력 함수를 주입받는다. RPC 래퍼(`rpc.call("readLine", …)`·`rpc.notify(…)`)는 `repl-driver.ts`가 만든다. 그래서 이전 구현의 시험(가짜 터미널, node+실제 pyodide)이 그대로 옮겨진다.

### 4.3 apps/demo

React 19 + Vite 8. RD-024부터 `ReplView`·`RunnerView`는 xterm·`createRepl`·`createTerminalRunner`를 직접 다루지 않고 `@cp949/runo-pyodide-repl-react`의 `<PythonRepl>`·`<PythonRunner>`를 렌더링하며 handle(`ref`)로 `reset`·`runSource`·`run`·`stop`·`clear`를 부른다. 기본 화면은 `fit={false}`(xterm 기본 80×24, 기존 브라우저 기준선 유지)이고 쿼리 `?fit=1`일 때만 `fit`이 켜진다(`App.tsx`가 두 View에 prop으로 넘긴다). 아래 RD-010·RD-022 시점 설명의 `createRepl`·`createTerminalRunner` 호출은 컴포넌트 안에서 일어나는 것으로 읽는다(`15-react.md`). `ReplView` 컴포넌트가 `createRepl`을 마운트 시 1회 호출하고, 상태(`crossOriginIsolated` Chip, `ready` Chip, 세션 리셋 버튼, top-level await 스위치, 종료·크래시 Alert)만 React state로 둔다. StrictMode 이중 마운트에서 `dispose()`가 두 번 불려도 안전해야 한다(`08-session.md` 8.2). UI 라이브러리는 정하지 않았다(이전 구현은 MUI v9였고, 이 데모에는 필수가 아니다).

RD-010 시점의 데모(`ReplView.tsx`)는 `createRepl({ terminal, createWorker, onStatus: setStatus, onCrash: setCrashMessage })`를 부르고 핸들을 `useRef`에 보관했다(RD-024 이후는 `<PythonRepl ref onStatus onCrash …>`). plain 요소만 쓴다(라이브러리 없음):

- `<output data-testid="status">`: 상태 텍스트, 상시.
- `<button data-testid="reset" disabled={!isolated}>`: `handle.reset()`을 부른다. `isolated`는 `globalThis.crossOriginIsolated === true`(모듈 최상위 상수, RD-010 확정 8). 상시 렌더한다.
- `<label><input type="checkbox" data-testid="top-level-await" disabled={!isolated} /> top-level await</label>`(RD-012): React state(`useState(false)`, 저장 없음, 새로고침하면 항상 꺼짐)가 소유하고 `onChange`가 즉시 `handle.reset({ topLevelAwait: checked })`를 부른다(양방향 모두, 규칙은 "스위치 변경 = 세션 리셋"). 터미널·배너에는 표시하지 않는다. 리셋 버튼·크래시 재시작은 무인자라 코어가 보관한 마지막 값을 그대로 유지한다(sticky).
- `status === "terminated"` → `<div role="alert" data-testid="terminated">Python session terminated. "세션 리셋" 버튼으로 새 세션을 시작하세요.</div>`.
- `status === "crashed"` → `<div role="alert" data-testid="crashed">worker가 예기치 않게 종료됐습니다: {crashMessage} <button data-testid="restart">재시작</button></div>`. `restart`는 `crashMessage` state를 비운 뒤 `reset()`을 부른다 — 리셋이 `loading`을 동기 발행하므로 Alert는 상태 전이로 자연히 사라진다. 새 worker 생성이 또 실패하면 `reset()` 안에서 `crashed`·`onCrash`가 다시 와 새 메시지로 Alert가 남는다(`08-session.md` 8.1).
- 터미널(`<div data-testid="terminal">`)은 `crashed` 중에도 계속 렌더한다(이전 구현과 다른 선택: 화면에 남은 출력이 단서가 된다).
- `<label><input type="checkbox" data-testid="copy-on-select" /> 선택 시 자동 복사</label>`(RD-017): 기본 켜짐. `localStorage`(`runo-repl.copyOnSelect`, `"0"`이면 꺼짐)에서 초기값을 읽고 바뀔 때마다 저장하며 `handle.setCopyOnSelect(checked)`를 부른다(리셋 없음). `createRepl`에도 같은 초기값을 `copyOnSelect`로 넘긴다. `isolated`와 무관하게 활성이다(worker 없이도 선택·복사는 된다).
- `<label><input type="checkbox" data-testid="completion-popover" /> completion popover(새로고침)</label>`(RD-049): 쿼리 `?completionPopover=1`을 반영한다. 옵션이 `createRepl` 때만 읽히므로(`07-tab-completion.md` 7.6) `onChange`가 쿼리를 바꿔 페이지를 다시 불러온다(다른 쿼리 보존, 세션도 새로 시작).
- `<div role="status" data-testid="copy-toast">`(RD-017): `onCopy` 결과를 우측 하단 고정(`position: fixed; right: 16px; bottom: 16px`, 작은 글씨)으로 1초 보인다 — `ok`면 `copied {chars} chars to clipboard`, 아니면 `copy failed`. 연속 복사는 타이머를 새로 건다. 표시 중이 아니면 렌더하지 않는다.
- `<textarea data-testid="source">`·`<button data-testid="run-source">`·`<output data-testid="source-result">`(RD-022a): `runSource(code)` 시험용이다. 버튼이 `handle.runSource(textarea 값)`을 부르고(터미널에 포커스를 주지 않는다) 결과를 JSON 텍스트로 `source-result`에 낸다(거부는 `{"rejected":"<reason>"}`). 새 호출을 시작하면 이전 결과를 지운다. `window` 전역 노출은 없다. 결과 칸은 xterm DOM 행보다 먼저 바뀔 수 있다(`docs/traps/TRP-050`). e2e는 `apps/demo/e2e/checks/run-source-check.mjs`(`e2e:run-source`).

`?view=runner`(RD-022): `App.tsx`가 쿼리 `view=runner`이면 `ReplView` 대신 `RunnerView`(`createTerminalRunner`)를 렌더링한다(페이지당 xterm 1개). plain 요소 `code`(textarea)·`run`·`stop`·`reset`·`clear`·`status`·`result`·`copy-result`·`terminal`의 `data-testid`를 두고 worker는 `src/runner.worker.ts`(`runWorker({ driver: runDriver })`)다. 규칙과 e2e는 `14-runner.md` 14.6.

RD-005 시점에는 `onStatus`만 있었고 `terminated`도 `<p data-testid="terminated">Python session terminated.</p>`(버튼 없음)였다 — 위가 RD-010이 대체한 최종 형태다.

### 4.4 워크스페이스 빌드 규칙

RD-001에서 클린 체크아웃(`dist` 없음)으로 재현한 결과다.

- 패키지 `exports`의 조건 순서는 `development`(`./src/*.ts`) → `types`(`./dist/*.d.mts`) → `default`(`./dist/*.mjs`)다. tarball에는 `src/`가 없으므로 6개 패키지 모두 `package.json`의 `publishConfig.exports`에 `development`를 뺀 `exports`를 두고 `pnpm pack`이 이것을 tarball의 `exports`로 쓴다(빠지면 Vite dev가 없는 `./src/*.ts`로 해석해 `null`을 돌려준다, `smoke:pack`이 검사, `09-testing.md` 9.8.3). 진입점을 추가하면 `exports`와 `publishConfig.exports`, `scripts/pack-smoke.mjs`의 `ENTRY_EXPORTS`를 함께 고친다(`09-testing.md` 9.8.3). Vite는 dev에서 `development`를, build·preview에서 `default`를 고른다(`dist` 없이 `vite build`만 돌리면 실패해서 확인). 새 패키지나 서브패스를 추가하면 `development` 항목도 함께 둔다. 빠지면 `pnpm dev`에서 vite가 `dist`보다 먼저 떠서 `Failed to resolve import ...`(500)를 내고, 실패한 해석을 캐시해 `dist`가 생겨도 vite를 재시작하기 전까지 복구되지 않는다. worker 오류는 브라우저 콘솔에만 남는다.
- 루트 `pnpm dev`는 `apps/demo`만 띄운다(`turbo run dev --filter=demo`). 패키지의 `dev`(`tsdown --watch`)는 `dist`를 지우고 다시 써서 `build`와 경합하므로 필요할 때 `pnpm --filter <패키지> dev`로 따로 실행한다.
- `check-types`는 `^build`에 의존한다. 앱이 패키지 타입을 `dist/*.d.mts`에서 읽으므로 d.ts가 먼저 있어야 한다. 이전 값(`^check-types`)은 클린 상태에서 `TS2307: Cannot find module '@cp949/runo-pyodide-repl/worker'`로 실패했다. `customConditions`로 소스를 읽게 하면 앱의 컴파일러 옵션(`noUncheckedIndexedAccess`)이 벤더링한 xterm-readline 소스를 검사하므로 쓰지 않는다.
- `pnpm preview`는 `build`에 의존한다.
- 패키지 의존 순서(RD-020, RD-022, RD-024, RD-023): `pyodide-repl`이 `pyodide-core`·`pyodide-terminal`에, terminal이 core·xterm-readline에, `pyodide-repl-react`가 core·terminal·repl에 `workspace:*`로 의존하므로 turbo `^build`가 core → terminal → repl → react 순으로 빌드한다. `pyodide-dom-bridge`는 core를 peer(+devDependency `workspace:*`)로 두므로 core 뒤에 빌드되고 다른 패키지 빌드와 무관하다(demo는 이들 전부에 의존한다). repl의 `check-types`·`test`도 core `dist`(`./dist/*.d.mts`·`./dist/*.mjs`)를 읽는다(vitest·tsc에는 `development` 조건이 없다). demo는 dev에서 `development` 조건으로 core 소스를 직접 읽고 build·preview에서는 repl `dist`가 core를 외부 import로 남기므로 vite 워커 번들링이 `node_modules`의 core를 해석한다.
- `pyodide-testkit`은 빌드하지 않는다. `exports`가 `./src/*.ts`(`./thread`·`./fake-terminal`·`./vt-screen`·`./package-boundary`)와 `./ts-resolve-hook.mjs`를 직접 가리키고 소비자가 vitest·tsc뿐이다. `private`이고 pack 대상이 아니다.
- `check-dist` 태스크(RD-020, RD-021, RD-022, RD-024, RD-023): `dependsOn: ["build"]`, `cache: false`. xterm-readline·core·terminal·repl·react의 `dist`에 `coincident`·`reflected-ffi` 문자열이 없는지, `.mjs`에 `pyodide` 런타임 import(`from "pyodide`·`import("pyodide`)가 없는지 검사한다(`scripts/check-dist.mjs`). dom-bridge의 `check-dist`만 `--allow-sync-bridge`로 coincident 문자열 금지 대신 CSP 정적 규칙과 관찰기 import 순서를 검사한다(`16-dom-bridge.md` 16.12). 루트 `pnpm test`는 `turbo run test check-dist`라 시험과 함께 돌고 `pnpm check-dist`로 단독 실행할 수 있다. turbo `test`가 자기 패키지 `build`에 의존하지 않아 `dist` 검사를 시험 안에 둘 수 없다(`09-testing.md` 9.8.2).
- core는 `pyodide`를 `devDependencies`(`"catalog:"`, 원천은 `pnpm-workspace.yaml` catalog, ADR-0007)로 두고 optional peer(`^314.0.7`)로도 선언한다. `tsdown.config.ts`의 `deps.neverBundle`(`pyodide`, `pyodide/*`에서 `pyodide/package.json` 제외)로 `.d.mts`에 pyodide 타입을 인라인하지 않고, `deps.alwaysBundle: ["pyodide/package.json"]`로 `PYODIDE_VERSION`용 `version` 문자열만 `dist`에 인라인한다(런타임 `pyodide` import 없음). core `./worker` 타입을 쓰는 소비자는 `pyodide`(+`@types/node`·`@types/emscripten`)를 설치해야 한다(`packages/pyodide-core/README.md`, `packages/pyodide-core/CONTEXT.md`, `09-testing.md` 9.8.3, `13-version-upgrade.md` 13.7). repl만 쓰는 소비자는 영향이 없다.
- tarball 스모크: 루트 `pnpm smoke:pack`(`pnpm build && node scripts/pack-smoke.mjs`)이 xterm-readline·core·terminal·repl·react·dom-bridge를 pack해 저장소 밖에 설치·`import`·`tsc`·Vite 해석으로 확인한다(주 소비자는 dom-bridge를 뺀 5개, dom-bridge는 core와 별도 소비자). 기본 파이프라인에는 넣지 않는다(`09-testing.md` 9.8.3).

### 4.5 `@cp949/runo-pyodide-repl-react` export

```ts
// '@cp949/runo-pyodide-repl-react'   (RD-024, private, 진입점 하나)
export function PythonRunner(props: PythonRunnerProps): JSX.Element; // terminal createTerminalRunner
export function PythonRepl(props: PythonReplProps): JSX.Element; // repl createRepl
export function usePythonRunner(
  options: UsePythonRunnerOptions,
): UsePythonRunnerResult; // core createRunner, xterm 없음
// PythonRunnerHandle = { run, stop, reset, clear, setCopyOnSelect, focus, readonly status }
// PythonReplHandle   = { runSource, reset, setCopyOnSelect, focus, readonly busy, readonly crossOriginIsolated }
// UsePythonRunnerResult = { status, run, stop, reset, interrupt, busy }
export { RunRejectedError }; // core의 것을 다시 내보낸다(같은 클래스)
// 타입 PythonRunnerProps·PythonReplProps·UsePythonRunnerOptions·InputProvider·OutputChunk·RunRejectedReason·RunResult·RunnerStatus·StopResult·ReplStatus·CopyResult
```

props·handle·수명·fit·StrictMode 규칙은 `15-react.md`. peer는 `react`·`react-dom`(`^19.0.0`)·`@xterm/xterm`(`^6.0.0`)이고 `xterm.css`는 소비자가 import한다.

### 4.6 `@cp949/runo-pyodide-dom-bridge` export

```ts
// main: '@cp949/runo-pyodide-dom-bridge'   (RD-023, private)
export function createBridgeMain(): BridgeMain; // { Worker, native }, coincident main을 옵션 없이 한 번만 부른다
export function isDomBridgeSupported(): boolean; // crossOriginIsolated + growable SharedArrayBuffer
// 타입 BridgeMain·BridgeMainWorker

// worker: '@cp949/runo-pyodide-dom-bridge/worker'   (worker 파일의 첫 정적 import)
export function domBridge(): WorkerPlugin; // name: "dom-bridge"
export function bridge(): Promise<WorkerBridge>; // { proxy, window, native }, worker당 coincident() 1회
// 타입 WorkerBridge
```

규칙(첫 정적 import·`plugins`·`runo.browser`·`native: false`·S5·순서 보장 없음·CSP)은 `16-dom-bridge.md`다. REPL과의 조합은 지원하지 않는다.

## 5. 이전 구현 대비 무엇이 사라지고 무엇이 남는가

사라지는 것: coincident 의존과 포크, reflected-ffi 옵션, 응답 프레임 변환 함정(TRP-010), 초기 handshake와 공존하기 위한 "최초 `await` 이전 등록·`instanceof` 구분" 규칙, 출력 조각마다 worker가 멈추는 동기 왕복, worker가 main에 설정을 되묻는 호출(`getTopLevelAwait`는 초기화 프레임으로 대체), `reportSync`(`crossOriginIsolated`는 main이 직접 안다).

남는 것: cross-origin isolation 요구(interrupt buffer 때문에 어차피 필요), `input()` 대기 중 worker 정지(의도된 의미), read-guard, SIGINT 프로토콜 전체(pyodide 폴링의 비원자성은 통신 방식과 무관), xterm-readline 계열 함정(벤더링으로 소스에서 처리).

## 6. 호스팅 요구

- dev·preview·정적 배포 모두 `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`를 응답 헤더로 보내야 한다. 이전 구현은 dev 서버에만 걸어 두어 `vite preview`와 빌드 산출물에서 `crossOriginIsolated === false`였다. 새 구현은 `apps/demo/vite.config.ts`의 `server.headers`와 `preview.headers` 둘 다에 넣고, README에 배포 시 요구를 적는다. `apps/demo/src/vite-config.test.ts`가 두 곳과 `worker.format`을 시험한다. RD-001에서 dev와 preview 모두 HTML과 worker 스크립트 응답에 두 헤더가 붙고, 페이지와 worker의 `crossOriginIsolated`가 참인 것을 Chromium(Playwright 1.60, 리비전 1223)으로 확인했다. 같은 빌드 산출물을 헤더 없는 서버로 서빙하면 둘 다 거짓이다.
- pyodide는 CDN(`cdn.jsdelivr.net`)에서 로드한다. COEP `require-corp` 아래에서는 CDN 응답에 `Cross-Origin-Resource-Policy: cross-origin`이 있어야 한다(jsdelivr는 제공한다). 자체 호스팅 pyodide로 바꾸면 같은 헤더를 붙인다.
