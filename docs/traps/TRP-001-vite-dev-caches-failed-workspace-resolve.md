# TRP-001 vite dev가 워크스페이스 서브패스의 해석 실패를 캐시한다

- 상태: ACTIVE
- 적용 조건: 패키지 `exports`가 `dist`만 가리키는 상태로 `dist` 없이(클린 체크아웃) `pnpm dev`를 처음 띄울 때. 새 패키지나 새 서브패스를 추가하면서 `development` 조건을 빠뜨렸을 때 다시 해당한다.

## 오해하기 쉬운 신호

- `vite ready in 109 ms`와 `Local: http://localhost:5173/`이 정상으로 찍힌다. `/`와 `/src/App.tsx`도 200이다.
- 패키지의 `tsdown --watch`가 몇 초 뒤 `dist`를 만들어 디스크에는 파일이 있다. `/@fs/.../dist/worker.mjs`를 직접 요청해도 200이다.
- 실패는 `/src/repl.worker.ts`(500, `Failed to resolve import "@cp949/runo-pyodide-repl/worker" from "src/repl.worker.ts". Does the file exist?`)에서만 난다. 브라우저에서는 worker 생성 오류가 콘솔에만 남아 페이지는 겉보기에 정상이다.

## 원인

vite가 첫 해석 실패를 캐시한다. `dist`가 4초 뒤 생긴 뒤에도 같은 요청 3회가 모두 500이었고, vite를 재시작해야 복구된다. `turbo run dev`가 패키지 `dev`(`tsdown --watch`)와 앱 `dev`(`vite`)를 순서 없이 동시에 시작해 vite가 먼저 뜬다. `dev.dependsOn: ["^build"]`로 순서를 잡아도 패키지 `build`와 `tsdown --watch`가 같은 `dist`를 동시에 지우고 써서 경합이 남는다.

## 탐지/회피

- 회피: 각 패키지 `exports`의 조건 순서를 `development`(`./src/*.ts`) → `types`(`./dist/*.d.mts`) → `default`(`./dist/*.mjs`)로 둔다. Vite는 dev에서만 `development`를 골라 `dist` 없이 해석한다. 루트 `dev`는 `turbo run dev --filter=demo`로 앱만 띄운다. 규칙 전체는 `docs/design/00-architecture.md` 4.4.
- 탐지: `rm -rf packages/*/dist apps/*/dist`로 `dist`를 지우고 `pnpm dev`를 띄운 직후 `curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/src/repl.worker.ts`가 200이어야 한다. `development` 조건이 프로덕션 빌드로 새지 않았는지는 `dist` 없이 `pnpm --filter demo exec vite build`가 실패하는 것으로 본다.
