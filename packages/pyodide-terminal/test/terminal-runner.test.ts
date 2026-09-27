/**
 * `createTerminalRunner` 시험(RD-022 DELTA-06, RD-031 DELTA-01). 실제 벤더 `Readline`·실제 sink·실제 선택 복사를 가짜 터미널
 * (`@repo/pyodide-testkit/fake-terminal`)에 붙이고, core도 실제 `createRunner`를 쓴다 — worker만 공용 가짜
 * (`@cp949/runo-pyodide-core/test-utils`)로 둔다. 가짜 core 주입 자리(내부 팩토리)는 RD-031에서 삭제됐다: runner
 * 규칙(거부 분기·`busy`·상태 전이)은 core `runner.test.ts`가 소유하고, 이 파일은 실행창이 그 위에 붙이는 화면(sink)·입력
 * (`Readline`)·Ctrl+C·선택 복사만 본다. 공용 setup은 `./test/runner-setup`(`terminal-runner-screen.test.ts`와 공유).
 * `run()` 시작 화면 준비 시험은 `terminal-runner-screen.test.ts`에 있다. 실제 pyodide 왕복은 브라우저 L1이 본다.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { RunRejectedError, type RunnerStatus } from "@cp949/runo-pyodide-core";
import { stubClipboard } from "@repo/pyodide-testkit/clipboard";
import { createFakeTerminal } from "@repo/pyodide-testkit/fake-terminal";
import { VtScreen, attachVtScreen } from "@repo/pyodide-testkit/vt-screen";
import { createTerminalRunner } from "../src/terminal-runner";
import { factory, setupReal, tick } from "./runner-setup";

const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  localStorage.clear();
});

describe("키 정책: 읽기 밖 입력은 무시한다(typeAhead: false)", () => {
  test("running 중 친 문자는 화면에 나타나지 않고 다음 input() 읽기에도 들어가지 않는다", async () => {
    const { fake, handle, screen, worker, startInput, finishRun } =
      await setupReal();
    void handle.run("code");
    expect(handle.status).toBe("running");

    fake.type("abc");
    expect(screen()).not.toContain("abc");

    await startInput();
    fake.type("\r");
    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "line",
      text: "",
    });
    await finishRun();
  });

  test("running 중 붙여넣기(다중 문자·개행 포함)도 버려진다", async () => {
    const { fake, handle, screen, worker, startInput, finishRun } =
      await setupReal();
    void handle.run("code");

    fake.paste("hello\nworld");
    expect(screen()).not.toContain("hello");

    await startInput();
    fake.type("\r");
    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "line",
      text: "",
    });
    await finishRun();
  });

  test("ready에서 친 문자도 버려진다", async () => {
    const { fake, handle, screen, worker, startInput } = await setupReal();

    fake.type("abc");
    fake.paste("xyz");
    expect(screen()).toBe("");

    void handle.run("code");
    await startInput();
    fake.type("\r");
    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "line",
      text: "",
    });
  });

  test("waiting-input 중에는 한 줄을 편집하고 Enter로 전달한다", async () => {
    const { fake, screen, worker, startInput } = await setupReal();
    await startInput("이름: ");

    fake.type("ab");
    fake.type("\x7f"); // Backspace
    fake.type("c\r");

    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "line",
      text: "ac",
    });
    // 프롬프트(core가 넘기는 prompt 인자가 아니라 자체 꼬리를 쓴다)와 입력이 화면에 그려졌다.
    expect(screen()).toContain("ac");
  });

  test("Enter로 제출한 입력줄은 history에 남지 않아 다음 읽기에서 ↑로 되살아나지 않는다", async () => {
    const { fake, worker, startInput } = await setupReal();
    await startInput();
    fake.type("first\r");
    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "line",
      text: "first",
    });
    await tick();

    await startInput();
    fake.type("\x1b[A"); // ↑
    fake.type("\r");

    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "line",
      text: "",
    });
  });

  test("history를 localStorage에 저장하지 않는다(persist: false)", async () => {
    const { fake, worker, startInput } = await setupReal();
    await startInput();

    fake.type("secret\r");
    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "line",
      text: "secret",
    });

    expect(localStorage.getItem("history")).toBeNull();
  });
});

describe("[T2] 기본 입력 공급자의 EOF(RD-048)", () => {
  test("빈 줄 Ctrl+D는 공급자 결과를 STDIN_EOF로 끝내 메일박스에 eof로 실린다", async () => {
    const { fake, worker, startInput } = await setupReal();
    await startInput();

    fake.type("\x04");

    await expect(worker().takeResponse()).resolves.toEqual({ kind: "eof" });
  });
});

describe("Ctrl+C: 상태별 분기 4종", () => {
  test("선택이 있으면 복사하고 선택을 지우며 실행은 중단하지 않는다", async () => {
    const writeText = stubClipboard();
    const onCopy = vi.fn();
    const { fake, handle, screen, worker } = await setupReal({
      runner: { onCopy },
    });
    void handle.run("code");
    fake.select("복사할 글");

    const passedToXterm = fake.keyDown({ key: "c", ctrlKey: true });
    await tick();

    expect(passedToXterm).toBe(false);
    expect(writeText).toHaveBeenCalledWith("복사할 글");
    expect(onCopy).toHaveBeenCalledWith({ ok: true, chars: 5 });
    expect(fake.clearSelectionCalls).toBe(1);
    expect(worker().signal()).toBe(0);
    expect(screen()).not.toContain("^C");
  });

  test("[C1] running이면 ^C를 표시하고 interrupt를 보낸다", async () => {
    const { fake, handle, screen, worker } = await setupReal();
    void handle.run("code");
    expect(handle.status).toBe("running");

    fake.type("\x03");

    expect(screen()).toContain("^C");
    expect(worker().signal()).toBe(2);
  });

  test("running 중 ^C 표시는 꼬리에 남아 다음 input() 프롬프트에 이어 그려진다", async () => {
    const { fake, handle, worker, startInput } = await setupReal();
    void handle.run("code");
    worker().write("t");
    await vi.waitFor(() => expect(fake.written.join("")).toContain("t"));
    fake.type("\x03");

    await startInput();
    fake.type("x\r");

    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "line",
      text: "x",
    });
    // `t^C`가 프롬프트다(tty 로컬 에코 흉내, REPL과 같다).
    expect(fake.written.join("")).toContain("t^Cx");
  });

  test("waiting-input이고 읽기가 열려 있으면 벤더가 읽기를 취소하고 interrupt는 따로 보내지 않는다", async () => {
    const { fake, handle, screen, worker, startInput } = await setupReal();
    await startInput("x: ");
    expect(handle.status).toBe("waiting-input");

    // 전제: 읽기가 열려 있다(키가 그려진다). 그래야 Ctrl+C가 핸들러가 아니라 벤더로 간다.
    const beforeKeys = fake.written.length;
    fake.type("ab");
    expect(fake.written.slice(beforeKeys).join("")).toContain("ab");
    fake.type("\x03");

    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "cancelled",
    });
    expect(worker().signal()).toBe(0);
    expect(screen()).not.toContain("^C");
  });

  test("[C2] waiting-input이지만 읽기가 아직 그려지기 전이면 runner.interrupt로 읽기를 취소한다", async () => {
    const { fake, handle, worker, screen, startInput } = await setupReal({
      terminal: { asyncWrite: true },
    });
    // write 콜백이 오기 전이라 벤더에 활성 읽기가 없다. 이 구간의 Ctrl+C는 핸들러로 온다.
    await startInput("x: ");
    expect(handle.status).toBe("waiting-input");
    // 전제: 벤더에 활성 읽기가 없다(키가 그려지지 않는다). 그래야 Ctrl+C가 핸들러로 온다.
    const beforeKeys = fake.written.length;
    fake.type("q");
    expect(fake.written.slice(beforeKeys)).toEqual([]);

    fake.type("\x03");

    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "cancelled",
    });
    expect(worker().signal()).toBe(0);
    expect(screen()).not.toContain("^C");
    fake.flush();
  });

  test("[C2] inputProvider를 직접 준 waiting-input에서도 Ctrl+C는 runner.interrupt로 읽기를 취소한다", async () => {
    let seenSignal: AbortSignal | undefined;
    const inputProvider = vi.fn((_prompt: string, signal: AbortSignal) => {
      seenSignal = signal;
      return new Promise<string | null>(() => {});
    });
    const { fake, handle, worker, screen, startInput } = await setupReal({
      runner: { inputProvider },
    });
    await startInput("x: ");
    expect(handle.status).toBe("waiting-input");

    fake.type("\x03");

    expect(seenSignal?.aborted).toBe(true);
    expect(worker().signal()).toBe(0);
    expect(screen()).not.toContain("^C");
  });

  test("[C3] ready에서는 아무 일도 하지 않는다(^C 표시 없음·interrupt 없음)", async () => {
    const { fake, handle, screen, worker } = await setupReal();

    fake.type("\x03");

    expect(handle.status).toBe("ready");
    expect(worker().signal()).toBe(0);
    expect(screen()).toBe("");
  });

  test("[C3] loading·restarting·crashed 같은 그 밖의 상태에서도 무동작이다", async () => {
    // loading: worker의 ready를 보내지 않은 채로 둔다.
    {
      const { fake, handle, worker } = await setupReal({ ready: false });
      expect(handle.status).toBe("loading");

      fake.type("\x03");

      expect(fake.written).toEqual([]);
      expect(worker().signal()).toBe(0);
    }
    // restarting: reset()으로 들어간다.
    {
      const { fake, handle } = await setupReal();
      handle.reset();
      expect(handle.status).toBe("restarting");
      fake.written.length = 0;

      fake.type("\x03");

      expect(fake.written).toEqual([]);
      // reset()이 새 worker를 만든다 — 그 worker(마지막으로 만들어진 worker)에도 SIGINT가 가지 않는다.
      expect(factory.workers.at(-1)!.signal()).toBe(0);
    }
    // crashed: worker crashed 알림으로 들어간다.
    {
      const { fake, handle, worker } = await setupReal();
      worker().crashedNotice("boom");
      await vi.waitFor(() => expect(handle.status).toBe("crashed"));
      fake.written.length = 0;

      fake.type("\x03");

      expect(fake.written).toEqual([]);
      expect(worker().signal()).toBe(0);
    }
  });

  test("[C3] running인데 세션이 끝나(sessionTerminated) 눌림을 보내지 않으면 ^C를 쓰지 않는다", async () => {
    const { fake, handle, screen, worker } = await setupReal();
    void handle.run("code");
    expect(handle.status).toBe("running");

    // 실제 runDriver는 보내지 않는 알림이다(design.md P-e, P-d). core의 `pythonRunning()`을 거짓으로 만들어
    // I3 조건(`active?.phase === "sent" && session?.pythonRunning()`)이 성립하지 않는 상황을 재현한다.
    // 알림은 MessagePort를 타고 비동기로 도착한다 — 같은 포트의 뒤 알림(write)이 그려질 때까지 기다려 반영을 확인한 뒤
    // Ctrl+C를 친다.
    worker().sessionTerminated();
    worker().write("·");
    await vi.waitFor(() => expect(screen()).toContain("·"));
    fake.type("\x03");

    expect(handle.status).toBe("running");
    expect(screen()).not.toContain("^C");
    expect(worker().signal()).toBe(0);
  });
});

describe("clear()", () => {
  test("화면을 지우는 시퀀스를 쓴다", async () => {
    const { handle, screen } = await setupReal();

    handle.clear();

    expect(screen()).toContain("\x1b[2J");
  });

  test("sink 꼬리를 비워 지운 뒤 input() 프롬프트가 지워진 출력을 되살리지 않는다", async () => {
    const { fake, handle, worker, startInput } = await setupReal();
    worker().write("abc");
    await vi.waitFor(() => expect(fake.written.join("")).toContain("abc"));
    handle.clear();
    const before = fake.written.length;

    await startInput();

    expect(fake.written.slice(before).join("")).not.toContain("abc");
  });

  test("입력을 기다리는 중(읽기가 열린 동안)에는 아무것도 하지 않는다", async () => {
    const { fake, handle, startInput } = await setupReal();
    await startInput("x: ");
    const before = fake.written.length;

    handle.clear();

    expect(fake.written).toHaveLength(before);
  });
});

describe("출력 연결", () => {
  test("stdout은 그대로, stderr는 빨강으로 화면에 쓰고 onOutput에도 알린다", async () => {
    const onOutput = vi.fn();
    const { screen, worker } = await setupReal({ runner: { onOutput } });

    worker().write("out");
    worker().writeError("err");

    await vi.waitFor(() => expect(screen()).toBe(`out${RED}err${RESET}`));
    expect(onOutput).toHaveBeenNthCalledWith(1, {
      stream: "stdout",
      text: "out",
    });
    expect(onOutput).toHaveBeenNthCalledWith(2, {
      stream: "stderr",
      text: "err",
    });
  });

  test("input()의 프롬프트는 직전 출력의 꼬리로 그려진다", async () => {
    const { fake, worker, startInput } = await setupReal();
    await startInput("이름: ");

    fake.type("홍\r");

    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "line",
      text: "홍",
    });
    // Enter 때 프롬프트와 입력이 한 조각으로 다시 그려진다.
    expect(fake.written).toContain("이름: 홍");
  });

  test("pyodide 로드 실패 메시지를 빨강 한 줄로 낸다", async () => {
    const { screen, worker } = await setupReal({ ready: false });

    worker().loadFailed("네트워크 오류");

    await vi.waitFor(() =>
      expect(screen()).toBe(
        `${RED}pyodide 로드 실패: 네트워크 오류${RESET}\r\n`,
      ),
    );
  });
});

describe("input() 대기 중 배경 출력(RD-022b)", () => {
  /** 화면을 `VtScreen`으로 해석하는 가짜 터미널로 실행창을 만들고 실행 중 `input("x: ")` 읽기에 `ab`를 친 상태로 둔다. */
  async function setupWaitingInput() {
    const fake = createFakeTerminal();
    const vt = new VtScreen(80, 24);
    attachVtScreen(fake, vt);
    const context = await setupReal({ fake });
    void context.handle.run("code");
    await context.startInput("x: ");
    fake.type("ab");
    return { ...context, vt };
  }

  test("stdout 행은 입력줄 위에 쓰이고 프롬프트·입력은 그 아래에 다시 그려지며 Enter 값은 그대로다", async () => {
    const { fake, vt, worker, finishRun } = await setupWaitingInput();
    expect(vt.screen()).toBe("x: ab");

    worker().write("tick\n");
    await vi.waitFor(() => expect(vt.screen()).toBe("tick\nx: ab"));

    fake.type("c\r");
    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "line",
      text: "abc",
    });
    expect(vt.lines()).toEqual(["tick", "x: abc"]);
    await finishRun();
  });

  test("stderr 행도 같은 경로로 입력줄 위에 쓰이고 onOutput에는 조각 그대로 알린다", async () => {
    const onOutput = vi.fn();
    const fake = createFakeTerminal();
    const vt = new VtScreen(80, 24);
    attachVtScreen(fake, vt);
    const { handle, worker, startInput, finishRun } = await setupReal({
      fake,
      runner: { onOutput },
    });
    void handle.run("code");
    await startInput("x: ");
    fake.type("ab");

    worker().writeError("warn\n");

    await vi.waitFor(() => expect(vt.screen()).toBe("warn\nx: ab"));
    expect(onOutput).toHaveBeenLastCalledWith({
      stream: "stderr",
      text: "warn\n",
    });
    fake.type("\r");
    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "line",
      text: "ab",
    });
    await finishRun();
  });

  test("개행 없는 조각은 프롬프트 앞 접두가 되고 Enter 뒤 다음 input() 프롬프트에 섞이지 않는다", async () => {
    const { fake, vt, worker, startInput, finishRun } =
      await setupWaitingInput();

    worker().write("tick");
    await vi.waitFor(() => expect(vt.screen()).toBe("tickx: ab"));

    fake.type("\r");
    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "line",
      text: "ab",
    });
    await startInput("y: ");
    // `lines()`는 행 끝 공백을 자른다. 다음 프롬프트는 `y: `뿐이다(`tick`은 꼬리에 들어가지 않았다).
    expect(vt.lines()).toEqual(["tickx: ab", "y:"]);
    fake.type("\r");
    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "line",
      text: "",
    });
    await finishRun();
  });
});

