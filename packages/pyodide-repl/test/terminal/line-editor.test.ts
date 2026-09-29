/**
 * `createLineEditor` 시험(`docs/design/06-editing.md` 6.8, `docs/design/07-tab-completion.md` 7.6).
 * 규칙 ID(E0~E11·C1·W4)는 `line-editor.ts` 주석과 위 두 절의 번호를 따른다.
 *
 * 실제 `createTerminalSurface`(`promptRow.read`) + `createFakeTerminal({ asyncWrite: true })`로 본다.
 * - autoIndent·blockHistory·tabReader 세 정책의 합성(`begin`).
 * - 종료 훅(`end`·`dispose`).
 *
 * 옵션 합성을 순수 함수로 따로 시험하던 옛 파일(삭제됨, RD-029)의 규칙(E3·E4)은 이 파일에서 재현한다.
 * 세 정책이 실제로 내는 `ReplReadOptions`를 쓴다.
 *
 * 세 정책은 서로 다른 키 종류만 처리한다(E-a, 6.8).
 * 그래서 `onKey`의 "먼저 소비한 쪽에서 멈춘다" 규칙은 실제 모듈로 관측되지 않는다(운영에서 충돌 0건인 전제와 같다).
 * 대신 각 정책이 자기 몫의 키를 처리하는지 확인한다.
 */
import { describe, expect, test, vi } from "vitest";
import { tick } from "@repo/pyodide-testkit/async";
import { asVendorReadline } from "@cp949/runo-pyodide-terminal/test-utils";
import {
  createCompletionPopover,
  type CompletionPopover,
} from "../../src/terminal/completion-popover";
import type { SourceCompletion } from "../../src/worker/complete-source";
import { createLineEditor, type ReadEnd } from "../../src/terminal/line-editor";
import { setupLineEditor } from "./line-editor-setup";

/** 배선만 보는 popover 목(mock, RD-049). `onKeyResult`가 `true`면 열려서 키를 항상 소비하는 상태를 흉내 낸다. */
function fakePopover(onKeyResult = false): CompletionPopover {
  return {
    isOpen: false,
    open: vi.fn(),
    close: vi.fn(),
    onKey: vi.fn(() => onKeyResult),
    dispose: vi.fn(),
    onApplied: vi.fn(),
  };
}

