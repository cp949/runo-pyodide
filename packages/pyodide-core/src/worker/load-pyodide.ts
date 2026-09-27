/**
 * CDN에서 pyodide를 동적 import하는 브라우저 worker 전용 로더. 단위 시험은 없다 — worker 안 CDN import와 실패 경로는
 * 브라우저 확인(Playwright)이 본다. 시퀀스 시험은 `bootWorker`에 npm `loadPyodide`를 주입해 node에서 돈다(core
 * `worker/boot.test.ts`는 실행 driver, repl `worker/boot.test.ts`는 REPL driver).
 */
import type { loadPyodide as LoadPyodide, PyodideInterface } from "pyodide";

/** `${indexURL}pyodide.mjs`를 동적 import해 `loadPyodide({ indexURL })`를 부른다. indexURL은 `/`로 끝나야 한다. */
export async function loadPyodideFromCdn(
  indexURL: string,
): Promise<PyodideInterface> {
  // 번들러가 npm `pyodide`를 워커 번들에 끌어들이지 않도록 URL 문자열을 그대로 둔다.
  const module = (await import(
    /* @vite-ignore */ `${indexURL}pyodide.mjs`
  )) as {
    loadPyodide: typeof LoadPyodide;
  };
  return module.loadPyodide({ indexURL });
}
