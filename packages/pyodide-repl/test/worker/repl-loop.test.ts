// @vitest-environment jsdom
/**
 * REPL 루프(`runReplLoop`)의 순수 제어 흐름 시험(00-architecture.md 3.2).
 * core 프로토콜·RPC 구현을 import하지 않고 주입한 `readLine`·`run`으로 프롬프트와 pending 전달, 종료,
 * 실행 오류 복구, 읽기 요청 거절 정책을 고정한다.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { runReplLoop } from "../../src/worker/repl-loop";
import { isReadLineSourceReply } from "../../src/repl-protocol";
import type { RunOutcome } from "@cp949/runo-pyodide-core/worker";
import type { SubmissionResult } from "../../src/worker/submission-runner";

type ReadLine = (
  prompt: string,
  pending: string | undefined,
  outcome?: RunOutcome,
) => Promise<string | null | { source: string } | { eof: true }>;
type Run = (line: string | null) => Promise<SubmissionResult>;
type RunSource = (source: string) => Promise<RunOutcome>;

afterEach(() => {
  vi.restoreAllMocks();
});

/** 각본: 단계마다 `readLine`이 돌려줄 줄과 `run`이 돌려줄 결과(또는 던질 오류)를 차례로 쓴다. */
function script(
  steps: { line: string | null; result: SubmissionResult | Error }[],
) {
  const readLine = vi.fn<ReadLine>();
  const run = vi.fn<Run>();
  for (const { line, result } of steps) {
    readLine.mockResolvedValueOnce(line);
    if (result instanceof Error) run.mockRejectedValueOnce(result);
    else run.mockResolvedValueOnce(result);
  }
  return { readLine, run };
}

const READY: SubmissionResult = { prompt: ">>> ", exit: false };
const EXIT: SubmissionResult = { prompt: ">>> ", exit: true };

