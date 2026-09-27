/**
 * `createRepl`의 선택 복사 배선 시험(RD-017 DELTA-03). `packages/pyodide-terminal/src/selection-copy.ts`(DELTA-02)의
 * `decideKey`·`createSelectionCopy` 자체는 여기서 다시 보지 않는다 — `createRepl`이 벤더 `Readline`의 `onKeyEvent`에 실제로
 * 연결했는지, `dispose()` 순서, `!isolated`·`setCopyOnSelect`·`copyOnSelect`·`onCopy`가 문서(DELTA-03.md "## 계획")대로인지만
 * 본다. `createRepl`이 `writeText`를 주입받지 않으므로(옵션 없음) `navigator.clipboard`를 jsdom에 심어 관찰한다.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createRepl, type CopyResult } from "../../src/index";
import { createFakeTerminal } from "@repo/pyodide-testkit/fake-terminal";
import {
  createWorker,
  startSession,
  startRead,
  startInputRead,
  takeResponse,
  peek,
  slots,
  echoes,
  observe,
  trackHandle,
  type Session,
  useReplHarness,
} from "./harness";

useReplHarness();

describe("선택 복사 배선(RD-017 DELTA-03)", () => {
  let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
  const originalClipboard = navigator.clipboard;

  beforeEach(() => {
    writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      configurable: true,
    });
  });

  test("실행 중(pythonRunning) 선택 있는 Ctrl+C는 SIGINT 없이 복사만 한다", () => {
    const session = startSession();
    session.fake.select("hello");

    const handled = session.fake.keyDown({ key: "c", ctrlKey: true });

    // 훅이 소비했다는 뜻(벤더 `handleKeyEvent`가 xterm에 `false`를 돌려준다) — 실제 브라우저에서는 ETX 자체가
    // 발생하지 않으므로 이 시험도 `fake.type("\x03")`를 별도로 부르지 않는다.
    expect(handled).toBe(false);
    expect(slots(session).seq).toBe(0);
    expect(echoes(session)).toBe(0);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  test("`>>> ` 읽기 중 `abc` 입력 뒤 선택 있는 Ctrl+C는 읽기를 건드리지 않고 복사만 한다", async () => {
    const session = startSession();
    const { line } = await startRead(session);
    session.fake.type("abc");
    session.fake.select("sel");
    const outcome = observe(line);

    const handled = session.fake.keyDown({ key: "c", ctrlKey: true });

    expect(handled).toBe(false);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(outcome().state).toBe("pending");

    session.fake.type("\r");
    await expect(line).resolves.toBe("abc");
  });

  test("`input()` 읽기 중 선택 있는 Ctrl+C는 취소하지 않고 복사만 한다", async () => {
    const session = startSession();
    session.workerRpc.notify("write", "x: ");
    await startInputRead(session);
    session.fake.type("abc");
    session.fake.select("sel");

    const handled = session.fake.keyDown({ key: "c", ctrlKey: true });

    expect(handled).toBe(false);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(peek(session)).toEqual({ kind: "none" });

    session.fake.type("\r");
    await expect(takeResponse(session)).resolves.toEqual({
      kind: "line",
      text: "abc",
    });
  });

  test("선택 없는 Ctrl+C는 기존 동작(RD-007) 그대로다", () => {
    const session = startSession();

    const handled = session.fake.keyDown({ key: "c", ctrlKey: true });
    // 선택이 없으면 훅이 pass를 돌려줘 vendor가 원본대로 처리한다 — 실제 브라우저의 ETX 도착을 흉내 낸다.
    session.fake.type("\x03");

    expect(handled).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(echoes(session)).toBe(1);
    expect(slots(session).seq).toBe(1);
  });

  test("dispose 뒤 Ctrl+C는 벤더 원본 경로로 돌아가고 복사하지 않는다", () => {
    const session = startSession();
    session.fake.select("hello");
    // dispose 전에는 정상적으로 복사가 걸려야 한다(배선 전이면 여기서 이미 RED).
    expect(session.fake.keyDown({ key: "c", ctrlKey: true })).toBe(false);
    expect(writeText).toHaveBeenCalledTimes(1);

    session.handle.dispose();
    session.fake.select("world");
    const handled = session.fake.keyDown({ key: "c", ctrlKey: true });

    // dispose 뒤에는 훅이 스스로를 끄고 벤더 원본 경로(true, xterm 기본 처리)로 돌아간다 — 추가 복사 없음.
    expect(handled).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  test("!isolated에서도 Ctrl+C 복사가 동작한다", () => {
    vi.stubGlobal("crossOriginIsolated", false);
    const fake = createFakeTerminal();
    const handle = createRepl({ terminal: fake.term, createWorker });
    trackHandle(handle);
    fake.select("hello");

    const handled = fake.keyDown({ key: "c", ctrlKey: true });

    expect(handled).toBe(false);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  test("setCopyOnSelect(false) 뒤에는 드래그(mouseup)로 복사되지 않는다", () => {
    const session = startSession({}, { withElement: true });
    session.fake.select("dragged");
    session.handle.setCopyOnSelect(false);
    const element = session.fake.term.element as HTMLElement;

    element.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    element.ownerDocument.dispatchEvent(new MouseEvent("mouseup"));

    expect(writeText).not.toHaveBeenCalled();
  });

  /** 드래그(mousedown → 선택 → mouseup)를 흉내 낸다. 자동 복사는 `mouseup`에서 걸린다. */
  function drag(session: Session, selected: string) {
    session.fake.select(selected);
    const element = session.fake.term.element as HTMLElement;
    element.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    element.ownerDocument.dispatchEvent(new MouseEvent("mouseup"));
  }

  test("copyOnSelect 옵션은 createRepl에서 선택 복사 정책까지 전달된다(기본은 켜짐, false는 끔)", () => {
    const enabled = startSession({}, { withElement: true });
    drag(enabled, "dragged");
    // 기본값(옵션 생략)이면 드래그 뒤 자동 복사한다. 이 대조가 있어야 아래 false의 무복사가 옵션 전달을 뜻한다.
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("dragged");

    const disabled = startSession(
      { copyOnSelect: false },
      { withElement: true },
    );
    drag(disabled, "dragged");
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  test("onCopy 옵션은 createRepl에서 선택 복사 결과(성공 chars·실패 error)를 받는다", async () => {
    const results: CopyResult[] = [];
    const session = startSession(
      { onCopy: (result) => results.push(result) },
      { withElement: true },
    );

    drag(session, "한글abc");
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toEqual({ ok: true, chars: 5 });

    const failure = new Error("클립보드 거부");
    writeText.mockRejectedValueOnce(failure);
    drag(session, "x");
    await vi.waitFor(() => expect(results).toHaveLength(2));
    expect(results[1]).toEqual({ ok: false, error: failure });
  });
});
