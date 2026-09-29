/**
 * `createPromptRow` 읽기 시험(RD-027).
 * - 검증 1: `promptRow.read`가 꼬리를 프롬프트로 합성해 벤더 `readline.read`를 연다.
 * - 검증 2: 읽기가 호출 시점의 io에 묶인다.
 * - 구성: `@repo/pyodide-testkit/fake-terminal` + 실제 `Readline` + 실제 `createTerminalSurface`.
 *   `surface.promptRow`를 직접 부른다. 조립·배출은 `../surface-setup.ts`(RD-042)가 맡는다.
 * - write 콜백이 동기인 경우와 비동기인 경우를 `describe.each`로 모두 돌린다.
 *   비동기 모드는 `rewindTail`의 flush 대기 순서를 통제한다(TRAP-14).
 * - 화면에 실제로 어떻게 그려지는지(앞 행 중복 없음)는 브라우저(Playwright)가 본다.
 *
 * 절 구성:
 * - `prompt=''` 절은 구 `stdin-reader` 시험을 새 인터페이스로 옮긴 것이다.
 * - "합성 프롬프트" 절은 구 `repl-reader` 시험을 새 인터페이스로 옮긴 것이다.
 * - pending 프리필은 repl `createAutoIndent` 대신 `readOptions`에 직접 `prefill`을 준다. terminal은 repl을 import하지 않는다.
 * - 같은 surface의 접두 정리는 `prefix.test.ts`, 행 마감은 `row-end.test.ts`가 맡는다(RD-042 분할).
 */
import { describe, expect, test, vi } from "vitest";
import { STDIN_EOF } from "@cp949/runo-pyodide-core";
import { drain, setupSurface, tail, tick } from "../surface-setup";

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

