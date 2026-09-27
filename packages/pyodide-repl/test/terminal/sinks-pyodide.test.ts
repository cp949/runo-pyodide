// @vitest-environment node
/**
 * 실제 `PyodideConsole` + 실제 sink + 실제 `Readline` + 가짜 터미널의 터미널 바이트 시험(05-output.md 4.1,
 * 이전 구현 terminal-sinks.test.ts 상당). Python이 낸 조각이 화면에 어떤 바이트로 나가는지를 CPython 3.14.4
 * pty 실측 기준표(`print("err", file=sys.stderr)` → `err\r\n` 등)와 맞춰 고정하는 sink의 회귀선이다.
 */
import { Readline } from "@cp949/runo-xterm-readline";
import { loadPyodide, type PyodideInterface } from "pyodide";
import { beforeAll, describe, expect, test } from "vitest";
import { createConsole } from "../../src/worker/console";
import { createFakeTerminal } from "@repo/pyodide-testkit/fake-terminal";
import { createTerminalSinks } from "@cp949/runo-pyodide-terminal/internal";

let pyodide: PyodideInterface;

beforeAll(async () => {
  pyodide = await loadPyodide();
  pyodide.runPython("import sys, warnings, logging");
}, 60_000);

/** 새 가짜 터미널·`Readline`·sink 세트·콘솔. `output(src)`는 `runLine(src)` 동안 터미널에 나간 바이트다. */
function setup() {
  const fake = createFakeTerminal();
  const readline = new Readline({ persist: false });
  fake.term.loadAddon(readline);
  const sinks = createTerminalSinks(readline);
  const repl = createConsole(pyodide, sinks, { topLevelAwait: false });
  async function output(source: string): Promise<string> {
    const from = fake.written.length;
    await repl.runLine(source);
    return fake.written.slice(from).join("");
  }
  return { sinks, output };
}

const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
/** stderr 빨강 이스케이프를 지운 바이트. 3.14.4 pty 기준표는 색이 없는 화면이다. */
const plain = (bytes: string) =>
  bytes.replaceAll("\x1b[31m", "").replaceAll("\x1b[0m", "");

describe("stderr 조각 출력 — CPython 3.14.4 pty 실측과 같은 바이트", () => {
  test("`print(..., file=sys.stderr)`는 err 뒤 `\\r\\n`이고 빈 줄이 없다", async () => {
    const { output } = setup();

    const bytes = await output('print("err", file=sys.stderr)');

    expect(bytes).toBe(red("err") + red("\r\n"));
    expect(plain(bytes)).toBe("err\r\n");
  });

  test("`warnings.warn`은 `<console>:1: UserWarning: w`를 한 줄로 낸다", async () => {
    const { output } = setup();

    const bytes = await output('warnings.warn("w")');

    // 파일명 `<console>`은 3.14의 `<python-input-N>`과 다르다(10-parity-deviations.md 30).
    expect(plain(bytes)).toBe("<console>:1: UserWarning: w\r\n");
  });

  test("`logging.warning`은 `WARNING:root:lg`를 한 줄로 낸다", async () => {
    const { output } = setup();

    const bytes = await output('logging.warning("lg")');

    expect(plain(bytes)).toBe("WARNING:root:lg\r\n");
  });

  test("`sys.stderr.write`의 여러 줄은 한 조각으로 오고 뒤에 빈 줄이 없다", async () => {
    const { output } = setup();

    const bytes = await output('sys.stderr.write("a\\nb\\n")');

    // 값 에코 `4`는 REPL 루프(RD-005)가 낸다. 이 경로는 stderr 조각만 본다.
    expect(bytes).toBe(red("a\r\nb\r\n"));
  });

  test("개행 없는 `sys.stderr.write`는 즉시 나온다", async () => {
    const { output } = setup();

    const bytes = await output('sys.stderr.write("raw-err")');

    expect(bytes).toBe(red("raw-err"));
  });

  test("`\\r` 진행률 조각은 그대로 나온다", async () => {
    const { output } = setup();

    const bytes = await output('sys.stderr.write("\\rprog 50%")');

    expect(bytes).toBe(red("\rprog 50%"));
  });

  test("stdout과 stderr는 낸 순서대로 섞이고 stdout은 빨강이 아니다", async () => {
    const { output } = setup();

    const bytes = await output(
      'print("out"); print("err", file=sys.stderr); print("out2")',
    );

    expect(bytes).toBe("out\r\n" + red("err") + red("\r\n") + "out2\r\n");
  });

  test("빈 문자열을 쓰면 색 이스케이프도 나오지 않는다", async () => {
    const { output } = setup();

    const bytes = await output('sys.stderr.write("")');

    expect(bytes).toBe("");
  });

  test("빈 `end`의 stderr `print`는 텍스트 조각만 낸다", async () => {
    const { output } = setup();

    const bytes = await output('print("x", end="", file=sys.stderr)');

    expect(bytes).toBe(red("x"));
  });
});

