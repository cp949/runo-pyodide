// N0 시험 worker(`?view=dom-bridge&native=0`): `dom-bridge.worker.ts`와 같지만 growable SharedArrayBuffer를 가린 채 시작한다.
// `force-non-native`가 coincident보다 먼저 평가돼야 하므로 첫 import다(dom-bridge `./worker`가 그다음).
import "./force-non-native";
import { domBridge } from "@cp949/runo-pyodide-dom-bridge/worker";
import { runDriver, runWorker } from "@cp949/runo-pyodide-core/worker";

runWorker({ driver: runDriver, plugins: [domBridge()] });
