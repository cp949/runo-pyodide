/**
 * `<PythonRunner>` 시험(jsdom + React). 실제 `createTerminalRunner`·실제 `@xterm/xterm`·실제 `FitAddon`을 쓰고 worker만 가짜다
 * (공용 `@cp949/runo-pyodide-core/test-utils`). 두 컴포넌트 시험에서 본문이 같은 쌍(StrictMode 수명·정리 순서·copyOnSelect 반응형·
 * fit 배선 3건·ref handle 4건)은 `terminal-component.contract.test.tsx`로 옮겼다(DELTA-02). fit 세부(크기 0 건너뜀·rAF 합침)는
 * `terminal-view.ts`가 실제로 보는 로직이라 `terminal-view.test.ts`로 옮겼다(DELTA-03). 여기는 runner 고유 시험(생성 옵션·
 * `onOutput`·`inputProvider`·`clearOnRun`)만 남았다.
 */
import type {
  TerminalRunnerHandle,
  TerminalRunnerOptions,
} from "@cp949/runo-pyodide-terminal";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import { PythonRunner } from "../src/index";
import type {
  PythonRunnerHandle,
  PythonRunnerProps,
  RunnerStatus,
} from "../src/index";
import { until } from "./harness";
import {
  factory,
  container,
  openSpy,
  unmount,
  screenText,
  useComponentHarness,
  type Probe,
} from "./component-harness";

const HOST_ID = "runner-host";

// eslint-disable-next-line react-hooks/rules-of-hooks -- React hook이 아니다. beforeEach/afterEach를 등록하는 시험 하니스(RD-037 `useConsoleHarness` 선례).
const { mount, props } = useComponentHarness<
  PythonRunnerHandle,
  PythonRunnerProps
>({ Component: PythonRunner, hostId: HOST_ID });

/** worker `ready`를 보내 상태를 `ready`로 만든다. */
async function becomeReady(
  probe: Probe<PythonRunnerHandle, PythonRunnerProps>,
  index = 0,
): Promise<void> {
  factory.workers[index]!.ready();
  await until(() => probe.ref.current?.status === "ready");
}

describe("PythonRunner: xterm·worker 수명", () => {
  test("생성 옵션(createWorker·terminalOptions·fit·filename·clearOnRun)을 바꿔 재렌더해도 마운트 때 것을 유지한다", () => {
    const probe = mount({ terminalOptions: { cols: 100, rows: 10 } });
    const replaced = vi.fn(factory.createWorker);
    probe.rerender(
      props({
        createWorker: replaced,
        terminalOptions: { cols: 50, rows: 5 },
        fit: false,
        filename: "other.py",
        clearOnRun: true,
      }),
    );
    expect(replaced).not.toHaveBeenCalled();
    expect(factory.workers).toHaveLength(1);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(probe.terminal().cols).toBe(100);
    expect(probe.terminal().rows).toBe(10);
  });

  test("indexURL·filename·topLevelAwait를 core에 넘긴다", () => {
    mount({
      indexURL: "https://cdn.example/pyodide/",
      filename: "app.py",
      topLevelAwait: true,
    });
    const frame = factory.workers[0]!.init()!;
    expect(frame.pyodide.indexURL).toBe("https://cdn.example/pyodide/");
    expect(frame.driver).toMatchObject({
      filename: "app.py",
      topLevelAwait: true,
    });
  });

  test("clearOnRun을 core에 넘긴다(true면 run 시작 때 화면을 지운다, 기본은 지우지 않는다)", async () => {
    const cleared = mount({ clearOnRun: true });
    await becomeReady(cleared);
    factory.workers[0]!.write("old-output");
    await expect
      .poll(() => screenText(cleared.terminal()))
      .toContain("old-output");
    cleared.ref.current!.run("1").catch(() => {});
    await expect
      .poll(() => screenText(cleared.terminal()))
      .not.toContain("old-output");
    await unmount();

    const kept = mount();
    await becomeReady(kept, 1);
    factory.workers[1]!.write("old-output");
    await expect
      .poll(() => screenText(kept.terminal()))
      .toContain("old-output");
    kept.ref.current!.run("1").catch(() => {});
    await until(() => factory.workers[1]!.pending.length === 1);
    expect(await screenText(kept.terminal())).toContain("old-output");
  });
});

