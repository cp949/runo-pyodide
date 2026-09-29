/**
 * `ReplHandle.runSource(code)`·`busy` 시험(RD-022a). 계약은 `docs/design/02-console-core.md` 5.6이다.
 *
 * 조립:
 * - 실제 `Readline` + 가짜 터미널 + 가짜 worker다. 가짜 터미널에 화면을 해석하는 `VtScreen`을 물린다.
 * - worker 역할 rpc가 `readLine`을 요청한다.
 * - main이 줄 대신 `{ source }`로 응답하면 worker가 코드를 실행한 것처럼 출력을 알린다.
 * - 결말은 다음 `readLine` 요청의 네 번째 인자로 싣는다.
 * - 세션 조립·정리는 하니스(`./harness`)의 `startResettableSession`·`useReplHarness`를 쓴다(RD-041).
 * - 이 파일의 `startSession`은 그 위에 화면(`VtScreen`)과 도우미(`request`·`output`·`pump` 등)만 얹는다.
 *
 * 다른 시험이 맡는 범위: 실제 pyodide 왕복은 `worker/run-source.test.ts`와 브라우저 확인이 맡는다.
 *
 * 파일 구성(위에서 아래):
 * 1. 화면·정착: 치던 줄 보존, 복원, history 제외, 결말 종류(5.6.3·5.6.4).
 * 2. 실행 중 키: Ctrl+C, `input()`(5.6.5).
 * 3. 대기·생애 사건: `loading` 대기, `reset()`·크래시·`dispose()`(5.6.2).
 * 4. 거부 표와 `busy` 게터(5.6.2).
 * 5. 정착·정리 경계: write를 차례로 처리하는 모델, worker 생성 실패.
 * 6. 배경 출력(RD-022b), `reset()`의 접두 복원, 감긴 입력·꼬리의 `reset()`.
 * 7. Tab 완성 응답과 배경 출력 재그리기의 겹침.
 * 8. 소비자 콜백 예외 격리(08-session.md 8.5).
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  RunRejectedError as CoreRunRejectedError,
  type RpcHandlers,
} from "@cp949/runo-pyodide-core";
import { attachVtScreen, VtScreen } from "@repo/pyodide-testkit/vt-screen";
import { RunRejectedError, type RunResult } from "../../src/index";
import type { ReadLineOutcome, ReadLineReply } from "../../src/repl-protocol";
import type { SourceCompletion } from "../../src/worker/complete-source";
import {
  type Outcome,
  echoes,
  flushRequestCount,
  must,
  observe,
  readyPayload,
  settle,
  slotsOf,
  startResettableSession,
  takeResponse,
  tick,
  useReplHarness,
  waitFor,
} from "./harness";

useReplHarness();

/** `startSession` 옵션. */
interface SessionOptions {
  /** 참이면 write 콜백을 `flush()`까지 미루는 옵션(xterm의 비동기 파싱 흉내). */
  asyncWrite?: boolean;

  workerHandlers?: RpcHandlers;

  cols?: number;
}

/** 읽기 요청 하나. `promise`는 main의 응답, `state()`는 그 현재 상태다. */
interface Request {
  promise: Promise<ReadLineReply>;

  state: () => Outcome<ReadLineReply>;
}

/**
 * 이 파일의 세션 조립 도우미. 하니스의 `startResettableSession` 위에 가상 화면과 요청 도우미를 얹는다.
 * 반환 세션이 쥔 손잡이:
 * - `request`: worker 역할로 `readLine`을 요청한다.
 * - `output`: worker가 stdout 조각을 알린다.
 * - `pump`: 미뤄 둔 write 콜백을 배출한다.
 * - `ready`: worker가 `ready`를 알린다.
 */
function startSession(options: SessionOptions = {}) {
  const cols = options.cols ?? 40;
  const onCrash = vi.fn<(message: string) => void>();
  const base = startResettableSession(
    { onCrash },
    { asyncWrite: options.asyncWrite ?? false, cols },
    options.workerHandlers,
  );
  const { fake } = base;
  // 화면을 해석하는 가상 화면을 가짜 터미널의 write 앞에 끼운다.
  // 커서 모델도 함께 갱신한다. `Readline`이 앵커 행으로 읽는다.
  const vt = new VtScreen(cols, 24);
  attachVtScreen(fake, vt);

  const flushCount = () => flushRequestCount(fake);
  const bytes = () => fake.written.join("");
  // 미뤄 둔 write 콜백을 배출하고 마이크로태스크를 지나가게 한다. 콜백이 새 write를 내므로 두 번 돈다.
  const pump = async () => {
    fake.flush();
    await tick();
    fake.flush();
    await tick();
  };

  const session = {
    fake,
    vt,
    handle: base.handle,
    workers: base.workers,
    // 지금까지 받은 상태 콜백 값. `onStatus` 호출 기록에서 읽으므로 시험이 구현을 바꿔도 따라간다.
    get statuses(): string[] {
      return base.onStatus.mock.calls.map(([status]) => status);
    },
    onStatus: base.onStatus,
    onCrash,
    createWorkerSpy: base.createWorkerSpy,
    get rpc() {
      return base.workerRpc;
    },
    get worker() {
      return base.fakeWorker;
    },
    rpcAt: base.workerRpcAt,
    flushCount,
    pump,
    lastStatus: () => base.onStatus.mock.calls.at(-1)?.[0],
    // 마지막 worker가 `ready`를 알린다.
    async ready() {
      session.rpc.notify("ready", readyPayload());
      await waitFor(() => session.lastStatus() === "ready");
    },
    // worker 역할 rpc로 `readLine`을 요청한다.
    // - `outcome`이 있으면 네 번째 인자로 싣는다.
    // - 기본으로 읽기가 그려질 때까지 배출한다.
    // - `draw: false`이면 요청이 도착한 것만 확인하고 write 콜백은 배출하지 않는다.
    async request(
      prompt = ">>> ",
      pending: string | undefined = undefined,
      outcome: ReadLineOutcome | undefined = undefined,
      draw = true,
    ): Promise<Request> {
      const before = flushCount();
      const promise =
        outcome === undefined
          ? session.rpc.call<ReadLineReply>("readLine", prompt, pending, true)
          : session.rpc.call<ReadLineReply>(
              "readLine",
              prompt,
              pending,
              true,
              outcome,
            );
      void promise.catch(() => {});
      const state = observe(promise);
      await Promise.race([
        waitFor(() => flushCount() > before),
        // 읽기를 열지 않고 응답하는 요청(대기 슬롯 실행)이나 거절된 요청은 write를 내지 않는다.
        // 그 경우 요청 promise 정착으로 기다림을 끝낸다.
        promise.then(
          () => undefined,
          () => undefined,
        ),
      ]);
      if (draw) await pump();
      return { promise, state };
    },
    // worker가 stdout 조각을 알리고 화면에 반영될 때까지 기다린다.
    async output(text: string) {
      const before = fake.written.length;
      session.rpc.notify("write", text);
      await waitFor(() => fake.written.length > before);
    },
    // 인터럽트 buffer 슬롯(마지막 worker의 프레임).
    slots(index = base.workers.length - 1) {
      return slotsOf(must(base.workers[index]).frame().interruptBuffer);
    },
    // 마지막 worker의 stdin 메일박스 응답을 받는다(규칙: `docs/design/01-protocols.md` 2.5).
    takeResponse: () => takeResponse(base),
    echoes: () => echoes({ bytes }),
  };
  return session;
}

/** 이 파일 `startSession`이 돌려주는 세션. */
type Session = ReturnType<typeof startSession>;

/** 결과를 기다리지 않는 `runSource` 호출. 시험이 끝나 `dispose()`될 때 거부돼도 처리되지 않은 rejection이 되지 않는다. */
function runQuietly(session: Session, code: string): Promise<RunResult> {
  const run = session.handle.runSource(code);
  run.catch(() => {});
  return run;
}

/** `>>> `에서 입력 중인 상태까지 만든다. 첫 요청을 돌려준다. */
async function openPrompt(session: Session, typed = ""): Promise<Request> {
  await session.ready();
  const request = await session.request();
  if (typed !== "") session.fake.type(typed);
  return request;
}

/** 열린 읽기에서 한 줄을 제출하고 main의 응답을 기다린다. 응답 뒤에는 worker가 실행 중인 상태다. */
async function submit(session: Session, request: Request, line: string) {
  session.fake.type(`${line}\r`);
  await request.promise;
}

beforeEach(() => {
  // `ready` 알림마다 main driver가 남기는 버전 정보 로그를 가린다.
  vi.spyOn(console, "info").mockImplementation(() => {});
});

