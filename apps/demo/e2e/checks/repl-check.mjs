// RD-005 브라우저 확인(RD-004 repl-check.mjs 이식 + ROADMAP RD-005 시나리오 7개). 실제 xterm 6 + 실제 브라우저 + 실제 CDN pyodide.
// 출처 RD-005에서 이관(RD-018).
//   normal       : 배너·첫 프롬프트, 상태 ready, StrictMode 정리(터미널·worker 1개, 콘솔 0) + ROADMAP 7개(① 값 에코 ② 빈 Enter
//                  ③ 블록 ④ SyntaxError ⑤ 트레이스백 ⑥ 개행 없는 출력 뒤 프롬프트 ⑦ exit())
//   cdn-blocked  : CDN 차단 시 앱이 죽지 않고 빨간 "pyodide 로드 실패: …" + 상태 load-failed
//   not-isolated : 헤더 없는 서버에서 노란 경고 한 줄 + 상태 not-isolated + worker 없음
// 사용: node repl-check.mjs <normal|cdn-blocked|not-isolated> <url> [screenshot-prefix.png]
//   normal에서 screenshot-prefix가 `x.png`이면 `x.png`(t>>> abc·트레이스백)와 `x-terminated.png`(exit() 뒤)를 남긴다.
//   url 생략 시 http://localhost:5173. 결과 파일 label은 `<모드>-<서버>`다: 서버는 url 포트 4173이면 preview, 그 밖(5173·4174 등)은
//   dev(RD-018 결정). 모드를 넣는 이유: `run.mjs baseline`이 세 모드를 별도 프로세스로 돌려 `lib.mjs`의 `-2`·`-3`
//   접미 카운터가 매번 1부터 시작하므로, 모드가 없으면 세 모드가 같은 `repl-check-dev.json`을 덮어쓴다.
//   결과 파일: `repl-check-normal-dev.json`·`repl-check-cdn-blocked-dev.json`·`repl-check-not-isolated-dev.json`·`repl-check-normal-preview.json`.
// RD-018 갱신: ③은 RD-013(자동 들여쓰기) 프리필을 그대로 쓰도록 수동 들여쓰기를 뺐고(화면 문자열은 불변),
// ⑦은 RD-010(세션 리셋)이 덧붙인 종료 안내 문구로 기대값을 갱신했다(낡은 기대값, 판정 의도는 불변).
import { checkEntry, exitWith, serverLabel } from "../check-runner.mjs";
import { hasFg, open, same, show } from "../lib.mjs";

const {
  mode,
  url,
  rest: [screenshotPath],
} = checkEntry({ modes: ["normal", "cdn-blocked", "not-isolated"] });
// 결과 파일 이름에만 쓰인다(stdout JSON에는 `mode` 필드로 따로 남는다).
const label = serverLabel(url, mode);

const BANNER_FIRST = /^Python 3\.14\.2 \(.*\) on WebAssembly\/Emscripten$/;
const BANNER_SECOND = 'Type "help", "copyright", "credits" or "license" for more information.';
const LOAD_FAILED_PREFIX = "pyodide 로드 실패: ";
const NOT_ISOLATED_WARNING =
  "경고: cross-origin isolation이 꺼져 있어 Python 세션을 시작하지 않습니다. 서버가 COOP/COEP 헤더를 보내야 합니다.";
const INTERNAL_FRAMES = ["__repl_run", "push", "runcode", "await_fut"];

const requestedCdn = [];
const h = await open(url, {
  before: async (page) => {
    if (mode === "cdn-blocked") {
      // 페이지·worker의 CDN 요청을 모두 끊는다. 아래 "차단한 CDN 요청이 실제로 발생했다"가 차단이 먹혔는지 대조한다.
      await page.route("https://cdn.jsdelivr.net/**", (route) => route.abort());
    }
    page.on("requestfailed", (r) => {
      if (r.url().startsWith("https://cdn.jsdelivr.net/")) requestedCdn.push(r.url());
    });
  },
});
const { page, step, notes, waitFor, waitPrompt, rows, rowClasses, cursorRow, tail, type, enter, press, clear, resetPrompt, killLine, lastLine } = h;
const statusText = () => page.locator('[data-testid="status"]').textContent();
const isolatedText = () => page.locator('[data-testid="cross-origin-isolated"]').textContent();
const terminatedText = () => page.locator('[data-testid="terminated"]').textContent({ timeout: 2000 });
let extra = {};

