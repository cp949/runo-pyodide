/**
 * `createPromptRow` 접두·안내 시험(RD-027, `design.md` §4·§6): 열린 읽기에서 입력을 가져오는 `take`, 배경 출력 접두를 꼬리로
 * 옮기는 `detachPrefix`, 안내 한 줄 `notice`. "detachPrefix" 절은 `sinks.test.ts`의 `moveAbovePrefixToTail` describe(6건),
 * "notice" 절은 `notice.test.ts`(3건)를 새 인터페이스로 옮긴 것이다. 조립·배출은 `../surface-setup.ts`(RD-042).
 */
import { ReadTakenError } from "@cp949/runo-xterm-readline";
import { describe, expect, test, vi } from "vitest";
import { attachScreen, setupSurface, tail, tick } from "../surface-setup";

describe("take", () => {
  function setup() {
    const setup = setupSurface();
    return { ...setup, io: setup.surface.openIo() };
  }

  test("열린 읽기가 없으면 undefined를 돌려주고 아무것도 쓰지 않는다", () => {
    const { fake, surface } = setup();
    const before = fake.written.length;

    expect(surface.promptRow.take()).toBeUndefined();
    expect(fake.written.length).toBe(before);
  });

  test("읽던 텍스트·커서를 가져오고 지운 꼬리를 다시 쓴다", async () => {
    const { fake, surface, io, startRead } = setup();
    io.sinks.write("t");
    const { line: read } = await startRead(">>> ", { cancelable: true });
    fake.type("abc");

    const taken = surface.promptRow.take();

    expect(taken).toEqual({ text: "abc", cursor: 3 });
    expect(fake.written.join("")).toContain("t\x1b[0m\r\n");
    await expect(read).rejects.toThrow(ReadTakenError);
  });

  test("배경 출력이 남긴 접두도 함께 지워 접두를 꼬리보다 먼저 쓴다(변이 검사 ③: abovePrefix는 takeRead 앞)", async () => {
    const { fake, surface, io, startRead } = setup();
    const { line: read } = await startRead("> ", { cancelable: true });
    fake.type("abc");
    io.sinks.write("bg"); // 열린 읽기 중이므로 접두가 된다(printAboveRaw 경로).

    const taken = surface.promptRow.take();

    expect(taken).toEqual({ text: "abc", cursor: 3 });
    expect(fake.written.join("")).toContain("bg\x1b[0m\r\n");
    await expect(read).rejects.toThrow(ReadTakenError);
  });

  test("접두와 꼬리가 둘 다 있으면 접두 → 꼬리 순서로 잇는다", async () => {
    const { fake, surface, io, startRead } = setup();
    io.sinks.write("T");
    const { line: read } = await startRead(">>> ", { cancelable: true });
    fake.type("abc");
    io.sinks.write("bg");

    const taken = surface.promptRow.take();

    expect(taken).toEqual({ text: "abc", cursor: 3 });
    expect(fake.written.join("")).toContain("bg\x1b[0mT\x1b[0m\r\n");
    await expect(read).rejects.toThrow(ReadTakenError);
  });
});

