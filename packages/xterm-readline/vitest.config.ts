import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 원본 시험은 jsdom(jest-environment-jsdom)에서 돈다. History가 window.localStorage를 쓴다.
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
  },
});
