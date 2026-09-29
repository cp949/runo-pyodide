/**
 * 열린 읽기 위 원시 출력 시험(RD-022b).
 * 계약(`docs/design/06-editing.md` 6.1 `printAboveRaw` 항목, `docs/design/05-output.md` 4.4):
 * - `printAboveRaw(lines, prefix)`는 입력줄(프롬프트 첫 행부터 입력 마지막 행까지)을 지우고 그 자리에 `lines`(완성된 행)를 쓴다.
 * - 이어서 `prefix`를 프롬프트 앞에 붙여 같은 읽기를 그 아래에 다시 그린다.
 * - 재그리기(write 콜백)를 기다리는 동안 들어온 출력·Tab `printAbove`는 하나의 재그리기로 합치고 마지막 콜백만 그린다.
 * - 저장 커서는 처음 값 하나다.
 * - Tab `printAbove`는 접두를 비운다.
 *
 * `StubTerminal`의 write 바이트 기록(`log`)과 콜백 하나씩 실행(`flushOne`)을 쓴다.
 */
import { describe, expect, test } from "vitest";
import { Readline } from "../src/readline";
import { StubTerminal } from "./stub-terminal";

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
  readline.activate(term as unknown as Parameters<Readline["activate"]>[0]);
  return { term, readline };
}

/** 화면에서 `needle`이 나오는 횟수. */
function count(screen: string, needle: string): number {
  return screen.split(needle).length - 1;
}

// 키 입력 시퀀스
const ARROW_LEFT = "\x1b[D";
const ARROW_UP = "\x1b[A";
const BACKSPACE = "\x7f";
const ENTER = "\r";
const CTRL_C = "\x03";

describe("isReading·abovePrefix", () => {
  test("읽기 전과 write 콜백 전 읽기는 읽는 중이 아니고 접두는 빈 문자열이다", () => {
    const { term, readline } = setup();
    expect(readline.isReading()).toBe(false);
    expect(readline.abovePrefix()).toBe("");

    term.asyncWrite = true;
    void readline.read("> ").catch(() => {});
    expect(readline.isReading()).toBe(false);

    term.flush();
    expect(readline.isReading()).toBe(true);
    expect(readline.abovePrefix()).toBe("");
  });

  test("printAboveRaw가 준 접두를 돌려주고 재그리기 대기 중에도 읽는 중이다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");

    term.asyncWrite = true;
    void readline.printAboveRaw("", "tick");

    expect(readline.isReading()).toBe(true);
    expect(readline.abovePrefix()).toBe("tick");
    term.flush();
    expect(readline.isReading()).toBe(true);
    expect(readline.abovePrefix()).toBe("tick");
  });

  test("Enter로 읽기가 끝나면 읽는 중이 아니고 다음 읽기는 접두 없이 시작한다", async () => {
    const { term, readline } = setup();
    const first = readline.read("> ");
    term.type("abc");
    void readline.printAboveRaw("", "tick");

    term.feed(ENTER);
    await expect(first).resolves.toBe("abc");
    expect(readline.isReading()).toBe(false);
    expect(readline.abovePrefix()).toBe("");

    void readline.read("> ");
    expect(readline.abovePrefix()).toBe("");
    // 접두는 확정된 행과 함께 위에 남고 새 프롬프트는 접두 없이 그려진다.
    expect(term.vt.screen()).toBe("tick> abc\n>");
  });

  test("취소·takeRead·cancelRead 뒤에는 읽는 중이 아니고 접두는 빈 문자열이다", async () => {
    {
      const { term, readline } = setup();
      const read = readline.read("> ", { cancelable: true });
      void readline.printAboveRaw("", "tick");
      term.feed(CTRL_C);
      await expect(read).resolves.toBeNull();
      expect(readline.isReading()).toBe(false);
      expect(readline.abovePrefix()).toBe("");
    }
    {
      const { readline } = setup();
      void readline.read("> ").catch(() => {});
      void readline.printAboveRaw("", "tick");
      readline.takeRead();
      expect(readline.isReading()).toBe(false);
      expect(readline.abovePrefix()).toBe("");
    }
    {
      const { readline } = setup();
      void readline.read("> ").catch(() => {});
      void readline.printAboveRaw("", "tick");
      readline.cancelRead();
      expect(readline.isReading()).toBe(false);
      expect(readline.abovePrefix()).toBe("");
    }
  });

  test("취소 불가 읽기의 Ctrl+C는 같은 읽기를 접두 없이 다시 그린다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    void readline.printAboveRaw("", "tick");

    term.feed(CTRL_C);

    expect(readline.isReading()).toBe(true);
    expect(readline.abovePrefix()).toBe("");
    expect(term.vt.screen()).toBe("tick> abc^C\n>");
  });
});

/**
 * `hasPendingRead()` 시험(RD-028).
 * - write 콜백을 기다리는 읽기(아직 그리지 않음)가 있으면 true다. 활성 읽기(그려짐)는 세지 않는다.
 * - `isReading()`과 정확히 반대 시점을 가리켜야 한다.
 *   그래야 promptRow가 두 조회로 settle 실패의 두 경우(그리기 전 읽기 있음 / 열린 읽기 없음)를 구분한다.
 */
