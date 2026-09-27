/**
 * 제출 한 번의 실행 규칙(02-console-core.md 5.2). worker 루프가 `readLine`으로 받은 값(`string | null`)을 그대로 `run()`에
 * 넘기면 `null` 취소 → 콘솔 실행 → 화면 규칙(값 에코 `writeOutput`, 오류 `writeError`)으로 옮기고 다음 프롬프트와
 * `exit`·`pending`을 돌려준다. 분기 순서(RD-011 확정 2): `line === null` → 취소 / `repl.pending() !== undefined` →
 * 블록 입력 중이므로 줄 단위로 흘려 넣는다(`replayLines`) / 개행이 있으면 `split_paste`로 문장 단위 분할(`runMultiline`) /
 * 아니면 기존 한 줄. `run()` 전체를 `KeyboardInterrupt` 안전망으로 감싸 사용자 코드 밖에서 새는 인터럽트가 worker 루프를
 * 죽이지 않게 한다(TRP-009).
 */
import type { PyodideInterface } from "pyodide";
import type { ReplConsole, RunLineResult } from "./console";
import type { SplitPaste } from "./multiline";

export const PS1 = ">>> ";
export const PS2 = "... ";

/**
 * 둘 다 끝 개행 없는 텍스트를 받는다(05-output.md 4.1). sink(`readline.println`)가 개행을 붙이므로 끝 개행을 붙여
 * 넘기면 프롬프트 앞에 빈 줄이 하나 더 생긴다. worker에서는 RPC `notify` 래퍼다.
 */
export interface SubmissionIO {
  writeOutput(text: string): void;
  writeError(text: string): void;
}

export interface SubmissionResult {
  prompt: string;
  exit: boolean;
  /** 블록 입력 중일 때만. `repl.pending()` 그대로(main의 자동 들여쓰기·Tab 완성이 쓴다). */
  pending?: string;
}

export interface SubmissionRunner {
  /** `null`은 입력 취소 신호다: 미완성 블록을 버리고 `>>> `로 돌아간다. worker 루프는 줄과 신호를 구분하지 않는다. */
  run(line: string | null): Promise<SubmissionResult>;
}

export interface SubmissionRunnerDeps {
  splitPaste: SplitPaste;
}

/** 오류 문자열은 끝 개행이 하나 붙어 온다. 그 하나만 떼고, 메시지 자체의 개행은 CPython처럼 남긴다. */
function withoutTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

