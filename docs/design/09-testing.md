# 테스트·검증 전략

> 이 문서의 규칙·상수는 이전 구현(`/work/cp949/pyodide-samples/apps/repl`, 읽기 전용 참고)이 CPython 3.14.4 pty 실측과 브라우저 회귀로 확정한 것이다. 새 구현은 통신 계층만 바꾸고(`docs/design/00-architecture.md`, `01-protocols.md`) 이 규칙은 그대로 지킨다. 절 끝의 "참고:" 경로는 이전 구현의 근거 위치다.

파일 이름은 이전 구현의 시험 인벤토리다. 새 구현은 같은 검증 범위를 목표로 하되 파일 배치는 패키지별 `src/**/*.test.ts`를 따른다(RD-020 뒤 core·repl·testkit, RD-022 뒤 terminal이 더해져 네 곳). 새로 추가되는 시험 대상: `rpc`(실제 `MessageChannel`), `stdin-mailbox`(node `worker_threads`로 실제 `Atomics.wait` 왕복·청크·취소), 초기화 프레임, core 세션, 패키지 경계(9.8). terminal은 이후 소스(`src/`)·시험(`test/`) 분리로 옮겨 `test/**/*.test.ts`를 따른다(xterm-readline과 같은 배치, 2026-09-27). repl도 같은 배치로 옮겼다(2026-09-27) — 시험 전용 헬퍼·코퍼스(`console-harness.ts`·`import-gate-corpus.ts`·`multiline-corpus.json`)도 `test/`로 함께 옮기고, `src/` 쪽 참조는 `../src/...` 상대경로로 고쳤다. react도 같은 배치로 옮겼다(2026-09-27) — `src/test-utils/`의 하니스·setup(`harness.ts`·`component-harness.tsx`·`setup.ts`)은 `test/` 바로 아래로 올렸다. core·dom-bridge·testkit도 같은 배치로 옮겨(2026-09-27) 모든 패키지가 `test/**/*.test.ts`를 따른다 — core `src/test/`의 시험 전용 진입점·하니스·역할 스크립트(`fake-worker.ts`·`worker-internals.ts`·`boot-harness.ts`·`roles/`)는 `test/` 바로 아래로 올렸고, `test-utils`·`test-utils/worker` subpath는 `./test/fake-worker.ts`·`./test/worker-internals.ts`를 가리킨다.

**시험 배치(RD-020)**. 아래 9.1·9.2의 파일 이름에서 `worker/`·`protocol/`·`terminal/`은 그 파일이 있는 패키지를 따른다.