describe("상태·크래시 전달", () => {
  // [결정] 가짜 core는 `core.setStatus("running")·("waiting-input")·("ready")`를 직접 세 번 불러 상태만 흉내 냈다(실행 중인
  // run과 무관). 실제 core에서 "waiting-input" 뒤 "ready"(다음 "running"을 거치지 않고)로 가려면 그 읽기가 실행 중인 run에
  // 묶이지 않은 배경 읽기여야 하고(P-d), "running"이 먼저 나오려면 실행 중인 run이 있어야 한다(그 run의 읽기는 취소돼도
  // `active.phase`가 그대로라 "running"으로 돌아간다, `runner.ts` `inputResumed`) — 두 조건이 같은 흐름에서 동시에 성립하지
  // 않아 기존 배열(`["running","waiting-input","ready"]`)을 실제 사건으로는 재현할 수 없었다(설계 §3.4 "기대값 원칙"의
  // 멈추는 지점 후보). 대신 "실행 중 input() 한 번을 마치고 끝나는" 가장 가까운 실제 흐름(`["running","waiting-input",
  // "running","ready"]`)으로 바꾼다 — 포워딩 자체(onStatus 순서 그대로·getter가 core 상태와 일치)는 다른 시험(onCrash·
  // not-isolated)도 간접적으로 검증해 틀렸을 때 비용은 낮다. **사용자 확인 필요**: 기대 배열이 바뀌는 것이므로 병합 전
  // 확인받는다.
  test("core 상태 알림을 onStatus로 그대로 전달하고 status 게터는 core 상태를 읽는다", async () => {
    const { fake, handle, worker, statuses, startInput, finishRun } =
      await setupReal();
    statuses.length = 0;

    const running = handle.run("code");
    expect(handle.status).toBe("running");

    await startInput();
    expect(handle.status).toBe("waiting-input");

    fake.type("\r");
    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "line",
      text: "",
    });
    await vi.waitFor(() => expect(handle.status).toBe("running"));

    await finishRun();
    await running;
    expect(handle.status).toBe("ready");
    expect(statuses).toEqual(["running", "waiting-input", "running", "ready"]);
  });

  test("onCrash와 crashed 상태를 그대로 전달한다", async () => {
    const onCrash = vi.fn();
    const { handle, worker, statuses } = await setupReal({
      runner: { onCrash },
    });

    worker().crashedNotice("worker 죽음");
    await vi.waitFor(() => expect(onCrash).toHaveBeenCalled());

    expect(onCrash).toHaveBeenCalledWith("worker 죽음");
    expect(statuses).toContain("crashed");
    expect(handle.status).toBe("crashed");
  });

  test("core에 넘기는 옵션(filename·topLevelAwait·pyodide·createWorker)을 그대로 전달한다", async () => {
    const { worker } = await setupReal({
      ready: false,
      runner: {
        filename: "app.py",
        topLevelAwait: true,
        pyodide: { indexURL: "https://example.test/pyodide/" },
      },
    });

    expect(worker().frame().pyodide.indexURL).toBe(
      "https://example.test/pyodide/",
    );
    expect(worker().frame().driver).toEqual({
      filename: "app.py",
      topLevelAwait: true,
    });
  });

  // 예외 1건: 가짜 core의 `stop()`은 실행 여부와 무관하게 항상 `"stopped"`를 돌려줬다. 실제 core는 실행 중인 run이 있어야
  // `"stopped"`다(없으면 `"idle"`, `runner.ts` `stop()`) — 실행 중 run을 `stop()`한 뒤 그 run이 끝나는 흐름으로 재현한다.
  test("stop·reset은 core로 넘기고 결과를 그대로 돌려준다", async () => {
    const { handle, worker, finishRun } = await setupReal();
    void handle.run("code");

    const stopping = handle.stop();
    // stop()이 실제로 core에 닿았다는 증거: 눌림을 보냈다.
    expect(worker().signal()).toBe(2);
    await finishRun();
    await expect(stopping).resolves.toBe("stopped");

    handle.reset();

    // reset()이 실제로 core에 닿았다는 증거: 새 worker를 만든다.
    await vi.waitFor(() => expect(factory.workers.length).toBe(2));
  });
});

