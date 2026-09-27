import { VTerm } from "../src/vterm";

/**
 * xterm-readline 시험 전용 가짜 터미널. `Readline`이 읽는 xterm 멤버(`cols`·`rows`·`options`·`buffer`·
 * `onData`·`onResize`·`attachCustomKeyEventHandler`·`write`)를 흉내 내고, 화면 해석은 로컬 `VTerm`에 맡긴다.
 * 시험 파일 11개가 각자 갖던 사본(RD-030 DELTA-03)을 옵션 없는 합집합으로 합쳤다 — 각 필드·메서드는 어느 사본에서든
 * 그 사본이 쓰던 시험은 그대로 통과한다. `src/index.ts`(`tsdown` entry) 밖이라 배포에 들어가지 않는다.
 */
export class StubTerminal {
  public cols: number;
  public rows: number;
  public options = { tabStopWidth: 8 } as { tabStopWidth?: number };
  /** true면 write 콜백을 `flush()`·`flushOne()` 때까지 미룬다(실제 xterm의 비동기 파싱을 흉내낸다). 기본 false(동기). */
  public asyncWrite = false;
  /** `buffer.active.cursorY`를 읽은 횟수. */
  public cursorYReads = 0;
  /** `onData`·`onResize`가 돌려준 `dispose()`가 불린 횟수(`Readline.dispose()` 정책 시험용). */
  public listenerDisposals = 0;
  /** `term.write`로 들어온 바이트를 호출 순서대로 모은다(SGR처럼 `VTerm`이 무시하는 바이트 확인용). */
  public log: string[] = [];
  public buffer = {
    active: {
      get cursorY() {
        this.parent.cursorYReads += 1;
        return this.parent.vt.cursor()[0];
      },
      parent: null as unknown as StubTerminal,
    },
  };
  public vt: VTerm;
  private onDataHandlers: ((data: string) => void)[] = [];
  private onResizeHandlers: ((size: { cols: number; rows: number }) => void)[] =
    [];
  private queue: { text: string; cb: () => void }[] = [];
  private keyEventHandler: ((event: KeyboardEvent) => boolean) | undefined;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.vt = new VTerm(cols, rows);
    this.buffer.active.parent = this;
  }

  onData(handler: (data: string) => void) {
    this.onDataHandlers.push(handler);
    return {
      dispose: () => {
        this.listenerDisposals += 1;
      },
    };
  }

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

  attachCustomKeyEventHandler(fn: (event: KeyboardEvent) => boolean) {
    this.keyEventHandler = fn;
  }

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
