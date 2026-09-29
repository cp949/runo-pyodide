/**
 * 출력 꼬리 추적(`createOutputTail`, `leavesVisibleText`) 시험(`04-stdin-input.md` 3.3, `05-output.md` 4.1).
 * - 꼬리: 마지막 `\n` 뒤이면서 그 안의 마지막 `\r` 뒤 텍스트.
 * - 줄 경계를 넘어 열린 SGR 이어받기.
 * - 제어 문자 정규화(BS 적용, BEL·나머지 C0 제거)와 문자열 시퀀스(OSC·DCS) 예외.
 * - 터미널·pyodide·worker 없이 도는 jsdom 기본 환경 시험이다.
 */
import { describe, expect, test } from "vitest";
import {
  createOutputTail,
  leavesVisibleText,
  MAX_ACTIVE_SGR,
} from "../../src/terminal/output-tail";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** 새 추적기에 조각을 순서대로 먹이고 꼬리를 돌려준다. */
function tail(...chunks: string[]): string {
  const tracker = createOutputTail();
  for (const chunk of chunks) tracker.feed(chunk);
  return tracker.value();
}

describe("출력 꼬리 추적", () => {
  test("아무것도 내지 않았으면 꼬리가 비어 있다", () => {
    expect(tail()).toBe("");
  });

  test("개행 없는 조각을 이어 붙인다", () => {
    expect(tail("x: ")).toBe("x: ");
    expect(tail("x", ": ")).toBe("x: ");
  });

  test("개행이 들어오면 마지막 개행 뒤 텍스트만 꼬리다", () => {
    expect(tail("a\nb")).toBe("b");
    expect(tail("a\nb\nc")).toBe("c");
  });

  test("개행으로 끝나면 꼬리가 비어 있다", () => {
    expect(tail("a\n")).toBe("");
    expect(tail("a", "\n")).toBe("");
  });

  test("`\\r\\n`은 개행으로 본다", () => {
    expect(tail("a\r\n")).toBe("");
    expect(tail("a\r\nb")).toBe("b");
  });

  test("개행 뒤에 조각으로 나뉘어 온 텍스트도 이어 붙는다", () => {
    expect(tail("a", "\n", "b", "c")).toBe("bc");
  });

  test("마지막 `\\r` 뒤 텍스트만 꼬리다(진행률 갱신)", () => {
    expect(tail("abc\rX")).toBe("X");
    expect(tail("10%\r20%\r30%")).toBe("30%");
  });

  test("`\\r`로 끝나면 꼬리가 비어 있다", () => {
    expect(tail("Loading\r")).toBe("");
  });

  test("열린 SGR은 줄 경계를 넘어 꼬리 앞에 이어진다", () => {
    expect(tail(`${GREEN}A\nB`)).toBe(`${GREEN}B`);
    expect(tail(`${GREEN}A`, "\n", "B")).toBe(`${GREEN}B`);
  });

  test("`\\r` 경계에서도 열린 SGR을 이어받는다", () => {
    expect(tail(`${GREEN}A\rB`)).toBe(`${GREEN}B`);
  });

  test("닫힌 SGR은 이어받지 않는다", () => {
    expect(tail(`${GREEN}A${RESET}\nB`)).toBe("B");
  });

  test("파라미터가 없는 `\\x1b[m`도 초기화다", () => {
    expect(tail(`${GREEN}A\x1b[m\nB`)).toBe("B");
  });

  test("초기화 뒤에 다시 연 SGR만 이어받는다", () => {
    expect(tail(`${RED}A${RESET}${GREEN}B\nC`)).toBe(`${GREEN}C`);
  });

  test("0으로 시작하는 SGR은 초기화 뒤 나머지를 켜는 것으로 본다", () => {
    expect(tail(`${GREEN}A\x1b[0;31mB\nC`)).toBe("\x1b[0;31mC");
  });

  test("꼬리 안의 SGR은 그대로 남는다", () => {
    expect(tail("x\x1b[1my")).toBe("x\x1b[1my");
    expect(tail(`${RED}err${RESET}`)).toBe(`${RED}err${RESET}`);
  });

  test("SGR 외 제어 시퀀스는 걸러내지 않고 통과시키며 SGR 상태를 바꾸지 않는다", () => {
    expect(tail("a\x1b[2Kb")).toBe("a\x1b[2Kb");
    expect(tail("a\x1b[?25lb")).toBe("a\x1b[?25lb");
    expect(tail(`${GREEN}A\x1b[2K\nB`)).toBe(`${GREEN}B`);
  });

  test("여러 줄에 걸쳐 색을 씌우면 마지막 줄도 같은 색으로 이어진다", () => {
    expect(tail(`${RED}line1\nline2${RESET}`)).toBe(`${RED}line2${RESET}`);
  });

  test("`reset()`은 꼬리와 SGR 상태를 모두 비운다", () => {
    const tracker = createOutputTail();
    tracker.feed(`${GREEN}A`);

    tracker.reset();

    expect(tracker.value()).toBe("");
  });

  test("`reset()` 뒤에는 이전에 열린 SGR을 이어받지 않는다", () => {
    const tracker = createOutputTail();
    tracker.feed(`${GREEN}A\n`);

    tracker.reset();
    tracker.feed("B");

    expect(tracker.value()).toBe("B");
  });

  test("색을 닫지 않고 계속 바꿔도 이어받는 SGR은 가장 최근 64개까지만 남는다", () => {
    const tracker = createOutputTail();
    for (let i = 0; i < 100; i += 1) tracker.feed(`\x1b[38;5;${i}m`);
    tracker.feed("\n");
    tracker.feed("x");

    const value = tracker.value();

    expect(MAX_ACTIVE_SGR).toBe(64);
    expect(value.endsWith("\x1b[38;5;99mx")).toBe(true);
    expect(value.split("\x1b[").length - 1).toBe(64);
  });

  test("탭과 전각 문자는 그대로 꼬리에 남는다", () => {
    expect(tail("a\tb")).toBe("a\tb");
    expect(tail("이름: ")).toBe("이름: ");
  });
});

