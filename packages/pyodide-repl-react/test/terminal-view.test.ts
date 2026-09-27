/**
 * `terminal-view.ts`의 `attachFit` 시험(jsdom, React 경유 없음). runner `fit` describe에 남았던 8건을 시험 대상
 * (`mountTerminalView`가 여는 fit 배선)과 파일을 맞추려고 여기로 옮겼다(DELTA-03). 마운트 배선 자체(FitAddon 부착·
 * ResizeObserver 생성·`fit={false}`·StrictMode observer 2개)는 계약 suite(`terminal-component.contract.test.tsx`)
 * C12~C15가 본다. followups/04(재개 시 addon 예외 주입 시험)도 이 파일이 자리다.
 */
import { FitAddon } from "@xterm/addon-fit";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mountTerminalView, type TerminalView } from "../src/terminal-view";
import { FakeResizeObserver, installFakeRaf, type FakeRaf } from "./harness";

describe("terminal-view: fit", () => {
  let raf: FakeRaf;
  let fitSpy: ReturnType<typeof vi.spyOn>;
  let activateSpy: ReturnType<typeof vi.spyOn>;
  let container: HTMLElement;
  let hostSize = { width: 0, height: 0 };
  let view: TerminalView | undefined;

  beforeEach(() => {
    FakeResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    raf = installFakeRaf((name, value) => vi.stubGlobal(name, value));
    fitSpy = vi.spyOn(FitAddon.prototype, "fit").mockImplementation(() => {});
    activateSpy = vi.spyOn(FitAddon.prototype, "activate");
    hostSize = { width: 0, height: 0 };
    container = document.createElement("div");
    document.body.append(container);
    // 실제 레이아웃이 없으므로 컨테이너의 크기만 시험이 정한다(xterm이 만드는 하위 요소는 0).
    const sizeOf = (element: Element, axis: "width" | "height") =>
      element === container ? hostSize[axis] : 0;
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(
      function (this: Element) {
        return sizeOf(this, "width");
      },
    );
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(
      function (this: Element) {
        return sizeOf(this, "height");
      },
    );
  });

  afterEach(() => {
    view?.dispose();
    view = undefined;
    container.remove();
    FakeResizeObserver.instances = [];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mount(): TerminalView {
    view = mountTerminalView(container, { fit: true });
    return view;
  }

  /** 마운트하고 xterm 자체가 예약한 rAF를 비워 이후 `raf.pending()`이 fit 것만 세게 한다. */
  function mountFit(): TerminalView {
    const created = mount();
    raf.flush();
    return created;
  }

  function hostObserver(): FakeResizeObserver {
    return FakeResizeObserver.instances.find((observer) =>
      observer.targets.includes(container),
    )!;
  }

  test("컨테이너 크기가 0이면 마운트 직후·리사이즈 통지 뒤에도 fit()을 부르지 않는다", () => {
    mountFit();
    expect(fitSpy).not.toHaveBeenCalled();
    hostObserver().trigger();
    raf.flush();
    expect(fitSpy).not.toHaveBeenCalled();
  });

  test("가로만 0이거나 세로만 0이어도 건너뛴다", () => {
    mountFit();
    hostSize = { width: 300, height: 0 };
    hostObserver().trigger();
    raf.flush();
    hostSize = { width: 0, height: 200 };
    hostObserver().trigger();
    raf.flush();
    expect(fitSpy).not.toHaveBeenCalled();
  });

  test("rAF 콜백은 실행 시점의 크기를 다시 본다(통지 뒤 프레임 전에 0이 되면 건너뛴다)", () => {
    mountFit();
    const observer = hostObserver();
    hostSize = { width: 400, height: 300 };
    observer.trigger();
    // 통지와 프레임 사이에 숨겨졌다(`display: none`).
    hostSize = { width: 0, height: 0 };
    raf.flush();
    expect(fitSpy).not.toHaveBeenCalled();
    // 같은 경로에서 크기가 남아 있으면 맞춘다(양성 구간).
    hostSize = { width: 400, height: 300 };
    observer.trigger();
    raf.flush();
    expect(fitSpy).toHaveBeenCalledTimes(1);
  });

  test("크기가 있으면 마운트 직후 fit()을 한 번 부른다", () => {
    hostSize = { width: 400, height: 300 };
    mount();
    expect(fitSpy).toHaveBeenCalledTimes(1);
  });

  test("연속 통지 3번은 rAF 한 번의 fit()으로 합쳐진다", () => {
    mountFit();
    hostSize = { width: 400, height: 300 };
    const observer = hostObserver();
    observer.trigger();
    observer.trigger();
    observer.trigger();
    expect(raf.pending()).toBe(1);
    expect(fitSpy).not.toHaveBeenCalled();
    raf.flush();
    expect(fitSpy).toHaveBeenCalledTimes(1);
    // 합쳐진 뒤 다음 통지는 새 rAF를 예약한다.
    observer.trigger();
    expect(raf.pending()).toBe(1);
    raf.flush();
    expect(fitSpy).toHaveBeenCalledTimes(2);
  });

  test("dispose()하면 예약된 rAF를 취소해 이후 fit()이 없다", () => {
    mountFit();
    hostSize = { width: 400, height: 300 };
    const observer = hostObserver();
    observer.trigger();
    expect(raf.pending()).toBe(1);
    view!.dispose();
    view = undefined;
    expect(observer.disconnected).toBe(true);
    expect(raf.pending()).toBe(0);
    raf.flush();
    expect(fitSpy).not.toHaveBeenCalled();
  });

  test("ResizeObserver가 없는 환경에서도 던지지 않는다", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    expect(() => mount()).not.toThrow();
    expect(activateSpy).toHaveBeenCalledTimes(1);
  });

  test("ResizeObserver가 없어도 크기가 있으면 마운트 때 한 번 맞춘다", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    hostSize = { width: 400, height: 300 };
    mount();
    expect(fitSpy).toHaveBeenCalledTimes(1);
  });
});
