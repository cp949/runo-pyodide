/**
 * `completion-popover.ts` 시험(`docs/design/07-tab-completion.md` 7.6, RD-049).
 * 규칙 ID(K·M·C·W·L)는 7.6의 표를 따른다.
 *
 * `createCompletionPopover`와 `placePopover`를 단독으로 조립해 시험한다.
 * 배선(C1·W1·W3·W4·E0)은 이 파일 밖의 몫이다. `tab-reader.test.ts`·`line-editor.test.ts`가 본다.
 */
import { InputType, type Input } from "@cp949/runo-xterm-readline";
import { createFakeTerminal } from "@repo/pyodide-testkit/fake-terminal";
import { describe, expect, test, vi } from "vitest";
import {
  createCompletionPopover,
  placePopover,
} from "../../src/terminal/completion-popover";

/** ↓ 키 입력. */
const arrowDown: Input = { inputType: InputType.ArrowDown, data: [] };

/** ↑ 키 입력. */
const arrowUp: Input = { inputType: InputType.ArrowUp, data: [] };

/** Enter 키 입력. */
const enter: Input = { inputType: InputType.Enter, data: [] };

/** Tab 키 입력. 벤더는 `UnsupportedControlChar`(`data: ["\t"]`)로 넘긴다. */
const tab: Input = {
  inputType: InputType.UnsupportedControlChar,
  data: ["\t"],
};
/** Esc 키 입력. 벤더는 `Text` 토큰(`data: ["\x1b"]`)으로 넘긴다. */
const esc: Input = { inputType: InputType.Text, data: ["\x1b"] };

/** `.xterm-screen` 크기를 지정해 `getBoundingClientRect`를 고정한다(jsdom은 레이아웃을 계산하지 않는다). */
function stubCellSize(
  screenEl: HTMLElement,
  cols: number,
  rows: number,
  cellWidth: number,
  cellHeight: number,
): void {
  screenEl.getBoundingClientRect = () =>
    ({
      width: cols * cellWidth,
      height: rows * cellHeight,
      top: 0,
      left: 0,
      right: cols * cellWidth,
      bottom: rows * cellHeight,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    }) as DOMRect;
}

/**
 * 가짜 터미널(`withElement`) 위에 popover 하나를 조립한다.
 * `editInsert`는 `vi.fn()`이고 셀 크기는 `stubCellSize`로 고정한다.
 * 옵션 기본값은 80×24, 셀 10×20이다.
 */
function setup(
  options: {
    cols?: number;
    rows?: number;
    cellWidth?: number;
    cellHeight?: number;
  } = {},
) {
  const cols = options.cols ?? 80;
  const rows = options.rows ?? 24;
  const cellWidth = options.cellWidth ?? 10;
  const cellHeight = options.cellHeight ?? 20;
  const fake = createFakeTerminal({ withElement: true, cols, rows });
  const screenEl = fake.term.element?.querySelector(
    ".xterm-screen",
  ) as HTMLElement;
  stubCellSize(screenEl, cols, rows, cellWidth, cellHeight);
  const editInsert = vi.fn();
  const popover = createCompletionPopover(fake.term, { editInsert });
  return { fake, popover, editInsert };
}

