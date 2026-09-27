# TRP-084 옵션 객체를 `toEqual`로 단언하면 값이 `undefined`인 키 전달을 못 잡는다

- 상태: ACTIVE
- 적용 조건: 소비자가 하위 module(벤더 `read()` 등)에 넘기는 옵션 객체를 spy 인자로 단언할 때, 선택 옵션을 전달 경로에 새로 더할 때(`{ cancelable }` → `{ cancelable, history }` 같은 확장).

## 오해하기 쉬운 신호

- `readline.read(tail, { cancelable, history: options?.history })`처럼 생략 호출에도 `history: undefined` 키를 넣어도 `expect(lastOptions()).toEqual({ cancelable: true })`가 통과한다. "생략 호출의 옵션은 전과 같다"를 시험이 보장하는 것처럼 보인다.
- 받는 쪽이 `in`·`Object.keys`·`{ ...defaults, ...options }`로 옵션을 다루면 `undefined` 키가 기본값을 덮어 동작이 달라지는데, 그 차이를 이 단언은 잡지 못한다.

## 원인

- vitest `toEqual`은 값이 `undefined`인 속성을 없는 것으로 본다. `toStrictEqual`만 키 유무를 구분한다.

## 탐지/회피

- 키 부재가 계약이면 `toStrictEqual` 또는 `not.toHaveProperty("<키>")`로 단언한다.
- 전달 코드는 값이 있을 때만 키를 넣는다(`options.history === false`일 때만 `vendorOptions.history = false`, `packages/pyodide-terminal/src/prompt-row.ts`, RD-027 구 `packages/pyodide-terminal/src/stdin-reader.ts`).
- 이 저장소의 기존 옵션 형태 시험(`prompt-row/read.test.ts`(구 `stdin-reader.test.ts`) "`cancelable`을 벤더 읽기 옵션으로 그대로 넘긴다", repl "stdin 읽기(input())에는 프리필도 onKey도 없다(확정 4)")은 `toEqual`이라 이 구분을 하지 않는다. `history` 생략 호출은 `prompt-row/read.test.ts`의 새 전달 시험이 `toStrictEqual({ cancelable: true })`로 고정한다.
