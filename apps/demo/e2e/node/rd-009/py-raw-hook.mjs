/**
 * `?raw` 텍스트 import 해석 훅(node 통계 전용). 저장소 `ts-resolve-hook.mjs`는 확장자 없는 상대 import만
 * 풀고(`\.[cm]?[jt]s$` 정규식이 쿼리 문자열을 모른다) `?raw`는 모른다(vitest·tsdown은 각자 내장/플러그인으로 처리
 * 하지만 맨 node 실행에는 없다). `console.ts`·`sigint-handler.ts`·`sleep-slice.ts`가 `./*.py?raw`를 import하므로
 * 이 훅을 저장소의 `ts-resolve-hook.mjs`보다 **뒤에**(`--import` 두 번째) 등록해야 한다 — 나중에
 * 등록한 훅이 먼저 실행돼(node 훅 체인은 스택) `?raw` 지정자를 `ts-resolve-hook`이 `.ts`를 잘못 덧붙이기 전에
 * 가로챈다. 저장소 소스(`packages/pyodide-testkit/src/ts-resolve-hook.mjs`)는 건드리지 않는다 — 이 파일은 node 통계 전용이다.
 * 출처 RD-009, `_works/_completed/20260922-09-rd-009-idle-ctrl-c/verify/node/`에서 이관(RD-018 DELTA-04).
 */
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

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
