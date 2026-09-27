// @vitest-environment node
/**
 * RPC 시험(01-protocols.md 1절). 실제 MessageChannel 두 포트 사이에서 돈다 — 구조적 복제와 비동기 전달까지 그대로 본다.
 */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createRpc } from "../../src/protocol/rpc";

type Handlers = NonNullable<Parameters<typeof createRpc>[1]>;

/** 실제 MessageChannel 양단에 RPC를 하나씩 붙인다. 시험이 끝나면 둘 다 닫는다. */
function connect(aHandlers: Handlers = {}, bHandlers: Handlers = {}) {
  const { port1, port2 } = new MessageChannel();
  const a = createRpc(port1, aHandlers);
  const b = createRpc(port2, bHandlers);
  onTestFinished(() => {
    a.dispose();
    b.dispose();
  });
  return { a, b };
}

describe("요청/응답", () => {
  it("상대 핸들러의 결과를 돌려받는다", async () => {
    const { a } = connect({}, { add: (x: number, y: number) => x + y });

    await expect(a.call("add", 1, 2)).resolves.toBe(3);
  });

  it("null 결과를 null 그대로 전달한다", async () => {
    const { a } = connect({}, { cancel: () => null });

    await expect(a.call("cancel")).resolves.toBeNull();
  });

  it("undefined 인자를 자리 그대로 보존한다", async () => {
    // readLine(prompt, pending, cancelable)의 pending은 string | undefined다.
    const { a } = connect({}, { readLine: (...args: unknown[]) => args });

    await expect(a.call("readLine", ">>> ", undefined, true)).resolves.toEqual([
      ">>> ",
      undefined,
      true,
    ]);
  });

  it("객체 결과를 구조적 복제로 전달한다", async () => {
    const { a } = connect(
      {},
      { complete: () => ({ completions: ["path", "pathsep"], start: 3 }) },
    );

    await expect(a.call("complete", "os.pa", undefined)).resolves.toEqual({
      completions: ["path", "pathsep"],
      start: 3,
    });
  });

  it("비동기 핸들러가 끝날 때까지 기다리고, 그동안 반대 방향 요청도 처리한다", async () => {
    let release: (line: string) => void = () => {};
    const { a, b } = connect(
      { complete: (source: string) => `${source}!` },
      { readLine: () => new Promise<string>((resolve) => (release = resolve)) },
    );

    const line = a.call<string>("readLine");
    // readLine이 끝나지 않은 채로 b가 a의 핸들러를 부른다. 동기 브리지에서는 막히던 방향이다.
    await expect(b.call("complete", "os.pa")).resolves.toBe("os.pa!");
    release("print(1)");

    await expect(line).resolves.toBe("print(1)");
  });

  // 양쪽이 독립 카운터로 id를 1부터 매긴다. res는 요청을 보낸 쪽에서만 해석하므로 같은 id가 겹쳐도 섞이지 않는다.
  it("양쪽이 동시에 보낸 요청이 같은 id를 써도 응답이 섞이지 않는다", async () => {
    const { a, b } = connect(
      {
        fromB: () =>
          new Promise((resolve) => setTimeout(() => resolve("a가 답함"), 10)),
      },
      { fromA: async () => "b가 답함" },
    );

    const [resultOfA, resultOfB] = await Promise.all([
      a.call("fromA"),
      b.call("fromB"),
    ]);

    expect(resultOfA).toBe("b가 답함");
    expect(resultOfB).toBe("a가 답함");
  });
});

describe("오류 응답", () => {
  // 오류는 ok:false + 던진 값의 String()으로 간다. 받는 쪽은 그 문자열을 message로 하는 Error로 reject한다.
  it("핸들러가 던지면 던진 값의 String()으로 reject한다", async () => {
    const { a } = connect(
      {},
      {
        boom: () => {
          throw new Error("실패");
        },
      },
    );

    await expect(a.call("boom")).rejects.toMatchObject({
      message: "Error: 실패",
    });
  });

  it("문자열을 던져도 그 문자열로 reject한다", async () => {
    const { a } = connect(
      {},
      {
        boom: () => {
          throw "문자열 예외";
        },
      },
    );

    await expect(a.call("boom")).rejects.toMatchObject({
      message: "문자열 예외",
    });
  });

  it("비동기 핸들러가 reject해도 같다", async () => {
    const { a } = connect(
      {},
      {
        boom: async () => {
          throw new Error("늦은 실패");
        },
      },
    );

    await expect(a.call("boom")).rejects.toMatchObject({
      message: "Error: 늦은 실패",
    });
  });

  it("예외 뒤에도 후속 요청을 정상 처리한다", async () => {
    const { a } = connect(
      {},
      {
        boom: () => {
          throw new Error("실패");
        },
        ok: () => "정상",
      },
    );

    await expect(a.call("boom")).rejects.toThrow();

    await expect(a.call("ok")).resolves.toBe("정상");
  });

  it("없는 메서드는 unknown method <name>으로 reject한다", async () => {
    const { a } = connect();

    await expect(a.call("없음")).rejects.toMatchObject({
      message: "unknown method 없음",
    });
  });

  // 핸들러 표는 own 속성만 본다. Object.prototype의 이름이 상대가 부르는 대로 실행되면 안 된다.
  it("객체 프로토타입에 있는 이름도 없는 메서드로 답한다", async () => {
    const { a } = connect();

    await expect(a.call("toString")).rejects.toMatchObject({
      message: "unknown method toString",
    });
    await expect(a.call("constructor")).rejects.toMatchObject({
      message: "unknown method constructor",
    });
  });
});

