# TRP-068 Vite dev는 `exports`의 `development` 대상 파일이 없어도 다음 조건으로 넘어가지 않고 오류 없이 `null`을 돌려준다

- 상태: ACTIVE
- 적용 조건: 패키지 `exports`에 작업공간 소스용 `development` 조건(`./src/…ts`)을 두면서 `files: ["dist"]`로 배포할 때. tarball 소비자 검사(`scripts/pack-smoke.mjs`의 Vite 해석 단계)나 그 해석 결과를 판정하는 코드를 고칠 때. 새 패키지·새 진입점을 추가할 때.

## 오해하기 쉬운 신호

- Node ESM과 `tsc` `NodeNext`는 `development` 조건을 쓰지 않는다. `default`·`types`가 배포 파일을 가리키므로 이 두 검사는 결함을 놓치고 통과한다.
- Vite `pluginContainer.resolveId`는 `development` 대상 파일이 없어도 던지지 않는다. `null`을 돌려주고, 다음 조건(`types`·`default`)으로 넘어가지도 않는다(vite `8.3.0` client 환경). 검사 코드가 `existsSync(resolved.id)`만 보거나 예외만 잡으면 `null`을 "해결할 것이 없음"으로 읽어 통과시킨다.
- 같은 위치에 빈 `src/index.ts`를 두면 그 파일로 해석된다. `development`가 `default`보다 먼저 선택된다는 뜻이다.
- 실제 dev 서버에서는 `Failed to resolve import` 오류로 나타난다. 오류 문구에는 원인이 `exports` 조건 순서라는 내용이 없다.

## 원인

- Vite는 dev에서 해석 조건에 `development`를 기본으로 넣는다. `exports`의 조건은 순서대로 평가되고, 매칭된 조건의 대상이 실제 파일인지는 되돌아가 확인하지 않는다.
- `packages/*/package.json`의 `exports`는 작업공간 소스(`./src/…ts`)를 가리키는 `development`를 담고, tarball에는 `src/`가 없다(`files: ["dist"]`).

## 탐지/회피

- 각 패키지 `package.json`의 `publishConfig.exports`에 `development`를 뺀 같은 `exports`를 둔다. `pnpm pack`이 이것을 tarball `package.json`의 `exports`로 쓰고 `development`·`publishConfig` 필드는 남지 않는다. 작업공간 해석(demo·vitest)은 원래 `exports`를 그대로 쓴다. `packages/pyodide-dom-bridge/src/package-boundary.test.ts`는 두 `exports`의 키가 같은지 본다.
- `pnpm smoke:pack`이 두 검사를 상시로 돈다: (a) tarball `exports`의 모든 대상이 tarball 파일 목록에 있는지(정적), (b) 소비자 임시 폴더에서 Vite `createServer`(middleware 모드)의 client 환경 `pluginContainer.resolveId`로 진입점을 풀고 결과 파일이 설치본에 존재하는지. (b)의 판정은 `null`을 실패로 취급한다(`resolved?.id`가 문자열이고 `existsSync`여야 통과). 규칙은 `docs/design/09-testing.md` 9.8.3.
- 한계: Vite 해석 검사는 client 환경 한 가지다. SSR `ssr.resolve.conditions`·`optimizeDeps` 사전 번들 경로는 보지 않는다. 진입점을 추가하면 `exports`·`publishConfig.exports`·`scripts/pack-smoke.mjs`의 `ENTRY_EXPORTS`를 맞춘다. `ENTRY_EXPORTS` 누락은 `smoke:pack`이 진입점 도출 대조에서 잡는다(`docs/design/09-testing.md` 9.8.3).
