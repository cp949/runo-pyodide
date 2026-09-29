import type { Input } from "./keymap";
import type { State } from "./state";

/**
 * 입력줄 조회·편집. 재그리기 대기 여부에 따라 두 구현이 있다(`Readline.view()` = `this.offscreen ?? DRAWN`).
 * 규칙: `docs/design/06-editing.md` 6.1.
 * `state`는 읽기마다 새로 만들어진다(read()의 write 콜백·취소 불가 Ctrl+C). 필드로 잡지 않고 호출마다 받는다.
 */
/**
 * 입력 하나가 어디서 왔는지.
 * - `"live"`: 지금 친 키(`onData`·Shift+Enter).
 * - `"replay"`: 활성 읽기가 없을 때 쌓인 type-ahead 재생.
 * - `"paste"`: 여러 토큰 붙여넣기 덩어리 안에서 나온 제어 문자.
 *
 * `Readline.readKey`의 Ctrl+D EOF 판정만 이 구분을 쓴다(재생·붙여넣기 안 Ctrl+D는 EOF가 아니다).
 * `Offscreen.queued`가 각 항목의 원래 origin을 들고 있다가 재그리기 뒤 그대로 재생한다.
 * 재그리기 창에서 친 키만 `"live"`이다.
 * type-ahead 재생 도중(`onKey`가 동기로 `printAbove`를 부른 경우) queued로 넘어간 항목은 `"replay"`를 유지한다.
 */
export type Origin = "live" | "replay" | "paste";

export interface LineView {
  getCursor(state: State): number;
  updateLine(state: State, text: string): void;
  editInsert(state: State, text: string): void;
  editBackspace(state: State, n: number): void;
  hasQueuedInput(): boolean;
  undrawnAbovePrefix(state: State): string;
}

/** 화면에 그려진 입력줄(또는 활성 읽기 없음). 상태가 없어 하나를 공유한다. */
export const DRAWN: LineView = {
  getCursor(state) {
    return state.cursor();
  },
  updateLine(state, text) {
    state.update(text);
  },
  editInsert(state, text) {
    state.editInsert(text);
  },
  editBackspace(state, n) {
    state.editBackspace(n);
  },
  hasQueuedInput() {
    return false;
  },
  undrawnAbovePrefix() {
    return "";
  },
};

/**
 * 재그리기 하나(구 `RedrawRun` + `queued` + `redrawCursor`).
 * 객체 identity가 무효화 토큰이다(`Readline.finishRedraw`의 `run !== this.offscreen`).
 * 콜백을 기다리는 동안 들어온 `printAbove`·`printAboveRaw` 호출은 새로 만들지 않고 여기에 합류한다.
 * `cancelRead()`·`takeRead()`·`dispose()`가 `Readline.offscreen`에서 떼어 내면 무효가 된다.
 */
export class Offscreen implements LineView {
  /** 합류한 호출 수. 각 호출의 write 콜백은 자기 순번이 마지막일 때만 다시 그린다. */
  calls = 0;
  /** 합류한 호출들의 resolve. 마지막 콜백이 다시 그린 뒤, 또는 무효가 된 뒤 첫 콜백에서 한꺼번에 부른다. */
  waiters: (() => void)[] = [];
  /**
   * 재그리기를 기다리는 동안 들어온 입력을 순서대로 쌓아 둔다.
   * `entry`: 문자열이면 `onData` 원본(키 하나 또는 붙여넣기 덩어리), `Input`이면 `onData`를 거치지 않는 Shift+Enter.
   * `origin`: 이 항목을 큐에 넣은 `dispatch` 호출이 받은 값 그대로.
   * 재생 뒤에도 그 값으로 다시 `dispatch`한다(`Readline.finishRedraw`).
   */
  queued: { entry: string | Input; origin: Origin }[] = [];

  /**
   * @param cursor 재그리기를 시작할 때의 논리 커서.
   *   `printAbove`의 `moveCursorToEnd()`가 `line.pos`를 끝으로 옮긴다.
   *   재그리기 콜백과 재그리기 중 `takeRead()`가 원래 커서를 쓰려면 따로 보관해야 한다.
   *   합류한 호출은 덮어쓰지 않는다(처음 값).
   *   재그리기 대기 중 공개 편집 API(`editInsert`·`editBackspace`·`updateLine`)는 이 커서 자리의 버퍼를 고친다.
   *   그리고 이 값을 편집 뒤 커서로 바꾼다.
   */
  constructor(public cursor: number) {}

  getCursor(): number {
    return this.cursor;
  }

  /** 입력줄이 화면에 없어 버퍼만 바꾸고, 콜백이 이 커서로 다시 그린다(이슈 10). */
  updateLine(state: State, text: string): void {
    this.cursor = state.updateOffscreen(text);
  }

  /**
   * 입력줄이 화면에 없으므로 그리지 않는다. 저장 커서 자리의 버퍼에만 넣고 저장 커서를 삽입 뒤로 옮긴다.
   * 재그리기 콜백이 그 커서로 다시 그린다(Tab 완성 삽입이 배경 출력 재그리기와 겹칠 때, 이슈 10).
   */
  editInsert(state: State, text: string): void {
    this.cursor = state.insertOffscreen(this.cursor, text);
  }

  /** 처리는 `editInsert`와 같다. */
  editBackspace(state: State, n: number): void {
    this.cursor = state.backspaceOffscreen(this.cursor, n);
  }

  hasQueuedInput(): boolean {
    return this.queued.length > 0;
  }

  /** P-d: 재그리기 대기 중이면 `activeRead`가 항상 있다. `abovePrefix()`의 활성 읽기 확인 없이 바로 접두를 돌려준다. */
  undrawnAbovePrefix(state: State): string {
    return state.promptPrefix();
  }
}

/** 기다리던 호출을 모두 resolve한다. 두 번 불려도 한 번만 resolve한다. */
export function settleRun(run: Offscreen) {
  for (const resolve of run.waiters.splice(0)) resolve();
}