describe("PythonRunner: 출력·콜백 latest-ref", () => {
  test("worker 출력이 xterm 화면에 그려진다", async () => {
    const probe = mount();
    await becomeReady(probe);
    factory.workers[0]!.write("hello-screen");
    await expect
      .poll(() => screenText(probe.terminal()))
      .toContain("hello-screen");
  });

  test("재렌더로 바꾼 onOutput·onStatus가 다음 통지부터 불리고 옛 함수는 불리지 않는다", async () => {
    const outputFirst = vi.fn();
    const outputSecond = vi.fn();
    const statusFirst = vi.fn();
    const statusSecond = vi.fn();
    const probe = mount({ onOutput: outputFirst, onStatus: statusFirst });
    expect(statusFirst).toHaveBeenCalledWith("loading");
    probe.rerender(props({ onOutput: outputSecond, onStatus: statusSecond }));
    // 재렌더가 worker·Terminal을 다시 만들지 않는다(계약 C4는 공통 콜백만 넘겨서 못 보는 onOutput 인라인 람다 경로 보존).
    expect(factory.workers).toHaveLength(1);
    expect(openSpy).toHaveBeenCalledTimes(1);
    await becomeReady(probe);
    expect(statusSecond).toHaveBeenCalledWith("ready");
    expect(statusFirst).not.toHaveBeenCalledWith("ready");
    factory.workers[0]!.write("x");
    await until(() => outputSecond.mock.calls.length === 1);
    expect(outputSecond).toHaveBeenCalledWith({ stream: "stdout", text: "x" });
    expect(outputFirst).not.toHaveBeenCalled();
  });

  test("마운트 때 준 inputProvider는 재렌더로 바꾼 최신 함수가 다음 입력 읽기를 받는다", async () => {
    const first = vi.fn(async () => "one");
    const second = vi.fn(async () => "two");
    const probe = mount({ inputProvider: first });
    await becomeReady(probe);
    probe.rerender(props({ inputProvider: second }));
    probe.ref.current!.run("input()").catch(() => {});
    await until(() => factory.workers[0]!.pending.length === 1);
    factory.workers[0]!.readInput();
    await until(() => second.mock.calls.length === 1);
    expect(first).not.toHaveBeenCalled();
  });

  test("inputProvider 없이 마운트하면 xterm에서 한 줄을 읽는다(공급자가 null을 돌려 읽기를 끝내지 않는다)", async () => {
    const probe = mount();
    await becomeReady(probe);
    probe.ref.current!.run("input()").catch(() => {});
    await until(() => factory.workers[0]!.pending.length === 1);
    factory.workers[0]!.readInput();
    // 읽기가 열리면 키 입력이 화면에 에코된다. 열리기 전 입력은 버려지므로 나타날 때까지 계속 보낸다.
    await expect
      .poll(async () => {
        act(() => probe.terminal().input("q"));
        return screenText(probe.terminal());
      })
      .toContain("q");
  });
});

