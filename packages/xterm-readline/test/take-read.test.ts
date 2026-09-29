/**
 * `Readline.takeRead()`·`ReadOptions.prefillCursor` 시험(RD-022a).
 * 계약(`docs/design/06-editing.md` 6.1 `takeRead()`·`prefillCursor` 항목):
 * - 열린 읽기를 제출·history 없이 끝낸다.
 * - 프롬프트 첫 행부터 입력 마지막 행까지 화면에서 지우고 `{ text, cursor }`를 돌려준다.
 * - 읽기 promise는 `ReadTakenError`로 reject한다(`ReadCancelledError`와 구분).
 * - 남은 type-ahead·재그리기 큐는 다음 읽기로 넘긴다.
 * - `prefillCursor`는 `prefill`을 채운 직후 커서를 그 위치에 둔다.
 *
 * `StubTerminal`의 `asyncWrite`로 write 콜백을 `flush()`까지 미룬다.
 */
import { describe, expect, test } from "vitest";
import { ReadCancelledError, ReadTakenError, Readline } from "../src/readline";
import { asTerminal, StubTerminal } from "./stub-terminal";

type Outcome =
  | { state: "pending" }
  | { state: "resolved"; value: unknown }
  | { state: "rejected"; reason: unknown };

/** promise의 현재 상태를 읽는 함수를 돌려준다. */
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

/** 대기 중인 마이크로태스크와 타이머 한 번을 지나가게 한다. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** `StubTerminal`에 활성화한 `Readline`을 만든다. */
function setup(cols = 20, rows = 8) {
  const term = new StubTerminal(cols, rows);
  const readline = new Readline({ persist: false });
  readline.activate(asTerminal(term));
  return { term, readline };
}

// 키 입력 시퀀스
const ARROW_LEFT = "\x1b[D";
const ENTER = "\r";
const CTRL_C = "\x03";

describe("takeRead 기본 동작", () => {
  test("열린 읽기가 없으면 undefined를 돌려주고 화면을 바꾸지 않는다", () => {
    const { term, readline } = setup();
    readline.println("out");

    expect(readline.takeRead()).toBeUndefined();

    expect(term.vt.screen()).toBe("out");
    expect(term.vt.cursor()).toEqual([1, 0]);
  });

  test("한 행 입력을 텍스트·커서로 돌려주고 프롬프트 행을 지운다", () => {
    const { term, readline } = setup();
    readline.println("out");
    void readline.read(">>> ").catch(() => {});
    term.type("pri");

    const taken = readline.takeRead();

    expect(taken).toEqual({ text: "pri", cursor: 3 });
    expect(term.vt.screen()).toBe("out");
    expect(term.vt.cursor()).toEqual([1, 0]);
  });

  test("커서가 입력 중간이면 그 위치를 돌려준다", () => {
    const { term, readline } = setup();
    void readline.read(">>> ").catch(() => {});
    term.type("print");
    term.feed(ARROW_LEFT);
    term.feed(ARROW_LEFT);

    const taken = readline.takeRead();

    expect(taken).toEqual({ text: "print", cursor: 3 });
    expect(term.vt.screen()).toBe("");
    expect(term.vt.cursor()).toEqual([0, 0]);
  });

  test("빈 입력도 텍스트 빈 문자열·커서 0으로 돌려주고 프롬프트를 지운다", () => {
    const { term, readline } = setup();
    void readline.read(">>> ").catch(() => {});

    expect(readline.takeRead()).toEqual({ text: "", cursor: 0 });

    expect(term.vt.screen()).toBe("");
    expect(term.vt.cursor()).toEqual([0, 0]);
  });

  test("꼬리가 붙은 프롬프트도 프롬프트 전체를 지운다(꼬리 복원은 호출자 몫)", () => {
    const { term, readline } = setup();
    void readline.read("a>>> ").catch(() => {});
    term.type("pri");

    readline.takeRead();

    expect(term.vt.screen()).toBe("");
    expect(term.vt.cursor()).toEqual([0, 0]);
  });

  test("연속으로 두 번 부르면 두 번째는 undefined다", () => {
    const { readline } = setup();
    void readline.read(">>> ").catch(() => {});

    expect(readline.takeRead()).toBeDefined();
    expect(readline.takeRead()).toBeUndefined();
  });

  test("dispose 뒤에는 undefined를 돌려준다", () => {
    const { readline } = setup();
    void readline.read(">>> ").catch(() => {});
    readline.dispose();

    expect(readline.takeRead()).toBeUndefined();
  });
});

