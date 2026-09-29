/**
 * `State` 시험. 가짜 `Output`에 쓰인 조각으로 편집·렌더링 결과를 확인한다.
 * - 삽입·삭제·커서 이동이 버퍼와 출력에 반영된다.
 * - 열 폭을 넘기면 창(window) 렌더러가 전체를 다시 그린다.
 * - 버퍼가 뷰포트보다 크면 커서 행을 따라 창을 스크롤한다.
 * - `refreshUnhighlighted`는 하이라이터의 SGR을 빼고 그린 뒤 하이라이터를 복원한다.
 */
import { expect, test, vi } from "vitest";
import { IdentityHighlighter } from "../src/highlight";
import { History } from "../src/history";
import { State } from "../src/state";
import { Tty } from "../src/tty";

const PROMPT = "> ";

/** `Tty`가 쓰는 `Output`의 가짜. 출력 조각을 `output`에 모으고 호출을 `vi.fn`으로 기록한다. */
class Output {
  output: string[] = [];
  write = vi.fn((text: string) => this.output.push(text));
  print = vi.fn((text: string) => this.output.push(text));
  println = vi.fn((text: string) => this.output.push(text));
}

test("editInsert를 이어 넣으면 글자마다 그대로 쓴다", () => {
  const out = new Output();
  const tty = new Tty(80, 24, 8, out);
  const state = new State(
    PROMPT,
    tty,
    new IdentityHighlighter(),
    new History(50),
  );
  state.editInsert("a");
  state.editInsert("b");
  state.editInsert("c");
  expect(state.buffer()).toBe("abc");
  expect(out.write).toHaveBeenNthCalledWith(1, "a");
  expect(out.write).toHaveBeenNthCalledWith(2, "b");
  expect(out.write).toHaveBeenNthCalledWith(3, "c");
});

test("커서 중간에 editInsert하면 그 자리에 들어간다", () => {
  const out = new Output();
  const tty = new Tty(80, 24, 8, out);
  const state = new State(
    PROMPT,
    tty,
    new IdentityHighlighter(),
    new History(50),
  );
  state.editInsert("a");
  state.editInsert("b");
  state.editInsert("c");
  state.moveCursorBack(1);
  state.editInsert("d");
  expect(state.buffer()).toBe("abdc");
});

test("열 폭을 넘는 editInsert는 창 렌더러로 전체를 다시 그린다", () => {
  const out = new Output();
  const tty = new Tty(5, 24, 8, out);
  const state = new State(
    PROMPT,
    tty,
    new IdentityHighlighter(),
    new History(50),
  );
  state.editInsert("a");
  state.editInsert("b");
  state.editInsert("c");
  state.editInsert("d");
  expect(state.buffer()).toBe("abcd");
  expect(out.write).toHaveBeenNthCalledWith(1, "a");
  expect(out.write).toHaveBeenNthCalledWith(2, "b");
  expect(out.write).toHaveBeenNthCalledWith(3, "c");
  expect(out.write).toHaveBeenNthCalledWith(4, "d");

  out.write.mockClear();
  state.editInsert("e");
  expect(state.buffer()).toBe("abcde");
  // 창 렌더러의 출력 순서:
  // 1. 갱신 동안 커서를 숨긴다.
  // 2. 앵커부터 아래를 \x1b[J로 지운다.
  // 3. 시각 행을 \r\n으로 나눠 쓰고 행마다 끝에 SGR 리셋을 붙인다.
  // 4. 커서를 뷰포트 안의 새 (행, 열)로 옮긴다.
  // 5. 커서를 다시 보인다.
  expect(out.write).toHaveBeenNthCalledWith(1, "\x1B[?25l");
  expect(out.write).toHaveBeenNthCalledWith(2, "\r\x1B[J");
  expect(out.write).toHaveBeenNthCalledWith(3, "> abc");
  expect(out.write).toHaveBeenNthCalledWith(4, "\x1B[0m");
  expect(out.write).toHaveBeenNthCalledWith(5, "\r\n");
  expect(out.write).toHaveBeenNthCalledWith(6, "de");
  expect(out.write).toHaveBeenNthCalledWith(7, "\x1B[0m");
  expect(out.write).toHaveBeenNthCalledWith(8, "\r\x1B[2C");
  expect(out.write).toHaveBeenNthCalledWith(9, "\x1B[?25h");
});

test("여러 줄에서 커서를 되돌려 삽입·삭제해도 버퍼가 유지된다", () => {
  const out = new Output();
  const tty = new Tty(5, 24, 8, out);
  const state = new State(
    PROMPT,
    tty,
    new IdentityHighlighter(),
    new History(50),
  );
  state.editInsert("a");
  state.editInsert("\n");
  state.editInsert("b");
  state.editInsert("\n");
  state.editInsert("c");
  state.moveCursorBack(1);
  state.moveCursorBack(1);
  state.editInsert("d");
  state.editBackspace(1);
  expect(state.buffer()).toBe("a\nb\nc");
});

