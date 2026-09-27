// RD-006b 브라우저 검증(REPL 프롬프트 이어붙임)의 RD-005 해당 시나리오 이식. 이전 구현
// `pyodide-samples/_works/_completed/20260919-11-rd-006b-repl-prompt-join/reference/browser-check.mjs`(74개) 중
//   초기 프롬프트, T1, U1, W1, W3, W4, W5, X1, Y1~Y4, Z1, Z2, AA×5, AB1, AB2, 끝 pageerror 없음
// 을 새 데모(포트 5173, 하니스 lib.mjs)에 맞춰 옮겼다. 기대 행·입력 문장은 이전 스크립트의 것을 그대로 쓴다.
// 이전과 달라진 입력 방식(모두 새 구현이 아직 갖지 않은 기능을 피하는 것이다):
//   - U1: 이전은 `input("p: ")`로 꼬리 비움을 봤다(stdin은 RD-006). 같은 성질(읽기가 꼬리를 비운다)을 출력 없는 문장 `pass`로 본다.
//   - 블록 안 줄은 자동 들여쓰기(RD-013)가 없어 공백 4칸을 직접 친다(`... ` 프롬프트 + 4칸 = 이전 화면과 같은 행).
//   - 정리에 Ctrl+C(RD-007) 대신 Ctrl+U(줄 지우기) + 빈 Enter를 쓴다.
//   - AB의 400토큰(스크롤백 관찰)은 판정 밖이라 옮기지 않았다. 250토큰(16행)은 24행 뷰포트 안이라 DOM 행으로 센다.
// 건너뛴 ID → 대상 RD: A1~A5·B1·B2·C1·C2·D1·E1·E2·H1·H2·K1~K3·L1·M1·M2·N1~N3·O1·O2·P1~P9·Q1·R1·S1·J1·J3 → RD-006/008
//   (input()·stdin), F×5·G1·G2 → RD-007(Ctrl+C·송신기), G3·W2 → RD-008(프롬프트 취소), X2·X3 → RD-014(블록 history),
//   AC1·J2 → RD-010(세션 리셋), V·AD(관찰 항목) → 해당 RD와 함께.
// 출처 RD-005, `_works/_completed/20260922-05-rd-005-repl-loop/verify/`에서 이관(RD-018).
// 사용: node prompt-join-check.mjs <url>(생략 시 http://localhost:5173)
// 결과 파일 label은 url 포트 4173이면 preview, 그 밖은 dev(RD-018 DELTA-02 결정).
import { checkEntry, exitWith, serverLabel } from "../check-runner.mjs";
import { hasFg, open, same, show } from "../lib.mjs";

const { url } = checkEntry();
const label = serverLabel(url);

const h = await open(url);
const { step, waitPrompt, waitLastEndsWith, waitFor, clear, type, enter, press, killLine, resetPrompt, tail, lastLine, rows, nonEmpty, spansOf, cursorRow, focus } = h;

/** 화면을 지우고 코드를 실행해 꼬리가 든 프롬프트(`expectedPrompt`)가 뜰 때까지 기다린다. */
async function runTail(code, expectedPrompt) {
  await clear();
  await type(code);
  await enter();
  await waitPrompt(expectedPrompt);
}

await step("초기: 프롬프트가 뜬다", async () => {
  await waitPrompt(">>>", 60000);
  await focus();
});

await step("T1 REPL 프롬프트는 개행 없는 출력의 꼬리 뒤에 한 줄로 이어 붙는다(3.14의 t>>> )", async () => {
  await runTail('print("t", end="")', "t>>>");
  const t = await tail(2);
  if (!same(t, ['>>> print("t", end="")', "t>>>"])) throw new Error(show(t));
});

await step("U1 다음 문장이 출력이 없어도 앞 문장의 꼬리(t)를 물려받지 않는다(>>>)", async () => {
  await type("pass");
  await enter();
  await waitPrompt(">>>");
  const t = await tail(3);
  if (!same(t, ['>>> print("t", end="")', "t>>> pass", ">>>"])) throw new Error(show(t));
});

await step("W1 꼬리 뒤 프롬프트에 입력한 글자가 같은 줄에 이어진다(t>>> abc)", async () => {
  await runTail('print("t", end="")', "t>>>");
  await type("abc");
  const t = await tail(2);
  if (!same(t, ['>>> print("t", end="")', "t>>> abc"])) throw new Error(show(t));
  await killLine();
  await resetPrompt();
});

await step("W3 ↑ 재호출 뒤에도 프롬프트는 t>>> 로 남고 재호출한 줄이 뒤에 붙는다", async () => {
  await runTail('print("t", end="")', "t>>>");
  await press("ArrowUp");
  await waitFor(async () => (await lastLine()) === 't>>> print("t", end="")', "↑ 재호출한 줄", 5000);
  await killLine();
  await resetPrompt();
});

