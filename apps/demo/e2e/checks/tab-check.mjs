// RD-015(이름·속성 Tab 완성)와 RD-016(`import`/`from` 줄 모듈 완성)을 실제 브라우저로 검증한다.
// 규칙은 docs/design/07-tab-completion.md.
//
// 절 구성:
// - 초기: 프롬프트와 픽스처.
// - C1~C10: 삽입·목록·빈 스템 공백·커서 중간·여러 줄·왕복 경합·`input()`·후처리.
// - C11: 세션 리셋과 `exit()` 뒤 Tab.
// - C12: 왕복 지연 기록(판정은 정지 0뿐).
// - C13: Tab 큐.
// - C14: 완성 중 Ctrl+C(RD-021).
// - C15: `import`/`from` 줄 모듈 완성(RD-016).
//
// 실행 순서: 초기 → C1~C10 → C12 → C13 → C15 → C11 → C14. 번호순이 아니다.
// - 순서는 세션 상태가 정한다.
// - C12·C13은 초기 픽스처 `a`(클래스 `A`의 인스턴스)와 빈 입력줄이 필요하다.
// - C15는 픽스처가 만든 전역 `os`가 필요하다.
// - C11은 세션을 리셋해 픽스처를 지운다. 그래서 C15 뒤에 둔다.
// - C14는 자기 클래스 `G`를 새로 만든다. 리셋과 무관하게 독립이다.
//
// 기준 리터럴:
// - 목록 행(`a.attr_one  a.meth()    a.prop` 등)은 CPython 3.14 pty 측정값이다. 출처는 apps/demo/e2e/pty/rd-015/.
// - 모듈 후보는 개수·전체 목록을 단정하지 않는다(TRAP-27).
//
// 사용법·`ONLY`·결과 파일 이름은 apps/demo/e2e/README.md.
// - `ONLY`는 절 이름이 정확히 같을 때만 절을 켠다.
// - previewURL이 있으면 초기·C1·C3·C8·C11만 그 URL에서 다시 돈다(RD-044 K6).
import { open, hasFg, show } from "../lib.mjs";
import { checkEntry, currentOnly, exitWith, runDevPreview, sectionEnabled, serverLabel } from "../check-runner.mjs";

/**
 * 서버 하나(dev 또는 preview)에서 선택된 절을 위 순서로 실행하고 결과 JSON을 남긴다.
 * 초기 프롬프트와 픽스처는 `ONLY`와 무관하게 항상 실행한다.
 * 결과 파일 label은 `serverLabel(url)`이다. C12 지연 기록은 `finish`의 `c12` 필드로 실린다.
 */
