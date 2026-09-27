import { PythonRunner, RunRejectedError } from "@cp949/runo-pyodide-repl-react";
import type {
  CopyResult,
  PythonRunnerHandle,
  RunnerStatus,
} from "@cp949/runo-pyodide-repl-react";
import "@xterm/xterm/css/xterm.css";
import { useRef, useState } from "react";
import { createRunnerWorker } from "./create-worker";

/** `run()`이 끝났을 때 `result`에 보여 줄 문자열. 결과 유니온은 JSON, 거부는 `{"rejected":"<reason>"}`. */
function describeError(error: unknown): string {
  if (error instanceof RunRejectedError)
    return JSON.stringify({ rejected: error.reason });
  return JSON.stringify({ error: String(error) });
}

/**
 * 실행창 데모(`?view=runner`, RD-022). plain 요소만 쓴다: 코드 입력 `textarea`, `run`·`stop`·`reset`·`clear` 버튼, 상태, 마지막
 * 결과(JSON 텍스트), 마지막 선택 복사 결과(`copy-result`), xterm 터미널. 터미널·runner 생성·정리는 `<PythonRunner>`(`@cp949/runo-pyodide-repl-react`,
 * RD-024)가 맡는다(StrictMode의 mount → cleanup → mount에서도 worker가 남지 않는다). 기본 크기는 xterm 기본 80×24(`fit={false}`)이고
 * 쿼리 `?fit=1`이면 `fit`이 켜져 컨테이너 크기를 따른다(`App`이 prop으로 넘긴다). 새 실행을 시작하면 이전 결과를 지운다.
 */
export function RunnerView({ fit }: { fit: boolean }) {
  const runnerRef = useRef<PythonRunnerHandle>(null);
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<RunnerStatus>("loading");
  const [result, setResult] = useState("");
  const [copyResult, setCopyResult] = useState("");

  const run = () => {
    const runner = runnerRef.current;
    if (runner === null) return;
    setResult("");
    // 입력(`input()`)을 바로 칠 수 있게 터미널에 포커스를 준다.
    runner.focus();
    runner.run(code).then(
      (outcome) => setResult(JSON.stringify(outcome)),
      (error: unknown) => setResult(describeError(error)),
    );
  };

  return (
    <>
      <p>
        status: <output data-testid="status">{status}</output>
      </p>
      <textarea
        data-testid="code"
        rows={6}
        cols={80}
        spellCheck={false}
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <div>
        <button type="button" data-testid="run" onClick={run}>
          run
        </button>{" "}
        <button
          type="button"
          data-testid="stop"
          onClick={() => void runnerRef.current?.stop()}
        >
          stop
        </button>{" "}
        <button
          type="button"
          data-testid="reset"
          onClick={() => runnerRef.current?.reset()}
        >
          reset
        </button>{" "}
        <button
          type="button"
          data-testid="clear"
          onClick={() => runnerRef.current?.clear()}
        >
          clear
        </button>
      </div>
      <p>
        result: <output data-testid="result">{result}</output>
      </p>
      <p>
        copy: <output data-testid="copy-result">{copyResult}</output>
      </p>
      <PythonRunner
        ref={runnerRef}
        data-testid="terminal"
        createWorker={createRunnerWorker}
        terminalOptions={{ cursorBlink: true }}
        fit={fit}
        onStatus={setStatus}
        // 드래그 선택 복사와 선택 중 Ctrl+C 복사의 결과를 화면에 남긴다(토스트 대신 plain 텍스트).
        onCopy={(r: CopyResult) =>
          setCopyResult(r.ok ? `copied ${r.chars} chars` : "copy failed")
        }
      />
    </>
  );
}