/** 정상 종료 결말. 다음 `readLine` 요청의 네 번째 인자로 싣는다. */
const OK: ReadLineOutcome = { kind: "ok" };

describe.each([
  { mode: "동기", asyncWrite: false },
  { mode: "비동기", asyncWrite: true },
])("runSource 화면·정착($mode 모드)", ({ asyncWrite }) => {
  test("pri를 치던 중 runSource하면 출력 뒤 >>> pri를 다시 그리고 결말로 resolve한다, 이어 x를 제출할 수 있다", async () => {
    const session = startSession({ asyncWrite });
    const first = await openPrompt(session, "pri");
    expect(session.vt.screen()).toBe(">>> pri");

    // 1단계: runSource가 열린 읽기를 가져간다.
    const run = observe(session.handle.runSource("x = 1\nprint(x)"));
    // main은 열린 읽기의 응답을 줄이 아니라 `{ source }`로 보낸다. 프롬프트 행이 지워진다.
    await expect(first.promise).resolves.toEqual({ source: "x = 1\nprint(x)" });
    await session.pump();
    expect(session.vt.screen()).toBe("");
    expect(session.vt.cursor()).toEqual([0, 0]);

    // 2단계: worker가 출력하고 결말을 실어 다음 읽기를 요청한다. 그 읽기가 그려지면 정착한다.
    await session.output("1\n");
    expect(run().state).toBe("pending");
    const second = await session.request(">>> ", undefined, OK);

    expect(run()).toEqual({ state: "resolved", value: OK });
    expect(session.vt.screen()).toBe("1\n>>> pri");
    expect(session.vt.cursor()).toEqual([1, 7]);

    // 3단계: 복원된 줄은 보통 읽기다. 지우고 x를 제출하면 그 줄이 응답이 된다.
    session.fake.type("\x15x\r");
    await expect(second.promise).resolves.toBe("x");
  });

  test("커서가 입력 중간(p|ri)이면 그 위치에 복원하고, 이어 친 글자가 그 자리에 들어간다", async () => {
    const session = startSession({ asyncWrite });
    const first = await openPrompt(session, "pri");
    session.fake.type("\x1b[D\x1b[D");
    expect(session.vt.cursor()).toEqual([0, 5]);

    runQuietly(session, "print(1)");
    await first.promise;
    await session.output("1\n");
    const second = await session.request(">>> ", undefined, OK);

    expect(session.vt.screen()).toBe("1\n>>> pri");
    expect(session.vt.cursor()).toEqual([1, 5]);
    session.fake.type("X\r");
    await expect(second.promise).resolves.toBe("pXri");
  });

  test("이전 출력의 꼬리가 붙은 프롬프트(a>>> pri)는 꼬리를 남기고 행을 바꿔 출력한다", async () => {
    const session = startSession({ asyncWrite });
    await session.ready();
    await session.output("a");
    const first = await session.request();
    session.fake.type("pri");
    expect(session.vt.screen()).toBe("a>>> pri");

    runQuietly(session, "print(2)");
    await first.promise;
    await session.pump();
    // 꼬리 `a`는 남고 프롬프트·입력 부분만 지워진다.
    // 출력은 새 행에서 시작한다.
    expect(session.vt.screen()).toBe("a");
    expect(session.vt.cursor()).toEqual([1, 0]);

    await session.output("2\n");
    await session.request(">>> ", undefined, OK);
    expect(session.vt.screen()).toBe("a\n2\n>>> pri");
  });

  test("출력이 미종결 줄로 끝나면 다음 프롬프트는 그 꼬리를 이어 그린다(b>>> pri)", async () => {
    const session = startSession({ asyncWrite });
    const first = await openPrompt(session, "pri");

    runQuietly(session, 'print("b", end="")');
    await first.promise;
    await session.output("b");
    await session.request(">>> ", undefined, OK);

    expect(session.vt.screen()).toBe("b>>> pri");
  });

  test("여러 행 입력은 전 행을 지우고 출력한 뒤 같은 모양으로 복원한다", async () => {
    const session = startSession({ asyncWrite });
    const first = await openPrompt(session);
    session.fake.type("pri");
    session.fake.keyDown({ key: "Enter", shiftKey: true });
    session.fake.type("nt");
    const before = session.vt.screen();
    expect(before.split("\n").length).toBe(2);
    const cursorBefore = session.vt.cursor();

    // 여러 행을 전부 지운다.
    runQuietly(session, "print(9)");
    await first.promise;
    await session.pump();
    expect(session.vt.screen()).toBe("");

    await session.output("9\n");
    await session.request(">>> ", undefined, OK);

    expect(session.vt.screen()).toBe(`9\n${before}`);
    expect(session.vt.cursor()).toEqual([cursorBefore[0] + 1, cursorBefore[1]]);
  });

  test("실행 중 친 키는 type-ahead에 쌓였다가 복원된 커서 위치에 재생된다", async () => {
    const session = startSession({ asyncWrite });
    const first = await openPrompt(session, "pri");
    session.fake.type("\x1b[D");

    // 실행 중 친 키는 활성 읽기가 없어 type-ahead에 쌓인다.
    runQuietly(session, "print(1)");
    await first.promise;
    session.fake.type("X");
    await session.output("1\n");
    // 읽기가 열리기 전에는 화면에 에코되지 않는다.
    expect(session.vt.screen()).toBe("1");
    const second = await session.request(">>> ", undefined, OK);

    expect(session.vt.screen()).toBe("1\n>>> prXi");
    session.fake.type("\r");
    await expect(second.promise).resolves.toBe("prXi");
  });

  test("결말이 도착해도 복원한 줄이 그려지기 전에는 resolve하지 않고, resolve 시점에 줄이 이미 화면에 있다", async () => {
    const session = startSession({ asyncWrite });
    const first = await openPrompt(session, "pri");
    let screenAtResolve: string | undefined;
    const run = session.handle.runSource("print(1)").then((result) => {
      screenAtResolve = session.vt.screen();
      return result;
    });
    const state = observe(run);
    await first.promise;
    await session.output("1\n");

    // 읽기 요청은 도착했지만 write 콜백은 배출하지 않는다(그리기 전 창).
    const second = await session.request(">>> ", undefined, OK, false);
    await settle();
    if (asyncWrite) {
      // write 콜백이 아직 오지 않아 프롬프트가 그려지지 않았다.
      expect(state().state).toBe("pending");
      expect(session.vt.screen()).toBe("1");
      await session.pump();
    }
    await settle();

    expect(state()).toEqual({ state: "resolved", value: OK });
    expect(screenAtResolve).toBe("1\n>>> pri");
    void second;
  });

  test("runSource 코드는 history에 남지 않는다: 위 화살표는 그 전에 제출한 줄을 불러온다", async () => {
    const session = startSession({ asyncWrite });
    const one = await openPrompt(session);
    await submit(session, one, "one");
    const two = await session.request();
    session.fake.type("pri");

    runQuietly(session, "secret = 1");
    await two.promise;
    const third = await session.request(">>> ", undefined, OK);
    session.fake.type("\x15\x1b[A\r");

    await expect(third.promise).resolves.toBe("one");
  });

  test("error·interrupted·exit 결말도 값 그대로 resolve하고 세션은 유지되어 프롬프트를 다시 그린다", async () => {
    const outcomes: ReadLineOutcome[] = [
      { kind: "error", errorType: "ZeroDivisionError", traceback: "tb\n" },
      { kind: "interrupted", traceback: "KeyboardInterrupt\n" },
      { kind: "exit", code: 3 },
    ];
    for (const outcome of outcomes) {
      const session = startSession({ asyncWrite });
      const first = await openPrompt(session, "pri");
      const run = observe(session.handle.runSource("code"));
      await first.promise;
      await session.output("out\n");
      const second = await session.request(">>> ", undefined, outcome);

      expect(run()).toEqual({ state: "resolved", value: outcome });
      expect(session.vt.screen()).toBe("out\n>>> pri");
      expect(session.lastStatus()).toBe("ready");
      // 세션이 살아 있어 다음 줄이 평소처럼 제출된다.
      session.fake.type("\r");
      await expect(second.promise).resolves.toBe("pri");
      session.handle.dispose();
    }
  });
});

