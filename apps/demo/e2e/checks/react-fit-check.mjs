// RD-024 DELTA-06 브라우저 확인: `?fit=1`에서 `@cp949/runo-pyodide-repl-react` 컴포넌트가 컨테이너(창) 너비를 따라 xterm `cols`를 바꾸는지.
// 실제 xterm 6.0.0 + `@xterm/addon-fit` 0.11.0 + 실제 브라우저 + 실제 CDN pyodide. addon-fit이 xterm 비공개 API에 기대므로(`_core._renderService`)
// 이 스크립트가 addon-fit + xterm 6.0.0 조합의 첫 실제 브라우저 `cols` 변화 확인이다(jsdom은 셀 크기가 0이라 fit이 no-op이다).
// 컨테이너 높이는 auto라 창 크기로 바뀌는 것은 `cols`(너비)뿐이다. `rows`는 판정하지 않는다.
//
// `cols` 측정: 데모 페이지는 `Terminal` 객체를 노출하지 않으므로(`window`에 전역 없음) 두 가지 독립 근거로 잰다.
//   (1) DOM 기하: `.xterm-screen` 너비 ÷ 셀 너비(`.xterm-char-measure-element` 너비 ÷ 글자 수). xterm이 `cols` 변경 때 `.xterm-screen` 너비를
//       `cols × 셀 너비`로 다시 쓴다. 창 변경 판정은 이 값으로 한다(`colsFromGeometry`).
//   (2) 줄바꿈 폭: 열 수보다 긴 `x` 줄(400자)을 출력해 꽉 찬 행의 길이를 읽는다. xterm 버퍼의 실제 `cols`로 줄이 감긴다(`wrappedRowCols`).
//       (1)과 같아야 한다(`judgeWrapMatchesGeometry`).
//
// 화면 두 개를 각각 새 브라우저로 연다: `REPL`(`/?fit=1`), `RUNNER`(`/?view=runner&fit=1`). 시작 창은 1280×720.
//   F01 fit 켜짐: 초기 `cols`가 fit 끔의 기본값 80이 아니다(1280px 창)
//   F02 창을 640px로 좁히면 `cols`가 줄어든다(폴링)
//   F03 창을 1000px로 넓히면 `cols`가 늘어난다(폴링)
//   F04 출력의 줄바꿈 폭이 DOM 기하 `cols`와 같다
//   F05 REPL: (a) 유휴 상태에서 `print(1+1)` → `2` 행과 새 `>>>` / RUNNER: (b) `input()` 대기 중 창을 500px로 좁히고(`cols` 감소) 값을 입력하면 출력에 반영된다
//   F06 콘솔 warning·error와 pageerror가 없다
//
// 시간 판정(`docs/design/09-testing.md` 9.7): 고정 대기·ms 상한을 쓰지 않는다. `cols` 변화·출력 행·상태는 조건 대기(`waitFor`)이고
// `timeoutMs`는 정지 감지용이다. 판정 함수는 `../react-judge.mjs`(순수 함수, `react-judge.test.mjs`가 가짜 입력으로 시험).
//
// 사용: node react-fit-check.mjs [url](생략 시 http://localhost:5173)     ONLY=REPL 또는 ONLY=RUNNER (셀 접두어 `ONLY=RUNNER-F05`도 된다. F02·F03은 F01이 기록한 `cols`에 의존하므로 `ONLY=RUNNER-F01,RUNNER-F02,RUNNER-F03`처럼 선행 셀과 함께 실행한다)
// 결과 파일: `react-fit-check-<repl|runner>-dev.json`. dev 전용이 아니어도 동작하지만(preview에서도 fit은 같다) 기준선은 dev만 둔다.
import { open, same, show } from "../lib.mjs";
import { colsFromGeometry, judgeColsChange, judgeWrapMatchesGeometry } from "../react-judge.mjs";
import { checkEntry, currentOnly, exitWith, pageSelected } from "../check-runner.mjs";

