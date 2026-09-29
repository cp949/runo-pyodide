// @vitest-environment node
/**
 * REPL driver가 `{ source }` 실행기(`createSourceRunner`)를 세션마다 한 번 만들고 루프가 끝나면 놓는지 본다(RD-022a).
 *
 * - `run-source.ts`를 전달만 하는 모의로 감싼다. 만든 실행기의 `destroy` 호출을 센다.
 * - 실제 pyodide(node)와 실제 `MessageChannel`로 `bootWorker({ driver: replDriver })`를 돌린다.
 * - main 역할(core 하니스 `createMainSide`)은 각본형 `readLine` 응답만 한다.
 */
import { loadPyodide } from "pyodide";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createMainSide as createHarnessMainSide } from "@cp949/runo-pyodide-core/test-utils";
import { bootWorker } from "@cp949/runo-pyodide-core/worker";
import { replDriver } from "../../src/worker/repl-driver";
import {
  createSourceRunner,
  type SourceRunner,
} from "../../src/worker/run-source";

vi.mock("../../src/worker/run-source", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/worker/run-source")>();
  return {
    ...original,
    // 실행기는 원본 그대로 만든다. `destroy`만 감시한다.
    createSourceRunner: vi.fn(
      (...args: Parameters<typeof original.createSourceRunner>) => {
        const runner = original.createSourceRunner(...args);
        vi.spyOn(runner, "destroy");
        return runner;
      },
    ),
  };
});

afterEach(() => {
  vi.mocked(createSourceRunner).mockClear();
});

/**
 * worker 역할이 받을 프레임과, main 역할이 받은 알림·요청 기록을 만든다.
 * `script`는 `readLine` 요청에 차례로 답할 값이다.
 */
function scriptedMainSide(script: unknown[]) {
  return createHarnessMainSide({
    frame: { driver: { topLevelAwait: false } },
    extraNotifications: ["writeOutput", "writeError"],
    requests: { readLine: () => script.shift() },
  });
}

describe("REPL driver의 `{ source }` 실행기 수명", () => {
  test("세션마다 실행기를 한 번 만들고 exit() 명령으로 루프가 끝나면 놓는다", async () => {
    const { frame, events, waitFor } = scriptedMainSide([
      { source: "1" },
      "exit()",
    ]);

    await bootWorker(frame, {
      driver: replDriver,
      loadPyodide: () => loadPyodide(),
    });
    await waitFor(() => events.some((e) => e[0] === "sessionTerminated"));

    const runners = vi
      .mocked(createSourceRunner)
      .mock.results.map((result) => result.value as SourceRunner);
    expect(runners).toHaveLength(1);
    // 실행기는 루프가 끝난 뒤(`finally`)에 놓는다. 종료 통지보다 늦게 온다.
    await waitFor(() => vi.mocked(runners[0]!.destroy).mock.calls.length > 0);
    expect(runners[0]!.destroy).toHaveBeenCalledTimes(1);
  }, 30_000);
});
