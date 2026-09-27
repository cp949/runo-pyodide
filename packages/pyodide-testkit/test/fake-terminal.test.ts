/**
 * 가짜 터미널(`createFakeTerminal`) 시험.
 * 이 가짜는 이후 시험이 실제 `Readline`을 구동하는 바탕이라, 실제 xterm과 다르게 동작하면 그 시험들이
 * 통과해도 의미가 없다. write 콜백 타이밍, 입력 분해, addon·dispose 거동을 고정한다.
 */
import type { ITerminalAddon, Terminal } from "@xterm/xterm";
import { describe, expect, test } from "vitest";
import { createFakeTerminal } from "../src/fake-terminal";

/** activate에 받은 터미널과 activate·dispose 호출 순서를 기록하는 addon. */
function createRecordingAddon() {
  const calls: string[] = [];
  const activatedWith: Terminal[] = [];
  const addon: ITerminalAddon = {
    activate: (terminal) => {
      calls.push("activate");
      activatedWith.push(terminal);
    },
    dispose: () => {
      calls.push("dispose");
    },
  };
  return { addon, calls, activatedWith };
}

describe("write 콜백", () => {
  test("동기 모드에서는 write 호출 안에서 바로 실행된다", () => {
    const fake = createFakeTerminal();
    const order: string[] = [];

    fake.term.write("a", () => order.push("콜백"));
    order.push("write 다음 문장");

    expect(order).toEqual(["콜백", "write 다음 문장"]);
  });

  test("비동기 모드에서는 flush() 전까지 실행되지 않고 write한 순서대로 실행된다", () => {
    const fake = createFakeTerminal({ asyncWrite: true });
    const order: string[] = [];
    fake.term.write("a", () => order.push("첫째"));
    fake.term.write("b", () => order.push("둘째"));
    expect(order).toEqual([]);

    fake.flush();

    expect(order).toEqual(["첫째", "둘째"]);
  });

  test("flush()는 콜백 안에서 새로 쌓인 콜백까지 모두 실행한다", () => {
    const fake = createFakeTerminal({ asyncWrite: true });
    const order: string[] = [];
    fake.term.write("a", () => {
      order.push("바깥");
      fake.term.write("b", () => order.push("안쪽"));
    });

    fake.flush();

    expect(order).toEqual(["바깥", "안쪽"]);
  });

  test("write한 원문은 콜백 유무와 모드에 상관없이 바로 written에 호출 순서대로 쌓인다", () => {
    const fake = createFakeTerminal({ asyncWrite: true });

    fake.term.write("a", () => {});
    fake.term.write("b");

    expect(fake.written).toEqual(["a", "b"]);
  });
});

describe("입력", () => {
  test("type()은 키 하나마다 onData를 한 번씩 부르고 이스케이프 시퀀스와 서로게이트 쌍은 한 키로 묶는다", () => {
    const fake = createFakeTerminal();
    const received: string[] = [];
    fake.term.onData((data) => received.push(data));

    fake.type("a\x1b[D😀\r\x1b[3~\x1b\r");

    expect(received).toEqual(["a", "\x1b[D", "😀", "\r", "\x1b[3~", "\x1b\r"]);
  });

  test("paste()는 문자열 전체를 한 번의 onData로 보낸다", () => {
    const fake = createFakeTerminal();
    const received: string[] = [];
    fake.term.onData((data) => received.push(data));

    fake.paste("ab\ncd");

    expect(received).toEqual(["ab\ncd"]);
  });

  test("해제한 onData 리스너에는 입력이 가지 않는다", () => {
    const fake = createFakeTerminal();
    const received: string[] = [];
    const listener = fake.term.onData((data) => received.push(data));

    listener.dispose();
    fake.type("x");

    expect(received).toEqual([]);
  });

  test("keyDown()은 custom key handler에 keydown 이벤트를 넘기고 그 반환값을 돌려준다", () => {
    const fake = createFakeTerminal();
    const events: KeyboardEvent[] = [];
    fake.term.attachCustomKeyEventHandler((event) => {
      events.push(event);
      return false;
    });

    const result = fake.keyDown({ key: "Enter", shiftKey: true });

    expect(result).toBe(false);
    expect(events.map((e) => [e.type, e.key, e.shiftKey])).toEqual([
      ["keydown", "Enter", true],
    ]);
  });

  test("custom key handler가 없으면 keyDown()은 true를 돌려 xterm이 키를 그대로 처리하게 한다", () => {
    const fake = createFakeTerminal();

    expect(fake.keyDown({ key: "a" })).toBe(true);
  });
});

