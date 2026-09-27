# 첫 구현 로드맵 (이관됨)

이관일: 2026-09-28. 원본 `ROADMAP.md`(2052줄, RD-001~RD-049 전부 완료)를 압축 보관한다.
이 문서는 이력 보관용이며 갱신하지 않는다. 상세 설계 근거는 `docs/design/`, 결정 기록은 `docs/adr/` 참고.
ROADMAP.md 형식(ID 규칙·상태 표기·후속 후보 등록 규칙)은 이 저장소에서 더 이상 쓰지 않는다 — 다음에 여러 단계로
나눠 진행할 작업이 실제로 생기면 그때 새로 만든다.

## Phase 0 — 기반과 프로토콜

- **RD-001** — 워크스페이스 정비와 xterm-readline 벤더링(완료): xterm-readline을 `packages/xterm-readline`으로 벤더링(jest→vitest 이식), COOP/COEP 헤더 설정, worker ES 모듈 빌드 확인.
- **RD-002** — 프로토콜 코어(완료): RPC·stdin 메일박스·interrupt buffer·초기화 프레임을 pyodide 없이 순수 구현.
- **RD-003** — 터미널 마운트와 줄 편집(완료): `createRepl` main 쪽 뼈대, xterm 마운트, 벤더 readline로 줄 편집·history.
- **RD-004** — pyodide 로드·배너·출력 sink 4종·전역 스트림(완료): worker 부팅→`loadPyodide`, main sink 4종, `createRepl`에 `createWorker`·`pyodide`·`onStatus` 옵션 추가.
- **RD-005** — REPL 루프와 PyodideConsole 코어(완료): 한 줄 제출 REPL 루프, `sys.ps1/ps2`, 값 에코, 오류 표시. `<console>` 프레임 제거.
- **RD-006** — `input()` 읽기(완료): stdin 메일박스·꼬리 프롬프트·read-guard로 `input()`/`sys.stdin` 계열 읽기 구현.

## Phase 1 — Ctrl+C 전체

- **RD-007** — 실행 중 Ctrl+C(완료): 요청 번호·ack·재전송·연타 보호·시작 코드 보호를 갖춘 기본 인터럽트.
- **RD-008** — 입력줄 Ctrl+C·`input()` 중 Ctrl+C(완료): 미완성 블록 취소, `input()` 중단이 호출 지점 `KeyboardInterrupt`.
- **RD-009** — 정지한 실행 중 Ctrl+C(완료): 감시 타이머, `time.sleep` 조각, webloop 재보고 억제, 유휴 SIGINT 폐기.
- **RD-009a** — `run_sync` 계열 대기 중 예외의 중복 트레이스백 제거(완료): asyncio 대기 코루틴 예외를 사용자 스택에서 재발생시켜 이중 인쇄·프레임 오염 제거.

## Phase 2 — 세션·제출·편집·완성

- **RD-010** — 세션 리셋·종료 정책·크래시 재시작 UI(완료): 리셋 버튼, `exit()` 뒤 Alert 복구, worker 크래시 재시작.
- **RD-011** — 여러 줄 입력 제출(완료): 붙여넣기·Shift+Enter·히스토리 재호출로 여러 줄을 한 번에 제출·실행.
- **RD-012** — top-level await 옵션(완료): 기본 꺼짐, 옵션 켜면 세션 리셋 후 적용.
- **RD-013** — 자동 들여쓰기(완료): 블록 진입 시 자동 4칸, 세션 리셋 시 초기화.
- **RD-014** — 블록 입력을 history 항목 하나로(완료): 여러 줄 블록을 history 한 항목으로 묶어 재호출.
- **RD-015** — Tab 완성(이름·속성)(완료): 이름·속성 완성, 완성 중 Ctrl+C 취소, Tab 큐잉.
- **RD-016** — `import`/`from` 줄의 모듈 완성(완료): import 문에서 모듈 이름 Tab 완성.
- **RD-017** — 선택 영역 복사(완료): 드래그 선택 시 자동 복사, 선택 중 Ctrl+C는 인터럽트 대신 복사.
- **RD-019** — 읽기 없는 구간의 키 버퍼링(type-ahead)(완료): 실행 중 친 키를 다음 읽기가 재생(tty 입력 큐와 동일 개념).

