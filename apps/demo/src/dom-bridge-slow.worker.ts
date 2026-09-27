// S5 시험 worker(`?view=dom-bridge&mode=slow`): `dom-bridge.worker.ts`에 시험 플러그인을 더한다. dom-bridge `./worker`가 첫 import다.
import { bridge, domBridge } from "@cp949/runo-pyodide-dom-bridge/worker";
import { runDriver, runWorker } from "@cp949/runo-pyodide-core/worker";
import type { WorkerPlugin } from "@cp949/runo-pyodide-core/worker";

/** guard 수정 전의 옛 구현(target이 원격 프록시 자체, `get` trap만). Python 속성 접근 실패의 원인 분리용 대조로만 노출한다. */
function oldGuardedWindow<T extends object>(target: T): T {
  return new Proxy(target, {
    get(original, property) {
      if (
        typeof property === "string" &&
        ["parent", "top", "opener"].includes(property)
      )
        throw new Error(`옛 guard: window.${property}`);
      return Reflect.get(original, property);
    },
  });
}

// `runo_test`(시험 전용 JS 모듈):
// - `slow(ms)`: main이 `worker.proxy.slow`에 등록한 Promise 핸들러. coincident 동기 호출이라 main이 Promise를 정착시킬 때까지 worker가
//   막힌다(호출 도중 `interrupt()`가 전달되지 않는 S5 동작의 재현 장치).
// - `raw_window`·`old_guarded_window`: guard 없는 원격 창 프록시와 옛 guard. guard가 Python 속성 접근에 미치는 영향을 분리하는 대조다.
const slowPlugin: WorkerPlugin = {
  name: "dom-bridge-test-slow",
  async prepare({ pyodide }) {
    const { proxy, window } = await bridge();
    pyodide.registerJsModule("runo_test", {
      slow: proxy.slow,
      raw_window: window,
      old_guarded_window: oldGuardedWindow(window),
    });
  },
};

runWorker({ driver: runDriver, plugins: [domBridge(), slowPlugin] });
