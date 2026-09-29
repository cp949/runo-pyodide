/**
 * 사용자에게 보이는 렌더링 시험.
 * - 사용자처럼 `State`를 구동한다(입력, 키, history 불러오기).
 * - 가상 터미널에 보이는 화면과 커서를 확인한다. 깨지기 쉬운 바이트 단위 단언을 대신한다.
 * - 원본 시험이 다루지 않은 동작을 포함한다: 긴 입력을 불러올 때 터미널 스크롤, 편집 모드 잠금,
 *   오른쪽 끝 줄바꿈, 행을 넘는 SGR, onResize 앵커 보정.
 */
import { expect, test } from "vitest";
import { State } from "../src/state";
import { Tty } from "../src/tty";
import { History } from "../src/history";
import { Highlighter, IdentityHighlighter } from "../src/highlight";
import { VTerm } from "../src/vterm";

/**
 * 가상 터미널(`VTerm`)에 연결한 `State`를 만들고 첫 화면을 그린다.
 * `opts.anchor`는 프롬프트를 시작할 물리 행, `opts.history`는 미리 넣을 history 항목이다.
 */
function setup(
  cols: number,
  rows: number,
  opts: {
    prompt?: string;
    anchor?: number;
    highlighter?: Highlighter;
    history?: string[];
  } = {},
) {
  const vt = new VTerm(cols, rows);
  // State를 만들기 전에 가상 커서를 앵커 행으로 옮긴다.
  // 첫 refresh가 알려진 물리 행에서 시작한다. 실제 Readline.read()와 같다.
  if (opts.anchor && opts.anchor > 0) {
    vt.write("\n".repeat(opts.anchor));
  }
  const tty = new Tty(cols, rows, 8, vt, opts.anchor ?? 0);
  const history = new History(50);
  for (const e of opts.history ?? []) history.append(e);
  const state = new State(
    opts.prompt ?? "> ",
    tty,
    opts.highlighter ?? new IdentityHighlighter(),
    history,
  );
  state.refresh();
  return { vt, tty, state };
}

test("한 줄 입력은 프롬프트와 글자를 그린다", () => {
  const { vt, state } = setup(20, 5);
  state.editInsert("abc");
  expect(vt.screen()).toBe("> abc");
  expect(vt.cursor()).toEqual([0, 5]);
});

test("여러 줄 삽입은 모든 행을 그리고 커서를 끝에 둔다", () => {
  const { vt, state } = setup(20, 5);
  state.editInsert("a\nb\nc");
  expect(vt.screen()).toBe("> a\nb\nc");
  expect(vt.cursor()).toEqual([2, 1]);
});

test("버퍼가 뷰포트보다 크면 창이 커서를 따라 스크롤한다", () => {
  const { vt, state } = setup(20, 3);
  // 시각 행은 5개("> a", "b", "c", "d", "e")이고 뷰포트는 3행이다.
  // 창은 마지막 3행을 보여 주고 커서는 맨 아래에 놓인다.
  state.editInsert("a\nb\nc\nd\ne");
  expect(vt.screen()).toBe("c\nd\ne");
  expect(vt.cursor()).toEqual([2, 1]);
});

test("ArrowUp이 창 위를 넘으면 창이 위로 스크롤한다", () => {
  const { vt, state } = setup(20, 3);
  state.editInsert("a\nb\nc\nd\ne"); // window: c,d,e
  state.moveCursorBack(1); // 편집 모드 진입(Up이 버퍼 안에서 움직인다)
  state.moveCursorUp(1); // 3행("d"), 창 안
  state.moveCursorUp(1); // 2행("c"), 창 맨 위
  state.moveCursorUp(1); // 1행("b"), 창 밖 → 스크롤
  expect(vt.screen()).toBe("b\nc\nd");
});

test("앵커 행에 다 들어가지 않는 버퍼를 불러오면 터미널이 위로 스크롤한다", () => {
  // 앵커는 4행(5행 터미널의 마지막 행)이고 5행짜리 명령을 불러온다.
  // bash처럼 터미널이 스크롤해 불러온 입력의 끝이 뷰포트 맨 아래에 놓인다.
  // 프롬프트가 위로 밀려나가도 그렇다.
  const { vt, state } = setup(40, 5, {
    anchor: 4,
    history: ["a\nb\nc\nd\ne"],
  });
  state.moveCursorUp(1); // 불러오기. editing이 처음엔 false라 history 탐색이다.
  expect(vt.screen()).toBe("> a\nb\nc\nd\ne");
  expect(vt.cursor()).toEqual([4, 1]);
});