describe.each([
  { mode: "동기", asyncWrite: false },
  { mode: "비동기", asyncWrite: true },
])("promptRow.read (write 콜백이 $mode 모드일 때)", ({ asyncWrite }) => {
  function setup() {
    const setup = setupSurface({ asyncWrite });
    const read = vi.spyOn(setup.readline, "read");
    return {
      ...setup,
      io: setup.surface.openIo(),
      lastPrompt: () => read.mock.calls.at(-1)?.[0],
      lastOptions: () => read.mock.calls.at(-1)?.[1],
    };
  }

  describe("prompt=''(구 stdin-reader)", () => {
    test('`input("x: ")`의 프롬프트를 꼬리로 받아 그 자리에 다시 그리고 입력값을 돌려준다', async () => {
      const { fake, io, startRead, lastPrompt } = setup();
      io.sinks.write("x: ");
      const { line } = await startRead("", { cancelable: true });

      fake.type("abc\r");

      expect(lastPrompt()).toBe("x: ");
      await expect(line).resolves.toBe("abc");
      expect(fake.written).toContain("x: abc");
    });

    test("꼬리가 없으면 프롬프트 없이 입력만 받는다", async () => {
      const { fake, startRead, lastPrompt } = setup();
      const { line } = await startRead("", { cancelable: true });

      fake.type("abc\r");

      expect(lastPrompt()).toBe("");
      await expect(line).resolves.toBe("abc");
    });

    test("색이 닫힌 꼬리는 색 이스케이프까지 그대로 프롬프트가 되고 SGR 리셋을 더 붙이지 않는다", async () => {
      const { io, startRead, lastPrompt } = setup();
      io.sinks.write("\x1b[32mNm: \x1b[0m");

      await startRead("", { cancelable: true });

      expect(lastPrompt()).toBe("\x1b[32mNm: \x1b[0m");
    });

    test("닫지 않은 색 꼬리에도 SGR 리셋을 붙이지 않는다(합성 프롬프트와 다른 점: 열린 색이 입력에 이어진다)", async () => {
      const { io, startRead, lastPrompt } = setup();
      io.sinks.write("\x1b[32mG");

      await startRead("", { cancelable: true });

      expect(lastPrompt()).toBe("\x1b[32mG");
    });

    test("stderr 꼬리도 그대로다(뒤에 리셋이 더 붙지 않는다)", async () => {
      const { io, startRead, lastPrompt } = setup();
      io.sinks.writeErrorRaw("e");

      await startRead("", { cancelable: true });

      expect(lastPrompt()).toBe(`${RED}e${RESET}`);
    });

    test("읽기를 시작하면 꼬리를 비워 다음 읽기가 앞 프롬프트를 물려받지 않는다", async () => {
      const { fake, io, startRead, lastPrompt } = setup();
      io.sinks.write("x: ");
      const { line: first } = await startRead("", { cancelable: true });
      fake.type("\r");
      await first;

      await startRead("", { cancelable: true });

      expect(lastPrompt()).toBe("");
    });

    test("읽는 도중에도 꼬리는 이미 비어 있다", async () => {
      const { io, startRead } = setup();
      io.sinks.write("x: ");

      await startRead("", { cancelable: true });

      expect(tail(io.sinks)).toBe("");
    });

    test("`cancelable`을 벤더 읽기 옵션으로 그대로 넘긴다", async () => {
      const { startRead, lastOptions } = setup();

      await startRead("", { cancelable: false });

      expect(lastOptions()).toEqual({ cancelable: false });
    });

    test("호출 옵션 `history: false`를 벤더 읽기 옵션으로 넘기고, 생략하면 history 키를 넣지 않는다", async () => {
      const { fake, startRead, lastOptions } = setup();
      const { line: first } = await startRead("", {
        cancelable: true,
        history: false,
      });
      expect(lastOptions()).toEqual({ cancelable: true, history: false });
      fake.type("abc\r");
      await expect(first).resolves.toBe("abc");

      await startRead("", { cancelable: true });
      expect(lastOptions()).toStrictEqual({ cancelable: true });
    });

    test("`history: false`로 읽은 줄은 history에 남지 않고, 옵션 없이 읽은 줄은 남는다", async () => {
      const { fake, readline, startRead } = setup();
      const { line: first } = await startRead("", {
        cancelable: true,
        history: false,
      });
      fake.type("abc\r");
      await expect(first).resolves.toBe("abc");
      expect(readline.getHistory().entries).toEqual([]);

      const { line } = await startRead("", { cancelable: true });
      fake.type("def\r");
      await expect(line).resolves.toBe("def");
      expect(readline.getHistory().entries).toEqual(["def"]);
    });

    test("cancelable 읽기 중 Ctrl+C는 `^C` 없이 `null`을 돌려준다", async () => {
      const { fake, io, startRead } = setup();
      io.sinks.write("x: ");
      const { line } = await startRead("", { cancelable: true });

      fake.type("abc\x03");
      fake.flush();

      await expect(line).resolves.toBeNull();
      expect(fake.written.join("")).not.toContain("^C");
    });

    test("취소로 끝난 읽기도 꼬리를 남기지 않아 다음 읽기가 앞 프롬프트를 물려받지 않는다", async () => {
      const { fake, io, startRead, lastPrompt } = setup();
      io.sinks.write("x: ");
      const { line } = await startRead("", { cancelable: true });
      fake.type("abc\x03");
      fake.flush();
      await expect(line).resolves.toBeNull();

      expect(tail(io.sinks)).toBe("");
      await startRead("", { cancelable: true });
      expect(lastPrompt()).toBe("");
    });

    test("`cancelable`이 거짓이면 벤더 원본대로 `^C`를 찍고 읽기가 계속된다", async () => {
      const { fake, io, startRead } = setup();
      io.sinks.write("x: ");
      const { line } = await startRead("", { cancelable: false });

      fake.type("abc\x03");
      fake.flush();
      await tick();

      expect(fake.written.join("")).toContain("^C");
      fake.type("1\r");
      await expect(line).resolves.toBe("1");
    });

    test("`\\r`로 덮어쓴 진행률 꼬리는 마지막 `\\r` 뒤만 프롬프트다", async () => {
      const { io, startRead, lastPrompt } = setup();
      io.sinks.write("\r30%");
      io.sinks.write("\r100%");

      await startRead("", { cancelable: true });

      expect(lastPrompt()).toBe("100%");
    });

    test("flush를 기다리는 사이에 온 출력도 꼬리에 반영한다", async () => {
      const { io, surface, fake, lastPrompt } = setup();
      io.sinks.write("x".repeat(100));

      void surface.promptRow.read("", { cancelable: true });
      io.sinks.write("!");
      await drain(fake);

      expect(lastPrompt()).toBe(`${"x".repeat(100)}!`);
    });

    test("폭을 넘는 꼬리는 커서를 첫 행까지 올린 다음에 프롬프트를 그린다", async () => {
      const { fake, io, startRead } = setup();
      fake.screen.cursorY = 1;
      fake.screen.wrappedRows = new Set([1]);
      io.sinks.write("x".repeat(100));

      await startRead("", { cancelable: true });

      const up = fake.written.indexOf("\x1b[1A");
      expect(up).toBeGreaterThan(-1);
      expect(
        fake.written.slice(up + 1).some((text) => text.includes("xxxx")),
      ).toBe(true);
    });

    test("짧은 꼬리는 flush를 기다리지 않고 바로 읽기를 시작한다", async () => {
      const { io, surface, lastPrompt } = setup();
      io.sinks.write("x: ");

      void surface.promptRow.read("", { cancelable: true });
      await tick();

      expect(lastPrompt()).toBe("x: ");
    });

    test("꼬리 정리를 기다리는 사이 signal이 abort되면 읽기를 열지 않고 null을 돌려준다", async () => {
      const { fake, io, surface, lastPrompt } = setup();
      io.sinks.write("x: ");
      const controller = new AbortController();

      const line = surface.promptRow.read("", {
        cancelable: true,
        signal: controller.signal,
      });
      controller.abort();
      await drain(fake);

      await expect(line).resolves.toBeNull();
      expect(lastPrompt()).toBeUndefined();
      fake.type("abc\r");
      expect(fake.written.join("")).not.toContain("abc");
    });

    test("abort되지 않은 signal은 읽기에 영향이 없다", async () => {
      const { fake, io, startRead, lastPrompt } = setup();
      io.sinks.write("x: ");
      const controller = new AbortController();
      const { line } = await startRead("", {
        cancelable: true,
        signal: controller.signal,
      });

      fake.type("abc\r");

      expect(lastPrompt()).toBe("x: ");
      await expect(line).resolves.toBe("abc");
    });

    test("새 io는 빈 프롬프트로 시작한다(세션 리셋의 단위 성질)", async () => {
      const { surface, io, lastPrompt } = setup();
      io.sinks.write("x: ");
      // 세션 리셋 뒤에는 io가 새로 만들어져 현재 io가 바뀐다. 이전 io에 꼬리가 남아 있어도 새 io는 물려받지 않는다.
      const fresh = surface.openIo();

      void surface.promptRow.read("", { cancelable: true });
      await tick();

      expect(lastPrompt()).toBe("");
      expect(tail(fresh.sinks)).toBe("");
    });
  });

  describe("합성 프롬프트(구 repl-reader)", () => {
    test("꼬리가 없으면 프롬프트를 그대로 읽는다(SGR 리셋 없음)", async () => {
      const { startRead, lastPrompt } = setup();

      await startRead(">>> ", { cancelable: true });

      expect(lastPrompt()).toBe(">>> ");
    });

    test("개행 없이 끝난 stdout 꼬리가 프롬프트 앞에 붙는다(`t>>> `)", async () => {
      const { io, startRead, lastPrompt } = setup();
      io.sinks.write("t");

      await startRead(">>> ", { cancelable: true });

      expect(lastPrompt()).toBe("t\x1b[0m>>> ");
    });

    test("`... ` 프롬프트도 같은 합성이다", async () => {
      const { io, startRead, lastPrompt } = setup();
      io.sinks.write("t");

      await startRead("... ", { cancelable: true });

      expect(lastPrompt()).toBe("t\x1b[0m... ");
    });

    test("stderr 꼬리는 빨강 텍스트가 꼬리 본문에 남고 그 뒤에 리셋 한 번이 더 붙는다", async () => {
      const { io, startRead, lastPrompt } = setup();
      io.sinks.writeErrorRaw("e");

      await startRead(">>> ", { cancelable: true });

      expect(lastPrompt()).toBe(`${RED}e${RESET}${RESET}>>> `);
    });

    test("닫지 않은 색은 프롬프트 앞 리셋으로 닫힌다", async () => {
      const { io, startRead, lastPrompt } = setup();
      io.sinks.write("\x1b[32mG");

      await startRead(">>> ", { cancelable: true });

      expect(lastPrompt()).toBe("\x1b[32mG\x1b[0m>>> ");
    });

    test("`\\r`로 덮어쓴 진행률은 마지막 것만 꼬리가 된다(`100%>>> `)", async () => {
      const { io, startRead, lastPrompt } = setup();
      io.sinks.write("\r30%");
      io.sinks.write("\r100%");

      await startRead(">>> ", { cancelable: true });

      expect(lastPrompt()).toBe("100%\x1b[0m>>> ");
    });

    test("println으로 끝난 출력(값 에코)은 꼬리가 없다", async () => {
      const { io, startRead, lastPrompt } = setup();
      io.sinks.writeOutput("2");

      await startRead(">>> ", { cancelable: true });

      expect(lastPrompt()).toBe(">>> ");
    });

    test("읽기를 시작하면 꼬리를 비워 다음 읽기가 물려받지 않는다", async () => {
      const { fake, io, startRead, lastPrompt } = setup();
      io.sinks.write("t");
      const { line: first } = await startRead(">>> ", { cancelable: true });
      fake.type("\r");
      await first;

      await startRead(">>> ", { cancelable: true });

      expect(lastPrompt()).toBe(">>> ");
    });

    test("Enter로 친 줄을 돌려준다", async () => {
      const { fake, startRead } = setup();
      const { line } = await startRead(">>> ", { cancelable: true });

      fake.type("abc\r");

      await expect(line).resolves.toBe("abc");
    });

    test("`cancelable`을 벤더 읽기 옵션으로 그대로 넘긴다(readOptions는 항상 평가한다)", async () => {
      const { startRead, lastOptions } = setup();

      await startRead(">>> ", {
        cancelable: false,
        readOptions: () => ({ onKey: () => false }),
      });

      expect(lastOptions()).toMatchObject({ cancelable: false });
      expect(lastOptions()?.prefill).toBeUndefined();
      expect(typeof lastOptions()?.onKey).toBe("function");
    });

    test("cancelable 읽기 중 Ctrl+C는 `^C` 없이 `null`을 돌려준다", async () => {
      const { fake, io, startRead } = setup();
      io.sinks.write("t");
      const { line } = await startRead(">>> ", { cancelable: true });

      fake.type("abc\x03");
      fake.flush();

      await expect(line).resolves.toBeNull();
      expect(fake.written.join("")).not.toContain("^C");
    });

    test("취소로 끝난 읽기도 꼬리를 남기지 않아 다음 프롬프트에 앞 꼬리가 섞이지 않는다", async () => {
      const { fake, io, startRead, lastPrompt } = setup();
      io.sinks.write("t");
      const { line } = await startRead(">>> ", { cancelable: true });
      fake.type("abc\x03");
      fake.flush();
      await expect(line).resolves.toBeNull();

      expect(tail(io.sinks)).toBe("");
      await startRead(">>> ", { cancelable: true });
      expect(lastPrompt()).toBe(">>> ");
    });

    test("`cancelable`이 거짓이면 벤더 원본대로 `^C`를 찍고 읽기가 계속된다", async () => {
      const { fake, startRead } = setup();
      const { line } = await startRead(">>> ", { cancelable: false });

      fake.type("abc\x03");
      fake.flush();
      await tick();

      expect(fake.written.join("")).toContain("^C");
      fake.type("1\r");
      await expect(line).resolves.toBe("1");
    });

    test("꼬리 정리를 기다리는 사이에 온 출력도 꼬리에 반영한다", async () => {
      const { io, surface, fake, lastPrompt } = setup();
      io.sinks.write("x".repeat(100));

      void surface.promptRow.read(">>> ", { cancelable: true });
      io.sinks.write("Z");
      await drain(fake);

      expect(lastPrompt()).toBe(`${"x".repeat(100)}Z\x1b[0m>>> `);
    });

    test("폭을 넘는 꼬리는 커서를 첫 행까지 올린 다음에 프롬프트를 그린다", async () => {
      const { fake, io, startRead } = setup();
      fake.screen.cursorY = 1;
      fake.screen.wrappedRows = new Set([1]);
      io.sinks.write("x".repeat(100));

      await startRead(">>> ", { cancelable: true });

      const up = fake.written.indexOf("\x1b[1A");
      const promptDraw = fake.written.findIndex((text) =>
        text.includes(">>> "),
      );
      expect(up).toBeGreaterThan(-1);
      expect(promptDraw).toBeGreaterThan(up);
    });

    test("readOptions가 flush 뒤 읽기 직전에 평가돼 pending prefill이 `... ` 다음에 그려지고 getLine()에 남는다", async () => {
      const { readline, startRead } = setup();

      await startRead("... ", {
        cancelable: true,
        readOptions: () => ({ prefill: "    ", prefillCursor: 4 }),
      });

      expect(readline.getLine()).toBe("    ");
    });

    test("prefill 뒤 Enter는 prefill + 입력을 돌려준다", async () => {
      const { fake, startRead } = setup();

      const { line } = await startRead("... ", {
        cancelable: true,
        readOptions: () => ({ prefill: "    ", prefillCursor: 4 }),
      });
      fake.type("print(i)\r");

      await expect(line).resolves.toBe("    print(i)");
    });

    test("꼬리가 있는 합성 프롬프트에서도 prefill이 프롬프트 뒤에 온다", async () => {
      const { io, readline, startRead, lastPrompt } = setup();
      io.sinks.write("t");

      await startRead("... ", {
        cancelable: true,
        readOptions: () => ({ prefill: "    ", prefillCursor: 4 }),
      });

      expect(lastPrompt()).toBe("t\x1b[0m... ");
      expect(readline.getLine()).toBe("    ");
    });
  });

  test("onOpen은 readline.read()를 연 직후 동기로 그 읽기 promise를 알린다", async () => {
    const { fake, startRead } = setup();
    const onOpen = vi.fn();

    const { line } = await startRead(">>> ", { cancelable: true, onOpen });

    expect(onOpen).toHaveBeenCalledExactlyOnceWith(expect.any(Promise));
    fake.type("1\r");
    await expect(line).resolves.toBe("1");
  });
});

