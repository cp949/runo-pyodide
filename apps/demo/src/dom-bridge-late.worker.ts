// LATE 양성 대조(`?view=dom-bridge&mode=late`): 첫 정적 import 규칙을 어긴 worker.
// - dom-bridge `./worker`를 정적 import하지 않는다.
// - 플러그인 `prepare`(init 프레임·`loadPyodide` 뒤)에서 동적 import한다.
// - 그 시점에는 부트스트랩 메시지가 이미 지나갔다. 관찰기가 이를 보지 못한다.
// - `domBridge()`가 명시 오류로 실패한다. 세션이 `load-failed`가 되고 대기 상태로 남지 않는다.
import { runDriver, runWorker } from "@cp949/runo-pyodide-core/worker";
import type { WorkerPlugin } from "@cp949/runo-pyodide-core/worker";

const lateDomBridge: WorkerPlugin = {
  // 실제 플러그인과 같은 이름이다. `load-failed` 문구 접두가 정상 배치의 실패와 같은 형태가 된다.
  name: "dom-bridge",
  async prepare(context) {
    const { domBridge } = await import("@cp949/runo-pyodide-dom-bridge/worker");
    await domBridge().prepare(context);
  },
};

runWorker({ driver: runDriver, plugins: [lateDomBridge] });