describe("placePopover", () => {
  test("[L2] 기본은 커서 행 아래에 배치한다", () => {
    const result = placePopover({
      cursorX: 4,
      cursorY: 5,
      stemWidth: 0,
      cols: 80,
      rows: 24,
      cellWidth: 10,
      cellHeight: 20,
      maxCandidateLength: 8,
      candidateCount: 3,
    });

    expect(result.above).toBe(false);
    expect(result.top).toBe((5 + 1) * 20);
  });

  test("[L1] 표시 행은 후보 수와 10 중 작은 값이고, 높이는 테두리(1px×2)를 더해 내용이 스크롤되지 않는다", () => {
    const result = placePopover({
      cursorX: 0,
      cursorY: 0,
      stemWidth: 0,
      cols: 80,
      rows: 40,
      cellWidth: 10,
      cellHeight: 20,
      maxCandidateLength: 5,
      candidateCount: 15,
    });

    expect(result.visibleRows).toBe(10);
    // border-box라 테두리를 빼면 내용 높이 = 표시 행 × 셀 높이(테두리를 안 더하면 2px 모자라 항상 스크롤된다).
    expect(result.height).toBe(10 * 20 + 2);
  });

  test("[L2] 아래 남은 행이 표시 행보다 적고 위쪽 행이 더 많으면 커서 행 위로 뒤집는다", () => {
    const result = placePopover({
      cursorX: 0,
      cursorY: 8,
      stemWidth: 0,
      cols: 80,
      rows: 10,
      cellWidth: 10,
      cellHeight: 20,
      maxCandidateLength: 5,
      candidateCount: 5,
    });

    // belowSpace = 10 - 8 - 1 = 1 < visibleRows(5), aboveSpace = 8 > 1 → 뒤집기. 아래 끝이 커서 행 위 끝에 붙는다.
    expect(result.above).toBe(true);
    expect(result.top).toBe(8 * 20 - (5 * 20 + 2));
  });

  test("[L3] 오른쪽으로 넘치면 화면 안에 들어오게 왼쪽으로 민다", () => {
    const result = placePopover({
      cursorX: 18,
      cursorY: 0,
      stemWidth: 0,
      cols: 20,
      rows: 24,
      cellWidth: 10,
      cellHeight: 20,
      maxCandidateLength: 15,
      candidateCount: 3,
    });

    const screenWidth = 20 * 10;
    expect(result.width).toBe(15 * 10 + 8 + 2);
    expect(result.left + result.width).toBeLessThanOrEqual(screenWidth);
    expect(result.left).toBe(screenWidth - result.width);
  });

  test("[L1] 놓는 쪽 남은 행이 원하는 행보다 적으면 표시 행을 줄여 화면 위로 새지 않는다", () => {
    const result = placePopover({
      cursorX: 0,
      cursorY: 8,
      stemWidth: 0,
      cols: 80,
      rows: 15,
      cellWidth: 10,
      cellHeight: 20,
      maxCandidateLength: 5,
      candidateCount: 30,
    });

    // belowSpace = 6 < 10, aboveSpace = 8 > 6 → 위. 위쪽 8행만 쓴다.
    expect(result.above).toBe(true);
    expect(result.visibleRows).toBe(8);
    expect(result.top).toBeGreaterThanOrEqual(0);
  });

  test("[L3] 스크롤바 폭을 받으면 그만큼 넓히고, 화면 너비 상한은 지킨다", () => {
    const base = {
      cursorX: 0,
      cursorY: 0,
      stemWidth: 0,
      cols: 80,
      rows: 40,
      cellWidth: 10,
      cellHeight: 20,
      maxCandidateLength: 12,
      candidateCount: 30,
    };

    expect(placePopover({ ...base, scrollbarWidth: 15 }).width).toBe(
      placePopover(base).width + 15,
    );
    expect(placePopover({ ...base, cols: 13, scrollbarWidth: 15 }).width).toBe(
      13 * 10,
    );
  });

  test("열 = cursorX - 스템 코드포인트 수, 음수면 0으로 자른다", () => {
    const result = placePopover({
      cursorX: 2,
      cursorY: 0,
      stemWidth: 5,
      cols: 80,
      rows: 24,
      cellWidth: 10,
      cellHeight: 20,
      maxCandidateLength: 5,
      candidateCount: 3,
    });

    expect(result.left).toBe(0);
  });
});

