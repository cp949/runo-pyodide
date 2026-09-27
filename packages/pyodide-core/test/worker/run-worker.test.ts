/**
 * worker 진입점 `runWorker({ driver })` 시험.
 * main이 worker 생성 직후 보내는 core의 첫 메시지(초기화 프레임)를 검증해 부팅 시퀀스(`bootWorker`)를 시작하는지 확인한다.
 * 부팅 시퀀스 자체(pyodide 로드·ready·배너)는 core `worker/boot.test.ts`와 repl `worker/boot.test.ts`가 보므로 여기서는
 * mock으로 막는다.
 * 프레임을 놓치지 않도록 리스너는 core `./worker` 모듈 평가 시점에 걸린다(import 순서 조건을 지키면 `runWorker` 호출 시점은 자유다, 01-protocols.md 4절).
 * 리스너는 init 프레임만 소비한다: 배열 메시지나 kind가 다른 객체가 먼저 와도 뒤의 init을 받는다(RD-020 Q11).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createInitFrame as createBaseInitFrame } from "../boot-harness";
import { bootWorker } from "../../src/worker/boot";
import type { WorkerDriver } from "../../src/worker/driver";
import { runWorker } from "../../src/worker/run-worker";

vi.mock("../../src/worker/boot", () => ({ bootWorker: vi.fn(async () => {}) }));

/** 부팅이 mock이라 쓰이지 않는 driver. `runWorker`가 그대로 부팅에 넘기는지만 본다. */
const driver: WorkerDriver = {
  parseOptions: () => undefined,
  createSession() {
    throw new Error("부팅 mock이라 세션을 만들지 않는다");
  },
};

const runReplWorker = () => runWorker({ driver });

/** worker 전역(jsdom에서는 window)에 main이 보낸 것과 같은 message 이벤트를 던진다. */
function receive(data: unknown) {
  self.dispatchEvent(new MessageEvent("message", { data }));
}

/** main이 보내는 것과 같은 모양의 올바른 초기화 프레임. */
function createInitFrame() {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  // 스프레드로 감싸 object literal 타입(암묵적 index signature)을 유지한다 —
  // 아래에서 `Record<string, unknown>`로 받아 필드를 지우는 시험이 있다.
  return { ...createBaseInitFrame({ rpcPort: port1 }) };
}

const ports: MessagePort[] = [];
/** 시험 중 `runWorker`가 건 message 리스너. init을 받지 못한 시험의 리스너가 다음 시험으로 새지 않게 치운다. */
const registered: EventListenerOrEventListenerObject[] = [];

beforeEach(() => {
  vi.mocked(bootWorker).mockClear();
  const add = self.addEventListener.bind(self) as typeof self.addEventListener;
  vi.spyOn(self, "addEventListener").mockImplementation(
    (type: string, listener: unknown, options?: unknown) => {
      if (type === "message")
        registered.push(listener as EventListenerOrEventListenerObject);
      add(type, listener as EventListener, options as AddEventListenerOptions);
    },
  );
});

afterEach(() => {
  for (const listener of registered.splice(0))
    self.removeEventListener("message", listener);
  vi.restoreAllMocks();
  for (const port of ports.splice(0)) port.close();
});

test("올바른 프레임이면 console.error 없이 부팅을 시작한다", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  runReplWorker();
  const initFrame = createInitFrame();

  receive(initFrame);

  expect(error).not.toHaveBeenCalled();
  expect(bootWorker).toHaveBeenCalledTimes(1);
  // toContain·toEqual은 MessagePort의 순환 내부 참조를 따라가다 스택이 넘친다. 같은 객체인지만 본다.
  const [frame, deps] = vi.mocked(bootWorker).mock.calls[0] ?? [];
  expect(frame === initFrame).toBe(true);
  expect(typeof deps?.loadPyodide).toBe("function");
});

test("첫 메시지의 kind가 init이 아니면 console.error로 알리고 부팅하지 않는다", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  runReplWorker();

  receive({ kind: "other" });

  expect(error).toHaveBeenCalledTimes(1);
  expect(bootWorker).not.toHaveBeenCalled();
});

test("첫 메시지만 처리하고 이후 네이티브 message는 무시한다", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  runReplWorker();
  const initFrame = createInitFrame();

  receive(initFrame);
  receive(initFrame);
  receive({ kind: "other" });

  expect(bootWorker).toHaveBeenCalledTimes(1);
  expect(error).not.toHaveBeenCalled();
});

// kind만 보고 통과시키면 필드가 빠진 프레임이 뒤 단계(pyodide 로드, 메일박스 대기)에서 원인을 알 수 없는 오류로 터진다.
test("kind는 init이지만 필드가 빠진 프레임은 필드 이름을 담아 console.error로 알리고 부팅하지 않는다", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  runReplWorker();
  const frame: Record<string, unknown> = createInitFrame();
  delete frame.interruptBuffer;

  receive(frame);

  expect(bootWorker).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledTimes(1);
  expect(String(error.mock.calls[0])).toContain("interruptBuffer");
});

// 동기 브리지(coincident) 같은 다른 프로토콜의 메시지가 init보다 먼저 올 수 있다(RD-020 스파이크 S1).
test("배열 메시지가 먼저 와도 뒤에 오는 init 프레임을 받아 부팅한다", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  runReplWorker();
  const initFrame = createInitFrame();

  receive(["bridge", 1, 2]);
  receive(initFrame);

  expect(error).not.toHaveBeenCalled();
  expect(bootWorker).toHaveBeenCalledTimes(1);
  const [frame] = vi.mocked(bootWorker).mock.calls[0] ?? [];
  expect(frame === initFrame).toBe(true);
});

test("kind가 init이 아닌 객체는 리스너를 소비하지 않아 뒤에 오는 init 프레임을 받는다", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  runReplWorker();
  const initFrame = createInitFrame();

  receive({ kind: "other" });
  receive(initFrame);

  expect(bootWorker).toHaveBeenCalledTimes(1);
  const [frame] = vi.mocked(bootWorker).mock.calls[0] ?? [];
  expect(frame === initFrame).toBe(true);
});
