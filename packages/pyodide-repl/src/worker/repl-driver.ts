/**
 * REPL worker driver(RD-020). core worker 커널(`runWorker`, `@cp949/runo-pyodide-core/worker`)이 공통 부팅
 * (RPC → loadPyodide → 콘솔 → 런타임 연결(`attachRuntime`, `docs/design/03-ctrl-c.md` 2.6) → `ready` → 감시 타이머)을 맡고, 이 driver는
 * REPL 전용 부분을 낸다(초기화 프레임 `driver` 필드 `{ topLevelAwait }`의 검증 포함): `complete` RPC 핸들러, 콘솔 확장(`sys.ps1/ps2`·헬퍼·TLA·완성기), pyodide 비공개 지점 탐지(`probe`), 배너·제출 러너·`{ source }` 실행기(RD-022a)·`readLine` 루프.
 */
import {
  discardPendingInterrupt,
  type ConsoleContext,
  type PyodideConsoleProxy,
  type RunContext,
  type WorkerDriver,
  type WorkerDriverSession,
} from "@cp949/runo-pyodide-core/worker";
import {
  parseReplDriverOptions,
  type ReplDriverOptions,
} from "../driver-options";
import type { ReadLineReply } from "../repl-protocol";
import { loadCompleteSource, type CompleteSource } from "./complete-source";
import { createConsole, type ReplConsole } from "./console";
import { loadSplitPaste } from "./multiline";
import { runReplLoop } from "./repl-loop";
import { createSourceRunner } from "./run-source";
import { createSubmissionRunner } from "./submission-runner";

/** `atPrompt`가 아니거나 `completer`가 아직 없을 때(콘솔 생성 전) `complete` 요청에 돌려주는 빈 응답. */
function emptyCompletion() {
  return { completions: [], start: 0 };
}

function createReplSession(options: ReplDriverOptions): WorkerDriverSession {
  // complete 핸들러는 createRpc 생성 시에만 등록할 수 있다(core `protocol/rpc.ts`, 나중 등록 API 없음). 콘솔이 아직 없는
  // 동안(로드 중)과 프롬프트 대기 중이 아닌 동안(실행 중)은 completer/atPrompt를 클로저로 읽어 빈 응답으로 답한다.
  let completer: CompleteSource | null = null;
  let atPrompt = false;
  let repl: ReplConsole;
  return {
    handlers: {
      complete: (source: string, pending: string | undefined) =>
        atPrompt && completer ? completer(source, pending) : emptyCompletion(),
    },
    createConsole({ pyodide, sinks }: ConsoleContext): PyodideConsoleProxy {
      repl = createConsole(pyodide, sinks, {
        topLevelAwait: options.topLevelAwait,
      });
      completer = loadCompleteSource(pyodide, repl.pyconsole);
      return repl.pyconsole;
    },
    // pyodide 비공개 지점 탐지(`compiler-flags`·`incomplete-input-message`). core가 `createConsole` 직후 한 번 부른다.
    probe: () => repl.probe(),
    async run({ pyodide, rpc, frame }: RunContext): Promise<void> {
      // sink(println)가 개행을 붙이므로 배너에 개행을 더하지 않는다(TRAP-29).
      rpc.notify("writeOutput", repl.banner);
      const splitPaste = loadSplitPaste(pyodide);
      const runner = createSubmissionRunner(
        pyodide,
        repl,
        {
          writeOutput: (text) => rpc.notify("writeOutput", text),
          writeError: (text) => rpc.notify("writeError", text),
        },
        { splitPaste },
      );
      // `{ source }` 응답(RD-022a `runSource`) 실행기. 세션마다 한 번 올리고 루프가 끝나면(정상 종료·RPC 종료) 놓는다.
      const sourceRunner = createSourceRunner(pyodide, repl);
      try {
        await runReplLoop({
          readLine: (prompt, pending, outcome) =>
            // 결말은 `{ source }` 실행 직후 요청에만 싣는다. 없으면 기존 3인자 요청 그대로다.
            outcome === undefined
              ? rpc.call<ReadLineReply>("readLine", prompt, pending, true)
              : rpc.call<ReadLineReply>(
                  "readLine",
                  prompt,
                  pending,
                  true,
                  outcome,
                ),
          setAtPrompt: (value) => {
            atPrompt = value;
          },
          discardPendingInterrupt: () =>
            discardPendingInterrupt(frame.interruptBuffer),
          run: (line) => runner.run(line),
          runSource: (source) => sourceRunner.run(source),
          onTerminated: () => rpc.notify("sessionTerminated"),
          onError: (error) => {
            console.error("[repl.worker] 루프 오류", error);
            rpc.notify("writeError", `repl 내부 오류: ${String(error)}`);
            try {
              repl.clearPending();
            } catch {
              // 콘솔 상태를 읽을 수 없으면 다음 push가 새 상태를 만든다.
            }
          },
        });
      } finally {
        sourceRunner.destroy();
      }
    },
    atPrompt: () => atPrompt,
  };
}

/** REPL driver. `runWorker({ driver: replDriver })`가 worker 하나에 세션 하나를 만든다. */
export const replDriver: WorkerDriver<ReplDriverOptions> = {
  parseOptions: parseReplDriverOptions,
  createSession: createReplSession,
};
