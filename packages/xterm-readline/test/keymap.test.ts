/**
 * `parseInput`(입력 문자열 → 입력 종류별 조각) 시험.
 * - 일반 문자는 `Text` 하나로 묶고, 특수 키에서 나눈다.
 * - 이스케이프 시퀀스는 지원 여부에 따라 전용 종류 또는 `UnsupportedEscape`로 분류한다.
 * - 파라미터가 붙은 CSI 시퀀스는 최종 바이트까지 읽는다. 최종 바이트 없이 끝나면 버린다.
 */
import { expect, test } from "vitest";
import { InputType, parseInput } from "../src/keymap";

test("일반 문자열은 Text 하나로 묶는다", () => {
  expect(parseInput("foo")).toEqual([
    {
      inputType: InputType.Text,
      data: ["f", "o", "o"],
    },
  ]);
});

test("Enter는 전용 종류로 분류한다", () => {
  expect(parseInput("\r")).toEqual([
    {
      inputType: InputType.Enter,
      data: ["\r"],
    },
  ]);
});

test("특수 키에서 Text 조각을 나눈다", () => {
  expect(parseInput("foo\rbar")).toEqual([
    {
      inputType: InputType.Text,
      data: ["f", "o", "o"],
    },
    {
      inputType: InputType.Enter,
      data: ["\r"],
    },
    {
      inputType: InputType.Text,
      data: ["b", "a", "r"],
    },
  ]);
});

test("이스케이프 시퀀스를 지원 여부에 따라 분류한다", () => {
  expect(parseInput("\x1b[D")).toEqual([
    {
      inputType: InputType.ArrowLeft,
      data: ["\x1b", "[", "D"],
    },
  ]);

  expect(parseInput("\x1b\r")).toEqual([
    {
      inputType: InputType.AltEnter,
      data: ["\x1b", "\r"],
    },
  ]);

  expect(parseInput("\x1bZ")).toEqual([
    {
      inputType: InputType.UnsupportedEscape,
      data: ["\x1b", "Z"],
    },
  ]);

  expect(parseInput("\x1b[Z")).toEqual([
    {
      inputType: InputType.UnsupportedEscape,
      data: ["\x1b", "[", "Z"],
    },
  ]);

  expect(parseInput("\x1b[3~")).toEqual([
    {
      inputType: InputType.Delete,
      data: ["\x1b", "[", "3", "~"],
    },
  ]);

  expect(parseInput("\x1b[1~")).toEqual([
    {
      inputType: InputType.UnsupportedEscape,
      data: ["\x1b", "[", "1", "~"],
    },
  ]);

  expect(parseInput("\x1b[1d")).toEqual([
    {
      inputType: InputType.UnsupportedEscape,
      data: ["\x1b", "[", "1", "d"],
    },
  ]);
});

test("수정자가 붙은 CSI 시퀀스는 최종 바이트까지 하나의 UnsupportedEscape로 읽는다", () => {
  expect(parseInput("\x1b[1;5C")).toEqual([
    {
      inputType: InputType.UnsupportedEscape,
      data: ["\x1b", "[", "1", ";", "5", "C"],
    },
  ]);

  // 뒤따르는 글자는 시퀀스에 섞이지 않고 Text가 된다.
  expect(parseInput("\x1b[1;5Cx")).toEqual([
    {
      inputType: InputType.UnsupportedEscape,
      data: ["\x1b", "[", "1", ";", "5", "C"],
    },
    { inputType: InputType.Text, data: ["x"] },
  ]);

  // 최종 바이트가 `~`여도 파라미터가 `3`이 아니면 Delete가 아니다.
  expect(parseInput("\x1b[3;5~")).toEqual([
    {
      inputType: InputType.UnsupportedEscape,
      data: ["\x1b", "[", "3", ";", "5", "~"],
    },
  ]);
});

test("세 자리 이상 파라미터의 CSI 시퀀스도 최종 바이트까지 읽는다", () => {
  expect(parseInput("\x1b[200~ab\x1b[201~")).toEqual([
    {
      inputType: InputType.UnsupportedEscape,
      data: ["\x1b", "[", "2", "0", "0", "~"],
    },
    { inputType: InputType.Text, data: ["a", "b"] },
    {
      inputType: InputType.UnsupportedEscape,
      data: ["\x1b", "[", "2", "0", "1", "~"],
    },
  ]);
});

test("Delete 시퀀스 뒤의 글자는 Text가 된다", () => {
  expect(parseInput("\x1b[3~x")).toEqual([
    {
      inputType: InputType.Delete,
      data: ["\x1b", "[", "3", "~"],
    },
    { inputType: InputType.Text, data: ["x"] },
  ]);
});

test("최종 바이트 없이 끝난 CSI 시퀀스는 버린다", () => {
  expect(parseInput("\x1b[1;5")).toEqual([]);
});
