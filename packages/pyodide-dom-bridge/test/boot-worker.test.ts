// @vitest-environment node
/**
 * core `bootWorker`와 dom-bridge 플러그인 조합 시험.
 *
 * - 플러그인이 던진 오류는 `loadFailed`로 간다. 문구는 `Error: plugin "dom-bridge": `로 시작한다.
 * - `loadFailed` 페이로드가 `String(error)`라 `Error: ` 접두가 붙는다.
 * - 성공하면 `createConsole` 앞에서 `runo` 모듈이 등록된다.
 * - 가짜 pyodide(interrupt 공개 API와 `registerJsModule`만)와 가짜 브리지를 쓴다.
 * - 가짜 driver의 `createConsole`이 던져 시퀀스를 거기서 끝낸다. 플러그인 이후 단계에 도달했다는 표지다.
 */
import type { PyodideInterface } from "pyodide";
import { describe, expect, test, vi } from "vitest";
import { createMainSide } from "@cp949/runo-pyodide-core/test-utils";
import { bootWorker, type WorkerDriver } from "@cp949/runo-pyodide-core/worker";
import { createDomBridgePlugin } from "../src/dom-bridge-plugin";
import type { WorkerBridge } from "../src/worker-bridge";

/** `createConsole`에 도달하면 `console 도달`로 던지는 가짜 driver. */
const driver: WorkerDriver = {
  parseOptions: (raw) => raw,
  createSession: () => ({
    handlers: {},
    createConsole: () => {
      throw new Error("console 도달");
    },
    run: async () => {},
    atPrompt: () => false,
  }),
};

/**
 * 가짜 pyodide·가짜 브리지로 플러그인을 끼운 `bootWorker`를 시작한다.
 * `received`(부트스트랩 수신)·`native`(동기 브리지 가능)가 플러그인 판정 입력이다.
 */
function createBoot(options: { received: boolean; native: boolean }) {
  const registerJsModule = vi.fn();
  const pyodide = {
    setInterruptBuffer: () => {},
    checkInterrupt: () => {},
    registerJsModule,
  } as unknown as PyodideInterface;
  const plugin = createDomBridgePlugin({
    receivedBootstrap: () => options.received,
    bridge: async (): Promise<WorkerBridge> => ({
      proxy: {},
      native: options.native,
      window: { document: {} } as unknown as WorkerBridge["window"],
    }),
  });
  const main = createMainSide();
  const booted = bootWorker(main.frame, {
    driver,
    loadPyodide: async () => pyodide,
    plugins: [plugin],
  });
  return { main, booted, registerJsModule };
}

describe("bootWorker + dom-bridge 플러그인", () => {
  test('부트스트랩을 받지 못했으면 loadFailed이고 문구가 Error: plugin "dom-bridge": 로 시작하며 첫 정적 import를 알린다', async () => {
    const { main, booted, registerJsModule } = createBoot({
      received: false,
      native: true,
    });

    await booted;
    const outcome = await main.waitForOutcome();

    expect(outcome[0]).toBe("loadFailed");
    expect(String(outcome[1]).startsWith('Error: plugin "dom-bridge": ')).toBe(
      true,
    );
    expect(outcome[1]).toContain("첫 정적 import");
    expect(registerJsModule).not.toHaveBeenCalled();
  });

  test('native가 false면 loadFailed이고 문구가 Error: plugin "dom-bridge": 로 시작하며 SharedArrayBuffer를 알린다', async () => {
    const { main, booted, registerJsModule } = createBoot({
      received: true,
      native: false,
    });

    await booted;
    const outcome = await main.waitForOutcome();

    expect(outcome[0]).toBe("loadFailed");
    expect(String(outcome[1]).startsWith('Error: plugin "dom-bridge": ')).toBe(
      true,
    );
    expect(outcome[1]).toContain("SharedArrayBuffer");
    expect(registerJsModule).not.toHaveBeenCalled();
  });

  test("정상이면 createConsole 앞에서 runo 모듈이 등록된다(loadFailed 문구가 콘솔 단계 것이다)", async () => {
    const { main, booted, registerJsModule } = createBoot({
      received: true,
      native: true,
    });

    await booted;
    const outcome = await main.waitForOutcome();

    expect(registerJsModule).toHaveBeenCalledTimes(1);
    expect(registerJsModule.mock.calls[0]?.[0]).toBe("runo");
    expect(outcome).toEqual(["loadFailed", "Error: console 도달"]);
  });
});
