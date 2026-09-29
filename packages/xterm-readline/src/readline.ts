/**
 * xterm addon `Readline`.
 * 줄 입력(`read`), 입력줄 위 출력(`printAbove`·`printAboveRaw`), 읽기 종료(`cancelRead`·`takeRead`·`dispose`)를 맡는다.
 * 규칙은 docs/design/06-editing.md 6.1·6.7.
 *
 * 읽기 상태는 셋으로 나뉜다:
 * - write 콜백 대기: `read()`를 불렀지만 앵커 행이 아직 정해지지 않았다(`pendingReads`).
 * - 활성 읽기: 입력줄이 그려져 키를 받는다(`activeRead`).
 * - 재그리기 대기: 활성 읽기 중 `printAbove`류가 입력줄을 화면에서 뗐다(`offscreen`).
 */
import { Terminal, ITerminalAddon, IDisposable } from "@xterm/xterm";
import { Input, InputType, parseInput } from "./keymap";
import { State } from "./state";
import { History } from "./history";
import { Output, Tty } from "./tty";
import { Highlighter, IdentityHighlighter } from "./highlight";
import { DRAWN, LineView, Offscreen, Origin, settleRun } from "./line-view";

/** 활성 읽기 하나의 상태. `read()`의 옵션을 옮겨 담는다. */
interface ActiveRead {
  /** 읽기가 시작할 때의 프롬프트. 취소 불가 Ctrl+C가 같은 프롬프트로 새 `State`를 만든다. */
  prompt: string;

  /** 제출·취소·EOF 때 부른다. */
  resolve: (input: string | null | typeof READ_EOF) => void;

  /** 취소·해제 때 부른다. */
  reject: (e: unknown) => void;

  /** `ReadOptions.cancelable` */
  cancelable: boolean;

  /** `ReadOptions.onKey` */
  onKey?: (input: Input) => boolean;

  /** `ReadOptions.historyEntry` */
  historyEntry?: (line: string) => string;

  /** `false`면 이 읽기의 Enter 제출을 history에 넣지 않는다(`ReadOptions.history`). */
  history: boolean;

  /** `ReadOptions.eof`. true면 빈 버퍼의 실제로 친 Ctrl+D가 읽기를 `READ_EOF`로 끝낸다. */
  eof: boolean;
}

/** write 콜백을 기다리는 읽기 하나. */
interface PendingRead {
  /** 취소·해제 때 부른다. */
  reject: (e: unknown) => void;

  /** 콜백 도착 전에 `cancelRead()`·`takeRead()`·`dispose()`가 먼저 끝냈는가 */
  cancelled: boolean;
}

/** `cancelRead()`가 읽기를 끝낼 때 reject 사유로 쓰는 오류. */
export class ReadCancelledError extends Error {
  constructor() {
    super("read cancelled");
    this.name = "ReadCancelledError";
  }
}

/**
 * `takeRead()`가 읽기를 끝낼 때 reject 사유로 쓰는 오류.
 * 제출(resolve)도 취소(`ReadCancelledError`)도 아니다.
 * 호출자가 입력 상태를 가져갔다는 뜻이라 별도 클래스로 구분한다.
 */
export class ReadTakenError extends Error {
  constructor() {
    super("read taken");
    this.name = "ReadTakenError";
  }
}

/** Enter 때 입력이 완성됐는지 판정한다. 완성이면 참이고, 거짓이면 줄바꿈을 넣는다. */
type CheckHandler = (text: string) => boolean;

/** 활성 읽기가 없을 때 들어온 Ctrl+C를 처리한다. */
type CtrlCHandler = () => void;

/** Ctrl+S(`resume`이 거짓)·Ctrl+Q(참) 처리 */
type PauseHandler = (resume: boolean) => void;

/**
 * `read(prompt, { eof: true })`가 빈 버퍼 Ctrl+D를 만나 읽기를 끝낼 때 돌려주는 값.
 * 문자열도 `null`도 아닌 벤더 자체 값이다.
 * `unique symbol`이라 호출자의 다른 값과 겹치지 않는다.
 */
export const READ_EOF: unique symbol = Symbol("READ_EOF");

/** `Readline` 생성 옵션. 생성 뒤에는 바꾸지 못한다. */
export interface ReadlineOptions {
  /** false면 history를 localStorage에 저장·복원하지 않는다. 기본값은 true(원본 동작). */
  persist?: boolean;

  /**
   * true면 공백뿐인(trim 결과 빈 문자열) 제출을 history에 넣지 않고 탐색 커서만 처음으로 되돌린다.
   * 기본값은 false(원본 동작). 공백뿐인 제출도 그대로 기록한다.
   */
  skipBlankHistory?: boolean;

  /**
   * 모든 `keydown`·`keypress`·`keyup`에서 벤더 `handleKeyEvent` 처리 앞에 부른다.
   * - `true`를 돌려주면 벤더 처리를 생략한다.
   * - 이때 `handleKeyEvent`가 xterm에 `false`를 돌려주므로 xterm의 기본 처리도 생략된다.
   * - 활성 읽기 유무와 무관하게 항상 불린다.
   */
  onKeyEvent?: (event: KeyboardEvent) => boolean;

  /**
   * false면 활성 읽기가 없는 구간에 들어온 입력을 쌓지 않고 버린다.
   * - 구간: 실행 중, `read()`의 write 콜백 대기 중, 부팅 중.
   * - 대상: 키·붙여넣기·IME 조합 완성 덩어리·Shift+Enter.
   * - Ctrl+C·Ctrl+L 단독 입력은 그대로 즉시 처리한다.
   * - 활성 읽기 중 `printAbove` 재그리기 동안 쌓는 `queued`는 대상이 아니다.
   *
   * 기본값은 true(type-ahead 동작). `=== false`일 때만 끈다.
   */
  typeAhead?: boolean;
}

/** `read()` 옵션 */
export interface ReadOptions {
  /** true면 활성 읽기 중 Ctrl+C가 읽기를 `null`로 끝낸다. 줄만 바꾸고 `^C`·history 기록은 없다. 기본 false(원본 동작). */
  cancelable?: boolean;

  /**
   * write 콜백 안에서 새 입력 상태(`State`)를 만든 직후 1회 채워 넣는 텍스트. 커서는 끝에 놓인다.
   * `read()` 호출 직후(콜백 밖)의 `updateLine()`은 이 시점보다 먼저 실행되어 사라진다.
   * 그래서 이 옵션으로만 넣는다.
   */
  prefill?: string;

  /**
   * `prefill`을 채운 직후 커서를 둘 위치(UTF-16 인덱스). `[0, prefill 길이]`로 자른다.
   * `prefill`이 없거나 빈 문자열이면 무시한다.
   * 생략하면 커서는 끝에 놓인다.
   * `takeRead()`가 돌려준 커서를 그대로 넘기면 된다.
   */
  prefillCursor?: number;

  /**
   * 활성 읽기의 키마다 벤더 처리 앞에 부른다. `true`를 돌려주면 벤더 처리를 생략한다(소비).
   * - 활성 읽기가 없을 때(write 콜백 대기 중 포함)는 부르지 않는다.
   * - `readPaste`가 `editInsert`로 바로 넣는 `Text` 토큰은 거치지 않는다.
   * - 그래서 붙여넣은 텍스트에는 훅이 반응하지 않는다.
   */
  onKey?: (input: Input) => boolean;

  /**
   * Enter로 제출된 줄을 history에 넣기 직전에 부른다. 돌려준 문자열이 기록된다.
   * 다음 경우에는 부르지 않는다:
   * - `skipBlankHistory`가 거른 공백뿐인 제출.
   * - 취소(`cancelable` Ctrl+C).
   * - `history: false`인 읽기.
   */
  historyEntry?: (line: string) => string;

