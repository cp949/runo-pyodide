/**
 * `createTerminalRunner`의 `run()` 시작 화면 준비 시험(run-accepted-hook DELTA-03). 실제 core `createRunner`를 쓰고
 * worker만 공용 가짜(`@cp949/runo-pyodide-core/test-utils`)로 둔다: 화면 준비가 core의 수락 판정(거부 5종·`loading`·
 * `restarting` 대기·재진입)을 그대로 따르는지 본다. 공용 setup은 `./test/runner-setup`(RD-031 DELTA-01, `terminal-runner.test.ts`와
 * 공유). 화면 준비 밖 시험은 `terminal-runner.test.ts`에 있다. jsdom은 `crossOriginIsolated`가 없어 setup이 스텁한다.
 */
import { describe, expect, test, vi } from "vitest";
import type { RunResult } from "@cp949/runo-pyodide-core";
import { setupReal, tick } from "./runner-setup";

describe("run 시작 시 화면 준비: 꼬리 줄바꿈·clearOnRun", () => {
  /**
   * 이전 실행이 남긴 미종결 stdout(`"a"`)으로 현재 io 꼬리를 만든다. 그 실행("priming")은 끝내고 기다린다 —
   * `run()`은 시작할 때 꼬리를 지우지 않으므로(그 판단은 다음 `run()`의 화면 준비가 한다) 꼬리는 그대로 남는다.
   */
  async function primeTail({
    handle,
    worker,
    screen,
    finishRun,
  }: Awaited<ReturnType<typeof setupReal>>) {
    const priming = handle.run("priming");
    await vi.waitFor(() => expect(worker().pending).toHaveLength(1));
    worker().write("a");
    await vi.waitFor(() => expect(screen()).toContain("a"));
    await finishRun();
    await priming;
  }

  test("꼬리가 있으면 \\r\\n을 한 번 쓴다", async () => {
    const started = await setupReal();
    const { fake, handle } = started;
    await primeTail(started);
    fake.written.length = 0;

    void handle.run("code");

    expect(fake.written.filter((text) => text === "\r\n")).toHaveLength(1);
  });

  test("꼬리가 없으면 줄바꿈을 쓰지 않는다", async () => {
    const { fake, handle } = await setupReal();

    void handle.run("code");

    expect(fake.written).toEqual([]);
  });

  test("clearOnRun이 기본이면 화면을 지우지 않는다", async () => {
    const { handle, screen } = await setupReal();

    void handle.run("code");

    expect(screen()).not.toContain("\x1b[2J");
  });

  test("clearOnRun이면 화면을 지우고 줄바꿈은 쓰지 않는다(꼬리가 있어도)", async () => {
    const started = await setupReal({ runner: { clearOnRun: true } });
    const { fake, handle, screen } = started;
    await primeTail(started);
    fake.written.length = 0;

    void handle.run("code");

    expect(screen()).toContain("\x1b[2J");
    expect(fake.written.filter((text) => text === "\r\n")).toHaveLength(0);
  });

  test("clearOnRun이 참인 값만 켠다(=== true)", async () => {
    const { handle, screen } = await setupReal({
      runner: { clearOnRun: "yes" as unknown as boolean },
    });

    void handle.run("code");

    expect(screen()).not.toContain("\x1b[2J");
  });

  test("거부되는 run(busy)은 화면을 건드리지 않는다", async () => {
    const { fake, handle } = await setupReal({ runner: { clearOnRun: true } });
    void handle.run("first");
    fake.written.length = 0;

    await expect(handle.run("second")).rejects.toMatchObject({
      reason: "busy",
    });

    expect(fake.written).toEqual([]);
  });

  // 예외 1건: 가짜 core의 `calls.run`(core가 받은 run 호출) 단언은 실제 core에서 볼 수 없어, 같은 뜻인 "worker는 first만 받는다"로 바꿨다.
  test("로딩 대기 중인 run이 슬롯을 잡고 있을 때 두 번째 run은 busy로 거부되고 화면을 건드리지 않는다", async () => {
    const { fake, handle, worker, becomeReady } = await setupReal({
      ready: false,
      runner: { clearOnRun: true },
    });
    void handle.run("first"); // ready가 될 때까지 대기한다(core도 슬롯을 잡는다)
    fake.written.length = 0;

    await expect(handle.run("second")).rejects.toMatchObject({
      reason: "busy",
    });

    expect(fake.written).toEqual([]);
    await becomeReady();
    await vi.waitFor(() => expect(worker().pending).toHaveLength(1));
    expect(worker().pending.map((run) => run.code)).toEqual(["first"]);
  });

  test("끝난 run 뒤 재시작 대기 중에 부른 run은 슬롯이 비어 있으므로 화면을 준비한다", async () => {
    const { fake, handle, worker, screen, finishRun } = await setupReal();
    const first = handle.run("first");
    await vi.waitFor(() => expect(worker().pending).toHaveLength(1));
    worker().write("a"); // 미종결 stdout으로 꼬리를 만든다(끝나도 남는다).
    await vi.waitFor(() => expect(screen()).toContain("a"));
    await finishRun();
    await first;
    handle.reset(); // 재시작 대기(restarting)
    fake.written.length = 0;

    void handle.run("second"); // 새 worker가 준비되면 실행된다(core도 슬롯을 잡는다)

    expect(fake.written.filter((text) => text === "\r\n")).toHaveLength(1);
  });

  test("실행 중 reset 직후 같은 틱에 부른 run은 받아들여지므로 화면을 준비한다", async () => {
    const { fake, handle } = await setupReal();
    void handle.run("first");
    // "first"가 accept된 뒤 같은 틱에 실제 출력(Ctrl+C 로컬 에코, 동기)으로 꼬리를 만든다 — "second"의 화면 준비가
    // 볼 꼬리는 "first" 자신이 이미 소비한 뒤(새 실행은 꼬리를 비운다)에 새로 생겨야 "second"가 실제로 받아들여졌다는
    // 증거가 된다(첫 accept의 소비만으로 개행 수가 맞아떨어지면 두 번째 accept 여부와 무관해진다).
    expect(handle.status).toBe("running");
    fake.type("\x03");
    fake.written.length = 0;
    handle.reset();

    void handle.run("second"); // 옛 run의 결과 Promise는 아직 정착 콜백 전이다

    expect(fake.written.filter((text) => text === "\r\n")).toHaveLength(1);
  });

  test("reset 직후 받아들여진 run이 재시작을 기다리는 동안 부른 run은 busy로 거부되고 화면을 건드리지 않는다", async () => {
    const { fake, handle } = await setupReal({ runner: { clearOnRun: true } });
    void handle.run("first");
    handle.reset();
    void handle.run("second").catch(() => {});
    await tick(); // 옛 run의 정착 콜백까지 돈다
    fake.written.length = 0;

    await expect(handle.run("third")).rejects.toMatchObject({ reason: "busy" });

    expect(fake.written).toEqual([]);
  });

  test("대기 run이 있는 onStatus(ready) 콜백 안에서 부른 run은 busy로 거부되고 화면을 건드리지 않는다", async () => {
    let inner: Promise<unknown> | undefined;
    // 첫 상태(loading)는 `setupReal()`이 반환하기 전에 오지만 ready가 아니라 `started`를 읽지 않는다.
    const started: Awaited<ReturnType<typeof setupReal>> = await setupReal({
      ready: false,
      runner: {
        clearOnRun: true,
        onStatus: (status) => {
          if (status === "ready" && inner === undefined) {
            inner = started.handle.run("inner");
            inner.catch(() => {});
          }
        },
      },
    });
    const { fake, handle, becomeReady } = started;
    void handle.run("first");
    fake.written.length = 0;

    await becomeReady();

    await expect(inner).rejects.toMatchObject({ reason: "busy" });
    expect(fake.written).toEqual([]);
  });

  test("worker가 없는 상태(unavailable)의 run도 화면을 건드리지 않는다", async () => {
    const { fake, handle, worker } = await setupReal({
      runner: { clearOnRun: true },
    });
    worker().dispatchError("boom"); // crashed
    expect(handle.status).toBe("crashed");

    await expect(handle.run("x")).rejects.toMatchObject({
      reason: "unavailable",
    });

    expect(fake.written).toEqual([]);
  });

  test("실행 시작에 꼬리를 비워 이전 실행의 미종결 줄이 다음 input() 프롬프트가 되지 않는다", async () => {
    const { fake, handle, screen, worker, finishRun } = await setupReal();
    const first = handle.run("first");
    await vi.waitFor(() => expect(worker().pending).toHaveLength(1));
    worker().write("a");
    await vi.waitFor(() => expect(screen()).toContain("a"));
    await finishRun();
    await first;
    const before = fake.written.length;

    void handle.run("second");
    await vi.waitFor(() => expect(worker().pending).toHaveLength(2));
    worker().readInput();
    await tick(); // 읽기가 열려 그려진다
    fake.type("z\r");

    const response = await worker().takeResponse();
    if (response.kind !== "line")
      throw new Error(`unexpected kind: ${response.kind}`);
    expect(response.text).toContain("z");
    // 프롬프트는 빈 꼬리라 입력줄 재그리기가 `a`를 다시 그리지 않는다(`az`가 아니라 `z`).
    const drawn = fake.written.slice(before);
    expect(drawn).toContain("z");
    expect(drawn.join("")).not.toContain("a");
  });

  test("run의 결과와 거부를 core 그대로 돌려준다", async () => {
    const { handle, finishRun } = await setupReal();
    const running = handle.run("code");
    await finishRun({ kind: "exit", code: 3 });
    await expect(running).resolves.toEqual<RunResult>({
      kind: "exit",
      code: 3,
    });

    const restarted = handle.run("code");
    handle.reset();
    await expect(restarted).resolves.toEqual({ kind: "restarted" });

    const disposed = handle.run("code");
    handle.dispose();
    await expect(disposed).rejects.toMatchObject({
      name: "RunRejectedError",
      reason: "disposed",
    });
  });
});

// `prepareScreen`에는 `disposed` 방어가 없다. 실제 core가 dispose 뒤 `run()`을 콜백 전에 거부하고 terminal `dispose()`가
// core를 먼저 끝내므로 콜백이 불릴 수 없다는 근거(코드 읽기 + 이 시험).
describe("dispose 뒤 run은 화면 준비 콜백이 불리지 않는다", () => {
  test("dispose 뒤 run은 disposed로 거부되고 해제된 터미널의 buffer를 읽지 않으며 화면을 건드리지 않는다", async () => {
    const { fake, handle } = await setupReal();
    handle.dispose();
    fake.term.dispose();

    await expect(handle.run("x")).rejects.toMatchObject({ reason: "disposed" });

    expect(fake.disposedBufferReads).toBe(0);
    expect(fake.written).toEqual([]);
  });
});
