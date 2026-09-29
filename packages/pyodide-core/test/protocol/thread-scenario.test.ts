// @vitest-environment node
/**
 * 프로토콜 코어 통합 시나리오(RD-002).
 * - main 역할(시험 본문)과 worker 역할(`test/roles/repl-worker.ts`)이 실제 worker 스레드로 나뉜다.
 * - 두 역할이 초기화 프레임·RPC·stdin 메일박스·interrupt buffer를 함께 쓴다.
 * - pyodide는 쓰지 않는다.
 */
import { describe, expect, it, onTestFinished } from "vitest";
import { postInitFrame } from "../../src/protocol/init-frame";
import type { InitFrame } from "../../src/protocol/init-frame";
import {
  ACK,
  SEQ,
  SIGNAL,
  signalInterrupt,
} from "../../src/protocol/interrupt-protocol";
import { createRpc } from "../../src/protocol/rpc";
import {
  createMailboxWriter,
  createStdinMailbox,
} from "../../src/protocol/stdin-mailbox";
import { spawnRole } from "@repo/pyodide-testkit/thread";
import { createInitFrame } from "../boot-harness";

/** worker 역할이 `received` 알림으로 보고하는 관찰 결과 */
interface Received {
  /** `readLine` 응답으로 받은 줄 */
  line: string;

  /** `wait()`가 돌려준 값. 줄이 아니면 null */
  text: string | null;

  /** `wait()` 직후 interrupt buffer의 SIGINT 슬롯 값 */
  signal: number;

  /** `wait()` 직후 interrupt buffer의 요청 번호 슬롯 값 */
  seq: number;
}

/** 시나리오 변형 옵션 */
interface ScenarioOptions {
  /**
   * `complete`를 보내는 시점을 `readLine` 응답 전에서 `readInput` 알림 뒤로 옮긴다.
   * 그 시점 worker는 `wait()`에서 정지해 있다. 요청은 worker 이벤트 루프가 풀릴 때까지 포트에 큐잉된다.
   */
  completeAfterReadInput?: boolean;
}

/** `ms` 뒤에 끝나는 Promise */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * main 역할로 시나리오를 끝까지 돌리고 관찰한 것을 돌려준다.
 * worker 역할은 실제 worker 스레드로 띄운다. 알림은 도착 순서대로 `log`에 쌓인다.
 */
async function runScenario(options: ScenarioOptions = {}) {
  const channel = new MessageChannel();
  const mailbox = createStdinMailbox();
  const frame: InitFrame = createInitFrame({
    rpcPort: channel.port1,
    stdinCtrl: mailbox.ctrl,
    stdinData: mailbox.data,
  });
  const writer = createMailboxWriter(mailbox);
  const log: string[] = [];
  let completeResult: unknown;
  // `deliver` 전에 `complete` 응답이 왔는가(`completeAfterReadInput`일 때만 정해진다).
  let completeAnsweredBeforeDeliver: boolean | undefined;
  let resolveReceived: (received: Received) => void = () => {};
  const receivedPromise = new Promise<Received>(
    (resolve) => (resolveReceived = resolve),
  );
  let resolveInputHandled: () => void = () => {};
  const inputHandled = new Promise<void>(
    (resolve) => (resolveInputHandled = resolve),
  );

  const rpc = createRpc(channel.port2, {
    readLine: async (prompt: string) => {
      log.push(`readLine:${prompt}`);
      if (!options.completeAfterReadInput) {
        // worker는 이 응답을 기다리는 동안 이벤트 루프가 살아 있어 main의 요청에 답한다.
        completeResult = await rpc.call("complete", "os.pa", undefined);
      }
      return 'x = input("x: ")';
    },
    write: (text: string) => void log.push(`write:${text}`),
    readInput: async () => {
      log.push("readInput");
      try {
        // 이 시점 worker는 wait()에서 정지해 있다.
        const pendingComplete = options.completeAfterReadInput
          ? rpc.call("complete", "os.pa", undefined)
          : undefined;
        if (pendingComplete) {
          // 정지한 worker는 요청을 처리하지 못한다. 응답이 오지 않는 것을 100ms 동안 지켜본다.
          let answered = false;
          void pendingComplete.then(
            () => (answered = true),
            () => (answered = true),
          );
          await sleep(100);
          completeAnsweredBeforeDeliver = answered;
        }
        // SIGINT를 먼저 쓴 뒤 deliver로 worker를 깨운다.
        signalInterrupt(frame.interruptBuffer);
        await writer.deliver("abc");
        // 깨어난 worker가 이벤트 루프로 돌아오면 큐에 있던 요청을 처리한다.
        if (pendingComplete) completeResult = await pendingComplete;
      } finally {
        resolveInputHandled();
      }
    },
    received: (received: Received) => resolveReceived(received),
  });
  onTestFinished(() => rpc.dispose());

  const role = spawnRole(new URL("../roles/repl-worker.ts", import.meta.url));
  postInitFrame(
    { postMessage: (message, transfer) => role.post(message, transfer) },
    frame,
  );
  const received = await receivedPromise;
  await inputHandled;
  return {
    log,
    completeResult,
    completeAnsweredBeforeDeliver,
    received,
    interruptBuffer: frame.interruptBuffer,
  };
}

