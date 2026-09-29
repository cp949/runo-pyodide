/**
 * `terminal-view.ts`의 fit 로직(`attachFit`) 시험. jsdom, React를 거치지 않는다.
 * - 진입점: `mountTerminalView(container, { fit: true })`.
 * - 확인: 크기 0 건너뜀, rAF 콜백의 실행 시점 크기 재확인, 연속 통지 합침, `dispose()`의 rAF 취소, `ResizeObserver` 없는 환경.
 * - 확인: 마운트 도중 `fit()`이 던지면 `Terminal`(과 로드된 addon)을 정리하고 다시 던진다.
 * - 다른 파일과의 분담: 마운트 배선(FitAddon 부착·ResizeObserver 생성·`fit={false}`·StrictMode observer 2개)은
 *   `terminal-component.contract.test.tsx`의 "fit 배선" suite가 본다(`docs/design/15-react.md` 15.5).
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
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
    // jsdom은 레이아웃이 없다. 컨테이너 크기만 `hostSize`로 정하고 xterm이 만드는 하위 요소는 0으로 둔다.
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

  // `fit: true`로 마운트하고 `afterEach`가 정리하도록 `view`에 담는다.
  function mount(): TerminalView {
    view = mountTerminalView(container, { fit: true });
    return view;
  }

  // 마운트한 뒤 xterm이 예약한 rAF를 비운다. 이후 `raf.pending()`은 fit이 예약한 것만 센다.
  function mountFit(): TerminalView {
    const created = mount();
    raf.flush();
    return created;
  }

  // 컨테이너를 관찰하는 observer. xterm 내부 observer는 대상으로 걸러 뺀다.
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
    // 통지와 프레임 사이에 숨겨진 상황이다(`display: none`).
    hostSize = { width: 0, height: 0 };
    raf.flush();
    expect(fitSpy).not.toHaveBeenCalled();
    // 대조: 같은 경로에서 크기가 남아 있으면 fit()을 부른다.
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
    // 합친 뒤의 다음 통지는 새 rAF를 예약한다.
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

  test("마운트 도중 fit()이 던지면 Terminal을 정리하고 다시 던진다", () => {
    const failure = new Error("fit 실패");
    fitSpy.mockImplementation(() => {
      throw failure;
    });
    const terminalDispose = vi.spyOn(Terminal.prototype, "dispose");
    const addonDispose = vi.spyOn(FitAddon.prototype, "dispose");
    hostSize = { width: 400, height: 300 };
    expect(() => mount()).toThrow(failure);
    expect(terminalDispose).toHaveBeenCalledTimes(1);
    expect(addonDispose).toHaveBeenCalledTimes(1);
    expect(FakeResizeObserver.instances.length).toBe(0);
  });
});