async function run(url) {
  const h = await open(url);
  const {
    page, step, waitPrompt, waitStatus, statusText, type, press, enter, submit,
    rows, tail, lastLine, spansOf, focus, killLine, clear,
  } = h;

  // 절 필터. 절 이름이 정확히 같을 때만 켠다(`sectionEnabled`, 09-testing.md 9.6.5 K3).
  // - 접두어를 허용하면 "C1"이 "C11"~"C14"도 켠다(실측).
  // - 확인 하나의 필터는 `lib.mjs` `step()`의 접두어 검사가 한 번 더 건다.
  const enabled = (name) => sectionEnabled(currentOnly(), name);

  // 화면 읽기 도우미. `lib.mjs`의 `tail`·`trimmedRows`는 끝의 빈 줄만 자르고 중간 빈 줄을 보존한다.
  // 여기서는 빈 줄을 전부 거른다. 판정 리터럴이 이 기준으로 잰 값이기 때문이다.
  const nonEmpty = async () => (await rows()).filter((l) => l !== "");
  const tailRows = async (n) => (await nonEmpty()).slice(-n);
  const screenText = async () => (await rows()).join("\n").replace(/\s+$/, "");
  // 마지막 줄이 `expected`가 될 때까지 기다린다.
  // `rows()`가 각 행의 끝 공백을 자르므로 기대값의 끝 공백도 자른다(예: ">>> import ").
  async function waitLast(expected, timeoutMs = 3000) {
    const want = expected.replace(/\s+$/, "");
    await h.waitFor(async () => (await lastLine()) === want, `마지막 줄 === ${show(want)}(원문 ${show(expected)})`, timeoutMs, 10);
  }
  async function waitRow(predicate, desc, timeoutMs = 3000) {
    await h.waitFor(async () => (await rows()).some(predicate), desc, timeoutMs, 20);
  }
  // Ctrl+L로 화면을 비우고 프롬프트만 남긴다(각 절 앞).
  async function clearScreen() {
    await focus();
    await clear();
  }
  // Ctrl+U로 입력줄만 지운다(같은 절 안의 확인 사이).
  async function clearLine() {
    await killLine();
    await page.waitForTimeout(150);
  }
  const sleep = (ms) => page.waitForTimeout(ms);

  await step("초기 프롬프트 표시", async () => {
    await waitPrompt(">>>", 60000);
    await focus();
  });

  // 픽스처. 3.14 pty 측정(pty/rd-015/cases.json)과 같은 이름에 후처리 확인용 객체를 더한다.
  // C1~C10·C12·C13이 기대므로 `ONLY`와 무관하게 항상 준비한다.
  await step("초기 픽스처 준비", async () => {
    await submit("import os, warnings");
    await submit("x = [1, 2]");
    await submit(
      "A = type('A', (), {'attr_one': 1, '_priv': 2, 'meth': lambda self: 0, 'prop': property(lambda self: 1)})",
    );
    await submit("a = A()");
    await submit("printer = 1");
    await submit('warnings.simplefilter("always")');
    await submit(
      "exec(\"class W:\\n    def __dir__(self): return ['foo']\\n    def __getattr__(self, n):\\n        warnings.warn('careful'); return 1\")",
    );
    await submit("w = W()");
    await submit(
      "exec(\"class B:\\n    def __dir__(self): return ['foo']\\n    def __getattr__(self, n): raise ValueError('boom')\")",
    );
    await submit("b = B()");
    if ((await lastLine()).trim() !== ">>>") throw new Error(show(await lastLine()));
    await clearScreen();
  });

  // ═══════════════════════ C1 후보 1개는 즉시 삽입 ═══════════════════════
  if (enabled("C1")) {
    await step("C1a 후보 1개: impor Tab → import ", async () => {
      await type("impor");
      await press("Tab");
      await waitLast(">>> import ");
    });
    await step("C1b 후보 1개: os.path.exist Tab → os.path.exists(", async () => {
      await clearLine();
      await type("os.path.exist");
      await press("Tab");
      await waitLast(">>> os.path.exists(");
    });
    await clearLine();
  }

  // ═══════════════════════ C2 접두사만 채움 ═══════════════════════
  if (enabled("C2")) {
    await clearScreen();
    await step("C2a 접두사: os.getc Tab → os.getcwd", async () => {
      await type("os.getc");
      await press("Tab");
      await waitLast(">>> os.getcwd");
    });
    await step("C2a 보조 메시지([ not unique ]) 없음", async () => {
      if ((await screenText()).includes("not unique")) throw new Error(show(await tailRows(3)));
    });
    await clearLine();
    await step("C2b 스템 자체가 후보: os.path 무변화", async () => {
      await type("os.path");
      await press("Tab");
      await sleep(500);
      if ((await lastLine()) !== ">>> os.path") throw new Error(show(await lastLine()));
    });
    await step("C2b 첫 Tab은 목록을 내지 않는다", async () => {
      if ((await screenText()).includes("os.pathsep")) throw new Error(show(await tailRows(3)));
    });
    await clearLine();
  }

  // ═══════════════════════ C3 연속 두 번째 Tab: 열 우선 목록 + 입력줄 재그리기 ═══════════════════════
  if (enabled("C3")) {
    await clearScreen();
    await step("C3a 첫 Tab은 목록 없음(a.)", async () => {
      await type("a.");
      await press("Tab");
      await sleep(400);
      if ((await screenText()).includes("a.attr_one")) throw new Error(show(await tailRows(3)));
    });
    await step("C3a 목록이 3.14 pty와 같은 행(a.)", async () => {
      await press("Tab");
      await waitRow((l) => l === "a.attr_one  a.meth()    a.prop", "a. 목록 행");
    });
    await step("C3a 목록 아래 새 행에 입력줄 재그리기", async () => {
      // 목록 행이 보인 시점과 입력줄 재그리기가 끝나는 시점 사이에 짧은 창이 있다.
      // `printAbove`의 재그리기 콜백이 별도 마이크로태스크이기 때문이다(C7c 실측).
      // 즉시 비교하지 않고 기다린다.
      await waitLast(">>> a.");
    });
    await step("C3a 재그리기 뒤 커서 끝: 타이핑이 끝에 붙음", async () => {
      await type("t");
      await sleep(200);
      if ((await lastLine()) !== ">>> a.t") throw new Error(show(await lastLine()));
    });
    await clearLine();
    await sleep(200);

    await clearScreen();
    await step("C3b 목록이 3.14 pty와 같은 행(A.)", async () => {
      await type("A.");
      await press("Tab");
      await sleep(400);
      await press("Tab");
      await waitRow((l) => l === "A.attr_one  A.meth(     A.mro()     A.prop", "A. 목록 행");
    });
    await clearLine();

    await clearScreen();
    await step("C3c 첫 Tab이 공통 접두사 x.__class_ 까지 채움(pty와 같음)", async () => {
      await type("x.__cl");
      await press("Tab");
      await waitLast(">>> x.__class_");
    });
    await step("C3c 두 번째 Tab 목록이 3.14 pty와 같은 행(x.__cl)", async () => {
      await press("Tab");
      await waitRow((l) => l === "x.__class__(          x.__class_getitem__(", "x.__cl 목록 행");
    });
    await clearLine();

    // 커서가 줄 중간일 때 두 번째 Tab: 재그리기 뒤 커서가 원래 위치(a.|xyz)에 있어야 한다
    await clearScreen();
    await step("C3d 커서 중간 재그리기 입력줄", async () => {
      await type("a.xyz");
      for (let i = 0; i < 3; i++) await press("ArrowLeft");
      await press("Tab");
      await sleep(400);
      await press("Tab");
      await waitRow((l) => l === "a.attr_one  a.meth()    a.prop", "a. 목록 행(커서 중간)");
      await waitLast(">>> a.xyz");
    });
    await step("C3d 재그리기 뒤 커서 위치 유지(a.txyz)", async () => {
      // 커서가 줄 중간(a.|xyz)이라 타이핑한 글자로 줄이 끝나지 않는다.
      // `h.type()`의 자동 대기는 끝 문자 일치를 기다리므로 맞을 수 없다.
      // `sync: false`로 끄고 최종 문자열을 직접 기다린다.
      await type("t", { sync: false });
      await waitLast(">>> a.txyz");
    });
    await clearLine();

    // 후보 200개 초과
    await clearScreen();
    await step("C3e 200개 초과: ...N개 더", async () => {
      await type("os.");
      await press("Tab");
      await sleep(500);
      await press("Tab");
      await waitRow((l) => /^\.\.\.\d+개 더$/.test(l), "...N개 더", 5000);
    });
    await step("C3e 목록 아래 입력줄 재그리기", async () => {
      await waitLast(">>> os.");
    });
    await clearLine();

    // 사이에 다른 키가 끼면 첫 Tab 규칙으로 돌아간다
    await clearScreen();
    await step("C3f 사이에 다른 키가 끼면 목록 없음(첫 Tab 규칙)", async () => {
      await type("os.pa");
      await press("Tab");
      await sleep(400);
      await type("t");
      await press("Backspace");
      await sleep(100);
      await press("Tab");
      await sleep(600);
      if ((await screenText()).includes("os.pardir")) throw new Error(show(await tailRows(3)));
    });
    await step("C3f 이어서 연속 Tab이면 목록이 나온다", async () => {
      await press("Tab");
      await waitRow((l) => l.includes("os.pardir") && l.includes("os.path"), "os. 목록(재개)");
    });
    await clearLine();
  }

  // ═══════════════════════ C4 후보 없음은 무동작 ═══════════════════════
  if (enabled("C4")) {
    await clearScreen();
    await step("C4 후보 없음: 무변화", async () => {
      await type("os.zzzz");
      await press("Tab");
      await sleep(500);
      if ((await lastLine()) !== ">>> os.zzzz") throw new Error(show(await lastLine()));
    });
    await clearLine();
    await step("C4 무동작 뒤 REPL 계속 동작", async () => {
      await submit("1+1");
      if (!(await tailRows(3)).some((l) => l === "2")) throw new Error(show(await tailRows(3)));
    });
  }

  // ═══════════════════════ C5 스템이 빈 곳: 공백 4-(열%4)칸 ═══════════════════════
  if (enabled("C5")) {
    await clearScreen();
    await step("C5a 빈 줄: 4칸", async () => {
      await press("Tab");
      await type("x");
      await sleep(200);
      if ((await lastLine()) !== `>>> ${" ".repeat(4)}x`) throw new Error(show(await lastLine()));
    });
    await clearLine();
    await step("C5b 2칸 뒤: 2칸 더(모두 4칸)", async () => {
      await page.keyboard.type("  ");
      await sleep(150);
      await press("Tab");
      await type("x");
      await sleep(200);
      if ((await lastLine()) !== `>>> ${" ".repeat(4)}x`) throw new Error(show(await lastLine()));
    });
    await clearLine();
    await step("C5c x = 뒤: 4칸", async () => {
      await type("x = ");
      await press("Tab");
      await type("y");
      await sleep(200);
      if ((await lastLine()) !== `>>> x = ${" ".repeat(4)}y`) throw new Error(show(await lastLine()));
    });
    await clearLine();
    await step("C5d print( 뒤: 2칸", async () => {
      await type("print(");
      await press("Tab");
      await type("y");
      await sleep(200);
      if ((await lastLine()) !== `>>> print(${" ".repeat(2)}y`) throw new Error(show(await lastLine()));
    });
    await clearLine();
    await step("C5e important = 뒤 Tab 8연타(지연 0) → 32칸(게이트 참·빈 스템·왕복 + 큐)", async () => {
      await type("important = ");
      for (let i = 0; i < 8; i++) await press("Tab"); // 사이에 sleep 없음(지연 0)
      // 줄에 `import` 글자열이 있으면 빈 스템도 게이트가 참이라 worker 왕복을 한다(RD-016).
      // 그러면 8번의 Tab이 큐로 순서대로 처리된다.
      // 왕복이 끝나기 전에 `z`를 치면 남은 큐 Tab이 `z` 스템으로 재생돼 `zip(`이 붙는다(실측).
      // 커서 열이 프롬프트 16칸 + 32칸에 닿기를 기다린 뒤 `z`를 친다.
      await h.waitFor(
        async () =>
          (await page.evaluate(() => {
            const row = [...document.querySelectorAll(".xterm-rows > div")].find((r) => r.querySelector(".xterm-cursor"));
            if (!row) return -1;
            let col = 0;
            for (const child of row.childNodes) {
              if (child.nodeType === 1 && child.classList?.contains("xterm-cursor")) break;
              col += (child.textContent ?? "").length;
            }
            return col;
          })) === ">>> important = ".length + 32,
        "커서 열 = 프롬프트+`important = ` 16 + 32칸",
        10000,
        20,
      );
      await type("z");
      await waitLast(`>>> important = ${" ".repeat(32)}z`);
    });
    await clearLine();
  }

  // ═══════════════════════ C6 커서 중간(os.getc|xyz) ═══════════════════════
  if (enabled("C6")) {
    await clearScreen();
    await step("C6 커서 중간: os.getc|xyz Tab → os.getcwd|xyz", async () => {
      await type("os.getcxyz");
      for (let i = 0; i < 3; i++) await press("ArrowLeft");
      await press("Tab");
      await waitLast(">>> os.getcwdxyz");
    });
    await step("C6 삽입 뒤 커서 위치: 타이핑 이어짐", async () => {
      // 커서가 줄 중간(os.getcwd|xyz)이라 C3d와 같은 이유로 `sync: false`를 쓴다.
      await type("!", { sync: false });
      await waitLast(">>> os.getcwd!xyz");
    });
    await clearLine();
  }

  // ═══════════════════════ C7 여러 줄 버퍼와 `... ` 줄은 마지막 논리 줄만 스템 ═══════════════════════
  if (enabled("C7")) {
    await clearScreen();
    await step("C7a 여러 줄 버퍼(Shift+Enter) 마지막 줄 완성", async () => {
      await type("x = 1");
      await press("Shift+Enter");
      await type("os.getc");
      await press("Tab");
      await sleep(400);
      if (!(await lastLine()).endsWith("os.getcwd")) throw new Error(show(await tailRows(3)));
    });
    await clearLine();
    await press("Control+c");
    await waitPrompt(">>>");
    // 취소 직후 재그리기는 두 단계다: 즉시 프롬프트, KeyboardInterrupt 삽입, 프롬프트 재출력.
    // 그 사이의 짧은 창에 보낸 키는 새 읽기로 교체되며 버려질 수 있다(block-history-check.mjs `reset()`과 같은 이유, 실측).
    // RD-019 뒤에는 읽기 없는 구간의 키를 벤더가 쌓아 재생한다.
    // 그러나 이 재그리기 창(벤더 `offscreen`)의 키 처리는 바뀌지 않았다. 그래서 이 대기는 남긴다.
    await sleep(250);
    await step("C7b `... ` 줄 접두사 완성", async () => {
      await type("for i in range(2):");
      await enter();
      await waitPrompt("...");
      await type("os.getc");
      await press("Tab");
      await sleep(400);
      if ((await lastLine()) !== "...     os.getcwd") throw new Error(show(await lastLine()));
    });
    await clearLine();
    await step("C7c `... ` 줄 목록 뒤 프롬프트와 입력줄 재그리기", async () => {
      await type("    a.");
      await press("Tab");
      await sleep(400);
      await press("Tab");
      await waitRow((l) => l === "a.attr_one  a.meth()    a.prop", "a. 목록 행(... 줄)");
      await waitLast("...     a.");
    });
    await press("Control+c");
    await waitPrompt(">>>");
    await sleep(250);
    await step("C7d 블록 취소 뒤 REPL 계속 동작", async () => {
      await submit("1+1");
      if (!(await tailRows(3)).some((l) => l === "2")) throw new Error(show(await tailRows(3)));
    });
  }

  // ═══════════════════════ C8 왕복 중 경합 ═══════════════════════
  if (enabled("C8")) {
    await clearScreen();
    await step("C8a Tab→Enter 20회: 매번 프롬프트 복귀(정지 없음)", async () => {
      let plain = 0, completed = 0, hung = 0;
      for (let i = 0; i < 20; i++) {
        await type("os.getc");
        await press("Tab");
        await press("Enter");
        const ok = await Promise.race([
          waitPrompt(">>>", 15000).then(() => true),
          sleep(15000).then(() => false),
        ]);
        if (!ok) {
          hung++;
          break;
        }
        const txt = (await tailRows(4)).join("|");
        if (txt.includes("built-in function getcwd")) completed++;
        else if (txt.includes("AttributeError")) plain++;
      }
      console.log(`  C8a 완성된 줄 제출 ${completed}, 원문 제출 ${plain}, 정지 ${hung}`);
      if (hung !== 0 || completed + plain !== 20) throw new Error(`hung=${hung} completed=${completed} plain=${plain}`);
    });
    await step("C8a 경합 뒤 REPL 계속 동작", async () => {
      await submit("1+2");
      if (!(await tailRows(3)).some((l) => l === "3")) throw new Error(show(await tailRows(3)));
    });

    await step("C8b Tab 반영 뒤 Enter: 완성된 줄 제출", async () => {
      await type("os.getc");
      await press("Tab");
      await sleep(300);
      await press("Enter");
      await waitPrompt(">>>");
      if (!(await tailRows(3)).some((l) => l.includes("built-in function getcwd"))) {
        throw new Error(show(await tailRows(3)));
      }
    });

    await step("C8c Tab→Ctrl+C 20회: 프롬프트 복귀(정지 없음)", async () => {
      let stuck = 0;
      for (let i = 0; i < 20; i++) {
        await type("os.getc");
        await press("Tab");
        await press("Control+c");
        const ok = await Promise.race([
          waitPrompt(">>>", 15000).then(() => true),
          sleep(15000).then(() => false),
        ]);
        if (!ok) {
          stuck++;
          break;
        }
      }
      if (stuck !== 0) throw new Error(`정지 ${stuck}`);
    });
    await step("C8c 경합 뒤 REPL 계속 동작", async () => {
      await submit("2+2");
      if (!(await tailRows(3)).some((l) => l === "4")) throw new Error(show(await tailRows(3)));
    });

    await step("C8d Tab→글자: 입력 유지", async () => {
      await type("os.getc");
      await press("Tab");
      await type("x");
      await sleep(500);
      const l8 = await lastLine();
      if (l8 !== ">>> os.getcx" && l8 !== ">>> os.getcwdx") throw new Error(show(l8));
    });
    await clearLine();

    await step("C8e 두 번째 Tab 직후 x·Enter 10회: 제출됨(입력·Enter 소실/정지 없음)", async () => {
      let lost = 0;
      for (let i = 0; i < 10; i++) {
        await type("a.");
        await press("Tab");
        await sleep(300);
        await press("Tab");
        await press("x");
        await press("Enter");
        const ok = await Promise.race([
          waitPrompt(">>>", 15000).then(() => true),
          sleep(15000).then(() => false),
        ]);
        if (!ok) {
          lost++;
          break;
        }
        const tailTxt = (await tailRows(4)).join("|");
        if (!tailTxt.includes("AttributeError")) {
          lost++;
          console.log("  C8e 제출 결과 이상:", show(await tailRows(4)));
          break;
        }
      }
      if (lost !== 0) throw new Error(`이상 ${lost}`);
    });
    await step("C8e 뒤 REPL 계속 동작", async () => {
      await submit("5+5");
      if (!(await tailRows(3)).some((l) => l === "10")) throw new Error(show(await tailRows(3)));
    });
  }

  // ═══════════════════════ C9 input() 안 Tab은 무동작, from os import pa Tab은 모듈 완성 ═══════════════════════
  if (enabled("C9")) {
    await clearScreen();
    await step("C9a input() 안 Tab 무동작(\\t 없음)", async () => {
      await type('v = input("x: ")');
      await press("Enter");
      await sleep(500);
      await press("Tab");
      await type("abc");
      await press("Enter");
      await waitPrompt(">>>");
      await submit("repr(v)");
      if (!(await tailRows(3)).some((l) => l === `"'abc'"`)) throw new Error(show(await tailRows(3)));
    });
    await step("C9b input() 안 스템이 빈 곳의 Tab도 공백을 넣지 않음", async () => {
      await type('v = input("y: ")');
      await press("Enter");
      await sleep(500);
      await type("a = ");
      await press("Tab");
      await type("b");
      await press("Enter");
      await waitPrompt(">>>");
      await submit("repr(v)");
      if (!(await tailRows(3)).some((l) => l === `"'a = b'"`)) throw new Error(show(await tailRows(3)));
    });
    // 3.14는 `from os import pa`에서 `path`를 채운다(pty 대조 A02).
    // RD-015 시점에는 후보 없음을 전제로 무동작을 기대했으나 RD-016이 모듈 완성을 더하며 바뀌었다.
    // worker 왕복 뒤 삽입을 `waitLast`로 기다린다.
    await step("C9c from os import pa Tab → from os import path(모듈 완성)", async () => {
      await type("from os import pa");
      await press("Tab");
      await waitLast(">>> from os import path");
    });
    await clearLine();
  }

  // ═══════════════════════ C10 후처리: 정렬, 예외, 경고, 내부 이름 ═══════════════════════
  if (enabled("C10")) {
    await clearScreen();
    await step("C10a 이름 후보 전체 정렬(전역 printer보다 builtins print( 먼저)", async () => {
      await type("print");
      await press("Tab");
      await sleep(400);
      await press("Tab");
      await waitRow((l) => l === "print(   printer", "print 목록 행");
    });
    await clearLine();

    await clearScreen();
    await step("C10b 예외를 던지는 객체(b.): 후보 없음·무변화", async () => {
      await type("b.");
      await press("Tab");
      await sleep(600);
      if ((await lastLine()) !== ">>> b.") throw new Error(show(await lastLine()));
    });
    await clearLine();
    await step("C10b 뒤 REPL 계속 동작", async () => {
      await submit("1+1");
      if (!(await tailRows(3)).some((l) => l === "2")) throw new Error(show(await tailRows(3)));
    });
    await step("C10c 경고를 내는 객체(w.): 후보 삽입", async () => {
      await type("w.");
      await press("Tab");
      await waitLast(">>> w.foo");
    });
    await step("C10c 경고가 화면에 나오지 않음", async () => {
      if (/careful|UserWarning/.test(await screenText())) throw new Error(show(await tailRows(4)));
    });
    await clearLine();

    await clearScreen();
    await step("C10d 내부 이름(_pyodide*, ___*)이 목록에 없음", async () => {
      await type("_");
      await press("Tab");
      await sleep(400);
      await press("Tab");
      await waitRow((l) => l.includes("__name__"), "_ 목록 행");
      const listText = await screenText();
      if (listText.includes("_pyodide") || listText.includes("___EvalCode")) {
        throw new Error(show((await tailRows(8)).join(" / ")));
      }
    });
    await clearLine();
  }

  // ═══════════════════════ C12 왕복 지연(페이지 내부 시계) ═══════════════════════
  let c12Result = null;
  if (enabled("C12")) {
    const c12 = { attr: [], blank: [] };
    await clearScreen();
    // a. 속성 후보 다수. 첫 Tab은 무동작이지만 왕복은 있다. 먼저 정착시키고 두 번째 Tab(목록 반영)만 잰다.
    // 시각은 페이지 안 `performance.now()`로 잰다(TRP-022).
    for (let i = 0; i < 22; i++) {
      await type("a.");
      await press("Tab");
      await sleep(300);
      await page.evaluate(() => {
        window.__t0 = null;
        window.__lat = null;
        const target = document.querySelector(".xterm-rows");
        const onKey = (e) => {
          if (e.key === "Tab" && window.__t0 === null) {
            window.__t0 = performance.now();
            window.removeEventListener("keydown", onKey, true);
          }
        };
        window.addEventListener("keydown", onKey, true);
        const mo = new MutationObserver(() => {
          if (window.__lat !== null || window.__t0 === null) return;
          const txt = [...target.children].map((d) => d.textContent).join("\n");
          if (txt.includes("a.attr_one  a.meth()    a.prop")) {
            window.__lat = performance.now() - window.__t0;
            mo.disconnect();
          }
        });
        mo.observe(target, { subtree: true, childList: true, characterData: true });
        window.__mo = mo;
      });
      await press("Tab");
      await sleep(400);
      const lat = await page.evaluate(() => window.__lat);
      c12.attr.push(lat);
      await clearLine();
      await page.evaluate(() => window.__mo?.disconnect());
    }
    // 빈 스템 공백. 빈 줄의 첫 Tab은 왕복 없이 곧바로 동기 삽입한다. 그래서 그 Tab 자체를 잰다.
    // 삽입은 커서 x좌표 이동으로 감지한다.
    // 화면 텍스트는 끝 공백을 잘라 `characterData`만으로는 구분되지 않을 수 있다.
    for (let i = 0; i < 22; i++) {
      await page.evaluate(() => {
        window.__t0 = null;
        window.__lat = null;
        const cr = [...document.querySelectorAll(".xterm-rows > div")].findIndex((el) => el.querySelector(".xterm-cursor"));
        const row = document.querySelectorAll(".xterm-rows > div")[cr];
        const cursor = row?.querySelector(".xterm-cursor");
        const startX = cursor ? cursor.getBoundingClientRect().x : null;
        const onKey = (e) => {
          if (e.key === "Tab" && window.__t0 === null) {
            window.__t0 = performance.now();
            window.removeEventListener("keydown", onKey, true);
          }
        };
        window.addEventListener("keydown", onKey, true);
        const target = document.querySelector(".xterm-rows");
        const mo = new MutationObserver(() => {
          if (window.__lat !== null || window.__t0 === null) return;
          const nowRow = [...document.querySelectorAll(".xterm-rows > div")][cr];
          const nowCursor = nowRow?.querySelector(".xterm-cursor");
          const nowX = nowCursor ? nowCursor.getBoundingClientRect().x : null;
          if (nowX !== null && startX !== null && nowX !== startX) {
            window.__lat = performance.now() - window.__t0;
            mo.disconnect();
          }
        });
        mo.observe(target, { subtree: true, childList: true, characterData: true, attributes: true });
        window.__mo = mo;
      });
      await press("Tab");
      await sleep(300);
      const lat = await page.evaluate(() => window.__lat);
      c12.blank.push(lat);
      await clearLine();
      await page.evaluate(() => window.__mo?.disconnect());
    }
    // `import os.pa` Tab 한 번의 지연(RD-016). 경로는 게이트, worker `ZipStdlibModuleCompleter`, `os.path` 삽입이다.
    // 판정 없이 기록만 한다(9.7 6항, 결과 JSON `notes`·`c12.modulePa`).
    // 삽입은 행 텍스트가 `import os.path`를 포함하는 순간으로 감지한다.
    // 이 동작의 기능 판정은 C15a가 맡는다.
    // 응답이 안 오면 10초에서 포기하고 null로 남긴다(정지 감지용 timeout).
    c12.modulePa = [];
    for (let i = 0; i < 22; i++) {
      await type("import os.pa");
      await page.evaluate(() => {
        window.__t0 = null;
        window.__lat = null;
        const target = document.querySelector(".xterm-rows");
        const onKey = (e) => {
          if (e.key === "Tab" && window.__t0 === null) {
            window.__t0 = performance.now();
            window.removeEventListener("keydown", onKey, true);
          }
        };
        window.addEventListener("keydown", onKey, true);
        const mo = new MutationObserver(() => {
          if (window.__lat !== null || window.__t0 === null) return;
          const txt = [...target.children].map((d) => d.textContent).join("\n");
          if (txt.includes("import os.path")) {
            window.__lat = performance.now() - window.__t0;
            mo.disconnect();
          }
        });
        mo.observe(target, { subtree: true, childList: true, characterData: true });
        window.__mo = mo;
      });
      await press("Tab");
      const lat = await h
        .waitFor(async () => (await page.evaluate(() => window.__lat)) !== null, "import os.pa 삽입 지연 측정", 10000, 10)
        .then(() => page.evaluate(() => window.__lat))
        .catch(() => null);
      c12.modulePa.push(lat);
      await page.evaluate(() => window.__mo?.disconnect());
      await clearLine();
    }
    const warm = (arr) => arr.slice(2); // 세션 첫 Tab류 웜업 제외(22개 중 앞 2개를 버리고 20개를 남긴다)
    const attrWarm = warm(c12.attr).slice(0, 20);
    const blankWarm = warm(c12.blank).slice(0, 20);
    const stats = (arr) => {
      const nulls = arr.filter((v) => v === null).length;
      const sorted = arr.filter((v) => v !== null).sort((a, b) => a - b);
      const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
      const max = sorted.length ? sorted[sorted.length - 1] : null;
      return { nulls, median, max, sorted };
    };
    const attrStats = stats(attrWarm);
    const blankStats = stats(blankWarm);
    const modulePaStats = stats(warm(c12.modulePa).slice(0, 20));
    console.log("  C12 import os.pa 지연(ms):", modulePaStats.sorted.map((v) => v.toFixed(1)).join(" "));
    h.notes["C12 import os.pa 지연(기록, 웜 N=20, ms)"] =
      `중앙값 ${modulePaStats.median?.toFixed(1)} 최대 ${modulePaStats.max?.toFixed(1)} 미도착 ${modulePaStats.nulls}`;
    console.log("  C12 a. 속성 후보 지연(ms):", attrStats.sorted.map((v) => v.toFixed(1)).join(" "));
    console.log("  C12 빈 스템 지연(ms):", blankStats.sorted.map((v) => v.toFixed(1)).join(" "));
    await step("C12 정지 0(표본 20/20 확보, a.·빈 스템 둘 다)", async () => {
      if (attrStats.nulls !== 0 || blankStats.nulls !== 0) {
        throw new Error(`정지 a.=${attrStats.nulls} 빈스템=${blankStats.nulls}`);
      }
    });
    // 왕복 지연의 중앙값·최대는 판정이 아니라 기록이다(9.7 6항, 절대 ms 상한 금지). 정지 여부는 위 "정지 0" 판정이 맡는다.
    h.notes["C12 a. 속성 후보 지연(기록, 웜 N=20, ms)"] =
      `중앙값 ${attrStats.median?.toFixed(1)} 최대 ${attrStats.max?.toFixed(1)} 미도착 ${attrStats.nulls}`;
    h.notes["C12 빈 스템 지연(기록, 웜 N=20, ms)"] =
      `중앙값 ${blankStats.median?.toFixed(1)} 최대 ${blankStats.max?.toFixed(1)} 미도착 ${blankStats.nulls}`;
    c12Result = {
      attr: { median: attrStats.median, max: attrStats.max, samples: attrStats.sorted },
      blank: { median: blankStats.median, max: blankStats.max, samples: blankStats.sorted },
      modulePa: { median: modulePaStats.median, max: modulePaStats.max, nulls: modulePaStats.nulls, samples: modulePaStats.sorted },
    };
  }

  // ═══════════════════════ C13 큐: `a.` Tab 2연타(지연 0) → 왕복 1회 뒤 목록 1번 ═══════════════════════
  if (enabled("C13")) {
    await clearScreen();
    await step("C13 a. Tab 2연타(0ms) → 왕복 1회 뒤 목록이 정확히 1번 출력", async () => {
      await type("a.");
      await press("Tab");
      await press("Tab"); // 지연 없이 바로 두 번째 Tab. 왕복 중이라 큐에 쌓인다.
      await waitRow((l) => l === "a.attr_one  a.meth()    a.prop", "a. 목록 행(큐)", 5000);
      await sleep(300); // 큐가 잘못 배선돼 두 번째 목록이 더 나온다면 이 사이에 나타난다.
      const occurrences = (await rows()).filter((l) => l === "a.attr_one  a.meth()    a.prop").length;
      if (occurrences !== 1) throw new Error(`목록 행 출현 ${occurrences}회 ${show(await tail(8))}`);
      await waitLast(">>> a.");
    });
    await clearLine();
  }

  // ═══════════════════════ C15 import/from 줄 모듈 완성(RD-016) ═══════════════════════
  // 배선을 확인한다. 경로는 main 게이트(`mentionsImportKeyword`·`planTab`), worker `complete_source` 모듈 분기, 삽입·목록·큐다.
  // 정확성(3.14 pty 대조)은 L0 시험 `module-completion-parity.test.ts`가 맡는다.
  // 판정은 `waitLast`·`waitFor`만 쓴다(9.7).
  if (enabled("C15")) {
    await clearScreen();
    await step("C15a import os.pa Tab → import os.path", async () => {
      await type("import os.pa");
      await press("Tab");
      await waitLast(">>> import os.path");
    });
    await clearLine();
    await step("C15b import collections.a Tab → import collections.abc(브라우저 번들 zip 보정)", async () => {
      await type("import collections.a");
      await press("Tab");
      await waitLast(">>> import collections.abc");
    });
    await clearLine();
    await step("C15c import xml.dom.m Tab → import xml.dom.mini(공통 접두까지)", async () => {
      await type("import xml.dom.m");
      await press("Tab");
      await waitLast(">>> import xml.dom.mini");
    });
    await clearLine();
    await clearScreen();
    await step("C15d import Tab 두 번 → 모듈 목록 출력, 목록 뒤 프롬프트 >>> import ", async () => {
      await type("import ");
      await press("Tab");
      await press("Tab");
      // 목록이 다 그려진 신호는 둘이다.
      // - 열 행이 있다(공백 2칸 이상으로 갈린 여러 단어, 프롬프트 행 제외).
      // - 프롬프트 행이 목록 뒤에 다시 그려졌다.
      await h.waitFor(
        async () => {
          const r = await rows();
          const hasList = r.some((l) => !l.startsWith(">>>") && /\S {2,}\S/.test(l));
          return hasList && (await lastLine()) === ">>> import";
        },
        "import 목록 행 + 목록 뒤 프롬프트 >>> import",
        10000,
        20,
      );
    });
    await step("C15d 목록에 os·sys 포함(개수 단정 없음)", async () => {
      // 모듈이 178개 안팎이라 목록이 한 화면을 넘는다. 위쪽은 스크롤백으로 밀린다.
      // 개수는 단정하지 않는다(TRAP-27).
      // Shift+PageUp으로 올라가며 본 단어 집합에 os·sys가 있는지만 본다.
      // 화면이 안 바뀌면 맨 위에 닿은 것이다.
      const seen = new Set();
      const collect = async () => {
        for (const l of await rows()) for (const w of l.split(/\s+/)) if (w) seen.add(w);
      };
      await collect();
      for (let i = 0; i < 8 && !(seen.has("os") && seen.has("sys")); i++) {
        const before = (await rows()).join("\n");
        await press("Shift+PageUp");
        const moved = await h
          .waitFor(async () => (await rows()).join("\n") !== before, "Shift+PageUp 뒤 화면 갱신", 1500, 20)
          .then(
            () => true,
            () => false,
          );
        if (!moved) break;
        await collect();
      }
      if (!seen.has("os") || !seen.has("sys")) {
        throw new Error(`목록에 os·sys 없음(단어 ${seen.size}개, os=${seen.has("os")} sys=${seen.has("sys")})`);
      }
      // 입력이 들어가면 xterm이 맨 아래로 돌아온다.
      await clearLine();
      await waitLast(">>>");
    });
    // C15d가 실패해 입력줄에 `import `가 남아도 다음 clearScreen이 막히지 않게 한다.
    // 통과했으면 빈 줄에 Ctrl+U라 무해하다.
    await clearLine();
    await clearScreen();
    // pending 경로. 블록 안 줄(`if True:` 뒤 `...` 프롬프트)에서 `pending`이 worker로 간다.
    // worker는 `pending + "\n" + source`로 판정한다.
    // 자동 들여쓰기(RD-013)가 `...` 뒤 4칸을 프리필하므로 본문만 입력한다(C14와 같다).
    await step("C15e if True: 블록 안 import os.pa Tab → ...     import os.path(pending 경로)", async () => {
      await type("if True:");
      await enter();
      await waitPrompt("...");
      await type("import os.pa");
      await press("Tab");
      await waitLast("...     import os.path");
    });
    await step("C15e 블록을 빈 줄로 닫으면 >>> 복귀(import os.path 실행)", async () => {
      await enter();
      await waitPrompt("...");
      await enter();
      await waitPrompt(">>>");
    });
    await clearScreen();
    // 전역 `os`는 픽스처 `import os, warnings`가 만든다. 줄 안의 `import os;`는 Tab 시점에 실행 전이다.
    // 모듈 판정이 None이라 RD-015 속성 완성으로 폴백한다.
    // `os.pa*` 후보의 공통 접두가 `os.pa`라 채움이 없고, 두 번째 Tab이 목록을 낸다.
    await step("C15f import os; os.pa Tab 두 번 → 속성 후보 목록(os.path·os.pathsep 포함, None 폴백)", async () => {
      await type("import os; os.pa");
      await press("Tab");
      await press("Tab");
      await h.waitFor(
        async () => {
          const r = await rows();
          return r.some((l) => /(^|\s)os\.path(\s|$)/.test(l)) && r.some((l) => /(^|\s)os\.pathsep(\s|$)/.test(l));
        },
        "속성 후보 목록 행(os.path·os.pathsep)",
        10000,
        20,
      );
      await waitLast(">>> import os; os.pa");
    });
    await clearLine();
  }

  // ═══════════════════════ C11 세션 리셋과 exit() 뒤의 Tab ═══════════════════════
  // 리셋 버튼을 눌러 새 세션의 첫 프롬프트까지 기다린다. 끝은 안내 줄 개수가 아니라 status로 판정한다(TRP-024).
  async function resetSession() {
    await page.click('[data-testid="reset"]');
    await waitStatus(["loading"], "리셋: loading 상태");
    await waitStatus(["ready", "load-failed"], "리셋: ready 상태", 60000);
    if ((await statusText()) === "load-failed") throw new Error("리셋 뒤 load-failed");
    await focus();
    await waitPrompt(">>>", 60000);
  }
  if (enabled("C11")) {
    await clearScreen();
    await step("C11a 세션 리셋 뒤 프롬프트 복귀 + 리셋한 새 세션에서 Tab 동작", async () => {
      await resetSession();
      await type("impor");
      await press("Tab");
      await waitLast(">>> import ");
    });
    await clearLine();
    // 새 세션 `globals()`에 `sys`가 없어야 한다(docs/design/10-parity-deviations.md 편차 22 해소).
    // `submit()`이 새 프롬프트를 기다린 뒤 읽으므로 출력 행은 이미 그려져 있다(고정 대기·ms 상한 없음, 9.7).
    await step("C11a 새 세션 \"sys\" in globals()가 False(편차 22 해소)", async () => {
      await submit('"sys" in globals()');
      const observed = (await tailRows(2))[0];
      if (observed !== "False") throw new Error(`"sys" in globals() 출력 ${show(observed)}(기대 "False")`);
    });
    await step("C11a 새 세션에서 삽입이 한 번만 적용", async () => {
      await submit("import os");
      await type("os.getc");
      await press("Tab");
      await waitLast(">>> os.getcwd");
    });
    await clearLine();
    await step("C11b exit() 뒤 Tab 무동작·입력 무반응(세션 종료)", async () => {
      await type("exit()");
      await press("Enter");
      await sleep(1500);
      // 세션 종료 뒤에는 활성 읽기가 없어 키가 에코되지 않는다.
      // 벤더가 키를 쌓아 두었다가 리셋이 폐기한다(RD-019).
      // `h.type()`은 에코를 기다리므로 쓰지 않고 `page.keyboard.type`을 직접 쓴다(대기 없음).
      await page.keyboard.type("os.pa");
      await press("Tab");
      await sleep(600);
      if ((await screenText()).includes("os.pardir")) throw new Error(show(await tailRows(3)));
    });
    await step("C11c exit() 뒤 리셋한 세션에서 Tab 동작", async () => {
      await resetSession();
      await type("impor");
      await press("Tab");
      await waitLast(">>> import ");
    });
    await clearLine();
    await submit("import os");
  }

  // ═══════════════════════ C14 완성 중 Ctrl+C(RD-021) ═══════════════════════
  if (enabled("C14")) {
    await clearScreen();
    await step("C14 초기 __getattr__ 무한 루프 클래스 준비(REPL 직접 멀티라인 타이핑)", async () => {
      // `exec()`로 정의하면 컴파일 파일명이 "<string>"이 된다.
      // 그러면 packages/pyodide-core/src/worker/sigint-handler.py의 매칭에 걸리지 않는다.
      // 이 파일은 `co_filename == console.filename`("<console>")인 프레임을 사용자 코드로 본다.
      // REPL 프롬프트에 직접 멀티라인으로 타이핑하면 "<console>" 프레임이 되어 규칙이 매치된다.
      // 자동 들여쓰기(RD-013)가 다음 줄 들여쓰기를 프리필하므로 각 줄은 본문 텍스트만 입력한다.
      await type("class G:");
      await enter();
      await waitPrompt("...");
      await type("def __getattr__(self, n):");
      await enter();
      await waitPrompt("...");
      await type("while True: pass");
      await enter();
      await waitPrompt("...");
      await enter(); // 빈 줄로 블록 닫기 → 클래스 정의 실행
      await waitPrompt(">>>");
      await submit("a = G()");
      if ((await lastLine()).trim() !== ">>>") throw new Error(show(await lastLine()));
    });
    for (let i = 0; i < 5; i++) {
      await step(`C14 반복 ${i + 1}/5: Tab 뒤 500ms Ctrl+C → 3초 안에 KeyboardInterrupt + >>> 복귀`, async () => {
        // 이전 반복의 취소 재그리기(두 단계)가 끝난 직후일 수 있다. C7b·C7d와 같은 이유로 정착을 기다린다.
        await sleep(250);
        await killLine();
        // 스템은 "a.x"가 아니라 끝에 점이 붙은 "a.x."여야 한다.
        // 완성기가 a.x를 평가해 `__getattr__`를 부르는 것은 후자뿐이다(RD-021 `t.foo.`와 같은 이유).
        // "a.x"는 `dir(a)`만으로 후보를 내 `__getattr__`를 부르지 않아 무한 루프에 걸리지 않았다(실측).
        await type("a.x.");
        await press("Tab");
        await sleep(500);
        await press("Control+c");
        await h.waitFor(
          async () => {
            const last = (await lastLine()).trim();
            return last.endsWith(">>>") && (await screenText()).includes("KeyboardInterrupt");
          },
          "KeyboardInterrupt + >>> 복귀",
          3000,
          20,
        );
      });
    }
    await step("C14 KeyboardInterrupt 행이 빨간색이다", async () => {
      const spans = await spansOf("KeyboardInterrupt");
      if (!spans.some((s) => hasFg(s.cls, 1))) throw new Error(show(spans));
    });
    await step("C14 리셋 알림 없음(status가 ready 유지, terminated/crashed 없음)", async () => {
      const st = await statusText();
      if (st !== "ready") throw new Error(`status=${st}`);
      if (await page.locator('[data-testid="terminated"]').isVisible().catch(() => false)) {
        throw new Error("terminated 알림이 보인다");
      }
      if (await page.locator('[data-testid="crashed"]').isVisible().catch(() => false)) {
        throw new Error("crashed 알림이 보인다");
      }
    });
    await step("C14 뒤 세션 생존(1+1 → 2)", async () => {
      await submit("1+1");
      if (!(await tailRows(3)).some((l) => l === "2")) throw new Error(show(await tailRows(3)));
    });
  }

  const label = serverLabel(url);
  return h.finish({ label, c12: c12Result });
}

const { url: devUrl, previewUrl } = checkEntry();

// preview는 아래 절만 돈다. 사용자 `ONLY`가 있으면 이 목록과의 교집합만 돈다(RD-044 K6).
const ok = await runDevPreview({
  url: devUrl,
  previewUrl,
  run,
  previewSections: ["초기", "C1", "C3", "C8", "C11"],
});
exitWith(ok);