describe("inputProvider 옵션", () => {
  // 예외 1건: 가짜 core에서는 프롬프트 자체가 화면에 쓰이지 않아 "화면이 완전히 빈다"를 볼 수 있었다. 실제 worker의
  // `write("x: ")`는 입력 읽기 여부와 무관하게 항상 화면에 그려진다(출력과 입력은 별개 경로) — 여기서 실제로 보는 건
  // "읽기가 없어 키 입력이 화면에 나타나지 않는다"쪽이다.
  test("주면 core에 그대로 넘기고 xterm 읽기는 열지 않는다", async () => {
    const inputProvider = vi.fn(() => new Promise<string | null>(() => {}));
    const { fake, worker, screen } = await setupReal({
      runner: { inputProvider },
    });

    worker().write("x: ");
    worker().readInput();
    await vi.waitFor(() => expect(screen()).toContain("x: "));
    await vi.waitFor(() => expect(inputProvider).toHaveBeenCalled());
    const before = fake.written.length;
    fake.type("abc\r");

    expect(inputProvider).toHaveBeenCalledWith("x: ", expect.any(AbortSignal));
    // 읽기가 없으므로 키 입력은 그려지지 않고 버려진다.
    expect(fake.written.slice(before)).toEqual([]);
  });

  test("주지 않으면 기본 provider(xterm 읽기)를 core에 넘긴다", async () => {
    const { fake, worker, startInput } = await setupReal();

    await startInput("x: ");
    fake.type("z\r");

    // 기본 provider는 xterm에서 읽는다: 화면에 프롬프트·입력이 그려지고 메일박스로 값이 전달된다.
    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "line",
      text: "z",
    });
    expect(fake.written.join("")).toContain("x: z");
  });
});

