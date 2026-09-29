/**
 * sink 4종(`createTerminalSinks`)의 개행·색·꼬리 계약 시험(05-output.md 4.1, TRAP-29).
 * - 실제 `Readline`을 가짜 터미널에 붙이고 터미널로 나간 바이트를 그대로 비교한다.
 * - 벤더 `write`가 `\n`을 `\r\n`으로 정규화한다. 가짜 `Readline`이면 이중 개행을 놓친다.
 * - pyodide·worker는 쓰지 않는다.
 *   실제 `PyodideConsole`과의 바이트 비교는 `pyodide-repl/test/terminal/sinks-pyodide.test.ts`가 맡는다.
 * - 열린 읽기 중 출력(RD-022b, 05-output.md 4.4)은 결과 화면을 `VtScreen`으로 해석해 단정한다.
 *   대상: 입력줄 위 행, 접두, 다시 그린 입력줄.
 */
import { Readline } from "@cp949/runo-xterm-readline";
import { describe, expect, test, vi } from "vitest";
import { createFakeTerminal } from "@repo/pyodide-testkit/fake-terminal";
import { VtScreen, attachVtScreen } from "@repo/pyodide-testkit/vt-screen";
import { createTerminalSinks, splitAboveRead } from "../src/sinks";

/**
 * 실제 `Readline`을 붙인 가짜 터미널과 sink 세트를 만든다.
 * `bytes()`는 터미널로 나간 바이트 전부를 돌려준다.
 */
function setup() {
  const fake = createFakeTerminal();
  const readline = new Readline({ persist: false });
  fake.term.loadAddon(readline);
  const sinks = createTerminalSinks(readline);
  const bytes = () => fake.written.join("");
  return { fake, sinks, bytes };
}

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

describe("sink 4종의 개행·색 계약", () => {
  test("`writeOutput`은 텍스트 뒤에 `\\r\\n`을 한 번 붙인다", () => {
    const { sinks, bytes } = setup();

    sinks.writeOutput("2");

    expect(bytes()).toBe("2\r\n");
  });

  test("`writeOutput`에 든 `\\n`은 `\\r\\n`이 된다(배너 두 줄)", () => {
    const { sinks, bytes } = setup();

    sinks.writeOutput("a\nb");

    expect(bytes()).toBe("a\r\nb\r\n");
  });

  test("`writeError`는 줄 전체를 빨강으로 한 번 감싸고 `\\r\\n`을 붙인다", () => {
    const { sinks, bytes } = setup();

    sinks.writeError("Traceback\nZeroDivisionError");

    expect(bytes()).toBe("\x1b[31mTraceback\r\nZeroDivisionError\x1b[0m\r\n");
  });

  test("`write`는 조각 그대로 내고 개행을 붙이지 않는다", () => {
    const { sinks, bytes } = setup();

    sinks.write("x");
    expect(bytes()).toBe("x");

    sinks.write("\r50%");
    expect(bytes()).toBe("x\r50%");
  });

  test("`write`의 `\\n`은 `\\r\\n`으로 정규화된다", () => {
    const { sinks, bytes } = setup();

    sinks.write("a\nb\n");

    expect(bytes()).toBe("a\r\nb\r\n");
  });

  test("`write`의 빈 조각은 터미널에 아무것도 쓰지 않는다", () => {
    const { fake, sinks } = setup();
    const before = fake.written.length;

    sinks.write("");

    expect(fake.written.length - before).toBe(0);
  });

  test("`writeErrorRaw`는 조각마다 빨강을 열고 닫는다", () => {
    const { sinks, bytes } = setup();

    sinks.writeErrorRaw("err");
    sinks.writeErrorRaw("\n");

    expect(bytes()).toBe("\x1b[31merr\x1b[0m\x1b[31m\r\n\x1b[0m");
  });

  test("`writeErrorRaw`의 빈 조각은 색 이스케이프도 내지 않는다", () => {
    const { fake, sinks } = setup();
    const before = fake.written.length;

    sinks.writeErrorRaw("");

    expect(fake.written.length - before).toBe(0);
  });

  test("`writeErrorRaw`는 `\\r` 진행률 조각을 그대로 낸다", () => {
    const { sinks, bytes } = setup();

    sinks.writeErrorRaw("\rprog 50%");

    expect(bytes()).toBe("\x1b[31m\rprog 50%\x1b[0m");
  });

  test("stdout과 stderr 조각은 호출 순서대로 섞이고 stdout은 빨강이 아니다", () => {
    const { sinks, bytes } = setup();

    sinks.write("out\n");
    sinks.writeErrorRaw("err");
    sinks.writeErrorRaw("\n");
    sinks.write("out2\n");

    expect(bytes()).toBe(
      "out\r\n\x1b[31merr\x1b[0m\x1b[31m\r\n\x1b[0mout2\r\n",
    );
  });
});