describe("hasPendingRead", () => {
  test("읽기가 없으면 false다", () => {
    const { readline } = setup();
    expect(readline.hasPendingRead()).toBe(false);
  });

  test("read() 직후 write 콜백 전에는 true이고, 같은 시점 isReading()은 false다", () => {
    const { term, readline } = setup();
    term.asyncWrite = true;
    void readline.read("> ").catch(() => {});

    expect(readline.hasPendingRead()).toBe(true);
    expect(readline.isReading()).toBe(false);
  });

  test("write 콜백이 와 그려진 뒤에는 false이고 isReading()이 true다", () => {
    const { term, readline } = setup();
    term.asyncWrite = true;
    void readline.read("> ").catch(() => {});
    term.flush();

    expect(readline.hasPendingRead()).toBe(false);
    expect(readline.isReading()).toBe(true);
  });

  test("write 콜백 전 cancelRead() 뒤에는 false다", () => {
    const { term, readline } = setup();
    term.asyncWrite = true;
    void readline.read("> ").catch(() => {});
    readline.cancelRead();

    expect(readline.hasPendingRead()).toBe(false);
  });

  test("write 콜백 전 takeRead() 뒤에는 false다", () => {
    const { term, readline } = setup();
    term.asyncWrite = true;
    void readline.read("> ").catch(() => {});
    readline.takeRead();

    expect(readline.hasPendingRead()).toBe(false);
  });

  test("write 콜백 전 dispose() 뒤에는 false다", () => {
    const { term, readline } = setup();
    term.asyncWrite = true;
    void readline.read("> ").catch(() => {});
    readline.dispose();

    expect(readline.hasPendingRead()).toBe(false);
  });

  test("write 콜백 전 cancelRead({ settle: true })가 false를 돌려주기 직전에 읽은 값은 true다", () => {
    // promptRow가 쓰는 순서의 전제(`docs/design/06-editing.md` 6.1):
    // "그리기 전 읽기 있음"은 cancelRead() 앞에서 읽어야 한다.
    // cancelRead()가 pendingReads를 즉시 비우므로 뒤에서 읽으면 항상 false다.
    const { term, readline } = setup();
    term.asyncWrite = true;
    void readline.read("> ").catch(() => {});

    const hadPendingBeforeCancel = readline.hasPendingRead();
    const settled = readline.cancelRead({ settle: true });

    expect(hadPendingBeforeCancel).toBe(true);
    // 그리기 전 읽기만 있고 term에 아직 아무것도 그려지지 않아 정리할 화면이 없다.
    expect(settled).toBe(false);
    expect(readline.hasPendingRead()).toBe(false);
  });
});

