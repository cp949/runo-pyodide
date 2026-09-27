/**
 * Tab 키를 세션 소유 정책 객체로 감싼다(docs/design/07-tab-completion.md 7.1~7.3, RD-015 DELTA-04).
 * `planTab`·`resolveCompletion`·`formatCompletionList`(DELTA-02, `tab-completion.ts`의 순수 함수)의
 * 계산과 worker `complete` RPC(DELTA-03, `worker/complete-source.ts`) 왕복을 잇는다.
 * `createAutoIndent`·`createBlockHistory`와 같은 패턴이다 — `readOptions(pending)`이 그 읽기 하나의
 * `onKey`를 내준다.
 *
 * 상태 요약:
 *
 * | 상태          | 뜻                                                                  |
 * | ------------- | -------------------------------------------------------------------- |
 * | generation    | 읽기 세대. `readOptions` 호출마다 1 증가. 옛 세대의 응답·큐는 버린다.  |
 * | ended         | 현재 세대의 읽기가 끝났는가(`readEnded` 호출 이후). 끝난 세대는 Tab 무동작. |
 * | pendingBlock  | `... ` 줄의 이어지는 블록 텍스트. `complete` 요청의 `pending`으로 넘긴다.  |
 * | lastKeyWasTab | 직전 키가 Tab이었는가. 연속 두 번째 Tab만 목록을 연다.                |
 * | requesting    | `complete` 왕복이 진행 중인가. 참이면 다음 Tab은 `queuedTabs`에 쌓인다. |
 * | queuedTabs    | 왕복 중 눌린 Tab들(`{ generation, second }`). 응답 뒤 순서대로 처리한다. |
 *
 * 응답 적용 조건(`applyResume`): 세대가 같고, 읽기가 끝나지 않았고, 버퍼·커서가 요청 시점과 같아야
 * 삽입·목록을 적용한다. 하나라도 어긋나면(경합) 버린다(그릴링 확정 3).
 *
 * 취소 인터럽트 조건(`readEnded`): 왕복 중(`requesting`)에 `null` 응답(Ctrl+C 취소)으로 읽기가
 * 끝나면 `interruptCompletion()`을 1회 부른다 — worker의 완성 계산(임의 `repr()` 실행 등)이 멎어
 * 있을 수 있어 비워 둔다. Enter로 끝나거나 요청이 없으면 부르지 않는다.
 */
import {
  InputType,
  type Input,
  type Readline,
} from "@cp949/runo-xterm-readline";
import type { SourceCompletion } from "../worker/complete-source";
import type { CompletionPopover } from "./completion-popover";
import type { ReplReadOptions } from "./line-editor";
import {
  formatCompletionList,
  planTab,
  resolveCompletion,
} from "./tab-completion";

export interface TabReaderDeps {
  /** worker `complete` RPC 호출. `pending`은 `... ` 블록의 이어지는 텍스트(RD-016 대비). */
  complete(
    source: string,
    pending: string | undefined,
  ): Promise<SourceCompletion>;
  /** 왕복 중 취소됐을 때 worker의 완성 계산을 멎게 한다(`InterruptSender.send()`). */
  interruptCompletion(): void;
  /** 있으면 `list` 액션을 텍스트 목록 대신 이걸로 연다(옵션 켬, RD-049). */
  popover?: CompletionPopover;
}

export interface TabReader {
  /** REPL 읽기 하나의 옵션. 새 세대를 열고 이번 읽기의 상태를 리셋한다. */
  readOptions(pending: string | undefined): Pick<ReplReadOptions, "onKey">;
  /** 현재 세대의 읽기가 끝났다(Enter → 문자열, Ctrl+C 취소 → `null`). */
  readEnded(line: string | null): void;
  /** `complete` 왕복이 진행 중인가(`runSource`가 이 동안 `busy`로 거부한다). 읽기만 하는 값이다. */
  readonly requesting: boolean;
  /**
   * 연속 두 번째 Tab 판정("직전 키가 Tab")을 끈다. popover(E0)가 이 모듈의 `onKey`보다 먼저 키를
   * 소비하면(`composeOptions`가 그 자리에서 멈춰) 이 `onKey`가 전혀 불리지 않아 `lastKeyWasTab`이
   * 낡은 채로 남는다 — line-editor가 popover 소비를 감지해 이 메서드로 대신 끈다(RD-049 리뷰 발견).
   */
  resetTabStreak(): void;
}

type TabReaderReadline = Pick<
  Readline,
  | "getLine"
  | "getCursor"
  | "editInsert"
  | "tty"
  | "printAbove"
  | "hasQueuedInput"
>;

/** 왕복 중 눌려 큐에 쌓인 Tab 하나. */
interface QueuedTab {
  generation: number;
  second: boolean;
}

/** 왕복 시작 시점의 스냅샷. 응답이 오면 이 시점의 버퍼·커서·세대와 지금을 비교해 경합을 가른다. */
interface RequestSnapshot {
  generation: number;
  buf: string;
  pos: number;
  second: boolean;
}

