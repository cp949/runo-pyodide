# 프로토콜: RPC·stdin 메일박스·interrupt buffer·초기화 프레임

`00-architecture.md` 2절의 채널 세 개와 초기화 프레임의 정확한 형식이다. 이 문서의 상수·상태 전이가 `packages/pyodide-core/src/protocol/`의 계약이고(RD-020 전에는 `pyodide-repl`에 있었다), 시험은 이 문서를 기준으로 쓴다.

## 1. RPC (MessagePort 위 요청/응답/알림)

### 1.1 메시지 형식

```ts
type RpcMessage =
  | { kind: "req"; id: number; name: string; args: unknown[] } // 응답을 기다린다
  | { kind: "res"; id: number; ok: true; result: unknown }
  | { kind: "res"; id: number; ok: false; error: string } // 핸들러가 던진 값의 String()
  | { kind: "ntf"; name: string; args: unknown[] }; // 응답 없음
```

- 값은 구조적 복제로 그대로 간다. `null`은 `null`로 도착한다(이전 구현의 TRP-010 같은 변환이 없다).
- `id`는 보내는 쪽에서 1부터 증가. 양쪽이 독립 카운터를 가져도 `res`는 요청을 보낸 쪽에서만 해석하므로 충돌하지 않는다.
- 핸들러가 없는 `req`는 `ok: false, error: 'unknown method <name>'`로 답한다. 없는 `ntf`는 버린다. 핸들러 표는 own 속성만 본다(`toString` 같은 `Object.prototype` 이름은 없는 메서드다).
- 알림 핸들러가 던지거나 reject하면 응답 통로가 없으므로 `console.error("[rpc] 알림 핸들러 예외", name, error)`를 남기고 다음 메시지를 계속 처리한다.
- `dispose()`는 대기 중 요청을 모두 `Error('rpc disposed')`로 reject하고 포트를 닫는다. 두 번 불러도 안전하고, `dispose()` 뒤의 `call()`은 보내지 않고 바로 같은 오류로 reject한다(닫힌 포트의 응답은 오지 않는다).
- 알려진 한계: 핸들러 결과는 구조적 복제가 가능해야 한다. 복제할 수 없는 값(함수 등)을 돌려주면 응답 `postMessage`가 `DataCloneError`를 던지고 호출자는 응답을 받지 못해 멈춘다. 현재 핸들러 결과(문자열·`null`·`{completions, start}`)에서는 재현되지 않는다.

### 1.2 메서드 표

| 이름                | 종류 | 방향        | 인자                                                                                                                            | 결과                                                                                                         | 시점                                                                                                             |
| ------------------- | ---- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `readLine`          | req  | worker→main | `prompt: string, pending: string \| undefined, cancelable: boolean, outcome?: RunOutcome`                                       | `string \| null`(취소) `\| { source: string }`(루프 명령) `\| { eof: true }`(`>>>` EOF, `06-editing.md` 6.9) | REPL 루프가 한 줄을 읽을 때. `outcome`(RD-022a)은 바로 앞 `{ source }` 응답을 실행한 결말이고 그 요청에만 실린다 |
| `complete`          | req  | main→worker | `source: string, pending: string \| undefined`                                                                                  | `{ completions: string[], start: number }`                                                                   | Tab. worker는 프롬프트 대기 중에만 계산                                                                          |
| `readInput`         | ntf  | worker→main | `cancelable: boolean`                                                                                                           | —                                                                                                            | stdin 콜백 진입. 이 알림 직후 worker는 메일박스 대기에 들어간다                                                  |
| `write`             | ntf  | worker→main | `text: string`                                                                                                                  | —                                                                                                            | stdout 조각(개행 미강제)                                                                                         |
| `writeErrorRaw`     | ntf  | worker→main | `text: string`                                                                                                                  | —                                                                                                            | stderr 조각(개행 미강제, main이 빨강)                                                                            |
| `writeOutput`       | ntf  | worker→main | `text: string`                                                                                                                  | —                                                                                                            | 값 에코·배너(main이 개행을 붙인다)                                                                               |
| `writeError`        | ntf  | worker→main | `text: string`                                                                                                                  | —                                                                                                            | 트레이스백·SyntaxError(main이 개행·빨강)                                                                         |
| `ready`             | ntf  | worker→main | `ReadyPayload` = `{ pyodideVersion: string, versionMismatch: boolean, degraded: string[], details?: Record<string, string[]> }` | —                                                                                                            | 콘솔 생성·호환 탐지 뒤 REPL 루프 직전. 필드 규칙은 아래 "`ready` 페이로드"                                       |
| `loadFailed`        | ntf  | worker→main | `message: string`                                                                                                               | —                                                                                                            | pyodide 로드 실패. worker는 살아 있고 루프에 들어가지 않는다                                                     |
| `sessionTerminated` | ntf  | worker→main | —                                                                                                                               | —                                                                                                            | `exit()`/`quit()`/`SystemExit`, `>>>` EOF(`06-editing.md` 6.9)                                                   |
| `crashed`           | ntf  | worker→main | `{ message: string }`                                                                                                           | —                                                                                                            | 부팅 뒤(REPL 루프)의 잡히지 않은 예외. worker는 살아 있을 수 있으나 루프는 끝났다(RD-010)                        |

