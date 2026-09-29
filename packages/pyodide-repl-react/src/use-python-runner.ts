/**
 * `usePythonRunner`(RD-024): xterm 없이 core `createRunner`를 React 수명에 붙인다.
 * - 마운트 때 만들고 언마운트(cleanup)에서 `dispose()`한다.
 * - StrictMode에서는 worker가 2개 만들어지고 1개가 terminate된다. 살아 있는 것은 1개다.
 * - 첫 worker의 pyodide 로드 낭비는 수용한다(08-session.md 8.2).
 * - 콜백(`onOutput`·`onStatus`·`onCrash`·`onLoadFailed`·`inputProvider`)은 latest-ref다. 인라인 람다여도 재마운트가 없고 항상 최신 함수가 불린다.
 * - 생성 옵션(`createWorker`·`pyodide`·`filename`·`topLevelAwait`)은 마운트 때만 읽는다. 바꾸려면 소비자가 `key`로 재마운트한다.
 */
import {
  createRunner,
  type InputProvider,
  type InterruptResult,
  type OutputChunk,
  type RunResult,
  type RunnerHandle,
  type RunnerOptions,
  type RunnerStatus,
  type StopResult,
} from "@cp949/runo-pyodide-core";
import { useState } from "react";
import {
  useCoreHandle,
  useInitialRunnerStatus,
  useLatest,
  useRunnerDelegates,
} from "./use-lifecycle";

export interface UsePythonRunnerOptions {
  /** worker를 만들 때마다 부른다. 마운트 때 것을 쓴다. */
  createWorker: RunnerOptions["createWorker"];
  /** Python의 stdout·stderr 원문 조각. */
  onOutput: (chunk: OutputChunk) => void;
  /** 마운트 때만 읽는다. */
  pyodide?: RunnerOptions["pyodide"];
  /** 마운트 때만 읽는다. */
  filename?: string;
  /** 마운트 때만 읽는다. */
  topLevelAwait?: boolean;
  /** 입력 공급자. 없으면 `input()`은 읽기 취소를 받는다. */
  inputProvider?: InputProvider;
  onStatus?: (status: RunnerStatus) => void;
  onCrash?: (message: string) => void;
  onLoadFailed?: (message: string) => void;
}

export interface UsePythonRunnerResult {
  /** 마지막으로 통지된 상태(React 상태). */
  readonly status: RunnerStatus;
  /** 살아 있는 핸들이 없으면 `RunRejectedError("disposed")`로 reject한다. */
  run(code: string): Promise<RunResult>;
  /** 살아 있는 핸들이 없으면 `"idle"`. */
  stop(): Promise<StopResult>;
  reset(): void;
  /** 살아 있는 핸들이 없으면 `"ignored"`. */
  interrupt(): InterruptResult;
  /** 지금 `run()`이 `busy`로 거부되는가. 렌더 시점 값이 아니라 읽을 때마다 핸들에 묻는다. */
  readonly busy: boolean;
}

export function usePythonRunner(
  options: UsePythonRunnerOptions,
): UsePythonRunnerResult {
  const latest = useLatest(options);
  // 핸들이 통지한 마지막 상태. 첫 통지 전에는 `useInitialRunnerStatus()`를 쓴다(SSR 하이드레이션 일치).
  const [notified, setStatus] = useState<RunnerStatus | null>(null);
  const initialStatus = useInitialRunnerStatus();
  const status = notified ?? initialStatus;

  const handleRef = useCoreHandle<RunnerHandle>(() => {
    const mount = latest.current;
    return createRunner({
      createWorker: mount.createWorker,
      pyodide: mount.pyodide,
      filename: mount.filename,
      topLevelAwait: mount.topLevelAwait,
      // 래퍼는 동기 재진입을 그대로 통과시킨다(TRP-051). 안에서 상태를 가두지 않고 호출만 전달한다.
      onOutput: (chunk) => latest.current.onOutput(chunk),
      inputProvider: (prompt, signal) => {
        const provider = latest.current.inputProvider;
        return provider ? provider(prompt, signal) : Promise.resolve(null);
      },
      onStatus: (next) => {
        setStatus(next);
        latest.current.onStatus?.(next);
      },
      onCrash: (message) => latest.current.onCrash?.(message),
      onLoadFailed: (message) => latest.current.onLoadFailed?.(message),
    });
  });
  const delegates = useRunnerDelegates(handleRef);
  const [interrupt] = useState(
    () => (): InterruptResult => handleRef.current?.interrupt() ?? "ignored",
  );

  return {
    status,
    run: delegates.run,
    stop: delegates.stop,
    reset: delegates.reset,
    interrupt,
    get busy() {
      return handleRef.current?.busy ?? false;
    },
  };
}
