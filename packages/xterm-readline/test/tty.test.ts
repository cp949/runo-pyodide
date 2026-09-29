/**
 * `Tty` 시험.
 * - `splitIntoVisualRows`: 열 폭·`\n`·탭·전각 문자 기준 줄바꿈, 행 경계에서 SGR 이어붙임.
 * - `calculatePosition`: SGR·CSI 시퀀스는 폭 0으로 세고, 사설 접두 CSI 뒤 글자는 폭을 센다.
 * - `refreshLine`: 출력을 커서 숨김·표시로 감싼다.
 */
import { expect, test, vi } from "vitest";
import { IdentityHighlighter } from "../src/highlight";
import { LineBuffer } from "../src/line";
import { Layout, Position } from "../src/state";
import { Tty } from "../src/tty";

/** `Tty`가 쓰는 `Output`의 가짜. 출력 조각을 `output`에 모으고 호출을 `vi.fn`으로 기록한다. */
class Output {
  output: string[] = [];
  write = vi.fn((text: string) => this.output.push(text));
  print = vi.fn((text: string) => this.output.push(text));
  println = vi.fn((text: string) => this.output.push(text));
}

test("splitIntoVisualRows는 열 경계에서 줄바꿈한다", () => {
  const tty = new Tty(5, 24, 8, new Output());
  expect(tty.splitIntoVisualRows("abcdefgh")).toEqual(["abcde", "fgh"]);
});

test("splitIntoVisualRows는 버퍼가 열 끝에서 끝나면 빈 행을 하나 더 붙인다", () => {
  const tty = new Tty(5, 24, 8, new Output());
  // 5글자가 0행을 정확히 채운다.
  // calculatePosition의 (row+1, 0) 정규화와 맞춰야 렌더러의 행 수가 Layout.end.row와 같다.
  expect(tty.splitIntoVisualRows("abcde")).toEqual(["abcde", ""]);
});

test("splitIntoVisualRows는 \\n에서 행을 나눈다", () => {
  const tty = new Tty(80, 24, 8, new Output());
  expect(tty.splitIntoVisualRows("foo\nbar\nbaz")).toEqual([
    "foo",
    "bar",
    "baz",
  ]);
});

test("splitIntoVisualRows는 줄바꿈된 행 앞에 활성 SGR을 다시 붙인다", () => {
  const tty = new Tty(5, 24, 8, new Output());
  // "\x1b[31m"은 글자를 빨강으로 칠한다. 줄바꿈 지점은 'd'와 'e' 사이다.
  // 1행 앞에 활성 SGR을 다시 붙여야 스타일이 행 경계를 넘어 이어진다.
  const rows = tty.splitIntoVisualRows("\x1b[31mabcdef\x1b[0m");
  expect(rows[0]).toBe("\x1b[31mabcde");
  expect(rows[1]).toBe("\x1b[31mf\x1b[0m");
});

test("splitIntoVisualRows는 \\x1b[0m에서 SGR 추적을 초기화한다", () => {
  const tty = new Tty(5, 24, 8, new Output());
  // 스타일이 행 중간에 끝난 뒤 줄바꿈한다. 1행은 SGR을 물려받으면 안 된다.
  const rows = tty.splitIntoVisualRows("\x1b[31mab\x1b[0mcdef");
  expect(rows[0]).toBe("\x1b[31mab\x1b[0mcde");
  expect(rows[1]).toBe("f");
});

test("splitIntoVisualRows는 탭을 다음 탭 정지 위치까지 넓힌다", () => {
  // tabWidth=4. "a\tb"에서 'a'는 1열, 탭은 4열까지(폭 3), 'b'는 5열에서 끝난다.
  const tty = new Tty(80, 24, 4, new Output());
  const rows = tty.splitIntoVisualRows("a\tb");
  expect(rows).toEqual(["a\tb"]);
  expect(tty.calculatePosition("a\tb", new Position(0, 0))).toEqual(
    new Position(0, 5),
  );
});

