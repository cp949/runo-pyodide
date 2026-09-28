import { defineConfig } from "tsdown";
import { BROWSER_TARGET } from "../../browser-target.mts";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  // 빌드 floor(ADR-0008).
  target: [...BROWSER_TARGET],
});
