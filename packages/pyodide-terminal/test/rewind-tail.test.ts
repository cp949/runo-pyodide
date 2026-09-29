/**
 * `rewindTail` 시험(04-stdin-input.md 3.3, TRAP-15).
 * - 검증: 꼬리가 터미널 폭을 넘어 여러 행으로 감기면 `read()` 앞에 `\x1b[nA`로 첫 행까지 커서를 올린다.
 * - 화면 버퍼: 시험이 가짜 터미널의 `screen`에 값을 직접 지정한다(VT 해석 없음).
 * - write 콜백: `flush()`까지 미룬다. "flush 뒤에 화면을 읽는" 순서를 통제하기 위해서다.
 * - 실제 화면 결과(앞 행 중복 없음)는 브라우저(Playwright)가 본다.
 */
import { describe, expect, test } from "vitest";
import { createFakeTerminal } from "@repo/pyodide-testkit/fake-terminal";
import { rewindTail } from "../src/rewind-tail";

/**
 * 비동기 write 가짜 터미널(기본 폭 80)과 `rewind` 도우미를 만든다.
 * `rewind`는 시작 → flush → 완료를 한 번에 한다.
 */
function setup(cols = 80) {
  const fake = createFakeTerminal({ asyncWrite: true, cols });
  /** `rewindTail`을 시작하고 바로 flush해 끝까지 돌린다. 짧은 꼬리처럼 flush가 필요 없으면 그냥 끝난다. */
  async function rewind(tail: string): Promise<void> {
    const done = rewindTail(fake.term, tail);
    fake.flush();
    await done;
  }
  return { fake, rewind };
}

describe("rewindTail", () => {
  test("빈 꼬리는 write를 부르지 않는다", async () => {
    const { fake, rewind } = setup();

    await rewind("");

    expect(fake.written).toEqual([]);
  });

  test("짧은 꼬리(39자, 폭 80)는 flush 없이 즉시 끝난다", async () => {
    const { fake } = setup();

    // flush()를 부르지 않는다. 조기 반환이 없으면 write 콜백이 오지 않아 이 await가 멈춘다.
    await rewindTail(fake.term, "x".repeat(39));

    expect(fake.written).toEqual([]);
  });

  test("정확히 cols/2(40자)는 짧지 않아 flush한다", async () => {
    const { fake, rewind } = setup();

    await rewind("x".repeat(40));

    expect(fake.written).toEqual([""]);
  });

  test("전각 45자(90칸)는 길이 45로도 짧지 않아 flush한다", async () => {
    const { fake, rewind } = setup();

    await rewind("가".repeat(45));

    expect(fake.written).toEqual([""]);
  });

  test("100자 꼬리가 3행째 커서까지 감겼으면 flush 뒤 `\\x1b[2A`로 첫 행까지 올린다", async () => {
    const { fake, rewind } = setup();
    fake.screen.cursorY = 3;
    fake.screen.wrappedRows = new Set([3, 2]);

    await rewind("x".repeat(100));

    expect(fake.written).toEqual(["", "\x1b[2A"]);
  });

  test("감긴 행이 없으면 flush만 하고 커서를 올리지 않는다", async () => {
    const { fake, rewind } = setup();
    fake.screen.cursorY = 3;

    await rewind("x".repeat(100));

    expect(fake.written).toEqual([""]);
  });

  test("뷰포트 위(스크롤백)로는 올리지 않고 cursorY까지만 센다", async () => {
    const { fake, rewind } = setup();
    fake.screen.baseY = 5;
    fake.screen.cursorY = 1;
    // 절대 행 = baseY + cursorY = 6. 6·5·4가 모두 감겼어도 cursorY가 1이라 올릴 수 있는 행은 1개다.
    fake.screen.wrappedRows = new Set([6, 5, 4]);

    await rewind("x".repeat(100));

    expect(fake.written).toEqual(["", "\x1b[1A"]);
  });

  test("절대 행(baseY + cursorY)을 기준으로 감긴 행을 센다", async () => {
    const { fake, rewind } = setup();
    fake.screen.baseY = 10;
    fake.screen.cursorY = 2;
    // 커서 절대 행 12와 11만 감겼다. baseY를 더하지 않으면 행 2·1을 조회해 감긴 행이 없다고 잘못 판단한다.
    fake.screen.wrappedRows = new Set([12, 11]);

    await rewind("x".repeat(100));

    expect(fake.written).toEqual(["", "\x1b[2A"]);
  });

  test("화면 버퍼는 flush 뒤에 읽는다(방금 쓴 출력은 나중에 파싱된다)", async () => {
    const { fake } = setup();
    const done = rewindTail(fake.term, "x".repeat(100));

    // 시작 뒤 flush 전에 화면이 꼬리 끝을 반영한 것처럼 바꾼다.
    // flush 전에 읽으면 cursorY가 0이라 올리지 않는다.
    fake.screen.cursorY = 3;
    fake.screen.wrappedRows = new Set([3, 2]);
    fake.flush();
    await done;

    expect(fake.written).toEqual(["", "\x1b[2A"]);
  });

  test("올린 행 수를 돌려준다(짧은 꼬리·감기지 않은 꼬리는 0)", async () => {
    const { fake } = setup();

    await expect(rewindTail(fake.term, "x".repeat(39))).resolves.toBe(0);

    const plain = rewindTail(fake.term, "x".repeat(100));
    fake.flush();
    await expect(plain).resolves.toBe(0);

    fake.screen.cursorY = 3;
    fake.screen.wrappedRows = new Set([3, 2]);
    const wrapped = rewindTail(fake.term, "x".repeat(100));
    fake.flush();
    await expect(wrapped).resolves.toBe(2);
  });
});
