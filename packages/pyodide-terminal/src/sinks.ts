/**
 * main이 터미널에 쓰는 sink 4종과 꼬리 추적(05-output.md 4.1). worker의 출력 알림과 콘솔 콜백·전역 스트림이 모두
 * 이 함수들을 지나므로 개행·색 규칙이 한곳에 있다. `Readline`은 읽기 밖에서 `print`/`println`만 쓴다(ADR-0003).
 *
 * 열린 읽기(프롬프트가 그려진 REPL `>>> `·`... `·`input()` 읽기) 중 출력(asyncio task·`call_later` 콜백·전역 스트림)은
 * 벤더 `printAboveRaw`로 보낸다(RD-022b): 벤더가 입력줄을 지우고 완성 행을 쓴 뒤 같은 읽기를 그 아래에 다시 그리고, 개행 없이
 * 끝난 나머지는 프롬프트 앞 접두로 그린다. 읽기 중 출력은 꼬리 추적기에 먹이지 않는다 — 접두는 벤더가 보관하고, 읽기가 끝나면
 * 그 행째 화면에 남으므로 다음 읽기의 꼬리가 되지 않는다.
 */
import type { Readline } from "@cp949/runo-xterm-readline";
import { createOutputTail, leavesVisibleText } from "@cp949/runo-pyodide-core";

export const RED = "\x1b[31m";
export const RESET = "\x1b[0m";

/** 소비자(`SurfaceIo.sinks`)가 보는 쓰기 4종. 꼬리 재료는 내지 않는다(`TerminalSinksInternal`이 prompt-row 전용으로 낸다, RD-027 DELTA-04). */
export interface TerminalSinks {
  /** 값 에코·배너. 끝 개행 없는 텍스트를 받고 sink가 `\r\n`을 붙인다. */
  writeOutput(text: string): void;
  /** 트레이스백·SyntaxError. 줄 전체를 빨강으로 한 번 감싸고 `\r\n`을 붙인다. */
  writeError(text: string): void;
  /** stdout 조각·전역 stdout·`^C` 에코. 조각 그대로, 개행 강제 없음. 빈 조각은 무출력. */
  write(text: string): void;
  /** stderr 조각·전역 stderr. 조각마다 빨강을 열고 닫는다(무상태). 빈 조각은 무출력. */
  writeErrorRaw(text: string): void;
}

/** `TerminalSinks` + 꼬리 재료. `PromptRow`(`./prompt-row`)가 "현재 io"의 꼬리를 다루는 내부 타입이다. 소비자 타입(`SurfaceIo.sinks`)에는 내지 않는다. */
export interface TerminalSinksInternal extends TerminalSinks {
  tail(): string;
  resetTail(): void;
  /**
   * 열린 읽기의 프롬프트 앞 접두(`Readline.abovePrefix()`)를 입력줄에서 떼어(접두 없이 다시 그림) 꼬리로 옮긴다(RD-022b).
   * `promptRow.detachPrefix()`(RD-027)의 내부 재료다 — REPL 읽기 중 배경 `input("bg> ")`이 미뤄질 때 read-guard가
   * `promptRow.detachPrefix()`로 부른다: `bg> `가 REPL 줄 앞에 남지 않고 미뤄진 stdin 읽기의 프롬프트가 된다. 꼬리는
   * 접두로 바꾼다 — 열린 읽기의 행에는 접두 뒤 프롬프트뿐이고, 그리기 전에 꼬리에 들어간 조각은 프롬프트 그리기(`\r\x1b[J`)가
   * 지웠다. 접두가 없으면(열린 읽기가 없을 때 포함) 아무것도 하지 않는다.
   */
  moveAbovePrefixToTail(): void;
}

/** 열린 읽기 위 출력의 분리 결과. `Readline.printAboveRaw(lines, prefix)`의 두 인자다. */
export interface AboveReadSplit {
  /** 입력줄 위에 쓸 완성 행. 빈 문자열이거나 `\n`으로 끝난다. */
  lines: string;
  /** 프롬프트 앞에 그릴 새 접두. `\n`·`\r`이 없다. */
  prefix: string;
  /**
   * 다음 조각 앞에 `prefix` 대신 이어 붙일 원문. 마지막 행이 `\r`로 끝나(뒤에 SGR만 있어도) 커서가 행 머리에 있을 때만 있다 —
   * `prefix`만 이으면 다음 조각이 접두를 덮어쓰지 않고 뒤에 붙는다(`10%` + `20%\r` → `10%20%`).
   */
  resume?: string;
}

/**
 * 열린 읽기의 현재 접두 `prefix`(또는 앞 분리의 `resume`) 뒤에 출력 `text`가 왔을 때 완성 행과 새 접두로 나눈다. `prefix + text`의
 * 마지막 `\n`까지가 완성 행(벤더가 접두째 지우므로 앞 접두를 이어 쓴다)이고, 새 접두는 꼬리 규칙(04-stdin-input.md 3.3: 마지막
 * `\n` 뒤, 그 안의 마지막 `\r` 뒤, 줄 경계를 넘어 열린 SGR을 앞에 이어 붙임)을 `createOutputTail`로 그대로 계산한 값이다.
 * 예외: 마지막 `\r` 뒤에 보이는 글자가 없으면(`100%\r`·`50%\r\x07`, 05-output.md 4.4) 꼬리 규칙은 빈 접두를 내 조각이 사라지므로, 그 행에서
 * 마지막으로 보이는 `\r` 구간까지 먹인 꼬리를 접두로 하고 나머지(`\r`부터)를 붙인 원문을 `resume`으로 준다. "보이는 글자"는 꼬리
 * 정규화와 같은 기준(core `leavesVisibleText`)이라야 한다 — 정규화가 지우는 BEL·BS를 글자로 세면 접두가 빈 문자열이 되어 화면의
 * 진행률이 통째로 사라진다. `\n` → `\r\n` 정규화는 벤더 `write`가 한다.
 */