describe("꼬리 추적", () => {
  test("개행 없는 `write` 뒤 꼬리는 그 텍스트다", () => {
    const { sinks } = setup();

    sinks.write("t");

    expect(sinks.tail()).toBe("t");
  });

  test("`write`의 마지막 `\\r` 뒤만 꼬리다", () => {
    const { sinks } = setup();

    sinks.write("\r30%");
    sinks.write("\r100%");

    expect(sinks.tail()).toBe("100%");
  });

  test("`writeOutput`은 꼬리를 비운다", () => {
    const { sinks } = setup();
    sinks.write("t");

    sinks.writeOutput("2");

    expect(sinks.tail()).toBe("");
  });

  test("`writeError`는 꼬리를 비운다", () => {
    const { sinks } = setup();
    sinks.write("t");

    sinks.writeError("E");

    expect(sinks.tail()).toBe("");
  });

  test("`writeErrorRaw` 조각은 빨강 감싸기째 꼬리에 남는다", () => {
    const { sinks } = setup();

    sinks.writeErrorRaw("e");

    expect(sinks.tail()).toBe(`${RED}e${RESET}`);
  });

  test("여러 줄 stderr 조각의 마지막 줄은 색을 이어받는다", () => {
    const { sinks } = setup();

    sinks.writeErrorRaw("l1\nl2");

    expect(sinks.tail()).toBe(`${RED}l2${RESET}`);
  });

  test("stdout·stderr 조각이 화면 순서대로 꼬리에 이어진다", () => {
    const { sinks } = setup();

    sinks.write("a");
    sinks.writeErrorRaw("b");

    expect(sinks.tail()).toBe(`a${RED}b${RESET}`);
  });

  test("닫지 않은 색은 줄 경계를 넘어 꼬리 앞에 붙는다", () => {
    const { sinks } = setup();

    sinks.write("\x1b[32mA\nB");

    expect(sinks.tail()).toBe("\x1b[32mB");
  });

  test("`resetTail()`은 꼬리를 비운다", () => {
    const { sinks } = setup();
    sinks.write("t");

    sinks.resetTail();

    expect(sinks.tail()).toBe("");
  });

  test("sink 세트마다 꼬리가 따로다", () => {
    const first = setup();
    first.sinks.write("t");

    const second = setup();

    expect(second.sinks.tail()).toBe("");
    expect(first.sinks.tail()).toBe("t");
  });
});

