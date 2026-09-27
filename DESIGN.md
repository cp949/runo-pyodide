# runo-pyodide 설계

브라우저 Python REPL(pyodide + xterm.js)을 `/work/cp949/pyodide-samples/apps/repl`(이전 구현)에서 coincident 동기 브리지 없이 재개발하는 기술 설계다. RD-001~RD-049 이관 작업(이력: `docs/history/first-roadmap.md`)은 이 문서와 `docs/design/`을 전제로 진행했다.

이 문서는 색인이다. 내용은 `docs/design/NN-*.md`에 있다.

## 읽기 순서

처음 오는 에이전트는 1→2→3 순서로 읽는다. 특정 RD를 맡았으면 3의 해당 절만 읽어도 된다.

1. **무엇을, 왜**: `docs/design/00-architecture.md`(목표·채널·생명주기·패키지·공개 인터페이스), `docs/adr/`(결정 7건)
2. **통신 계약**: `docs/design/01-protocols.md`(RPC 메시지, stdin 메일박스, interrupt buffer, 초기화 프레임, 시퀀스)
3. **기능 규칙**(이전 구현이 3.14 pty 실측으로 확정한 것을 계승):
   - `02-console-core.md` PyodideConsole·제출 실행·top-level await·종료, `runSource`(5.6)
   - `03-ctrl-c.md` SIGINT 프로토콜(요청 번호·ack·재전송, Python 핸들러, 감시 타이머, sleep 조각)
   - `04-stdin-input.md` `input()` 읽기·취소·read-guard·프롬프트 꼬리
   - `05-output.md` sink 4종·전역 스트림·배너·열린 읽기 위 배경 출력(4.4)
   - `06-editing.md` 벤더링 xterm-readline(`takeRead`·`prefillCursor` 포함)·자동 들여쓰기·블록 히스토리·붙여넣기·선택 복사·읽기 없는 구간의 키 버퍼링
   - `07-tab-completion.md` Tab 완성
   - `08-session.md` 리셋·이중 마운트·종료 후 상태
   - `14-runner.md` 실행 driver(`runDriver`)·`createRunner`(상태 8종·결과·`stop()`)·`InputProvider`·xterm 실행창(`createTerminalRunner`). REPL이 아니라 `python main.py` 기준이다
   - `15-react.md` React 컴포넌트·hook(`PythonRunner`·`PythonRepl`·`usePythonRunner`): props·handle·수명과 핸들 위임 규칙·fit·StrictMode(RD-024)
   - `16-dom-bridge.md` DOM 브리지(`pyodide-dom-bridge`): `runo.browser`(`window`·`document`)·worker 조립과 첫 정적 import 규칙·`plugins` 계약·`native: false`·동기 호출 중 중단(S5)·출력·DOM 도착 순서 보장 없음·CSP 정적 검사(RD-023)
   - `17-release.md` npm 공개 배포: 공개 범위 6개·lockstep 버전·공개 매니페스트 규칙·MIT 라이선스·release-it 흐름(publish가 push보다 먼저)·실패 복구·사용자 준비물·`release:check`
4. **검증과 한계**: `09-testing.md`(패키지 경계 검사 9.8 포함), `10-parity-deviations.md`(3.14 편차 55건 등록: 해소 22·28·32와 동등 항목 23 포함, 범위 밖은 별도), `11-known-traps.md`(함정 33건), `13-version-upgrade.md`(pyodide 버전 원천·업그레이드 절차·호환 탐지 등급표, [ADR-0007](docs/adr/0007-pyodide-single-version-policy.md))
5. **이전 구현 참조**: `12-previous-implementation.md`(이전 RD 인벤토리·모듈 지도)

## 결정된 스택

