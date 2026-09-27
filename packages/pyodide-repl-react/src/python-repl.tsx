/**
 * `<PythonRepl>`(RD-024): repl 패키지의 `createRepl`(xterm 대화형 콘솔)을 React 수명에 붙인다. 수명·fit·ref 규칙은
 * `<PythonRunner>`와 같다. 컨테이너 `div`에 xterm `Terminal`을 만들고(필요하면 `FitAddon`), REPL을 만들고, 언마운트(cleanup)에서
 * REPL → fit → `Terminal` 순으로 정리한다(14.5.5). StrictMode에서는 worker가 2개 만들어지고 1개가 terminate돼 살아 있는 것은
 * 1개다(첫 worker의 pyodide 로드 낭비는 수용한다, 08-session.md 8.2). 콜백(`onStatus`·`onCrash`·`onCopy`)은 latest-ref라
 * 인라인 람다여도 재마운트가 없고, `copyOnSelect`는 재렌더로 바꾸면 `setCopyOnSelect`가 불린다. 나머지 생성 옵션(`createWorker`·
 * `indexURL`·`topLevelAwait`·`terminalOptions`·`fit`)은 마운트 때만 읽는다(바꾸려면 소비자가 `key`로 재마운트한다).
 * `topLevelAwait`를 세션 도중 바꾸는 길은 handle의 `reset({ topLevelAwait })`뿐이다. `xterm.css`는 소비자가 import한다.
 */
import {
  createRepl,
  type ReplHandle,
  type ReplOptions,
} from "@cp949/runo-pyodide-repl";
import type { ITerminalInitOnlyOptions, ITerminalOptions } from "@xterm/xterm";
import {
  useImperativeHandle,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type Ref,
} from "react";
import { rejectDisposed, useLatest } from "./use-lifecycle";
import { useTerminalWidget } from "./use-terminal-widget";

/**
 * `PythonRepl`의 ref handle. 살아 있는 REPL이 없는 동안(마운트 전·재마운트 사이·언마운트 뒤)의 규칙은 `PythonRunner`와 같다:
 * `runSource`는 `RunRejectedError("disposed")`, `busy`는 `false`, 나머지는 no-op이다(`crossOriginIsolated`는 전역 값).
 */
export interface PythonReplHandle extends Pick<
  ReplHandle,
  "runSource" | "reset" | "setCopyOnSelect" | "busy" | "crossOriginIsolated"
> {
  /** xterm 화면에 포커스를 준다. 살아 있는 `Terminal`이 없으면 아무것도 하지 않는다. */
  focus(): void;
}

export interface PythonReplProps
  extends
    Omit<ReplOptions, "terminal" | "pyodide">,
    Omit<ComponentPropsWithoutRef<"div">, keyof ReplOptions | "children"> {
  /** pyodide 배포 위치. 마운트 때만 읽는다. 없으면 core 기본값. */
  indexURL?: string;
  /** xterm `Terminal` 옵션. 마운트 때만 읽고 그대로 넘긴다(기본값을 더하지 않는다). */
  terminalOptions?: ITerminalOptions & ITerminalInitOnlyOptions;
  /** 컨테이너 크기에 맞춰 열·행을 조절한다. 기본 `true`. 마운트 때만 읽는다. */
  fit?: boolean;
  ref?: Ref<PythonReplHandle>;
}

export function PythonRepl({
  ref,
  createWorker,
  indexURL,
  topLevelAwait,
  copyOnSelect,
  onCopy,
  onStatus,
  onCrash,
  terminalOptions,
  fit,
  completionPopover,
  ...divProps
}: PythonReplProps) {
  const latest = useLatest({
    createWorker,
    indexURL,
    topLevelAwait,
    copyOnSelect,
    onCopy,
    onStatus,
    onCrash,
    terminalOptions,
    fit,
    completionPopover,
  });
  const containerRef = useRef<HTMLDivElement>(null);

  const widget = useTerminalWidget<ReplHandle>(containerRef, {
    // 렌더 스코프 값(`latest.current`가 아니다): hook 내부의 latest-ref가 마운트 시점 최신 렌더의 `create`
    // 클로저(와 이 `view`)를 골라 쓰므로, 여기서 `latest.current`를 읽으면 한 commit 늦은 값이 된다(TRP-086).
    view: { terminalOptions, fit: fit !== false },
    create: (terminal) => {
      const mount = latest.current;
      return createRepl({
        terminal,
        createWorker: mount.createWorker,
        pyodide:
          mount.indexURL === undefined
            ? undefined
            : { indexURL: mount.indexURL },
        topLevelAwait: mount.topLevelAwait,
        copyOnSelect: mount.copyOnSelect,
        completionPopover: mount.completionPopover,
        // 래퍼는 동기 재진입을 그대로 통과시킨다(TRP-051): 안에서 상태를 가두지 않고 호출만 전달한다.
        onCopy: (result) => latest.current.onCopy?.(result),
        onStatus: (next) => latest.current.onStatus?.(next),
        onCrash: (message) => latest.current.onCrash?.(message),
      });
    },
    copyOnSelect,
  });

  const [handle] = useState<PythonReplHandle>(() => ({
    runSource: (code) =>
      widget.live.current?.runSource(code) ?? rejectDisposed(),
    reset: (options) => widget.live.current?.reset(options),
    setCopyOnSelect: (on) => widget.live.current?.setCopyOnSelect(on),
    focus: widget.focus,
    get busy() {
      return widget.live.current?.busy ?? false;
    },
    get crossOriginIsolated() {
      return (
        widget.live.current?.crossOriginIsolated ??
        globalThis.crossOriginIsolated === true
      );
    },
  }));
  useImperativeHandle(ref, () => handle, [handle]);

  return <div {...divProps} ref={containerRef} />;
}
