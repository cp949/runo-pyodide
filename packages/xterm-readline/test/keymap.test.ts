/**
 * `parseInput`(입력 문자열 → 입력 종류별 조각) 시험.
 * - 일반 문자는 `Text` 하나로 묶고, 특수 키에서 나눈다.
 * - 이스케이프 시퀀스는 지원 여부에 따라 전용 종류 또는 `UnsupportedEscape`로 분류한다.
 * - 알 수 없는 CSI 시퀀스는 버린다.
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

  expect(parseInput("\x1b[1d")).toEqual([]);
});
