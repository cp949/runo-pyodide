/**
 * `vite.config.ts`의 cross-origin isolation·worker 설정 시험.
 * 브라우저 없이 설정 객체만 읽는다. 두 회귀를 막는다.
 *
 * - COOP/COEP: 이전 구현은 dev 서버에만 걸어 preview·빌드 산출물이 비격리였다.
 * - worker 형식: `es`를 유지한다. 기본 iife 빌드는 현재 성공하므로 이 시험은 형식이 조용히 바뀌는 것을 막는 고정이다.
 *
 * 근거는 `vite.config.ts` 주석. 규칙은 ADR-0004, 00-architecture.md 4.1·6절.
 */
import { describe, expect, test } from "vitest";
import config from "../vite.config";

const COOP = "Cross-Origin-Opener-Policy";
const COEP = "Cross-Origin-Embedder-Policy";

describe("cross-origin isolation 헤더", () => {
  test("dev 서버가 COOP same-origin과 COEP require-corp를 보낸다", () => {
    expect(config.server?.headers).toMatchObject({
      [COOP]: "same-origin",
      [COEP]: "require-corp",
    });
  });

  test("preview 서버도 dev와 같은 헤더를 보낸다", () => {
    expect(config.preview?.headers).toMatchObject({
      [COOP]: "same-origin",
      [COEP]: "require-corp",
    });
  });
});

describe("worker 번들", () => {
  test("worker 형식이 es다", () => {
    expect(config.worker?.format).toBe("es");
  });
});