await step("W4 빈 Enter 뒤 다음 프롬프트는 꼬리를 물려받지 않는다(t>>> 는 남고 새 행이 >>>)", async () => {
  await runTail('print("t", end="")', "t>>>");
  await resetPrompt();
  const t = await tail(3);
  if (!same(t, ['>>> print("t", end="")', "t>>>", ">>>"])) throw new Error(show(t));
});

await step("W5 개행 없는 출력 뒤 값 에코는 꼬리 줄에 이어지고 다음 프롬프트는 꼬리가 없다(t5 / >>>)", async () => {
  await clear();
  await type('print("t", end=""); 5');
  await enter();
  await waitPrompt(">>>");
  const t = await tail(3);
  if (!same(t, ['>>> print("t", end=""); 5', "t5", ">>>"])) throw new Error(show(t));
});

await step("X1 블록이 낸 개행 없는 출력(012) 뒤 프롬프트는 012>>> 한 줄이다", async () => {
  await clear();
  await type("for i in range(3):");
  await enter();
  await waitPrompt("...");
  await type('    print(i, end="")');
  await enter();
  await waitPrompt("...");
  await enter();
  await waitPrompt("012>>>");
  const t = await tail(4);
  if (!same(t.slice(-1), ["012>>>"])) throw new Error(show(t));
  await resetPrompt();
});

await step("Y1·Y2 stderr 꼬리 뒤 프롬프트는 e>>> 한 줄이고 e는 빨강(xterm-fg-1), >>> 는 빨강이 아니다", async () => {
  await runTail('import sys; print("e", end="", file=sys.stderr)', "e>>>");
  if ((await lastLine()) !== "e>>>") throw new Error(show(await lastLine()));
  const spans = await spansOf("e>>>");
  const eRed = spans.some((sp) => sp.text.includes("e") && !sp.text.includes(">") && /xterm-fg-1\b/.test(sp.cls));
  const promptRed = spans.some((sp) => sp.text.includes(">>>") && /xterm-fg-1\b/.test(sp.cls));
  if (!eRed || promptRed) throw new Error(`eRed=${eRed} promptRed=${promptRed} ${show(spans)}`);
  await resetPrompt();
});

await step("Y3·Y4 닫히지 않은 초록 꼬리 뒤 프롬프트는 G>>> abc 한 줄이고 G만 초록(xterm-fg-2)이다", async () => {
  await runTail('print("\\x1b[32mG", end="")', "G>>>");
  await type("abc");
  if ((await lastLine()) !== "G>>> abc") throw new Error(show(await lastLine()));
  const spans = await spansOf("G>>>");
  const gGreen = spans.some((sp) => sp.text.includes("G") && /xterm-fg-2\b/.test(sp.cls));
  const restGreen = spans.some((sp) => (sp.text.includes(">>>") || sp.text.includes("abc")) && /xterm-fg-2\b/.test(sp.cls));
  if (!gGreen || restGreen) throw new Error(`gGreen=${gGreen} restGreen=${restGreen} ${show(spans)}`);
  await killLine();
  await resetPrompt();
});

await step("Z1 \\r 진행률(30% → 100%) 뒤 프롬프트는 100%>>> 한 줄이다(3.14와 같다)", async () => {
  await runTail('print("30%", end=""); print("\\r100%", end="")', "100%>>>");
  if ((await lastLine()) !== "100%>>>") throw new Error(show(await tail(3)));
  await resetPrompt();
});

await step("Z2 [편차 기록] 프롬프트보다 긴 잔여물은 지워진다(3.14는 `short>>> 9ABCDEFGHIJ`로 남긴다)", async () => {
  await runTail('print("0123456789ABCDEFGHIJ\\rshort", end="")', "short>>>");
  if ((await lastLine()) !== "short>>>") throw new Error(show(await tail(3)));
  await resetPrompt();
});

// AA. 폭을 넘는 꼬리: 앞 행이 중복되지 않고 나머지 뒤에 프롬프트가 온다(TRP-016). 3.14 pty 실측: 100자 → `x×80` / `x×20>>> `,
// 정확히 80자 → 다음 행 열 0의 `>>> `.
const Q80 = "q".repeat(80);
for (const [label2, code, fullRows, lastExpected] of [
  ["100자(2행)", 'print("q" * 100, end="")', 1, `${"q".repeat(20)}>>>`],
  ["130자(2행)", 'print("q" * 130, end="")', 1, `${"q".repeat(50)}>>>`],
  ["200자(3행)", 'print("q" * 200, end="")', 2, `${"q".repeat(40)}>>>`],
  ["정확히 80자", 'print("q" * 80, end="")', 1, ">>>"],
]) {
  // eslint 대상 밖(e2e/**)이라 no-shadow 우려 없이 원문 그대로 둘 수 있었지만, 바깥 스코프의
  // RD-018 label(결과 파일 label)과 이름이 겹쳐 읽기 혼동이 있어 label2로 바꿨다(판정 로직 불변).
  await step(`AA 폭 초과 꼬리 ${label2}: 코드 줄 아래 ${fullRows}행이 한 번씩만 나오고 마지막 행이 ${lastExpected}이다`, async () => {
    await runTail(code, lastExpected);
    const t = await tail(fullRows + 2);
    const wide = (await nonEmpty()).filter((l) => l === Q80).length;
    if (wide !== fullRows) throw new Error(`80자 행 ${wide}개(기대 ${fullRows}): ${show(t)}`);
    if ((await lastLine()) !== lastExpected) throw new Error(`마지막 행 ${show(await lastLine())}`);
    if (t[0] !== `>>> ${code}`) throw new Error(`첫 행 ${show(t[0])}`);
    await resetPrompt();
  });
}
await step("AA 전각 꼬리(45자 = 90칸): 첫 행(40자)이 한 번만 나오고 마지막 행이 가가가가가>>>이다", async () => {
  await runTail('print("\\uac00" * 45, end="")', "가가가가가>>>");
  const full = (await nonEmpty()).filter((l) => l === "가".repeat(40)).length;
  if (full !== 1) throw new Error(`40자 행 ${full}개: ${show(await tail(3))}`);
  await resetPrompt();
});

