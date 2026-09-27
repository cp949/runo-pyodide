import { runWorker } from "@cp949/runo-pyodide-core/worker";
import { replDriver } from "./worker/repl-driver";

/**
 * worker 쪽 진입점. 앱의 얇은 worker 파일이 부른다('@cp949/runo-pyodide-repl/worker').
 * core worker 커널(`runWorker`)에 REPL driver를 넘긴다. 초기화 프레임 수신·검증·부팅 시퀀스는 core가 맡고,
 * 부팅 뒤 REPL 루프는 worker 내부에서 `readLine` RPC를 요청하며 이어진다.
 */
export function runReplWorker(): void {
  runWorker({ driver: replDriver });
}
