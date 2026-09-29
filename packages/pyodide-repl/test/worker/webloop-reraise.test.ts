// @vitest-environment node
/**
 * WebLoop 재보고 억제 시험(03-ctrl-c.md 2.8, 09-testing.md 9.1).
 * - WebLoop이 콜백 안의 `KeyboardInterrupt`·`SystemExit`을 다시 던지는 경로는 pyodide의 이벤트 루프·Task·JS Promise에 걸친다.
 * - 실제 pyodide(node)에서만 재현되므로 mock 없이 로드한다.
 * - 콘솔 러너 경로(`createConsole` → `createSubmissionRunner`)로 돌려 `<console>` 프레임에서 예외를 낸다.
 * - 버퍼·SIGINT 핸들러는 쓰지 않는다. 사용자 코드가 직접 raise한다.
 */
import { loadPyodide, type PyodideInterface } from "pyodide";
import type { PyProxy } from "pyodide/ffi";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import { createConsole } from "../../src/worker/console";
import { loadSplitPaste } from "../../src/worker/multiline";
import { createSubmissionRunner } from "../../src/worker/submission-runner";
import {
  suppressWebLoopReraise,
  warnDegraded,
} from "@cp949/runo-pyodide-core/test-utils/worker";

/** 파일 전체가 공유하는 pyodide 인스턴스. `beforeAll`에서 로드한다. */
let pyodide: PyodideInterface;

/**
 * 파일 전체가 공유하는 실제 WebLoop.
 * - `asyncio.get_event_loop()`는 항상 이 객체를 돌려준다.
 * - 억제 설치 가드 시험이 그 함수를 잠시 바꿔도 이 참조 자체는 바뀌지 않는다.
 */
let realLoop: PyProxy;

beforeAll(async () => {
  pyodide = await loadPyodide();
  const namespace = pyodide.toPy({}) as PyProxy & {
    get(name: string): unknown;
  };
  try {
    pyodide.runPython("import asyncio\nloop = asyncio.get_event_loop()", {
      globals: namespace,
    });
    realLoop = namespace.get("loop") as PyProxy;
  } finally {
    namespace.destroy();
  }
}, 60_000);

/**
 * `realLoop`의 속성 하나를 `None`으로 되돌린다.
 * - 패치된 `asyncio.get_event_loop`와 무관하게 실제 객체를 직접 만진다.
 * - JS `null`을 값으로 넘기면 `pyodide.ffi.JsNull`이 되어 `is None`이 거짓이 된다. 그래서 Python 리터럴 `None`을 그대로 쓴다.
 */
function resetLoopAttrToNone(name: string): void {
  const namespace = pyodide.toPy({}) as PyProxy & {
    set(name: string, value: unknown): void;
  };
  try {
    namespace.set("loop", realLoop);
    pyodide.runPython(`loop.${name} = None`, { globals: namespace });
  } finally {
    namespace.destroy();
  }
}

/** `realLoop`의 속성 하나가 `None`인지 본다. */
function loopAttrIsNone(name: string): boolean {
  const namespace = pyodide.toPy({}) as PyProxy & {
    set(name: string, value: unknown): void;
  };
  try {
    namespace.set("loop", realLoop);
    return pyodide.runPython(`loop.${name} is None`, {
      globals: namespace,
    }) as boolean;
  } finally {
    namespace.destroy();
  }
}

/** `realLoop`에 속성 하나가 있는지 본다. */
function loopHasAttr(name: string): boolean {
  const namespace = pyodide.toPy({}) as PyProxy & {
    set(name: string, value: unknown): void;
  };
  try {
    namespace.set("loop", realLoop);
    return pyodide.runPython(`hasattr(loop, ${JSON.stringify(name)})`, {
      globals: namespace,
    }) as boolean;
  } finally {
    namespace.destroy();
  }
}

