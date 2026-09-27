/**
 * `createRepl`의 Tab 완성 배선 시험(RD-015 DELTA-04). worker 역할 rpc의 `complete` 핸들러를 가짜로 두고, `input()` 읽기에서
 * 완성을 요청하지 않는지, 완성 왕복 중 취소가 SIGINT를 보내는지, 리셋을 넘어 옛 세션의 Tab이 새 세션에 새지 않는지 본다.
 */
import { describe, expect, test, vi } from "vitest";
import { Readline } from "@cp949/runo-xterm-readline";
import { type SourceCompletion } from "../../src/worker/complete-source";
import {
  startSession,
  startResettableSession,
  startRead,
  startInputRead,
  takeResponse,
  slots,
  echoes,
  tick,
  waitFor,
  useReplHarness,
} from "./harness";

useReplHarness();

describe("Tab 완성 배선(RD-015 DELTA-04)", () => {
  test("`input()` 읽기 중 Tab은 complete를 요청하지 않고 \\t도 넣지 않는다(그릴링 확정 6)", async () => {
    const complete = vi.fn();
    const session = startSession({}, {}, { complete });

    await startInputRead(session);
    session.fake.type("ab\tcd\r");
    const response = await takeResponse(session);

    expect(complete).not.toHaveBeenCalled();
    expect(response).toEqual({ kind: "line", text: "abcd" });
  });

  test("프롬프트 취소(Ctrl+C) 중 완성 요청이 있으면 SIGINT를 1회 보낸다", async () => {
    // 응답하지 않는 completion 요청(왕복 중 취소를 관찰하려면 requesting이 계속 참이어야 한다).
    const complete = vi.fn(() => new Promise<SourceCompletion>(() => {}));
    const session = startSession({}, {}, { complete });

    const { line } = await startRead(session);
    session.fake.type("os.pa");
    session.fake.type("\t");
    await waitFor(() => complete.mock.calls.length > 0);

    const before = slots(session).seq;
    session.fake.type("\x03");
    await expect(line).resolves.toBeNull();

    // cancelable Ctrl+C는 벤더가 직접 null로 끝낸다(setCtrlCHandler를 거치지 않는다) — 이 SIGINT는
    // tabReader의 readEnded(null) → interruptCompletion() 경로에서만 나온다.
    await waitFor(() => slots(session).seq === before + 1);
    expect(slots(session).signal).toBe(2);
    expect(echoes(session)).toBe(0);
  });

  test("세션 리셋 뒤 새 세션에서 Tab이 한 번만 적용된다(C11a 대응)", async () => {
    const complete = vi.fn(async (): Promise<SourceCompletion> => ({
      completions: ["os.path"],
      start: 0,
    }));
    const session = startResettableSession({}, {}, { complete });

    const { line: l1 } = await startRead(session);
    session.fake.type("y = 1\r");
    await l1;

    session.handle.reset();
    await waitFor(() => session.onStatus.mock.calls.at(-1)?.[0] === "loading");

    const { line: l2 } = await startRead(session);
    session.fake.type("os.pa");
    session.fake.type("\t");
    await waitFor(() => complete.mock.calls.length > 0);
    await tick();

    expect(complete).toHaveBeenCalledTimes(1);
    session.fake.type("\r");
    await expect(l2).resolves.toBe("os.path");
  });

  test("리셋(terminate()) 중 큐에 남은 Tab이 터미널에 쓰지 않는다(DELTA-04a)", async () => {
    // worker가 끝내 응답하지 않는 진행 중 요청을 흉내 낸다 — reset() 시점까지 requesting을 참으로 둔다.
    const complete = vi.fn(() => new Promise<SourceCompletion>(() => {}));
    const session = startResettableSession({}, {}, { complete });
    // `Readline.prototype.editInsert`(공개 훅)만 잡는다 — 일반 타이핑은 내부 `state.editInsert`를
    // 직접 부르므로(readline.ts:503·529 등) 여기 걸리지 않는다. tab-reader가 직접 부르는 경로만 본다.
    const editInsertSpy = vi.spyOn(Readline.prototype, "editInsert");

    await startRead(session);
    session.fake.type("os.p");
    session.fake.type("\t"); // 요청 #1 진행 중(응답 없음)
    session.fake.type("\t"); // 큐(second=true)
    await waitFor(() => complete.mock.calls.length > 0);
    editInsertSpy.mockClear();
    // 요청이 진행되는 동안 공백을 더 입력해 버퍼를 "os.p "로 만든다 — 리셋 뒤 큐가 처리될 때
    // 스템이 비어 `indent` 분기(공백 삽입)로 가게 한다(리뷰 재현).
    session.fake.type(" ");

    session.handle.reset();
    // rpc.dispose()의 reject → .catch().finally(drainQueue) → handleTab이 흐르는 마이크로태스크를
    // 모두 지나가게 한다.
    await tick();
    await tick();

    // 리셋된 옛 세션의 tabReader가 끝나지 않았다면(수정 전 버그) 여기서 공백을 삽입해
    // RESET_NOTICE 뒤에 엉뚱한 내용이 쓰인다.
    expect(editInsertSpy).not.toHaveBeenCalled();
  });
});