describe("takeRead 지움 범위", () => {
  test("줄바꿈으로 여러 행이 된 긴 입력을 전부 지운다", () => {
    // cols 8: "> " + 14글자 = 16칸이라 두 행이 가득 찬다. 끝이 정확히 우측 끝이라 3행째에 빈 커서 행이 생긴다.
    const { term, readline } = setup(8, 10);
    readline.println("out");
    void readline.read("> ").catch(() => {});
    term.type("abcdefghijklmn");
    expect(term.vt.screen().split("\n").length).toBeGreaterThanOrEqual(3);

    const taken = readline.takeRead();

    expect(taken).toEqual({ text: "abcdefghijklmn", cursor: 14 });
    expect(term.vt.screen()).toBe("out");
    expect(term.vt.cursor()).toEqual([1, 0]);
  });

  test("커서가 첫 행에 있어도 아래 행까지 전부 지운다", () => {
    const { term, readline } = setup(8, 10);
    readline.println("out");
    void readline.read("> ").catch(() => {});
    term.type("abcdefghijkl");
    for (let i = 0; i < 12; i++) term.feed(ARROW_LEFT);
    expect(readline.getCursor()).toBe(0);

    const taken = readline.takeRead();

    expect(taken).toEqual({ text: "abcdefghijkl", cursor: 0 });
    expect(term.vt.screen()).toBe("out");
    expect(term.vt.cursor()).toEqual([1, 0]);
  });

  test("커서가 감긴 행의 중간에 있어도 프롬프트 첫 행까지 올라가 지운다", () => {
    const { term, readline } = setup(8, 10);
    readline.println("out");
    void readline.read("> ").catch(() => {});
    term.type("abcdefghijkl");
    for (let i = 0; i < 4; i++) term.feed(ARROW_LEFT);

    const taken = readline.takeRead();

    expect(taken).toEqual({ text: "abcdefghijkl", cursor: 8 });
    expect(term.vt.screen()).toBe("out");
    expect(term.vt.cursor()).toEqual([1, 0]);
  });

  test("여러 논리 줄(멀티라인 버퍼)을 전부 지운다", () => {
    const { term, readline } = setup(40, 10);
    readline.println("out");
    void readline.read(">>> ").catch(() => {});
    readline.editInsert("for x in y:\n    x.");
    expect(term.vt.screen()).toBe("out\n>>> for x in y:\n    x.");

    const taken = readline.takeRead();

    expect(taken).toEqual({ text: "for x in y:\n    x.", cursor: 18 });
    expect(term.vt.screen()).toBe("out");
    expect(term.vt.cursor()).toEqual([1, 0]);
  });

  test("멀티라인 버퍼에서 커서가 첫 줄에 있어도 마지막 줄까지 지운다", () => {
    const { term, readline } = setup(40, 10);
    readline.println("out");
    void readline.read(">>> ").catch(() => {});
    readline.editInsert("if a:\n  if b:\n    x");
    for (let i = 0; i < 18; i++) term.feed(ARROW_LEFT);
    expect(readline.getCursor()).toBe(1);

    const taken = readline.takeRead();

    expect(taken).toEqual({ text: "if a:\n  if b:\n    x", cursor: 1 });
    expect(term.vt.screen()).toBe("out");
    expect(term.vt.cursor()).toEqual([1, 0]);
  });

  test("뷰포트보다 큰 입력도 화면에 남은 행을 전부 지운다", () => {
    const { term, readline } = setup(8, 4);
    void readline.read("> ").catch(() => {});
    term.type("abcdefghijklmnopqrstuvwxyz");

    const taken = readline.takeRead();

    expect(taken?.text).toBe("abcdefghijklmnopqrstuvwxyz");
    expect(term.vt.screen()).toBe("");
    expect(term.vt.cursor()).toEqual([0, 0]);
  });

  test("가져간 뒤 남은 상태를 다시 그려도 지운 행보다 위로 올라가지 않는다", () => {
    const { term, readline } = setup(8, 10);
    readline.println("out");
    void readline.read("> ").catch(() => {});
    term.type("abcdefghijkl");
    readline.takeRead();

    readline.updateLine("Z");

    expect(term.vt.screen()).toBe("out\n> Z");
  });

  test("지운 자리에 다음 read의 프롬프트가 처음부터 그려진다", () => {
    const { term, readline } = setup(8, 10);
    readline.println("out");
    void readline.read("> ").catch(() => {});
    term.type("abcdefghijkl");
    readline.takeRead();

    void readline.read(">>> ").catch(() => {});

    expect(term.vt.screen()).toBe("out\n>>>");
    expect(term.vt.cursor()).toEqual([1, 4]);
  });
});

