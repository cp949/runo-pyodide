# TRP-039 pyodide 비공개 경로에서 없는 속성은 예외가 아니라 `undefined`이고, 산술에 들어가 0이 되어 조용히 오동작한다

- 상태: ACTIVE
- 적용 조건: `pyconsole._compile.compiler.flags`처럼 pyodide 비공개 경로를 JS에서 읽어 비트 연산·산술에 쓰는 코드를 추가·수정할 때, pyodide를 올린 뒤 그런 경로가 사라졌는지 확인할 때.

## 오해하기 쉬운 신호

- pyodide가 `pyconsole._compile.compiler`는 남기고 `flags` 속성만 없앤 경우, `setTopLevelAwait`가 예외 없이 끝난다. PyProxy에서 없는 속성 접근은 `undefined`이고 `undefined & ~TOP_LEVEL_AWAIT_FLAG`는 0이라 `compiler.flags = 0`이 써진다.
- 부팅은 성공하고 `loadFailed`·경고·`pageerror` 어느 것도 없다. 이후 `compilerFlags()`·문법 오류 정규화도 `undefined & …`인 0으로 계산해 붙여넣기 분할과 EOF 문구 정규화가 어긋난 값으로 동작한다.
- "경로 전체가 없을 때만 던진다"는 가정(`undefined.flags`의 `TypeError`가 `loadFailed`가 된다)은 마지막 속성 하나만 없는 경우에 틀린다.

## 원인

JS에서 PyProxy의 없는 속성 읽기는 `undefined`를 돌려주고, JS 비트 연산은 `undefined`를 0으로 취급한다. 마지막 속성만 없어지는 변경(이름 변경·이동)은 중간 객체가 있어 `TypeError`가 나지 않는다.

## 탐지/회피

- 비공개 경로를 산술에 쓰기 전에 `typeof … === "number"`로 판정하고, 없으면 그 기능을 건너뛴다(`hasCompilerFlags`, repl `worker/top-level-await.ts`). 판정은 그 경로를 쓰는 첫 코드(`setTopLevelAwait`)보다 앞이어야 한다.
- 시험: repl `worker/console-compat.test.ts`의 "setTopLevelAwait를 건너뛴다…"가 `flags`만 없앤 콘솔에서 경로에 0이 써지지 않았는지 단언한다. 새 비공개 경로를 더하면 "속성 하나만 삭제" 시험을 함께 둔다(중간 객체까지 지우는 시험은 이 경우를 놓친다).
- 판정 결과는 호환 탐지의 `degraded` 식별자로 알린다(`docs/design/13-version-upgrade.md` 13.6).