describe("printAboveRaw 지우기·쓰기·다시 그리기", () => {
  test("한 행 입력 위에 완성 행을 쓰고 입력줄을 그 아래에 다시 그린다", () => {
    const { term, readline } = setup();
    readline.println("out");
    void readline.read("> ");
    term.type("abc");

    void readline.printAboveRaw("tick\n", "");

    expect(term.vt.screen()).toBe("out\ntick\n> abc");
    expect(readline.getLine()).toBe("abc");
    expect(readline.getCursor()).toBe(3);
    expect(term.vt.cursor()).toEqual([2, 5]);

    // 뒤이은 편집 재그리기가 출력 행을 지우지 않는다.
    term.feed(BACKSPACE);
    expect(term.vt.screen()).toBe("out\ntick\n> ab");
  });

  test("개행 없는 조각은 프롬프트 앞 접두로 그리고 다음 출력이 그 행을 이어 쓴다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");

    void readline.printAboveRaw("", "tick");
    expect(term.vt.screen()).toBe("tick> abc");
    expect(term.vt.cursor()).toEqual([0, 9]);
    expect(readline.getCursor()).toBe(3);

    void readline.printAboveRaw("tick tock\n", "");
    expect(term.vt.screen()).toBe("tick tock\n> abc");

    term.feed(BACKSPACE);
    expect(term.vt.screen()).toBe("tick tock\n> ab");
  });

  test("비어 있지 않은 접두와 프롬프트 사이, 완성 행 뒤에 SGR 초기화를 넣는다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");

    void readline.printAboveRaw("\x1b[31mred\n", "\x1b[32mgo");

    expect(term.bytes()).toContain("\x1b[31mred\r\n\x1b[0m");
    expect(term.bytes()).toContain("\r\x1b[J\x1b[32mgo\x1b[0m> abc");
    expect(term.vt.screen()).toBe("red\ngo> abc");
  });

  test("빈 접두면 프롬프트 앞에 아무것도 붙이지 않는다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    void readline.printAboveRaw("", "tick");
    term.log = [];

    void readline.printAboveRaw("tick\n", "");

    expect(term.bytes()).toContain("\r\x1b[J> abc");
    expect(term.bytes()).not.toContain("\x1b[0m> abc");
  });

  test("커서가 줄 중간이면 다시 그린 뒤에도 같은 논리 위치·화면 열에 있다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    term.feed(ARROW_LEFT);

    void readline.printAboveRaw("tick\n", "");

    expect(readline.getCursor()).toBe(2);
    expect(term.vt.cursor()).toEqual([1, 4]);
    term.type("Z");
    expect(readline.getLine()).toBe("abZc");
    expect(term.vt.screen()).toBe("tick\n> abZc");
  });

  test("접두가 있어도 커서 열은 접두 폭만큼 밀린 자리다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    term.feed(ARROW_LEFT);

    void readline.printAboveRaw("", "tick");

    expect(readline.getCursor()).toBe(2);
    expect(term.vt.cursor()).toEqual([0, 8]);
  });

  test("감긴 입력은 모든 행을 지우고 출력 아래에 감긴 그대로 다시 그린다", () => {
    const { term, readline } = setup(10, 10);
    void readline.read("> ");
    term.type("abcdefghijklmnopqrstuvwxy");
    expect(term.vt.screen()).toBe("> abcdefgh\nijklmnopqr\nstuvwxy");

    void readline.printAboveRaw("tick\n", "");

    expect(term.vt.screen()).toBe("tick\n> abcdefgh\nijklmnopqr\nstuvwxy");
    term.feed(BACKSPACE);
    expect(term.vt.screen()).toBe("tick\n> abcdefgh\nijklmnopqr\nstuvwx");
    expect(count(term.vt.screen(), "> ")).toBe(1);
  });

  test("여러 논리 줄 버퍼도 전부 지우고 다시 그린다", () => {
    const { term, readline } = setup(40, 10);
    void readline.read(">>> ");
    readline.editInsert("for x in y:\n    x.");

    void readline.printAboveRaw("tick\n", "");

    expect(term.vt.screen()).toBe("tick\n>>> for x in y:\n    x.");
    term.type("a");
    expect(term.vt.screen()).toBe("tick\n>>> for x in y:\n    x.a");
  });

  test("맨 아래 행에서 여러 행을 쓰면 스크롤 뒤 입력줄이 마지막 행에 오고 흔적 행이 없다", () => {
    const { term, readline } = setup(20, 5);
    for (const row of ["o1", "o2", "o3", "o4"]) readline.println(row);
    void readline.read("> ");
    term.type("abc");
    expect(term.vt.cursor()).toEqual([4, 5]);

    void readline.printAboveRaw("t1\nt2\nt3\n", "");

    expect(term.vt.screen()).toBe("o4\nt1\nt2\nt3\n> abc");
    expect(term.vt.cursor()).toEqual([4, 5]);
    const scrollback = term.vt.scrollback.map((r) => r.join("").trimEnd());
    expect(scrollback).toEqual(["o1", "o2", "o3"]);

    term.feed(BACKSPACE);
    expect(term.vt.screen()).toBe("o4\nt1\nt2\nt3\n> ab");
  });

  test("맨 아래의 감긴 입력도 스크롤 뒤 겹치지 않고 다시 그린다", () => {
    const { term, readline } = setup(10, 5);
    for (const row of ["o1", "o2", "o3"]) readline.println(row);
    void readline.read("> ");
    term.type("abcdefghijkl");
    expect(term.vt.screen()).toBe("o1\no2\no3\n> abcdefgh\nijkl");

    void readline.printAboveRaw("t1\nt2\n", "");

    expect(term.vt.screen()).toBe("o3\nt1\nt2\n> abcdefgh\nijkl");
    const scrollback = term.vt.scrollback.map((r) => r.join("").trimEnd());
    expect(scrollback).toEqual(["o1", "o2"]);

    term.feed(BACKSPACE);
    expect(term.vt.screen()).toBe("o3\nt1\nt2\n> abcdefgh\nijk");
  });

  test("다시 그린 뒤 입력이 화면보다 커지면 출력 행은 스크롤백으로 올라가고 지워지지 않는다", () => {
    // 앵커가 출력 뒤 커서 행으로 갱신되지 않으면 스크롤 양을 적게 잡아 출력 행을 입력으로 덮어쓴다.
    const { term, readline } = setup(10, 5);
    readline.println("o1");
    void readline.read("> ");
    term.type("a");
    void readline.printAboveRaw("t1\nt2\n", "");
    expect(term.vt.screen()).toBe("o1\nt1\nt2\n> a");

    readline.editInsert("\nb\nc\nd\ne\nf");

    expect(term.vt.screen()).toBe("b\nc\nd\ne\nf");
    const scrollback = term.vt.scrollback.map((r) => r.join("").trimEnd());
    expect(scrollback).toEqual(["o1", "t1", "t2"]);
  });

  test("터미널 폭보다 긴 접두는 감긴 프롬프트가 되고 다음 출력 때 접두 행을 전부 지운다", () => {
    const { term, readline } = setup(10, 10);
    void readline.read("> ");
    term.type("ab");
    const prefix = "p".repeat(25);

    void readline.printAboveRaw("", prefix);

    expect(term.vt.screen()).toBe("pppppppppp\npppppppppp\nppppp> ab");
    expect(term.vt.cursor()).toEqual([2, 9]);

    void readline.printAboveRaw(prefix + "!\n", "");

    expect(term.vt.screen()).toBe("pppppppppp\npppppppppp\nppppp!\n> ab");
    term.feed(BACKSPACE);
    expect(term.vt.screen()).toBe("pppppppppp\npppppppppp\nppppp!\n> a");
  });

  test("완료 뒤 돌려준 프로미스가 resolve된다", async () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    term.asyncWrite = true;

    const outcome = observe(readline.printAboveRaw("tick\n", ""));
    await tick();
    expect(outcome().state).toBe("pending");

    term.flush();
    await tick();
    expect(outcome().state).toBe("resolved");
  });
});

