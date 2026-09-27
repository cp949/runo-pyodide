/**
 * `usePythonRunner` 시험(jsdom + React). 실제 core `createRunner`를 쓰고 worker만 가짜다(공용 `@cp949/runo-pyodide-core/test-utils`).
 * StrictMode 이중 마운트에서 살아 있는 worker 1개, 언마운트 뒤 0개, 콜백 latest-ref, 핸들이 없을 때의 위임 규칙(14.3),
 * 상태 콜백 안 재진입(TRP-051)을 본다.
 */
import { RunRejectedError as CoreRunRejectedError } from "@cp949/runo-pyodide-core";
import { RunRejectedError as ReplRunRejectedError } from "@cp949/runo-pyodide-repl";
import { RunRejectedError as TerminalRunRejectedError } from "@cp949/runo-pyodide-terminal";
import { StrictMode, act, useLayoutEffect } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";
import { RunRejectedError, usePythonRunner } from "../src/index";
import type {
  RunnerStatus,
  UsePythonRunnerOptions,
  UsePythonRunnerResult,
} from "../src/index";
import {
  createFakeWorkerFactory,
  type FakeWorkerFactory,
} from "@cp949/runo-pyodide-core/test-utils";
import { enableActEnvironment, until } from "./harness";

enableActEnvironment();

let factory: FakeWorkerFactory;
let container: HTMLElement;
let root: Root | undefined;

beforeEach(() => {
  // jsdom에는 `crossOriginIsolated`가 없다. worker를 만드는 경로는 격리를 전제한다.
  vi.stubGlobal("crossOriginIsolated", true);
  factory = createFakeWorkerFactory();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await unmount();
  container.remove();
  factory.dispose();
  vi.unstubAllGlobals();
});

async function unmount(): Promise<void> {
  if (!root) return;
  const mounted = root;
  root = undefined;
  await act(async () => mounted.unmount());
}

interface Probe {
  /** 마지막 렌더의 hook 반환값. */
  api: UsePythonRunnerResult;
  /** 렌더마다의 `status`. */
  renderedStatuses: RunnerStatus[];
  /** 레이아웃 효과 시점(핸들 생성 전, StrictMode 재마운트 사이 포함)에 위임 함수를 부른 결과. */
  beforeHandle: {
    run: Promise<unknown>;
    stop: Promise<unknown>;
    busy: boolean;
  }[];
  /** 옵션을 바꿔 다시 렌더한다. */
  rerender(next: UsePythonRunnerOptions): void;
}

