// @vitest-environment node
/**
 * 호환 탐지 보조(`worker/compat.ts`) 시험. 저하 지점 수집기와 interrupt 공개 API 확인은 pyodide 없이 가짜 객체로 전수 본다.
 * 실제 pyodide에서 지점마다 `degraded`가 실리는지는 `boot-compat.test.ts`가 본다.
 */
import { describe, expect, test } from "vitest";
import {
  createDegradedCollector,
  findMissingInterruptApi,
} from "../../src/worker/compat";

describe("createDegradedCollector", () => {
  test("보고가 없으면 degraded가 비어 있고 details는 없다", () => {
    const collector = createDegradedCollector();

    expect(collector.degraded()).toEqual([]);
    expect(collector.details()).toBeUndefined();
  });

  test("보고한 식별자를 처음 보고한 순서로 돌려주고 상세는 식별자별로 모은다", () => {
    const collector = createDegradedCollector();

    collector.report("run-sync", "pyodide.ffi.run_sync");
    collector.report("sleep-slice", "time.sleep.__wrapped__");
    collector.report("run-sync", "console.runcode");

    expect(collector.degraded()).toEqual(["run-sync", "sleep-slice"]);
    expect(collector.details()).toEqual({
      "run-sync": ["pyodide.ffi.run_sync", "console.runcode"],
      "sleep-slice": ["time.sleep.__wrapped__"],
    });
  });

  test("같은 식별자·같은 상세의 중복 보고는 한 번만 센다", () => {
    const collector = createDegradedCollector();

    collector.report("webloop-handlers", "_system_exit_handler");
    collector.report("webloop-handlers", "_system_exit_handler");

    expect(collector.degraded()).toEqual(["webloop-handlers"]);
    expect(collector.details()).toEqual({
      "webloop-handlers": ["_system_exit_handler"],
    });
  });

  test("driver probe가 돌려준 식별자는 상세 없이 앞에 싣고 중복은 지운다", () => {
    const collector = createDegradedCollector();
    collector.addIds(["compiler-flags", "incomplete-input-message"]);

    collector.report("run-sync", "pyodide.ffi.run_sync");
    collector.addIds(["run-sync"]);

    expect(collector.degraded()).toEqual([
      "compiler-flags",
      "incomplete-input-message",
      "run-sync",
    ]);
    expect(collector.details()).toEqual({
      "run-sync": ["pyodide.ffi.run_sync"],
    });
  });

  test("driver 식별자만 있으면 details는 없다", () => {
    const collector = createDegradedCollector();

    collector.addIds(["compiler-flags"]);

    expect(collector.details()).toBeUndefined();
  });
});

describe("findMissingInterruptApi", () => {
  const fn = () => {};

  test("setInterruptBuffer와 checkInterrupt가 함수이면 빈 배열이다", () => {
    expect(
      findMissingInterruptApi({ setInterruptBuffer: fn, checkInterrupt: fn }),
    ).toEqual([]);
  });

  test("setInterruptBuffer가 없으면 그 이름만 돌려준다", () => {
    expect(findMissingInterruptApi({ checkInterrupt: fn })).toEqual([
      "setInterruptBuffer",
    ]);
  });

  test("checkInterrupt가 없으면 그 이름만 돌려준다", () => {
    expect(findMissingInterruptApi({ setInterruptBuffer: fn })).toEqual([
      "checkInterrupt",
    ]);
  });

  test("둘 다 없으면 둘 다 돌려준다", () => {
    expect(findMissingInterruptApi({})).toEqual([
      "setInterruptBuffer",
      "checkInterrupt",
    ]);
  });

  test("함수가 아닌 값은 없는 것으로 본다", () => {
    expect(
      findMissingInterruptApi({ setInterruptBuffer: 1, checkInterrupt: null }),
    ).toEqual(["setInterruptBuffer", "checkInterrupt"]);
  });
});
