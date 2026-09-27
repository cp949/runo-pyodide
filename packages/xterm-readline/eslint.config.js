import { config as baseConfig } from "@repo/eslint-config/base";

/** 벤더링한 원본 소스의 관례를 수정 없이 받아들이기 위한 규칙 완화. */
export default [
  ...baseConfig,
  {
    // 원본 `.eslintrc`도 이 규칙을 끈다. 미사용 인자를 그대로 둔다.
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // ANSI 이스케이프(`\x1b`) 제거 정규식과 `cw` 재대입이 원본 그대로다.
    files: ["src/tty.ts"],
    rules: {
      "no-control-regex": "off",
      "no-useless-assignment": "off",
    },
  },
];