describe("열린 읽기 위 출력의 완성 행·접두 분리(`splitAboveRead`)", () => {
  test.each([
    {
      name: "개행으로 끝난 조각은 전부 완성 행이다",
      prefix: "",
      text: "tick\n",
      lines: "tick\n",
      next: "",
    },
    {
      name: "개행 없는 조각은 전부 접두다",
      prefix: "",
      text: "tick",
      lines: "",
      next: "tick",
    },
    {
      name: "마지막 개행까지가 완성 행이고 그 뒤가 접두다",
      prefix: "",
      text: "t1\nt2",
      lines: "t1\n",
      next: "t2",
    },
    {
      name: "접두는 마지막 `\\r` 뒤만 남는다",
      prefix: "",
      text: "a\rb",
      lines: "",
      next: "b",
    },
    {
      name: "앞 접두 뒤 `\\r` 진행률은 접두를 제자리에서 바꾼다",
      prefix: "tick",
      text: "\r50%",
      lines: "",
      next: "50%",
    },
    {
      name: "완성 행 안의 `\\r`은 그대로 두고 마지막 행만 `\\r` 규칙을 따른다",
      prefix: "",
      text: "a\nb\rc",
      lines: "a\n",
      next: "c",
    },
    {
      name: "줄 경계를 넘어 열린 SGR을 접두 앞에 이어 붙인다",
      prefix: "",
      text: "\x1b[31mred\nmore",
      lines: "\x1b[31mred\n",
      next: "\x1b[31mmore",
    },
    {
      name: "앞 접두에 열린 SGR도 새 접두로 이어진다",
      prefix: "a\x1b[32m",
      text: "b\nc",
      lines: "a\x1b[32mb\n",
      next: "\x1b[32mc",
    },
    {
      name: "앞 접두는 완성 행 앞에 이어 붙는다",
      prefix: "tick",
      text: " tock\n",
      lines: "tick tock\n",
      next: "",
    },
    {
      name: "빈 조각은 앞 접두를 그대로 둔다",
      prefix: "tick",
      text: "",
      lines: "",
      next: "tick",
    },
    {
      name: "둘 다 비면 둘 다 빈 문자열이다",
      prefix: "",
      text: "",
      lines: "",
      next: "",
    },
    {
      name: "`\\r\\n` 줄끝도 완성 행에 든다",
      prefix: "",
      text: "l1\r\nl2",
      lines: "l1\r\n",
      next: "l2",
    },
  ])("$name", ({ prefix, text, lines, next }) => {
    expect(splitAboveRead(prefix, text)).toEqual({ lines, prefix: next });
  });
});

/**
 * 실제 `Readline`에 활성 읽기(`> ` + 친 글자)를 연 상태를 만든다.
 * - 화면은 `VtScreen`으로 해석하고 커서 모델도 갱신한다. 벤더 재그리기가 앵커 행으로 `cursorY`를 읽는다.
 * - `printAboveRaw`는 호출을 기록하되 실제로 실행한다.
 * - `openRead(typed)`는 `> ` 읽기를 열고 그린 뒤 `typed`(기본 `abc`)를 친다.
 *   읽기 Promise는 객체에 담아 돌려주므로 읽기가 끝나지 않아도 시험이 멈추지 않는다.
 */
function setupReading(options: { cols?: number; asyncWrite?: boolean } = {}) {
  const cols = options.cols ?? 40;
  const fake = createFakeTerminal({
    cols,
    asyncWrite: options.asyncWrite ?? false,
  });
  const vt = new VtScreen(cols, 24);
  attachVtScreen(fake, vt);
  const readline = new Readline({ persist: false });
  fake.term.loadAddon(readline);
  const sinks = createTerminalSinks(readline);
  const printAboveRaw = vi.spyOn(readline, "printAboveRaw");
  const openRead = (typed = "abc") => {
    const line = readline.read("> ");
    fake.flush();
    fake.type(typed);
    fake.flush();
    return { line };
  };
  return { fake, vt, readline, sinks, printAboveRaw, openRead };
}

