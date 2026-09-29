import type { Readline } from "../src/readline";
import { VTerm } from "../src/vterm";

/**
 * xterm-readline 시험 전용 가짜 터미널.
 * - `Readline`이 읽는 xterm 멤버를 흉내 낸다: `cols`·`rows`·`options`·`buffer`·`onData`·`onResize`·
 *   `attachCustomKeyEventHandler`·`write`.
 * - 화면 해석은 로컬 `VTerm`에 맡긴다.
 * - 시험 파일별로 있던 사본(RD-030)을 하나로 합쳤다. 필드는 옵션 없이 모두 켜져 있다.
 * - `src/index.ts`(`tsdown` entry) 밖이라 배포에 들어가지 않는다.
 */
export class StubTerminal {
  /** 터미널 열 수. `resize()`가 바꾼다. */
  public cols: number;
  /** 터미널 행 수. `resize()`가 바꾼다. */
  public rows: number;
  /** xterm 옵션 중 `Readline`이 읽는 탭 폭. */
  public options = { tabStopWidth: 8 } as { tabStopWidth?: number };
  /** true면 write 콜백을 `flush()`·`flushOne()` 때까지 미룬다(실제 xterm의 비동기 파싱을 흉내낸다). 기본 false(동기). */
  public asyncWrite = false;
  /** `buffer.active.cursorY`를 읽은 횟수. */
  public cursorYReads = 0;
  /** `onData`·`onResize`가 돌려준 `dispose()`가 불린 횟수(`Readline.dispose()` 정책 시험용). */
  public listenerDisposals = 0;
  /** `term.write`로 들어온 바이트를 호출 순서대로 모은다(SGR처럼 `VTerm`이 무시하는 바이트 확인용). */
  public log: string[] = [];
  /** xterm `buffer.active`의 일부. `cursorY`는 읽을 때마다 `cursorYReads`를 올린다. */
  public buffer = {
    active: {
      get cursorY() {
        this.parent.cursorYReads += 1;
        return this.parent.vt.cursor()[0];
      },
      parent: null as unknown as StubTerminal,
    },
  };
  /** 화면·커서를 해석하는 가상 터미널. */
  public vt: VTerm;
  private onDataHandlers: ((data: string) => void)[] = [];
  private onResizeHandlers: ((size: { cols: number; rows: number }) => void)[] =
    [];
  private queue: { text: string; cb: () => void }[] = [];
  private keyEventHandler: ((event: KeyboardEvent) => boolean) | undefined;

  /** `cols`×`rows` 크기의 가짜 터미널을 만든다. */
  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.vt = new VTerm(cols, rows);
    this.buffer.active.parent = this;
  }

  /** 입력 리스너를 등록한다. 돌려준 `dispose()`는 호출 횟수만 센다. */
  onData(handler: (data: string) => void) {
    this.onDataHandlers.push(handler);
    return {
      dispose: () => {
        this.listenerDisposals += 1;
      },
    };
  }

  /** 크기 변경 리스너를 등록한다. 돌려준 `dispose()`는 호출 횟수만 센다. */
  onResize(handler: (size: { cols: number; rows: number }) => void) {
    this.onResizeHandlers.push(handler);
    return {
      dispose: () => {
        this.listenerDisposals += 1;
      },
    };
  }

  /** 창 크기 변경을 흉내 낸다. xterm처럼 크기를 먼저 바꾼 뒤 리스너에 알린다. */
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.vt.resize(cols, rows);
    for (const handler of this.onResizeHandlers) handler({ cols, rows });
  }

  /** 커스텀 키 이벤트 핸들러를 하나 등록한다. `fireKeyEvent()`가 부른다. */
  attachCustomKeyEventHandler(fn: (event: KeyboardEvent) => boolean) {
    this.keyEventHandler = fn;
  }

  /**
   * 바이트를 기록하고 `VTerm`에 쓴다. 콜백은 `asyncWrite`가 거짓이면 바로, 참이면 `flush()`때 실행한다.
   * 콜백이 없으면 미룰 것도 없다.
   */
  write(text: string, cb?: () => void) {
    this.log.push(text);
    this.vt.write(text);
    if (!cb) return;
    if (this.asyncWrite) {
      this.queue.push({ text, cb });
    } else {
      cb();
    }
  }

  /** 미뤄 둔 write 콜백을 순서대로 모두 실행한다(실행 중 새로 쌓인 것도 마저 비운다). */
  flush() {
    while (this.queue.length > 0) {
      const { cb } = this.queue.shift()!;
      cb();
    }
  }

  /**
   * 미뤄 둔 write 콜백을 순서대로 실행하되 빈 write의 콜백(재그리기·`read()` 콜백) 하나를 실행하면 멈춘다. 그 앞의
   * 워터마크 콜백(`Readline.write`가 거는 것)은 함께 실행한다.
   */
  flushOne() {
    while (this.queue.length > 0) {
      const { text, cb } = this.queue.shift()!;
      cb();
      if (text === "") return;
    }
  }

  /** 기록한 바이트를 하나로 이어 붙인다. */
  bytes(): string {
    return this.log.join("");
  }

  /** 키 입력 한 번을 흘린다. 여러 글자를 한 번에 넣으면 붙여넣기 경로로 가므로 한 글자씩 부른다. */
  feed(data: string) {
    for (const handler of this.onDataHandlers) handler(data);
  }

  /** 문자열을 코드포인트 단위로 하나씩 타이핑한다. */
  type(text: string) {
    for (const ch of text) this.feed(ch);
  }

  /** 벤더 `handleKeyEvent`에 원시 이벤트를 넘기고 반환값(=xterm 자체 처리 여부)을 돌려준다. */
  fireKeyEvent(
    event: Partial<KeyboardEvent> & { key: string; type: string },
  ): boolean {
    return this.keyEventHandler?.(event as KeyboardEvent) ?? true;
  }

  /** Shift+Enter는 `onData`가 아니라 `attachCustomKeyEventHandler`로 온다. */
  pressShiftEnter() {
    this.fireKeyEvent({
      key: "Enter",
      shiftKey: true,
      type: "keydown",
    } as KeyboardEvent);
  }
}

/** 가짜 터미널을 `Readline.activate`가 받는 xterm `Terminal` 타입으로 단언한다. */
export function asTerminal(term: unknown): Parameters<Readline["activate"]>[0] {
  return term as Parameters<Readline["activate"]>[0];
}
