/**
 * `read(prompt, { eof: true })`의 빈 버퍼 Ctrl+D EOF 시험(RD-048 DELTA-02). 계약(`_works/20260928-63-
 * rd-048-ctrl-d-eof/DELTA-02.md`): `eof` 옵션을 켠 읽기에서만, 버퍼가 완전히 빈 상태로 실제로 친(`origin
 * "live"`) Ctrl+D가 읽기를 `READ_EOF`로 끝낸다(취소 가능한 Ctrl+C와 같은 순서 — commitDrawnLine →
 * activeRead 비움 → resolve, history 없음). type-ahead 재생(`origin "replay"`)·붙여넣기 덩어리 안
 * (`origin "paste"`)의 Ctrl+D, 커서가 끝이 아니거나 버퍼가 비지 않은 Ctrl+D, `onKey` 훅이 소비한 Ctrl+D는
 * 전부 EOF가 아니고 지금처럼 커서 뒤 글자를 지운다(또는 무동작). `eof` 옵션이 없으면 원본 동작(무동작)이
 * 그대로다.
 */
import { describe, expect, expectTypeOf, test } from "vitest";
import { InputType, type Input } from "../src/keymap";
import { READ_EOF, Readline, type ReadOptions } from "../src/readline";
import { StubTerminal } from "./stub-terminal";

type Outcome =
  | { state: "pending" }
  | { state: "resolved"; value: unknown }
  | { state: "rejected"; reason: unknown };

/** promise의 현재 상태를 읽는 함수를 돌려준다. 끝나지 않는 읽기도 시험이 멈추지 않고 잡는다. */
function observe(promise: Promise<unknown>): () => Outcome {
  let outcome: Outcome = { state: "pending" };
  promise.then(
    (value) => {
      outcome = { state: "resolved", value };
    },
    (reason) => {
      outcome = { state: "rejected", reason };
    },
  );
  return () => outcome;
}

