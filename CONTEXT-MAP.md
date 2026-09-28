# Context Map

## Contexts

- [pyodide-core](./packages/pyodide-core/CONTEXT.md): 공통 부분. 프로토콜(RPC·메일박스·interrupt buffer·초기화 프레임), worker 커널(`runWorker`), main 세션(`startCoreSession`)과 driver 경계의 용어, 실행 driver(`runDriver`)·runner(`createRunner`)·`InputProvider`. 빌드 floor·런타임 floor·`detectRuntimeSupport()`(브라우저 호환) 용어도 여기 있다([ADR-0008](./docs/adr/0008-chrome84-build-floor-and-pyodide-runtime-floor.md)). UI·xterm·coincident 비의존, private(RD-020·RD-022, [ADR-0006](./docs/adr/0006-pyodide-core-and-plugin-packages.md)).
- [pyodide-terminal](./packages/pyodide-terminal/CONTEXT.md): xterm 실행창(`createTerminalRunner`)과 repl이 공유하는 xterm 결합 부품 5종(`./internal`). 실행창·읽기 밖 입력·Ctrl+C 분기·abort 정리·프롬프트 행의 용어. core의 용어는 core `CONTEXT.md`를 따른다. coincident 비의존, private(RD-022).
- [pyodide-repl](./packages/pyodide-repl/CONTEXT.md): REPL driver와 REPL 프런트. main 쪽(터미널·읽기·인터럽트 송신 연결)과 worker 쪽(콘솔 확장·제출 러너·REPL 루프)의 용어, 호스트가 REPL 세션에 코드를 실행시키는 `runSource`(슬롯·루프 명령·정착, RD-022a). core의 용어는 core `CONTEXT.md`를 따른다.
- [pyodide-repl-react](./packages/pyodide-repl-react/CONTEXT.md): React 컴포넌트·hook(`PythonRunner`·`PythonRepl`·`usePythonRunner`)이 core·terminal·repl을 React 수명에 붙이는 패키지(RD-024). handle 위임·생성 옵션·latest-ref·fit·StrictMode의 용어. main·worker·읽기·인터럽트 용어는 repl, runner·실행창은 terminal, driver·core 세션은 core `CONTEXT.md`를 따른다. coincident 비의존, private([ADR-0006](./docs/adr/0006-pyodide-core-and-plugin-packages.md)).
- [pyodide-dom-bridge](./packages/pyodide-dom-bridge/CONTEXT.md): worker Python이 main의 `window`·`document`를 동기 프록시로 쓰게 하는 플러그인(`runo.browser`, RD-023). 부트스트랩·부트스트랩 관찰기·첫 정적 import 규칙·`bridge()`·`native`·guarded window·CSP 정적 검사의 용어. `WorkerPlugin`·`loadFailed`는 core `CONTEXT.md`를 따른다. coincident에 의존하는 유일한 패키지, private([ADR-0006](./docs/adr/0006-pyodide-core-and-plugin-packages.md)).
- xterm-readline (`packages/xterm-readline`): 벤더링한 줄 편집기. 용어는 원본(`Readline`, `History`, `State`, `Tty`, `InputType`)을 그대로 쓰고 별도 `CONTEXT.md`를 두지 않는다.
- pyodide-testkit (`packages/pyodide-testkit`): 시험 전용 도우미(`spawnRole` 하니스·가짜 터미널·패키지 경계 도우미). private이고 pack 대상이 아니며 고유 용어가 없어 별도 `CONTEXT.md`를 두지 않는다.
- demo (`apps/demo`): 데모 셸. 고유 용어가 없고 pyodide-repl·pyodide-terminal·pyodide-repl-react·pyodide-dom-bridge의 용어를 그대로 쓴다. `?view=runner`가 실행창 화면이고 `?fit=1`이 fit을 켠다(RD-024). `?view=dom-bridge`가 dom-bridge 실행창 화면이다(RD-023).

## Relationships

