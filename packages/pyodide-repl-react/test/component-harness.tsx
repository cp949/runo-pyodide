/**
 * `<PythonRunner>`·`<PythonRepl>` 컴포넌트 시험 공용 하니스(jsdom 시험 전용). 두 시험 파일의 이름만 다른 사본(전역·
 * beforeEach/afterEach·`unmount`·`Probe`·`mount`·`props`·`screenText`)을 하나로 모은다(RD-037 `console-harness`의
 * live binding 선례를 따른다 — 컴포넌트와 무관한 상태는 `export let` live binding, 함수는 평범한 export).
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
/** spy를 걸기 전의 원본 `Terminal.prototype.dispose`. */
export const originalDispose = Terminal.prototype.dispose;

let root: Root | undefined;

export async function unmount(): Promise<void> {
  if (!root) return;
  const mounted = root;
  root = undefined;
  await act(async () => mounted.unmount());
}

/** 터미널에 쓴 글이 화면 버퍼에 반영될 때까지 기다린다(xterm write는 비동기 파싱). */
export async function screenText(terminal: Terminal): Promise<string> {
  await new Promise<void>((resolve) => terminal.write("", resolve));
  const lines: string[] = [];
  const buffer = terminal.buffer.active;
  for (let y = 0; y < buffer.length; y += 1) {
    lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

export interface Probe<Handle, Props> {
  ref: { current: Handle | null };
  rerender(next: Props): void;
  /** 컴포넌트가 그린 컨테이너 div. */
  host(): HTMLElement;
  /** 가장 최근에 open된 Terminal. */
  terminal(): Terminal;
}

export interface ComponentHarnessOptions<Props> {
  Component: (props: Props) => ReactNode;
  hostId: string;
}

export interface ComponentHarness<Props, Handle> {
  mount(
    initial?: Partial<Props>,
    options?: { strict?: boolean },
  ): Probe<Handle, Props>;
  props(overrides?: Partial<Props>): Props;
}

/**
 * 시험 파일 최상위에서 한 번 부른다. `enableActEnvironment()`와 beforeEach(`crossOriginIsolated` 스텁·factory·container·
 * spy 3개)/afterEach(`unmount`·container 제거·`factory.dispose()`·`FakeResizeObserver.instances = []`·
 * `vi.restoreAllMocks()`·`vi.unstubAllGlobals()`·`navigator.clipboard` 삭제)를 등록하고 `{ mount, props }`를 돌려준다.
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

  function props(overrides: Partial<Props> = {}): Props {
    return {
      createWorker: factory.createWorker,
      "data-testid": hostId,
      ...overrides,
    } as unknown as Props;
  }

  function mount(
    initial: Partial<Props> = {},
    { strict = false }: { strict?: boolean } = {},
  ): Probe<Handle, Props> {
    let current: Props = props(initial);
    const ref: Probe<Handle, Props>["ref"] = { current: null };
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