describe("takeRead 읽기 종료", () => {
  test("읽기 promise를 ReadTakenError로 reject하고 ReadCancelledError와 구분된다", async () => {
    const { term, readline } = setup();
    const outcome = observe(readline.read(">>> "));
    term.type("abc");

    readline.takeRead();
    await tick();

    const result = outcome();
    expect(result.state).toBe("rejected");
    const reason = (result as { reason: unknown }).reason;
    expect(reason).toBeInstanceOf(ReadTakenError);
    expect(reason).not.toBeInstanceOf(ReadCancelledError);
    expect((reason as Error).name).toBe("ReadTakenError");
  });

  test("history를 바꾸지 않는다", async () => {
    const { term, readline } = setup();
    readline.appendHistory("old");
    const before = readline.getHistory().entries.slice();
    const outcome = observe(readline.read(">>> "));
    term.type("abc");

    readline.takeRead();
    await tick();

    expect(outcome().state).toBe("rejected");
    expect(readline.getHistory().entries).toEqual(before);
    expect(readline.getHistory().cursor).toBe(-1);
  });

  test("반환 뒤 활성 읽기가 없어 키는 읽기에 들어가지 않고 다음 read가 정상 동작한다", async () => {
    const { term, readline } = setup();
    void readline.read(">>> ").catch(() => {});
    term.type("abc");
    readline.takeRead();

    // 활성 읽기가 없으므로 이 키는 버퍼가 아니라 type-ahead로 간다.
    term.type("Z");
    expect(term.vt.screen()).toBe("");

    const next = readline.read("> ");
    await tick();
    // 재생된 "Z"가 다음 읽기의 입력이 된다.
    expect(readline.getLine()).toBe("Z");
    term.feed(ENTER);
    await expect(next).resolves.toBe("Z");
  });

  test("Ctrl+C 단독은 활성 읽기가 없으므로 Ctrl+C 핸들러로 간다", () => {
    const { term, readline } = setup();
    let ctrlC = 0;
    readline.setCtrlCHandler(() => {
      ctrlC += 1;
    });
    void readline.read(">>> ").catch(() => {});
    readline.takeRead();

    term.feed(CTRL_C);

    expect(ctrlC).toBe(1);
  });
});

describe("takeRead type-ahead", () => {
  test("읽기 없는 구간에 친 키가 다음 읽기에서 순서대로 재생된다", async () => {
    const { term, readline } = setup();
    void readline.read(">>> ").catch(() => {});
    term.type("pri");
    readline.takeRead();

    term.type("xy");
    void readline.read(">>> ").catch(() => {});
    await tick();

    expect(readline.getLine()).toBe("xy");
  });

  test("그리기 전 읽기를 가져갈 때 이미 쌓인 type-ahead를 비우지 않는다", async () => {
    const { term, readline } = setup();
    term.asyncWrite = true;
    void readline.read("> ").catch(() => {});
    // 읽기가 아직 열리지 않았으므로 이 키는 type-ahead에 쌓인다.
    term.type("ab");

    readline.takeRead();
    term.flush();
    term.asyncWrite = false;
    void readline.read("> ").catch(() => {});
    await tick();

    expect(readline.getLine()).toBe("ab");
  });

  test("printAbove 재그리기 중 쌓인 키(queued)는 type-ahead로 옮겨 다음 읽기가 재생한다", async () => {
    const { term, readline } = setup();
    void readline.read("> ").catch(() => {});
    term.type("abc");
    term.asyncWrite = true;
    void readline.printAbove("LIST");
    term.type("12");

    const taken = readline.takeRead();
    term.flush();
    term.asyncWrite = false;
    void readline.read("> ").catch(() => {});
    await tick();

    expect(taken).toEqual({ text: "abc", cursor: 3 });
    expect(readline.getLine()).toBe("12");
  });
});