/** 대기 중인 마이크로태스크를 지나가게 한다. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createSession(cols = 20, rows = 8) {
  const term = new StubTerminal(cols, rows);
  const readline = new Readline({ persist: false });
  readline.activate(term as unknown as Parameters<Readline["activate"]>[0]);
  return { term, readline };
}

const CTRL_D = "\x04";
const ARROW_LEFT = "\x1b[D";
const ENTER = "\r";

describe("eof 읽기의 Ctrl+D", () => {
  test("[V1] eof 켬·빈 버퍼 Ctrl+D → READ_EOF, 프롬프트 행 뒤 개행(커서 다음 행 열 0), history 미기록", async () => {
    const { term, readline } = createSession();
    const outcome = observe(readline.read(">>> ", { eof: true }));

    term.feed(CTRL_D);
    await tick();

    expect(outcome()).toEqual({ state: "resolved", value: READ_EOF });
    expect(term.vt.screen()).toBe(">>>");
    expect(term.vt.cursor()).toEqual([1, 0]);
    expect(readline.getHistory().entries).toEqual([]);
  });

  test("[V2] eof 켬·abc·커서 b 앞 Ctrl+D → ac, 읽기 계속", () => {
    const { term, readline } = createSession();
    void readline.read(">>> ", { eof: true });
    term.type("abc");
    term.feed(ARROW_LEFT);
    term.feed(ARROW_LEFT);
    term.feed(CTRL_D);

    expect(readline.getLine()).toBe("ac");
  });

  test("[V3] eof 켬·abc·커서 끝 Ctrl+D → 무동작, 읽기 계속(Enter → abc)", async () => {
    const { term, readline } = createSession();
    const outcome = observe(readline.read(">>> ", { eof: true }));
    term.type("abc");
    term.feed(CTRL_D);

    expect(readline.getLine()).toBe("abc");

    term.feed(ENTER);
    await tick();

    expect(outcome()).toEqual({ state: "resolved", value: "abc" });
  });

  test("[V4] eof 끔(옵션 없음)·빈 버퍼 Ctrl+D → 무동작, 읽기 계속", async () => {
    const { term, readline } = createSession();
    const outcome = observe(readline.read(">>> "));
    term.feed(CTRL_D);
    await tick();

    // commitDrawnLine은 버퍼를 바꾸지 않으므로 EOF가 잘못 트리거돼도 getLine()·screen()만으로는 못 잡는다
    // — 읽기가 끝나지 않았다(pending)는 것까지 같이 본다.
    expect(outcome()).toEqual({ state: "pending" });
    expect(readline.getLine()).toBe("");
    expect(term.vt.screen()).toBe(">>>");
  });

  test("[V5] eof 켬·읽기 없는 구간에 친 \\x04(type-ahead) → 재생 뒤 무동작, 읽기 계속", async () => {
    const { term, readline } = createSession();
    term.feed(CTRL_D);
    const outcome = observe(readline.read(">>> ", { eof: true }));
    await tick();

    expect(outcome()).toEqual({ state: "pending" });
    expect(readline.getLine()).toBe("");
    expect(term.vt.screen()).toBe(">>>");
  });

  test('[V6] eof 켬·빈 버퍼에 붙여넣기 덩어리 "\\x04ab" → EOF 아님, 버퍼 ab', async () => {
    const { term, readline } = createSession();
    const outcome = observe(readline.read(">>> ", { eof: true }));
    // 한 onData 호출에 여러 문자 — readPaste 경로(붙여넣기), origin "paste".
    term.feed(CTRL_D + "ab");
    await tick();

    expect(outcome()).toEqual({ state: "pending" });
    expect(readline.getLine()).toBe("ab");
  });

  test("[V7] eof 켬·printAbove 재그리기 중 친 Ctrl+D(빈 버퍼, queued) → 재그리기 뒤 READ_EOF", async () => {
    const { term, readline } = createSession();
    term.asyncWrite = true;
    const outcome = observe(readline.read(">>> ", { eof: true }));
    term.flush();

    void readline.printAbove("cand");
    // 재그리기 콜백 전(offscreen 대기 중)에 친 키다 — queued에 쌓였다가 재그리기 뒤 origin "live"로 재생된다.
    term.feed(CTRL_D);
    term.flush();
    await tick();

    expect(outcome()).toEqual({ state: "resolved", value: READ_EOF });
  });

  test('[V8] eof 켬·Shift+Enter로 버퍼가 "\\n" → Ctrl+D는 EOF 아님', async () => {
    const { term, readline } = createSession();
    const outcome = observe(readline.read(">>> ", { eof: true }));
    term.pressShiftEnter();
    term.feed(CTRL_D);
    await tick();

    // 버퍼 끝의 editDelete(1)은 무동작이라 버퍼값만으로는 EOF 오발도 "\n"으로 같게 보인다 — pending도 같이 본다.
    expect(outcome()).toEqual({ state: "pending" });
    expect(readline.getLine()).toBe("\n");
  });

  test("[V9] eof 켬·onKey가 Ctrl+D를 소비 → EOF 아님, 읽기 계속", async () => {
    const { term, readline } = createSession();
    const seen: InputType[] = [];
    const onKey = (input: Input) => {
      seen.push(input.inputType);
      return input.inputType === InputType.CtrlD;
    };
    const outcome = observe(readline.read(">>> ", { eof: true, onKey }));
    term.feed(CTRL_D);
    await tick();

    expect(seen).toEqual([InputType.CtrlD]);
    expect(outcome()).toEqual({ state: "pending" });
    expect(readline.getLine()).toBe("");
  });

  test("eof 켬·빈 버퍼에서 Delete(\\x1b[3~)는 Ctrl+D와 다른 키라 EOF가 아니다", async () => {
    const { term, readline } = createSession();
    const outcome = observe(readline.read(">>> ", { eof: true }));
    term.feed("\x1b[3~");
    await tick();

    expect(outcome()).toEqual({ state: "pending" });
    expect(readline.getLine()).toBe("");
  });

  test("type-ahead 재생 중 onKey가 동기로 printAbove를 불러 뒤 Ctrl+D가 queued로 넘어가도 origin은 replay를 유지해 EOF가 아니다", async () => {
    const { term, readline } = createSession();
    term.asyncWrite = true;
    const TAB = "\t";
    const onKey = (input: Input) => {
      if (input.data.join("") !== TAB) return false;
      void readline.printAbove("cand");
      return true;
    };
    // 활성 읽기가 없는 구간에 쌓인다(type-ahead). TAB이 재생 중 printAbove를 동기로 시작해 뒤이은
    // Ctrl+D는 offscreen.queued로 넘어간다 — 그래도 원래 origin "replay"를 유지해야 한다.
    term.feed(TAB);
    term.feed(CTRL_D);
    const outcome = observe(readline.read(">>> ", { eof: true, onKey }));
    term.flush();
    await tick();

    expect(outcome()).toEqual({ state: "pending" });
    expect(readline.getLine()).toBe("");
  });

  test("eof가 boolean으로만 알려진 옵션의 read() 반환 타입은 READ_EOF를 포함하고, eof 없는 옵션은 포함하지 않는다", () => {
    const { readline } = createSession();
    const withOptions = (options: ReadOptions) =>
      readline.read(">>> ", options);
    const cancelableOnly = () => readline.read(">>> ", { cancelable: true });

    expectTypeOf(withOptions).returns.toEqualTypeOf<
      Promise<string | null | typeof READ_EOF>
    >();
    expectTypeOf(cancelableOnly).returns.toEqualTypeOf<
      Promise<string | null>
    >();
  });
});
