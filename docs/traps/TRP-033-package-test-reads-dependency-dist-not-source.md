# TRP-033 패키지 단독 시험은 의존 패키지의 `dist`를 읽고, 자기 `dist`는 빌드되지 않는다

- 상태: ACTIVE
- 적용 조건: (a) core 소스(`packages/pyodide-core/src`)를 고친 뒤 repl 시험을 `pnpm --filter @cp949/runo-pyodide-repl test` 또는 `packages/pyodide-repl`의 `vitest`로 직접 돌릴 때. (b) 패키지 시험이 자기 `dist`를 읽을 때(산출물 검사 등).

## 오해하기 쉬운 신호

- (a) 시험이 통과하거나 실패한다. 통과·실패 어느 쪽도 "낡은 core로 돌았다"는 표시가 없다. 방금 고친 core 코드가 시험에 반영됐다고 믿기 쉽다.
- (b) `dist`가 없으면 시험이 "파일 없음"으로 실패하고, 이전 빌드가 남아 있으면 낡은 산출물을 통과시킨다. `dist`는 gitignore라 turbo 입력 해시에 들지 않으므로 `cache`가 켜져 있으면 변조·빌드 누락을 가린다.
- 루트 `pnpm test`는 항상 최신으로 돌아서 "루트에서는 통과하는데 패키지 단독으로는 다르다"가 재현된다.

## 원인

- `@cp949/runo-pyodide-core`의 `exports`는 `development` 조건(`./src/*.ts`)과 `default`(`./dist/*.mjs`)를 둔다. vitest·`tsc` 기본 해석에는 `development` 조건이 없어 repl 시험은 `dist`를 읽는다. core를 다시 빌드하지 않으면 옛 산출물이다.
- `turbo.json`의 `test`는 `dependsOn: ["^build"]`(의존 패키지의 빌드)뿐이다. 자기 패키지 `build`에는 의존하지 않는다. 의존시키면 demo(vite)까지 매번 빌드되어 비용이 크다.
- 시험 전용 역할 스크립트(`packages/pyodide-core/src/test/roles/*`)는 `dist`가 아니라 소스 경로를 직접 가리키므로 이 영향이 없다.

## 탐지/회피

- 패키지 단독 시험 전에 의존 패키지를 빌드한다.

  ```bash
  pnpm --filter @cp949/runo-pyodide-core build
  cd packages/pyodide-repl && pnpm exec vitest run <파일 일부 이름>
  ```

- 자기 `dist`를 검사하는 것은 시험이 아니라 별도 태스크로 둔다(`turbo.json`의 `check-dist`: `dependsOn: ["build"]`, `cache: false`, 루트 `pnpm test`가 함께 실행, 단독은 `pnpm check-dist`).
- 진입점 시험에서 `vi.mock`이 안 걸리는 경우도 같은 뿌리다. repl 시험이 core `dist`를 import하면 `dist/worker.mjs` 안에서 `bootWorker`가 이미 묶여 있어 mock 대상이 아니다. 진입점 시험은 진입점과 같은 패키지(core, 소스 import)에 둔다.

## 정정(2026-09-24 실측)

(a)의 "repl 시험은 `dist`를 읽는다"는 vitest 5.0.1 단독 실행에서는 성립하지 않았다. core `dist` 폴더를 치운 채 `packages/pyodide-repl`에서 `npx vitest run src/index.test.ts src/worker/boot.test.ts`를 돌려도 2파일 162건이 통과했다(vitest가 `development` 조건으로 core 소스를 읽는다). 반대로 core 소스를 고치면 `pnpm build` 없이도 repl 시험에 반영됐다. `tsc`(`check-types`)와 `dist`를 직접 읽는 시험(산출물 검사)의 해석은 이 실측 대상이 아니다. 그러므로 (a)의 "빌드 뒤에 돌린다"는 회피는 무해하지만 vitest에서는 필요 조건이 아니고, "통과·실패가 낡은 core를 뜻한다"는 신호 설명은 vitest 단독 실행에는 해당하지 않는다. (b)는 이 실측과 무관하다.