  /**
   * `false`면 이 읽기에서 Enter로 제출된 줄을 history에 넣지 않는다. `historyEntry`도 부르지 않는다.
   * history 탐색 커서는 `skipBlankHistory`가 거른 공백 제출처럼 처음으로 되돌린다.
   * 읽는 동안 ↑·↓ 탐색은 그대로 된다.
   * 생략하면 기록한다(원본 동작).
   */
  history?: false;

  /**
   * true면 이 읽기 중 빈 버퍼에서 실제로 친 Ctrl+D가 읽기를 `READ_EOF`로 끝낸다.
   * - 빈 버퍼는 커서 위치와 무관하게 전체 버퍼가 빈 문자열인 경우다.
   * - 끝내는 순서는 취소 가능한 Ctrl+C와 같다. 커서를 끝으로 옮기고 강조 없이 다시 그린 뒤 개행한다.
   * - history에 넣지 않는다.
   * - type-ahead 재생·붙여넣기 덩어리 안의 Ctrl+D는 대상이 아니다. 그 경우는 커서 뒤 글자를 지운다.
   *
   * 기본값은 false(원본 동작).
   */
  eof?: boolean;
}

/**
 * 활성 읽기가 없는 구간에 친 키를 쌓아 두는 버퍼의 상한(UTF-16 코드 유닛 합계).
 * Linux tty `N_TTY_BUF_SIZE`와 같다.
 * 넘치는 덩어리는 통째로 버린다.
 * 규칙은 docs/design/06-editing.md 6.7.
 */
const TYPE_AHEAD_LIMIT = 4096;

/** `prefillCursor`를 `[0, length]`로 자른다. 생략·NaN이면 끝(`length`)이다. */
function clampCursor(cursor: number | undefined, length: number): number {
  if (cursor === undefined || Number.isNaN(cursor)) return length;
  return Math.min(Math.max(Math.trunc(cursor), 0), length);
}

/**
 * xterm 줄 입력 addon.
 * `Terminal.loadAddon()`으로 붙이고 `read()`로 한 줄씩 읽는다.
 * `Output`을 구조적으로 만족해 `Tty`의 출력 대상으로도 쓰인다(`output()`).
 */
export class Readline implements ITerminalAddon {
  private term: Terminal | undefined;

  /** 새 `State`에 넘길 highlighter. 이미 만들어진 `State`에는 반영되지 않는다(`setHighlighter`). */
  private highlighter: Highlighter = new IdentityHighlighter();

  private history: History;

  /** 입력줄이 그려져 키를 받는 읽기. 없으면 `undefined`. */
  private activeRead: ActiveRead | undefined;

  private disposables: IDisposable[] = [];

  /** write 콜백이 아직 오지 않아 `activeRead`가 없는 읽기들. `dispose`·`cancelRead`도 이들을 끝내야 한다. */
  private pendingReads = new Set<PendingRead>();

  /** 쓰기를 요청했지만 xterm이 아직 처리하지 않은 글자 수(UTF-16 코드 유닛) */
  private watermark = 0;

  /** `watermark`가 이 값을 넘으면 `highWater`가 선다. */
  private highWatermark = 10000;

  /** `highWater`가 선 뒤 `watermark`가 이 값 아래로 내려오면 푼다. */
  private lowWatermark = 1000;

  /** 출력이 밀려 있는가. `writeReady()`가 이 값의 반대를 돌려준다. */
  private highWater = false;

  /** 현재 읽기의 입력줄 상태. `read()`의 write 콜백과 취소 불가 Ctrl+C가 새로 만든다. */
  private state: State;

  private skipBlankHistory: boolean;

  private onKeyEvent?: (event: KeyboardEvent) => boolean;

  /** false면 활성 읽기가 없을 때 들어온 입력을 `pushTypeAhead`에서 버린다. `options.typeAhead === false`일 때만 false. */
  private typeAheadEnabled: boolean;

  /**
   * `printAbove`·`printAboveRaw`가 기다리는 재그리기 하나(`line-view.ts` `Offscreen`).
   * 활성 읽기가 있을 때만 있다.
   * - 생성: `printAbove`·`printAboveRaw`가 `activeRead`를 확인한 뒤.
   * - 제거: `finishRedraw`·`endOpenReads`.
   *
   * 있는 동안 들어온 키는 바로 처리하지 않고 `offscreen.queued`에 쌓는다.
   */
  private offscreen: Offscreen | undefined;

  /**
   * 활성 읽기가 없을 때(실행 중·`read()` write 콜백 대기 중·부팅 중) 들어온 입력을 순서대로 쌓아 둔다(type-ahead).
   * - `onData` 덩어리는 원본 문자열째, Shift+Enter는 `Input`째 쌓는다.
   * - 다음 `read()`의 write 콜백이 재생한다.
   * - Ctrl+C·`cancelRead()`·`dispose()`가 비운다.
   * - Ctrl+C·Ctrl+L 단독 입력은 쌓지 않는다.
   */
  private typeAhead: (string | Input)[] = [];

  /** `typeAhead`에 쌓인 덩어리 길이(UTF-16 코드 유닛) 합계. `TYPE_AHEAD_LIMIT` 검사에 쓴다. */
  private typeAheadLength = 0;

  private checkHandler: CheckHandler = () => true;

  private ctrlCHandler: CtrlCHandler = () => {
    return;
  };

  private pauseHandler: PauseHandler = (resume: boolean) => {
    return;
  };

  constructor(options: ReadlineOptions = {}) {
    // `State`가 history를 받으므로 history를 먼저 만든다.
    // term이 아직 없어 `tty()`는 크기 0인 임시 `Tty`를 돌려준다. `read()`가 `State`를 새로 만든다.
    this.history = new History(50, { persist: options.persist });
    this.state = new State(">", this.tty(), this.highlighter, this.history);
    this.history.restoreFromLocalStorage();
    this.skipBlankHistory = options.skipBlankHistory ?? false;
    this.onKeyEvent = options.onKeyEvent;
    this.typeAheadEnabled = options.typeAhead !== false;
  }

  /**
   * addon을 활성화한다. xterm의 loadAddon()이 이 함수를 부른다.
   *
   * @param term - 이 readline이 붙는 터미널.
   */
  public activate(term: Terminal): void {
    this.term = term;
    this.disposables.push(this.term.onData(this.readData.bind(this)));
    this.disposables.push(
      this.term.onResize(({ cols, rows }) => {
        const tty = this.state.getTty();
        tty.col = cols;
        tty.row = rows;
        if (tty.anchorRow >= rows) tty.anchorRow = Math.max(0, rows - 1);
        // 재그리기 대기 중에는 입력줄이 화면에 없다.
        // 지금 그리면 출력 아래에 잔상 행이 남고 콜백이 한 번 더 그린다.
        // 크기는 위에서 갱신했으므로 콜백(`finishRedraw`)이 새 크기로 그린다.
        if (this.activeRead !== undefined && this.offscreen === undefined) {
          this.state.refresh();
        }
      }),
    );
    this.term.attachCustomKeyEventHandler(this.handleKeyEvent.bind(this));
  }

