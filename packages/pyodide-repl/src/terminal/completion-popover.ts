/**
 * 완성 후보 popover(옵션, RD-049). 규칙은 docs/design/07-tab-completion.md 7.6.
 *
 * 소유 범위:
 * - 배선(열기 호출·닫기 신호 C1·경합 W1~W4)은 이 모듈 밖(`tab-reader.ts`·`line-editor.ts`)의 몫이다.
 * - 이 모듈은 열린 뒤의 키(K1~K5)·마우스(M1~M3)·화면 변화 닫기(C2~C6)·위치(L1~L3)만 소유한다.
 *
 * 코드포인트/UTF-16 경계:
 * - `stem`·후보는 `tab-completion.ts`와 같은 이유로 코드포인트 단위로 다룬다.
 * - 서로게이트 쌍을 `slice`로 반으로 자르지 않는다(TRAP-32).
 */
import {
  InputType,
  type Input,
  type Readline,
} from "@cp949/runo-xterm-readline";
import type { Terminal } from "@xterm/xterm";

/** `createCompletionPopover`가 `Terminal`에서 읽는 좁은 멤버(비공개 `_core` 금지, 위치·닫기 신호 재료). */
export type PopoverTerminal = Pick<
  Terminal,
  | "element"
  | "textarea"
  | "buffer"
  | "cols"
  | "rows"
  | "options"
  | "onWriteParsed"
  | "onScroll"
  | "onResize"
>;

/** 완성 후보 popover. 세션마다 하나다. */
export interface CompletionPopover {
  /** 목록을 연다(첫 후보 선택 상태). `stem`은 커서 앞 완성 대상 부분 문자열(UTF-16). */
  open(completions: string[], stem: string): void;

  /** 닫는다. 닫혀 있으면 무동작. */
  close(): void;

  /** 열려 있는가 */
  readonly isOpen: boolean;

  /** 열려 있을 때만 키를 소비할 수 있다. 닫혀 있으면 항상 `false`(K5). */
  onKey(input: Input): boolean;

  /** `close()`하고, 이후 `open()`은 무동작이다. */
  dispose(): void;

  /**
   * M1(클릭 적용) 뒤 1회 호출한다.
   * K1~K3(`onKey` 경로)는 대상이 아니다. 그 경로는 `onKey`가 `true`를 반환하므로 line-editor가 이미 소비를 안다.
   * 클릭 적용은 `onKey`를 거치지 않는다. 이 통지가 없으면 line-editor가 연속 Tab 판정을 리셋할 수 없다.
   */
  onApplied(listener: () => void): void;
}

/** `placePopover` 입력. 길이 단위는 따로 적은 것 말고 셀이다. */
export interface PlacePopoverInput {
  /** 커서의 뷰포트 열(`buffer.active.cursorX`) */
  cursorX: number;

  /** 커서의 뷰포트 행(`buffer.active.cursorY`) */
  cursorY: number;

  /** 스템의 코드포인트 길이 */
  stemWidth: number;

  /** 터미널 열 수 */
  cols: number;

  /** 터미널 행 수 */
  rows: number;

  /** 셀 폭(px) */
  cellWidth: number;

  /** 셀 높이(px) */
  cellHeight: number;

  /** 후보 중 가장 긴 코드포인트 길이 */
  maxCandidateLength: number;

  /** 후보 수 */
  candidateCount: number;

  /** 세로 스크롤바가 차지하는 폭(px). 붙인 뒤에야 잴 수 있어 첫 계산은 생략(0)한다. */
  scrollbarWidth?: number;
}

/** `placePopover` 결과. 좌표·크기는 px이다. */
export interface PlacePopoverResult {
  /** 왼쪽 위치(px) */
  left: number;

  /** 위쪽 위치(px) */
  top: number;

  /** 너비(px) */
  width: number;

  /** 높이(px) */
  height: number;

  /** 실제로 보이는 행 수(L1, 상한 `MAX_VISIBLE_ROWS`) */
  visibleRows: number;

  /** 커서 행 위에 뒤집어 놓았는가(L2) */
  above: boolean;
}

/** L1: 표시 행 상한. 후보는 이 상한과 무관하게 전부 DOM에 둔다(`LIST_CAP` 미적용, 스크롤로 본다). */
const MAX_VISIBLE_ROWS = 10;

/** 너비 계산의 좌우 여백(px). 셀 폭 격자 밖의 순수 여유 공간이라 셀 단위가 아니다. */
const WIDTH_PADDING_PX = 8;

