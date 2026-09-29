/**
 * 벤더 `Readline.printAbove(text)` 시험(RD-015).
 * 계약(`docs/design/06-editing.md` 6.1 `printAbove` 항목):
 * - 활성 읽기 중에는 커서를 버퍼 끝으로 옮겨 원시 텍스트를 쓴다.
 * - `term.write("", cb)` 콜백에서 앵커를 갱신한 뒤 원래 커서로 되돌려 같은 State를 다시 그린다.
 * - 재그리기 중 들어온 키는 큐에 쌓았다가 콜백 뒤 순서대로 재생한다.
 * - 활성 읽기가 없으면 `println`과 같다.
 * - dispose 뒤 늦게 도착한 콜백은 아무것도 하지 않는다.
 *
 * 회귀 방지 시험:
 * - 다중 행(감김·`\n` 포함 블록) 재그리기가 옛 레이아웃 기준으로 화면을 지우는 버그(`resetLayout()`).
 * - `cancelRead()`가 재그리기 콜백보다 먼저 끝났을 때 죽은 입력줄을 다시 그리는 경합(`activeRead` 가드).
 */
import { describe, expect, test } from "vitest";
import { Readline } from "../src/readline";
import { asTerminal, StubTerminal } from "./stub-terminal";

/** `StubTerminal`에 활성화한 `Readline`을 만든다. */
function setup(cols = 20, rows = 8) {
  const term = new StubTerminal(cols, rows);
  const readline = new Readline({ persist: false });
  readline.activate(asTerminal(term));
  return { term, readline };
}

// ArrowLeft 키 시퀀스
const ARROW_LEFT = "\x1b[D";

