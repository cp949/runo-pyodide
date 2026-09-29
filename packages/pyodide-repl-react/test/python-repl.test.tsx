/**
 * `<PythonRepl>` 고유 시험. jsdom + React.
 * - 실제 `createRepl`·`@xterm/xterm`·`FitAddon`을 쓰고 worker만 가짜다(`@cp949/runo-pyodide-core/test-utils`).
 * - 확인: 생성 옵션 전달·고정(`topLevelAwait`·`completionPopover`·`indexURL`), `onStatus`, 비격리 경고,
 *   ref handle 위임 규칙(`runSource`·`reset({ topLevelAwait })`·`busy`·`crossOriginIsolated`), 타입 유도.
 * - 다른 파일과의 분담: `PythonRunner`와 본문이 같은 시험은 `terminal-component.contract.test.tsx`가 본다.
 *   StrictMode 수명, 정리 순서, `copyOnSelect` 반응형, fit 배선, ref handle 공통 부분이 여기에 든다.
 */
import type { CopyResult } from "@cp949/runo-pyodide-terminal";
import * as replModule from "@cp949/runo-pyodide-repl";
import {
  NOT_ISOLATED_WARNING,
  type ReplHandle,
  type ReplOptions,
  type ReplStatus,
} from "@cp949/runo-pyodide-repl";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import { PythonRepl, PythonRunner } from "../src/index";
import type {
  PythonReplHandle,
  PythonReplProps,
  PythonRunnerProps,
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

const HOST_ID = "repl-host";

// eslint-disable-next-line react-hooks/rules-of-hooks -- React hook이 아니다. beforeEach/afterEach를 등록하는 시험 하니스다(`pyodide-repl`의 `useConsoleHarness`와 같은 방식).
const { mount, props } = useComponentHarness<PythonReplHandle, PythonReplProps>(
  { Component: PythonRepl, hostId: HOST_ID },
);

/**
 * `index`번째 worker가 `ready`를 알리게 하고 `statuses`의 마지막 값이 `ready`가 될 때까지 기다린다.
 * `probe`는 다른 helper와 시그니처를 맞추려고 받는다. 쓰지 않는다.
 */
async function becomeReady(
  probe: Probe<PythonReplHandle, PythonReplProps>,
  statuses: ReplStatus[],
  index = 0,
): Promise<void> {
  factory.workers[index]!.ready();
  await until(() => statuses.at(-1) === "ready");
  void probe;
}

/**
 * worker가 `>>> ` 읽기를 열게 해 `runSource`를 받을 수 있는 상태(`busy` 거짓)로 만든다.
 * - 열린 읽기 promise는 `runSource`가 응답할 때까지 끝나지 않는다.
 * - async 함수는 반환한 promise를 풀어 버린다. 그래서 객체에 담아 돌려준다.
 */
async function openPrompt(
  probe: Probe<PythonReplHandle, PythonReplProps>,
  statuses: ReplStatus[],
  index = 0,
): Promise<{ read: Promise<unknown> }> {
  await becomeReady(probe, statuses, index);
  const read = factory.workers[index]!.readLine();
  // 프롬프트가 화면에 그려지면 읽기가 열린 것이다.
  await expect.poll(() => screenText(probe.terminal())).toContain(">>> ");
  return { read };
}

describe("PythonRepl: xterm·worker 수명", () => {
  test("생성 옵션(createWorker·indexURL·terminalOptions·fit·topLevelAwait·completionPopover)을 바꿔 재렌더해도 마운트 때 것을 유지한다", () => {
    const createReplSpy = vi.spyOn(replModule, "createRepl");
    const probe = mount({
      terminalOptions: { cols: 100, rows: 10 },
      topLevelAwait: false,
      completionPopover: true,
    });
    const replaced = vi.fn(factory.createWorker);
    probe.rerender(
      props({
        createWorker: replaced,
        indexURL: "https://cdn.example/other/",
        terminalOptions: { cols: 50, rows: 5 },
        fit: false,
        topLevelAwait: true,
        completionPopover: false,
      }),
    );
    expect(replaced).not.toHaveBeenCalled();
    expect(factory.workers).toHaveLength(1);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(probe.terminal().cols).toBe(100);
    expect(probe.terminal().rows).toBe(10);
    // 재렌더로 값이 바뀌어도 이미 만든 세션의 init 프레임은 그대로다.
    expect(
      (factory.workers[0]!.init()!.driver as { topLevelAwait?: unknown })
        .topLevelAwait,
    ).toBe(false);
    // `createRepl`은 마운트 때 한 번만 불린다. 그때 넘긴 `completionPopover: true`가 재렌더로 바뀌지 않는다.
    expect(createReplSpy).toHaveBeenCalledTimes(1);
    expect(createReplSpy.mock.calls[0]![0]).toMatchObject({
      completionPopover: true,
    });
  });

  test("completionPopover가 createRepl에 전달되고 컨테이너 div 속성으로 새지 않는다", () => {
    const createReplSpy = vi.spyOn(replModule, "createRepl");
    const probe = mount({ completionPopover: true });
    expect(createReplSpy).toHaveBeenCalledTimes(1);
    expect(createReplSpy.mock.calls[0]![0]).toMatchObject({
      completionPopover: true,
    });
    expect(probe.host().hasAttribute("completionpopover")).toBe(false);
  });

  test("indexURL·topLevelAwait를 core에 넘긴다", () => {
    mount({
      indexURL: "https://cdn.example/pyodide",
      topLevelAwait: true,
    });
    const frame = factory.workers[0]!.init()!;
    // repl은 `indexURL` 끝에 `/`가 없으면 붙인다.
    expect(frame.pyodide.indexURL).toBe("https://cdn.example/pyodide/");
    expect(frame.driver).toMatchObject({ topLevelAwait: true });
  });

  test("topLevelAwait 생략은 false다", () => {
    mount();
    expect(factory.workers[0]!.init()!.driver).toMatchObject({
      topLevelAwait: false,
    });
  });
});

describe("PythonRepl: 출력·콜백 latest-ref", () => {
  test("worker 출력이 xterm 화면에 그려진다", async () => {
    const statuses: ReplStatus[] = [];
    const probe = mount({ onStatus: (status) => statuses.push(status) });
    await becomeReady(probe, statuses);
    factory.workers[0]!.write("hello-screen");
    await expect
      .poll(() => screenText(probe.terminal()))
      .toContain("hello-screen");
  });

  test("재렌더로 바꾼 onStatus가 다음 통지부터 불리고 옛 함수는 불리지 않는다", async () => {
    const statusFirst = vi.fn();
    const seenSecond: ReplStatus[] = [];
    const statusSecond = vi.fn((status: ReplStatus) => seenSecond.push(status));
    const probe = mount({ onStatus: statusFirst });
    expect(statusFirst).toHaveBeenCalledWith("loading");
    probe.rerender(props({ onStatus: statusSecond }));
    await becomeReady(probe, seenSecond);
    expect(statusSecond).toHaveBeenCalledWith("ready");
    expect(statusFirst).not.toHaveBeenCalledWith("ready");
  });

  test("onStatus는 ReplStatus를 받는다(loading·ready, 크래시 뒤 crashed)", async () => {
    const statuses: ReplStatus[] = [];
    const probe = mount({ onStatus: (status) => statuses.push(status) });
    await becomeReady(probe, statuses);
    act(() => factory.workers[0]!.dispatchError("boom"));
    expect(statuses).toEqual(["loading", "ready", "crashed"]);
  });

  test("격리되지 않으면 worker를 만들지 않고 not-isolated를 알리며 경고를 그린다", async () => {
    vi.stubGlobal("crossOriginIsolated", false);
    const statuses: ReplStatus[] = [];
    const probe = mount({ onStatus: (status) => statuses.push(status) });
    expect(factory.workers).toHaveLength(0);
    expect(statuses).toEqual(["not-isolated"]);
    expect(probe.ref.current!.crossOriginIsolated).toBe(false);
    await expect
      .poll(() => screenText(probe.terminal()))
      .toContain(NOT_ISOLATED_WARNING.slice(0, 20));
  });
});

describe("PythonRepl: ref handle", () => {
  test("ref가 붙는 시점(repl 생성 전)에는 runSource reject disposed·busy false이고 crossOriginIsolated는 전역 값이다", async () => {
    for (const isolated of [true, false]) {
      vi.stubGlobal("crossOriginIsolated", isolated);
      const seen: {
        busy: boolean;
        crossOriginIsolated: boolean;
        run: Promise<unknown>;
      }[] = [];
      // 콜백 ref는 레이아웃 단계에 불린다. passive effect의 repl 생성보다 먼저다.
      const ref = (handle: PythonReplHandle | null) => {
        if (!handle) return;
        const run = handle.runSource("1");
        run.catch(() => {});
        seen.push({
          busy: handle.busy,
          crossOriginIsolated: handle.crossOriginIsolated,
          run,
        });
      };
      const local = createRoot(container);
      act(() =>
        local.render(
          <PythonRepl createWorker={factory.createWorker} ref={ref} />,
        ),
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]!.busy).toBe(false);
      expect(seen[0]!.crossOriginIsolated).toBe(isolated);
      await expect(seen[0]!.run).rejects.toMatchObject({
        name: "RunRejectedError",
        reason: "disposed",
      });
      await act(async () => local.unmount());
    }
  });

  test("handle 키는 runSource·reset·setCopyOnSelect·busy·focus·crossOriginIsolated 6개뿐이다", () => {
    const probe = mount();
    expect(Object.keys(probe.ref.current!).sort()).toEqual([
      "busy",
      "crossOriginIsolated",
      "focus",
      "reset",
      "runSource",
      "setCopyOnSelect",
    ]);
    expectTypeOf<keyof PythonReplHandle>().toEqualTypeOf<
      | "runSource"
      | "reset"
      | "setCopyOnSelect"
      | "busy"
      | "focus"
      | "crossOriginIsolated"
    >();
  });

  test("마운트 뒤 runSource는 core runSource로 전달되고 결말이 돌아온다", async () => {
    const statuses: ReplStatus[] = [];
    const probe = mount({ onStatus: (status) => statuses.push(status) });
    const { read } = await openPrompt(probe, statuses);
    const run = probe.ref.current!.runSource("1 + 1");
    // 열린 읽기가 줄 대신 `{ source }`로 응답한다.
    await expect(read).resolves.toEqual({ source: "1 + 1" });
    // worker는 실행을 마치고 다음 읽기를 열면서 결말을 싣는다.
    void factory.workers[0]!.readLine(">>> ", { kind: "ok" });
    await expect(run).resolves.toMatchObject({ kind: "ok" });
  });

  test("StrictMode에서 handle의 runSource는 살아 있는(두 번째) worker로 간다", async () => {
    const statuses: ReplStatus[] = [];
    const probe = mount(
      { onStatus: (status) => statuses.push(status) },
      { strict: true },
    );
    const { read } = await openPrompt(probe, statuses, 1);
    void probe.ref.current!.runSource("x = 1").catch(() => {});
    await expect(read).resolves.toEqual({ source: "x = 1" });
  });

  test("busy는 살아 있는 repl의 값이다(실행 중이면 true)", async () => {
    const statuses: ReplStatus[] = [];
    const probe = mount({ onStatus: (status) => statuses.push(status) });
    await openPrompt(probe, statuses);
    expect(probe.ref.current!.busy).toBe(false);
    void probe.ref.current!.runSource("while True: pass").catch(() => {});
    expect(probe.ref.current!.busy).toBe(true);
  });

  test("worker가 로드되기 전(loading)의 runSource는 슬롯을 차지하고 두 번째 호출은 busy로 거부된다", async () => {
    const probe = mount();
    const first = probe.ref.current!.runSource("1");
    first.catch(() => {});
    await expect(probe.ref.current!.runSource("2")).rejects.toMatchObject({
      reason: "busy",
    });
    expect(probe.ref.current!.busy).toBe(true);
    await unmount();
    await expect(first).rejects.toMatchObject({ reason: "disposed" });
  });

  test("언마운트 뒤 낡은 handle은 runSource reject disposed·busy false·나머지 no-op이다", async () => {
    const statuses: ReplStatus[] = [];
    const probe = mount({ onStatus: (status) => statuses.push(status) });
    await becomeReady(probe, statuses);
    const handle = probe.ref.current!;
    await unmount();
    await expect(handle.runSource("1")).rejects.toMatchObject({
      name: "RunRejectedError",
      reason: "disposed",
    });
    expect(handle.busy).toBe(false);
    expect(() => handle.reset()).not.toThrow();
    expect(() => handle.reset({ topLevelAwait: true })).not.toThrow();
    expect(() => handle.setCopyOnSelect(false)).not.toThrow();
    expect(() => handle.focus()).not.toThrow();
    expect(handle.crossOriginIsolated).toBe(true);
    // 정리된 뒤에는 worker를 새로 만들지 않는다.
    expect(factory.workers).toHaveLength(1);
  });

  test("reset({ topLevelAwait: true })는 core reset으로 전달돼 새 worker를 만들고 값을 바꾼다", async () => {
    const statuses: ReplStatus[] = [];
    const probe = mount({ onStatus: (status) => statuses.push(status) });
    await becomeReady(probe, statuses);
    act(() => probe.ref.current!.reset({ topLevelAwait: true }));
    expect(factory.workers).toHaveLength(2);
    expect(factory.workers[0]!.terminated()).toBe(true);
    expect(factory.workers[1]!.init()!.driver).toMatchObject({
      topLevelAwait: true,
    });
    // 마지막 값은 core가 보관한다. 인자 없는 `reset()`은 같은 값을 다시 쓴다.
    act(() => probe.ref.current!.reset());
    expect(factory.workers).toHaveLength(3);
    expect(factory.workers[2]!.init()!.driver).toMatchObject({
      topLevelAwait: true,
    });
    act(() => probe.ref.current!.reset({ topLevelAwait: false }));
    expect(factory.workers[3]!.init()!.driver).toMatchObject({
      topLevelAwait: false,
    });
  });

  test("crossOriginIsolated는 살아 있는 repl이 만들 때 정한 값이다(만든 뒤 전역이 바뀌어도 유지)", () => {
    const probe = mount();
    vi.stubGlobal("crossOriginIsolated", false);
    expect(probe.ref.current!.crossOriginIsolated).toBe(true);
  });

  test("reset()은 세션을 새로 시작해 loading을 다시 알린다", async () => {
    const statuses: ReplStatus[] = [];
    const probe = mount({ onStatus: (status) => statuses.push(status) });
    await becomeReady(probe, statuses);
    act(() => probe.ref.current!.reset());
    expect(statuses).toEqual(["loading", "ready", "loading"]);
  });
});