export function createSubmissionRunner(
  pyodide: Pick<PyodideInterface, "ffi">,
  repl: Pick<
    ReplConsole,
    "runLine" | "pending" | "clearPending" | "compilerFlags"
  >,
  io: SubmissionIO,
  deps: SubmissionRunnerDeps,
): SubmissionRunner {
  /** 미완성 블록을 버리고 `KeyboardInterrupt`만 쓴다(3.14 REPL이 프롬프트에서 취소할 때와 같다, 트레이스백 없음). */
  function cancel(): SubmissionResult {
    repl.clearPending();
    io.writeError("KeyboardInterrupt");
    return { prompt: PS1, exit: false };
  }

  /**
   * JS↔Python 변환 중에 끊기면 `KeyboardInterrupt`가 `ConversionError`에 감싸여 `err.type`이 달라진다.
   * 메시지의 연쇄 예외 출력에서 단독 `KeyboardInterrupt` 줄로도 판별한다.
   */
  function isKeyboardInterrupt(err: unknown): boolean {
    return (
      err instanceof pyodide.ffi.PythonError &&
      (err.type === "KeyboardInterrupt" ||
        /^KeyboardInterrupt\s*$/m.test(err.message))
    );
  }

  /** 취소 처리 자체가 다시 끊기면 buffer 정리는 포기하고 출력만 낸다(SIGINT는 이미 소비됐다). */
  function recoverFromInterrupt(): SubmissionResult {
    try {
      return cancel();
    } catch (err) {
      if (!isKeyboardInterrupt(err)) throw err;
      io.writeError("KeyboardInterrupt");
      return { prompt: PS1, exit: false };
    }
  }

  /** 한 줄을 push하고 화면 규칙(값 에코·오류 표시)까지 옮긴다. 한 줄 경로와 분할 경로가 공유한다. */
  async function runOne(
    line: string,
    options: { echo: boolean },
  ): Promise<RunLineResult> {
    const result = await repl.runLine(line, options);
    if (result.kind === "syntax-error" || result.kind === "error") {
      io.writeError(withoutTrailingNewline(result.formattedError));
    } else if (
      result.kind === "complete" &&
      options.echo &&
      result.echo !== null
    ) {
      io.writeOutput(result.echo);
    }
    return result;
  }

  /** 줄 하나(또는 분할 재생) 처리를 마친 뒤의 최종 결과. 블록이 아직 열려 있으면 `... `와 pending을 함께 돌려준다. */
  function resultAfter(result: RunLineResult): SubmissionResult {
    if (result.kind === "incomplete") {
      return { prompt: PS2, exit: false, pending: repl.pending() };
    }
    if (result.kind === "complete") {
      return { prompt: PS1, exit: result.exited };
    }
    // syntax-error · error: runOne이 이미 오류를 표시했다.
    return { prompt: PS1, exit: false };
  }

  /**
   * 블록 입력 중(`... `) 붙여넣은 여러 줄은 분할하면 이미 열려 있는 블록과 어긋나므로(IndentationError) 한 줄씩
   * 흘려 넣는다(RD-011 확정 3). 첫 오류(문법·런타임)나 `exit()`에서 나머지 줄을 버린다. 블록 안 빈 줄이 블록을
   * 끝내는 한계는 이 경로에만 남는다(편차, `02-console-core.md` 5.2).
   */
  async function replayLines(text: string): Promise<SubmissionResult> {
    let result: RunLineResult = { kind: "incomplete" };
    for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
      result = await runOne(line, { echo: true });
      if (result.kind === "syntax-error" || result.kind === "error") break;
      if (result.kind === "complete" && result.exited) break;
    }
    return resultAfter(result);
  }

  /**
   * 문장 하나(chunk)의 줄들을 순서대로 push한다. 실패하거나 종료되면 거기서 멈춘다. 복합문은 빈 줄이 와야
   * 블록이 끝나므로 마지막 결과가 `incomplete`면 빈 줄을 한 번 더 push한다.
   */
  async function runChunk(
    lines: string[],
    echo: boolean,
  ): Promise<RunLineResult> {
    let result: RunLineResult = { kind: "incomplete" };
    for (const line of lines) {
      result = await runOne(line, { echo });
      if (result.kind === "syntax-error" || result.kind === "error")
        return result;
      if (result.kind === "complete" && result.exited) return result;
    }
    return result.kind === "incomplete" ? runOne("", { echo }) : result;
  }

  /** 개행이 든 제출: `split_paste`로 top-level 문장 단위 chunk로 나눠 순서대로 실행한다(CPython 3.14 REPL 동등). */
  async function runMultiline(text: string): Promise<SubmissionResult> {
    const [error, chunks] = deps.splitPaste(text, repl.compilerFlags());
    if (error !== undefined) {
      io.writeError(withoutTrailingNewline(error));
      return { prompt: PS1, exit: false };
    }
    for (const [index, chunk] of chunks.entries()) {
      // 마지막 문장의 값만 에코한다.
      const result = await runChunk(chunk, index === chunks.length - 1);
      if (result.kind === "complete" && result.exited)
        return { prompt: PS1, exit: true };
      if (result.kind === "syntax-error" || result.kind === "error") break;
    }
    return { prompt: PS1, exit: false };
  }

  return {
    async run(line) {
      try {
        // `push(null)`은 콘솔 buffer를 `JsNull`로 오염시키므로 `null` 분기가 가장 먼저다.
        if (line === null) return cancel();
        // `replayLines`·`runMultiline`은 반드시 `await`한다 — 그냥 `return`하면 async 함수의 반환값 채택이
        // 이 try/catch 밖에서 일어나 안에서 새는 KeyboardInterrupt를 못 잡는다.
        if (repl.pending() !== undefined) return await replayLines(line);
        if (/[\r\n]/.test(line)) return await runMultiline(line);
        return resultAfter(await runOne(line, { echo: true }));
      } catch (err) {
        if (!isKeyboardInterrupt(err)) throw err;
        return recoverFromInterrupt();
      }
    },
  };
}