describe("열린 읽기 중 출력은 입력줄 위에 쓰고 같은 읽기를 다시 그린다(RD-022b)", () => {
  test("개행으로 끝난 `write`는 입력줄 위 행이 되고 프롬프트·입력은 그 아래에 다시 그려진다", () => {
    const { vt, sinks, printAboveRaw, openRead } = setupReading();
    openRead();

    sinks.write("tick\n");

    expect(printAboveRaw).toHaveBeenCalledExactlyOnceWith("tick\n", "");
    expect(vt.screen()).toBe("tick\n> abc");
  });

  test("개행 없는 `write`는 프롬프트 앞 접두가 된다", () => {
    const { vt, readline, sinks, printAboveRaw, openRead } = setupReading();
    openRead();

    sinks.write("tick");

    expect(printAboveRaw).toHaveBeenCalledExactlyOnceWith("", "tick");
    expect(readline.abovePrefix()).toBe("tick");
    expect(vt.screen()).toBe("tick> abc");
  });

  test("접두 뒤 조각은 접두에 이어 쓴 완성 행이 된다", () => {
    const { vt, readline, sinks, printAboveRaw, openRead } = setupReading();
    openRead();
    sinks.write("tick");

    sinks.write(" tock\n");

    expect(printAboveRaw).toHaveBeenLastCalledWith("tick tock\n", "");
    expect(readline.abovePrefix()).toBe("");
    expect(vt.screen()).toBe("tick tock\n> abc");
  });

  test("접두 뒤 `\\r` 진행률은 접두를 제자리에서 바꾼다", () => {
    const { vt, sinks, printAboveRaw, openRead } = setupReading();
    openRead();
    sinks.write("tick");

    sinks.write("\r50%");

    expect(printAboveRaw).toHaveBeenLastCalledWith("", "50%");
    expect(vt.screen()).toBe("50%> abc");
  });

  test("재그리기 콜백 전에 연속으로 온 조각은 순서대로 쌓이고 마지막 접두로 입력줄 하나만 그린다", () => {
    const { fake, vt, sinks, printAboveRaw, openRead } = setupReading({
      asyncWrite: true,
    });
    openRead();

    sinks.write("tick");
    sinks.write(" tock\n");
    sinks.write("t2");
    fake.flush();

    expect(printAboveRaw.mock.calls).toEqual([
      ["", "tick"],
      ["tick tock\n", ""],
      ["", "t2"],
    ]);
    expect(vt.screen()).toBe("tick tock\nt2> abc");
  });

  test("`writeErrorRaw`의 여러 줄 조각은 빨강 감싸기째 나뉘고 마지막 행이 색을 이어받은 접두가 된다", () => {
    const { vt, sinks, printAboveRaw, openRead } = setupReading();
    openRead();

    sinks.writeErrorRaw("e1\ne2");

    expect(printAboveRaw).toHaveBeenCalledExactlyOnceWith(
      `${RED}e1\n`,
      `${RED}e2${RESET}`,
    );
    expect(vt.screen()).toBe("e1\ne2> abc");
  });

  test("`writeOutput`은 접두에 이어 쓴 텍스트에 개행을 붙인 완성 행이 된다", () => {
    const { vt, sinks, printAboveRaw, openRead } = setupReading();
    openRead();
    sinks.write("tick");

    sinks.writeOutput("2");

    expect(printAboveRaw).toHaveBeenLastCalledWith("tick2\n", "");
    expect(vt.screen()).toBe("tick2\n> abc");
  });

  test("`writeError`는 빨강으로 감싼 텍스트에 개행을 붙인 완성 행이 된다", () => {
    const { vt, sinks, printAboveRaw, openRead } = setupReading();
    openRead();

    sinks.writeError("E");

    expect(printAboveRaw).toHaveBeenCalledExactlyOnceWith(
      `${RED}E${RESET}\n`,
      "",
    );
    expect(vt.screen()).toBe("E\n> abc");
  });

  test("빈 조각은 읽기 중에도 아무것도 쓰지 않는다", () => {
    const { fake, sinks, printAboveRaw, openRead } = setupReading();
    openRead();
    const before = fake.written.length;

    sinks.write("");
    sinks.writeErrorRaw("");

    expect(printAboveRaw).not.toHaveBeenCalled();
    expect(fake.written.length - before).toBe(0);
  });

  test("터미널 폭보다 긴 접두는 감긴 프롬프트로 그리고 다음 출력 때 접두 행을 모두 지운다", () => {
    const { vt, sinks, openRead } = setupReading({ cols: 10 });
    openRead();

    sinks.write("x".repeat(25));
    expect(vt.lines()).toEqual(["xxxxxxxxxx", "xxxxxxxxxx", "xxxxx> abc"]);

    sinks.write("\n");
    expect(vt.lines()).toEqual(["xxxxxxxxxx", "xxxxxxxxxx", "xxxxx", "> abc"]);
  });

  test("커서가 줄 중간이면 다시 그린 뒤에도 같은 논리·화면 위치다", () => {
    const { fake, vt, readline, sinks, openRead } = setupReading();
    openRead();
    fake.type("\x1b[D"); // ←

    sinks.write("tick\n");

    expect(readline.getCursor()).toBe(2);
    expect(vt.cursor()).toEqual([1, 4]);
  });
});

/**
 * `\r`로 끝나는 조각(`print(f"{p}%", end="\r")`)은 커서를 행 머리에 둔다.
 * - 꼬리 규칙만 쓰면 접두가 빈 문자열이 되어 조각이 사라진다. 뒤따르는 `\n`도 빈 행만 남긴다.
 * - 그래서 마지막으로 보이는 `\r` 구간을 접두로 보관한다.
 * - 다음 조각은 보관한 원문 뒤 `\r`에 이어 계산한다.
 *   다음 조각이 그 접두를 덮어쓰거나, `\n`이 그 행을 완성한다.
 */
