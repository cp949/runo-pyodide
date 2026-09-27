/**
 * 줄 편집 정책 3종(autoIndent·blockHistory·tabReader)을 한 객체로 묶는다(`docs/design/06-editing.md` 6.8,
 * RD-029 design.md §4, Q8). 세 정책의 생성 순서·수명은 이 편집기와 같다(= 세션 하나, `08-session.md` 8.1).
 * driver는 이 interface 넷(`begin`·`end`·`dispose`·`requesting`)으로만 편집 정책을 만난다 — 어떤 정책이 몇 개
 * 있는지, 그 정책들의 `readOptions`를 어떤 순서로 합성하는지는 이 모듈 밖에서 알 필요가 없다.
 */
import type { Input, ReadOptions } from "@cp949/runo-xterm-readline";
import type { SurfaceReadline } from "@cp949/runo-pyodide-terminal/internal";
import type { SourceCompletion } from "../worker/complete-source";
import { createAutoIndent } from "./auto-indent";
import { createBlockHistory } from "./block-history";
import type { CompletionPopover } from "./completion-popover";
import { createTabReader } from "./tab-reader";

export type ReplReadOptions = Pick<
  ReadOptions,
  "prefill" | "prefillCursor" | "onKey" | "historyEntry"
>;

/** 읽기 하나의 결말(driver `readLine` 핸들러가 낸다). */
export type ReadEnd =
  | { kind: "line"; line: string }
  | { kind: "cancel" }
  | { kind: "taken" }
  | { kind: "eof" };

export interface LineEditorDeps {
  /** worker의 `complete`를 부른다(tabReader가 쓴다). */
  complete(
    source: string,
    pending: string | undefined,
  ): Promise<SourceCompletion>;
  /** 왕복 중 취소됐을 때 worker의 완성 계산을 멎게 한다. */
  interruptCompletion(): void;
  /** 있으면(옵션 켬, RD-049) E0(onKey 맨 앞)·C1(읽기 끝·세션 종료에 닫기)로 관여한다. tabReader로도 넘긴다(W3, 목록 열기). */
  popover?: CompletionPopover;
}

export interface LineEditor {
  /** 읽기마다 한 번, `promptRow.read`의 `readOptions` thunk 안에서(flush 뒤) 부른다. `restore`가 있으면(텍스트가
   * 비어 있지 않으면) autoIndent의 prefill보다 우선해 덮어쓴다 — 소비는 이 호출 시점이다. */
  begin(
    pending: string | undefined,
    restore?: { text: string; cursor: number },
  ): ReplReadOptions;
  /** 읽기가 끝났다(줄 제출·취소·`sendSource()`가 가져감). */
  end(result: ReadEnd): void;
  /** 세션 종료(`terminate` 훅). `readOpen` = REPL 읽기 phase가 `opening`·`open`·`closing` 중 하나. */
  dispose(readOpen: boolean): void;
  /** Tab `complete` 왕복 중인가(`sourcePrompt` busy 재료). */
  readonly requesting: boolean;
}

/** 여러 정책의 `ReplReadOptions`를 하나로 합친다(`onKey`는 순서대로 불러 먼저 소비한 쪽에서 멈추고,
 * `prefill`·`historyEntry`는 뒤가 이긴다). 이 모듈 밖에는 내지 않는다 — 합성 순서 자체가 이 모듈의 규칙(E2·E3)이다. */
function composeOptions(parts: ReplReadOptions[]): ReplReadOptions {
  const onKeys = parts
    .map((part) => part.onKey)
    .filter(
      (onKey): onKey is NonNullable<ReplReadOptions["onKey"]> =>
        onKey !== undefined,
    );

  const result: ReplReadOptions = {};
  if (onKeys.length > 0) {
    result.onKey = (input) => onKeys.some((onKey) => onKey(input));
  }
  for (const part of parts) {
    if (part.prefill !== undefined) result.prefill = part.prefill;
    if (part.historyEntry !== undefined)
      result.historyEntry = part.historyEntry;
  }
  return result;
}

