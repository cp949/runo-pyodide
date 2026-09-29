// RD-044: `run.mjs`가 도는 스크립트 목록(`SETS`·`MEASURE_SET`)과 서버 URL 상수.
// `run.mjs`는 파일 끝에서 `process.argv[2]`로 하위 명령을 바로 실행하는 CLI다.
// import하면 CLI가 함께 돈다. `registry.test.mjs`가 `SETS`만 읽으려면 이 분리가 필요하다(`docs/design/09-testing.md` 9.6.5).

/** dev 서버 URL. */
export const DEV_URL = "http://localhost:5173";
/** preview 서버 URL. */
export const PREVIEW_URL = "http://localhost:4173";
/** 교차출처 격리 헤더가 없는 정적 서버 URL. */
export const STATIC_URL = "http://localhost:4174";

/**
 * `baseline`이 순차로 돌릴 스크립트 목록. 항목은 `{ file, args?, server, only? }`다.
 * - `file`: `e2eDir` 기준 경로.
 * - `args`: URL 앞에 붙는 위치 인자. 기본 빈 배열. `repl-check`의 모드 같은 것이다.
 * - `server`: `dev`·`preview`·`static`(`SERVER_URLS`의 키, URL을 정한다) 또는 `dev+preview`.
 * - `only`: `ONLY=` 환경변수로 넘긴다. 그 접두어의 확인만 돈다. preview 부분 재실행용이다.
 *
 * `args`가 있는 항목(mode 스크립트: `repl-check`·`runner-check`)은 `server: "dev+preview"`를 쓰지 않는다.
 * - `check-runner.mjs`의 `parseArgs`는 mode 경로에서 `previewUrl`을 항상 `undefined`로 둔다(K1). mode 스크립트에 preview 개념이 없다.
 * - 이 조합이면 `runOneScript`가 `[...args, DEV_URL, PREVIEW_URL]`을 만든다.
 * - `PREVIEW_URL`이 스크립트의 `rest[0]`(예: `repl-check`의 screenshot 경로)로 잘못 흘러든다.
 * - `registry.test.mjs`가 이 조합을 L0에서 막는다(양성 대조 포함).
 *
 * RD-018: RD-005~008 판정 스크립트 9종.
 * - dev는 전부 돈다.
 * - preview는 각 RD 인계 기록이 남긴 부분 집합만 돈다.
 * - `carryover`·`prompt-join`·`trailing-newline`은 preview를 돌리지 않는다(RD-005 인계 기록).
 * - 결과 파일 label은 각 스크립트가 자기 URL을 보고 정한다. 4173이 아닌 모든 URL은 `dev`다.
 * - 그래서 `not-isolated`(4174)도 label은 `dev`다. `server: "static"`과는 별개다.
 * - `repl-check`는 세 모드가 별도 프로세스다. label에 모드를 넣어 `repl-check-<모드>-<dev|preview>.json`으로 나눠 쓴다. 안 나누면 마지막 모드만 남는다.
 *
 * RD-018·RD-044: RD-010~017 판정 스크립트 7종.
 * - 위 9종과 달리 dev·preview를 한 프로세스 안에서 이어 돈다.
 * - `server: "dev+preview"`면 `runOneScript`가 `[...args, DEV_URL, <preview URL>]`을 만든다. 진입 규약 K1이고 `checkEntry`가 읽는다.
 * - preview 몫 ONLY는 스크립트가 선언한 목록과 사용자 ONLY의 교집합이다. `runDevPreview`가 계산하고 복원한다(K6).
 * - 그래서 항목 하나가 dev·preview 결과 파일을 모두 만든다. label만 다르다.
 * - `lib.mjs`의 `-2`·`-3` 접미 카운터와 무관하다. 파일이 분리됨을 실측으로 확인했다.
 */