  /**
   * addon을 해제한다.
   *
   * - 리스너를 해제하고 term을 비운다.
   * - 열린 읽기(write 콜백 대기 중인 것 포함)를 `Error("readline disposed")`로 reject한다.
   * - 쌓인 type-ahead·재그리기 대기 입력을 버린다.
   * - `term.dispose()`도 addon을 dispose하므로 두 번 불릴 수 있다. 두 번째 호출은 읽기·화면에 아무것도 하지 않는다.
   */
  public dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.term = undefined;
    // 재그리기를 무효로 해 늦은 콜백이 해제된 터미널에 닿지 않게 한다(TRP-004).
    this.endOpenReads(new Error("readline disposed"), "drop", "drop");
  }

  /**
   * 열린 읽기(활성 읽기 + write 콜백을 기다리는 읽기)를 `ReadCancelledError`로 끝낸다.
   * `dispose()`와 달리 리스너·term·history·state는 건드리지 않는다.
   * 열린 읽기가 없으면 읽기 쪽은 아무것도 하지 않는다.
   *
   * `settle`을 주지 않으면(또는 `false`) 화면에 아무것도 쓰지 않고 `false`를 돌려준다.
   * 개행·안내 줄은 호출자가 정한다.
   * `settle: true`면 읽기를 끝내기 전에 취소 시점 상태를 보고 화면을 정리한다.
   *
   * | 취소 시점 상태 | 쓰는 것 | 반환 |
   * | --- | --- | --- |
   * | 재그리기 대기 중 + 접두 있음(`printAboveRaw`) | 아직 그리지 않은 접두 + `"\x1b[0m\r\n"` | `true` |
   * | 재그리기 대기 중 + 접두 없음(`printAbove` 또는 접두 `""`) | 없음(커서는 이미 출력 아래 행 머리) | `true` |
   * | 그려진 활성 읽기 | 커서를 입력 끝으로 옮기고 강조 없이 다시 그린 뒤 `"\r\n"`(취소 가능한 Ctrl+C와 같은 바이트) | `true` |
   * | write 콜백을 기다리는 읽기만 / 열린 읽기 없음 / `term` 없음(`dispose()` 뒤) | 없음 | `false` |
   *
   * 반환값은 호출 뒤 커서가 입력·접두 아래 행 머리임을 Readline이 보장했는가다.
   * `false`면 Readline은 행 머리 여부를 모른다. 그리기 전 읽기는 화면에 이전 출력의 꼬리가 있을 수 있다.
   * 필요한 개행은 호출자가 정한다.
   *
   * 열린 읽기 유무와 무관하게 쌓인 type-ahead와 `offscreen.queued`를 비우고 재그리기를 무효로 한다(6.7).
   */
  public cancelRead(options?: { settle?: boolean }): boolean {
    // 상태 판정은 activeRead·offscreen을 비우기 전에 해야 한다.
    const settled = options?.settle === true ? this.settleScreen() : false;
    // 취소 뒤에는 새 실행이 시작한다. 옛 맥락에서 쌓인 type-ahead와 offscreen.queued는 버린다.
    // 이후 도착하는 키는 activeRead가 없으므로 type-ahead로 간다.
    this.endOpenReads(new ReadCancelledError(), "drop", "drop");
    return settled;
  }

  /**
   * 열린 읽기를 끝내기 전에 화면을 정리한다(`cancelRead({ settle: true })`의 상태표).
   * 커서를 입력·접두 아래 행 머리에 두었으면 `true`다.
   * 정리할 수 없는 상태(활성 읽기 없음·`term` 없음)면 아무것도 쓰지 않고 `false`다.
   * 읽기 상태는 바꾸지 않는다.
   */
  private settleScreen(): boolean {
    if (this.term === undefined || this.activeRead === undefined) return false;
    if (this.offscreen !== undefined) {
      // 입력줄은 이미 지워졌고 커서는 출력 아래 행 머리다. 아직 그리지 않은 접두만 자기 행으로 남긴다.
      const prefix = this.undrawnAbovePrefix();
      if (prefix !== "") this.write(prefix + "\x1b[0m\r\n");
      return true;
    }
    this.commitDrawnLine();
    return true;
  }

  /**
   * 그려진 활성 읽기의 입력줄을 화면에 확정한다.
   * - 커서를 입력 마지막 행 끝으로 옮긴다(감긴 입력 포함).
   * - 커서 위치 강조를 벗겨 다시 그린 뒤 개행한다.
   * - 커서는 입력 아래 행 머리에 온다.
   *
   * `settleScreen()`(settle 취소)과 `endActiveRead()`가 같이 쓴다.
   * 읽기 상태는 바꾸지 않는다.
   */
  private commitDrawnLine(): void {
    this.state.moveCursorToEnd();
    this.state.refreshUnhighlighted();
    this.term?.write("\r\n");
  }

  /**
   * 활성 읽기를 제출 없이 `value`로 끝낸다(취소 가능한 Ctrl+C의 `null`, `eof` 읽기 Ctrl+D의 `READ_EOF`).
   * 줄을 확정하고 history에는 넣지 않는다.
   * `resolve`를 부르기 전에 `activeRead`를 비운다.
   */
  private endActiveRead(
    activeRead: ActiveRead,
    value: null | typeof READ_EOF,
  ): void {
    this.commitDrawnLine();
    this.activeRead = undefined;
    activeRead.resolve(value);
  }

  /**
   * 열린 읽기를 제출·history 없이 끝내고 입력 상태를 가져간다.
   * 열린 읽기가 없으면 아무것도 하지 않고 `undefined`를 돌려준다.
   *
   * 상태별 동작:
   * - 활성 읽기:
   *   - 프롬프트 첫 행부터 입력 마지막 행까지(감긴 행·멀티라인 버퍼 포함) 화면에서 지운다.
   *   - 커서는 프롬프트 첫 행 열 0에 둔다.
   *   - 프롬프트 앞에 붙은 꼬리(`a>>> `의 `a`)도 프롬프트라 함께 지워진다.
   *   - 복원은 호출자가 한다. 돌려주는 값은 지우기 전의 텍스트·커서다.
   * - write 콜백을 기다리는 읽기(아직 그려지지 않음):
   *   - 화면에 그린 것이 없으므로 `{ text: "", cursor: 0 }`이다.
   *   - 늦게 오는 콜백은 읽기를 되살리지 않는다(`cancelRead()`와 같은 `cancelled` 표시).
   * - `printAbove` 재그리기 중:
   *   - 입력줄은 이미 출력 위에 남았고 그 아래에 출력이 있어 지울 수 없다.
   *   - 재그리기 콜백 전의 텍스트·저장 커서(`offscreen.cursor`)를 돌려준다.
   *   - 재그리기 대기 중 공개 편집 API(`editInsert`·`editBackspace`·`updateLine`)가 화면 밖에서 고친 버퍼·커서를 반영한 값이다.
   *   - 늦게 오는 재그리기 콜백은 재그리기가 무효가 되어 입력줄을 다시 그리지 않는다.
   * - `printAboveRaw` 재그리기 중:
   *   - 입력줄·접두는 이미 지워졌고 아직 다시 그려지지 않아 지울 것이 없다.
   *   - 돌려주는 값과 뒤처리는 `printAbove` 재그리기 중과 같다.
   *   - 접두는 화면에 없으므로 필요하면 호출자가 이 호출 전에 `abovePrefix()`로 읽어 다시 쓴다.
   *
   * 공통:
   * - 읽기 promise는 `ReadTakenError`로 reject한다(`ReadCancelledError`와 구분).
   * - 재그리기 중 쌓인 키(`offscreen.queued`)는 type-ahead로 옮겨 다음 읽기가 재생한다.
   * - 이미 쌓인 type-ahead는 그대로 둔다.
   * - history는 건드리지 않는다.
   */
  public takeRead(): { text: string; cursor: number } | undefined {
    const active = this.activeRead;
    const pending = [...this.pendingReads];
    if (active === undefined && pending.length === 0) return undefined;

    let taken = { text: "", cursor: 0 };
    if (active !== undefined) {
      if (this.offscreen !== undefined) {
        taken = { text: this.state.buffer(), cursor: this.offscreen.cursor };
      } else {
        taken = { text: this.state.buffer(), cursor: this.state.cursor() };
        this.state.erase();
      }
    }

    // 지금부터 활성 읽기가 없다. 재그리기 중 쌓인 키는 type-ahead로 옮겨 순서를 보존한다.
    this.endOpenReads(new ReadTakenError(), "toTypeAhead", "keep");
    return taken;
  }

  /**
   * 열린 읽기(활성 읽기 + write 콜백을 기다리는 읽기)를 모두 떼고 `error`로 reject한다.
   * `cancelRead()`·`takeRead()`·`dispose()`의 공통 상태 정리다. 화면에는 쓰지 않는다.
   *
   * - write 콜백을 기다리는 읽기에 `cancelled`를 세워 늦은 콜백이 활성 읽기를 되살리지 않게 한다.
   * - 기다리던 재그리기를 무효로 해 늦은 콜백이 그리지 않게 한다. 다음 읽기의 재그리기는 건드리지 않는다.
   * - `queued`(`offscreen.queued`, 재그리기 중 쌓인 입력):
   *   - `"drop"`: 버린다.
   *   - `"toTypeAhead"`: 순서대로 type-ahead 뒤에 붙인다.
   * - `typeAhead`(읽기 밖에서 쌓인 입력):
   *   - `"drop"`: 비운다. `queued` 이동보다 먼저 한다.
   *   - `"keep"`: 둔다.
   *
   * 상태를 모두 바꾼 뒤 reject한다. 순서는 write 콜백 대기 읽기가 먼저, 활성 읽기가 나중이다.
   * 호출자는 활성 읽기에서 읽을 것(`takeRead()`의 버퍼·커서·`state.erase()`)을 이 호출 전에 끝낸다.
   */
  private endOpenReads(
    error: Error,
    queued: "drop" | "toTypeAhead",
    typeAhead: "drop" | "keep",
  ): void {
    const pending = [...this.pendingReads];
    const active = this.activeRead;
    this.pendingReads.clear();
    pending.forEach((p) => {
      p.cancelled = true;
    });
    this.activeRead = undefined;
    const entries = this.offscreen?.queued ?? [];
    this.offscreen = undefined;
    if (typeAhead === "drop") this.clearTypeAhead();
    if (queued === "toTypeAhead") {
      // origin은 버린다. type-ahead로 옮겨진 뒤 재생되면 항상 "replay"다(`replayTypeAhead`).
      for (const { entry } of entries) {
        this.pushTypeAhead(entry);
      }
    }
    pending.forEach((p) => p.reject(error));
    active?.reject(error);
  }

  /**
   * history 맨 앞에 줄을 직접 추가한다.
   * 같은 항목은 앞으로 옮기고, 상한을 넘으면 가장 오래된 항목을 버린다(`History.append`).
   *
   * @param text history에 추가할 텍스트.
   */
  public appendHistory(text: string) {
    this.history.append(text);
  }

  /**
   * 내부 `History` 객체를 복사 없이 돌려준다.
   * 코어의 블록 history(RD-014)가 `entries` 스냅샷과 `restore`에 쓴다.
   */
  public getHistory(): History {
    return this.history;
  }

  /**
   * highlighter를 설정한다.
   * 구문 강조·괄호 짝 강조 같은 강조 기능에 쓴다.
   * 다음 `read()`가 만드는 `State`부터 적용한다. 이미 그려진 활성 읽기는 옛 highlighter를 쓴다.
   *
   * @param highlighter 모든 highlight 콜백을 처리하는 핸들러.
   */
  public setHighlighter(highlighter: Highlighter) {
    this.highlighter = highlighter;
  }

  /**
   * check 콜백을 설정한다.
   * Enter를 눌렀을 때 입력이 끝났는지, 줄이 더 필요한지 판정한다.
   *
   * @param fn `(text: string) => boolean`. 입력이 완성됐으면 `true`(제출)를 돌려준다.
   *   `false`면 줄바꿈(`\n`)을 입력에 넣고 읽기를 이어 간다.
   */
  public setCheckHandler(fn: CheckHandler) {
    this.checkHandler = fn;
  }

  /**
   * Ctrl+C 핸들러를 설정한다.
   * 활성 읽기가 없을 때 Ctrl+C가 들어오면 이 함수를 부른다(쌓인 type-ahead는 먼저 비운다).
   * 활성 읽기 중에는 부르지 않는다.
   * 실행 중인 작업을 취소하는 데 쓴다.
   *
   * @param fn Ctrl+C 핸들러.
   */
  public setCtrlCHandler(fn: CtrlCHandler) {
    this.ctrlCHandler = fn;
  }

  /**
   * Ctrl+S·Ctrl+Q 핸들러를 설정한다.
   * 활성 읽기 중에만 부른다. Ctrl+S는 `fn(false)`, Ctrl+Q는 `fn(true)`다.
   *
   * @param fn pause 핸들러. 인자 `resume`이 참이면 재개다.
   */
  public setPauseHandler(fn: PauseHandler) {
    this.pauseHandler = fn;
  }

  /**
   * 출력 흐름 제어용 신호.
   * Readline이 시작한 쓰기의 미처리 양이 상한(10000)을 넘으면 false다.
   * 하한(1000) 아래로 내려오면 다시 true다.
   *
   * @returns 이 터미널이 출력을 더 받을 수 있으면 true.
   */
  public writeReady(): boolean {
    return !this.highWater;
  }

  /**
   * 터미널에 텍스트를 쓴다.
   * 줄 앞과 `\r`이 아닌 글자 뒤의 `\n`을 `\r\n`으로 바꾼다.
   * 연속한 `\n`은 첫 번째만 바뀐다(현재 동작).
   * `term`이 없으면 쓰지 않는다.
   *
   * @param text 터미널에 쓸 텍스트.
   */
  public write(text: string) {
    if (text === "\n") {
      text = "\r\n";
    } else {
      text = text.replace(/^\n/, "\r\n");
      text = text.replace(/([^\r])\n/g, "$1\r\n");
    }
    const outputLength = text.length;
    this.watermark += outputLength;
    if (this.watermark > this.highWatermark) {
      this.highWater = true;
    }
    if (this.term) {
      this.term.write(text, () => {
        this.watermark = Math.max(this.watermark - outputLength, 0);
        if (this.highWater && this.watermark < this.lowWatermark) {
          this.highWater = false;
        }
      });
    }
  }

  /**
   * `write`와 같다.
   *
   * @param text 터미널에 쓸 텍스트.
   */
  public print(text: string) {
    return this.write(text);
  }

  /**
   * 터미널에 텍스트를 쓰고 `\r\n`을 덧붙인다.
   *
   * @param text 터미널에 쓸 텍스트.
   */
  public println(text: string) {
    return this.write(text + "\r\n");
  }

  /**
   * 활성 입력줄 위에 `text`를 출력하고 같은 읽기로 입력줄을 다시 그린다.
   * 활성 읽기가 없으면(또는 `term`이 없으면) `println`과 같고 프로미스는 바로 resolve한다.
   *
   * 동작:
   * - 출력이 끝나기 전에 들어온 입력은 큐(`offscreen.queued`)에 두었다가 순서대로 재생한다.
   * - 프로미스는 재그리기가 실제로 끝난 뒤 resolve한다.
   * - 호출자(코어 `tab-reader.ts`)는 재그리기 도중에 큐의 다음 키를 벤더 큐를 우회해 처리하지 않도록 이 프로미스로 순서를 맞춘다.
   * - 옛 입력행(접두 포함)은 화면에 남는다. 새 입력행은 접두 없이 그린다(접두를 비운다).
   *
   * 재그리기를 기다리는 중(앞선 `printAbove`·`printAboveRaw`)에 부르면 그 재그리기에 합류한다:
   * - 입력줄은 화면에 없고 커서는 앞 출력 아래 행 머리다. 앞 `\r\n` 없이 `text`를 쓴다.
   * - 아직 그리지 않은 접두는 먼저 자기 행으로 쓴다.
   * - 저장 커서는 처음 값을 유지한다.
   * - 프로미스는 합친 재그리기가 끝날 때 resolve한다.
   *
   * 규칙은 docs/design/07-tab-completion.md 7.3.
   *
   * @param text 입력줄 위에 찍을 텍스트. 여러 줄이면 `\n`으로 잇는다(`write`가 `\r\n`으로 바꾼다).
   */
  public printAbove(text: string): Promise<void> {
    if (this.activeRead === undefined || this.term === undefined) {
      this.println(text);
      return Promise.resolve();
    }
    // `moveCursorToEnd()`는 물리 커서를 버퍼 끝(여러 줄로 감기면 마지막 행)으로 옮긴다.
    // 그래야 그 아래에 원시 텍스트를 쓸 수 있다. 논리 커서(`line.pos`)도 함께 끝으로 옮긴다.
    // 재그리기 뒤에 원래 위치로 되돌리려고 새 `Offscreen`에 넘길 값을 먼저 읽어 둔다.
    // 합류 중이면 이 값은 쓰이지 않는다(처음 값 유지).
    const cursor = this.state.cursor();
    if (this.offscreen !== undefined) {
      // `moveCursorToEnd()`를 부르지 않는다.
      // 입력줄이 화면에 없어 `refresh()`가 엉뚱한 행에 그린다.
      // 논리 커서도 끝으로 옮겨져 처음 커서를 잃는다.
      const prefix = this.state.promptPrefix();
      if (prefix !== "") this.write(prefix + "\x1b[0m\r\n");
      this.write(text + "\r\n");
    } else {
      this.state.moveCursorToEnd();
      this.write("\r\n" + text + "\r\n");
    }
    // `moveCursorToEnd()`가 옛 프롬프트로 다시 그린 뒤에 비운다. 먼저 비우면 화면의 접두가 지워진다.
    this.state.setPromptPrefix("");
    return this.scheduleRedraw(this.term, cursor);
  }

  /**
   * 활성 읽기가 있는가. `printAbove`·`printAboveRaw` 재그리기 대기 중도 포함한다.
   * `read()`의 write 콜백을 기다리는 읽기(아직 그리지 않음)는 포함하지 않는다.
   */
  public isReading(): boolean {
    return this.activeRead !== undefined;
  }

  /**
   * write 콜백을 기다리는 읽기(아직 그리지 않음)가 있으면 true다. 활성 읽기는 세지 않는다(`isReading()`과 짝).
   * `cancelRead()`·`takeRead()`·`dispose()`는 write 콜백이 오기 전에 `pendingReads`를 바로 비운다.
   * 그래서 그 호출 직후에는 항상 false다.
   * 그리기 전 읽기가 있었는지 알려면 그 호출보다 먼저 읽어야 한다.
   */
  public hasPendingRead(): boolean {
    return this.pendingReads.size > 0;
  }

  /** 활성 읽기의 프롬프트 앞 접두(`printAboveRaw`가 준 값). 활성 읽기가 없으면 빈 문자열이다. */
  public abovePrefix(): string {
    return this.activeRead === undefined ? "" : this.state.promptPrefix();
  }

  /**
   * `abovePrefix()` 중 아직 화면에 그리지 않은 것.
   * - `printAboveRaw` 재그리기의 write 콜백을 기다리는 동안 접두가 있으면 그 접두다. 입력줄이 접두째 지워진 상태다.
   * - 그 밖에는 `""`다.
   * - 재그리기가 끝난 뒤의 접두는 이미 프롬프트 행에 그려져 있다. 그래서 `""`이며, 다시 쓰면 중복된다.
   *
   * `cancelRead({ settle: true })`(`settleScreen()`)가 취소 전에 이 값을 자기 행으로 다시 쓴다.
   * `settle` 없는 `cancelRead()`는 화면에 쓰지 않는다. 콜백 전에 취소하면 이 접두가 사라진다.
   *
   * 재그리기 대기 중 동작: `line-view.ts` `Offscreen`.
   */
  private undrawnAbovePrefix(): string {
    return this.view().undrawnAbovePrefix(this.state);
  }

  /** 조회·편집 메서드가 위임할 뷰. 재그리기를 기다리는 중이면 `Offscreen`, 아니면 `DRAWN`이다. */
  private view(): LineView {
    return this.offscreen ?? DRAWN;
  }

  /**
   * 열린 읽기 위에 배경 출력을 쓴다.
   * - 입력줄(프롬프트 첫 행부터 입력 마지막 행까지, 접두 포함)을 지우고 그 자리에 `lines`를 쓴다.
   * - 프롬프트 앞에 `prefix`를 붙여 같은 읽기(버퍼·커서)를 그 아래에 다시 그린다.
   * - 다시 그리기는 write 콜백에서 앵커를 새 커서 행으로 옮긴 뒤 한다.
   * - 그동안 들어온 키는 `queued`에 쌓았다가 재생한다.
   *
   * 인자:
   * - `lines`: 완성된 행. 빈 문자열이거나 `\n`으로 끝나야 한다.
   *   - 앞 접두는 화면에서 지워진다. 이어 쓰려면 호출자가 앞 접두를 `lines` 앞에 붙인다(`abovePrefix()`).
   *   - 비어 있지 않으면 뒤에 `\x1b[0m`을 쓴다.
   * - `prefix`: 개행 없이 끝난 나머지. 빈 문자열이면 접두 없음.
   *   - `\n`·`\r`이 없어야 한다(`State.setPromptPrefix`).
   *
   * 예외 경로:
   * - 재그리기를 기다리는 중(앞선 `printAboveRaw`·`printAbove`)이면 그 재그리기에 합류한다.
   *   입력줄이 화면에 없으므로 지우지 않고 `lines`만 쓰고 접두를 바꾼다.
   *   마지막 호출의 콜백만 다시 그린다.
   * - 활성 읽기가 없거나 `term`이 없으면 `write(lines + prefix)`와 같다.
   *
   * 돌려주는 프로미스는 합친 재그리기가 끝난 뒤(무효가 됐으면 콜백이 온 뒤) resolve한다.
   */
  public printAboveRaw(lines: string, prefix: string): Promise<void> {
    if (this.activeRead === undefined || this.term === undefined) {
      this.write(lines + prefix);
      return Promise.resolve();
    }
    const cursor = this.state.cursor();
    if (this.offscreen === undefined) {
      // 배치 기준으로 프롬프트 첫 행까지 올라가 지우고 배치를 초기화한다. 물리 커서는 그 행 열 0에 온다.
      this.state.erase();
    }
    if (lines !== "") this.write(lines + "\x1b[0m");
    this.state.setPromptPrefix(prefix);
    return this.scheduleRedraw(this.term, cursor);
  }

  /**
   * 재그리기를 시작하거나 기다리는 재그리기에 합류한다.
   * write 콜백에서 마지막 호출만 같은 읽기를 다시 그린다.
   *
   * 전제:
   * - 부르기 전에 입력줄이 화면에서 떠나 있어야 한다.
   * - 물리 커서는 출력 아래 행 머리여야 한다.
   *
   * `cursor`는 새 `Offscreen`을 만들 때만 쓴다. 합류 중이면 이미 있는 `this.offscreen`을 쓰고 `cursor`는 버린다(처음 값 유지).
   */
  private scheduleRedraw(term: Terminal, cursor: number): Promise<void> {
    const run = this.offscreen ?? new Offscreen(cursor);
    this.offscreen = run;
    run.calls += 1;
    const call = run.calls;
    return new Promise<void>((resolve) => {
      run.waiters.push(resolve);
      term.write("", () => this.finishRedraw(run, call));
    });
  }

  /**
   * `scheduleRedraw`의 write 콜백.
   * 마지막 합류 호출이고 재그리기가 유효하면 입력줄을 다시 그리고 쌓인 입력을 재생한다.
   */
  private finishRedraw(run: Offscreen, call: number) {
    // `cancelRead()`·`takeRead()`·`dispose()`가 무효로 했으면 그리지 않는다.
    // 해제된 터미널의 buffer도 읽지 않는다(TRP-004).
    // 뒤 읽기가 시작한 재그리기(`this.offscreen`)는 건드리지 않는다.
    if (run !== this.offscreen) {
      settleRun(run);
      return;
    }
    // 뒤에 합류한 호출의 콜백이 다시 그린다.
    if (call !== run.calls) return;
    this.offscreen = undefined;
    // 위 세 경로가 재그리기를 무효로 하므로 닿지 않는 방어다. 읽기가 없으면 그리지 않는다.
    if (this.term === undefined || this.activeRead === undefined) {
      settleRun(run);
      return;
    }
    this.state.getTty().anchorRow = this.term.buffer.active.cursorY;
    this.state.restoreCursor(run.cursor);
    // `moveCursorToEnd()`가 남긴 옛 배치(감긴 경우 마지막 행 기준)를 새 앵커 기준 배치로 되돌린다.
    // 되돌리지 않으면 `refresh()`가 옛 커서 행 기준으로 위로 올라가
    // 방금 쓴 원시 텍스트나 입력줄 일부를 \x1b[J로 지운다(다중 행 블록 입력에서 재현).
    this.state.resetLayout();
    this.state.refresh();
    // 재생 뒤에 `run.queued`를 비우지 않는다.
    // 재생 중 `dispatch`가 새 재그리기를 시작해도 그 입력은 새 `Offscreen`의 `queued`로 간다.
    // 위 `this.offscreen = undefined`가 이미 옛 `run`과 갈라놓았다.
    // 각 항목은 큐에 넣을 때 받은 origin 그대로 재생한다(`dispatch` 참고).
    for (const { entry, origin } of run.queued) {
      this.dispatch(entry, origin);
    }
    settleRun(run);
  }

  /**
   * 현재 버퍼 전체를 돌려준다.
   *
   * @returns 현재 줄.
   */
  public getLine() {
    return this.state.buffer();
  }

  /**
   * 버퍼를 `text`로 바꾸고 커서를 끝에 둔다.
   * 재그리기 대기 중이면 그리지 않고 버퍼만 바꾼다. 재그리기 콜백이 그린다.
   *
   * 재그리기 대기 중 동작: `line-view.ts` `Offscreen`.
   *
   * @param text 새 버퍼 텍스트.
   */
  public updateLine(text: string) {
    return this.view().updateLine(this.state, text);
  }

  /**
   * 재그리기 대기 중 들어와 큐(`queued`)에 쌓인 입력이 있는가.
   * - 큐의 키는 콜백이 재생하기 전까지 버퍼에 없다. `getLine`·`getCursor` 비교로는 보이지 않는다.
   * - 버퍼 비교로 경합을 판정하는 호출자(Tab 완성 응답)는 이 값을 함께 봐야 한다.
   * - 재그리기 중이 아니거나 큐가 비었으면 false다.
   * - 읽기 밖 type-ahead 버퍼는 포함하지 않는다.
   *
   * 재그리기 대기 중 동작: `line-view.ts` `Offscreen`.
   */
  public hasQueuedInput(): boolean {
    return this.view().hasQueuedInput();
  }

  /**
   * 현재 버퍼의 커서 위치(UTF-16 인덱스)를 돌려준다.
   * - `getLine`·`updateLine`처럼 활성 읽기가 없어도 현재 `State`에 작용한다.
   * - 재그리기 대기 중이면 저장 커서(`offscreen.cursor`)다.
   * - Tab `printAbove`의 `moveCursorToEnd()`가 논리 커서를 끝으로 옮겨 두어도 공개 편집 API가 쓰는 자리와 같은 값이다.
   *
   * 재그리기 대기 중 동작: `line-view.ts` `Offscreen`.
   */
  public getCursor(): number {
    return this.view().getCursor(this.state);
  }

  /**
   * 현재 커서 위치에 텍스트를 끼워 넣는다(원본 편집 경로와 같은 `State.editInsert`).
   * `printAbove`·`printAboveRaw` 재그리기를 기다리는 중이면 입력줄이 화면에 없으므로 그리지 않는다.
   * 이때는 저장 커서(`offscreen.cursor`) 자리의 버퍼에만 넣고 저장 커서를 삽입 뒤로 옮긴다.
   * 재그리기 콜백이 그 커서로 다시 그린다.
   * Tab 완성 삽입이 배경 출력 재그리기와 겹치는 경우가 이 경로다.
   *
   * 재그리기 대기 중 동작: `line-view.ts` `Offscreen`.
   */
  public editInsert(text: string): void {
    this.view().editInsert(this.state, text);
  }

  /**
   * 커서 앞 `n`글자를 지운다(원본 편집 경로와 같은 `State.editBackspace`).
   * 재그리기 대기 중 처리는 `editInsert`와 같다.
   *
   * 재그리기 대기 중 동작: `line-view.ts` `Offscreen`.
   */
  public editBackspace(n: number): void {
    this.view().editBackspace(this.state, n);
  }

  /**
   * `Tty`가 쓸 출력 대상을 돌려준다. `Readline` 자신이다.
   *
   * @returns 이 인스턴스.
   */
  public output(): Output {
    return this;
  }

  /**
   * 현재 터미널 크기와 커서 행(앵커)으로 `Tty`를 새로 만든다.
   * `term`이 없거나 `tabStopWidth` 옵션이 없으면 크기 0×0, 탭 8인 임시 `Tty`를 돌려준다.
   *
   * @returns 새 `Tty`.
   */
  public tty(): Tty {
    if (this.term?.options?.tabStopWidth !== undefined) {
      const anchor = this.term.buffer.active.cursorY;
      return new Tty(
        this.term.cols,
        this.term.rows,
        this.term.options.tabStopWidth,
        this.output(),
        anchor,
      );
    } else {
      return new Tty(0, 0, 8, this.output());
    }
  }

  /**
   * 프롬프트를 표시하고 한 줄 입력을 기다린다.
   * 프로미스는 Enter로 제출된 줄로 resolve한다.
   * `term`이 없으면(`activate` 전·`dispose` 뒤) 문자열 `"addon is not active"`로 reject한다.
   *
   * @param prompt 프롬프트.
   * @returns 제출된 줄.
   */
  public read(prompt: string): Promise<string>;
  /**
   * 취소 가능한 읽기. `options.cancelable`이 true면 Ctrl+C가 읽기를 `null`로 끝낸다.
   *
   * @param prompt 프롬프트.
   * @param options `eof`가 없거나 false인 읽기 옵션.
   * @returns 제출된 줄, 또는 취소를 뜻하는 `null`.
   */
  public read(
    prompt: string,
    options: ReadOptions & { eof?: false },
  ): Promise<string | null>;
  /**
   * `eof`를 켤 수 있는 읽기.
   * `eof`가 true면 빈 버퍼에서 실제로 친 Ctrl+D가 읽기를 `READ_EOF`로 끝낸다(`ReadOptions.eof`).
   * `eof`가 `boolean`으로만 알려진 옵션도 이 오버로드가 받는다.
   *
   * @param prompt 프롬프트.
   * @param options 읽기 옵션.
   * @returns 제출된 줄, 취소를 뜻하는 `null`, 또는 EOF를 뜻하는 `READ_EOF`.
   */
  public read(
    prompt: string,
    options: ReadOptions,
  ): Promise<string | null | typeof READ_EOF>;
  public read(
    prompt: string,
    options: ReadOptions = {},
  ): Promise<string | null | typeof READ_EOF> {
    const cancelable = options.cancelable === true;
    const eof = options.eof === true;
    return new Promise<string | null | typeof READ_EOF>((resolve, reject) => {
      if (this.term === undefined) {
        reject("addon is not active");
        return;
      }
      // `term.write`는 버퍼링된다.
      // 앞선 출력(예: 애니메이션 로고)은 지금 읽는 시점에 `buffer.active.cursorY`에 아직 반영되지 않았을 수 있다.
      // 버퍼가 flush되길 기다려야 앵커 행이 프롬프트가 놓일 위치를 정확히 반영한다.
      const pending: PendingRead = { reject, cancelled: false };
      this.pendingReads.add(pending);
      this.term.write("", () => {
        this.pendingReads.delete(pending);
        // 콜백 전에 dispose됐으면 이미 reject됐다. 해제된 터미널에는 닿지 않는다.
        if (this.term === undefined) return;
        // 콜백 전에 취소(`cancelRead()`·`takeRead()`)됐으면 이미 reject됐다. activeRead를 되살리지 않는다.
        if (pending.cancelled) return;
        this.state = new State(
          prompt,
          this.tty(),
          this.highlighter,
          this.history,
        );
        if (options.prefill !== undefined && options.prefill !== "") {
          this.state.update(
            options.prefill,
            clampCursor(options.prefillCursor, options.prefill.length),
          );
        } else {
          this.state.refresh();
        }
        this.activeRead = {
          prompt,
          resolve,
          reject,
          cancelable,
          onKey: options.onKey,
          historyEntry: options.historyEntry,
          history: options.history !== false,
          eof,
        };
        // 활성 읽기가 선 뒤 쌓인 type-ahead를 재생한다.
        this.replayTypeAhead();
      });
    });
  }

  /**
   * xterm 커스텀 키 이벤트 핸들러. `false`를 돌려주면 xterm이 그 이벤트를 처리하지 않는다.
   * - `onKeyEvent`가 참을 돌려주면 벤더 처리를 생략하고 `false`를 돌려준다.
   * - Shift+Enter는 `keydown`에서 `ShiftEnter` 입력으로 보내고 모든 이벤트 종류에 `false`를 돌려준다.
   * - 그 밖에는 `true`다.
   */
  private handleKeyEvent(event: KeyboardEvent): boolean {
    if (this.onKeyEvent?.(event)) return false;
    if (event.key === "Enter" && event.shiftKey) {
      if (event.type === "keydown") {
        // `onData`를 거치지 않는 키라 재그리기·type-ahead 분기를 직접 태운다(`dispatch`).
        this.dispatch(
          {
            inputType: InputType.ShiftEnter,
            data: ["\r"],
          },
          "live",
        );
      }
      return false;
    }
    return true;
  }

  /** xterm `onData` 리스너. 입력을 `"live"`로 보낸다. */
  private readData(data: string) {
    this.dispatch(data, "live");
  }

  /**
   * 입력 하나(`onData` 원본 문자열 또는 Shift+Enter `Input`)를 상태에 맞게 보낸다.
   * `onData`·Shift+Enter·두 재생 경로(`replayTypeAhead`, `finishRedraw`의 `queued`)가 모두 이 분기를 탄다.
   *
   * 분기 순서:
   * 1. 재그리기 대기 중: `offscreen.queued`에 쌓는다.
   * 2. Shift+Enter(`Input`): 활성 읽기가 없으면 type-ahead에 쌓고, 있으면 `readKey`로 보낸다.
   * 3. 활성 읽기가 없고 즉시 처리 키(Ctrl+C·Ctrl+L 단독)가 아니면 type-ahead에 쌓는다.
   * 4. 토큰이 여럿이거나 `Text`가 여러 글자면 `readPaste`, 아니면 `readKey`로 보낸다.
   *
   * `origin` 규칙:
   * - `readKey`의 Ctrl+D EOF 판정만 쓴다.
   * - 재그리기 창에서 실제로 친 키는 `"live"`, type-ahead 재생은 `"replay"`다.
   * - `queued`로 넘어가는 항목은 받은 origin을 들고 있다가 재그리기 뒤 그 origin으로 재생한다.
   * - `replayTypeAhead` 도중 `onKey`가 동기로 `printAbove`를 불러 뒤 항목이 `queued`로 넘어가도 `"replay"`가 `"live"`로 바뀌지 않는다.
   */
  private dispatch(entry: string | Input, origin: Origin) {
    if (this.offscreen !== undefined) {
      // 재그리기(`printAbove`) 중 도착한 입력은 원본째 쌓아 둔다.
      // 붙여넣기 덩어리도 하나로 보관해 재생 때 `readPaste` 경로를 그대로 타게 한다.
      // Shift+Enter도 여기 쌓아 앞서 친 키보다 먼저 적용되지 않게 한다.
      this.offscreen.queued.push({ entry, origin });
      return;
    }
    if (typeof entry !== "string") {
      // Shift+Enter: 활성 읽기가 없으면 쌓았다가 다음 읽기에서 `readKey`(`onKey` 훅 포함)로 재생한다.
      if (this.activeRead === undefined) {
        this.pushTypeAhead(entry);
        return;
      }
      this.readKey(entry, origin);
      return;
    }
    const input = parseInput(entry);
    // 활성 읽기가 없으면 키를 버리지 않고 쌓는다. Ctrl+C·Ctrl+L 단독 입력만 즉시 처리한다(`readKey`).
    if (this.activeRead === undefined && !this.isImmediateKey(input)) {
      this.pushTypeAhead(entry);
      return;
    }
    if (
      input.length > 1 ||
      (input[0].inputType === InputType.Text && input[0].data.length > 1)
    ) {
      this.readPaste(input);
      return;
    }
    this.readKey(input[0], origin);
  }

  /** 활성 읽기가 없어도 쌓지 않고 바로 처리하는 입력(Ctrl+C·Ctrl+L 단독)인가. */
  private isImmediateKey(input: Input[]): boolean {
    return (
      input.length === 1 &&
      (input[0].inputType === InputType.CtrlC ||
        input[0].inputType === InputType.CtrlL)
    );
  }

  /**
   * 항목을 통째로 type-ahead에 쌓는다.
   * - 길이는 문자열이면 `entry.length`, Shift+Enter `Input`이면 1(`\r` 1바이트)이다.
   * - 합계가 상한(`TYPE_AHEAD_LIMIT`)을 넘으면 그 항목만 버린다. 앞에 쌓인 것은 유지하고 알리지 않는다.
   */
  private pushTypeAhead(entry: string | Input) {
    // `typeAhead: false`면 쌓지 않고 버린다.
    // 활성 읽기 없는 구간의 입력(`onData` 키·붙여넣기·IME, Shift+Enter)은 모두 `dispatch`를 거쳐 여기로 온다.
    // 그래서 이 한 곳에서 막는다. `onKeyEvent`는 `KeyboardEvent`에만 불려 붙여넣기·IME를 막지 못한다.
    if (!this.typeAheadEnabled) return;
    const length = typeof entry === "string" ? entry.length : 1;
    if (this.typeAheadLength + length > TYPE_AHEAD_LIMIT) return;
    this.typeAhead.push(entry);
    this.typeAheadLength += length;
  }

  /** 쌓인 type-ahead와 그 길이 합계를 비운다. */
  private clearTypeAhead() {
    this.typeAhead = [];
    this.typeAheadLength = 0;
  }

  /**
   * 쌓인 항목을 `dispatch`로 하나씩 재생한다. `onKey` 훅과 붙여넣기 경로를 그대로 탄다.
   * - 스냅샷을 먼저 꺼내 비운다.
   * - 재생 중 Enter로 읽기가 끝나면 뒤 항목은 `activeRead`가 없어 다시 `typeAhead`로 들어간다. 순서가 보존되고 다음 읽기가 받는다.
   * - 재생 키가 `printAbove`로 재그리기를 시작하면 남은 항목은 `queued`가 이어받는다.
   */
  private replayTypeAhead() {
    const entries = this.typeAhead;
    this.clearTypeAhead();
    for (const entry of entries) {
      this.dispatch(entry, "replay");
    }
  }

  /**
   * 여러 토큰 붙여넣기 덩어리를 처리한다.
   * - Enter는 줄바꿈 텍스트로 바꿔 제출하지 않는다.
   * - 탭 하나짜리 `UnsupportedControlChar`는 탭 텍스트로 바꾼다(TRAP-13).
   * - `Text`는 `State.editInsert`로 바로 넣는다. `onKey`를 거치지 않는다.
   * - 그 밖의 제어 문자는 origin `"paste"`로 `readKey`에 보낸다.
   */
  private readPaste(input: Input[]) {
    const mappedInput = input.map((it) => {
      if (it.inputType === InputType.Enter) {
        return { inputType: InputType.Text, data: ["\n"] };
      }
      if (
        it.inputType === InputType.UnsupportedControlChar &&
        it.data.length === 1 &&
        it.data[0] === "\t"
      ) {
        return { inputType: InputType.Text, data: ["\t"] };
      }
      return it;
    });

    for (const it of mappedInput) {
      if (it.inputType === InputType.Text) {
        this.state.editInsert(it.data.join(""));
      } else {
        // 붙여넣기 덩어리 안 제어 문자는 실제로 친 키가 아니다. origin이 "paste"라 Ctrl+D는 EOF가 아니다.
        this.readKey(it, "paste");
      }
    }
  }

  /**
   * 입력 하나를 종류별로 처리한다.
   *
   * 활성 읽기가 없으면:
   * - Ctrl+C: 쌓인 type-ahead를 비우고 Ctrl+C 핸들러를 부른다.
   * - Ctrl+L: 화면을 지운다.
   * - 그 밖에는 무시한다.
   *
   * 활성 읽기가 있으면 `onKey` 훅이 먼저 본다. 훅이 참을 돌려주면 여기서 끝난다.
   *
   * @param input 처리할 입력.
   * @param origin 입력의 출처. Ctrl+D EOF 판정에만 쓴다.
   */
  private readKey(input: Input, origin: Origin) {
    if (this.activeRead === undefined) {
      switch (input.inputType) {
        case InputType.CtrlC:
          // 핸들러 결과와 무관하게 쌓인 키를 버린다. 새 프로세스·인터럽트 뒤에 옛 키를 넘기지 않는다.
          this.clearTypeAhead();
          this.ctrlCHandler();
          break;
        case InputType.CtrlL:
          this.write("\x1b[H\x1b[2J");
          break;
      }
      return;
    }

    if (this.activeRead.onKey?.(input)) {
      return;
    }

    switch (input.inputType) {
      case InputType.Text:
        this.state.editInsert(input.data.join(""));
        break;
      case InputType.AltEnter:
      case InputType.ShiftEnter:
        this.state.editInsert("\n");
        break;
      case InputType.Enter:
        if (this.checkHandler(this.state.buffer())) {
          // 줄 확정. `commitDrawnLine()`과 같은 순서다.
          this.state.moveCursorToEnd();
          // 커서에 따라 붙는 강조(예: 괄호 짝)를 확정 전에 벗긴다.
          // 스크롤백에 굳는 줄은 강조 없는 평문이어야 한다.
          this.state.refreshUnhighlighted();
          this.term?.write("\r\n");
          if (
            this.activeRead?.history === false ||
            (this.skipBlankHistory && this.state.buffer().trim() === "")
          ) {
            this.history.resetCursor();
          } else {
            const line = this.state.buffer();
            this.history.append(this.activeRead?.historyEntry?.(line) ?? line);
          }
          this.activeRead?.resolve(this.state.buffer());
          this.activeRead = undefined;
        } else {
          this.state.editInsert("\n");
        }
        break;
      case InputType.CtrlC:
        if (this.activeRead.cancelable) {
          // 취소: settle 취소와 같은 줄 확정이다. `^C`를 찍지 않고 history에도 넣지 않는다.
          this.endActiveRead(this.activeRead, null);
          break;
        }
        // 취소 불가 읽기: 버퍼를 버리고 `^C`를 찍은 뒤 같은 프롬프트로 새로 시작한다. history에 넣지 않는다.
        this.state.moveCursorToEnd();
        this.term?.write("^C\r\n");
        this.state = new State(
          this.activeRead.prompt,
          this.tty(),
          this.highlighter,
          this.history,
        );
        this.state.refresh();
        break;
      case InputType.CtrlS:
        this.pauseHandler(false);
        break;
      case InputType.CtrlU:
        // 커서 위치와 무관하게 버퍼 전체를 비운다.
        this.state.update("");
        break;
      case InputType.CtrlK:
        this.state.editDeleteEndOfLine();
        break;
      case InputType.CtrlQ:
        this.pauseHandler(true);
        break;
      case InputType.CtrlL:
        this.state.clearScreen();
        break;
      case InputType.Home:
      case InputType.CtrlA:
        this.state.moveCursorHome();
        break;
      case InputType.End:
      case InputType.CtrlE:
        this.state.moveCursorEnd();
        break;
      case InputType.Backspace:
        this.state.editBackspace(1);
        break;
      case InputType.Delete:
        this.state.editDelete(1);
        break;
      case InputType.CtrlD:
        if (
          this.activeRead.eof &&
          origin === "live" &&
          this.state.buffer() === ""
        ) {
          // EOF 종료는 취소 가능한 Ctrl+C와 같다. history에 넣지 않는다.
          this.endActiveRead(this.activeRead, READ_EOF);
          break;
        }
        this.state.editDelete(1);
        break;
      case InputType.ArrowLeft:
        this.state.moveCursorBack(1);
        break;
      case InputType.ArrowRight:
        this.state.moveCursorForward(1);
        break;
      case InputType.ArrowUp:
        this.state.moveCursorUp(1);
        break;
      case InputType.ArrowDown:
        this.state.moveCursorDown(1);
        break;
      case InputType.UnsupportedControlChar:
      case InputType.UnsupportedEscape:
        break;
    }
  }
}
