/**
 * 커서 행의 프롬프트 앞 글자(꼬리·접두)·열린 읽기·읽기가 끝난 뒤 행 머리 보장을 한곳에 모은 deep module
 * (RD-027, `docs/design/04-stdin-input.md` 3.3, `packages/pyodide-terminal/CONTEXT.md`의 프롬프트 행).
 * - 이전: terminal(`stdin-reader`)·repl(`repl-reader`·`source-bridge`·`sinks.moveAbovePrefixToTail`·실행창 abort·
 *   `prepareScreen`·`clearScreen`·repl reset·`writeNotice`) 두 패키지 7곳에 순서 제약이 흩어져 있었다.
 * - 지금: 이 module이 순서 제약을 소유한다.
 * - RD-027: **화면 바이트 동일 리팩터**.
 * - RD-028: 아래 행 머리 보장 규칙 통일. 의도된 바이트 변경이 3건 있다.
 *   그중 그리기 전 창 reset의 무조건 개행은 `docs/design/08-session.md` 8.1 1번에 있다.
 *
 * 행 머리 보장 규칙(RD-028, `docs/design/14-runner.md` 14.5.4, `docs/design/08-session.md` 8.1 1번):
 * - 판정 재료: 항상 **현재 io 꼬리에 보이는 글자가 있는가**(`leavesVisibleText`).
 * - xterm의 실제 커서는 쓰지 않는다. write 콜백이 `setTimeout`으로 미뤄져 같은 태스크의 커서가 낡을 수 있다(F3).
 * - 문자열이 비어 있는가만으로는 틀린다.
 *   색을 안 닫고 개행으로 끝난 출력은 꼬리에 열린 SGR만 남는다.
 *   문자열은 비지 않지만 화면에는 보이는 글자가 없다.
 * - `endRead({ screen: true })`: settle 성공이면 아무것도 쓰지 않는다.
 * - settle 실패면 벤더 `hasPendingRead()`(취소 **앞**에서 읽는다)로 "그리기 전 읽기가 있었는가"를 나눈다.
 *   있었으면 무조건 개행. 없었으면 꼬리에 보이는 글자가 있을 때만 개행.
 * - `breakLine()`: 항상 "꼬리에 보이는 글자가 있을 때만 개행".
 * - `notice()`: 같은 판정으로 개행을 선행한다(TRAP-12 예외 없음).
 *
 * "현재 io" = 가장 최근 `TerminalSurface.openIo()`로 연 io(`surface.ts`가 갱신한다).
 * - 그 io의 `close()`가 불리면 현재 io가 없다.
 * - 더 오래된 io의 `close()`는 현재 io를 바꾸지 않는다.
 * - `read()`는 호출 시점의 현재 io에 묶인다. io가 없으면 던진다.
 * - flush를 기다리는 사이 다른 io가 현재 io가 되어도 이 읽기는 처음 묶인 io의 꼬리를 그대로 쓴다.
 * - `detachPrefix()`의 핸들도 `read()`처럼 호출 시점 io에 묶인다.
 * - 그 밖의 연산은 매번 그때의 현재 io를 본다.
 */
import { READ_EOF } from "@cp949/runo-xterm-readline";
import type { Readline, ReadOptions } from "@cp949/runo-xterm-readline";
import { leavesVisibleText, STDIN_EOF } from "@cp949/runo-pyodide-core";
import { rewindTail, type RewindTerminal } from "./rewind-tail";
import { RESET, type TerminalSinksInternal } from "./sinks";

export type NoticeKind = "warning" | "info";

const COLOR: Record<NoticeKind, string> = {
  warning: "\x1b[33m",
  info: "\x1b[36m",
};

/** 화면과 스크롤백을 지우고 커서를 처음으로 돌린다(구 `terminal-runner.ts` `CLEAR_SCREEN`). */
const CLEAR_SCREEN = "\x1b[H\x1b[2J\x1b[3J";