describe("runReplLoop", () => {
  test("첫 요청은 `>>> `·pending 없음이고, 결과의 프롬프트·pending이 다음 요청으로 넘어간다", async () => {
    const { readLine, run } = script([
      {
        line: "if True:",
        result: { prompt: "... ", exit: false, pending: "if True:" },
      },
      { line: "", result: READY },
      { line: "exit()", result: EXIT },
    ]);
    const onTerminated = vi.fn();

    await runReplLoop({
      readLine,
      setAtPrompt: vi.fn(),
      discardPendingInterrupt: vi.fn(),
      run,
      runSource: vi.fn<RunSource>(),
      onTerminated,
      onError: vi.fn(),
    });

    // 두 번째 결과에는 pending이 없으므로 세 번째 요청에서 이전 pending이 지워진다.
    expect(readLine.mock.calls).toEqual([
      [">>> ", undefined],
      ["... ", "if True:"],
      [">>> ", undefined],
    ]);
    expect(run.mock.calls).toEqual([["if True:"], [""], ["exit()"]]);
    expect(onTerminated).toHaveBeenCalledTimes(1);
  });

  test("exit 결과 뒤에는 종료만 알리고 readLine을 더 부르지 않는다", async () => {
    const { readLine, run } = script([{ line: "exit()", result: EXIT }]);
    const onTerminated = vi.fn();

    await runReplLoop({
      readLine,
      setAtPrompt: vi.fn(),
      discardPendingInterrupt: vi.fn(),
      run,
      runSource: vi.fn<RunSource>(),
      onTerminated,
      onError: vi.fn(),
    });

    expect(onTerminated).toHaveBeenCalledTimes(1);
    expect(readLine).toHaveBeenCalledTimes(1);
  });

  test("run 오류는 onError로 알리고 `>>> `·pending 없음으로 계속한다", async () => {
    const boom = new Error("boom");
    const { readLine, run } = script([
      {
        line: "if True:",
        result: { prompt: "... ", exit: false, pending: "if True:" },
      },
      { line: "bad", result: boom },
      { line: "exit()", result: EXIT },
    ]);
    const onError = vi.fn();
    const onTerminated = vi.fn();

    await runReplLoop({
      readLine,
      setAtPrompt: vi.fn(),
      discardPendingInterrupt: vi.fn(),
      run,
      runSource: vi.fn<RunSource>(),
      onTerminated,
      onError,
    });

    expect(onError.mock.calls).toEqual([[boom]]);
    // 오류가 난 줄은 블록 입력 중이었다: 다음 요청은 `... `가 아니라 `>>> `이고 pending이 없다.
    expect(readLine.mock.calls).toEqual([
      [">>> ", undefined],
      ["... ", "if True:"],
      [">>> ", undefined],
    ]);
    expect(onTerminated).toHaveBeenCalledTimes(1);
  });

  test("`rpc disposed` 읽기 거절은 아무것도 부르지 않고 조용히 끝난다", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const readLine = vi
      .fn<ReadLine>()
      .mockRejectedValue(new Error("rpc disposed"));
    const run = vi.fn<Run>();
    const onError = vi.fn();
    const onTerminated = vi.fn();

    await runReplLoop({
      readLine,
      setAtPrompt: vi.fn(),
      discardPendingInterrupt: vi.fn(),
      run,
      runSource: vi.fn<RunSource>(),
      onTerminated,
      onError,
    });

    expect(run).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onTerminated).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("다른 이유의 읽기 거절은 console.error 한 번만 남기고 끝난다", async () => {
    const boom = new Error("transport broken");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const run = vi.fn<Run>();
    const onError = vi.fn();
    const onTerminated = vi.fn();

    await runReplLoop({
      readLine: vi.fn<ReadLine>().mockRejectedValue(boom),
      setAtPrompt: vi.fn(),
      discardPendingInterrupt: vi.fn(),
      run,
      runSource: vi.fn<RunSource>(),
      onTerminated,
      onError,
    });

    expect(consoleError.mock.calls).toEqual([
      ["[repl.worker] readLine 실패", boom],
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onTerminated).not.toHaveBeenCalled();
  });

  test("`null`(입력 취소)도 분기 없이 run에 그대로 넘긴다", async () => {
    const { readLine, run } = script([{ line: null, result: EXIT }]);

    await runReplLoop({
      readLine,
      setAtPrompt: vi.fn(),
      discardPendingInterrupt: vi.fn(),
      run,
      runSource: vi.fn<RunSource>(),
      onTerminated: vi.fn(),
      onError: vi.fn(),
    });

    expect(run.mock.calls).toEqual([[null]]);
  });

  test("setAtPrompt(true) → readLine → setAtPrompt(false) → discardPendingInterrupt → run 순서다(`null`에도, 두 번째 반복에도)", async () => {
    const { readLine, run } = script([
      { line: "1+1", result: READY },
      { line: null, result: EXIT },
    ]);
    const setAtPrompt = vi.fn<(value: boolean) => void>();
    const discardPendingInterrupt = vi.fn();

    await runReplLoop({
      readLine,
      setAtPrompt,
      discardPendingInterrupt,
      run,
      runSource: vi.fn<RunSource>(),
      onTerminated: vi.fn(),
      onError: vi.fn(),
    });

    // 호출 전역 순번(invocationCallOrder)으로 네 함수의 호출을 한 줄로 펴서 순서를 본다.
    const timeline = [
      ...setAtPrompt.mock.invocationCallOrder.map(
        (n, i) =>
          [
            n,
            setAtPrompt.mock.calls[i]?.[0]
              ? "atPrompt(true)"
              : "atPrompt(false)",
          ] as const,
      ),
      ...readLine.mock.invocationCallOrder.map((n) => [n, "readLine"] as const),
      ...discardPendingInterrupt.mock.invocationCallOrder.map(
        (n) => [n, "discard"] as const,
      ),
      ...run.mock.invocationCallOrder.map((n) => [n, "run"] as const),
    ]
      .sort(([a], [b]) => a - b)
      .map(([, name]) => name);
    expect(timeline).toEqual([
      "atPrompt(true)",
      "readLine",
      "atPrompt(false)",
      "discard",
      "run",
      "atPrompt(true)",
      "readLine",
      "atPrompt(false)",
      "discard",
      "run",
    ]);
  });

  test("readLine이 reject되면 폐기하지 않고 끝난다", async () => {
    const discardPendingInterrupt = vi.fn();

    await runReplLoop({
      readLine: vi.fn<ReadLine>().mockRejectedValue(new Error("rpc disposed")),
      discardPendingInterrupt,
      setAtPrompt: vi.fn(),
      run: vi.fn<Run>(),
      runSource: vi.fn<RunSource>(),
      onTerminated: vi.fn(),
      onError: vi.fn(),
    });

    expect(discardPendingInterrupt).not.toHaveBeenCalled();
  });

  test("readLine이 reject되면 setAtPrompt(false)로 되돌리지 않는다", async () => {
    const setAtPrompt = vi.fn<(value: boolean) => void>();

    await runReplLoop({
      readLine: vi.fn<ReadLine>().mockRejectedValue(new Error("rpc disposed")),
      setAtPrompt,
      discardPendingInterrupt: vi.fn(),
      run: vi.fn<Run>(),
      runSource: vi.fn<RunSource>(),
      onTerminated: vi.fn(),
      onError: vi.fn(),
    });

    expect(setAtPrompt.mock.calls).toEqual([[true]]);
  });
});

/** `{ source }` 응답 각본: 단계마다 `readLine`이 돌려줄 응답과 `runSource`가 돌려줄 결말(또는 던질 오류)을 쓴다. */
function sourceScript(
  steps: {
    reply: string | null | { source: string };
    outcome?: RunOutcome | Error;
    result?: SubmissionResult;
  }[],
) {
  const readLine = vi.fn<ReadLine>();
  const run = vi.fn<Run>();
  const runSource = vi.fn<RunSource>();
  for (const { reply, outcome, result } of steps) {
    readLine.mockResolvedValueOnce(reply);
    if (outcome instanceof Error) runSource.mockRejectedValueOnce(outcome);
    else if (outcome) runSource.mockResolvedValueOnce(outcome);
    if (result) run.mockResolvedValueOnce(result);
  }
  return { readLine, run, runSource };
}

describe("runReplLoop: 루프 명령 `{ source }`", () => {
  test("`{ source }` 응답은 run이 아니라 runSource로 실행하고 소스를 그대로 넘긴다", async () => {
    const { readLine, run, runSource } = sourceScript([
      { reply: { source: "x = 1\nprint(x)" }, outcome: { kind: "ok" } },
      { reply: null, result: EXIT },
    ]);

    await runReplLoop({
      readLine,
      setAtPrompt: vi.fn(),
      discardPendingInterrupt: vi.fn(),
      run,
      runSource,
      onTerminated: vi.fn(),
      onError: vi.fn(),
    });

    expect(runSource.mock.calls).toEqual([["x = 1\nprint(x)"]]);
    // run은 두 번째 응답(`null`)에만 불렸다.
    expect(run.mock.calls).toEqual([[null]]);
  });

  test("setAtPrompt(false) → discardPendingInterrupt → runSource 순서다", async () => {
    const { readLine, run, runSource } = sourceScript([
      { reply: { source: "1" }, outcome: { kind: "ok" } },
      { reply: null, result: EXIT },
    ]);
    const setAtPrompt = vi.fn<(value: boolean) => void>();
    const discardPendingInterrupt = vi.fn();

    await runReplLoop({
      readLine,
      setAtPrompt,
      discardPendingInterrupt,
      run,
      runSource,
      onTerminated: vi.fn(),
      onError: vi.fn(),
    });

    const timeline = [
      ...setAtPrompt.mock.invocationCallOrder.map(
        (n, i) =>
          [
            n,
            setAtPrompt.mock.calls[i]?.[0]
              ? "atPrompt(true)"
              : "atPrompt(false)",
          ] as const,
      ),
      ...readLine.mock.invocationCallOrder.map((n) => [n, "readLine"] as const),
      ...discardPendingInterrupt.mock.invocationCallOrder.map(
        (n) => [n, "discard"] as const,
      ),
      ...runSource.mock.invocationCallOrder.map(
        (n) => [n, "runSource"] as const,
      ),
      ...run.mock.invocationCallOrder.map((n) => [n, "run"] as const),
    ]
      .sort(([a], [b]) => a - b)
      .map(([, name]) => name);
    expect(timeline).toEqual([
      "atPrompt(true)",
      "readLine",
      "atPrompt(false)",
      "discard",
      "runSource",
      "atPrompt(true)",
      "readLine",
      "atPrompt(false)",
      "discard",
      "run",
    ]);
  });

  test("runSource 실행 중에는 atPrompt가 거짓이고 끝난 뒤 다음 읽기 직전에 다시 참이 된다", async () => {
    let atPrompt = false;
    const seenDuringRun: boolean[] = [];
    const atPromptAtRead: boolean[] = [];
    const readLine = vi.fn<ReadLine>(async () => {
      atPromptAtRead.push(atPrompt);
      return atPromptAtRead.length === 1 ? { source: "1" } : null;
    });
    const runSource = vi.fn<RunSource>(async () => {
      seenDuringRun.push(atPrompt);
      return { kind: "ok" };
    });

    await runReplLoop({
      readLine,
      setAtPrompt: (value) => {
        atPrompt = value;
      },
      discardPendingInterrupt: vi.fn(),
      run: vi.fn<Run>().mockResolvedValue(EXIT),
      runSource,
      onTerminated: vi.fn(),
      onError: vi.fn(),
    });

    expect(seenDuringRun).toEqual([false]);
    expect(atPromptAtRead).toEqual([true, true]);
  });

  test("결말은 다음 readLine 요청의 세 번째 인자로 실려 가고 `>>> `·pending 없음이다", async () => {
    const { readLine, run, runSource } = sourceScript([
      {
        reply: { source: "1/0" },
        outcome: {
          kind: "error",
          errorType: "ZeroDivisionError",
          traceback: "Traceback...\n",
        },
      },
      { reply: null, result: EXIT },
    ]);

    await runReplLoop({
      readLine,
      setAtPrompt: vi.fn(),
      discardPendingInterrupt: vi.fn(),
      run,
      runSource,
      onTerminated: vi.fn(),
      onError: vi.fn(),
    });

    expect(readLine.mock.calls).toEqual([
      [">>> ", undefined],
      [
        ">>> ",
        undefined,
        {
          kind: "error",
          errorType: "ZeroDivisionError",
          traceback: "Traceback...\n",
        },
      ],
    ]);
  });

  test("결말은 한 번만 싣고 그 다음 요청에는 싣지 않는다", async () => {
    const { readLine, run, runSource } = sourceScript([
      { reply: { source: "1" }, outcome: { kind: "ok" } },
      { reply: "1+1", result: READY },
      { reply: null, result: EXIT },
    ]);

    await runReplLoop({
      readLine,
      setAtPrompt: vi.fn(),
      discardPendingInterrupt: vi.fn(),
      run,
      runSource,
      onTerminated: vi.fn(),
      onError: vi.fn(),
    });

    expect(readLine.mock.calls.map((call) => call.length)).toEqual([2, 3, 2]);
  });

  test("exit 결말이어도 onTerminated를 부르지 않고 다음 프롬프트를 요청한다(세션 유지)", async () => {
    const { readLine, run, runSource } = sourceScript([
      { reply: { source: "sys.exit(3)" }, outcome: { kind: "exit", code: 3 } },
      { reply: "print(1)", result: READY },
      { reply: null, result: EXIT },
    ]);
    const onTerminated = vi.fn();

    await runReplLoop({
      readLine,
      setAtPrompt: vi.fn(),
      discardPendingInterrupt: vi.fn(),
      run,
      runSource,
      onTerminated,
      onError: vi.fn(),
    });

    // exit 결말 뒤에도 루프가 다음 readLine으로 돌아와 결말을 싣고, 이어진 명령이 실행된다.
    expect(readLine.mock.calls[1]).toEqual([
      ">>> ",
      undefined,
      { kind: "exit", code: 3 },
    ]);
    expect(run.mock.calls).toEqual([["print(1)"], [null]]);
    // 종료 통지는 마지막 `run(null)`의 exit 결과 한 번뿐이다.
    expect(onTerminated).toHaveBeenCalledTimes(1);
    expect(readLine).toHaveBeenCalledTimes(3);
  });

  test("runSource가 던지면 onError로 알리고 InternalError 결말을 싣고 계속한다", async () => {
    const boom = new Error("boom");
    const { readLine, run, runSource } = sourceScript([
      { reply: { source: "1" }, outcome: boom },
      { reply: null, result: EXIT },
    ]);
    const onError = vi.fn();

    await runReplLoop({
      readLine,
      setAtPrompt: vi.fn(),
      discardPendingInterrupt: vi.fn(),
      run,
      runSource,
      onTerminated: vi.fn(),
      onError,
    });

    expect(onError.mock.calls).toEqual([[boom]]);
    // 사용자 코드 오류가 아니라 worker 내부 오류라는 표지: errorType이 `InternalError`다.
    expect(readLine.mock.calls[1]).toEqual([
      ">>> ",
      undefined,
      {
        kind: "error",
        errorType: "InternalError",
        traceback: "repl 내부 오류: Error: boom\n",
      },
    ]);
  });

  test("성공 결말은 프롬프트·pending을 바꾸지 않는다(열린 블록은 콘솔 buffer에 그대로 있다)", async () => {
    const { readLine, run, runSource } = sourceScript([
      {
        reply: "if True:",
        result: { prompt: "... ", exit: false, pending: "if True:" },
      },
      { reply: { source: "1" }, outcome: { kind: "ok" } },
      { reply: null, result: EXIT },
    ]);

    await runReplLoop({
      readLine,
      setAtPrompt: vi.fn(),
      discardPendingInterrupt: vi.fn(),
      run,
      runSource,
      onTerminated: vi.fn(),
      onError: vi.fn(),
    });

    expect(readLine.mock.calls[2]).toEqual([
      "... ",
      "if True:",
      { kind: "ok" },
    ]);
  });

  test("runSource 내부 오류는 onError가 블록을 버리므로 `>>> `·pending 없음으로 돌아간다", async () => {
    const { readLine, run, runSource } = sourceScript([
      {
        reply: "if True:",
        result: { prompt: "... ", exit: false, pending: "if True:" },
      },
      { reply: { source: "1" }, outcome: new Error("boom") },
      { reply: null, result: EXIT },
    ]);

    await runReplLoop({
      readLine,
      setAtPrompt: vi.fn(),
      discardPendingInterrupt: vi.fn(),
      run,
      runSource,
      onTerminated: vi.fn(),
      onError: vi.fn(),
    });

    expect(readLine.mock.calls[2]?.slice(0, 2)).toEqual([">>> ", undefined]);
  });

  test("결말을 실은 읽기가 `rpc disposed`로 끝나면 조용히 끝난다", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const readLine = vi
      .fn<ReadLine>()
      .mockResolvedValueOnce({ source: "1" })
      .mockRejectedValueOnce(new Error("rpc disposed"));
    const onTerminated = vi.fn();
    const onError = vi.fn();

    await runReplLoop({
      readLine,
      setAtPrompt: vi.fn(),
      discardPendingInterrupt: vi.fn(),
      run: vi.fn<Run>(),
      runSource: vi.fn<RunSource>().mockResolvedValue({ kind: "ok" }),
      onTerminated,
      onError,
    });

    expect(onTerminated).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("`{ source }` 뒤 문자열 응답은 기존 경로 그대로 프롬프트·pending을 갱신한다", async () => {
    const { readLine, run, runSource } = sourceScript([
      { reply: { source: "1" }, outcome: { kind: "ok" } },
      {
        reply: "if True:",
        result: { prompt: "... ", exit: false, pending: "if True:" },
      },
      { reply: "", result: READY },
      { reply: null, result: EXIT },
    ]);

    await runReplLoop({
      readLine,
      setAtPrompt: vi.fn(),
      discardPendingInterrupt: vi.fn(),
      run,
      runSource,
      onTerminated: vi.fn(),
      onError: vi.fn(),
    });

    expect(readLine.mock.calls).toEqual([
      [">>> ", undefined],
      [">>> ", undefined, { kind: "ok" }],
      ["... ", "if True:"],
      [">>> ", undefined],
    ]);
  });
});

describe("runReplLoop: EOF 응답 { eof: true }(RD-048)", () => {
  test("[R4] { eof: true } 응답은 onTerminated를 한 번 부르고 run을 부르지 않는다", async () => {
    const readLine = vi.fn<ReadLine>().mockResolvedValueOnce({ eof: true });
    const run = vi.fn<Run>();
    const onTerminated = vi.fn();

    await runReplLoop({
      readLine,
      setAtPrompt: vi.fn(),
      discardPendingInterrupt: vi.fn(),
      run,
      runSource: vi.fn<RunSource>(),
      onTerminated,
      onError: vi.fn(),
    });

    expect(onTerminated).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  test("[R8] isReadLineSourceReply({ eof: true })는 거짓이다", () => {
    expect(isReadLineSourceReply({ eof: true })).toBe(false);
  });
});
