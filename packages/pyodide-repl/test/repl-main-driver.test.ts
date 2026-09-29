/**
 * `createReplMainDriver` 시험(RD-029). REPL 읽기 phase 규칙과 전이는 `docs/design/08-session.md` 8.1이다.
 *
 * 조립:
 * - worker·RPC·메일박스를 거치지 않는다.
 * - `driver.driver.handlers.readLine`·`isIdle`·`inputRequested`·`inputResumed`·`terminate`·`readInput`·`sourcePrompt`·`sendSource`를 직접 부른다.
 * - 실제 `createTerminalSurface` + `@repo/pyodide-testkit`의 `createFakeTerminal`·`VtScreen`으로 조립한다. terminal `test/surface-setup.ts`와 같은 관례다.
 * - 가짜는 `interruptSender`·`complete`·`source`(`SourceLink`)뿐이다.
 *
 * 시험 제목의 `[Pn]`은 규칙 ID다.
 * 대상은 `source-bridge.ts`를 흡수해 읽기 phase 하나로 합친 뒤의 `repl-main-driver.ts`다.
 * 관측 가능한 화면 바이트·응답·게이트 값을 검증한다. 내부 변수 이름은 보지 않는다.
 */
import type { InterruptSender } from "@cp949/runo-pyodide-core";
import { describe, expect, test, vi } from "vitest";
import { createFakeTerminal, drain } from "@repo/pyodide-testkit/fake-terminal";
import { VtScreen, attachVtScreen } from "@repo/pyodide-testkit/vt-screen";
import { tick } from "@repo/pyodide-testkit/async";
import { asVendorReadline } from "@cp949/runo-pyodide-terminal/test-utils";
import { createTerminalSurface } from "@cp949/runo-pyodide-terminal/internal";
import {
  createReplMainDriver,
  type ReplMainDriver,
} from "../src/repl-main-driver";
import type { ReadLineOutcome, ReadLineReply } from "../src/repl-protocol";
import type { SourceLink } from "../src/run-source";
import type { SourceCompletion } from "../src/worker/complete-source";

/** `complete` 호출을 기록하는 가짜. 시험이 원하는 시점에 응답을 끝낼 수 있다. 기본은 빈 목록으로 즉시 resolve한다. */
function createCompleteSpy() {
  let impl: (
    source: string,
    pending: string | undefined,
  ) => Promise<SourceCompletion> = () =>
    Promise.resolve({ completions: [], start: 0 });
  const complete = vi.fn((source: string, pending: string | undefined) =>
    impl(source, pending),
  );
  return {
    complete,
    // 다음 호출부터 이 함수로 응답한다. 왕복 시점을 시험이 통제할 때 쓴다(예: Tab 왕복 중 busy 판정).
    setImpl(next: typeof impl) {
      impl = next;
    },
  };
}

/** `SourceLink` 가짜. `claim`은 기본 `undefined`(대기 슬롯 없음)다. 시험이 `mockReturnValue`로 채운다. */
function createSourceLinkSpy(): SourceLink & {
  claim: ReturnType<typeof vi.fn<() => string | undefined>>;
} {
  return {
    claim: vi.fn<() => string | undefined>(() => undefined),
    receive: vi.fn(),
    settle: vi.fn(),
  };
}

/**
 * `createReplMainDriver`를 실제 surface + 가짜 터미널로 조립한다.
 * `asyncWrite`는 write 콜백을 동기·비동기 중 어느 쪽으로 돌릴지 고른다.
 * 동기만 쓰면 콜백 안에서 입력 상태를 만드는 경합을 놓친다(TRAP-14). terminal `test/prompt-row/read.test.ts`의 `$mode` 관례다.
 */
