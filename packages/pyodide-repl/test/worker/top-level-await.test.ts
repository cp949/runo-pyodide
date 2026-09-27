// @vitest-environment node
/**
 * top-level await 비트 토글(`setTopLevelAwait`) 시험(02-console-core.md 5.4, TRAP-03).
 * 실제 `PyodideConsole`의 컴파일 플래그(`_compile.compiler.flags`, pyodide private 경로)를 읽고 쓴다.
 * 이 경로가 바뀌면 pyodide 버전 업그레이드 알림으로 첫 시험이 먼저 깨진다(09-testing.md 9.1).
 */
import type { PyProxy } from "pyodide/ffi";
import { loadPyodide, type PyodideInterface } from "pyodide";
import { beforeAll, describe, expect, onTestFinished, test } from "vitest";
import { createConsole } from "../../src/worker/console";
import {
  DEFAULT_CONSOLE_FLAGS,
  hasCompilerFlags,
  setTopLevelAwait,
  TOP_LEVEL_AWAIT_FLAG,
  type CompilerFlagsHolder,
} from "../../src/worker/top-level-await";

interface TestConsole extends PyProxy, CompilerFlagsHolder {
  push(line: string): PyProxy & { syntax_check: string };
}

let pyodide: PyodideInterface;

beforeAll(async () => {
  pyodide = await loadPyodide();
  pyodide.runPython("import asyncio");
}, 60_000);

/** 이 시험이 쓸 새 콘솔. 콜백은 잇지 않는다. */
function createTestConsole(): TestConsole {
  const consoleModule = pyodide.pyimport("pyodide.console");
  return consoleModule.PyodideConsole(pyodide.globals) as TestConsole;
}

/**
 * top-level `await`를 push해 판정만 보고 future를 버린다. `await 1`은 켜진 상태에서 실제로 실행돼 회수되지 않는
 * `TypeError`가 stderr에 남으므로, 정상 완료되는 `asyncio.sleep(0)`을 쓴다.
 */
function syntaxCheckOfAwait(pyconsole: TestConsole): string {
  const future = pyconsole.push("await asyncio.sleep(0)");
  try {
    return future.syntax_check;
  } finally {
    future.destroy();
  }
}

describe("setTopLevelAwait", () => {
  test("생성 직후 콘솔 플래그는 0x6200이고 비공개 경로 _compile.compiler.flags가 숫자다", () => {
    const pyconsole = createTestConsole();

    const flags = pyconsole._compile.compiler.flags;

    expect(typeof flags).toBe("number");
    expect(flags).toBe(0x6200);
    expect(DEFAULT_CONSOLE_FLAGS).toBe(0x6200);
    expect(TOP_LEVEL_AWAIT_FLAG).toBe(0x2000);
  });

  test("false면 TLA 비트만 꺼져 0x4200이 된다", () => {
    const pyconsole = createTestConsole();

    setTopLevelAwait(pyconsole, false);

    expect(pyconsole._compile.compiler.flags).toBe(0x4200);
  });

  test("true면 다시 0x6200이다", () => {
    const pyconsole = createTestConsole();
    setTopLevelAwait(pyconsole, false);

    setTopLevelAwait(pyconsole, true);

    expect(pyconsole._compile.compiler.flags).toBe(0x6200);
  });

  test("끄면 top-level await가 syntax-error, 켜면 complete로 판정된다", () => {
    const pyconsole = createTestConsole();

    setTopLevelAwait(pyconsole, false);
    expect(syntaxCheckOfAwait(pyconsole)).toBe("syntax-error");

    setTopLevelAwait(pyconsole, true);
    expect(syntaxCheckOfAwait(pyconsole)).toBe("complete");
  });
});

/**
 * 처리되지 않은 Promise 거부 수를 센다(RD-009 기준선, `09-testing.md` 9.5 5번, `webloop-reraise.test.ts` 사본).
 */
function trackRejections(): { count(): number } {
  let count = 0;
  const onRejection = () => {
    count += 1;
  };
  process.on("unhandledRejection", onRejection);
  onTestFinished(() => {
    process.off("unhandledRejection", onRejection);
  });
  return { count: () => count };
}

/** 재보고는 실행이 끝난 뒤 이벤트 루프가 한 틱 돌 때 도착한다. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

describe("asyncio.run(main())(RD-012)", () => {
  test.each([
    { topLevelAwait: false, bareAwait: "syntax-error" as const },
    { topLevelAwait: true, bareAwait: "complete" as const },
  ])(
    "topLevelAwait=$topLevelAwait 에서도 asyncio.run(main())이 완료되고 값을 돌려준다",
    async ({ topLevelAwait, bareAwait }) => {
      const rejections = trackRejections();
      // 정의는 console 층을 거치지 않는다(`sigint-handler-idle.test.ts`와 같은 방식). runLine이 보는 것은
      // `asyncio.run(main())` 한 줄뿐이다.
      pyodide.runPython(
        "async def main():\n    await asyncio.sleep(0)\n    return 42\n",
        { globals: pyodide.globals, filename: "<console>" },
      );
      const repl = createConsole(
        pyodide,
        { write: () => {}, writeErrorRaw: () => {} },
        { topLevelAwait },
      );

      const call = await repl.runLine("asyncio.run(main())");
      expect(call).toEqual({ kind: "complete", echo: "42", exited: false });

      const bare = await repl.runLine("await asyncio.sleep(0)", {
        echo: false,
      });
      expect(bare.kind).toBe(bareAwait);

      await settle();
      expect(rejections.count()).toBe(0);
    },
  );
});

describe("hasCompilerFlags(compiler-flags 탐지)", () => {
  test("`_compile.compiler.flags`가 숫자이면 참이다", () => {
    expect(
      hasCompilerFlags({ _compile: { compiler: { flags: 0x6200 } } }),
    ).toBe(true);
  });

  test("flags가 0이어도 숫자이므로 참이다", () => {
    expect(hasCompilerFlags({ _compile: { compiler: { flags: 0 } } })).toBe(
      true,
    );
  });

  test.each([
    ["`_compile`이 없다", {}],
    ["`_compile`이 undefined다", { _compile: undefined }],
    ["`compiler`가 없다", { _compile: {} }],
    ["`compiler`가 null이다", { _compile: { compiler: null } }],
    ["`flags`가 없다", { _compile: { compiler: {} } }],
    ["`flags`가 문자열이다", { _compile: { compiler: { flags: "0x6200" } } }],
    ["`flags`가 null이다", { _compile: { compiler: { flags: null } } }],
  ])("경로가 기대와 다르면 거짓이다: %s", (_name, holder) => {
    expect(hasCompilerFlags(holder)).toBe(false);
  });

  test("접근이 던지면 거짓이다", () => {
    const holder = {
      get _compile(): never {
        throw new Error("접근 불가");
      },
    };

    expect(hasCompilerFlags(holder)).toBe(false);
  });

  test("실제 콘솔에서는 참이고, `_compile.compiler.flags`를 지운 콘솔에서는 거짓이다", () => {
    const real = createTestConsole();
    const withoutFlags = createTestConsole();
    pyodide.globals.set("no_flags_console", withoutFlags);
    pyodide.runPython(
      "import types\nno_flags_console._compile.compiler = types.SimpleNamespace()",
    );

    expect(hasCompilerFlags(real)).toBe(true);
    expect(hasCompilerFlags(withoutFlags)).toBe(false);
    pyodide.runPython("del no_flags_console");
  });
});
