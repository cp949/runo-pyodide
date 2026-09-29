/**
 * `<PythonRunner>`·`<PythonRepl>` 공통 계약 시험. jsdom + React.
 * - 방식: `describe.each([PythonRunner, PythonRepl])` 한 벌로 두 컴포넌트에 같은 시험을 돌린다(RD-038).
 * - adapter는 `{ name, Component, hostId }` 세 필드만 쓴다. 두 컴포넌트에 공통인 props·handle 표면만 시험한다.
 * - suite 5개, 고유 제목 19개(`docs/design/15-react.md` 15.10).
 *   - xterm·worker 수명 7
 *   - 콜백 1
 *   - `copyOnSelect` 반응형 3
 *   - fit 배선 4
 *   - ref handle 4
 * - 이 suite에 없는 시험: 구조만 같거나(핸들 키 목록) 본문이 다른 시험. 각 컴포넌트 시험 파일에 있다.
 * - 이 suite는 `useTerminalWidget` 수명 module의 안전망이다.
 */
import type { CopyResult } from "@cp949/runo-pyodide-terminal";
import type { ITerminalInitOnlyOptions, ITerminalOptions } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { StrictMode, act, useEffect, useRef } from "react";
import type { CSSProperties, ReactNode, Ref } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { stubClipboard } from "@repo/pyodide-testkit/clipboard";
import { PythonRepl, PythonRunner } from "../src/index";
import {
  FakeResizeObserver,
  installFakeRaf,
  until,
  type FakeRaf,
} from "./harness";
import {
  factory,
  container,
  openSpy,
  disposeSpy,
  warnSpy,
  originalDispose,
  unmount,
  useComponentHarness,
  type Probe,
} from "./component-harness";

/** 계약 시험이 쓰는 handle 표면. 두 컴포넌트 handle의 공통 부분만 담는다. */
interface ContractHandle {
  focus(): void;
  setCopyOnSelect(enabled: boolean): void;
  reset(): void;
}

/** 계약 시험이 쓰는 props 표면. 두 컴포넌트 Props의 공통 부분만 담는다. */
interface ContractProps {
  createWorker: typeof factory.createWorker;
  terminalOptions?: ITerminalOptions & ITerminalInitOnlyOptions;
  fit?: boolean;
  copyOnSelect?: boolean;
  onStatus?: (status: string) => void;
  onCrash?: (message: string) => void;
  onCopy?: (result: CopyResult) => void;
  className?: string;
  style?: CSSProperties;
  id?: string;
  "data-testid"?: string;
  ref?: Ref<ContractHandle>;
}

/** 시험 대상 컴포넌트 한 쌍의 차이를 담는 adapter */
interface Adapter {
  /** suite 제목과 `className`·`id` 접두에 쓰는 이름 */
  name: string;

  /** 시험할 컴포넌트. 공통 props 표면으로 좁힌 타입 */
  Component: (props: ContractProps) => ReactNode;

  /** 컨테이너 div의 `data-testid` 값 */
  hostId: string;
}

// 두 컴포넌트를 공통 표면 타입으로 단언해 넣는다.
const ADAPTERS: Adapter[] = [
  {
    name: "PythonRunner",
    Component: PythonRunner as unknown as Adapter["Component"],
    hostId: "runner-host",
  },
  {
    name: "PythonRepl",
    Component: PythonRepl as unknown as Adapter["Component"],
    hostId: "repl-host",
  },
];

/**
 * `index`번째 worker가 `ready`를 알리게 하고 `statuses`의 마지막 값이 `ready`가 될 때까지 기다린다.
 * `onStatus`로 모은 배열을 쓰므로 두 컴포넌트에 똑같이 동작한다. ref handle suite의 `reset()` 시험이 쓴다.
 */
async function becomeReady(statuses: string[], index = 0): Promise<void> {
  factory.workers[index]!.ready();
  await until(() => statuses.at(-1) === "ready");
}

