import { defineConfig } from "tsdown";

export default defineConfig({
  // internal.ts는 '@cp949/runo-pyodide-terminal/internal' 서브패스로 노출한다(repl 전용, 안정성 보장 없음).
  entry: ["src/index.ts", "src/internal.ts"],
  format: ["esm"],
  dts: true,
});