describe("printAboveRaw 재그리기 대기", () => {
  test("콜백 전 연속 세 조각: 출력 순서 보존·입력줄 1개·마지막 접두", async () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    term.asyncWrite = true;

    const first = observe(readline.printAboveRaw("a1\n", ""));
    const second = observe(readline.printAboveRaw("a2\n", "p"));
    const third = observe(readline.printAboveRaw("pa3\n", "q"));

    // 입력줄은 첫 조각에서 지워졌고 아직 다시 그려지지 않았다.
    expect(term.vt.screen()).toBe("a1\na2\npa3");
    expect(readline.abovePrefix()).toBe("q");

    // 앞선 콜백은 그리지 않고, 마지막 재그리기가 끝나기 전에는 resolve하지 않는다.
    term.flushOne();
    term.flushOne();
    await tick();
    expect(term.vt.screen()).toBe("a1\na2\npa3");
    expect(first().state).toBe("pending");
    expect(second().state).toBe("pending");

    term.flushOne();
    await tick();
    expect(term.vt.screen()).toBe("a1\na2\npa3\nq> abc");
    expect(count(term.vt.screen(), "> abc")).toBe(1);
    expect([first().state, second().state, third().state]).toEqual([
      "resolved",
      "resolved",
      "resolved",
    ]);
  });

  test("재그리기 중 친 키는 큐에 쌓였다가 다시 그린 뒤 원래 커서 위치에 순서대로 들어간다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    term.feed(ARROW_LEFT);
    term.asyncWrite = true;

    void readline.printAboveRaw("tick\n", "");
    term.type("12");
    expect(readline.getLine()).toBe("abc");

    term.flush();

    expect(readline.getLine()).toBe("ab12c");
    expect(readline.getCursor()).toBe(4);
    expect(term.vt.screen()).toBe("tick\n> ab12c");
  });

  test("재그리기 중 Enter는 다시 그린 뒤 재생되어 줄을 제출한다", async () => {
    const { term, readline } = setup();
    const read = observe(readline.read("> "));
    term.type("abc");
    term.asyncWrite = true;

    void readline.printAboveRaw("tick\n", "");
    term.feed(ENTER);
    await tick();
    expect(read().state).toBe("pending");

    term.flush();
    await tick();

    expect(read()).toEqual({ state: "resolved", value: "abc" });
    expect(term.vt.screen()).toBe("tick\n> abc");
    expect(term.vt.cursor()).toEqual([2, 0]);
    expect(readline.isReading()).toBe(false);
  });

  test("재그리기 중 취소 가능한 Ctrl+C는 다시 그린 뒤 재생되어 읽기를 null로 끝낸다", async () => {
    const { term, readline } = setup();
    const read = observe(readline.read("> ", { cancelable: true }));
    term.type("abc");
    term.asyncWrite = true;

    void readline.printAboveRaw("tick\n", "");
    term.feed(CTRL_C);
    await tick();
    expect(read().state).toBe("pending");

    term.flush();
    await tick();

    expect(read()).toEqual({ state: "resolved", value: null });
    expect(term.vt.screen()).toBe("tick\n> abc");
  });

  test("접두가 있는 재그리기 중 취소 가능한 Ctrl+C는 콜백 뒤 null로 끝나고 접두·입력·다음 출력이 겹치지 않는다", async () => {
    const { term, readline } = setup();
    const read = observe(readline.read("> ", { cancelable: true }));
    term.type("abc");
    term.asyncWrite = true;

    void readline.printAboveRaw("out\n", "tick");
    term.feed(CTRL_C);
    await tick();
    // 콜백 전: 키는 큐에 있고 읽기는 살아 있다.
    expect(read().state).toBe("pending");
    expect(readline.hasQueuedInput()).toBe(true);

    term.flush();
    await tick();

    expect(read()).toEqual({ state: "resolved", value: null });
    expect(term.vt.screen()).toBe("out\ntick> abc");
    expect(term.vt.cursor()).toEqual([2, 0]);
    term.asyncWrite = false;
    readline.write("Traceback");
    expect(term.vt.screen()).toBe("out\ntick> abc\nTraceback");
  });

  test("감긴 입력 첫 행 커서에서 접두가 있는 재그리기 중 취소 가능한 Ctrl+C는 입력 전체를 남기고 그 아래 행 머리로 간다", async () => {
    const { term, readline } = setup();
    const read = observe(readline.read("> ", { cancelable: true }));
    // cols 20: "tick> " + 30자는 두 행으로 감긴다.
    term.type("abcdefghijklmnopqrstuvwxyz0123");
    term.feed("\x1b[H");
    term.asyncWrite = true;

    void readline.printAboveRaw("out\n", "tick");
    term.feed(CTRL_C);
    term.flush();
    await tick();

    expect(read()).toEqual({ state: "resolved", value: null });
    expect(term.vt.screen()).toBe(
      "out\ntick> abcdefghijklmn\nopqrstuvwxyz0123",
    );
    expect(term.vt.cursor()).toEqual([3, 0]);
    term.asyncWrite = false;
    readline.write("Traceback");
    expect(term.vt.screen()).toBe(
      "out\ntick> abcdefghijklmn\nopqrstuvwxyz0123\nTraceback",
    );
  });

  test("재그리기 대기 중 takeRead는 지우지 않고 텍스트·처음 커서를 돌려주며 늦은 콜백은 그리지 않는다", async () => {
    const { term, readline } = setup();
    void readline.read("> ").catch(() => {});
    term.type("abc");
    term.feed(ARROW_LEFT);
    term.asyncWrite = true;
    const printed = observe(readline.printAboveRaw("tick\n", "p"));
    const cursorYReads = term.cursorYReads;

    // 브리지는 takeRead 직전에 접두를 읽는다.
    expect(readline.abovePrefix()).toBe("p");
    const taken = readline.takeRead();
    expect(taken).toEqual({ text: "abc", cursor: 2 });
    expect(readline.abovePrefix()).toBe("");

    term.flush();
    await tick();

    // 입력줄·접두는 화면에 없다(출력만 남는다).
    expect(term.vt.screen()).toBe("tick");
    expect(term.vt.cursor()).toEqual([1, 0]);
    expect(term.cursorYReads).toBe(cursorYReads);
    expect(printed().state).toBe("resolved");

    term.asyncWrite = false;
    const next = readline.read("> ");
    term.type("Q");
    term.feed(ENTER);
    await expect(next).resolves.toBe("Q");
    expect(term.vt.screen()).toBe("tick\n> Q");
  });

  test("다시 그린 뒤 takeRead는 접두째 입력줄을 지운다", () => {
    const { term, readline } = setup();
    readline.println("out");
    void readline.read("> ").catch(() => {});
    term.type("abc");
    void readline.printAboveRaw("", "tick");
    expect(term.vt.screen()).toBe("out\ntick> abc");

    expect(readline.takeRead()).toEqual({ text: "abc", cursor: 3 });

    expect(term.vt.screen()).toBe("out");
    expect(term.vt.cursor()).toEqual([1, 0]);
  });

  test("cancelRead 뒤 늦은 콜백은 새 읽기의 재그리기를 앞당겨 끝내지 않는다", () => {
    const { term, readline } = setup();
    void readline.read("> ").catch(() => {});
    term.type("abc");
    term.asyncWrite = true;
    void readline.printAboveRaw("t1\n", "");
    readline.cancelRead();

    // 새 읽기는 동기로 그리고, 그 읽기의 재그리기 콜백은 옛 콜백 뒤에 쌓인다.
    term.asyncWrite = false;
    void readline.read("> ");
    term.type("xy");
    term.asyncWrite = true;
    void readline.printAboveRaw("t2\n", "");
    term.type("Z");

    // 옛 콜백: 새 재그리기가 끝나지 않았으므로 Z는 아직 큐에 있다.
    term.flushOne();
    expect(readline.getLine()).toBe("xy");

    term.flushOne();
    expect(readline.getLine()).toBe("xyZ");
    expect(term.vt.screen()).toBe("t1\nt2\n> xyZ");
  });

  test("dispose 뒤 늦은 콜백은 버퍼를 읽지 않고 프로미스는 resolve된다", async () => {
    const { term, readline } = setup();
    void readline.read("> ").catch(() => {});
    term.type("abc");
    term.asyncWrite = true;
    const printed = observe(readline.printAboveRaw("tick\n", "p"));
    const cursorYReads = term.cursorYReads;

    readline.dispose();
    term.flush();
    await tick();

    expect(term.cursorYReads).toBe(cursorYReads);
    expect(printed().state).toBe("resolved");
  });
});