/** 새 콘솔과 러너를 만들고 재보고 억제를 설치한다. `screen`은 화면에 쌓일 텍스트다. */
function setup() {
  const screen = { stdout: "", stderr: "" };
  const repl = createConsole(
    pyodide,
    {
      write: (text) => {
        screen.stdout += text;
      },
      writeErrorRaw: (text) => {
        screen.stderr += text;
      },
    },
    { topLevelAwait: false },
  );
  suppressWebLoopReraise(pyodide, {
    report: warnDegraded,
  });
  const { run } = createSubmissionRunner(
    pyodide,
    repl,
    {
      writeOutput: (text) => {
        screen.stdout += `${text}\n`;
      },
      writeError: (text) => {
        screen.stderr += `${text}\n`;
      },
    },
    { splitPaste: loadSplitPaste(pyodide) },
  );
  return { run, screen };
}

/**
 * 처리되지 않은 Promise 거부 수를 센다.
 * - 리스너를 붙인 시험에서는 vitest가 프로세스 리스너 수로 집계 여부를 판단한다(09-testing.md 9.5 5번, TRAP-22).
 * - 그래서 이 카운터가 유일한 회귀 신호다.
 * - 리스너는 `onTestFinished`로 반드시 뗀다.
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

/** 재보고는 실행이 끝난 뒤 이벤트 루프가 한 틱 돌 때 도착한다. 그 틱까지 기다린다. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

describe("pyodide WebLoop 가정", () => {
  // 억제는 고정 버전(`PYODIDE_VERSION`) pyodide의 private 속성에 기댄다.
  // pyodide를 올렸을 때 속성이 사라졌는지 이 시험이 알려 준다.
  // 다른 describe가 설치를 하기 전에 실행돼야 "설치 전 값은 None"을 관측할 수 있다.
  it("_keyboard_interrupt_handler·_system_exit_handler 속성이 있고 억제 설치 전 값은 None이다", () => {
    expect(loopHasAttr("_keyboard_interrupt_handler")).toBe(true);
    expect(loopHasAttr("_system_exit_handler")).toBe(true);
    expect(loopAttrIsNone("_keyboard_interrupt_handler")).toBe(true);
    expect(loopAttrIsNone("_system_exit_handler")).toBe(true);
  });
});

describe("WebLoop 재보고 억제", () => {
  it("실행 중 KeyboardInterrupt는 처리되지 않은 Promise 거부를 남기지 않고 표준 트레이스백을 낸다", async () => {
    const { run, screen } = setup();
    const rejections = trackRejections();

    await run("raise KeyboardInterrupt");
    await settle();

    expect(screen.stderr).toBe(
      'Traceback (most recent call last):\n  File "<console>", line 1, in <module>\nKeyboardInterrupt\n',
    );
    expect(rejections.count()).toBe(0);
  });

  it("exit()는 처리되지 않은 Promise 거부 없이 exit: true를 돌려준다", async () => {
    const { run } = setup();
    const rejections = trackRejections();

    expect(await run("exit()")).toMatchObject({ exit: true });
    await settle();

    expect(rejections.count()).toBe(0);
  });

  it("raise SystemExit(3)도 처리되지 않은 Promise 거부 없이 exit: true를 돌려준다", async () => {
    const { run } = setup();
    const rejections = trackRejections();

    expect(await run("raise SystemExit(3)")).toMatchObject({ exit: true });
    await settle();

    expect(rejections.count()).toBe(0);
  });
});

describe("억제 설치 가드", () => {
  // 패치 전의 `asyncio.get_event_loop`. 비어 있지 않으면 아직 원복하지 않은 상태다. `afterEach`가 원복한다.
  let savedGetEventLoop: PyProxy | undefined;

  afterEach(() => {
    if (!savedGetEventLoop) return;
    const namespace = pyodide.toPy({}) as PyProxy & {
      set(name: string, value: unknown): void;
    };
    try {
      namespace.set("original", savedGetEventLoop);
      pyodide.runPython("import asyncio\nasyncio.get_event_loop = original", {
        globals: namespace,
      });
    } finally {
      namespace.destroy();
      savedGetEventLoop.destroy();
      savedGetEventLoop = undefined;
    }
  });

  it("WebLoop에 두 속성이 모두 있으면 report를 부르지 않는다", () => {
    const reports: [string, string][] = [];

    suppressWebLoopReraise(pyodide, {
      report: (id, detail) => reports.push([id, detail]),
    });

    expect(reports).toEqual([]);
  });

  it("WebLoop에 두 속성이 모두 없으면 설치를 건너뛰고 없는 이름마다 webloop-handlers로 report한다(부분 설치 없음)", () => {
    // 이전 시험이 설치해 둔 흔적을 지워 실제 loop을 초기 상태(`None`)로 되돌린다.
    resetLoopAttrToNone("_keyboard_interrupt_handler");
    resetLoopAttrToNone("_system_exit_handler");

    // `asyncio.get_event_loop`를 속성이 하나도 없는 객체를 돌려주는 함수로 바꾼다.
    // `install()`은 이 함수가 돌려준 객체만 만진다. 실제 loop(`realLoop`)는 이 시험 동안 전혀 건드려지지 않아야 한다.
    const namespace = pyodide.toPy({}) as PyProxy & {
      get(name: string): unknown;
    };
    try {
      pyodide.runPython(
        [
          "import asyncio, types",
          "_original = asyncio.get_event_loop",
          "asyncio.get_event_loop = lambda: types.SimpleNamespace()",
        ].join("\n"),
        { globals: namespace },
      );
      savedGetEventLoop = namespace.get("_original") as PyProxy;
    } finally {
      namespace.destroy();
    }

    const reports: [string, string][] = [];
    suppressWebLoopReraise(pyodide, {
      report: (id, detail) => reports.push([id, detail]),
    });

    expect(reports).toEqual([
      ["webloop-handlers", "_keyboard_interrupt_handler"],
      ["webloop-handlers", "_system_exit_handler"],
    ]);
    // 부분 설치가 없었다는 뜻이다. 실제 loop의 두 속성은 손대지 않아 그대로 `None`이다.
    expect(loopAttrIsNone("_keyboard_interrupt_handler")).toBe(true);
    expect(loopAttrIsNone("_system_exit_handler")).toBe(true);
  });

  // 위 시험은 둘 다 없는 loop(`SimpleNamespace()`)를 쓴다.
  // 그 경우 "부분 설치"와 "전부 건너뜀"은 만질 속성이 하나도 없어 결과가 똑같다. 구분이 안 된다.
  // 한쪽만 없는 실제 loop으로 그 차이를 드러낸다. 부분 설치를 허용하면 남아 있는 속성까지 no-op으로 바뀐다.
  it("한쪽 속성만 없으면 그 이름만 알리고 남은 속성은 손대지 않는다(부분 결여)", () => {
    resetLoopAttrToNone("_keyboard_interrupt_handler");
    const namespace = pyodide.toPy({}) as PyProxy & {
      set(name: string, value: unknown): void;
    };
    try {
      namespace.set("loop", realLoop);
      pyodide.runPython("del loop._system_exit_handler", {
        globals: namespace,
      });
    } finally {
      namespace.destroy();
    }
    try {
      const reports: [string, string][] = [];
      suppressWebLoopReraise(pyodide, {
        report: (id, detail) => reports.push([id, detail]),
      });

      // 없는 이름만 알린다.
      expect(reports).toEqual([["webloop-handlers", "_system_exit_handler"]]);
      // 부분 설치가 없었다는 뜻이다. 있던 속성(`_keyboard_interrupt_handler`)도 손대지 않아 그대로 `None`이다.
      expect(loopAttrIsNone("_keyboard_interrupt_handler")).toBe(true);
    } finally {
      // 지운 속성을 되돌려 다음 시험에 흔적을 남기지 않는다.
      const restore = pyodide.toPy({}) as PyProxy & {
        set(name: string, value: unknown): void;
      };
      try {
        restore.set("loop", realLoop);
        pyodide.runPython("loop._system_exit_handler = None", {
          globals: restore,
        });
      } finally {
        restore.destroy();
      }
    }
  });
});