describe("detachPrefix(구 moveAbovePrefixToTail, RD-022b)", () => {
  function setup(options: { asyncWrite?: boolean } = {}) {
    const { fake, surface, readline } = setupSurface({ cols: 40, ...options });
    const vt = attachScreen(fake);
    const printAboveRaw = vi.spyOn(readline, "printAboveRaw");
    const io = surface.openIo();
    /** `> ` 읽기를 열고 그린 뒤 `typed`를 친다. 읽기 Promise는 객체에 담아 돌려준다. */
    const openRead = async (typed = "abc") => {
      const line = surface.promptRow.read("> ", { cancelable: true });
      // `promptRow.read()`는 `readline.read()`를 부르기 전에 `await rewindTail(...)`를 거친다(빈 꼬리도 마이크로
      // 태스크 한 번). 실제 벤더 호출까지 기다린 뒤 write 콜백을 배출한다.
      await tick();
      fake.flush();
      fake.type(typed);
      fake.flush();
      return { line };
    };
    return { fake, vt, surface, readline, io, printAboveRaw, openRead };
  }

  test("접두를 입력줄에서 떼어 다시 그리고 꼬리를 그 접두로 둔다", async () => {
    const { vt, surface, readline, io, printAboveRaw, openRead } = setup();
    await openRead();
    io.sinks.write("bg> ");
    expect(vt.screen()).toBe("bg> > abc");

    surface.promptRow.detachPrefix();

    expect(printAboveRaw).toHaveBeenLastCalledWith("", "");
    expect(readline.abovePrefix()).toBe("");
    expect(vt.screen()).toBe("> abc");
    expect(tail(io.sinks)).toBe("bg> ");
  });

  test("줄 경계를 넘어 열린 색이 실린 접두도 그대로 꼬리가 된다", async () => {
    const { surface, io, openRead } = setup();
    await openRead();
    io.sinks.write("\x1b[32mA\nbg> ");

    surface.promptRow.detachPrefix();

    expect(tail(io.sinks)).toBe("\x1b[32mbg> ");
  });

  test("접두가 없으면 아무것도 하지 않는다", async () => {
    const { fake, surface, printAboveRaw, openRead } = setup();
    await openRead();
    const before = fake.written.length;

    surface.promptRow.detachPrefix();

    expect(printAboveRaw).not.toHaveBeenCalled();
    expect(fake.written.length - before).toBe(0);
  });

  test("열린 읽기가 없으면 꼬리를 건드리지 않는다", () => {
    const { surface, io, printAboveRaw } = setup();
    io.sinks.write("t");

    surface.promptRow.detachPrefix();

    expect(printAboveRaw).not.toHaveBeenCalled();
    expect(tail(io.sinks)).toBe("t");
  });

  test("읽기가 그려지기 전에 꼬리에 들어간 조각은 접두로 바뀐다(프롬프트 그리기가 그 행을 지웠다)", async () => {
    const { fake, surface, io } = setup({ asyncWrite: true });
    void surface.promptRow.read("> ", { cancelable: true });
    // `readline.read()`까지는 진행했지만(짧은 빈 꼬리는 flush를 기다리지 않는다) 아직 그려지지 않았다.
    await tick();
    io.sinks.write("x");
    expect(tail(io.sinks)).toBe("x");
    fake.flush();
    io.sinks.write("bg> ");
    fake.flush();

    surface.promptRow.detachPrefix();

    expect(tail(io.sinks)).toBe("bg> ");
  });

  test("현재 io가 없으면 무동작이다", () => {
    const { surface } = setupSurface();

    expect(() => surface.promptRow.detachPrefix()).not.toThrow();
  });

  test("옮긴 뒤 Enter로 읽기가 끝나도 화면 행에 접두가 남지 않는다", async () => {
    const { fake, vt, surface, io, openRead } = setup();
    const { line } = await openRead();
    io.sinks.write("bg> ");
    surface.promptRow.detachPrefix();

    fake.type("\r");
    await expect(line).resolves.toBe("abc");

    expect(vt.lines()).toEqual(["> abc"]);
    expect(tail(io.sinks)).toBe("bg> ");
  });
});

describe("detachPrefix 핸들(이슈 prompt-row-followups/07)", () => {
  function setup() {
    const { fake, surface } = setupSurface({ cols: 40 });
    const vt = attachScreen(fake);
    return { fake, vt, surface, io: surface.openIo() };
  }

  /**
   * `> abc` 읽기 위에 배경 출력 `bg> `를 접두로 쓰고, 꼬리로 뗀 뒤 Enter로 읽기를 끝낸다(D6 직전 상태). 뗀 핸들을
   * 돌려준다.
   */
  async function detachAndEnter(s: ReturnType<typeof setup>) {
    const line = s.surface.promptRow.read("> ", { cancelable: true });
    await tick();
    s.fake.flush();
    s.fake.type("abc");
    s.fake.flush();
    s.io.sinks.write("bg> ");
    const handle = s.surface.promptRow.detachPrefix();
    s.fake.type("\r");
    await expect(line).resolves.toBe("abc");
    s.fake.flush();
    return handle;
  }

  test("[R2] 뗀 접두를 읽기 없이 화면에 그리고 꼬리는 그대로 둔다", async () => {
    const s = setup();
    const handle = await detachAndEnter(s);

    handle.draw();
    s.fake.flush();

    expect(s.vt.lines()).toEqual(["> abc", "bg>"]); // VtScreen.lines()는 행 끝 공백을 자른다
    expect(tail(s.io.sinks)).toBe("bg> ");
  });

  test("[R2] 그린 뒤 breakLine은 그 행을 끝내는 개행을 낸다(화면과 꼬리가 같다)", async () => {
    const s = setup();
    const handle = await detachAndEnter(s);
    const before = s.fake.written.length;

    handle.draw();
    s.surface.promptRow.breakLine();

    expect(s.fake.written.slice(before).join("")).toBe("bg> \r\n");
  });

  test("[R2] 꼬리가 비었으면 아무것도 쓰지 않는다", () => {
    const { fake, surface } = setup();
    const before = fake.written.length;

    surface.promptRow.detachPrefix().draw();

    expect(fake.written.length).toBe(before);
  });

  test("[R2] 묶인 io가 닫혔으면 무동작이다", async () => {
    const s = setup();
    const handle = await detachAndEnter(s);
    s.io.close();
    const before = s.fake.written.length;

    handle.draw();

    expect(s.fake.written.length).toBe(before);

    // io 없이 뗀 핸들도 던지지 않는다.
    const { surface } = setupSurface();
    expect(() => surface.promptRow.detachPrefix().draw()).not.toThrow();
  });

  test("[R2] 새 io가 현재여도 옛 io에 묶인 핸들은 새 io 꼬리를 그리지 않는다", async () => {
    const s = setup();
    const handle = await detachAndEnter(s);
    s.io.close();
    const next = s.surface.openIo();
    next.sinks.write("zz");
    s.fake.flush();
    const before = s.fake.written.length;

    handle.draw();

    expect(s.fake.written.length).toBe(before);
  });
});