/**
 * 재그리기 대기 중(입력줄이 화면에 없다) 공개 편집 API.
 * Tab 완성 삽입(`tab-reader.ts`의 `applyResume` → `editInsert`)이 배경 출력 재그리기 콜백보다 먼저 오면
 * 편집은 버퍼에만 들어간다. 콜백은 편집 뒤 커서로 다시 그린다.
 */
describe("재그리기 대기 중 공개 편집 API", () => {
  test("printAboveRaw 콜백 전 editInsert(Tab 완성 삽입)는 콜백 뒤 커서가 삽입 끝이다", () => {
    const { term, readline } = setup();
    void readline.read(">>> ");
    term.type("imp");
    term.asyncWrite = true;
    void readline.printAboveRaw("tick\n", "");

    readline.editInsert("ort");
    term.flush();

    expect(readline.getLine()).toBe("import");
    expect(readline.getCursor()).toBe(6);
    expect(term.vt.screen()).toBe("tick\n>>> import");
    expect(term.vt.cursor()).toEqual([1, 10]);
    term.type(" os");
    expect(readline.getLine()).toBe("import os");
  });

  test("재그리기 대기 중 editInsert·editBackspace·updateLine은 화면에 아무것도 쓰지 않는다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    term.asyncWrite = true;
    void readline.printAboveRaw("tick\n", "");
    term.log = [];

    readline.editInsert("d");
    readline.editBackspace(1);
    readline.updateLine("xy");

    // 실제 xterm은 콜백 시점에 그 앞 쓰기까지만 반영한다.
    // 여기서 쓴 바이트는 콜백이 읽는 앵커 뒤에 놓여 화면이 어긋난다.
    expect(term.bytes()).toBe("");
    term.flush();
    expect(term.vt.screen()).toBe("tick\n> xy");
  });

  test("감긴 입력 가운데 커서에서 콜백 전 editInsert는 그 자리에 들어가고 커서는 삽입 뒤다", () => {
    const { term, readline } = setup(10, 10);
    void readline.read("> ");
    term.type("abcdefghijk");
    for (let i = 0; i < 3; i++) term.feed(ARROW_LEFT);
    term.asyncWrite = true;
    void readline.printAboveRaw("t\n", "");

    readline.editInsert("Z");
    term.flush();

    expect(readline.getLine()).toBe("abcdefghZijk");
    expect(readline.getCursor()).toBe(9);
    expect(term.vt.screen()).toBe("t\n> abcdefgh\nZijk");
    expect(term.vt.cursor()).toEqual([2, 1]);
  });

  test("콜백 전 editBackspace는 커서 앞 글자를 지우고 커서는 지운 자리다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    term.asyncWrite = true;
    void readline.printAboveRaw("tick\n", "");

    readline.editBackspace(1);
    term.flush();

    expect(readline.getLine()).toBe("ab");
    expect(readline.getCursor()).toBe(2);
    expect(term.vt.screen()).toBe("tick\n> ab");
    expect(term.vt.cursor()).toEqual([1, 4]);
  });

  test("콜백 전 updateLine은 버퍼를 바꾸고 커서는 끝이다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    term.feed(ARROW_LEFT);
    term.asyncWrite = true;
    void readline.printAboveRaw("tick\n", "");

    readline.updateLine("xyz12");
    term.flush();

    expect(readline.getLine()).toBe("xyz12");
    expect(readline.getCursor()).toBe(5);
    expect(term.vt.screen()).toBe("tick\n> xyz12");
  });

  test("Tab printAbove 재그리기 대기 중 editInsert는 끝이 아니라 처음 커서 자리에 들어간다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    term.feed(ARROW_LEFT);
    term.asyncWrite = true;
    void readline.printAbove("A");

    readline.editInsert("Z");
    term.flush();

    expect(readline.getLine()).toBe("abZc");
    expect(readline.getCursor()).toBe(3);
    expect(term.vt.screen()).toBe("> abc\nA\n> abZc");
    expect(term.vt.cursor()).toEqual([2, 5]);
  });

  // Up의 history 이동 여부(편집 모드)는 평상시 편집과 같다: editInsert·editBackspace는 편집 모드를 켜고 updateLine은 끈다.
  test.each([
    {
      name: "editInsert는 편집 모드를 켜 Up이 history로 가지 않는다",
      edit: (readline: Readline) => readline.editInsert("x"),
      typed: "",
      expected: "h2x",
    },
    {
      name: "editBackspace는 편집 모드를 켜 Up이 history로 가지 않는다",
      edit: (readline: Readline) => readline.editBackspace(1),
      typed: "",
      expected: "h",
    },
    {
      name: "updateLine은 편집 모드를 꺼 Up이 history로 간다",
      edit: (readline: Readline) => readline.updateLine("q"),
      typed: "x",
      expected: "h1",
    },
  ])("콜백 전 $name", ({ edit, typed, expected }) => {
    const { term, readline } = setup();
    readline.appendHistory("h1");
    readline.appendHistory("h2");
    void readline.read("> ");
    term.feed(ARROW_UP);
    term.type(typed);
    term.asyncWrite = true;
    void readline.printAboveRaw("tick\n", "");

    edit(readline);
    term.flush();
    term.feed(ARROW_UP);

    expect(readline.getLine()).toBe(expected);
  });

  test("Tab printAbove 재그리기 대기 중 editBackspace는 끝이 아니라 처음 커서 앞 글자를 지운다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    term.feed(ARROW_LEFT);
    term.asyncWrite = true;
    void readline.printAbove("A");

    readline.editBackspace(1);
    term.flush();

    expect(readline.getLine()).toBe("ac");
    expect(readline.getCursor()).toBe(1);
    expect(term.vt.screen()).toBe("> abc\nA\n> ac");
  });

  test("Tab printAbove 재그리기 대기 중 getCursor는 끝이 아니라 편집이 들어갈 처음 커서를 돌려준다", () => {
    // 호출자(tab-reader 경합 판정)는 getCursor로 본 자리에 editInsert가 들어간다고 가정한다.
    // 둘이 같은 커서를 봐야 한다.
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    term.feed(ARROW_LEFT);
    term.asyncWrite = true;
    void readline.printAbove("A");

    expect(readline.getCursor()).toBe(2);
    readline.editInsert("Z");
    expect(readline.getCursor()).toBe(3);
    term.flush();
    expect(readline.getCursor()).toBe(3);
  });

  test("콜백 전 편집 뒤 takeRead는 편집 뒤 텍스트·커서를 돌려준다", () => {
    const { term, readline } = setup();
    void readline.read("> ").catch(() => {});
    term.type("abc");
    term.feed(ARROW_LEFT);
    term.asyncWrite = true;
    void readline.printAboveRaw("tick\n", "");

    readline.editInsert("Z");

    expect(readline.takeRead()).toEqual({ text: "abZc", cursor: 3 });
  });
});

