/**
 * dom-bridge worker 플러그인의 `prepare`. 브리지 준비(`bridge`)와 부트스트랩 수신 여부(`receivedBootstrap`)를 주입받아
 * coincident 없이 순서·오류 경로를 시험할 수 있다. `./worker`가 실제 coincident와 관찰기를 물려 `domBridge()`로 낸다.
 *
 * 순서: ① 부트스트랩 미수신이면 명시 오류(`bridge()`를 부르지 않는다: 부르면 영원히 대기한다. 원인은 첫 정적 import 위반이거나 main이
 * `createBridgeMain()`의 `Worker`가 아닌 전역 `Worker`로 만든 것이다) → ② `await bridge()` →
 * ③ `native === false`면 명시 오류(동기 DOM이 오류 없이 무효가 되는 것을 막는다, TRP-065) → ④ `runo` 모듈 등록.
 * 던진 오류는 core `bootWorker`가 `plugin "dom-bridge": ` 접두를 붙여 `loadFailed`로 알린다.
 */
import type { WorkerPlugin } from "@cp949/runo-pyodide-core/worker";
import { guardedWindow } from "./guarded-window";
import type { WorkerBridge } from "./worker-bridge";

export interface DomBridgePluginDeps {
  receivedBootstrap(): boolean;
  bridge(): Promise<WorkerBridge>;
}

export function createDomBridgePlugin(deps: DomBridgePluginDeps): WorkerPlugin {
  return {
    name: "dom-bridge",
    async prepare({ pyodide }) {
      if (!deps.receivedBootstrap())
        throw new Error(
          "coincident 부트스트랩 메시지를 받지 못했다. 가능한 원인은 둘이다. " +
            "① dom-bridge ./worker가 worker 파일의 첫 정적 import가 아니다: " +
            'worker 파일 맨 위에서 import "@cp949/runo-pyodide-dom-bridge/worker"를 다른 import보다 먼저 둔다(동적 import 금지). ' +
            "② main이 createBridgeMain()이 돌려준 Worker가 아니라 전역 Worker로 worker를 만들었다: " +
            "const { Worker } = createBridgeMain()으로 받은 Worker로 만든다.",
        );
      const { window, native } = await deps.bridge();
      if (!native)
        throw new Error(
          "동기 DOM 브리지(native)를 쓸 수 없다. growable SharedArrayBuffer가 필요하다(cross-origin isolation: COOP same-origin·COEP require-corp, 지원 브라우저). " +
            "서비스워커 경로는 지원하지 않는다. 소비자는 worker를 만들기 전에 isDomBridgeSupported()로 거를 수 있다.",
        );
      pyodide.registerJsModule("runo", {
        browser: { window: guardedWindow(window), document: window.document },
      });
    },
  };
}