describe("runSource 실행 중 키", () => {
  test("실행 중 Ctrl+C는 ^C를 에코하고 중단을 보내며 결말 interrupted로 끝난다", async () => {
    const session = startSession();
    const first = await openPrompt(session, "pri");
    const run = observe(session.handle.runSource("while True: pass"));
    await first.promise;
    expect(session.echoes()).toBe(0);

    session.fake.type("\x03");

    expect(session.echoes()).toBe(1);
    expect(session.slots().seq).toBe(1);
    const interrupted: ReadLineOutcome = {
      kind: "interrupted",
      traceback: "KeyboardInterrupt\n",
    };
    await session.request(">>> ", undefined, interrupted);
    expect(run()).toEqual({ state: "resolved", value: interrupted });
  });

  test("실행 중 input()은 stdin 읽기로 답을 받아 메일박스에 전달한다", async () => {
    const session = startSession();
    const first = await openPrompt(session, "pri");
    runQuietly(session, "print(input())");
    await first.promise;

    const before = session.flushCount();
    session.rpc.notify("readInput", true);
    await waitFor(() => session.flushCount() > before);
    await session.pump();
    session.fake.type("abc\r");

    await expect(session.takeResponse()).resolves.toEqual({
      kind: "line",
      text: "abc",
    });
    expect(session.echoes()).toBe(0);
  });
});

describe("runSource 대기·생애 사건", () => {
  test("loading 중 호출은 슬롯을 차지하고 첫 >>> 요청에 { source }로 실행하며, 화면을 지우지 않는다", async () => {
    const session = startSession();
    const run = observe(session.handle.runSource("print(1)"));
    expect(session.handle.busy).toBe(true);
    await expect(session.handle.runSource("print(2)")).rejects.toMatchObject({
      reason: "busy",
    });
    expect(run().state).toBe("pending");

    await session.ready();
    const first = await session.request();
    await expect(first.promise).resolves.toEqual({ source: "print(1)" });
    // 읽기를 열지 않았으므로 프롬프트가 그려지지 않았고 지운 것도 없다.
    expect(session.vt.screen()).toBe("");
    expect(run().state).toBe("pending");

    await session.output("1\n");
    const second = await session.request(">>> ", undefined, OK);
    expect(run()).toEqual({ state: "resolved", value: OK });
    expect(session.vt.screen()).toBe("1\n>>>");
    void second;
    expect(session.handle.busy).toBe(false);
  });

  test("첫 요청 시점에 미종결 꼬리가 있으면 출력 앞에 줄을 바꾼다", async () => {
    const session = startSession();
    runQuietly(session, "print(1)");
    await session.ready();
    await session.output("t");
    const first = await session.request();
    await first.promise;
    await session.output("1\n");

    expect(session.vt.screen()).toBe("t\n1");
  });

  test("대기 중 reset()은 취소하지 않고 새 worker의 첫 >>> 에서 실행한다", async () => {
    const session = startSession();
    const run = observe(session.handle.runSource("print(1)"));

    session.handle.reset();

    expect(session.workers).toHaveLength(2);
    expect(run().state).toBe("pending");
    expect(session.handle.busy).toBe(true);
    await session.ready();
    const first = await session.request();
    await expect(first.promise).resolves.toEqual({ source: "print(1)" });
    await session.request(">>> ", undefined, OK);
    expect(run()).toEqual({ state: "resolved", value: OK });
  });

  test("대기 중 load-failed는 unavailable로 거부한다", async () => {
    const session = startSession();
    const run = session.handle.runSource("print(1)");
    const observed = observe(run);

    session.rpc.notify("loadFailed", "Error: boom");
    await waitFor(() => session.lastStatus() === "load-failed");
    await settle();

    expect(observed().state).toBe("rejected");
    await expect(run).rejects.toMatchObject({ reason: "unavailable" });
    expect(session.handle.busy).toBe(false);
  });

  test("실행 중 reset()은 restarted로 resolve하고 새 세션에서 다시 실행하지 않는다", async () => {
    const session = startSession();
    const first = await openPrompt(session, "pri");
    const run = session.handle.runSource("while True: pass");
    await first.promise;

    session.handle.reset();

    await expect(run).resolves.toEqual({ kind: "restarted" });
    expect(session.handle.busy).toBe(false);
    await session.ready();
    const next = await session.request();
    // 새 세션의 첫 요청은 평소 읽기다. 코드를 다시 보내지 않는다.
    session.fake.type("z\r");
    await expect(next.promise).resolves.toBe("z");
  });

  test("실행 중 크래시는 crashed로 거부하고 크래시 콜백 안에서 busy는 거짓·runSource는 unavailable이다", async () => {
    const session = startSession();
    const first = await openPrompt(session, "pri");
    const run = session.handle.runSource("while True: pass");
    const observed = observe(run);
    await first.promise;
    const seen: { busy?: boolean; rejection?: unknown } = {};
    session.onStatus.mockImplementation((status: string) => {
      if (status !== "crashed") return;
      seen.busy = session.handle.busy;
      seen.rejection = session.handle
        .runSource("x")
        .catch((error: unknown) => error);
    });

    session.worker.dispatchError("worker 죽음");

    await expect(run).rejects.toMatchObject({ reason: "crashed" });
    expect(observed().state).toBe("rejected");
    expect(seen.busy).toBe(false);
    await expect(seen.rejection).resolves.toMatchObject({
      reason: "unavailable",
    });
  });

  test("크래시 콜백 안에서 reset()해도(자동 복구) 진행 중이던 실행은 restarted가 아니라 crashed로 끝난다", async () => {
    const session = startSession();
    const first = await openPrompt(session, "pri");
    const run = session.handle.runSource("while True: pass");
    const observed = observe(run);
    await first.promise;
    session.onStatus.mockImplementation((status: string) => {
      if (status === "crashed") session.handle.reset();
    });

    session.worker.dispatchError("worker 죽음");

    await expect(run).rejects.toMatchObject({ reason: "crashed" });
    expect(observed().state).toBe("rejected");
    // 자동 복구로 새 worker가 만들어졌다.
    expect(session.workers).toHaveLength(2);
  });

  test("대기 중 크래시도 crashed로 거부한다", async () => {
    const session = startSession();
    const run = session.handle.runSource("print(1)");

    session.worker.dispatchError("부팅 중 죽음");

    await expect(run).rejects.toMatchObject({ reason: "crashed" });
    expect(session.handle.busy).toBe(false);
  });

  test("실행 중 dispose는 disposed로 거부한다", async () => {
    const session = startSession();
    const first = await openPrompt(session, "pri");
    const run = session.handle.runSource("while True: pass");
    await first.promise;

    session.handle.dispose();

    await expect(run).rejects.toMatchObject({ reason: "disposed" });
  });

  test("대기 중 dispose는 disposed로 거부한다", async () => {
    const session = startSession();
    const run = session.handle.runSource("print(1)");

    session.handle.dispose();

    await expect(run).rejects.toMatchObject({ reason: "disposed" });
  });

  test("결말이 도착한 뒤 복원한 줄이 그려지기 전에 reset·dispose되면 이미 정해진 결말로 resolve한다", async () => {
    for (const event of ["reset", "dispose"] as const) {
      const session = startSession({ asyncWrite: true });
      const first = await openPrompt(session, "pri");
      const run = session.handle.runSource("print(1)");
      await first.promise;
      await session.output("1\n");
      await session.request(">>> ", undefined, OK, false);

      if (event === "reset") session.handle.reset();
      else session.handle.dispose();

      await expect(run).resolves.toEqual(OK);
      session.handle.dispose();
    }
  });

  test("RunRejectedError·RunResult는 core의 것을 그대로 다시 내보낸다", () => {
    expect(RunRejectedError).toBe(CoreRunRejectedError);
    const result: RunResult = { kind: "restarted" };
    expect(result.kind).toBe("restarted");
  });
});

/** 거부 표 한 행. `arrange`가 상태를 만든다. `reason`이 `busy`면 `busy` 게터가 참이다. */
interface RejectionRow {
  title: string;

  reason: "busy" | "unavailable" | "disposed";

  asyncWrite?: boolean;

  workerHandlers?: RpcHandlers;

  arrange(session: Session): Promise<void>;
}

/** 응답하지 않는 `complete` 핸들러. Tab 왕복이 끝나지 않은 상태를 만든다. */
const pendingComplete = () =>
  vi.fn(() => new Promise<SourceCompletion>(() => {}));