function mount(
  initial: UsePythonRunnerOptions,
  { strict = false }: { strict?: boolean } = {},
): Probe {
  let current = initial;
  const probe: Probe = {
    api: undefined as never,
    renderedStatuses: [],
    beforeHandle: [],
    rerender(next) {
      current = next;
      act(() => root!.render(element()));
    },
  };

  function Component() {
    const api = usePythonRunner(current);
    probe.api = api;
    probe.renderedStatuses.push(api.status);
    // hook의 효과(passive)보다 이 레이아웃 효과가 먼저 돈다: 핸들이 아직 없을 때의 위임 규칙을 본다.
    useLayoutEffect(() => {
      const run = api.run("1");
      run.catch(() => {});
      probe.beforeHandle.push({ run, stop: api.stop(), busy: api.busy });
      // 마운트 때 한 번만 본다(재렌더마다 다시 재지 않는다).
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
  }
  const element = () => {
    const app = <Component />;
    return strict ? <StrictMode>{app}</StrictMode> : app;
  };
  root = createRoot(container);
  act(() => root!.render(element()));
  return probe;
}

function options(
  overrides: Partial<UsePythonRunnerOptions> = {},
): UsePythonRunnerOptions {
  return {
    createWorker: factory.createWorker,
    onOutput: () => {},
    ...overrides,
  };
}

describe("usePythonRunner: worker 수명", () => {
  test("StrictMode 이중 마운트 뒤 살아 있는 worker는 1개다(생성 2·terminate 1)", () => {
    mount(options(), { strict: true });
    expect(factory.workers).toHaveLength(2);
    expect(factory.live()).toBe(1);
    expect(factory.workers[0]!.terminated()).toBe(true);
    expect(factory.workers[1]!.terminated()).toBe(false);
  });

  test("StrictMode 없이는 worker 1개를 만든다", () => {
    mount(options());
    expect(factory.workers).toHaveLength(1);
    expect(factory.live()).toBe(1);
  });

  test("언마운트하면 살아 있는 worker가 0개다", async () => {
    mount(options(), { strict: true });
    await unmount();
    expect(factory.live()).toBe(0);
    expect(factory.workers).toHaveLength(2);
  });

  test("인라인 람다 콜백으로 재렌더해도 worker를 다시 만들지 않는다", () => {
    const probe = mount(options({ onOutput: () => {}, onStatus: () => {} }));
    probe.rerender(options({ onOutput: () => {}, onStatus: () => {} }));
    probe.rerender(options({ onOutput: () => {}, onStatus: () => {} }));
    expect(factory.workers).toHaveLength(1);
    expect(factory.workers[0]!.terminated()).toBe(false);
  });

  test("생성 옵션(createWorker)을 바꿔 재렌더해도 마운트 때 것을 유지한다", () => {
    const probe = mount(options());
    const replaced = vi.fn(factory.createWorker);
    probe.rerender(options({ createWorker: replaced }));
    expect(replaced).not.toHaveBeenCalled();
    expect(factory.workers).toHaveLength(1);
  });

  test("pyodide·filename·topLevelAwait를 core에 넘긴다", () => {
    mount(
      options({
        pyodide: { indexURL: "https://cdn.example/pyodide/" },
        filename: "app.py",
        topLevelAwait: true,
      }),
    );
    const frame = factory.workers[0]!.init()!;
    expect(frame.pyodide.indexURL).toBe("https://cdn.example/pyodide/");
    expect(frame.driver).toMatchObject({
      filename: "app.py",
      topLevelAwait: true,
    });
  });
});

describe("usePythonRunner: 콜백 latest-ref", () => {
  test("재렌더로 바꾼 onOutput이 다음 출력부터 불리고 옛 함수는 불리지 않는다", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const probe = mount(options({ onOutput: first }));
    factory.workers[0]!.ready();
    await until(() => probe.api.status === "ready");
    factory.workers[0]!.write("a");
    await until(() => first.mock.calls.length === 1);
    probe.rerender(options({ onOutput: second }));
    factory.workers[0]!.write("b");
    await until(() => second.mock.calls.length === 1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith({ stream: "stdout", text: "b" });
  });

  test("재렌더로 바꾼 onStatus가 다음 상태 변화부터 불린다", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const probe = mount(options({ onStatus: first }));
    expect(first).toHaveBeenCalledWith("loading");
    probe.rerender(options({ onStatus: second }));
    factory.workers[0]!.ready();
    await until(() => probe.api.status === "ready");
    expect(second).toHaveBeenCalledWith("ready");
    expect(first).not.toHaveBeenCalledWith("ready");
  });

  test("재렌더로 넣은 inputProvider를 다음 입력 읽기가 쓴다", async () => {
    const probe = mount(options());
    factory.workers[0]!.ready();
    await until(() => probe.api.status === "ready");
    // 마운트 때는 공급자가 없었다. 재렌더로 넣은 것이 불려야 한다.
    const provider = vi.fn(async () => "abc");
    probe.rerender(options({ inputProvider: provider }));
    probe.api.run("input()").catch(() => {});
    await until(() => factory.workers[0]!.pending.length === 1);
    factory.workers[0]!.readInput();
    await until(() => provider.mock.calls.length === 1);
  });
});

describe("usePythonRunner: 콜백 latest-ref(오류 통지)", () => {
  test("재렌더로 바꾼 onCrash가 크래시 통지를 받는다", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const probe = mount(options({ onCrash: first }));
    probe.rerender(options({ onCrash: second }));
    act(() => factory.workers[0]!.dispatchError("boom"));
    expect(second).toHaveBeenCalledWith("boom");
    expect(first).not.toHaveBeenCalled();
  });

  test("재렌더로 바꾼 onLoadFailed가 로드 실패 사유를 받는다", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const probe = mount(options({ onLoadFailed: first }));
    probe.rerender(options({ onLoadFailed: second }));
    factory.workers[0]!.loadFailed("network");
    await until(() => probe.api.status === "load-failed");
    expect(second).toHaveBeenCalledWith("network");
    expect(first).not.toHaveBeenCalled();
  });
});

