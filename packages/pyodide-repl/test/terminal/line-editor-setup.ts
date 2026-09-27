/**
 * repl 줄 편집기 시험(`tab-reader`·`block-history`·`line-editor`) 공용 fixture(RD-043). terminal
 * `createTerminalSurface` 조립을 `@cp949/runo-pyodide-terminal/test-utils`의 `setupSurface`로 열고
 * `createLineEditor`를 이어 붙인다. hook을 등록하지 않는다(시험 전용, `create-repl/harness.ts`류의
 * 전역 stub 없음). `readline`은 3벌이 지금 쓰던 정책용 타입(`surface.readline`) 그대로다 — 벤더
 * `Readline`이 필요한 시험은 `asVendorReadline`(terminal `./test-utils` 재수출)을 쓴다.
 */
import { vi, type Mock } from "vitest";
import type { STDIN_EOF } from "@cp949/runo-pyodide-core";
import { setupSurface } from "@cp949/runo-pyodide-terminal/test-utils";
import type {
  SurfaceReadline,
  TerminalSurface,
} from "@cp949/runo-pyodide-terminal/internal";
import type { FakeTerminal } from "@repo/pyodide-testkit/fake-terminal";
import type { CompletionPopover } from "../../src/terminal/completion-popover";
import {
  createLineEditor,
  type LineEditor,
} from "../../src/terminal/line-editor";
import type { TabReaderDeps } from "../../src/terminal/tab-reader";

export interface SetupLineEditorOptions {
  asyncWrite?: boolean;
  /** 참이면 가짜 터미널에 `element`(`.xterm-screen`·`textarea` 포함)를 만든다(실 popover가 필요할 때만). */
  withElement?: boolean;
  complete?: Mock<TabReaderDeps["complete"]>;
  interruptCompletion?: () => void;
  /** 있으면(옵션 켬, RD-049) `fake`·`readline`을 받아 popover를 만들어 `createLineEditor`·`createTabReader`에 넘긴다. */
  popover?: (
    fake: FakeTerminal,
    readline: SurfaceReadline,
  ) => CompletionPopover;
}

export interface LineEditorSetup {
  fake: FakeTerminal;
  surface: TerminalSurface;
  readline: SurfaceReadline;
  lineEditor: LineEditor;
  complete: Mock<TabReaderDeps["complete"]>;
  interruptCompletion: () => void;
  /** `popover` 옵션을 줬으면 그 인스턴스. */
  popover?: CompletionPopover;
  startRead(
    pending?: string,
    cancelable?: boolean,
  ): Promise<{ line: Promise<string | null | typeof STDIN_EOF> }>;
}

export function setupLineEditor({
  asyncWrite = true,
  withElement = false,
  complete = vi.fn<TabReaderDeps["complete"]>(),
  interruptCompletion = vi.fn(),
  popover: createPopover,
}: SetupLineEditorOptions = {}): LineEditorSetup {
  const setup = setupSurface(
    { asyncWrite, withElement },
    { readline: { skipBlankHistory: true } },
  );
  const { fake, surface } = setup;
  const readline = surface.readline;
  surface.openIo();
  const popover = createPopover?.(fake, readline);
  const lineEditor = createLineEditor(readline, {
    complete,
    interruptCompletion,
    popover,
  });

  /** `>>> `(pending 없음) 또는 `... `(pending 있음) 읽기 하나를 시작해 배출까지 기다린다. */
  function startRead(pending?: string, cancelable = true) {
    const prompt = pending === undefined ? ">>> " : "... ";
    return setup.startRead(prompt, {
      cancelable,
      readOptions: () => lineEditor.begin(pending),
    });
  }

  return {
    fake,
    surface,
    readline,
    lineEditor,
    complete,
    interruptCompletion,
    popover,
    startRead,
  };
}