/** 거부 표(02-console-core.md 5.6.2). 행마다 상태를 만들고 거부 사유를 기대한다. */
const rejectionRows: RejectionRow[] = [
  {
    title: "블록 입력 중(... 프롬프트)",
    reason: "busy",
    async arrange(session) {
      const first = await openPrompt(session);
      await submit(session, first, "if 1:");
      await session.request("... ", "if 1:");
    },
  },
  {
    title: "Python 실행 중(제출한 줄이 실행되는 동안)",
    reason: "busy",
    async arrange(session) {
      const first = await openPrompt(session);
      await submit(session, first, "while True: pass");
    },
  },
  {
    title: "input() 대기 중",
    reason: "busy",
    async arrange(session) {
      const first = await openPrompt(session);
      await submit(session, first, "input()");
      const before = session.flushCount();
      session.rpc.notify("readInput", true);
      await waitFor(() => session.flushCount() > before);
      await session.pump();
    },
  },
  {
    title: "프롬프트가 열린 채 배경 input() 대기 중",
    reason: "busy",
    async arrange(session) {
      await openPrompt(session, "pri");
      session.rpc.notify("readInput", true);
      await settle();
    },
  },
  {
    title: "다른 runSource 진행 중",
    reason: "busy",
    async arrange(session) {
      await openPrompt(session, "pri");
      runQuietly(session, "first");
      await settle();
    },
  },
  {
    title: "다른 runSource가 loading에서 대기 중",
    reason: "busy",
    async arrange(session) {
      runQuietly(session, "first");
    },
  },
  {
    title: "결말이 도착했지만 복원한 줄이 아직 그려지지 않은 구간",
    reason: "busy",
    asyncWrite: true,
    async arrange(session) {
      const first = await openPrompt(session, "pri");
      runQuietly(session, "first");
      await first.promise;
      await session.request(">>> ", undefined, OK, false);
    },
  },
  {
    title: "프롬프트 읽기가 열렸지만 아직 그려지지 않은 구간",
    reason: "busy",
    asyncWrite: true,
    async arrange(session) {
      await session.ready();
      await session.request(">>> ", undefined, undefined, false);
    },
  },
  {
    title: "Tab complete 왕복 중",
    reason: "busy",
    workerHandlers: { complete: pendingComplete() },
    async arrange(session) {
      await openPrompt(session, "pri");
      session.fake.type("\t");
      await settle();
    },
  },
  {
    title: "상태 not-isolated",
    reason: "unavailable",
    async arrange() {},
  },
  {
    title: "상태 load-failed",
    reason: "unavailable",
    async arrange(session) {
      session.rpc.notify("loadFailed", "Error: boom");
      await waitFor(() => session.lastStatus() === "load-failed");
    },
  },
  {
    title: "상태 crashed",
    reason: "unavailable",
    async arrange(session) {
      session.worker.dispatchError("죽음");
      await waitFor(() => session.lastStatus() === "crashed");
    },
  },
  {
    title: "상태 terminated(exit())",
    reason: "unavailable",
    async arrange(session) {
      await openPrompt(session);
      session.rpc.notify("sessionTerminated");
      await waitFor(() => session.lastStatus() === "terminated");
    },
  },
  {
    title: "dispose 뒤",
    reason: "disposed",
    async arrange(session) {
      await openPrompt(session, "pri");
      session.handle.dispose();
    },
  },
];

describe("runSource 거부 표와 busy 게터", () => {
  test.each(rejectionRows.map((row) => [row.title, row] as const))(
    "%s이면 거부하고 화면을 건드리지 않으며 busy 게터가 그 판정과 같다",
    async (title, row) => {
      if (title === "상태 not-isolated")
        vi.stubGlobal("crossOriginIsolated", false);
      const session = startSession({
        asyncWrite: row.asyncWrite,
        workerHandlers: row.workerHandlers,
      });
      await row.arrange(session);
      const screenBefore = session.vt.screen();
      const writtenBefore = session.fake.written.length;

      // 게터는 부작용이 없고 거부 판정과 같다. `busy` 사유일 때만 참이다.
      expect(session.handle.busy).toBe(row.reason === "busy");
      expect(session.handle.busy).toBe(row.reason === "busy");
      const run = session.handle.runSource("print(1)");

      await expect(run).rejects.toBeInstanceOf(RunRejectedError);
      await expect(run).rejects.toMatchObject({ reason: row.reason });
      expect(session.vt.screen()).toBe(screenBefore);
      expect(session.fake.written).toHaveLength(writtenBefore);
    },
  );

  test("코드가 문자열이 아니면 TypeError로 거부한다", async () => {
    const session = startSession();
    await openPrompt(session, "pri");
    const screenBefore = session.vt.screen();

    for (const value of [undefined, null, 1, {}, ["x"]]) {
      await expect(
        session.handle.runSource(value as unknown as string),
      ).rejects.toBeInstanceOf(TypeError);
    }

    expect(session.vt.screen()).toBe(screenBefore);
    expect(session.handle.busy).toBe(false);
  });

  test("프롬프트가 열려 있으면 busy 게터는 거짓이고 runSource는 받아들여진다", async () => {
    const session = startSession();
    const first = await openPrompt(session, "pri");

    expect(session.handle.busy).toBe(false);
    const run = observe(session.handle.runSource("print(1)"));

    await expect(first.promise).resolves.toEqual({ source: "print(1)" });
    expect(run().state).toBe("pending");
    expect(session.handle.busy).toBe(true);
  });

  test("Tab 왕복이 끝나면 다시 받아들인다", async () => {
    let finish: (value: SourceCompletion) => void = () => {};
    const complete = vi.fn(
      () =>
        new Promise<SourceCompletion>((resolve) => {
          finish = resolve;
        }),
    );
    const session = startSession({ workerHandlers: { complete } });
    const first = await openPrompt(session, "pri");
    session.fake.type("\t");
    await waitFor(() => complete.mock.calls.length > 0);
    expect(session.handle.busy).toBe(true);

    finish({ completions: [], start: 0 });
    await waitFor(() => !session.handle.busy);

    runQuietly(session, "print(1)");
    await expect(first.promise).resolves.toEqual({ source: "print(1)" });
  });
});

/**
 * xterm처럼 write를 차례로 처리하게 만든다.
 * - write를 하나씩 화면에 반영하고 그 콜백을 부른 뒤 macrotask를 넘긴다.
 * - xterm이 write 처리를 시간 예산(12ms)에서 끊어 `setTimeout`으로 넘긴 경우다.
 * - 콜백 사이에 마이크로태스크가 돈다. 콜백 안에서 낸 write는 큐 뒤에 선다.
 * - 돌려주는 함수는 큐가 빌 때까지 처리한다.
 */
function serialWrites(session: Session): () => Promise<void> {
  const queue: { text: string; callback?: () => void }[] = [];
  const inner = session.fake.term.write;
  session.fake.term.write = ((text: string, callback?: () => void) => {
    queue.push({ text, callback });
  }) as typeof session.fake.term.write;
  return async () => {
    for (
      let entry = queue.shift();
      entry !== undefined;
      entry = queue.shift()
    ) {
      inner(entry.text, entry.callback);
      await tick();
    }
  };
}