export const SETS = [
  // dev 전부
  { file: "checks/repl-check.mjs", args: ["normal"], server: "dev" },
  { file: "checks/repl-check.mjs", args: ["cdn-blocked"], server: "dev" },
  { file: "checks/repl-check.mjs", args: ["not-isolated"], server: "static" },
  { file: "checks/prompt-join-check.mjs", server: "dev" },
  { file: "checks/trailing-newline-check.mjs", server: "dev" },
  { file: "checks/carryover-check.mjs", server: "dev" },
  { file: "checks/stdin-input-check.mjs", server: "dev" },
  { file: "checks/bg-input-guard-probe.mjs", server: "dev" },
  { file: "checks/ctrl-c-check.mjs", server: "dev" },
  { file: "checks/prompt-cancel-check.mjs", server: "dev" },
  { file: "checks/input-cancel-check.mjs", server: "dev" },
  // preview 부분 집합(각 RD 인계 기록)
  { file: "checks/repl-check.mjs", args: ["normal"], server: "preview" },
  { file: "checks/stdin-input-check.mjs", server: "preview", only: "RM1,L1,O1,M1,M2,O2,TICK" },
  { file: "checks/bg-input-guard-probe.mjs", server: "preview" },
  { file: "checks/ctrl-c-check.mjs", server: "preview" },
  { file: "checks/prompt-cancel-check.mjs", server: "preview", only: "RM1,B0" },
  { file: "checks/input-cancel-check.mjs", server: "preview", only: "RM2,EC" },
  // RD-018·RD-044: RD-010~017 판정 스크립트 7종. 한 프로세스가 dev·preview 결과를 모두 만든다.
  { file: "checks/session-reset-check.mjs", server: "dev+preview" },
  { file: "checks/multiline-check.mjs", server: "dev+preview" },
  { file: "checks/tla-check.mjs", server: "dev+preview" },
  { file: "checks/auto-indent-check.mjs", server: "dev+preview" },
  { file: "checks/block-history-check.mjs", server: "dev+preview" },
  { file: "checks/tab-check.mjs", server: "dev+preview" },
  { file: "checks/selection-copy-check.mjs", server: "dev+preview" },
  // RD-019: 읽기가 없는 구간의 키 버퍼링(type-ahead). dev 전용.
  { file: "checks/type-ahead-check.mjs", server: "dev" },
  // RD-048: 빈 입력줄의 Ctrl+D를 EOF로 처리한다. dev 전용.
  // 범위: REPL `>>>` 세션 종료, `input()`·`sys.stdin`의 EOFError·루프 종료, 실행창 EOFError.
  { file: "checks/ctrl-d-check.mjs", server: "dev" },
  // RD-022: 실행창(`?view=runner`, `createTerminalRunner`). normal은 dev, not-isolated는 4174 정적 서버다(`repl-check`와 같은 규칙).
  // 결과 파일 label에 모드가 들어간다. `runner-check-normal-dev.json`·`runner-check-not-isolated-dev.json`이 된다.
  { file: "checks/runner-check.mjs", args: ["normal"], server: "dev" },
  { file: "checks/runner-check.mjs", args: ["not-isolated"], server: "static" },
  // RD-022a: REPL `runSource(code)`. REPL 화면의 `source`·`run-source`·`source-result` 요소를 쓴다. dev 전용.
  // 결과 파일은 `run-source-check-dev.json`이다. label은 스크립트가 URL 포트로 정한다.
  { file: "checks/run-source-check.mjs", server: "dev" },
  // RD-022b: 열린 읽기 위의 배경 출력 조율(REPL 화면). dev 전용.
  { file: "checks/bg-output-check.mjs", server: "dev" },
  // RD-049: completion popover(`?completionPopover=1`, DOM role=listbox)의 키·마우스·닫기 신호. dev 전용.
  { file: "checks/completion-popover-check.mjs", server: "dev" },
  // RD-024: `@cp949/runo-pyodide-repl-react` 컴포넌트 확인. dev 전용.
  // - StrictMode worker 수. dev 서버의 `<StrictMode>`가 필요하다.
  // - `?fit=1` 리사이즈.
  // 각 스크립트가 화면 두 개(REPL·`?view=runner`)를 새 브라우저로 연다. 결과 파일은 `-repl-dev`·`-runner-dev`로 나눠 쓴다.
  { file: "checks/react-strictmode-check.mjs", server: "dev" },
  { file: "checks/react-fit-check.mjs", server: "dev" },
  // RD-023: dom-bridge 실행창(`?view=dom-bridge`)의 S1~S7·`?native=0`·늦은 import 양성 대조. dev 전용.
  // StrictMode와 dev 서버의 worker 파일 서빙이 필요하다.
  // 스크립트가 페이지 7개를 새 브라우저로 연다. 결과 파일은 `dom-bridge-check-<label>.json`이다.
  // label은 plain|slow|core|native0g|native0|late|runlate이고 `-dev` 접미가 없다.
  { file: "checks/dom-bridge-check.mjs", server: "dev" },
  // RD-018: 부팅 중 Ctrl+C 판정(N=30 기본값). 파일은 `measure/`에 있지만 baseline 세트다.
  { file: "measure/boot-press.mjs", server: "dev" },
];

/**
 * `measure`가 순차로 돌릴 스크립트 목록(RD-018).
 * - `boot-press.mjs`는 `SETS`에 있다(N=30, 판정). 여기에는 없다.
 * - 나머지 5종은 dev에서만 돈다. measure에는 preview 부분 집합이 없다.
 * - 판정선은 각 스크립트 안에 있다. 이 실행기는 exit code만 본다.
 * - `baseline`의 `writeSummary()`처럼 결과 JSON을 대조하지 않는다. 측정값은 판정이 아니라 기록이다.
 */
export const MEASURE_SET = [
  { file: "measure/keys-after-enter-probe.mjs", server: "dev" },
  { file: "measure/press-loss.mjs", server: "dev" },
  { file: "measure/burst-matrix.mjs", server: "dev" },
  { file: "measure/input-burst-matrix.mjs", server: "dev" },
  { file: "measure/sleep-await-check.mjs", server: "dev" },
];