describe("usePythonRunner: 핸들이 없을 때 위임 규칙(14.3)", () => {
  test("핸들 생성 전(레이아웃 효과 시점)에는 run reject disposed·stop idle·busy false다", async () => {
    const probe = mount(options());
    expect(probe.beforeHandle).toHaveLength(1);
    const sample = probe.beforeHandle[0]!;
    await expect(sample.run).rejects.toMatchObject({
      name: "RunRejectedError",
      reason: "disposed",
    });
    await expect(sample.stop).resolves.toBe("idle");
    expect(sample.busy).toBe(false);
  });

  test("StrictMode cleanup 뒤 재마운트 사이에도 같은 규칙이고 첫 핸들을 재사용하지 않는다", async () => {
    const probe = mount(options(), { strict: true });
    // 첫 마운트 전, cleanup 뒤 재마운트 사이 두 번이다.
    expect(probe.beforeHandle).toHaveLength(2);
    for (const sample of probe.beforeHandle) {
      await expect(sample.run).rejects.toMatchObject({ reason: "disposed" });
      await expect(sample.stop).resolves.toBe("idle");
      expect(sample.busy).toBe(false);
    }
    // 두 번째 핸들은 살아 있어 run이 거부되지 않고 대기(loading)한다.
    factory.workers[1]!.ready();
    await until(() => probe.api.status === "ready");
    const run = probe.api.run("print(1)");
    await until(() => factory.workers[1]!.pending.length === 1);
    expect(factory.workers[0]!.pending).toHaveLength(0);
    factory.workers[1]!.pending[0]!.resolve({
      kind: "ok",
      value: null,
    } as never);
    await run;
  });

  test("언마운트 뒤 낡은 반환값의 run은 disposed로 reject하고 stop은 idle·busy는 false다", async () => {
    const probe = mount(options());
    const api = probe.api;
    await unmount();
    await expect(api.run("1")).rejects.toMatchObject({ reason: "disposed" });
    await expect(api.stop()).resolves.toBe("idle");
    expect(api.busy).toBe(false);
    expect(() => api.reset()).not.toThrow();
    expect(api.interrupt()).toBe("ignored");
  });

  test("busy는 렌더 시점 값이 아니라 지금 값을 돌려준다", async () => {
    const probe = mount(options());
    const api = probe.api;
    factory.workers[0]!.ready();
    await until(() => probe.api.status === "ready");
    expect(api.busy).toBe(false);
    const run = api.run("1");
    run.catch(() => {});
    expect(api.busy).toBe(true);
    await until(() => factory.workers[0]!.pending.length === 1);
    factory.workers[0]!.pending[0]!.resolve({
      kind: "ok",
      value: null,
    } as never);
    await run;
    expect(api.busy).toBe(false);
  });
});

describe("usePythonRunner: 살아 있는 핸들로의 위임", () => {
  test("loading 중 대기하던 run은 stop()으로 취소되고 stop은 idle이다", async () => {
    const probe = mount(options());
    const run = probe.api.run("1");
    const settled = run.then(
      () => "resolved",
      (error: unknown) => error,
    );
    expect(probe.api.busy).toBe(true);
    await expect(probe.api.stop()).resolves.toBe("idle");
    expect(await settled).toMatchObject({ reason: "unavailable" });
    expect(probe.api.busy).toBe(false);
  });

  test("interrupt()는 열린 입력 읽기를 취소한다", async () => {
    let readSignal: AbortSignal | undefined;
    const provider = vi.fn(
      (_prompt: string, signal: AbortSignal) =>
        new Promise<string | null>(() => {
          readSignal = signal;
        }),
    );
    const probe = mount(options({ inputProvider: provider }));
    factory.workers[0]!.ready();
    await until(() => probe.api.status === "ready");
    probe.api.run("input()").catch(() => {});
    await until(() => factory.workers[0]!.pending.length === 1);
    factory.workers[0]!.readInput();
    await until(() => probe.api.status === "waiting-input");
    expect(readSignal?.aborted).toBe(false);
    let result: string | undefined;
    act(() => {
      result = probe.api.interrupt();
    });
    expect(result).toBe("input-cancelled");
    expect(readSignal?.aborted).toBe(true);
  });

  test("reset()은 worker를 새로 만든다", async () => {
    const probe = mount(options());
    factory.workers[0]!.ready();
    await until(() => probe.api.status === "ready");
    act(() => probe.api.reset());
    expect(factory.workers).toHaveLength(2);
    expect(factory.workers[0]!.terminated()).toBe(true);
    expect(factory.live()).toBe(1);
  });
});

describe("usePythonRunner: status", () => {
  test("첫 렌더의 status는 격리 환경에서 loading이다", () => {
    const probe = mount(options());
    expect(probe.renderedStatuses[0]).toBe("loading");
  });

  test("격리되지 않으면 첫 렌더부터 not-isolated이고 worker를 만들지 않는다", () => {
    vi.stubGlobal("crossOriginIsolated", false);
    const onStatus = vi.fn();
    const probe = mount(options({ onStatus }));
    expect(probe.renderedStatuses[0]).toBe("not-isolated");
    expect(probe.api.status).toBe("not-isolated");
    expect(factory.workers).toHaveLength(0);
    expect(onStatus).toHaveBeenCalledWith("not-isolated");
  });

  test("createRunner가 반환 전에 동기로 통지하는 첫 상태를 onStatus가 놓치지 않는다", () => {
    const onStatus = vi.fn();
    mount(options({ onStatus }));
    expect(onStatus.mock.calls).toEqual([["loading"]]);
  });

  test("worker가 준비되면 status가 ready로 갱신된다", async () => {
    const probe = mount(options());
    factory.workers[0]!.ready();
    await until(() => probe.api.status === "ready");
  });
});

