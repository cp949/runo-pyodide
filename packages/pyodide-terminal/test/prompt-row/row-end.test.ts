/**
 * `createPromptRow` 행 마감 시험(RD-028 §3 규칙 표): 읽기를 끝내는 `endRead`, 꼬리 뒤 개행 `breakLine`, 화면 지우기 `clear`와
 * 그 회귀(낡은 `cursorX`·빈 행·감긴 꼬리 되감기 뒤 그리기 전 창). 조립·배출은 `../surface-setup.ts`(RD-042).
 */
import { ReadCancelledError } from "@cp949/runo-xterm-readline";
import { describe, expect, test, vi } from "vitest";
import {
  attachScreen,
  drain,
  setupSurface,
  tail,
  tick,
} from "../surface-setup";

describe("endRead(RD-028 §3 규칙 표)", () => {
  test("{screen:false}는 settle 없이 취소해 화면에 아무것도 쓰지 않는다", async () => {
    const { fake, surface, startRead } = setupSurface();
    const io = surface.openIo();
    const { line: read } = await startRead(">>> ", { cancelable: true });
    const writeSpy = vi.spyOn(io.sinks, "write");
    const before = fake.written.length;

    surface.promptRow.endRead({ screen: false });

    await expect(read).rejects.toThrow(ReadCancelledError);
    expect(fake.written.length).toBe(before);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test("settle 성공(그려진 읽기)은 대체 개행을 쓰지 않는다(벤더 바이트만)", async () => {
    const { fake, surface, startRead } = setupSurface();
    const io = surface.openIo();
    const { line: read } = await startRead(">>> ", { cancelable: true });
    fake.type("abc");
    const writeSpy = vi.spyOn(io.sinks, "write");

    surface.promptRow.endRead({ screen: true });

    await expect(read).rejects.toThrow(ReadCancelledError);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test("settle 실패 + 그리기 전 읽기(빈 꼬리)는 무조건 개행 1개를 쓴다", async () => {
    const { surface } = setupSurface({ asyncWrite: true });
    const io = surface.openIo();
    const read = surface.promptRow.read(">>> ", { cancelable: true });
    // flush하지 않는다 — 아직 그려지지 않은 상태(settle 실패를 유도, hasPendingRead()가 true).
    await tick();
    const writeSpy = vi.spyOn(io.sinks, "write");

    surface.promptRow.endRead({ screen: true });

    await expect(read).rejects.toThrow(ReadCancelledError);
    expect(writeSpy).toHaveBeenCalledExactlyOnceWith("\r\n");
  });

  test("settle 실패 + 그리기 전 읽기(꼬리 있음)는 그 꼬리에 개행을 공급하고 꼬리를 비운다(H1 수정)", async () => {
    const { surface } = setupSurface({ asyncWrite: true });
    const io = surface.openIo();
    const read = surface.promptRow.read(">>> ", { cancelable: true });
    // 그리기 전(write 콜백 대기) 상태에서는 isReading()이 거짓이라 sinks.write가 보통 경로로 꼬리에 쌓인다.
    await tick();
    io.sinks.write("abc");
    expect(tail(io.sinks)).toBe("abc");
    const writeSpy = vi.spyOn(io.sinks, "write");

    surface.promptRow.endRead({ screen: true });

    await expect(read).rejects.toThrow(ReadCancelledError);
    expect(writeSpy).toHaveBeenCalledExactlyOnceWith("\r\n");
    expect(tail(io.sinks)).toBe("");
  });

  test("settle 실패 + 열린 읽기 없음 + 꼬리 있음은 개행 1개를 쓴다", () => {
    const { surface } = setupSurface();
    const io = surface.openIo();
    io.sinks.write("abc"); // 열린 읽기 없이 꼬리만 남긴다.
    const writeSpy = vi.spyOn(io.sinks, "write");

    surface.promptRow.endRead({ screen: true });

    expect(writeSpy).toHaveBeenCalledExactlyOnceWith("\r\n");
    expect(tail(io.sinks)).toBe("");
  });

  test("settle 실패 + 열린 읽기 없음 + 꼬리 없음은 아무것도 쓰지 않는다", () => {
    const { fake, surface } = setupSurface();
    surface.openIo();

    surface.promptRow.endRead({ screen: true });

    expect(fake.written).toEqual([]);
  });

  test("현재 io가 없고 그리기 전 읽기가 있으면 readline.write로 직접 개행한다", async () => {
    const { surface, readline } = setupSurface({ asyncWrite: true });
    const io = surface.openIo();
    const read = surface.promptRow.read(">>> ", { cancelable: true });
    await tick();
    io.close();
    const writeSpy = vi.spyOn(readline, "write");

    surface.promptRow.endRead({ screen: true });

    await expect(read).rejects.toThrow(ReadCancelledError);
    expect(writeSpy).toHaveBeenCalledWith("\r\n");
  });

  test("현재 io가 없고 열린 읽기도 없으면 아무것도 쓰지 않는다", () => {
    const { fake, surface, readline } = setupSurface();
    const io = surface.openIo();
    io.close();
    const writeSpy = vi.spyOn(readline, "write");

    surface.promptRow.endRead({ screen: true });

    expect(writeSpy).not.toHaveBeenCalled();
    expect(fake.written).toEqual([]);
  });

  test("대체 개행은 sinks.write로 꼬리에 공급돼 열린 SGR이 다음 read 프롬프트에 이어진다(RD-027 변이 검사)", async () => {
    const { fake, surface, readline } = setupSurface();
    const io = surface.openIo();
    // 열린 읽기가 없는 채로 닫지 않은 색을 꼬리에 남긴다(read()를 열면 그 자리에서 꼬리를 리셋해 버려 관찰할 수 없다).
    io.sinks.write("\x1b[32mG");

    // 열린 읽기가 없으므로 settle은 실패하고("열린 읽기 없음" 상태) 꼬리가 있으므로 개행한다.
    surface.promptRow.endRead({ screen: true });

    const readSpy = vi.spyOn(readline, "read");
    const read = surface.promptRow.read(">>> ", { cancelable: true });
    await drain(fake);

    // `readline.write`로 직접 개행했다면(우회) 꼬리 추적기를 거치지 않아 이 값이 다른 문자열이 된다.
    // `sinks.write`를 거치면 개행이 꼬리 추적기에 열린 색을 이어 붙인 값으로 반영된다.
    expect(readSpy.mock.calls.at(-1)?.[0]).toBe("\x1b[32m\x1b[0m>>> ");
    fake.type("1\r");
    await expect(read).resolves.toBe("1");
  });
});

describe("breakLine(RD-028 §3 규칙 표)", () => {
  test("꼬리가 있으면 개행하고 꼬리를 비운다", () => {
    const { fake, surface } = setupSurface();
    const io = surface.openIo();
    io.sinks.write("t");

    surface.promptRow.breakLine();

    expect(fake.written.join("")).toBe("t\r\n");
    expect(tail(io.sinks)).toBe("");
  });

  test("꼬리가 없으면 아무것도 쓰지 않는다", () => {
    const { fake, surface } = setupSurface();
    surface.openIo();

    surface.promptRow.breakLine();

    expect(fake.written.length).toBe(0);
  });

  test("현재 io가 없으면 무동작이다", () => {
    const { surface } = setupSurface();

    expect(() => surface.promptRow.breakLine()).not.toThrow();
  });

  test("cursorX와 무관하다(변이 검사 ②): 꼬리가 없으면 커서가 행 머리가 아니어도 쓰지 않는다", () => {
    const { fake, surface } = setupSurface();
    surface.openIo();
    fake.screen.cursorX = 3;

    surface.promptRow.breakLine();

    expect(fake.written.length).toBe(0);
  });

  test("cursorX와 무관하다(변이 검사 ②): 꼬리가 있으면 커서가 행 머리여도 개행한다", () => {
    const { fake, surface } = setupSurface();
    const io = surface.openIo();
    fake.screen.cursorX = 0;
    io.sinks.write("t");

    surface.promptRow.breakLine();

    expect(fake.written.join("")).toBe("t\r\n");
    expect(tail(io.sinks)).toBe("");
  });

  // DELTA-05(최종 리뷰 발견): 색을 안 닫고 개행으로 끝난 출력은 `createOutputTail`의 `carried`에 열린 SGR이
  // 남아 `tail() !== ""`이지만 화면에는 보이는 글자가 없다. `tail() !== ""` 판정(수정 전)이면 이 시험이 RED다
  // (불필요한 개행을 쓴다).
  test("SGR만 남은 꼬리(색 안 닫고 개행으로 끝난 출력)는 보이는 글자가 없어 개행하지 않는다(회귀)", () => {
    const { fake, surface } = setupSurface();
    const io = surface.openIo();
    io.sinks.write("\x1b[31mred\n");
    expect(tail(io.sinks)).toBe("\x1b[31m");
    const before = fake.written.length;

    surface.promptRow.breakLine();

    expect(fake.written.slice(before)).toEqual([]);
    expect(tail(io.sinks)).toBe("\x1b[31m");
  });

  test("SGR만 남은 꼬리에서 breakLine()을 연속으로 불러도 빈 행이 쌓이지 않는다(회귀 재현 형태 유지)", () => {
    const { fake, surface } = setupSurface();
    const io = surface.openIo();
    io.sinks.write("\x1b[31mred\n");
    const before = fake.written.length;

    surface.promptRow.breakLine();
    surface.promptRow.breakLine();

    expect(fake.written.slice(before)).toEqual([]);
    expect(tail(io.sinks)).toBe("\x1b[31m");
  });

  test("보이는 글자가 있는 SGR 이음(RD-027)은 회귀 없이 그대로 개행한다(연동 회귀 방지)", () => {
    const { fake, surface } = setupSurface();
    const io = surface.openIo();
    io.sinks.write("\x1b[32mG");
    const before = fake.written.length;

    surface.promptRow.breakLine();

    expect(fake.written.slice(before).join("")).toBe("\r\n");
    // "\r\n"을 sink로 먹여도 줄 시작에 이어받은 SGR(`carried`)은 그대로 남는다(design.md §3 각주 정정, DELTA-05) —
    // 빈 문자열이 되지는 않지만 `leavesVisibleText`로는 여전히 "보이는 글자 없음"이라 다음 판정은 올바르다.
    expect(tail(io.sinks)).toBe("\x1b[32m");
  });
});

describe("clear", () => {
  test("화면·스크롤백을 지우고 현재 io의 꼬리를 리셋한다", () => {
    const { fake, surface } = setupSurface();
    const io = surface.openIo();
    io.sinks.write("t");

    surface.promptRow.clear();

    expect(fake.written).toContain("\x1b[H\x1b[2J\x1b[3J");
    expect(tail(io.sinks)).toBe("");
  });

  test("현재 io가 없어도 화면은 지운다", () => {
    const { fake, surface } = setupSurface();

    expect(() => surface.promptRow.clear()).not.toThrow();
    expect(fake.written).toContain("\x1b[H\x1b[2J\x1b[3J");
  });
});

// H1 수정 확인(RD-028 DELTA-02, design.md F3): xterm의 실제 write 콜백은 `setTimeout`으로 파싱을 미루므로, 같은
// 태스크에서 sink에 쓴 뒤 곧바로 읽는 `cursorX`는 아직 그 쓰기를 반영하지 못한 낡은 값이다. 가짜 터미널은 `cursorX`를
// 시험이 지정한 값 그대로 두고(write로 갱신하지 않는다) 그 낡음을 흉내 낸다. 새 규칙(현재 io 꼬리 기준)은 이 낡은
// `cursorX`를 아예 읽지 않으므로 개행을 빠뜨리지 않는다. 구현 전 코드(커서 기준 대체 개행 분기)에 대한 RED 재현은
// DELTA-02 결과에 적었다.
describe("H1 수정 확인: 꼬리 기준이라 xterm 파싱 전 낡은 cursorX와 무관하다", () => {
  test("breakLine(): sink에 쓴 직후의 낡은 cursorX(0)로도 꼬리가 있으면 개행한다", () => {
    const { fake, surface } = setupSurface();
    const io = surface.openIo();
    fake.screen.cursorX = 0; // xterm이 아직 파싱하지 않은 낡은 값(같은 태스크의 write 직후).
    io.sinks.write("abc"); // 현재 io 꼬리는 "abc"다.

    surface.promptRow.breakLine();

    expect(fake.written.join("")).toContain("\r\n");
  });

  test("endRead({screen:true}): 열린 읽기가 없을 때도 낡은 cursorX(0)로 꼬리가 있으면 개행한다", () => {
    const { fake, surface } = setupSurface();
    const io = surface.openIo();
    fake.screen.cursorX = 0;
    io.sinks.write("abc");

    surface.promptRow.endRead({ screen: true });

    expect(fake.written.join("")).toContain("\r\n");
  });
});

describe("빈 행(의도, RD-028 Q1): 그려진 읽기 settle과 같은 행 수를 낸다", () => {
  test("빈 꼬리·행 머리에서 연 cancelable 읽기를 그리기 전에 abort로 끝내면 개행 하나가 그려진다", async () => {
    const { fake, surface } = setupSurface({ asyncWrite: true });
    surface.openIo();
    const controller = new AbortController();

    const read = surface.promptRow.read("", {
      cancelable: true,
      signal: controller.signal,
      history: false,
    });
    // 그리기 전(write 콜백 대기) 창에서 abort → endRead(그리기 전 읽기가 있었으므로 무조건 개행).
    await tick();
    controller.abort();
    surface.promptRow.endRead({ screen: true });
    await expect(read).rejects.toThrow(ReadCancelledError);
    await drain(fake);

    // 의도: 빈 꼬리에서도 대체 개행 한 줄이 그려진다("\r\n" 하나, 중복 없음) — 그려진 읽기의 settle과 같은 행 수(Q1).
    expect(fake.written.join("")).toBe("\r\n");
  });
});

describe("감긴 꼬리 되감기 뒤 그리기 전 창 endRead(이슈 prompt-row-followups/03)", () => {
  /** cols 10 화면에 25글자 꼬리(3행으로 감김)를 남기고 `>>> ` 읽기를 `rewindTail` 뒤까지 연다(그리기는 미룬다). */
  async function openAfterRewind() {
    const { fake, surface } = setupSurface({ cols: 10, asyncWrite: true });
    const vt = attachScreen(fake);
    const io = surface.openIo();
    io.sinks.write(`${"a".repeat(10)}${"b".repeat(10)}ccccc`);
    fake.flush();
    // xterm이 감은 행(절대 행 1·2)을 화면 모델에 알린다.
    fake.screen.wrappedRows = new Set([1, 2]);
    const read = surface.promptRow.read(">>> ", { cancelable: true });
    fake.flush(); // rewindTail의 flush 대기를 푼다.
    await tick(); // `\x1b[2A` 뒤 readline.read()가 write 콜백을 기다리는 상태(그리기 전 창).
    return { fake, vt, surface, io, read };
  }

  test("그리기 전 창에서 endRead → notice 하면 꼬리 행이 그대로 남고 안내가 그 아래 행에서 시작한다", async () => {
    const { vt, surface, read } = await openAfterRewind();
    expect(vt.cursor()).toEqual([0, 5]);

    surface.promptRow.endRead({ screen: true });
    await expect(read).rejects.toThrow(ReadCancelledError);
    surface.promptRow.notice("reset", "info");

    expect(vt.lines().slice(0, 4)).toEqual([
      "aaaaaaaaaa",
      "bbbbbbbbbb",
      "ccccc",
      "reset",
    ]);
  });

  test("대조: 그려진 읽기에서 endRead → notice 하면 꼬리 행이 그대로 남는다(settle 경로, 커서를 따로 내리지 않는다)", async () => {
    const { fake, vt, surface, read } = await openAfterRewind();
    fake.flush(); // 그리기 콜백을 배출한다.

    surface.promptRow.endRead({ screen: true });
    await expect(read).rejects.toThrow(ReadCancelledError);
    surface.promptRow.notice("reset", "info");

    expect(vt.lines().slice(0, 4)).toEqual([
      "aaaaaaaaaa",
      "bbbbbbbbbb",
      "ccccc>>>",
      "reset",
    ]);
    expect(fake.written.some((text) => text.includes("\x1b[2B"))).toBe(false);
  });

  test("되감은 읽기가 끝난 뒤 되감지 않은 그리기 전 읽기의 endRead는 커서를 내리지 않는다(되감은 행 수가 남지 않는다)", async () => {
    const { fake, surface, read } = await openAfterRewind();
    surface.promptRow.endRead({ screen: false });
    await expect(read).rejects.toThrow(ReadCancelledError);
    const next = surface.promptRow.read(">>> ", { cancelable: true });
    await tick(); // 빈 꼬리는 되감지 않는다 — 그리기 전 창.
    const before = fake.written.length;

    surface.promptRow.endRead({ screen: true });

    await expect(next).rejects.toThrow(ReadCancelledError);
    expect(fake.written.slice(before)).toEqual(["\r\n"]);
  });

  test("flush를 기다리는 사이 abort되면 되감은 행만큼 다시 내려 커서를 abort 시점 위치로 돌린다(이슈 prompt-row-followups/04)", async () => {
    // 화면 모델을 쓰기로 갱신하지 않는다 — xterm이 `""` 콜백 시점에 뒤 `\r\n`을 아직 파싱하지 않은 버퍼(꼬리 끝 행)를 모사한다.
    const { fake, surface } = setupSurface({ cols: 10, asyncWrite: true });
    const io = surface.openIo();
    io.sinks.write(`${"a".repeat(10)}${"b".repeat(10)}ccccc`);
    fake.flush();
    fake.screen.cursorY = 2;
    fake.screen.wrappedRows = new Set([1, 2]);
    const controller = new AbortController();
    const read = surface.promptRow.read("", {
      cancelable: true,
      signal: controller.signal,
    });
    controller.abort();
    surface.promptRow.endRead({ screen: true }); // 실행창 onAbort: 열린 읽기 없음 + 꼬리 있음 → `\r\n`.
    fake.flush();

    await expect(read).resolves.toBeNull();
    const up = fake.written.indexOf("\x1b[2A");
    expect(up).toBeGreaterThan(fake.written.indexOf("\r\n"));
    expect(fake.written.slice(up + 1)).toEqual(["\x1b[2B"]);
  });

  test("flush를 기다리는 사이 abort됐어도 되감지 않았으면 아무것도 더 쓰지 않는다", async () => {
    const { fake, surface } = setupSurface({ cols: 10, asyncWrite: true });
    const io = surface.openIo();
    io.sinks.write("x".repeat(25));
    fake.flush();
    const controller = new AbortController();
    const read = surface.promptRow.read("", {
      cancelable: true,
      signal: controller.signal,
    });
    controller.abort();
    const before = fake.written.length;
    fake.flush();

    await expect(read).resolves.toBeNull();
    expect(fake.written.slice(before)).toEqual([]);
  });
});
