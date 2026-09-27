/**
 * worker 스레드 시험 전용 해석 훅. `--import`로 스레드에 등록한다(`thread.ts`).
 * 프로덕션 소스는 번들러 해석을 전제로 확장자 없이 상대 import를 쓴다(`../protocol/rpc`). Node의 타입 제거 실행은 그
 * 확장자를 풀지 못하므로 `.ts`를 붙여 다시 푼다. `import text from "./x.py?raw"`(vite의 `?raw`)는 파일 내용을 기본 export
 * 문자열로 하는 모듈로 읽는다(pyodide를 올리는 역할 스크립트가 worker 모듈을 그대로 import할 수 있게).
 */
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const RELATIVE = /^\.\.?\//;
const HAS_SCRIPT_EXTENSION = /\.[cm]?[jt]s$/;
const RAW_SUFFIX = "?raw";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(RAW_SUFFIX)) {
      // Node의 해석은 질의 문자열을 버린다. 파일로 풀고 `?raw`를 다시 붙여 `load`가 알아보게 한다.
      const resolved = nextResolve(specifier.slice(0, -RAW_SUFFIX.length), context);
      return { ...resolved, url: `${resolved.url}${RAW_SUFFIX}`, shortCircuit: true };
    }
    if (RELATIVE.test(specifier) && !HAS_SCRIPT_EXTENSION.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // 확장자를 붙여도 없으면 원래 지정자로 다시 시도해 Node의 원래 오류를 낸다.
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(RAW_SUFFIX)) return nextLoad(url, context);
    const path = fileURLToPath(url.slice(0, -RAW_SUFFIX.length));
    return {
      format: "module",
      source: `export default ${JSON.stringify(readFileSync(path, "utf8"))};`,
      shortCircuit: true,
    };
  },
});
