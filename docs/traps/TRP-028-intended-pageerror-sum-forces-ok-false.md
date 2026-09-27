# TRP-028 스크립트 자신의 "forced pageerror 1건만" 확인이 통과해도, 순진한 합산은 `ok`를 항상 거짓으로 만든다

- 상태: ACTIVE
- 적용 조건: 여러 확인 스크립트의 결과 JSON을 모아 하나의 `summary.json`/`ok`로 합산하는 실행기를
  만들 때(`apps/demo/e2e/run.mjs`류), 그중 일부 스크립트가 "의도적으로 만든 pageerror 1건만 있고
  나머지는 0"을 스스로 검증해 PASS하는 구조를 가질 때.

## 오해하기 쉬운 신호

개별 확인 스크립트가 강제로 `pageerror`를 1건 일으키고, 그 스크립트 **자신의** "forced 1건만, 나머지
0" 확인이 PASS로 통과시킨다(`data.passed === data.total`, `data.failed` 배열도 비어 있다). 그런데
실행기가 모든 결과 파일의 `pageErrors`(raw 배열) 길이를 그냥 더해 총계를 만들면, 이 의도된 건수가 그대로
합산돼 총계가 0이 아니게 된다. 개별 스크립트는 전부 `passed/total` 만점이고 `failed` 목록도 비어 있어서
"뭔가 실패했다"는 신호가 어디에도 안 보이는데, 최상위 `ok`만 거짓이 된다 — 원인을 모르면 "실패 0건인데
왜 `ok: false`?"로 오래 헤매기 쉽다.

## 원인

실행기의 합산 로직이 "스크립트 자신의 판정(의도된 예외를 이미 걸러냄)"과 "raw 이벤트 개수(그 예외를
그대로 포함)"를 구분하지 않고 후자만 본다. 개별 스크립트 설계자는 "내 pageerror는 의도된 것"이라고 자기
파일 안에서만 처리했지, 그 사실을 상위 집계기에 전달할 방법(예: 필드 하나)을 남기지 않았다.

## 탐지/회피

- 집계기가 raw `pageErrors` 배열 길이를 그냥 더하지 말고, 어떤 파일이 몇 건의 "의도된" pageerror를 낼
  수 있는지 알고 있는 목록(`apps/demo/e2e/baseline.json`의 `expectedPageErrors: [{ file, count }]`)과
  대조해 그 개수만큼 빼고 합산한다(그 이상 나오면 초과분은 그대로 집계돼 회귀를 계속 잡는다) —
  `apps/demo/e2e/run.mjs`의 `writeSummary()`가 이 방식이다.
- 새 확인 스크립트를 baseline 세트에 추가하면서 "의도된 pageerror" 절이 있으면, 그 사실을
  `baseline.json`의 `expectedPageErrors`에 곧바로 등록해야 한다 — 스크립트 자신의 `notes`/`checks`만
  보고 "이 스크립트는 통과했으니 상위 집계도 당연히 통과겠지"라고 넘겨짚지 않는다.
- 결과 JSON이 표준 `finish()` 포맷(top-level `passed`/`total`/`ok`/`failed`/`pageErrors` 배열)을 따르지
  않는 스크립트(예: `measure/boot-press.mjs`의 `{ summary, results }` 커스텀 포맷)를 baseline 세트에 새로
  넣을 때도 같은 함정이 있다 — 집계기가 그 포맷을 알아서 해석하는 분기가 없으면 `passed/total`이
  `undefined`로 나오고 `failed` 판정에서 빠져 실제 실패를 놓친다.