describe("notice(구 writeNotice)", () => {
  test("`warning`은 노랑으로 감싼 한 줄을 낸다", () => {
    const { fake, surface } = setupSurface();

    surface.promptRow.notice("경고", "warning");

    expect(fake.written.join("")).toBe("\x1b[33m경고\x1b[0m\r\n");
  });

  test("`info`는 청록으로 감싼 한 줄을 낸다", () => {
    const { fake, surface } = setupSurface();

    surface.promptRow.notice("리셋", "info");

    expect(fake.written.join("")).toBe("\x1b[36m리셋\x1b[0m\r\n");
  });

  test("현재 io가 없으면 println과 같은 바이트를 낸다(RD-028 §3, 현행 유지)", () => {
    const { fake, surface } = setupSurface();

    expect(() => surface.promptRow.notice("경고", "warning")).not.toThrow();
    expect(fake.written.join("")).toBe("\x1b[33m경고\x1b[0m\r\n");
  });

  test("io가 있고 꼬리가 없으면 println과 바이트가 같고, 뒤 꼬리도 비어 있다(RD-028 §3)", () => {
    const { fake, surface } = setupSurface();
    const io = surface.openIo();

    surface.promptRow.notice("경고", "warning");

    expect(fake.written.join("")).toBe("\x1b[33m경고\x1b[0m\r\n");
    expect(tail(io.sinks)).toBe("");
  });

  test("io가 있고 꼬리가 있으면 `\\r\\n` 뒤에 안내를 쓰고 그 꼬리를 비운다(RD-028 §3, 변이 검사 ④)", () => {
    const { fake, surface } = setupSurface();
    const io = surface.openIo();
    io.sinks.write("t");

    surface.promptRow.notice("경고", "warning");

    expect(fake.written.join("")).toBe("t\r\n\x1b[33m경고\x1b[0m\r\n");
    expect(tail(io.sinks)).toBe("");
  });

  // DELTA-05(최종 리뷰 발견): SGR만 남은 꼬리(`tail() !== ""`)를 "꼬리 있음"으로 잘못 보면 불필요한 `\r\n`을
  // 선행한다(수정 전이면 이 시험이 RED).
  test("io가 있고 꼬리가 SGR만 남았으면(색 안 닫고 개행으로 끝난 출력) println과 바이트가 같다(회귀)", () => {
    const { fake, surface } = setupSurface();
    const io = surface.openIo();
    io.sinks.write("\x1b[31mred\n");
    expect(tail(io.sinks)).toBe("\x1b[31m");

    surface.promptRow.notice("경고", "warning");

    // `Readline.write`가 `\n`을 `\r\n`으로 정규화한다(`readline.ts:440-446`) — 원문의 `\n`도 `\r\n`으로 나간다.
    expect(fake.written.join("")).toBe(
      "\x1b[31mred\r\n\x1b[33m경고\x1b[0m\r\n",
    );
  });

  test("io가 있고 열린 읽기 중이면 입력줄 위에 그려지고 읽기가 다시 그려진다(sink printAboveRaw 경로)", async () => {
    const { fake, surface, readline, startRead } = setupSurface();
    const printAboveRaw = vi.spyOn(readline, "printAboveRaw");
    surface.openIo();
    const { line: read } = await startRead("> ", { cancelable: true });
    fake.type("abc");

    surface.promptRow.notice("경고", "warning");

    expect(printAboveRaw).toHaveBeenLastCalledWith(
      "\x1b[33m경고\x1b[0m\r\n",
      "",
    );
    fake.type("\r");
    await expect(read).resolves.toBe("abc");
  });
});