## Phase 3 — 검증 자산

- **RD-018** — 브라우저 회귀 하니스와 3.14 기준 데이터 저장소 보관(완료): 각 RD의 확인 스크립트·pty 기준 데이터를 `apps/demo/e2e/`로 이관, 기준선(BASELINE.md) 정립.

## Phase 4 — 패키지 분리와 새 소비자

- **RD-020** — `pyodide-core` 추출과 `pyodide-repl` 축소(완료): 프로토콜·worker 커널·main 세션을 `pyodide-core`로 분리(동작 불변).
- **RD-021** — pyodide 버전 원천 통합과 호환 탐지(완료): 버전 리터럴을 workspace catalog 한 곳으로, 비공개 API 탐지로 버전 불일치 경고.
- **RD-022** — 실행 driver와 `pyodide-terminal` 실행창(완료): `run()`/`stop()` 기반 실행창(`pyodide-terminal` 패키지), xterm 공통 부품 이전.
- **RD-022a** — REPL `runSource(code)`(완료): REPL 핸들에 배경 실행 API 추가(치던 줄 보존 후 재출력).
- **RD-022b** — 열린 읽기 위 배경 출력 조율(완료): 프롬프트가 열린 채 배경 출력이 오면 입력줄을 지우고 다시 그리는 규약 정립.
- **RD-023** — `pyodide-dom-bridge`(완료): coincident 기반 DOM 프록시 플러그인, Chromium 한정 "제한 있는 지원" 판정.
- **RD-024** — `pyodide-repl-react`와 demo 이전(완료): `<PythonRunner>`·`<PythonRepl>`·`usePythonRunner` React 컴포넌트, StrictMode 대응.
- **RD-025** — pty 캡처 도구 복원(완료): 3.14 기준 데이터 재생성 도구를 저장소에 이관(3.15 재측정 대비).

## Phase 5 — 아키텍처 정리(전부 동작 불변 리팩터)