describe("열린 읽기 중 `\\r`로 끝나는 조각(진행률)", () => {
  test.each([
    {
      name: "`\\r`로 끝난 조각은 그 앞 구간을 접두로 보관하고 이어 쓸 원문을 준다",
      prefix: "",
      text: "100%\r",
      lines: "",
      next: "100%",
      resume: "100%\r",
    },
    {
      name: "여러 `\\r` 구간 뒤 `\\r`로 끝나면 마지막으로 보이는 구간이 접두다",
      prefix: "",
      text: "10%\r20%\r",
      lines: "",
      next: "20%",
      resume: "20%\r",
    },
    {
      name: "보관한 원문 뒤 `\\n`은 그 행을 완성 행으로 쓴다",
      prefix: "100%\r",
      text: "\n",
      lines: "100%\r\n",
      next: "",
      resume: undefined,
    },
    {
      name: "보관한 원문 뒤 조각은 행 머리부터 새 접두가 된다",
      prefix: "10%\r",
      text: "20%\r",
      lines: "",
      next: "20%",
      resume: "20%\r",
    },
    {
      name: "`\\r` 뒤 SGR만 남아도 그 앞 구간을 색째 접두로 보관한다",
      prefix: "",
      text: "\x1b[31m100%\r\x1b[0m",
      lines: "",
      next: "\x1b[31m100%",
      resume: "\x1b[31m100%\r\x1b[0m",
    },
    {
      name: "완성 행 뒤 `\\r`로 끝난 마지막 행만 보관한다",
      prefix: "",
      text: "done\n50%\r",
      lines: "done\n",
      next: "50%",
      resume: "50%\r",
    },
    {
      name: "줄 경계를 넘어 열린 SGR은 보관한 접두 앞에도 이어 붙인다",
      prefix: "",
      text: "\x1b[31mred\n50%\r",
      lines: "\x1b[31mred\n",
      next: "\x1b[31m50%",
      resume: "\x1b[31m50%\r",
    },
    {
      name: "`\\r` 뒤에 빈 구간이 이어져도 마지막으로 보이는 구간까지 거슬러 보관한다",
      prefix: "50%\r",
      text: "\r",
      lines: "",
      next: "50%",
      resume: "50%\r\r",
    },
    {
      name: "보이는 구간이 없으면 접두는 비고 원문도 없다",
      prefix: "",
      text: "\r",
      lines: "",
      next: "",
      resume: undefined,
    },
    {
      // 보이는 글자 판정은 꼬리 정규화와 같은 기준이어야 한다.
      // BEL을 글자로 세면 접두가 빈 문자열이 되어 화면의 `50%`가 통째로 사라진다(RD-026 사후 리뷰).
      name: "`\\r` 뒤 BEL만 있으면 정규화로 사라지므로 그 앞 구간을 접두로 보관한다",
      prefix: "",
      text: "50%\r\x07",
      lines: "",
      next: "50%",
      resume: "50%\r\x07",
    },
    {
      name: "`\\r` 뒤 BS만 있어도 같다(정규화 뒤 남는 글자가 없다)",
      prefix: "",
      text: "50%\r\b",
      lines: "",
      next: "50%",
      resume: "50%\r\b",
    },
    {
      name: "BEL뿐인 `\\r` 구간은 건너뛰고 그 앞 구간까지 거슬러 보관한다",
      prefix: "",
      text: "50%\r\x07\r",
      lines: "",
      next: "50%",
      resume: "50%\r\x07\r",
    },
    {
      name: "`\\r` 뒤 BS가 글자를 다 지우지 못하면 남은 글자가 접두다",
      prefix: "",
      text: "50%\rab\b",
      lines: "",
      next: "a",
      resume: undefined,
    },
    {
      name: "`\\r` 뒤 SGR이 아닌 제어 시퀀스는 글자로 보고 꼬리 규칙 그대로다",
      prefix: "",
      text: "100%\r\x1b[K",
      lines: "",
      next: "\x1b[K",
      resume: undefined,
    },
  ])("$name", ({ prefix, text, lines, next, resume }) => {
    expect(splitAboveRead(prefix, text)).toEqual({
      lines,
      prefix: next,
      resume,
    });
  });

  test("기준: 열린 읽기가 없으면 `50%\\r`의 50%가 화면에 보인다", () => {
    const { vt, sinks } = setupReading();
    sinks.write("50%\r");
    expect(vt.screen()).toBe("50%");
  });

  test("열린 읽기 중 `50%\\r`: 50%가 프롬프트 앞 접두로 보인다", () => {
    const { vt, readline, sinks, openRead } = setupReading();
    openRead();

    sinks.write("50%\r");

    expect(readline.abovePrefix()).toBe("50%");
    expect(vt.screen()).toBe("50%> abc");
  });

  test("열린 읽기 중 `100%\\r` 뒤 `\\n`(진행률 끝의 print()): 100% 행이 남는다", () => {
    const { vt, sinks, openRead } = setupReading();
    openRead();

    sinks.write("100%\r");
    sinks.write("\n");

    expect(vt.screen()).toBe("100%\n> abc");
  });

  test("대조: 같은 입력을 읽기 밖에서 쓰면 100% 행이 남는다", () => {
    const { vt, sinks } = setupReading();
    sinks.write("100%\r");
    sinks.write("\n");
    expect(vt.screen()).toBe("100%");
  });

  test("`\\r`로 끝나는 진행률 조각이 이어지면 접두는 마지막 값으로 제자리 갱신되고 끝의 `\\n`이 그 행을 남긴다", () => {
    const { vt, printAboveRaw, sinks, openRead } = setupReading();
    openRead();

    sinks.write("10%\r");
    sinks.write("20%\r");
    expect(vt.screen()).toBe("20%> abc");
    sinks.write("100%\r");
    sinks.write("\n");

    expect(printAboveRaw.mock.calls).toEqual([
      ["", "10%"],
      ["", "20%"],
      ["", "100%"],
      ["100%\r\n", ""],
    ]);
    expect(vt.screen()).toBe("100%\n> abc");
  });

  test("Tab 목록이 접두를 비운 뒤에는 보관한 원문을 잇지 않는다", () => {
    const { vt, readline, printAboveRaw, sinks, openRead } = setupReading();
    openRead();
    sinks.write("50%\r");

    void readline.printAbove("LIST");
    sinks.write("x\n");

    expect(printAboveRaw).toHaveBeenLastCalledWith("x\n", "");
    expect(vt.screen()).toBe("50%> abc\nLIST\nx\n> abc");
  });

  test("보이는 글자가 온 뒤의 `\\r` 진행률은 옛 보관 원문이 아니라 그 글자에 이어 계산한다", () => {
    const { vt, sinks, openRead } = setupReading();
    openRead();

    sinks.write("50%\r");
    sinks.write("x");
    sinks.write("\r50%");
    sinks.write("Y\n");

    expect(vt.screen()).toBe("50%Y\n> abc");
  });

  // 보이지 않는 조각(`\r`·SGR뿐)이 이어져도 보관 원문은 "보이는 구간 + `\r` 하나 + SGR 순효과"로 묶인다.
  // 색 켜기의 순효과는 꼬리 추적기의 열린 SGR 목록이다.
  // 같은 SGR이 반복돼도 `MAX_ACTIVE_SGR`(64)까지만 쌓인다.
  // 닫지 않은 색은 꼬리 규칙대로 `\n` 뒤 새 접두(SGR만)로 이어진다.
  test.each([
    { name: "`\\r`만", color: "", chunk: "\r", lines: "50%\r\n" },
    { name: "SGR 끄기만", color: "", chunk: RESET, lines: `50%\r${RESET}\n` },
    { name: "색 켜기", color: RED, chunk: "\x1b[32m", lines: undefined },
  ])(
    "`50%\\r` 뒤 보이지 않는 조각이 이어져도 보관 원문이 자라지 않는다($name)",
    ({ color, chunk, lines }) => {
      // `50%\r` 뒤 `chunk`를 n번, 이어 `\n`을 쓴다. 마지막 완성 행·접두와 화면을 돌려준다.
      const run = (n: number) => {
        const { vt, printAboveRaw, sinks, openRead } = setupReading();
        openRead();
        sinks.write(`${color}50%\r`);
        for (let i = 0; i < n; i += 1) sinks.write(chunk);
        sinks.write("\n");
        const [last, prefix] = printAboveRaw.mock.calls.at(-1) ?? [];
        return { last, prefix, screen: vt.screen() };
      };

      const many = run(100);
      const more = run(200);

      expect(more).toEqual(many);
      if (lines !== undefined) {
        expect(many.last).toBe(lines);
        expect(many.prefix).toBe("");
      }
      expect(many.screen).toBe("50%\n> abc");
    },
  );
});

