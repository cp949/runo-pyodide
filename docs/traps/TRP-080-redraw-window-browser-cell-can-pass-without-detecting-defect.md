# TRP-080 재그리기 대기 창 결함의 브라우저 셀은 결함이 없는 코드에서만 통과하는지 확인하지 않으면 검출력이 없다

- 상태: ACTIVE
- 적용 조건: 재그리기 대기 중(`printAboveRaw`·`printAbove`의 write 콜백 전) 일어나는 결함(리사이즈·키·취소)을 브라우저 e2e 셀로 확인할 때, `apps/demo/e2e/checks/bg-output-check.mjs`의 `FIT=1` 셀(B09)을 완료 근거로 인용할 때.

## 오해하기 쉬운 신호

- B09(`FIT=1`)는 통과한다. 그러나 결함 있는 코드(`onResize`가 재그리기 대기 중에도 `refresh()`를 부르던 것)에서도 통과했다(양성 대조 미검출). 통과 로그만 보면 결함이 없다고 읽는다.
- 같은 결함이 jsdom `StubTerminal` 시험에서는 결정적으로 재현되고 가드를 지우는 변이가 죽는다.

## 원인

- 실제 xterm에서는 `onResize`가 그린 `refresh()` 출력이 쓰기 큐에서 write 콜백(`finishRedraw`의 앵커 읽기)보다 뒤에 놓여 같은 자리에 겹쳐 그려질 수 있어 흔적이 눈에 남지 않을 수 있다(추정, 미검증).
- 셀이 만든 창 크기 변경이 재그리기 대기 창에 들었는지 셀이 기록하지 않아 창에 들지 않은 통과와 결함이 없는 통과를 구분할 수 없다. 창 크기 변경은 `ResizeObserver` → `requestAnimationFrame` → `fit()`이라 write 콜백보다 수십 ms 늦을 수 있다.

## 탐지/회피

- 브라우저 셀은 결함 있는 코드에서 실패하는지(양성 대조)를 먼저 확인하고, 통과하면 기준선(`apps/demo/e2e/BASELINE.md`) 기대에 넣지 않는다. B09는 이 이유로 기대에서 뺐다.
- 결함 10의 판정은 jsdom 시험(벤더 `print-above-raw.test.ts`·`take-read.test.ts`의 재그리기 대기 중 리사이즈)이 한다.
- 브라우저 재현을 다시 시도하려면 write 콜백 시점과 `onResize` 시점을 페이지 안에 기록해 순서를 판정한다. 그 전에는 셀을 완료 근거로 세지 않는다.
