/**
 * 선택 복사 정책 시험.
 * - 대상: `decideKey`(키 판정)와 `createSelectionCopy`(복사 부작용).
 * - 가짜 터미널(`@repo/pyodide-testkit/fake-terminal`)과 `writeText` 스텁을 쓴다.
 * - 실제 xterm과 클립보드 없이 판정·부작용을 검증한다.
 */
import { describe, expect, test, vi } from "vitest";
import { createFakeTerminal } from "@repo/pyodide-testkit/fake-terminal";
import {
  createSelectionCopy,
  decideKey,
  type CopyResult,
} from "../src/selection-copy";

describe("decideKey", () => {
  test.each([
    ["keydown", true, false, false, "c", true, "copy"],
    ["keydown", true, false, false, "c", false, "pass"],
    ["keydown", true, false, false, "C", true, "copy"],
    ["keydown", true, true, false, "c", true, "pass"],
    ["keydown", true, false, true, "c", true, "pass"],
    ["keyup", true, false, false, "c", true, "pass"],
    ["keydown", false, false, false, "c", true, "pass"],
    ["keydown", true, false, false, "v", true, "pass"],
  ] as const)(
    "%s ctrl=%s alt=%s meta=%s key=%s hasSelection=%s -> %s",
    (type, ctrlKey, altKey, metaKey, key, hasSelection, expected) => {
      expect(
        decideKey({ type, ctrlKey, altKey, metaKey, key }, hasSelection),
      ).toBe(expected);
    },
  );

  test("Ctrl+Shift+C도 선택이 있으면 copy다", () => {
    expect(
      decideKey(
        {
          type: "keydown",
          ctrlKey: true,
          altKey: false,
          metaKey: false,
          key: "c",
        },
        true,
      ),
    ).toBe("copy");
  });
});

/**
 * 즉시 resolve하는 `writeText` 스텁을 만든다.
 * 넘겨받은 텍스트를 `calls`에 기록한다.
 */
function stubWriteText() {
  const calls: string[] = [];
  const writeText = vi.fn((text: string) => {
    calls.push(text);
    return Promise.resolve();
  });
  return { writeText, calls };
}

/** 복사 단축키(Ctrl+C) `keydown` 이벤트를 만든다. */
function ctrlC(): KeyboardEvent {
  return new KeyboardEvent("keydown", { ctrlKey: true, key: "c" });
}

