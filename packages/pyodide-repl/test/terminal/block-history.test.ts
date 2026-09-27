/**
 * `createBlockHistory` 시험(06-editing.md 6.4, RD-014 그릴링 확정 8). 실제 `createTerminalSurface`
 * (`promptRow.read`) + 가짜 터미널로, 블록(`... `) 입력의 줄들이 history 항목 하나로 묶이는지
 * `setupLineEditor()`(`./line-editor-setup.ts`, RD-043)로 확인한다. 세션과 같은 합성(`createLineEditor(readline,
 * deps).begin(pending)`, RD-029 DELTA-03)을 그대로 쓴다(seam 1). `pending`은 worker가 보낼 값을 시험이
 * 직접 만든다(직전까지 제출된 줄을 `\n`으로 이은 텍스트).
 *
 * 대부분의 관찰은 ↑ 재호출(`recall`)이다. `entries` 직접 단언은 ↑로 구분할 수 없는 두 경우(50개
 * 제한으로 밀린 항목 복구, 중복 제거로 옮겨진 옛 항목의 원래 자리 복구)에만 쓴다(확정 8).
 */
import { describe, expect, test } from "vitest";
import { asVendorReadline } from "@cp949/runo-pyodide-terminal/test-utils";
import { setupLineEditor } from "./line-editor-setup";

