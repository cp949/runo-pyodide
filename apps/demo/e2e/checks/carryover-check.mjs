// RD-005에서 이월한 브라우저 확인 둘. RD-005에서 이관했다(RD-018).
//
// (a) worker → main `readLine` 요청의 실제 인자(prompt, pending, cancelable)가 브라우저 worker RPC(구조적 복제)에서 보존된다.
//     - 특히 `pending: undefined`가 `undefined`로 도착한다.
//     - main의 `MessagePort.onmessage`를 감싸 수신한 요청을 기록한다.
// (b) 문법 오류를 여러 번 낸 뒤 `gc.collect()`를 돌려도 `ConsoleFuture exception was never retrieved`가 터미널·콘솔에 새지 않는다.
//     - node 시험은 GC를 강제한다.
//     - 브라우저에서도 그런지 본다.
//
// 사용: `node carryover-check.mjs [url]`
// 결과 파일 규칙은 README "결과 파일 규칙".
import { checkEntry, exitWith, serverLabel } from "../check-runner.mjs";
import { open, same, show } from "../lib.mjs";

const { url } = checkEntry();
const label = serverLabel(url);

const h = await open(url, {
  before: async (page) => {
    await page.addInitScript(() => {
      window.__readLineRequests = [];
      const desc = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage");
      Object.defineProperty(MessagePort.prototype, "onmessage", {
        configurable: true,
        get() {
          return desc.get.call(this);
        },
        set(fn) {
          desc.set.call(
            this,
            typeof fn === "function"
              ? (event) => {
                  const d = event.data;
                  if (d && d.kind === "req" && d.name === "readLine") {
                    window.__readLineRequests.push({
                      length: d.args.length,
                      prompt: d.args[0],
                      pendingIsUndefined: d.args[1] === undefined,
                      pending: d.args[1] === undefined ? null : d.args[1],
                      cancelable: d.args[2],
                    });
                  }
                  return fn.call(this, event);
                }
              : fn,
          );
        },
      });
    });
  },
});
const { step, waitPrompt, clear, type, enter, submit, page } = h;
/** 기록한 `readLine` 요청 목록. */
const requests = () => page.evaluate(() => window.__readLineRequests);

await waitPrompt(">>>", 60000);
await h.focus();

await step("(a) 첫 readLine 요청: prompt `>>> `, pending은 undefined로 도착, cancelable true, 인자 3개", async () => {
  const first = (await requests())[0];
  const expected = { length: 3, prompt: ">>> ", pendingIsUndefined: true, pending: null, cancelable: true };
  if (!same(first, expected)) throw new Error(`첫 요청 = ${show(first)}`);
});

await step("(a) 블록 진행 중 요청: prompt `... `, pending은 지금까지 쌓인 소스 문자열", async () => {
  await clear();
  await type("if True:");
  await enter();
  await waitPrompt("...");
  // `... ` 프리필(4칸)이 이미 채워져 있다(RD-013). 수동 들여쓰기를 치지 않는다.
  // 실제 소스에 들어가는 문자는 프리필이든 수동이든 같은 4칸이라 pending 기대값은 같다.
  await type("print(1)");
  await enter();
  await waitPrompt("...");
  await enter();
  await waitPrompt(">>>");
  const all = await requests();
  const cont = all.filter((r) => r.prompt === "... ");
  const got = cont.map((r) => r.pending);
  if (!same(got, ["if True:", "if True:\n    print(1)"])) throw new Error(`... 요청의 pending = ${show(got)}`);
  const afterBlock = all.at(-1);
  if (afterBlock.prompt !== ">>> " || !afterBlock.pendingIsUndefined) throw new Error(`블록 뒤 요청 = ${show(afterBlock)}`);
});

// (b) 문법 오류 30회. 누출 로그는 stderr(터미널)로 오고 24행을 넘는 트레이스백이다.
// 뒤 출력에 밀려 뷰포트 밖으로 나가므로 화면을 지우고 `gc.collect()` 직후의 행 목록을 단언한다.
// 값 에코 한 줄(3행)뿐이어야 한다(뷰포트만 나중에 훑으면 누출을 놓친다, TRP-008).
await step("(b) 문법 오류 30회 뒤 gc.collect() 출력이 값 에코 한 줄뿐이다(never retrieved 로그 없음)", async () => {
  for (let i = 0; i < 30; i++) {
    await type("1 +");
    await enter();
    await waitPrompt(">>>");
  }
  await submit("import gc");
  for (let round = 1; round <= 2; round++) {
    await clear();
    await type("gc.collect()");
    await enter();
    await waitPrompt(">>>");
    // GC 로그는 `collect()` 안에서 동기로 나오지만 터미널 그리기는 비동기다. 그래서 800ms 여유를 둔다.
    // 고정 대기 뒤 부재 확인이라 9.7이 금지하는 형태다. 기존 대기이며 이 스크립트를 고칠 때 마커 배리어로 바꾼다.
    await page.waitForTimeout(800);
    const t = await h.trimmedRows();
    const echoOnly = t.length === 3 && t[0] === ">>> gc.collect()" && /^\d+$/.test(t[1]) && t[2] === ">>>";
    if (!echoOnly) throw new Error(`collect#${round} 화면 ${t.length}행: ${show(t.slice(0, 6))}`);
  }
  const leakedLogs = h.logs.filter((l) => /never retrieved|ConsoleFuture/.test(l.text));
  if (leakedLogs.length > 0) throw new Error(`콘솔 ${show(leakedLogs.slice(0, 2))}`);
});

await step("콘솔 경고·오류·pageerror가 없다", async () => {
  if (h.problemLogs().length > 0 || h.pageErrors.length > 0) {
    throw new Error(JSON.stringify({ problemLogs: h.problemLogs().slice(0, 3), pageErrors: h.pageErrors }));
  }
});

const ok = await h.finish({ label });
exitWith(ok);