describe.each(ADAPTERS)(
  "$name: xterm·worker 수명",
  ({ name, Component, hostId }) => {
    const { mount, props } = useComponentHarness<ContractHandle, ContractProps>(
      {
        Component,
        hostId,
      },
    );

    test("StrictMode 이중 마운트 뒤 살아 있는 worker와 .xterm은 1개다(worker 생성 2·terminate 1)", () => {
      mount({}, { strict: true });
      expect(factory.workers).toHaveLength(2);
      expect(factory.live()).toBe(1);
      expect(factory.workers[0]!.terminated()).toBe(true);
      expect(factory.workers[1]!.terminated()).toBe(false);
      expect(openSpy).toHaveBeenCalledTimes(2);
      expect(disposeSpy).toHaveBeenCalledTimes(1);
      expect(container.querySelectorAll(".xterm")).toHaveLength(1);
    });

    test("StrictMode 없이는 worker 1개와 Terminal 1개를 만든다", () => {
      mount();
      expect(factory.workers).toHaveLength(1);
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(container.querySelectorAll(".xterm")).toHaveLength(1);
    });

    test("언마운트하면 worker 0개이고 Terminal을 dispose하며 .xterm이 사라진다", async () => {
      mount({}, { strict: true });
      await unmount();
      expect(factory.live()).toBe(0);
      expect(factory.workers).toHaveLength(2);
      expect(disposeSpy).toHaveBeenCalledTimes(2);
      expect(container.querySelectorAll(".xterm")).toHaveLength(0);
    });

    test("인라인 람다 콜백으로 재렌더해도 worker·Terminal을 다시 만들지 않는다", () => {
      const probe = mount({
        onStatus: () => {},
        onCrash: () => {},
        onCopy: () => {},
      });
      for (let i = 0; i < 2; i += 1) {
        probe.rerender(
          props({
            onStatus: () => {},
            onCrash: () => {},
            onCopy: () => {},
          }),
        );
      }
      expect(factory.workers).toHaveLength(1);
      expect(factory.workers[0]!.terminated()).toBe(false);
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(disposeSpy).not.toHaveBeenCalled();
    });

    test("정리 순서는 하위 먼저 terminal 나중이다(terminal이 dispose될 때 worker는 이미 terminate됐다)", async () => {
      const liveWhenTerminalDisposed: number[] = [];
      disposeSpy.mockImplementation(function (this: Terminal) {
        liveWhenTerminalDisposed.push(factory.live());
        return originalDispose.call(this);
      });
      mount({}, { strict: true });
      await unmount();
      expect(liveWhenTerminalDisposed).toEqual([0, 0]);
      // 정리 중 동기 경고가 없다는 것만 본다.
      // - 이 시험은 dispose 전에 대기 중인 write 콜백을 만들지 않는다. xterm write 파싱은 `setTimeout`으로 미뤄진다.
      //   그래서 `docs/traps/TRP-004` 회귀(dispose 뒤 콜백의 `buffer` 접근)는 여기서 보이지 않는다.
      // - 정리 순서를 뒤집어도 이 경고는 나지 않는다(`docs/traps/TRP-064`). 순서는 위 `[0, 0]` 단언이 잡는다.
      expect(warnSpy).not.toHaveBeenCalled();
    });

    test("createWorker가 던지면 만든 Terminal을 정리하고 오류가 React로 전파된다", () => {
      // 격리가 아니면 `createWorker`를 부르지 않으므로 격리 상태에서 시험한다.
      // 오류 경계가 없어 root 렌더가 그대로 던진다.
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const root = createRoot(container);
      expect(() =>
        act(() =>
          root.render(
            <Component
              createWorker={() => {
                throw new Error("worker 생성 실패");
              }}
            />,
          ),
        ),
      ).toThrow("worker 생성 실패");
      // 생성 도중 던져도 열린 Terminal은 모두 dispose된다.
      expect(openSpy).toHaveBeenCalled();
      expect(disposeSpy).toHaveBeenCalledTimes(openSpy.mock.calls.length);
      errors.mockRestore();
    });

    test("terminalOptions를 Terminal에 넘기고 나머지 div 속성·className·style을 컨테이너에 준다", () => {
      const probe = mount({
        terminalOptions: { cols: 100, rows: 10 },
        className: `${name}-box`,
        style: { height: 240 },
        id: `${name}-1`,
      });
      expect(probe.terminal().cols).toBe(100);
      expect(probe.terminal().rows).toBe(10);
      const host = probe.host();
      expect(host.className).toBe(`${name}-box`);
      expect(host.style.height).toBe("240px");
      expect(host.id).toBe(`${name}-1`);
      expect(host.querySelector(".xterm")).not.toBeNull();
    });
  },
);