describe("열린 읽기 중 출력과 꼬리 추적(RD-022b)", () => {
  test("읽기 중 출력은 꼬리 추적기에 먹이지 않는다", () => {
    const { sinks, openRead } = setupReading();
    sinks.write("t");
    openRead();

    sinks.write("x\n");
    sinks.write("y");
    sinks.writeErrorRaw("e");
    sinks.writeOutput("2");

    expect(sinks.tail()).toBe("t");
  });

  test("접두가 남은 채 Enter로 끝난 뒤 꼬리는 비어 있고 다음 출력은 기존 경로로 꼬리에 들어간다", async () => {
    const { fake, vt, sinks, printAboveRaw, openRead } = setupReading();
    const { line } = openRead();
    sinks.write("tick");

    fake.type("\r");
    await expect(line).resolves.toBe("abc");

    expect(sinks.tail()).toBe("");
    expect(vt.lines()[0]).toBe("tick> abc");
    printAboveRaw.mockClear();
    sinks.write("z");
    expect(printAboveRaw).not.toHaveBeenCalled();
    expect(sinks.tail()).toBe("z");
  });

  test("읽기가 없으면 기존 경로(꼬리 공급 + print)로 쓴다", () => {
    const { fake, sinks, printAboveRaw } = setupReading();

    sinks.write("a\nb");

    expect(printAboveRaw).not.toHaveBeenCalled();
    expect(fake.written.join("")).toBe("a\r\nb");
    expect(sinks.tail()).toBe("b");
  });

  test("`read()` 뒤 그리기 전(write 콜백 전)의 출력은 기존 경로로 쓰고 꼬리에 먹인다", () => {
    const { readline, sinks, printAboveRaw } = setupReading({
      asyncWrite: true,
    });
    void readline.read("> ");

    sinks.write("t");

    expect(readline.isReading()).toBe(false);
    expect(printAboveRaw).not.toHaveBeenCalled();
    expect(sinks.tail()).toBe("t");
  });
});

