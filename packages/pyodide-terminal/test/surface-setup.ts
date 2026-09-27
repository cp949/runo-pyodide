/**
 * `createTerminalSurface` 단위 시험(`prompt-row/*.test.ts`·`surface.test.ts`)의 공용 fixture(RD-042). 가짜 터미널
 * (`@repo/pyodide-testkit/fake-terminal`) + 실제 `Readline`으로 surface를 조립하고, 읽기 배출 순서와 내부 관찰 창구를 한곳에 둔다.
 * hook을 등록하지 않는다(`runner-setup.ts`는 전역 stub hook을 등록하므로 이 시험들이 import하지 않는다).
 * 시험 전용이며 패키지 진입점(`index.ts`·`internal.ts`)에서 import하지 않는다. repl 시험은 `./test-utils` subpath로 가져온다(RD-043).
 * `tick`·`drain`·`attachScreen`의 원천은 testkit이다 — 이 파일은 재수출만 한다.
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
 * `SurfaceIo.sinks`는 쓰기 4종만 낸다(RD-027 DELTA-04) — 꼬리는 promptRow 내부 재료다. promptRow 자체(`sinks.tail()`을 재료로
 * 합성 프롬프트를 만드는 계산)와 세션 분리를 검증하는 시험만 내부 타입으로 직접 관찰한다.
 */
export const tail = (sinks: TerminalSinks): string =>
  (sinks as TerminalSinksInternal).tail();

/** `surface.readline`은 소비자 정책용으로 좁혀 있다(RD-027 DELTA-04) — 벤더 호출 자체를 스파이하는 시험만 전체 `Readline`으로 되돌려 본다. */
export const asVendorReadline = (readline: unknown): Readline =>
  readline as Readline;

export interface SurfaceSetup {
  fake: FakeTerminal;
  surface: TerminalSurface;
  /** `surface.readline`을 벤더 `Readline`으로 되돌린 같은 객체. */
  readline: Readline;
  /**
   * `surface.promptRow.read`를 열고 `drain`한다. 읽기 Promise는 `await`가 풀지 않도록 객체에 담아 돌려준다. 현재 io는 시험이 먼저
   * 연다.
   */
  startRead(
    prompt: string,
    options: PromptReadOptions,
  ): Promise<{ line: Promise<string | null | typeof STDIN_EOF> }>;
}

/**
 * 가짜 터미널에 surface를 조립한다. io·spy·`VtScreen`은 시험이 직접 연다. `surfaceOptions`는
 * `createTerminalSurface`에 그대로 전달되되 `readline`만 `{ persist: false, ...surfaceOptions.readline }`로
 * 한 단계 병합한다(history 비영속이 기본, 다른 `readline` 필드·최상위 옵션은 `surfaceOptions`가 그대로 덮어쓴다).
 * repl 시험은 이 fixture를 `@cp949/runo-pyodide-terminal/test-utils`로 가져와 쓴다(RD-043).
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