표의 핸들러 소유(RD-020): `write`·`writeErrorRaw`·`readInput`·`ready`·`loadFailed`·`sessionTerminated`·`crashed`는 core 핸들러(main 쪽 표 `CORE_MAIN_HANDLER_NAMES`)이고, `readLine`(worker→main)·`writeOutput`·`writeError`는 REPL main driver 핸들러, `complete`(main→worker)는 REPL worker driver 핸들러다. 각 RPC 끝점은 생성 시 `composeRpcHandlers(core 표, driver 표)`로 표를 합치고 이름이 겹치면 예외를 던진다(늦은 등록 API 없음). core는 `write`·`writeErrorRaw`를 `{ stream: 'stdout' | 'stderr', text }` 원문으로 세션 `output` 콜백에 넘긴다.

**`readLine` 응답 `{ source }`와 요청 4번째 인자 `outcome`**(RD-022a, repl `src/repl-protocol.ts`의 `ReadLineReply`·`ReadLineSourceReply`·`ReadLineOutcome`·`isReadLineSourceReply`, main·worker 공용 타입): 응답은 셋 중 하나다. 문자열은 제출한 줄, `null`은 입력 취소(Ctrl+C), `{ source: string }`은 루프 명령이다. `{ source }`는 `ReplHandle.runSource(code)`가 만든다: main이 열린 읽기를 `takeRead()`로 가져가고(또는 첫 프롬프트 전 대기하던 코드를 첫 요청에서 바로) 줄 대신 `{ source }`로 응답하면, worker 루프가 제출 한 건처럼 `setAtPrompt(false)` → `discardPendingInterrupt()` → 실행 순으로 처리하고(`02-console-core.md` 5.6) 결말을 **다음** `readLine` 요청의 네 번째 위치 인자 `outcome`으로 보낸다. `outcome`은 core `RunOutcome`(`ok` / `error{ errorType, traceback }` / `interrupted{ traceback }` / `exit{ code }`)이고 `restarted`는 main이 만드는 결말이라 실리지 않는다. `{ source }` 실행 직후 요청에만 실리고 그 밖의 요청(첫 요청·일반 명령 뒤)은 3인자 그대로다(worker는 `outcome === undefined`면 인자를 넘기지 않고, main은 인자 유무로 구분한다). 한 결말은 한 요청에만 실린다. 이 요청의 `prompt`는 `>>> `이고 `pending`은 `undefined`다(main은 블록 입력 중에는 `{ source }`를 보내지 않는다). 결말을 별도 알림으로 보내지 않고 요청에 싣는 이유는 main이 새 읽기를 열 때 결말을 이미 알아야 "복원한 줄이 그려진 뒤 결과를 확정한다"(5.6.4)를 지킬 수 있고, 알림과 요청의 도착 순서를 따로 보장할 필요가 없기 때문이다. `{ source }`로 실행한 코드의 `SystemExit`는 `sessionTerminated`를 보내지 않는다. worker 내부 오류는 `outcome`이 `{ kind: "error", errorType: "InternalError", traceback: "repl 내부 오류: …\n" }`이다. 실행 중 worker 크래시·`reset()`이면 다음 요청이 오지 않으므로 main이 `crashed`·`restarted`를 스스로 만든다.

**`ready` 페이로드**(RD-021, core `protocol/ready-payload.ts`의 `ReadyPayload`·`createReadyPayload`): worker가 부팅 중 한 번 탐지한 pyodide 호환 결과다. 공개 API가 아닌 내부 계약이다.

