/**
 * worker 부팅 시험용 main 쪽 하니스(RD-040). `createMainSide` 사본 5벌(core `worker/boot-compat.test.ts`·
 * `worker/boot-plugins.test.ts`, dom-bridge `boot-worker.test.ts`, repl `worker/boot.test.ts`·
 * `worker/repl-driver-source-runner.test.ts`)을 이 파일 하나로 합쳤다. 알림 기본 목록은 `CORE_MAIN_HANDLER_NAMES`
 * (`session/core-session.ts`)다 — core가 새 알림을 더하면 그쪽 `satisfies`가 갱신을 강제하고 이 하니스도 따라간다.
 * 시험 프레임워크 의존(`onTestFinished`로 포트 정리)을 이 파일에 모은다.
 */
import { onTestFinished } from "vitest";
import type { InitFrame } from "../src/protocol/init-frame";
import { createInterruptBuffer } from "../src/protocol/interrupt-protocol";
import { createRpc } from "../src/protocol/rpc";
import type { Rpc } from "../src/protocol/rpc";
import {
  createMailboxWriter,
  createStdinMailbox,
} from "../src/protocol/stdin-mailbox";
import type { MailboxWriter } from "../src/protocol/stdin-mailbox";
import { CORE_MAIN_HANDLER_NAMES } from "../src/session/core-session";

/** worker 쪽에 보낼 초기화 프레임. `rpcPort`만 필수이고 나머지는 기본값이 채운다. */
export function createInitFrame(
  overrides: Partial<InitFrame> & { rpcPort: MessagePort },
): InitFrame {
  const mailbox = createStdinMailbox();
  return {
    kind: "init",
    interruptBuffer: createInterruptBuffer(),
    stdinCtrl: mailbox.ctrl,
    stdinData: mailbox.data,
    driver: {},
    pyodide: { indexURL: "unused-in-node/" },
    ...overrides,
  };
}

export interface CreateMainSideOptions {
  /** 기본 프레임(위 `createInitFrame` 기본값)에 얹을 덮어쓰기. `rpcPort`·`stdinCtrl`·`stdinData`는 내부에서 정한다. */
  frame?: Omit<Partial<InitFrame>, "rpcPort" | "stdinCtrl" | "stdinData">;
  /** `CORE_MAIN_HANDLER_NAMES` 외에 기록할 알림 이름(예: repl driver의 `writeOutput`·`writeError`). */
  extraNotifications?: readonly string[];
  /** 요청(RPC `call`) 핸들러. 호출도 `events`에 기록된 뒤 핸들러가 반환값을 정한다. */
  requests?: Record<string, (...args: unknown[]) => unknown>;
}

export interface MainSide {
  frame: InitFrame;
  /** 알림·요청이 도착한 순서대로 쌓인 `[이름, ...인자]` 기록. */
  events: unknown[][];
  rpc: Rpc;
  writer: MailboxWriter;
  /** 20ms 간격으로 최대 5초 기다린다. */
  waitFor(predicate: () => boolean): Promise<void>;
  /** `ready`·`loadFailed` 중 먼저 온 알림을 기다려 돌려준다(20ms 간격·5초 상한). */
  waitForOutcome(): Promise<unknown[]>;
}

const POLL_INTERVAL_MS = 20;
const POLL_TIMEOUT_MS = 5000;

async function waitFor(
  events: unknown[][],
  predicate: () => boolean,
): Promise<void> {
  for (let waited = 0; waited < POLL_TIMEOUT_MS; waited += POLL_INTERVAL_MS) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `기다리던 상태가 오지 않았다(events: ${JSON.stringify(events)})`,
  );
}

/**
 * worker 역할이 받을 초기화 프레임과, main 역할이 받은 알림·요청 기록(도착 순서). 포트 정리를 현재 시험의
 * `onTestFinished`에 걸므로 시험 본문에서 부른다.
 */
export function createMainSide(options: CreateMainSideOptions = {}): MainSide {
  const channel = new MessageChannel();
  const mailbox = createStdinMailbox();
  const writer = createMailboxWriter(mailbox);
  const frame = createInitFrame({
    rpcPort: channel.port1,
    stdinCtrl: mailbox.ctrl,
    stdinData: mailbox.data,
    ...options.frame,
  });
  const events: unknown[][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      events.push([name, ...args]);
    };
  const notificationNames = [
    ...CORE_MAIN_HANDLER_NAMES,
    ...(options.extraNotifications ?? []),
  ];
  const requestHandlers = Object.fromEntries(
    Object.entries(options.requests ?? {}).map(([name, handler]) => [
      name,
      (...args: unknown[]) => {
        events.push([name, ...args]);
        return handler(...args);
      },
    ]),
  );
  const rpc = createRpc(channel.port2, {
    ...Object.fromEntries(
      notificationNames.map((name) => [name, record(name)]),
    ),
    ...requestHandlers,
  });
  onTestFinished(() => {
    rpc.dispose();
    channel.port1.close();
    channel.port2.close();
  });
  return {
    frame,
    events,
    rpc,
    writer,
    waitFor: (predicate) => waitFor(events, predicate),
    waitForOutcome: async () => {
      await waitFor(events, () =>
        events.some(
          (event) => event[0] === "ready" || event[0] === "loadFailed",
        ),
      );
      return events.find(
        (event) => event[0] === "ready" || event[0] === "loadFailed",
      )!;
    },
  };
}