| 위치                                | 시험                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/pyodide-core/test/`       | `protocol/*.test.ts`(init-frame·interrupt-protocol·interrupt-sender·rpc·rpc-handlers·stdin-mailbox·thread-scenario), `terminal/output-tail.test.ts`, `session/core-session.test.ts`(가짜 worker·가짜 driver로 세션 게이트·출력 계약·핸들러 충돌·종료 순서), `worker/{boot,run-worker,boot-driver-options,core-console,interrupt-watch,sink-writer,sink-writer-pyodide}.test.ts`, 실행 driver(RD-022) `worker/{run-driver,run-driver-classify,run-driver-pyodide}.test.ts`·`session/{runner,runner-pyodide}.test.ts`(`14-runner.md` 14.6), 플러그인·init 버퍼링(RD-023) `worker/{boot-plugins,init-receiver,run-worker-buffering}.test.ts`(가짜 pyodide 로더·가짜 `EventTarget`), `package-boundary.test.ts`     |
| `packages/pyodide-dom-bridge/test/` | `dom-bridge-plugin`·`boot-worker`(core `bootWorker`와 조합)·`bootstrap-observer`·`guarded-window`·`worker`·`index`(가짜 coincident·가짜 pyodide, jsdom·node), `csp-static.test.ts`(CSP 정적 검사, `scripts/check-dist.mjs --allow-sync-bridge`를 자식 프로세스로 실행), `package-boundary.test.ts`(정확한 의존 버전·`sideEffects`·core는 peer)                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/pyodide-terminal/test/`   | `{sinks,rewind-tail,selection-copy}.test.ts`(repl에서 이동), `prompt-row/{read,prefix,row-end}.test.ts`(RD-027, `stdin-reader`·`repl-reader`·`notice`·`sinks.moveAbovePrefixToTail` 전용 시험을 흡수, RD-042가 읽기·접두·행 마감으로 분할), `surface-setup.ts`(prompt-row·surface 시험의 surface 조립·배출 fixture, hook 없음, RD-042 — `./test-utils` subpath로 repl 시험도 쓴다, RD-043), `surface.test.ts`(가짜 터미널 + 실제 `Readline`, worker·core 없음), `terminal-runner.test.ts`(jsdom + 실제 core + 공용 가짜 worker `@cp949/runo-pyodide-core/test-utils`), `terminal-runner-screen.test.ts`(jsdom + 실제 core + 공용 가짜 worker `@cp949/runo-pyodide-core/test-utils`), `package-boundary.test.ts` |
| `packages/pyodide-repl/test/`       | `terminal/*.test.ts`(줄 편집기 조립은 `terminal/line-editor-setup.ts`의 `setupLineEditor`, hook 없음, RD-043), `worker/*.test.ts`(SIGINT 통합 4종·`runtime-attach`·`stdin-callback`·`console`·`submission-runner`·`webloop-reraise`·`boot`·`repl-driver`·`repl-loop`·`multiline`·`complete-source`·`top-level-await`·`module-completion-parity`), `create-repl/*.test.ts`(실제 `Readline` + 가짜 worker로 REPL 세션 전체, `runSource` 포함, 공용 하니스 `create-repl/harness.ts`), `worker.test.ts`, `package-boundary.test.ts`                                                                                                                                                                                 |
| `packages/pyodide-testkit/test/`    | `fake-terminal.test.ts`, `package-boundary.test.ts`(도우미 시험), `check-dist-script.test.ts`, `pack-smoke-script.test.ts`. 도우미 소스는 `src/async.ts`(`tick`·`observe`·`Outcome`)·`src/clipboard.ts`(`stubClipboard`)·`src/fake-terminal.ts`(`drain`)·`src/vt-screen.ts`(`attachScreen`) — terminal·repl·react 시험에 흩어져 있던 사본을 모은 것이다(RD-043)                                                                                                                                                                                                                                                                                                                                                 |
| `packages/pyodide-repl-react/test/` | `terminal-component.contract.test.tsx`(`describe.each`, `PythonRunner`·`PythonRepl` 공통 계약: 수명·콜백·`copyOnSelect`·fit 배선·handle, RD-038), `python-runner.test.tsx`·`python-repl.test.tsx`(컴포넌트 고유), `terminal-view.test.ts`(`mountTerminalView` fit 세부, React 없음, RD-038), `use-python-runner.test.tsx`, `package-boundary.test.ts`. 공용 하니스 `harness.ts`(`use-python-runner.test.tsx`)·`component-harness.tsx`(계약 suite·두 컴포넌트 고유 시험, RD-038)·`setup.ts`(vitest `setupFiles`)                                                                                                                                                                                                 |

- SIGINT 통합 시험(`sigint-handler*.test.ts` 4종)과 `runtime-attach`·`stdin-callback`·`console`·`submission-runner`·`webloop-reraise` 시험은 repl에 남는다. 공용 하니스 `test/console-harness.ts`가 repl의 `worker/console`(`createConsole`)·`worker/multiline`(`loadSplitPaste`)을 조립하는 REPL 콘솔 통합 시험이라, core로 옮기면 core → repl 역의존이 생기기 때문이다. RD-022가 core에 실행 driver를 두면서 REPL 없는 core 전용 하니스(`test/roles/run-worker.ts`, `worker/run-driver-pyodide.test.ts`, `session/runner-pyodide.test.ts`)가 생겼다. 그러나 이 4종을 그 하니스로 옮겨 나누는 일은 RD-022에서 하지 않았다(범위 밖). 재검토 조건: core 전용 하니스가 이 4종이 확인하는 SIGINT 규칙(규칙 ①~④·sleep 조각·프롬프트 유휴)을 실제 REPL 콘솔 조립 없이 같은 검출력으로 재현함을 변이 검사로 보인 뒤에 옮긴다. 그 전에는 repl에 둔다.
- 이 시험들이 core 부품(`attachRuntime`·`installSigintHandler`·`installSleepSlice`·`createStdinCallback`·`suppressWebLoopReraise`·`createSinkWriter`)을 쓰는 통로는 core 패키지 subpath `@cp949/runo-pyodide-core/test-utils/worker`(core `test/worker-internals.ts`, `development`·`types` 둘 다 소스, `publishConfig`는 `null`) 한 곳이다. 옆의 `test-utils`(가짜 worker)와 같은 패턴이지만 subpath는 분리했다. 눌림 스레드 역할도 같은 진입점의 `INTERRUPT_PRESSER_ROLE`(core `test/roles/interrupt-presser.ts`의 URL)이 가리키고, 하니스의 `presser()`가 이것을 띄운다. 하니스는 이 진입점의 `attachRuntime`을 그대로 부른다(운영 조립과 같다, `03-ctrl-c.md` 2.6) — 개별 부품을 손으로 다시 조립하지 않는다.
- main 측 부팅 하니스(`createMainSide`·`createInitFrame`, core `worker/boot.test.ts`·dom-bridge `boot-worker.test.ts`·repl `worker/boot.test.ts`·`repl-driver-source-runner.test.ts`가 쓴다, RD-040)는 `test-utils/worker`가 아니라 `@cp949/runo-pyodide-core/test-utils`(core `test/boot-harness.ts`, `test/fake-worker.ts`가 재수출)로 낸다 — dom-bridge에 `?raw` Python 모듈 선언(`py-modules.d.ts`)이 없어 `test-utils/worker`를 import하면 `tsc`가 `TS2307`로 실패하기 때문이다(2026-09-27 실측).
- repl 시험이 core를 공개 export(`@cp949/runo-pyodide-core`·`/worker`)로 import하면 `tsc`는 `dist`로 해석된다(`development` 조건 없음). vitest 5.0.1 단독 실행은 core `dist`를 치워도 통과해 소스로 해석되는 것으로 실측됐다(2026-09-24, `docs/traps/TRP-033` 정정 절). 루트 `pnpm test`는 turbo `test`가 `^build`에 의존해 core `dist`를 먼저 빌드한다. core 소스를 고친 뒤 repl `check-types`나 `dist`를 읽는 시험을 직접 돌릴 때는 먼저 `pnpm --filter @cp949/runo-pyodide-core build`를 한다(안전한 습관이고 vitest 단독 실행에는 필수가 아니다). `test-utils`·`test-utils/worker` subpath는 `types` 조건이 소스를 가리켜 이 영향이 없다(`dist` 없이도 repl `check-types`가 통과, 2026-09-27 실측).
- `runWorker`가 같은 번들 안에서 `bootWorker`를 부르므로 진입점 시험(옛 `worker.test.ts`의 4건)은 core `worker/run-worker.test.ts`에 있고, repl `worker.test.ts`는 `runReplWorker`가 REPL driver로 `runWorker`를 부르는지만 본다.
- repl 시험이 terminal surface fixture를 패키지 경계로 쓰는 통로는 terminal 패키지 subpath `@cp949/runo-pyodide-terminal/test-utils`(`development`·`types` 둘 다 terminal `test/surface-setup.ts` 소스 — `setupSurface`·`asVendorReadline`·`tail`, testkit `tick`·`drain`·`attachScreen` 재수출 — , `publishConfig`는 `null`) 한 곳이다(RD-043, core `test-utils`와 같은 패턴). `setupSurface(options, surfaceOptions)`는 `readline` 필드만 한 단계 병합하고(기본 `persist: false`, 호출자가 `surfaceOptions.readline`으로 덮어쓸 수 있다) 다른 최상위 옵션은 `surfaceOptions`가 그대로 이긴다. `tsc`에서 이 subpath의 타입은 terminal 소스(`src/surface.ts` 등)에서, `/internal`의 타입은 `dist`에서 온다. 이를 쓰는 repl fixture(예: `line-editor-setup.ts`)가 반환 타입을 추론에 맡기면 추론된 타입이 repl에서 이름 붙일 수 없는 terminal 소스 타입(`SurfaceReadline`·`TerminalSurface`)을 가리켜 `tsc`가 TS2883("The inferred type ... cannot be named without a reference to ...")으로 실패한다 — fixture는 반환 타입을 `/internal` 타입으로 적은 인터페이스로 명시한다(2026-09-27 실측).

## 9.1 node + 실제 pyodide(`// @vitest-environment node`)

파이썬 의미·pyodide 내부 가정·프로토콜 불변식을 실제로 돌려 고정한다. 해당 파일:
`sigint-handler.test.ts`, `sigint-handler-idle.test.ts`, `sigint-handler-sleep-slice.test.ts`,
`sigint-handler-nojspi.test.ts`(Node에서 `WebAssembly.Suspending`을 지워 JSPI 없는 경로),
`runtime-attach.test.ts`, `webloop-reraise.test.ts`,
`submission-runner.test.ts`, `multiline.test.ts`, `stdin-callback.test.ts`,
`top-level-await.test.ts`(콘솔 플래그 토글 + RD-012 `asyncio.run(main())` TLA 꺼짐/켜짐 둘 다 완료),
`terminal-sinks.test.ts`(실제 `PyodideConsole`·sink·`Readline`의 터미널 바이트),
`complete-source.test.ts`, `module-completion-parity.test.ts`(RD-016, 아래 별도 항목), `auto-indent-parity.test.ts`
(pyodide에 든 `_pyrepl.readline` 함수와 차분 검증), `rpc.test.ts`(실제 `MessageChannel`).

- 루트 `pnpm test`를 기본 병렬도로 돌리면 repl `sigint-handler-sleep-slice.test.ts`의 100ms 벽시계 판정이 CPU 부하로 흔들릴 수 있다(RD-022 실측: 이동 전 커밋에서도 같은 명령이 2회 중 2회 1건·3건 실패, 단독 실행 3/3 통과). L0 판정은 `pnpm test --force --concurrency=1`로 하고, 실패하면 실패한 파일만 단독 재실행한다. 이슈는 `.scratch/sigint-test-isolation/issues/04-sleep-slice-2pow31-timing-flake.md`(deferred)다.
- 파일 지정 실행: `pnpm --filter @cp949/runo-pyodide-repl test -- <이름>`은 필터가 적용되지 않아 패키지 전체를 돌린다(RD-020 뒤 repl 34개 파일·1034건, 약 18초. 2026-09-24 실측. 이동 전에는 43개 파일·1185건, 약 18초).
  대상만 돌리려면 `cd packages/pyodide-repl && pnpm exec vitest run <파일 일부 이름...> [--reporter=verbose]`.
- 빠른 실행: `pnpm --filter @cp949/runo-pyodide-repl test:fast`는 실제 pyodide 시험(`test/worker/**`,
  `terminal/auto-indent-parity.test.ts`, `terminal/sinks-pyodide.test.ts`)을 빼고 돈다(11개 파일, 약 5초. 전체 `test`는
  약 38초, 2026-09-26 실측). `src/worker/**`나 pyodide 쪽 코드를 바꾸지 않은 DELTA 중간 확인용이다. 실제 pyodide를
  로드하는 시험 파일을 `test/worker/` 밖에 새로 두면 `package.json`의 `test:fast` 제외 목록에 더한다.
- **모듈 완성(RD-016)**: `worker/complete-source.test.ts`는 실제 pyodide에서 `complete_source`의 모듈 분기를 본다 — 후보(`os.path`·`path`·`collections.abc`),
  zip 보정 사전 조건(원본 `ModuleCompleter`가 `import collections.a`에 `[]`, `_stdlib_path`가 `str` `'/lib/python314.zip'`, `_is_stdlib_module` 존재, TRAP-10),
  호출마다 새 인스턴스(site-packages 가짜 패키지 `zz_fake_pkg`를 첫 호출 뒤에 만들어 후보로 잡히는지), 내부 이름 제외, 정렬 없음(기반 클래스 스텁), `[]` 무동작,
  `None` 공백 후보, `pending` 결합, 3.14 삽입 quirk(A37·편차 23), 모듈 분기 `KeyboardInterrupt` 통과, `_pyrepl` import 실패 시 `loadCompleteSource` 실패,
  게이트 안전성("`mentionsImportKeyword`가 거짓인 줄은 `ModuleCompleter`가 `None`", 코퍼스 55줄, TRAP-33).
  `worker/module-completion-parity.test.ts`는 3.14.4 pty 기준 케이스 40개(A01~A36·X01~X04)를 실제 pyodide로 대조한다: 시뮬레이터가 Tab마다 `planTab` →
  `completeSource` → `resolveCompletion`/`formatCompletionList`(80열)를 거쳐 pty의 `screen`·`cursor`와 비교한다. 기대값은 원본 JSON을 읽지 않고 케이스 ID와 함께 시험 파일
  리터럴로 옮겨 둔다(패키지가 `apps/demo`를 읽지 않는다). 편차 18로 화면이 같을 수 없는 `import `·`from ` 두 번째 Tab의 목록만 구조로 판정한다(입력 행·커서 동일,
  목록이 열림, 행 80열 이하). 함정: `[ not unique ]` 행은 편차 16이라 비교에서 뺀다. 리터럴 생성은 옮김 스크립트 없이 손으로 하지 않고 원본 ID 목록(41개)과 대조했다.
- 새 구현의 Ctrl+C 파일: `worker/sigint-handler.test.ts`(요청 번호 확인·ack·`<console>` 프레임 규칙·절단·
  catch-loop·TLA 켜짐 연타), `worker/runtime-attach.test.ts`(`attachRuntime`의 규칙 ID A1~A6,
  `03-ctrl-c.md` 2.6), core `worker/boot.test.ts`(연결이 `ready`보다 먼저·부팅 전 눌림·감시 타이머 정지, 규칙 `B5`~`B7`,
  `00-architecture.md` 3.1), repl `worker/boot.test.ts`(정지한 대기 깨우기·프롬프트 유휴 폐기, driver 타임라인이
  있어야 관찰되는 혼합 규칙). RD-009가 더한 파일:
  `worker/webloop-reraise.test.ts`(재보고 억제 4건 + 가드),
  `worker/sigint-handler-sleep-slice.test.ts`(조각·폴링 횟수·무효 인자·가드 2종),
  `worker/sigint-handler-idle.test.ts`(정지한 대기 깨우기·TLA·`pending`·가드 3종. RD-009a가 더한 것:
  `run_sync` 계열 대기에서 코루틴이 낸 예외의 나르기·프레임 보존. 결정적 주입 묶음은 `<test>` 파일명 래퍼로 1회 눌림을
  넣고 주입 횟수를 단언하며, `run_sync` 래퍼의 JS 변환 중 눌림 4건(표준 트레이스백, 사용자 `except KeyboardInterrupt:`
  포착, 긴 awaitable 취소, Task 생성 전 눌림)을 포함한다),
  `worker/sigint-handler-nojspi.test.ts`(JSPI 없는 경로 5건).
- 공용 하니스는 repl `test/console-harness.ts`다. 시험 파일은 최상위에서 `useConsoleHarness({ beforeLoad, afterLoad,
afterEach, afterAll })`를 한 번 부르고 `{ setup, report, track }`을 받는다. 로드된 인스턴스는 모듈 export `pyodide`(ESM live
  binding)로 읽는다. 등록하는 hook과 순서:
  - `beforeAll`: `beforeLoad` → `loadPyodide` → `afterLoad` → `run_sync` 원본 붙잡기(1회).
  - `afterEach`: `vi.restoreAllMocks()`(스파이를 먼저 풀어 원본으로 버퍼를 뗀다) → 공용 해체 → `report` 비우기 → 파일 `afterEach`.
    공용 해체는 `wakeAfter` 타이머·`interrupt_idle` proxy 정리, 버퍼 해제·`discardPendingInterrupt`, `signal.signal(SIGINT,
default_int_handler)`, stdin 원복(`setStdin({ error: true })` + `sys.stdin` 재열기, TRP-010), **`pyodide.ffi.run_sync`·
    `pyodide.webloop.run_sync` 원복**이다 — 설치가 모듈 전역을 바꾸므로 한 인스턴스에 두 번 설치하면 래퍼가 겹쌓인다. Python을
    돌리는 단계는 모두 버퍼를 뗀 뒤다.
- `setup(options)` → `{ run, screen, buffer, pyconsole, repl, presser, markStarted, interruptIdle, wakeAfter }`. 조립 자체는 운영과 같은
  `attachRuntime`(`03-ctrl-c.md` 2.6) 하나를 부른다 — 시험 전용 토글(예: sleep 조각 설치 건너뛰기)은 attach에 없으므로, 그런
  대조·가드 시험은 하니스 없이 부품을 직접 부르거나 pyodide 원본 상태를 본다. `attachRuntime` 자체가 시험 대상인 단위 시험
  (`runtime-attach.test.ts`)은 직접 부르고 연결한 버퍼·proxy를 `track(buffer, interruptIdle)`으로 공용 해체에 맡긴다.
  `wakeAfter(ms)`는 감시 타이머 대신 시험이 직접 `interruptIdle()`을 부르는 도우미이고(프로덕션 경로는 타이머다) `{ woke }`를
  돌려준다. `markStarted()`는 Python 전역 `started()`와 같은 시작 표시를 JS 훅(stdin `wait()` 등)에서 세운다. `report`는 설치 가드의
  저하 지점을 받는 `vi.fn`이고(시험마다 비운다) `setup`의 기본 report는 `warnDegraded`다.
- **JSPI 없는 경로를 만드는 법**: `loadPyodide()` **전에**(하니스 `beforeLoad`) `WebAssembly.Suspending`·`promising`·`Suspender`를
  `delete`하고 `afterAll`에서 되돌린다. pyodide는 `"Suspending" in WebAssembly`로 판정하고 Node 24는 기본으로
  JSPI가 켜져 있다(`--no-experimental-wasm-jspi`는 듣지 않는다). vitest는 파일 격리라 다른 파일에 새지 않는다
  (같은 실행에서 JSPI 있는 `sigint-handler-idle.test.ts`가 통과하는 것으로 확인한다).
- 눌림은 눌림 스레드 역할 core `test/roles/interrupt-presser.ts`가 `node:worker_threads`로 실제 스레드에서 버퍼에
  쓴다. 시나리오 Python은 JS 전역 `started()`로 "실행에 들어갔다"를 알리고, 그 호출을 `try` **본문 안**에 둔다
  (폴링 위상에 따라 호출 직후의 SIGINT가 `try` 진입 전에 처리되면 예외가 `except`를 벗어난다, TRP-012). 무한
  루프 대신 상한 있는 루프를 쓴다(눌림이 소실되면 vitest가 멈출 수 없다).
- 눌림 스레드가 한 번만 쓰면(기본) pyodide 폴링의 읽기·비우기 경합(`11-known-traps.md` TRAP-06, TRP-019)으로 눌림이 드물게
  사라진다. 전체 스위트 부하에서 슬롯 `[0, n, n+1]`(SIGNAL은 비었고 ack는 그대로, 트레이스백 없음)로 나타난다. 눌림마다
  중단·개수를 단언하는 시험은 `press({ resend: true })`로 main 송신기(`createInterruptSender`)의 5ms 점검·재전송을 함께 흉내낸다.
  송신기 타이머는 역할 스레드의 루프가 돌린다(`setTimeout`은 `Atomics.wait` 대기 때문에 돌지 않는다, TRP-014). 소실 자체를 재는
  측정은 재전송을 끈다(TRAP-06 검증 방법).
- 스레드가 저장소 **송신기**(`createInterruptSender`)를 쓸 때는 대기를 `Atomics.wait`로 하면 안 된다. 점검이
  `setTimeout`이라 스레드를 막으면 재전송이 한 번도 돌지 않고 "소실 0"이 저절로 나온다(TRP-014).
- pyodide private 의존(플래그, `run_sync`, `time.sleep.__wrapped__`, WebLoop 속성)은 **테스트가 깨지는 것이
  버전 업그레이드 알림**이라는 전제로 쓴다. RD-021부터 이 전제에 명시적 시험이 있다: 고정 버전 pyodide 부팅이 `degraded: []`·
  `versionMismatch: false`인지 단정한다(core `worker/boot-compat.test.ts` "고정 버전 pyodide 부팅은 degraded가 비고
  versionMismatch가 거짓이다(업그레이드 알림 역할)", repl `worker/repl-driver-probe.test.ts` "고정 버전 pyodide에서는 빈 배열이다",
  repl `worker/console-compat.test.ts`의 "고정 버전 pyodide"). 비공개 지점 하나가 어긋나면 이 시험이 식별자를 담아 실패한다.
  저하 시험은 판정 로직을 가짜 객체로, "해당 기능만 꺼짐"을 실제 pyodide 1건(속성 삭제·문구 변조, 시험마다 새 `loadPyodide`)으로
  나눈다(`13-version-upgrade.md` 13.6, 절차 13.3). 버전 리터럴은 시험에 쓰지 않고 core `PYODIDE_VERSION`을 import한다.
- worker 스레드 시험(메일박스·프로토콜 통합 시나리오): `packages/pyodide-testkit/src/thread.ts`(`@repo/pyodide-testkit/thread`)의
  `spawnRole(roleUrl: URL, workerData?)`가 호출한 패키지가 넘긴 역할 스크립트(core `test/roles/<name>.ts`)를 실제 `worker_threads` 스레드로 띄운다. `Atomics.wait`에 영구히 막힌 스레드도 시험이
  끝나면 `terminate()`로 회수된다. 역할 스크립트와 그것이 import하는 소스는 Node 타입 제거로 실행되므로 enum·
  namespace·매개변수 프로퍼티를 쓰지 않고 타입 import는 `import type`으로 쓴다. 확장자 없는 상대 import는
  `packages/pyodide-testkit/src/ts-resolve-hook.mjs`(`@repo/pyodide-testkit/ts-resolve-hook.mjs`, `module.registerHooks`)가 푼다. 역할 스크립트를 testkit이 아니라 core에 두는 것은 역할이 core `protocol/`을 import하기 때문이다(testkit에 두면 testkit → core → (dev) testkit 순환).
- 변이 검사 주의: 비동기 폴링 대기를 없애는 변이는 마이크로태스크 스핀이 되어 이벤트 루프를 굶기고 시험 타임아웃도
  발동하지 못한다. 그런 변이는 간격·호출 경로를 바꾸는 방식으로 대체한다. `MessagePort`를 든 객체에는 `toContain`·
  `toEqual`을 쓰지 않는다(순환 내부 참조로 스택이 넘친다). 정체성 비교(`includes`)를 쓴다.
- **이 저장소의 패턴**(RD-004에서 확립). 해당 파일: `worker/sink-writer-pyodide.test.ts`, `worker/top-level-await.test.ts`,
  `worker/console.test.ts`, `worker/submission-runner.test.ts`, `terminal/sinks-pyodide.test.ts`, repl `worker/boot.test.ts`,
  core `worker/boot.test.ts`(`B1`~`B8`, RD-040), `worker/stdin-callback.test.ts`.
  - 파일 상단에 `// @vitest-environment node`를 두고 `import { loadPyodide } from "pyodide"`를 인자 없이 부른다
    (npm 패키지 자체 `indexURL`을 쓴다). `beforeAll(async () => { pyodide = await loadPyodide(); }, 60_000)`으로
    파일마다 인스턴스 하나를 만들어 그 파일의 시험이 공유한다(로드가 수 초라 시험마다 만들지 않는다). CDN 로더
    `loadPyodideFromCdn`은 브라우저 전용이라 단위 시험이 없고 9.3의 브라우저 확인이 본다.
  - 실제 `Readline`(`persist: false`) + 가짜 터미널은 node에서 `window` stub 없이 돈다. 벤더 `readline.ts`의
    `@xterm/xterm` import는 타입뿐이고 `History`는 `persist: false`면 `window`를 만지지 않는다. 그래서 실제
    `PyodideConsole`·sink·`Readline`을 이어 터미널 바이트를 검사하는 시험(`sinks-pyodide.test.ts`)이 node에서 돈다.
  - 부팅 시퀀스는 core `bootWorker(frame, { driver, loadPyodide })`에 로더를 주입하고 main 역할은 core 하니스
    `createMainSide`(RD-040, `@cp949/runo-pyodide-core/test-utils`)가 실제 `MessageChannel`의 다른 포트에서 알림을
    받는다. core `worker/boot.test.ts`는 `driver: runDriver`로 로더 실패·콘솔 생성 실패(`Proxy`로 감싼 pyodide의
    `pyimport`만 던지게 한다)·`setStdin` 실패·버퍼 연결 실패(`B1`~`B4`)와 연결 순서·부팅 전 눌림·감시 타이머 정지
    (`B5`~`B7`)·`crashed`(`B8`)를 driver 중립으로 본다(`00-architecture.md` 3.1). repl `worker/boot.test.ts`는
    `driver: replDriver`로 배너·`readLine` 각본을 포함한 REPL 고유·혼합 규칙만 본다.
  - 부팅 뒤 REPL 루프는 각본 `readLine`으로 시험한다. main 역할이 `readLine` 핸들러를 각본 배열로 답하고(각본이 끝난 뒤의
    요청은 오류로 답하되 기록은 남긴다), 알림과 `readLine` 요청을 한 타임라인(`events`)에 도착 순서대로 기록해 "출력 → 다음
    프롬프트 요청" 순서 전체를 단언한다. 종료 뒤에는 시간을 두고 이벤트 수가 늘지 않는지(요청이 더 오지 않는지) 본다.
    실행 밖 오류 경로는 각본이 문자열이 아닌 값(`42`)을 답하게 해 실제 `push`가 `TypeError`를 던지게 만든다.
  - 러너(`worker/submission-runner.test.ts`)는 실제 pyodide의 `createConsole`이 만든 `ReplConsole`을 `createSubmissionRunner`에
    물려 한 줄 제출·값 에코·오류 표시·끝 개행·`exit`·`null` 취소를 본다. 사용자 코드 밖에서 새는 `KeyboardInterrupt` 안전망은
    실제 SIGINT 없이 `runLine`·`clearPending`을 `KeyboardInterrupt`를 던지는 Python 함수로 바꿔 끼워 재현한다.
  - `worker/multiline.test.ts`(RD-011, node + 실제 pyodide, 24건: 문장 단위 분할 11·입력 정규화 4·부작용 1·
    파싱 오류 5·2차 `compile` 2·globals 오염 없음 1)는 `split_paste(source, flags)`(`multiline.py?raw`)를 실제
    콘솔의 `compilerFlags()`로 얻은 플래그로 직접 부른다. 같은 파일의 `worker/submission-runner.test.ts`는
    여러 줄 분할·줄 흘림·중단·무동작·`builtins._` 갱신 시험(신규 43건, 기존 26건 + 코퍼스 검증 포함 69건)과
    `describe("코퍼스 27")`을 더한다 — 코퍼스는 `packages/pyodide-repl/test/worker/multiline-corpus.json`
    (이름·소스 27개)을 순회하며, 새 콘솔+러너로 `run(source)`한 stdout과 같은 pyodide에서
    `exec(compile(source, "<x>", "exec"), {"__name__": "__main__"})`를 돌려 캡처한 stdout을 비교한다
    (stderr는 `""`이어야 한다). 값 에코 차이를 피하려고 코퍼스 소스는 모두 `print`로 끝나거나 값 문장이
    없다.
  - stdin 콜백(`worker/stdin-callback.test.ts`)은 실제 pyodide에 `setStdin({ stdin: createStdinCallback(...) })`을 걸고 `input()`·`sys.stdin.readline()`·`read(3)`·`readlines(1)`·`for line in sys.stdin`이 같은 경로로 값을 받는지, 콜백 호출 수가 소비한 줄 수와 같은지 본다. `requestInput`과 `wait`의 앞뒤 순서는 호출 순서를 기록하는 주입 함수로 단언한다(알림을 `wait()` 뒤로 옮긴 변이가 이 시험에서 잡힌다). `setStdin` 없이 `input()`을 부르면 시험이 실패하지 않고 스위트가 멈추므로(외부 `timeout`이 필요하다) 시험 인스턴스에 `setStdin({ error: true })`를 먼저 걸고, `afterEach`에서 `sys.stdin`을 새 스트림으로 교체한다(`read(n)`이 남긴 `\n`이 다음 시험을 채운다, `docs/traps/TRP-010`).
  - 같은 파일의 **취소 변환**(RD-008)은 `runPython`이 아니라 **콘솔 러너 경로**로 돌린다: 핸들러는 스택에 `<console>` 프레임이 있을 때만 `KeyboardInterrupt`를 내므로 `runPython`의 파일명 `<exec>`에서는 취소가 버려지고 CPython이 읽기를 재시도한다. `sigint-handler.test.ts`의 `setup()`과 같은 순서로 `createConsole` → `createInterruptBuffer` → `installSigintHandler` → `setInterruptBuffer` → `createSubmissionRunner`를 만들어 제출하고 `screen.stderr`로 트레이스백 바이트를 단언한다. 보는 것: `input()`·`readline()`·`read()`·`for line in sys.stdin`·함수 프레임의 트레이스백, `try/except/finally/with`, 재시도 없음(`countWaits === 1`), 요청 번호를 올리지 않은 전송은 무시(TRP-035 검출), `checkInterrupt()`가 던지지 않으면 `EOFError` + `console.warn` 1회, 20회 반복 뒤 SIGINT 잔류 0.
  - **취소와 눌림의 경합**(같은 파일)은 눌림 스레드(core `test/roles/interrupt-presser.ts`)를 띄운다. 읽기가 열린 순간을 기준으로 삼기 위해 `installStdin`에 `onRead` 훅을 두고 그 안에서 시작 표시(`ctl`)를 세운다. 0ms 연타는 취소와 같은 읽기 안에 떨어져 콜백의 `checkInterrupt()`가 함께 소비하고(실측 20라운드 잔류 0), 취소가 끝난 뒤 도착한 눌림은 돌고 있는 Python이 없어 슬롯에 남아 루프의 `discardPendingInterrupt`가 지운다(그 시험이 `SIGNAL === 2`를 단언한다). `except KeyboardInterrupt` 뒤 계산 중 눌림은 시간과 stderr 둘 다 본다(대조 215ms → 눌림 34ms).
  - 부팅의 `input()` 시험(`worker/boot.test.ts`)은 **선전달 기법**을 쓴다. `Atomics.wait(ctrl, STATE, IDLE)`은 STATE가 이미 READY면 즉시 돌아오므로, 각본이 `input()` 줄을 답하기 전에 main 역할이 `deliver`를 해 두고 타임라인(`write("x: ")` → `readInput(true)` → 다음 `readLine`)과 값(`x`의 에코 `'abc'`, `sys.stdin.readline()`의 에코 `'def\n'`)을 단언한다. 스레드는 쓰지 않는다. 메일박스 대기 중 `complete`가 큐잉되는 프로토콜 쪽은 `protocol/thread-scenario.test.ts`의 스레드 시험이 본다.
  - `exit()`·중단·`input()` 취소는 asyncio가 `SystemExit`·`KeyboardInterrupt`를 WebLoop로 다시 던져 vitest를
    `Unhandled Rejection`으로 실패 종료시킨다. RD-009의 `suppressWebLoopReraise`가 이 재보고를 없앴고
    **`vitest.config.ts`의 `onUnhandledError` 필터는 제거했다**(억제 없이 필터만 떼면 개별 시험이 다 통과해도
    `Errors 210` + 종료코드 1이다 — 실측). 실제 pyodide를 직접 로드하는 시험 파일은 core `worker/boot.ts`(`bootWorker`)의 배선이 닿지
    않으므로 **그 파일의 콘솔 조립 지점에서 `suppressWebLoopReraise`를 직접 불러야** 한다. `process.on
("unhandledRejection")`은 쓰지 않는다(집계에서 빠진다, TRAP-22).
  - `time.sleep`의 무효 인자 문구(`-1`·`'a'`·NaN·inf·키워드·인자 2개·`9.3e9`)를 단정하는 시험의 기준은 **로컬
    CPython 3.14.4**로 재 둔 문자열이다(번들 pyodide는 3.14.2 — 편차 19). 조각 래퍼는 이 인자들을 원본 C 함수에
    그대로 넘겨 문구를 보존한다.
  - 시험 입력 함정: `1 +`·`foo bar` 같은 EOF 문법 오류는 pyodide 314.0.7의 `pyconsole.push`가 `_IncompleteInputError:
incomplete input`으로 표시한다. `runLine`은 이를 표준 `SyntaxError: invalid syntax`로 정규화해 돌려주므로(`02-console-core.md`
    5.1) `push`를 직접 부르는 시험만 원문을 기대해야 한다(`x = = 1`은 원문도 `SyntaxError: invalid syntax`). 한 줄에 `;`로
    이은 앞 식문장의 값은 콘솔이 stdout으로 에코해 꼬리를 비우므로, 개행 없는 출력 시험은 값이 없는
    `print(..., end="")`로 만든다.

## 9.2 jsdom(기본 환경) + 실제 `Readline` + 가짜 터미널 / 가짜 타이머

`auto-indent.test.ts`(순수 함수 + `createAutoIndent` 정책 객체, RD-013 완료 — 별도 `-reader.ts` 파일 없이
한 모듈에 둔다), `block-history.test.ts`(실제 `Readline` + 가짜 터미널, `createBlockHistory` 정책 객체,
RD-014 완료), `line-editor.test.ts`(`createLineEditor`가 autoIndent·blockHistory·tabReader 세 정책을 합성하는
규칙, RD-029 — 옛 `read-options.test.ts`의 `mergeReadOptions` 순수 함수 시험을 대체했다, `06-editing.md` 6.8) — 벤더 `packages/xterm-readline`의
`history-entry.test.ts`도 같은 `StubTerminal` 패턴으로 `historyEntry` 훅을 본다 — 벤더 `packages/xterm-readline`의
`print-above.test.ts`도 같은 패턴으로 `printAbove`(버퍼·커서 유지, 재그리기 중 키 큐 순서 보존, 커서 끝·이모지
버퍼, 활성 읽기 없을 때 `println` 동등, dispose 뒤 콜백 무해, 다중 행 블록·감긴 단일 행에서 소실 없음,
`cancelRead()` 경합 무해, RD-015 DELTA-01·01a·04a 11건)를 본다), `tab-completion.test.ts`(`planTab`·`resolveCompletion`·`formatCompletionList`,
RD-016이 `planTab` 게이트 분기 10건 추가: 빈 스템 `import `·`from os import ` → complete, `x = ` → indent, `important = ` → complete, `pending`에만 `import`가 있는 경우),
`import-gate.test.ts`(`mentionsImportKeyword` 코퍼스 55줄 61건: 게이트 거짓 16·오탐 28·비`None` 11·대소문자 2, 코퍼스 정의는 `terminal/import-gate-corpus.ts`, `complete-source.test.ts`가 같은 코퍼스로 안전성을 본다),
`tab-reader.test.ts`(RD-016이 게이트 참 빈 스템 배선 6건 추가: `pending` 전달, `x = ` 무왕복 공백, 8연타 큐 → 32칸, Tab 직후 입력·커서 이동 → 응답 버림), `packages/pyodide-terminal/test/prompt-row/read.test.ts`(RD-027, 구
`stdin-reader.test.ts`·`repl-reader.test.ts`), `packages/pyodide-terminal/test/rewind-tail.test.ts`, `read-guard.test.ts`, `output-tail.test.ts`, `sink-writer.test.ts`,
`worker/repl-loop.test.ts`(pyodide 없이 주입한 `readLine`·`run` 각본으로 프롬프트·`pending` 전달, 종료, 실행 오류 복구, 읽기
요청 거절 정책, **`setAtPrompt` 호출 순서**(`true` → `readLine` → `false` → `discardPendingInterrupt` → `run`, 취소
`null`과 `readLine` reject 경로 포함)를 고정), `create-repl/*.test.ts`(`createRepl`),
`history-filter.test.ts`, `paste-tabs.test.ts`, `interrupt-protocol.test.ts`,
`interrupt-sender.test.ts`(주입 타이머로 전송·재전송·10회 상한·읽기 순서), `interrupt-watch.test.ts`,
`App.test.tsx`(배선: 전송·재전송, `readLine`/`readInput` 진입, 세션 리셋, 언마운트).

- 가짜 터미널(`packages/pyodide-testkit/src/fake-terminal.ts`, `@repo/pyodide-testkit/fake-terminal`)은 `write` 콜백을 동기/비동기 둘 다 돌릴 수 있어야 한다
  (동기만 쓰면 TRP-008을 놓친다). history는 ↑ 재호출로만 관찰한다.
  `createFakeTerminal({ asyncWrite, cols, rows })`가 `{ term, screen, written, type, paste, keyDown, flush, disposedBufferReads }`를 돌려준다.
  `entries` 직접 단언은 ↑ 재호출로 구분할 수 없는 복구 두 경우(50개 제한으로 밀린 항목 복구, 중복 제거로 옮겨진 옛 항목의 원래 자리 복구)에만 쓴다(`block-history.test.ts`, RD-014 확정 8).
  `Readline`이 읽는 xterm 멤버와 `loadAddon`·`dispose`만 구현하고 화면은 해석하지 않는다(원문 `written`). 화면 버퍼를 읽는
  코드(`rewindTail`)를 위해 `screen`에 시험이 값을 지정하는 최소 모델만 둔다: `buffer.active.{cursorY, baseY, getLine(row)?.isWrapped}`가
  읽는 `cursorY`·`baseY`·`wrappedRows`이고 VT는 해석하지 않는다. 기본값(커서 0행, 스크롤백 없음, 감긴 행 없음)은 값을 지정하지
  않는 시험에 영향이 없다. 실제 화면 결과(앞 행 중복 없음)는 9.3의 브라우저가 본다.
  `type()`은 키 하나마다 `onData`를 한 번씩 부르고(이스케이프 시퀀스는 한 키) `paste()`는 한 번에 보낸다. 비동기 모드는 콜백을 `flush()`까지 미룬다.
  실제 xterm처럼 `dispose()` 뒤에도 write 콜백을 돌리고 그때의 `buffer` 읽기(`cursorY`·`baseY`·`getLine`)를 `disposedBufferReads`로 센다(`docs/traps/TRP-004`).
  실제 xterm `Terminal`은 jsdom에서 `open()`이 `matchMedia` 없음으로 실패해 브라우저(9.3)에서만 쓴다.
  배출 도우미 `drain(fake)`(`flush → tick → flush`)와 VT 부착 도우미 `attachScreen(fake, rows = 24)`(`new VtScreen` + `attachVtScreen`)의 원천은 testkit(`@repo/pyodide-testkit/fake-terminal`·`/vt-screen`)이다 — terminal·repl 시험은 이를 import하거나 terminal `./test-utils`를 통해 재수출받아 쓴다(RD-043).
- `create-repl/*.test.ts`는 worker 역할 rpc(초기화 프레임의 `rpcPort`에 시험이 만든 `createRpc`)가 `readLine`을 요청하고 main이 읽기를
  시작하는 경로로 줄 편집·이중 요청 거절·dispose·`terminated`를 본다. `startRead(session, prompt)` 도우미가 요청을 보내고 입력
  상태가 만들어질 때까지 write 콜백을 배출한다. 출력 알림은 빈 문자열 write를 내지 않으므로 빈 문자열 write의 개수가 늘어난 것을
  "요청이 도착했다"는 신호로 쓴다(`written.length` 증가는 앞선 출력 알림에도 반응한다). 긴 꼬리는 `rewindTail`이 flush를
  기다리므로 배출을 두 번 한다. 읽기 Promise는 객체 `{ line }`에 담아 돌려준다(`async` 함수가 반환한 Promise를 풀어 Enter까지
  멈추는 것을 피한다). 응답이 오지 않는 시험(dispose 뒤 요청)은 `observe`로 상태만 본다.
- 실제 pyodide의 **동기** stdin 콜백 안에서 실제 `Readline`을 기다릴 수 없어, `input()` 통합은 read를
  동기 fake로 대신한다. 이 저장소는 양쪽을 나눠 본다: main은 jsdom(`create-repl/input-read.test.ts`)에서 `readInput` 알림 뒤
  메일박스 응답을 `takeMailboxResponse`·`peekMailbox`(`01-protocols.md` 2.5, fake worker가 `takeResponse()`·`peekMailbox()`로
  내보낸다)로 확인하고, worker는 node + 실제 pyodide(`boot.test.ts`의 선전달 기법)에서 본다. 실제 `Atomics.wait` 왕복은
  RD-002의 스레드 시험이 담당한다.
- `read-guard.test.ts`는 결과를 시험이 정하는 가짜 읽기(`deferred`)로 순서 규칙을, 실제 `Readline` + 가짜 터미널 + `createTerminalSurface`의
  `promptRow`(RD-027, 구 `createReplReader`·`createInputReader`)로 "REPL 줄은 REPL 읽기가, 그다음 줄은 stdin 읽기가 받는다"를 본다(가드의 `await`를 빼면 후자가 실패한다). 마이크로태스크 한 번 안에 시작해야 하는 규칙("활성 REPL 읽기가 없으면 기다리지 않는다")은 `tick` 뒤가 아니라 `await Promise.resolve()` 뒤에 단언한다.
- `interrupt-watch.test.ts`는 가짜 타이머(`vi.useFakeTimers`)와 주입 deps로 감시 타이머 규칙을 본다: SIGINT가 없으면
  `interruptIdle`을 부르지 않는다, 20ms 간격, 깨웠으면 소비, 못 깨우면 남기고 재시도, 부르는 동안 버퍼가 바뀌면
  덮어쓰지 않는다, 콜백이 던져도 계속 돌며 `console.error`, 중지, 프롬프트 유휴 폐기(실행 중이면 남긴다·깨웠으면
  프롬프트여도 소비·상태는 틱마다 재확인·폴링이 먼저 소비했으면 ack 안 함). `interruptIdle()`의 반환값에는 경합이
  있으므로(`03-ctrl-c.md` 2.5) 실제 pyodide 쪽 시험에서 `woke === true`를 단언하지 않는다 — 깨어남은 경과 시간과
  화면으로, ack는 슬롯으로 본다.
- **변이 검사(mutation)** 를 관행으로 쓴다: 요청 번호와 SIGINT 쓰기 순서 뒤집기, 송신기가 ack를 먼저 읽기,
  핸들러 ack 위치 옮기기, 감시 타이머 ack를 비교 교환과 무관하게 올리기, 연결이 무조건 ack하기 등이 각각
  해당 테스트를 실패시키는지 확인했다.

## 9.3 브라우저(Playwright headless Chromium, dev 서버)로만 확인되는 것

- SharedArrayBuffer/Atomics 동기 브리지 결합, `sync === true` 확인, COOP/COEP 의존 동작.
- 실제 xterm의 **비동기 파싱**과 `isWrapped`·flush 타이밍(TRP-016/017 계열), 꼬리 재그리기 화면.
- 눌림 간격·소실률·위험 구간 같은 타이밍 통계(연타 매트릭스 조합별 N=20, `while True: pass` 단일 눌림
  N=200 등), 부팅 중 Ctrl+C(N=30), 정지한 실행 12조합. RD-007의 스크립트: `ctrl-c-check.mjs`·`press-loss.mjs`·
  `burst-matrix.mjs`·`boot-press.mjs`·`positive-controls.py`(양성 대조 3건), node 통계는 `verify/node/`의
  `press-loss.mjs`(N=3000)·`poll-overhead.mjs`. RD-008의 스크립트: `prompt-cancel-check.mjs`(23개)·
  `input-cancel-check.mjs`(26개)·`input-burst-matrix.mjs`(8셀 × N=20)·`positive-controls.py`(3건)·
  `pty/pty_cancel.py`(3.14.4 취소 7건). RD-009의 스크립트: `sleep-await-check.mjs`(정지한 실행 12조합 × N=20)·
  `run-browser.sh`·`positive-controls.py`(3건), node 통계는 `verify/node/sleep-stats.mjs`(JSPI 유무 × 5 프로그램
  × N=30).
- **`pageerror` 기준선은 총계 0이다**(RD-009부터). webloop 재보고를 억제하기 전에는 확인 스크립트가 재보고를
  분류해 빼고 셌지만(`isWebLoopReraise`), 이제 정상 중단·`input()` 취소·`exit()` 어디서도 재보고가 나지 않는다.
  RD-009 실측: 12조합 240시행 0, 재실행 4종(`repl-check normal`·`ctrl-c-check`·`prompt-cancel-check`·
  `input-cancel-check`) 전부 0(이전 기준선 1·시행당 2·4·28건).
- 정지한 실행 12조합의 판정은 복귀 여부 + 복귀 지연 + **화면 형식** + 우리 프레임 0 + `pageerror` 0을 따로 센다.
  240/240 복귀·지연 중앙값 12/12셀 30ms 이내, 형식 판정 12/12셀(RD-009a 뒤. RD-009 당시 `arun-sleep`·
  `runsync-sleep`은 편차 28(`docs/traps/TRP-021`)로 형식 판정에서 제외했었다).
- 양성 대조는 "이 확인이 무엇을 잡는가"를 셋으로 나눠 건다(RD-009): 억제 제거 → `pageerror` 총계 0 → 10,
  ≤20ms 폴링 제거 → `sleep-0.01` 중앙값 28.44 → 96.79ms, 감시 타이머 제거 → `arun5` 24.22 → 4010.3ms.
  각각 해당 확인만 실패하고 원복 후 통과해야 한다(변조 → dev 재시작(TRP-007) → 실행 → `git checkout --`).
- 지연을 재는 확인은 **눌림 시각과 화면 변화 시각을 둘 다 페이지 안에서** 잡는다(keydown 리스너 +
  `MutationObserver`). Node 쪽에서 `page.$$eval` 폴링으로 재면 CDP 왕복이 끼어 5~8ms 과대 측정돼 문턱 근처에서
  가짜 회귀가 난다(`docs/traps/TRP-022`).
- 연타 화면 판정은 행 감김·스크롤 아웃·프롬프트 재그리기에 깨진다(TRP-016). `while True: pass`·`for …: pass`는
  **한 줄 복합문**이라 빈 줄 Enter가 있어야 실행이 시작된다(3.14와 같다) — 그 단계를 빼면 Ctrl+C가 `... `
  프롬프트의 활성 읽기로 가 벤더 경로에서 `... ^C`만 남는다.
- StrictMode 이중 마운트 거동.
- 화면 행 텍스트(`.xterm-rows > div`)만 비교하면 출력 끝의 여분 빈 줄이 보이지 않는다. 개행 수는 커서 행 번호로
  단언한다(`docs/traps/TRP-006`).
- xterm이 키와 출력을 비동기로 그리므로 하니스는 입력이 커서 행에 그려진 것을 확인한 뒤 진행하고, Enter를 친 뒤에는 화면이
  바뀐 것을 확인하고 나서 새 프롬프트(`>>>`·`... `) 행을 기다린다. 그리기 전에 화면을 읽으면 낡은 프롬프트 행에 통과하고,
  새 프롬프트가 뜨기 전에 보낸 키는 벤더 `Readline`이 쌓았다가 다음 읽기에서 재생한다(RD-019 type-ahead, 6.7) — 낡은 프롬프트 행에 통과한 뒤 친 키는 사라지지 않고 뜻밖의 줄로 재생돼 판정이 어긋난다. Ctrl+C만 쌓이지 않고 버려진다(`docs/traps/TRP-005`).
- stdin 프롬프트(`x: `)는 읽기가 시작되기 전에 화면에 나온다(`write` 알림이 `readInput` 알림보다 먼저 그린다). 프롬프트 없는 `input()`은 화면 신호가 없다. 그래서 `waitLastEndsWith("x:")`가 참이어도 읽기가 시작됐다는 보장이 없어, 입력은 첫 글자를 한 번만 치고 에코(쌓인 키가 읽기 시작에서 재생되는 시점)를 기다린다(`typeWhenReading`). **재시도하지 않는다** — 첫 글자가 버려지지 않고 쌓이므로 다시 치면 글자가 중복된다(RD-019 이전에는 버려진 키가 화면에 흔적이 없어 재시도가 안전했다).
- **취소도 같다**: 읽기가 열리기 전의 Ctrl+C는 쌓이지 않고 쌓인 키를 비운 채 `ctrlCHandler`로 가 게이트에 막혀 버려진다(`docs/traps/TRP-005`). `cancelWhenReading(text)`는 `typeWhenReading`으로 읽기를 확인한 뒤 Ctrl+C를 누른다(글자가 최소 하나 필요하다). 그 앞에 화면을 바꾸는 동작(빈 줄 제출 등)을 두면 무관한 재그리기를 첫 글자 에코로 오인해 글자를 잃는다 — `clear()` → 제출 → `cancelWhenReading` 순서만 쓴다.
- 출력 유무를 **부분일치로 판정하지 않는다**: 제출한 소스 줄이 화면에 에코되므로 `exec("…print('wrong')")`을 제출하면 화면에 `wrong`이 있다. 행 정확일치(`hasRow`)나 눌림 직전 개수를 기준선으로 잡은 증가분(`countOf`)으로 본다(RD-008에서 이 버그로 확인 하나가 거짓 통과했다).
- 취소 전 마지막 행이 이미 `>>>`인 확인(빈 프롬프트 취소)은 `waitPrompt(">>>")`가 낡은 행에 즉시 통과한다. 취소 줄(`KeyboardInterrupt`)이 나타나는 것을 먼저 기다린다.
- 출력이 나온 시점을 "행에 마커 포함"으로 기다릴 때는 입력한 코드 행을 뺀다. 코드 행이 같은 마커를 포함해 즉시 통과한다(`docs/traps/TRP-011`). 시간을 재는 확인은 경과 시간과 화면 끝을 로그에 남긴다.
- "이 로그가 없다"는 확인은 후속 출력에 밀려 뷰포트 밖으로 나간 행을 놓친다. 화면을 지우고(Ctrl+L) 한 번의 동작 직후 행 목록을
  정확히 단언한다(예: `gc.collect()` 직후 화면이 값 에코 한 줄뿐). 수정을 제거하는 변조로 확인이 실패하는지 봐서 검출력을 확인한다.
- 미확인으로 남은 것: **프로덕션 빌드, Firefox, Safari, `sync=false` 폴백**, 자동화 E2E(범위 밖).
- **세션 리셋·크래시(RD-010)**: worker 교체(`session-reset-check.mjs`, `_works/_completed/20260922-11-rd-010-session-reset/verify/`)는 `data-testid=status`의 상태 전이(`loading`→`ready`/`load-failed`)로 "리셋이 끝났다"를 기다린다 — 화면 행(안내 줄) 개수로 판정하면 xterm 뷰포트(기본 24행) 밖으로 밀려난 옛 행이 DOM에서 사라져 여러 번 반복한 뒤(실측 4번째부터) 무한 대기한다(`docs/traps/TRP-024`). 리셋 직전 Ctrl+C 경합(`Promise.all([ctrlC(), 리셋 클릭])`)도 N=10을 상태 전이 기준으로 돌려야 안정적이다(`ccreset`). 실행 중 리셋 직후 첫 Ctrl+C는 `ccafter`가 센다(아래 `session-reset-check.mjs` 문단). 취소 트레이스백 직후 곧바로 타이핑하면 첫 글자가 드물게 드롭된다(`docs/traps/TRP-005`류) — `h.settled()`로 화면이 멈춘 뒤 입력한다. `crashed` 유발은 `pyodide.code.run_js("setTimeout(() => { throw new Error('forced') }, 0)")`(동기 throw는 `JsException`이 되어 worker를 안 죽이므로 타이머 경로가 필요, RD-010 확정 17)이고 `pageerror` 기준선은 이 유발 1건만 허용(그 밖은 0).
- 리셋 안내 줄의 개행 판정 재료가 꼬리로 바뀌었다(RD-028, 옛 `cursorX===0` 분기는 폐기). `create-repl/reset.test.ts`의 "리셋 안내 줄" 시험은
  커서를 직접 지정하지 않고 실제 배경 출력(`workerRpc.notify("write", "t")`)으로 현재 io 꼬리를 만들거나 비워 두 분기(꼬리
  있음 → 개행, 꼬리 없음 → 개행 없음)를 단위 시험으로 고정한다(DELTA-02). 이 분기의 브라우저 확인(L1)은 이 작업에서 추가하지
  않았다 — 모든 분기가 브라우저로 확인 가능한 것은 아니다.

## 9.4 측정·비교 기준

- 동등성 기준은 CPython 3.14.4를 pty(24×80, `TERM=xterm`)로 구동한 실측이다. 화면 비교는 pyte로 읽는다.
- 후보를 비교할 때는 OK/HANG/CRASH/DIRTY 같은 판정 축과 n을 정해 표로 남기고, "간격 0ms"처럼 합쳐져
  성공처럼 보이는 측정(TRP-018)과 "재전송 수 = 소실 수"라는 오독(TRP-025)을 피한다.

참고: `/work/cp949/pyodide-samples/apps/repl/DESIGN.md`("테스트 전략"),
`/work/cp949/pyodide-samples/apps/repl/src/repl/*.test.ts`,
`/work/cp949/pyodide-samples/apps/repl/src/test/`

## 9.5 검증 하니스 설계 규칙 (이전 구현의 측정 함정 11건 압축)

측정·테스트 방법론 함정은 전부 "측정이 통과했는데 사실이 아니다"라는 같은 모양이다. 규칙으로 압축한다.

1. **TRAP-18 (TRP-011) pty `_pyrepl` 화살표는 `TERM`에 맞춰 보낸다.** `TERM=xterm`이면 ↑ `\x1bOA`·↓ `\x1bOB`, `TERM=linux`면 `\x1b[A`·`\x1b[B`. 다른 쪽은 오류 없이 버려져 "↑ 무동작"으로 오인된다. 인식 여부는 "직전 입력이 다시 그려지는지"로 판정하고 `PYTHON_COLORS=0`·`NO_COLOR=1`로 색을 끈다(색 이스케이프가 `print(12345)` 부분 문자열 검사를 오탐으로 만든다). 홈 오염 방지로 `PYTHON_HISTORY`는 임시 파일로 고정한다. 시퀀스를 바꿔 한 번 확인하기 전에는 실측 결론을 쓰지 않는다.
2. **TRAP-19 (TRP-013) pty CPython의 무개행 stderr·stdin 중 stdout은 명시 flush로 잰다.** `sys.stderr.line_buffering=True`, `write_through=False`라 `\n`·`\r` 없는 조각은 다음 flush까지 안 나오고, 그 텍스트가 다음 케이스 바이트에 섞여 나온다. 실측 문장에 `sys.stderr.flush()`(또는 `flush=True`)를 명시하고, 바이트가 섞여 보이면 이전 케이스의 잔류부터 의심한다. 웹 REPL은 stderr 버퍼가 없어 무개행 조각을 즉시 표시하는 의도된 편차다.
3. **TRAP-20 (TRP-015) 배경 실행 pty 자식은 SIGINT 처분을 먼저 확인한다.** 비대화형 셸이 `&` 비동기 명령의 SIGINT를 SIG_IGN으로 두고 exec 뒤에도 유지된다. `pty.fork()` 자식에서 exec 전에 `signal.signal(signal.SIGINT, signal.SIG_DFL)`를 부르고, 스크립트 시작 시 자식의 `signal.getsignal(signal.SIGINT)`가 SIG_DFL인지 단언한다.
4. **TRAP-21 (TRP-018) Ctrl+C 연타는 간격을 스윕하고 눌림이 아니라 `KeyboardInterrupt` 수로 센다.** 간격 0(실제 약 1µs)은 쓰기가 합쳐져 눌림 한 번과 같아지고, pty의 0ms 송신은 커널이 `^C` 에코를 합친다. 간격 0·0.2·0.5·1·2·5·20·50ms를 스윕하되 0은 "합쳐짐" 셀로 따로 읽고, 실제 대상의 이벤트 타임스탬프로 간격 분포를 먼저 잰다. 결과를 종류별로 집계하고 종류가 모두 드러날 때까지 표본을 늘린다(3.14 pty는 50회에서 세 종류, 확률 3% 셀은 20회로는 안 보인다). 콜드(세션 첫 트레이스백)와 웜을 구분한다.
5. **TRAP-22 (TRP-023) `unhandledRejection` 리스너를 붙인 시험은 집계에 기대지 않는다.** vitest의 `catchError`가 해당 이벤트 프로세스 리스너 수가 1을 넘으면 집계하지 않는다(vitest 5.0.1). 리스너로 모은 목록의 단언(`expect(rejections).toEqual([])`)이 유일한 신호다. 리스너는 `onTestFinished`로 반드시 뗀다. vitest를 올릴 때 이 판정이 바뀌었는지 확인한다.
6. **TRAP-23 (TRP-024) 폴링 경로에는 JS 코드를 더하지 않는다.** 접근자·Proxy 비용은 폴링 횟수에 비례하고 폴링 밀도가 작업량마다 약 100배 다르다(맨몸 `while` 반복당 0.02~0.04회 대 `str(i)` 반복당 약 2.04회). 3M회 맨몸 루프 +10%만 보면 통과처럼 보이지만 `''.join(str(i) …)`는 2.93배다. 소실은 폴링 쪽이 아니라 눌림 쪽(ack + 재전송)에서 푼다. 폴링 경로를 건드리는 변경은 `str(i)` 루프로도 재고(plain 대비 1.03 이내, 10회 교차), 폴링 횟수는 카운터 래퍼로 센다.
7. **TRAP-24 (TRP-025) 재전송 횟수를 소실로 세지 않는다.** 폴링이 슬롯을 비운 뒤 핸들러가 ack를 올리기 전 약 40µs 창에 점검이 걸리면 가짜 재전송이 생긴다(5ms 점검에서 발생률 0.8%, 추적 11/11이 이 창). 소실은 `KeyboardInterrupt`가 0인 눌림이나 감시견이 살려야 했던 라운드로 센다. 통과선을 "재전송 0"이 아니라 "미소비 구간(슬롯이 2인 동안)의 재전송 0 + 중단 정확히 1회"로 나눠 잰다.
8. **TRAP-25 (TRP-028) 지연 측정은 눌림 시각을 무작위로 두고 N≥30의 최대값으로 판정한다.** 폴링을 pyodide 틱 클럭에 맡긴 대기는 최대 지연이 (반복 1회 시간)×12.5~13.1까지 늘어나는데, 눌림 시각 고정 하니스(브라우저 `sleep-0.01` 166ms)와 판정선 1초 단위 시험은 통과한다. 눌림 시각이 고정인 결과는 "위상 하나"임을 적고, 대기 시간 조합을 20ms 경계 근처까지 넓힌다. 시험은 지연 시간이 아니라 폴링 호출 횟수로 가른다.
   - **재확인 방법**(이 저장소, RD-009): `sleep-slice.py`의 `secs <= SLEEP_SLICE` 분기에서 `poll()` 한 줄을 지우고 `verify/node/sleep-stats.mjs --progs loop002,loop001 --n 30 --mode jspi`를 돌려 배수를 잰다. 실측 `loop002` 중앙값 12.2 → 187.6ms(15.4배)·최대 20.4 → 339.5ms(16.6배), `loop001` 중앙값 6.7 → 66.6ms(9.9배). 브라우저 쪽 같은 변조는 `sleep-0.01` 중앙값 28.44 → 96.79ms. 측정 결과는 실측 파일과 **다른 이름**으로 저장하고(같은 이름이면 정상 실측을 덮어쓴다) 곧바로 `git checkout --`로 원복한다. 판정 항목이 아니라 근거 기록이다.
9. **TRAP-26 (TRP-029) 블로킹 대기의 눌림은 별도 스레드로 넣는다.** 블로킹 대기 동안 Node 이벤트 루프가 멈춰 `setTimeout` 눌림이 대기가 끝난 뒤 도착하므로 `pressed > 0` 그리고 `sincePress < 1s`가 끊기지 않았는데도 만족된다(`time.sleep(3)`이 3006ms 걸렸는데 통과). `worker_threads` 눌림 스레드와 `process.hrtime.bigint()` 공유 시계를 쓰고, 눌림 뒤 지연뿐 아니라 실행 전체 시간과 `screen.stderr`(트레이스백)도 단언한다. 새 시험은 기준선 코드에서 RED인지 확인한다.
10. **TRAP-27 (TRP-034) 모듈 완성 후보는 개수·전체 목록을 단정하지 않는다.** `sys.path[0] == ''`라 cwd의 `.py` 파일이 후보가 되고 환경 모듈 집합도 다르다(3.14.4 네이티브 192개, pyodide 178개, 하니스 폴더 pty 196개). 시험·문서는 접두사·포함 여부·삽입 결과·구조(열 우선 배치, 200개 상한)를 단정하고, 후보 리터럴은 네이티브와 pyodide가 같은 케이스에만 쓴다. 문서에 개수를 적을 때는 측정 환경(빈 임시 cwd, 번들 버전)을 함께 적고, pty 측정 하니스는 자식 REPL의 cwd를 빈 임시 폴더로 고정한다.
11. **TRAP-28 (TRP-035) SIGINT를 심는 프로브는 실제 경로와 같은 순서로 쓰고 ack로 판정한다.** 핸들러가 요청 번호(슬롯 2)가 그대로면 재전송으로 보고 무시하므로, 슬롯 0에만 쓴 프로브는 "영향 없음"으로 오판된다. 프로브도 `Atomics.add(buffer, 2, 1)` 뒤 `Atomics.store(buffer, 0, 2)` 순서로 쓰고, 소비 여부는 슬롯 0이 아니라 ack(슬롯 1) 증가로 본다. "영향 없음" 결론 전에 같은 대상이 실제 Ctrl+C 경로에서는 끊기는지 양성 대조를 둔다.
12. **(TRP-022, 이 저장소 RD-009) 브라우저 지연은 페이지 안의 한 시계로 잰다.** `keyboard.press` 직전 Node `performance.now()` + `page.$$eval` 폴링으로 재면 폴링마다 CDP 왕복이 최소 2회 껴 평균 5~8ms를 보탠다. 실측에서 이 방식이 12셀 중 8셀을 30ms 문턱 바로 위(31.5~33.9ms)로 밀어 가짜 회귀를 만들었고, 같은 시행을 페이지 내부 keydown 리스너 + `MutationObserver`(같은 `performance.now()` 시계)로 재니 12/12셀이 문턱 안(22.19~29.98ms)이었다. 측정 대상(눌림 → 새 프롬프트가 보인 시각)은 바꾸지 않고 시계만 옮긴다. 문턱에서 5~10ms 안쪽 결과는 다른 시계로 한 번 더 재기 전에 회귀로 보고하지 않는다. 실패한 1차 측정 로그는 판단을 되돌릴 근거이므로 버리지 않는다.

참고: `/work/cp949/pyodide-samples/docs/repl/traps/` 의 TRP-011, TRP-013, TRP-015, TRP-018, TRP-023, TRP-024, TRP-025, TRP-028, TRP-029, TRP-034, TRP-035

## 9.6 이전 구현의 검증 자산 위치

### 9.6.1 단위 시험 (vitest)

- 실행: `pnpm --filter repl test`(= `vitest run`). 최종 규모 **32파일 / 781개**(RD-016 종료 시점 28/603 → RD-016a 29/774 → RD-012h 30/778 → RD-021 32/781).
- 기본 환경은 jsdom(`vite.config.ts`의 `test.environment`), 셸 컴포넌트는 Testing Library 렌더 스모크 하나뿐이다(`src/App.test.tsx`).
- **핵심은 `// @vitest-environment node` 파일들이다. 여기서는 실제 pyodide를 로드한다** — `pyodide`(catalog가 고정한 버전, `13-version-upgrade.md` 13.1)가 devDependency로 설치돼 있고 20개 안팎의 시험 파일이 `loadPyodide`를 직접 부른다. 실제 `PyodideConsole`·SIGINT 핸들러·stdin 콜백·완성 후처리·sink 바이트·`Readline` 출력까지 진짜로 돌린다.
- 대표 파일(전부 `/work/cp949/pyodide-samples/apps/repl/src/repl/` 아래): `sigint-handler*.test.ts`(기본/JSPI 없음/sleep 조각/프롬프트 유휴 4종), `interrupt-{buffer,connect,protocol,sender,watch}.test.ts`, `stdin-callback.test.ts`, `read-guard.test.ts`, `rpc.test.ts`, `tab-completion.test.ts`·`tab-completion-flow.test.ts`·`tab-reader.test.ts`·`complete-source.test.ts`·`import-gate.test.ts`(코퍼스 53줄), `multiline.test.ts`, `auto-indent*.test.ts`(파서 동등 포함), `terminal-sinks.test.ts`·`sink-writer.test.ts`, `submission-runner.test.ts`, `top-level-await.test.ts`, `webloop-reraise.test.ts`, `block-history`/`history-filter`·`output-tail`·`stdin-reader`·`repl-reader`·`paste-tabs`.
- 보조 도구: `src/test/fake-terminal.ts`(실제 sink 동작을 모사해야 한다는 교훈이 반영된 fake), `src/test/interrupt-presser.ts`(node worker_threads로 눌림 주입), `src/test/setup.ts`.
- 시험 품질 관행: 새 방어선은 **RED를 확인**하고, 구현을 뒤집는 **변이 검사**로 시험이 실제로 잡는지 확인했다(예: RD-021에서 가드 10/10, 전역 스트림 Writer 6/6, 유휴 폐기 6/6, 완성 중 취소 5/5).

### 9.6.2 브라우저 회귀 하니스

- 형태: 저장소 코드가 아닌 **작업 폴더의 Node 스크립트**(`browser-check*.mjs`, `*-probe.mjs`). Playwright `chromium.launch({ headless: true })`로 `http://localhost:4321`에 접속해 `.xterm-rows > div`의 텍스트 행을 읽고(NBSP→공백, 행 끝 공백 제거) 기대 행과 대조한다. `page.on('pageerror')`로 페이지 예외도 센다.
- 실행: 각 작업 폴더의 `run-harness.sh <스크립트 절대경로> <라벨>` — 포트 4321이 비어 있는지 확인하고 dev 서버를 띄운 뒤 `timeout ${HARNESS_TIMEOUT:-420} node <스크립트>`를 돌리고 서버를 죽인다. 결과·스크린샷은 그 폴더의 `results/`에 남는다. `STOP_AFTER=<시나리오 ID>`로 일부만 돌릴 수 있다.
- **회귀 기준선 5종**(모든 후속 RD가 같은 수·같은 실패 ID를 요구): RD-016 58/58, RD-016a 129/129, RD-012b 22/24(실패 E1·E2), RD-012c 20/24(실패 A1·C2·H1·J1), RD-006b 74/74. 여기에 `boot-press` N=30(부팅 중 Ctrl+C)이 붙는다.
- Ctrl+C 계열은 별도 매트릭스가 있다: RD-012d 매트릭스 6~7조합 × N=20(200/200), RD-012a 신규 10~11조합 × N=20(220/220), RD-012f 12조합 × N=20(240/240).
- 시나리오 단발 프로브(RD-021): `bg-input-guard-probe.mjs`, `bg-output-probe.mjs`, `getattr-loop-probe.mjs`, `stale-sigint-probe.mjs` — 각각 "배선을 빼면 실패한다"까지 확인했다.
- 주요 경로: `/work/cp949/pyodide-samples/_works/_completed/20260921-05-rd-021-async-prompt-channel/`(run-harness.sh, 프로브 4종), `.../20260920-04-rd-016-tab-completion/reference/browser-check.mjs`, `.../20260921-01-rd-016a-import-completion/reference/browser-check-import.mjs`, `.../20260919-11-rd-006b-repl-prompt-join/reference/browser-check.mjs`, `.../20260919-05-rd-012b-prompt-cancel/`, `.../20260919-09-rd-012c-input-ctrl-c/`.
- 각 작업 폴더의 `DELTA-NN.md`가 수정 전/후 화면 행 diff와 측정치를 담은 근거 문서다.

### 9.6.3 CPython 3.14 pty 실측 스크립트

- 하니스: `ptyrepl.py` — `python3.14`를 pty로 띄우고 `pyte`로 화면을 렌더링한다(`TERM=xterm`, 인터프리터는 `PY314` 환경변수로 교체 가능, `pyte`/`wcwidth`는 폴더 안 `pylib`에서 읽어 재현성 확보). 키는 바이트로 보낸다(`\x1bOD` 등, 여러 줄은 bracketed paste `\x1b[200~…\x1b[201~`).
- Tab 완성 측정 일습: `/work/cp949/pyodide-samples/_works/_completed/20260921-01-rd-016a-import-completion/reference/measure-3.14/` — `ptyrepl.py`, `runcases_import.py`, `native_complete.py`, `pyodide_complete.mjs`, `compare_native_pyodide.py`(네이티브 대 pyodide 95케이스), `build_gate_corpus.py`·`gate_js.mjs`(게이트 코퍼스 53줄), `pyodide_zip_patch_check.mjs`, `verify_expectations.py`, 요약 `SUMMARY-import.md`.
- 이름·속성 완성 측정: `/work/cp949/pyodide-samples/_works/_completed/20260920-04-rd-016-tab-completion/reference/measure-3.14/`(`s3`~`s13` 시나리오 스크립트, `compare.py`).
- 프롬프트·stdin 측정: `.../20260919-11-rd-006b-repl-prompt-join/reference/pty/probe*.py`, `.../20260919-10-rd-006a-input-line-prompt/reference/pty_input*.py`, `.../20260919-08-rd-011b-stderr-newline/reference/pty_stderr.py`.
- sleep·인터럽트 Node 프로브: `.../20260920-03-rd-012f-time-sleep-slice/reference/probe-*.mjs`.
- 이 측정 폴더들은 `_works/` 아래의 작업 기록이며 저장소 코드가 아니다(일부는 gitignore 대상). 새 저장소에서 재활용하려면 경로를 복사해 쓰되, 기준 인터프리터 버전(3.14.4)과 pyodide 번들 버전(3.14.2)의 차이를 명시해야 한다.
- → 저장소 이식본은 9.6.6.

### 9.6.4 그 밖의 관행

- 각 RD는 착수 전 설계 문서의 해당 절을 읽고, 규칙을 정하기 전에 **3.14 pty로 먼저 재보는**("그릴링") 절차를 거쳤다. 후보 안을 비교해 기각 사유(성능 수치 포함)를 남겼다.
- 함정은 `TRP-0NN` 번호로 따로 기록했다(예: pyodide 시그널 폴링의 비원자성, `println`의 개행 추가, Python 인덱스와 JS 인덱스, 부분 문자열 게이트의 대가).
- 프로덕션 빌드(`vite build`)는 worker의 top-level `await`를 Vite가 기본 `iife`로 번들링하려다 실패한다 — 실행 환경을 로컬 dev로 한정했기 때문에 고치지 않았다. 새 구현에서 배포를 원하면 초기에 포맷을 정해야 한다.

참고: `/work/cp949/pyodide-samples/apps/repl/src/`, `/work/cp949/pyodide-samples/_works/_completed/`

### 9.6.5 이 저장소의 브라우저 하니스(RD-010부터)

공유 라이브러리 `apps/demo/e2e/lib.mjs`(저장소 devDependency, RD-010 DELTA-00에서 RD-009 하니스를 이관)가
`open(url)`을 export한다 — Playwright로 페이지를 열고 화면 행 읽기(`rows`·`tail`·`rowClasses`·`cursorRow`),
타이핑·Enter·대기(`type`·`enter`·`submit`·`waitPrompt`·`waitFor`·`typeWhenReading`·`cancelWhenReading`),
Ctrl+C 계열(`ctrlC`·`holdCtrlC`·`ctrlCBurst`), 확인 기록(`step`·`checks`·`notes`·`finish`)을 돌려준다. 각
RD의 확인 스크립트는 이 파일을 **복사하지 않고 import**하며 `apps/demo/e2e/checks/`에 두고 저장소에
커밋한다(RD-018부터 — 그 전에는 `_works/<작업>/verify/`에 두고 `.gitignore` 대상이었다, 아래 각 RD
문단의 경로는 그 시점 기록이라 고치지 않는다). `ONLY=<이름,…>` 환경변수로 `step` 이름이 그 접두어로
시작하는 것만 골라 돈다.

RD-010의 `session-reset-check.mjs`(`_works/_completed/20260922-11-rd-010-session-reset/verify/`)가 이
구조의 첫 사례다: dev 서버(5173)에 대해 절 9개(`reset`·`cursor`·`ctrll`·`carry`·`ccreset`·`ccafter`·`exit`·`crash`·
`strict`)를 순서대로 돌리고, `pnpm --filter demo build && pnpm --filter demo preview`(4173)에 대해
`reset`·`exit`·`crash` 3절을 재실행한다. 양성 대조는 소스를 변조(`git status --short`가 비어 있는 상태에서
시작해 원복 뒤 다시 비어 있는지 확인)한 뒤 dev 서버가 HMR로 반영하길 기다렸다 재실행하는 방식으로
했다(`verify/positive-controls.md`). 이 스크립트는 그 뒤 `apps/demo/e2e/checks/session-reset-check.mjs`로 옮겨졌고 `ccafter`
절이 더해졌다(아래 문단).

`ccafter`(N=8): 삼키는 루프(`while True: try: while True: pass / except KeyboardInterrupt: pass`) 실행 중 `reset()`한 뒤 새 세션에서
`while True: pass`를 시작하고 곧바로 Ctrl+C를 눌러, 옛 worker가 새 세션의 첫 눌림을 가로채지 않는지 센다(`TRP-049`). 옛 worker가
`terminate()` 뒤 약 2초 사는 창 안에서 눌러야 하므로 리셋 뒤 고정 대기를 넣지 않고, 회차 로그의 클릭→Ctrl+C 시간(관찰값 약 1.0초, 판정 아님)이 창 안인지 본다(부팅 지연으로 창을 넘긴 회차는 유실을 검출하지 못한다). 유실된 눌림은 옛 worker가 ack해 재전송이 없으므로
루프가 스스로 끝나지 않는다 — 판정은 고정 대기 뒤 부재 확인이 아니라 정지 감지용 조건 대기(15000ms) 시간 초과다(9.7). 수정 전(REPL이
buffer를 재사용하던 코드) 유실은 1/8(7/8 통과), 수정 후는 0/8(2회 실행 총 16회)이다. 수정 전 유실률이 낮아 이 절 하나만으로는 수정 효과를
통계적으로 입증하지 못한다. 인과는 단위 시험(`packages/pyodide-repl/test/create-repl/reset.test.ts`, 리셋 뒤 새 프레임의 buffer가 옛 것과 다르고 눌림이
새 buffer에만 쓰인다)과 core 폴백 프로브(수정 전 6/8·수정 후 0/8, `14-runner.md` 14.3.5)가 뒷받침한다.

RD-011의 `multiline-check.mjs`(`_works/_completed/20260923-12-rd-011-multiline-submit/verify/`)는 절 8개
(`paste`·`tab`·`parse`·`stop`·`block`·`shift`·`recall`·`input`, dev 18개 확인)를 순서대로 돌리고,
preview(4173)에 대해 `paste`·`tab`·`parse` 3절을 재실행한다. 이 RD가 `lib.mjs`에 더한 `paste(text)`는 먼저
실제 클립보드 경로(`context().grantPermissions(["clipboard-read","clipboard-write"])` +
`navigator.clipboard.writeText` + `Control+V`)를 시도한다 — headless Chromium에서는 `writeText`는 성공해도
`Control+V`가 화면을 바꾸지 않고(실측), 대체로 시도한 `page.keyboard.insertText()`도 CDP가 삽입 이벤트에서
`\n`을 지워 여러 줄이 한 줄로 뭉개진다. 그래서 `paste()`는 화면이 안 바뀌면 `textarea`에 합성
`ClipboardEvent("paste")`를 직접 dispatch하는 경로로 대체한다 — xterm이 실제로 듣는 이벤트(`clipboardData.
getData("text/plain")` → `coreService.triggerDataEvent`)라 `readPaste` 이후 코드 경로는 실제 붙여넣기와
같다. 변이 4건은 `verify/positive-controls.md`에 기록(소스 변조 → dev HMR 반영 대기 → `ONLY=` 재실행 →
`git checkout --` 원복, RD-010과 같은 방식).

RD-013의 `auto-indent-check.mjs`(`_works/_completed/20260923-14-rd-013-auto-indent/verify/`)는 절 10개
(`prefill`·`backspace`·`unit`·`history`·`shift`·`alt`·`paste`·`cancel`·`input`·`multiline-shift`, dev
26개 확인)를 순서대로 돌리고, preview(4173)에 대해 `prefill`·`shift`·`unit` 3절을 재실행한다. `lib.mjs`에
없는 `cursorCol()`(커서 앞 형제 노드의 `textContent` 길이 합산)을 이 스크립트가 로컬로 더했다 — `rows()`의
끝 공백 제거가 "프리필만 있고 아직 타이핑하지 않은" 상태의 공백을 지워 버려 행 문자열 판정이 못 미친다.
벤더 재그리기가 비동기라(`state.update`/`refresh`의 `term.write` 콜백) `Backspace` 직후 `cursorCol()`을
곧바로 읽으면 낡은 값을 보므로 250~300ms 유예를 넣는다. 양성 대조 2건은 `verify/positive-controls.md`에
기록 — ① `readOptions`의 `prefill` 제거(`prefill`·`unit` 절 실패, `shift`는 `onKey`만으로 계산돼 죽지
않는다), ② `onKey` 제거(`backspace`·`shift`·`alt`·`cancel` 대부분 실패). 둘을 합치면 배선 전체가 커버된다.

RD-015의 `tab-check.mjs`(`_works/_completed/20260923-16-rd-015-tab-completion/verify/`)는 이전 RD-016
브라우저 58개(C1~C12)를 절 단위로 이식하고 C13(큐)·C14(완성 중 Ctrl+C)를 더해 총 68개 확인(RD-016이 C15 8개를 더해 76개)을 순서대로
돌리고, preview(4173)에 대해 C1·C3·C8·C11 4절(30개)을 재실행한다. C12(지연 측정)는 페이지 내부
keydown 리스너 + `MutationObserver`(같은 `performance.now()` 시계, TRP-022)로 `a.` 속성 후보(두 번째 Tab이
목록을 화면에 반영한 시각, N=20)와 빈 스템 공백 삽입(첫 Tab이 동기 삽입한 시각, N=20)을 웜(세션 첫 Tab
제외)으로 잰다 — 필수 판정은 정지 0 + 최대 200ms 이내(RD-009 시나리오와 같은 판정선), 30ms는 참고치로만
기록한다(실측: `a.` 중앙값 25.8ms·최대 33.5ms, 빈 스템 중앙값 10.9ms·최대 17.0ms). `import os.pa`(지연
측정 3종째)는 RD-016이 C12에 기록 전용으로 더했다(아래). 양성 대조 3건은 `verify/positive-controls.md`에 RD-010과 같은
방식으로 기록한다 — 큐(`queuedTabs.push`) 제거는 브라우저 C13 실패로 확인했지만, `readEnded` 배선 제거·
`interruptCompletion` 무력화는 계획한 브라우저 시나리오(C8·C14) 대신 `create-repl/tab-completion.test.ts`의 세션 조립 수준
단위 시험("프롬프트 취소 중 완성 요청이 있으면 SIGINT를 1회 보낸다")으로 확인했다 — C8은 Playwright의
연속 `press`가 항상 완성 왕복(~25ms)보다 빨라 "완성이 다음 줄에 끼어드는" 경합이 재현되지 않고, C14는
`exec()`/`eval()` 아티팩트(아래)로 정상 코드에서도 한때 실패해 변이 구분력이 없었기 때문이다(`DELTA-05.md`
"## 결정"). C14는 재현 클래스를 `exec()`가 아니라 REPL 프롬프트에 직접 멀티라인으로 타이핑해 정의해야
`co_filename == "<console>"` 규칙이 매치돼 정상 복귀한다(`10-parity-deviations.md`에 좁은 경계 사례로 등록).

RD-016은 같은 `tab-check.mjs`(현재 위치 `apps/demo/e2e/checks/`)에 C15 절 6종 8개 확인(C15a `import os.pa`→`os.path`, C15b `import collections.a`→`abc`
(브라우저 번들 zip 보정), C15c `import xml.dom.m`→`mini`, C15d `import ` Tab 두 번 모듈 목록(개수 단정 없음, TRAP-27), C15e `if True:` 블록 안 `pending` 경로,
C15f `import os; os.pa` 속성 폴백)을 더했다. 모듈 목록은 178개라 한 화면(24행)을 넘어 `os`·`sys`가 뷰포트 밖에 있으므로 C15d는 `Shift+PageUp` 스크롤백으로
단어 집합을 모은다. C9c는 `from os import pa` → `from os import path` 채우기 셀로 재정의했고(예전 셀은 Tab 직후 `!`가 완성 왕복보다 먼저 도착해 통과한 것으로 판단하며
채우기 동작을 확인하지 못했다), C5e(`important = ` 8연타)는 게이트 참 빈 스템이 worker 왕복을 만들어 큐로 32칸이 되는 셀로 제목을 정정했고 연타 뒤 입력 전 커서 열
`waitFor`를 더했다(왕복 중 도착한 문자가 남은 큐 Tab의 스템이 된다, 7.1 큐 규칙). C12에는 `import os.pa` 지연(웜 N=20)을 기록 전용으로 더했다(판정 step 없음,
RD-016 실측 중앙값 26.2ms·최대 33.4ms, 같은 실행 `a.` 중앙값 28.7ms·최대 34.0ms). 이로써 지연 측정 3종이 모두 코드에 있다. 확인은 L1
`ONLY=C5,C9,C12,C15` 20/20·`pageerror` 0이고 전체 76개(C1~C15) 재실행은 하지 않았다(L2 미실행). 양성 대조 1건: 게이트를 상시 거짓으로 변조 → C15d 실패.

RD-024는 새 브라우저 스크립트 2종을 `apps/demo/e2e/checks/`에 두고 `run.mjs` `SETS`(dev 전용)·`package.json`(`e2e:react-strictmode`·`e2e:react-fit`)·`BASELINE.md` 행에 배선했다. 둘 다 dev 서버(5173, `<StrictMode>`)에 대해 화면 두 개(REPL `/`·실행창 `?view=runner`)를 각각 새 브라우저로 열고 결과 파일을 화면별(`-repl-dev`·`-runner-dev`)로 나눠 쓴다. `react-strictmode-check.mjs`(10셀)는 StrictMode 이중 마운트의 worker 수를 페이지 안 `Worker` 계측(`new`·`terminate` 호출)과 Playwright `worker`·`close` 이벤트 두 근거로 판정하고(생성 직후 terminate된 첫 worker는 Playwright 이벤트에 보이지 않는다, `docs/traps/TRP-061`), `.xterm` 1개·콘솔 warning(`DisposableStore` 포함) 0을 본다(경고 0 확인일 뿐 정리 순서 회귀는 검출하지 못한다. 순서 방어는 L0 몫, `docs/traps/TRP-064`). `react-fit-check.mjs`(12셀)는 `?fit=1`에서 창 크기를 바꿔 `cols`가 바뀌는지와 그 뒤 입력(REPL 유휴 `print(1+1)`, 실행창 `input()` 대기)을 본다. `cols`는 데모가 `Terminal`을 노출하지 않아 DOM 기하(`.xterm-screen` 너비 ÷ 셀 너비)와 `x` 400자 출력의 줄바꿈 폭 두 값이 같아야 통과한다. 두 스크립트의 판정 함수는 순수 함수 `apps/demo/e2e/react-judge.mjs`로 분리해 `react-judge.test.mjs`(vitest, 데모 `pnpm test`)가 가짜 입력으로 양성 대조한다(28개). 판정은 모두 폴링이고 고정 대기·절대 ms 상한이 없다(9.7). 브라우저 양성 대조 1건: `useCoreHandle` cleanup의 `handle.dispose()`를 지우면 `ONLY=REPL-S01`이 `살아 있는 worker 2개 (… new 2회·terminate 0회, 기대 1개)`로 실패한다. 규칙은 `15-react.md` 15.6, 15.10.

RD-023은 새 브라우저 스크립트 `apps/demo/e2e/checks/dom-bridge-check.mjs`(`e2e:dom-bridge`)를 `run.mjs` `SETS`(dev 전용)·`package.json`·`BASELINE.md` 행·`e2e/README.md` 명령 표에 배선했다. 화면 `?view=dom-bridge`를 쿼리로 나눠(기본·`mode=slow`·`native=0`·`native=0&gate=off`·`mode=late`·`mode=late-run`·`runner=core`) 7페이지 24셀을 돈다: 초기(격리·`native` true), S1~S4·S7(초기화·`ready`, `document.title`·canvas 픽셀·guarded `window`, `input()`·취소 2종·재입력, `while True`·`time.sleep` Ctrl+C, 전역 패치 뒤 core 채널), S5(동기 호출 도중 `interrupt()`는 호출 반환 뒤 결말·다음 줄 `interrupted`, `stop()` → `restarted`), S6(출력·DOM 도착 순서), N0a·N0b(`?native=0`), LATE(dom-bridge 늦은 import → `load-failed`), RUNLATE(늦은 `runWorker` → `ready`). 판정 함수는 순수 함수 `apps/demo/e2e/dom-bridge-judge.mjs`로 분리해 `dom-bridge-judge.test.mjs`(vitest, 데모 `pnpm test`)가 가짜 입력으로 양성 대조한다. 시간 판정은 이벤트 열의 앞뒤·결말이고 ms 상한이 없다(9.7): S5의 중단 요청이 `slowStart`와 `slowDone` 사이여야 하고(호출이 끝난 뒤에 눌렀다면 시험 불성립으로 실패), 옛 worker의 소멸은 조건 대기다. S6은 경로(core `createRunner` 직접·`<PythonRunner>`+terminal)·방식(C·Ag·Ar)별 역전 수를 **판정 없이 기록**하고 필수는 기록 누락 0·모든 실행 `ok`다(출력과 DOM 호출은 다른 채널이라 도착 순서를 보장하지 않는다, `16-dom-bridge.md` 16.9). `?native=0`은 main·worker 양쪽 realm에서 growable `SharedArrayBuffer` 생성만 던지게 하고(`TRP-066`) 판정에 양쪽 `native === false` 근거(main `native`·`isDomBridgeSupported()`, worker의 `prepare` 명시 문구)를 넣는다. 코드를 `textarea`에 넣고 `run` 버튼으로 실행해 xterm 화면 행·`result`·페이지의 이벤트 열(`window.__domBridge.events`, 순서 기록)로 판정한다. 픽셀은 `getImageData` 한 번으로 읽는다(여러 번 읽으면 Chromium `willReadFrequently` 콘솔 warning이 남아 "콘솔 경고 0" 판정을 깬다). 양성 대조(브라우저 1건): `prepare`의 부트스트랩 검사를 제거하면 `ONLY=LATE`가 실패한다(`load-failed`가 오지 않고 `loading`에 머문다). 결과(2026-09-25): 전체 재실행 22셀 통과, S6 2셀은 새 기준으로 저장된 결과를 재판정해 통과(24/24, 새 기준 S6의 브라우저 재실행 없음), `BASELINE.md`에 기록. 소스를 변조·원복한 뒤에는 dev 서버를 재시작한다(`TRP-007`). worker 파일은 `src/*.worker.ts`로 이름 짓는다(`vite.config.ts`의 `optimizeDeps.entries`가 이 패턴으로 worker의 bare import를 서버 시작 때 미리 최적화한다, `16-dom-bridge.md` 16.3).

**RD-044(2026-09-27)는 `apps/demo/e2e/checks/*.mjs` 23개가 각자 되풀이하던 진입 규약(URL 인자·label·ONLY
재해석·dev/preview 반복·종료 코드)을 라이브러리 `apps/demo/e2e/check-runner.mjs` 한 곳으로 모았다.** 이후
스크립트가 진입 부분에서 이 규칙을 다시 풀어 쓰지 않고 아래 함수를 import한다(다른 문서·스크립트 머리
주석이 ONLY 판정을 다시 서술하려면 이 절을 링크로 가리킨다 — "문서 갱신: 규칙은 한 곳에",
`docs/agents/rubber-workflow.md`).

- **URL·label(K1·K2)**: `checkEntry({ modes? })`가 `process.argv`를 읽어 `{ mode, url, previewUrl, rest }`를
  돌려준다(mode 스크립트는 `previewUrl`이 항상 `undefined`다 — mode와 dev+preview는 같은 스크립트에서
  공존하지 않는다). `serverLabel(url, mode?)`가 결과 파일 label을 만든다(`:4173` 포함 → `preview`, 아니면
  `dev`, mode가 있으면 `<mode>-<dev|preview>`).
- **절 ONLY, `sectionEnabled`(K3, 정확 일치)**: `ONLY=<이름,…>` 토큰과 절 이름이 정확히 같을 때만 켠다.
  `lib.mjs`의 `step` 접두어 규칙("초기"로 시작하는 이름은 항상 실행)과는 다른 층이다 — `step`은 화면
  확인 단위, `sectionEnabled`는 스크립트 안의 더 큰 절(예: tab-check의 `C1`~`C11`) 단위다.
- **페이지 ONLY, `pageSelected`(K4, 양방향 접두어)**: 토큰과 페이지 접두어 중 하나가 다른 하나의
  접두어면 켠다(`ONLY=S5`가 `S5`·`S6` 둘 다 선언한 페이지를 켜고, `ONLY=LATE`는 `RUNLATE`를 켜지 않는다).
  여러 화면을 여는 스크립트(`dom-bridge-check`·`react-strictmode-check`·`react-fit-check`)와, 절 하나가
  돌았는지 검사하는 스크립트(`tla-check`의 `sticky`·`session-reset-check`의 `crash`)가 함께 쓴다.
- **dev+preview 반복, `runDevPreview`(K5)**: dev를 실행하고 previewUrl이 있으면 이어서 preview를
  실행한다. preview 동안만 `process.env.ONLY`를 K6이 계산한 값으로 바꾸고 끝나면 원래 값(없었으면
  삭제)으로 되돌린다(try/finally). 결과 = 두 실행 모두 통과. `run(url, phase)`의 phase(`"dev"`|`"preview"`)로
  dev·preview 본문이 다른 스크립트(`session-reset-check`·`multiline-check`)가 분기한다. 옛 `tla-check.mjs`는
  이 원복이 없었다(preview가 마지막 실행이라 증상은 없었다) — 라이브러리로 이관하며 규칙이 하나가 됐다.
- **preview ONLY 교집합, `previewOnlyTokens`(K6)**: 선언한 preview 절 목록 P가 없으면 사용자 ONLY 그대로
  (preview에도 그대로 적용, 예: `session-reset-check`·`multiline-check`). P가 있고 사용자 ONLY가 없으면 P
  전체. 둘 다 있으면 `초기`(P에 있을 때, 정확히 이 이름) + (사용자 토큰 ∩ P, 정확 일치) — 교집합이 "초기"뿐이면
  preview 단계를 건너뛰고 dev 결과만 쓴다(2026-09-27 사용자 확정).
- **종료(K7)**: `exitWith(ok)`가 통과 시 exit 0, 실패 시 exit 1. `apps/demo/e2e/positive-controls/*.py`가
  읽는 stdout `PASS  `/`FAIL  ` 6글자 접두 형식은 이 이관으로 바뀌지 않았다.
- **배너 삭제**: 이관 전에는 7개 스크립트가 각자 `=== dev: … ===` 류 배너를 찍었다. `runDevPreview`는
  preview를 건너뛸 때 안내 한 줄만 찍고, 그 밖에는 배너를 찍지 않는다(단순화, "문구 통일"이 아니다).
  positive-controls 파서는 `PASS`/`FAIL` 줄만 읽어 영향이 없다.
- **등록 대조, `registry.test.mjs`(vitest, `pnpm --filter demo test`)**: `apps/demo/package.json`의
  `e2e:*` 스크립트·`apps/demo/e2e/sets.mjs`의 `SETS`·`README.md` 명령 표·`BASELINE.md` 2절 표, 이 4곳이
  `checks/` 디렉터리의 실제 파일 집합(현재 23개)과 같은지 L0에서 대조한다(네 곳 모두 등록을 빠뜨린 새 스크립트도 잡는다)(전례: SETS 누락으로 L2에서만 드러난 회귀,
  `.scratch/repl-run-source-followups/issues/11`). `measure/*.mjs`·`cpu-throttle-probe`(기록용)는 이
  대조 범위 밖이다. `run.mjs`는 파일 끝에서 `process.argv[2]`로 subcommand를 실행하는 CLI라 그대로
  import하면 시험이 CLI를 실행시켜버려, `SETS`·`MEASURE_SET`·서버 URL 상수를 `sets.mjs`로 분리했다
  (`run.mjs`는 그 파일을 import만 한다).

규칙 정의·단위 시험은 `apps/demo/e2e/check-runner.mjs`·`check-runner.test.mjs`(K1~K7 태그)·
`registry.test.mjs`에 있다. 이관 범위·검증 근거는
`_works/_completed/20260927-58-rd-044-e2e-check-runner/checklist.md`(DELTA-01~05).

### 9.6.6 이 저장소의 pty 캡처 도구(RD-025)

Tab 완성 기준 데이터를 만든 도구를 `apps/demo/e2e/pty/tools/`로 옮겼다. 사용법·전제·설치는 [`apps/demo/e2e/pty/README.md`](../../apps/demo/e2e/pty/README.md), 파일별 생성 명령·소요 시간·허용 차이는 `apps/demo/e2e/pty/REGEN.md`, 도구별 입출력·인자는 `apps/demo/e2e/pty/tools/README.md`에 있다(여기에는 요약만 둔다).

- **이식한 것**: 하니스(`ptyrepl.py`·`common.py`·`hook_startup.py`·`mc_probe.py`), rd-016 파이프라인(`runcases_import.py`·`make_lines_B/C.py`·`native_complete.py`·`pyodide_complete.mjs`·`gate_js.mjs`·`compare_native_pyodide.py`·`build_gate_corpus.py`·보조 3종), rd-015 실행기 `runcases.py`, 비교기 `compare_baseline.py`, 공용 `resolve_pyodide.mjs`, `requirements.txt`.
- **인터프리터**: `--python` > 환경변수 `PTY_PYTHON` > `PATH`의 `python3.14`(홈 절대경로 기본값 없음). 대상 `sys.version_info[:3]`이 `3.14.4`가 아니면 `--allow-version-mismatch` 없이는 중단한다. 대상이 venv이거나 `pyte`·`wcwidth`가 import되면 중단한다(자식 REPL의 후보 집합이 바뀐다, TRAP-27).
- **의존성**: `pyte==0.8.2`(LGPLv3)·`wcwidth==0.8.4`(MIT)는 벤더링하지 않고 `requirements.txt`로 핀한다. 하니스를 돌리는 venv에만 설치한다.
- **판정**: `compare_baseline.py`가 재생성물과 기준 데이터를 정규화 비교한다(종료 코드 0 판정값 차이 0, 1 차이 있음, 2 실행 오류). 2026-09-26 실측: rd-016 6파일 판정값 차이 0, rd-015 7파일 중 6파일 바이트 동일이고 `res_s1.json`은 측정 당시 하니스 폴더의 `.py` 파일명 14개를 기준 후보에서 제외한 뒤 판정값 차이 0(사용자 확정, 근거는 `REGEN.md`).
- **읽기 전용**: `apps/demo/e2e/pty/rd-015|016/**` 데이터는 도구가 덮어쓰지 않는다. 재생성물은 트리 밖에 쓴다.
- **재측정**: 새 CPython(3.15 등)으로 다시 재는 절차는 `13-version-upgrade.md` 13.4와 `REGEN.md` "3.15 재측정 시 실행 순서"다. 재측정 여부는 사용자가 정한다(ADR-0007).
- **이식하지 않은 것**(이전 구현 작업 폴더 `/work/cp949/pyodide-samples/_works/_completed/20260920-04-rd-016-tab-completion/reference/measure-3.14/`에 있다): 이름·속성 완성 탐색 스크립트 `s*.py` 16개(`s1`~`s13`, `s3b`·`s3c`·`s8b`·`s9b` 포함. 화면 출력만 내고 저장소 기준 데이터를 만들지 않는다. `s7.py`만 별도 `s7_result.json`을 쓴다), 이전 구현 대조기 `compare.py`·`node_complete.mjs`·`node_edge.mjs`와 그 입력 `cases_extra.json`(저장소 기준 데이터를 만들지 않는다), pyodide 소스 읽기용 사본 `pyodide__base.py`·`pyodide_console.py`·`pyodide_rlcompleter.py`(다른 스크립트가 import하지 않는다). `pylib/`(`pyte`·`wcwidth` 사본)은 rd-016a 측정 폴더(9.6.3)에 있고 LGPLv3라 복사하지 않았다. `rd-008/pty_cancel.py`·`rd-019/pty_type_ahead.py`는 이미 저장소에 있는 자립형이라 그대로 두었다(인터프리터는 `PY314` 환경변수, 결과는 사람 판정).

## 9.7 시간을 쓰는 판정 (2026-09-24 사용자 확정)

장비 성능이 달라도 판정 결과가 같아야 한다. 시간 값은 아래 규칙 안에서만 판정에 쓴다. 새로 쓰거나 고치는
e2e 스크립트와 L0 단위 시험(vitest)에 적용한다. 기존 고정 대기(2026-09-26 기준 `checks/`·`measure/`에 154곳: `waitForTimeout(`·`sleep(` 122줄 + `settled(` 32줄)는 그 스크립트를 고칠 때
바꾸고 일괄 수정하지 않는다(`.scratch/e2e-time-dependence/issues/01-absence-checks-after-fixed-wait.md`, 집계 규칙·분류표 포함). 이전 "145곳"은 Python 코드 문자열 안 `sleep()`까지 센 오계수다.

| 형태                                               | 규칙                                                                                                                                                                                                             | 느린 장비에서 생기는 일                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 하한("N ms보다 빨리 나오면 실패")                  | 허용 — 단 시작점이 장비 속도에 영향받지 않을 때만. 시작점이 사용자 입력·실행 시작 같은 고정 사건이 아니라 "앞 단계가 끝난 시점"이면 느린 장비에서 구간이 짧아져 하한이 깨진다(`stdin-input-check.mjs` TICK 사례) | 시작점이 고정 사건이면 없음 — 느려져도 더 빨라지지 않는다. 시작점이 앞 단계 종료 시점이면 **결함 없이 실패** |
| 절대 ms 상한("N ms 안에 끝나야 한다")              | 금지. 예외는 아래 2                                                                                                                                                                                              | 결함 없이 실패                                                                                               |
| 고정 대기 뒤 부재 확인("N ms 기다렸는데 X가 없다") | 금지. 마커 배리어(아래 3)                                                                                                                                                                                        | 결함이 있어도 **통과**(검출력 상실, 로그에 안 남는다)                                                        |
| 고정 대기 뒤 존재 확인("N ms 뒤 X가 있다")         | 금지. 조건 대기(아래 4)                                                                                                                                                                                          | 결함 없이 실패(간헐 실패)                                                                                    |
| 성능 수치(중앙값·최대·p95)                         | 판정이 아니라 기록(아래 6)                                                                                                                                                                                       | —                                                                                                            |

하한 사례(`stdin-input-check.mjs` TICK, `call_later(2)` 뒤 출력): 시작점을 프롬프트 복귀 뒤로 잡으면 구간이 실제 타이머(2000ms)보다 짧게 나온다(수정 전 시작점의 감속 4 실측 1963ms. 당시 하한은 1000ms라 통과했지만 하한을 타이머 값 2000ms로 올리면 이 시작점에서는 깨진다). 지금은 Enter `keydown` 페이지 시각을 시작점으로 하고 하한을 타이머 자체인 2000ms로 둔다. 하한 여유가 Enter → 타이머 등록 지연(13~18ms)뿐이라 하한을 더 올리지 않는다.

1. **판정은 이벤트·상태로 한다.** `data-testid=status` 전이, 새 프롬프트 출현, 결과 문자열, `pageerror` 수.
2. **상한 예외**: 요구 사항 자체가 응답성 수치일 때만(예: 실행 중 Ctrl+C → `KeyboardInterrupt`). 근거 RD·설계
   절을 판정 옆 주석에 적는다. 시간은 페이지 안 `performance.now()` 한 시계로 재고(9.5 12, TRP-022), 같은 실행에서
   잰 기준 동작(예: `1+1` 왕복) 중앙값의 배수로 판정하거나 배율 환경변수(기본 1)를 곱한다.
   배율 환경변수는 `E2E_TIME_SCALE`(기본 1)로 실재한다: `lib.mjs`가 읽어 핸들의 `timeScale`로 노출하고 결과 JSON `notes`에 값을 기록한다(e2e 전용, L0 vitest 상수에는 적용하지 않는다).
   상한은 **결함 시 값과 정상 값 사이**를 가르되 정상 쪽에 동시 실행 부하 여유를 둔다 — L0의 SIGINT 계열은 1초다
   (`PRESS_LIMIT_MS`·`WATCH_LIMIT_MS`·`run-driver-pyodide.test.ts`). 같은 장비에서도 눌림 뒤 `KeyboardInterrupt`까지가
   파일 단독 42.8~56.9ms·패키지 전체 병렬 63.5~92.1ms·루트 전체 실행 133.2ms로 3배 넘게 벌어지므로
   (`.scratch/sigint-test-isolation/issues/04-sleep-slice-2pow31-timing-flake.md` 실측) 단독 실측의 2배 같은 좁은 상한은
   거짓 실패를 낸다. 조각·타이머가 멈추면 값이 초 단위(5초·10초·무한)로 뛰므로 1초로도 회귀는 잡힌다(같은 이슈의 변이 검사).
3. **마커 배리어**: 대상 동작 뒤 결과가 정해진 입력(예: `print('MARK')`)을 보내고, 마커 **출력 행**이 보일 때까지
   `waitFor`로 기다린 뒤 부재를 판정한다. 입력이 순서대로 처리되면 마커 도착 = 앞선 처리 완료다.
   - 마커는 대상과 같은 경로를 지나야 한다(예: Tab 완성이 worker 왕복이면 마커도 worker 왕복).
   - 입력 행도 마커 문자열을 포함한다 — 출력 행만 센다(TRP-011).
   - 마커가 history·`_`·세션 상태를 바꿔 뒤 단계 기대값에 영향이 없는지 확인한다.
4. **조건 대기**: `lib.mjs`의 `waitFor(check, description, timeoutMs)`를 쓴다. `timeoutMs`는 정지 감지용으로 넉넉히
   둔다(판정선이 아니다).
5. **고정 대기가 허용되는 경우**: 입력 간격 자체가 측정 대상일 때(연타 간격, Enter 뒤 지연 스윕), 폴링 루프의
   간격, 판정과 무관한 정리 단계. `settled()`(화면이 `quietMs` 동안 안 바뀌면 끝)는 부재 확인 부류다 — 제품 쪽
   완료 신호가 있으면 그것으로 바꾼다.
6. **성능 수치는 기록이다.** 결과 JSON에 N과 함께 남기고, 비교는 같은 장비의 이전 값과만 한다.
   `apps/demo/e2e/BASELINE.md` 4절의 ms 값은 참고값이다. 참고값을 벗어난 것은 회귀 판정이 아니라 `deferred` 이슈
   대상이다(`docs/agents/issue-tracker.md` "등록·분류 기준").

## 9.8 패키지 경계 검사(RD-020)

"core·repl·terminal·react는 coincident에 의존하지 않는다"([ADR-0006](../adr/0006-pyodide-core-and-plugin-packages.md))와 "core는 터미널 라이브러리를 모른다"를 시험·스크립트로 강제한다. coincident에 의존하는 패키지는 `pyodide-dom-bridge` 하나이고 이 예외는 아래 각 검사의 별도 경로로만 둔다(다른 패키지의 금지 보장은 그대로다). 검사 대상이 서로 달라 세 가지로 나눴고, 하나가 다른 것을 대신하지 않는다.

| 검사               | 대상                                          | 실행                                            | 위치                                                                                                                 |
| ------------------ | --------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 의존 트리 시험     | 설치된 `node_modules`의 의존 트리             | `pnpm test`(vitest)                             | core·dom-bridge·terminal·repl·react `test/package-boundary.test.ts`, 도우미 `@repo/pyodide-testkit/package-boundary` |
| `dist` 문자열 검사 | 빌드 산출물 파일 내용                         | `pnpm check-dist`, 루트 `pnpm test`가 함께 실행 | `scripts/check-dist.mjs`, 패키지 `check-dist` 스크립트                                                               |
| tarball 스모크     | `pnpm pack` tarball을 저장소 밖에 설치한 결과 | `pnpm smoke:pack`(L0 수동)                      | `scripts/pack-smoke.mjs`·`scripts/pack-smoke/`, 판정 함수 시험 testkit `pack-smoke-script.test.ts`(`pnpm test`)      |

### 9.8.1 의존 트리 시험

- 도우미 `packages/pyodide-testkit/src/package-boundary.ts`: `collectInstalledDependencyNames(packageDir)`가 `package.json`에서 시작해 `dependencies`·`peerDependencies`·`optionalDependencies`를 설치된 `node_modules`(심볼릭 링크는 실제 경로)로 끝까지 따라가 이름 집합을 낸다. 작업공간 내부 패키지와 외부 패키지의 전이 의존을 모두 포함한다. `devDependencies`는 소비자에게 가지 않으므로 따라가지 않는다. `findForbiddenDependencies(names)`가 `FORBIDDEN_RUNTIME_DEPENDENCIES`(`coincident`·`reflected-ffi`)와 겹치는 이름을 낸다.
- `dependencies` 항목을 해석하지 못하면 던진다(부분 트리로 통과해 금지 이름이 가려지는 것을 막는다). 설치되지 않을 수 있는 peer·optional은 `unresolved`에 적고 넘어간다. 그러므로 `pnpm install` 없이 시험을 돌리면 `의존 …을(를) 해석하지 못했다`로 실패한다.
- core 시험: 트리에 금지 이름이 없고, `@cp949/runo-xterm-readline`이 없다. terminal 시험(RD-022): 금지 이름이 없고, 트리에 `@cp949/runo-pyodide-core`·`@cp949/runo-xterm-readline`·`string-width`·`@xterm/xterm`이 있으며, `@cp949/runo-pyodide-repl`이 없다(repl → terminal 단방향). repl 시험: 금지 이름이 없고, 트리에 `@cp949/runo-pyodide-core`·`@cp949/runo-xterm-readline`·`string-width`·`@xterm/xterm`이 있다(아무것도 따라가지 못해 빈 집합으로 항상 통과하는 것을 막는 대조). react 시험(RD-024): 금지 이름이 없고, 트리에 `@cp949/runo-pyodide-core`·`-terminal`·`-repl`·`@cp949/runo-xterm-readline`·`string-width`·`@xterm/addon-fit`·`@xterm/xterm`·`react`·`react-dom`이 있다. 변이로 확인했다: react `dependencies`에 `coincident`를 넣으면 이 시험이 실패한다. dom-bridge 시험(RD-023, 이 패키지만 coincident를 가진다): `dependencies`에 coincident `4.1.1`·reflected-ffi `0.7.2`가 정확한 버전이고, core는 `dependencies`가 아니라 `peerDependencies`(+`devDependencies`)이며, `pyodide`를 직접 선언하지 않고(core의 optional peer로 트리에는 잡힌다), `sideEffects`가 정해진 배열(글로브 포함)이고, 자기 `publishConfig.exports`가 `exports`와 키가 같다. 트리에는 소비자에게 가면 안 되는 이름(repl·terminal·xterm 등)이 없다. 다른 5개 패키지 트리에 dom-bridge·coincident가 없다는 단정도 이 시험이 한다(core·terminal·repl·react 시험은 손대지 않았다). 커밋 `035a95d`부터 같은 파일이 두 가지를 더 본다: 배포 패키지 6종(core·terminal·repl·react·xterm-readline·dom-bridge) 모두 `publishConfig.exports`가 `exports`와 키가 같고 어느 깊이에도 `development` 조건이 없다, 다른 5개 패키지의 `scripts`에 `--allow-sync-bridge`가 없고 `check-dist` 스크립트가 있다.
- 도우미 자체는 testkit `package-boundary.test.ts`가 가짜 해석기·임시 `node_modules`로 시험한다. 이 도우미는 `node:fs`를 쓰므로 시험 파일 상단에 `// @vitest-environment node`를 둔다.

### 9.8.2 `dist` 문자열 검사

- `node scripts/check-dist.mjs <dist 폴더>...`: 폴더 아래 모든 파일(`.map` 포함)에 `coincident`·`reflected-ffi`가 없는지 본다(대소문자 무시). `.mjs`에는 `pyodide` 런타임 import(`from "pyodide`·`from "pyodide/…`·`import("pyodide`·`import "pyodide`)가 없는지도 본다(RD-021, ADR-0007: worker는 CDN에서 불러오고 core는 `pyodide/package.json`의 `version` 문자열만 인라인한다). Python 코드 문자열(`from pyodide.ffi import`)·`pyodide-lock` 같은 다른 이름·`.d.mts`의 타입 import는 걸리지 않는다. 폴더가 없거나, 파일이 하나도 없거나, 인자가 없으면 통과하지 않고 실패한다(빌드 전에 돌린 것을 통과로 착각하지 않게). 실패는 `check-dist 실패: …`를 표준 오류에 내고 종료 코드 1이다.
- xterm-readline·core·terminal·repl·react의 `package.json`에 `"check-dist": "node ../../scripts/check-dist.mjs dist"`가 있다.
- dom-bridge의 `package.json`만 `"check-dist": "node ../../scripts/check-dist.mjs --allow-sync-bridge dist"`다(RD-023). `--allow-sync-bridge`가 있을 때만 coincident 문자열 금지를 끄고 CSP 정적 규칙을 건다: 코드 파일의 coincident 모듈 지정자는 `coincident/window/main`·`coincident/window/worker` 또는 포크 패키지 `@cp949/runo-coincident/window/main`·`@cp949/runo-coincident/window/worker`(2026-09-28, coincident 4.1.1 대체, ADR-0008 작업 중 `check-dist.mjs`가 놓치던 것을 수정)뿐(직접 `reflected-ffi` import 금지), 주석을 뺀 코드에 `evaluate`·`serviceWorker`·`coincident/sync`·`window.import`·`.import(`가 없어야 하고, `coincident/window/worker`를 import하는 `.mjs`는 그보다 앞서 `bootstrap-observer-install`을 import해야 한다(`16-dom-bridge.md` 16.5·16.12). `pyodide` 런타임 import 금지는 이 옵션에서도 유지한다. 다른 패키지는 옵션 없이 검사하므로 금지 보장이 그대로다. 소스에는 `packages/pyodide-dom-bridge/test/csp-static.test.ts`가 같은 검사기를 자식 프로세스로 돌린다. 옵션이 없는 dist에 coincident 지정자가 있으면 실패하는 시험도 testkit `check-dist-script.test.ts`에 있다.
- turbo 태스크 `check-dist`는 `dependsOn: ["build"]`, `cache: false`다. 루트 `pnpm test`는 `turbo run test check-dist`이고 `pnpm check-dist`로 단독 실행할 수 있다. `check-dist`는 vitest가 아니라 turbo 태스크라 시험 수에 잡히지 않는다.
- 시험 안이 아니라 별도 태스크인 이유: turbo `test`는 `^build`(의존 패키지의 빌드)에만 의존하고 자기 패키지의 `build`에는 의존하지 않는다. 시험이 자기 `dist`를 읽으면 빌드 전에는 실패하고 빌드 뒤에는 낡은 산출물을 볼 수 있다. `test`가 `build`에 의존하게 바꾸면 demo(vite)까지 매번 빌드된다. `cache: false`는 `dist`가 `.gitignore` 대상이라 turbo 입력 해시에 들지 않아, 캐시가 켜져 있으면 변조가 가려지기 때문이다.
- 스크립트 자체는 testkit `check-dist-script.test.ts`(자식 프로세스로 실행, 9건)가 시험한다. 실패 케이스는 종료 코드 1만 단언하면 스크립트가 없어도(`MODULE_NOT_FOUND`) 통과하므로 표식 `check-dist 실패`를 함께 단언한다.
- 변이 검사 주의(dist 덧붙임): tsdown이 만든 `dist/*.mjs`는 마지막 줄이 `//# sourceMappingURL=…`이고 개행 없이 끝난다. `echo '…' >> dist/worker.mjs`로 덧붙이면 그 주석 줄에 흡수돼 주석 제거 뒤 판정에서 빠지고 "검사가 못 잡는다"로 잘못 보인다. 덧붙일 때 앞에 개행을 넣는다(`printf '\nimport "coincident/sync";\n' >> …`). 이 경우 `허용 밖 모듈 지정자`·`금지 표현` 2건으로 실패한다.

### 9.8.3 tarball 스모크(`pnpm smoke:pack`)

- `pnpm build && node scripts/pack-smoke.mjs`. 기본 파이프라인(`pnpm test`·turbo)에는 넣지 않는다. L0 범위의 수동 검사이고 레지스트리 접근(네트워크)이 필요하다(`@xterm/xterm`·`string-width`·`typescript`·`pyodide`·`@types/*` 설치, `--prefer-offline`이라 pnpm 저장소에 있으면 다시 받지 않는다). `dist`가 없으면 스크립트가 실패한다.
- 돌리는 때: 진입점 export 이름·`exports`·`publishConfig.exports`·배포 의존 선언을 바꾸는 변경은 공통 완료 조건에 더해 `pnpm smoke:pack`을 돌린다. 수동 L0라 RD-027이 `terminal/internal` export를 지운 뒤 RD-039 착수까지 실패 상태로 남았다.
- 구성(RD-039): 진입 파일 `scripts/pack-smoke.mjs`는 pack 대상·진입점별 기대 export 표 `ENTRY_EXPORTS`·소비자 선언 두 개·설치 트리 검사만 둔다. `scripts/pack-smoke/manifest.mjs`는 부수효과 없는 판정(매니페스트 공통 규칙, 패키지별 정책 표 `MANIFEST_POLICY`, 진입점 도출 `entrySpecifiers`, 선언 대조 `compareEntryDeclarations`)이고 testkit `pack-smoke-script.test.ts`가 L0로 고정한다(정책 표 키가 pack 대상 이름인지 포함). `scripts/pack-smoke/consumer.mjs`의 `smokeConsumer`가 소비자 하나를 작성·설치·import·`tsc`·Vite 해석한다. 새 소비자는 선언 하나를 더한다.
- 절차:
  1. xterm-readline·core·terminal·repl·react·dom-bridge 6개를 `pnpm pack`하고 각 tarball `package.json`의 `exports`를 재귀로 훑어 모든 대상 경로가 tarball 파일 목록에 있는지 본다(정적 검사, 조건 이름과 무관, `./package.json` 포함, RD-023 DELTA-01). 이어서 tarball 안 `package.json`의 `dependencies`·`peerDependencies`·`optionalDependencies`에 `workspace:`가, 모든 필드에 `catalog:`가 남지 않았는지 확인한다(RD-021). core에는 `peerDependencies.pyodide`(`^` 범위)와 `peerDependenciesMeta.pyodide.optional: true`가 있고 repl에는 `pyodide` peer가 없어야 한다. react에는 `peerDependencies`의 `react`·`react-dom`·`@xterm/xterm`이 있고 셋이 `dependencies`에 없으며 `dependencies`의 `@xterm/addon-fit`이 정확 버전이어야 한다(소비자가 셋을 직접 설치하므로 2~4단계로는 선언 누락이 드러나지 않는다). dom-bridge는 `dependencies`의 coincident·reflected-ffi가 정확한 버전이고, core가 `dependencies`가 아니라 `peerDependencies`에 있으며, `sideEffects`가 배열이어야 한다. 정확 버전 규칙은 모두 작업공간 `package.json` 선언과 같아야 한다. 규칙 목록의 원천은 `MANIFEST_POLICY`다. 이어서 진입점을 도출한다: 각 tarball `exports` 키 중 값이 `null`이 아니고 `./package.json`이 아닌 것(`.`은 패키지 이름). 도출 목록과 `ENTRY_EXPORTS` 키가 양방향으로 같아야 하고, 다르면 설치 전에 진입점 이름을 찍고 실패한다. 공개 진입점이 없는 `exports`도 실패다.
  2. 저장소 밖 임시 소비자 프로젝트(주 소비자, dom-bridge를 뺀 5개)에 다섯 tarball(`file:`)과 `@xterm/xterm`·`react`·`react-dom`·`@types/react`·`pyodide`를 설치한다(react 패키지는 `react`·`react-dom`·`@xterm/xterm`을 peer로만 선언한다. 소비자 버전은 react 패키지 `devDependencies`가 원천).
  3. node ESM `import`로 주 소비자 패키지의 도출 진입점 8개(`@cp949/runo-xterm-readline`, `@cp949/runo-pyodide-core`, `@cp949/runo-pyodide-core/worker`, `@cp949/runo-pyodide-terminal`, `@cp949/runo-pyodide-terminal/internal`, `@cp949/runo-pyodide-repl`, `@cp949/runo-pyodide-repl/worker`, `@cp949/runo-pyodide-repl-react`)의 대표 export가 기대한 타입인지 본다. react는 `PythonRepl`·`PythonRunner`·`usePythonRunner`·`RunRejectedError`가 `function`이어야 한다. 이 import가 번들 없는 Node ESM에서 `@xterm/xterm`을 평가하므로 `docs/traps/TRP-063`의 이름 import 실패를 잡는 유일한 검사다. core는 `PYODIDE_VERSION`(catalog 버전과 같은 문자열)·`DEFAULT_PYODIDE_INDEX_URL`(`https://cdn.jsdelivr.net/pyodide/v<버전>/full/`)도 단언한다.
  4. `tsc --noEmit`을 `skipLibCheck: false`로 돌려 배포된 `.d.mts`의 타입 해석까지 검사한다. react는 `PythonRunnerProps`·`PythonReplProps`에 실제 props 객체(`terminalOptions: { cols, rows, cursorBlink }`·`fit`·`topLevelAwait`)를 대입하고 필수 `createWorker` 누락이 `@ts-expect-error`로 잡히는지, `PythonReplHandle.runSource` 호출이 해석되는지 본다(any로 무너지지 않는지).
  5. 설치된 트리(lockfile·`node_modules` 이름·설치된 `dist` 문자열)에 `coincident`·`reflected-ffi`가 없는지 본다(`dist` 문자열은 9.8.2의 `check-dist.mjs`를 재사용한다).
  6. Vite dev 해석: 소비자에 설치한 vite(`apps/demo/package.json`과 같은 `8.3.0`)의 `createServer`(middleware 모드, `optimizeDeps.noDiscovery`) client 환경 `pluginContainer.resolveId`로 공개 진입점 8개와 `./package.json`을 풀어 결과 파일이 설치본에 있는지 본다. `null`은 실패다(Vite는 `development` 조건의 대상 파일이 없어도 다음 조건으로 넘어가지 않고 오류 없이 `null`을 돌려준다). Node·`tsc`는 `development` 조건을 쓰지 않아 1~4단계가 놓치는 결함을 잡는다(이슈 `react-package-followups/05`).
  7. dom-bridge 소비자(RD-023): core + dom-bridge tarball만 별도 임시 폴더에 설치한다. core·dom-bridge의 도출 진입점 4개 import(dom-bridge worker 진입점은 `addEventListener` 스텁을 세운 뒤 평가해 export 모양·coincident 해석만 본다, 부트스트랩·동작은 보지 않는다), `tsc`(`WorkerPlugin`과 타입 호환, `@ts-expect-error` 2건), Vite 해석 6건, 설치된 coincident `4.1.1`·reflected-ffi `0.7.2`가 각 버전 1개, dom-bridge dist의 `check-dist --allow-sync-bridge` 통과, 소비자 core dist의 옵션 없는 엄격 `check-dist` 통과. 주 소비자와 나눈 이유: 하나의 소비자에서 dom-bridge를 예외로 빼는 판정은 다른 패키지의 금지 검사를 약하게 만들 수 있다.
- 확인된 사실:
  - `pnpm pack`은 `dependencies`의 `workspace:*`를 실제 버전(현재 `0.0.0`)으로, `devDependencies`의 `catalog:`를 catalog 버전으로 바꿔 쓴다. 스모크가 1단계에서 매번 단언한다(pnpm 11.25.0 실측).
  - `"private": true`인 패키지도 pack 된다. tarball 안 `package.json`에도 `private: true`가 남지만 설치에는 영향이 없다. tarball 파일은 `dist/**`·`package.json`(xterm-readline은 `LICENSE-MIT`·`README.md` 포함)이다.
- 내부 패키지를 tarball로 고정하는 메커니즘: 소비자 폴더에 `pnpm-workspace.yaml`을 두고 `overrides:`(내부 패키지 5개 → `file:` tarball)를 적은 뒤 `pnpm install --prefer-offline`을 `--ignore-workspace` 없이 실행한다. pnpm 11.25.0에서 `package.json`의 `pnpm.overrides`는 읽히지 않고(`The "pnpm" field in package.json is no longer read by pnpm`), `--ignore-workspace`는 `pnpm-workspace.yaml`의 `overrides`도 무시한다. 둘 다 내부 패키지가 레지스트리로 조회돼 `ERR_PNPM_FETCH_404`가 난다. 소비자 `package.json`의 `packageManager`를 저장소 루트 값(pnpm 11.25.0)으로 고정해야 전역 pnpm 10이 쓰이지 않는다(pnpm 10은 `pnpm.overrides`를 읽는다). 소비자가 pnpm 10 이하이면 다른 메커니즘이 필요하다.
- 소비자 요구사항(스모크 소비자가 충족하는 것):
  - core `./worker` 타입(`dist/worker.d.mts`)이 `pyodide`·`pyodide/ffi` 타입을 import한다. core는 `pyodide`를 optional peer(`^314.0.7`)로 선언하고(배포 `dependencies`가 아니다, RD-021) tsdown `deps.neverBundle`로 타입을 인라인하지 않는다. 그래서 core 타입을 직접 쓰는 소비자는 같은 minor의 `pyodide`를 직접 설치해야 한다(`packages/pyodide-core/README.md`). repl은 core 타입을 `dist/*.d.mts`에서 import하지 않으므로(`@xterm/xterm`만) repl만 쓰는 소비자는 영향이 없다.
  - `skipLibCheck: false`이면 pyodide 자체 타입이 `lib`에 `ESNext`(`Symbol.dispose`)를, `@types/node`와 `@types/emscripten`(전역 `FS`)을 요구한다. TypeScript 6은 `@types/*`를 자동 포함하지 않으므로 소비자 tsconfig에 `types: ["node", "emscripten"]`를 적는다. 저장소 내부 `tsc`는 `skipLibCheck: true`라 이 요구가 가려져 있다. 스모크가 `false`를 쓰는 이유는 `true`이면 `pyodide` 미해석도 가려지기 때문이다.
  - 소비자 tsconfig: `module`·`moduleResolution: "NodeNext"`, `strict`, `noEmit`, `lib: ["ESNext", "DOM", "DOM.Iterable"]`.
- 임시 폴더: `SMOKE_TMPDIR`(기본 `os.tmpdir()`) 아래 `mkdtemp`. 성공하면 지우고, 실패하면 원인 조사용으로 남기고 경로를 출력한다(실패가 쌓이면 수동으로 지운다). `KEEP=1`이면 성공해도 남긴다.
- 소비자 버전 원천: `pyodide`는 `pnpm-workspace.yaml`의 `catalog.pyodide`(스크립트가 `catalog:` 절을 읽는다, 단순 YAML만 지원하고 `catalogs:`·앵커는 "못 찾음"으로 실패한다), `@xterm/xterm`은 repl `devDependencies`, `typescript`·`packageManager`는 루트 `package.json`이다. `@types/node`(`24`)·`@types/emscripten`(`^1.41.4`)는 스크립트에 적은 범위라 시간이 지나면 해석되는 버전이 바뀐다.
- 소요 시간: 2026-09-24 실측 통과 2.6초(스크립트 내부 기록), `time` real 3.3초(패키지 5개 시점). 2026-09-25 RD-023 뒤(6개 패키지, dom-bridge 소비자·Vite 해석 단계 추가) 6.1초, `time` real 6.9초. 2026-09-27 RD-039 전후 14.6초(스크립트 내부 기록, 구조 변경 전인 DELTA-01에서도 같은 값). pnpm 저장소에 필요한 패키지가 이미 있고 `pnpm build`가 turbo 캐시인 상태의 값이며, 저장소가 비어 있는 첫 실행은 재지 않았다.
- tarball `exports` 규칙(RD-023 DELTA-01): 6개 패키지의 `package.json`이 `publishConfig.exports`에 `development`를 뺀 `exports`를 두고, `pnpm pack`(pnpm 11.25.0)이 이것을 tarball의 `exports`로 쓴다(tarball `package.json`에 `development`·`publishConfig`가 남지 않는 것을 직접 확인). 수정 전에는 tarball `exports`가 배포되지 않은 `./src/…ts`를 가리켜 1단계 정적 검사가 5개 패키지에서 실패했고, 6단계는 공개 진입점 8개 모두 `null`이었다(Vite 8.3.0 client `resolveId`, 임시 폴더에 빈 `src/index.ts`를 두면 `development`가 선택돼 그 파일로 해석). 작업공간 `exports`(`development` 포함)와 `publishConfig.exports`는 손으로 맞춘다.
- 한계: 소비자 검사는 `moduleResolution: NodeNext`·strict 기준 한 가지이고 Vite 해석은 client 환경 한 가지다(SSR 환경 `ssr.resolve.conditions`와 `optimizeDeps` 사전 번들 경로는 보지 않는다). `smoke:pack`이 검사하는 tarball은 6개다. `publishConfig.exports`는 pnpm 동작에 의존하지만 정적 검사(1단계)가 다른 패키지 매니저의 pack도 잡는다. 진입점을 추가하거나 지울 때 손으로 맞추는 곳은 `exports`·`publishConfig.exports`·`ENTRY_EXPORTS`다. `exports`와 `publishConfig.exports`의 키 어긋남은 L0 키 일치 시험(9.8.1, 배포 패키지 6종)이 잡고, `smoke:pack`도 선언된 진입점이 tarball `exports`에 없으면 선언 대조에서 실패한다. `ENTRY_EXPORTS`를 빠뜨리면 `smoke:pack`이 1단계의 선언 대조에서 실패한다(`smoke:pack`을 돌려야 드러난다). 기대 export는 진입점마다 대표 이름만 적으므로, 적지 않은 export가 사라지는 것은 `tsc` 대상 `check.ts`가 그 이름을 쓸 때만 잡힌다.

## 9.9 브라우저 호환 게이트(빌드 floor·런타임 floor, ADR-0008)

결정·판정 규칙 본문은 [ADR-0008](../adr/0008-chrome84-build-floor-and-pyodide-runtime-floor.md)·[`14-runner.md`](14-runner.md) 14.3.1 두 곳에 있다. 이 절은 검증 단계에서 어떤 스크립트가 그것을 확인하는지만 적는다.

| 검사                          | 대상                                                | 실행                                                                              | 위치                                                                                                    |
| ----------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| ES 호환성 정적 게이트         | 빌드 산출물(`dist`)의 Chrome 84 초과 런타임 API      | 각 패키지 `check-dist` 스크립트 뒤에 체인(`&& node ../../scripts/check-escompat.mjs dist`), 루트 `pnpm test`(turbo `check-dist`)가 항상 돈다 | `scripts/check-escompat.mjs`, 시험 `packages/pyodide-testkit/test/check-escompat-script.test.ts`        |
| `detectRuntimeSupport()` 단위 시험 | `unsupported`·`not-isolated`·`supported` 판정표      | `pnpm test`(vitest)                                                               | `packages/pyodide-core/test/runtime-support.test.ts`, runner·repl·terminal 각 `*-unsupported.test.ts`   |
| 구버전 Chromium 실측          | Chrome 84(빌드 floor)·93(격리 O·wasm X)·97(런타임 floor) | `CHROMIUM_VERSION=84\|93\|97 pnpm --filter demo e2e:legacy`(L1, 수동, CI 게이트 아님) | `docker/chromium-legacy/Dockerfile`, `apps/demo/e2e/legacy/legacy-smoke.mjs`                            |

- `check-escompat.mjs`는 `check-dist.mjs`와 별개 스크립트이고 같은 패키지 스크립트 안에서 순서대로 실행된다 — `check-dist`가 coincident·`pyodide` import 금지를, `check-escompat`가 Chrome 84 초과 문법·API를 본다.
- `e2e:legacy`는 `apps/demo`가 `vite build && vite preview`로 만든 산출물(tsdown·Vite `target`이 적용된 실제 배포 dist)을 대상으로 한다 — dev 서버는 `build.target`을 적용하지 않아 이 게이트의 대상이 아니다(9.3의 "브라우저로만 확인되는 것"과 같은 이유로 dev 서버 한계가 있다).
- 한계는 ADR-0008 "Consequences"에 있다(94~96 미실측, dom-bridge 별도 floor 미확정, `check-escompat`이 못 잡는 Web API).