function setup(asyncWrite: boolean) {
  const fake = createFakeTerminal({ asyncWrite });
  const vt = new VtScreen(fake.term.cols, 24);
  attachVtScreen(fake, vt);
  const surface = createTerminalSurface(fake.term, {
    readline: { persist: false },
  });
  const io = surface.openIo();
  const readSpy = vi.spyOn(asVendorReadline(surface.readline), "read");
  const interruptSender: InterruptSender = { send: vi.fn(), cancel: vi.fn() };
  const source = createSourceLinkSpy();
  const completeSpy = createCompleteSpy();
  const driver: ReplMainDriver = createReplMainDriver({
    readline: surface.readline,
    io,
    promptRow: surface.promptRow,
    interruptSender,
    topLevelAwait: false,
    complete: completeSpy.complete,
    source,
  });
  // `RpcHandlers`는 `Record<string, (...args: never[]) => unknown>`이다.
  // 그래서 `readLine`이 컴파일 타임에 optional·`never[]`로 좁혀진다.
  // 실제 계약(`repl-protocol.ts`)으로 한 번만 캐스팅한다. 시험 본문은 구체 타입으로 부른다.
  const readLineHandler = driver.driver.handlers.readLine as (
    prompt: string,
    pending: string | undefined,
    cancelable: boolean,
    outcome?: ReadLineOutcome,
  ) => Promise<ReadLineReply>;
  return {
    fake,
    vt,
    surface,
    io,
    driver,
    interruptSender: interruptSender as InterruptSender & {
      send: ReturnType<typeof vi.fn>;
      cancel: ReturnType<typeof vi.fn>;
    },
    source,
    complete: completeSpy,
    readSpy,
    // `readLine` 핸들러를 직접 부른다. 반환 promise에 빈 `catch`를 붙여 처리되지 않은 rejection 경고를 막는다.
    callReadLine(
      prompt: string,
      pending?: string,
      cancelable = true,
      outcome?: ReadLineOutcome,
    ): Promise<ReadLineReply> {
      const line = readLineHandler(prompt, pending, cancelable, outcome);
      void line.catch(() => {});
      return line;
    },
  };
}

