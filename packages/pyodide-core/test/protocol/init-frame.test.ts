// @vitest-environment node
/**
 * 초기화 프레임 시험(01-protocols.md 4절).
 * - 대상: main이 worker 생성 직후 보내는 단 하나의 네이티브 메시지.
 * - `parseInitFrame`: 필드 존재와 타입을 검증한다.
 * - `postInitFrame`: 포트를 전송하고 버퍼를 같은 메모리로 공유한다.
 */
import { describe, expect, it, onTestFinished } from "vitest";
import { parseInitFrame, postInitFrame } from "../../src/protocol/init-frame";
import type { InitFrame } from "../../src/protocol/init-frame";
import { createInterruptBuffer } from "../../src/protocol/interrupt-protocol";
import { createStdinMailbox } from "../../src/protocol/stdin-mailbox";
import { DEFAULT_PYODIDE_INDEX_URL } from "../../src/pyodide-version";

/** 모든 필드가 올바른 `InitFrame`을 만든다. 시험이 끝나면 포트를 닫는다. */
function createFrame(): InitFrame {
  const { port1, port2 } = new MessageChannel();
  onTestFinished(() => {
    port1.close();
    port2.close();
  });
  const mailbox = createStdinMailbox();
  return {
    kind: "init",
    rpcPort: port1,
    interruptBuffer: createInterruptBuffer(),
    stdinCtrl: mailbox.ctrl,
    stdinData: mailbox.data,
    driver: {},
    pyodide: { indexURL: DEFAULT_PYODIDE_INDEX_URL },
  };
}

describe("parseInitFrame", () => {
  it("올바른 프레임은 같은 값을 그대로 돌려준다", () => {
    const frame = createFrame();

    expect(parseInitFrame(frame)).toBe(frame);
  });

  it.each([null, undefined, "init", 42])("객체가 아니면 던진다: %j", (data) => {
    expect(() => parseInitFrame(data)).toThrow(/init 프레임/);
  });

  it("kind가 init이 아니면 kind를 담은 오류를 던진다", () => {
    expect(() => parseInitFrame({ ...createFrame(), kind: "other" })).toThrow(
      /kind/,
    );
  });

  it.each([
    "rpcPort",
    "interruptBuffer",
    "stdinCtrl",
    "stdinData",
    "driver",
    "pyodide",
  ] as const)(
    "필드가 빠지면 그 필드 이름을 담은 오류를 던진다: %s",
    (field) => {
      const frame: Partial<InitFrame> = createFrame();
      delete frame[field];

      expect(() => parseInitFrame(frame)).toThrow(new RegExp(field));
    },
  );

  // driver 설정은 driver 파서가 검증한다(repl `worker/repl-driver.test.ts`).
  // core는 필드가 있는지만 본다.
  // 옛 모양(설정이 최상위에 있고 driver 필드가 없는 프레임)을 worker가 받아들이면 driver 설정을 잃는다.
  // 이 일을 막는다.
  it.each([
    { label: "객체", driver: { topLevelAwait: true } },
    { label: "null", driver: null },
    { label: "undefined 값(키는 있음)", driver: undefined },
    { label: "문자열", driver: "opts" },
  ])(
    "driver 필드의 값은 검증하지 않고 그대로 통과시킨다: $label",
    ({ driver }) => {
      const frame = { ...createFrame(), driver };

      expect(parseInitFrame(frame)).toBe(frame);
    },
  );

  it("옛 모양(최상위 topLevelAwait, driver 필드 없음)은 driver 필드 오류로 거부한다", () => {
    const frame: Partial<InitFrame> = createFrame();
    delete frame.driver;

    expect(() => parseInitFrame({ ...frame, topLevelAwait: false })).toThrow(
      /driver/,
    );
  });

  // 비공유 뷰는 postMessage의 구조적 복제에서 메모리가 복사된다.
  // main과 worker가 서로 다른 메모리를 본다.
  // 오류 없이 통신만 조용히 끊긴다(Ctrl+C가 영영 안 먹는다). 프레임 검증에서 막아야 한다.
  it.each([
    { field: "interruptBuffer", value: () => new Int32Array(4) },
    { field: "stdinCtrl", value: () => new Int32Array(4) },
    { field: "stdinData", value: () => new Uint8Array(16) },
  ])(
    "SharedArrayBuffer 위의 뷰가 아니면 던진다: $field",
    ({ field, value }) => {
      expect(() =>
        parseInitFrame({ ...createFrame(), [field]: value() }),
      ).toThrow(new RegExp(`${field}.*SharedArrayBuffer`));
    },
  );

  it.each([
    { label: "pyodide에 indexURL이 없음", pyodide: {} },
    { label: "indexURL이 문자열이 아님", pyodide: { indexURL: 42 } },
  ])("pyodide.indexURL이 문자열이 아니면 던진다: $label", ({ pyodide }) => {
    expect(() => parseInitFrame({ ...createFrame(), pyodide })).toThrow(
      /indexURL/,
    );
  });
});

// 실제 MessageChannel 포트를 전송 대상으로 쓴다(`Worker.postMessage`와 같은 시그니처).
// 전송 목록이 빠지면 rpcPort를 복제할 수 없어 DataCloneError가 난다.
describe("postInitFrame", () => {
  it("rpcPort는 전송돼 살아 있는 포트로 도착하고, 버퍼는 같은 메모리를 공유한다", async () => {
    const carrier = new MessageChannel();
    const rpcChannel = new MessageChannel();
    onTestFinished(() => {
      carrier.port1.close();
      carrier.port2.close();
      rpcChannel.port2.close();
    });
    const frame = { ...createFrame(), rpcPort: rpcChannel.port1 };
    const arrived = new Promise<unknown>((resolve) => {
      carrier.port2.onmessage = (event) => resolve(event.data);
    });

    postInitFrame(carrier.port1, frame);
    const received = parseInitFrame(await arrived);

    // 전송된 포트는 원래 짝(rpcChannel.port2)과 이어져 있다.
    const pong = new Promise<unknown>((resolve) => {
      rpcChannel.port2.onmessage = (event) => resolve(event.data);
    });
    received.rpcPort.postMessage("ping");
    await expect(pong).resolves.toBe("ping");
    received.rpcPort.close();
    // main이 쓴 값이 worker가 받은 뷰에 보인다.
    Atomics.store(frame.interruptBuffer, 0, 2);
    expect(Atomics.load(received.interruptBuffer, 0)).toBe(2);
  });
});