- **demo → pyodide-repl-react**: `<PythonRepl>`·`<PythonRunner>`를 렌더링하고 `PythonReplHandle`·`PythonRunnerHandle`·상태 콜백만 다룬다. xterm `Terminal`·`createRepl`·`createTerminalRunner`를 직접 만들지 않는다(RD-024).
- **demo → pyodide-repl**: `repl.worker.ts`가 `./worker`의 `runReplWorker`만 import한다.
- **demo → pyodide-core**: `runner.worker.ts`가 `./worker`의 `runWorker`·`runDriver`만 import한다. 그 밖에 core를 직접 import하지 않는다.
- **pyodide-repl-react → pyodide-repl·pyodide-terminal·pyodide-core**: `PythonRepl`은 repl `createRepl`, `PythonRunner`는 terminal `createTerminalRunner`, `usePythonRunner`는 core `createRunner`의 옵션·핸들을 위임한다. terminal `./internal`을 쓰지 않는다. repl·terminal·core는 react를 import하지 않는다(단방향).
- **demo → pyodide-dom-bridge**: `?view=dom-bridge`가 main `createBridgeMain`·`isDomBridgeSupported`를, dom-bridge worker 파일이 `./worker`의 `domBridge`를 쓴다. 이 화면만 dom-bridge를 지연 import한다(coincident의 전역 `addEventListener` 패치가 다른 화면에 닿지 않게, RD-023).
- **pyodide-dom-bridge → pyodide-core**: core `./worker`의 `WorkerPlugin` 타입만 쓴다(런타임 import 없음, `peerDependencies`). core는 dom-bridge를 import하지 않는다. dom-bridge의 `domBridge()`가 core `runWorker({ plugins })`의 `prepare`로 부팅에 끼어든다. REPL과의 조합은 지원하지 않는다.
- **pyodide-repl → pyodide-core**: core의 프로토콜·`startCoreSession`·`runWorker`와 driver 경계(`MainDriver`·`WorkerDriver`)를 쓰고, REPL 전용 부분을 driver로 채운다. `runSource`는 core `./worker`의 공용 실행 함수(`loadExecInConsole`·`toRunOutcome`)와 `RunRejectedError`·`RunResult`(repl `.`가 다시 내보낸다)를 쓴다. core는 repl을 import하지 않는다(의존 방향 repl → core).
- **pyodide-terminal → pyodide-core**: `createRunner`·`RunRejectedError`·`createOutputTail`과 타입을 쓴다. core는 terminal을 import하지 않는다.
- **pyodide-repl → pyodide-terminal**: `./internal`의 공통 부품 5종(sinks·rewind-tail·selection-copy·surface·prompt-row)을 쓴다. 화면 조립·수명은 surface(`createTerminalSurface`)가 소유하고 프롬프트 행 연산(읽기·take·행 머리 보장)은 surface가 낸 `promptRow`(RD-027)로만 부른다. repl은 정책(`Readline` 옵션·세션 여닫는 시점)만 넘긴다. 두 패키지는 lockstep이고 `./internal`은 안정성을 보장하지 않는다. terminal은 repl을 import하지 않는다(단방향).
- **pyodide-core → (없음)**: 작업공간 내부 의존이 없다. xterm·`@cp949/runo-xterm-readline`·coincident에 의존하지 않고 시험이 강제한다(`docs/design/09-testing.md` 9.8). terminal·repl·react도 coincident에 의존하지 않는다(coincident는 dom-bridge에만 있다).
- **pyodide-repl·pyodide-terminal → xterm-readline**: export된 공개 API만 사용한다. private 멤버 래핑은 하지 않는다([ADR-0003](./docs/adr/0003-vendor-xterm-readline.md)). terminal은 `ReadlineOptions.typeAhead`(RD-022)를 쓴다.
- **main ↔ worker (core 프로토콜)**: `docs/design/01-protocols.md`의 채널 3종으로만 통신한다(dom-bridge를 쓰면 DOM 접근용 coincident 채널이 하나 더 있고, `input()`·출력·중단은 계속 core 채널이다. 두 채널 사이의 도착 순서는 보장되지 않는다, `docs/design/16-dom-bridge.md` 16.9). 채널·초기화 프레임·세션 게이트는 core, 그 위의 REPL 메시지(`readLine`·`writeOutput`·`writeError`·`complete`)는 repl driver가 얹는다.
- **시험 도우미 (pyodide-testkit)**: core·repl이 devDependencies로만 쓴다. 시험 전용 worker 역할 스크립트(`packages/pyodide-core/test/roles/`)는 core에 있다(testkit이 core를 import하는 순환을 피한다).
