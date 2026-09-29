// RD-011 브라우저 확인: 붙여넣기·Shift+Enter·히스토리 재호출로 여러 줄을 한 번에 제출·실행한다.
// 규칙은 `docs/design/06-editing.md` 6.5. RD-011에서 이관했다(RD-018).
// RD-011 시나리오와 이월 S03·S07을 절 8개로 나눈다: paste·tab·parse·stop·block·shift·recall·input.
//
// 실행:
// - dev에서 절 8개를 모두 돈다.
// - preview는 devURL·previewURL이 둘 다 있을 때만 돈다. paste·tab·parse 대표 3건이다.
// - `ONLY=<절 이름,…>`는 preview에도 그대로 적용된다. preview 전용 절 목록은 선언하지 않는다(RD-044 K6).
//
// shift 절은 RD-013 자동 들여쓰기 프리필을 그대로 쓴다.
// - Shift+Enter도 `onKey`가 `nextIndentation`으로 프리필을 계산해 넣는다. `for i in range(2):` 뒤에 4칸이 채워진다(6.3).
// - 프리필 위에 `print(i)`만 친다. 수동 4칸을 더 치면 8칸이 된다.
// - 판정 문자열 "0"·"1"은 들여쓰기 폭을 보지 않는다.
// - `auto-indent-check.mjs`의 `multiline-shift` 절이 같은 시나리오를 프리필 기준으로 다시 확인한다.
//
// 사용: `node multiline-check.mjs [devURL] [previewURL]`
// 결과 파일 규칙은 README "결과 파일 규칙".
import { open, same, show } from "../lib.mjs";
import { checkEntry, exitWith, runDevPreview, serverLabel } from "../check-runner.mjs";