describe("printAboveRaw 읽기 밖", () => {
  test("열린 읽기가 없으면 완성 행과 접두를 그대로 쓰고 바로 resolve한다", async () => {
    const { term, readline } = setup();

    const printed = observe(readline.printAboveRaw("tick\n", "p"));
    await tick();

    expect(term.vt.screen()).toBe("tick\np");
    expect(printed().state).toBe("resolved");
  });

  test("write 콜백 전 읽기(그리기 전)에는 지우지 않고 그대로 쓴다", () => {
    const { term, readline } = setup();
    term.asyncWrite = true;
    void readline.read("> ").catch(() => {});

    void readline.printAboveRaw("tick\n", "");

    expect(readline.isReading()).toBe(false);
    term.flush();
    expect(term.vt.screen()).toBe("tick\n>");
  });
});

describe("Tab printAbove와 접두", () => {
  test("접두가 있으면 옛 행에 남기고 새 입력행은 접두 없이 그린다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    void readline.printAboveRaw("", "tick");

    void readline.printAbove("LIST");

    expect(term.vt.screen()).toBe("tick> abc\nLIST\n> abc");
    expect(readline.abovePrefix()).toBe("");

    // 뒤이은 조각은 별도 행이 된다.
    void readline.printAboveRaw(" tock\n", "");
    expect(term.vt.screen()).toBe("tick> abc\nLIST\n tock\n> abc");
  });

  test("커서가 줄 중간이어도 끝으로 옮겨 그린 옛 행에 접두가 남는다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    term.feed(ARROW_LEFT);
    void readline.printAboveRaw("", "tick");

    void readline.printAbove("LIST");

    expect(term.vt.screen()).toBe("tick> abc\nLIST\n> abc");
    expect(readline.getCursor()).toBe(2);
    expect(term.vt.cursor()).toEqual([2, 4]);
  });

  test("printAboveRaw 재그리기 대기 중 printAbove: 그려지지 않은 접두는 자기 행으로 남기고 빈 행 없이 목록을 쓴다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    term.feed(ARROW_LEFT);
    term.asyncWrite = true;

    void readline.printAboveRaw("t1\n", "tick");
    void readline.printAbove("A");
    term.flush();

    expect(term.vt.screen()).toBe("t1\ntick\nA\n> abc");
    expect(readline.getCursor()).toBe(2);
    expect(term.vt.cursor()).toEqual([3, 4]);
    expect(readline.abovePrefix()).toBe("");
  });

  test("printAboveRaw 재그리기 대기 중 printAbove: 접두가 없으면 출력 바로 아래에 목록을 쓴다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    term.asyncWrite = true;

    void readline.printAboveRaw("t1\n", "");
    void readline.printAbove("A");
    term.flush();

    expect(term.vt.screen()).toBe("t1\nA\n> abc");
  });

  test("printAbove 재그리기 대기 중 printAboveRaw는 목록을 지우지 않고 그 아래에 쓴다(감긴 입력)", () => {
    const { term, readline } = setup(8, 10);
    void readline.read("> ");
    term.type("abcdefghij");
    for (let i = 0; i < 8; i++) term.feed(ARROW_LEFT);
    expect(readline.getCursor()).toBe(2);
    term.asyncWrite = true;

    void readline.printAbove("A");
    void readline.printAboveRaw("t1\n", "p");
    term.flush();

    expect(term.vt.screen()).toBe("> abcdef\nghij\nA\nt1\np> abcde\nfghij");
    expect(readline.getCursor()).toBe(2);
    expect(readline.abovePrefix()).toBe("p");
  });

  // 저장 커서는 처음 값 하나다(`docs/design/06-editing.md` 6.1 "저장 커서").
  test("겹친 printAbove 두 번 뒤에도 커서는 처음 위치다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("abc");
    term.feed(ARROW_LEFT);
    term.asyncWrite = true;

    void readline.printAbove("A");
    void readline.printAbove("B");
    term.flushOne();
    term.flushOne();

    expect(readline.getCursor()).toBe(2);
    expect(term.vt.screen()).toBe("> abc\nA\nB\n> abc");
    expect(term.vt.cursor()).toEqual([3, 4]);
  });
});

