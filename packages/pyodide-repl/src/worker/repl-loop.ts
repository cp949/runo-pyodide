/**
 * REPL 한 세션의 제어 흐름(00-architecture.md 3.2).
 * - 통신·프로토콜 구현은 import하지 않는다. `readLine`·`setAtPrompt`·`discardPendingInterrupt`만 주입받는다.
 * - 그래서 RPC 종료·브라우저 worker·node 시험이 같은 프롬프트 갱신 규칙을 쓴다.
 * - 여러 줄 분할(붙여넣기·Shift+Enter·히스토리 재호출)은 `submission-runner.ts`의 `run()`이 처리한다.
 *   이 루프는 결과의 `prompt`·`pending`만 그대로 옮긴다.
 * - 열린 읽기에 main이 `{ source }`로 응답하면(RD-022a `runSource`) 제출 한 건처럼 받아 REPL 콘솔에서 실행한다.
 *   그 결말을 다음 `readLine` 요청에 실어 보낸다(형식은 `../repl-protocol.ts`).
 */
import {
  isReadLineEofReply,
  isReadLineSourceReply,
  type ReadLineOutcome,
  type ReadLineReply,
} from "../repl-protocol";
import { PS1, type SubmissionResult } from "./submission-runner";

export interface ReplLoopDeps {
  /**
   * RPC `readLine(prompt, pending, true, outcome?)`.
   * - 요청 채널이 사라지면 reject되어 루프가 끝난다.
   * - `outcome`은 바로 앞 `{ source }` 응답을 실행한 결말이다. 그 실행이 없었던 요청에는 인자를 싣지 않는다(두 인자만 부른다).
   * - 응답은 줄(제출)·`null`(입력 취소)·`{ source }`(루프 명령)다.
   */
  readLine(
    prompt: string,
    pending: string | undefined,
    outcome?: ReadLineOutcome,
  ): Promise<ReadLineReply>;
  /**
   * `readLine` 요청 직전 `true`. 응답 직후(`null`에도)·`discardPendingInterrupt` 전 `false`.
   * 감시 타이머(03-ctrl-c.md 2.5)의 프롬프트 유휴 폐기가 읽는다.
   * `readLine`이 reject로 끝나면 되돌리지 않는다. 루프 종료 뒤 타이머도 꺼진다.
   */
  setAtPrompt(value: boolean): void;
  /**
   * `readLine` 응답 직후·`run` 전에 부른다(`null`에도).
   * 읽는 동안이나 Enter 직후 쓴 SIGINT는 대상 코드가 없다. 다음 문장의 컴파일·실행을 끊는다(TRAP-04).
   * `boot.ts`가 `discardPendingInterrupt(buffer)`를 넣는다.
   */
  discardPendingInterrupt(): void;
  run(line: string | null): Promise<SubmissionResult>;
  /**
   * `{ source }` 응답의 코드를 REPL 콘솔에서 실행하고 결말을 돌려준다(RD-022a).
   * 사용자 코드의 오류·`SystemExit`·중단은 결말이다.
   * 던지면 worker 내부 오류다. `onError`로 알리고 `InternalError` 결말을 싣는다.
   */
  runSource(source: string): Promise<ReadLineOutcome>;
  /**
   * `exit()`·`quit()`·`SystemExit` 뒤 한 번만 부른다.
   * `{ source }`로 실행한 코드의 `SystemExit`는 세션을 끝내지 않는다. 부르지 않는다.
   * `>>>`의 빈 줄 Ctrl+D(EOF, `{ eof: true }` 응답)도 같은 결말이다(RD-048).
   */
  onTerminated(): void;
  /** 사용자 실행 밖에서 난 오류를 boot가 화면에 알리고 콘솔 상태를 정리한다. */
  onError(error: unknown): void;
}

function isRpcDisposed(error: unknown): boolean {
  return error instanceof Error && error.message === "rpc disposed";
}

/** 읽기 → 한 줄 실행 → 다음 프롬프트 갱신을 세션 종료 또는 RPC 종료까지 반복한다. */
export async function runReplLoop(deps: ReplLoopDeps): Promise<void> {
  let prompt = PS1;
  let pending: string | undefined;
  // 바로 앞 `{ source }` 실행의 결말. 다음 `readLine` 요청에 한 번만 싣는다.
  let outcome: ReadLineOutcome | undefined;

  while (true) {
    let reply: ReadLineReply;
    deps.setAtPrompt(true);
    try {
      reply =
        outcome === undefined
          ? await deps.readLine(prompt, pending)
          : await deps.readLine(prompt, pending, outcome);
    } catch (error) {
      if (!isRpcDisposed(error)) {
        console.error("[repl.worker] readLine 실패", error);
      }
      return;
    }
    outcome = undefined;
    deps.setAtPrompt(false);

    // 읽기가 끝난 순간부터 `run`이 시작하기 전까지 도착한 눌림을 비운다. `run` 안(사용자 코드 실행)의 눌림은 비우지 않는다.
    deps.discardPendingInterrupt();

    // 루프 명령: 제출 한 건처럼 받아 실행하고 결말을 다음 요청에 싣는다. `SystemExit`여도 세션은 유지된다.
    if (isReadLineSourceReply(reply)) {
      try {
        outcome = await deps.runSource(reply.source);
      } catch (error) {
        deps.onError(error);
        outcome = {
          kind: "error",
          errorType: "InternalError",
          traceback: `repl 내부 오류: ${String(error)}\n`,
        };
        // `onError`가 콘솔의 미완성 블록을 버린다(`clearPending`). 명령 실행 오류와 같이 새 프롬프트로 돌아간다.
        prompt = PS1;
        pending = undefined;
      }
      // 성공 결말은 프롬프트·pending을 건드리지 않는다. 실행은 콘솔 buffer를 지나지 않는다. 열린 블록이 있었다면 그대로 열려 있다.
      // (main은 블록 입력 중에는 `{ source }`를 보내지 않아 실경로에서는 항상 `>>> `·pending 없음이다.)
      continue;
    }

    // EOF: `>>>`의 빈 줄 Ctrl+D(RD-048). Python을 실행하지 않고 세션을 끝낸다(`exit()`와 같은 결말).
    if (isReadLineEofReply(reply)) {
      deps.onTerminated();
      return;
    }

    try {
      const result = await deps.run(reply);
      if (result.exit) {
        deps.onTerminated();
        return;
      }
      prompt = result.prompt;
      pending = result.pending;
    } catch (error) {
      deps.onError(error);
      prompt = PS1;
      pending = undefined;
    }
  }
}