describe("printAbove", () => {
  test("활성 읽기 중 printAbove는 텍스트를 입력줄 위에 쓰고 버퍼·커서를 유지한다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    term.feed(ARROW_LEFT);

    readline.printAbove("x  y");

    expect(term.vt.screen()).toBe("> abc\nx  y\n> abc");
    expect(readline.getLine()).toBe("abc");
    expect(readline.getCursor()).toBe(2);

    term.type("Z");
    expect(readline.getLine()).toBe("abZc");
  });

  test("재그리기 중 들어온 키는 순서대로 재생된다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    term.feed(ARROW_LEFT);

    // 이 시점부터 write 콜백을 미뤄 printAbove의 재그리기가 끝나기 전 상태를 관찰한다.
    term.asyncWrite = true;
    readline.printAbove("x");
    const bufferBeforeFlush = readline.getLine();
    term.type("12");
    const bufferWhileQueued = readline.getLine();

    term.flush();

    expect(bufferBeforeFlush).toBe("abc");
    expect(bufferWhileQueued).toBe("abc");
    // 커서 2 기준으로 "12"가 순서대로 끼어든다: "ab" + "12" + "c".
    expect(readline.getLine()).toBe("ab12c");
  });

  test("커서 끝·이모지 버퍼에서도 커서가 유지된다", () => {
    {
      // 커서가 이미 버퍼 끝: moveCursorToEnd()가 조기 반환하는 경로.
      const { term, readline } = setup();
      void readline.read("> ");
      term.type("a😀b");

      readline.printAbove("x");

      expect(readline.getCursor()).toBe(4); // UTF-16 인덱스: a(1) + 😀(2) + b(1)
      term.type("!");
      expect(readline.getLine()).toBe("a😀b!");
    }
    {
      // 커서를 이모지 앞으로 옮긴 경우: moveCursorToEnd()가 실제로 옮겼다가 되돌리는 경로.
      const { term, readline } = setup();
      void readline.read("> ");
      term.type("a😀b");
      term.feed(ARROW_LEFT);
      term.feed(ARROW_LEFT);

      readline.printAbove("x");

      expect(readline.getCursor()).toBe(1);
      term.type("!");
      expect(readline.getLine()).toBe("a!😀b");
    }
  });

  test("활성 읽기가 없으면 println과 같다", () => {
    const { term, readline } = setup();

    expect(() => readline.printAbove("x")).not.toThrow();

    expect(term.vt.screen()).toBe("x");
  });

  test("dispose 뒤 도착한 콜백은 아무것도 하지 않는다", () => {
    const { term, readline } = setup();
    void readline.read("> ").catch(() => {});
    term.type("abc");

    term.asyncWrite = true;
    readline.printAbove("x");
    const cursorYReadsBeforeDispose = term.cursorYReads;
    readline.dispose();

    expect(() => term.flush()).not.toThrow();
    // 해제된 터미널의 buffer(cursorY)를 다시 읽지 않는다(TRP-004).
    expect(term.cursorYReads).toBe(cursorYReadsBeforeDispose);
  });

  // 회귀 방지: 재그리기가 moveCursorToEnd()가 남긴 옛 레이아웃(옛 커서 행) 기준으로 위로 올라가
  // 방금 찍은 텍스트나 입력줄 일부를 \x1b[J로 지우던 버그.
  test("블록 입력(여러 논리 줄)에서 재그리기 뒤에도 입력줄이 남는다", () => {
    const { term, readline } = setup(40, 10);
    void readline.read(">>> ");
    readline.editInsert("for x in y:\n    x.");

    readline.printAbove("x.a  x.b");

    // 재그리기 뒤에도 버퍼가 소실되지 않는다.
    expect(readline.getLine()).toBe("for x in y:\n    x.");
    expect(term.vt.screen()).toBe(
      ">>> for x in y:\n    x.\nx.a  x.b\n>>> for x in y:\n    x.",
    );

    term.type("a");
    expect(readline.getLine()).toBe("for x in y:\n    x.a");
  });

  test("3행 블록에서도 옛 줄이 지워지지 않는다", () => {
    const { term, readline } = setup(40, 10);
    void readline.read(">>> ");
    readline.editInsert("if a:\n  if b:\n    x.");

    readline.printAbove("x.a  x.b");

    // 목록뿐 아니라 옛 입력의 마지막 행까지 지워지는 회귀를 막는다.
    expect(readline.getLine()).toBe("if a:\n  if b:\n    x.");
    expect(term.vt.screen()).toBe(
      ">>> if a:\n  if b:\n    x.\nx.a  x.b\n>>> if a:\n  if b:\n    x.",
    );
  });

  test("감긴 단일 행(cols 작음)에서도 입력줄이 남는다", () => {
    const { term, readline } = setup(8, 8);
    void readline.read("> ");
    term.type("abcdefgh");

    readline.printAbove("LIST");

    expect(readline.getLine()).toBe("abcdefgh");
    expect(term.vt.screen()).toBe("> abcdef\ngh\nLIST\n> abcdef\ngh");
  });

  // `printAbove`가 돌려주는 프로미스는 재그리기가 실제로 끝난 뒤에만 resolve해야 한다.
  // 그래야 코어 `tab-reader.ts`가 재그리기 중 큐의 키를 벤더 큐를 우회해 처리하지 않는다.
  test("활성 읽기가 없으면 돌려준 프로미스가 즉시(println과 함께) resolve된다", async () => {
    const { term, readline } = setup();
    let resolved = false;

    void readline.printAbove("x").then(() => {
      resolved = true;
    });

    // println은 동기라 write 콜백을 기다릴 필요가 없다. 마이크로태스크 한 번이면 충분하다.
    await Promise.resolve();
    expect(resolved).toBe(true);
    expect(term.vt.screen()).toBe("x");
  });

  test("활성 읽기가 있으면 돌려준 프로미스가 재그리기 write 콜백이 끝난 뒤에 resolve된다", async () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    term.asyncWrite = true;
    let resolved = false;

    void readline.printAbove("x").then(() => {
      resolved = true;
    });

    // 콜백이 flush될 때까지는(재그리기가 끝나기 전) resolve되지 않는다.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    term.flush();
    await Promise.resolve();
    await Promise.resolve();

    expect(resolved).toBe(true);
    // 재그리기도 정상적으로 끝나 있다(버퍼·커서 유지).
    expect(readline.getLine()).toBe("abc");
  });

  test("cancelRead()가 재그리기 콜백보다 먼저 오면 입력줄을 다시 그리지 않는다", async () => {
    const { term, readline } = setup(40, 10);
    void readline.read(">>> ").catch(() => {});
    term.type("abc");

    // write 콜백을 flush()까지 미뤄, printAbove의 재그리기 콜백이 도착하기 전에
    // cancelRead()가 먼저 끝나는 경합을 흉내낸다.
    term.asyncWrite = true;
    let resolved = false;
    const printed = readline.printAbove("L").then(() => {
      resolved = true;
    });
    readline.cancelRead();
    readline.println("[reset]");

    // flush() 전에는 재그리기 콜백이 아직 오지 않았으므로 resolve되지 않는다.
    await Promise.resolve();
    expect(resolved).toBe(false);

    term.flush();
    await printed;

    // cancelRead() 뒤라 재그리기는 건너뛰지만 printAbove가 돌려준 프로미스는 여전히 resolve된다.
    // 호출자(`tab-reader.ts`)의 `.finally(drainQueue)`가 매달리지 않는다.
    expect(resolved).toBe(true);
    // 죽은 입력줄("abc")이 [reset] 아래에 다시 그려지지 않는다.
    const screen = term.vt.screen();
    const resetIndex = screen.indexOf("[reset]");
    expect(resetIndex).toBeGreaterThan(-1);
    expect(screen.slice(resetIndex)).not.toContain("abc");
    expect(screen).toBe(">>> abc\nL\n[reset]");
  });

  // cancelRead() 뒤 재그리기 콜백 전 창을 다룬다.
  // 취소 이전 키는 옛 맥락이라 폐기한다.
  // 취소 이후 키는 새 맥락이라 type-ahead가 받아 다음 읽기에서 재생한다.
  describe("cancelRead() 뒤 재그리기 콜백 전 창", () => {
    test("취소 이전에 친 키는 폐기되어 다음 읽기에서 재생되지 않는다", () => {
      const { term, readline } = setup();
      void readline.read("> ").catch(() => {});
      term.asyncWrite = true;
      void readline.printAbove("L");
      term.type("x");
      readline.cancelRead();
      term.flush();

      term.asyncWrite = false;
      void readline.read("> ");

      expect(readline.getLine()).toBe("");
    });

    test("취소 뒤 콜백 전에 친 키는 type-ahead로 가서 다음 읽기에서 재생된다", () => {
      const { term, readline } = setup();
      void readline.read("> ").catch(() => {});
      term.asyncWrite = true;
      void readline.printAbove("L");
      readline.cancelRead();
      term.type("y");
      term.flush();

      term.asyncWrite = false;
      void readline.read("> ");

      expect(readline.getLine()).toBe("y");
    });

    test("취소 뒤 콜백 전에 친 키와 Shift+Enter는 순서대로 재생된다: y Shift+Enter z", () => {
      const { term, readline } = setup();
      void readline.read("> ").catch(() => {});
      term.asyncWrite = true;
      void readline.printAbove("L");
      readline.cancelRead();
      term.type("y");
      term.pressShiftEnter();
      term.type("z");
      term.flush();

      term.asyncWrite = false;
      void readline.read("> ");

      expect(readline.getLine()).toBe("y\nz");
    });

    test("콜백이 온 뒤 새 읽기에서는 키가 큐를 거치지 않고 바로 버퍼에 반영된다", () => {
      const { term, readline } = setup();
      void readline.read("> ").catch(() => {});
      term.asyncWrite = true;
      void readline.printAbove("L");
      readline.cancelRead();
      // 새 읽기의 write 콜백은 printAbove 콜백 뒤에 등록되므로 FIFO로 함께 flush된다.
      void readline.read("> ");
      term.flush();

      term.type("a");

      expect(readline.getLine()).toBe("a");
    });
  });
});
