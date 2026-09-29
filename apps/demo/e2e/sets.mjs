// RD-044: `run.mjs`가 도는 스크립트 목록(`SETS`·`MEASURE_SET`)과 서버 URL 상수를 여기로 분리했다.
// `run.mjs`는 파일 끝에서 `process.argv[2]`로 subcommand를 곧바로 실행하는 CLI라 그 파일을 import하면
// CLI가 함께 돌아버린다 — `registry.test.mjs`가 `SETS`만 읽으려면 이 분리가 필요하다
// (`docs/design/09-testing.md` 9.6.5).

export const DEV_URL = "http://localhost:5173";
export const PREVIEW_URL = "http://localhost:4173";
export const STATIC_URL = "http://localhost:4174";

/**
 * `baseline`이 순차로 돌릴 스크립트 목록. 항목 하나 = `{ file, args?, server, only? }`.
 * `file`은 `e2eDir` 기준 경로, `args`는 URL(들) 앞에 붙는 위치 인자(`repl-check`의 모드 등, 기본 빈 배열),
 * `server`는 `dev`·`preview`·`static`(`SERVER_URLS`의 키, url을 결정한다) 또는 `dev+preview`(아래),
 * `only`가 있으면 `ONLY=` 환경변수로 넘겨 그 접두어의 확인만 돌린다(부분 preview 재실행용).
 *
 * `args`가 있는 항목(mode 스크립트, `repl-check`·`runner-check`)은 `server: "dev+preview"`를 쓰지 않는다
 * — `check-runner.mjs`의 `parseArgs`가 mode 경로에서 `previewUrl`을 항상 `undefined`로 고정하기 때문에
 * (K1, "모양 B"는 preview 개념이 없다는 설계 전제) 이 조합이 오면 `run.mjs`의 `runOneScript`가 만드는
 * `[...args, DEV_URL, PREVIEW_URL]` argv에서 `PREVIEW_URL`이 스크립트의 `rest[0]`(예: repl-check의
 * screenshot 경로)로 잘못 흘러든다. `registry.test.mjs`가 이 조합을 L0에서 막는다(양성 대조 포함).
 *
 * RD-018: RD-005~008 판정 스크립트 9종. dev는 전부, preview는 각 RD 인계 기록이 남긴 부분
 * 집합만(`carryover`·`prompt-join`·`trailing-newline`은 preview 실행 없음 — RD-005 인계 기록 근거).
 * `not-isolated`는 4174(static, 헤더 없는 정적 서버)에 대해 돌지만 label은 dev로 잡힌다(4173이 아닌
 * 모든 URL은 dev) — 이 SETS의 `server: "static"`과는 별개로, 결과 파일
 * label은 각 스크립트가 자기 url을 보고 스스로 정한다. `repl-check`는 세 모드가 별도 프로세스라 label에
 * 모드를 넣어 `repl-check-<모드>-<dev|preview>.json`으로 나눠 쓴다(같은 이름이면 마지막 모드만 남는다).
 *
 * RD-018/RD-044: RD-010~017 판정 스크립트 7종. 이 스크립트들은 (위 9종과
 * 달리) dev·preview를 **한 프로세스 안에서** 이어 돈다 — `server: "dev+preview"`면 `runOneScript`가
 * `[...args, DEV_URL, <preview 서버 url>]`(진입 규약 K1, `check-runner.mjs`의 `checkEntry`가 읽는다)로 argv를
 * 만든다. preview 몫 ONLY는 각 스크립트가 선언한 목록과 사용자 ONLY의 교집합이다(K6, `runDevPreview`가
 * 계산·복원한다). 그래서 SETS 항목 하나가 dev·preview 결과 파일을 모두 만든다(같은 프로세스, label만
 * 다르다 — `lib.mjs`의 `-2`/`-3` 접미 카운터와 무관, 파일 분리를 실측 확인했다).
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
  // RD-018/RD-044: RD-010~017 판정 스크립트 7종(한 프로세스에서 dev+preview를 모두 만든다)
  { file: "checks/session-reset-check.mjs", server: "dev+preview" },
  { file: "checks/multiline-check.mjs", server: "dev+preview" },
  { file: "checks/tla-check.mjs", server: "dev+preview" },
  { file: "checks/auto-indent-check.mjs", server: "dev+preview" },
  { file: "checks/block-history-check.mjs", server: "dev+preview" },
  { file: "checks/tab-check.mjs", server: "dev+preview" },
  { file: "checks/selection-copy-check.mjs", server: "dev+preview" },
  // RD-019: 읽기가 없는 구간 키 버퍼링(type-ahead). dev 전용(preview 재실행 없음).
  { file: "checks/type-ahead-check.mjs", server: "dev" },
  // RD-048: 빈 입력줄 Ctrl+D를 EOF로(REPL `>>>` 세션 종료, `input()`·`sys.stdin` EOFError/루프 종료, 실행창 EOFError). dev 전용.
  { file: "checks/ctrl-d-check.mjs", server: "dev" },
  // RD-022: 실행창(`?view=runner`, `createTerminalRunner`). normal은 dev, not-isolated는 4174 헤더 없는 정적 서버(`repl-check`와 같은 규칙).
  // 결과 파일 label에 모드가 들어가 `runner-check-normal-dev.json`·`runner-check-not-isolated-dev.json`으로 나뉜다.
  { file: "checks/runner-check.mjs", args: ["normal"], server: "dev" },
  { file: "checks/runner-check.mjs", args: ["not-isolated"], server: "static" },
  // RD-022a: REPL `runSource(code)`(REPL 화면의 `source`·`run-source`·`source-result` 요소). dev 전용(preview 재실행 없음).
  // 결과 파일은 `run-source-check-dev.json`(label은 스크립트가 url 포트로 정한다).
  { file: "checks/run-source-check.mjs", server: "dev" },
  // RD-022b: 열린 읽기 위 배경 출력 조율(REPL 화면). dev 전용(preview 재실행 없음).
  { file: "checks/bg-output-check.mjs", server: "dev" },
  // RD-049: completion popover(`?completionPopover=1`, DOM role=listbox) 키·마우스·닫기 신호. dev 전용(preview 재실행 없음).
  { file: "checks/completion-popover-check.mjs", server: "dev" },
  // RD-024: `@cp949/runo-pyodide-repl-react` 컴포넌트 확인. StrictMode worker 수(dev 서버의 `<StrictMode>` 필요)·`?fit=1` 리사이즈. dev 전용.
  // 각 스크립트가 화면 두 개(REPL·`?view=runner`)를 새 브라우저로 열어 결과 파일을 `-repl-dev`·`-runner-dev`로 나눠 쓴다.
  { file: "checks/react-strictmode-check.mjs", server: "dev" },
  { file: "checks/react-fit-check.mjs", server: "dev" },
  // RD-023: dom-bridge 실행창(`?view=dom-bridge`) S1~S7·`?native=0`·늦은 import 양성 대조. dev 전용(StrictMode·dev 서버의 worker 파일 서빙 필요).
  // 스크립트가 페이지 7개를 새 브라우저로 열어 결과 파일을 `dom-bridge-check-<label>.json`(label = plain|slow|core|native0g|native0|late|runlate, `-dev` 접미 없음)으로 나눠 쓴다.
  { file: "checks/dom-bridge-check.mjs", server: "dev" },
  // RD-018: 부팅 중 Ctrl+C 판정(N=30 기본값, boot-press.mjs는 measure/ 소속 파일이지만 baseline 세트다)
  { file: "measure/boot-press.mjs", server: "dev" },
];

/**
 * `measure`가 순차로 돌릴 스크립트 목록(RD-018). `boot-press.mjs`는 `baseline` 세트 소속(N=30, 판정)이라
 * 여기 없다 — SETS에 배선돼 있다. 나머지 5종은 dev에서만 돈다(measure는 preview 부분집합이 없다). 판정선은
 * 각 스크립트 안에 있고 이 실행기는 exit code만 본다(baseline의 `writeSummary()`처럼 결과 JSON을 대조하지 않는다 —
 * 측정값은 판정 대상이 아니라 기록이기 때문).
 */
export const MEASURE_SET = [
  { file: "measure/keys-after-enter-probe.mjs", server: "dev" },
  { file: "measure/press-loss.mjs", server: "dev" },
  { file: "measure/burst-matrix.mjs", server: "dev" },
  { file: "measure/input-burst-matrix.mjs", server: "dev" },
  { file: "measure/sleep-await-check.mjs", server: "dev" },
];
