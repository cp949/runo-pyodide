/**
 * `History` 시험.
 * - 용량 초과 시 오래된 항목을 덮어쓴다.
 * - `prev()`·`next()`로 cursor를 옮긴다.
 * - `restore()`는 복사본으로 되돌리고 cursor를 -1로 초기화한다.
 */
import { expect, test } from "vitest";
import { History } from "../src/history";

test("append는 용량을 넘으면 오래된 항목을 덮어쓴다", () => {
  const history = new History(2);
  history.append("a");
  history.append("b");
  history.append("c");
  expect(history.entries).toEqual(["c", "b"]);
});

test("prev·next가 cursor를 옮기고 양 끝에서 undefined를 돌려준다", () => {
  const history = new History(3);
  history.append("a");
  history.append("b");
  history.append("c");
  expect(history.prev()).toEqual("c");
  expect(history.prev()).toEqual("b");
  expect(history.prev()).toEqual("a");
  expect(history.prev()).toBeUndefined();
  expect(history.next()).toEqual("b");
  expect(history.next()).toEqual("c");
  expect(history.next()).toBeUndefined();
});

test("restore는 복사본으로 되돌리고 cursor를 -1로 한다", () => {
  const history = new History(3);
  history.append("a");
  history.append("b");
  history.prev();
  expect(history.cursor).toBe(0);

  const snapshot = ["x", "y"];
  history.restore(snapshot);

  expect(history.entries).toEqual(["x", "y"]);
  expect(history.cursor).toBe(-1);

  snapshot.push("z");
  expect(history.entries).toEqual(["x", "y"]);
});