describe("PythonRepl: 타입", () => {
  test("props·handle은 하위 타입에서 유도돼 콜백·메서드 시그니처가 같다", () => {
    expectTypeOf<PythonReplProps["onStatus"]>().toEqualTypeOf<
      ReplOptions["onStatus"]
    >();
    expectTypeOf<PythonReplProps["onCrash"]>().toEqualTypeOf<
      ReplOptions["onCrash"]
    >();
    expectTypeOf<PythonReplProps["onCopy"]>().toEqualTypeOf<
      ReplOptions["onCopy"]
    >();
    expectTypeOf<PythonReplProps["onCopy"]>().toEqualTypeOf<
      ((result: CopyResult) => void) | undefined
    >();
    expectTypeOf<PythonReplProps["topLevelAwait"]>().toEqualTypeOf<
      ReplOptions["topLevelAwait"]
    >();
    expectTypeOf<PythonReplProps["copyOnSelect"]>().toEqualTypeOf<
      ReplOptions["copyOnSelect"]
    >();
    expectTypeOf<PythonReplProps["completionPopover"]>().toEqualTypeOf<
      ReplOptions["completionPopover"]
    >();
    expectTypeOf<PythonReplHandle["runSource"]>().toEqualTypeOf<
      ReplHandle["runSource"]
    >();
    expectTypeOf<PythonReplHandle["reset"]>().toEqualTypeOf<
      ReplHandle["reset"]
    >();
    expectTypeOf<PythonReplHandle["busy"]>().toEqualTypeOf<
      ReplHandle["busy"]
    >();
    expectTypeOf<PythonReplHandle["crossOriginIsolated"]>().toEqualTypeOf<
      ReplHandle["crossOriginIsolated"]
    >();
  });

  test("onStatus의 상태 유니온은 REPL은 ReplStatus, Runner는 RunnerStatus라 섞이지 않는다", () => {
    type ReplStatusArg = Parameters<
      NonNullable<PythonReplProps["onStatus"]>
    >[0];
    type RunnerStatusArg = Parameters<
      NonNullable<PythonRunnerProps["onStatus"]>
    >[0];
    expectTypeOf<ReplStatusArg>().toEqualTypeOf<ReplStatus>();
    expectTypeOf<ReplStatusArg>().not.toEqualTypeOf<RunnerStatusArg>();
  });

  test("Terminal 객체·status·run·stop·clear는 handle에, terminal·pyodide는 props에 없다", () => {
    expectTypeOf<PythonReplHandle>().not.toHaveProperty("terminal");
    expectTypeOf<PythonReplHandle>().not.toHaveProperty("status");
    expectTypeOf<PythonReplHandle>().not.toHaveProperty("run");
    expectTypeOf<PythonReplHandle>().not.toHaveProperty("stop");
    expectTypeOf<PythonReplHandle>().not.toHaveProperty("clear");
    expectTypeOf<PythonReplHandle>().not.toHaveProperty("dispose");
    expectTypeOf<PythonReplProps>().not.toHaveProperty("terminal");
    expectTypeOf<PythonReplProps>().not.toHaveProperty("pyodide");
  });

  test("children은 props 타입에 없다(xterm이 붙는 컨테이너 div에 React 자식을 함께 렌더하지 않는다)", () => {
    expectTypeOf<PythonReplProps>().not.toHaveProperty("children");
  });

  test("index는 PythonRepl·PythonRunner를 함께 내보낸다", () => {
    expect(typeof PythonRepl).toBe("function");
    expect(typeof PythonRunner).toBe("function");
  });
});