- `pyodideVersion`: worker가 로드한 `pyodide.version`(실제 값).
- `versionMismatch`: `pyodideVersion !== PYODIDE_VERSION`(core 고정 버전과 **완전 일치** 비교, 부분 일치·범위 없음).
- `degraded`: 비공개 API 지점 중 기대와 달라 해당 기능만 꺼진 식별자 배열(처음 보고한 순서, 중복 없음, 문제가 없으면 빈 배열). 식별자 6개와 지점·탐지 방법은 `13-version-upgrade.md` 13.6.
- `details`: 식별자별 상세 이름(`pyodide.ffi.run_sync` 등)의 `Record<string, string[]>`. 상세가 하나도 없으면 **키 자체가 없다**(`undefined`를 싣지 않는다).
- main 경고 규칙: core 세션의 `ready` 핸들러(`session/core-session.ts`)가 `versionMismatch`이거나 `degraded`가 비어 있지 않을 때만 `console.warn("[session] pyodide 호환 경고", { expected, actual, degraded, details })`를 1회 낸다. 문제가 없으면 경고를 내지 않는다. 그 뒤 `driver.onReady(payload)`(REPL은 `console.info("[repl] pyodide 준비", …)`)와 `onStatus("ready")`가 이어진다. worker는 경고를 직접 내지 않는다.
- 시작 거부: `pyodide.setInterruptBuffer`·`pyodide.checkInterrupt` 중 하나라도 함수가 아니면 `ready`가 아니라 `loadFailed`다(콘솔을 만들기 전, `message`에 없는 API 이름이 들어간다). `degraded`에는 오지 않는다.
- driver `probe`가 던져도 `loadFailed`다.

`loadFailed`의 `message`는 worker의 `String(error)`이고 main이 `pyodide 로드 실패: ` 접두사를 붙여 `writeError`로 낸다(빨강 + 개행). pyodide 로드뿐 아니라 콘솔 생성 실패도 같은 알림으로 온다.

`crashed`는 `loadFailed`와 달리 main이 터미널에 아무것도 쓰지 않는다(앱의 Alert가 보여준다, `08-session.md`). main은 worker의 전역 `error` 이벤트(스레드 자체가 죽은 경우)도 같은 경로로 취급한다 — `crashed` 알림은 그 이벤트가 오지 않는 실패(부팅 뒤 잡히지 않은 예외로 루프만 끝난 경우)를 보완한다. 둘 중 먼저 온 신호만 반영한다(`08-session.md`).

main→worker 알림은 없다. 설정은 초기화 프레임(4절)으로만 간다.

### 1.3 순서 규칙

- 한 세션의 모든 RPC 메시지는 **같은 포트**를 탄다. MessagePort는 FIFO이므로 worker가 `write("x: ")` 뒤에 `readInput`을 보내면 main은 반드시 그 순서로 받는다.
- `readInput` 알림은 `mailbox.wait()` **직전**에 보낸다. `postMessage`는 호출 즉시 큐에 들어가므로 뒤이어 worker가 `Atomics.wait`로 멈춰도 main에 전달된다.
- worker가 메일박스 대기 중이면 포트에 도착한 `complete` 요청은 worker가 깨어난 뒤 처리된다. main의 Tab 리더는 `input()` 읽기 중 Tab을 요청하지 않으므로 이 경우는 생기지 않는다.

## 2. stdin 메일박스 (SharedArrayBuffer)

`input()`·`sys.stdin` 읽기 한 건의 응답을 main이 worker에 동기적으로 넘기는 단방향 우편함이다. 세션(worker)마다 새로 만든다.

### 2.1 배치

```ts
const CAPACITY = 64 * 1024; // 데이터 바이트. 고정 크기(ADR-0002)
const sab = new SharedArrayBuffer(16 + CAPACITY);
const ctrl = new Int32Array(sab, 0, 4); // [STATE, BYTE_LENGTH, FLAGS, RESERVED]
const data = new Uint8Array(sab, 16, CAPACITY);

const STATE = 0,
  BYTE_LENGTH = 1,
  FLAGS = 2;
const IDLE = 0,
  READY = 1,
  CANCELLED = 2,
  ERROR = 3,
  EOF = 4; // ctrl[STATE] — EOF는 RD-048(입력 끝, 취소가 아니다. `06-editing.md` 6.9)
const FLAG_LAST = 1; // ctrl[FLAGS] 비트: 마지막 청크
```

- 한 줄은 UTF-8로 인코딩해 `CAPACITY` 이하 청크로 나눈다. 대부분의 입력은 청크 1개다. 청크 경계는 바이트 단위라 UTF-8 시퀀스 중간일 수 있으므로 worker는 `TextDecoder`를 `{ stream: true }`로 이어 붙이고 마지막 청크 뒤 `decode()`로 닫는다.
- growable `SharedArrayBuffer`는 쓰지 않는다. 필요한 최대 용량을 먼저 정해 고정 할당한다(runo-reflected-ffi ADR-0002와 같은 방침).

### 2.2 worker `wait(): { kind: "line"; text } | { kind: "cancelled" } | { kind: "eof" }`

