# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (freeform — e.g. `open` / `in-progress` / `done`; this repo doesn't have the `triage` skill installed, so no canonical role labels apply)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## 등록·분류 기준 (2026-09-24 사용자 확정)

후속 이슈가 조사 → 새 이슈로 끝없이 이어지는 것을 막는다. 등록 전에 아래 기준으로 `Status`를 정한다.

`Status` 값: `open`(착수 대상) · `deferred`(기록만, 재개 조건 명시) · `done` · `wontfix`(사유 명시) · `promoted (RD-NNN)`(ROADMAP RD로 승격, 이후 추적은 RD).

`open`으로 등록할 수 있는 것:

1. 제품 결함·기능 — **재현 가능한 사용자 시나리오**와 **관찰 가능한 완료 기준**이 둘 다 있을 때
   (`ROADMAP.md` "후속 후보 등록 규칙"과 같은 기준).
2. 테스트 도구 결함 — 다음 중 하나가 **실측으로** 확인됐을 때:
   - 결함 없는 코드에서 L1 스크립트나 L2 판정이 실패한다(거짓 실패 재현).
   - 결함을 넣어도 통과한다(양성 대조로 검출력 상실 확인).

`deferred`로 등록하는 것(원인 조사를 시작하지 않는다):

- 1회만 관찰됐거나 원인 불명인 간헐 실패. 원시 로그 위치와 재개 조건(예: "단독 실행 N=10에서 1회 이상
  재현")을 적는다.
- 코드 읽기로만 추정한 테스트 도구 문제(거짓 결과를 아직 관찰하지 않음).
- 측정값이 참고값에서 벗어난 것 — 성능 수치는 판정이 아니다(`docs/design/09-testing.md` 9.7).

등록하지 않는 것:

- 규칙 한 줄로 흡수되는 것 → 해당 규칙 문서(`docs/design/09-testing.md`, `apps/demo/e2e/README.md` 등)에 추가한다.
- 등록 편차·범위 밖(`docs/design/10-parity-deviations.md`).

재개: `deferred` 이슈의 재개 조건이 충족되면 `open`으로 바꾸고 `## Comments`에 근거(로그 경로·수치)를 남긴다.
재분류할 때도 사유를 `## Comments`에 한 줄 남긴다.

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
