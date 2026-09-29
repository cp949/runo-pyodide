/**
 * 핸들러 표 합성(`composeRpcHandlers`) 시험.
 * - core·driver 핸들러 표를 하나로 합친다.
 * - 이름이 겹치면 조용히 덮어쓰지 않고 이름을 담은 예외를 던진다.
 */
import { describe, expect, test } from "vitest";
import { composeRpcHandlers } from "../../src/protocol/rpc-handlers";

describe("composeRpcHandlers: core·driver 핸들러 표 합성", () => {
  test("이름이 겹치지 않는 표들을 하나로 합친다", () => {
    const write = () => "w";
    const complete = () => "c";

    const merged = composeRpcHandlers({ write }, { complete });

    expect(Object.keys(merged).sort()).toEqual(["complete", "write"]);
    expect(merged.write).toBe(write);
    expect(merged.complete).toBe(complete);
  });

  test("핸들러가 없는 표(빈 객체)와도 합성한다", () => {
    const complete = () => "c";

    expect(composeRpcHandlers({}, { complete })).toEqual({ complete });
    expect(composeRpcHandlers({ complete }, {})).toEqual({ complete });
  });

  test("표 사이에 같은 이름이 있으면 그 이름을 담은 예외를 던진다", () => {
    expect(() =>
      composeRpcHandlers({ write: () => 1 }, { write: () => 2 }),
    ).toThrow(/write/);
  });

  test("세 표 이상에서도 뒤쪽 표끼리 겹치면 예외를 던진다", () => {
    expect(() =>
      composeRpcHandlers({ a: () => 1 }, { b: () => 2 }, { b: () => 3 }),
    ).toThrow(/b/);
  });
});
