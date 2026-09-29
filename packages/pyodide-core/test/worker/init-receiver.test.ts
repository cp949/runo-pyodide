/**
 * worker init 프레임 수신기(`createInitReceiver`) 시험.
 * 수신기는 모듈 평가 시점에 message 리스너를 걸어 init 프레임을 버퍼에 담는다.
 * `runWorker`를 늦게 불러도 프레임을 잃지 않는다(01-protocols.md 4절).
 *
 * 메시지 규칙은 `runWorker`가 직접 듣던 때와 같다.
 * - 배열은 무시한다.
 * - `kind`가 init이 아닌 객체는 오류를 남기고 계속 듣는다.
 * - init 후보를 받으면 리스너를 뗀 뒤 검증한다. 필드 오류는 프레임을 버린다.
 *
 * 가짜 `EventTarget`을 주입해 worker 전역 없이 본다.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { InitFrame } from "../../src/protocol/init-frame";
import { createInitFrame as createBaseInitFrame } from "../boot-harness";
import { createInitReceiver } from "../../src/worker/init-receiver";

const ports: MessagePort[] = [];

afterEach(() => {
  for (const port of ports.splice(0)) port.close();
  vi.restoreAllMocks();
});

/** main이 보내는 것과 같은 모양의 올바른 초기화 프레임을 만든다. 포트는 `afterEach`가 닫는다. */
function createInitFrame() {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  // 스프레드로 감싸 object literal 타입(암묵적 index signature)을 유지한다.
  // 아래에서 `Record<string, unknown>`로 받아 필드를 지우는 시험이 있다.
  return { ...createBaseInitFrame({ rpcPort: port1 }) };
}

/** message 리스너 등록 수를 셀 수 있는 가짜 worker 전역을 만든다. `receive`로 메시지를 흘려 보낸다. */
function createSource() {
  const target = new EventTarget();
  let listeners = 0;
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = (
    type: string,
    listener: never,
    options?: never,
  ) => {
    if (type === "message") listeners += 1;
    add(type, listener, options);
  };
  target.removeEventListener = (
    type: string,
    listener: never,
    options?: never,
  ) => {
    if (type === "message") listeners -= 1;
    remove(type, listener, options);
  };
  return {
    target,
    listenerCount: () => listeners,
    receive(data: unknown) {
      target.dispatchEvent(new MessageEvent("message", { data }));
    },
  };
}

/** `take`에 넘길 소비 함수를 만든다. 받은 프레임을 `frames`에 모은다. */
function collect() {
  const frames: InitFrame[] = [];
  return { frames, consume: (frame: InitFrame) => void frames.push(frame) };
}

describe("createInitReceiver: 버퍼링", () => {
  test("만들 때 message 리스너를 건다", () => {
    const source = createSource();

    createInitReceiver(source.target);

    expect(source.listenerCount()).toBe(1);
  });

  test("take보다 먼저 온 init 프레임은 버퍼에 두었다가 take 때 바로 넘긴다", () => {
    const source = createSource();
    const receiver = createInitReceiver(source.target);
    const initFrame = createInitFrame();
    const sink = collect();

    source.receive(initFrame);
    expect(sink.frames).toHaveLength(0);
    receiver.take(sink.consume);

    expect(sink.frames).toHaveLength(1);
    // MessagePort의 순환 참조 때문에 toEqual을 쓰지 않는다. 같은 객체인지만 본다.
    expect(sink.frames[0] === initFrame).toBe(true);
  });

  test("take 뒤에 온 init 프레임도 받는다", () => {
    const source = createSource();
    const receiver = createInitReceiver(source.target);
    const initFrame = createInitFrame();
    const sink = collect();

    receiver.take(sink.consume);
    expect(sink.frames).toHaveLength(0);
    source.receive(initFrame);

    expect(sink.frames).toHaveLength(1);
    expect(sink.frames[0] === initFrame).toBe(true);
  });

  test("init 프레임을 받으면 리스너를 떼고 이후 메시지는 무시한다", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const source = createSource();
    const receiver = createInitReceiver(source.target);
    const initFrame = createInitFrame();
    const sink = collect();
    receiver.take(sink.consume);

    source.receive(initFrame);
    source.receive(initFrame);
    source.receive({ kind: "other" });

    expect(source.listenerCount()).toBe(0);
    expect(sink.frames).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();
  });

  test("take는 한 번만 부를 수 있다(두 번째 호출은 오류)", () => {
    const source = createSource();
    const receiver = createInitReceiver(source.target);
    receiver.take(() => {});

    expect(() => receiver.take(() => {})).toThrow(/한 번/);
  });
});

describe("createInitReceiver: 메시지 규칙", () => {
  test("배열 메시지는 조용히 무시하고 리스너를 유지한다", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const source = createSource();
    const receiver = createInitReceiver(source.target);
    const initFrame = createInitFrame();
    const sink = collect();
    receiver.take(sink.consume);

    source.receive(["bridge", 1, 2]);
    expect(source.listenerCount()).toBe(1);
    source.receive(initFrame);

    expect(error).not.toHaveBeenCalled();
    expect(sink.frames).toHaveLength(1);
  });

  test("kind가 init이 아닌 객체는 console.error로 알리되 리스너를 유지해 뒤의 init을 받는다", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const source = createSource();
    const receiver = createInitReceiver(source.target);
    const initFrame = createInitFrame();
    const sink = collect();
    receiver.take(sink.consume);

    source.receive({ kind: "other" });
    expect(error).toHaveBeenCalledTimes(1);
    expect(source.listenerCount()).toBe(1);
    source.receive(initFrame);

    expect(sink.frames).toHaveLength(1);
  });

  test("필드가 빠진 init 프레임은 필드 이름을 담아 console.error로 알리고 버린다", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const source = createSource();
    const receiver = createInitReceiver(source.target);
    const frame: Record<string, unknown> = createInitFrame();
    delete frame.interruptBuffer;
    const sink = collect();
    receiver.take(sink.consume);

    source.receive(frame);

    expect(sink.frames).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0])).toContain("interruptBuffer");
    // init 후보를 받았으므로 리스너는 떨어진다(기존 동작).
    expect(source.listenerCount()).toBe(0);
  });

  test("버린 프레임 뒤에 take해도 아무것도 넘기지 않는다", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const source = createSource();
    const receiver = createInitReceiver(source.target);
    const frame: Record<string, unknown> = createInitFrame();
    delete frame.rpcPort;
    const sink = collect();

    source.receive(frame);
    receiver.take(sink.consume);

    expect(sink.frames).toHaveLength(0);
  });
});
