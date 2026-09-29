// RD-006 브라우저 확인: 프롬프트 대기 중 배경 콜백이 input()을 부르면 REPL 줄 → 배경 input 줄 → 콜백 출력 → REPL 줄 실행 순서로 진행하고
// 이어서 REPL이 멈추지 않는다. 출처 RD-006에서 이관(RD-018). 이전 구현 RD-021의
// `bg-input-guard-probe.mjs` 프로브를 하니스 lib.mjs로 옮겼다.
// 가드(`terminal/read-guard.ts`)가 없으면 배경 input()이 REPL 읽기를 교체해 REPL 읽기가 고아가 되고, 사용자가 친 `x = 41`이 stdin 값이
// 되어 `bg-got x = 41`이 나오며 이후 REPL 프롬프트가 돌아오지 않는다(시간 초과로 FAIL).
// RD-022b(사용자 확정 선택지 C): REPL 읽기 중 배경 `input()`의 프롬프트 `bg> `는 REPL 줄 접두로 그려졌다가 곧이은 `readInput`
// 알림에서 떼어져 stdin 프롬프트로 넘어간다. 화면에 `bg>`가 보이는 순간이 사실상 없으므로, 중간 대기를
// "화면에 `bg>` 행"에서 "main이 `readInput` 알림을 처리함"(`installRpcTap`, 이벤트 신호 — 9.7)으로 바꿨다. 최종 판정 `ORDER`와
// `x = 41` Enter 뒤 `waitLastEndsWith("bg>")`는 그대로다.
// 사용: node bg-input-guard-probe.mjs <url>(생략 시 http://localhost:5173)
// 결과 파일 label은 url 포트 4173이면 preview, 그 밖은 dev(RD-018 결정).
import { checkEntry, exitWith, serverLabel } from "../check-runner.mjs";
import { installRpcTap, open, rpcNoticeCount, show } from "../lib.mjs";

const { url } = checkEntry();
const label = serverLabel(url);

const h = await open(url, { before: installRpcTap });
const { step, waitPrompt, waitLastEndsWith, waitFor, clear, type, enter, rows, tail, typeWhenReading, settled, focus } = h;

/** REPL 프롬프트에서 문장을 실행하고 다음 프롬프트까지 기다린다. */
async function run(code) {
  await type(code);
  await enter();
  await waitPrompt(">>>");
}
const snap = async (title) => console.log(`관찰  ${title}:`, show(await tail(8)));

await step("초기: 프롬프트가 뜬다", async () => {
  await waitPrompt(">>>", 60000);
  await focus();
});

// 이전 판정 정규식과 같다.
const ORDER = />>> x = 41[\s\S]*hello[\s\S]*bg-got hello[\s\S]*>>> x\n41[\s\S]*>>> 1\+1\n2/;

await step("배경 input(): REPL 줄 → 배경 input 줄 → 콜백 출력 → REPL 줄 실행 순서이고 이어서 x → 41, 1+1 → 2", async () => {
  await clear();
  await run("import asyncio");
  const readInputsBefore = await rpcNoticeCount(h.page, "readInput");
  // 문장이 80칸을 넘어 다음 행으로 감기므로 커서 행 끝 글자 대기를 끄고(sync: false) 화면 안정으로 기다린다.
  await type("asyncio.get_event_loop().call_later(1, lambda: print('bg-got', input('bg> ')))", { sync: false });
  await settled();
  await enter();
  await waitPrompt(">>>");
  // 1초 뒤 콜백이 input()을 부른다. 선택지 C에서는 `bg> `가 REPL 줄에서 곧바로 떼어져 화면 신호가 없으므로, main이 그 `readInput`
  // 알림을 처리한 것(read-guard가 미뤄 두고 접두를 꼬리로 옮김)을 기다린다. timeout은 정지 감지용이다(판정선이 아니다).
  await waitFor(
    async () => (await rpcNoticeCount(h.page, "readInput")) > readInputsBefore,
    "배경 input()의 readInput 알림을 main이 처리함",
    15000,
  );
  await settled();
  await snap("콜백이 input()을 부른 뒤(REPL 읽기 활성, 입력 없음: 선택지 C라 bg>는 REPL 줄에 남지 않는다)");

  // 사용자가 REPL 줄을 친다. 이 줄은 REPL 읽기가 받고, 그 뒤에 배경 input 읽기가 시작돼야 한다.
  await type("x = 41");
  await enter();
  await waitLastEndsWith("bg>");
  await settled(150);
  await snap("REPL 줄 x = 41 Enter 뒤(배경 input 읽기가 시작됐다)");

  await typeWhenReading("hello");
  await enter();
  await waitPrompt(">>>");
  await snap("hello Enter 뒤(콜백 출력, 이어서 REPL 줄 x = 41 실행)");

  await run("x");
  await run("1+1");
  await snap("x, 1+1 Enter 뒤(REPL이 살아 있으면 41, 2가 나온다)");
  const text = (await rows()).join("\n");
  if (!ORDER.test(text)) throw new Error(`순서 불일치 ${show(await tail(14))}`);
});

await step("콘솔 경고·오류·pageerror가 없다", async () => {
  if (h.problemLogs().length > 0 || h.pageErrors.length > 0) {
    throw new Error(JSON.stringify({ problemLogs: h.problemLogs(), pageErrors: h.pageErrors }));
  }
});

// SHOT=경로 를 주면 마지막 화면을 저장한다.
if (process.env.SHOT) await h.page.screenshot({ path: process.env.SHOT });
const ok = await h.finish({ label });
exitWith(ok);