export function createTabReader(
  readline: TabReaderReadline,
  deps: TabReaderDeps,
): TabReader {
  let generation = 0;
  // 첫 `readOptions` 전에는 활성 읽기가 없어 벤더가 onKey 자체를 부르지 않지만, 방어적으로 "끝남"을
  // 기본값으로 둔다.
  let ended = true;
  let pendingBlock = "";
  let lastKeyWasTab = false;
  let requesting = false;
  let queuedTabs: QueuedTab[] = [];

  /**
   * 응답을 지금 적용해도 되는지 판정하고, 되면 삽입하거나 목록을 연다. `list` 분기는
   * `printAbove`가 돌려주는 프로미스를 그대로 반환한다 — `handleTab`의 `.then(applyResume)`이
   * 이 프로미스를 체인하므로, 재그리기가 실제로 끝난 뒤에야 `.finally(drainQueue)`가 큐의
   * 다음 Tab을 처리한다(재그리기 중 벤더 큐를 우회해 옮겨진 커서로 계산하는 것을 막는다,
   * DELTA-04a Important-1). `insert`/`none` 분기는 즉시 끝나므로 프로미스를 반환할 필요 없다.
   */
  function applyResume(
    snap: RequestSnapshot,
    { completions, start }: SourceCompletion,
  ): void | Promise<void> {
    if (
      snap.generation !== generation ||
      ended ||
      readline.getLine() !== snap.buf ||
      readline.getCursor() !== snap.pos ||
      // 재그리기 대기 중 친 키는 벤더 큐에만 있고 버퍼에 없어 위 비교를 통과한다. 큐가 있으면 삽입·목록 모두 버린다(이슈 16).
      readline.hasQueuedInput()
    ) {
      return;
    }
    const action = resolveCompletion({
      buf: snap.buf,
      pos: snap.pos,
      second: snap.second,
      completions,
      start,
    });
    if (action.kind === "insert") {
      readline.editInsert(action.text);
    } else if (action.kind === "list") {
      if (deps.popover) {
        deps.popover.open(action.completions, action.stem);
        return;
      }
      return readline.printAbove(
        formatCompletionList(action.completions, readline.tty().col).join("\n"),
      );
    }
  }

  /**
   * 왕복이 끝난 뒤(성공·실패 모두) 큐에 남은 Tab을 이어 처리한다. 옛 세대 항목은 버리고 계속
   * 넘어간다. 처리한 Tab이 `indent`(공백 삽입)나 무동작으로 끝나 `requesting`이 다시 `true`가
   * 되지 않으면(`handleTab`이 `deps.complete()`를 부르지 않았다는 뜻) 그 Tab은 비동기 왕복을
   * 시작하지 않았으므로, 큐가 비거나 새 왕복이 시작될 때까지 다음 큐 항목을 계속 처리한다 — 그러지
   * 않으면 `indent` 경로를 탄 큐 Tab 뒤에 남은 항목이 다음 왕복이 끝날 때까지(또는 영원히)
   * 방치된다(리뷰 Important-1).
   */
  function drainQueue(): void {
    requesting = false;
    let next = queuedTabs.shift();
    while (next !== undefined) {
      if (next.generation !== generation) {
        next = queuedTabs.shift();
        continue;
      }
      handleTab(next.second);
      if (requesting) return; // 새 왕복이 시작됐다 — 그 응답의 finally(drainQueue)가 이어 받는다.
      next = queuedTabs.shift();
    }
  }

  function handleTab(second: boolean): void {
    // W3: 열린 popover가 있으면 이 Tab(큐에서 꺼낸 것 포함)은 버린다 — 새 왕복을 시작하지 않는다.
    if (deps.popover?.isOpen) return;
    if (ended) return;
    if (requesting) {
      queuedTabs.push({ generation, second });
      return;
    }
    const buf = readline.getLine();
    const pos = readline.getCursor();
    const plan = planTab(buf, pos, pendingBlock || undefined);
    if (plan.kind === "indent") {
      readline.editInsert(plan.text);
      return;
    }
    const snap: RequestSnapshot = { generation, buf, pos, second };
    requesting = true;
    deps
      .complete(plan.source, pendingBlock || undefined)
      .then((result) => applyResume(snap, result))
      .catch(() => {
        // 요청 실패(rpc dispose 등)는 무동작 — 큐는 `finally`가 이어 처리한다.
      })
      .finally(drainQueue);
  }

  const onKey = (input: Input): boolean => {
    const isTab =
      input.inputType === InputType.UnsupportedControlChar &&
      input.data[0] === "\t";
    if (!isTab) {
      lastKeyWasTab = false;
      return false;
    }
    handleTab(lastKeyWasTab);
    lastKeyWasTab = true;
    return true;
  };

  return {
    readOptions(pending) {
      generation += 1;
      ended = false;
      pendingBlock = pending ?? "";
      lastKeyWasTab = false;
      queuedTabs = [];
      return { onKey };
    },
    readEnded(line) {
      ended = true;
      if (line === null && requesting) deps.interruptCompletion();
      queuedTabs = [];
    },
    resetTabStreak() {
      lastKeyWasTab = false;
    },
    get requesting() {
      return requesting;
    },
  };
}
