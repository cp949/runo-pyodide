/**
 * `?raw` 텍스트 import 해석 훅(node 통계 전용).
 * - `console.ts`·`sigint-handler.ts`·`sleep-slice.ts`가 `./*.py?raw`를 import한다.
 * - vitest·tsdown은 `?raw`를 각자 내장·플러그인으로 처리한다. 맨 node 실행에는 그 처리가 없다.
 * - 이 훅은 `?raw` 지정자를 파일로 풀고 내용을 기본 export 문자열인 모듈로 읽는다.
 *
 * 저장소 `packages/pyodide-testkit/src/ts-resolve-hook.mjs`도 `?raw`를 처리한다.
 * 실측: 이 훅을 등록하지 않고 `ts-resolve-hook.mjs`만 등록해도 `console.ts`가 로드된다.
 * 두 훅을 함께 등록해도, 등록 순서를 바꿔도 로드된다.
 * 이 파일은 node 통계 전용이며 저장소 소스를 건드리지 않는다.
 *
 * 출처 RD-009에서 이관(RD-018).
 */
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

/** vite의 `?raw` 접미. 이 접미가 붙은 지정자만 처리한다. */
const RAW_QUERY = "?raw";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.endsWith(RAW_QUERY)) return nextResolve(specifier, context);
    const withoutQuery = specifier.slice(0, -RAW_QUERY.length);
    const resolved = new URL(withoutQuery, context.parentURL);
    return { url: `${resolved.href}${RAW_QUERY}`, shortCircuit: true };
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(RAW_QUERY)) return nextLoad(url, context);
    const filePath = new URL(url.slice(0, -RAW_QUERY.length));
    const text = readFileSync(filePath, "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(text)};`,
    };
  },
});
