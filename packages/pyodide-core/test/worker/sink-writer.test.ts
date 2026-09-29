/**
 * 전역 stdout/stderr Writer(`createSinkWriter`) 순수 시험(05-output.md 4.2, TRAP-01).
 * pyodide 없이 바이트 조각을 직접 `write`해서 세 가지를 본다.
 * - UTF-8 이어 붙임
 * - 반환값
 * - Writer별 상태 분리
 *
 * 실제 pyodide가 이 Writer를 어떻게 부르는지는 sink-writer-pyodide.test.ts(node)가 본다.
 */
import { describe, expect, test, vi } from "vitest";
import { createSinkWriter } from "../../src/worker/sink-writer";

/** 문자열을 UTF-8 바이트로 바꾼다. */
const encode = (text: string) => new TextEncoder().encode(text);

describe("createSinkWriter: 전역 stdout·stderr를 콘솔 콜백과 같은 sink로 보낸다", () => {
  test("쓴 바이트를 UTF-8 텍스트로 sink에 넘기고 쓴 바이트 수를 돌려준다", () => {
    const sink = vi.fn();
    const writer = createSinkWriter(sink);

    const written = writer.write(encode("안녕"));

    expect(sink.mock.calls).toEqual([["안녕"]]);
    expect(written).toBe(6);
  });

  test("개행 없는 조각도 붙잡지 않고 바로 넘긴다", () => {
    const sink = vi.fn();
    const writer = createSinkWriter(sink);

    writer.write(encode("tick"));

    expect(sink.mock.calls).toEqual([["tick"]]);
  });

  test("글자 하나가 조각 경계에서 잘려 와도 이어 붙여 넘기고 잘린 조각의 바이트 수도 돌려준다", () => {
    const sink = vi.fn();
    const writer = createSinkWriter(sink);
    const bytes = encode("한"); // ED 95 9C

    const first = writer.write(bytes.slice(0, 2));
    expect(sink).not.toHaveBeenCalled();
    expect(first).toBe(2);

    const second = writer.write(bytes.slice(2));
    expect(sink.mock.calls).toEqual([["한"]]);
    expect(second).toBe(1);
  });

  test("stdout과 stderr Writer는 잘린 글자 상태를 공유하지 않는다", () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const stdoutWriter = createSinkWriter(stdout);
    const stderrWriter = createSinkWriter(stderr);
    const bytes = encode("한");

    stdoutWriter.write(bytes.slice(0, 2));
    stderrWriter.write(encode("x"));
    stdoutWriter.write(bytes.slice(2));

    expect(stderr.mock.calls).toEqual([["x"]]);
    expect(stdout.mock.calls).toEqual([["한"]]);
  });
});
