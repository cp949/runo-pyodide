/**
 * `persist` 옵션 시험.
 * 옵션을 생략하면 원본 1.2.2처럼 localStorage에 저장·복원하고,
 * `persist: false`면 History와 Readline이 localStorage를 읽지도 쓰지도 않는지 확인한다.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { History } from "../src/history";
import { Readline } from "../src/readline";

const STORAGE_KEY = "history";

beforeEach(() => {
  localStorage.clear();
});

describe("History의 persist 옵션", () => {
  test("옵션을 생략하면 항목을 localStorage에 저장한다", () => {
    const history = new History(3);
    history.append("a");
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(["a"]));
  });

  test("persist: false면 append가 localStorage에 쓰지 않는다", () => {
    const history = new History(3, { persist: false });
    history.append("a");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("persist: false면 restoreFromLocalStorage가 저장된 항목을 불러오지 않는다", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["old"]));
    const history = new History(3, { persist: false });
    history.restoreFromLocalStorage();
    expect(history.entries).toEqual([]);
  });

  test("persist: false여도 메모리 안의 항목 추가와 이전/다음 이동은 그대로 동작한다", () => {
    const history = new History(3, { persist: false });
    history.append("a");
    history.append("b");
    expect(history.prev()).toBe("b");
    expect(history.prev()).toBe("a");
    expect(history.next()).toBe("b");
  });
});

describe("Readline의 persist 옵션", () => {
  test("옵션을 생략하면 저장된 history를 복원하고 새 항목을 저장한다", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["old"]));
    new Readline().appendHistory("new");
    expect(localStorage.getItem(STORAGE_KEY)).toBe(
      JSON.stringify(["new", "old"]),
    );
  });

  test("persist: false면 저장된 history를 복원하지도 덮어쓰지도 않는다", () => {
    // 복원했다면 append 뒤에 ["new","old"]가 저장되고, 복원 없이 저장만 했다면 ["new"]가 저장된다.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["old"]));
    new Readline({ persist: false }).appendHistory("new");
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(["old"]));
  });
});
