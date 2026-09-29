/**
 * 감시 타이머(03-ctrl-c.md 2.5).
 * JSPI로 정지한 대기(`run_sync`·`asyncio.run`·top-level await) 중에는 Python이 돌지 않는다. 폴링이 없다.
 * 이 타이머가 20ms 간격으로 버퍼를 엿보고, 정지한 대기가 있으면 `interruptIdle()`로 깨운다.
 *
 * 한 틱의 규칙:
 * - 엿보기: `hasPending()`이 거짓이면(SIGINT 없음) 아무것도 하지 않는다.
 * - 소비: `interruptIdle()`이 깨울 것을 찾았을 때만(참) `consume()`한다. 비교 교환 2→0이 성공할 때만 ack한다.
 * - 깨울 수 없고(거짓) `atPrompt()`가 거짓(실행 중)이면 SIGINT를 슬롯에 남긴다.
 *   재개한 사용자 스택의 폴링이 받는다. 다음 틱에 다시 시도한다.
 * - 프롬프트 유휴 폐기: 깨울 수 없고 `atPrompt()`가 참이면 대상 코드가 없는 낡은 눌림이다. 그 틱에서 버린다(`discard()`).
 *
 * 중지: 반환한 함수가 `clearInterval`한다.
 *
 * 이 파일은 `protocol/`을 import하지 않는다. 버퍼 대신 deps 클로저를 받는다(`boot.ts`가 넣는다).
 * 타이머는 요청 번호를 확인하지 않는다(알려진 한계).
 */
export interface InterruptWatchDeps {
  /** Python `interrupt_idle`. 정지한 실행을 깨웠으면 참(부른 쪽이 소비·ack한다). */
  interruptIdle(): boolean;

  /** 대상 Python 코드가 없는 구간인가. driver가 정한다(`WorkerDriverSession.atPrompt`). REPL은 `readLine` 응답 대기 중이다. */
  atPrompt(): boolean;

  /** SIGINT 슬롯이 전달 대기(2)인가 */
  hasPending(): boolean;

  /** 비교 교환(2→0)이 성공했을 때만 ack하고 true */
  consume(): boolean;

  /** 대상 코드가 없는 SIGINT를 지운다(2를 지웠을 때만 ack). */
  discard(): void;

  /** 틱 간격(ms). 기본 20. */
  tickMs?: number;
}

/** driver 실행 직전에 켠다. 실행이 끝나면(`exit()`) 반환한 함수를 불러 끈다. */
export function startInterruptWatch(deps: InterruptWatchDeps): () => void {
  const {
    interruptIdle,
    atPrompt,
    hasPending,
    consume,
    discard,
    tickMs = 20,
  } = deps;
  const timer = setInterval(() => {
    try {
      if (!hasPending()) return;
      if (interruptIdle()) {
        consume();
      } else if (atPrompt()) {
        discard();
      }
    } catch (error) {
      console.error("[interrupt-watch]", error);
    }
  }, tickMs);
  return () => {
    clearInterval(timer);
  };
}
