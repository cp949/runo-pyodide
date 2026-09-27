import { defineConfig } from "tsdown";

export default defineConfig({
  // worker.ts는 '@cp949/runo-pyodide-dom-bridge/worker' 서브패스로 노출한다(worker 파일의 첫 정적 import).
  // bootstrap-observer-install.ts는 dist에서 별도 파일로 남아야 한다: worker.mjs가 coincident보다 먼저 import해야 관찰 리스너가 먼저
  // 등록된다(번들러가 외부 import를 위로 올리므로 인라인하면 순서가 뒤집힌다).
  entry: ["src/index.ts", "src/worker.ts", "src/bootstrap-observer-install.ts"],
  format: ["esm"],
  dts: true,
});
