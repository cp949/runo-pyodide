# TRP-035 변이한 `package.json`에서 `pnpm exec`·`pnpm run`은 자동으로 install해 "설치되지 않은 경우" 검사가 불가능해진다

- 상태: ACTIVE
- 적용 조건: 의존 변이 검사를 위해 `package.json`의 `dependencies`에 금지 의존(예: `coincident`)을 넣은 뒤 `pnpm exec vitest`·`pnpm --filter … test`로 시험을 돌릴 때. pnpm 11의 `verifyDepsBeforeRun` 기본 동작이다.

## 오해하기 쉬운 신호

- 출력에 `Lockfile passes supply-chain policies` 같은 install 문구가 끼고, 시험은 "설치된 경우"로 실패한다. "설치되지 않은 경우"의 통과·실패는 확인하지 못한 채 변이가 죽었다고 읽기 쉽다.
- 원복(`git checkout`)해도 `node_modules/.pnpm/coincident@<버전>`이 남는다. 이후 `node_modules`에 금지 이름이 실제로 있어 정상 상태의 시험이 실패하거나 검사 자체가 무의미해진다.
- `pnpm-lock.yaml`은 바뀌지 않아 `git status`로는 잔재가 보이지 않는다.

## 원인

pnpm 11은 `pnpm exec`·`pnpm run` 앞에 `package.json`과 `node_modules`가 어긋나면 install을 먼저 한다. 변이한 의존이 레지스트리에서 설치된다.

## 탐지/회피

- 변이 검사는 패키지 디렉터리에서 vitest 바이너리를 직접 돌린다.

  ```bash
  cd packages/pyodide-repl && ./node_modules/.bin/vitest run src/package-boundary.test.ts
  ```

- 이미 잔재가 남았으면 지우고 복구한 뒤 확인한다.

  ```bash
  rm -rf node_modules/.pnpm/coincident@<버전>
  pnpm install --frozen-lockfile
  ls node_modules/.pnpm | grep coincident   # 출력 없음이어야 한다
  ```
