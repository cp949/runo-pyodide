/**
 * jsdom 시험용 가짜 xterm `Terminal`. 실제 `Readline`이 읽는 멤버만 구현한다.
 * 실제 xterm은 jsdom에서 `open()`이 실패하므로(`matchMedia` 없음) 브라우저에서만 쓸 수 있다.
 *
 * 동작:
 * - 화면을 해석하지 않는다. write한 원문을 `written`에 모은다.
 * - 입력은 `type()`·`paste()`로 넣는다.
 * - 화면 버퍼를 읽는 코드(`rewindTail`)를 위해 `screen`에 커서 행·스크롤백·감긴 행을 둔다. 값은 시험이 지정한다.
 * - VT 해석이 필요하면 `vt-screen.ts`의 `attachScreen()`을 붙인다.
 *
 * write 콜백 모드:
 * - `asyncWrite: false`: write 안에서 바로 돌린다.
 * - `asyncWrite: true`: `flush()`까지 미룬다. 실제 xterm의 비동기 파싱을 흉내내, 콜백이 다음 동기 문장 뒤에 오는 순서를 시험이 통제한다.
 *
 * 동기 모드만 쓰면 `read()`가 입력 상태를 콜백 안에서 만드는 데서 오는 오류(TRAP-14)를 놓친다.
 */
import type {
  IBufferLine,
  ITerminalAddon,
  ITheme,
  Terminal,
} from "@xterm/xterm";
import { tick } from "./async";

/** `createFakeTerminal()` 옵션. */
export interface FakeTerminalOptions {
  /** 참이면 write 콜백을 `flush()` 때까지 미룬다. 기본은 거짓(write 안에서 바로 실행). */
  asyncWrite?: boolean;

  /** `term.cols`. 기본 80. */
  cols?: number;

  /** `term.rows`. 기본 24. */
  rows?: number;

  /** 참이면 jsdom `div`를 만들어 `term.element`에 채운다(`.xterm-screen`·`textarea` 자식 포함). 기본은 거짓(`element` 없음). */
  withElement?: boolean;
  /** `term.options.fontFamily`. 기본 `"monospace"`(xterm 기본값과 같다). */
  fontFamily?: string;
  /** `term.options.fontSize`. 기본 `15`(xterm 기본값과 같다). */
  fontSize?: number;
  /** `term.options.theme`. 기본 빈 객체. */
  theme?: ITheme;
}

/** 시험이 값을 지정하는 화면 모델. `buffer.active.{cursorX, cursorY, baseY, getLine(row)?.isWrapped}`가 이것을 읽는다. */
export interface FakeScreen {
  /** 뷰포트 안 커서 열. 기본 0. 완성 목록 popover가 위치 계산에 읽는다. */
  cursorX: number;
  /** 뷰포트 안 커서 행. 기본 0. `Readline`의 재그리기 앵커 행과 `rewindTail`이 읽는다. */
  cursorY: number;
  /** 스크롤백 행 수. 기본 0. */
  baseY: number;
  /** 절대 행 번호(`baseY + y`) 중 윗 행에서 이어진 행. */
  wrappedRows: Set<number>;
}

/** `createFakeTerminal()`이 돌려주는 가짜 터미널과 시험 조작 손잡이. */
export interface FakeTerminal {
  /** `Readline`과 `createRepl`에 넘기는 가짜. 구현한 멤버는 아래 `FakeXterm`뿐이다. */
  term: Terminal;
  /** 화면 버퍼 모델. 기본은 커서 0행·스크롤백 없음·감긴 행 없음이라 값을 지정하지 않는 시험에는 영향이 없다. */
  readonly screen: FakeScreen;
  /** `write`로 받은 원문. 콜백 유무·모드와 무관하게 호출 즉시 호출 순서대로 쌓인다. */
  written: string[];
  /** 키 하나마다 `onData`를 한 번씩 부른다. 이스케이프 시퀀스(`\x1b[D` 등)와 서로게이트 쌍은 한 키다. */
  type(text: string): void;
  /** 문자열 전체를 한 번의 `onData`로 보낸다(붙여넣기). */
  paste(text: string): void;
  /** custom key handler에 keydown을 넘기고 반환값을 돌려준다. 핸들러가 없으면 `true`(xterm이 그대로 처리). */
  keyDown(init: KeyboardEventInit): boolean;
  /** 미뤄 둔 write 콜백을 콜백 안에서 새로 쌓인 것까지 모두 순서대로 실행한다. */
  flush(): void;
  /** `dispose()` 뒤에 `buffer`를 읽은 횟수. 실제 xterm은 이때 `DisposableStore` 경고를 낸다(이전 구현 TRAP-11). */
  readonly disposedBufferReads: number;
  /** 시험이 선택 상태를 설정한다. 빈 문자열이면 선택 없음(`hasSelection() === false`)이다. */
  select(text: string): void;
  /** `term.clearSelection()` 호출 횟수. */
  readonly clearSelectionCalls: number;
  /** `term.onScroll` 구독자에게 뷰포트 위치 `y`를 보낸다. */
  emitScroll(y: number): void;
  /** `term.onResize` 구독자에게 새 `cols`·`rows`를 보내고 `term.cols`·`term.rows`를 갱신한다. */
  emitResize(cols: number, rows: number): void;
  /** 현재 구독자 수(해제 확인용). */
  readonly scrollListenerCount: number;
  readonly resizeListenerCount: number;
  readonly writeParsedListenerCount: number;
}