```text
전제: ctrl[STATE] == IDLE, 이 세션에 진행 중인 다른 wait 없음(stdin 콜백은 재진입하지 않는다)
loop:
  Atomics.wait(ctrl, STATE, IDLE)              # IDLE인 동안 잔다. 타임아웃 없음
  s = Atomics.load(ctrl, STATE)
  READY:     chunk = data[0 .. ctrl[BYTE_LENGTH]) 복사 → decoder에 이어 붙임
             last = ctrl[FLAGS] & FLAG_LAST
             Atomics.store(ctrl, STATE, IDLE); Atomics.notify(ctrl, STATE)   # main의 다음 청크 신호
             if last: return { kind: "line", text: decoder.decode() }
             continue
  CANCELLED: Atomics.store(ctrl, STATE, IDLE); Atomics.notify(ctrl, STATE); return { kind: "cancelled" }
  EOF:       Atomics.store(ctrl, STATE, IDLE); Atomics.notify(ctrl, STATE); return { kind: "eof" }
  ERROR:     msg = data[0 .. BYTE_LENGTH) UTF-8 디코드; Atomics.store(ctrl, STATE, IDLE); Atomics.notify(ctrl, STATE); throw new Error(msg)
```

- READY·CANCELLED·EOF·ERROR 처리(청크 디코드·IDLE 복귀·notify·오류 메시지 조립)는 `stdin-mailbox.ts`의 공유 해석 단계
  (`consumeReady`) 하나이며, worker `wait()`와 main 쪽 시험용 take(2.5)가 이 함수 하나를 같이 쓴다.
- `Atomics.wait`는 worker에서만 허용된다. 코어의 worker 쪽에서만 부른다.
- IDLE로 되돌릴 때는 네 경로(READY·CANCELLED·EOF·ERROR) 모두 `Atomics.notify`한다. main이 취소·EOF·오류 표식을 worker가 가져가기 전에 다음 `deliver`를 부르면 `untilIdle()`이 IDLE 복귀를 기다리는데, notify가 없으면 그 대기가 깨어나지 않는다.
- `{ kind: "cancelled" }`와 `{ kind: "eof" }`는 값 하나(`null`)에 두 뜻을 싣지 않는다(RD-048 전에는 `wait(): string | null`이라 취소·EOF를 구분할 수 없었다). stdin 콜백이 `cancelled`는 `03`·`04`의 규칙으로 `KeyboardInterrupt`로, `eof`는 SIGINT 없이 pyodide `null`(EOF로 해석됨)로 바꾼다(`04-stdin-input.md` 3.1, `06-editing.md` 6.9).

### 2.3 main `deliver(text)` / `cancel()` / `eof()` / `fail(message)`

```text
deliver(text):
  bytes = TextEncoder().encode(text)
  for each chunk of bytes by CAPACITY (빈 문자열이면 빈 청크 1개):
    await untilIdle()                                   # 직전 청크를 worker가 가져갈 때까지
    data.set(chunk); ctrl[BYTE_LENGTH] = chunk.length; ctrl[FLAGS] = isLast ? FLAG_LAST : 0
    Atomics.store(ctrl, STATE, READY); Atomics.notify(ctrl, STATE)
cancel():  await untilIdle(); Atomics.store(ctrl, STATE, CANCELLED); Atomics.notify(ctrl, STATE)
eof():     await untilIdle(); Atomics.store(ctrl, STATE, EOF); Atomics.notify(ctrl, STATE)
fail(msg): await untilIdle(); data ← encodeInto(msg)(완전한 문자만 쓰므로 넘치면 문자 경계에서 잘린다); BYTE_LENGTH; Atomics.store(ctrl, STATE, ERROR); notify

untilIdle():
  Atomics.load(ctrl, STATE) == IDLE이면 즉시.
  아니면 Atomics.waitAsync가 있으면 Atomics.waitAsync(ctrl, STATE, <현재값>).value를 await,
  없으면 setTimeout(1ms) 폴링.
```

- 폴링 간격은 `POLL_INTERVAL_MS = 1`(ms)로 확정했다. 브라우저의 중첩 타이머 클램프(약 4ms)가 실제 간격을 늘려도 이 대기는 64KiB를 넘는 입력의 청크 사이에서만 돌아 정확성에는 영향이 없다. `Atomics.waitAsync` 유무는 호출 시점에 확인한다(Chromium 148은 메인·Worker 모두 있다. Firefox·WebKit은 미확인).

- main은 `readInput` 알림을 받은 뒤에만 쓴다. 알림 없이 쓰면 worker가 없는 값을 다음 읽기에서 가져간다.
- `deliver`·`cancel`·`eof`·`fail`은 한 읽기에 넷 중 하나만, 한 번만 부른다. read-guard와 readline이 한 읽기에 한 결과만 내는 것으로 보장한다. `fail`은 main의 읽기가 실패했을 때(dispose가 아닐 때만) 쓴다. `eof`는 core 세션 `readInput` 핸들러가 `STDIN_EOF`를 받았을 때만 쓴다(`06-editing.md` 6.9).
- worker가 `terminate()`로 죽으면 대기 중 값은 버려진다. 메일박스는 세션마다 새로 만들므로 다음 세션에 섞이지 않는다.