describe("열린 읽기 위 접두의 제어 문자 정규화(실제 `Readline` 경로)", () => {
  const BACKSPACE = "\x7f";

  test("BS 스피너 `|` 뒤 `\\b/`는 접두 `/`가 되고 커서가 실제 글자 끝이다", () => {
    const { fake, vt, readline, sinks, openRead } = setupReading();
    openRead("xy");

    sinks.write("|");
    sinks.write("\b/");

    expect(readline.abovePrefix()).toBe("/");
    expect(vt.screen()).toBe("/> xy");
    expect(vt.cursorCol).toBe(5);

    // 뒤이은 편집 재그리기도 같은 자리에 커서를 놓는다.
    fake.type(BACKSPACE);
    expect(vt.screen()).toBe("/> x");
    expect(vt.cursorCol).toBe(4);
  });

  test("커서 숨김 진행률 `\\x1b[?25l50%\\r`는 커서가 실제 글자 끝이다", () => {
    const { vt, sinks, openRead } = setupReading();
    openRead();

    sinks.write("\x1b[?25l50%\r");

    expect(vt.screen()).toBe("50%> abc");
    expect(vt.cursorCol).toBe(8);
  });

  test("접두 BEL은 편집 재그리기마다 다시 울리지 않는다", () => {
    const { fake, readline, sinks, openRead } = setupReading();
    openRead();
    sinks.write("\x07");
    const before = fake.written.join("").length;

    fake.type(BACKSPACE);
    fake.type(BACKSPACE);

    const redrawn = fake.written.join("").slice(before);
    expect(redrawn.split("\x07").length - 1).toBe(0);
    expect(readline.abovePrefix()).toBe("");
  });
});