describe("runSource 정착·정리 경계(사후 리뷰)", () => {
  test("실행 중 친 Enter로 복원한 줄이 그려지자마자 제출돼도 그 읽기에서 정착한다(write 처리가 끊겨도)", async () => {
    const session = startSession();
    const first = await openPrompt(session, "pri");
    const drain = serialWrites(session);
    const run = observe(runQuietly(session, "print(1)"));
    await expect(first.promise).resolves.toEqual({ source: "print(1)" });
    await drain();
    // 활성 읽기가 없으므로 Enter는 type-ahead에 쌓인다.
    // 복원한 읽기에서 재생돼 `pri`를 제출한다.
    session.fake.type("\r");
    session.rpc.notify("write", "1\n");
    await settle();
    await drain();

    // 결말을 실은 다음 요청이 도착한다. 복원한 읽기가 그려지자마자 `pri`가 제출된다.
    const second = session.rpc.call<ReadLineReply>(
      "readLine",
      ">>> ",
      undefined,
      true,
      OK,
    );
    const secondState = observe(second);
    for (let round = 0; round < 3; round += 1) {
      await settle();
      await drain();
    }

    expect(secondState()).toEqual({ state: "resolved", value: "pri" });
    // 다음 읽기(제출된 `pri`가 끝난 뒤)를 기다리지 않는다.
    expect(run()).toEqual({ state: "resolved", value: OK });
  });

  test("정착하는 순간 복원한 >>> pri가 이미 화면에 반영돼 있다(write를 차례로 처리해도)", async () => {
    const session = startSession();
    const first = await openPrompt(session, "pri");
    const drain = serialWrites(session);
    const run = runQuietly(session, "print(1)");
    let screenAtSettle: string | undefined;
    void run.then(() => {
      screenAtSettle = session.vt.screen();
    });
    await first.promise;
    await drain();
    session.rpc.notify("write", "1\n");
    await settle();
    await drain();

    void session.rpc
      .call<ReadLineReply>("readLine", ">>> ", undefined, true, OK)
      .catch(() => {});
    for (let round = 0; round < 3; round += 1) {
      await settle();
      await drain();
    }

    expect(screenAtSettle).toBe("1\n>>> pri");
  });

  test("reset() 중 새 worker 생성이 던지면 reset()은 던지지 않고 crashed·onCrash로 넘기며 실행 중이던 runSource는 restarted로 끝난다", async () => {
    const session = startSession();
    const first = await openPrompt(session, "pri");
    const run = runQuietly(session, "while True: pass");
    await first.promise;
    const order: string[] = [];
    session.onStatus.mockImplementation((status: string) => {
      order.push(`status:${status}`);
    });
    session.onCrash.mockImplementation((message: string) => {
      order.push(`crash:${message}`);
    });
    session.createWorkerSpy.mockImplementationOnce(() => {
      throw new Error("worker 생성 실패");
    });

    expect(() => session.handle.reset()).not.toThrow();

    // runner `restart()`와 같다. `loading`을 거치지 않고 `crashed` 다음에 `onCrash`를 부른다.
    expect(order).toEqual(["status:crashed", "crash:Error: worker 생성 실패"]);
    await expect(run).resolves.toEqual({ kind: "restarted" });
    expect(session.handle.busy).toBe(false);
    await expect(session.handle.runSource("print(1)")).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  test("대기 중 runSource는 reset() 중 worker 생성 실패에 crashed로 거부한다", async () => {
    const session = startSession();
    const run = session.handle.runSource("print(1)");
    session.createWorkerSpy.mockImplementationOnce(() => {
      throw new Error("worker 생성 실패");
    });

    session.handle.reset();

    await expect(run).rejects.toMatchObject({ reason: "crashed" });
    expect(session.handle.busy).toBe(false);
  });

  test("worker 생성 실패 뒤 reset()은 새 세션을 만들어 복구한다", async () => {
    const session = startSession();
    await session.ready();
    session.createWorkerSpy.mockImplementationOnce(() => {
      throw new Error("worker 생성 실패");
    });
    session.handle.reset();

    session.handle.reset();

    expect(session.createWorkerSpy).toHaveBeenCalledTimes(3);
    expect(session.workers).toHaveLength(2);
    expect(session.lastStatus()).toBe("loading");
    await session.ready();
    expect(session.lastStatus()).toBe("ready");
  });

  test("worker 생성 실패의 crashed 콜백 안에서 reset()하면 새 세션이 남고 onCrash는 한 번 불린다", () => {
    const session = startSession();
    session.onStatus.mockImplementation((status: string) => {
      if (status === "crashed") session.handle.reset();
    });
    session.createWorkerSpy.mockImplementationOnce(() => {
      throw new Error("worker 생성 실패");
    });

    session.handle.reset();

    expect(session.statuses.slice(-2)).toEqual(["crashed", "loading"]);
    expect(session.workers).toHaveLength(2);
    expect(session.onCrash).toHaveBeenCalledTimes(1);
    expect(session.handle.busy).toBe(false);
  });

  test("worker 생성 실패 뒤 친 키는 복구 reset()이 버린다(type-ahead)", async () => {
    const session = startSession();
    await openPrompt(session);
    session.createWorkerSpy.mockImplementationOnce(() => {
      throw new Error("worker 생성 실패");
    });
    session.handle.reset();
    session.fake.type("abc");

    session.handle.reset();
    await session.ready();
    const request = await session.request();
    session.fake.type("\r");

    await expect(request.promise).resolves.toBe("");
  });

  test("worker 생성 실패의 crashed 콜백 안에서 dispose()하면 onCrash를 부르지 않는다", () => {
    const session = startSession();
    session.onStatus.mockImplementation((status: string) => {
      if (status === "crashed") session.handle.dispose();
    });
    session.createWorkerSpy.mockImplementationOnce(() => {
      throw new Error("worker 생성 실패");
    });

    session.handle.reset();

    expect(session.onCrash).not.toHaveBeenCalled();
  });

  test("dispose() 정리 중 worker terminate가 던져도 실행 중이던 runSource는 disposed로 거부한다", async () => {
    const session = startSession();
    const first = await openPrompt(session, "pri");
    const run = runQuietly(session, "while True: pass");
    await first.promise;
    session.worker.terminate.mockImplementationOnce(() => {
      throw new Error("terminate 실패");
    });

    expect(() => session.handle.dispose()).toThrow("terminate 실패");

    await expect(run).rejects.toMatchObject({ reason: "disposed" });
  });
});

/**
 * 열린 읽기 위 배경 출력(RD-022b, 규칙: `docs/design/02-console-core.md` 5.6.3).
 * - 프롬프트가 열린 채 worker가 출력(asyncio task·`call_later` 콜백)을 알린다.
 * - sink가 입력줄을 지우고 출력을 쓴 뒤 같은 읽기를 그 아래에 다시 그린다. 개행 없는 나머지는 프롬프트 앞 접두가 된다.
 * - `runSource`의 `takeRead()`는 접두째 지운다. 브리지가 `접두 + 읽기 시작 꼬리`를 다시 쓴다.
 * - 비동기 모드는 재그리기가 write 콜백을 기다린다. 출력 뒤 `pump()`로 그린다.
 */
describe.each([
  { mode: "동기", asyncWrite: false },
  { mode: "비동기", asyncWrite: true },
])("열린 읽기 위 배경 출력($mode 모드)", ({ asyncWrite }) => {
  // worker가 배경 출력을 알리고 재그리기까지 끝낸다.
  const background = async (session: Session, text: string) => {
    await session.output(text);
    await session.pump();
  };

  // 열린 읽기를 `runSource`로 가져가고 화면 준비(지우기·접두 복원)가 끝날 때까지 기다린다.
  const take = async (session: Session, first: Request, code = "print(1)") => {
    runQuietly(session, code);
    await expect(first.promise).resolves.toEqual({ source: code });
    await session.pump();
  };

  test("H4 배경 출력 행이 온 뒤 runSource하면 >>> pritick 흔적 없이 tick 행을 남기고 출력 뒤 >>> pri를 복원한다", async () => {
    const session = startSession({ asyncWrite });
    const first = await openPrompt(session, "pri");
    await background(session, "tick\n");
    expect(session.vt.screen()).toBe("tick\n>>> pri");

    await take(session, first);
    expect(session.vt.screen()).toBe("tick");
    expect(session.vt.cursor()).toEqual([1, 0]);

    await session.output("1\n");
    await session.request(">>> ", undefined, OK);
    expect(session.vt.screen()).toBe("tick\n1\n>>> pri");
  });

  test("개행 없는 배경 출력은 프롬프트 앞 접두(tick>>> pri)가 되고, runSource는 접두를 행으로 남기고 출력 뒤 >>> pri를 복원한다", async () => {
    const session = startSession({ asyncWrite });
    const first = await openPrompt(session, "pri");
    await background(session, "tick");
    expect(session.vt.screen()).toBe("tick>>> pri");

    await take(session, first);
    expect(session.vt.screen()).toBe("tick");
    expect(session.vt.cursor()).toEqual([1, 0]);

    await session.output("1\n");
    await session.request(">>> ", undefined, OK);
    expect(session.vt.screen()).toBe("tick\n1\n>>> pri");
  });

  test("읽기 시작 꼬리가 붙은 프롬프트(a>>> pri) 위 배경 출력 행은 그 위에 쓰이고, runSource는 꼬리 a를 행으로 남긴다", async () => {
    const session = startSession({ asyncWrite });
    await session.ready();
    await session.output("a");
    const first = await session.request();
    session.fake.type("pri");
    await background(session, "tick\n");
    expect(session.vt.screen()).toBe("tick\na>>> pri");

    await take(session, first);
    expect(session.vt.screen()).toBe("tick\na");
    expect(session.vt.cursor()).toEqual([2, 0]);

    await session.output("2\n");
    await session.request(">>> ", undefined, OK);
    expect(session.vt.screen()).toBe("tick\na\n2\n>>> pri");
  });

  test("접두와 읽기 시작 꼬리가 함께 있으면(ta>>> pri, 순서 뒤집힘 편차) runSource는 화면 순서 그대로 ta를 행으로 남긴다", async () => {
    const session = startSession({ asyncWrite });
    await session.ready();
    await session.output("a");
    const first = await session.request();
    session.fake.type("pri");
    await background(session, "t");
    expect(session.vt.screen()).toBe("ta>>> pri");

    await take(session, first);
    expect(session.vt.screen()).toBe("ta");

    await session.output("1\n");
    await session.request(">>> ", undefined, OK);
    expect(session.vt.screen()).toBe("ta\n1\n>>> pri");
  });

  test("색이 열린 접두를 복원할 때는 벤더가 그린 대로 접두 뒤에서 색을 닫고 꼬리를 잇는다", async () => {
    const session = startSession({ asyncWrite });
    await session.ready();
    await session.output("a");
    const first = await session.request();
    session.fake.type("pri");
    await background(session, "\x1b[31mt");
    expect(session.vt.screen()).toBe("ta>>> pri");
    const writtenBefore = session.fake.written.length;

    await take(session, first);

    // 벤더가 그린 화면에서는 접두 `t`(빨강)와 꼬리 `a` 사이에 `\x1b[0m`이 있었다(`State.setPromptPrefix`).
    // 복원도 같은 경계를 쓴다. 꼬리가 빨강을 물려받지 않는다.
    expect(session.fake.written.slice(writtenBefore).join("")).toContain(
      "\x1b[31mt\x1b[0ma\x1b[0m\r\n",
    );
    expect(session.vt.screen()).toBe("ta");
  });

  test("프로브 P1: 배경 출력 행 아래 입력줄은 하나이고 입력·Backspace·runSource 뒤에도 tick 행이 남는다", async () => {
    const session = startSession({ asyncWrite });
    const first = await openPrompt(session, "pri");
    await background(session, "tick\n");
    expect(session.vt.screen()).toBe("tick\n>>> pri");

    session.fake.type("a");
    await session.pump();
    expect(session.vt.screen()).toBe("tick\n>>> pria");
    session.fake.type("\x7f\x7f");
    await session.pump();
    expect(session.vt.screen()).toBe("tick\n>>> pr");

    await take(session, first);
    expect(session.vt.screen()).toBe("tick");
  });

  test("프로브 P2: 개행 없는 배경 출력 접두는 입력·Backspace 뒤에도 사라지지 않고 runSource 뒤에도 남는다", async () => {
    const session = startSession({ asyncWrite });
    const first = await openPrompt(session, "pri");
    await background(session, "tick");
    expect(session.vt.screen()).toBe("tick>>> pri");

    session.fake.type("a");
    await session.pump();
    expect(session.vt.screen()).toBe("tick>>> pria");
    session.fake.type("\x7f\x7f");
    await session.pump();
    expect(session.vt.screen()).toBe("tick>>> pr");

    await take(session, first);
    expect(session.vt.screen()).toBe("tick");
  });

  test("프로브 P4: 감긴 입력줄 위 배경 출력은 감긴 두 행을 모두 지우고 그 아래에 다시 그리며 Backspace 뒤 흔적 행이 없다", async () => {
    const session = startSession({ asyncWrite, cols: 40 });
    const first = await openPrompt(session, "x".repeat(50));
    expect(session.vt.screen()).toBe(
      `>>> ${"x".repeat(36)}\n${"x".repeat(14)}`,
    );
    await background(session, "tick\n");
    expect(session.vt.screen()).toBe(
      `tick\n>>> ${"x".repeat(36)}\n${"x".repeat(14)}`,
    );

    session.fake.type("a");
    await session.pump();
    session.fake.type("\x7f\x7f");
    await session.pump();
    expect(session.vt.screen()).toBe(
      `tick\n>>> ${"x".repeat(36)}\n${"x".repeat(13)}`,
    );

    await take(session, first);
    expect(session.vt.screen()).toBe("tick");
  });

  test("프로브 P5: 블록 ... 입력줄 위 배경 출력은 앞 >>> 행을 두고 ... 행만 지워 그 아래에 다시 그린다", async () => {
    const session = startSession({ asyncWrite });
    const first = await openPrompt(session);
    await submit(session, first, "if 1:");
    await session.request("... ", "if 1:");
    session.fake.type("pri");
    await session.pump();
    const block = must(session.vt.lines()[1]);
    expect(block).toBe("...     pri");

    await background(session, "tick\n");
    expect(session.vt.screen()).toBe(`>>> if 1:\ntick\n${block}`);
    session.fake.type("a");
    await session.pump();
    expect(session.vt.screen()).toBe(`>>> if 1:\ntick\n${block}a`);
  });

  test("프로브 P7: 개행 없는 배경 출력 뒤 Enter하면 tick>>> pri 행이 남고 이어진 출력·다음 프롬프트는 그 아래에 온다", async () => {
    const session = startSession({ asyncWrite });
    const first = await openPrompt(session, "pri");
    await background(session, "tick");

    session.fake.type("\r");
    await expect(first.promise).resolves.toBe("pri");
    await session.output("out\n");
    await session.request();

    expect(session.vt.screen()).toBe("tick>>> pri\nout\n>>>");
  });

  test("개행 없는 배경 출력 뒤 Enter하면 다음 프롬프트는 꼬리 없이 >>> 로 그린다(tick>>> 중복 없음)", async () => {
    const session = startSession({ asyncWrite });
    const first = await openPrompt(session, "pri");
    await background(session, "tick");

    session.fake.type("\r");
    await expect(first.promise).resolves.toBe("pri");
    const second = await session.request();
    session.fake.type("x");

    expect(session.vt.screen()).toBe("tick>>> pri\n>>> x");
    session.fake.type("\r");
    await expect(second.promise).resolves.toBe("x");
  });

  test("커서가 입력 중간(p|ri)일 때 배경 출력이 와도 커서 열이 보존되고 이어 친 글자가 그 자리에 들어간다", async () => {
    const session = startSession({ asyncWrite });
    const first = await openPrompt(session, "pri");
    session.fake.type("\x1b[D\x1b[D");
    await background(session, "tick\n");

    expect(session.vt.screen()).toBe("tick\n>>> pri");
    expect(session.vt.cursor()).toEqual([1, 5]);
    session.fake.type("X\r");
    await expect(first.promise).resolves.toBe("pXri");
  });

  test("REPL input('x: ') 대기 중 배경 출력 행은 x: 입력줄 위에 쓰이고, 이어 친 입력이 input()에 전달된다", async () => {
    const session = startSession({ asyncWrite });
    const first = await openPrompt(session);
    await submit(session, first, "input('x: ')");
    await session.output("x: ");
    const before = session.flushCount();
    session.rpc.notify("readInput", true);
    await waitFor(() => session.flushCount() > before);
    await session.pump();
    session.fake.type("ab");
    expect(session.vt.screen()).toBe(">>> input('x: ')\nx: ab");

    await background(session, "tick\n");
    expect(session.vt.screen()).toBe(">>> input('x: ')\ntick\nx: ab");
    expect(session.vt.cursor()).toEqual([2, 5]);

    session.fake.type("c\r");
    await expect(session.takeResponse()).resolves.toEqual({
      kind: "line",
      text: "abc",
    });
    expect(session.vt.screen()).toBe(">>> input('x: ')\ntick\nx: abc");
  });
});

// 이슈 13: 재그리기 콜백 전 reset()은 벤더가 화면에 아무것도 쓰지 않아 아직 그리지 않은 접두를 잃는다.
// reset이 그 접두를 복원한다.
describe("재그리기 대기 중 reset()의 접두 복원(이슈 13)", () => {
  test("아직 그리지 않은 접두 tick이 화면에 남고 안내 줄은 그 아래 행에 나온다", async () => {
    const session = startSession({ asyncWrite: true });
    await openPrompt(session, "pri");
    // 재그리기 콜백을 배출하지 않는다.
    // 입력줄은 지워졌고 접두 `tick`은 아직 그려지지 않았다.
    await session.output("tick");
    expect(session.vt.screen()).toBe("");

    session.handle.reset();
    await session.pump();

    const lines = session.vt.lines();
    expect(lines[0]).toBe("tick");
    expect(lines[1]).toContain("세션 리셋됨");
  });

  // 행 머리 판정은 꼬리 기준이다(RD-028). 이 시험이 흉내 내는 낡은 `cursorX`와는 원래부터 무관하다.
  // 이 경우는 settle이 성공하는 분기(재그리기 대기 중 + 접두 있음)라 promptRow가 커서도 꼬리도 보지 않는다.
  // 그래도 실제 xterm의 `buffer.active`는 해석이 끝난 바이트까지만 반영한다.
  // 재그리기 콜백 전에는 `cursorX`가 옛 입력줄 끝일 수 있다.
  // 가짜 터미널로 그 낡음을 흉내 내어 무관함을 확인해 둔다.
  test("접두를 쓴 뒤에는 낡은 cursorX를 보지 않아 안내 줄 앞에 빈 행이 없다(꼬리 기준이라 원래부터 무관)", async () => {
    const session = startSession({ asyncWrite: true });
    await openPrompt(session, "pri");
    await session.output("tick");
    expect(session.vt.screen()).toBe("");

    // write마다 `cursorX`를 옛 값(7)으로 되돌려 낡은 커서를 흉내 낸다.
    const write = session.fake.term.write.bind(session.fake.term);
    session.fake.screen.cursorX = 7;
    session.fake.term.write = ((text: string, callback?: () => void) => {
      const stale = session.fake.screen.cursorX;
      write(text, callback);
      session.fake.screen.cursorX = stale;
    }) as typeof session.fake.term.write;

    session.handle.reset();
    await session.pump();

    const lines = session.vt.lines();
    expect(lines[0]).toBe("tick");
    expect(lines[1]).toContain("세션 리셋됨");
  });

  test("대조: 재그리기가 끝난 뒤 reset()하면 접두는 이미 그려진 행에 있고 다시 쓰지 않는다", async () => {
    const session = startSession({ asyncWrite: true });
    await openPrompt(session, "pri");
    await session.output("tick");
    await session.pump();
    expect(session.vt.screen()).toBe("tick>>> pri");

    session.handle.reset();
    await session.pump();

    const lines = session.vt.lines();
    expect(lines[0]).toBe("tick>>> pri");
    expect(lines[1]).toContain("세션 리셋됨");
  });
});

// 커서가 감긴 입력 중간에 있을 때 reset()하면 커서 행 기준 개행만으로는 안내 줄이 입력의 다음 행을 덮는다.
// 벤더 `cancelRead({ settle: true })`가 커서를 입력 끝으로 옮기고 개행한 뒤에 안내 줄을 쓴다.
// 규칙: `docs/design/08-session.md` 8.1 reset() 1번.
describe("감긴 입력 중간 커서에서 reset()", () => {
  const THIRTY = "abcdefghijklmnopqrstuvwxyz0123";
  const HOME = "\x1b[H";

  // 열 20 화면의 `>>> ` 읽기에 30자를 쳐 두 행으로 감긴 입력을 만든다.
  const openWrappedPrompt = async () => {
    const session = startSession({ asyncWrite: true, cols: 20 });
    await openPrompt(session, THIRTY);
    await session.pump();
    expect(session.vt.lines()).toEqual([
      ">>> abcdefghijklmnop",
      "qrstuvwxyz0123",
    ]);
    return session;
  };

  test("커서가 첫 행에 있어도 입력 두 행이 온전히 남고 안내 줄은 그 아래 행에 나온다", async () => {
    const session = await openWrappedPrompt();
    session.fake.type(HOME);
    await session.pump();
    expect(session.vt.cursor()[0]).toBe(0);

    session.handle.reset();
    await session.pump();

    const lines = session.vt.lines();
    expect(lines.slice(0, 2)).toEqual([
      ">>> abcdefghijklmnop",
      "qrstuvwxyz0123",
    ]);
    expect(lines[2]).toContain("세션 리셋됨");
  });

  test("대조: 커서가 입력 끝이면 입력 두 행 아래에 안내 줄이 나온다", async () => {
    const session = await openWrappedPrompt();

    session.handle.reset();
    await session.pump();

    const lines = session.vt.lines();
    expect(lines.slice(0, 2)).toEqual([
      ">>> abcdefghijklmnop",
      "qrstuvwxyz0123",
    ]);
    expect(lines[2]).toContain("세션 리셋됨");
  });
});

// 크래시는 세션을 terminate하지 않는다. core `crash()`는 `endSession()`만 부른다. 열린 읽기가 reset()까지 남는다.
// reset()은 `endRead({ screen: true })`를 terminate 훅의 `endRead({ screen: false })`보다 먼저 부른다.
// 그래서 그리기 전 창이어도 되감은 행을 되돌리는 대체 개행 분기(이슈 prompt-row-followups/03)를 탄다.
// 이슈 prompt-row-followups/05의 가설은 이 시험으로 기각됐다.
describe("감긴 꼬리 되감기 뒤 그리기 전 창의 크래시와 reset()(이슈 prompt-row-followups/05)", () => {
  const TAIL = `${"a".repeat(10)}${"b".repeat(10)}ccccc`;

  // 열 10 화면에 3행으로 감긴 출력 꼬리를 남기고 `>>> ` 읽기를 `rewindTail` 뒤·그리기 전까지 연다.
  const openAfterRewind = async () => {
    const session = startSession({ asyncWrite: true, cols: 10 });
    await session.ready();
    await session.output(TAIL);
    await session.pump();
    // xterm이 감은 행(절대 행 1·2)을 화면 모델에 알린다.
    session.fake.screen.wrappedRows = new Set([1, 2]);
    await session.request(">>> ", undefined, undefined, false);
    session.fake.flush(); // rewindTail의 flush 대기를 푼다.
    await tick(); // `\x1b[2A` 뒤 readline.read()가 write 콜백을 기다리는 상태(그리기 전 창).
    expect(session.vt.cursor()).toEqual([0, 5]);
    return session;
  };

  test("그리기 전 창에서 크래시 직후 reset()하면 꼬리 세 행이 남고 안내 줄은 그 아래 행에서 시작한다", async () => {
    const session = await openAfterRewind();

    session.worker.dispatchError("worker 죽음");
    session.handle.reset();
    await session.pump();

    const lines = session.vt.lines();
    expect(lines.slice(0, 3)).toEqual(["aaaaaaaaaa", "bbbbbbbbbb", "ccccc"]);
    expect(lines[3]?.startsWith("[세션")).toBe(true);
  });

  test("대조: 그리기 전 창에서 크래시한 뒤 읽기가 그려지고 나서 reset()하면 프롬프트 행 아래에 안내 줄이 나온다", async () => {
    const session = await openAfterRewind();

    session.worker.dispatchError("worker 죽음");
    await session.pump(); // 크래시는 열린 읽기를 끝내지 않는다. 미뤄 둔 그리기가 그대로 돈다.
    expect(session.vt.lines()).toEqual([
      "aaaaaaaaaa",
      "bbbbbbbbbb",
      "ccccc>>>",
    ]);
    session.handle.reset();
    await session.pump();

    const lines = session.vt.lines();
    expect(lines.slice(0, 3)).toEqual(["aaaaaaaaaa", "bbbbbbbbbb", "ccccc>>>"]);
    expect(lines[3]?.startsWith("[세션")).toBe(true);
  });
});

describe("열린 읽기 위 배경 출력(write 콜백 순서 경계)", () => {
  test("재그리기 콜백 전에 runSource하면 아직 그리지 않은 접두 tick을 행으로 남기고 출력 뒤 >>> pri를 복원한다", async () => {
    const session = startSession({ asyncWrite: true });
    const first = await openPrompt(session, "pri");
    // 재그리기 콜백을 배출하지 않는다.
    // 입력줄은 지워졌고 접두 `tick`은 아직 그려지지 않았다.
    await session.output("tick");
    expect(session.vt.screen()).toBe("");

    runQuietly(session, "print(1)");
    await expect(first.promise).resolves.toEqual({ source: "print(1)" });
    await session.pump();
    expect(session.vt.screen()).toBe("tick");
    expect(session.vt.cursor()).toEqual([1, 0]);

    await session.output("1\n");
    await session.request(">>> ", undefined, OK);
    expect(session.vt.screen()).toBe("tick\n1\n>>> pri");
  });

  test("짧은 간격으로 연속 도착한 배경 조각은 순서대로 쓰이고 입력줄은 하나, 마지막 접두가 적용된다(write를 차례로 처리)", async () => {
    const session = startSession({ asyncWrite: true });
    const first = await openPrompt(session, "pri");
    const drain = serialWrites(session);
    // 차례 처리 큐와 미뤄 둔 write 콜백을 번갈아 비운다. 콜백이 새 write를 낸다.
    const drainAll = async () => {
      for (let round = 0; round < 3; round += 1) {
        await settle();
        await drain();
        await session.pump();
      }
    };
    // 조각 셋이 재그리기 사이에 연달아 도착한다.
    session.rpc.notify("write", "t1\n");
    session.rpc.notify("write", "t2");
    session.rpc.notify("write", " t3\nt4");
    await drainAll();

    expect(session.vt.screen()).toBe("t1\nt2 t3\nt4>>> pri");
    expect(session.vt.cursor()).toEqual([2, 9]);

    session.fake.type("x");
    await drainAll();
    expect(session.vt.screen()).toBe("t1\nt2 t3\nt4>>> prix");

    runQuietly(session, "print(1)");
    await expect(first.promise).resolves.toEqual({ source: "print(1)" });
    await drainAll();
    expect(session.vt.screen()).toBe("t1\nt2 t3\nt4");
  });
});

/**
 * Tab 완성 응답과 배경 출력 재그리기의 겹침(second-opinion SO-R1, 이슈 10).
 * - `>>> imp`에서 Tab을 누른다.
 * - `complete` 왕복 중에 배경 출력이 오면 입력줄은 지워지고 재그리기 콜백을 기다린다.
 * - 완성 응답이 그 콜백보다 먼저 처리돼도(`applyResume` → `editInsert`) 삽입은 버퍼에 들어간다.
 * - 콜백은 삽입 뒤 커서로 다시 그린다.
 */
describe("Tab 완성 응답과 배경 출력 재그리기의 겹침", () => {
  // `imp`를 친 뒤 Tab을 눌러 `complete` 왕복을 연다. `finish`로 응답을 돌려준다.
  const openTab = async () => {
    let finish: (value: SourceCompletion) => void = () => {};
    const complete = vi.fn(
      () =>
        new Promise<SourceCompletion>((resolve) => {
          finish = resolve;
        }),
    );
    const session = startSession({
      asyncWrite: true,
      workerHandlers: { complete },
    });
    const first = await openPrompt(session, "imp");
    await session.pump();
    expect(session.vt.screen()).toBe(">>> imp");
    session.fake.type("\t");
    await waitFor(() => complete.mock.calls.length > 0);
    return {
      session,
      first,
      complete,
      finish: (value: SourceCompletion) => finish(value),
    };
  };

  test("완성 응답이 재그리기 콜백보다 먼저 오면 커서는 import 끝이고 이어 친 글자가 그 뒤에 붙는다", async () => {
    const { session, first, finish } = await openTab();
    // 배경 출력이 오고 그 재그리기 write 콜백은 아직 오지 않았다(실 xterm: 파싱 한 번 전).
    await session.output("tick\n");
    finish({ completions: ["import"], start: 0 });
    await settle();
    await session.pump();

    expect(session.vt.screen()).toBe("tick\n>>> import");
    expect(session.vt.cursor()).toEqual([1, 10]);
    session.fake.type(" os\r");
    await session.pump();
    await expect(first.promise).resolves.toBe("import os");
  });

  test("대조: 재그리기 콜백이 완성 응답보다 먼저 오면 커서는 import 끝이다", async () => {
    const { session, first, finish } = await openTab();
    await session.output("tick\n");
    await session.pump();
    finish({ completions: ["import"], start: 0 });
    await settle();
    await session.pump();

    expect(session.vt.screen()).toBe("tick\n>>> import");
    expect(session.vt.cursor()).toEqual([1, 10]);
    session.fake.type(" os\r");
    await session.pump();
    await expect(first.promise).resolves.toBe("import os");
  });

  // 재그리기 대기 중 친 키는 벤더 큐에만 있고 버퍼에는 없다.
  // 경합 판정이 큐를 봐야 배경 출력 유무와 무관하게 같은 결과가 된다(이슈 16).
  test("대조: 배경 출력 없이 Tab 왕복 중 x를 치면 완성은 버려진다(impx)", async () => {
    const { session, first, finish } = await openTab();
    session.fake.type("x");
    await session.pump();
    finish({ completions: ["import"], start: 0 });
    await settle();
    await session.pump();

    expect(session.vt.screen()).toBe(">>> impx");
    session.fake.type("\r");
    await session.pump();
    await expect(first.promise).resolves.toBe("impx");
  });

  test("대조: 배경 출력 없이 Tab 왕복 중 Enter를 치면 imp가 제출된다", async () => {
    const { session, first, finish } = await openTab();
    session.fake.type("\r");
    await session.pump();
    finish({ completions: ["import"], start: 0 });
    await settle();
    await session.pump();

    await expect(first.promise).resolves.toBe("imp");
  });

  test("배경 출력 재그리기 콜백 전 x(큐) → 완성 응답 → 콜백: 대조와 같게 impx여야 한다", async () => {
    const { session, first, finish } = await openTab();
    await session.output("tick\n");
    session.fake.type("x");
    finish({ completions: ["import"], start: 0 });
    await settle();
    await session.pump();

    expect(session.vt.screen()).toBe("tick\n>>> impx");
    session.fake.type("\r");
    await session.pump();
    await expect(first.promise).resolves.toBe("impx");
  });

  test("배경 출력 재그리기 콜백 전 Enter(큐) → 완성 응답 → 콜백: 대조와 같게 imp가 제출돼야 한다", async () => {
    const { session, first, finish } = await openTab();
    await session.output("tick\n");
    session.fake.type("\r");
    finish({ completions: ["import"], start: 0 });
    await settle();
    await session.pump();

    await expect(first.promise).resolves.toBe("imp");
  });

  test("배경 출력 재그리기 콜백 전 큐가 있으면 목록 응답도 버려진다", async () => {
    const { session, first, complete, finish } = await openTab();
    // 첫 Tab은 채울 것이 없다. 공통 접두사가 이미 입력돼 있어 아무것도 넣지 않는다.
    // 이어지는 두 번째 Tab이 목록을 연다.
    finish({ completions: ["imp", "impl"], start: 0 });
    await settle();
    session.fake.type("\t");
    await waitFor(() => complete.mock.calls.length > 1);
    await session.output("tick\n");
    session.fake.type("x");
    finish({ completions: ["imp", "impl"], start: 0 });
    await settle();
    await session.pump();

    expect(session.vt.screen()).toBe("tick\n>>> impx");
    session.fake.type("\r");
    await session.pump();
    await expect(first.promise).resolves.toBe("impx");
  });
});

describe("createRepl: 소비자 콜백 예외 격리(규칙 08-session.md 8.5, X1·X2)", () => {
  let report: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    report = vi.fn();
    vi.stubGlobal("reportError", report);
  });

  test("[X2] 실행 중 crashed 콜백이 던져도 runSource는 crashed로 거부되고 onCrash가 불린다", async () => {
    const session = startSession();
    const first = await openPrompt(session, "pri");
    const run = session.handle.runSource("while True: pass");
    await first.promise;
    const failure = new Error("crashed onStatus 실패");
    session.onStatus.mockImplementation((status: string) => {
      if (status === "crashed") throw failure;
    });

    session.worker.dispatchError("worker 죽음");

    await expect(run).rejects.toMatchObject({ reason: "crashed" });
    expect(session.onCrash).toHaveBeenCalledWith("worker 죽음");
    expect(report).toHaveBeenCalledWith(failure);
  });

  test("[X2] 대기 중 load-failed 콜백이 던져도 runSource는 unavailable로 거부된다", async () => {
    const session = startSession();
    const run = session.handle.runSource("print(1)");
    const failure = new Error("load-failed onStatus 실패");
    session.onStatus.mockImplementation((status: string) => {
      if (status === "load-failed") throw failure;
    });

    session.rpc.notify("loadFailed", "Error: boom");

    await expect(run).rejects.toMatchObject({ reason: "unavailable" });
    expect(report).toHaveBeenCalledWith(failure);
  });

  test("[X2] 실행 중 terminated 콜백이 던져도 runSource는 unavailable로 거부된다", async () => {
    const session = startSession();
    const first = await openPrompt(session, "pri");
    const run = session.handle.runSource("while True: pass");
    await first.promise;
    const failure = new Error("terminated onStatus 실패");
    session.onStatus.mockImplementation((status: string) => {
      if (status === "terminated") throw failure;
    });

    session.rpc.notify("sessionTerminated");

    await expect(run).rejects.toMatchObject({ reason: "unavailable" });
    expect(report).toHaveBeenCalledWith(failure);
  });

  test("[X2] reset() 중 생성 실패의 crashed 콜백이 던져도 reset()은 던지지 않고 onCrash가 불린다", () => {
    const session = startSession();
    const failure = new Error("crashed onStatus 실패");
    session.onStatus.mockImplementation((status: string) => {
      if (status === "crashed") throw failure;
    });
    session.createWorkerSpy.mockImplementationOnce(() => {
      throw new Error("worker 생성 실패");
    });

    expect(() => session.handle.reset()).not.toThrow();

    expect(session.onCrash).toHaveBeenCalledWith("Error: worker 생성 실패");
    expect(report).toHaveBeenCalledWith(failure);
  });

  test("[X1] onCrash가 던져도 보고만 한다(dispatchError 호출이 던지지 않는다)", async () => {
    const session = startSession();
    const first = await openPrompt(session, "pri");
    const run = session.handle.runSource("while True: pass");
    await first.promise;
    const failure = new Error("onCrash 실패");
    session.onCrash.mockImplementation(() => {
      throw failure;
    });

    expect(() => session.worker.dispatchError("worker 죽음")).not.toThrow();

    await expect(run).rejects.toMatchObject({ reason: "crashed" });
    expect(report).toHaveBeenCalledWith(failure);
  });
});
