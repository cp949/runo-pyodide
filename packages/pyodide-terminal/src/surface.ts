/**
 * xterm 화면 조립·수명을 한곳에 둔다(`createTerminalRunner`·`createRepl`이 공유). 수명은 두 겹이다.
 *
 * - 위젯 수명(`createTerminalSurface`): 선택 복사 → `Readline` → `loadAddon` 조립과 정리(선택 복사 → `Readline`).
 *   - `onKeyEvent`를 selectionCopy에 묶는 일과 selectionCopy를 `Readline`보다 먼저 만드는 순서를 이 module이 소유한다.
 *   - 소비자는 순서를 알 필요가 없다.
 *   - 소비자는 정책(`Readline` 옵션·언제 세션을 여닫는가)만 넘긴다.
 * - 세션 수명(`surface.openIo()`): 세션마다 새 sink 세트와 `close()` 뒤 write 콜백을 전달하지 않는 터미널 뷰(TRP-004)를 만든다.
 *   - 새 세션이 이전 꼬리를 물려받지 않는다(05-output.md 4.1).
 *   - 프롬프트 행 읽기·take·행 머리 보장은 `promptRow`(RD-027)가 "현재 io"로 낸다.
 *
 * `dispose()`는 열린 `io`를 닫지 않는다.
 * - `io.close()`를 부르는 시점은 소비자가 소유한다. terminal은 `dispose()`와 같은 지점, repl은 core 세션의 `terminate` 훅.
 * - 의미 있는 정리 순서도 소비자가 소유한다(TRP-064). runner·세션을 먼저 끝내 열린 읽기의 abort가 `cancelRead()`를 돌린 뒤 화면을 뗀다.
 * - 여기서 소유하는 순서는 서로 독립인 두 정리뿐이다.
 */
import { Readline, type ReadlineOptions } from "@cp949/runo-xterm-readline";
import type { Terminal } from "@xterm/xterm";
import {
  createPromptRow,
  type PromptRow,
  type PromptRowIo,
} from "./prompt-row";
import type { RewindTerminal } from "./rewind-tail";
import { createSelectionCopy, type CopyResult } from "./selection-copy";
import { createTerminalSinks, type TerminalSinks } from "./sinks";

/**
 * 소비자(sinks·surface·prompt-row 밖)가 실제로 부르는 `Readline` 멤버만 낸다(RD-027).
 * 프롬프트 행 연산(`read`·`cancelRead`·`takeRead`·`abovePrefix`·`printAboveRaw`·`write`·`print`·`println`·`isReading`·`updateLine`·
 * `dispose` 등)은 `surface.promptRow`만 쓸 수 있다. 컴파일 단계에서 막는다.
 */
export type SurfaceReadline = Pick<
  Readline,
  | "setCtrlCHandler"
  | "getLine"
  | "getCursor"
  | "editInsert"
  | "editBackspace"
  | "getHistory"
  | "printAbove"
  | "hasQueuedInput"
  | "tty"
>;

export interface TerminalSurfaceOptions {
  /** 드래그 선택(`mouseup`) 시 자동 복사할지. 기본 `true`(`=== false`일 때만 끔). Ctrl+C 복사는 이 값과 무관하게 항상 동작한다. */
  copyOnSelect?: boolean;
  /** 선택 복사(자동·Ctrl+C 모두) 결과를 알린다. 기본 무동작. */
  onCopy?: (result: CopyResult) => void;
  /** `Readline` 옵션. `onKeyEvent`는 surface가 selectionCopy에 묶으므로 받지 않는다. */
  readline?: Omit<ReadlineOptions, "onKeyEvent">;
}

/** 세션 하나의 화면 입출력. `TerminalSurface.openIo()`가 호출마다 새로 만든다. */
export interface SurfaceIo {
  /**
   * 게이트가 걸린 터미널 뷰. `close()` 뒤에는 write 콜백을 전달하지 않는다. `close()` 전에는 그대로 전달한다.
   * 이유(TRP-004): xterm의 write 콜백은 `terminal.dispose()` 뒤에도 돈다. 그러면 `rewindTail`이 해제된 터미널의 buffer를 읽는다.
   */
  readonly terminal: RewindTerminal;
  /** 이 세션의 sink 세트(쓰기 4종만, RD-027). 꼬리 재료는 `promptRow`가 내부에서 다룬다. */
  readonly sinks: TerminalSinks;
  /** 게이트를 닫는다. 두 번 불러도 안전. 다른 `io`에 영향을 주지 않는다. */
  close(): void;
}