export interface PromptReadOptions {
  cancelable: boolean;
  /** flush(꼬리 정리) 대기 뒤 abort됐으면 읽기를 열지 않고 `null`로 끝난다. */
  signal?: AbortSignal;
  /** `false`일 때만 벤더 옵션에 `history: false`를 넣는다(생략 시 키 자체가 없다). */
  history?: false;
  /**
   * 벤더 읽기 옵션 조각. **flush 뒤, `readline.read()` 직전에** 평가한다.
   * repl `repl-main-driver.ts`의 `lineEditor.begin(pending, restore)`가 이 시점에 부른다.
   * restore 소비·Tab 세대가 이 시점에 묶여 있다.
   */
  readOptions?: () => Omit<ReadOptions, "cancelable" | "history" | "eof">;
  /**
   * true면 이 읽기 중 빈 버퍼에서 실제로 친 Ctrl+D가 읽기를 `STDIN_EOF`로 끝낸다(벤더 `ReadOptions.eof`).
   * `READ_EOF` → core `STDIN_EOF` 변환은 이 모듈이 한 곳에서 한다.
   * 생략하면 false(원본 동작).
   */
  eof?: true;
  /**
   * `readline.read()`를 연 직후 동기로 부른다. repl `repl-main-driver.ts`의 `onOpen` 콜백이 그리기 시점을 잰다.
   * 넘기는 promise는 벤더 원시 promise 그대로다(변환 전). 호출자는 결말 값이 아니라 정착 시점만 쓴다.
   */
  onOpen?: (read: Promise<unknown>) => void;
}

/**
 * 떼는 순간의 현재 io에 묶인다.
 * - `draw()`: 그 io가 아직 현재 io이면 그 io 꼬리를 읽기 없이 그리고 꼬리는 둔다. 꼬리가 비었으면 무동작.
 * - 현재 io가 아니면(닫혔거나 바뀜) 무동작.
 * - 규칙: `docs/design/04-stdin-input.md` 3.2.
 */
export interface DetachedPrefix {
  draw(): void;
}

export interface PromptRow {
  read(
    prompt: string,
    options: PromptReadOptions,
  ): Promise<string | null | typeof STDIN_EOF>;
  take(): { text: string; cursor: number } | undefined;
  detachPrefix(): DetachedPrefix;
  endRead(options: { screen: boolean }): void;
  breakLine(): void;
  clear(): void;
  notice(text: string, kind: NoticeKind): void;
}

/** `PromptRow`가 "현재 io"로 보는 최소 재료. `TerminalSurface`가 `openIo()`마다 갱신한다. */
export interface PromptRowIo {
  readonly terminal: RewindTerminal;
  readonly sinks: Pick<
    TerminalSinksInternal,
    "tail" | "resetTail" | "write" | "moveAbovePrefixToTail"
  >;
}

type PromptRowReadline = Pick<
  Readline,
  | "read"
  | "cancelRead"
  | "takeRead"
  | "hasPendingRead"
  | "abovePrefix"
  | "write"
  | "println"
>;

/**
 * - `readline`: `TerminalSurface`가 조립한 실제 `Readline`. 위젯 수명이고 io와 무관하게 하나다.
 * - `getIo`: 그 시점의 현재 io를 돌려준다(없으면 `undefined`).
 * - 행 머리 판정은 항상 현재 io 꼬리로 한다(RD-028). 위젯 터미널의 실제 커서 위치는 보지 않는다.
 *
 * module 자체는 상태를 거의 갖지 않는다. 마지막 `read()`가 연 읽기의 두 값만 둔다:
 * - `openTail`: 그 읽기의 꼬리. `take()`가 지운 조각을 다시 쓰는 데 쓴다.
 * - `rewoundRows`: 그 읽기의 `rewindTail`이 올린 행 수. 그리기 전 창 `endRead`의 커서 복귀에 쓴다.
 */
