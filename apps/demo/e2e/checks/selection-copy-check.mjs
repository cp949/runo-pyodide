// RD-017 브라우저 검증. 출처 RD-017에서 이관(RD-018).
// 시나리오 S01~S12를 그대로 자동화하고, Ctrl+Shift+C
// 변형(S03b)과 "새로고침 후 드래그 → 클립보드 불변" 확인을 S08b로 추가한다.
//
// "배너 행"(S02·S03·S04) 판단: 각 시나리오는 `h.clear()`로 화면을 지운 뒤 시작하므로, Ctrl+L 직후의
// 첫 행(row 0)이 항상 그 시나리오의 명령 에코 행이다 — S02는 `>>> while True: pass`, S03은
// `>>> abc`(입력 중이라 프롬프트와 같은 행), S04는 `>>> input("x: ")`. 이 row 0을 드래그 대상으로
// 쓴다(실측).
//
// 선택 해제 관찰: 계획서는 `.xterm-selection-layer`를 가정했으나 실제 xterm 6 DOM 렌더러는
// `.xterm-selection`(레이어 접미사 없음)을 쓴다(실측, xterm.mjs 소스 확인). `window.getSelection()`
// 대체안은 이 렌더러에서 쓸모가 없다(내부 폭 측정용 숨은 div를 가리키는 무관한 값을 돌려준다, 실측).
// 그래서 선택 해제는 `.xterm-selection`의 자식 개수로만 관찰한다.
//
// 사용: node selection-copy-check.mjs [devURL] [previewURL]
//   previewURL이 있으면 S01·S02·S05·S07(+초기)만 그 URL에서 재실행한다(RD-044 K6).
// ONLY=<ID,...>로 절을 거른다(양성 대조용): 초기,S01,S02,S03,S03b,S04,S05,S06,S07,S08,S08b,S09,S10,S11,S12
// 결과 파일 label은 url 포트 4173이면 preview, 그 밖은 dev(RD-018 결정과 같은 규칙).
// RD-018 갱신: 자기 results 경로 상수 + `writeFileSync`를 없애고 `lib.mjs`의 `finish({ label, ...})`로
// 통일했다(옛 `results/dev.json`·`results/preview.json` 직접 쓰기 제거). `ok`·`passed`·`total`·`failed`는
// `cells`(S01~S12, "초기" 제외) 기준 판정 로직을 그대로 `finish()`의 extra로 넘겨 덮어쓴다(판정 불변 —
// `finish()` 기본값은 "초기" 스텝까지 센다).
import {
  open,
  selectRows,
  dblclickCell,
  readClipboard,
  seedClipboard,
  setCopyOnSelect,
  toastText,
  show,
} from "../lib.mjs";
import { checkEntry, exitWith, runDevPreview, serverLabel } from "../check-runner.mjs";