export interface TerminalSurface {
  /** 조립한 줄 편집기. 소비자 정책(auto-indent·block-history·tab-reader·Ctrl+C)이 쓰는 멤버만 낸다(RD-027). 프롬프트 행 연산은 `promptRow`가 맡는다. */
  readonly readline: SurfaceReadline;
  /**
   * 프롬프트 행 deep module(RD-027). "현재 io"를 본다.
   * - 현재 io: 가장 최근 `openIo()`로 연 io. 그 io가 `close()`되지 않은 동안만 해당한다.
   * - 더 오래된 io의 `close()`는 현재 io를 바꾸지 않는다.
   */
  readonly promptRow: PromptRow;
  /** 드래그 자동 복사 on/off를 바꾼다. `dispose()` 뒤 no-op. */
  setCopyOnSelect(on: boolean): void;
  /** 세션 수명의 입출력을 연다. 호출마다 새 sinks·게이트를 만든다. */
  openIo(): SurfaceIo;
  /** 선택 복사 → `Readline` 순으로 정리한다. 두 번 불러도 안전. 열린 `io`는 닫지 않는다(시점은 소비자가 소유). */
  dispose(): void;
}

/**
 * 선택 복사 → `Readline` → `terminal.loadAddon` 순으로 조립한다. `Terminal`은 dispose하지 않는다.
 * `loadAddon`이 던지면 이미 만든 선택 복사·`Readline`을 정리한 뒤 그 예외를 그대로 던진다.
 */
export function createTerminalSurface(
  terminal: Terminal,
  options: TerminalSurfaceOptions = {},
): TerminalSurface {
  // 선택 복사 정책은 `Readline` 생성 앞에 만든다. 훅이 vendor보다 먼저 걸려도 안전하게 한다.
  const selectionCopy = createSelectionCopy(terminal, {
    copyOnSelect: options.copyOnSelect !== false,
    onCopy: options.onCopy ?? (() => {}),
  });
  const readline = new Readline({
    ...options.readline,
    onKeyEvent: (event) => selectionCopy.onKeyEvent(event),
  });
  const disposeParts = () => {
    selectionCopy.dispose();
    readline.dispose();
  };
  try {
    terminal.loadAddon(readline);
  } catch (error) {
    disposeParts();
    throw error;
  }

  let disposed = false;
  // "현재 io"(가장 최근 openIo()로 연 io). promptRow가 프롬프트 행 연산의 재료로 본다(`docs/design/08-session.md` 8.1).
  let currentIo: PromptRowIo | undefined;
  const promptRow = createPromptRow(readline, () => currentIo);
  return {
    readline,
    promptRow,
    setCopyOnSelect(on) {
      if (disposed) return;
      selectionCopy.setCopyOnSelect(on);
    },
    openIo() {
      let closed = false;
      // sink 세트는 세션마다 새로 만든다. 새 세션이 이전 꼬리를 물려받지 않게 한다(05-output.md 4.1).
      const sinks = createTerminalSinks(readline);
      const liveTerminal: RewindTerminal = {
        get cols() {
          return terminal.cols;
        },
        get buffer() {
          return terminal.buffer;
        },
        write: (text, callback) =>
          terminal.write(
            text,
            callback &&
              (() => {
                if (!closed) callback();
              }),
          ),
      };
      const io: PromptRowIo = { terminal: liveTerminal, sinks };
      currentIo = io;
      return {
        terminal: liveTerminal,
        sinks,
        close() {
          closed = true;
          // 더 오래된 io의 close()는 현재 io를 바꾸지 않는다(surface.test "한 io의 close()는 다른 io의 게이트에
          // 영향 없음"과 같은 성질).
          if (currentIo === io) currentIo = undefined;
        },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeParts();
    },
  };
}