### 2.4 시험

- node `worker_threads`에서 실제 `SharedArrayBuffer`로 왕복: 한 청크, 정확히 `CAPACITY` 바이트, `CAPACITY + 1` 바이트(2청크), 멀티바이트 문자가 청크 경계에 걸리는 경우, 빈 문자열, `cancel`, `eof`, `fail`(넘치는 메시지의 문자 경계 절단 포함), worker가 표식을 가져가기 전에 main이 다음 `deliver`를 부르는 경우.
- 이 계약 시험은 worker `wait()`·main take(2.5) 두 adapter에서 모두 돈다(같은 해석 단계를 공유하므로 같은 결과를 내야 한다).
  peek(2.5, 소비하지 않음)은 `none`·청크 중간·청크 마지막·`cancelled`·`eof`·`error` 여섯 가지를 따로 본다.
- 변이 검사: `readInput` 알림을 `wait()` 뒤로 옮기면 main이 알림을 받지 못하고 멈추는지, `FLAG_LAST`를 빼면 worker가 영원히 기다리는지.

### 2.5 main 쪽 응답 수신(시험용)

`stdin-mailbox.ts`가 내보내는 두 함수. **운영 main은 쓰지 않는다** — worker `wait()`(2.2)만 실제 stdin 경로다. 패키지
진입점(`index.ts`)에는 없고 `./test-utils`로만 나간다(공용 fake worker의 `takeResponse()`·`peekMailbox()`, 자체 fake worker를 쓰는
core `core-session.test`·repl `create-repl/*.test`가 쓴다).

- `takeMailboxResponse(buffers): Promise<MailboxResponse>` — STATE가 IDLE이 아닐 때까지 `Atomics.waitAsync`(없으면
  `POLL_INTERVAL_MS` 폴링)로 기다린 뒤 2.2와 같은 해석 단계로 청크를 모두 가져가 `MailboxResponse`
  (`{kind:"line",text}` | `{kind:"cancelled"}` | `{kind:"eof"}` | `{kind:"error",message}`)를 돌려준다. 실제 worker의
  `wait()`처럼 STATE를 IDLE로 되돌린다. 시간 상한 없음 — 멈추면 시험 timeout이 잡는다(`09-testing.md` 9.7).
- `peekMailbox(buffers): MailboxPeek` — 현재 STATE를 소비하지 않고 해석만 한다. `{kind:"none"}` |
  `{kind:"chunk",text,last}`(`last`가 거짓이면 줄의 일부, 다음 청크가 남았다) | `{kind:"cancelled"}` |
  `{kind:"eof"}` | `{kind:"error",message}`.

용어: core `CONTEXT.md`의 **메일박스 응답**.

## 3. interrupt buffer

```ts
const buffer = new Int32Array(new SharedArrayBuffer(4 * 4));
const SIGNAL = 0; // main이 2를 쓴다. pyodide 폴링이 읽고 0으로 비운다
const ACK = 1; // worker만 올린다
const SEQ = 2; // 요청 번호. 새 눌림마다 +1, 재전송은 같은 번호
//    [3]    예약
```

- 초기화 프레임으로 worker에 넘기고 `pyodide.setInterruptBuffer(buffer)`에 **그대로**(접근자·Proxy 없이) 연결한다.
- 세션 간 재사용한다. 새 worker를 만들기 직전 main이 송신기를 취소하고 `SIGNAL`을 0으로 비운다.
- 쓰기·ack·재전송·핸들러 규칙 전체는 `03-ctrl-c.md`에 있다. 새 SIGINT를 쓰는 곳은 main 송신기와 worker의 stdin 콜백(취소 변환) 둘뿐이다.
- 읽기 함수 `readRequestSeq(buffer)`(슬롯 `[2]`)는 핸들러가 재전송과 새 눌림을 구분할 때 쓴다. core `worker/sigint-handler.ts`는 `protocol/`을 import하지 않으므로 `worker/runtime-attach.ts`(`attachRuntime`)가 클로저로 넣는다(`03-ctrl-c.md` 2.6).

## 4. 초기화 프레임

```ts
interface InitFrame {
  kind: "init";
  rpcPort: MessagePort; // transfer
  interruptBuffer: Int32Array; // SAB 뷰. 구조적 복제로 같은 메모리를 가리킨다
  stdinCtrl: Int32Array; // 메일박스 제어
  stdinData: Uint8Array; // 메일박스 데이터
  driver: unknown; // driver 전용 옵션. core는 모양을 모른다(REPL은 { topLevelAwait: boolean }, 실행 driver는 { filename?: string, topLevelAwait?: boolean })
  pyodide: { indexURL: string };
}
```

