// 저장소 전체 빌드 floor 상수(ADR-0008). 모든 라이브러리 `dist`의 문법·API를 이 값으로 하향한다. 런타임 floor(pyodide가 정한다)와는
// 별개다 — 빌드 floor ≤ 브라우저 < 런타임 floor 구간은 `detectRuntimeSupport()`가 명시적으로 `unsupported`로 멈춘다.
// 소비처: `packages/*/tsdown.config.ts`(`target`)·`apps/demo/vite.config.ts`(`build.target`)·`scripts/check-escompat.mjs`(보고 문구).
// runo-coincident와 같은 값(`BROWSER_TARGET = ["chrome84"]`).
export const BROWSER_TARGET = ["chrome84"] as const;
