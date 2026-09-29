# apps/demo/e2e

실제 xterm 6 + 실제 브라우저(chromium)로 데모를 조작하는 Playwright 하니스. 판정 스크립트·측정
스크립트·pty 기준 데이터·양성 대조 드라이버·node 통계를 전부 이 폴더 안에 저장소 코드로 커밋한다
(RD-018부터. 이력은 `docs/design/12-previous-implementation.md`,
각 RD 요약은 `docs/history/first-roadmap.md` 참고, 상세 인계는 보관하지 않음).

기준선(시나리오 ID별 현재 기대 결과)은 `apps/demo/e2e/BASELINE.md`에 있다. 이 문서는 실행법·폴더
규칙·버전 차이·함정만 다룬다.

**실행 규칙**: 전체 `e2e:baseline`(1회 약 8분 이상)과 `e2e:measure`·`node/` 통계는 **사용자가 지시할 때만**
돌린다. 에이전트가 스스로 돌리는 것은 변경 영역 개별 스크립트(`ONLY=`·`N=` 축소)까지다
(`docs/agents/rubber-workflow.md` "검증 실행 예산" L0~L3).

**스크립트 작성 규칙**: 고정 대기 뒤 부재·존재 확인과 절대 ms 상한 판정을 새로 쓰지 않는다. 마커 배리어·
`waitFor`·페이지 안 시계를 쓴다(`docs/design/09-testing.md` 9.7).

## 실행 전제

- `pnpm exec playwright install chromium`이 끝나 있어야 한다(devDependency `playwright`,
  `apps/demo/package.json`).
- `pnpm --filter demo e2e:baseline`·`e2e:measure`는 서버(5173 dev·4173 preview·4174 비격리 정적)가
  비어 있으면 스스로 기동하고 끝나면 자기가 띄운 것만 내린다(`e2e/run.mjs`). 이미 떠 있으면 "기존
  사용"으로 표기하고 그대로 쓰며 종료 시에도 내리지 않는다.
- `pnpm --filter demo e2e:<이름>`(개별 스크립트)은 서버가 **미리 떠 있어야** 한다 — 보통
  `pnpm --filter demo dev`(5173).
- 서버 기동 확인은 `lsof`(포트 기준 프로세스 조회)에 의존한다 — 이 sandbox에는 있지만 `lsof`가 없는
  환경에서는 `e2e/run.mjs`가 "이미 죽었다"로 조용히 오판할 수 있다(아래 함정 절 참고).

## 명령 표(35항목, `apps/demo/package.json`)