const { url: baseUrl } = checkEntry();
const only = currentOnly();
/** worker 부팅(pyodide 로드)·리사이즈 반영 대기용 정지 감지 timeout(판정선이 아니다). */
const BOOT_TIMEOUT_MS = 90000;
const STEP_TIMEOUT_MS = 15000;
const HEIGHT = 720;
/** fit 끔일 때 xterm 기본 열 수. 초기 `cols`가 이 값이면 fit이 붙지 않은 것이다. */
const DEFAULT_COLS = 80;

const VIEWS = [
  { name: "REPL", path: "/?fit=1", label: "repl" },
  { name: "RUNNER", path: "/?view=runner&fit=1", label: "runner" },
].filter((v) => pageSelected(only, v.name));

let allOk = true;
for (const view of VIEWS) {
  const h = await open(new URL(view.path, baseUrl).href, { viewport: { width: 1280, height: HEIGHT } });
  const { page, step, waitFor, waitStatus, waitPrompt, rows, trimmedRows, focus, type, enter, submit, clear, press } = h;
  const P = (id, text) => `${view.name}-${id} ${text}`;

  /** 화면의 열 수(DOM 기하). 요소가 아직 없으면 NaN. */
  const cols = () =>
    page
      .evaluate(() => {
        const screen = document.querySelector(".xterm-screen");
        const measure = document.querySelector(".xterm-char-measure-element");
        if (!screen || !measure) return null;
        return {
          screenWidth: screen.getBoundingClientRect().width,
          measureWidth: measure.getBoundingClientRect().width,
          measureChars: (measure.textContent ?? "").length,
        };
      })
      .then((g) => (g === null ? Number.NaN : colsFromGeometry(g)));
  /** 창 너비를 바꾸고 `cols`가 `before`와 달라질 때까지 기다린 뒤 방향 판정 결과를 돌려준다. */
  async function resizeTo(width, before, direction) {
    await page.setViewportSize({ width, height: HEIGHT });
    let after = before;
    await waitFor(
      async () => {
        after = await cols();
        return after !== before;
      },
      `창 ${width}px 뒤 cols가 ${before}에서 바뀜`,
      STEP_TIMEOUT_MS,
    ).catch(() => {});
    return { after, verdict: judgeColsChange(before, after, direction) };
  }
  const waitRow = (text, timeoutMs = 30000) =>
    waitFor(async () => (await rows()).some((r) => r === text), `출력 행 ${show(text)}`, timeoutMs);
  /** 지금까지 잰 열 수(셀 사이에서 이어 쓴다). */
  const seen = {};

  await step(P("F01", "fit 켜짐: 초기 cols가 기본 80이 아니다(1280px 창)"), async () => {
    await waitFor(async () => (await cols()) > 0, "xterm 화면 측정 가능", BOOT_TIMEOUT_MS);
    seen.initial = await cols();
    h.notes[P("F01", "cols")] = seen.initial;
    if (seen.initial === DEFAULT_COLS) throw new Error(`cols = ${seen.initial}: fit이 컨테이너를 따르지 않았다`);
  });

  await step(P("F02", "창을 640px로 좁히면 cols가 줄어든다"), async () => {
    const { after, verdict } = await resizeTo(640, seen.initial, "shrink");
    seen.narrow = after;
    h.notes[P("F02", "cols")] = `${seen.initial} → ${after}`;
    if (!verdict.ok) throw new Error(verdict.reason);
  });

  await step(P("F03", "창을 1000px로 넓히면 cols가 늘어난다"), async () => {
    const { after, verdict } = await resizeTo(1000, seen.narrow, "grow");
    seen.wide = after;
    h.notes[P("F03", "cols")] = `${seen.narrow} → ${after}`;
    if (!verdict.ok) throw new Error(verdict.reason);
  });

  // 부팅이 끝나 입력을 받을 수 있는 상태로 만든다(창 크기 변경은 위에서 이미 끝났다: 부팅 중 리사이즈도 함께 통과한 셈이다).
  if (view.name === "REPL") await waitPrompt(">>>", BOOT_TIMEOUT_MS);
  else await waitStatus(["ready"], "status = ready", BOOT_TIMEOUT_MS);

  await step(P("F04", "출력의 줄바꿈 폭이 DOM 기하 cols와 같다"), async () => {
    const geometry = await cols();
    const code = 'print("x" * 400)';
    if (view.name === "REPL") {
      await focus();
      await clear();
      await submit(code);
    } else {
      await page.click('[data-testid="clear"]');
      await waitFor(async () => (await trimmedRows()).length === 0, "clear 뒤 빈 화면", 5000);
      await page.fill('[data-testid="code"]', code);
      await page.click('[data-testid="run"]');
      await waitStatus(["ready"], "출력 뒤 ready", BOOT_TIMEOUT_MS);
      await waitFor(async () => (await page.locator('[data-testid="result"]').textContent()) !== "", "result 채움", BOOT_TIMEOUT_MS);
    }
    // x 400개 전부가 화면에 도착할 때까지(마지막 행까지 그려질 때까지) 기다린다.
    await waitFor(async () => (await rows()).join("").split("x").length - 1 >= 400, "x 400자 출력", STEP_TIMEOUT_MS);
    const verdict = judgeWrapMatchesGeometry(await rows(), geometry);
    h.notes[P("F04", "wrap")] = verdict.reason;
    if (!verdict.ok) throw new Error(verdict.reason);
  });

  if (view.name === "REPL") {
    await step(P("F05", "(a) 유휴 상태에서 print(1+1) → 2 (리사이즈 뒤 입력이 정상이다)"), async () => {
      await focus();
      await clear();
      await submit("print(1+1)");
      await waitFor(async () => same(await trimmedRows(), [">>> print(1+1)", "2", ">>>"]), "print(1+1) 화면", STEP_TIMEOUT_MS).catch(
        async (e) => {
          throw new Error(`${e.message} — 행 ${show(await trimmedRows())}`);
        },
      );
    });
  } else {
    await step(P("F05", "(b) input() 대기 중 창을 좁힌 뒤 값을 입력하면 출력에 반영된다"), async () => {
      await page.click('[data-testid="clear"]');
      await waitFor(async () => (await trimmedRows()).length === 0, "clear 뒤 빈 화면", 5000);
      await page.fill('[data-testid="code"]', 'name = input("이름: ")\nprint("안녕 " + name)');
      await page.click('[data-testid="run"]');
      await waitStatus(["waiting-input"], "입력 대기 상태", BOOT_TIMEOUT_MS);
      await waitPrompt("이름:", STEP_TIMEOUT_MS);
      // 읽기가 열린 채로 창을 좁힌다.
      const before = await cols();
      const { after, verdict } = await resizeTo(500, before, "shrink");
      h.notes[P("F05", "cols")] = `${before} → ${after}(입력 대기 중)`;
      if (!verdict.ok) throw new Error(`입력 대기 중 ${verdict.reason}`);
      await focus();
      await type("kim");
      await enter();
      await waitStatus(["ready"], "입력 뒤 ready", BOOT_TIMEOUT_MS);
      await waitFor(async () => same(await trimmedRows(), ["이름: kim", "안녕 kim"]), "입력 뒤 출력", STEP_TIMEOUT_MS).catch(
        async (e) => {
          throw new Error(`${e.message} — 행 ${show(await trimmedRows())}`);
        },
      );
      const r = JSON.parse(await page.locator('[data-testid="result"]').textContent());
      if (r.kind !== "ok") throw new Error(`결과 = ${show(r)}`);
    });
  }

  await step(P("F06", "콘솔 warning·error와 pageerror가 없다"), async () => {
    const problems = h.problemLogs();
    if (problems.length > 0 || h.pageErrors.length > 0) {
      throw new Error(JSON.stringify({ problems, pageErrors: h.pageErrors }));
    }
  });

  const ok = await h.finish({ label: `${view.label}-dev`, view: view.name });
  allOk &&= ok;
}

exitWith(allOk);