/** 테두리 두께(px). `box-sizing: border-box`라 높이·너비에 양쪽(×2)을 더해야 내용이 표시 행에 딱 맞는다. */
const BORDER_PX = 1;

/** L1~L3·음수 열 자르기. 위치·표시 규칙만 계산하는 순수 함수(DOM·터미널 접근 없음). */
export function placePopover(input: PlacePopoverInput): PlacePopoverResult {
  const {
    cursorX,
    cursorY,
    stemWidth,
    cols,
    rows,
    cellWidth,
    cellHeight,
    maxCandidateLength,
    candidateCount,
    scrollbarWidth = 0,
  } = input;
  const frame = BORDER_PX * 2;

  // L2: 기본은 커서 행 아래(above=false). 아래 남은 행이 원하는 행보다 적고 위쪽 행이 더 많으면 뒤집는다.
  const wantedRows = Math.min(candidateCount, MAX_VISIBLE_ROWS);
  const belowSpace = rows - cursorY - 1;
  const aboveSpace = cursorY;
  const above = belowSpace < wantedRows && aboveSpace > belowSpace;

  // L1: 놓는 쪽 남은 행을 넘지 않는다(최소 1). 넘치면 화면 위·아래로 샌다.
  const visibleRows = Math.max(
    1,
    Math.min(wantedRows, above ? aboveSpace : belowSpace),
  );
  const height = visibleRows * cellHeight + frame;
  const top = above
    ? Math.max(0, cursorY * cellHeight - height)
    : (cursorY + 1) * cellHeight;

  // 기준 열: 음수면 0.
  const column = Math.max(0, cursorX - stemWidth);

  // L3: 너비 상한은 화면 너비. 오른쪽으로 넘치면 화면 안에 들어오게 왼쪽으로 민다.
  const screenWidth = cols * cellWidth;
  const width = Math.min(
    maxCandidateLength * cellWidth + WIDTH_PADDING_PX + frame + scrollbarWidth,
    screenWidth,
  );
  const left = Math.min(column * cellWidth, Math.max(0, screenWidth - width));

  return { left, top, width, height, visibleRows, above };
}

/** `theme` 미지정 시 xterm의 실제 기본 배경색(`ThemeService`의 `DEFAULT_BACKGROUND`). */
const DEFAULT_BACKGROUND = "#000000";

/** `theme` 미지정 시 xterm의 실제 기본 글자색(`ThemeService`의 `DEFAULT_FOREGROUND`). */
const DEFAULT_FOREGROUND = "#ffffff";

/** xterm의 실제 기본 선택색(`ThemeService`의 `selectionBackgroundTransparent` 기본값). */
const DEFAULT_SELECTION_BACKGROUND = "rgba(255, 255, 255, 0.3)";

/** Esc 키가 `Text` 입력으로 오는 데이터 */
const ESC = "\x1b";

/** 문자열을 코드포인트 배열로 나눈다. */
function codepoints(text: string): string[] {
  return [...text];
}

/**
 * `.xterm-screen` 기하 ÷ `cols`·`rows`로 셀 크기를 잰다(docs/design/09-testing.md 9.6.5의 `react-fit-check`와 같은 계산).
 * 비공개 `_core` 없이 셀 크기를 얻는 유일한 방법이다.
 * `origin`은 `.xterm-screen`이 `terminal.element`의 padding box(absolute 자식의 기준)에서 떨어진 거리다.
 * 호스트가 `.xterm`에 padding을 주면 0이 아니다.
 */
function measureScreen(terminal: PopoverTerminal): {
  cellWidth: number;
  cellHeight: number;
  originX: number;
  originY: number;
} {
  const element = terminal.element;
  const rect = element
    ?.querySelector<HTMLElement>(".xterm-screen")
    ?.getBoundingClientRect();
  const elementRect = element?.getBoundingClientRect();
  const width = rect?.width ?? 0;
  const height = rect?.height ?? 0;
  return {
    cellWidth: width / terminal.cols,
    cellHeight: height / terminal.rows,
    originX:
      (rect?.left ?? 0) - (elementRect?.left ?? 0) - (element?.clientLeft ?? 0),
    originY:
      (rect?.top ?? 0) - (elementRect?.top ?? 0) - (element?.clientTop ?? 0),
  };
}