/** 지연 제어 가능한 `SourceCompletion` promise. 시험이 원하는 시점에 `resolve`를 부른다. */
function deferredCompletion() {
  let resolve!: (value: SourceCompletion) => void;
  const promise = new Promise<SourceCompletion>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 기본 옵션(popover 없음)으로 `setupLineEditor()`를 부른다. */
function setup() {
  return setupLineEditor();
}

describe("createLineEditor", () => {
  test("[E0] popover가 composeOptions 맨 앞이라 blockHistory보다 먼저 ↑를 받는다", async () => {
    const popover = fakePopover(true); // 열린 것처럼 항상 소비한다(K1 흉내).
    const { fake, startRead } = setupLineEditor({ popover: () => popover });
    // pendingBlock이 있는 단일 줄 읽기다. popover가 없으면 blockHistory.onKey가 이 ↑를 삼킨다.
    // 반환값이 같아 소비 여부로는 순서가 관측되지 않는다.
    // popover가 뒤로 밀리면 blockHistory가 먼저 소비해 popover.onKey가 전혀 불리지 않는다.
    // 그 차이로 순서를 본다.
    await startRead("if True:");
    fake.type("\x1b[A"); // ArrowUp

    expect(popover.onKey).toHaveBeenCalledTimes(1);
  });

  test("[C1] end 4종 모두 popover.close()를 부른다", () => {
    const results: ReadEnd[] = [
      { kind: "line", line: "x" },
      { kind: "cancel" },
      { kind: "eof" },
      { kind: "taken" },
    ];
    for (const result of results) {
      const popover = fakePopover();
      const { lineEditor } = setupLineEditor({ popover: () => popover });
      lineEditor.end(result);
      expect(popover.close).toHaveBeenCalledTimes(1);
    }
  });

  test("[C1] dispose는 popover.close()·popover.dispose()를 부른다", () => {
    const popover = fakePopover();
    const { lineEditor } = setupLineEditor({ popover: () => popover });
    lineEditor.dispose(false);
    expect(popover.close).toHaveBeenCalledTimes(1);
    expect(popover.dispose).toHaveBeenCalledTimes(1);
  });

  test("[W4] 배경 출력 재그리기 대기 중 열림 — 그 재그리기의 쓰기 파싱(C2)이 popover를 닫는다(fake asyncWrite)", async () => {
    const { fake, popover, startRead } = setupLineEditor({
      withElement: true,
      popover: (fake, readline) => createCompletionPopover(fake.term, readline),
    });
    if (popover === undefined) throw new Error("popover가 없다");
    await startRead();

    // 배경 출력(재그리기) 하나를 큐에 남긴다. asyncWrite 모드에서는 flush() 전까지 파싱을 기다린다.
    fake.term.write("background output");

    popover.open(["os.path"], "");
    expect(popover.isOpen).toBe(true);

    // 큐에 남은 쓰기를 파싱한다. onWriteParsed(C2)가 발생해 popover를 닫는다.
    fake.flush();

    expect(popover.isOpen).toBe(false);
  });

  test("[E1] autoIndent 상태는 편집기 하나의 수명(세션) 동안 유지된다", () => {
    const { lineEditor } = setup();
    // pending에 8칸 들여쓰기 줄이 있으면 autoIndent가 그 폭을 lastUsedIndentation으로 학습한다. begin의 부작용이다.
    lineEditor.begin("if True:\n        pass");

    // 같은 편집기의 새 ":"-끝 블록은 학습한 8칸을 쓴다. 4칸 기본값이 아니다.
    const options = lineEditor.begin("if True:");
    expect(options.prefill).toBe("        ");
  });

  test("[E1] 새 편집기(새 세션)는 autoIndent 상태를 이어받지 않는다", () => {
    const { readline } = setup();
    const deps = {
      complete: () => new Promise<SourceCompletion>(() => {}),
      interruptCompletion: () => {},
    };
    const editorA = createLineEditor(readline, deps);
    editorA.begin("if True:\n        pass");

    // reset()이 만드는 새 세션과 같다. 새 `createLineEditor`는 4칸(DEFAULT_UNIT)으로 시작한다.
    const editorB = createLineEditor(readline, deps);
    const options = editorB.begin("if True:");
    expect(options.prefill).toBe("    ");
  });

  test("[E2]·[E4] begin 합성에 세 정책이 모두 들어간다 — prefill은 autoIndent 것이고 Tab은 tabReader가 받는다(호출 순서는 부작용이 서로 독립이라 관측되지 않는다)", async () => {
    const { fake, readline, complete, startRead } = setup();
    const first = await startRead();
    fake.type("if True:\r");
    await first.line;

    // 이어지는 블록 읽기다. autoIndent가 낸 prefill(4칸)이 결과에 있다.
    // historyEntry는 blockHistory가 낸다. [E7] 시험이 discard() 경로로, 일반 규칙은 `block-history.test.ts`가 본다.
    await startRead("if True:");
    expect(readline.getLine()).toBe("    ");
    // tabReader도 같은 합성에 들어 있다. Tab은 다른 두 정책이 소비하지 않는 키라 tabReader가 반응한다.
    fake.type("os.pa");
    complete.mockReturnValueOnce(new Promise(() => {}));
    fake.type("\t");
    expect(complete).toHaveBeenCalledWith("    os.pa", "if True:");
  });

  test("[E3] 세 정책은 서로 다른 키만 처리한다 — ArrowUp(blockHistory)·ShiftEnter(autoIndent)·Tab(tabReader) 각자 자기 몫을 소비한다", async () => {
    const { fake, readline, complete, startRead } = setup();
    const first = await startRead();
    fake.type("a\r");
    await first.line;

    // ArrowUp: `>>> `(블록 밖)에서는 벤더 자체 history 탐색이 동작한다.
    // blockHistory의 onKey는 pendingBlock !== "" 조건이 거짓이라 소비하지 않는다.
    await startRead();
    fake.type("\x1b[A");
    expect(readline.getLine()).toBe("a");

    // ShiftEnter: autoIndent만 처리한다. 개행과 들여쓰기를 삽입한다.
    await startRead();
    fake.type("if True:");
    fake.keyDown({ key: "Enter", shiftKey: true });
    expect(readline.getLine()).toBe("if True:\n    ");

    // Tab: tabReader만 처리한다. complete를 호출한다.
    complete.mockReturnValueOnce(new Promise(() => {}));
    fake.type("x");
    fake.type("\t");
    expect(complete).toHaveBeenCalled();
  });

  test("[E5] restore가 있고 비어 있지 않으면 autoIndent prefill보다 우선한다(소비는 begin 호출 시점)", async () => {
    const { fake, lineEditor, startRead } = setup();
    const first = await startRead();
    fake.type("if True:\r");
    await first.line;

    // autoIndent가 4칸 prefill을 냈을 자리에 restore가 대신 들어간다.
    const options = lineEditor.begin("if True:", {
      text: "restored",
      cursor: 3,
    });
    expect(options.prefill).toBe("restored");
    expect(options.prefillCursor).toBe(3);
  });

  test("[E5] restore.text가 빈 문자열이면 무시한다(autoIndent prefill이 남는다)", () => {
    const { lineEditor } = setup();
    const options = lineEditor.begin("if True:", { text: "", cursor: 0 });
    expect(options.prefill).toBe("    ");
  });

  test("[E5] restore는 begin을 부를 때마다 한 번만 쓰인다(다음 읽기에는 남지 않는다)", () => {
    const { lineEditor } = setup();
    const first = lineEditor.begin(undefined, { text: "restored", cursor: 3 });
    expect(first.prefill).toBe("restored");

    const second = lineEditor.begin(undefined);
    expect(second.prefill).toBeUndefined();
  });

  test("[E6] end({kind:'line'})은 tabReader.readEnded(line)을 불러 왕복 응답을 버린다", async () => {
    const { fake, readline, complete, lineEditor, startRead } = setup();
    await startRead();
    fake.type("os.pa");
    const pending = deferredCompletion();
    complete.mockReturnValueOnce(pending.promise);
    fake.type("\t");

    lineEditor.end({ kind: "line", line: "os.pa" });
    pending.resolve({ completions: ["os.path"], start: 0 });
    await tick();

    // end()가 tabReader를 끝내지 않았다면 이 응답이 적용돼 "os.path"가 됐을 것이다.
    expect(readline.getLine()).toBe("os.pa");
  });

  test("[E7] end({kind:'cancel'})은 tabReader.readEnded(null)과 blockHistory.discard()를 모두 부른다(두 부작용은 서로 독립이라 호출 순서는 관측할 수 없다)", async () => {
    const {
      fake,
      readline,
      complete,
      interruptCompletion,
      lineEditor,
      startRead,
    } = setup();
    const vendor = asVendorReadline(readline);

    const first = await startRead();
    fake.type("if True:\r");
    await first.line;
    expect(vendor.getHistory().entries).toEqual(["if True:"]);

    // 왕복 중 취소다. readEnded(null)의 효과로 interruptCompletion이 불려야 한다.
    await startRead("if True:");
    complete.mockReturnValueOnce(new Promise(() => {}));
    fake.type("pri");
    fake.type("\t");

    lineEditor.end({ kind: "cancel" });

    expect(interruptCompletion).toHaveBeenCalledTimes(1);
    // discard()가 열린 블록을 첫 줄까지 지운다. "if True:" 자신도 사라진다(block-history.test.ts와 같은 규칙).
    expect(vendor.getHistory().entries).toEqual([]);
  });

  test("[R7][E11] end({kind:'eof'})은 tabReader.readEnded(null)만 부른다 — blockHistory.discard()는 부르지 않는다(RD-048)", async () => {
    const {
      fake,
      readline,
      complete,
      interruptCompletion,
      lineEditor,
      startRead,
    } = setup();
    const vendor = asVendorReadline(readline);

    const first = await startRead();
    fake.type("if True:\r");
    await first.line;
    expect(vendor.getHistory().entries).toEqual(["if True:"]);

    // 왕복 중 EOF다. readEnded(null)의 효과로 interruptCompletion이 불려야 한다(cancel과 같다).
    await startRead("if True:");
    complete.mockReturnValueOnce(new Promise(() => {}));
    fake.type("pri");
    fake.type("\t");

    lineEditor.end({ kind: "eof" });

    expect(interruptCompletion).toHaveBeenCalledTimes(1);
    // discard()를 부르지 않는다. cancel([E7])과 달리 history가 그대로다("if True:"가 남는다).
    expect(vendor.getHistory().entries).toEqual(["if True:"]);
  });

  test("[E8] end({kind:'taken'})은 tabReader.readEnded('')를 불러 왕복 응답을 버린다", async () => {
    const { fake, readline, complete, lineEditor, startRead } = setup();
    await startRead();
    fake.type("os.pa");
    const pending = deferredCompletion();
    complete.mockReturnValueOnce(pending.promise);
    fake.type("\t");

    lineEditor.end({ kind: "taken" });
    pending.resolve({ completions: ["os.path"], start: 0 });
    await tick();

    // end()가 tabReader를 끝내지 않았다면 이 응답이 적용돼 "os.path"가 됐을 것이다.
    expect(readline.getLine()).toBe("os.pa");
  });

  test("[E9] dispose(true)는 열린 블록을 첫 줄까지 지운다", async () => {
    const { fake, readline, lineEditor, startRead } = setup();
    const vendor = asVendorReadline(readline);

    const first = await startRead();
    fake.type("if True:\r");
    await first.line;

    lineEditor.begin("if True:");
    vendor.appendHistory("stray");
    expect(vendor.getHistory().entries).toEqual(["stray", "if True:"]);

    lineEditor.dispose(true);
    expect(vendor.getHistory().entries).toEqual([]);
  });

  test("[E9] dispose(false)는 블록을 남긴다", async () => {
    const { fake, readline, lineEditor, startRead } = setup();
    const vendor = asVendorReadline(readline);

    const first = await startRead();
    fake.type("if True:\r");
    await first.line;

    lineEditor.begin("if True:");
    vendor.appendHistory("stray");

    lineEditor.dispose(false);
    expect(vendor.getHistory().entries).toEqual(["stray", "if True:"]);
  });

  test("[E9] dispose는 readOpen과 무관하게 tabReader를 끝내 지연 응답을 버린다", async () => {
    const { fake, readline, complete, lineEditor, startRead } = setup();
    await startRead();
    fake.type("os.pa");
    const pending = deferredCompletion();
    complete.mockReturnValueOnce(pending.promise);
    fake.type("\t");

    // readOpen=false(읽기가 열려 있지 않았다고 가정)여도 tabReader는 항상 끝난다.
    lineEditor.dispose(false);
    pending.resolve({ completions: ["os.path"], start: 0 });
    await tick();

    expect(readline.getLine()).toBe("os.pa");
  });

  test("[E10] requesting은 tabReader.requesting을 그대로 낸다", async () => {
    const { fake, complete, lineEditor, startRead } = setup();
    await startRead();
    expect(lineEditor.requesting).toBe(false);

    fake.type("os.pa");
    complete.mockReturnValueOnce(new Promise(() => {}));
    fake.type("\t");
    expect(lineEditor.requesting).toBe(true);
  });
});