describe("입력 읽기의 signal abort", () => {
  test("abort되면(stop) 진행 중 읽기를 cancelRead로 끝내고 입력줄 뒤에 줄바꿈을 낸다", async () => {
    const { fake, handle, worker, startInput } = await setupReal();
    void handle.run("code");
    await startInput("x: ");
    fake.type("ab");
    const before = fake.written.length;

    // 실행 중인 run이 있으면 `stop()`의 Promise는 그 run이 끝나야(또는 1000ms 폴백) 풀린다 — 여기서 보는 건 취소
    // 자체(`pendingInput.abandon()`, 호출 안에서 동기)뿐이라 기다리지 않는다.
    void handle.stop();

    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "cancelled",
    });
    // 벤더 settle은 입력줄을 강조 없이 다시 그린 뒤 개행한다(재그리기 조각은 단언하지 않는다).
    const after = fake.written.slice(before);
    expect(after.filter((text) => text === "\r\n")).toHaveLength(1);
    expect(after.at(-1)).toBe("\r\n");
  });

  // 이슈 13: 재그리기 콜백 전 abort하면 벤더가 화면에 아무것도 쓰지 않아 아직 그리지 않은 접두가 사라진다. 호출자가 복원한다.
  describe("재그리기 대기 중 abort의 접두 복원(이슈 13)", () => {
    /** `x: ab`가 그려진 입력 읽기를 열고, 배경 출력 `tick`(개행 없음)의 재그리기 write 콜백은 배출하지 않은 채 둔다. */
    const openWithPendingPrefix = async () => {
      const fake = createFakeTerminal({ asyncWrite: true });
      const vt = new VtScreen(80, 24);
      attachVtScreen(fake, vt);
      const context = await setupReal({ fake });
      void context.handle.run("code");
      await context.startInput("x: ");
      for (let round = 0; round < 3; round += 1) {
        await tick();
        fake.flush();
      }
      fake.type("ab");
      fake.flush();
      await vi.waitFor(() => expect(vt.screen()).toBe("x: ab"));
      return { ...context, vt };
    };

    test("아직 그리지 않은 접두 tick이 화면에 남고 뒤이은 트레이스백이 같은 행에 붙지 않는다", async () => {
      const { fake, handle, worker, vt } = await openWithPendingPrefix();
      worker().write("tick");
      // 입력줄은 지워졌고 접두는 재그리기 콜백을 기다린다.
      await vi.waitFor(() => expect(vt.screen()).toBe(""));

      void handle.stop();
      await expect(worker().takeResponse()).resolves.toEqual({
        kind: "cancelled",
      });
      worker().writeError("Traceback\n");
      fake.flush();
      await tick();
      fake.flush();

      expect(vt.lines()).toEqual(["tick", "Traceback"]);
    });

    test("대조: 재그리기가 끝난 뒤 abort하면 접두가 이미 그려진 행에 있고 다시 쓰지 않는다", async () => {
      const { fake, handle, worker, vt } = await openWithPendingPrefix();
      worker().write("tick");
      // write 알림이 도착해 그 write 콜백이 걸릴 때까지 몇 틱 돈 뒤 배출한다(`openWrappedInput`과 같은 패턴).
      for (let round = 0; round < 3; round += 1) {
        await tick();
        fake.flush();
      }
      await vi.waitFor(() => expect(vt.screen()).toBe("tickx: ab"));

      void handle.stop();
      await expect(worker().takeResponse()).resolves.toEqual({
        kind: "cancelled",
      });
      worker().writeError("Traceback\n");
      for (let round = 0; round < 3; round += 1) {
        fake.flush();
        await tick();
      }

      expect(vt.lines()).toEqual(["tickx: ab", "Traceback"]);
    });
  });

  // 커서가 감긴 입력의 중간 행에 있을 때 abort하면 뒤 출력이 입력 마지막 행 위에 겹치던 결함(readline-read-end DELTA-03).
  describe("abort 뒤 출력 위치: 벤더 settle·그리기 전 대체 개행", () => {
    const THIRTY = "abcdefghijklmnopqrstuvwxyz0123";
    const HOME = "\x1b[H";

    /** 열 20 화면에서 `x: ` 읽기에 30자를 쳐 두 행으로 감긴 입력을 만든다. */
    const openWrappedInput = async () => {
      const fake = createFakeTerminal({ asyncWrite: true, cols: 20, rows: 10 });
      const vt = new VtScreen(20, 10);
      attachVtScreen(fake, vt);
      const context = await setupReal({ fake });
      void context.handle.run("code");
      await context.startInput("x: ");
      for (let round = 0; round < 3; round += 1) {
        await tick();
        fake.flush();
      }
      fake.type(THIRTY);
      fake.flush();
      await vi.waitFor(() =>
        expect(vt.lines()).toEqual(["x: abcdefghijklmnopq", "rstuvwxyz0123"]),
      );
      return { ...context, vt };
    };

    /** stop으로 읽기를 끊고 트레이스백 한 줄을 낸 뒤 화면을 배출한다. */
    const stopAndPrintTraceback = async (
      context: Awaited<ReturnType<typeof openWrappedInput>>,
    ) => {
      void context.handle.stop();
      await expect(context.worker().takeResponse()).resolves.toEqual({
        kind: "cancelled",
      });
      context.worker().writeError("Traceback\n");
      for (let round = 0; round < 3; round += 1) {
        context.fake.flush();
        await tick();
      }
    };

    test("커서가 첫 행에 있어도 입력 두 행이 온전히 남고 트레이스백은 그 아래 행에 쓰인다", async () => {
      const context = await openWrappedInput();
      context.fake.type(HOME);
      context.fake.flush();
      expect(context.vt.cursor()[0]).toBe(0);

      await stopAndPrintTraceback(context);

      expect(context.vt.lines()).toEqual([
        "x: abcdefghijklmnopq",
        "rstuvwxyz0123",
        "Traceback",
      ]);
    });

    test("읽기가 그려지기 전(write 콜백 대기) abort면 꼬리 뒤에 개행해 트레이스백이 꼬리 행에 붙지 않는다", async () => {
      const fake = createFakeTerminal({ asyncWrite: true });
      const vt = new VtScreen(80, 24);
      attachVtScreen(fake, vt);
      const { handle, worker } = await setupReal({ fake });
      void handle.run("code");
      worker().write("x: ");
      worker().readInput();
      // 짧은 꼬리는 flush를 기다리지 않으므로 몇 틱 뒤 읽기는 write 콜백만 기다린다(배출하지 않는다).
      await tick();
      await tick();

      void handle.stop();
      await expect(worker().takeResponse()).resolves.toEqual({
        kind: "cancelled",
      });
      worker().writeError("Traceback\n");
      for (let round = 0; round < 3; round += 1) {
        fake.flush();
        await tick();
      }

      expect(vt.lines()).toEqual(["x:", "Traceback"]);
    });

    test("대조: 커서가 입력 끝이면 입력 두 행 아래에 트레이스백이 쓰인다", async () => {
      const context = await openWrappedInput();

      await stopAndPrintTraceback(context);

      expect(context.vt.lines()).toEqual([
        "x: abcdefghijklmnopq",
        "rstuvwxyz0123",
        "Traceback",
      ]);
    });
  });

  test("abort 뒤 친 키는 죽은 읽기에 들어가지 않고, 다음 읽기는 그 키를 받지 않는다", async () => {
    const { fake, handle, worker, startInput } = await setupReal();
    await startInput();
    await handle.stop();
    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "cancelled",
    });

    // 죽은 읽기가 남아 있으면 키가 그려진다.
    const beforeKeys = fake.written.length;
    fake.type("zz\r");
    expect(fake.written.slice(beforeKeys).join("")).not.toContain("zz");
    await startInput();
    fake.type("y\r");

    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "line",
      text: "y",
    });
  });

  // `onAbort` 리스너 제거는 실제 core로 관찰할 수 없다: core는 끝난 읽기의 signal을 다시 abort하지 않는다(`pendingInput`이
  // 읽기 종료 때 비워진다). 여기서는 읽기가 끝난 뒤 stop()이 화면에 쓰지 않는 것만 본다.
  test("읽기가 정상으로 끝난 뒤의 stop은 줄바꿈을 더 쓰지 않는다", async () => {
    const { fake, handle, worker, startInput } = await setupReal();
    await startInput();
    fake.type("a\r");
    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "line",
      text: "a",
    });
    const before = fake.written.length;

    await handle.stop();

    expect(fake.written).toHaveLength(before);
  });

  test("긴 꼬리를 정리(flush 대기)하는 사이 abort되면 읽기를 열지 않아 이어 친 키가 죽은 읽기에 들어가지 않는다", async () => {
    const { fake, handle, worker } = await setupReal({
      terminal: { asyncWrite: true },
    });
    // 꼬리가 폭의 절반 이상이면 `rewindTail`이 write 콜백(flush)을 기다린다.
    worker().write("x".repeat(50));
    fake.flush();
    await tick();
    worker().readInput();
    await tick();

    await handle.stop();
    fake.flush();
    await tick();
    fake.flush();
    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "cancelled",
    });
    const before = fake.written.length;
    fake.type("q\r");

    // 읽기가 열리지 않았으므로 키는 버려지고 아무것도 그려지지 않는다.
    expect(fake.written).toHaveLength(before);
  });

  test("dispose 뒤 도착한 flush 콜백은 해제된 터미널의 buffer를 읽지 않는다(TRP-004)", async () => {
    const { fake, handle, worker } = await setupReal({
      terminal: { asyncWrite: true },
    });
    worker().write("x".repeat(50));
    fake.flush();
    await tick();
    worker().readInput();
    await tick();

    handle.dispose();
    fake.term.dispose();
    fake.flush();
    await tick();

    expect(fake.disposedBufferReads).toBe(0);
  });

  test("Ctrl+C로 사용자가 취소한 읽기는 줄바꿈을 한 번만 쓴다(벤더가 쓴 것)", async () => {
    const { fake, worker, startInput } = await setupReal();
    await startInput();
    const before = fake.written.length;

    fake.type("\x03");
    // 읽기 취소가 core까지 완결된 뒤 센다(뒤늦은 줄바꿈도 잡는다).
    await expect(worker().takeResponse()).resolves.toEqual({
      kind: "cancelled",
    });

    expect(
      fake.written.slice(before).filter((text) => text === "\r\n"),
    ).toHaveLength(1);
  });
});