describe.each(ADAPTERS)("$name: 콜백", ({ Component, hostId }) => {
  const { mount, props } = useComponentHarness<ContractHandle, ContractProps>({
    Component,
    hostId,
  });

  test("재렌더로 바꾼 onCrash가 크래시 통지를 받는다", () => {
    const first = vi.fn();
    const second = vi.fn();
    const probe = mount({ onCrash: first });
    probe.rerender(props({ onCrash: second }));
    act(() => factory.workers[0]!.dispatchError("boom"));
    expect(second).toHaveBeenCalledWith("boom");
    expect(first).not.toHaveBeenCalled();
  });
});

describe.each(ADAPTERS)(
  "$name: copyOnSelect 반응형",
  ({ Component, hostId }) => {
    const { mount, props } = useComponentHarness<ContractHandle, ContractProps>(
      {
        Component,
        hostId,
      },
    );

    // 화면에 글(`copy-me`)을 쓰고 7자를 드래그로 선택한 뒤 마우스를 놓는 동작을 흉내 낸다.
    async function dragSelect(
      probe: Probe<ContractHandle, ContractProps>,
    ): Promise<void> {
      const terminal = probe.terminal();
      await new Promise<void>((resolve) => terminal.write("copy-me", resolve));
      terminal.select(0, 0, 7);
      terminal.element!.dispatchEvent(
        new MouseEvent("mousedown", { button: 0 }),
      );
      document.dispatchEvent(new MouseEvent("mouseup"));
    }

    test("prop을 토글하면 재마운트 없이 자동 복사가 켜지고 꺼진다", async () => {
      const writeText = stubClipboard();
      const onCopy = vi.fn();
      const probe = mount({ copyOnSelect: false, onCopy });
      await dragSelect(probe);
      expect(writeText).not.toHaveBeenCalled();

      probe.rerender(props({ copyOnSelect: true, onCopy }));
      await dragSelect(probe);
      await until(() => onCopy.mock.calls.length === 1);
      expect(writeText).toHaveBeenCalledWith("copy-me");
      expect(onCopy).toHaveBeenCalledWith({ ok: true, chars: 7 });

      probe.rerender(props({ copyOnSelect: false, onCopy }));
      await dragSelect(probe);
      expect(writeText).toHaveBeenCalledTimes(1);
      // 토글은 재마운트를 일으키지 않는다.
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(factory.workers).toHaveLength(1);
    });

    test("handle.setCopyOnSelect()로도 자동 복사를 바꾼다", async () => {
      const writeText = stubClipboard();
      const onCopy = vi.fn();
      const probe = mount({ copyOnSelect: false, onCopy });
      act(() => probe.ref.current!.setCopyOnSelect(true));
      await dragSelect(probe);
      await until(() => onCopy.mock.calls.length === 1);
      expect(writeText).toHaveBeenCalledWith("copy-me");
    });

    test("기본값은 자동 복사이고 재렌더로 바꾼 onCopy가 결과를 받는다", async () => {
      stubClipboard();
      const first = vi.fn();
      const second = vi.fn();
      const probe = mount({ onCopy: first });
      probe.rerender(props({ onCopy: second }));
      await dragSelect(probe);
      await until(() => second.mock.calls.length === 1);
      expect(first).not.toHaveBeenCalled();
    });
  },
);

describe.each(ADAPTERS)("$name: fit 배선", ({ Component, hostId }) => {
  const { mount } = useComponentHarness<ContractHandle, ContractProps>({
    Component,
    hostId,
  });

  let raf: FakeRaf;
  let fitSpy: ReturnType<typeof vi.spyOn>;
  let activateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    FakeResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    raf = installFakeRaf((globalName, value) =>
      vi.stubGlobal(globalName, value),
    );
    fitSpy = vi.spyOn(FitAddon.prototype, "fit").mockImplementation(() => {});
    activateSpy = vi.spyOn(FitAddon.prototype, "activate");
  });

  // 마운트한 뒤 xterm이 예약한 rAF를 비운다.
  function mountFit(
    initial: Partial<ContractProps> = {},
    mountOptions: { strict?: boolean } = {},
  ): Probe<ContractHandle, ContractProps> {
    const probe = mount(initial, mountOptions);
    raf.flush();
    return probe;
  }

  // 컨테이너를 관찰하는 observer. xterm 내부 observer는 대상으로 걸러 뺀다.
  function hostObservers(
    probe: Probe<ContractHandle, ContractProps>,
  ): FakeResizeObserver[] {
    return FakeResizeObserver.instances.filter((observer) =>
      observer.targets.includes(probe.host()),
    );
  }

  test("기본값(fit 생략)은 FitAddon을 붙이고 컨테이너에 ResizeObserver를 건다", () => {
    const probe = mountFit();
    expect(activateSpy).toHaveBeenCalledTimes(1);
    expect(hostObservers(probe)).toHaveLength(1);
  });

  test("fit={false}이면 FitAddon도 ResizeObserver도 만들지 않는다", () => {
    const probe = mountFit({ fit: false });
    expect(activateSpy).not.toHaveBeenCalled();
    expect(hostObservers(probe)).toHaveLength(0);
    expect(FakeResizeObserver.instances).toHaveLength(0);
    expect(fitSpy).not.toHaveBeenCalled();
  });

  test("언마운트하면 observer를 끊는다", async () => {
    const probe = mount();
    const observer = hostObservers(probe)[0]!;
    await unmount();
    expect(observer.disconnected).toBe(true);
  });

  test("StrictMode에서는 observer 2개를 만들고 첫 것만 끊는다", () => {
    const probe = mount({}, { strict: true });
    const observers = hostObservers(probe);
    // StrictMode 재마운트에서도 컨테이너 div는 같은 DOM 노드다. observer는 그 노드에 두 번 걸린다.
    expect(observers).toHaveLength(2);
    expect(observers[0]!.disconnected).toBe(true);
    expect(observers[1]!.disconnected).toBe(false);
  });
});