- **RD-026** — 재그리기 대기 창·접두 경로 결함 4건 수정(완료).
- **RD-027** — 프롬프트 행을 surface의 deep module로 심화(완료): 꼬리·접두·읽기 관리를 `createTerminalSurface`(promptRow) 하나로 통합.
- **RD-028** — 프롬프트 행 개행 규칙 통일(완료): 행 머리 보장 판정을 "그리기 전 읽기 있음" + "현재 io 꼬리" 규칙 하나로 통일.
- **RD-029** — REPL 읽기 주기를 driver 하나로 통합(완료): `SourceBridge`를 흡수해 읽기 phase 상태 기계 하나로.
- **RD-030** — Readline 재그리기 대기를 `Offscreen` 객체·`LineView`로 분리(완료): 벤더 재그리기 상태를 객체 하나로 합치고 위임.
- **RD-031** — 실행창 가짜 core seam 삭제·`interrupt()` 결과 반환(완료): 실제 `createRunner`로 시험, `interrupt()`가 결과값 반환.
- **RD-032** — worker 런타임 연결을 `attachRuntime` 하나로(완료): SIGINT·sleep 조각·stdin 배선 조립을 함수 하나로 통합.
- **RD-033** — 읽기 폐기 판정을 core 세션이 담당(완료): `ended || crashed` 판정을 core로 일원화, REPL·runner 의미 통일.
- **RD-034** — 미룬 stdin 읽기를 끝난 세션에서 열지 않음(완료): 리셋 경합 시 옛 세션 읽기가 새 세션 화면을 건드리지 않게.
- **RD-035** — 메일박스 응답 해석을 인터페이스 하나로(완료): `takeMailboxResponse`/`peekMailbox`로 시험 하니스 통합.
- **RD-036** — REPL `index.test`의 층 중복 시험 삭제(완료, 시험 전용): 소유 층과 중복된 단언 14블록 제거.
- **RD-037** — REPL 콘솔 통합 하니스 한 번 등록으로(완료, 시험 전용): `useConsoleHarness`로 부팅·해체 사본 통합.
- **RD-038** — React 터미널 위젯 수명 module과 계약 suite(완료): `useTerminalWidget` 추출, 컴포넌트 간 계약 시험 공유.
- **RD-039** — pack-smoke 소비자 프로젝트를 module 하나로(완료, 시험 전용): tarball 스모크 검사 로직 통합.
- **RD-040** — worker 부팅 시험 하니스를 core로 이전(완료, 시험 전용): `createMainSide` 5벌을 core 하나로, 부팅 불변식 시험을 core 소유로.
- **RD-041** — REPL `run-source` 시험이 `create-repl` 하니스 사용(완료, 시험 전용).
- **RD-042** — terminal `prompt-row` 시험이 surface fixture 사용(완료, 시험 전용): 1346줄 파일을 3개로 분할.
- **RD-043** — terminal·repl 시험 도우미 사본을 testkit/terminal `./test-utils`로 통합(완료, 시험 전용).
- **RD-044** — e2e check 스크립트 진입 규약을 실행기 라이브러리 하나로(완료, 시험 전용): `check-runner.mjs`로 23개 스크립트 통합.
- **RD-045** — 미룬 stdin 읽기를 read-guard 하나가 소유(완료): `DetachedPrefix` 핸들로 io 수명과 그리기 판정을 read-guard로 집중.
- **RD-046** — REPL 세션 interface 축소·종료 순서 서술 통합(완료): `ReplSession` 멤버 8→4, Ctrl+C 처리를 `interrupt()` 하나로.
- **RD-047** — `exit()`가 닫은 stdin 되살림을 core `exec_in_console`로(완료): runner·REPL 두 벌이던 stdin 재개 로직을 core 하나로.
- **RD-048** — 빈 입력줄 Ctrl+D를 EOF로(완료): 벤더→terminal→core→worker 4계층 배선으로 `sys.stdin` EOF 지원.
- **RD-049** — 완성 후보 popover(옵션)(완료, 2026-09-28): `completionPopover` 옵션(기본 꺼짐)으로 Tab 완성 후보를 커서 옆 선택 상자로 표시.

## 보류(당시 미등록·미착수)

- `input()` 안 Tab 완성 — worker가 메일박스 대기라 완성 요청 불가, 별도 배선 필요.
- `time.sleep` 대기 중 워커 CPU 점유 — 정확성 영향 없음, 재측정 비용 대비 이득 적음.
- "Python 정지" 플래그(송신기 잔류 제거) — 정확성 영향 없음.
- Firefox에서 dom-bridge 공존 실측 — Chromium만 검증됨, Firefox 지원 시점에 등록.
- `native: false` + 서비스워커 경로의 동기 DOM 호출 — 서비스워커 없는 조건만 측정됨, 필요 시 재개.
- `native: false`용 `await` 전용 DOM API — 조기 실패 정책 채택, 필요 시 별도 표면 설계.

## 범위 밖

`docs/design/10-parity-deviations.md` 2절(3.14 편차 중 범위 밖 확정 5건)과 v1 제외 항목: history 영구 저장, Ctrl+R 역검색,
syntax highlighting, session export/import, 패키지 설치 UI, 파일시스템·터미널 명령·디버거, Service Worker COOP/COEP 우회,
CI 상시 E2E, 서버 CPython 프로세스 아키텍처, `@cp949/runo-xterm-readline`의 npm 배포(재사용 가치 확인되면 별도 결정).
