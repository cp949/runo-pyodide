import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 기본은 jsdom이다. 경계 시험처럼 node 전용 시험은 파일 상단에 `// @vitest-environment node`를 둔다(09-testing.md).
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    // jsdom에 없는 `window.matchMedia` 등 xterm 마운트 최소 스텁.
    setupFiles: ["./test/setup.ts"],
  },
});
