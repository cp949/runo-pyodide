// @vitest-environment node
/**
 * 콘솔 뼈대(`installStdioWriters`·`createCoreConsole`) 시험(실제 pyodide, 02-console-core.md 5.1).
 * 여기서는 driver가 공통으로 쓰는 두 함수만 본다.
 * REPL 전용 부분(ps1/ps2·헬퍼·TLA)은 repl `worker/console.test.ts`가 본다.
 */
import { loadPyodide, type PyodideInterface } from "pyodide";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  createCoreConsole,
  installStdioWriters,
  type PyodideConsoleProxy,
} from "../../src/worker/core-console";

let pyodide: PyodideInterface;

beforeAll(async () => {
  pyodide = await loadPyodide();
}, 60_000);

afterAll(() => {
  pyodide.setStdout();
  pyodide.setStderr();
});

/**
 * 콘솔에 한 줄을 push하고 결과 future를 기다린다.
 * 실행 예외면 그 메시지(트레이스백 포함)를 돌려준다. 정상이면 빈 문자열이다.
 * 뼈대만 보므로 REPL의 `await_fut` 헬퍼 없이 직접 await한다. 내부 프레임이 남지만 소스 이름 확인에는 상관없다.
 */
async function push(pyconsole: PyodideConsoleProxy, line: string) {
  try {
    await pyconsole.push(line);
    return "";
  } catch (error) {
    return String((error as Error).message);
  }
}

describe("installStdioWriters·createCoreConsole", () => {
  test("전역 Writer는 콘솔 밖 print·stderr 쓰기를 sink로 보내고 콘솔 출력도 함께 받는다", async () => {
    const sinks = { write: vi.fn(), writeErrorRaw: vi.fn() };
    installStdioWriters(pyodide, sinks);
    const pyconsole = createCoreConsole(pyodide, sinks);

    pyodide.runPython('print("전역", flush=True)');
    pyodide.runPython(
      'import sys; sys.stderr.write("err\\n"); sys.stderr.flush()',
    );
    await push(pyconsole, "print('콘솔')");

    const out = sinks.write.mock.calls.map((call) => call[0]).join("");
    expect(out).toContain("전역\n");
    expect(out).toContain("콘솔\n");
    expect(sinks.writeErrorRaw.mock.calls.map((call) => call[0]).join("")).toBe(
      "err\n",
    );
    pyconsole.destroy();
  });

  // 전역 Writer 없이 콘솔 콜백만 걸고, 콘솔 안에서 쓴 stdout·stderr가 각자의 sink로 가는지 본다.
  test("콘솔 안에서 쓴 stdout·stderr는 전역 Writer 없이도 각각 write·writeErrorRaw로 간다", async () => {
    pyodide.setStdout();
    pyodide.setStderr();
    const sinks = { write: vi.fn(), writeErrorRaw: vi.fn() };
    const pyconsole = createCoreConsole(pyodide, sinks);

    await push(pyconsole, "import sys; sys.stdout.write('콘솔out\\n')");
    await push(pyconsole, "import sys; sys.stderr.write('콘솔err\\n')");

    expect(sinks.write.mock.calls.map((call) => call[0]).join("")).toContain(
      "콘솔out\n",
    );
    expect(
      sinks.writeErrorRaw.mock.calls.map((call) => call[0]).join(""),
    ).toContain("콘솔err\n");
    pyconsole.destroy();
  });

  test("filename을 주지 않으면 트레이스백의 소스 이름은 <console>이다", async () => {
    const sinks = { write: vi.fn(), writeErrorRaw: vi.fn() };
    const pyconsole = createCoreConsole(pyodide, sinks);

    const error = await push(pyconsole, "1 / 0");

    expect(error).toContain('File "<console>"');
    pyconsole.destroy();
  });

  test("filename을 주면 트레이스백의 소스 이름이 그 값이다", async () => {
    const sinks = { write: vi.fn(), writeErrorRaw: vi.fn() };
    const pyconsole = createCoreConsole(pyodide, sinks, {
      filename: "<실행창>",
    });

    const error = await push(pyconsole, "1 / 0");

    expect(error).toContain('File "<실행창>"');
    pyconsole.destroy();
  });
});
