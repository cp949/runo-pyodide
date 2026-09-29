/**
 * 실제 worker 스레드 시험 하니스. `// @vitest-environment node` 시험 전용이다.
 * 역할 스크립트(호출한 패키지의 `test/roles/<이름>.ts`)를 스레드로 띄운다.
 * main 역할(시험 본문)과는 메시지·SharedArrayBuffer로 주고받는다.
 * 스레드가 `Atomics.wait`에 막혀 있어도 시험이 끝나면 종료한다.
 *
 * 역할 스크립트 규칙:
 * - Node의 타입 제거로 실행하므로 enum·namespace를 쓰지 않는다.
 * - 타입 import는 `import type`으로 쓴다.
 * - 확장자 없는 상대 import는 `ts-resolve-hook.mjs`가 푼다.
 */
import { Worker } from "node:worker_threads";
import { onTestFinished } from "vitest";

const RESOLVE_HOOK = new URL("./ts-resolve-hook.mjs", import.meta.url).href;

/** `spawnRole()`이 돌려주는 스레드 손잡이. */
export interface Role {
  /** 스레드에 메시지를 보낸다. `transfer`에 든 MessagePort 등은 소유권이 넘어간다. */
  post(message: unknown, transfer?: readonly unknown[]): void;

  /**
   * 스레드가 보낸 다음 메시지 하나를 기다린다.
   * 스레드가 오류로 죽으면 그 오류로 reject한다. 이미 받아 둔 메시지가 있으면 그것을 먼저 돌려준다.
   * 오류 없이 끝난 스레드는 알리지 않으므로 메시지를 더 기다리면 끝나지 않는다.
   */
  next<T = unknown>(): Promise<T>;
}

// `next()` 호출이 남긴 대기자. 메시지가 오면 앞에서부터 깨운다.
interface Waiter {
  resolve(message: unknown): void;
  reject(error: unknown): void;
}

/**
 * 역할 스크립트를 스레드로 띄운다. 시험이 끝나면 스레드를 종료한다.
 * `roleUrl`은 스크립트 파일의 URL이다. 호출한 시험 파일에서 `new URL("../test/roles/<이름>.ts", import.meta.url)`로 만든다.
 * 하니스가 패키지 밖에 있어 이름만으로는 위치를 알 수 없기 때문이다.
 */
export function spawnRole(roleUrl: URL, workerData?: unknown): Role {
  const worker = new Worker(roleUrl, {
    execArgv: ["--import", RESOLVE_HOOK],
    workerData,
  });
  const inbox: unknown[] = [];
  const waiters: Waiter[] = [];
  let failure: unknown;

  worker.on("message", (message: unknown) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message);
    else inbox.push(message);
  });
  worker.on("error", (error) => {
    failure = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });
  onTestFinished(async () => {
    await worker.terminate();
  });

  return {
    post: (message, transfer) => worker.postMessage(message, transfer as never),
    next: <T>() =>
      new Promise<T>((resolve, reject) => {
        if (inbox.length > 0) return resolve(inbox.shift() as T);
        if (failure) return reject(failure);
        waiters.push({
          resolve: resolve as (message: unknown) => void,
          reject,
        });
      }),
  };
}

/**
 * 역할 스크립트를 DOM `Worker`와 같은 모양으로 띄운다(`createWorker` 주입용). 시험이 끝나면 스레드를 종료한다.
 * 지원하는 멤버:
 * - `postMessage(메시지, 전송 목록)`
 * - `terminate()`
 * - `error` 이벤트 리스너. 이벤트는 `{ message }`뿐이다. 다른 `type`은 무시한다.
 */
export function spawnWorkerLike(
  roleUrl: URL,
  workerData?: unknown,
): WorkerLike {
  const worker = new Worker(roleUrl, {
    execArgv: ["--import", RESOLVE_HOOK],
    workerData,
  });
  const listeners = new Map<
    (event: { message: string }) => void,
    (error: Error) => void
  >();
  onTestFinished(async () => {
    await worker.terminate();
  });
  return {
    postMessage: (message: unknown, transfer?: readonly unknown[]) =>
      worker.postMessage(message, transfer as never),
    terminate: () => {
      void worker.terminate();
    },
    addEventListener: (
      type: string,
      listener: (event: { message: string }) => void,
    ) => {
      if (type !== "error") return;
      const wrapped = (error: Error) => listener({ message: error.message });
      listeners.set(listener, wrapped);
      worker.on("error", wrapped);
    },
    removeEventListener: (
      type: string,
      listener: (event: { message: string }) => void,
    ) => {
      const wrapped = listeners.get(listener);
      if (type !== "error" || !wrapped) return;
      listeners.delete(listener);
      worker.off("error", wrapped);
    },
  };
}

/** `spawnWorkerLike`가 돌려주는 값. DOM `Worker`가 필요한 자리(`createWorker`)에는 소비자가 `as unknown as Worker`로 넘긴다. */
export interface WorkerLike {
  /** 스레드에 메시지를 보낸다. `transfer`에 든 MessagePort 등은 소유권이 넘어간다. */
  postMessage(message: unknown, transfer?: readonly unknown[]): void;

  /** 스레드 종료를 요청한다. 끝나기를 기다리지 않는다. */
  terminate(): void;

  /** `error` 이벤트 리스너를 등록한다. 스레드 오류의 `message`를 넘긴다. 다른 `type`은 무시한다. */
  addEventListener(
    type: string,
    listener: (event: { message: string }) => void,
  ): void;

  /** `addEventListener`로 등록한 `error` 리스너를 뗀다. 등록하지 않은 리스너는 무시한다. */
  removeEventListener(
    type: string,
    listener: (event: { message: string }) => void,
  ): void;
}
