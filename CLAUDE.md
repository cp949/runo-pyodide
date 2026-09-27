## Agent skills

### Issue tracker

이슈는 `.scratch/<feature-slug>/` 아래 로컬 마크다운 파일로 관리한다. See `docs/agents/issue-tracker.md`.

### Domain docs

멀티 컨텍스트 — 앱/패키지별 `CONTEXT.md`를 루트 `CONTEXT-MAP.md`가 가리킨다. See `docs/agents/domain.md`.

### 작업 실행 (rubber-workflow)

브레인스토밍으로 확정한 작업이나 `ROADMAP.md`의 RD 항목 하나를 실행할 때는
rubber-workflow(DELTA 단위, 탄력적 추가, `dev` 브랜치 + 재그룹화 병합)를 따른다. See
`docs/agents/rubber-workflow.md`.

### e2e·반복 측정 최소화

검증은 L0(`pnpm test` 등 브라우저 없음)·L1(변경 영역 개별 e2e 스크립트, `ONLY=`·`N=` 축소)·L2(전체
`e2e:baseline`, 약 8분 이상)·L3(`e2e:measure`·node 통계·반복 측정)로 나눈다. **L2·L3은 사용자가 지시할 때만
돌린다** — 자동으로 진행하지 않는다. RD·이슈 완료는 L0 + L1로 판정한다. 계획 단계에서 L1 스크립트·횟수를 적고,
넘으면 실행 전 사용자 확인. See `docs/agents/rubber-workflow.md` "검증 실행 예산".

e2e 스크립트의 시간 판정(고정 대기·ms 상한)은 `docs/design/09-testing.md` 9.7, 이슈 등록·`Status`
분류는 `docs/agents/issue-tracker.md` "등록·분류 기준"을 따른다.

### 설계 문서

`DESIGN.md`가 색인이다. RD 항목을 시작하기 전에 `DESIGN.md`의 읽기 순서를 따라
`docs/design/00-architecture.md`, `01-protocols.md`, 해당 기능 절을 읽는다. 결정 기록은
`docs/adr/`, 용어는 `CONTEXT-MAP.md`. 이전 구현(`/work/cp949/pyodide-samples/apps/repl`)은
읽기 전용 참고이며 coincident 동기 브리지는 쓰지 않는다(ADR-0001).
