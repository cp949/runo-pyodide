import { createBridgeMain } from "@cp949/runo-pyodide-dom-bridge";
import type { BridgeMainWorker } from "@cp949/runo-pyodide-dom-bridge";
import { log } from "./dom-bridge-log";

/**
 * dom-bridge 실행창(`?view=dom-bridge`) worker 생성 경로. `<PythonRunner>`의 `createWorker` prop(재시작마다 다시 호출됨)으로 넘긴다.
 * `create-worker.ts`와 달리 별도 파일이다: 이 모듈은 coincident(`@cp949/runo-pyodide-dom-bridge`)를 정적으로 import하고, coincident는
 * 평가될 때 전역 `EventTarget.prototype.addEventListener`를 패치한다. REPL·실행창 화면이 이 패치를 받지 않도록 `DomBridgeView`(지연
 * import)만 이 모듈을 가져온다.
 *
 * Vite가 worker를 번들하려면 `new Worker(new URL(리터럴, import.meta.url), ...)` 형태여야 하고, coincident `Worker` 생성자의 지역 이름이
 * `Worker`여야 알아본다. 시험 훅(쿼리)으로 worker 파일이 갈린다:
 * - `?native=0`: growable SharedArrayBuffer를 가린 worker(N0)
 * - `?mode=slow`: `runo_test.slow`가 있는 worker + main 쪽 `slow` 핸들러(S5)
 * - `?mode=late`: dom-bridge를 늦게 import하는 worker(LATE 양성 대조)
 * - `?mode=late-run`: `runWorker`를 늦게 부르는 worker(init 버퍼링 확인)
 * - 그 밖: 정상 worker
 */
export function createDomBridgeWorker(): Worker {
  const { Worker } = createBridgeMain();
  const params = new URLSearchParams(globalThis.location.search);
  const mode = params.get("mode");
  if (params.get("native") === "0")
    return new Worker(
      new URL("./dom-bridge-native0.worker.ts", import.meta.url),
      { type: "module" },
    );
  if (mode === "slow") {
    const worker = new Worker(
      new URL("./dom-bridge-slow.worker.ts", import.meta.url),
      { type: "module" },
    );
    registerSlow(worker);
    return worker;
  }
  if (mode === "late")
    return new Worker(new URL("./dom-bridge-late.worker.ts", import.meta.url), {
      type: "module",
    });
  if (mode === "late-run")
    return new Worker(
      new URL("./dom-bridge-late-run.worker.ts", import.meta.url),
      { type: "module" },
    );
  return new Worker(new URL("./dom-bridge.worker.ts", import.meta.url), {
    type: "module",
  });
}

let slowSeq = 0;

/**
 * S5: main 쪽 오래 걸리는 Promise. worker의 Python이 `runo_test.slow(ms)`로 부르면 coincident 동기 호출이라 이 Promise가 정착할
 * 때까지 worker가 막힌다. 시작·종료를 기록해 e2e가 "결말이 호출 반환 뒤에 왔는가"를 이벤트 순서로 판정하게 한다.
 */
function registerSlow(worker: BridgeMainWorker): void {
  worker.proxy.slow = (ms: number) => {
    const id = ++slowSeq;
    log("slowStart", { id, ms });
    return new Promise<string>((resolve) =>
      setTimeout(() => {
        log("slowDone", { id, ms });
        resolve(`slow-done-${ms}`);
      }, ms),
    );
  };
}