describe("createCompletionPopover: 키", () => {
  test("[K1] ArrowDown/ArrowUp은 선택을 이동하고 끝에서 반대 끝으로 순환한다", () => {
    const { fake, popover } = setup();
    popover.open(["a", "b", "c"], "");
    const items = () => [
      ...(fake.term.element?.querySelectorAll(
        ".runo-completion-popover__item",
      ) ?? []),
    ];

    expect(popover.onKey(arrowDown)).toBe(true);
    expect(items()[1]?.getAttribute("aria-selected")).toBe("true");

    expect(popover.onKey(arrowDown)).toBe(true);
    expect(items()[2]?.getAttribute("aria-selected")).toBe("true");

    expect(popover.onKey(arrowDown)).toBe(true); // 순환: 2 → 0
    expect(items()[0]?.getAttribute("aria-selected")).toBe("true");

    expect(popover.onKey(arrowUp)).toBe(true); // 순환: 0 → 2
    expect(items()[2]?.getAttribute("aria-selected")).toBe("true");
  });

  test("[K2] Enter는 스템 뒤 부분을 코드포인트 기준으로 editInsert하고 제출 없이 닫는다", () => {
    const { popover, editInsert } = setup();
    // stem "a😀"는 코드포인트 2개, UTF-16 유닛 3개다. 그 뒤 부분은 "bc"다.
    // 스템 길이를 UTF-16 유닛 수(3)로 세면 "c"만 남아 틀린다.
    popover.open(["a😀bc"], "a😀");

    expect(popover.onKey(enter)).toBe(true);

    expect(editInsert).toHaveBeenCalledWith("bc");
    expect(popover.isOpen).toBe(false);
  });

  test("[K2] Tab도 Enter와 같은 적용을 한다", () => {
    const { popover, editInsert } = setup();
    popover.open(["print", "printed"], "pri");

    expect(popover.onKey(tab)).toBe(true);

    expect(editInsert).toHaveBeenCalledWith("nt");
    expect(popover.isOpen).toBe(false);
  });

  test("[K2] close() 뒤 editInsert 순서다 — editInsert가 던져도 이미 닫혀 있다(opus 리뷰 지적)", () => {
    const { popover, editInsert } = setup();
    editInsert.mockImplementation(() => {
      throw new Error("boom");
    });
    popover.open(["print"], "pri");

    expect(() => popover.onKey(enter)).toThrow("boom");
    expect(popover.isOpen).toBe(false);
  });

  test("[K3] Esc는 입력을 바꾸지 않고 닫기만 한다", () => {
    const { popover, editInsert } = setup();
    popover.open(["print"], "pri");

    expect(popover.onKey(esc)).toBe(true);

    expect(editInsert).not.toHaveBeenCalled();
    expect(popover.isOpen).toBe(false);
  });

  test.each<[string, Input]>([
    ["글자", { inputType: InputType.Text, data: ["x"] }],
    ["Backspace", { inputType: InputType.Backspace, data: [] }],
    ["ArrowLeft", { inputType: InputType.ArrowLeft, data: [] }],
    ["Ctrl+C", { inputType: InputType.CtrlC, data: [] }],
    ["Ctrl+D", { inputType: InputType.CtrlD, data: [] }],
  ])("[K4][W2] %s는 닫고 벤더에 넘긴다(false)", (_label, input) => {
    const { popover, editInsert } = setup();
    popover.open(["print"], "pri");

    expect(popover.onKey(input)).toBe(false);

    expect(editInsert).not.toHaveBeenCalled();
    expect(popover.isOpen).toBe(false);
  });

  test("[K5] 닫혀 있을 때는 모든 입력이 아무것도 하지 않는다(false)", () => {
    const { popover, editInsert } = setup();

    expect(popover.onKey(arrowDown)).toBe(false);
    expect(popover.onKey(enter)).toBe(false);

    expect(editInsert).not.toHaveBeenCalled();
    expect(popover.isOpen).toBe(false);
  });
});

