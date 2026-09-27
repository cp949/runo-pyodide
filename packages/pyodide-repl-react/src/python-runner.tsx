/**
 * `<PythonRunner>`(RD-024): terminal 패키지의 `createTerminalRunner`(xterm 실행창)를 React 수명에 붙인다. 컨테이너 `div`에
 * xterm `Terminal`을 만들고(필요하면 `FitAddon`), runner를 만들고, 언마운트(cleanup)에서 runner → fit → `Terminal` 순으로 정리한다
 * (14.5.5). StrictMode에서는 worker가 2개 만들어지고 1개가 terminate돼 살아 있는 것은 1개다(첫 worker의 pyodide 로드 낭비는
 * 수용한다, 08-session.md 8.2). 콜백(`onStatus`·`onOutput`·`onCrash`·`onCopy`·`inputProvider`)은 latest-ref라 인라인 람다여도
 * 재마운트가 없고, `copyOnSelect`는 재렌더로 바꾸면 `setCopyOnSelect`가 불린다. 나머지 생성 옵션(`createWorker`·`indexURL`·
 * `filename`·`topLevelAwait`·`clearOnRun`·`terminalOptions`·`fit`)은 마운트 때만 읽는다(바꾸려면 소비자가 `key`로 재마운트한다).
 * `xterm.css`는 소비자가 import한다.
 */
import {
  createTerminalRunner,
  type TerminalRunnerHandle,
  type TerminalRunnerOptions,
} from "@cp949/runo-pyodide-terminal";
import type { ITerminalInitOnlyOptions, ITerminalOptions } from "@xterm/xterm";
import {
  useImperativeHandle,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type Ref,
} from "react";
import {
  initialRunnerStatus,
  useLatest,
  useRunnerDelegates,
} from "./use-lifecycle";
import { useTerminalWidget } from "./use-terminal-widget";

/** `PythonRunner`의 ref handle. 살아 있는 runner가 없는 동안(마운트 전·재마운트 사이·언마운트 뒤)의 규칙은 14.3과 같다. */
export interface PythonRunnerHandle extends Pick<
  TerminalRunnerHandle,
  "run" | "stop" | "reset" | "clear" | "setCopyOnSelect"
> {
  /** 마지막으로 통지된 상태. 살아 있는 runner가 없으면 마지막 값이다. */
  readonly status: TerminalRunnerHandle["status"];
  /** xterm 화면에 포커스를 준다. 살아 있는 `Terminal`이 없으면 아무것도 하지 않는다. */
  focus(): void;
}

export interface PythonRunnerProps
  extends
    Omit<TerminalRunnerOptions, "terminal" | "pyodide">,
    Omit<
      ComponentPropsWithoutRef<"div">,
      keyof TerminalRunnerOptions | "children"
    > {
  /** pyodide 배포 위치. 마운트 때만 읽는다. 없으면 core 기본값. */
  indexURL?: string;
  /** xterm `Terminal` 옵션. 마운트 때만 읽고 그대로 넘긴다(기본값을 더하지 않는다). */
  terminalOptions?: ITerminalOptions & ITerminalInitOnlyOptions;
  /** 컨테이너 크기에 맞춰 열·행을 조절한다. 기본 `true`. 마운트 때만 읽는다. */
  fit?: boolean;
  ref?: Ref<PythonRunnerHandle>;
}

export function PythonRunner({
  ref,
  createWorker,
  indexURL,
  filename,
  topLevelAwait,
  clearOnRun,
  copyOnSelect,
  onCopy,
  inputProvider,
  onStatus,
  onOutput,
  onCrash,
  terminalOptions,
  fit,
  ...divProps
}: PythonRunnerProps) {
  const latest = useLatest({
    createWorker,
    indexURL,
    filename,
    topLevelAwait,
    clearOnRun,
    copyOnSelect,
    onCopy,
    inputProvider,
    onStatus,
    onOutput,
    onCrash,
    terminalOptions,
    fit,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  // 살아 있는 runner가 없을 때 `handle.status`가 돌려줄 마지막 통지 값.
  const lastStatus = useRef(initialRunnerStatus());

  const widget = useTerminalWidget<TerminalRunnerHandle>(containerRef, {
    // 렌더 스코프 값(`latest.current`가 아니다): hook 내부의 latest-ref가 마운트 시점 최신 렌더의 `create`
    // 클로저(와 이 `view`)를 골라 쓰므로, 여기서 `latest.current`를 읽으면 한 commit 늦은 값이 된다(TRP-086).
    view: { terminalOptions, fit: fit !== false },
    create: (terminal) => {
      const mount = latest.current;
      return createTerminalRunner({
        terminal,
        createWorker: mount.createWorker,
        pyodide:
          mount.indexURL === undefined
            ? undefined
            : { indexURL: mount.indexURL },
        filename: mount.filename,
        topLevelAwait: mount.topLevelAwait,
        clearOnRun: mount.clearOnRun,
        copyOnSelect: mount.copyOnSelect,
        // 래퍼는 동기 재진입을 그대로 통과시킨다(TRP-051): 안에서 상태를 가두지 않고 호출만 전달한다.
        onCopy: (result) => latest.current.onCopy?.(result),
        // 마운트 때 공급자가 없었으면 terminal 기본(xterm 한 줄 읽기)을 쓴다. 있었으면 그 뒤로는 최신 공급자를 부른다.
        inputProvider:
          mount.inputProvider === undefined
            ? undefined
            : (prompt, signal) =>
                latest.current.inputProvider?.(prompt, signal) ??
                Promise.resolve(null),
        onStatus: (next) => {
          lastStatus.current = next;
          latest.current.onStatus?.(next);
        },
        onOutput: (chunk) => latest.current.onOutput?.(chunk),
        onCrash: (message) => latest.current.onCrash?.(message),
      });
    },
    copyOnSelect,
  });

  const delegates = useRunnerDelegates(widget.live);
  const [handle] = useState<PythonRunnerHandle>(() => ({
    run: delegates.run,
    stop: delegates.stop,
    reset: delegates.reset,
    clear: () => widget.live.current?.clear(),
    setCopyOnSelect: (on) => widget.live.current?.setCopyOnSelect(on),
    focus: widget.focus,
    get status() {
      return widget.live.current?.status ?? lastStatus.current;
    },
  }));
  useImperativeHandle(ref, () => handle, [handle]);

  return <div {...divProps} ref={containerRef} />;
}