describe("takeRead와 다른 API의 상호작용", () => {
  test("takeRead 직후 cancelRead는 읽기·화면에 아무 일도 하지 않는다", async () => {
    const { term, readline } = setup();
    const outcome = observe(readline.read(">>> "));
    term.type("abc");
    readline.takeRead();
    await tick();
    const screenBefore = term.vt.screen();
    const cursorBefore = term.vt.cursor();

    expect(() => readline.cancelRead()).not.toThrow();
    await tick();

    // 이미 ReadTakenError로 끝났고 ReadCancelledError로 바뀌지 않는다.
    const result = outcome();
    expect(result.state).toBe("rejected");
    expect((result as { reason: unknown }).reason).toBeInstanceOf(
      ReadTakenError,
    );
    expect(term.vt.screen()).toBe(screenBefore);
    expect(term.vt.cursor()).toEqual(cursorBefore);
  });

  test("cancelRead 뒤에는 takeRead가 undefined다", () => {
    const { readline } = setup();
    void readline.read(">>> ").catch(() => {});
    readline.cancelRead();

    expect(readline.takeRead()).toBeUndefined();
  });

  test("printAbove 재그리기 중 takeRead는 콜백이 입력줄을 다시 그리지 않게 한다", async () => {
    const { term, readline } = setup();
    void readline.read("> ").catch(() => {});
    term.type("abc");
    term.feed(ARROW_LEFT);
    term.asyncWrite = true;
    void readline.printAbove("LIST");

    const taken = readline.takeRead();
    term.flush();

    // 재그리기 전 논리 커서(2)를 돌려준다(moveCursorToEnd가 옮긴 끝 위치가 아니다).
    expect(taken).toEqual({ text: "abc", cursor: 2 });
    // 콜백이 "> abc"를 LIST 아래에 다시 그리지 않는다.
    expect(term.vt.screen()).toBe("> abc\nLIST");
    expect(term.vt.cursor()).toEqual([2, 0]);
    // 재그리기 상태도 풀려 다음 읽기가 정상이다.
    term.asyncWrite = false;
    const next = readline.read("> ");
    term.type("Q");
    term.feed(ENTER);
    await expect(next).resolves.toBe("Q");
  });

  test("여러 행 입력에서 재그리기 중 takeRead는 이미 찍힌 출력을 지우지 않는다", () => {
    const { term, readline } = setup(8, 10);
    void readline.read("> ").catch(() => {});
    term.type("abcdefghijkl");
    term.asyncWrite = true;
    void readline.printAbove("LIST");
    const screenBefore = term.vt.screen();

    readline.takeRead();
    term.flush();

    // 옛 입력줄과 출력이 그대로이고 커서는 출력 아래 빈 행 열 0이다.
    expect(term.vt.screen()).toBe(screenBefore);
    expect(term.vt.screen()).toBe("> abcdef\nghijkl\nLIST");
    expect(term.vt.cursor()).toEqual([3, 0]);
  });

  test("printAbove가 겹친 재그리기 중에도 처음 커서를 돌려준다", () => {
    const { term, readline } = setup();
    void readline.read("> ").catch(() => {});
    term.type("abc");
    term.feed(ARROW_LEFT);
    term.asyncWrite = true;
    void readline.printAbove("A");
    void readline.printAbove("B");

    const taken = readline.takeRead();
    term.flush();

    expect(taken).toEqual({ text: "abc", cursor: 2 });
  });

  test("printAbove 재그리기 중 takeRead 뒤 도착한 키는 type-ahead로 간다", async () => {
    const { term, readline } = setup();
    void readline.read("> ").catch(() => {});
    term.type("abc");
    term.asyncWrite = true;
    void readline.printAbove("LIST");
    readline.takeRead();

    term.type("z");
    term.flush();
    term.asyncWrite = false;
    void readline.read("> ").catch(() => {});
    await tick();

    expect(readline.getLine()).toBe("z");
  });
});