/** dev 화면에서 절 8개를 돌리고 모든 확인이 통과했는지 돌려준다. */
async function runDev(url) {
  const h = await open(url);
  const { page, rows, tail, cursorRow, waitPrompt, type, press, paste, enter, submit, focus, waitFor, typeWhenReading, step } = h;

  const statusText = () => page.locator('[data-testid="status"]').textContent();
  const click = async (testid) => {
    await page.click(`[data-testid="${testid}"]`);
    await focus();
  };
  // 리셋 버튼 클릭 → `loading` → `ready`/`load-failed` → 새 프롬프트까지 기다린다.
  async function resetAndWait() {
    await click("reset");
    await waitFor(async () => (await statusText()) === "loading", "reset: loading 상태");
    await waitFor(
      async () => ["ready", "load-failed"].includes(await statusText()),
      "reset: ready 상태",
      30000,
    );
    await waitPrompt(">>>", 30000);
  }
  // 화면(이어붙인 문자열)에서 needle 개수. 행이 감겨도 놓치지 않는다.
  const count = async (needle) => (await rows()).join("\n").split(needle).length - 1;
  // 프롬프트가 보일 때까지 기다린 뒤 `tail(n)`을 돌려준다.
  async function tailAfterPrompt(n, prompt = ">>>") {
    await waitPrompt(prompt, 15000);
    return tail(n);
  }

  await step("초기: 첫 프롬프트", async () => {
    await waitPrompt(">>>");
  });

  // ── paste: RD-011 시나리오 + S03 + 무동작 + 기존 한 줄/빈 줄 동작 ──
  await step("paste: def add… 붙여넣기 Enter 1회 → 3, SyntaxError 없음", async () => {
    const r = await paste("def add(a, b):\n    return a + b\n\nprint(add(1, 2))");
    await enter();
    const t = await tailAfterPrompt(6);
    if (!t.some((r) => r === "3")) throw new Error(`마지막 행들 = ${show(t)}`);
    if ((await count("SyntaxError")) !== 0) throw new Error("SyntaxError가 보인다");
    h.notes["paste: def add… (paste route)"] = r.usedFallback ? "insertText/합성 이벤트 fallback" : "실제 클립보드";
  });
  await step("paste: 클래스 메서드 사이 빈 줄이 블록을 끊지 않는다", async () => {
    await paste(
      "class A:\n    def m(self):\n        return 1\n\n    def n(self):\n        return 2\n\nprint(A().n())",
    );
    await enter();
    const t = await tailAfterPrompt(6);
    if (!t.some((r) => r === "2")) throw new Error(`마지막 행들 = ${show(t)}`);
  });
  await step("paste: 1\\n2\\n3은 마지막 값만 에코한다(S03)", async () => {
    await paste("1\n2\n3");
    await enter();
    await waitPrompt(">>>", 15000);
    const t = await tail(5);
    // 입력 에코 ">>> 1"·"2"·"3" 뒤 값 에코 "3"이 한 번만 더 붙는다(1·2는 값 에코가 없다).
    if (!same(t, [">>> 1", "2", "3", "3", ">>>"])) {
      throw new Error(`마지막 5행 = ${show(t)}`);
    }
  });
  await step("paste: 붙여넣은 탭 보존(def f():\\n\\treturn 1\\nprint(f())) → 1", async () => {
    await paste("def f():\n\treturn 1\nprint(f())");
    await enter();
    const t = await tailAfterPrompt(6);
    if (!t.some((r) => r === "1")) throw new Error(`마지막 행들 = ${show(t)}`);
  });
  await step("paste: 주석·빈 줄만 있는 입력은 무동작이다(새 프롬프트만)", async () => {
    await paste("# only\n\n# comments");
    await enter();
    await waitPrompt(">>>", 15000);
    const t = await tail(4);
    // 입력 에코 3행(주석 두 줄 + 그 사이 빈 줄) 뒤 바로 다음 프롬프트여야 한다(추가 출력 없음).
    if (!same(t, [">>> # only", "", "# comments", ">>>"])) {
      throw new Error(`마지막 4행 = ${show(t)}`);
    }
  });
  await step("paste: 한 줄 1 + 1 → 2(기존 동작 유지)", async () => {
    await submit("1 + 1");
    const t = await tail(3);
    if (!t.some((r) => r === "2")) throw new Error(`마지막 행들 = ${show(t)}`);
  });
  await step("paste: 빈 줄 Enter는 프롬프트만 돌려준다(기존 동작 유지)", async () => {
    const before = await rows();
    await enter();
    await waitPrompt(">>>", 15000);
    const after = await rows();
    if (after.filter((r) => r !== "").length !== before.filter((r) => r !== "").length) {
      throw new Error(`빈 줄 Enter 뒤 출력이 생겼다 — ${show(after.slice(-4))}`);
    }
  });

  // ── tab: 붙여넣기 직후(Enter 전) 커서 관찰만, 실행 결과는 paste 절에서 이미 확인 ──
  await step("tab: 붙여넣은 탭 직후 커서 위치 관찰(판정 아님, notes에 기록)", async () => {
    await paste("def f():\n\treturn 1\nprint(f())");
    const cur = await cursorRow();
    const curLine = (await rows())[cur] ?? "";
    h.notes["tab: 붙여넣기 직후 커서 행"] = `row=${cur} text=${show(curLine)}`;
    await enter();
    const t = await tailAfterPrompt(4);
    if (!t.some((r) => r === "1")) throw new Error(`마지막 행들 = ${show(t)}`);
  });

  // ── parse: 파싱·컴파일 오류는 아무 문장도 실행하지 않는다 ──
  await step("parse: 문법 오류 뒤 이어진 이름 참조는 NameError다(S07)", async () => {
    await paste("a = 1\nb = = 2");
    await enter();
    let t = await tailAfterPrompt(8);
    if ((await count("SyntaxError")) < 1) throw new Error(`SyntaxError가 안 보인다 — ${show(t)}`);
    await submit("a");
    t = await tail(4);
    if (!t.some((r) => r.includes("NameError"))) throw new Error(`NameError가 안 보인다 — ${show(t)}`);
  });
  await step("parse: 함수 밖 return은 2차 compile 오류로 무실행이다", async () => {
    await paste("print(1)\nreturn 2");
    await enter();
    const t = await tailAfterPrompt(8);
    if (!(await count("'return' outside function"))) {
      throw new Error(`오류 문구가 안 보인다 — ${show(t)}`);
    }
    // print(1)이 실행됐다면 단독 "1" 행이 출력에 남는다(입력 에코 "print(1)"과는 다른 행).
    if (t.includes("1")) throw new Error(`print(1)이 실행됐다(단독 "1" 행 발견) — ${show(t)}`);
  });

  // ── stop: 예외·exit() 뒤 나머지 문장 미실행 ──
  await step("stop: 런타임 예외 뒤 나머지 문장은 실행하지 않는다", async () => {
    await paste("print(1)\n1/0\nprint(2)");
    await enter();
    const t = await tailAfterPrompt(8);
    if (!t.some((r) => r === "1")) throw new Error(`"1"이 안 보인다 — ${show(t)}`);
    if ((await count("ZeroDivisionError")) < 1) throw new Error(`ZeroDivisionError가 안 보인다 — ${show(t)}`);
    if (t.some((r) => r === "2")) throw new Error(`"2"가 보인다(실행되면 안 된다) — ${show(t)}`);
  });
  await step("stop: exit() 뒤 나머지 문장은 실행하지 않고 terminated Alert가 뜬다", async () => {
    await paste("print(1)\nexit()\nprint(2)");
    await enter();
    await waitFor(async () => (await statusText()) === "terminated", "status = terminated", 10000);
    // 상태 DOM 갱신이 xterm의 `1` 행 렌더보다 먼저 보일 수 있다. 그래서 `1` 행도 조건 대기한다(`docs/design/09-testing.md` 9.7).
    // 종료 처리 중 출력이 버려지는 결함이면 여기서 시간 초과로 실패한다.
    await waitFor(async () => (await tail(6)).some((r) => r === "1"), '"1" 출력 행(terminated 뒤)', 5000);
    // terminated 뒤에는 더 실행되지 않으므로 "2" 부재는 이 시점에 판정해도 된다.
    const t = await tail(6);
    if (t.some((r) => r === "2")) throw new Error(`"2"가 보인다(실행되면 안 된다) — ${show(t)}`);
    const terminatedCount = await page.locator('[data-testid="terminated"]').count();
    if (terminatedCount !== 1) throw new Error(`terminated Alert 개수 = ${terminatedCount}`);
  });
  await step("stop: 리셋 버튼으로 복구", async () => {
    await resetAndWait();
    const terminatedCount = await page.locator('[data-testid="terminated"]').count();
    if (terminatedCount !== 0) throw new Error("복구 뒤에도 terminated Alert가 보인다");
    await submit("1 + 1");
    const t = await tail(3);
    if (!t.some((r) => r === "2")) throw new Error(`복구 뒤 1 + 1 → 2가 안 보인다 — ${show(t)}`);
  });

  // ── block: 블록 입력 중(... ) 붙여넣기는 한 줄씩 흘려 넣는다 ──
  await step('block: for i in range(2): 뒤 "    print(i)\\n\\nprint(\'done\')" 붙여넣기 → 0·1·done', async () => {
    await type("for i in range(2):");
    await enter();
    await waitPrompt("...", 15000);
    await paste('    print(i)\n\nprint("done")');
    await enter();
    const t = await tailAfterPrompt(8);
    const joined = t.join("\n");
    if (!/(^|\n)0(\n|$)/.test(joined) || !/(^|\n)1(\n|$)/.test(joined) || !joined.includes("done")) {
      throw new Error(`마지막 행들 = ${show(t)}`);
    }
  });

  // ── shift: Shift+Enter로 줄바꿈 뒤 Enter 1회로 실행(RD-013 프리필 사용, 들여쓰기 직접 입력 없음) ──
  await step("shift: Shift+Enter 블록 → 0·1(Enter 1회)", async () => {
    await type("for i in range(2):");
    await press("Shift+Enter");
    await type("print(i)"); // 들여쓰기 직접 입력 없음 — 프리필이 채운다(RD-013)
    await enter();
    const t = await tailAfterPrompt(6);
    const joined = t.join("\n");
    if (!/(^|\n)0(\n|$)/.test(joined) || !/(^|\n)1(\n|$)/.test(joined)) {
      throw new Error(`마지막 행들 = ${show(t)}`);
    }
  });

  // ── recall: ↑ 재호출 뒤 Enter 1회로 재실행(편차 7) ──
  await step("recall: paste 절 def add…를 ↑ 1회로 재호출 → Enter 1회 → 3", async () => {
    await paste("def add(a, b):\n    return a + b\n\nprint(add(1, 2))");
    await enter();
    await waitPrompt(">>>", 15000);
    await press("ArrowUp");
    await waitFor(async () => {
      const all = await rows();
      const cur = await cursorRow();
      return cur >= 0 && (all[cur] ?? "").includes("print(add(1, 2))");
    }, "↑ 재호출로 블록 전체가 돌아옴", 5000);
    await enter();
    const t = await tailAfterPrompt(6);
    if (!t.some((r) => r === "3")) throw new Error(`마지막 행들 = ${show(t)}`);
  });

  // ── input: input() 대기 중 여러 줄 붙여넣기는 첫 줄만(편차 15, 관찰 기록 — 판정 아님) ──
  await step('input: input("x: ") 중 abc\\ndef 붙여넣기 → x: abc, 다음 프롬프트에 def 안 남음(관찰)', async () => {
    await type('input("x: ")');
    await enter();
    await typeWhenReading("a");
    const r = await paste("bc\ndef");
    await enter();
    const t = await tailAfterPrompt(6);
    h.notes["input: 관찰 결과"] = show(t);
    h.notes["input: paste route"] = r.usedFallback ? "fallback" : "실제 클립보드";
    // 판정 없이 기록만 한다.
  });

  const label = serverLabel(url);
  await h.finish({ label });
  return Object.values(h.checks).every(Boolean);
}

