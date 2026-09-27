import { readFile } from "node:fs/promises";
import { defineConfig } from "tsdown";

/** `import text from "./x.py?raw"`를 문자열 모듈로 만든다. vite의 `?raw`와 같은 의미(rolldown에는 없다). */
function rawTextPlugin() {
  return {
    name: "raw-text",
    async load(id: string) {
      if (!id.endsWith("?raw")) return null;
      const text = await readFile(id.slice(0, -"?raw".length), "utf8");
      return {
        code: `export default ${JSON.stringify(text)};`,
        moduleType: "js" as const,
      };
    },
  };
}

export default defineConfig({
  // worker.ts는 '@cp949/runo-pyodide-repl/worker' 서브패스로 노출한다.
  entry: ["src/index.ts", "src/worker.ts"],
  format: ["esm"],
  dts: true,
  plugins: [rawTextPlugin()],
});