- main: `worker.postMessage(frame, [frame.rpcPort])`. worker 생성 직후 core가 보내는 첫 메시지다. worker가 받는 첫 메시지라는 보장은 아니다: dom-bridge를 쓰면 `createBridgeMain()`이 돌려준 coincident `Worker` 생성자가 생성 중에 부트스트랩 배열 `[UID, serviceWorker, ffi_timeout]`을 먼저 `postMessage`한다(`coincident@4.1.1` `src/main.js` 126행). 그래서 worker 수신기는 첫 메시지를 무조건 소비하지 않고 아래 필터로 고른다.
- worker: core `./worker` 모듈이 평가될 때(worker 전역일 때만) 수신기(`packages/pyodide-core/src/worker/init-receiver.ts`)가 `addEventListener('message', listener)`로 리스너를 걸고 도착한 프레임을 버퍼에 둔다. 앱의 worker 파일은 `@cp949/runo-pyodide-core/worker`를 top-level await가 있는 모듈의 import보다 앞선 **정적 import**로 둔다(dom-bridge를 쓰면 dom-bridge `./worker` 다음). 이 순서를 지키면 `runWorker({ driver, plugins? })`를 부르는 시점(파일 안의 `await` 뒤 등)은 자유다(늦게 불러도 버퍼의 프레임으로 부팅한다). top-level await가 있는 모듈에는 그런 모듈을 import하는 모듈도 포함된다(순서 조건의 근거는 이 절 아래 "import 순서 조건의 근거"). 동적 `import()`로 core `./worker`를 늦게 평가하면 리스너가 걸리기 전에 온 프레임은 받을 수 없다(시험하지 않았다). 수신기는 `runWorker`를 부르지 않아도 core `./worker`를 import하는 순간(worker 전역일 때) `run-worker.ts`의 모듈 최상위 문장으로 걸린다. 그래서 `bootWorker` 등 다른 공개 export만 쓰는 worker에서도 init 전에 온 비 init 객체 메시지마다 아래 `console.error`가 남는다(`bootWorker`만 import한 `vite build` 산출물에도 이 문장이 남는 것을 확인했다, `_works/_completed/20260925-32-rd-023-dom-bridge/verify/post-review/receiver-without-runworker/result.log`). `runWorker`는 worker당 한 번만 부를 수 있고 두 번째 호출은 `runWorker는 worker당 한 번만 부를 수 있다`를 던진다. dom-bridge를 쓰면 규칙이 하나 더 있다: dom-bridge `./worker`가 worker 파일의 **첫 정적 import**여야 한다(`16-dom-bridge.md` 16.3). 리스너는 `{ once: true }`가 아니라 필터다(coincident 같은 다른 프로토콜이 같은 worker에 있어도 그 메시지를 삼키지 않는다, ADR-0006). 리스너는 메시지를 다음 규칙으로 처리한다.
  - 배열 메시지(다른 프로토콜의 것): 조용히 넘기고 리스너를 유지한다.
  - `kind === 'init'`인 객체(init 후보): 리스너를 떼고(이후 네이티브 `message` 채널은 쓰지 않는다) `parseInitFrame`으로 검증한다. 실패하면 필드 이름을 담아 `console.error("[worker] 초기화 프레임이 올바르지 않다", …)` 후 프레임을 버린다.
  - 그 밖의 메시지(`kind`가 다른 객체·`null`·원시값): 같은 `console.error`(`parseInitFrame`의 오류 메시지 포함)를 남기되 리스너를 **유지**해 뒤에 오는 init을 받는다. 무시하지 않고 로그를 남기는 것은 옛 `{ once: true }` 동작의 오류 표시를 유지하기 위해서다.
    검증 항목은 객체 여부, `kind === 'init'`, 필드 존재·타입, `interruptBuffer`·`stdinCtrl`·`stdinData`가 `SharedArrayBuffer` 위의 뷰인지다(비공유 뷰는 구조적 복제에서 복사돼 메모리 공유가 조용히 끊긴다, `docs/traps/TRP-002`).