describe("addon과 dispose", () => {
  test("loadAddon은 addon.activate에 터미널을 넘기고 dispose()는 로드한 addon을 dispose한다", () => {
    const fake = createFakeTerminal();
    const { addon, calls, activatedWith } = createRecordingAddon();

    fake.term.loadAddon(addon);
    expect(calls).toEqual(["activate"]);
    expect(activatedWith[0]).toBe(fake.term);

    fake.term.dispose();
    expect(calls).toEqual(["activate", "dispose"]);
  });

  test("dispose() 뒤에는 입력이 리스너에 전달되지 않는다", () => {
    const fake = createFakeTerminal();
    const received: string[] = [];
    fake.term.onData((data) => received.push(data));

    fake.term.dispose();
    fake.type("x");
    fake.paste("y");

    expect(received).toEqual([]);
  });

  // 실제 xterm은 dispose 뒤에도 write 콜백을 돌린다(이전 구현 TRP-001). 가짜가 이를 막으면 해제 뒤 콜백 방어 시험이 의미를 잃는다.
  test("dispose() 뒤에도 write 콜백은 실행된다", () => {
    const fake = createFakeTerminal();
    let fired = false;
    fake.term.dispose();

    fake.term.write("late", () => {
      fired = true;
    });

    expect(fired).toBe(true);
  });

  test("dispose() 전의 buffer 읽기는 세지 않고 dispose() 뒤의 읽기만 disposedBufferReads로 센다", () => {
    const fake = createFakeTerminal();

    expect(fake.term.buffer.active.cursorY).toBe(0);
    expect(fake.disposedBufferReads).toBe(0);

    fake.term.dispose();
    expect(fake.term.buffer.active.cursorY).toBe(0);

    expect(fake.disposedBufferReads).toBe(1);
  });
});

describe("화면 모델(screen)", () => {
  test("기본값은 cursorX 0·cursorY 0·baseY 0·wrapped 행 없음이다", () => {
    const fake = createFakeTerminal();
    const active = fake.term.buffer.active;

    expect(fake.screen).toEqual({
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      wrappedRows: new Set<number>(),
    });
    expect(active.cursorX).toBe(0);
    expect(active.cursorY).toBe(0);
    expect(active.baseY).toBe(0);
  });

  test("screen에 지정한 cursorX를 buffer.active가 읽는다", () => {
    const fake = createFakeTerminal();

    fake.screen.cursorX = 7;

    expect(fake.term.buffer.active.cursorX).toBe(7);
  });

  test("screen에 지정한 cursorY·baseY를 buffer.active가 읽는다", () => {
    const fake = createFakeTerminal();

    fake.screen.cursorY = 3;
    fake.screen.baseY = 5;

    expect(fake.term.buffer.active.cursorY).toBe(3);
    expect(fake.term.buffer.active.baseY).toBe(5);
  });

  test("getLine은 wrappedRows에 넣은 절대 행만 isWrapped이고 음수 행은 없다", () => {
    const fake = createFakeTerminal();
    fake.screen.wrappedRows.add(4);
    const active = fake.term.buffer.active;

    expect(active.getLine(4)?.isWrapped).toBe(true);
    expect(active.getLine(3)?.isWrapped).toBe(false);
    expect(active.getLine(-1)).toBeUndefined();
  });

  test("dispose() 뒤의 baseY·getLine 읽기도 disposedBufferReads로 센다", () => {
    const fake = createFakeTerminal();
    fake.term.dispose();

    void fake.term.buffer.active.baseY;
    fake.term.buffer.active.getLine(0);

    expect(fake.disposedBufferReads).toBe(2);
  });
});
