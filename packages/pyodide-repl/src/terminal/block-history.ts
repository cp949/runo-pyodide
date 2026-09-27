// 블록(`... `) 입력의 줄들을 history 항목 하나로 묶는 세션 소유 모듈(06-editing.md 6.4,
// RD-014 그릴링 확정 2). `startSession`이 `createAutoIndent` 옆에 만들어 세션과 함께 산다.
//
// 기록 방식은 진행형 교체다 — 블록 첫 줄이 append되기 직전의 history 스냅샷을 기준점으로 잡고,
// 이어지는 줄을 제출할 때마다 기준점으로 되돌린 뒤 `(pendingBlock + "\n" + 방금 줄).trimEnd()`를
// 다시 기록한다. "블록이 끝난 뒤 1회만 기록"하는 방식은 `exit()`로 끝나 다음 pending이 오지 않는
// 블록을 놓치므로(항목이 영영 안 생김) 채택하지 않았다.
//
// 종료용 공백 줄(괄호를 닫지 않고 블록을 끝내는 빈 Enter)은 벤더 `skipBlankHistory`가 걸러
// `historyEntry`를 부르지 않는다 — 그 경우 진행형 항목은 직전 줄까지 기록된 상태 그대로 남는다
// (항목 불변, 별도 처리 불필요).
import {
  InputType,
  type Input,
  type Readline,
} from "@cp949/runo-xterm-readline";
import type { ReplReadOptions } from "./line-editor";

export interface BlockHistory {
  /** REPL 읽기 하나의 옵션. pending이 있으면 블록 이어짐(기준점 고정), 없으면 블록 끝(기준점 해제). */
  readOptions(
    pending: string | undefined,
  ): Pick<ReplReadOptions, "historyEntry" | "onKey">;
  /** 열려 있는 블록을 첫 줄까지 버리고 기준점으로 되돌린다(취소·리셋). 블록이 없으면 무동작. */
  discard(): void;
}

/**
 * `readline`은 history 스냅샷·복원(`getHistory`)과 ↑ 삼킴 판정(`getLine`)에만 쓴다 — private
 * 멤버를 건드리지 않는다(ADR-0003).
 */
export function createBlockHistory(
  readline: Pick<Readline, "getHistory" | "getLine">,
): BlockHistory {
  // 가장 최근 `>>> ` 제출(블록 첫 줄) 직전의 history 스냅샷.
  let beforeFirstLine: string[] = [];
  // 열려 있는 블록의 기준점. null이면 블록 밖(`>>> `).
  let blockBase: string[] | null = null;
  // 마지막 `readOptions` 호출의 pending. `""`는 "블록 없음"과 "빈 블록 첫 줄"을 구분하지 않는다 —
  // 둘 다 continuation이 아니라는 점에서 같다(`createAutoIndent`와 같은 관례).
  let pendingBlock = "";

  // `... `의 프리필 없는 줄(들여쓰기 0으로 돌아온 줄, Ctrl+U로 지운 줄)에서만 ↑를 삼킨다. 여러 줄
  // 버퍼(Shift+Enter·붙여넣기로만 생긴다) 안에서는 줄 이동이라 삼키지 않는다. 동치 근거: 프리필이
  // 남아 있는 한 줄 버퍼에서는 벤더 ↑가 이미 무동작이라(`state.ts`의 `previousHistory` 가드) 삼겨도
  // 화면이 같다.
  const onKey = (input: Input): boolean =>
    input.inputType === InputType.ArrowUp &&
    pendingBlock !== "" &&
    !readline.getLine().includes("\n");

  return {
    readOptions(pending) {
      pendingBlock = pending ?? "";
      blockBase = pending === undefined ? null : (blockBase ?? beforeFirstLine);
      return {
        historyEntry(line) {
          const history = readline.getHistory();
          if (blockBase === null) {
            beforeFirstLine = history.entries.slice();
            return line;
          }
          history.restore(blockBase);
          return `${pendingBlock}\n${line}`.trimEnd();
        },
        onKey,
      };
    },
    discard() {
      if (blockBase !== null) {
        readline.getHistory().restore(blockBase);
        blockBase = null;
      }
    },
  };
}