- import 순서 조건의 근거(RD-023 사후 리뷰, 2026-09-25, 함정 `docs/traps/TRP-073-tla-import-before-core-worker-delays-init-receiver-in-bundle.md`):
  - 번들 순서(확인): Vite 8.3.0(rolldown) `vite build`는 모듈 코드를 import 순서대로 한 스코프에 이어 붙인다. worker 파일이 top-level await 모듈을 core `./worker`보다 먼저 import하면 산출물에서 수신기 등록 문장(`createInitReceiver(self)`)이 앞 모듈의 `await` 뒤에 놓이고, 순서를 바꾸면 앞에 놓인다(lib 모드와 `new Worker(new URL(…))` worker 번들 모두, `_works/_completed/20260925-32-rd-023-dom-bridge/verify/post-review/tla-bundle-order/result.log`).
  - init 유실(추정, 브라우저 미실측): 그 `await` 동안 도착한 init 프레임은 `message` 리스너가 없어 버려질 수 있다. HTML 명세 해석에 따른 추정이다: worker의 암묵 포트 메시지 큐는 모듈 스크립트 실행을 시작한 뒤 top-level await 완료를 기다리지 않고 활성화되고, 리스너가 없을 때 배달된 `message` 이벤트는 다시 오지 않는다.
  - 네이티브 ESM(dev 서버가 앱 모듈을 따로 제공할 때)에서는 형제 모듈이 앞 모듈의 top-level await를 기다리지 않고 평가돼 이 차이가 없다(node로 확인, 같은 폴더 `native/`).
- `driver` 필드: `parseInitFrame`은 필드가 있는지만 본다(`"driver" in frame`, 값은 `undefined`도 통과). 옛 모양(최상위 `topLevelAwait`, `driver` 없음)의 프레임을 worker가 조용히 받아 driver 옵션을 잃는 것을 막는다. 값은 worker 쪽 driver가 `WorkerDriver.parseOptions(frame.driver)`로 검증한다. REPL은 `{ topLevelAwait: boolean }`이고 repl `driver-options.ts`의 파서가 `driver: 객체 필요`·`topLevelAwait: boolean 필요` 오류를 낸다. 옵션 검증이 던지면 RPC 생성·pyodide 로드 없이 부팅이 그 오류로 거부되고 `runWorker`가 `console.error("[worker] 부팅 시퀀스 예외", …)`로 남긴다. main 쪽 driver의 `options`가 프레임의 `driver` 필드로 실린다. 실행 driver의 `createRunner`는 worker를 만들기 전에 같은 파서(`parseRunDriverOptions`)로 먼저 검증한다(`docs/traps/TRP-042`, `14-runner.md` 14.2.3).
- `SharedArrayBuffer` 뷰는 postMessage로 넘겨도 같은 메모리를 공유한다(coincident 프록시가 값으로 직렬화하던 문제가 없다).
- 설정 변경(REPL의 `topLevelAwait`)은 새 프레임 = 새 worker다. worker가 main에 설정을 되묻는 호출은 없다.

## 5. 시퀀스

