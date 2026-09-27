# TRP-038 tsdown은 optional peer의 서브패스를 자동으로 외부 처리해 `neverBundle` 예외만으로는 인라인되지 않는다

- 상태: ACTIVE
- 적용 조건: `peerDependencies`·`peerDependenciesMeta`·`optionalDependencies`로 선언한 패키지의 일부 서브패스(JSON 등)를 `dist`에 인라인하려 할 때(core의 `pyodide/package.json`), deprecated `external` 옵션을 `deps.*`로 옮길 때, tsdown을 올릴 때(0.23.0에서 확인).

## 오해하기 쉬운 신호

- `tsdown.config.ts`의 `external`(또는 `deps.neverBundle`) 정규식에서 대상 서브패스를 뺐는데도 빌드는 성공하고, 산출물 `.mjs`에 `import … from "pyodide/package.json" with { type: "json" }`가 그대로 남는다. 시험·타입 검사·빌드 어느 것도 실패하지 않는다.
- 그 import는 소비자가 `pyodide`를 설치하지 않았거나 번들러가 해석하지 못하면 깨진다(core는 `pyodide`를 optional peer로만 선언하고 런타임은 CDN을 쓴다). 이 저장소의 시험은 소스(`development` 조건)를 읽으므로 `dist`의 잔존 import를 보지 못한다.

## 원인

- tsdown 0.23.0의 `getProductionDeps`가 `dependencies`·`peerDependencies`·`peerDependenciesMeta`·`optionalDependencies`의 이름을 모으고, `externalStrategy`가 `id`가 그 이름이거나 `${이름}/`로 시작하면 외부로 돌린다. 예외 정규식이 있어도 자동 외부 처리는 그대로다.
- `deps.alwaysBundle`은 이 자동 외부 처리를 이긴다. 반대로 `deps.neverBundle`은 rolldown `external`로 직접 넘어가 `alwaysBundle`이 이기지 못한다. 그래서 두 곳 모두 설정해야 한다: `neverBundle`에서 대상 서브패스를 예외로 빼고(`/^pyodide\/(?!package\.json$)/`), `alwaysBundle`에 그 서브패스를 넣는다(`["pyodide/package.json"]`).
- 두 설정을 각각 되돌리면 빌드는 성공하고 `.mjs`에 런타임 import가 남는다(변이로 확인).

## 탐지/회피

- `pnpm check-dist`(`scripts/check-dist.mjs`)가 `.mjs`의 `pyodide` 런타임 import(`from "pyodide`·`import("pyodide`)를 실패로 잡는다. 빌드 뒤에 실행한다(루트 `pnpm test`가 함께 돌린다).
- 다른 패키지·서브패스를 인라인하도록 바꿀 때는 `check-dist`에 그 이름의 런타임 import 검사를 더한다. `check-dist`는 `pyodide`만 본다.
- tsdown을 올린 뒤에는 `pnpm build && pnpm check-dist`와 `dist`의 인라인 범위(`PYODIDE_VERSION` 값 하나만 남았는지)를 다시 본다.
