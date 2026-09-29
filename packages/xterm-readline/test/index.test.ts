/**
 * 패키지 진입점의 공개 표면 시험.
 * - 코어(`packages/pyodide-repl`)는 이 export만 쓰고 private 멤버에 접근하지 않는다.
 * - 시험 전용 헬퍼(`VTerm`)와 내부 레이아웃 타입은 공개하지 않는다.
 */
import { expect, test } from "vitest";
import * as api from "../src/index";

test("코어가 쓰는 Readline·ReadCancelledError·ReadTakenError·History·State·Tty·InputType·READ_EOF만 값으로 export한다", () => {
  expect(Object.keys(api).sort()).toEqual([
    "History",
    "InputType",
    // eof 읽기가 빈 버퍼 Ctrl+D로 끝날 때 돌려주는 벤더 자체 값(unique symbol)
    "READ_EOF",
    "ReadCancelledError",
    // takeRead()가 읽기를 끝낼 때 쓰는 오류. 코어가 ReadCancelledError와 구분하려고 값으로 쓴다.
    "ReadTakenError",
    "Readline",
    "State",
    "Tty",
  ]);
});

test("InputType은 키 입력 종류를 구분하는 enum이다", () => {
  expect(api.InputType[api.InputType.Text]).toBe("Text");
  expect(api.InputType[api.InputType.CtrlC]).toBe("CtrlC");
  expect(api.InputType[api.InputType.ShiftEnter]).toBe("ShiftEnter");
});