/**
 * 완성 후보 popover를 만든다. 세션마다 한 번 부른다(옵션을 켠 경우만).
 * `readline`은 후보 적용(`editInsert`)에만 쓴다.
 */
export function createCompletionPopover(
  terminal: PopoverTerminal,
  readline: Pick<Readline, "editInsert">,
): CompletionPopover {
  let container: HTMLDivElement | undefined;
  let items: HTMLDivElement[] = [];
  let completions: string[] = [];
  let stemLength = 0;
  let selectedIndex = 0;
  let subscriptions: { dispose(): void }[] = [];
  let disposed = false;
  let applyListener: (() => void) | undefined;
  // open() 시점에 읽어 고정한다. 연 뒤의 테마 변경은 추적하지 않는다.
  // 그래서 highlightSelection이 매 ↑↓마다 `terminal.options.theme`를 다시 읽지 않는다.
  let selectionBackground = DEFAULT_SELECTION_BACKGROUND;

  // 적용할 삽입 문자열을 미리 계산해 둔다. `closeInternal()`이 `completions`를 비우기 전에 불러야 한다.
  function candidateInsertText(index: number): string | undefined {
    const candidate = completions[index];
    if (candidate === undefined) return undefined;
    return codepoints(candidate).slice(stemLength).join("");
  }

  // K2·M1 공용: close() 뒤에 editInsert한다. 반대 순서면 editInsert가 던질 때 popover가 열린 채 남는다.
  function applyAndClose(index: number): void {
    const text = candidateInsertText(index);
    closeInternal();
    applyListener?.();
    if (text !== undefined) readline.editInsert(text);
  }

  // 선택 항목을 표시하고 목록 안쪽에서 보이게 스크롤한다.
  function highlightSelection(): void {
    items.forEach((item, index) => {
      const selected = index === selectedIndex;
      item.setAttribute("aria-selected", String(selected));
      item.style.background = selected ? selectionBackground : "";
    });
    // 목록 안쪽만 스크롤한다(K1 "선택 항목이 보이게").
    // `scrollIntoView`는 popover 밖 스크롤 조상까지 움직인다. 터미널이 통째로 스크롤되므로 쓰지 않는다.
    const item = items[selectedIndex];
    if (container !== undefined && item !== undefined) {
      if (item.offsetTop < container.scrollTop) {
        container.scrollTop = item.offsetTop;
      } else if (
        item.offsetTop + item.offsetHeight >
        container.scrollTop + container.clientHeight
      ) {
        container.scrollTop =
          item.offsetTop + item.offsetHeight - container.clientHeight;
      }
    }
  }

  function closeInternal(): void {
    if (container === undefined) return;
    for (const subscription of subscriptions.splice(0)) subscription.dispose();
    container.remove();
    container = undefined;
    items = [];
    completions = [];
  }

  function onOutsideClick(event: MouseEvent): void {
    if (container === undefined) return;
    if (event.target instanceof Node && container.contains(event.target)) {
      return; // C6은 popover 밖 클릭만 닫는다. popover 안 클릭은 M1이 처리한다.
    }
    closeInternal();
  }

  return {
    open(newCompletions, stem) {
      if (disposed || newCompletions.length === 0) return;
      closeInternal(); // 재호출 방어(정상 배선에서는 이미 닫혀 있다, W3).

      completions = newCompletions;
      stemLength = codepoints(stem).length;
      selectedIndex = 0;
      selectionBackground =
        terminal.options.theme?.selectionBackground ??
        DEFAULT_SELECTION_BACKGROUND;

      const { cellWidth, cellHeight, originX, originY } =
        measureScreen(terminal);
      const placeInput: PlacePopoverInput = {
        cursorX: terminal.buffer.active.cursorX,
        cursorY: terminal.buffer.active.cursorY,
        stemWidth: stemLength,
        cols: terminal.cols,
        rows: terminal.rows,
        cellWidth,
        cellHeight,
        maxCandidateLength: Math.max(
          0,
          ...completions.map((c) => codepoints(c).length),
        ),
        candidateCount: completions.length,
      };
      const placement = placePopover(placeInput);

      const el = document.createElement("div");
      el.className = "runo-completion-popover";
      el.setAttribute("role", "listbox");
      el.style.position = "absolute";
      const applyHorizontal = (left: number, width: number) => {
        el.style.left = `${originX + left}px`;
        el.style.width = `${width}px`;
      };
      applyHorizontal(placement.left, placement.width);
      el.style.top = `${originY + placement.top}px`;
      el.style.height = `${placement.height}px`;
      el.style.overflowY = "auto";
      el.style.overflowX = "hidden"; // 세로 스크롤바가 폭을 먹어도 가로 스크롤바가 생기지 않게 한다.
      el.style.boxSizing = "border-box"; // 테두리를 폭에 포함시켜 화면 밖으로 새지 않게 한다.
      el.style.zIndex = "1000";
      el.style.fontFamily = terminal.options.fontFamily ?? "";
      el.style.fontSize = `${terminal.options.fontSize ?? 0}px`;
      el.style.lineHeight = `${cellHeight}px`;
      el.style.background =
        terminal.options.theme?.background ?? DEFAULT_BACKGROUND;
      el.style.color = terminal.options.theme?.foreground ?? DEFAULT_FOREGROUND;
      el.style.border = `${BORDER_PX}px solid`;
      // M2: popover 안 mousedown은 xterm textarea focus를 지킨다(preventDefault로 focus 이동 억제).
      // xterm의 SelectionService도 같은 element(`terminal.element`)에서 mousedown을 듣는다.
      // stopPropagation 없이는 popover 클릭이 터미널 텍스트 선택을 건드린다.
      el.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      // M1: 항목 클릭은 K2와 같은 적용 + 닫기.
      el.addEventListener("click", (event) => {
        if (!(event.target instanceof Node)) return;
        const index = items.findIndex((item) =>
          item.contains(event.target as Node),
        );
        if (index < 0) return;
        applyAndClose(index);
      });

      items = completions.map((completion) => {
        const item = document.createElement("div");
        item.className = "runo-completion-popover__item";
        item.setAttribute("role", "option");
        item.textContent = completion;
        el.appendChild(item);
        return item;
      });

      terminal.element?.appendChild(el);
      // 스크롤바가 자리를 차지하는 환경(overlay가 아닌 스크롤바)에서는 그만큼 내용 폭이 줄어
      // 긴 후보가 `overflow-x: hidden`에 잘린다. 붙인 뒤 폭을 재어 한 번만 넓힌다(L3).
      const scrollbarWidth = el.offsetWidth - el.clientWidth - BORDER_PX * 2;
      if (scrollbarWidth > 0) {
        const widened = placePopover({ ...placeInput, scrollbarWidth });
        applyHorizontal(widened.left, widened.width);
      }
      container = el;
      highlightSelection();

      // C2~C6: open에서 걸고 close에서 푼다.
      subscriptions = [
        terminal.onWriteParsed(closeInternal),
        terminal.onScroll(closeInternal),
        terminal.onResize(closeInternal),
        {
          dispose: () => {
            terminal.textarea?.removeEventListener("blur", closeInternal);
          },
        },
        {
          dispose: () => {
            terminal.element?.removeEventListener("mousedown", onOutsideClick);
          },
        },
      ];
      terminal.textarea?.addEventListener("blur", closeInternal);
      terminal.element?.addEventListener("mousedown", onOutsideClick);
    },

    close() {
      closeInternal();
    },

    get isOpen() {
      return container !== undefined;
    },

    onKey(input) {
      if (container === undefined) return false; // K5

      if (
        input.inputType === InputType.ArrowDown ||
        input.inputType === InputType.ArrowUp
      ) {
        // K1: 끝에서 반대 끝으로 순환.
        const delta = input.inputType === InputType.ArrowDown ? 1 : -1;
        selectedIndex = (selectedIndex + delta + items.length) % items.length;
        highlightSelection();
        return true;
      }

      const isTab =
        input.inputType === InputType.UnsupportedControlChar &&
        input.data[0] === "\t";
      if (input.inputType === InputType.Enter || isTab) {
        // K2: 제출 안 함. 닫은 뒤 editInsert(순서 규칙, applyAndClose 참고).
        applyAndClose(selectedIndex);
        return true;
      }

      const isEsc =
        input.inputType === InputType.Text && input.data.join("") === ESC;
      if (isEsc) {
        // K3: 입력 불변으로 닫기만 한다.
        closeInternal();
        return true;
      }

      // K4: 그 밖의 모든 입력은 닫고 벤더에 넘긴다(false 반환, W2 겸용).
      closeInternal();
      return false;
    },

    dispose() {
      closeInternal();
      disposed = true;
    },

    onApplied(listener) {
      applyListener = listener;
    },
  };
}
