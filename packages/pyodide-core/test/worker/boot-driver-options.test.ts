// @vitest-environment node
/**
 * `bootWorker`가 초기화 프레임의 `driver` 필드를 driver 파서(`parseOptions`)로 검증하는 지점을 본다.
 * - core는 `driver` 값의 모양을 모른다(`parseInitFrame`은 필드 존재만 본다).
 * - 검증은 driver 몫이다.
 * - 잘못된 옵션이면 세션·RPC·pyodide 로드 어느 것도 시작하지 않는다.
 *
 * pyodide 로드 이후 시퀀스는 core `worker/boot.test.ts`와 repl `worker/boot.test.ts`가 본다.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { InitFrame } from "../../src/protocol/init-frame";
import { createInitFrame } from "../boot-harness";
import { bootWorker } from "../../src/worker/boot";
import type {
  WorkerDriver,
  WorkerDriverSession,
} from "../../src/worker/driver";

const ports: MessagePort[] = [];

afterEach(() => {
  for (const port of ports.splice(0)) port.close();
});

/** `driver` 필드에 `driver` 값을 넣은 초기화 프레임을 만든다. 포트는 `afterEach`가 닫는다. */
function createFrame(driver: unknown): InitFrame {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  return createInitFrame({ rpcPort: port1, driver });
}

/** 시험용 세션. 콘솔 생성까지 가면 던진다. */
const session: WorkerDriverSession = {
  handlers: {},
  createConsole: () => {
    throw new Error("이 시험은 콘솔 생성까지 가지 않는다");
  },
  run: async () => {},
  atPrompt: () => false,
};

describe("bootWorker: driver 옵션 검증", () => {
  test("프레임의 driver 필드를 parseOptions에 넘기고 반환값으로 세션을 만든다", async () => {
    const parsed = { parsed: true };
    const parseOptions = vi.fn<(raw: unknown) => typeof parsed>(() => parsed);
    const createSession = vi.fn<
      (options: typeof parsed) => WorkerDriverSession
    >(() => session);
    const driver: WorkerDriver<typeof parsed> = { parseOptions, createSession };
    const raw = { topLevelAwait: true };
    // 로드 실패로 시퀀스를 바로 끝낸다(loadFailed 알림 뒤 반환).
    const loadPyodide = vi.fn(async () => {
      throw new Error("로드 중단");
    });

    await bootWorker(createFrame(raw), { driver, loadPyodide });

    expect(parseOptions).toHaveBeenCalledTimes(1);
    expect(parseOptions.mock.calls[0]?.[0]).toBe(raw);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]?.[0]).toBe(parsed);
    expect(loadPyodide).toHaveBeenCalledTimes(1);
  });

  test("parseOptions가 던지면 부팅이 그 오류로 거부되고 세션 생성·pyodide 로드를 시작하지 않는다", async () => {
    const createSession = vi.fn(() => session);
    const driver: WorkerDriver = {
      parseOptions: () => {
        throw new Error("옵션 오류 — topLevelAwait: boolean 필요");
      },
      createSession,
    };
    const loadPyodide = vi.fn(async () => {
      throw new Error("호출되면 안 된다");
    });

    await expect(
      bootWorker(createFrame({ topLevelAwait: "yes" }), {
        driver,
        loadPyodide,
      }),
    ).rejects.toThrow(/topLevelAwait/);

    expect(createSession).not.toHaveBeenCalled();
    expect(loadPyodide).not.toHaveBeenCalled();
  });
});