describe("비격리", () => {
  test("core가 not-isolated를 알리면 경고 안내를 노랑 한 줄로 낸 뒤 onStatus로 알린다", () => {
    vi.stubGlobal("crossOriginIsolated", false);
    const fake = createFakeTerminal();
    let writtenAtStatus = -1;
    const statuses: RunnerStatus[] = [];
    const createWorker = vi.fn(() => {
      throw new Error("비격리에서는 worker를 만들면 안 된다");
    });
    const handle = createTerminalRunner({
      terminal: fake.term,
      createWorker,
      onStatus: (status) => {
        statuses.push(status);
        writtenAtStatus = fake.written.length;
      },
    });

    expect(fake.written).toHaveLength(1);
    expect(fake.written[0]).toContain(YELLOW);
    expect(fake.written[0]).toContain("cross-origin isolation");
    expect(fake.written[0]?.endsWith(`${RESET}\r\n`)).toBe(true);
    expect(statuses).toEqual(["not-isolated"]);
    // 안내가 상태 알림보다 먼저다(알림 시점에 이미 안내가 쓰여 있다).
    expect(writtenAtStatus).toBe(1);
    handle.dispose();
  });

  test("실제 core createRunner는 jsdom(비격리)에서 worker 없이 not-isolated가 되고 run은 unavailable로 거부된다", async () => {
    // 공용 setup의 `beforeEach`가 매 시험 `crossOriginIsolated`를 참으로 스텁한다 — 이 시험은 비격리를 직접 본다.
    vi.stubGlobal("crossOriginIsolated", false);
    const fake = createFakeTerminal();
    const createWorker = vi.fn(() => {
      throw new Error("worker를 만들면 안 된다");
    });
    const onStatus = vi.fn();
    const handle = createTerminalRunner({
      terminal: fake.term,
      createWorker,
      onStatus,
    });

    expect(handle.status).toBe("not-isolated");
    expect(onStatus).toHaveBeenCalledWith("not-isolated");
    expect(fake.written.join("")).toContain("cross-origin isolation");
    const before = fake.written.length;
    await expect(handle.run("1")).rejects.toBeInstanceOf(RunRejectedError);
    await expect(handle.run("1")).rejects.toMatchObject({
      reason: "unavailable",
    });
    expect(fake.written).toHaveLength(before);
    expect(createWorker).not.toHaveBeenCalled();
    handle.dispose();
  });

  test("옵션이 틀려 core가 던지면 붙인 Readline·선택 복사를 정리하고 그대로 던진다", () => {
    const fake = createFakeTerminal({ withElement: true });
    const removeSpy = vi.spyOn(fake.term.element!, "removeEventListener");

    expect(() =>
      createTerminalRunner({
        terminal: fake.term,
        createWorker: () => ({}) as Worker,
        filename: "",
      }),
    ).toThrow();

    expect(removeSpy).toHaveBeenCalledWith("mousedown", expect.any(Function));
    // Readline이 떼어졌으므로 입력이 와도 아무 일도 없다.
    fake.type("abc");
    expect(fake.written).toEqual([]);
  });
});