test("터미널 전체보다 큰 버퍼를 불러오면 끝을 뷰포트 맨 아래에 고정한다", () => {
  const { vt, state } = setup(40, 3, { anchor: 2, history: ["a\nb\nc\nd\ne"] });
  state.moveCursorUp(1);
  // 버퍼는 5행이고 아래 3행만 보인다. 앞 행은 스크롤백으로 밀려난다.
  expect(vt.screen()).toBe("c\nd\ne");
  expect(vt.cursor()).toEqual([2, 1]);
});

test("불러온 직후 ArrowUp은 history를 탐색한다(버퍼 안 이동 아님)", () => {
  const { vt, state } = setup(40, 8, { history: ["older", "newer\nline2"] });
  state.moveCursorUp(1); // 가장 최근 항목을 불러온다: "newer\nline2"
  expect(state.buffer()).toBe("newer\nline2");
  state.moveCursorUp(1); // 바로 한 번 더. 더 오래된 항목으로 간다.
  expect(state.buffer()).toBe("older");
  expect(vt.screen()).toBe("> older");
});

test("불러온 뒤 ArrowLeft는 편집 모드로 들어가고 이후 ArrowUp은 버퍼 안에서 움직인다", () => {
  const { vt, state } = setup(40, 8, {
    history: ["older", "(define\n  body)"],
  });
  state.moveCursorUp(1); // "(define\n  body)"를 불러온다.
  state.moveCursorBack(1); // 편집 모드 진입
  state.moveCursorUp(1); // 이제 history가 아니라 버퍼 안에서 움직인다.
  expect(state.buffer()).toBe("(define\n  body)"); // 버퍼는 바뀌지 않는다.
  expect(vt.cursor()[0]).toBe(0); // 커서는 첫 시각 행으로 갔다.
});

test("편집 모드에서 버퍼 맨 위의 ArrowUp은 무동작이다(history로 넘어가지 않는다)", () => {
  const { state } = setup(40, 8, { history: ["older", "current\nline2"] });
  state.moveCursorUp(1); // "current\nline2"를 불러온다.
  state.moveCursorBack(1); // 편집 모드
  state.moveCursorUp(1); // 0행으로 올라간다.
  state.moveCursorUp(1); // 이미 맨 위다. "older"로 바뀌면 안 된다.
  expect(state.buffer()).toBe("current\nline2");
});

test("Ctrl-U식 update는 편집 모드를 풀어 Up이 다시 history를 탐색한다", () => {
  const { state } = setup(40, 8, { history: ["older", "current"] });
  state.moveCursorUp(1); // "current"를 불러온다.
  state.moveCursorBack(1); // 편집 모드
  state.update(""); // Ctrl-U
  state.moveCursorUp(1); // editing이 초기화돼 다음 이전 항목으로 간다.
  expect(state.buffer()).toBe("older");
});

test("오른쪽 끝에서 정확히 줄바꿈되는 버퍼는 커서를 다음 행에 둔다", () => {
  // 20열이다. "> " + 18글자가 0행을 정확히 채운다.
  // 커서는 0행 20열(pending-wrap)이 아니라 1행 0열에 놓여야 한다.
  const { vt, state } = setup(20, 5);
  state.editInsert("a".repeat(18));
  expect(vt.cursor()).toEqual([1, 0]);
  // 화면: 0행은 '> aaaa…' 20글자로 가득 차고 1행은 비어 있다.
  expect(vt.screen().split("\n")[0]).toBe("> " + "a".repeat(18));
});

test("하이라이터 SGR이 줄바꿈된 시각 행을 넘어도 글자가 보존된다", () => {
  // 하이라이터가 버퍼 전체를 빨강으로 감싼다.
  // VTerm이 SGR을 버리므로 스타일은 확인하지 않는다.
  // 대신 줄바꿈 뒤에도 보이는 글자가 모두 보존되는지 본다.
  // splitIntoVisualRows의 SGR 추적이 틀리면 여기서 깨진다.
  const hl: Highlighter = {
    highlight: (line) => `\x1b[31m${line}\x1b[0m`,
    highlightPrompt: (p) => p,
    highlightChar: () => false,
  };
  const { vt, state } = setup(10, 4, { highlighter: hl });
  state.editInsert("abcdefghijklmno"); // 15글자, 10열 터미널에서 줄바꿈된다.
  // "> " + "abcdefgh"가 10글자이고 "ijklmno"는 다음 행에 온다.
  const lines = vt.screen().split("\n");
  expect(lines[0]).toBe("> abcdefgh");
  expect(lines[1]).toBe("ijklmno");
});

