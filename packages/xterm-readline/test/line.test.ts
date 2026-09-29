/**
 * `LineBuffer` 시험.
 * - 커서 이동·삭제는 서로게이트 쌍(이모지)을 한 글자로 센다.
 * - `moveLineUp`·`moveLineDown`은 첫 줄의 프롬프트 폭(`promptCols`)을 시각 열에 반영한다.
 */
import { expect, test } from "vitest";
import { LineBuffer } from "../src/line";

test("prevPos는 서로게이트 쌍을 한 글자로 세어 이전 위치를 돌려준다", () => {
  {
    const line = new LineBuffer();
    line.insert("foo");
    line.set_pos(0);
    expect(line.prevPos(1)).toBeUndefined();
  }
  {
    const line = new LineBuffer();
    line.insert("foo");
    expect(line.prevPos(1)).toBe(2);
    expect(line.prevPos(2)).toBe(1);
    expect(line.prevPos(3)).toBe(0);
    expect(line.prevPos(4)).toBe(0);
  }
  {
    const line = new LineBuffer();
    line.insert("foobar");
    line.set_pos(3);
    expect(line.prevPos(1)).toBe(2);
    expect(line.prevPos(2)).toBe(1);
    expect(line.prevPos(3)).toBe(0);
    expect(line.prevPos(4)).toBe(0);
  }
  {
    const line = new LineBuffer();
    line.insert("fo🐕");
    expect(line.prevPos(1)).toBe(2);
  }
});

test("backspace는 이모지를 한 글자로 지운다", () => {
  {
    const line = new LineBuffer();
    line.insert("foobar");
    expect(line.backspace(3)).toBeTruthy();
    expect(line.buffer()).toBe("foo");
  }
  {
    const line = new LineBuffer();
    line.insert("fo🐕");
    expect(line.backspace(1)).toBeTruthy();
    expect(line.buffer()).toBe("fo");
  }
});

test("deleteEndOfLine은 커서부터 논리 줄 끝까지 지운다", () => {
  {
    const line = new LineBuffer();
    line.insert("foobar");
    expect(line.moveBack(3)).toBeTruthy();
    expect(line.buffer()).toBe("foobar");
    expect(line.deleteEndOfLine()).toBeTruthy();
    expect(line.buffer()).toBe("foo");
  }

  {
    const line = new LineBuffer();
    line.insert("foo\nbar");

    expect(line.moveLineUp(1)).toBeTruthy();
    expect(line.buffer()).toBe("foo\nbar");
    expect(line.moveBack(2)).toBeTruthy();
    expect(line.deleteEndOfLine()).toBeTruthy();
    expect(line.buffer()).toBe("f\nbar");

    expect(line.moveLineDown(1)).toBeTruthy();
    expect(line.deleteEndOfLine()).toBeTruthy();
    expect(line.buffer()).toBe("f\nb");
  }
});

test("moveLineUp은 0행의 프롬프트 폭을 반영한다", () => {
  const line = new LineBuffer();
  // 버퍼 0행은 "abcde"다. 2열 프롬프트 뒤에 그려지므로 시각 열 2~6을 차지한다.
  // 버퍼 1행은 "wxyz"다. 커서는 1행 끝, 시각 열 4다.
  line.insert("abcde\nwxyz");

  expect(line.moveLineUp(1, 2)).toBeTruthy();
  // 0행의 시각 열 4 = 버퍼 열 4 - 2 = 2. 커서는 'c' 앞에 놓인다.
  expect(line.pos).toBe(2);
});

test("moveLineDown은 0행의 프롬프트 폭을 반영한다", () => {
  const line = new LineBuffer();
  line.insert("abcde\nwxyz");
  // 커서를 0행의 버퍼 위치 4("abcd|e")로 옮긴다.
  // 시각 열은 6(= 4 + promptCols 2)이다.
  line.moveBack(line.length() - 4);
  expect(line.pos).toBe(4);

  expect(line.moveLineDown(1, 2)).toBeTruthy();
  // 1행의 시각 열 6은 버퍼 열 6이지만 1행은 4글자뿐이다.
  // 커서는 1행 끝에 놓인다.
  expect(line.pos).toBe(line.length());

  // 열을 줄여 커서가 1행 안에 머무는 경우를 본다.
  const line2 = new LineBuffer();
  line2.insert("abcde\nwxyz");
  line2.moveBack(line2.length() - 1); // 위치 1, 시각 열 3
  expect(line2.pos).toBe(1);
  expect(line2.moveLineDown(1, 2)).toBeTruthy();
  // 1행의 시각 열 3 = 버퍼 열 3. 커서는 'y'와 'z' 사이에 놓인다.
  expect(line2.pos).toBe(6 + 3); // "abcde\n"이 6, 1행 안에서 3글자 지난 위치
});

test("프롬프트 폭이 없으면 moveLineUp·moveLineDown은 글자 수 기준으로 움직인다(기존 동작)", () => {
  const line = new LineBuffer();
  line.insert("abcde\nwxyz");
  expect(line.moveLineUp(1)).toBeTruthy(); // promptCols 기본값은 0
  // 시각 열 4 = 버퍼 열 4. 커서는 0행의 'd'와 'e' 사이에 놓인다.
  expect(line.pos).toBe(4);
});

test("moveLineUp은 도착 열이 0이면 도착 줄 처음으로 간다", () => {
  const line = new LineBuffer();
  // 두 번째 줄 처음(열 0)에 커서를 둔다.
  line.update("abc\nde", 4);
  expect(line.moveLineUp(1)).toBeTruthy();
  expect(line.pos).toBe(0);
});

test("moveLineUp은 여러 줄 위로 올라가도 도착 열 0이면 도착 줄 처음으로 간다", () => {
  const line = new LineBuffer();
  // 셋째 줄 처음(위치 7)에서 두 줄 올라가면 첫 줄 처음이다.
  line.update("abc\nde\nfg", 7);
  expect(line.moveLineUp(2)).toBeTruthy();
  expect(line.pos).toBe(0);

  // 넷째 줄 처음(위치 10)에서 두 줄 올라가면 둘째 줄 처음이다.
  line.update("abc\nde\nfg\nhi", 10);
  expect(line.moveLineUp(2)).toBeTruthy();
  expect(line.pos).toBe(4);
});

test("moveLineUp은 도착 줄이 비어 있으면 그 줄에 머문다", () => {
  const line = new LineBuffer();
  // 둘째 줄이 비어 있다. 셋째 줄 열 1에서 한 줄 올라가면 빈 줄(위치 4)이다.
  line.update("abc\n\nde", 6);
  expect(line.moveLineUp(1)).toBeTruthy();
  expect(line.pos).toBe(4);

  // 빈 줄 두 개 위로 올라가도 도착 줄 처음이다.
  line.update("\n\nde", 3);
  expect(line.moveLineUp(2)).toBeTruthy();
  expect(line.pos).toBe(0);
});

test("moveLineUp은 프롬프트 폭이 도착 열보다 크면 0번 줄 처음으로 간다", () => {
  const line = new LineBuffer();
  // 1행의 시각 열 2가 0번 줄에서는 프롬프트 안(5열)이라 버퍼 열이 0 아래로 내려간다.
  line.update("abc\nde", 6);
  expect(line.moveLineUp(1, 5)).toBeTruthy();
  expect(line.pos).toBe(0);
});