describe("초기화 프레임 → readLine → complete → readInput → wait/deliver", () => {
  it("worker의 wait()가 main이 deliver한 값을 받는다", async () => {
    const { received } = await runScenario();

    expect(received.line).toBe('x = input("x: ")');
    expect(received.text).toBe("abc");
  });

  it("readLine 응답을 기다리는 동안 worker가 main의 complete 요청에 답한다", async () => {
    const { completeResult } = await runScenario();

    expect(completeResult).toEqual({ completions: ["path"], start: 3 });
  });

  // 같은 포트를 타는 메시지는 FIFO다.
  // 출력 알림(`write`)이 `readInput` 알림보다 먼저 main에 닿는 규칙(01-protocols.md 1.3).
  it("main은 readLine, 출력, readInput 알림을 worker가 보낸 순서대로 받는다", async () => {
    const { log } = await runScenario();

    expect(log).toEqual(["readLine:>>> ", "write:x: ", "readInput"]);
  });

  it("초기화 프레임으로 넘긴 interrupt buffer를 양쪽이 같은 메모리로 본다", async () => {
    const { received, interruptBuffer } = await runScenario();

    // worker가 wait()에서 깨어난 뒤 main이 deliver 전에 쓴 SIGINT와 요청 번호가 보였다.
    expect(received.signal).toBe(2);
    expect(received.seq).toBe(1);
    // worker가 폐기하며 올린 ack와 비운 SIGINT가 main 쪽 뷰에 보인다.
    expect(Atomics.load(interruptBuffer, ACK)).toBe(1);
    expect(Atomics.load(interruptBuffer, SIGNAL)).toBe(0);
    expect(Atomics.load(interruptBuffer, SEQ)).toBe(1);
  });

  // 01-protocols.md 1.3: worker가 메일박스 대기 중이면 포트에 도착한 요청은 깨어난 뒤 처리된다.
  // 정지한 worker에 보낸 요청은 유실되지 않는다. 큐에 남았다가 `deliver` 뒤에 응답한다.
  // main이 `input()` 읽기 중 요청을 보내도 교착·유실이 없다.
  it("worker가 wait()에서 정지한 동안 보낸 complete 요청은 deliver 전에는 응답이 없고 deliver 뒤 유실 없이 응답한다", async () => {
    const { completeAnsweredBeforeDeliver, completeResult, received } =
      await runScenario({ completeAfterReadInput: true });

    expect(completeAnsweredBeforeDeliver).toBe(false);
    expect(received.text).toBe("abc");
    expect(completeResult).toEqual({ completions: ["path"], start: 3 });
  });
});