test("큰 버퍼에서 moveCursorToEnd는 확정 전에 끝까지 스크롤한다", () => {
  // Enter 뒤 Readline은 state.moveCursorToEnd()를 부르고 \r\n을 쓴다.
  // 커서가 버퍼 끝(보이는 마지막 행)에 놓이는지 본다.
  const { vt, state } = setup(20, 3);
  state.editInsert("a\nb\nc\nd\ne");
  state.moveCursorBack(1); // 편집 모드
  state.moveCursorUp(1);
  state.moveCursorUp(1); // 버퍼 중간 어딘가
  state.moveCursorToEnd();
  expect(vt.cursor()).toEqual([2, 1]); // 뷰포트 맨 아래, "e"의 끝
});

test("editBackspace는 앞 글자를 지우고 화면을 다시 맞춘다", () => {
  const { vt, state } = setup(20, 5);
  state.editInsert("hello");
  state.editBackspace(1);
  expect(state.buffer()).toBe("hell");
  expect(vt.screen()).toBe("> hell");
  expect(vt.cursor()).toEqual([0, 6]);
});

test("editDelete는 커서 위치 글자를 지우고 커서는 움직이지 않는다", () => {
  const { vt, state } = setup(20, 5);
  state.editInsert("hello");
  state.moveCursorBack(2); // 두 'l' 사이에 커서를 둔다.
  state.editDelete(1); // 두 번째 'l'을 지운다.
  expect(state.buffer()).toBe("helo");
  expect(vt.screen()).toBe("> helo");
});

test("editDeleteEndOfLine은 커서부터 논리 줄 끝까지 지운다", () => {
  const { vt, state } = setup(20, 5);
  state.editInsert("foo bar\nbaz");
  state.moveCursorHome();
  state.moveCursorUp(1); // Home 뒤 editing이 true라 버퍼 안에서 움직인다.
  // 커서는 0행이다. 처음으로 간 뒤 4글자 앞으로 가서 "bar" 앞에 놓는다.
  state.moveCursorHome();
  for (let i = 0; i < 4; i++) state.moveCursorForward(1);
  state.editDeleteEndOfLine();
  expect(state.buffer()).toBe("foo \nbaz");
  expect(vt.screen()).toBe("> foo\nbaz");
});

test("editInsert 빠른 경로도 화면 결과는 같다", () => {
  // 현재 행에 들어가고 SGR 추적이 필요 없는 한 글자 삽입은 전체 refresh를 건너뛰고 그 글자만 쓴다.
  // 바이트는 보지 않는다. 넓은 터미널에 입력해 보이는 화면 결과만 확인한다.
  const { vt, state } = setup(40, 3);
  state.editInsert("a");
  state.editInsert("b");
  state.editInsert("c");
  expect(vt.screen()).toBe("> abc");
  expect(vt.cursor()).toEqual([0, 5]);
});

test("위쪽 화살표가 창 가장자리를 넘으면 moveCursor가 전체 refresh로 되돌아간다", () => {
  // 뷰포트 4행, 버퍼 5행이라 scrollOffset은 1이고 창은 1~4행을 보여 준다.
  // 위쪽 화살표 세 번은 창 안에 머문다(증분 ANSI).
  // 네 번째가 위쪽 가장자리를 넘으며 0~3행을 다시 그리는 전체 refresh가 일어나야 한다.
  const { vt, state } = setup(20, 4);
  state.editInsert("a\nb\nc\nd\ne");
  state.moveCursorBack(1); // 편집 모드
  state.moveCursorUp(1); // 3행
  state.moveCursorUp(1); // 2행
  state.moveCursorUp(1); // 1행(창 맨 위)
  expect(vt.screen()).toBe("b\nc\nd\ne");
  state.moveCursorUp(1); // 0행. 창 밖이라 refresh
  expect(vt.screen()).toBe("> a\nb\nc\nd");
});

test("터미널이 줄면 onResize식 앵커 보정이 커서를 유효한 행에 둔다", () => {
  const { vt, tty, state } = setup(40, 10, { anchor: 8 });
  state.editInsert("hi");
  // Readline.activate()의 resize 핸들러를 흉내낸다.
  // xterm이 물리 커서를 새 경계 안으로 보정하면, Tty 크기를 갱신하고 anchorRow를 다시 보정한다.
  vt.resize(40, 4);
  tty.col = 40;
  tty.row = 4;
  if (tty.anchorRow >= tty.row) tty.anchorRow = Math.max(0, tty.row - 1);
  state.refresh();
  // 커서는 8행이 아니라 새 뷰포트 안에 있어야 한다.
  const [r] = vt.cursor();
  expect(r).toBeLessThan(4);
  expect(state.buffer()).toBe("hi");
});