describe.each([
  { mode: "동기", asyncWrite: false },
  { mode: "비동기", asyncWrite: true },
])("createBlockHistory(write 콜백이 $mode 모드일 때)", ({ asyncWrite }) => {
  function setup() {
    // Tab 왕복은 이 시험의 관심사가 아니다 — 실제로 눌리지 않으므로 `complete`는 불릴 일이 없다.
    const { fake, readline, lineEditor, startRead } = setupLineEditor({
      asyncWrite,
    });

    /** 세션이 취소된 읽기 뒤 부르는 정리를 흉내 낸다(driver `readLine` 핸들러의 `lineEditor.end({kind:"cancel"})`,
     * `line-editor.ts` E7 — `tabReader.readEnded(null)` 다음 `blockHistory.discard()`). */
    function discardCancelled(): void {
      lineEditor.end({ kind: "cancel" });
    }

    /** `>>> ` 읽기를 새로 열고 `\x1b[A`를 n번 친 뒤 편집 버퍼를 돌려준다(제출하지 않음). */
    async function recall(n: number): Promise<string> {
      await startRead();
      fake.type("\x1b[A".repeat(n));
      return readline.getLine();
    }

    return { fake, readline, discardCancelled, startRead, recall };
  }

  test("블록을 공백 줄로 끝낸 뒤 ↑는 블록 전체를 한 항목으로 돌려준다", async () => {
    const { fake, startRead, recall } = setup();

    const first = await startRead();
    fake.type("for i in range(2):\r");
    await first.line;

    const second = await startRead("for i in range(2):");
    fake.type("print(i)\r");
    await second.line;

    const third = await startRead("for i in range(2):\n    print(i)");
    fake.type("\r");
    await third.line;

    expect(await recall(1)).toBe("for i in range(2):\n    print(i)");
  });

  test("Ctrl+C로 취소한 블록은 첫 줄까지 남지 않는다", async () => {
    const { fake, discardCancelled, startRead, recall } = setup();

    const first = await startRead();
    fake.type("y = 2\r");
    await first.line;

    const second = await startRead();
    fake.type("if True:\r");
    await second.line;

    const third = await startRead("if True:");
    fake.type("print(1)\r");
    await third.line;

    const fourth = await startRead("if True:\n    print(1)");
    fake.type("\x03");
    fake.flush();
    await expect(fourth.line).resolves.toBeNull();

    discardCancelled();

    expect(await recall(1)).toBe("y = 2");
  });

  // 계획(DELTA-03.md)의 17건 외 추가(변이 검사에서 M8이 살아남아 발견, rubber-workflow "발견하면
  // 바로 목록에 추가" 절차). `readOptions(undefined)`가 다음 읽기마다 `blockBase`를 다시 계산해
  // 덮어써서, `discard()`가 `blockBase`를 `null`로 안 해도(M8) 그 사이 다른 읽기가 없으면 드러나지
  // 않는다 — `discard()`를 연달아 불러 첫 호출 이후의 부수효과가 없는지 직접 본다.
  test("discard()를 두 번 연달아 불러도 두 번째는 무동작이다", async () => {
    const { fake, readline, discardCancelled, startRead } = setup();

    const first = await startRead();
    fake.type("y = 2\r");
    await first.line;
    const second = await startRead();
    fake.type("if True:\r");
    await second.line;
    const third = await startRead("if True:");
    fake.type("print(1)\r");
    await third.line;
    const fourth = await startRead("if True:\n    print(1)");
    fake.type("\x03");
    fake.flush();
    await expect(fourth.line).resolves.toBeNull();

    discardCancelled();
    asVendorReadline(readline).appendHistory("guard");
    discardCancelled();

    expect(readline.getHistory().entries[0]).toBe("guard");
  });

  test("취소해도 50개 제한으로 밀린 항목이 복구된다", async () => {
    const { fake, readline, discardCancelled, startRead } = setup();
    for (let i = 0; i < 50; i++)
      asVendorReadline(readline).appendHistory(`e${i}`);
    expect(readline.getHistory().entries.length).toBe(50);

    const first = await startRead();
    fake.type("if True:\r");
    await first.line;

    expect(readline.getHistory().entries.length).toBe(50);
    expect(readline.getHistory().entries).not.toContain("e0");

    const second = await startRead("if True:");
    fake.type("\x03");
    fake.flush();
    await expect(second.line).resolves.toBeNull();

    discardCancelled();

    expect(readline.getHistory().entries.length).toBe(50);
    expect(readline.getHistory().entries.at(-1)).toBe("e0");
  });

  test("취소해도 중복 제거로 옮겨진 옛 항목이 원래 자리로 돌아온다", async () => {
    const { fake, readline, discardCancelled, startRead } = setup();

    const first = await startRead();
    fake.type("a\r");
    await first.line;
    const second = await startRead();
    fake.type("if True:\r");
    await second.line;
    const third = await startRead();
    fake.type("b\r");
    await third.line;
    expect(readline.getHistory().entries).toEqual(["b", "if True:", "a"]);

    const fourth = await startRead();
    fake.type("if True:\r");
    await fourth.line;
    expect(readline.getHistory().entries).toEqual(["if True:", "b", "a"]);

    const fifth = await startRead("if True:");
    fake.type("\x03");
    fake.flush();
    await expect(fifth.line).resolves.toBeNull();

    discardCancelled();

    expect(readline.getHistory().entries).toEqual(["b", "if True:", "a"]);
  });

  test("블록이 끝난 뒤 `>>> `에서 취소해도 완료된 블록은 남는다", async () => {
    const { fake, discardCancelled, startRead, recall } = setup();

    const first = await startRead();
    fake.type("for i in range(2):\r");
    await first.line;
    const second = await startRead("for i in range(2):");
    fake.type("print(i)\r");
    await second.line;
    const third = await startRead("for i in range(2):\n    print(i)");
    fake.type("\r");
    await third.line;

    const fourth = await startRead();
    fake.type("abc\x03");
    fake.flush();
    await expect(fourth.line).resolves.toBeNull();
    // 세션은 모든 null(취소)에 discard()를 부른다 — 블록 밖(blockBase === null)이면 무동작이어야 한다.
    discardCancelled();

    expect(await recall(1)).toBe("for i in range(2):\n    print(i)");
  });

  test("괄호 안 빈 줄은 보존한다", async () => {
    const { fake, startRead, recall } = setup();

    const first = await startRead();
    fake.type("x = [\r");
    await first.line;

    const second = await startRead("x = [");
    fake.type("\r");
    await second.line;

    const third = await startRead("x = [\n");
    fake.type("1]\r");
    await third.line;

    expect(await recall(1)).toBe("x = [\n\n1]");
  });

  test("문법 오류로 끝난 블록도 오류 줄까지 남는다", async () => {
    const { fake, startRead, recall } = setup();

    const first = await startRead();
    fake.type("if True:\r");
    await first.line;

    const second = await startRead("if True:");
    fake.type("x = = 1\r");
    await second.line;

    expect(await recall(1)).toBe("if True:\n    x = = 1");
  });

  test("같은 블록을 다시 제출하면 중복 없이 최신으로 옮겨진다", async () => {
    const { fake, readline, startRead, recall } = setup();

    const first = await startRead();
    fake.type("for i in range(2):\r");
    await first.line;
    const second = await startRead("for i in range(2):");
    fake.type("print(i)\r");
    await second.line;
    const third = await startRead("for i in range(2):\n    print(i)");
    fake.type("\r");
    await third.line;

    const fourth = await startRead();
    fake.type("z = 1\r");
    await fourth.line;

    const fifth = await startRead();
    fake.type("\x1b[A\x1b[A\r");
    await fifth.line;

    expect(await recall(2)).toBe("z = 1");
    // 블록이 한 번만 있다: 재제출 전 기록된 중간 상태(진행형 교체가 지운 조각)가 남아 있으면
    // "z = 1" 항목과 합쳐 3개가 된다.
    expect(readline.getHistory().entries.length).toBe(2);
  });

  test("Shift+Enter로 만든 줄까지 한 항목이다", async () => {
    const { fake, startRead, recall } = setup();

    const first = await startRead();
    fake.type("if True:\r");
    await first.line;

    const second = await startRead("if True:");
    fake.type("print(1)");
    fake.keyDown({ key: "Enter", shiftKey: true });
    fake.type("print(2)\r");
    await second.line;

    const third = await startRead("if True:\n    print(1)\n    print(2)");
    fake.type("\r");
    await third.line;

    expect(await recall(1)).toBe("if True:\n    print(1)\n    print(2)");
  });

  test("`... `에 붙여넣은 여러 줄은 top-level 문장까지 같은 항목에 잇는다", async () => {
    const { fake, startRead, recall } = setup();

    const first = await startRead();
    fake.type("for i in range(2):\r");
    await first.line;

    const second = await startRead("for i in range(2):");
    // 실제 xterm.js는 붙여넣은 텍스트의 개행을 onData로 넘기기 전에 `\r`로 바꾼다(브라우저 관찰,
    // `fake.paste`는 원문을 그대로 보내므로 시험이 그 전처리 결과를 직접 준다). `readPaste`가
    // `\r`(Enter 토큰)를 `editInsert("\n")`로 바꿔 버퍼에 줄바꿈만 남기고 제출하지 않는다.
    fake.paste("print(i)\r\rx = 1");
    fake.type("\r");
    await second.line;

    expect(await recall(1)).toBe("for i in range(2):\n    print(i)\n\nx = 1");
  });

  test("`>>> `에서 블록을 열어 둔 채 끝나는 붙여넣기 뒤 `... ` 줄이 같은 항목에 이어진다", async () => {
    const { fake, startRead, recall } = setup();

    const first = await startRead();
    fake.type("q = 0\r");
    await first.line;

    const second = await startRead();
    fake.paste("for i in range(2):\r    print(i)");
    fake.type("\r");
    await second.line;

    const third = await startRead("for i in range(2):\n    print(i)");
    fake.type("print(9)\r");
    await third.line;

    expect(await recall(1)).toBe(
      "for i in range(2):\n    print(i)\n    print(9)",
    );
    expect(await recall(2)).toBe("q = 0");
  });

  test("한 줄 입력은 남고 빈/공백 제출은 남지 않는다", async () => {
    const { fake, startRead, recall } = setup();

    const first = await startRead();
    fake.type("z = 1\r");
    await first.line;
    const second = await startRead();
    fake.type("\r");
    await second.line;
    const third = await startRead();
    fake.type("   \r");
    await third.line;

    expect(await recall(1)).toBe("z = 1");
  });

  test("프리필이 없는 `... ` 줄에서 ↑는 history를 탐색하지 않는다", async () => {
    const { fake, readline, startRead } = setup();

    const first = await startRead();
    fake.type("w = 5\r");
    await first.line;
    const second = await startRead();
    fake.type("x = [\r");
    await second.line;

    await startRead("x = [");
    expect(readline.getLine()).toBe("");
    fake.type("\x1b[A");

    expect(readline.getLine()).toBe("");
  });

  test("프리필을 지운 `... ` 줄에서도 ↑는 탐색하지 않는다", async () => {
    const { fake, readline, startRead } = setup();

    const first = await startRead();
    fake.type("if True:\r");
    await first.line;

    await startRead("if True:");
    fake.type("\x15");
    expect(readline.getLine()).toBe("");
    fake.type("\x1b[A");

    expect(readline.getLine()).toBe("");
  });

  test("`... `의 여러 줄 버퍼 안에서 ↑는 줄 이동이다", async () => {
    const { fake, readline, startRead } = setup();

    const first = await startRead();
    fake.type("if True:\r");
    await first.line;

    await startRead("if True:");
    fake.type("print(1)");
    fake.keyDown({ key: "Enter", shiftKey: true });
    fake.type("print(2)");
    fake.type("\x1b[A");

    expect(readline.getLine()).toBe("    print(1)\n    print(2)");
    expect(readline.getCursor()).toBeLessThan("    print(1)\n".length);
  });

  test("Shift+Enter 뒤 빈 줄로 제출해도 끝 공백 줄이 잘린다", async () => {
    const { fake, startRead, recall } = setup();

    const first = await startRead();
    fake.type("if True:\r");
    await first.line;

    const second = await startRead("if True:");
    fake.type("print(1)");
    fake.keyDown({ key: "Enter", shiftKey: true });
    fake.type("\r");
    await second.line;

    expect(await recall(1)).toBe("if True:\n    print(1)");
  });

  test("`>>> `의 ↑는 그대로 탐색한다", async () => {
    const { fake, startRead, recall } = setup();

    const first = await startRead();
    fake.type("a\r");
    await first.line;
    const second = await startRead();
    fake.type("b\r");
    await second.line;

    expect(await recall(2)).toBe("a");
  });
});