describe("[T1] eof 옵션(RD-048)", () => {
  test("eof: true로 연 읽기에서 빈 줄 Ctrl+D는 STDIN_EOF로 끝난다", async () => {
    const { fake, surface, startRead } = setupSurface();
    surface.openIo();
    const { line } = await startRead(">>> ", { cancelable: true, eof: true });

    fake.type("\x04");
    await tick();

    await expect(line).resolves.toBe(STDIN_EOF);
  });

  test("eof 옵션이 없으면 빈 줄 Ctrl+D는 무동작이고 읽기가 계속된다(원본 동작)", async () => {
    const { fake, surface, startRead } = setupSurface();
    surface.openIo();
    const { line } = await startRead(">>> ", { cancelable: true });

    fake.type("\x04");
    fake.type("ok\r");

    await expect(line).resolves.toBe("ok");
  });
});

describe("현재 io 추적과 read의 io 묶임", () => {
  test("io를 연 적이 없으면 read()가 던진다", async () => {
    const { surface } = setupSurface();

    await expect(
      surface.promptRow.read("", { cancelable: true }),
    ).rejects.toThrow();
  });

  test("io를 닫으면 다시 read()가 던진다(현재 io 없음)", async () => {
    const { surface } = setupSurface();
    const io = surface.openIo();
    io.close();

    await expect(
      surface.promptRow.read("", { cancelable: true }),
    ).rejects.toThrow();
  });

  test("더 오래된 io의 close()는 현재 io를 바꾸지 않는다", async () => {
    const { fake, surface } = setupSurface();
    const first = surface.openIo();
    const second = surface.openIo();
    second.sinks.write("2: ");

    first.close();
    const read = surface.promptRow.read("", { cancelable: true });
    await tick();
    fake.type("ok\r");

    // 현재 io는 여전히 second다. 그 io로 읽기가 성공하고 프롬프트("2: ")가 함께 그려진다.
    // 첫 io의 close()가 현재 io를 지우면 read()가 "현재 io가 없다"로 reject한다.
    await expect(read).resolves.toBe("ok");
    expect(fake.written.join("")).toContain("2: ok");
  });

  test("read()는 호출 시점에 묶인 io의 꼬리를 쓴다 — flush를 기다리는 사이 다른 io가 현재 io가 돼도 바뀌지 않는다", async () => {
    const { fake, surface, readline } = setupSurface({ asyncWrite: true });
    const read = vi.spyOn(readline, "read");
    const first = surface.openIo();
    // 100자 꼬리는 `rewindTail`이 flush를 기다리게 한다. 짧은 꼬리는 즉시 반환한다.
    first.sinks.write("A".repeat(100));

    const line = surface.promptRow.read("", { cancelable: true });
    await tick();
    // flush 전에 다른 io를 열어 현재 io를 바꾼다.
    const second = surface.openIo();
    second.sinks.write("B: ");
    await drain(fake);

    // 호출 시점의 현재 io인 first의 꼬리를 쓴다. second의 "B: "가 아니다.
    expect(read.mock.calls.at(-1)?.[0]).toBe("A".repeat(100));
    fake.type("x\r");
    await expect(line).resolves.toBe("x");
  });
});
