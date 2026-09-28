# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.
Repo: `cp949/runo-pyodide` (public) — `gh`가 `git remote`로 자동 추론한다.

## Conventions

- **이슈 생성**: `gh issue create --title "..." --body "..."` (여러 줄 본문은 heredoc)
- **이슈 조회**: `gh issue view <number> --comments`
- **이슈 목록**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` — 필요시 `--label`·`--state` 필터
- **코멘트**: `gh issue comment <number> --body "..."`
- **라벨 적용/제거**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **닫기**: `gh issue close <number> --reason completed --comment "..."` (완료가 아니면 `--reason "not planned"`)

## 상태 라벨

기존 로컬 마크다운 트래커의 `Status:` 줄을 GitHub의 open/close 상태 + 라벨로 옮긴다.

| Status (구)                         | GitHub 표현                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `open` (착수 대상)                  | 이슈 open, 라벨 없음                                                                                          |
| `deferred` (기록만, 재개 조건 명시) | 이슈 open 유지 + `deferred` 라벨. 재개 조건은 본문 또는 코멘트에 명시                                         |
| `done`                              | `gh issue close <n> --reason completed`                                                                       |
| `wontfix` (사유 명시)               | `wontfix` 라벨 적용 + `gh issue close <n> --reason "not planned" --comment "<사유>"`                          |
| `promoted (RD-NNN)`                 | `promoted` 라벨 적용 + `gh issue close <n> --reason completed --comment "Promoted to RD-NNN"`. 이후 추적은 RD |

`deferred`·`promoted` 라벨은 이 저장소 전용(`gh label create deferred ...` / `gh label create promoted ...`로
생성해둔다). `wontfix`는 GitHub 기본 라벨을 그대로 쓴다.

재개: `deferred` 라벨이 붙은 이슈의 재개 조건이 충족되면 라벨을 제거하고 `gh issue comment`로 근거(로그
경로·수치)를 남긴다. 재분류할 때도 사유를 코멘트로 남긴다.

## 등록·분류 기준 (2026-09-24 사용자 확정)

후속 이슈가 조사 → 새 이슈로 끝없이 이어지는 것을 막는다. 등록 전에 아래 기준으로 상태(open 유지 /
`deferred` 라벨 / 등록 안 함)를 정한다.

open으로 등록할 수 있는 것:

1. 제품 결함·기능 — **재현 가능한 사용자 시나리오**와 **관찰 가능한 완료 기준**이 둘 다 있을 때
   (`ROADMAP.md` "후속 후보 등록 규칙"과 같은 기준).
2. 테스트 도구 결함 — 다음 중 하나가 **실측으로** 확인됐을 때:
   - 결함 없는 코드에서 L1 스크립트나 L2 판정이 실패한다(거짓 실패 재현).
   - 결함을 넣어도 통과한다(양성 대조로 검출력 상실 확인).

`deferred` 라벨로 등록하는 것(원인 조사를 시작하지 않는다):

- 1회만 관찰됐거나 원인 불명인 간헐 실패. 원시 로그 위치와 재개 조건(예: "단독 실행 N=10에서 1회 이상
  재현")을 본문에 적는다.
- 코드 읽기로만 추정한 테스트 도구 문제(거짓 결과를 아직 관찰하지 않음).
- 측정값이 참고값에서 벗어난 것 — 성능 수치는 판정이 아니다(`docs/design/09-testing.md` 9.7).

등록하지 않는 것:

- 규칙 한 줄로 흡수되는 것 → 해당 규칙 문서(`docs/design/09-testing.md`, `apps/demo/e2e/README.md` 등)에 추가한다.
- 등록 편차·범위 밖(`docs/design/10-parity-deviations.md`).

## Pull requests as a triage surface

**PRs as a request surface: no.** _(`yes`로 바꾸면 외부 PR도 이슈와 같은 라벨·상태를 쓴다; `/triage`가 이 값을
읽는다.)_

## When a skill says "publish to the issue tracker"

`gh issue create`로 GitHub 이슈를 만든다.

## When a skill says "fetch the relevant ticket"

`gh issue view <number> --comments`를 실행한다. 사용자가 보통 번호나 URL을 직접 전달한다.

## Wayfinding operations

`/wayfinder`가 쓴다. **map**은 하나의 이슈, **child**는 그 이슈의 티켓들이다.

- **Map**: `wayfinder:map` 라벨을 단 이슈 하나(Notes / Decisions-so-far / Fog 본문). `gh issue create --label wayfinder:map`.
- **Child ticket**: map에 GitHub sub-issue로 연결된 이슈(`gh api`의 sub-issues 엔드포인트). sub-issue를 못
  쓰면 map 본문의 task list에 추가하고 child 본문 맨 위에 `Part of #<map>`을 적는다. 라벨은
  `wayfinder:<type>`(`research`/`prototype`/`grilling`/`task`). claim되면 담당자를 배정한다.
- **Blocking**: GitHub 네이티브 issue dependencies. `gh api --method POST
repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>` (`<blocker-db-id>`는
  `gh api repos/<owner>/<repo>/issues/<n> --jq .id`로 구한 숫자 database id, `#번호`나 `node_id`가 아니다).
  `issue_dependencies_summary.blocked_by`(open 상태 blocker 수)로 확인한다. 안 되면 child 본문 위쪽
  `Blocked by: #<n>, #<n>` 줄로 대체한다. 모든 blocker가 close되면 unblocked.
- **Frontier**: map의 open child 중 blocker 없고(`issue_dependencies_summary.blocked_by == 0`, 또는
  `Blocked by` 줄의 이슈가 모두 close) assignee 없는 것. map 순서상 먼저 나온 것이 우선.
- **Claim**: `gh issue edit <n> --add-assignee @me` — 세션의 첫 write.
- **Resolve**: `gh issue comment <n> --body "<answer>"` → `gh issue close <n> --reason completed` → map의
  Decisions-so-far에 근거(요지 + 링크) 추가.