describe("createSelectionCopy", () => {
  test("선택 있는 Ctrl+C는 복사하고 선택을 지우고 true를 돌려준다", () => {
    const fake = createFakeTerminal();
    fake.select("hello");
    const { writeText, calls } = stubWriteText();
    const results: CopyResult[] = [];
    const policy = createSelectionCopy(fake.term, {
      copyOnSelect: true,
      onCopy: (r) => results.push(r),
      writeText,
    });
    const event = ctrlC();
    const preventDefault = vi.spyOn(event, "preventDefault");

    const handled = policy.onKeyEvent(event);

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["hello"]);
    expect(fake.clearSelectionCalls).toBe(1);
  });

  test("복사 성공 시 onCopy에 chars 개수를 담아 알린다", async () => {
    const fake = createFakeTerminal();
    fake.select("hello");
    const { writeText } = stubWriteText();
    const results: CopyResult[] = [];
    const policy = createSelectionCopy(fake.term, {
      copyOnSelect: true,
      onCopy: (r) => results.push(r),
      writeText,
    });

    policy.onKeyEvent(ctrlC());
    await Promise.resolve();
    await Promise.resolve();

    expect(results).toEqual([{ ok: true, chars: 5 }]);
  });

  test("이모지가 섞인 텍스트의 chars는 코드 포인트 기준이다", async () => {
    const fake = createFakeTerminal();
    fake.select("😀x\ny");
    const { writeText } = stubWriteText();
    const results: CopyResult[] = [];
    createSelectionCopy(fake.term, {
      copyOnSelect: true,
      onCopy: (r) => results.push(r),
      writeText,
    }).onKeyEvent(ctrlC());
    await Promise.resolve();
    await Promise.resolve();

    expect(results).toEqual([{ ok: true, chars: 4 }]);
  });

  test("writeText가 reject하면 onCopy에 ok:false와 error를 담아 알린다", async () => {
    const fake = createFakeTerminal();
    fake.select("hello");
    const error = new Error("clipboard denied");
    const writeText = vi.fn(() => Promise.reject(error));
    const results: CopyResult[] = [];
    createSelectionCopy(fake.term, {
      copyOnSelect: true,
      onCopy: (r) => results.push(r),
      writeText,
    }).onKeyEvent(ctrlC());
    await Promise.resolve();
    await Promise.resolve();

    expect(results).toEqual([{ ok: false, error }]);
  });

  test("선택 없는 Ctrl+C는 아무 것도 하지 않고 false를 돌려준다", () => {
    const fake = createFakeTerminal();
    const { writeText, calls } = stubWriteText();
    const results: CopyResult[] = [];
    const policy = createSelectionCopy(fake.term, {
      copyOnSelect: true,
      onCopy: (r) => results.push(r),
      writeText,
    });

    const handled = policy.onKeyEvent(ctrlC());

    expect(handled).toBe(false);
    expect(calls).toEqual([]);
    expect(fake.clearSelectionCalls).toBe(0);
    expect(results).toEqual([]);
  });

  test("빈 선택은 복사하지도 알리지도 않는다(방어)", () => {
    const fake = createFakeTerminal();
    fake.select("");
    const { writeText, calls } = stubWriteText();
    const results: CopyResult[] = [];
    createSelectionCopy(fake.term, {
      copyOnSelect: true,
      onCopy: (r) => results.push(r),
      writeText,
    }).onKeyEvent(ctrlC());

    expect(calls).toEqual([]);
    expect(results).toEqual([]);
  });

  test("mousedown 뒤 document에서 mouseup하면 선택이 있으면 자동 복사한다(선택은 유지)", () => {
    const fake = createFakeTerminal({ withElement: true });
    fake.select("dragged");
    const { writeText, calls } = stubWriteText();
    createSelectionCopy(fake.term, { copyOnSelect: true, writeText });
    const element = fake.term.element!;

    element.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    element.ownerDocument.dispatchEvent(new MouseEvent("mouseup"));

    expect(calls).toEqual(["dragged"]);
    expect(fake.clearSelectionCalls).toBe(0);
  });

  test("button 2(우클릭) mousedown 뒤 mouseup은 복사하지 않는다", () => {
    const fake = createFakeTerminal({ withElement: true });
    fake.select("dragged");
    const { writeText, calls } = stubWriteText();
    createSelectionCopy(fake.term, { copyOnSelect: true, writeText });
    const element = fake.term.element!;

    element.dispatchEvent(new MouseEvent("mousedown", { button: 2 }));
    element.ownerDocument.dispatchEvent(new MouseEvent("mouseup"));

    expect(calls).toEqual([]);
  });

  test("mousedown 없이 mouseup만 오면 복사하지 않는다", () => {
    const fake = createFakeTerminal({ withElement: true });
    fake.select("dragged");
    const { writeText, calls } = stubWriteText();
    createSelectionCopy(fake.term, { copyOnSelect: true, writeText });

    fake.term.element!.ownerDocument.dispatchEvent(new MouseEvent("mouseup"));

    expect(calls).toEqual([]);
  });

  test("copyOnSelect: false면 드래그 복사는 꺼지지만 Ctrl+C 복사는 그대로 동작한다", () => {
    const fake = createFakeTerminal({ withElement: true });
    fake.select("dragged");
    const { writeText, calls } = stubWriteText();
    const policy = createSelectionCopy(fake.term, {
      copyOnSelect: false,
      writeText,
    });
    const element = fake.term.element!;

    element.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    element.ownerDocument.dispatchEvent(new MouseEvent("mouseup"));
    expect(calls).toEqual([]);

    fake.select("selected");
    const handled = policy.onKeyEvent(ctrlC());
    expect(handled).toBe(true);
    expect(calls).toEqual(["selected"]);
  });

  test("setCopyOnSelect(true)로 다시 켜면 드래그 복사가 동작한다", () => {
    const fake = createFakeTerminal({ withElement: true });
    fake.select("dragged");
    const { writeText, calls } = stubWriteText();
    const policy = createSelectionCopy(fake.term, {
      copyOnSelect: false,
      writeText,
    });
    const element = fake.term.element!;

    policy.setCopyOnSelect(true);
    element.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    element.ownerDocument.dispatchEvent(new MouseEvent("mouseup"));

    expect(calls).toEqual(["dragged"]);
  });

  test("element가 없으면 마우스 리스너를 걸지 않지만 Ctrl+C 복사는 동작한다", () => {
    const fake = createFakeTerminal({ withElement: false });
    fake.select("hello");
    const { writeText, calls } = stubWriteText();
    const policy = createSelectionCopy(fake.term, {
      copyOnSelect: true,
      writeText,
    });

    expect(fake.term.element).toBeUndefined();
    const handled = policy.onKeyEvent(ctrlC());

    expect(handled).toBe(true);
    expect(calls).toEqual(["hello"]);
  });

  test("dispose() 뒤에는 마우스 리스너가 해제되고 onKeyEvent는 항상 false, setCopyOnSelect는 no-op이다", () => {
    const fake = createFakeTerminal({ withElement: true });
    fake.select("hello");
    const { writeText, calls } = stubWriteText();
    const policy = createSelectionCopy(fake.term, {
      copyOnSelect: true,
      writeText,
    });
    const element = fake.term.element!;

    policy.dispose();
    policy.setCopyOnSelect(false);

    element.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    element.ownerDocument.dispatchEvent(new MouseEvent("mouseup"));
    expect(calls).toEqual([]);

    const handled = policy.onKeyEvent(ctrlC());
    expect(handled).toBe(false);
    expect(calls).toEqual([]);
  });
});