| 이름                     | 실행                                                                                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e:baseline`           | `node e2e/run.mjs baseline` — 서버 3개 관리 + 판정 23종(dev 전부 + preview 부분) + `boot-press` N=30, `results/summary.json`을 `baseline.json`과 대조                                                                                                            |
| `e2e:measure`            | `node e2e/run.mjs measure` — dev만 기동, 측정 5종(`boot-press` 제외) 순차 실행                                                                                                                                                                                   |
| `e2e:check`              | `node e2e/run.mjs check` — `checks/`·`measure/`·`node/`의 `.mjs`를 `node --check`로 정적 구문 검사만(eslint·tsc는 `e2e/**` 계속 무시, 아래 "정적 검사" 참고)                                                                                                     |
| `e2e:repl-check`         | `node e2e/checks/repl-check.mjs normal`(`cdn-blocked`·`not-isolated`는 인자로 직접 지정)                                                                                                                                                                         |
| `e2e:runner-check`       | `node e2e/checks/runner-check.mjs normal`(실행창 `?view=runner`, `not-isolated`는 인자로 직접 지정하고 4174 정적 서버를 쓴다)                                                                                                                                    |
| `e2e:prompt-join`        | `node e2e/checks/prompt-join-check.mjs`                                                                                                                                                                                                                          |
| `e2e:trailing-newline`   | `node e2e/checks/trailing-newline-check.mjs`                                                                                                                                                                                                                     |
| `e2e:carryover`          | `node e2e/checks/carryover-check.mjs`                                                                                                                                                                                                                            |
| `e2e:stdin-input`        | `node e2e/checks/stdin-input-check.mjs`                                                                                                                                                                                                                          |
| `e2e:bg-input-guard`     | `node e2e/checks/bg-input-guard-probe.mjs`                                                                                                                                                                                                                       |
| `e2e:ctrl-c`             | `node e2e/checks/ctrl-c-check.mjs`                                                                                                                                                                                                                               |
| `e2e:prompt-cancel`      | `node e2e/checks/prompt-cancel-check.mjs`                                                                                                                                                                                                                        |
| `e2e:input-cancel`       | `node e2e/checks/input-cancel-check.mjs`                                                                                                                                                                                                                         |
| `e2e:session-reset`      | `node e2e/checks/session-reset-check.mjs`                                                                                                                                                                                                                        |
| `e2e:multiline`          | `node e2e/checks/multiline-check.mjs`                                                                                                                                                                                                                            |
| `e2e:tla`                | `node e2e/checks/tla-check.mjs`                                                                                                                                                                                                                                  |
| `e2e:auto-indent`        | `node e2e/checks/auto-indent-check.mjs`                                                                                                                                                                                                                          |
| `e2e:block-history`      | `node e2e/checks/block-history-check.mjs`                                                                                                                                                                                                                        |
| `e2e:tab`                | `node e2e/checks/tab-check.mjs`                                                                                                                                                                                                                                  |
| `e2e:selection-copy`     | `node e2e/checks/selection-copy-check.mjs`                                                                                                                                                                                                                       |
| `e2e:type-ahead`         | `node e2e/checks/type-ahead-check.mjs`                                                                                                                                                                                                                           |
| `e2e:ctrl-d`             | `node e2e/checks/ctrl-d-check.mjs`(RD-048, 빈 입력줄 Ctrl+D. `D01`은 REPL `>>>` 세션 종료·`D07`은 실행창, 나머지는 REPL `input()`·`sys.stdin`·블록. `ONLY=D03,D07`)                                                                                              |
| `e2e:run-source`         | `node e2e/checks/run-source-check.mjs`(REPL 화면의 `source`·`run-source`·`source-result` 요소로 `runSource(code)`를 조작, RD-022a)                                                                                                                               |
| `e2e:bg-output`          | `node e2e/checks/bg-output-check.mjs`(열린 읽기 위 배경 출력 조율, RD-022b. 배경 출력은 Python BroadcastChannel 수신기, `input()` 중 출력은 `lib.mjs` `injectRpcNotice`로 합성)                                                                                  |
| `e2e:completion-popover` | `node e2e/checks/completion-popover-check.mjs`(RD-049, completion popover `role=listbox`. 화면 둘: `POP`(`?completionPopover=1`)·`OFF`(옵션 꺼짐 회귀). `ONLY=POP`·`ONLY=OFF`)                                                                                   |
| `e2e:react-strictmode`   | `node e2e/checks/react-strictmode-check.mjs`(RD-024, REPL·`?view=runner` 두 화면의 StrictMode worker·xterm 수, dev 서버 전용. `ONLY=REPL`·`ONLY=RUNNER`로 화면 하나만)                                                                                           |
| `e2e:react-fit`          | `node e2e/checks/react-fit-check.mjs`(RD-024, `?fit=1` 두 화면의 창 크기 → `cols` 변화·이후 입력. `ONLY=REPL`·`ONLY=RUNNER`)                                                                                                                                     |
| `e2e:dom-bridge`         | `node e2e/checks/dom-bridge-check.mjs`(RD-023, `?view=dom-bridge` 7페이지: S1~S7(S6은 core 직접·`<PythonRunner>` 두 경로 모두 누락 0·모든 `ok` 필수, 역전 수는 기록만)·`?native=0`·늦은 import·늦은 `runWorker`, dev 전용. `ONLY=S5`·`S6`·`N0`·`LATE`·`RUNLATE`) |
| `e2e:boot-press`         | `node e2e/measure/boot-press.mjs`                                                                                                                                                                                                                                |
| `e2e:press-loss`         | `node e2e/measure/press-loss.mjs`                                                                                                                                                                                                                                |
| `e2e:burst-matrix`       | `node e2e/measure/burst-matrix.mjs`                                                                                                                                                                                                                              |
| `e2e:input-burst-matrix` | `node e2e/measure/input-burst-matrix.mjs`                                                                                                                                                                                                                        |
| `e2e:sleep-await`        | `node e2e/measure/sleep-await-check.mjs`                                                                                                                                                                                                                         |
| `e2e:keys-after-enter`   | `node e2e/measure/keys-after-enter-probe.mjs`                                                                                                                                                                                                                    |
| `e2e:cpu-throttle`       | `node e2e/measure/cpu-throttle-probe.mjs`(기록용 — CPU 감속 rate 1/2/4/8에서 메인·worker 소요를 재고 감속 적용 여부를 표로 남긴다. 실측 결과 메인만 적용·worker 미적용, 아래 "환경변수" 절 한계. 판정 상한 없음, baseline·measure 세트 미등록)                   |

개별 스크립트는 `node <파일> [devURL] [...]` 형태로도 직접 돌릴 수 있다(`devURL` 기본값
`http://localhost:5173`). dev+preview를 한 프로세스에서 도는 7개(`session-reset`·`multiline`·`tla`·
`auto-indent`·`block-history`·`tab`·`selection-copy`, 전부 `<이름>-check.mjs`)는 `node <파일> [devURL] [previewURL]`
— `previewURL`을 주면 dev 다음 preview도 이어서 돈다(`pnpm --filter demo build && pnpm --filter demo
preview`가 떠 있어야 함). `ONLY=<이름 접두어,…>` 환경변수로 일부 확인만 골라 돌릴 수 있고, 측정
스크립트는 `N=<정수>`로 반복 횟수를 줄일 수 있다(예: `N=2 pnpm --filter demo e2e:sleep-await`). 진입
규약(URL·label·ONLY 판정·dev/preview 반복·종료 코드)과 ONLY 판정 두 종류(절 이름 정확 일치·페이지
접두어 양방향 일치)의 정의는 `apps/demo/e2e/check-runner.mjs` + `docs/design/09-testing.md` 9.6.5.

## 환경변수(`lib.mjs`, 느린 장비 재현)

- `E2E_CPU_THROTTLE`(기본 `1`): 1보다 크면 CDP `Emulation.setCPUThrottlingRate`로 CPU를 그 배율만큼 감속한다.
  `waitPrompt()`가 처음 성공한 시점에 1회 적용하므로 부팅 구간은 감속되지 않는다. 기본값에서는 CDP 세션을 만들지 않는다.
- `E2E_TIME_SCALE`(기본 `1`): 응답성 상한(`docs/design/09-testing.md` 9.7 2항)에 곱할 배율. 핸들의 `timeScale`로
  읽는다. e2e 전용이며 L0 vitest 상수에는 적용되지 않는다.

`E2E_CPU_THROTTLE`의 한계(2026-09-26 `e2e:cpu-throttle` 실측, rate 4에서 메인 스레드 4.07배·worker 1.01배):

- 감속은 **메인 스레드(xterm 렌더·입력)만** 늦춘다.
- **worker(Python 실행·`call_later` 타이머·SIGINT 처리)에는 적용되지 않는다.**
- **감속 실행이 통과해도 판정선이 견고하다는 증거가 아니다.** worker 쪽 지연은 시험되지 않는다. 감속 대상 3곳(C12·EC·TICK)은 rate 4에서 수정 전후 모두 통과했고 거짓 실패는 재현되지 않았다.
- worker에 감속을 거는 별도 CDP 세션은 시험하지 않았다(`deferred`).

두 값은 결과 JSON `notes`(`E2E_CPU_THROTTLE`·`E2E_TIME_SCALE`)에 기본값이어도 항상 기록되고, 기본값이 아니면 실행 시작
시 콘솔에 경고 한 줄이 나온다. 잘못된 값(숫자가 아니거나 `E2E_CPU_THROTTLE` < 1)은 던진다.

페이지 시계 도구: `markText(pattern, { exclude, startOnKey })`·`markStart()`·`readMark({ timeoutMs })`가 화면 행 출현
시각을 페이지 `performance.now()`로 잰다. 시작 기준은 `markText` 호출 시각(기본)·`startOnKey`(예: Enter·Ctrl+C
`keydown` 시각)·`markStart()` 중 하나다(`lib.mjs` JSDoc 참고).

## node 통계(수동 실행)

브라우저를 쓰지 않고 node에서 실제 pyodide + 저장소 worker 모듈을 직접 배선해 재는 통계다. 5분 이상
걸리는 것도 있어 `pnpm test`·`e2e:baseline`/`e2e:measure`에는 없다 — 필요할 때 손으로 돌린다.

- `apps/demo/e2e/node/rd-007/`(눌림 소실·폴링 비용): 실행법·판정선·양성 대조는
  `apps/demo/e2e/node/rd-007/README.md`.
- `apps/demo/e2e/node/rd-009/`(유휴 sleep 중 Ctrl+C): 실행법·판정선·`--dry` 양성 대조는
  `apps/demo/e2e/node/rd-009/README.md`.

두 폴더 모두 `console.ts`·`sigint-handler.ts`·`sleep-slice.ts`가 Python 소스를 `?raw`로 import한다.

- `packages/pyodide-testkit/src/ts-resolve-hook.mjs` 하나로 충분하다. `?raw`도 처리한다.
- 문서의 명령은 `node/rd-009/py-raw-hook.mjs`도 함께 `--import`한다. 두 폴더가 공유하고 등록 순서는 무관하다.
- 실측과 근거는 `node/rd-009/README.md` "해석 훅".

결과는 `E2E_RESULTS_DIR`(기본 `apps/demo/e2e/results/`)에 `node-*.json`으로 쓴다.

## 양성 대조(positive-controls)

`apps/demo/e2e/positive-controls/rd-0NN.{py,md}` — 판정 스크립트가 실제로 결함을 검출하는지 증명하는
드라이버(소스 변조 → 대상 확인 실행 → 기대 셀만 실패 → `git checkout --` 원복 → 재실행 통과).

**깨끗한 트리에서만 실행한다** — 시작 전 `git status --short`가 빈 출력이어야 한다(대상 파일이 이미
수정 상태면 원복 확인이 무의미해진다).

- `rd-005.py`~`rd-009.py`(5개, RD-005~009): 파이썬 드라이버가 **자기 스스로** dev 서버(5173)를
  변조·원복마다 재기동한다(TRP-007 — vite dev가 되돌린 파일의 재변조를 낡은 모듈로 계속 주는 것을
  피하려고). 실행: `python3 apps/demo/e2e/positive-controls/rd-0NN.py <번호>`(번호는 파일 머리
  주석·`rd-0NN.py` 안 `CONTROLS` 딕셔너리 참고). 끝나면 드라이버가 띄운 dev 서버가 하나 남는다 —
  직접 정리한다.
- `rd-010.md`~`rd-017.md`(7개, RD-010~017 중 RD-016 제외)·`rd-019.md`(RD-019): 자동 드라이버가 아니라 수행한 변조·명령·
  결과를 손으로 기록한 절차 문서다. 재현하려면 문서에 적힌 순서(소스 변조 → `pnpm --filter demo dev`
  **재시작** → `ONLY=`로 대상 셀 실행 → 원복 → 재시작 → 전체 재통과)를 직접 따른다 — dev 재시작은
  이 경우 실행자의 몫이다(`.py` 5개와 다르다).

## 폴더 규칙

| 폴더                          | 내용                                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib.mjs`                     | 공용 하니스(화면 읽기·입력·대기·pageerror 계수·`finish()`). eslint·tsc 대상 밖(`apps/demo/eslint.config.js`의 `ignores: ["e2e/**"]`, `tsconfig.json`의 `include`가 `src`뿐) |
| `run.mjs`                     | 묶음 실행기(`baseline`\|`measure`\|`check`, 서버 관리 + 결과 대조)                                                                                                          |
| `checks/`                     | 판정 스크립트(pass/fail이 있는 확인)                                                                                                                                        |
| `measure/`                    | 측정 스크립트(판정선 있음, `e2e:baseline`·`e2e:measure`가 도는 것과 `boot-press`처럼 baseline 세트 소속인 것이 섞여 있다 — `BASELINE.md` 4절 참고)                          |
| `node/rd-0NN/`                | node 전용 통계(브라우저 미사용)                                                                                                                                             |
| `pty/rd-0NN/`                 | CPython 3.14.4 pty 기준 데이터(기대 행 스냅샷)                                                                                                                              |
| `positive-controls/`          | 양성 대조 드라이버(`.py`)·기록(`.md`)                                                                                                                                       |
| `results/`                    | 실행 결과 JSON(`.gitignore` 대상, 커밋하지 않는다)                                                                                                                          |
| `BASELINE.md`·`baseline.json` | 기준선 문서(사람용)·기계용 사본(`run.mjs`가 읽는다)                                                                                                                         |

pty 기준 데이터(`pty/rd-0NN/`)와 그 재생성 도구(`pty/tools/`)는 pnpm 스크립트가 아니다. 실행 전제·설치는 `pty/README.md`, 명령은 `pty/REGEN.md`를 본다.

## 결과 파일 규칙

`lib.mjs`의 `finish({ label = "dev", ...extra } = {})`는 stdout에 결과 JSON을 찍는 것과 별개로
`process.env.E2E_RESULTS_DIR`(기본 `apps/demo/e2e/results/`)에
`<호출 스크립트 파일명(확장자 제외)>-<label>.json`을 쓴다. `label`은 보통 `"dev"`(5173·4174 공용)·`"preview"`(4173)다. 같은 프로세스에서 같은 이름이 반복되면 `-2`·`-3` 접미가 붙는다.

`repl-check.mjs`는 dev에서 세 모드(`normal`·`cdn-blocked`·`not-isolated`)를 각각 별도 프로세스로 돌리므로
프로세스별 `-2` 접미로는 구분되지 않는다. 그래서 label에 모드를 넣어
`repl-check-<mode>-<dev|preview>.json`(예: `repl-check-normal-dev.json`)을 쓴다. 같은 스크립트를 여러 모드로
나눠 돌리는 새 스크립트도 label에 모드를 넣는다.

`run.mjs baseline`은 `SETS` 항목마다 exit code와 그 실행이 새로 만든 결과 파일을 `summary.json`의 `runs`에
기록한다. exit ≠ 0인데 새 결과 파일이 없으면(`finish()` 전 크래시 등) `failed`에
`{ file: <스크립트 경로>, name: "결과 파일 없음(exit N, <server>...)" }`로 넣어 `ok=false`가 된다.
잡지 못하는 경우 둘: exit 0인데 결과 파일이 없는 실행, 앞 `SETS` 항목과 같은 결과 파일 이름을 덮어쓴 실행(새 파일로
안 보인다). 새 스크립트를 `SETS`에 넣을 때 결과 파일 이름이 다른 항목과 겹치지 않는지 확인한다.

## 기준 인터프리터 차이

- pty 대조 기준: **CPython 3.14.4**(24×80, `TERM=xterm`).
- 브라우저에서 실제로 도는 인터프리터: **pyodide 번들 3.14.2**(패키지 버전 표기 `314.0.7`).
- 두 버전은 소스 패치 레벨이 다르다(`docs/design/10-parity-deviations.md` 편차 19) — 95케이스 대조에서
  zip 보정 뒤 파서 결과 차이는 없었지만 소스 차이 자체를 배제하지는 않는다.
- **Tab 완성 후보 집합이 다르다**(편차 18): 빈 cwd 기준 `import ` 후보가 3.14.4는 192개, pyodide는
  178개다(네이티브 전용 15개 불포함 등). `tab-check.mjs`의 판정은 이 차이를 반영한 후보 목록을 쓴다.
- 화면 지우기(Ctrl+L) 관련 편차는 편차 40·44(꼬리 든 프롬프트에서 Ctrl+L, `AD` 절, 아래).

## 함정 링크

이 폴더의 하니스·확인 스크립트를 고치거나 새로 만들 때 부딪히기 쉬운 함정(`docs/traps/`):

- `docs/traps/TRP-005` Ctrl+C는 새 프롬프트가 보인 뒤에 보내야 한다(글자는 RD-019 이후 버퍼링, 재시도하면 중복)
- `docs/traps/TRP-006` 화면 행 텍스트만 비교하면 출력 끝의 여분 빈 줄을 놓친다
- `docs/traps/TRP-007` 파일을 `git checkout`으로 되돌린 뒤 다시 변조하면 vite dev가 낡은 모듈을 계속 준다
- `docs/traps/TRP-008` "로그가 없다" 확인을 뷰포트만 훑어 하면 화면 밖으로 밀려난 로그를 놓친다
- `docs/traps/TRP-011` 출력 도착을 "화면 행에 마커 포함"으로 기다리면 입력한 코드 행이 마커를 포함해 즉시 통과한다
- `docs/traps/TRP-022` 브라우저 지연을 Node 쪽 폴링으로 재면 문턱 근처에서 5~8ms 과대 측정된다
- `docs/traps/TRP-024` 안내 줄 개수로 "다시 준비됐다"를 판정하면 여러 번 반복한 뒤 무한 대기한다

`run.mjs`(서버 관리·결과 집계) 고유 함정은 `docs/traps/INDEX.md`에서 TRP-027 이후 번호를 확인한다
(pnpm 자식 프로세스 kill이 조용히 실패하는 것, 의도된 pageerror 합산 오류 등).

## 정적 검사

eslint·tsc는 계속 `e2e/**`를 무시한다(`apps/demo/eslint.config.js`의 `ignores`, `tsconfig.json`의
`include`가 `src`뿐). `pnpm --filter demo e2e:check`가 `node --check`로 구문만 확인한다.

## 도우미(RD-012)

- `waitStatus(values, label, timeout)`: `[data-testid=status]` 텍스트가 `values` 중 하나가 될 때까지 기다린다.
- `setTopLevelAwait(on)`: top-level await 체크박스를 `on`에 맞춘다(같으면 무동작, 다르면 클릭 뒤 리셋 완료까지 기다린다).

## 도우미(RD-017, 선택 복사)

`open()`이 반환하는 핸들의 메서드가 아니라 `page`를 첫 인자로 받는 독립 함수다(`open` 자체와 같은 형태).

- `selectRows(page, fromRow, fromCol, toRow, toCol, { endOutside })`: 행·열 좌표(`.xterm-rows > div`의
  `getBoundingClientRect()`)로 마우스 드래그 선택을 만든다. `endOutside: true`면 같은 행의 y를 유지한 채
  `.xterm` 요소 오른쪽 바깥(뷰포트 안, `.xterm-screen`보다 오른쪽)에서 뗀다. mouseup이 `.xterm` 밖에서
  일어나 document 리스너 경로를 확인한다. 단, 이 좌표에서는 xterm이 열 좌표를 그 행 끝으로 **clamp**한다
  (실측) — `toCol`은 무시되고 "`fromCol`부터 그 행 끝까지"가 선택된다. "행 전체/행
  끝까지"를 확인하고 싶을 때만 써라(정확한 부분 문자열 검증에는 쓰지 마라). 터미널 위쪽으로 떼면(예: y가
  작은 값) xterm이 선택 방향을 뒤집어 드래그한 텍스트 자체가 선택에서 빠지므로 쓰지 않는다. 전제: 뷰포트
  폭이 `.xterm-screen` 오른쪽 경계보다 충분히 넓어야 한다(기본 1280×720이면 안전, 좁으면 mouseup이
  `.xterm` 안에서 일어나 document 리스너 경로가 검증되지 않는다 — `selectRows`가 이 경우 에러를 던진다).
- `dblclickCell(page, row, col)`: 해당 칸을 더블클릭한다(단어 선택).
- `readClipboard(page)`: `navigator.clipboard.readText()`.
- `seedClipboard(page, text)`: 시험 전 클립보드에 사전 값을 넣는다.
- `setCopyOnSelect(page, on)`: "선택 시 자동 복사" 체크박스를 `on`에 맞춘다(리셋이 없어 대기 없이 클릭만 한다).
- `toastText(page)`: 복사 토스트(`data-testid=copy-toast`) 텍스트, 없으면 `null`.

## 도우미(RD-019, 읽기가 없는 구간의 키)

- `typeWhenReading(text)`·`cancelWhenReading(text)`는 **재시도하지 않는다**. 활성 읽기가 없는 구간의 키는 벤더
  `Readline`이 버리지 않고 쌓았다가 다음 읽기가 시작될 때 재생하므로(RD-019 type-ahead), 에코가 없다고 첫 글자를 다시
  치면 글자가 중복된다(`x: `에 `abc` → `aabc`). 첫 글자를 한 번 치고 그 에코(재생 = 읽기 시작)를 `waitFor`한 뒤 나머지를
  친다. 취소 helper는 에코 뒤에 Ctrl+C를 누른다 — 읽기 전 Ctrl+C는 쌓이지 않고 쌓인 키를 비운 채 게이트에 막힌다.
- 실행 중·부팅 중에 친 키가 "다음 프롬프트에 그대로 들어온다"는 판정은 `checks/type-ahead-check.mjs`(T01~T12)가 한다.
- 실행 중(읽기 없음)에는 `paste()`를 쓸 수 없다: 붙여넣기 뒤 화면이 바뀔 때까지(1.5초 두 번) 기다리다 시간 초과로 던진다. `type-ahead-check.mjs`의 `pasteSilently`처럼 `.xterm-helper-textarea`에 `ClipboardEvent("paste")`를 직접 dispatch한다. 여러 줄 붙여넣기는 첫 줄이 `>>> …`, 둘째 줄은 `... ` 접두 없이 그려지고 커서가 마지막 줄 끝에 있다.
- 결과 JSON 이름은 `<스크립트>-<label>.json`이고 `-2` 접미 카운터는 프로세스 안에서만 센다. 같은 `E2E_RESULTS_DIR`로 전 셀을 돌린 뒤 `ONLY=`로 다시 돌리면 전 셀 결과가 덮어써진다. 근거 JSON을 남길 때는 실행마다 `E2E_RESULTS_DIR`을 다르게 준다.

## 앞으로 새 RD를 추가할 때(RD-018부터)

- 새 브라우저 확인 스크립트는 처음부터 `apps/demo/e2e/checks/`(또는 `measure/`)에 쓰고 작업 브랜치에
  커밋한다.
- 완료 조건 "기준선과 같다"는 변경 영역 개별 스크립트 통과 + 기대값이 바뀐 행의 `BASELINE.md`·`baseline.json`
  갱신이다. 전체 `e2e:baseline` 대조는 사용자가 지시할 때 한다.
- 변이 검사 기록(`mutate-safe.mjs` 류)·`positive-controls.md`(수행 기록)·`results/`(실행 로그)는 저장소에
  커밋하지 않는다(일회성 근거 기록, 저장소 코드가 아니다).
