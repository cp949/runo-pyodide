/**
 * `createReadGuard` 시험(`docs/design/04-stdin-input.md` 3.2).
 *
 * 배경.
 * - REPL 읽기와 stdin 읽기는 같은 `Readline`을 쓴다.
 * - `readline.read()`는 이미 열린 읽기를 교체하고 옛 읽기의 promise를 끝내지 않는다.
 * - 프롬프트를 기다리는 사이 배경 콜백이 `input()`을 부르면 REPL 읽기가 고아가 되어 입력이 멈춘다.
 *
 * 가드는 stdin 읽기를 활성 REPL 읽기의 결과가 정해진 뒤에 시작한다.
 * 실제 `Readline` + 가짜 터미널로 순서·접두 떼기·버림을 본다.
 * 겹침 거절(읽기 phase)은 가드 바깥(`repl-main-driver.ts`)의 몫이라 여기서 보지 않는다.
 */
import { ReadCancelledError } from "@cp949/runo-xterm-readline";
import { describe, expect, test, vi } from "vitest";
import { STDIN_EOF } from "@cp949/runo-pyodide-core";
import { observe, tick } from "@repo/pyodide-testkit/async";
import { createReadGuard } from "../../src/terminal/read-guard";
import {
  attachScreen,
  setupSurface,
  tail,
} from "@cp949/runo-pyodide-terminal/test-utils";