if (mode === "normal") {
  await step("페이지가 cross-origin isolated다", async () => {
    const text = await isolatedText();
    if (text !== "true") throw new Error(`cross-origin-isolated = ${text}`);
  });

  await step("배너 2행이 행 0부터 나오고 행 2에 첫 프롬프트가 있으며 커서가 그 행이다(빈 줄 없음)", async () => {
    await waitPrompt(">>>", 60000);
    const all = await rows();
    if (!BANNER_FIRST.test(all[0] ?? "")) throw new Error(`행0 = ${show(all[0])}`);
    if (all[1] !== BANNER_SECOND) throw new Error(`행1 = ${show(all[1])}`);
    if (all[2] !== ">>>") throw new Error(`행2 = ${show(all[2])}`);
    const cur = await cursorRow();
    if (cur !== 2) throw new Error(`커서 행 = ${cur}(기대 2)`);
  });

  await step("상태 표시가 ready다", async () => {
    await waitFor(async () => (await statusText()) === "ready", "status = ready", 5000);
  });

  await step("터미널이 하나만 마운트된다(StrictMode 잔재 없음)", async () => {
    const count = await page.locator(".xterm").count();
    if (count !== 1) throw new Error(`.xterm 요소 ${count}개`);
  });

  await step("worker가 하나만 살아 있다", async () => {
    await waitFor(() => page.workers().length === 1, "workers().length === 1", 5000);
  });

  // ① 값 에코: `1 + 1` → 다음 행 `2`, 그 다음 행 `>>>`, 커서가 그 행(빈 줄 없음).
  await step("① `1 + 1` → 2 다음 행에 `>>>`이고 커서 행이 그 행이다(빈 줄 없음)", async () => {
    await clear();
    await type("1 + 1");
    await enter();
    await waitPrompt(">>>");
    const t = await tail(4);
    if (!same(t, [">>> 1 + 1", "2", ">>>"])) throw new Error(`행 = ${show(t)}`);
    const cur = await cursorRow();
    if (cur !== 2) throw new Error(`커서 행 = ${cur}(기대 2)`);
  });

  // ② 빈 Enter는 무해하다: 새 행에 `>>>`만 나온다.
  await step("② 빈 Enter → 새 행에 `>>>`만 나온다", async () => {
    await clear();
    await enter();
    await waitFor(async () => (await rows())[1] === ">>>" && (await cursorRow()) === 1, "행 1의 >>>", 5000);
    const t = await tail(4);
    if (!same(t, [">>>", ">>>"])) throw new Error(`행 = ${show(t)}`);
  });

  // ③ 블록: `if True:` → `... `(자동 들여쓰기 4칸 프리필, RD-013), `print(1)`만 이어 쳐서 `... `, 빈 Enter → `1` → `>>>`.
  // 화면 문자열(`...     print(1)`)은 프리필 4칸 + 프롬프트 공백 1칸으로 이전과 동일하다 — 수동 4칸을 더 치지 않는다.
  await step("③ `if True:` / `print(1)`(자동 들여쓰기) / 빈 Enter → `1` → `>>>`", async () => {
    await clear();
    await type("if True:");
    await enter();
    await waitPrompt("...");
    await type("print(1)");
    await enter();
    await waitPrompt("...");
    await enter();
    await waitPrompt(">>>");
    const t = await tail(6);
    const expected = [">>> if True:", "...     print(1)", "...", "1", ">>>"];
    if (!same(t, expected)) throw new Error(`행 = ${show(t)}`);
    const cur = await cursorRow();
    if (cur !== 4) throw new Error(`커서 행 = ${cur}(기대 4)`);
  });

  // ④ SyntaxError: 즉시 표시(`_IncompleteInputError` 정규화). 캐럿 7칸, 빨강, 사이 빈 줄 없음.
  await step("④ `1 +` → SyntaxError(캐럿 `       ^`) 빨강, 사이 빈 줄 없이 `>>>`", async () => {
    await clear();
    await type("1 +");
    await enter();
    await waitPrompt(">>>");
    const t = await tail(8);
    const expected = [">>> 1 +", '  File "<console>", line 1', "    1 +", "       ^", "SyntaxError: invalid syntax", ">>>"];
    if (!same(t, expected)) throw new Error(`행 = ${show(t)}`);
    const cur = await cursorRow();
    if (cur !== 5) throw new Error(`커서 행 = ${cur}(기대 5)`);
    const classes = await rowClasses();
    for (const i of [1, 4]) {
      if (!hasFg(classes[i] ?? [], 1)) throw new Error(`행 ${i} 클래스 = ${show(classes[i])}(빨강 아님)`);
    }
    if (hasFg(classes[5] ?? [], 1)) throw new Error(`프롬프트 행이 빨강이다: ${show(classes[5])}`);
  });

  // ⑤ 트레이스백: 내부 프레임이 보이지 않는다.
  await step("⑤ `1/0` → 트레이스백에 내부 프레임(__repl_run·push·runcode·await_fut)이 없다", async () => {
    await clear();
    await type("1/0");
    await enter();
    await waitPrompt(">>>");
    const t = await tail(8);
    const expected = [
      ">>> 1/0",
      "Traceback (most recent call last):",
      '  File "<console>", line 1, in <module>',
      "ZeroDivisionError: division by zero",
      ">>>",
    ];
    if (!same(t, expected)) throw new Error(`행 = ${show(t)}`);
    const all = (await rows()).join("\n");
    const leaked = INTERNAL_FRAMES.filter((name) => all.includes(name));
    if (leaked.length > 0) throw new Error(`내부 프레임 노출: ${show(leaked)}`);
    const cur = await cursorRow();
    if (cur !== 4) throw new Error(`커서 행 = ${cur}(기대 4)`);
  });

  // ⑥ 개행 없는 출력: 다음 프롬프트가 `t>>>`, 이어 `abc`를 치면 `t>>> abc`. (⑤의 트레이스백을 화면에 둔 채 이어서 스크린샷에 함께 담는다.)
  await step("⑥ `print(\"t\", end=\"\")` → `t>>>`, 이어 `abc`를 치면 `t>>> abc`", async () => {
    await type('print("t", end="")');
    await enter();
    await waitPrompt("t>>>");
    await type("abc");
    await waitFor(async () => (await lastLine()) === "t>>> abc", "마지막 행 `t>>> abc`", 5000);
    if (screenshotPath) await page.screenshot({ path: screenshotPath });
  });

  await step("콘솔 경고·오류가 없다(exit() 이전)", async () => {
    if (h.problemLogs().length > 0 || h.pageErrors.length > 0) {
      throw new Error(JSON.stringify({ problemLogs: h.problemLogs(), pageErrors: h.pageErrors }));
    }
  });

  // ⑦ exit(): 상태 terminated, 종료 문구, 터미널에 추가 줄 없음, 이후 입력 무응답, worker는 살아 있다.
  await killLine();
  await resetPrompt();
  await clear();
  await step("⑦ `exit()` → 상태 `terminated`와 종료 안내 문구, 터미널은 `>>> exit()`에서 멈춘다", async () => {
    await type("exit()");
    await enter();
    await waitFor(async () => (await statusText()) === "terminated", "status = terminated", 10000);
    const text = await terminatedText();
    // RD-010(세션 리셋)이 종료 문구에 안내 문장을 덧붙였다(RD-018, 낡은 기대값 갱신).
    const expectedText = 'Python session terminated. "세션 리셋" 버튼으로 새 세션을 시작하세요.';
    if (text !== expectedText) throw new Error(`terminated 텍스트 = ${show(text)}`);
    // 종료 뒤 새 프롬프트·추가 출력이 없다는 부정 확인은 폴링으로 증명할 수 없어 여유를 두고 본다.
    await page.waitForTimeout(800);
    const t = await h.trimmedRows();
    if (!same(t, [">>> exit()"])) throw new Error(`행 = ${show(t)}`);
    if (screenshotPath) await page.screenshot({ path: screenshotPath.replace(/\.png$/, "-terminated.png") });
  });

  await step("⑦ 종료 뒤 입력(`1+1` Enter)에 화면이 변하지 않는다", async () => {
    const before = await rows();
    // 화면이 바뀌지 않는 것이 기대 결과라 하니스의 type/enter(그려짐을 기다린다)를 쓰지 않고 키를 직접 보낸다.
    await page.keyboard.type("1+1");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    const after = await rows();
    if (!same(before, after)) throw new Error(`화면이 변했다: ${show(await h.trimmedRows())}`);
  });

  await step("⑦ 종료해도 worker는 살아 있다(정확히 1개)", async () => {
    if (page.workers().length !== 1) throw new Error(`workers().length = ${page.workers().length}`);
  });

  extra = {
    exitPageErrors: h.pageErrors.length,
    exitPageErrorSamples: h.pageErrors.map((e) => e.replace(/\s+/g, " ").slice(0, 160)),
    exitProblemLogs: h.problemLogs().length,
  };
  notes["exit() 뒤 pageerror(RD-009 대상, 실패로 세지 않음)"] = `${h.pageErrors.length}건`;
}

