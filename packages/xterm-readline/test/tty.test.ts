import { expect, test, vi } from "vitest";
import { IdentityHighlighter } from "../src/highlight";
import { LineBuffer } from "../src/line";
import { Layout, Position } from "../src/state";
import { Tty } from "../src/tty";

class Output {
  output: string[] = [];
  write = vi.fn((text: string) => this.output.push(text));
  print = vi.fn((text: string) => this.output.push(text));
  println = vi.fn((text: string) => this.output.push(text));
}

test("splitIntoVisualRows wraps on cols boundary", () => {
  const tty = new Tty(5, 24, 8, new Output());
  expect(tty.splitIntoVisualRows("abcdefgh")).toEqual(["abcde", "fgh"]);
});

test("splitIntoVisualRows pushes a trailing empty row when buffer ends at cols", () => {
  const tty = new Tty(5, 24, 8, new Output());
  // 5 chars exactly fills row 0; mirrors calculatePosition's (row+1, 0)
  // normalization so the renderer's row count matches Layout.end.row.
  expect(tty.splitIntoVisualRows("abcde")).toEqual(["abcde", ""]);
});

test("splitIntoVisualRows splits on \\n", () => {
  const tty = new Tty(80, 24, 8, new Output());
  expect(tty.splitIntoVisualRows("foo\nbar\nbaz")).toEqual([
    "foo",
    "bar",
    "baz",
  ]);
});

test("splitIntoVisualRows re-applies active SGR at the start of wrapped rows", () => {
  const tty = new Tty(5, 24, 8, new Output());
  // "\x1b[31m" colors text red; the wrap point is between 'd' and 'e'.
  // Row 1 must be prefixed with the active SGR so the styling carries
  // across the visual row boundary.
  const rows = tty.splitIntoVisualRows("\x1b[31mabcdef\x1b[0m");
  expect(rows[0]).toBe("\x1b[31mabcde");
  expect(rows[1]).toBe("\x1b[31mf\x1b[0m");
});

test("splitIntoVisualRows resets SGR tracking on \\x1b[0m", () => {
  const tty = new Tty(5, 24, 8, new Output());
  // Style ends mid-row, then we wrap. Row 1 must NOT inherit the SGR.
  const rows = tty.splitIntoVisualRows("\x1b[31mab\x1b[0mcdef");
  expect(rows[0]).toBe("\x1b[31mab\x1b[0mcde");
  expect(rows[1]).toBe("f");
});

test("splitIntoVisualRows expands tab to next tabstop", () => {
  // tabWidth=4. "a\tb" → 'a' col 1, '\t' to col 4 (3 spaces wide), 'b' col 5.
  const tty = new Tty(80, 24, 4, new Output());
  const rows = tty.splitIntoVisualRows("a\tb");
  expect(rows).toEqual(["a\tb"]);
  expect(tty.calculatePosition("a\tb", new Position(0, 0))).toEqual(
    new Position(0, 5),
  );
});

test("splitIntoVisualRows handles double-width characters at the wrap boundary", () => {
  // 5-col terminal, "中" has width 2. "ab中cd" → 'a','b','中' fills cols 1..4
  // (中 occupies cols 3-4); 'c' at col 5 stays on row 0; 'd' wraps. With my
  // wrap rule (col + cw > cols), 'c' at col 4+1=5 fits, 'd' at 5+1=6 wraps.
  const tty = new Tty(5, 24, 8, new Output());
  const rows = tty.splitIntoVisualRows("ab中cd");
  expect(rows[0]).toBe("ab中c");
  expect(rows[1]).toBe("d");
});

test("calculate position", () => {
  const orig = new Position(0, 0);
  const tty = new Tty(80, 24, 8, new Output());

  expect(tty.calculatePosition("foo", orig)).toEqual(new Position(0, 3));

  expect(tty.calculatePosition("\x1b[1;32mfoo", orig)).toEqual(
    new Position(0, 3),
  );

  expect(tty.calculatePosition("foo\nbar", orig)).toEqual(new Position(1, 3));
});

test("refreshLine wraps emit in cursor-hide/show", () => {
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
