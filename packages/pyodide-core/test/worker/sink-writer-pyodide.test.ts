// @vitest-environment node
/**
 * 전역 stdout/stderr Writer를 실제 pyodide(node)에 등록해 보는 경계 시험(09-testing.md 9.1).
 * `setStdout`/`setStderr`가 Writer를 어떤 단위로 부르는지, Python 버퍼가 언제 비워지는지를 고정한다.
 * 이 저장소의 첫 node + 실제 pyodide 시험이라 `loadPyodide()`(인자 없음, npm 패키지 자체 indexURL)가
 * vitest 안에서 도는 것도 함께 확인한다.
 */
import { loadPyodide, type PyodideInterface } from "pyodide";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createSinkWriter } from "../../src/worker/sink-writer";

let pyodide: PyodideInterface;

beforeAll(async () => {
  pyodide = await loadPyodide();
}, 60_000);

afterAll(() => {
  pyodide.setStdout();
  pyodide.setStderr();
});

describe("createSinkWriter를 실제 pyodide에 등록", () => {
  test("`setStdout`에 등록하면 Python이 flush한 텍스트가 조각째 sink에 온다", () => {
    const out = vi.fn();
    pyodide.setStdout(createSinkWriter(out));

    pyodide.runPython('print("한글 줄", flush=True)');

    expect(out.mock.calls.map((call) => call[0]).join("")).toBe("한글 줄\n");
  });

  test("raw 버퍼로 글자 중간에서 끊어 써도 sink에는 온전한 글자가 온다", () => {
    const out = vi.fn();
    pyodide.setStdout(createSinkWriter(out));

    // "한" = ED 95 9C. BufferedWriter를 통해 2바이트·1바이트로 나눠 flush하면 Writer.write가 두 번 불린다.
    pyodide.runPython(`
import sys
sys.stdout.buffer.write(b"\\xed\\x95"); sys.stdout.buffer.flush()
sys.stdout.buffer.write(b"\\x9c"); sys.stdout.buffer.flush()
`);

    expect(out.mock.calls).toEqual([["한"]]);
  });

  test("stdout과 stderr는 서로 다른 Writer라 잘린 글자가 섞이지 않는다", () => {
    const out = vi.fn();
    const err = vi.fn();
    pyodide.setStdout(createSinkWriter(out));
    pyodide.setStderr(createSinkWriter(err));

    pyodide.runPython(`
import sys
sys.stdout.buffer.write(b"\\xed\\x95"); sys.stdout.buffer.flush()
sys.stderr.write("x"); sys.stderr.flush()
sys.stdout.buffer.write(b"\\x9c"); sys.stdout.buffer.flush()
`);

    expect(err.mock.calls).toEqual([["x"]]);
    expect(out.mock.calls).toEqual([["한"]]);
  });

  test("flush하지 않은 개행 없는 print는 다음 개행까지 sink에 오지 않는다(Python 버퍼는 건드리지 않는다)", () => {
    const out = vi.fn();
    pyodide.setStdout(createSinkWriter(out));

    pyodide.runPython('print("t", end="")');
    expect(out).not.toHaveBeenCalled();

    pyodide.runPython('print("line")');
    expect(out.mock.calls).toEqual([["tline\n"]]);
  });
});