describe("제어 문자 정규화(BS 적용, BEL·나머지 C0 제거)", () => {
  test("BS는 본문 마지막 글자를 지운다", () => {
    expect(tail("ab\bc")).toBe("ac");
    expect(tail("|\b/")).toBe("/");
  });

  test("BS가 여러 번이면 그만큼 지운다", () => {
    expect(tail("abc\b\bx")).toBe("ax");
  });

  test("조각으로 나뉘어 온 BS도 앞 조각의 글자를 지운다", () => {
    expect(tail("|", "\b/")).toBe("/");
    expect(tail("ab", "\b", "\b", "c")).toBe("c");
  });

  test("본문이 비어 있으면 BS는 아무것도 지우지 않는다", () => {
    expect(tail("\b")).toBe("");
    expect(tail("a\b\b\bb")).toBe("b");
    expect(tail("x\n\by")).toBe("y");
    expect(tail("x\r\by")).toBe("y");
  });

  test("본문을 다 지운 BS는 줄 시작 SGR을 건드리지 않는다", () => {
    expect(tail(`${GREEN}A\n`, "b\b\bc")).toBe(`${GREEN}c`);
    expect(tail(`${RED}A\r`, "\b\bz")).toBe(`${RED}z`);
  });

  test("BS는 본문 안의 SGR 텍스트가 아니라 보이는 마지막 글자를 지운다", () => {
    expect(tail(`ab${RED}`, "\bc")).toBe(`a${RED}c`);
    expect(tail(`ab${RED}\bc`)).toBe(`a${RED}c`);
  });

  test("BS는 SGR 상태를 되돌리지 않는다", () => {
    expect(tail(`${GREEN}x\b\n`, "y")).toBe(`${GREEN}y`);
  });

  test("BEL을 제거한다", () => {
    expect(tail("a\x07b")).toBe("ab");
    expect(tail("\x07")).toBe("");
    expect(tail("\x07", "abc")).toBe("abc");
  });

  test.each([
    ["NUL", "\x00"],
    ["SOH", "\x01"],
    ["ETX", "\x03"],
    ["ACK", "\x06"],
    ["VT", "\x0b"],
    ["FF", "\x0c"],
    ["SO", "\x0e"],
    ["SUB", "\x1a"],
    ["FS", "\x1c"],
    ["US", "\x1f"],
    ["DEL", "\x7f"],
  ])("나머지 C0 %s를 제거한다", (_이름, 문자) => {
    expect(tail(`a${문자}b`)).toBe("ab");
  });

  test("제거한 제어 문자가 ESC 시퀀스 앞뒤에 있어도 시퀀스는 그대로다", () => {
    expect(tail("\x07\x1b[?25l50%")).toBe("\x1b[?25l50%");
    expect(tail(`${RED}\x00x${RESET}`)).toBe(`${RED}x${RESET}`);
  });

  test("탭·개행·`\\r`·SGR·ESC는 그대로다", () => {
    expect(tail("a\tb")).toBe("a\tb");
    expect(tail("a\nb")).toBe("b");
    expect(tail("a\rb")).toBe("b");
    expect(tail("a\r\nb")).toBe("b");
    expect(tail(`${RED}x${RESET}`)).toBe(`${RED}x${RESET}`);
    expect(tail("a\x1b[2Kb")).toBe("a\x1b[2Kb");
  });
});

