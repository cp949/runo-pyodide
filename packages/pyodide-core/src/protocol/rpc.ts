/**
 * MessagePort 위 요청/응답/알림(01-protocols.md 1절).
 * - 요청을 기다리는 동안 양쪽 이벤트 루프가 살아 있다. 상대의 요청을 받을 수 있다.
 * - 값은 구조적 복제로 그대로 간다. `null`도 `null`로 도착한다.
 *
 * 이 인터페이스는 RPC가 쓰는 포트의 최소 모양이다(`MessagePort`가 만족한다).
 */
export interface RpcPort {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  close?(): void;
}

/** 메서드 이름 → 핸들러 표. 이름은 own 속성만 찾는다. */
export type RpcHandlers = Record<string, (...args: never[]) => unknown>;

/** RPC 끝점. 요청(`call`)과 알림(`notify`)을 보내고, 종료(`dispose`)한다. */
export interface Rpc {
  /** 상대 핸들러를 부르고 결과를 기다린다. */
  call<T = unknown>(name: string, ...args: unknown[]): Promise<T>;
  /** 응답 없이 상대 핸들러를 부른다. 없는 이름은 상대가 버린다. */
  notify(name: string, ...args: unknown[]): void;
  /** 대기 중인 요청을 모두 reject하고 포트를 닫는다. */
  dispose(): void;
}

/** 포트로 오가는 메시지. `req`는 요청, `res`는 응답, `ntf`는 응답 없는 알림이다. */
type RpcMessage =
  | { kind: "req"; id: number; name: string; args: unknown[] }
  | { kind: "res"; id: number; ok: true; result: unknown }
  | { kind: "res"; id: number; ok: false; error: string }
  | { kind: "ntf"; name: string; args: unknown[] };

/** 핸들러를 메시지 이벤트 안에서 바로 호출한다. 동기 예외도 rejected Promise로 바꿔 한 갈래로 다룬다. */
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

/**
 * `port` 위에 RPC 끝점을 만든다. `handlers`는 상대가 부를 수 있는 이름 표다.
 * `port.onmessage`를 점유한다. 핸들러는 생성 시점에 한 번만 받는다.
 */
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
      // 대기 중이 아닌 id의 응답은 무시한다.
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error));
      return;
    }
    // 핸들러 표는 own 속성만 본다. `toString` 같은 Object.prototype 이름을 상대가 실행하게 두지 않는다.
    // `Object.hasOwn`(Chrome 93+)은 빌드 floor Chrome 84를 넘는다(ADR-0008). 같은 뜻의 호출로 대체한다.
    if (!Object.prototype.hasOwnProperty.call(handlers, message.name)) {
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
      // 알림에는 응답 통로가 없다. 예외는 unhandled rejection이 되지 않게 `console.error`로 남긴다.
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
      // 닫힌 포트에 보낸 요청은 응답이 오지 않는다. 보내지 않고 바로 reject한다.
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