describe.each([
  { mode: "동기", asyncWrite: false },
  { mode: "비동기", asyncWrite: true },
])(
  "createReadGuard(surface.promptRow, write 콜백이 $mode 모드일 때)",
  ({ asyncWrite }) => {
    function setup() {
      const { fake, surface, readline } = setupSurface({ asyncWrite });
      const io = surface.openIo();
      // 스파이는 실제 구현을 그대로 돌린다. 호출 시점·인자만 관찰한다.
      // read-guard는 `promptRow.read`를 객체 멤버로 부른다(생성 시 구조 분해하지 않는다). 그래서 이 스파이가 닿는다.
      const promptRowRead = vi.spyOn(surface.promptRow, "read");
      const vendorRead = vi.spyOn(readline, "read");
      const guard = createReadGuard(surface.promptRow);
      // write 콜백을 배출하고 대기 중인 마이크로태스크·타이머를 지나가게 한다.
      // 비동기 모드는 flush 전에 읽기가 시작되지 않는다.
      async function settle() {
        fake.flush();
        await tick();
        fake.flush();
        await tick();
      }
      // 지금까지 벤더 `readline.read`가 받은 프롬프트. promptRow가 꼬리와 합친 합성 결과다.
      const prompts = () => vendorRead.mock.calls.map(([prompt]) => prompt);
      // stdin 읽기(`promptRow.read("", …)`)가 시작된 횟수. REPL 읽기(`prompt !== ""`)는 세지 않는다.
      const stdinCalls = () =>
        promptRowRead.mock.calls.filter(([prompt]) => prompt === "").length;
      return {
        fake,
        surface,
        io,
        readline,
        guard,
        promptRowRead,
        prompts,
        stdinCalls,
        settle,
      };
    }

    describe("stdin 읽기는 활성 REPL 읽기가 끝난 뒤에 시작한다", () => {
      test("활성 REPL 읽기가 있으면 stdin 읽기는 그 읽기가 끝난 뒤에 시작하고 두 결과는 그대로 전달된다", async () => {
        const { fake, guard, stdinCalls, settle } = setup();
        const repl = guard.readLine(">>> ", { cancelable: true });
        await settle();
        const input = guard.readInput(true, () => false);
        await settle();
        expect(stdinCalls()).toBe(0);

        fake.type("x = 41\r");
        await settle();
        await expect(repl).resolves.toBe("x = 41");
        expect(stdinCalls()).toBe(1);

        fake.type("hello\r");
        await settle();
        await expect(input).resolves.toBe("hello");
      });

      test("활성 REPL 읽기가 없으면 stdin 읽기는 기다리지 않고 시작한다", async () => {
        const { fake, guard, promptRowRead, settle } = setup();

        const input = guard.readInput(true, () => false);
        // 마이크로태스크 한 번이면 충분해야 한다. 매크로태스크를 기다려야 시작하면 기다리지 않는 것이 아니다.
        await Promise.resolve();

        expect(promptRowRead).toHaveBeenCalledWith("", {
          cancelable: true,
          eof: true,
        });
        await settle();
        fake.type("answer\r");
        await settle();
        await expect(input).resolves.toBe("answer");
      });

      test("REPL 읽기가 reject돼도 stdin 읽기는 시작하고 reject는 REPL 호출자에게 그대로 간다", async () => {
        const { surface, guard, stdinCalls, settle } = setup();
        const repl = observe(guard.readLine(">>> ", { cancelable: true }));
        await settle();

        surface.promptRow.endRead({ screen: false });
        await tick();

        expect(repl()).toEqual({
          state: "rejected",
          reason: expect.any(ReadCancelledError),
        });
        void guard.readInput(true, () => false);
        await settle();
        expect(stdinCalls()).toBe(1);
      });

      test("REPL 읽기가 끝난 뒤에는 stdin 읽기가 연달아 와도 앞 읽기를 기다리지 않고 각각 바로 시작한다", async () => {
        const { fake, guard, stdinCalls, settle } = setup();
        const repl = guard.readLine(">>> ", { cancelable: true });
        await settle();
        fake.type("f()\r");
        await settle();
        await expect(repl).resolves.toBe("f()");

        // 앞 stdin 읽기는 끝내지 않는다. 직렬화하면 둘째는 시작하지 못한다.
        void guard.readInput(true, () => false);
        void guard.readInput(true, () => false);
        await settle();

        expect(stdinCalls()).toBe(2);
      });

      test("다음 프롬프트의 새 REPL 읽기가 시작되면 끝난 옛 읽기가 아니라 새 읽기를 기다린다", async () => {
        const { fake, guard, stdinCalls, settle } = setup();
        const first = guard.readLine(">>> ", { cancelable: true });
        await settle();
        fake.type("a = 1\r");
        await settle();
        await expect(first).resolves.toBe("a = 1");

        const second = guard.readLine(">>> ", { cancelable: true });
        await settle();
        void guard.readInput(true, () => false);
        await settle();
        expect(stdinCalls()).toBe(0);

        fake.type("b = 2\r");
        await settle();
        await expect(second).resolves.toBe("b = 2");
        expect(stdinCalls()).toBe(1);
      });

      test("REPL 읽기는 가드를 거쳐도 즉시 시작되고 옵션을 그대로 promptRow에 넘긴다(시작 타이밍 불변)", () => {
        const { guard, promptRowRead } = setup();
        const options = { cancelable: true };

        void guard.readLine(">>> ", options);

        // 동기로 확인한다. 마이크로태스크라도 미루면 시작 타이밍이 바뀐다.
        expect(promptRowRead).toHaveBeenCalledTimes(1);
        const call = promptRowRead.mock.calls[0];
        if (!call) throw new Error("promptRow.read가 불리지 않았다");
        expect(call[0]).toBe(">>> ");
        expect(call[1]).toBe(options); // 같은 객체(readOptions 평가 시점을 옮기지 않는다)
      });

      test("REPL 읽기가 취소(`null`)로 끝나도 stdin 읽기는 시작한다", async () => {
        const { fake, guard, stdinCalls, settle } = setup();
        const repl = guard.readLine(">>> ", { cancelable: true });
        await settle();
        void guard.readInput(true, () => false);
        await settle();
        expect(stdinCalls()).toBe(0);

        // 취소는 실패가 아니라 값(`null`)이다. 가드는 REPL 읽기가 끝났다는 사실만 본다.
        fake.type("\x03");
        await settle();

        await expect(repl).resolves.toBeNull();
        expect(stdinCalls()).toBe(1);
      });

      test("`cancelable`을 그대로 원본 stdin 읽기에 넘긴다", async () => {
        const { guard, promptRowRead, settle } = setup();

        void guard.readInput(false, () => false);
        await settle();

        expect(promptRowRead).toHaveBeenCalledWith("", {
          cancelable: false,
          eof: true,
        });
      });

      test("[R3] stdin 읽기는 eof: true로 열려 빈 줄 Ctrl+D가 STDIN_EOF로 끝난다", async () => {
        const { fake, guard, settle } = setup();
        const input = guard.readInput(true, () => false);
        await settle();

        fake.type("\x04");
        await settle();

        await expect(input).resolves.toBe(STDIN_EOF);
      });

      test("stdin 읽기가 reject되면 가드가 삼키지 않고 호출자에게 그대로 전달한다", async () => {
        const { surface, guard, settle } = setup();
        const input = observe(guard.readInput(true, () => false));
        await settle();

        surface.promptRow.endRead({ screen: false });
        await tick();

        expect(input()).toEqual({
          state: "rejected",
          reason: expect.any(ReadCancelledError),
        });
      });
    });

    describe("미뤄지는 stdin 읽기(접두 떼기, RD-022b)", () => {
      test("활성 REPL 읽기가 있으면 stdin 읽기 도착 즉시(동기) 접두를 뗀다", async () => {
        const { io, readline, guard, settle } = setup();
        void guard.readLine(">>> ", { cancelable: true });
        await settle();
        io.sinks.write("bg> ");

        void guard.readInput(true, () => false);

        // 동기로 확인한다. REPL 읽기가 끝난 뒤에는 벤더 접두가 사라져 넘겨받을 수 없다.
        expect(tail(io.sinks)).toBe("bg> ");
        expect(readline.abovePrefix()).toBe("");
      });

      test("활성 REPL 읽기가 없으면 떼지 않는다(꼬리가 그대로 stdin 프롬프트가 된다)", async () => {
        const { io, guard, prompts, settle } = setup();
        io.sinks.write("bg> ");

        void guard.readInput(true, () => false);
        await settle();

        expect(prompts()).toEqual(["bg> "]);
      });

      test("겹치는 stdin 읽기끼리는 접두를 떼지 않는다(RD-022b는 REPL 읽기에서만 적용)", async () => {
        // worker는 stdin 읽기 동안 동기 대기라 실제로는 겹치지 않는다.
        // 열린 읽기 위 접두를 만들 수 있는 비-REPL 읽기는 이것뿐이라 시험에 쓴다.
        // 떼기가 `replOpen` 조건 없이 돌면 이 접두를 떼어 간다.
        const { io, readline, guard, settle } = setup();
        void guard.readInput(true, () => false);
        await settle();
        io.sinks.write("bg> ");

        void guard.readInput(true, () => false);

        expect(readline.abovePrefix()).toBe("bg> ");
      });

      test("끝난 REPL 읽기 뒤에 온 stdin 읽기는 즉시 시작한다(미루지 않는다)", async () => {
        const { fake, guard, stdinCalls, settle } = setup();
        void guard.readLine(">>> ", { cancelable: true });
        await settle();
        fake.type("x = 41\r");
        await settle();

        void guard.readInput(true, () => false);
        await Promise.resolve();

        expect(stdinCalls()).toBe(1);
      });

      test("옛 REPL 읽기가 끝나는 처리보다 새 REPL 읽기가 먼저 열리면 새 읽기를 활성으로 본다(접두를 뗀다)", async () => {
        const { fake, io, readline, guard, settle } = setup();
        void guard.readLine(">>> ", { cancelable: true });
        await settle();
        fake.type("a = 1\r");
        // 옛 읽기의 끝 처리(마이크로태스크)가 돌기 전에 새 읽기가 열린다.
        void guard.readLine(">>> ", { cancelable: true });
        await settle(); // 옛 읽기의 끝 처리가 이 사이에 돈다.
        io.sinks.write("bg> "); // 둘째(새) REPL 읽기의 접두가 된다.

        void guard.readInput(true, () => false);

        // 동기로 확인한다: 둘째 읽기가 활성으로 남아 있어야 접두를 뗀다.
        expect(tail(io.sinks)).toBe("bg> ");
        expect(readline.abovePrefix()).toBe("");
      });
    });

    describe("미룬 뒤 열기 직전 sessionEnded (`08-session.md` 8.1 D6)", () => {
      test("[D6] 미루는 사이 세션이 끝났으면 원본 stdin 읽기를 열지 않고 null로 끝낸다", async () => {
        const { fake, guard, stdinCalls, settle } = setup();
        let ended = false;
        void guard.readLine(">>> ", { cancelable: true });
        await settle();
        const input = guard.readInput(true, () => ended);

        ended = true;
        fake.type("x = 1\r");
        await settle();

        expect(stdinCalls()).toBe(0);
        await expect(input).resolves.toBeNull();
      });

      test("[D6] 미루는 사이 세션이 끝나지 않았으면 원본 stdin 읽기를 연다(기존 동작)", async () => {
        const { fake, guard, settle } = setup();
        void guard.readLine(">>> ", { cancelable: true });
        await settle();
        const input = guard.readInput(true, () => false);

        fake.type("x = 1\r");
        await settle();
        fake.type("hello\r");
        await settle();

        await expect(input).resolves.toBe("hello");
      });

      test("[R1] 미룬 읽기를 D6으로 열지 않으면 뗀 접두를 출력으로 그린다", async () => {
        const { fake, io, guard, settle } = setup();
        const vt = attachScreen(fake);
        void guard.readLine(">>> ", { cancelable: true });
        await settle();
        io.sinks.write("bg> "); // 열린 REPL 읽기의 접두가 된다
        let ended = false;
        const input = guard.readInput(true, () => ended);
        await settle(); // 미룬다(접두를 뗀다)

        ended = true;
        fake.type("x\r");
        await settle();

        await expect(input).resolves.toBeNull();
        expect(vt.lines()).toEqual([">>> x", "bg>"]);
      });

      test("[R1] 미루지 않은 읽기는 D6으로 열지 않아도 그리지 않는다(꼬리가 화면에 있다)", async () => {
        const { fake, io, guard } = setup();
        io.sinks.write("bg> "); // 꼬리를 채운다 — 그려지면 이 조각이 한 번 더 쓰인다.
        const before = fake.written.length;

        await expect(guard.readInput(true, () => true)).resolves.toBeNull();

        expect(fake.written.length).toBe(before);
      });

      test("[R1] 미룬 읽기를 세션이 살아 있어 열면 출력으로 그리지 않고 프롬프트로 연다", async () => {
        const { fake, io, guard, settle } = setup();
        void guard.readLine(">>> ", { cancelable: true });
        await settle();
        io.sinks.write("bg> ");
        const input = guard.readInput(true, () => false);

        fake.type("x\r");
        await settle();

        // 뗀 접두를 출력으로 먼저 그린 뒤 프롬프트로 또 그리면(중복 그리기) "bg> " 조각이 두 번 쓰인다.
        // 최종 화면(`vt.lines()`)은 프롬프트 재그리기가 지우고 다시 써서 두 경우가 같아 보인다.
        // 그래서 바이트 단위로 센다.
        expect(fake.written.filter((chunk) => chunk === "bg> ")).toHaveLength(
          1,
        );

        fake.type("hello\r");
        await settle();
        await expect(input).resolves.toBe("hello");
      });
    });

    describe("실제 Readline에서 REPL 읽기가 고아가 되지 않는다", () => {
      // 가드가 없으면 stdin 읽기가 `readline.read()`로 REPL 읽기를 교체한다.
      // 사용자가 REPL 줄에 친 입력이 stdin 읽기로 가고 REPL 읽기는 영영 끝나지 않는다.
      // `createRepl`(repl-main-driver)과 같이 REPL 읽기·stdin 읽기 모두 `promptRow.read`다(RD-027).
      // REPL 읽기는 합성 프롬프트로, stdin 읽기는 `prompt=""`로 부른다.
      test("REPL 읽기 중 배경 input()이 들어와도 REPL 줄은 REPL 읽기가, 그다음 줄은 stdin 읽기가 받는다", async () => {
        const { fake, io, guard, prompts, settle } = setup();
        const repl = observe(guard.readLine(">>> ", { cancelable: true }));
        await settle();

        // 프롬프트를 기다리는 사이 배경 콜백의 `input("bg> ")`가 프롬프트를 쓰고 stdin 읽기를 요청한다.
        io.sinks.write("bg> ");
        const input = observe(guard.readInput(true, () => false));
        await settle();
        expect(prompts()).toEqual([">>> "]);

        // 사용자가 REPL 줄을 친다. 이 줄은 REPL 읽기가 받고 stdin 읽기는 아직 시작하지 않는다.
        fake.type("x = 41\r");
        await settle();
        expect(repl()).toEqual({ state: "resolved", value: "x = 41" });

        // REPL 읽기가 끝나 stdin 읽기가 시작됐다. 프롬프트는 배경 `input`의 꼬리(`bg> `)다. 다음 줄은 stdin 읽기가 받는다.
        expect(input()).toEqual({ state: "pending" });
        expect(prompts()).toEqual([">>> ", "bg> "]);
        fake.type("hello\r");
        await settle();
        expect(input()).toEqual({ state: "resolved", value: "hello" });
        expect(fake.written).toContain("bg> hello");
      });

      test("배경 input()의 프롬프트는 REPL 줄에서 떼어져 미뤄진 stdin 읽기의 프롬프트가 되고 그 뒤 꼬리는 비어 있다(RD-022b)", async () => {
        const { fake, io, readline, guard, settle } = setup();
        const vt = attachScreen(fake);
        const repl = observe(guard.readLine(">>> ", { cancelable: true }));
        await settle();
        fake.type("x = 41");

        io.sinks.write("bg> ");
        await settle();
        expect(vt.screen()).toBe("bg> >>> x = 41");
        const input = observe(guard.readInput(true, () => false));
        await settle();
        // 접두를 REPL 줄에서 떼어 꼬리로 옮겼다.
        expect(vt.screen()).toBe(">>> x = 41");
        expect(readline.abovePrefix()).toBe("");
        expect(tail(io.sinks)).toBe("bg> ");

        fake.type("\r");
        await settle();
        expect(repl()).toEqual({ state: "resolved", value: "x = 41" });
        // stdin 읽기가 꼬리를 프롬프트로 가져갔다. 다음 읽기가 물려받을 꼬리는 없다.
        expect(tail(io.sinks)).toBe("");
        fake.type("hello\r");
        await settle();
        expect(input()).toEqual({ state: "resolved", value: "hello" });
        expect(vt.lines()).toEqual([">>> x = 41", "bg> hello"]);
      });
    });
  },
);
