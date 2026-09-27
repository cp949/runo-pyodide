// RD-011a 브라우저 캡처(끝 개행 정리)의 RD-005 해당 시나리오 이식. 이전 구현
// `pyodide-samples/_works/_completed/20260919-07-rd-011a-trailing-newline/reference/{capture.mjs,after.json}`의 SCENARIOS 16개 중
//   S01·S02·S04·S05·S06·S09·S10·S11·S12·S13·S15·S16 (12개)
// 을 캡처 대조가 아니라 기대 행 직접 단언으로 옮겼다. 각 입력 뒤 행 목록과 커서 행이 기대와 같아야 한다(빈 줄이 끼면 실패).
// 기대 행은 이전 `after.json`의 값이다. 다음은 이전 구현 고유라 다르게 잡았다(각각 결정 절에 근거):
//   - S13: 이전은 `... ` 프롬프트에 자동 들여쓰기 4칸이 미리 채워졌다. RD-018 DELTA-02 갱신: 이후 RD-013이 데모에도
//     같은 자동 들여쓰기를 넣어 다시 프리필된다 — 수동 4칸을 치지 않고 프리필을 그대로 쓴다(화면 문자열은 불변).
//   - S15: 이전 `after.json`은 RD-011b 이전 상태라 `err` 뒤 빈 줄이 2개다(`RD-011b 대상`). 3.14 기준(빈 줄 없음)으로 잡는다.
//   - S16: 이전은 경고 뒤 빈 줄 1개(같은 RD-011b 대상). 3.14 기준으로 잡고 파일명은 `<console>`이다(편차 30).
// 건너뜀: S03·S07(붙여넣기 분할) → RD-011, S08(실행 중 Ctrl+C) → RD-007, S14(`if True:` 뒤 Ctrl+C) → RD-008.
// 출처 RD-005, `_works/_completed/20260922-05-rd-005-repl-loop/verify/`에서 이관(RD-018).
// 사용: node trailing-newline-check.mjs <url>(생략 시 http://localhost:5173)
// 결과 파일 label은 url 포트 4173이면 preview, 그 밖은 dev(RD-018 DELTA-02 결정).
import { checkEntry, exitWith, serverLabel } from "../check-runner.mjs";
import { open, same, show } from "../lib.mjs";

const { url } = checkEntry();
const label = serverLabel(url);

const BANNER_FIRST = /^Python 3\.14\.2 \(.*\) on WebAssembly\/Emscripten$/;
const BANNER_SECOND = 'Type "help", "copyright", "credits" or "license" for more information.';

const h = await open(url);
const { step, waitPrompt, clear, type, enter, submit, trimmedRows, cursorRow } = h;

/** 화면이 기대 행과 같고 커서가 마지막 행(프롬프트)에 있는지 본다. */
async function expectScreen(expected) {
  const actual = await trimmedRows();
  if (!same(actual, expected)) throw new Error(`행 = ${show(actual)}`);
  const cur = await cursorRow();
  if (cur !== expected.length - 1) throw new Error(`커서 행 = ${cur}(기대 ${expected.length - 1}), 행 = ${show(actual)}`);
}

// 시작: pyodide 로드 대기(CDN, 최대 90초). 배너 화면은 아무 입력 전에 본다(S04).
await step("S04 시작 배너: 행 0~1이 배너, 행 2가 `>>>`, 커서가 그 행(빈 줄 없음)", async () => {
  await waitPrompt(">>>", 90000);
  await h.focus();
  const all = await trimmedRows();
  if (all.length !== 3) throw new Error(`행 = ${show(all)}`);
  if (!BANNER_FIRST.test(all[0])) throw new Error(`행0 = ${show(all[0])}`);
  if (all[1] !== BANNER_SECOND) throw new Error(`행1 = ${show(all[1])}`);
  if (all[2] !== ">>>") throw new Error(`행2 = ${show(all[2])}`);
  if ((await cursorRow()) !== 2) throw new Error(`커서 행 = ${await cursorRow()}`);
});

// S15·S16이 쓰는 모듈을 미리 import한다(출력 없음).
await submit("import sys, warnings");

/** 단일 입력 시나리오: 화면을 지우고 `input`을 제출해 기대 행을 본다. */
const single = (id, title, input, expected) => [
  id,
  title,
  async () => {
    await clear();
    await type(input);
    await enter();
    await waitPrompt(">>>");
    await expectScreen(expected);
  },
];

const scenarios = [
  single("S01", "한 줄 식 에코 `1 + 1`", "1 + 1", [">>> 1 + 1", "2", ">>>"]),
  single("S02", "문자열 에코 `'abc'`", "'abc'", [">>> 'abc'", "'abc'", ">>>"]),
  single("S05", "런타임 예외 `1/0`", "1/0", [
    ">>> 1/0",
    "Traceback (most recent call last):",
    '  File "<console>", line 1, in <module>',
    "ZeroDivisionError: division by zero",
    ">>>",
  ]),
  single("S06", "문법 오류 `x = = 2`(원문 그대로 SyntaxError)", "x = = 2", [
    ">>> x = = 2",
    '  File "<console>", line 1',
    "    x = = 2",
    "        ^",
    "SyntaxError: invalid syntax",
    ">>>",
  ]),
  single("S09", "raw 출력 직후 에코 `print(\"a\", end=\"\"); 1`", 'print("a", end=""); 1', [
    '>>> print("a", end=""); 1',
    "a1",
    ">>>",
  ]),
  single("S10", "대입 `x = 5`(에코 없음)", "x = 5", [">>> x = 5", ">>>"]),
  single("S11", "`None`(에코 없음)", "None", [">>> None", ">>>"]),
  single("S12", '`print("x")`', 'print("x")', ['>>> print("x")', "x", ">>>"]),
  [
    "S13",
    "블록 `for i in range(2):` / `    print(i)` / 빈 줄",
    async () => {
      await clear();
      await type("for i in range(2):");
      await enter();
      await waitPrompt("...");
      await type("print(i)"); // RD-013 프리필(4칸)이 이미 채워져 있다 — 수동 들여쓰기를 치지 않는다.
      await enter();
      await waitPrompt("...");
      await enter();
      await waitPrompt(">>>");
      await expectScreen([">>> for i in range(2):", "...     print(i)", "...", "0", "1", ">>>"]);
    },
  ],
  single("S15", '`print("err", file=sys.stderr)`(3.14 기준: err 뒤 빈 줄 없음)', 'print("err", file=sys.stderr)', [
    '>>> print("err", file=sys.stderr)',
    "err",
    ">>>",
  ]),
  single("S16", '`warnings.warn("w")`(3.14 기준: 경고 뒤 빈 줄 없음, 파일명 <console>)', 'warnings.warn("w")', [
    '>>> warnings.warn("w")',
    "<console>:1: UserWarning: w",
    ">>>",
  ]),
];

for (const [id, title, run] of scenarios) {
  await step(`${id} ${title}`, run);
}

await step("콘솔 경고·오류·pageerror가 없다", async () => {
  if (h.problemLogs().length > 0 || h.pageErrors.length > 0) {
    throw new Error(JSON.stringify({ problemLogs: h.problemLogs(), pageErrors: h.pageErrors }));
  }
});

const ok = await h.finish({ label });
exitWith(ok);