describe("createCompletionPopover: 마우스", () => {
  test("[M1] 항목 클릭은 K2와 같은 적용을 하고 닫는다", () => {
    const { fake, popover, editInsert } = setup();
    popover.open(["print", "printed"], "pri");
    const items = fake.term.element!.querySelectorAll(
      ".runo-completion-popover__item",
    );

    items[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(editInsert).toHaveBeenCalledWith("nted");
    expect(popover.isOpen).toBe(false);
  });

  test("[M2] popover mousedown은 preventDefault로 textarea focus를 지킨다", () => {
    const { fake, popover } = setup();
    popover.open(["print"], "pri");
    const container = fake.term.element!.querySelector(
      ".runo-completion-popover",
    )!;
    const event = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });

    container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(popover.isOpen).toBe(true); // M2는 닫지 않는다.
  });

  test("[M2] popover mousedown은 상위(xterm SelectionService 등)로 전파되지 않는다(opus 리뷰 지적)", () => {
    const { fake, popover } = setup();
    popover.open(["print"], "pri");
    const container = fake.term.element!.querySelector(
      ".runo-completion-popover",
    )!;
    const outerHandler = vi.fn();
    fake.term.element!.addEventListener("mousedown", outerHandler);

    container.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );

    expect(outerHandler).not.toHaveBeenCalled();
  });
});

describe("createCompletionPopover: 표시 스타일", () => {
  test("theme 미지정이면 xterm 기본색(검정 배경·흰 글자)을 쓴다 — 빈 문자열(투명)이 아니다(opus 리뷰 지적)", () => {
    const { fake, popover } = setup();
    popover.open(["print"], "pri");
    const container = fake.term.element!.querySelector(
      ".runo-completion-popover",
    ) as HTMLElement;

    expect(container.style.background).toBe("rgb(0, 0, 0)");
    expect(container.style.color).toBe("rgb(255, 255, 255)");
  });

  test("선택 배경은 open() 시점 값을 고정한다 — 연 뒤 theme 변경을 따라가지 않는다(opus 리뷰 지적)", () => {
    const { fake, popover } = setup();
    popover.open(["a", "b"], "");
    fake.term.options.theme!.selectionBackground = "rgb(1, 2, 3)";

    popover.onKey(arrowDown);

    const items = fake.term.element!.querySelectorAll<HTMLElement>(
      ".runo-completion-popover__item",
    );
    expect(items[1]!.style.background).toBe("rgba(255, 255, 255, 0.3)");
  });

  test("너비는 border-box로 계산해 테두리가 화면 밖으로 새지 않는다(opus 리뷰 지적)", () => {
    const { fake, popover } = setup();
    popover.open(["print"], "pri");
    const container = fake.term.element!.querySelector(
      ".runo-completion-popover",
    ) as HTMLElement;

    expect(container.style.boxSizing).toBe("border-box");
    expect(container.style.overflowX).toBe("hidden");
  });
});

describe("createCompletionPopover: 위치", () => {
  test("[L3] .xterm-screen이 terminal.element 안에서 떨어진 거리(padding 등)만큼 좌표를 옮긴다", () => {
    const { fake, popover } = setup();
    const screenEl = fake.term.element!.querySelector(
      ".xterm-screen",
    ) as HTMLElement;
    const screenRect = screenEl.getBoundingClientRect();
    screenEl.getBoundingClientRect = () =>
      ({ ...screenRect, left: 112, top: 57 }) as DOMRect;
    fake.term.element!.getBoundingClientRect = () =>
      ({ ...screenRect, left: 100, top: 50 }) as DOMRect;
    fake.screen.cursorX = 3;
    fake.screen.cursorY = 2;

    popover.open(["print"], "pri");

    const container = fake.term.element!.querySelector(
      ".runo-completion-popover",
    ) as HTMLElement;
    // 열 = 3 - 3 = 0, 행 = 2 + 1 = 3(셀 10×20) → (0, 60)에 padding (12, 7)을 더한다.
    expect(container.style.left).toBe("12px");
    expect(container.style.top).toBe("67px");
  });

  test("[L3] 붙인 뒤 세로 스크롤바가 폭을 차지하면 그만큼 넓힌다", () => {
    const { fake, popover } = setup();
    const offsetWidth = vi
      .spyOn(HTMLElement.prototype, "offsetWidth", "get")
      .mockReturnValue(100);
    const clientWidth = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(83);
    try {
      popover.open(["abcde"], "");
    } finally {
      offsetWidth.mockRestore();
      clientWidth.mockRestore();
    }

    const container = fake.term.element!.querySelector(
      ".runo-completion-popover",
    ) as HTMLElement;
    // 5 × 10 + 여백 8 + 테두리 2 = 60, 스크롤바 100 - 83 - 2 = 15 → 75.
    expect(container.style.width).toBe("75px");
  });
});

