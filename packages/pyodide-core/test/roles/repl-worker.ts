/**
 * REPL worker 쪽 역할(시험 전용). pyodide 없이 프로토콜만으로 01-protocols.md 5절 시퀀스 S1·S3의 worker 쪽을 따라 한다:
 * 초기화 프레임 수신 → `readLine` 요청 → 출력 알림 → `readInput` 알림 → 메일박스 정지 → 값 수신.
 * 결과는 시험 전용 알림 `received`로 main 역할에 보고한다.
 */
import { parentPort } from "node:worker_threads";
import { parseInitFrame } from "../../src/protocol/init-frame";
import { discardPendingInterrupt } from "../../src/protocol/interrupt-protocol";
import { createRpc } from "../../src/protocol/rpc";
import { createMailboxReader } from "../../src/protocol/stdin-mailbox";

const port = parentPort;
if (!port) throw new Error("worker 스레드에서만 실행한다");

// 스크립트 최상단에서 첫 메시지를 받는다(첫 await 이전).
port.once("message", (data: unknown) => {
  const frame = parseInitFrame(data);
  const rpc = createRpc(frame.rpcPort, {
    // main의 Tab 완성 요청. worker 이벤트 루프가 살아 있는 동안(REPL 읽기 대기 중)에만 답할 수 있다.
    complete: (source: string) => ({
      completions: ["path"],
      start: source.length - 2,
    }),
  });
  const mailbox = createMailboxReader({
    ctrl: frame.stdinCtrl,
    data: frame.stdinData,
  });

  void (async () => {
    const line = await rpc.call<string>("readLine", ">>> ", undefined, true);
    // input("x: "): 출력이 먼저 포트에 오르고, readInput 알림이 wait() 직전에 오른다.
    rpc.notify("write", "x: ");
    rpc.notify("readInput", true);
    const result = mailbox.wait();
    const text = result.kind === "line" ? result.text : null;
    // wait() 뒤에는 main이 deliver 전에 쓴 SIGINT가 같은 메모리에서 보인다.
    const signal = Atomics.load(frame.interruptBuffer, 0);
    const seq = Atomics.load(frame.interruptBuffer, 2);
    discardPendingInterrupt(frame.interruptBuffer);
    rpc.notify("received", { line, text, signal, seq });
  })();
});