describe("PythonRunner: ref handle", () => {
  test("ref가 붙는 시점(runner 생성 전)에는 run reject disposed·stop idle이고 status는 첫 상태 규칙이다", async () => {
    for (const [isolated, expected] of [
      [true, "loading"],
      [false, "not-isolated"],
    ] as const) {
      vi.stubGlobal("crossOriginIsolated", isolated);
      const seen: {
        status: RunnerStatus;
        run: Promise<unknown>;
        stop: Promise<unknown>;
      }[] = [];
      // 콜백 ref는 레이아웃 단계에 불려 passive effect의 runner 생성보다 먼저다.
      const ref = (handle: PythonRunnerHandle | null) => {
        if (!handle) return;
        const run = handle.run("1");
        run.catch(() => {});
        seen.push({ status: handle.status, run, stop: handle.stop() });
      };
      const local = createRoot(container);
      act(() =>
        local.render(
          <PythonRunner createWorker={factory.createWorker} ref={ref} />,
        ),
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]!.status).toBe(expected);
      await expect(seen[0]!.run).rejects.toMatchObject({ reason: "disposed" });
      await expect(seen[0]!.stop).resolves.toBe("idle");
      await act(async () => local.unmount());
    }
  });

  test("handle 키는 run·stop·reset·clear·setCopyOnSelect·status·focus 7개뿐이다", () => {
    const probe = mount();
    expect(Object.keys(probe.ref.current!).sort()).toEqual([
      "clear",
      "focus",
      "reset",
      "run",
      "setCopyOnSelect",
      "status",
      "stop",
    ]);
    expectTypeOf<keyof PythonRunnerHandle>().toEqualTypeOf<
      | "run"
      | "stop"
      | "reset"
      | "clear"
      | "setCopyOnSelect"
      | "status"
      | "focus"
    >();
  });

  test("마운트 뒤 run은 core run으로 전달되고 결과가 돌아온다", async () => {
    const probe = mount();
    await becomeReady(probe);
    const run = probe.ref.current!.run("print(1)");
    await until(() => factory.workers[0]!.pending.length === 1);
    expect(factory.workers[0]!.pending[0]!.code).toBe("print(1)");
    factory.workers[0]!.pending[0]!.resolve({
      kind: "ok",
      value: null,
    } as never);
    await expect(run).resolves.toMatchObject({ kind: "ok" });
  });

  test("StrictMode에서 handle의 run은 살아 있는(두 번째) worker로 간다", async () => {
    const probe = mount({}, { strict: true });
    await becomeReady(probe, 1);
    probe.ref.current!.run("1").catch(() => {});
    await until(() => factory.workers[1]!.pending.length === 1);
    expect(factory.workers[0]!.pending).toHaveLength(0);
  });

  test("언마운트 뒤 낡은 handle은 run reject disposed·stop idle·나머지 no-op이고 status는 마지막 값이다", async () => {
    const probe = mount();
    await becomeReady(probe);
    const handle = probe.ref.current!;
    await unmount();
    await expect(handle.run("1")).rejects.toMatchObject({
      name: "RunRejectedError",
      reason: "disposed",
    });
    await expect(handle.stop()).resolves.toBe("idle");
    expect(() => handle.reset()).not.toThrow();
    expect(() => handle.clear()).not.toThrow();
    expect(() => handle.setCopyOnSelect(false)).not.toThrow();
    expect(() => handle.focus()).not.toThrow();
    expect(handle.status).toBe("ready");
  });

  test("reset()은 worker를 새로 만든다", async () => {
    const probe = mount();
    await becomeReady(probe);
    act(() => probe.ref.current!.reset());
    expect(factory.workers).toHaveLength(2);
    expect(factory.workers[0]!.terminated()).toBe(true);
  });

  test("status는 핸들 값이다(loading에서 ready로)", async () => {
    const probe = mount();
    expect(probe.ref.current!.status).toBe("loading");
    await becomeReady(probe);
    expect(probe.ref.current!.status).toBe("ready");
  });

  test("격리되지 않으면 status가 not-isolated이고 worker를 만들지 않는다", () => {
    vi.stubGlobal("crossOriginIsolated", false);
    const statuses: RunnerStatus[] = [];
    const probe = mount({ onStatus: (status) => statuses.push(status) });
    expect(factory.workers).toHaveLength(0);
    expect(statuses).toEqual(["not-isolated"]);
    expect(probe.ref.current!.status).toBe("not-isolated");
  });

  test("clear()는 화면을 지운다", async () => {
    const probe = mount();
    await becomeReady(probe);
    factory.workers[0]!.write("to-be-cleared");
    await expect
      .poll(() => screenText(probe.terminal()))
      .toContain("to-be-cleared");
    act(() => probe.ref.current!.clear());
    await expect
      .poll(() => screenText(probe.terminal()))
      .not.toContain("to-be-cleared");
  });
});

describe("PythonRunner: 타입", () => {
  test("props·handle은 하위 타입에서 유도돼 콜백 시그니처가 같다", () => {
    expectTypeOf<PythonRunnerProps["onStatus"]>().toEqualTypeOf<
      TerminalRunnerOptions["onStatus"]
    >();
    expectTypeOf<PythonRunnerProps["inputProvider"]>().toEqualTypeOf<
      TerminalRunnerOptions["inputProvider"]
    >();
    expectTypeOf<PythonRunnerProps["onCopy"]>().toEqualTypeOf<
      TerminalRunnerOptions["onCopy"]
    >();
    expectTypeOf<PythonRunnerHandle["run"]>().toEqualTypeOf<
      TerminalRunnerHandle["run"]
    >();
    expectTypeOf<PythonRunnerHandle["status"]>().toEqualTypeOf<
      TerminalRunnerHandle["status"]
    >();
  });

  test("Terminal 객체와 interrupt·busy는 handle에 없다", () => {
    expectTypeOf<PythonRunnerHandle>().not.toHaveProperty("interrupt");
    expectTypeOf<PythonRunnerHandle>().not.toHaveProperty("busy");
    expectTypeOf<PythonRunnerHandle>().not.toHaveProperty("terminal");
  });

  test("children은 props 타입에 없다(xterm이 붙는 컨테이너 div에 React 자식을 함께 렌더하지 않는다)", () => {
    expectTypeOf<PythonRunnerProps>().not.toHaveProperty("children");
  });
});
