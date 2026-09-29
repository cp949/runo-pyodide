/**
 * 입력 history.
 * 새 항목이 앞(인덱스 0)에 온다. `cursor`는 탐색 위치다.
 * 규칙은 docs/design/06-editing.md 6.1.
 */

/** `History` 생성 옵션. */
export interface HistoryOptions {
  /** false면 localStorage에 저장·복원하지 않는다. 기본값은 true(원본 동작). */
  persist?: boolean;
}

/** 줄 단위 history. 최신 항목이 `entries[0]`이다. */
export class History {
  /** 최신 항목이 앞인 배열 */
  public entries: string[] = [];

  /** `entries`에 담을 수 있는 최대 개수 */
  public maxEntries: number;

  /** 탐색 위치. -1이면 탐색 중이 아니다. 클수록 오래된 항목이다. */
  public cursor = -1;

  private readonly persist: boolean;

  constructor(maxEntries: number, options: HistoryOptions = {}) {
    this.maxEntries = maxEntries;
    this.persist = options.persist ?? true;
  }

  /**
   * `entries`를 localStorage `history` 키에 JSON으로 저장한다.
   * `persist`가 false면 아무것도 하지 않는다.
   * `window`가 없는 환경에서는 `persist: false`여야 한다. `window?.`가 선언 없는 `window`를 막지 못한다.
   */
  public saveToLocalStorage() {
    if (!this.persist) return;
    const localStorage = window?.localStorage;
    if (localStorage !== undefined) {
      localStorage.setItem("history", JSON.stringify(this.entries));
    }
  }

  /**
   * localStorage `history` 키에서 `entries`를 복원한다.
   * `persist`가 false거나 키가 없으면 아무것도 하지 않는다.
   * JSON이 아니거나 문자열 배열이 아니면 `entries`를 비우고 저장값도 `[]`로 되돌린다.
   */
  public restoreFromLocalStorage() {
    if (!this.persist) return;
    const localStorage = window?.localStorage;
    if (localStorage !== undefined) {
      const historyJson = localStorage.getItem("history");
      if (historyJson === undefined || historyJson === null) {
        return;
      }
      try {
        const historyEntries: string[] = JSON.parse(historyJson);
        if (
          !Array.isArray(historyEntries) ||
          historyEntries.find((it) => typeof it !== "string") !== undefined
        ) {
          this.entries = [];
          localStorage.setItem("history", "[]");
        } else {
          this.entries = historyEntries;
        }
      } catch (e) {
        this.entries = [];
        localStorage.setItem("history", "[]");
      }
    }
  }

  /**
   * `text`를 맨 앞에 추가하고 탐색 위치를 처음으로 되돌린다.
   * 같은 항목이 이미 있으면 그 항목을 지우고 맨 앞에 다시 넣는다(중복 없음).
   * `maxEntries`를 넘으면 가장 오래된 항목을 버린다.
   * 끝에서 `saveToLocalStorage()`를 부른다.
   */
  public append(text: string) {
    this.resetCursor();
    if (!this.entries.includes(text)) {
      this.entries.unshift(text);
    } else {
      this.entries.splice(this.entries.indexOf(text), 1);
      this.entries.unshift(text);
    }
    if (this.entries.length > this.maxEntries) {
      this.entries.pop();
    }
    this.saveToLocalStorage();
  }

  /** 탐색 위치를 처음(-1)으로 되돌린다. */
  public resetCursor() {
    this.cursor = -1;
  }

  /**
   * 스냅샷(`entries.slice()`)으로 되돌린다.
   * 복사본을 넣어 호출자 배열과 공유하지 않는다.
   * 탐색 위치를 처음으로 되돌리고 저장한다.
   */
  public restore(entries: string[]) {
    this.entries = entries.slice();
    this.resetCursor();
    this.saveToLocalStorage();
  }

  /**
   * 더 최근 항목으로 한 칸 이동해 그 항목을 돌려준다.
   * 탐색 중이 아니면(`cursor === -1`) `undefined`다.
   * 가장 최근 항목에서 한 번 더 부르면 `cursor`가 -1이 되고 `undefined`를 돌려준다.
   */
  public next(): string | undefined {
    if (this.cursor === -1) {
      return undefined;
    } else {
      this.cursor -= 1;
    }

    return this.entries[this.cursor];
  }

  /**
   * 더 오래된 항목으로 한 칸 이동해 그 항목을 돌려준다.
   * 이미 가장 오래된 항목이면 이동하지 않고 `undefined`다.
   */
  public prev(): string | undefined {
    if (this.cursor + 1 >= this.entries.length) {
      return undefined;
    } else {
      this.cursor += 1;
    }

    return this.entries[this.cursor];
  }
}
