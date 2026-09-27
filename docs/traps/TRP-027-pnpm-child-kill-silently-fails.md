# TRP-027 pnpm 자식 프로세스 kill이 조용히 실패한다(버전 관리자 재실행)

- 상태: ACTIVE
- 적용 조건: node `child_process.spawn("pnpm", [...])`로 띄운 서버를, 그 반환된 `child` 핸들에
  `child.kill()`로 내리려 할 때(`pnpm@11.25.0` pin + 셸 스텁으로 다른 버전을 호출하는 pnpm 버전
  관리자 조합의 환경 전반, 이 저장소의 `apps/demo/e2e/run.mjs`류 서버 관리 스크립트를 쓸 때).

## 오해하기 쉬운 신호

`child.kill("SIGTERM")` 뒤 `child`의 `exit` 이벤트가 실제로 발생하고(타임아웃 없이) 로직상 "정상
종료"로 보인다 — 로그도 "내리는 중..." 다음 바로 다음 단계로 넘어가 에러가 없다. 하지만 그 포트
(5173/4173 등)는 계속 `LISTEN` 상태로 남고, 실제 `vite` 프로세스는 살아 있다(`ps -o pid,ppid,pgid,cmd`로
확인하면 PPID가 관리 스크립트가 아니라 고아로 재부모화된 값이다). 다음 실행이 그 포트를 "이미 떠 있음
— 기존 사용"으로 오판하거나, 포트 충돌로 새 서버 기동이 실패한다.

## 원인

pnpm 버전 관리자(`packageManager` pin을 감지해 지정된 버전을 **추가로 spawn**해 위임하는 진입점)를 쓰는
환경에서는, `child_process.spawn("pnpm", [...])`가 돌려주는 `child.pid`가 이 체인의 첫 단계(버전 관리자
진입점)를 가리킨다. 이 진입점 프로세스가 pin된 버전 프로세스를 띄운 뒤 먼저 종료해버려서, Node의
`child` 핸들이 추적하는 PID는 이미 죽은 프로세스이고 실제 서버(pin된 pnpm → `sh -c vite` → `vite`)는
완전히 별개의, 추적되지 않는 PID 트리로 남는다. `detached: false`로 spawn해도 이 재-spawn 단계 자체가
이미 별도 프로세스 그룹을 만들 수 있어 부모-자식 관계로는 막을 수 없다.

## 탐지/회피

자식 핸들이 아니라 **포트**를 기준으로 실제 프로세스를 찾아 끝낸다(`lsof -ti tcp:<port> -sTCP:LISTEN` →
그 PID들에 SIGTERM, 일정 시간 뒤에도 남아 있으면 SIGKILL). `apps/demo/e2e/run.mjs`의 `killPort()`가 이
방식이다. `child.kill()`이나 `child.once("exit", ...)` 성공을 "서버가 내려갔다"의 증거로 믿지 않는다 —
반드시 포트 재확인(`fetch`/`lsof`)으로 검증한다. `lsof` 바이너리가 없는 환경에서는 이 회피 자체가
실패할 수 있다(조용히 "이미 죽음"으로 오판) — 새 환경에 배선하기 전에 `lsof` 존재를 확인한다.