/** `Readline`·popover가 `Terminal`에서 읽는 멤버와 `loadAddon`·`dispose`. */
interface FakeXterm {
  cols: number;
  rows: number;
  options: {
    tabStopWidth: number;
    fontFamily: string;
    fontSize: number;
    theme: ITheme;
  };
  buffer: {
    active: {
      readonly cursorX: number;
      readonly cursorY: number;
      readonly baseY: number;
      getLine(row: number): IBufferLine | undefined;
    };
  };
  onData(listener: (data: string) => void): { dispose(): void };
  onResize(listener: (size: { cols: number; rows: number }) => void): {
    dispose(): void;
  };
  /** write 콜백과 같은 시점에 발생한다(동기 모드: write 안, `asyncWrite`: `flush()` 때). */
  onWriteParsed(listener: () => void): { dispose(): void };
  onScroll(listener: (y: number) => void): { dispose(): void };
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  write(text: string, callback?: () => void): void;
  loadAddon(addon: ITerminalAddon): void;
  dispose(): void;
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  readonly element?: HTMLElement;
  readonly textarea?: HTMLTextAreaElement;
}

const ESC = "\x1b";

/** CSI 시퀀스의 매개변수 문자(숫자와 `;`)인가. */
function isCsiParameter(char: string | undefined): boolean {
  return char !== undefined && ((char >= "0" && char <= "9") || char === ";");
}

/**
 * 입력 문자열을 키 단위로 나눈다. 벤더 keymap이 해석하는 시퀀스를 기준으로 한다.
 * - `ESC [ 매개변수 최종문자`: 한 키.
 * - `ESC 문자`(Alt 조합): 한 키.
 * - 그 밖: 코드 포인트 하나가 한 키(서로게이트 쌍 포함).
 */
function splitKeys(text: string): string[] {
  const chars = [...text];
  const keys: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = start + 1;
    if (chars[start] === ESC) {
      if (chars[end] === "[") {
        end += 1;
        while (end < chars.length && isCsiParameter(chars[end])) end += 1;
      }
      // 최종 문자 하나(입력이 거기서 끝났으면 있는 만큼)까지 한 키다.
      end = Math.min(end + 1, chars.length);
    }
    keys.push(chars.slice(start, end).join(""));
    start = end;
  }
  return keys;
}