test("버퍼가 뷰포트보다 크면 창이 커서까지 스크롤한다", () => {
  const out = new Output();
  // 80열 3행. 시각 행이 3개를 넘으면 창으로 잘라 그린다.
  const tty = new Tty(80, 3, 8, out);
  const state = new State(
    PROMPT,
    tty,
    new IdentityHighlighter(),
    new History(50),
  );
  // 논리 5줄을 넣는다(프롬프트 포함 시각 5행).
  state.editInsert("a\nb\nc\nd\ne");
  expect(state.buffer()).toBe("a\nb\nc\nd\ne");

  // 여러 줄 삽입 뒤 커서는 끝(가상 좌표로 4행 1열)에 있다.
  // 뷰포트가 3행이라 scrollOffset은 2다. 2·3·4행("c", "d", "e")만 출력한다.
  const writes = out.write.mock.calls.map((c) => c[0]);
  // 아래 세 행을 출력한다.
  expect(writes).toContain("c");
  expect(writes).toContain("d");
  expect(writes).toContain("e");
  // 창 밖으로 스크롤된 행은 출력하지 않는다.
  expect(writes).not.toContain("> a");
  expect(writes).not.toContain("b");
});

test("moveCursorUp이 창 위를 넘으면 다시 그리며 스크롤한다", () => {
  const out = new Output();
  const tty = new Tty(80, 3, 8, out);
  const state = new State(
    PROMPT,
    tty,
    new IdentityHighlighter(),
    new History(50),
  );
  state.editInsert("a\nb\nc\nd\ne");
  // 뷰포트는 2·3·4행("c", "d", "e")을 보여 주고 커서는 4행에 있다.
  out.write.mockClear();
  // 세 번 올린다. 세 번째에 뷰포트를 벗어나 다시 그리며 스크롤한다.
  state.moveCursorUp(1); // 3행, 창 안
  state.moveCursorUp(1); // 2행, 창 안
  state.moveCursorUp(1); // 1행, 창 밖 → 다시 그리고 스크롤
  const writes = out.write.mock.calls.map((c) => c[0]);
  // adjustScroll이 커서를 창 맨 위에 놓아 scrollOffset이 1이 된다.
  // 창은 1·2·3행("b", "c", "d")을 보여 주고 "e"는 빠진다.
  expect(writes).toContain("b");
  expect(writes).toContain("c");
  expect(writes).toContain("d");
  expect(writes).not.toContain("e");
});

test("짧은 버퍼는 단일 뷰포트 동작이 그대로다", () => {
  const out = new Output();
  const tty = new Tty(80, 24, 8, out);
  const state = new State(
    PROMPT,
    tty,
    new IdentityHighlighter(),
    new History(50),
  );
  // 버퍼가 24행 안에 충분히 들어가 스크롤이 필요 없다.
  state.editInsert("a\nb\nc");
  // scrollOffset은 0으로 유지된다.
  expect(out.write).toHaveBeenCalled();
  // 커서는 가상 2행 1열이고 viewportRows가 24라 창이 전체를 덮는다.
  // 갱신은 커서 숨김·표시로 감싼다. 안쪽 시퀀스는 \r\x1b[J로 시작한다.
  // 이미 앵커에 있어서 \x1b[A로 올라갈 필요가 없다.
  const calls = out.write.mock.calls.map((c) => c[0]);
  expect(calls[0]).toBe("\x1b[?25l");
  expect(calls[1]).toBe("\r\x1b[J");
});

test("방향키 이동 뒤 삽입이 커서 위치에 반영된다", () => {
  const out = new Output();
  const tty = new Tty(5, 24, 8, out);
  const state = new State(
    PROMPT,
    tty,
    new IdentityHighlighter(),
    new History(50),
  );
  state.editInsert("abc\ndef\nghi");
  state.moveCursorBack(1);
  state.moveCursorUp(1);
  state.editInsert("z");
  expect(state.buffer()).toEqual("abc\ndezf\nghi");
  state.moveCursorForward(1);
  state.moveCursorDown(1);
  state.editInsert("y");
  expect(state.buffer()).toEqual("abc\ndezf\nghiy");
});

/** '('를 SGR로 감싸는 하이라이터. 시험이 하이라이트 여부를 출력에서 알아본다. */
class BracketHighlighter {
  highlight(line: string, _pos: number): string {
    // 모든 '('를 가짜 SGR로 감싸 하이라이트를 알아볼 수 있게 한다.
    return line.replace(/\(/g, "\x1b[1;33m(\x1b[0m");
  }
  highlightPrompt(prompt: string): string {
    return prompt;
  }
  highlightChar(_line: string, _pos: number): boolean {
    return false;
  }
}

test("refreshUnhighlighted는 하이라이터 SGR을 벗긴다", () => {
  const out = new Output();
  const tty = new Tty(80, 24, 8, out);
  const state = new State(
    PROMPT,
    tty,
    new BracketHighlighter(),
    new History(50),
  );
  state.editInsert("(foo)");

  // 대조: 일반 refresh는 하이라이트된 형태를 출력한다.
  out.output.length = 0;
  state.refresh();
  expect(out.output.join("")).toContain("\x1b[1;33m(\x1b[0m");

  // refreshUnhighlighted는 SGR 없는 버퍼를 쓴다.
  out.output.length = 0;
  state.refreshUnhighlighted();
  const written = out.output.join("");
  expect(written).toContain("(foo)");
  expect(written).not.toContain("\x1b[1;33m");

  // 하이라이트 없는 갱신 뒤 하이라이터가 복원된다.
  out.output.length = 0;
  state.refresh();
  expect(out.output.join("")).toContain("\x1b[1;33m(\x1b[0m");
});