describe("takeRead와 그리기 전 읽기(pendingReads)", () => {
  test("write 콜백을 기다리는 읽기를 가져가면 빈 텍스트·커서 0을 돌려주고 읽기를 끝낸다", async () => {
    const { term, readline } = setup();
    // 앞선 읽기가 남긴 버퍼("old")를 새 읽기의 텍스트로 착각하지 않아야 한다.
    const first = readline.read("> ");
    term.type("old");
    term.feed(ENTER);
    await first;
    term.vt.write("\x1b[H\x1b[2J");
    term.asyncWrite = true;
    const outcome = observe(readline.read(">>> ", { prefill: "abc" }));

    const taken = readline.takeRead();
    const second = readline.takeRead();
    term.flush();
    await tick();

    expect(taken).toEqual({ text: "", cursor: 0 });
    expect(second).toBeUndefined();
    const result = outcome();
    expect(result.state).toBe("rejected");
    expect((result as { reason: unknown }).reason).toBeInstanceOf(
      ReadTakenError,
    );
    // 프롬프트가 늦게 그려지지 않는다.
    expect(term.vt.screen()).toBe("");
    // 활성 읽기가 되살아나지 않아 키는 type-ahead로 간다.
    term.asyncWrite = false;
    term.type("k");
    expect(term.vt.screen()).toBe("");
  });

  test("그리기 전 읽기를 가져간 뒤 다음 read가 정상이다", async () => {
    const { term, readline } = setup();
    term.asyncWrite = true;
    void readline.read(">>> ").catch(() => {});
    readline.takeRead();
    term.flush();
    term.asyncWrite = false;

    const next = readline.read("> ");
    term.type("ok");
    term.feed(ENTER);

    await expect(next).resolves.toBe("ok");
  });
});

