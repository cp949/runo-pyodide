/**
 * 선택 영역 복사 정책. 두 경로를 하나의 기전(`navigator.clipboard.writeText` + `terminal.getSelection()`)으로 묶는다.
 *
 * - Ctrl+C(선택 있음): `decideKey`가 `copy`로 판정하면 `onKeyEvent`가 `preventDefault()`로 xterm 기본 처리를 막고
 *   복사한 뒤 `clearSelection()`으로 선택을 지운다(다음 Ctrl+C가 인터럽트·취소가 되게 한다, RD-017 확정 2).
 * - 드래그 선택(`copyOnSelect`가 참일 때): `mousedown`(`button === 0`)으로 드래그 시작을 표시하고, `mouseup`에서
 *   선택이 있으면 복사한다. 선택은 지우지 않는다(자동 복사는 사용자가 계속 볼 수 있게 유지).
 *
 * 빈 선택은 방어적으로 무시한다(`hasSelection()`이 참이면 이미 비지 않지만, 판정과 읽기 사이에 상태가 바뀌는
 * 경우를 대비). `writeText`는 시험에서 주입할 수 있도록 옵션으로 뺐다(jsdom에는 `navigator.clipboard`가 없다).
 */

/** `decideKey`가 보는 키 이벤트의 최소 형태. `KeyboardEvent` 구조와 호환된다. */
export interface KeyLike {
  type: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  key: string;
}

/** 복사 정책이 읽고 쓰는 터미널의 최소 형태. 실제 xterm `Terminal`과 구조적으로 호환된다. */
export interface SelectionTerminal {
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  readonly element?: HTMLElement;
}

export type CopyResult =
  { ok: true; chars: number } | { ok: false; error: unknown };

export interface SelectionCopyOptions {
  /** 참이면 드래그로 선택을 만든 뒤(`mouseup`) 자동 복사한다. Ctrl+C 복사는 이 값과 무관하게 항상 동작한다. */
  copyOnSelect: boolean;
  onCopy?: (result: CopyResult) => void;
  /** 기본값은 `navigator.clipboard.writeText`. 시험 용이성을 위해 주입 가능. */
  writeText?: (text: string) => Promise<void>;
}

export interface SelectionCopy {
  /** 벤더 `ReadlineOptions.onKeyEvent`에 그대로 넘긴다. `true`면 벤더·xterm 기본 처리를 생략시킨다. */
  onKeyEvent(event: KeyboardEvent): boolean;
  setCopyOnSelect(on: boolean): void;
  dispose(): void;
}

const defaultWriteText = (text: string): Promise<void> =>
  navigator.clipboard.writeText(text);

/**
 * `keydown`이고 Ctrl(Alt·Meta 없이)+C이며 선택이 있으면 `copy`, 그 외는 `pass`. Shift 유무는 보지 않는다
 * (Ctrl+Shift+C도 복사). Mac Cmd+C(`metaKey`)는 제외 — 네이티브 복사가 이미 처리한다.
 */
export function decideKey(
  key: KeyLike,
  hasSelection: boolean,
): "copy" | "pass" {
  if (
    key.type === "keydown" &&
    key.ctrlKey &&
    !key.altKey &&
    !key.metaKey &&
    key.key.toLowerCase() === "c" &&
    hasSelection
  ) {
    return "copy";
  }
  return "pass";
}

export function createSelectionCopy(
  terminal: SelectionTerminal,
  options: SelectionCopyOptions,
): SelectionCopy {
  let copyOnSelect = options.copyOnSelect;
  const onCopy = options.onCopy;
  const writeText = options.writeText ?? defaultWriteText;
  let disposed = false;
  let dragging = false;

  const copy = (): void => {
    const text = terminal.getSelection();
    if (text === "") return;
    writeText(text).then(
      () => onCopy?.({ ok: true, chars: [...text].length }),
      (error: unknown) => onCopy?.({ ok: false, error }),
    );
  };

  const onMouseDown = (event: MouseEvent): void => {
    if (event.button === 0) dragging = true;
  };
  const onMouseUp = (): void => {
    if (!dragging) return;
    dragging = false;
    if (copyOnSelect && terminal.hasSelection()) copy();
  };

  const element = terminal.element;
  const doc = element?.ownerDocument;
  element?.addEventListener("mousedown", onMouseDown);
  doc?.addEventListener("mouseup", onMouseUp);

  return {
    onKeyEvent(event) {
      if (disposed) return false;
      const decision = decideKey(
        {
          type: event.type,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          key: event.key,
        },
        terminal.hasSelection(),
      );
      if (decision !== "copy") return false;
      event.preventDefault();
      copy();
      terminal.clearSelection();
      return true;
    },
    setCopyOnSelect(on) {
      if (disposed) return;
      copyOnSelect = on;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      element?.removeEventListener("mousedown", onMouseDown);
      doc?.removeEventListener("mouseup", onMouseUp);
    },
  };
}
