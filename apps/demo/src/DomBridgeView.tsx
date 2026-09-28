// `./force-non-native`는 coincident를 가져오는 어떤 모듈보다 먼저 평가돼야 한다(`?native=0` 시험 훅, `TRP-066`). 첫 import를 유지한다.
import "./force-non-native";
import { detectRuntimeSupport } from "@cp949/runo-pyodide-core";
import {
  createBridgeMain,
  isDomBridgeSupported,
} from "@cp949/runo-pyodide-dom-bridge";
import { PythonRunner, RunRejectedError } from "@cp949/runo-pyodide-repl-react";
import type {
  PythonRunnerHandle,
  RunnerStatus,
} from "@cp949/runo-pyodide-repl-react";
import "@xterm/xterm/css/xterm.css";
import { useRef, useState } from "react";
import { createDomBridgeWorker } from "./create-dom-bridge-worker";
import { DomBridgeCoreView } from "./DomBridgeCoreView";
import { log } from "./dom-bridge-log";

/** `run()`이 끝났을 때 `result`에 보여 줄 문자열(`RunnerView`와 같은 형태). */
function describeError(error: unknown): string {
  if (error instanceof RunRejectedError)
    return JSON.stringify({ rejected: error.reason });
  return JSON.stringify({ error: String(error) });
}

/** dom-bridge를 쓸 수 없는 이유(사용자에게 보여 준다). `isDomBridgeSupported()`가 false인 세 원인을 구분한다(`docs/adr/0008-chrome84-build-floor-and-pyodide-runtime-floor.md`). */
function unsupportedReason(): string {
  const support = detectRuntimeSupport();
  if (support === "unsupported")
    return "이 브라우저는 pyodide 런타임이 요구하는 기능을 지원하지 않아 동기 DOM 브리지를 쓸 수 없습니다. 브라우저 호환(README) 절을 확인하세요.";
  if (support === "not-isolated")
    return "cross-origin isolation이 꺼져 있어 동기 DOM 브리지를 쓸 수 없습니다. 서버가 COOP/COEP 헤더를 보내야 합니다.";
  return "growable SharedArrayBuffer를 만들 수 없어 동기 DOM 브리지를 쓸 수 없습니다.";
}

/**
 * dom-bridge 실행창 데모(`?view=dom-bridge`, RD-023). `RunnerView`와 같은 plain 조작 요소(코드 입력·`run`·`stop`·`reset`·`clear`·상태·
 * 결과)에 `<canvas>`를 더한다. Python은 `from runo.browser import document`로 이 페이지의 `document`·`window`를 동기로 다룬다
 * (`input()`·출력·Ctrl+C는 core 채널). `isDomBridgeSupported()`가 false면 worker를 만들지 않고 이유만 보인다. 쿼리 `?gate=off`는
 * 이 검사를 건너뛰는 시험 훅이다(worker가 `load-failed`로 실패하는 경로를 보려면 worker가 만들어져야 한다). 쿼리 `?runner=core`는 `<PythonRunner>` 대신 core `createRunner`를 직접 쓰는 순서 시험 화면(`DomBridgeCoreView`)을 그린다.
 * REPL과의 조합은 지원하지 않는다(ADR-0006).
 */
export function DomBridgeView({ fit }: { fit: boolean }) {
  const { native } = createBridgeMain();
  const supported = isDomBridgeSupported();
  const params = new URLSearchParams(globalThis.location.search);
  const gateOff = params.get("gate") === "off";
  return (
    <>
      <p>
        native: <output data-testid="native">{String(native)}</output>{" "}
        supported: <output data-testid="supported">{String(supported)}</output>
      </p>
      {supported || gateOff ? (
        params.get("runner") === "core" ? (
          <DomBridgeCoreView />
        ) : (
          <DomBridgeRunner fit={fit} />
        )
      ) : (
        <p data-testid="unsupported">{unsupportedReason()}</p>
      )}
    </>
  );
}

/** canvas(`#dom-canvas`)에 파란 사각형을 그리는 고정 Python 코드(`draw` 버튼용). */
const DRAW_CODE = [
  "from runo.browser import document",
  'ctx = document.getElementById("dom-canvas").getContext("2d")',
  'ctx.fillStyle = "rgb(0,120,255)"',
  "ctx.fillRect(70, 30, 60, 40)",
  'print("drawn", flush=True)',
].join("\n");

function DomBridgeRunner({ fit }: { fit: boolean }) {
  const runnerRef = useRef<PythonRunnerHandle>(null);
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<RunnerStatus>("loading");
  const [result, setResult] = useState("");

  /** `code`를 실행하고 결과를 `result`에 반영한다(`run`·`draw` 공통). */
  const runCode = (label: string, source: string) => {
    const runner = runnerRef.current;
    if (runner === null) return;
    setResult("");
    log(label);
    // 입력(`input()`)을 바로 칠 수 있게 터미널에 포커스를 준다.
    runner.focus();
    runner.run(source).then(
      (outcome) => {
        log("outcome", outcome);
        setResult(JSON.stringify(outcome));
      },
      (error: unknown) => {
        log("outcome", { error: String(error) });
        setResult(describeError(error));
      },
    );
  };

  const run = () => runCode("runStart", code);
  const draw = () => runCode("drawStart", DRAW_CODE);

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
        <button type="button" data-testid="draw" onClick={draw}>
          draw
        </button>{" "}
        <button
          type="button"
          data-testid="stop"
          onClick={() => {
            log("stop");
            void runnerRef.current?.stop();
          }}
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
      <PythonRunner
        ref={runnerRef}
        data-testid="terminal"
        createWorker={createDomBridgeWorker}
        terminalOptions={{ cursorBlink: true }}
        fit={fit}
        onStatus={(next) => {
          log("status", next);
          setStatus(next);
        }}
        onOutput={(chunk) => log("out", chunk)}
      />
      <p>draw 코드:</p>
      <pre data-testid="draw-code">{DRAW_CODE}</pre>
      <canvas id="dom-canvas" data-testid="canvas" width={200} height={100} />
    </>
  );
}