```text
(S1) 시작
main : Terminal/Readline·interrupt buffer 생성(핸들) → REPL main driver 생성 → core 세션(`startCoreSession`): 메일박스 생성 → RPC 핸들러 합성(이름 충돌이면 여기서 예외, 채널·worker는 아직 없다)
       → MessageChannel 생성 → createRpc → createWorker() → postMessage(init, [port]) → onStatus('loading')
       (`detectRuntimeSupport()`가 `supported`가 아니면 위를 하지 않고 경고 한 줄 + onStatus(그 상태)로 끝난다 — `unsupported`·`not-isolated` 판정 순서는 `14-runner.md` 14.3.1)
worker: init 수신(필터 리스너, 4절) → parseOptions(frame.driver) → driver.createSession → createRpc(core 핸들러 + driver 핸들러 합성)
      → loadPyodide → interrupt 공개 API 확인(없으면 loadFailed) → plugins prepare(있을 때만, 배열 순서로 하나씩 await, 16-dom-bridge.md 16.4) → driver.createConsole(setStdout/setStderr(전역 Writer) → sys.ps1/ps2 → PyodideConsole → TLA 비트(driver 옵션 값))
      → driver.probe(비공개 API 지점 탐지) → attachRuntime(Python 런타임 연결, 03-ctrl-c.md 2.6) → ntf ready(ReadyPayload) → 감시 타이머 시작
      → driver.run(ntf writeOutput(BANNER) → req readLine('>>> '))   (RD-004는 readLine 대신 시험용 스크립트를 runLine으로 실행)
      옵션 검증·핸들러 합성 실패 → console.error만 남기고 부팅을 시작하지 않는다(RPC가 아직 없어 loadFailed를 보낼 수 없다)
      로드·interrupt API 확인·plugin prepare·콘솔 생성·probe·attachRuntime 실패 → ntf loadFailed(String(error))만 보내고 돌아온다(worker는 살아 있다)
        (plugin 실패는 접두 plugin "<name>": 가 붙은 Error라 페이로드가 Error: plugin "<name>": <원인> 이다. 실패한 plugin 뒤의 plugin·createConsole은 불리지 않는다)
main : ready → (versionMismatch·degraded면 console.warn 1회) → driver.onReady → onStatus('ready') → readLine 핸들러: 꼬리 + '>>> ' 합성 → readline.read()
       loadFailed → writeError('pyodide 로드 실패: ' + message) + onStatus('load-failed')

(S2) 한 줄 실행
main : Enter → res readLine("1+1")
worker: discardPendingInterrupt → runner.run → ntf writeOutput("2") → req readLine('>>> ')

(S3) input()
worker: run("x = input('x: ')") → stdout 콜백 → ntf write("x: ") → stdin 콜백 → ntf readInput(true) → mailbox.wait() [정지]
main : write → 화면·꼬리 "x: " → readInput → read-guard 통과 → 꼬리를 프롬프트로 promptRow.read("", { eof: true })(history 기록 유지, RD-027)
       Enter "abc" → mailbox.deliver("abc")   |  Ctrl+C → mailbox.cancel()   |  빈 줄 Ctrl+D(EOF, `06-editing.md` 6.9) → mailbox.eof()
       읽기 실패(dispose 아님) → mailbox.fail(String(error))
worker: wait() = {kind:"line",text:"abc"} → 콜백 반환 → 실행 계속
       wait() = {kind:"cancelled"} → signalInterrupt → checkInterrupt → KeyboardInterrupt
       wait() = {kind:"eof"} → SIGINT 없이 콜백이 null 반환 → pyodide EOF → input()에서 EOFError
       wait()가 Error를 던짐(fail) → 콜백이 그대로 전파 → input()에서 OSError

(S4) 실행 중 Ctrl+C
main : setCtrlCHandler → pythonRunning()이면 ntf 없이 sink.write("^C") → sender.send(): SEQ+1, SIGNAL=2, 5ms 점검
worker: 폴링 → 핸들러 → ack → KeyboardInterrupt → ntf writeError(traceback) → req readLine
main : readLine 요청 도착 → sender.cancel() (readInput 알림·sessionTerminated·loadFailed·dispose도 같다)

(S5) Tab
main : Tab → req complete(source, pending)   ←  worker: atPrompt이면 계산 → res {completions, start}
main : 읽기가 살아 있고 버퍼·커서가 같으면 적용

(S6) 종료
worker: run("exit()") → {exit:true} → ntf sessionTerminated → 루프 종료(더 이상 readLine 없음)
      → finally: 감시 타이머 정지(stopWatch) + interruptIdle.destroy()
main : 안내 표시. 복구는 reset()

(S6') `>>>` 빈 줄 Ctrl+D(EOF, `06-editing.md` 6.9)
main : readLine 핸들러 결과 STDIN_EOF → res readLine({ eof: true }) (Python 실행 없음)
worker: isReadLineEofReply(reply) → onTerminated() → ntf sessionTerminated → 루프 종료(S6과 같은 결말)

(S7) 세션 리셋(RD-010, `08-session.md` 8.1; 대체 개행 순서는 RD-027, 판정 재료는 RD-028)
main : reset() 호출 → promptRow.endRead({ screen: true })(옛 활성 읽기를
         `cancelRead({ settle: true })`로 ReadCancelledError화, history 불변, 화면은 입력·접두 아래 행 머리로 정리.
         settle 실패면 그리기 전 읽기가 있었으면 무조건, 없으면 현재 io 꼬리에 보이는 글자가 있을 때만 개행 —
         `session.terminate()` **앞**, 같은 동기 블록)
       → session.terminate()(훅: io.close·blockHistory.discard·tabReader.readEnded·`promptRow.endRead({ screen: false })`
         무동작 → endSession()(alive=false, interruptSender.cancel()) → rpc.dispose() → worker.terminate())
       → session = undefined → promptRow.notice(RESET_NOTICE, "info")
       → onStatus('loading') → 새 worker로 (S1)을 다시 탄다(새 interruptBuffer·송신기, 새 채널·메일박스·프레임)
worker: (새 worker) init 수신부터 (S1)과 동일

(S8) 크래시(RD-010, `08-session.md` 8.4)
worker: 전역 error 이벤트(스레드 자체가 죽음)                    | 부팅 뒤(REPL 루프) 잡히지 않은 예외
main   : worker.addEventListener('error', …) → crash(msg)        | ntf crashed({message}) → crash(message)
main   : crash(message): 첫 신호만(ended·crashedOnce 가드) → endSession()(alive=false) → onStatus('crashed')
       → onCrash?.(message). worker는 terminate하지 않는다(복구는 (S7) reset()뿐). 터미널에는 쓰지 않는다.
```