// AB. 뷰포트를 채우는 꼬리. 토큰(`0000 `…, 5글자)으로 중복·소실을 센다. 250토큰(16행)은 24행 뷰포트 안이라 DOM 행으로 센다.
const tokenName = (i) => String(i).padStart(4, "0");
async function tokenReport(n) {
  const all = await rows();
  const at = all.map((l, i) => (l.includes("{i:04d}") ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
  const seen = new Map();
  for (const tok of all.slice(at + 1).join(" ").match(/\b\d{4}\b/g) ?? []) seen.set(tok, (seen.get(tok) ?? 0) + 1);
  const missing = [];
  const dup = [];
  for (let i = 0; i < n; i++) {
    const count = seen.get(tokenName(i)) ?? 0;
    if (count === 0) missing.push(tokenName(i));
    if (count > 1) dup.push(tokenName(i));
  }
  return { missing, dup };
}
await step("AB1 250토큰(16행) 꼬리 뒤 프롬프트: 토큰이 한 번씩만 있다", async () => {
  await clear();
  await type('print("".join(f"{i:04d} " for i in range(250)), end="")');
  await enter();
  await waitLastEndsWith(`${tokenName(249)} >>>`);
  const rep = await tokenReport(250);
  if (rep.missing.length > 0 || rep.dup.length > 0) throw new Error(`소실 ${rep.missing.length} 중복 ${rep.dup.length}`);
});
await step("AB2 그 프롬프트에 130자를 입력해 행이 늘어나도 소실·중복이 없다", async () => {
  await type("a".repeat(130), { sync: false });
  // 프롬프트 행(54칸) 뒤에 26 + 80 + 24자로 감긴다. 마지막 행이 a 24개가 될 때까지 기다린다.
  await waitFor(async () => (await lastLine()) === "a".repeat(24), "감긴 마지막 행(a×24)", 5000);
  const rep = await tokenReport(250);
  if (rep.missing.length > 0 || rep.dup.length > 0) throw new Error(`소실 ${rep.missing.length} 중복 ${rep.dup.length}`);
});

// AD(RD-018 확정 8·14, docs/design/10-parity-deviations.md 편차 44): 꼬리가 든 프롬프트에서 입력 중
// Ctrl+L을 누르면 3.14(`skipped-ids.md` 기록: 화면 전체를 지워 `>>> foo`만 남김)와 달리 꼬리가 지워지지
// 않고 그대로 남는다(실측, DELTA-03). 실측값을 기대값으로 고정한다.
await step("AD 꼬리(t>>> foo)에서 Ctrl+L은 꼬리를 지우지 않고 t>>> foo 한 행만 남긴다(편차 44)", async () => {
  // AB2가 미제출 입력(a×130, sync:false)을 남겨 두므로(그 절의 마지막이라 원래는 정리가 필요 없었다)
  // 먼저 제출해 깨끗한 >>> 로 돌아온다(W1 등과 같은 정리 패턴).
  await killLine();
  await resetPrompt();
  await runTail('print("t", end="")', "t>>>");
  await type("foo");
  await waitFor(async () => (await lastLine()) === "t>>> foo", "입력 foo가 꼬리 뒤에 반영", 3000);
  await press("Control+l");
  await waitFor(async () => (await rows())[0] === "t>>> foo", "Ctrl+L 뒤 첫 행이 t>>> foo", 5000);
  const allRows = (await rows()).filter((r) => r !== "");
  if (!same(allRows, ["t>>> foo"])) throw new Error(`행 목록 = ${show(allRows)}`);
  if ((await cursorRow()) !== 0) throw new Error(`커서 행 = ${await cursorRow()}(0 기대)`);
  await killLine();
  await resetPrompt();
});

await step("콘솔 경고·오류·pageerror가 없다", async () => {
  if (h.problemLogs().length > 0 || h.pageErrors.length > 0) {
    throw new Error(JSON.stringify({ problemLogs: h.problemLogs(), pageErrors: h.pageErrors }));
  }
});

const ok = await h.finish({ label });
exitWith(ok);