// 문자열 시퀀스(OSC·DCS 등)는 BEL·ST가 닫는다.
// 종료자를 C0로 보고 지우면 시퀀스가 열린 채 본문에 남는다.
// 터미널이 뒤따르는 프롬프트·입력까지 삼킨다(RD-026 사후 리뷰).
describe("문자열 시퀀스(OSC·DCS)는 정규화하지 않는다", () => {
  test("OSC의 종료자 BEL을 지우지 않는다", () => {
    expect(tail("\x1b]0;title\x07done")).toBe("\x1b]0;title\x07done");
  });

  test("시퀀스가 닫힌 뒤의 BEL은 다시 제거한다", () => {
    expect(tail("\x1b]0;t\x07a\x07b")).toBe("\x1b]0;t\x07ab");
  });

  test("ST(`ESC \\`)로 닫는 시퀀스도 그대로 남는다", () => {
    expect(tail("\x1b]8;;http://x\x1b\\a\x07b")).toBe(
      "\x1b]8;;http://x\x1b\\ab",
    );
  });

  test("조각으로 나뉘어 와도 종료자가 남는다", () => {
    expect(tail("\x1b]0;ti", "tle\x07x")).toBe("\x1b]0;title\x07x");
  });

  test("시퀀스 안의 BS·다른 C0는 적용·제거하지 않는다", () => {
    expect(tail("\x1b]0;a\bb\x01c\x07d")).toBe("\x1b]0;a\bb\x01c\x07d");
  });

  test("OSC 밖의 SGR·BS 처리는 그대로다", () => {
    expect(tail(`${RED}ab\b`, "\x1b]0;t\x07", "c\bd")).toBe(
      `${RED}a\x1b]0;t\x07d`,
    );
  });

  test("개행·`\\r`는 열린 시퀀스도 끝내고 본문을 비운다(줄 단위 꼬리 규칙)", () => {
    expect(tail("\x1b]0;a\nb\x07c")).toBe("bc");
    expect(tail("\x1b]0;a\rb\x07c")).toBe("bc");
  });

  test("DCS(`ESC P`)·APC(`ESC _`)도 같은 규칙이다", () => {
    expect(tail("\x1bP1;2q\x07x")).toBe("\x1bP1;2q\x07x");
    expect(tail("\x1b_G1\x1b\\\x07y")).toBe("\x1b_G1\x1b\\y");
  });
});

// `\r` 구간이 화면에 무언가를 남기는지 보는 판정이다. 소비자는 terminal `splitAboveRead`다.
// 정규화와 기준이 어긋나면 접두가 빈 문자열이 된다.
// 화면의 글자가 사라진다(RD-026 사후 리뷰).
describe("정규화 뒤 남는 글자 판정(`leavesVisibleText`)", () => {
  test.each([
    ["빈 구간", "", false],
    ["글자", "50%", true],
    ["탭", "\t", true],
    ["SGR만", `${RED}${RESET}`, false],
    ["SGR 뒤 글자", `${RED}x`, true],
    ["BEL만", "\x07", false],
    ["BEL과 다른 C0만", "\x07\x00\x1a\x7f", false],
    ["BEL 뒤 글자", "\x07x", true],
    ["BS만", "\b", false],
    ["글자를 다 지운 BS", "ab\b\b", false],
    ["글자보다 많은 BS", "a\b\b\b", false],
    ["글자를 다 지우지 못한 BS", "ab\b", true],
    ["BS 뒤 글자", "a\bx", true],
    ["SGR이 아닌 CSI는 본문에 남는다", "\x1b[K", true],
    ["OSC는 본문에 남는다", "\x1b]0;t\x07", true],
  ])("%s", (_이름, 구간, 기대) => {
    expect(leavesVisibleText(구간)).toBe(기대);
  });
});
