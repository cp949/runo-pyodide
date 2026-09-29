import { createRunner } from "@cp949/runo-pyodide-core";
import type { RunnerStatus } from "@cp949/runo-pyodide-core";
import { useEffect, useState } from "react";
import { createDomBridgeWorker } from "./create-dom-bridge-worker";
import { log } from "./dom-bridge-log";

/**
 * dom-bridge 순서 시험용 화면(`?view=dom-bridge&runner=core`, 시험 훅).
 *
 * - `<PythonRunner>`·terminal 없이 core `createRunner`를 직접 쓴다.
 * - 출력 수신(`onOutput`)이 xterm 렌더와 분리된다.
 * - e2e S6이 이 경로와 `<PythonRunner>` + terminal 경로(`DomBridgeView`)를 비교한다.
 * - 비교 대상은 출력·DOM 도착 순서의 역전 수다. 역전 수는 판정 없이 기록한다.
 * - 필수 기준은 기록 누락 0과 모든 실행 `ok`다.
 * - 실행은 `window.__domBridgeCore.run(code)`로 한다. 결말은 이벤트 열(`dom-bridge-log.ts`)에 `outcome`으로도 남는다.
 * - `?view=dom-bridge`의 조작 요소(textarea·버튼)는 두지 않는다.
 */
export function DomBridgeCoreView() {
  const [status, setStatus] = useState<RunnerStatus>("loading");

  // 마운트 때 runner를 만들고 시험 훅을 건다. 언마운트하면 runner를 정리한다.
  useEffect(() => {
    const runner = createRunner({
      createWorker: createDomBridgeWorker,
      onOutput: (chunk) => log("out", chunk),
      onStatus: (next) => {
        log("status", next);
        setStatus(next);
      },
      inputProvider: async () => null,
    });
    (
      window as unknown as { __domBridgeCore: { run(code: string): unknown } }
    ).__domBridgeCore = {
      run: async (code: string) => {
        log("runStart");
        const outcome = await runner.run(code);
        log("outcome", outcome);
        return outcome;
      },
    };
    return () => runner.dispose();
  }, []);

  return (
    <p>
      status: <output data-testid="status">{status}</output>
    </p>
  );
}
