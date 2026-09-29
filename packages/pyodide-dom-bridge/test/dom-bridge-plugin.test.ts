/**
 * `createDomBridgePlugin` 시험. dom-bridge worker 플러그인의 `prepare` 순서와 오류 경로를 가짜 브리지·가짜 pyodide로 본다.
 *
 * 순서:
 * 1. 부트스트랩 미수신이면 명시 오류를 던진다. 브리지를 부르지 않는다.
 * 2. `await bridge()`.
 * 3. `native === false`면 명시 오류를 던진다. `registerJsModule`을 부르지 않는다.
 * 4. `registerJsModule("runo", { browser: { window, document } })`. `window`는 guard가 걸린 것이다.
 */
import type { PyodideInterface } from "pyodide";
import { describe, expect, test, vi } from "vitest";
import { createDomBridgePlugin } from "../src/dom-bridge-plugin";
import type { WorkerBridge } from "../src/worker-bridge";

/** guard가 막는 `parent`·`top`·`opener`와 통과하는 `title`·`document`를 가진 가짜 main `window`. */
function createFakeWindow() {
  return {
    document: { title: "문서" },
    parent: "부모",
    top: "최상위",
    opener: "오프너",
    title: "창",
  };
}

/**
 * 플러그인과 가짜 의존(브리지·pyodide)을 만든다. `log`가 `bridge`·`registerJsModule` 호출 순서를 기록한다.
 *
 * - `received`: 부트스트랩 수신 여부. 기본 `true`.
 * - `native`: 동기 브리지 가능 여부. 기본 `true`.
 * - `bridgeError`: 주면 `bridge()`가 이 오류로 실패한다.
 */
function createHarness(options: {
  received?: boolean;
  native?: boolean;
  bridgeError?: Error;
}) {
  const fakeWindow = createFakeWindow();
  const log: string[] = [];
  const bridge = vi.fn(async (): Promise<WorkerBridge> => {
    log.push("bridge");
    if (options.bridgeError) throw options.bridgeError;
    return {
      proxy: {},
      native: options.native ?? true,
      window: fakeWindow as unknown as WorkerBridge["window"],
    };
  });
  const registerJsModule = vi.fn((name: string, module: unknown) => {
    log.push(`registerJsModule:${name}`);
    void module;
  });
  const pyodide = { registerJsModule } as unknown as PyodideInterface;
  const plugin = createDomBridgePlugin({
    receivedBootstrap: () => options.received ?? true,
    bridge,
  });
  return { plugin, pyodide, bridge, registerJsModule, fakeWindow, log };
}

describe("dom-bridge 플러그인 prepare", () => {
  test("플러그인 이름은 dom-bridge다(loadFailed 접두에 쓰인다)", () => {
    const { plugin } = createHarness({});

    expect(plugin.name).toBe("dom-bridge");
  });

  test("부트스트랩을 받지 못했으면 첫 정적 import 위반을 알리는 오류로 실패하고 브리지를 부르지 않는다", async () => {
    const { plugin, pyodide, bridge, registerJsModule } = createHarness({
      received: false,
    });

    await expect(plugin.prepare({ pyodide })).rejects.toThrow("첫 정적 import");

    expect(bridge).not.toHaveBeenCalled();
    expect(registerJsModule).not.toHaveBeenCalled();
  });

  test("부트스트랩 미수신 문구는 기존 접두를 유지하고 두 번째 원인(main이 createBridgeMain()의 Worker로 만들지 않음)도 알린다", async () => {
    const { plugin, pyodide } = createHarness({ received: false });

    const error = await Promise.resolve(plugin.prepare({ pyodide })).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // e2e `judgeLoadFailedRows`(`dom-bridge-judge.mjs`)와 문서가 매칭하는 접두·원인 문구다.
    expect(
      message.startsWith("coincident 부트스트랩 메시지를 받지 못했다. "),
    ).toBe(true);
    expect(message).toContain("첫 정적 import");
    expect(message).toContain("createBridgeMain()");
    expect(message).toContain("전역 Worker");
  });

  test("native가 false면 동기 DOM을 쓸 수 없다는 명시 오류로 실패하고 runo 모듈을 등록하지 않는다", async () => {
    const { plugin, pyodide, bridge, registerJsModule } = createHarness({
      native: false,
    });

    const failure = plugin.prepare({ pyodide });

    await expect(failure).rejects.toThrow("SharedArrayBuffer");
    await expect(failure).rejects.toThrow("native");
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(registerJsModule).not.toHaveBeenCalled();
  });

  test("정상이면 runo 모듈을 한 번 등록하고 browser에는 window·document만 있다", async () => {
    const { plugin, pyodide, registerJsModule, fakeWindow, log } =
      createHarness({});

    await plugin.prepare({ pyodide });

    expect(registerJsModule).toHaveBeenCalledTimes(1);
    const [name, module] = registerJsModule.mock.calls[0] as [
      string,
      { browser: Record<string, unknown> },
    ];
    expect(name).toBe("runo");
    expect(Object.keys(module)).toEqual(["browser"]);
    expect(Object.keys(module.browser).sort()).toEqual(["document", "window"]);
    expect(module.browser.document).toBe(fakeWindow.document);
    expect(log).toEqual(["bridge", "registerJsModule:runo"]);
  });

  test("등록되는 window는 guard가 걸려 parent·top·opener를 읽으면 던진다", async () => {
    const { plugin, pyodide, registerJsModule } = createHarness({});

    await plugin.prepare({ pyodide });

    const { browser } = registerJsModule.mock.calls[0]?.[1] as {
      browser: { window: Record<string, unknown> };
    };
    expect(browser.window.title).toBe("창");
    for (const name of ["parent", "top", "opener"])
      expect(() => browser.window[name]).toThrow(`window.${name}`);
  });

  test("브리지 준비가 실패하면 그 오류를 그대로 전하고 runo 모듈을 등록하지 않는다", async () => {
    const { plugin, pyodide, registerJsModule } = createHarness({
      bridgeError: new Error("브리지 실패"),
    });

    await expect(plugin.prepare({ pyodide })).rejects.toThrow("브리지 실패");

    expect(registerJsModule).not.toHaveBeenCalled();
  });
});