if (mode === "cdn-blocked") {
  let failureRow = -1;
  await step("빨간 'pyodide 로드 실패: ' 행이 터미널에 찍힌다", async () => {
    await waitFor(async () => {
      failureRow = (await rows()).findIndex((r) => r.startsWith(LOAD_FAILED_PREFIX));
      return failureRow >= 0;
    }, `'${LOAD_FAILED_PREFIX}' 행`);
    const classes = await rowClasses();
    if (!hasFg(classes[failureRow] ?? [], 1)) {
      throw new Error(`실패 행 클래스 = ${show(classes[failureRow])}`);
    }
  });

  await step("상태 표시가 load-failed다", async () => {
    await waitFor(async () => (await statusText()) === "load-failed", "status = load-failed", 5000);
  });

  await step("배너가 없고 pageerror가 없고 페이지가 살아 있다", async () => {
    const all = await rows();
    if (all.some((r) => r.startsWith("Python 3."))) throw new Error("배너 행이 있다");
    if (h.pageErrors.length > 0) throw new Error(`pageerror = ${show(h.pageErrors)}`);
    const title = await page.title();
    if (title !== "runo-pyodide-repl") throw new Error(`title = ${show(title)}`);
  });

  // 양성 대조: 차단이 실제로 CDN 요청에 걸렸는지(라우팅이 무효라 로드가 우연히 실패한 게 아닌지).
  await step("차단한 CDN 요청이 실제로 발생했다", async () => {
    if (requestedCdn.length === 0) throw new Error("cdn.jsdelivr.net 실패 요청 0건");
  });
  await step("로드 실패 뒤 readLine 요청이 없어 입력이 무응답이다(REPL 프롬프트 없음)", async () => {
    await page.waitForTimeout(500);
    const all = await rows();
    if (all.some((r) => r === ">>>" || r.startsWith(">>> "))) throw new Error(`프롬프트가 있다: ${show(await h.trimmedRows())}`);
  });
  notes["실패한 CDN 요청(참고)"] = requestedCdn.slice(0, 3);
  notes["콘솔 오류·경고(참고, 실패로 세지 않음)"] = h.problemLogs();
  notes["실패 행 전체(참고)"] = (await rows()).filter((r) => r !== "");
}