describe("dispose()", () => {
  test("runner를 dispose하고 Readline을 떼되 Terminal은 dispose하지 않는다", async () => {
    const { fake, handle, worker } = await setupReal();
    const terminalDispose = vi.spyOn(fake.term, "dispose");
    void handle.run("code");
    expect(handle.status).toBe("running");

    handle.dispose();

    expect(terminalDispose).not.toHaveBeenCalled();
    // Readline이 떼어져 있어 키·붙여넣기가 무시된다(핸들러 없음). Ctrl+C도 핸들러를 부르지 않는다(running 상태였어도).
    fake.type("\x03");
    expect(worker().signal()).toBe(0);
    // 파괴되지 않은 터미널은 계속 쓸 수 있다.
    expect(() => fake.term.write("still alive")).not.toThrow();
  });

  test("두 번 불러도 안전하다", async () => {
    const { handle, worker } = await setupReal();

    handle.dispose();
    handle.dispose();

    // 두 번째 dispose는 no-op이다(core `dispose()`의 `if (disposed) return`): worker는 한 번만 terminate된다.
    expect(worker().terminateCount()).toBe(1);
  });

  // 읽기 결과(`null`)는 실제 core에서 시험이 볼 수 없다(core가 dispose 때 읽기를 버린다). 화면 쪽만 본다.
  test("열린 읽기가 있어도 화면에 줄바꿈을 더 쓰지 않는다", async () => {
    const { fake, handle, startInput } = await setupReal();
    await startInput("x: ");
    const before = fake.written.length;

    handle.dispose();

    expect(fake.written).toHaveLength(before);
  });

  test("dispose 뒤 run은 disposed로 거부되고 화면을 건드리지 않는다", async () => {
    const { fake, handle } = await setupReal({
      runner: { clearOnRun: true },
    });
    handle.dispose();

    await expect(handle.run("x")).rejects.toMatchObject({ reason: "disposed" });

    expect(fake.written).toEqual([]);
  });

  test("dispose 뒤 run은 해제된 터미널의 buffer를 읽지 않는다", async () => {
    const { fake, handle } = await setupReal();
    handle.dispose();
    fake.term.dispose();

    await expect(handle.run("x")).rejects.toMatchObject({ reason: "disposed" });

    expect(fake.disposedBufferReads).toBe(0);
  });

  test("dispose 뒤 clear·setCopyOnSelect는 아무 일도 하지 않는다", async () => {
    const { fake, handle } = await setupReal();
    handle.dispose();

    handle.clear();
    handle.setCopyOnSelect(true);

    expect(fake.written).toEqual([]);
  });

  test("선택 복사 리스너를 뗀다", async () => {
    const writeText = stubClipboard();
    const { fake, handle } = await setupReal({
      terminal: { withElement: true },
    });
    handle.dispose();
    fake.select("abc");

    fake.term.element!.dispatchEvent(
      new MouseEvent("mousedown", { button: 0 }),
    );
    document.dispatchEvent(new MouseEvent("mouseup"));

    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("선택 복사", () => {
  test("드래그 선택 자동 복사는 기본으로 켜져 있고 setCopyOnSelect(false)로 끈다", async () => {
    const writeText = stubClipboard();
    const { fake, handle } = await setupReal({
      terminal: { withElement: true },
    });
    const drag = () => {
      fake.term.element!.dispatchEvent(
        new MouseEvent("mousedown", { button: 0 }),
      );
      document.dispatchEvent(new MouseEvent("mouseup"));
    };
    fake.select("abc");

    drag();
    expect(writeText).toHaveBeenCalledTimes(1);

    handle.setCopyOnSelect(false);
    drag();
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  test("copyOnSelect: false 옵션이면 처음부터 자동 복사하지 않는다", async () => {
    const writeText = stubClipboard();
    const { fake } = await setupReal({
      terminal: { withElement: true },
      runner: { copyOnSelect: false },
    });
    fake.select("abc");

    fake.term.element!.dispatchEvent(
      new MouseEvent("mousedown", { button: 0 }),
    );
    document.dispatchEvent(new MouseEvent("mouseup"));

    expect(writeText).not.toHaveBeenCalled();
  });
});