describe.each([
  { mode: "동기", asyncWrite: false },
  { mode: "비동기", asyncWrite: true },
])(
  "createReplMainDriver 읽기 주기(write 콜백이 $mode 모드일 때)",
  ({ asyncWrite }) => {
    describe("겹침·읽기 시작(P1~P4)", () => {
      test("[P1] readLine 요청이 도착하면 interruptSender.cancel을 부른다(겹침으로 거절돼도)", async () => {
        const { fake, interruptSender, callReadLine } = setup(asyncWrite);
        callReadLine(">>> ");
        expect(interruptSender.cancel).toHaveBeenCalledTimes(1);
        callReadLine(">>> "); // 겹침(P2)이어도 cancel은 불린다
        expect(interruptSender.cancel).toHaveBeenCalledTimes(2);
        await drain(fake);
      });

      test("[P1] 취소 응답 뒤(cancel-settling) 도착한 readLine은 새 읽기를 정상적으로 연다", async () => {
        const { fake, driver, callReadLine } = setup(asyncWrite);
        const first = callReadLine(">>> ");
        await drain(fake);
        fake.type("\x03");
        await drain(fake);
        await expect(first).resolves.toBeNull();
        expect(driver.driver.isIdle()).toBe(true);

        const second = callReadLine(">>> ");
        await drain(fake);
        fake.type("ok\r");
        await drain(fake);
        await expect(second).resolves.toBe("ok");
      });

      test("[P2] 읽기가 열려 있는 동안 겹친 readLine은 가드 바깥에서 즉시 거절되고 첫 읽기는 그대로 진행된다", async () => {
        const { fake, callReadLine } = setup(asyncWrite);
        const first = callReadLine(">>> ");
        await drain(fake);
        const second = callReadLine(">>> ");
        await expect(second).rejects.toThrow("이미 읽는 중");
        fake.type("ok\r");
        await drain(fake);
        await expect(first).resolves.toBe("ok");
      });

      test("[P2] sendSource가 가져간 뒤 바깥 처리 전(closing)에 겹친 readLine도 거절된다", async () => {
        const { fake, driver, callReadLine } = setup(asyncWrite);
        const first = callReadLine(">>> ");
        await drain(fake);
        expect(driver.sendSource("code")).toBe(true);
        await expect(callReadLine(">>> ")).rejects.toThrow("이미 읽는 중");
        await drain(fake);
        await expect(first).resolves.toEqual({ source: "code" });
      });

      test("[P3] 결말이 실린 요청은 슬롯에 알리고, 복원한 읽기가 그려지면 정착시킨다", async () => {
        const { fake, source, callReadLine } = setup(asyncWrite);
        const outcome: ReadLineOutcome = { kind: "ok" };
        const reply = callReadLine(">>> ", undefined, true, outcome);
        await drain(fake);
        await drain(fake); // 두 번째 write("", cb)가 settleOnDraw를 처리한다
        expect(source.receive).toHaveBeenCalledWith(outcome);
        expect(source.settle).toHaveBeenCalledTimes(1);
        fake.type("ok\r");
        await drain(fake);
        await expect(reply).resolves.toBe("ok");
      });

      test("[P3] 대기 중인 코드가 있으면 읽기를 열지 않고 즉시 {source}로 응답한다", async () => {
        const { driver, source, readSpy, callReadLine } = setup(asyncWrite);
        source.claim.mockReturnValue("print(1)");
        const reply = callReadLine(">>> ");
        await expect(reply).resolves.toEqual({ source: "print(1)" });
        expect(readSpy).not.toHaveBeenCalled();
        expect(driver.driver.isIdle()).toBe(false);
      });

      test("[P4] 평소 읽기는 즉시 열려(phase opening) sourcePrompt가 busy를 낸다", () => {
        const { driver, callReadLine } = setup(asyncWrite);
        callReadLine(">>> ");
        expect(driver.sourcePrompt()).toBe("busy");
        expect(driver.driver.isIdle()).toBe(true);
      });
    });

    describe("그리기·읽기 판정(P5~P8)", () => {
      test("[P5] 복원한 줄은 벤더 read() 호출 직전(flush 뒤)에 프리필로 반영되고, 다음 평소 읽기에는 남지 않는다", async () => {
        const { fake, driver, readSpy, callReadLine } = setup(asyncWrite);
        const first = callReadLine(">>> ");
        await drain(fake);
        fake.type("abc");
        await drain(fake);
        expect(driver.sendSource("code")).toBe(true);
        await drain(fake);
        await expect(first).resolves.toEqual({ source: "code" });

        callReadLine(">>> ", undefined, true, { kind: "ok" });
        await drain(fake);
        const restored = readSpy.mock.calls.at(-1);
        expect(restored?.[1]).toMatchObject({
          prefill: "abc",
          prefillCursor: 3,
        });

        fake.type("\r");
        await drain(fake);
        callReadLine(">>> ", undefined, true, { kind: "ok" });
        await drain(fake);
        const afterConsumed = readSpy.mock.calls.at(-1);
        expect(afterConsumed?.[1]?.prefill).toBeUndefined();
      });

      test("[P6] (a) 벤더 읽기가 끝나는 즉시(그리기 콜백 전) sourcePrompt가 busy로 바뀐다", async () => {
        const { fake, driver, callReadLine } = setup(asyncWrite);
        callReadLine(">>> ");
        await drain(fake);
        expect(driver.sourcePrompt()).toBe("open");

        fake.type("ok\r");
        // 벤더 promise에 직접 붙은 콜백이 드라이버의 바깥 promise 처리보다 먼저 돈다(`08-session.md` 8.1 `closing` 항목, P-a).
        // `promptRow.read`가 `async` 함수라 바깥 promise는 벤더 원시 promise보다 정확히 1틱 늦게 정착한다.
        // 그 사이 1틱만 관찰한다. 2틱을 기다리면 바깥 promise까지 끝나 이 시험이 무력해진다.
        await Promise.resolve();
        expect(driver.sourcePrompt()).toBe("busy");
        // closing도 읽기 대기 중이다(P16). 바깥 promise가 phase를 `idle`로 내리기 전까지 게이트가 닫혀 있다.
        expect(driver.driver.isIdle()).toBe(true);

        await drain(fake);
      });

      test("[P6] (b) 그려지면 sourcePrompt가 open을 낸다", async () => {
        const { fake, driver, callReadLine } = setup(asyncWrite);
        callReadLine(">>> ");
        await drain(fake);
        expect(driver.sourcePrompt()).toBe("open");
      });

      test("[P7] 첫 요청 전에는 wait, 그려진 읽기가 열려 있으면 open이다", async () => {
        const { fake, driver, callReadLine } = setup(asyncWrite);
        expect(driver.sourcePrompt()).toBe("wait");
        callReadLine(">>> ");
        await drain(fake);
        expect(driver.sourcePrompt()).toBe("open");
      });

      test("[P7] 블록 입력 중(pending)이면 busy다", async () => {
        const { fake, driver, callReadLine } = setup(asyncWrite);
        const first = callReadLine(">>> ");
        await drain(fake);
        fake.type("if 1:\r");
        await drain(fake);
        await expect(first).resolves.toBe("if 1:");

        callReadLine("... ", "if 1:");
        await drain(fake);
        expect(driver.sourcePrompt()).toBe("busy");
      });

      test("[P7] input() 알림이 대기 중이면 프롬프트가 열려 있어도 busy다", async () => {
        const { fake, driver, callReadLine } = setup(asyncWrite);
        callReadLine(">>> ");
        await drain(fake);
        driver.driver.inputRequested?.();
        expect(driver.sourcePrompt()).toBe("busy");
        driver.driver.inputResumed?.();
        expect(driver.sourcePrompt()).toBe("open");
      });

      test("[P7] Tab 완성 왕복 중이면 busy다", async () => {
        const { fake, driver, complete, callReadLine } = setup(asyncWrite);
        complete.setImpl(() => new Promise(() => {}));
        callReadLine(">>> ");
        await drain(fake);
        fake.type("pri");
        await drain(fake);
        fake.type("\t");
        await drain(fake);
        expect(driver.sourcePrompt()).toBe("busy");
      });

      test("[P8] 프롬프트가 열려 있으면 sendSource가 편집 중이던 줄을 가져가 taken 응답을 만든다", async () => {
        const { fake, driver, callReadLine } = setup(asyncWrite);
        const first = callReadLine(">>> ");
        await drain(fake);
        fake.type("abc");
        await drain(fake);
        expect(driver.sendSource("code()")).toBe(true);
        await drain(fake);
        await expect(first).resolves.toEqual({ source: "code()" });
      });

      test("[P8] 프롬프트가 열려 있지 않으면 sendSource는 아무것도 하지 않고 false를 낸다", () => {
        const { driver } = setup(asyncWrite);
        expect(driver.sendSource("code()")).toBe(false);
      });
    });

    describe("읽기 종료(P9~P13)", () => {
      test("[P9] Enter로 제출한 줄이 그대로 응답되고 게이트가 열린다", async () => {
        const { fake, driver, callReadLine } = setup(asyncWrite);
        const line = callReadLine(">>> ");
        await drain(fake);
        fake.type("print(1)\r");
        await drain(fake);
        await expect(line).resolves.toBe("print(1)");
        expect(driver.driver.isIdle()).toBe(false);
      });

      test("[P10] Ctrl+C 취소는 null로 응답하고 다음 요청 전까지 게이트를 닫는다(cancel-settling)", async () => {
        const { fake, driver, callReadLine } = setup(asyncWrite);
        const line = callReadLine(">>> ");
        await drain(fake);
        fake.type("\x03");
        await drain(fake);
        await expect(line).resolves.toBeNull();
        expect(driver.driver.isIdle()).toBe(true);
      });

      test("[P10] 이어지는 블록 줄에서 취소하면 blockHistory가 대기 중이던 블록을 첫 줄까지 지운다", async () => {
        const { fake, surface, callReadLine } = setup(asyncWrite);
        const first = callReadLine(">>> ");
        await drain(fake);
        fake.type("if 1:\r");
        await drain(fake);
        await expect(first).resolves.toBe("if 1:");
        expect(surface.readline.getHistory().entries).toContain("if 1:");

        const second = callReadLine("... ", "if 1:");
        await drain(fake);
        fake.type("\x03");
        await drain(fake);
        await expect(second).resolves.toBeNull();
        expect(surface.readline.getHistory().entries).not.toContain("if 1:");
      });

      test("[P8][P12] taken 읽기의 rejection은 취소가 아니라 {source} 응답으로 변환된다", async () => {
        const { fake, driver, callReadLine } = setup(asyncWrite);
        const first = callReadLine(">>> ");
        await drain(fake);
        fake.type("x");
        await drain(fake);
        expect(driver.sendSource("y = 1")).toBe(true);
        await drain(fake);
        // ReadCancelledError가 아니라 taken 경로다. null이 아니라 {source}로 응답된다(P11과 대조).
        await expect(first).resolves.toEqual({ source: "y = 1" });
      });

      test("[P11] terminate() 중 취소된 옛 읽기는 응답 없이 영영 풀리지 않는다", async () => {
        const { fake, driver, callReadLine } = setup(asyncWrite);
        const line = callReadLine(">>> ");
        await drain(fake);
        const observed = { settled: false };
        line.then(
          () => {
            observed.settled = true;
          },
          () => {
            observed.settled = true;
          },
        );
        driver.driver.terminate?.();
        await drain(fake);
        await tick();
        expect(observed.settled).toBe(false);
      });

      test("[P13] 알려지지 않은 오류는 게이트를 idle로 되돌리고 그대로 전파한다", async () => {
        const { fake, driver, io, callReadLine } = setup(asyncWrite);
        io.close();
        const line = callReadLine(">>> ");
        await expect(line).rejects.toThrow();
        await drain(fake);
        expect(driver.driver.isIdle()).toBe(false);
      });
    });

    describe("입력 알림·유휴(P14~P16)", () => {
      test("[P14] inputRequested는 cancel-settling을 내리고 inputPending을 올려 busy로 만든다", async () => {
        const { fake, driver, callReadLine } = setup(asyncWrite);
        const line = callReadLine(">>> ");
        await drain(fake);
        fake.type("\x03");
        await drain(fake);
        await expect(line).resolves.toBeNull();
        expect(driver.driver.isIdle()).toBe(true);

        driver.driver.inputRequested?.();
        expect(driver.driver.isIdle()).toBe(false);

        const next = callReadLine(">>> ");
        await drain(fake);
        expect(driver.sourcePrompt()).toBe("busy");
        driver.driver.inputResumed?.();
        expect(driver.sourcePrompt()).toBe("open");
        fake.type("ok\r");
        await drain(fake);
        await expect(next).resolves.toBe("ok");
      });

      test("[P15] inputResumed는 cancel-settling을 내리고 inputPending을 0 미만으로 내리지 않는다", async () => {
        const { fake, driver, callReadLine } = setup(asyncWrite);
        const line = callReadLine(">>> ");
        await drain(fake);
        fake.type("\x03");
        await drain(fake);
        await expect(line).resolves.toBeNull();

        driver.driver.inputResumed?.();
        expect(driver.driver.isIdle()).toBe(false);

        const next = callReadLine(">>> ");
        await drain(fake);
        driver.driver.inputResumed?.(); // 이미 0인데 다시 불러도 예외 없이 open 유지
        expect(driver.sourcePrompt()).toBe("open");
        fake.type("ok\r");
        await drain(fake);
        await expect(next).resolves.toBe("ok");
      });

      test("[P16] isIdle은 읽기 대기 중이거나 취소 방어 구간일 때만 참이다", async () => {
        const { fake, driver, callReadLine } = setup(asyncWrite);
        expect(driver.driver.isIdle()).toBe(false);
        const line = callReadLine(">>> ");
        expect(driver.driver.isIdle()).toBe(true);
        await drain(fake);
        expect(driver.driver.isIdle()).toBe(true);
        fake.type("x\r");
        await drain(fake);
        await expect(line).resolves.toBe("x");
        expect(driver.driver.isIdle()).toBe(false);
      });
    });

    describe("종료(P17~P18)", () => {
      test("[P17] 읽기가 열려 있을 때(phase open) terminate하면 대기 중이던 블록을 history에서 첫 줄까지 버린다", async () => {
        const { fake, surface, driver, callReadLine } = setup(asyncWrite);
        const first = callReadLine(">>> ");
        await drain(fake);
        fake.type("if 1:\r");
        await drain(fake);
        await expect(first).resolves.toBe("if 1:");
        expect(surface.readline.getHistory().entries).toContain("if 1:");

        callReadLine("... ", "if 1:");
        await drain(fake);
        driver.driver.terminate?.();
        expect(surface.readline.getHistory().entries).not.toContain("if 1:");
      });

      test("[P17] 읽기가 열려 있지 않을 때(phase idle) terminate해도 진행형으로 기록된 블록은 history에 남는다", async () => {
        const { fake, surface, driver, callReadLine } = setup(asyncWrite);
        const first = callReadLine(">>> ");
        await drain(fake);
        fake.type("if 1:\r");
        await drain(fake);
        await expect(first).resolves.toBe("if 1:");

        // 이어지는 블록 줄을 제출해 진행형 history 항목을 만든다.
        // blockBase는 discard() 없이는 지워지지 않고 남는다.
        // worker가 이 뒤로 readLine을 다시 부르지 않는 경우다(예: exit()·무한루프).
        const second = callReadLine("... ", "if 1:");
        await drain(fake);
        fake.type("x = 1\r");
        await drain(fake);
        const secondLine = await second;
        const blockEntry = `if 1:\n${secondLine}`;
        expect(surface.readline.getHistory().entries).toContain(blockEntry);

        driver.driver.terminate?.();
        expect(surface.readline.getHistory().entries).toContain(blockEntry);
      });

      test("[P17] closing 구간(벤더 읽기 종료 직후, 바깥 처리 전)에 terminate해도 대기 중이던 블록을 history에서 버린다", async () => {
        const { fake, surface, driver, callReadLine } = setup(asyncWrite);
        const first = callReadLine(">>> ");
        await drain(fake);
        fake.type("if 1:\r");
        await drain(fake);
        await expect(first).resolves.toBe("if 1:");
        expect(surface.readline.getHistory().entries).toContain("if 1:");

        const second = callReadLine("... ", "if 1:");
        await drain(fake);
        fake.type("\r"); // 빈 줄로 블록을 끝낸다.
        // 벤더 promise는 이미 끝났다(phase: closing).
        // 바깥 promise 처리(P9, discard 호출)는 아직 안 돌았다.
        // `[P6] (a)`와 같은 1틱 창이다(`08-session.md` 8.1 `closing` 항목, P-a).
        await Promise.resolve();
        driver.driver.terminate?.();
        expect(surface.readline.getHistory().entries).not.toContain("if 1:");

        await second;
        await drain(fake);
      });

      test("[P17] terminate는 현재 io를 닫아 이후 새 읽기 시도가 던지게 한다", async () => {
        const { fake, driver, callReadLine } = setup(asyncWrite);
        callReadLine(">>> ");
        await drain(fake);
        driver.driver.terminate?.();
        await drain(fake);
        const second = callReadLine(">>> ");
        await expect(second).rejects.toThrow();
      });

      test("[P18] readInput은 stdin 읽기를 열어 Enter로 응답한다", async () => {
        const { fake, driver } = setup(asyncWrite);
        const input = driver.driver.readInput(true, () => false);
        void input.catch(() => {});
        await drain(fake);
        fake.type("hello\r");
        await drain(fake);
        await expect(input).resolves.toBe("hello");
      });
    });

    describe("EOF(H4, RD-048)", () => {
      test("[R1] `>>>`(pending 없음) 빈 줄 Ctrl+D는 { eof: true }로 응답한다", async () => {
        const { fake, callReadLine } = setup(asyncWrite);
        const reply = callReadLine(">>> ");
        await drain(fake);
        fake.type("\x04");
        await drain(fake);

        await expect(reply).resolves.toEqual({ eof: true });
      });

      test("[R2] `...`(pending 있음) 빈 줄 Ctrl+D는 eof를 켜지 않아 무동작이고 읽기가 계속된다", async () => {
        const { fake, callReadLine } = setup(asyncWrite);
        const first = callReadLine(">>> ");
        await drain(fake);
        // 열린 괄호는 `:`로 끝나지 않아 autoIndent 프리필이 없다.
        // 이어지는 읽기의 버퍼가 비어 있어야 이 시험이 eof 옵션 자체를 본다.
        // "if 1:"은 4칸 프리필이 생겨 버퍼가 비지 않는다.
        fake.type("x = (\r");
        await drain(fake);
        await expect(first).resolves.toBe("x = (");

        const second = callReadLine("... ", "x = (");
        await drain(fake);
        fake.type("\x04"); // eof 없음. 원본 동작(무동작)이라 읽기가 끝나지 않는다.
        fake.type("\r"); // 빈 줄로 블록을 끝낸다. EOF 응답이 아니라 보통의 빈 줄 제출이다.
        await drain(fake);

        await expect(second).resolves.toBe("");
      });

      test("[R6] EOF 응답 뒤 isIdle()은 참이다(cancel-settling 재사용 — Ctrl+C 게이트가 닫힌다)", async () => {
        const { fake, driver, callReadLine } = setup(asyncWrite);
        const reply = callReadLine(">>> ");
        await drain(fake);
        fake.type("\x04");
        await drain(fake);
        await expect(reply).resolves.toEqual({ eof: true });

        expect(driver.driver.isIdle()).toBe(true);
      });
    });
  },
);