describe("알림", () => {
  it("응답 없이 상대 핸들러를 부른다", async () => {
    const received: unknown[][] = [];
    const { a } = connect(
      {},
      {
        write: (...args: unknown[]) => void received.push(args),
        ping: () => "pong",
      },
    );

    a.notify("write", "x: ", 1);
    // 같은 포트는 FIFO라 뒤따른 요청의 응답이 오면 앞선 알림은 이미 처리됐다.
    await a.call("ping");

    expect(received).toEqual([["x: ", 1]]);
  });

  // 같은 포트를 타는 메시지는 보낸 순서대로 도착하고 핸들러도 그 순서로 시작한다. `input("x: ")`의 `x: ` 꼬리가 읽기 요청보다
  // 먼저 화면에 닿는 규칙(01-protocols.md 1.3)이 여기에 기댄다.
  it("알림과 요청의 핸들러를 보낸 순서대로 시작한다", async () => {
    const log: string[] = [];
    // readLine은 readInput 알림이 풀어줄 때까지 끝나지 않는다. 마이크로태스크는 메시지 사이에 비워지므로 이렇게 잡아야
    // "시작 순서"만 결정적으로 관찰된다.
    let releaseReadLine: () => void = () => {};
    const { a } = connect(
      {},
      {
        write: (text: string) => void log.push(`write:${text}`),
        readInput: () => {
          log.push("readInput");
          releaseReadLine();
        },
        readLine: async () => {
          log.push("readLine 시작");
          await new Promise<void>((resolve) => (releaseReadLine = resolve));
          log.push("readLine 끝");
        },
      },
    );

    a.notify("write", "x: ");
    const line = a.call("readLine");
    a.notify("readInput");
    await line;

    expect(log).toEqual([
      "write:x: ",
      "readLine 시작",
      "readInput",
      "readLine 끝",
    ]);
  });

  it("없는 알림은 버리고 이후 메시지를 계속 처리한다", async () => {
    const { a } = connect({}, { ping: () => "pong" });

    a.notify("없음");

    await expect(a.call("ping")).resolves.toBe("pong");
  });

  // 알림에는 응답 통로가 없다. 핸들러 예외를 처리되지 않은 rejection으로 흘리면 worker에서는 pageerror가 된다.
  it("알림 핸들러가 던지면 console.error로 남기고 이후 메시지를 계속 처리한다", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => error.mockRestore());
    const { a } = connect(
      {},
      {
        syncBoom: () => {
          throw new Error("동기 실패");
        },
        asyncBoom: async () => {
          throw new Error("비동기 실패");
        },
        ping: () => "pong",
      },
    );

    a.notify("syncBoom");
    a.notify("asyncBoom");

    await expect(a.call("ping")).resolves.toBe("pong");
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls.map((call) => call[1])).toEqual([
      "syncBoom",
      "asyncBoom",
    ]);
  });
});

describe("dispose", () => {
  it("대기 중인 요청을 모두 rpc disposed로 reject한다", async () => {
    const { a } = connect({}, { never: () => new Promise(() => {}) });
    const first = a.call("never");
    const second = a.call("never");

    a.dispose();

    await expect(first).rejects.toThrow("rpc disposed");
    await expect(second).rejects.toThrow("rpc disposed");
  });

  it("두 번 불러도 안전하다", async () => {
    const { a } = connect({}, { never: () => new Promise(() => {}) });
    const pending = a.call("never");

    a.dispose();

    expect(() => a.dispose()).not.toThrow();
    await expect(pending).rejects.toThrow("rpc disposed");
  });

  // 닫힌 포트에 보낸 요청은 응답이 영영 오지 않는다. 멈추지 않고 바로 reject해야 한다.
  it("dispose 뒤의 call은 바로 rpc disposed로 reject한다", async () => {
    const { a } = connect({}, { ping: () => "pong" });

    a.dispose();

    await expect(a.call("ping")).rejects.toThrow("rpc disposed");
  });

  it("포트를 닫아 상대 포트가 close를 받는다", async () => {
    const { port1, port2 } = new MessageChannel();
    // Node의 MessagePort는 EventTarget이고 상대가 닫으면 close 이벤트를 낸다.
    const peerClosed = new Promise<void>((resolve) =>
      (port2 as EventTarget).addEventListener("close", () => resolve()),
    );
    const rpc = createRpc(port1);
    onTestFinished(() => port2.close());

    rpc.dispose();

    await peerClosed;
  });
});
