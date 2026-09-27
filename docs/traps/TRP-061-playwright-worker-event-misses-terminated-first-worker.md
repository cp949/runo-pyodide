# TRP-061 Playwright `page.on('worker')`는 생성 직후 terminate된 worker를 보지 못해, 이중 마운트 확인이 빈 통과가 되거나 정상 컴포넌트에서 실패한다

- 상태: ACTIVE
- 적용 조건: React StrictMode(dev)의 mount → cleanup → mount에서 만들어지는 worker 수를 Playwright `page.on('worker')`·`worker.on('close')`로 세는 브라우저 확인(`react-strictmode-check` 계열), 또는 생성 직후 `terminate()`되는 worker를 Playwright 이벤트로 세려는 모든 확인.

## 오해하기 쉬운 신호

- 컴포넌트가 정상이어도 생성 이벤트가 1개뿐이다(2026-09-25 Chromium: `page.on('worker')` 1회, 페이지 안 `new Worker` 호출 2회·`terminate()` 1회). "worker 2개 생성"을 요구하는 판정은 정상 컴포넌트에서 실패하고 컴포넌트 결함처럼 보인다.
- 반대로 Playwright 이벤트만으로 "살아 있는 worker 1개"를 판정하면 이중 마운트가 실제로 일어났는지 모른 채 통과한다. 이중 마운트가 없었거나 컴포넌트가 첫 worker를 만들지 않아서 1개인 경우와 정리해서 1개인 경우를 구분하지 못한다(빈 통과).

## 원인

첫 마운트의 worker는 생성 직후 cleanup의 `terminate()`로 끝난다. CDP가 그 worker에 붙기 전에 사라지면 Playwright는 생성 이벤트도 `close` 이벤트도 내지 않는다.

## 탐지/회피

- `page.addInitScript`로 `window.Worker`를 서브클래스해 `new`·`terminate` 호출을 기록한다. 이중 마운트는 `new` 2회 이상으로 확인하고, 살아 있는 수는 Playwright 종료 이벤트(누수한 worker는 관측된다)와 계측(`new − terminate`) 두 근거가 모두 1이어야 통과시킨다. 판정 함수: `apps/demo/e2e/react-judge.mjs`의 `tallyWorkers`·`tallyWorkerCalls`·`judgeStrictModeWorkers`(시험 `react-judge.test.mjs`가 가짜 입력으로 양성 대조).
- 옛 worker는 `terminate()` 뒤에도 Chromium에서 최대 약 2초 살아 있다(`docs/traps/TRP-049`). 살아 있는 수는 폴링으로 기대값이 될 때까지 기다리고 고정 대기·ms 상한을 쓰지 않는다(`docs/design/09-testing.md` 9.7).
- 양성 대조: 컴포넌트 cleanup의 `dispose()`를 지우면 `살아 있는 worker 2개(… new 2회·terminate 0회, 기대 1개)`로 실패해야 한다(`e2e:react-strictmode`의 `ONLY=REPL-S01`).