describe("completionPopover 옵션 게이트(RD-049 DELTA-02)", () => {
  test("생략(기본) — 두 번째 Tab이 텍스트 목록을 띄운다(popover DOM 없음)", async () => {
    const complete = vi.fn(async (): Promise<SourceCompletion> => ({
      completions: ["os.path", "os.popen"],
      start: 0,
    }));
    const session = startSession({}, { withElement: true }, { complete });

    await startRead(session);
    session.fake.type("os.p");
    session.fake.type("\t");
    await waitFor(() => complete.mock.calls.length > 0);
    await tick();
    session.fake.type("\t");
    await waitFor(() => complete.mock.calls.length > 1);
    await tick();

    expect(session.bytes()).toContain("os.path");
    expect(
      session.fake.term.element?.querySelector(".runo-completion-popover"),
    ).toBeNull();
  });

  test("`true` — 두 번째 Tab이 텍스트 목록 대신 popover DOM을 띄운다", async () => {
    const complete = vi.fn(async (): Promise<SourceCompletion> => ({
      completions: ["os.path", "os.popen"],
      start: 0,
    }));
    const session = startSession(
      { completionPopover: true },
      { withElement: true },
      { complete },
    );

    await startRead(session);
    session.fake.type("os.p");
    session.fake.type("\t");
    await waitFor(() => complete.mock.calls.length > 0);
    await tick();
    session.fake.type("\t");
    await waitFor(() => complete.mock.calls.length > 1);
    await tick();

    expect(
      session.fake.term.element?.querySelector(".runo-completion-popover"),
    ).not.toBeNull();
  });

  test("reset() 뒤 새 세션에서도 popover가 다시 열린다(옛 인스턴스 dispose로 막히지 않는다)", async () => {
    const complete = vi.fn(async (): Promise<SourceCompletion> => ({
      completions: ["os.path", "os.popen"],
      start: 0,
    }));
    const session = startResettableSession(
      { completionPopover: true },
      { withElement: true },
      { complete },
    );

    await startRead(session);
    session.fake.type("os.p");
    session.fake.type("\t");
    await waitFor(() => complete.mock.calls.length > 0);
    await tick();
    session.fake.type("\t");
    await waitFor(() => complete.mock.calls.length > 1);
    await tick();
    expect(
      session.fake.term.element?.querySelector(".runo-completion-popover"),
    ).not.toBeNull();

    session.handle.reset();
    await waitFor(() => session.onStatus.mock.calls.at(-1)?.[0] === "loading");

    await startRead(session);
    session.fake.type("os.p");
    session.fake.type("\t");
    await waitFor(() => complete.mock.calls.length > 2);
    await tick();
    session.fake.type("\t");
    await waitFor(() => complete.mock.calls.length > 3);
    await tick();

    expect(
      session.fake.term.element?.querySelector(".runo-completion-popover"),
    ).not.toBeNull();
  });
});
