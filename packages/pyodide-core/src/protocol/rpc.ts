/**
 * MessagePort 위 요청/응답/알림(01-protocols.md 1절). 요청을 기다리는 동안 양쪽 이벤트 루프가 살아 있어 상대의 요청을
 * 받을 수 있다. 값은 구조적 복제로 그대로 가므로 `null`도 `null`로 도착한다.
 */
export interface RpcPort {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  close?(): void;
}

export type RpcHandlers = Record<string, (...args: never[]) => unknown>;

export interface Rpc {
  /** 상대 핸들러를 부르고 결과를 기다린다. */
  call<T = unknown>(name: string, ...args: unknown[]): Promise<T>;
  /** 응답 없이 상대 핸들러를 부른다. 없는 이름은 상대가 버린다. */
  notify(name: string, ...args: unknown[]): void;
  /** 대기 중인 요청을 모두 reject하고 포트를 닫는다. */
  dispose(): void;
}

type RpcMessage =
  | { kind: "req"; id: number; name: string; args: unknown[] }
  | { kind: "res"; id: number; ok: true; result: unknown }
  | { kind: "res"; id: number; ok: false; error: string }
  | { kind: "ntf"; name: string; args: unknown[] };

/** 핸들러를 메시지가 도착한 자리에서 시작하고, 동기 예외도 rejection으로 통일한다. */
function start(
  handler: (...args: unknown[]) => unknown,
  args: unknown[],
): Promise<unknown> {
  try {
    return Promise.resolve(handler(...args));
  } catch (error) {
    return Promise.reject(error);
  }
}

export function createRpc(port: RpcPort, handlers: RpcHandlers = {}): Rpc {
  let nextId = 1;
  let disposed = false;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();

  port.onmessage = (event) => {
    const message = event.data as RpcMessage;
    if (message.kind === "res") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error));
      return;
    }
    // 핸들러 표는 own 속성만 본다. `toString` 같은 Object.prototype 이름을 상대가 실행하게 두지 않는다.
    if (!Object.hasOwn(handlers, message.name)) {
      if (message.kind === "req") {
        port.postMessage({
          kind: "res",
          id: message.id,
          ok: false,
          error: `unknown method ${message.name}`,
        } satisfies RpcMessage);
      }
      return;
    }
    const outcome = start(
      handlers[message.name] as (...args: unknown[]) => unknown,
      message.args,
    );
    if (message.kind === "ntf") {
      // 알림에는 응답 통로가 없다. 예외를 처리되지 않은 rejection으로 흘리지 않고 남긴다.
      outcome.catch((error: unknown) =>
        console.error("[rpc] 알림 핸들러 예외", message.name, error),
      );
      return;
    }
    void outcome.then(
      (result) =>
        port.postMessage({
          kind: "res",
          id: message.id,
          ok: true,
          result,
        } satisfies RpcMessage),
      (error: unknown) =>
        port.postMessage({
          kind: "res",
          id: message.id,
          ok: false,
          error: String(error),
        } satisfies RpcMessage),
    );
  };

  return {
    call<T>(name: string, ...args: unknown[]): Promise<T> {
      // 닫힌 포트에 보낸 요청은 응답이 오지 않으므로 보내지 않고 바로 reject한다.
      if (disposed) return Promise.reject(new Error("rpc disposed"));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        port.postMessage({ kind: "req", id, name, args } satisfies RpcMessage);
      });
    },
    notify(name: string, ...args: unknown[]): void {
      port.postMessage({ kind: "ntf", name, args } satisfies RpcMessage);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      port.onmessage = null;
      for (const entry of pending.values())
        entry.reject(new Error("rpc disposed"));
      pending.clear();
      port.close?.();
    },
  };
}
