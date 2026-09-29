/**
 * 시험용 가상 터미널 `VTerm` 시험. 다른 시험이 화면 결과를 검증하는 바탕이다.
 * - 일반 문자 기록, 커서 이동, 오른쪽 끝 pending-wrap.
 * - CUU/CUD/CUF/CUB의 경계 고정, ED(`\x1b[J`) 지우기.
 * - 마지막 행 LF의 스크롤백 이동, SGR 무시.
 */
import { expect, test } from "vitest";
import { VTerm } from "../src/vterm";

test("일반 문자는 격자에 쓰이고 커서가 전진한다", () => {
  const t = new VTerm(10, 3);
  t.write("hello");
  expect(t.screen()).toBe("hello");
  expect(t.cursor()).toEqual([0, 5]);
});

test("\\r\\n은 다음 줄 0열로 옮긴다", () => {
  const t = new VTerm(10, 3);
  t.write("ab\r\ncd");
  expect(t.screen()).toBe("ab\ncd");
  expect(t.cursor()).toEqual([1, 2]);
});

test("오른쪽 끝 자동 줄바꿈은 즉시가 아니라 pending-wrap을 쓴다", () => {
  const t = new VTerm(5, 3);
  t.write("abcde"); // 0행을 채운다. 커서는 4열에 머물고 줄바꿈은 보류된다.
  expect(t.screen()).toBe("abcde");
  expect(t.cursor()).toEqual([0, 4]);
  t.write("f"); // 다음 글자에서 줄바꿈한다.
  expect(t.screen()).toBe("abcde\nf");
  expect(t.cursor()).toEqual([1, 1]);
});

test("\\r은 pending-wrap을 취소한다", () => {
  const t = new VTerm(5, 3);
  t.write("abcde");
  t.write("\r");
  t.write("X");
  expect(t.screen()).toBe("Xbcde");
  expect(t.cursor()).toEqual([0, 1]);
});

test("CUU/CUD/CUF/CUB는 가장자리에서 멈춘다", () => {
  const t = new VTerm(10, 3);
  t.write("\x1b[5A"); // 맨 위를 넘어 올린다.
  expect(t.cursor()).toEqual([0, 0]);
  t.write("\x1b[5B");
  expect(t.cursor()).toEqual([2, 0]);
  t.write("\x1b[20C");
  expect(t.cursor()).toEqual([2, 9]);
  t.write("\x1b[20D");
  expect(t.cursor()).toEqual([2, 0]);
});

test("\\x1b[J는 커서부터 화면 끝까지 지운다", () => {
  const t = new VTerm(5, 3);
  t.write("abcde\r\nfghij\r\nkl");
  t.write("\x1b[2A"); // 0행 2열로 올린다.
  // 이전 출력으로 커서가 (2, 2)에 있었고, CUU 뒤 (0, 2)에 놓인다.
  expect(t.cursor()).toEqual([0, 2]);
  t.write("\x1b[J");
  expect(t.screen()).toBe("ab");
});

test("마지막 행의 LF는 스크롤하고 맨 윗 행을 스크롤백으로 보낸다", () => {
  const t = new VTerm(5, 2);
  t.write("aaa\r\nbbb\r\n");
  expect(t.scrollback.length).toBe(1);
  expect(t.scrollback[0].join("")).toBe("aaa  ");
  expect(t.screen()).toBe("bbb");
});

test("SGR 시퀀스는 보이는 출력에서 무시한다", () => {
  const t = new VTerm(10, 1);
  t.write("\x1b[1;31mhi\x1b[0m there");
  expect(t.screen()).toBe("hi there");
});
