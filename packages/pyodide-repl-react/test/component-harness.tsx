/**
 * `<PythonRunner>`·`<PythonRepl>` 컴포넌트 시험 공용 하니스. jsdom 시험 전용이다.
 * - 대상 시험: `python-runner.test.tsx`, `python-repl.test.tsx`, `terminal-component.contract.test.tsx`.
 * - 공유 항목: 전역 상태, `beforeEach`·`afterEach` 등록, `mount`, `props`, `unmount`, `screenText`.
 * - 상태 공유 방식: `pyodide-repl`의 `console-harness`(RD-037)와 같다.
 *   - `factory`·`container`·spy는 `export let` live binding이다. 시험 파일은 import한 이름을 그대로 읽는다.
 *   - 함수는 평범한 export다.
 */
import { StrictMode, act, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, vi } from "vitest";
import {
  createFakeWorkerFactory,
  type FakeWorkerFactory,
} from "@cp949/runo-pyodide-core/test-utils";
import { FakeResizeObserver, enableActEnvironment } from "./harness";

export let factory: FakeWorkerFactory;
export let container: HTMLElement;
export let openSpy: ReturnType<typeof vi.spyOn>;
export let disposeSpy: ReturnType<typeof vi.spyOn>;
export let warnSpy: ReturnType<typeof vi.spyOn>;
/** spy를 걸기 전의 원본 `Terminal.prototype.dispose` */
export const originalDispose = Terminal.prototype.dispose;

let root: Root | undefined;

/** `mount`가 만든 root를 언마운트한다. 이미 언마운트했거나 마운트 전이면 아무것도 하지 않는다. */
export async function unmount(): Promise<void> {
  if (!root) return;
  const mounted = root;
  root = undefined;
  await act(async () => mounted.unmount());
}

/**
 * 터미널 화면 전체를 줄 단위 문자열로 읽는다.
 * xterm `write`는 파싱이 비동기라, 앞선 쓰기가 버퍼에 반영될 때까지 기다린 뒤 읽는다.
 */
export async function screenText(terminal: Terminal): Promise<string> {
  await new Promise<void>((resolve) => terminal.write("", resolve));
  const lines: string[] = [];
  const buffer = terminal.buffer.active;
  for (let y = 0; y < buffer.length; y += 1) {
    lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

/** `mount`가 돌려주는 시험 조작 handle */
export interface Probe<Handle, Props> {
  /** 컴포넌트에 붙인 ref. `current`가 handle이다. */
  ref: { current: Handle | null };

  /** props를 통째로 바꿔 다시 렌더한다. */
  rerender(next: Props): void;

  /** 컴포넌트가 그린 컨테이너 div */
  host(): HTMLElement;

  /** 가장 최근에 `open`된 Terminal */
  terminal(): Terminal;
}

export interface ComponentHarnessOptions<Props> {
  /** 시험할 컴포넌트 */
  Component: (props: Props) => ReactNode;

  /** 컨테이너 div의 `data-testid` 값 */
  hostId: string;
}

export interface ComponentHarness<Props, Handle> {
  /**
   * 컴포넌트를 `container`에 마운트한다.
   * `strict`이면 StrictMode로 감싸 mount → cleanup → mount를 돌린다.
   */
  mount(
    initial?: Partial<Props>,
    options?: { strict?: boolean },
  ): Probe<Handle, Props>;

  /** `createWorker`·`data-testid` 기본값에 `overrides`를 덮은 props */
  props(overrides?: Partial<Props>): Props;
}

/**
 * 컴포넌트 시험 하니스를 등록한다. 시험 파일(또는 `describe` 콜백) 최상위에서 부른다.
 * - `enableActEnvironment()`를 부른다.
 * - `beforeEach`를 등록한다: `crossOriginIsolated` 스텁, `factory`·`container`, spy 3개(`open`·`dispose`·`console.warn`).
 * - `afterEach`를 등록한다: `unmount`, `container` 제거, `factory.dispose()`, `FakeResizeObserver.instances` 비우기,
 *   `vi.restoreAllMocks()`, `vi.unstubAllGlobals()`, `navigator.clipboard` 삭제.
 * - `{ mount, props }`를 돌려준다.
 *
 * React hook이 아니다. 이름만 `use`로 시작한다.
 */
export function useComponentHarness<
  Handle,
  Props extends { ref?: Ref<Handle> },
>({
  Component,
  hostId,
}: ComponentHarnessOptions<Props>): ComponentHarness<Props, Handle> {
  enableActEnvironment();

  beforeEach(() => {
    // jsdom에는 `crossOriginIsolated`가 없다. worker를 만드는 경로는 격리를 전제한다.
    vi.stubGlobal("crossOriginIsolated", true);
    factory = createFakeWorkerFactory();
    container = document.createElement("div");
    document.body.append(container);
    // 호출은 그대로 통과시키고 횟수·`this`(Terminal 인스턴스)만 기록한다.
    openSpy = vi.spyOn(Terminal.prototype, "open");
    disposeSpy = vi.spyOn(Terminal.prototype, "dispose");
    warnSpy = vi.spyOn(console, "warn");
  });

  afterEach(async () => {
    await unmount();
    container.remove();
    factory.dispose();
    FakeResizeObserver.instances = [];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  // 기본 props에 `overrides`를 덮는다. 컴포넌트마다 Props 타입이 달라 단언으로 맞춘다.
  function props(overrides: Partial<Props> = {}): Props {
    return {
      createWorker: factory.createWorker,
      "data-testid": hostId,
      ...overrides,
    } as unknown as Props;
  }

  // `container`에 root를 만들어 렌더한다. `rerender`는 같은 root에 새 props를 다시 그린다.
  function mount(
    initial: Partial<Props> = {},
    { strict = false }: { strict?: boolean } = {},
  ): Probe<Handle, Props> {
    let current: Props = props(initial);
    const ref: Probe<Handle, Props>["ref"] = { current: null };
    // 현재 props로 만든 엘리먼트. StrictMode 여부는 마운트 때 정한 값을 유지한다.
    const element = () => {
      const app = (
        <Component {...current} ref={ref as unknown as Ref<Handle>} />
      );
      return strict ? <StrictMode>{app}</StrictMode> : app;
    };
    root = createRoot(container);
    act(() => root!.render(element()));
    return {
      ref,
      rerender(next) {
        current = next;
        act(() => root!.render(element()));
      },
      host: () =>
        container.querySelector<HTMLElement>(`[data-testid="${hostId}"]`)!,
      terminal: () => openSpy.mock.contexts.at(-1) as Terminal,
    };
  }

  return { mount, props };
}