| 항목         | 결정                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 워크스페이스 | pnpm 11 + turbo, `apps/*`·`packages/*`. Node 24+, TypeScript 6                                                                                                                                                                                                                                                                                                                                                                         |
| core         | `packages/pyodide-core` = `@cp949/runo-pyodide-core`(private, RD-020). 프로토콜(RPC·메일박스·interrupt)·worker 커널·main 세션·실행 driver(`runDriver`, RD-022)·`createRunner`. tsdown ESM + d.ts. UI·xterm·coincident 비의존                                                                                                                                                                                                           |
| REPL         | `packages/pyodide-repl` = `@cp949/runo-pyodide-repl`. REPL driver + REPL 프런트(core·terminal 위). tsdown ESM + d.ts. 프레임워크 무관. React·MUI 의존 없음                                                                                                                                                                                                                                                                             |
| 실행창       | `packages/pyodide-terminal` = `@cp949/runo-pyodide-terminal`(private, RD-022). xterm 실행창 `createTerminalRunner`와 repl이 공유하는 부품 5종(`./internal`, repl 전용·lockstep; 화면 조립·수명은 `surface`, 프롬프트 행 연산은 `promptRow`, RD-027). tsdown ESM + d.ts. coincident 비의존                                                                                                                                              |
| React        | `packages/pyodide-repl-react` = `@cp949/runo-pyodide-repl-react`(private, RD-024). `<PythonRunner>`·`<PythonRepl>`·`usePythonRunner`. core·terminal·repl 위에서 xterm 생성·`FitAddon`·dispose 순서·StrictMode를 처리한다. peer `react`·`react-dom` ^19·`@xterm/xterm` ^6, `xterm.css`는 소비자가 import. tsdown ESM + d.ts. coincident 비의존                                                                                          |
| DOM 브리지   | `packages/pyodide-dom-bridge` = `@cp949/runo-pyodide-dom-bridge`(private, RD-023). worker Python이 main의 `window`·`document`를 동기 프록시로 쓰는 플러그인(`from runo.browser import document`). coincident `4.1.1`·reflected-ffi `0.7.2` 정확한 버전 고정(포크 없음), 저장소에서 coincident에 의존하는 유일한 패키지. core `runWorker({ plugins })` 위에서 동작하고 REPL과는 지원하지 않는다. Chromium에서만 검증. tsdown ESM + d.ts |
| 줄 편집      | `packages/xterm-readline` = `@cp949/runo-xterm-readline`. strtok/xterm-readline 1.2.2 소스 벤더링(MIT). 원본 `/work/thrd/xterm-readline`                                                                                                                                                                                                                                                                                               |
| 터미널       | `@xterm/xterm` 6                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 데모         | `apps/demo`: Vite 8 + React 19. UI 라이브러리 미정(필수 아님)                                                                                                                                                                                                                                                                                                                                                                          |
| Python       | pyodide `314.0.7`(Python 3.14.2), CDN `loadPyodide`. 버전 원천은 `pnpm-workspace.yaml` catalog 한 곳이고 코드는 `pyodide/package.json`에서 유도한다(ADR-0007, `13-version-upgrade.md`). `pyodide` npm 패키지는 타입·node 시험용 devDependency이며 core가 optional peer로도 선언한다                                                                                                                                                    |
| 동등성 기준  | CPython 3.14.4 `_pyrepl`, pty 24×80 `TERM=xterm` 실측                                                                                                                                                                                                                                                                                                                                                                                  |
| 통신         | 네이티브 Worker + MessageChannel RPC + `input()` 전용 SAB 메일박스 + interrupt buffer. coincident 없음(DOM 브리지 플러그인 `pyodide-dom-bridge`만 예외이고 그때도 `input()`·출력·중단은 이 채널로 간다)                                                                                                                                                                                                                                |
| 테스트       | vitest 5. node 환경에서 실제 pyodide 로드, jsdom + 가짜 터미널, 브라우저는 Playwright 수동 하니스. 시험 도우미는 `packages/pyodide-testkit` = `@repo/pyodide-testkit`(private, 빌드·pack 없음). 패키지 경계 검사(의존 트리 시험·`check-dist`·`pnpm smoke:pack`)는 `09-testing.md` 9.8                                                                                                                                                  |
| 호스팅       | cross-origin isolated 필수(COOP/COEP). dev·preview·배포 모두                                                                                                                                                                                                                                                                                                                                                                           |

## 문서 규칙

- `docs/design/` 번호는 읽기 순서이지 의존 순서가 아니다. 새 절은 끝 번호 다음에 붙인다.
- 각 기능 문서의 "참고:" 경로는 이전 구현의 근거 위치다. 이전 구현은 읽기 전용 참고이며 코드를 그대로 복사할 때는 통신 계층(coincident proxy)과 결합된 부분을 걸러낸다(`12-previous-implementation.md` 4절의 "통신과 격리된 것 / 결합된 것").
- 규칙·상수를 바꾸면 해당 절과 `10-parity-deviations.md`를 같은 DELTA에서 갱신한다. 새 함정은 `docs/traps/`(rubber-workflow)이고 `11-known-traps.md`는 이관본이라 수정하지 않는다.
- 용어는 `CONTEXT-MAP.md`가 가리키는 `CONTEXT.md`를 따른다.

## 미확정 사항(구현 시점에 확인)

- Firefox·Safari 동작. 이전 구현은 Chromium만 확인했다. 브라우저별 차이는 `10-parity-deviations.md`에 적는다.
