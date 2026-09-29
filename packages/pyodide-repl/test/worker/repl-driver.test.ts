// @vitest-environment node
/**
 * REPL worker driver의 옵션 파서(`replDriver.parseOptions`) 시험.
 *
 * - 초기화 프레임의 `driver` 필드는 core가 모양을 모른다. `parseInitFrame`은 필드 존재만 본다.
 * - 그래서 `topLevelAwait` 검증은 REPL driver 몫이다.
 * - worker 쪽 검증의 전체 경로는 `parseInitFrame`(core 필드) → `replDriver.parseOptions(frame.driver)`(driver 필드)다.
 */
import { parseInitFrame } from "@cp949/runo-pyodide-core/worker";
import { createInitFrame } from "@cp949/runo-pyodide-core/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { replDriver } from "../../src/worker/repl-driver";

/** `createFrame`이 연 포트. `afterEach`가 닫는다. */
const ports: MessagePort[] = [];

afterEach(() => {
  for (const port of ports.splice(0)) port.close();
});

/** main이 보내는 것과 같은 모양의 초기화 프레임. `driver` 필드만 시험이 정한다. */
function createFrame(driver: unknown) {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  return createInitFrame({ rpcPort: port1, driver });
}

/** worker가 프레임을 받은 뒤 하는 검증 전체(core 필드 → driver 필드). */
function validateFrame(driver: unknown) {
  return replDriver.parseOptions(parseInitFrame(createFrame(driver)).driver);
}

describe("parseInitFrame", () => {
  it("topLevelAwait가 boolean이 아니면 던진다", () => {
    expect(() => validateFrame({ topLevelAwait: "true" })).toThrow(
      /topLevelAwait/,
    );
  });
});

describe("replDriver.parseOptions: driver 옵션 검증", () => {
  it.each([true, false])("topLevelAwait: %j는 그대로 돌려준다", (value) => {
    expect(validateFrame({ topLevelAwait: value })).toEqual({
      topLevelAwait: value,
    });
  });

  it.each([
    { label: "undefined", driver: undefined },
    { label: "null", driver: null },
    { label: "문자열", driver: "topLevelAwait" },
    { label: "숫자", driver: 1 },
    { label: "배열", driver: [true] },
  ])("옵션 객체가 아니면 던진다: $label", ({ driver }) => {
    expect(() => replDriver.parseOptions(driver)).toThrow(/driver/);
  });

  it("topLevelAwait가 없으면 그 필드 이름을 담은 오류를 던진다", () => {
    expect(() => replDriver.parseOptions({})).toThrow(/topLevelAwait/);
  });

  it.each([
    { label: "문자열", value: "true" },
    { label: "숫자", value: 1 },
    { label: "null", value: null },
    { label: "undefined", value: undefined },
  ])("topLevelAwait가 boolean이 아니면 던진다: $label", ({ value }) => {
    expect(() => replDriver.parseOptions({ topLevelAwait: value })).toThrow(
      /topLevelAwait.*boolean/,
    );
  });

  it("알 수 없는 필드는 무시하고 topLevelAwait만 돌려준다", () => {
    expect(
      replDriver.parseOptions({ topLevelAwait: true, extra: "무시" }),
    ).toEqual({ topLevelAwait: true });
  });
});
