/**
 * 초기화 프레임(01-protocols.md 4절). worker 생성 직후 main이 보내는 단 하나의 네이티브 메시지다. RPC 포트·버퍼·설정을
 * 담고, 이후 네이티브 `message` 채널은 쓰지 않는다. 설정을 바꾸려면 새 프레임 = 새 worker다.
 */
export interface InitFrame {
  kind: "init";
  /** 전송(transfer)된다. */
  rpcPort: MessagePort;
  /** SharedArrayBuffer 뷰. 구조적 복제로 같은 메모리를 가리킨다. */
  interruptBuffer: Int32Array;
  /** stdin 메일박스 제어. */
  stdinCtrl: Int32Array;
  /** stdin 메일박스 데이터. */
  stdinData: Uint8Array;
  /**
   * driver 전용 옵션. core는 값의 모양을 모른다(`unknown`) — 필드가 있는지만 본다. 검증은 worker 쪽 driver 파서
   * (`WorkerDriver.parseOptions`)가 한다. 예: REPL은 `{ topLevelAwait: boolean }`.
   */
  driver: unknown;
  pyodide: { indexURL: string };
}

function invalidField(field: string, expected: string): never {
  throw new Error(`초기화 프레임 필드 오류 — ${field}: ${expected} 필요`);
}

/** SharedArrayBuffer 위의 `constructor` 뷰인지. 비공유 뷰는 구조적 복제에서 복사돼 메모리 공유가 조용히 끊긴다. */
function isSharedView(
  value: unknown,
  constructor: typeof Int32Array | typeof Uint8Array,
): boolean {
  return (
    value instanceof constructor && value.buffer instanceof SharedArrayBuffer
  );
}

/**
 * worker가 받은 배열이 아닌 메시지를 init 프레임으로 검증한다(배열은 수신기가 먼저 거른다, `worker/init-receiver.ts`). 잘못됐으면
 * 어느 필드가 왜 틀렸는지 담은 오류를 던진다.
 */
export function parseInitFrame(data: unknown): InitFrame {
  if (typeof data !== "object" || data === null) {
    throw new Error("첫 메시지가 init 프레임이 아니다: 객체가 아님");
  }
  const frame = data as Partial<Record<keyof InitFrame, unknown>>;
  if (frame.kind !== "init") {
    throw new Error(
      `첫 메시지가 init 프레임이 아니다: kind가 ${JSON.stringify(frame.kind)}`,
    );
  }
  if (
    typeof (frame.rpcPort as { postMessage?: unknown } | undefined)
      ?.postMessage !== "function"
  ) {
    invalidField("rpcPort", "MessagePort");
  }
  if (!isSharedView(frame.interruptBuffer, Int32Array))
    invalidField("interruptBuffer", "SharedArrayBuffer 위의 Int32Array");
  if (!isSharedView(frame.stdinCtrl, Int32Array))
    invalidField("stdinCtrl", "SharedArrayBuffer 위의 Int32Array");
  if (!isSharedView(frame.stdinData, Uint8Array))
    invalidField("stdinData", "SharedArrayBuffer 위의 Uint8Array");
  // 값은 검증하지 않는다(driver 파서 몫). 필드 자체는 필요하다: 설정이 최상위에 있던 옛 모양의 프레임을 worker가
  // 조용히 받아들여 driver 설정을 잃는 일을 막는다.
  if (!("driver" in frame)) invalidField("driver", "필드(값은 driver가 검증)");
  if (
    typeof (frame.pyodide as { indexURL?: unknown } | undefined)?.indexURL !==
    "string"
  ) {
    invalidField("pyodide.indexURL", "문자열");
  }
  return data as InitFrame;
}

/** `Worker`·`MessagePort`가 갖는 `postMessage` 시그니처. */
export interface InitFrameTarget {
  postMessage(message: unknown, transfer: Transferable[]): void;
}

/**
 * main이 worker 생성 직후 보내는 core의 첫 메시지다. worker가 받는 첫 메시지라는 보장은 아니다: dom-bridge의 `Worker` 래퍼
 * 생성자는 부트스트랩 배열을 먼저 보낸다(01-protocols.md 4절). `rpcPort`는 복제할 수 없으므로 전송 목록에 담는다.
 */
export function postInitFrame(target: InitFrameTarget, frame: InitFrame): void {
  target.postMessage(frame, [frame.rpcPort]);
}
