/**
 * `vite.config.ts`의 cross-origin isolation·worker 설정 시험.
 * 이전 구현은 COOP/COEP를 dev 서버에만 걸어 preview·빌드 산출물이 비격리였고,
 * worker 기본 형식(iife)은 top-level await가 든 worker의 프로덕션 빌드를 깨뜨렸다.
 * 브라우저 없이 두 회귀를 막는다(ADR-0004, 00-architecture.md 4.1·6절).
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
  test("top-level await를 담을 수 있도록 형식이 es다", () => {
    expect(config.worker?.format).toBe("es");
  });
});
