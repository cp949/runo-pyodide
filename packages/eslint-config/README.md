# @repo/eslint-config

workspace 공용 ESLint 설정. `private`이며 npm에 배포하지 않는다.

## 진입점

| 진입점                               | 내용                                                                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@repo/eslint-config/base`           | `js.configs.recommended` + `typescript-eslint` recommended + prettier 충돌 규칙 끄기 + `eslint-plugin-turbo`(`turbo/no-undeclared-env-vars`) + `eslint-plugin-only-warn`(모든 오류를 warn으로) |
| `@repo/eslint-config/react-internal` | `base`에 React Hooks 규칙(`eslint-plugin-react-hooks` flat recommended)과 `browser`·`serviceworker` 전역을 더한 설정                                                                           |

## 사용

```js
// eslint.config.js
import { config } from "@repo/eslint-config/base";

export default [...config];
```

React를 쓰는 패키지는 `react-internal`을 쓴다.

```js
import { config } from "@repo/eslint-config/react-internal";

export default [...config];
```

- `dist/**`는 두 설정 모두 무시한다.
- `onlyWarn` 때문에 CI에서 오류로 막으려면 `eslint --max-warnings 0`으로 실행한다(각 패키지의 `lint` 스크립트 참고).