describe("createCompletionPopover: 닫기 신호", () => {
  test("[C2] 터미널 쓰기 파싱(배경 출력 포함)이 오면 닫힌다", () => {
    const { fake, popover } = setup();
    popover.open(["print"], "pri");

    fake.term.write("배경 출력");

    expect(popover.isOpen).toBe(false);
  });

  test("[C3] 스크롤이 오면 닫힌다", () => {
    const { fake, popover } = setup();
    popover.open(["print"], "pri");

    fake.emitScroll(3);

    expect(popover.isOpen).toBe(false);
  });

  test("[C4] 크기 변경이 오면 닫힌다", () => {
    const { fake, popover } = setup();
    popover.open(["print"], "pri");

    fake.emitResize(100, 30);

    expect(popover.isOpen).toBe(false);
  });

  test("[C5] textarea가 focus를 잃으면 닫힌다", () => {
    const { fake, popover } = setup();
    popover.open(["print"], "pri");

    fake.term.textarea!.dispatchEvent(new FocusEvent("blur"));

    expect(popover.isOpen).toBe(false);
  });

  test("[C6] 터미널 안, popover 밖 클릭이면 닫힌다", () => {
    const { fake, popover } = setup();
    popover.open(["print"], "pri");

    fake.term.element!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true }),
    );

    expect(popover.isOpen).toBe(false);
  });

  test("[C6] popover 안 클릭은 C6로 닫히지 않는다(M1·M2가 처리)", () => {
    const { fake, popover } = setup();
    popover.open(["print"], "pri");
    const item = fake.term.element!.querySelector(
      ".runo-completion-popover__item",
    )!;

    item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(popover.isOpen).toBe(true);
  });

  test("닫힌 뒤 DOM 0·구독 0(C2~C4 공통)", () => {
    const { fake, popover } = setup();
    popover.open(["print"], "pri");

    popover.close();

    expect(
      fake.term.element!.querySelectorAll(".runo-completion-popover").length,
    ).toBe(0);
    expect(fake.scrollListenerCount).toBe(0);
    expect(fake.resizeListenerCount).toBe(0);
    expect(fake.writeParsedListenerCount).toBe(0);
  });

  test("빈 후보로 open()을 부르면 무동작이다(opus 리뷰 지적: ArrowDown의 `% items.length`가 NaN이 되는 것을 막는다)", () => {
    const { fake, popover, editInsert } = setup();

    popover.open([], "");

    expect(popover.isOpen).toBe(false);
    expect(popover.onKey(arrowDown)).toBe(false);
    expect(editInsert).not.toHaveBeenCalled();
    expect(
      fake.term.element!.querySelectorAll(".runo-completion-popover").length,
    ).toBe(0);
  });
});

describe("createCompletionPopover: dispose", () => {
  test("dispose는 close + 이후 open을 무동작으로 만든다", () => {
    const { fake, popover } = setup();
    popover.open(["print"], "pri");

    popover.dispose();
    expect(popover.isOpen).toBe(false);

    popover.open(["print"], "pri");

    expect(popover.isOpen).toBe(false);
    expect(
      fake.term.element!.querySelectorAll(".runo-completion-popover").length,
    ).toBe(0);
  });
});
