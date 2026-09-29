// 자동 들여쓰기 순수 로직. CPython 3.14 `_pyrepl/readline.py`의 `maybe_accept`가 개행 뒤에 채우는
// 들여쓰기 규칙을 옮겼다(docs/design/06-editing.md 6.3).
// `createAutoIndent`가 이 순수 함수를 세션 소유 상태(`lastUsedIndentation`)와 묶어 벤더 `ReadOptions`로 바꾼다.

import {
  InputType,
  type Input,
  type Readline,
} from "@cp949/runo-xterm-readline";
import type { ReplReadOptions } from "./line-editor";

export interface NextIndentation {
  // 개행 바로 뒤에 넣을 공백(직전 줄에서 이어받은 들여쓰기 + `:` 뒤 추가분).
  indentation: string;
  // 세션 동안 유지되는 "마지막으로 본 첫 들여쓰기"(`_pyrepl`의 `last_used_indentation`).
  lastUsedIndentation: string | null;
}

export const DEFAULT_UNIT = "    ";

function isIndentChar(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

// `_get_first_indentation`: 버퍼에서 처음 나온 (공백만이 아닌) 들여쓴 줄의 들여쓰기.
function firstIndentation(buffer: string): string | null {
  let indentedLineStart: number | null = null;
  for (let i = 0; i < buffer.length; i++) {
    if (
      i < buffer.length - 1 &&
      buffer[i] === "\n" &&
      isIndentChar(buffer[i + 1])
    ) {
      indentedLineStart = i + 1;
    } else if (
      indentedLineStart !== null &&
      !isIndentChar(buffer[i]) &&
      buffer[i] !== "\n"
    ) {
      return buffer.slice(indentedLineStart, i);
    }
  }
  return null;
}

// `_get_previous_line_indent`: 커서가 있는 줄의 시작 위치와 들여쓰기 글자 수.
// 커서 앞이 공백뿐인 줄은 들여쓰기 없음(null).
function previousLineIndent(
  buffer: string,
  pos: number,
): { lineStart: number; indent: number | null } {
  let lineStart = pos;
  while (lineStart > 0 && buffer.charAt(lineStart - 1) !== "\n") lineStart--;
  let textStart = lineStart;
  while (textStart < pos && isIndentChar(buffer.charAt(textStart))) textStart++;
  return {
    lineStart,
    indent: textStart === pos ? null : textStart - lineStart,
  };
}

// `_should_auto_indent`: pos 앞의 마지막 의미 있는 글자가 `:`인지 판정한다.
// 공백·개행은 건너뛴다. 줄 끝 `#` 주석은 무시한다.
// 문자열 안의 `#`도 주석으로 오인한다(3.14와 같다).
function shouldAutoIndent(buffer: string, pos: number): boolean {
  let lastChar: string | null = null;
  while (pos > 0) {
    pos--;
    const char = buffer.charAt(pos);
    if (lastChar === null) {
      if (!" \t\n#".includes(char)) lastChar = char;
    } else {
      // 의미 있는 글자를 찾은 뒤에도 줄 시작까지 거슬러 올라간다. `#`가 있으면 주석으로 취급한다.
      if (char === "\n") break;
      if (char === "#") lastChar = null;
    }
  }
  return lastChar === ":";
}

// 들여쓰기 단위의 폭. 스페이스 단위면 그 길이. 탭이거나 본 적이 없으면 4칸.
export function indentUnitWidth(lastUsedIndentation: string | null): number {
  return lastUsedIndentation !== null && /^ +$/.test(lastUsedIndentation)
    ? lastUsedIndentation.length
    : DEFAULT_UNIT.length;
}

// `backspace_dedent`: Backspace 한 번에 지울 글자 수(1이면 평소처럼 한 글자).
// 커서 앞이 스페이스뿐이고 연속 줄일 때만 직전 단위 배수까지 지운다.
// continuation: 버퍼의 첫 줄이 블록의 이어지는 줄이면(`... ` 입력줄) true.
// 3.14는 이전 줄들의 더 얕은 들여쓰기 수준까지 지운다. 여기서는 단위 배수로 단순화했다.
// 들여쓰기가 단위 배수이면 결과가 같다(편차 12, `docs/design/10-parity-deviations.md`).
export function backspaceCount(
  buffer: string,
  pos: number,
  unitWidth: number,
  continuation: boolean,
): number {
  const lineStart = buffer.lastIndexOf("\n", pos - 1) + 1;
  const prefix = buffer.slice(lineStart, pos);
  if (!/^ +$/.test(prefix)) return 1;
  if (lineStart === 0 && !continuation) return 1;
  return prefix.length % unitWidth || unitWidth;
}

// buffer는 편집 버퍼 전체, pos는 Enter를 누른 커서 위치다.
export function nextIndentation(
  buffer: string,
  pos: number,
  lastUsedIndentation: string | null,
): NextIndentation {
  const { lineStart, indent } = previousLineIndent(buffer, pos);
  const kept = indent ? buffer.slice(lineStart, lineStart + indent) : "";
  // `_pyrepl`은 개행과 이어받은 들여쓰기를 넣은 버퍼에서 첫 들여쓰기를 다시 읽어 갱신한다.
  const next = buffer.slice(0, pos) + "\n" + kept + buffer.slice(pos);
  const unit = firstIndentation(next) ?? lastUsedIndentation;
  const extra = shouldAutoIndent(next, pos + 1 + kept.length)
    ? (unit ?? DEFAULT_UNIT)
    : "";
  return { indentation: kept + extra, lastUsedIndentation: unit };
}

export interface AutoIndent {
  /** REPL 읽기 하나의 옵션. `pending`이 없으면 prefill 없음(`onKey`는 항상 있다). */
  readOptions(pending: string | undefined): ReplReadOptions;
}

/**
 * `pending`(worker가 보낸, 아직 제출되지 않은 블록 줄들)을 프리필·Shift+Enter·Alt+Enter·Backspace
 * 정책으로 바꾼다.
 * `lastUsedIndentation`은 이 객체가 사는 동안(세션 하나) 유지된다.
 * 새 세션은 `createAutoIndent`를 다시 불러 4칸(`DEFAULT_UNIT`)으로 되돌아간다(`08-session.md` 8.1).
 */
export function createAutoIndent(
  readline: Pick<
    Readline,
    "getLine" | "getCursor" | "editInsert" | "editBackspace"
  >,
): AutoIndent {
  let lastUsedIndentation: string | null = null;
  // 마지막 `readOptions` 호출의 `pending`. `""`는 "블록 없음"과 "빈 블록 첫 줄"을 구분하지 않는다.
  // 둘 다 continuation이 아니라는 점에서 같다.
  let pendingBlock = "";

  const onKey = (input: Input): boolean => {
    if (
      input.inputType === InputType.ShiftEnter ||
      input.inputType === InputType.AltEnter
    ) {
      const buf = readline.getLine();
      const pos = readline.getCursor();
      const prefix = pendingBlock ? pendingBlock + "\n" : "";
      const next = nextIndentation(
        prefix + buf,
        prefix.length + pos,
        lastUsedIndentation,
      );
      lastUsedIndentation = next.lastUsedIndentation;
      readline.editInsert("\n" + next.indentation);
      return true;
    }
    if (input.inputType === InputType.Backspace) {
      const buf = readline.getLine();
      const pos = readline.getCursor();
      const count = backspaceCount(
        buf,
        pos,
        indentUnitWidth(lastUsedIndentation),
        pendingBlock !== "",
      );
      if (count > 1) {
        readline.editBackspace(count);
        return true;
      }
      return false;
    }
    // Enter·Ctrl+C를 포함한 나머지는 소비하지 않는다. 취소·제출은 벤더 그대로.
    return false;
  };

  return {
    readOptions(pending) {
      pendingBlock = pending ?? "";
      if (pending === undefined) return { onKey };
      const next = nextIndentation(
        pending,
        pending.length,
        lastUsedIndentation,
      );
      lastUsedIndentation = next.lastUsedIndentation;
      return next.indentation === ""
        ? { onKey }
        : { prefill: next.indentation, onKey };
    },
  };
}