describe("접두의 CSI 사설 시퀀스 폭(결함 15)", () => {
  test("커서 숨김 접두 `\\x1b[?25l50%`는 폭 3으로 계산해 커서가 실제 글자 끝이다", () => {
    const { term, readline } = setup(40, 8);
    void readline.read("> ");
    term.type("abc");

    void readline.printAboveRaw("", "\x1b[?25l50%");

    expect(term.vt.screen()).toBe("50%> abc");
    expect(term.vt.cursor()).toEqual([0, 8]);
    expect(readline.getCursor()).toBe(3);

    // 뒤이은 편집 재그리기도 같은 폭으로 커서를 놓는다.
    term.feed(BACKSPACE);
    expect(term.vt.screen()).toBe("50%> ab");
    expect(term.vt.cursor()).toEqual([0, 7]);
  });

  test("커서 표시·자동 줄바꿈 켜기 접두는 폭 0으로 계산한다", () => {
    const { term, readline } = setup(40, 8);
    void readline.read("> ");
    term.type("abc");

    void readline.printAboveRaw("", "x\x1b[?25h\x1b[?7hy");

    expect(term.vt.screen()).toBe("xy> abc");
    expect(term.vt.cursor()).toEqual([0, 7]);
  });
});

describe("재그리기 대기 중 리사이즈(결함 10)", () => {
  test("재그리기 콜백 전 리사이즈가 입력줄을 먼저 그리지 않아 입력줄이 한 번만 남고 커서가 원래 자리다", () => {
    const { term, readline } = setup(10, 8);
    void readline.read("> ");
    term.type("abcdefghijkl");
    expect(readline.getCursor()).toBe(12);

    term.asyncWrite = true;
    void readline.printAboveRaw("t\n", "");
    // 콜백을 기다리는 동안 창 크기 이벤트가 온다. 입력줄은 아직 화면에 없어야 한다.
    term.resize(10, 9);
    expect(term.vt.screen()).toBe("t");
    term.flush();

    expect(term.vt.screen()).toBe("t\n> abcdefgh\nijkl");
    expect(count(term.vt.screen(), "> abcdefgh")).toBe(1);
    expect(readline.getCursor()).toBe(12);
    expect(term.vt.cursor()).toEqual([2, 4]);
  });

  test("재그리기 대기 중 열 수가 바뀌면 콜백이 새 열 수로 입력줄을 한 번 그린다", () => {
    const { term, readline } = setup(10, 8);
    void readline.read("> ");
    term.type("abcdefghijkl");
    term.feed(ARROW_LEFT);

    term.asyncWrite = true;
    void readline.printAboveRaw("t\n", "");
    term.resize(20, 8);
    expect(term.vt.screen()).toBe("t");
    term.flush();

    expect(term.vt.screen()).toBe("t\n> abcdefghijkl");
    expect(count(term.vt.screen(), "> abcdefgh")).toBe(1);
    expect(readline.getCursor()).toBe(11);
    expect(term.vt.cursor()).toEqual([1, 13]);
  });

  test("재그리기 중이 아니면 리사이즈는 지금처럼 입력줄을 새 크기로 다시 그린다", () => {
    const { term, readline } = setup(10, 8);
    void readline.read("> ");
    term.type("abcdefghijkl");

    term.resize(20, 8);

    expect(term.vt.screen()).toBe("> abcdefghijkl");
    expect(term.vt.cursor()).toEqual([0, 14]);
  });
});

