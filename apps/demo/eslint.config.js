import { config } from "@repo/eslint-config/react-internal";

export default [
  ...config,
  {
    // Playwright 하니스(node 스크립트)는 브라우저 확인 전용이라 react-internal 규칙 대상이 아니다.
    ignores: ["e2e/**"],
  },
];