test("splitIntoVisualRows는 줄바꿈 경계의 전각 문자를 처리한다", () => {
  // 5열 터미널에서 "中"의 폭은 2다. "ab中cd"의 배치:
  // - 'a', 'b', '中'이 4열까지 채운다.
  // - 'c'는 4+1=5열로 0행에 들어간다.
  // - 'd'는 5+1=6열이라 줄바꿈된다.
  // 줄바꿈 규칙은 `col + cw > cols`다.
  const tty = new Tty(5, 24, 8, new Output());
  const rows = tty.splitIntoVisualRows("ab中cd");
  expect(rows[0]).toBe("ab中c");
  expect(rows[1]).toBe("d");
});

test("calculatePosition은 글자 폭과 개행으로 위치를 계산한다", () => {
  const orig = new Position(0, 0);
  const tty = new Tty(80, 24, 8, new Output());

  expect(tty.calculatePosition("foo", orig)).toEqual(new Position(0, 3));

  expect(tty.calculatePosition("\x1b[1;32mfoo", orig)).toEqual(
    new Position(0, 3),
  );

  expect(tty.calculatePosition("foo\nbar", orig)).toEqual(new Position(1, 3));
});

test("refreshLine은 출력을 커서 숨김·표시로 감싼다", () => {
  const out = new Output();
  const tty = new Tty(80, 24, 8, out);
  const line = new LineBuffer();
  line.update("hello\nworld", 11);

  const oldLayout = new Layout(new Position(0, 0));
  const newLayout = new Layout(new Position(0, 0));
  newLayout.cursor = new Position(1, 5);
  newLayout.end = new Position(1, 5);

  tty.refreshLine("> ", line, oldLayout, newLayout, new IdentityHighlighter());

  const emitted = out.output.join("");
  expect(emitted.startsWith("\x1b[?25l")).toBe(true);
  expect(emitted.endsWith("\x1b[?25h")).toBe(true);
});

test.each([
  ["커서 숨김(사설 접두 ?)", "\x1b[?25l"],
  ["커서 표시(사설 접두 ?)", "\x1b[?25h"],
  ["기기 속성 요청(사설 접두 >)", "\x1b[>1c"],
  ["기기 속성 요청(사설 접두 =)", "\x1b[=0c"],
  ["사설 접두 <", "\x1b[<0m"],
  ["커서 이동(파라미터 두 개)", "\x1b[1;2H"],
  ["커서 모양(중간 바이트 공백)", "\x1b[2 q"],
  ["소프트 리셋(사설 접두 없이 중간 바이트 !)", "\x1b[!p"],
  ["콜론 파라미터 SGR", "\x1b[38:5:196m"],
])("CSI 시퀀스는 폭 0이다: %s", (_이름, 시퀀스) => {
  const tty = new Tty(80, 24, 8, new Output());
  expect(tty.calculatePosition(시퀀스, new Position(0, 0))).toEqual(
    new Position(0, 0),
  );
});

test("사설 접두 CSI 뒤 글자는 폭을 센다(`\\x1b[?25l50%`는 3칸)", () => {
  const tty = new Tty(80, 24, 8, new Output());
  expect(tty.calculatePosition("\x1b[?25l50%", new Position(0, 0))).toEqual(
    new Position(0, 3),
  );
  expect(
    tty.calculatePosition("a\x1b[>1cb\x1b[?25hc", new Position(0, 0)),
  ).toEqual(new Position(0, 3));
});

test("SGR 뒤 글자 폭 계산은 그대로다", () => {
  const tty = new Tty(80, 24, 8, new Output());
  expect(
    tty.calculatePosition("\x1b[1;32mfoo\x1b[0m", new Position(0, 0)),
  ).toEqual(new Position(0, 3));
});

test("splitIntoVisualRows는 사설 접두 CSI를 폭 0으로 보고 행을 나눈다", () => {
  const tty = new Tty(5, 24, 8, new Output());
  // `25l`이 글자로 세어지면 5칸 행이 `\x1b[?25l` + `abc`에서 이미 넘친다.
  expect(tty.splitIntoVisualRows("\x1b[?25labcde")).toEqual([
    "\x1b[?25labcde",
    "",
  ]);
});