if (mode === "not-isolated") {
  await step("페이지가 cross-origin isolated가 아니다", async () => {
    const text = await isolatedText();
    if (text !== "false") throw new Error(`cross-origin-isolated = ${text}`);
  });

  await step("상태 표시가 not-isolated다", async () => {
    await waitFor(async () => (await statusText()) === "not-isolated", "status = not-isolated", 5000);
  });

  await step("첫 행부터 노란 경고 한 줄이 찍힌다(80열에서 감김)", async () => {
    const all = await rows();
    const end = all.findIndex((r) => r === "");
    const warningRows = all.slice(0, end < 0 ? all.length : end);
    // 한글은 2열이라 여러 행으로 감기고 감기는 위치의 공백이 사라질 수 있어 공백을 뺀 문자열로 비교한다.
    const joined = warningRows.join("").replace(/\s/g, "");
    const expected = NOT_ISOLATED_WARNING.replace(/\s/g, "");
    if (joined !== expected) throw new Error(`경고 행 = ${show(warningRows)}`);
    const classes = await rowClasses();
    const notYellow = warningRows.map((_, i) => i).filter((i) => !hasFg(classes[i] ?? [], 3));
    if (notYellow.length > 0) throw new Error(`xterm-fg-3 없는 행 = ${show(notYellow)}`);
    notes["경고 행 수(참고)"] = warningRows.length;
  });

  await step("worker가 없고 배너가 없고 콘솔 오류·pageerror가 없다", async () => {
    // worker가 만들어졌다면 생성 이벤트가 이미 도착했을 시간을 준다(부정 확인은 폴링으로 증명할 수 없다).
    await page.waitForTimeout(1500);
    if (page.workers().length !== 0) throw new Error(`workers().length = ${page.workers().length}`);
    const all = await rows();
    if (all.some((r) => r.startsWith("Python 3."))) throw new Error("배너 행이 있다");
    const errors = h.logs.filter((l) => l.type === "error");
    if (errors.length > 0 || h.pageErrors.length > 0) {
      throw new Error(JSON.stringify({ errors, pageErrors: h.pageErrors }));
    }
  });
}

const ok = await h.finish({ label, mode, ...extra });
exitWith(ok);