describe.each(ADAPTERS)("$name: ref handle", ({ Component, hostId }) => {
  const { mount, props } = useComponentHarness<ContractHandle, ContractProps>({
    Component,
    hostId,
  });

  test("handle 객체는 StrictMode 재마운트에서도 같은 객체다", () => {
    const seen = new Set<ContractHandle>();
    let current: ContractHandle | null = null;
    const ref = (handle: ContractHandle | null) => {
      if (handle) seen.add(handle);
      current = handle;
    };
    const root = createRoot(container);
    act(() =>
      root.render(
        <StrictMode>
          <Component createWorker={factory.createWorker} ref={ref} />
        </StrictMode>,
      ),
    );
    expect(current).not.toBeNull();
    expect(seen.size).toBe(1);
    act(() => root.unmount());
  });

  test("재렌더로 createWorker를 바꿔도 reset()은 마운트 때 것으로 새 worker를 만든다", async () => {
    const statuses: string[] = [];
    const probe = mount({ onStatus: (status) => statuses.push(status) });
    await becomeReady(statuses);
    const replaced = vi.fn(factory.createWorker);
    probe.rerender(
      props({
        createWorker: replaced,
        onStatus: (status) => statuses.push(status),
      }),
    );
    act(() => probe.ref.current!.reset());
    expect(replaced).not.toHaveBeenCalled();
    expect(factory.workers).toHaveLength(2);
  });

  test("focus()는 살아 있는 Terminal에 포커스를 준다", async () => {
    const probe = mount({}, { strict: true });
    const focusSpy = vi.spyOn(Terminal.prototype, "focus");
    act(() => probe.ref.current!.focus());
    expect(focusSpy).toHaveBeenCalledTimes(1);
    // 재마운트 뒤 살아 있는 Terminal은 두 번째 것이다.
    expect(focusSpy.mock.contexts[0]).toBe(probe.terminal());
    const handle = probe.ref.current!;
    await unmount();
    handle.focus();
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  test("부모의 마운트 effect에서 부른 focus()는 StrictMode에서도 살아 있는 Terminal에 닿는다(autoFocus prop 불필요)", () => {
    const focusSpy = vi.spyOn(Terminal.prototype, "focus");
    function Parent() {
      const ref = useRef<ContractHandle>(null);
      // 자식 effect(하위 핸들 생성)가 부모 effect보다 먼저 돈다. StrictMode 재마운트에서도 같은 순서다.
      useEffect(() => {
        ref.current?.focus();
      }, []);
      return <Component createWorker={factory.createWorker} ref={ref} />;
    }
    const root = createRoot(container);
    act(() =>
      root.render(
        <StrictMode>
          <Parent />
        </StrictMode>,
      ),
    );
    // effect가 마운트·재마운트로 두 번 돌아 `focus()`도 두 번이다. 마지막 호출이 살아 있는 두 번째 Terminal에 닿는다.
    expect(focusSpy).toHaveBeenCalledTimes(2);
    const live = openSpy.mock.contexts.at(-1);
    expect(focusSpy.mock.contexts.at(-1)).toBe(live);
    expect(focusSpy.mock.contexts[0]).not.toBe(live);
    expect(container.querySelectorAll(".xterm")).toHaveLength(1);
    act(() => root.unmount());
  });
});