describe("hasQueuedInput(결함 16)", () => {
  test("재그리기 대기 중 키가 큐에 쌓이면 true이고 콜백이 재생한 뒤에는 false다", () => {
    const { term, readline } = setup();
    void readline.read("> ");
    term.type("imp");

    term.asyncWrite = true;
    void readline.printAboveRaw("t\n", "");
    // 재그리기를 기다리는 동안이라도 친 키가 없으면 큐는 비어 있다.
    expect(readline.hasQueuedInput()).toBe(false);

    term.feed("x");
    expect(readline.hasQueuedInput()).toBe(true);
    // 큐의 키는 버퍼에 아직 없다(경합 판정이 버퍼 비교만으로는 못 보는 이유).
    expect(readline.getLine()).toBe("imp");

    term.flush();
    expect(readline.hasQueuedInput()).toBe(false);
    expect(readline.getLine()).toBe("impx");
  });

  test("붙여넣기 덩어리와 Enter도 큐에 쌓인 입력으로 센다", () => {
    const { term, readline } = setup();
    void readline.read("> ").catch(() => {});
    term.asyncWrite = true;
    void readline.printAboveRaw("t\n", "");

    term.feed("\r");
    expect(readline.hasQueuedInput()).toBe(true);
    term.flush();
    expect(readline.hasQueuedInput()).toBe(false);
  });

  test("재그리기 중이 아니면 false다(읽기 전·읽는 중·재그리기 뒤)", () => {
    const { term, readline } = setup();
    expect(readline.hasQueuedInput()).toBe(false);

    void readline.read("> ");
    term.type("ab");
    expect(readline.hasQueuedInput()).toBe(false);

    term.asyncWrite = true;
    void readline.printAboveRaw("t\n", "");
    term.flush();
    term.type("c");
    expect(readline.hasQueuedInput()).toBe(false);
  });

  test("읽기 밖 type-ahead 버퍼의 키는 큐가 아니라서 false다", () => {
    const { term, readline } = setup();
    term.type("abc");
    expect(readline.hasQueuedInput()).toBe(false);

    void readline.read("> ");
    expect(readline.hasQueuedInput()).toBe(false);
    expect(readline.getLine()).toBe("abc");
  });

  test("재그리기 대기 중 cancelRead·takeRead가 큐를 비우면 false다", () => {
    {
      const { term, readline } = setup();
      void readline.read("> ").catch(() => {});
      term.asyncWrite = true;
      void readline.printAboveRaw("t\n", "");
      term.feed("x");
      expect(readline.hasQueuedInput()).toBe(true);
      readline.cancelRead();
      expect(readline.hasQueuedInput()).toBe(false);
    }
    {
      const { term, readline } = setup();
      void readline.read("> ").catch(() => {});
      term.asyncWrite = true;
      void readline.printAboveRaw("t\n", "");
      term.feed("x");
      expect(readline.hasQueuedInput()).toBe(true);
      readline.takeRead();
      expect(readline.hasQueuedInput()).toBe(false);
    }
  });
});

// 재그리기 콜백 전에 취소하면 아직 그리지 않은 접두가 사라질 수 있다.
// 미그림 접두 판정은 private이라 `cancelRead({ settle: true })`의 공개 동작(쓰는 바이트·화면)으로 본다.
// 콜백 전 접두 재출력은 `cancel-settle.test.ts`가 맡는다.
describe("아직 그리지 않은 접두와 settle 취소", () => {
  test("콜백 전에는 접두가 화면에 없고, 콜백 뒤 settle 취소는 이미 그린 접두를 다시 쓰지 않는다", () => {
    const { term, readline } = setup();
    void readline.read("> ").catch(() => {});
    term.type("abc");
    term.asyncWrite = true;
    void readline.printAboveRaw("", "tick");
    expect(term.vt.screen()).not.toContain("tick");

    term.flush();
    // 접두는 프롬프트 행에 그려졌다(`abovePrefix()`는 그대로). 취소가 접두를 자기 행으로 다시 쓰면 중복된다.
    expect(term.vt.screen()).toContain("tick> abc");
    expect(readline.abovePrefix()).toBe("tick");

    expect(readline.cancelRead({ settle: true })).toBe(true);
    readline.write("Traceback");
    expect(term.vt.screen()).toBe("tick> abc\nTraceback");
  });

  test("접두 없는 재그리기 대기·열린 읽기 없음에서 settle 취소는 아무것도 쓰지 않는다", () => {
    const { term, readline } = setup();
    const idle = term.bytes();
    expect(readline.cancelRead({ settle: true })).toBe(false);
    expect(term.bytes()).toBe(idle);

    void readline.read("> ").catch(() => {});
    term.type("abc");
    term.asyncWrite = true;
    void readline.printAboveRaw("t\n", "");
    const waiting = term.bytes();
    expect(readline.cancelRead({ settle: true })).toBe(true);
    expect(term.bytes()).toBe(waiting);
  });

  test("재그리기 대기 중 cancelRead()는 화면에 쓰지 않고 이후 settle 취소도 접두를 쓰지 않는다", () => {
    const { term, readline } = setup();
    void readline.read("> ").catch(() => {});
    term.type("abc");
    term.asyncWrite = true;
    void readline.printAboveRaw("", "tick");
    const before = term.bytes();

    readline.cancelRead();
    term.flush();

    expect(term.bytes()).toBe(before);
    expect(readline.cancelRead({ settle: true })).toBe(false);
    expect(term.bytes()).toBe(before);
  });
});