async function run(url) {
  const h = await open(url);
  const { page } = h;

  const cells = [];
  /** 시나리오 하나(checklist 표의 한 행)를 실행하고 `{ id, pass, detail }`로 기록한다. */
  async function cell(id, label, fn) {
    const name = `${id} ${label}`;
    await h.step(name, fn);
    if (Object.prototype.hasOwnProperty.call(h.checks, name)) {
      cells.push({ id, pass: h.checks[name], detail: h.checks[name] ? "ok" : h.notes[name] });
    }
  }
  /** `.xterm-selection`의 자식 개수(선택 중이면 >0, 해제되면 0). 요소 자체가 없으면 -1(비정상). */
  const selectionChildCount = () =>
    page.evaluate(() => document.querySelector(".xterm-selection")?.children.length ?? -1);

  await h.step("초기 프롬프트 표시", async () => {
    await h.waitPrompt(">>>", 60000);
    await h.focus();
  });

  // ══════════════════ S01 드래그 선택 → 클립보드·토스트(표시 즉시, 소멸 2.8초 뒤 1회) ══════════════════
  await cell("S01", "드래그 선택 → 클립보드·토스트, 2.8초 뒤 소멸", async () => {
    await h.clear();
    await h.submit('print("hello world")');
    const rows = await h.trimmedRows();
    const rowIndex = rows.findIndex((r) => r === "hello world");
    if (rowIndex < 0) throw new Error(`hello world 행을 못 찾음: ${show(rows)}`);
    await seedClipboard(page, "seed");
    await selectRows(page, rowIndex, 0, rowIndex, 5);
    const text = await h.waitFor(
      async () => {
        const t = await readClipboard(page);
        return t === "hello" ? t : null;
      },
      "클립보드가 hello",
      3000,
    );
    if (text !== "hello") throw new Error(`클립보드 불일치: ${show(text)}`);
    const toast = await toastText(page);
    if (toast !== "copied 5 chars to clipboard") throw new Error(`토스트 불일치: ${show(toast)}`);
    // TRP-022: 표시 확인은 즉시, 소멸 확인은 1.5초보다 넉넉히(2.8초) 뒤 1회만.
    await page.waitForTimeout(2800);
    const gone = await toastText(page);
    if (gone !== null) throw new Error(`토스트가 소멸하지 않음: ${show(gone)}`);
  });

  // ══════════════════ S02 실행 중 배너 행 드래그 → Ctrl+C(복사·해제) → 300ms → Ctrl+C(중단) ══════════════════
  await cell("S02", "실행 중 배너 행 드래그 → Ctrl+C(복사) → 300ms → Ctrl+C(중단)", async () => {
    await h.clear();
    await h.startBlockLine("while True: pass");
    if ((await h.rows())[0] !== ">>> while True: pass") {
      throw new Error(`배너 행 불일치: ${show((await h.rows())[0])}`);
    }
    await seedClipboard(page, "seed");
    await selectRows(page, 0, 4, 0, 9); // ">>> while True: pass" cols 4..8 = "while"
    await h.ctrlC();
    const copied = await h.waitFor(
      async () => {
        const t = await readClipboard(page);
        return t === "while" ? t : null;
      },
      "클립보드가 while",
      3000,
    );
    if (copied !== "while") throw new Error(`1차 Ctrl+C 복사 실패: ${show(copied)}`);
    if ((await h.caretCount()) !== 0) throw new Error("1차 Ctrl+C 뒤 ^C가 나타남");
    if ((await h.trimmedRows()).length !== 2) {
      throw new Error(`1차 Ctrl+C 뒤 새 프롬프트가 이미 나타남: ${show(await h.trimmedRows())}`);
    }
    const selCount = await selectionChildCount();
    if (selCount !== 0) throw new Error(`선택이 해제되지 않음(.xterm-selection 자식 ${selCount})`);
    await page.waitForTimeout(300);
    await h.ctrlC();
    await h.waitPrompt(">>>", 15000);
    const tail = await h.tail(4);
    if (!(tail.includes("KeyboardInterrupt") && tail[tail.length - 1] === ">>>")) {
      throw new Error(`2차 Ctrl+C 뒤 중단 결과 불일치: ${show(tail)}`);
    }
  });

  // ══════════════════ S03 `>>> ` 타이핑 중 배너 행 드래그 → Ctrl+C(유지) → 이어 Ctrl+C(취소) ══════════════════
  await cell("S03", "입력줄 드래그 → Ctrl+C(유지) → 이어 Ctrl+C(RD-008 취소)", async () => {
    await h.clear();
    await h.type("abc");
    await seedClipboard(page, "seed");
    await selectRows(page, 0, 4, 0, 7); // ">>> abc" cols 4..6 = "abc"
    await h.ctrlC();
    await page.waitForTimeout(300);
    const row0 = (await h.rows())[0];
    if (row0 !== ">>> abc") throw new Error(`입력줄이 바뀜: ${show(row0)}`);
    if ((await h.caretCount()) !== 0) throw new Error("Ctrl+C 뒤 ^C가 나타남");
    if ((await h.trimmedRows()).length !== 1) {
      throw new Error(`새 프롬프트가 이미 나타남: ${show(await h.trimmedRows())}`);
    }
    const copied = await readClipboard(page);
    if (copied !== "abc") throw new Error(`클립보드 불일치: ${show(copied)}`);
    await h.ctrlC();
    await h.waitPrompt(">>>", 10000);
    const tail = await h.tail(3);
    if (!(tail[0] === ">>> abc" && tail[1] === "KeyboardInterrupt" && tail[2] === ">>>")) {
      throw new Error(`RD-008 취소 결과 불일치: ${show(tail)}`);
    }
  });

  // ══════════════════ S03b Ctrl+Shift+C 변형(같은 기대) ══════════════════
  await cell("S03b", "Ctrl+Shift+C 변형(같은 기대)", async () => {
    await h.clear();
    await h.type("xyz");
    await seedClipboard(page, "seed");
    await selectRows(page, 0, 4, 0, 7); // ">>> xyz" cols 4..6 = "xyz"
    await page.keyboard.press("Control+Shift+C");
    await page.waitForTimeout(300);
    const row0 = (await h.rows())[0];
    if (row0 !== ">>> xyz") throw new Error(`입력줄이 바뀜: ${show(row0)}`);
    if ((await h.caretCount()) !== 0) throw new Error("Ctrl+Shift+C 뒤 ^C가 나타남");
    if ((await h.trimmedRows()).length !== 1) {
      throw new Error(`새 프롬프트가 이미 나타남: ${show(await h.trimmedRows())}`);
    }
    const copied = await readClipboard(page);
    if (copied !== "xyz") throw new Error(`클립보드 불일치: ${show(copied)}`);
    await h.ctrlC();
    await h.waitPrompt(">>>", 10000);
  });

  // ══════════════════ S04 input() 대기 중 배너 행 드래그 → Ctrl+C(취소 없음) → hi Enter 정상 반환 ══════════════════
  await cell("S04", "input() 대기 중 드래그 → Ctrl+C(취소 없음) → 이어 hi Enter 정상 반환", async () => {
    await h.clear();
    await h.type('input("x: ")');
    await h.enter();
    await h.waitLastEndsWith("x:"); // rows()는 행 끝 공백을 자른다 — "x: "가 아니라 "x:"로 비교
    await seedClipboard(page, "seed");
    await selectRows(page, 0, 4, 0, 9); // '>>> input("x: ")' cols 4..8 = "input"
    await h.ctrlC();
    await page.waitForTimeout(300);
    const tail = await h.tail(2);
    if (!(tail[0] === '>>> input("x: ")' && tail[1] === "x:")) {
      throw new Error(`화면 불일치(취소 없음 기대): ${show(tail)}`);
    }
    if (/Traceback|KeyboardInterrupt/.test(tail.join(""))) throw new Error("트레이스백이 나타남(취소됨)");
    const copied = await readClipboard(page);
    if (copied !== "input") throw new Error(`클립보드 불일치: ${show(copied)}`);
    await h.typeWhenReading("hi");
    await h.enter();
    await h.waitPrompt(">>>");
    const finalTail = await h.tail(4);
    if (!(finalTail.includes("x: hi") && finalTail[finalTail.length - 1] === ">>>")) {
      throw new Error(`정상 반환 실패: ${show(finalTail)}`);
    }
  });

  // ══════════════════ S05 선택 없이 Ctrl+C → KeyboardInterrupt(RD-007 회귀) ══════════════════
  await cell("S05", "선택 없이 Ctrl+C → KeyboardInterrupt + 새 프롬프트(회귀)", async () => {
    await h.clear();
    await h.startBlockLine("while True: pass");
    await page.waitForTimeout(300);
    await h.ctrlC();
    await h.waitPrompt(">>>", 15000);
    const tail = await h.tail(5);
    const text = tail.join("");
    if (!/\^CTraceback[\s\S]*KeyboardInterrupt/.test(text)) {
      throw new Error(`회귀 실패: ${show(tail)}`);
    }
  });

  // ══════════════════ S06 더블클릭 단어 선택 → 클립보드 ══════════════════
  await cell("S06", "더블클릭 단어 선택 → 클립보드·토스트", async () => {
    await h.clear();
    await h.submit('print("a b")');
    const rows = await h.trimmedRows();
    const rowIndex = rows.findIndex((r) => r === "a b");
    if (rowIndex < 0) throw new Error(`a b 행을 못 찾음: ${show(rows)}`);
    await seedClipboard(page, "seed");
    await dblclickCell(page, rowIndex, 0);
    const text = await h.waitFor(
      async () => {
        const t = await readClipboard(page);
        return t === "a" ? t : null;
      },
      "클립보드가 a",
      3000,
    );
    if (text !== "a") throw new Error(`클립보드 불일치: ${show(text)}`);
    const toast = await toastText(page);
    if (toast === null) throw new Error("토스트가 뜨지 않음");
    // 다음 절(S07)이 "토스트가 뜨면 안 된다"를 단언하므로, 이 절의 토스트가 1초 자동 소멸 타이머로
    // 사라질 때까지 기다린 뒤 넘어간다(같은 종류의 경쟁을 실측으로 확인했다).
    await h.waitFor(async () => (await toastText(page)) === null, "S06 토스트 소멸", 2000);
  });

  // ══════════════════ S07 체크박스 해제 → 드래그 무복사, Ctrl+C는 복사 ══════════════════
  await cell("S07", "체크박스 해제 → 드래그 무복사·무토스트, Ctrl+C는 복사", async () => {
    await h.clear();
    await setCopyOnSelect(page, false);
    await h.submit('print("hello")');
    const rows = await h.trimmedRows();
    const rowIndex = rows.findIndex((r) => r === "hello");
    if (rowIndex < 0) throw new Error(`hello 행을 못 찾음: ${show(rows)}`);
    await seedClipboard(page, "seed");
    await selectRows(page, rowIndex, 0, rowIndex, 5);
    await page.waitForTimeout(300);
    const unchanged = await readClipboard(page);
    if (unchanged !== "seed") throw new Error(`체크박스 해제인데 클립보드가 바뀜: ${show(unchanged)}`);
    const toastAfterDrag = await toastText(page);
    if (toastAfterDrag !== null) throw new Error(`토스트가 뜨면 안 되는데 떴다: ${show(toastAfterDrag)}`);
    await h.ctrlC();
    const copied = await h.waitFor(
      async () => {
        const t = await readClipboard(page);
        return t === "hello" ? t : null;
      },
      "Ctrl+C 뒤 클립보드가 hello",
      3000,
    );
    if (copied !== "hello") throw new Error(`Ctrl+C 복사 실패: ${show(copied)}`);
    await setCopyOnSelect(page, true); // 다음 시나리오를 위해 원복
  });

  // ══════════════════ S08 localStorage 저장(양방향) ══════════════════
  await cell("S08", "체크박스 해제 → 새로고침 유지; 체크 → 새로고침 → 켜짐", async () => {
    await setCopyOnSelect(page, false);
    const stored = await page.evaluate(() => localStorage.getItem("runo-repl.copyOnSelect"));
    if (stored !== "0") throw new Error(`localStorage 값 불일치: ${show(stored)}`);
    await page.reload({ waitUntil: "load" });
    await h.waitPrompt(">>>");
    if (await page.locator('[data-testid="copy-on-select"]').isChecked()) {
      throw new Error("새로고침 뒤에도 켜져 있다");
    }
    await setCopyOnSelect(page, true);
    await page.reload({ waitUntil: "load" });
    await h.waitPrompt(">>>");
    if (!(await page.locator('[data-testid="copy-on-select"]').isChecked())) {
      throw new Error("새로고침 뒤에도 꺼져 있다");
    }
  });

  // ══════════════ S08b 새로고침 후 드래그 → 클립보드 불변 ══════════════
  await cell("S08b", "체크박스 해제 → 새로고침 → 드래그해도 클립보드 불변", async () => {
    await setCopyOnSelect(page, false);
    await page.reload({ waitUntil: "load" });
    await h.waitPrompt(">>>");
    await h.submit('print("stay")');
    const rows = await h.trimmedRows();
    const rowIndex = rows.findIndex((r) => r === "stay");
    if (rowIndex < 0) throw new Error(`stay 행을 못 찾음: ${show(rows)}`);
    await seedClipboard(page, "seed");
    await selectRows(page, rowIndex, 0, rowIndex, 4);
    await page.waitForTimeout(300);
    const unchanged = await readClipboard(page);
    if (unchanged !== "seed") throw new Error(`새로고침 뒤에도 클립보드가 바뀜: ${show(unchanged)}`);
    await setCopyOnSelect(page, true); // 다음 시나리오를 위해 원복
  });

  // ══════════════════ S09 두 행 출력(이모지) 드래그 → 클립보드·토스트(4자) ══════════════════
  await cell("S09", "두 행 출력(이모지) 드래그 → 클립보드·토스트(4자)", async () => {
    await h.clear();
    // 두 print를 한 줄(세미콜론)로 제출해야 두 출력 행이 바로 인접한다(중간에 두 번째 명령의 에코
    // 행이 끼지 않는다) — 실측.
    await h.submit('print("\u{1F600}x"); print("y")');
    const rows = await h.trimmedRows();
    const r1 = rows.findIndex((r) => r.includes("x") && !r.startsWith(">>>"));
    if (r1 < 0) throw new Error(`이모지 출력 행을 못 찾음: ${show(rows)}`);
    const r2 = r1 + 1;
    if (rows[r2] !== "y") throw new Error(`다음 행이 y가 아님: ${show(rows)}`);
    await seedClipboard(page, "seed");
    await selectRows(page, r1, 0, r2, 1);
    const text = await h.waitFor(
      async () => {
        const t = await readClipboard(page);
        return t !== "seed" ? t : null;
      },
      "클립보드 변경",
      3000,
    );
    if (text !== "\u{1F600}x\ny") throw new Error(`클립보드 불일치: ${show(text)}`);
    const toast = await toastText(page);
    if (toast !== "copied 4 chars to clipboard") throw new Error(`토스트 불일치: ${show(toast)}`);
  });

  // ══════════════════ S10 세션 리셋 뒤에도 복사 동작(핸들 수명) ══════════════════
  await cell("S10", "세션 리셋 뒤에도 드래그 복사 동작(핸들 수명)", async () => {
    await page.click('[data-testid="reset"]');
    await h.waitStatus(["loading"], "리셋: loading 상태");
    await h.waitStatus(["ready", "load-failed"], "리셋: ready 상태", 60000);
    if ((await h.statusText()) === "load-failed") throw new Error("리셋 뒤 load-failed");
    await h.focus();
    await h.waitPrompt(">>>", 30000);
    await h.submit('print("after reset")');
    const rows = await h.trimmedRows();
    const rowIndex = rows.findIndex((r) => r === "after reset");
    if (rowIndex < 0) throw new Error(`after reset 행을 못 찾음: ${show(rows)}`);
    await seedClipboard(page, "seed");
    await selectRows(page, rowIndex, 0, rowIndex, 5);
    const text = await h.waitFor(
      async () => {
        const t = await readClipboard(page);
        return t === "after" ? t : null;
      },
      "클립보드가 after",
      3000,
    );
    if (text !== "after") throw new Error(`클립보드 불일치: ${show(text)}`);
  });

  // ══════════════════ S11 터미널 밖 mouseup(endOutside) → document 리스너 경로 ══════════════════
  await cell("S11", "터미널 밖에서 mouseup(endOutside) → document 리스너로 복사", async () => {
    await h.clear();
    await h.submit('print("edge")');
    const rows = await h.trimmedRows();
    const rowIndex = rows.findIndex((r) => r === "edge");
    if (rowIndex < 0) throw new Error(`edge 행을 못 찾음: ${show(rows)}`);
    await seedClipboard(page, "seed");
    // endOutside는 열 좌표를 행 끝으로 clamp한다("edge"는 행 전체라 clamp와 무관하게 유효).
    await selectRows(page, rowIndex, 0, rowIndex, 4, { endOutside: true });
    const text = await h.waitFor(
      async () => {
        const t = await readClipboard(page);
        return t !== "seed" && t !== "" ? t : null;
      },
      "클립보드 변경",
      3000,
    );
    if (text !== "edge") throw new Error(`클립보드 불일치: ${show(text)}`);
  });

  // ══════════════════ S12 writeText 거부 → copy failed 토스트, pageerror 0 ══════════════════
  // 클립보드 함수를 이 페이지 컨텍스트에서 영구히 깨뜨리므로 반드시 마지막에 실행한다.
  await cell("S12", "writeText 거부 → copy failed 토스트, pageerror 0", async () => {
    await h.clear();
    await page.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.reject(new Error("주입된 실패"));
    });
    await h.submit('print("failcopy")');
    const rows = await h.trimmedRows();
    const rowIndex = rows.findIndex((r) => r === "failcopy");
    if (rowIndex < 0) throw new Error(`failcopy 행을 못 찾음: ${show(rows)}`);
    await selectRows(page, rowIndex, 0, rowIndex, 8);
    const toast = await h.waitFor(
      async () => {
        const t = await toastText(page);
        return t === "copy failed" ? t : null;
      },
      "토스트 copy failed",
      3000,
    );
    if (toast !== "copy failed") throw new Error(`토스트 불일치: ${show(toast)}`);
  });

  const label = serverLabel(url);
  return h.finish({
    label,
    ok: cells.every((c) => c.pass) && h.pageErrors.length === 0,
    passed: cells.filter((c) => c.pass).length,
    total: cells.length,
    failed: cells.filter((c) => !c.pass).map((c) => c.id),
    cells,
  });
}

const { url: devUrl, previewUrl } = checkEntry();

// preview는 S01·S02·S05·S07(+초기)만 돈다(계획, K6 선언 목록).
const ok = await runDevPreview({
  url: devUrl,
  previewUrl,
  run,
  previewSections: ["초기", "S01", "S02", "S05", "S07"],
});
exitWith(ok);
