// 늦은 `runWorker` 시험 worker(`?view=dom-bridge&mode=late-run`): dom-bridge `./worker`는 첫 정적 import지만 `runWorker`를 브리지가
// 준비된 뒤 매크로태스크를 넘겨 부른다. core `./worker`가 모듈 평가 시점에 init 프레임을 버퍼링하므로 이 배치도 `ready`가 된다
// (RD-023 이전에는 init 프레임을 잃고 진단 없이 `loading`에 머물렀다). init 도착 여부는 console로 남겨 e2e가 "호출 전 도착"을 확인한다.
import { bridge, domBridge } from "@cp949/runo-pyodide-dom-bridge/worker";
import { runDriver, runWorker } from "@cp949/runo-pyodide-core/worker";

let initSeen = false;
self.addEventListener("message", (event) => {
  const data = (event as MessageEvent).data as { kind?: unknown } | null;
  if (data !== null && !Array.isArray(data) && data.kind === "init")
    initSeen = true;
});

// 지연 50ms는 "init 프레임보다 늦게 부른다"는 배치를 만드는 장치다(판정 대기가 아니다). 성립 여부는 `initSeen` 로그로 확인한다.
void bridge().then(() => {
  setTimeout(() => {
    console.info(`[late-run] runWorker 호출 시점 init 도착=${initSeen}`);
    runWorker({ driver: runDriver, plugins: [domBridge()] });
  }, 50);
});
