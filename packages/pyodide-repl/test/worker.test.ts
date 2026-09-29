/**
 * repl worker 진입점 `runReplWorker()` 시험.
 * 초기화 프레임 수신·검증·부팅은 core `runWorker`의 몫이다(core `test/worker/run-worker.test.ts`).
 * 여기서는 REPL driver를 그 커널에 넘기는지만 본다.
 */
import { expect, test, vi } from "vitest";
import { runWorker } from "@cp949/runo-pyodide-core/worker";
import { runReplWorker } from "../src/worker";
import { replDriver } from "../src/worker/repl-driver";

vi.mock("@cp949/runo-pyodide-core/worker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cp949/runo-pyodide-core/worker")>()),
  runWorker: vi.fn(),
}));

test("runReplWorker는 REPL driver로 core worker 커널을 시작한다", () => {
  runReplWorker();

  expect(runWorker).toHaveBeenCalledTimes(1);
  expect(runWorker).toHaveBeenCalledWith({ driver: replDriver });
});