/** 가짜 xterm `Terminal`과 조작 손잡이를 만든다. `dispose()`는 실제 xterm처럼 로드한 addon과 구독자를 정리한다. */
export function createFakeTerminal(
  options: FakeTerminalOptions = {},
): FakeTerminal {
  const {
    asyncWrite = false,
    cols = 80,
    rows = 24,
    withElement = false,
    fontFamily = "monospace",
    fontSize = 15,
    theme = {},
  } = options;
  const written: string[] = [];
  const dataListeners = new Set<(data: string) => void>();
  const resizeListeners = new Set<
    (size: { cols: number; rows: number }) => void
  >();
  const scrollListeners = new Set<(y: number) => void>();
  const writeParsedListeners = new Set<() => void>();
  const addons: ITerminalAddon[] = [];
  // `asyncWrite`일 때 write마다 콜백을 순서대로 쌓는다. 콜백이 없으면 `undefined`를 쌓는다.
  // `undefined` 항목도 쓰기 하나다. `flush()`가 onWriteParsed를 낼지 판단하는 데 쓴다.
  const pendingCallbacks: (undefined | (() => void))[] = [];
  let keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
  let disposed = false;
  let disposedBufferReads = 0;
  let selectionText = "";
  let clearSelectionCalls = 0;
  const element = withElement ? document.createElement("div") : undefined;
  let textarea: HTMLTextAreaElement | undefined;
  if (element !== undefined) {
    const screenEl = document.createElement("div");
    screenEl.className = "xterm-screen";
    element.appendChild(screenEl);
    textarea = document.createElement("textarea");
    element.appendChild(textarea);
  }
  const screen: FakeScreen = {
    cursorX: 0,
    cursorY: 0,
    baseY: 0,
    wrappedRows: new Set<number>(),
  };
  // 실제 xterm은 dispose 뒤 `buffer` 접근에 경고를 낸다. 화면 모델을 읽을 때마다 센다.
  const countDisposedRead = () => {
    if (disposed) disposedBufferReads += 1;
  };

  const emitWriteParsed = () => {
    for (const listener of [...writeParsedListeners]) listener();
  };

  const xterm: FakeXterm = {
    cols,
    rows,
    options: { tabStopWidth: 8, fontFamily, fontSize, theme },
    buffer: {
      active: {
        get cursorX() {
          countDisposedRead();
          return screen.cursorX;
        },
        get cursorY() {
          countDisposedRead();
          return screen.cursorY;
        },
        get baseY() {
          countDisposedRead();
          return screen.baseY;
        },
        getLine(row) {
          countDisposedRead();
          if (row < 0) return undefined;
          return { isWrapped: screen.wrappedRows.has(row) } as IBufferLine;
        },
      },
    },
    onData(listener) {
      dataListeners.add(listener);
      return {
        dispose: () => {
          dataListeners.delete(listener);
        },
      };
    },
    onResize(listener) {
      resizeListeners.add(listener);
      return {
        dispose: () => {
          resizeListeners.delete(listener);
        },
      };
    },
    onScroll(listener) {
      scrollListeners.add(listener);
      return {
        dispose: () => {
          scrollListeners.delete(listener);
        },
      };
    },
    onWriteParsed(listener) {
      writeParsedListeners.add(listener);
      return {
        dispose: () => {
          writeParsedListeners.delete(listener);
        },
      };
    },
    attachCustomKeyEventHandler(handler) {
      keyHandler = handler;
    },
    write(text, callback) {
      written.push(text);
      if (asyncWrite) {
        pendingCallbacks.push(callback);
        return;
      }
      callback?.();
      emitWriteParsed();
    },
    loadAddon(addon) {
      addons.push(addon);
      addon.activate(term);
    },
    hasSelection() {
      return selectionText !== "";
    },
    getSelection() {
      return selectionText;
    },
    clearSelection() {
      clearSelectionCalls += 1;
      selectionText = "";
    },
    element,
    textarea,
    dispose() {
      disposed = true;
      dataListeners.clear();
      resizeListeners.clear();
      scrollListeners.clear();
      // `onWriteParsed` 구독은 `CoreTerminal`이 `_register`로 소유하므로 `dispose()`가 같이 정리한다.
      // write 콜백은 다르다. WriteBuffer가 dispose 뒤에도 계속 돌린다(TRAP-11). `pendingCallbacks`도 비우지 않는다.
      writeParsedListeners.clear();
      // 실제 xterm처럼 로드한 addon도 dispose한다. 호출자가 먼저 dispose한 addon은 두 번 dispose된다.
      for (const addon of addons.splice(0)) addon.dispose();
    },
  };
  const term = xterm as unknown as Terminal;

  const emit = (data: string) => {
    for (const listener of [...dataListeners]) listener(data);
  };

  return {
    term,
    screen,
    written,
    type(text) {
      for (const key of splitKeys(text)) emit(key);
    },
    paste(text) {
      emit(text);
    },
    keyDown(init) {
      const event = new KeyboardEvent("keydown", init);
      return keyHandler === undefined ? true : keyHandler(event);
    },
    flush() {
      // 콜백이 새 write를 낼 수 있어 큐가 빌 때까지 돈다.
      // 큐의 각 항목은 콜백이 없어도 실제 xterm의 `_innerWrite` 드레인 한 몫이다.
      // 다 비운 뒤 onWriteParsed를 한 번만 낸다. 큐가 비어 있으면 내지 않는다.
      if (pendingCallbacks.length === 0) return;
      while (pendingCallbacks.length > 0) {
        pendingCallbacks.shift()?.();
      }
      emitWriteParsed();
    },
    get disposedBufferReads() {
      return disposedBufferReads;
    },
    select(text) {
      selectionText = text;
    },
    get clearSelectionCalls() {
      return clearSelectionCalls;
    },
    emitScroll(y) {
      for (const listener of [...scrollListeners]) listener(y);
    },
    emitResize(cols, rows) {
      xterm.cols = cols;
      xterm.rows = rows;
      for (const listener of [...resizeListeners]) listener({ cols, rows });
    },
    get scrollListenerCount() {
      return scrollListeners.size;
    },
    get resizeListenerCount() {
      return resizeListeners.size;
    },
    get writeParsedListenerCount() {
      return writeParsedListeners.size;
    },
  };
}

/**
 * write 콜백을 배출하고, 매크로태스크 한 번 뒤 다시 배출한다. `asyncWrite: true`용이다.
 * 긴 꼬리면 `rewindTail`이 flush를 기다린다. 첫 배출이 읽기를 시작시키고, 두 번째 배출이 읽기를 그린다.
 */
export async function drain(fake: FakeTerminal): Promise<void> {
  fake.flush();
  await tick();
  fake.flush();
}
