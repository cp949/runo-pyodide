# TRP-063 `@xterm/xterm`은 번들 없는 Node ESM에서 이름 import가 실패하고, 번들러 경로의 시험·데모는 통과한다

- 상태: ACTIVE
- 적용 조건: 패키지 진입점(또는 그 하위 모듈)이 `@xterm/xterm`(6.0.0)을 `import { Terminal } from "@xterm/xterm"`처럼 값 이름으로 import하는 코드를 추가할 때, 외부 CommonJS 의존을 값 이름으로 import하는 패키지 진입점을 추가할 때, SSR 서버·소비자 Node 스크립트가 그 패키지를 번들 없이 평가할 때.

## 오해하기 쉬운 신호

- vitest(Vite 변환)·demo dev·demo build·브라우저 L1이 모두 통과한다. Vite·webpack은 `@xterm/xterm`의 `module`(`lib/xterm.mjs`, 번들러 전용)을 골라 이름 내보내기가 보인다.
- 타입 검사(`tsc`)도 통과한다.

## 원인

`@xterm/xterm` 6.0.0의 `package.json`은 `main: lib/xterm.js`(CommonJS)와 `module: lib/xterm.mjs`를 두고 `exports`가 없다. 번들 없는 Node ESM은 `main`을 읽어 CommonJS 모듈로 보고, 이름 내보내기를 정적으로 탐지하지 못해 모듈 평가 때 `SyntaxError: Named export 'Terminal' not found. The requested module '@xterm/xterm' is a CommonJS module`로 던진다. `@xterm/addon-fit`은 CommonJS이지만 이름 내보내기가 탐지돼 named import가 통한다(`node --input-type=module -e 'import * as x from "@xterm/addon-fit"; console.log(Object.keys(x))'`이 `FitAddon`을 포함).

## 탐지/회피

- 네임스페이스로 받고 사용 시점에 `namespace.Terminal ?? namespace.default?.Terminal`을 고른다(`packages/pyodide-repl-react/src/terminal-view.ts`의 `resolveTerminal`). 타입은 `import type`으로 가져온다(모듈 평가에 영향이 없다).
- 탐지는 `pnpm smoke:pack`의 소비자 Node ESM import 검사(`import("@cp949/runo-pyodide-repl-react")`)뿐이다. vitest에는 Node 경로 시험이 없다. 이 검사를 약화하거나 react 진입점을 제외하지 않는다.
- `@xterm/xterm`을 올릴 때 `exports`·`module` 필드가 바뀌었는지 확인하고 `pnpm smoke:pack`을 돌린다.
