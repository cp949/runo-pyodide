/**
 * `ReadOptions.prefill` 시험. write 콜백 안에서 `new State` 직후 넣는 계약을 고정한다
 * (`docs/design/06-editing.md` 6.3).
 * 트랩(TRAP-14, `docs/design/11-known-traps.md`):
 * - `read()`는 입력 상태를 write 콜백 안에서 **비동기로** 만든다.
 * - 그래서 `read()` 직후 동기로 `updateLine()`을 불러도 콜백의 `new State`가 덮어써 사라진다.
 * - 첫 시험이 이를 재현한다. `prefill`은 콜백 *안에서* 넣으므로 사라지지 않는다.
 */
import { expect, test } from "vitest";
import { Readline } from "../src/readline";
import { VTerm } from "../src/vterm";

/**
 * `write()`의 콜백을 큐에 쌓아 `flush()`까지 미루는 스텁.
 * `read()`가 `term.write("", cb)`로 입력 상태를 만드는 타이밍을 재현하려면 콜백이 늦게 와야 한다.
 * `StubTerminal`은 기본이 동기라 이 트랩을 재현하지 못한다. 이 시험은 독립 스텁을 쓴다.
 */
class DeferredStubTerminal {
  public cols: number;
  public rows: number;
  public options = { tabStopWidth: 8 } as { tabStopWidth?: number };
  public buffer = {
    active: {
      get cursorY() {
        return this.parent.vt.cursor()[0];
      },
      parent: null as unknown as DeferredStubTerminal,
    },
  };
  public vt: VTerm;
  private onDataHandlers: ((data: string) => void)[] = [];
  private queue: { text: string; cb?: () => void }[] = [];

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.vt = new VTerm(cols, rows);
    this.buffer.active.parent = this;
  }

  onData(handler: (data: string) => void) {
    this.onDataHandlers.push(handler);
    return { dispose: () => {} };
  }

  onResize(_handler: (size: { cols: number; rows: number }) => void) {
    return { dispose: () => {} };
  }

  attachCustomKeyEventHandler(_fn: (event: KeyboardEvent) => boolean) {
    // 이 시험에서는 쓰지 않는다.
  }

  write(text: string, cb?: () => void) {
    this.queue.push({ text, cb });
  }

  /** 큐에 쌓인 write 콜백을 순서대로 실행한다. 콜백 안에서 새 write가 쌓여도 마저 비운다. */
  flush() {
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item === undefined) break;
      this.vt.write(item.text);
      item.cb?.();
    }
  }

  feed(data: string) {
    for (const handler of this.onDataHandlers) handler(data);
  }

  type(text: string) {
    for (const ch of text) this.feed(ch);
  }
}

/** `DeferredStubTerminal`에 활성화한 `Readline`을 만든다. */
function setup(cols = 20, rows = 6) {
  const term = new DeferredStubTerminal(cols, rows);
  const rl = new Readline();
  rl.activate(term as unknown as Parameters<typeof rl.activate>[0]);
  return { term, rl };
}

test("read() 직후 updateLine()으로 넣은 텍스트는 입력 상태가 만들어질 때 사라진다", () => {
  const { term, rl } = setup();

  void rl.read(">>> ");
  // read()의 write("", cb) 콜백이 아직 큐에 있어 입력 상태(State)는 이전 것 그대로다.
  rl.updateLine("foo");
  expect(rl.getLine()).toBe("foo");

  // 콜백이 오면 read()가 new State(...)로 교체해 방금 넣은 텍스트가 사라진다.
  term.flush();
  expect(rl.getLine()).toBe("");
});

test("prefill 옵션의 텍스트는 입력 상태 생성 뒤에도 남고 커서가 끝에 있다", () => {
  const { term, rl } = setup();

  void rl.read(">>> ", { prefill: "    " });
  expect(rl.getLine()).toBe("");

  term.flush();
  expect(rl.getLine()).toBe("    ");

  // 커서가 끝에 있어야 타이핑이 뒤에 붙는다.
  term.type("x");
  expect(rl.getLine()).toBe("    x");
});

test("prefill 뒤 Enter는 prefill + 입력을 한 줄로 돌려준다", async () => {
  const { term, rl } = setup();

  const promise = rl.read(">>> ", { prefill: "    " });
  term.flush();
  term.type("x");
  term.feed("\r");

  await expect(promise).resolves.toBe("    x");
});

test("prefill이 빈 문자열이면 원본과 같이 그린다", () => {
  const { term, rl } = setup();

  void rl.read(">>> ", { prefill: "" });
  term.flush();
  expect(rl.getLine()).toBe("");

  term.type("x");
  expect(rl.getLine()).toBe("x");
});

test("cancelable이 아닌 읽기의 ^C 재그리기는 prefill을 다시 넣지 않는다", () => {
  const { term, rl } = setup();

  void rl.read(">>> ", { prefill: "    " });
  term.flush();
  expect(rl.getLine()).toBe("    ");

  term.feed("\x03");
  expect(rl.getLine()).toBe("");
});
