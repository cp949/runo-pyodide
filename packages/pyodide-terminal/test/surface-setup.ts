/**
 * `createTerminalSurface` 단위 시험의 공용 fixture(RD-042).
 * - 사용처: `prompt-row/*.test.ts`, `surface.test.ts`.
 * - 구성: 가짜 터미널(`@repo/pyodide-testkit/fake-terminal`) + 실제 `Readline`으로 surface를 조립한다.
 * - 제공: 읽기 배출 순서(`startRead`)와 내부 관찰 창구(`tail`·`asVendorReadline`).
 * - hook을 등록하지 않는다. `runner-setup.ts`는 전역 stub hook을 등록하므로 이 시험들은 그 파일을 import하지 않는다.
 * - `tick`·`drain`·`attachScreen`은 testkit에서 재수출만 한다.
 * - 시험 전용이다. 패키지 진입점(`index.ts`·`internal.ts`)에서 import하지 않는다.
 * - repl 시험은 `@cp949/runo-pyodide-terminal/test-utils` subpath로 가져온다(RD-043).
 */
import type { Readline } from "@cp949/runo-xterm-readline";
import { tick } from "@repo/pyodide-testkit/async";
import {
  createFakeTerminal,
  drain,
  type FakeTerminal,
  type FakeTerminalOptions,
} from "@repo/pyodide-testkit/fake-terminal";
import { attachScreen } from "@repo/pyodide-testkit/vt-screen";
import type { STDIN_EOF } from "@cp949/runo-pyodide-core";
import type { PromptReadOptions } from "../src/prompt-row";
import {
  createTerminalSurface,
  type TerminalSurface,
  type TerminalSurfaceOptions,
} from "../src/surface";
import type { TerminalSinks, TerminalSinksInternal } from "../src/sinks";

export { tick, drain, attachScreen };

/**
 * sink의 꼬리를 내부 타입으로 읽는다.
 * - `SurfaceIo.sinks`는 쓰기 4종만 공개한다(RD-027). 꼬리는 promptRow 내부 재료다.
 * - 꼬리 자체를 검증하는 시험만 쓴다.
 * - 대상: promptRow의 합성 프롬프트 계산(`sinks.tail()`을 재료로 쓴다)과 세션 분리.
 */
export const tail = (sinks: TerminalSinks): string =>
  (sinks as TerminalSinksInternal).tail();

/**
 * 좁혀진 `surface.readline`을 벤더 `Readline`으로 되돌린다.
 * - `surface.readline`은 소비자 정책용으로 좁혀 있다(RD-027).
 * - 벤더 호출 자체를 스파이하는 시험만 쓴다.
 */
export const asVendorReadline = (readline: unknown): Readline =>
  readline as Readline;

/** `setupSurface`가 돌려주는 surface와 조작 도구. */
export interface SurfaceSetup {
  /** surface가 붙은 가짜 터미널 */
  fake: FakeTerminal;

  /** 조립한 surface */
  surface: TerminalSurface;

  /** `surface.readline`을 벤더 `Readline`으로 되돌린 같은 객체 */
  readline: Readline;

  /**
   * `surface.promptRow.read`를 열고 `drain`한다.
   * - 읽기 Promise는 `await`가 풀지 않도록 객체에 담아 돌려준다.
   * - 현재 io는 시험이 먼저 연다.
   */
  startRead(
    prompt: string,
    options: PromptReadOptions,
  ): Promise<{ line: Promise<string | null | typeof STDIN_EOF> }>;
}

/**
 * 가짜 터미널에 surface를 조립한다.
 * - io·spy·`VtScreen`은 시험이 직접 연다.
 * - `surfaceOptions`는 `createTerminalSurface`에 그대로 전달한다.
 * - 예외: `readline`만 `{ persist: false, ...surfaceOptions.readline }`로 한 단계 병합한다.
 *   history 비영속이 기본이고, 다른 `readline` 필드는 `surfaceOptions`가 덮어쓴다.
 */
export function setupSurface(
  options: FakeTerminalOptions = {},
  surfaceOptions: TerminalSurfaceOptions = {},
): SurfaceSetup {
  const fake = createFakeTerminal(options);
  const surface = createTerminalSurface(fake.term, {
    ...surfaceOptions,
    readline: { persist: false, ...surfaceOptions.readline },
  });
  return {
    fake,
    surface,
    readline: asVendorReadline(surface.readline),
    async startRead(prompt, readOptions) {
      const line = surface.promptRow.read(prompt, readOptions);
      await drain(fake);
      return { line };
    },
  };
}