describe("usePythonRunner: SSR 하이드레이션", () => {
  /** `status`를 그리는 소비자. 서버 문자열과 하이드레이션 결과를 비교한다. */
  function StatusView({ statuses }: { statuses?: RunnerStatus[] }) {
    const { status } = usePythonRunner(options());
    statuses?.push(status);
    return <span>{status}</span>;
  }

  /** 서버 렌더: Node 서버처럼 `crossOriginIsolated`가 없다. */
  function renderOnServer(): string {
    vi.stubGlobal("crossOriginIsolated", undefined);
    const html = renderToString(<StatusView />);
    return html;
  }

  test("서버 렌더의 status는 격리 여부를 모르므로 loading이다", () => {
    expect(renderOnServer()).toBe("<span>loading</span>");
  });

  test.each([
    [true, "loading"],
    [false, "not-isolated"],
  ] as const)(
    "격리=%s 클라이언트 하이드레이션은 불일치 없이 서버와 같은 첫 렌더를 거쳐 %s 상태가 된다",
    (isolated, settled) => {
      container.innerHTML = renderOnServer();
      vi.stubGlobal("crossOriginIsolated", isolated);
      const statuses: RunnerStatus[] = [];
      const onRecoverableError = vi.fn();
      act(() => {
        root = hydrateRoot(container, <StatusView statuses={statuses} />, {
          onRecoverableError,
        });
      });
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(statuses[0]).toBe("loading");
      expect(container.textContent).toBe(settled);
    },
  );
});

describe("usePythonRunner: 상태 콜백 안 재진입(TRP-051)", () => {
  test("crashed 콜백 안의 reset() 자동 복구에서도 run은 crashed로 거부되고 onCrash가 불리며 새 worker가 산다", async () => {
    const onCrash = vi.fn();
    const probe: Probe = mount(
      options({
        onCrash,
        onStatus: (status) => {
          if (status === "crashed") probe.api.reset();
        },
      }),
    );
    factory.workers[0]!.ready();
    await until(() => probe.api.status === "ready");
    const run = probe.api.run("while True: pass");
    const settled = run.then(
      () => "resolved",
      (error: unknown) => error,
    );
    await until(() => factory.workers[0]!.pending.length === 1);
    act(() => factory.workers[0]!.dispatchError("boom"));
    const outcome = await settled;
    expect(outcome).toBeInstanceOf(RunRejectedError);
    expect(outcome).toMatchObject({ reason: "crashed" });
    expect(onCrash).toHaveBeenCalledWith("boom");
    expect(factory.workers).toHaveLength(2);
    expect(factory.workers[0]!.terminated()).toBe(true);
    expect(factory.live()).toBe(1);
    await until(() => probe.api.status === "restarting");
  });
});

describe("usePythonRunner: 공개 표면", () => {
  test("반환 키는 status·run·stop·reset·interrupt·busy 6개뿐이다", () => {
    const probe = mount(options());
    expect(Object.keys(probe.api).sort()).toEqual([
      "busy",
      "interrupt",
      "reset",
      "run",
      "status",
      "stop",
    ]);
    expectTypeOf<keyof UsePythonRunnerResult>().toEqualTypeOf<
      "status" | "run" | "stop" | "reset" | "interrupt" | "busy"
    >();
  });

  test("run·stop·reset·interrupt 참조는 재렌더에도 바뀌지 않는다", () => {
    const probe = mount(options());
    const before = probe.api;
    probe.rerender(options());
    expect(probe.api.run).toBe(before.run);
    expect(probe.api.stop).toBe(before.stop);
    expect(probe.api.reset).toBe(before.reset);
    expect(probe.api.interrupt).toBe(before.interrupt);
  });

  test("RunRejectedError는 core·terminal·repl과 같은 클래스다", () => {
    expect(RunRejectedError).toBe(CoreRunRejectedError);
    expect(RunRejectedError).toBe(TerminalRunRejectedError);
    expect(RunRejectedError).toBe(ReplRunRejectedError);
  });
});