describe("ReadOptions.prefillCursor", () => {
  test("prefill 뒤 커서를 지정한 위치에 둔다", () => {
    const { term, readline } = setup();
    void readline
      .read(">>> ", { prefill: "print", prefillCursor: 2 })
      .catch(() => {});

    expect(readline.getLine()).toBe("print");
    expect(readline.getCursor()).toBe(2);
    expect(term.vt.screen()).toBe(">>> print");
    expect(term.vt.cursor()).toEqual([0, 6]);

    term.type("X");
    expect(readline.getLine()).toBe("prXint");
  });

  test("0이면 맨 앞, 길이와 같으면 끝이다", () => {
    {
      const { readline } = setup();
      void readline
        .read(">>> ", { prefill: "abc", prefillCursor: 0 })
        .catch(() => {});
      expect(readline.getCursor()).toBe(0);
    }
    {
      const { readline } = setup();
      void readline
        .read(">>> ", { prefill: "abc", prefillCursor: 3 })
        .catch(() => {});
      expect(readline.getCursor()).toBe(3);
    }
  });

  test("범위를 벗어나면 [0, prefill 길이]로 자른다", () => {
    {
      const { readline } = setup();
      void readline
        .read(">>> ", { prefill: "abc", prefillCursor: 99 })
        .catch(() => {});
      expect(readline.getCursor()).toBe(3);
    }
    {
      const { readline } = setup();
      void readline
        .read(">>> ", { prefill: "abc", prefillCursor: -5 })
        .catch(() => {});
      expect(readline.getCursor()).toBe(0);
    }
  });

  test("prefill이 없거나 빈 문자열이면 무시한다", () => {
    {
      const { term, readline } = setup();
      void readline.read(">>> ", { prefillCursor: 2 }).catch(() => {});
      expect(readline.getLine()).toBe("");
      expect(readline.getCursor()).toBe(0);
      expect(term.vt.cursor()).toEqual([0, 4]);
    }
    {
      const { readline } = setup();
      void readline
        .read(">>> ", { prefill: "", prefillCursor: 2 })
        .catch(() => {});
      expect(readline.getCursor()).toBe(0);
    }
  });

  test("prefillCursor가 없으면 기존처럼 커서가 끝에 놓인다", () => {
    const { readline } = setup();
    void readline.read(">>> ", { prefill: "abc" }).catch(() => {});

    expect(readline.getCursor()).toBe(3);
  });

  test("멀티라인 prefill에서 첫 줄 중간에 커서를 두면 화면 커서도 그 자리다", () => {
    const { term, readline } = setup(40, 10);
    void readline
      .read(">>> ", { prefill: "if a:\n    x", prefillCursor: 3 })
      .catch(() => {});

    expect(readline.getCursor()).toBe(3);
    expect(term.vt.screen()).toBe(">>> if a:\n    x");
    expect(term.vt.cursor()).toEqual([0, 7]);
  });

  test("감긴 긴 prefill에서 커서를 중간에 두면 화면 커서가 그 행·열이다", () => {
    const { term, readline } = setup(8, 10);
    void readline
      .read("> ", { prefill: "abcdefghijkl", prefillCursor: 7 })
      .catch(() => {});

    // "> " 뒤 7글자 → 9칸째 = 둘째 행 열 1.
    expect(term.vt.cursor()).toEqual([1, 1]);
  });

  test("지연된 write 콜백 뒤에도 커서가 유지된다", () => {
    const { term, readline } = setup();
    term.asyncWrite = true;
    void readline
      .read(">>> ", { prefill: "print", prefillCursor: 2 })
      .catch(() => {});
    term.flush();

    expect(readline.getCursor()).toBe(2);
  });
});

describe("takeRead와 prefill 왕복", () => {
  test("돌려받은 텍스트·커서를 prefill·prefillCursor로 넘기면 같은 화면·커서로 복원된다", () => {
    const { term, readline } = setup();
    void readline.read(">>> ").catch(() => {});
    term.type("print");
    term.feed(ARROW_LEFT);
    term.feed(ARROW_LEFT);
    const before = { screen: term.vt.screen(), cursor: term.vt.cursor() };

    const taken = readline.takeRead();
    if (taken === undefined) throw new Error("takeRead가 undefined");
    void readline
      .read(">>> ", { prefill: taken.text, prefillCursor: taken.cursor })
      .catch(() => {});

    expect(term.vt.screen()).toBe(before.screen);
    expect(term.vt.cursor()).toEqual(before.cursor);
    expect(readline.getCursor()).toBe(taken.cursor);
  });
});

describe("takeRead와 재그리기 대기 중 리사이즈", () => {
  test("재그리기 대기 중 리사이즈 뒤 takeRead하면 화면에 흔적이 없고 새 소비자가 정상 크기로 그린다", () => {
    const { term, readline } = setup(10, 8);
    void readline.read("> ").catch(() => {});
    term.type("abcdefghijkl");

    term.asyncWrite = true;
    void readline.printAboveRaw("t\n", "");
    term.resize(20, 8);
    const taken = readline.takeRead();
    term.flush();

    expect(taken).toEqual({ text: "abcdefghijkl", cursor: 12 });
    // 리사이즈가 화면에 없는 입력줄을 그리지 않았으므로 지울 흔적도 없다.
    expect(term.vt.screen()).toBe("t");
    expect(term.vt.cursor()).toEqual([1, 0]);

    // 새 소비자(예: 실행창)가 가져간 입력을 새 열 수로 그린다.
    term.asyncWrite = false;
    void readline
      .read("> ", { prefill: taken!.text, prefillCursor: taken!.cursor })
      .catch(() => {});
    expect(term.vt.screen()).toBe("t\n> abcdefghijkl");
    expect(term.vt.cursor()).toEqual([1, 14]);
  });
});
