# TRP-076 core 소스 주석에 동기 브리지 라이브러리 이름을 쓰면 check-dist가 실패한다

- 상태: ACTIVE
- 적용 조건: `packages/pyodide-core/src`의 주석·문서 주석을 추가·수정하는 커밋(`docs:`·`refactor:` 포함).

## 오해하기 쉬운 신호

- 주석만 바꾼 커밋이라 시험·빌드와 무관해 보인다. 패키지 단독 `pnpm test`(vitest)는 통과한다.
- 루트 `pnpm test`(`turbo run test check-dist`)가 `check-dist` 단계에서 중단한다. 다른 작업의 L0 전체 시험에서 처음 보이면 그 작업의 실패로 오판한다.

## 원인

- `scripts/check-dist.mjs`의 `FORBIDDEN`(`coincident`, `reflected-ffi`)이 dist의 모든 파일(`.d.ts`, 소스맵 `.map`, 번들 주석 포함)에서 대소문자 구분 없이 문자열을 찾는다. 소스 주석은 d.ts·소스맵·번들에 그대로 실려 검사 대상이 된다.
- core는 동기 브리지 라이브러리를 의존하지 않는다는 규칙(ADR-0001)이라 `--allow-sync-bridge`(dom-bridge 전용) 없이 검사한다.

## 탐지/회피

- core 소스 주석에는 라이브러리 이름 대신 일반어("동기 브리지")를 쓴다.
- core를 바꾼 뒤(주석만이어도) `pnpm --filter @cp949/runo-pyodide-core build && pnpm --filter @cp949/runo-pyodide-core check-dist`를 실행한다.
- 이름이 필요한 설명은 `docs/`나 dom-bridge 패키지에 쓴다.
