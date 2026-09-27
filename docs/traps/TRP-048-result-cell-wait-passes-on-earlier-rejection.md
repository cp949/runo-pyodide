# TRP-048 결과 칸을 "비어 있지 않을 때까지 대기"로 판정하면 앞선 거부(`busy`)가 남긴 값에 즉시 통과한다

- 상태: ACTIVE
- 적용 조건: `run()`의 결말을 마지막 결과 한 칸(`data-testid="result"`)에 덮어써 보여 주는 화면(`RunnerView`)을 e2e가 폴링할 때. 한 실행이 진행 중인 사이 다른 `run()`이 거부돼 같은 칸에 `{"rejected":"busy"}`를 쓰는 시나리오(실행 중 `run` 두 번째).

## 오해하기 쉬운 신호

- `waitResult`(비어 있지 않을 때까지)가 통과하고 실패 메시지가 "첫 run 결과 = {"rejected":"busy"}"라서 `stop`이 안 먹은 것처럼 보인다.
- 스크립트가 던진 뒤 다음 셀이 시작되는데 첫 run은 아직 실행 중이라 다음 셀의 상태 전제가 깨져 그 셀이 연쇄로 실패한 것처럼 보인다.

## 원인

- 결과 칸은 마지막 결과만 갖는다. 거부(`rejected`)와 첫 run의 결말(`kind`)이 같은 칸에 순서 없이 온다. 앱은 새 실행을 시작할 때 이전 결과를 지우지만 거부된 `run()`은 그 뒤에 자기 값을 쓴다.

## 탐지/회피

- 결말은 `kind` 필드가 생길 때까지 기다린다(`waitFor(… "kind" in JSON.parse(…))`, `apps/demo/e2e/checks/runner-check.mjs`의 R05). 셀 시작은 running·waiting-input이면 `stop`으로 끝낸 뒤 시작한다(`freshCell()`).