/** preview 화면에서 대표 3건(paste·tab·parse)만 돌리고 모든 확인이 통과했는지 돌려준다. */
async function runPreview(url) {
  const h = await open(url);
  const { rows, tail, waitPrompt, paste, enter, submit, step } = h;

  await step("초기: 첫 프롬프트", async () => waitPrompt(">>>"));
  await step("paste: def add… 붙여넣기 Enter 1회 → 3", async () => {
    await paste("def add(a, b):\n    return a + b\n\nprint(add(1, 2))");
    await enter();
    await waitPrompt(">>>", 15000);
    const t = await tail(6);
    if (!t.some((r) => r === "3")) throw new Error(`preview: 마지막 행들 = ${show(t)}`);
  });
  await step("tab: 붙여넣은 탭 보존 → 1", async () => {
    await paste("def f():\n\treturn 1\nprint(f())");
    await enter();
    await waitPrompt(">>>", 15000);
    const t = await tail(4);
    if (!t.some((r) => r === "1")) throw new Error(`preview: 마지막 행들 = ${show(t)}`);
  });
  await step("parse: 함수 밖 return은 무실행이다", async () => {
    await paste("print(1)\nreturn 2");
    await enter();
    await waitPrompt(">>>", 15000);
    const all = (await rows()).join("\n");
    if (!all.includes("'return' outside function")) {
      throw new Error("preview: 'return' outside function이 안 보인다");
    }
  });
  void submit;

  const label = serverLabel(url);
  await h.finish({ label });
  return Object.values(h.checks).every(Boolean);
}

const { url: devURL, previewUrl: previewURL } = checkEntry();

const ok = await runDevPreview({
  url: devURL,
  previewUrl: previewURL,
  run: (u, phase) => (phase === "dev" ? runDev(u) : runPreview(u)),
});
exitWith(ok);
