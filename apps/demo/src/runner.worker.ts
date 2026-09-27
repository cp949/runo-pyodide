import { runDriver, runWorker } from "@cp949/runo-pyodide-core/worker";

// 실행창(`?view=runner`)의 worker. core worker 커널에 실행 driver를 넘긴다(RD-022).
runWorker({ driver: runDriver });