describe("개행 없는 출력 꼬리", () => {
  test('`print(..., end="")`는 그 텍스트가 꼬리다', async () => {
    const { sinks, output } = setup();

    await output('print("t", end="")');

    expect(sinks.tail()).toBe("t");
  });

  test("`sys.stdout.write`의 개행 없는 프롬프트는 꼬리다", async () => {
    const { sinks, output } = setup();

    await output('sys.stdout.write("x: ")');

    expect(sinks.tail()).toBe("x: ");
  });

  test("개행이 든 출력은 마지막 개행 뒤만 꼬리다", async () => {
    const { sinks, output } = setup();

    await output('print("a\\nb", end="")');

    expect(sinks.tail()).toBe("b");
  });

  test("개행으로 끝나는 출력 뒤 꼬리는 비어 있다", async () => {
    const { sinks, output } = setup();

    await output('print("a")');

    expect(sinks.tail()).toBe("");
  });

  test("개행 없는 stderr 조각은 빨강 감싸기째 꼬리에 남는다", async () => {
    const { sinks, output } = setup();

    await output('sys.stderr.write("e")');

    expect(sinks.tail()).toBe(red("e"));
  });

  test("여러 줄 stderr 조각의 마지막 줄은 색을 이어받는다", async () => {
    const { sinks, output } = setup();

    await output('sys.stderr.write("l1\\nl2")');

    expect(sinks.tail()).toBe(red("l2"));
  });

  test("stdout·stderr 조각이 화면 순서대로 꼬리에 이어진다", async () => {
    const { sinks, output } = setup();

    // `sys.stdout.write("a"); ...`처럼 값을 돌려주는 식문장을 앞에 두면 콘솔이 그 값(`1`)과 개행을 stdout으로 에코해
    // 꼬리가 비워진다. 값이 없는 `print`로 "개행 없는 stdout 뒤 개행 없는 stderr"만 만든다.
    await output('print("a", end=""); print("b", end="", file=sys.stderr)');

    expect(sinks.tail()).toBe("a" + red("b"));
  });

  test("닫지 않은 색은 줄 경계를 넘어 꼬리 앞에 붙는다", async () => {
    const { sinks, output } = setup();

    await output('print("\\x1b[32mA\\nB", end="")');

    expect(sinks.tail()).toBe("\x1b[32mB");
  });

  test("`resetTail()` 뒤 꼬리는 비어 있다", async () => {
    const { sinks, output } = setup();
    await output('print("t", end="")');

    sinks.resetTail();

    expect(sinks.tail()).toBe("");
  });

  test("새 sink 세트의 첫 꼬리는 비어 있다(세트마다 따로다)", async () => {
    const first = setup();
    await first.output('print("t", end="")');

    const second = setup();

    expect(second.sinks.tail()).toBe("");
    expect(first.sinks.tail()).toBe("t");
  });
});
