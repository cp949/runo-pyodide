/**
 * `<PythonRunner>`·`<PythonRepl>`이 반복하는 터미널 위젯 수명(RD-038)을 hook 하나로 모은다.
 * - 마운트 effect에서 `mountTerminalView`로 xterm 화면을 붙인다.
 * - 그 `Terminal`로 `create()`를 불러 하위 핸들(runner·repl)을 만든다.
 * - `create()`가 던지면 화면을 정리하고 다시 던진다. `useCoreHandle`의 effect 오류로 React가 처리한다.
 * - cleanup은 하위 `dispose()` → 화면 `dispose()` 순서다(14-runner.md 14.5.5).
 * - `live`는 지금 살아 있는 하위 핸들이다. 마운트 전·cleanup과 재마운트 사이·언마운트 뒤는 `null`이다.
 * - `focus()`는 수명 내내 같은 함수다. 살아 있는 `Terminal`이 없으면 no-op이다.
 */
import { useEffect, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { useCoreHandle } from "./use-lifecycle";
import {
  mountTerminalView,
  type TerminalView,
  type TerminalViewOptions,
} from "./terminal-view";

/** `useTerminalWidget` 반환값 */
export interface TerminalWidget<H> {
  /**
   * 살아 있는 하위 핸들(`createTerminalRunner`·`createRepl`의 반환값 그대로).
   * 없는 구간은 `null`이다.
   * getter라 대입할 수 없다.
   */
  readonly live: { readonly current: H | null };

  /** 살아 있는 `Terminal`에 포커스를 준다. 없으면 no-op. 수명 내내 같은 함수 */
  focus(): void;
}

/** `useTerminalWidget` 옵션 */
export interface UseTerminalWidgetOptions<H> {
  /** xterm 화면 옵션. 마운트 때만 읽는다. */
  view: TerminalViewOptions;

  /** 하위 핸들 생성 함수. 마운트 effect 안에서 한 번 부른다. 던지면 화면을 정리하고 다시 던진다. */
  create: (terminal: Terminal) => H;

  /** 반응형 옵션. 바뀌면 `live.current?.setCopyOnSelect(copyOnSelect !== false)`를 부른다. */
  copyOnSelect: boolean | undefined;
}

/** 살아 있는 위젯 한 벌. 하위 핸들과 xterm 화면을 묶어 정리 순서를 한 곳에서 지킨다. */
interface LiveWidget<H extends { dispose(): void }> {
  /** 하위 핸들(runner·repl) */
  child: H;

  /** xterm 화면 */
  view: TerminalView;

  /** 하위 핸들 → 화면 순으로 정리한다. */
  dispose(): void;
}

/**
 * 컨테이너에 xterm 화면과 하위 핸들을 붙이는 hook.
 * 수명 규칙은 파일 머리 주석을 따른다.
 *
 * @param containerRef xterm을 열 컨테이너. 마운트 effect 시점에 채워져 있어야 한다.
 * @param options 화면 옵션, 하위 핸들 생성 함수, 반응형 `copyOnSelect`
 * @returns 살아 있는 하위 핸들(`live`)과 `focus()`
 */
export function useTerminalWidget<
  H extends { dispose(): void; setCopyOnSelect(on: boolean): void },
>(
  containerRef: RefObject<HTMLDivElement | null>,
  options: UseTerminalWidgetOptions<H>,
): TerminalWidget<H> {
  // 마운트 effect에서 화면 → 하위 핸들 순으로 만든다.
  const innerRef = useCoreHandle<LiveWidget<H>>(() => {
    const view = mountTerminalView(containerRef.current!, options.view);
    let child: H;
    try {
      child = options.create(view.terminal);
    } catch (error) {
      view.dispose();
      throw error;
    }
    return {
      child,
      view,
      dispose() {
        // 열린 읽기가 정리된 뒤에 화면을 뗀다(14-runner.md 14.5.5).
        // 순서를 뒤집어도 콘솔 경고는 나지 않는다(TRP-064).
        // 순서는 L0 계약 시험이 지킨다. `Terminal.dispose` 시점의 live worker 수를 본다.
        child.dispose();
        view.dispose();
      },
    };
  });

  // `live`는 수명 내내 같은 객체이고, `current`는 읽을 때마다 지금 살아 있는 하위 핸들을 돌려준다.
  const [live] = useState<TerminalWidget<H>["live"]>(() => ({
    get current() {
      return innerRef.current?.child ?? null;
    },
  }));

  // 마운트 effect 뒤에 돌아 생성 직후 같은 값을 한 번 더 설정한다. 무해하다.
  useEffect(() => {
    live.current?.setCopyOnSelect(options.copyOnSelect !== false);
  }, [options.copyOnSelect, live]);

  const [widget] = useState<TerminalWidget<H>>(() => ({
    live,
    focus: () => innerRef.current?.view.terminal.focus(),
  }));

  return widget;
}
