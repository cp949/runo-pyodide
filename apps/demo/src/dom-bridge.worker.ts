// dom-bridge 첫 정적 import 규칙(RD-023): `@cp949/runo-pyodide-dom-bridge/worker`가 이 파일의 첫 import여야 한다. coincident가 이 모듈이
// 평가될 때 부트스트랩 리스너를 건다. 순서를 바꾸거나 동적 import로 바꾸면 세션이 `load-failed`가 된다(`dom-bridge-late.worker.ts`).
import { domBridge } from "@cp949/runo-pyodide-dom-bridge/worker";
import { runDriver, runWorker } from "@cp949/runo-pyodide-core/worker";

// `?view=dom-bridge`의 worker. 실행 driver에 dom-bridge 플러그인을 더해 Python에서 `from runo.browser import document`를 쓴다.
runWorker({ driver: runDriver, plugins: [domBridge()] });