export function splitAboveRead(prefix: string, text: string): AboveReadSplit {
  const full = prefix + text;
  const lineStart = full.lastIndexOf("\n") + 1;
  const lines = full.slice(0, lineStart);
  const tail = createOutputTail();
  tail.feed(full);
  const next = tail.value();
  const lastLine = full.slice(lineStart);
  const lastCr = lastLine.lastIndexOf("\r");
  if (lastCr === -1 || leavesVisibleText(lastLine.slice(lastCr + 1))) {
    return { lines, prefix: next };
  }
  // 마지막으로 보이는 `\r` 구간의 끝(그 뒤 `\r`의 위치)을 찾는다.
  let end = lastCr;
  while (end > 0) {
    const start = lastLine.lastIndexOf("\r", end - 1) + 1;
    if (leavesVisibleText(lastLine.slice(start, end))) break;
    end = start - 1;
  }
  if (end <= 0) return { lines, prefix: next };
  const kept = createOutputTail();
  kept.feed(full.slice(0, lineStart + end));
  const shown = kept.value();
  return { lines, prefix: shown, resume: shown + lastLine.slice(end) };
}

/**
 * 보관할 `resume`(`prefix` + `\r`부터의 나머지)을 줄인다. 나머지는 `\r`과 SGR뿐이므로(보이는 글자가 없는 구간) 연속 `\r`은 하나로,
 * SGR은 `createOutputTail`로 계산한 순효과(모두 끄고 열린 SGR을 다시 켬)로 바꾼다. 그대로 보관하면 `\r`·`\x1b[0m`만 오는 조각마다
 * 보관 원문이 자라 조각 수의 제곱으로 다시 분리한다(second-opinion 2차 SO2-S1).
 */
function compactResume(prefix: string, resume: string): string {
  // `replaceAll`(Chrome 85+)은 빌드 floor Chrome 84를 넘는다(ADR-0008) — `\r`은 정규식 특수문자가 아니지만 split/join으로
  // 대체해 일관되게 둔다.
  const sgr = resume.slice(prefix.length).split("\r").join("");
  if (sgr === "") return `${prefix}\r`;
  const state = createOutputTail();
  state.feed(`${prefix}${sgr}\r`);
  return `${prefix}\r${RESET}${state.value()}`;
}

/** sink 세트는 worker(세션)마다 새로 만든다 — 새 세션이 이전 꼬리를 물려받지 않게. */
export function createTerminalSinks(
  readline: Pick<
    Readline,
    "print" | "println" | "isReading" | "abovePrefix" | "printAboveRaw"
  >,
): TerminalSinksInternal {
  const tail = createOutputTail();
  /**
   * 마지막 분리가 준 `resume`(`compactResume`으로 줄인 값)과 그때 벤더에 넘긴 접두. 벤더 접두가 그 뒤 바뀌었으면(Tab 목록·새 읽기가
   * 비움) 쓰지 않는다.
   */
  let resume: { prefix: string; text: string } | undefined;
  /** 열린 읽기 위에 쓴다. 꼬리 추적기는 건드리지 않는다(읽기 중 접두는 벤더가 보관한다). */
  const printAboveRead = (text: string) => {
    const current = readline.abovePrefix();
    const previous =
      resume !== undefined && resume.prefix === current ? resume.text : current;
    const split = splitAboveRead(previous, text);
    resume =
      split.resume === undefined
        ? undefined
        : {
            prefix: split.prefix,
            text: compactResume(split.prefix, split.resume),
          };
    void readline.printAboveRaw(split.lines, split.prefix);
  };
  const print = (text: string) => {
    if (readline.isReading()) {
      printAboveRead(text);
      return;
    }
    tail.feed(text);
    readline.print(text);
  };
  // println은 sink가 붙이는 개행도 추적기에 알린다(TRAP-29: fake가 이것을 모사하지 않아 이중 개행을 놓쳤다).
  const println = (text: string) => {
    if (readline.isReading()) {
      printAboveRead(`${text}\n`);
      return;
    }
    tail.feed(`${text}\n`);
    readline.println(text);
  };
  return {
    writeOutput: (text) => println(text),
    writeError: (text) => println(`${RED}${text}${RESET}`),
    write: (text) => {
      if (text !== "") print(text);
    },
    writeErrorRaw: (text) => {
      if (text !== "") print(`${RED}${text}${RESET}`);
    },
    tail: () => tail.value(),
    resetTail: () => tail.reset(),
    moveAbovePrefixToTail: () => {
      const prefix = readline.abovePrefix();
      if (prefix === "") return;
      void readline.printAboveRaw("", "");
      tail.reset();
      tail.feed(prefix);
    },
  };
}