export function createPromptRow(
  readline: PromptRowReadline,
  getIo: () => PromptRowIo | undefined,
): PromptRow {
  /** 가장 최근 `read()`가 프롬프트 앞에 붙인 꼬리. `take()`가 지운 조각을 다시 쓰는 데 쓴다. */
  let openTail = "";
  /**
   * 가장 최근 `read()`의 `rewindTail`이 올린 행 수.
   * 그리기 전 창에서 끝난 읽기는 커서를 꼬리 첫 행에 둔다.
   * 그래서 `endRead`가 대체 개행 앞에 이만큼 내려 꼬리 끝으로 돌아간다(이슈 prompt-row-followups/03).
   */
  let rewoundRows = 0;

  /** "개행 쓰기": 현재 io가 있으면 그 io의 `sinks.write("\r\n")`(꼬리에 공급), 없으면 `readline.write("\r\n")`. */
  const writeNewline = () => {
    const io = getIo();
    if (io === undefined) {
      readline.write("\r\n");
      return;
    }
    io.sinks.write("\r\n");
  };

  /**
   * 현재 io 꼬리에 보이는 글자가 있을 때만 그 io에 개행을 공급한다.
   * `breakLine()` 본체이고 `endRead`의 "그리기 전 읽기 없음" 분기와 공유한다.
   * 판정은 `tail() !== ""`가 아니라 `leavesVisibleText`다.
   * 색을 안 닫고 개행으로 끝난 출력은 꼬리에 열린 SGR만 남는다.
   * 문자열은 비지 않지만 화면에는 보이는 글자가 없다.
   */
  const breakLineOnTail = () => {
    const io = getIo();
    if (io !== undefined && leavesVisibleText(io.sinks.tail()))
      io.sinks.write("\r\n");
  };

  return {
    async read(prompt, options) {
      const io = getIo();
      if (io === undefined) {
        throw new Error("promptRow.read: 현재 io가 없다");
      }
      const rewound = await rewindTail(io.terminal, io.sinks.tail());
      // flush를 기다리는 사이에 abort됐으면 읽기를 열지 않는다(열면 아무도 끝내지 않는 읽기가 남는다).
      // 되감았으면 같은 수만큼 다시 내린다.
      // abort 쪽 대체 개행이 `\x1b[nA`보다 먼저 큐에 들어갔을 수 있다.
      // xterm이 `""` 콜백 뒤 파싱을 끊으면 되감기 행 수는 개행 전 버퍼로 센다.
      // 이 CUD는 CUU 바로 뒤에 큐잉돼 파싱 순서와 무관하게 상쇄한다(이슈 prompt-row-followups/04).
      if (options.signal?.aborted) {
        if (rewound > 0) io.terminal.write(`\x1b[${rewound}B`);
        return null;
      }
      // flush를 기다리는 사이에 온 출력을 반영하려고 꼬리를 다시 읽는다.
      const tail = io.sinks.tail();
      io.sinks.resetTail();
      const composed =
        prompt === ""
          ? tail
          : tail === ""
            ? prompt
            : `${tail}${RESET}${prompt}`;
      const vendorOptions: ReadOptions = {
        cancelable: options.cancelable,
        ...options.readOptions?.(),
      };
      if (options.history === false) vendorOptions.history = false;
      if (options.eof) vendorOptions.eof = true;
      openTail = tail;
      rewoundRows = rewound;
      // 벤더 promise는 그대로 onOpen에 준다.
      // 변환하면 `.then` 한 단계가 늘어 P6a류의 "정확히 1틱" 가정이 깨진다.
      // READ_EOF → STDIN_EOF 변환은 여기 한 곳, 이 함수가 돌려주는 값에만 적용한다.
      const read = readline.read(composed, vendorOptions);
      options.onOpen?.(read);
      const result = await read;
      return result === READ_EOF ? STDIN_EOF : result;
    },
    take() {
      const prefix = readline.abovePrefix();
      const line = readline.takeRead();
      if (line === undefined) return undefined;
      const erased = [prefix, openTail].filter((part) => part !== "");
      if (erased.length > 0) {
        getIo()?.sinks.write(`${erased.join(RESET)}${RESET}\r\n`);
      }
      return line;
    },
    detachPrefix() {
      const io = getIo();
      io?.sinks.moveAbovePrefixToTail();
      return {
        draw() {
          // 호출자는 꼬리가 화면에 없을 때만 부른다(뗀 접두 또는 프롬프트 그리기가 지운 조각).
          // 꼬리는 그대로 둔다. 화면과 꼬리가 다시 같아진다(규칙: `docs/design/04-stdin-input.md` 3.2).
          // 묶인 io가 더 이상 현재 io가 아니면(닫혔거나 바뀜) 무동작.
          if (io === undefined || getIo() !== io) return;
          const tail = io.sinks.tail();
          if (tail !== "") readline.write(tail);
        },
      };
    },
    endRead(options) {
      if (!options.screen) {
        readline.cancelRead();
        return;
      }
      // pending은 취소 앞에서 읽는다 — cancelRead·takeRead·dispose가 pendingReads를 즉시 비운다(`docs/design/06-editing.md` 6.1 settle 규칙).
      const pending = readline.hasPendingRead();
      const settled = readline.cancelRead({ settle: true });
      if (settled) return;
      if (pending) {
        // 그리기 전 읽기가 있었으면 무조건 개행한다(Q1: 그려진 읽기 settle과 같은 행 수).
        // 그 읽기가 감긴 꼬리를 되감았으면 커서가 꼬리 첫 행에 있다.
        // 개행이 꼬리 둘째 행을 덮지 않게 먼저 꼬리 끝 행으로 내린다.
        if (rewoundRows > 0) readline.write(`\x1b[${rewoundRows}B`);
        writeNewline();
        return;
      }
      // 열린 읽기가 없었다: 현재 io 꼬리에 보이는 글자가 있을 때만 개행한다(`breakLine()`과 같은 규칙).
      breakLineOnTail();
    },
    breakLine() {
      breakLineOnTail();
    },
    clear() {
      readline.write(CLEAR_SCREEN);
      getIo()?.sinks.resetTail();
    },
    notice(text, kind) {
      const io = getIo();
      if (io === undefined) {
        readline.println(`${COLOR[kind]}${text}${RESET}`);
        return;
      }
      // 꼬리에 보이는 글자가 있으면 `\r\n`을 선행해 안내를 새 행으로 시작한다.
      // (`leavesVisibleText` — SGR만 남은 꼬리는 "없음")
      // 없으면 `println`과 바이트가 같다.
      // `sinks.write`는 읽는 중이 아니면 `tail.feed` + `readline.write`를 거친다.
      // 그래서 `x + "\r\n"` 텍스트가 `readline.println(x)`와 같은 바이트를 낸다.
      // 열린 읽기가 있으면 `sinks.write`가 sink 규칙대로 `printAboveRaw`로 입력줄 위에 그린다.
      // 이 경로 자체는 꼬리를 안 먹인다.
      // `detachPrefix()`(`moveAbovePrefixToTail`)를 부른 적이 없다면:
      // - 그동안 `io.sinks.tail()`은 비어 있어 `lead`가 `""`이다.
      // - 벤더 접두(`abovePrefix`)가 남아 있으면 안내가 그 접두 행에 이어 붙는다.
      // `detachPrefix()`를 부른 뒤라면:
      // - 그 접두가 꼬리로 옮겨져 있어 `io.sinks.tail()`이 비어 있지 않을 수 있다.
      // - 벤더 접두 자체는 이미 지워진 뒤다.
      // 현재 호출자는 열린 읽기 중 `notice()`를 부르지 않는다.
      // 그래서 이 조합 어느 쪽에도 도달하지 않는다(설계 공백).
      const lead = leavesVisibleText(io.sinks.tail()) ? "\r\n" : "";
      io.sinks.write(`${lead}${COLOR[kind]}${text}${RESET}\r\n`);
    },
  };
}