export function createLineEditor(
  readline: SurfaceReadline,
  deps: LineEditorDeps,
): LineEditor {
  const popover = deps.popover;
  // E1: 생성 순서 autoIndent → blockHistory → tabReader. 세 정책의 수명 = 편집기 수명 = 세션.
  const autoIndent = createAutoIndent(readline);
  const blockHistory = createBlockHistory(readline);
  const tabReader = createTabReader(readline, {
    complete: deps.complete,
    interruptCompletion: deps.interruptCompletion,
    popover,
  });
  // M1(클릭 적용)은 onKey를 거치지 않아 아래 `withPopover`의 onKey 기반 리셋이 못 본다 — popover가
  // 직접 알려온다(opus 리뷰 지적: 클릭 적용 뒤 Tab 한 번에 목록이 곧바로 다시 열리던 결함).
  popover?.onApplied(() => tabReader.resetTabStreak());

  return {
    begin(pending, restore) {
      // E2: 이 순서로 부른다(부작용: autoIndent `pendingBlock`·`lastUsedIndentation`, tabReader 세대).
      const composed = composeOptions([
        blockHistory.readOptions(pending),
        autoIndent.readOptions(pending),
        tabReader.readOptions(pending),
      ]);
      // E0: popover가 있으면 그 onKey를 맨 앞에 둔다 — 열려 있는 동안 ↑↓ 등이 blockHistory보다 먼저
      // popover로 간다. popover가 키를 소비하면(K1~K3·M1은 키 입력이 아니지만 다음 실키가 이 경로를 탄다)
      // tabReader의 `onKey`가 전혀 불리지 않아 "직전 키가 Tab" 판정이 낡은 채로 남는다 — 여기서 대신 끈다
      // (리뷰 발견: popover로 후보를 적용한 뒤 Tab 한 번에 목록이 곧바로 다시 열리던 결함).
      const withPopover = popover
        ? {
            ...composed,
            onKey: (input: Input) => {
              if (popover.onKey(input)) {
                tabReader.resetTabStreak();
                return true;
              }
              return composed.onKey?.(input) ?? false;
            },
          }
        : composed;
      // E5: restore가 있고 비어 있지 않으면 autoIndent prefill보다 우선한다. 소비는 지금(이 호출 시점)이다 —
      // 호출자가 요청 시점(P3)이 아니라 여기서 읽은 값만 넘겨준다.
      if (restore === undefined || restore.text === "") return withPopover;
      return {
        ...withPopover,
        prefill: restore.text,
        prefillCursor: restore.cursor,
      };
    },
    end(result) {
      // C1: 읽기가 끝나면(분기 무관) popover를 닫는다.
      popover?.close();
      switch (result.kind) {
        case "line":
          // E6
          tabReader.readEnded(result.line);
          return;
        case "cancel":
          // E7: 이 순서(readEnded 먼저, discard 나중).
          tabReader.readEnded(null);
          blockHistory.discard();
          return;
        case "eof":
          // E11: `>>>`만 EOF를 받는다 — 열린 블록이 없으니 discard가 없다(취소와 다른 점, RD-048).
          tabReader.readEnded(null);
          return;
        case "taken":
          // E8
          tabReader.readEnded("");
          return;
      }
    },
    dispose(readOpen) {
      // E9: `discard()`는 읽기가 열려 있던 경우에만 — 실행 중·`exit()`로 끝난 블록은 여기서
      // 버리지 않는다. `tabReader.readEnded(null)`은 readOpen과 무관하게 항상 부른다 — 뒤이은
      // core의 `rpc.dispose()`가 대기 중인 `complete` 요청을 reject하면 큐 재처리가 취소된 세션의 buffer/cursor를
      // 읽어 엉뚱한 삽입을 낼 수 있어(DELTA-04a Important-2), 읽기가 열려 있지 않았어도 tabReader는 먼저 끝내 둔다.
      if (readOpen) blockHistory.discard();
      tabReader.readEnded(null);
      // C1(세션 종료): close()를 dispose() 구현에 기대지 않고 명시적으로도 부른다(CompletionPopover
      // 인터페이스 계약만으로는 dispose()가 close() 상당을 포함하는지 보장되지 않는다).
      popover?.close();
      popover?.dispose();
    },
    get requesting() {
      // E10
      return tabReader.requesting;
    },
  };
}
