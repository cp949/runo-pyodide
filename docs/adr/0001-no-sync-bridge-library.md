# main↔worker 통신에 동기 브리지 라이브러리(coincident)를 쓰지 않는다

이전 구현(`/work/cp949/pyodide-samples/apps/repl`)은 `@cp949/coincident`(WebReflection/coincident 4.1.1의 TypeScript 포크)로 worker→main 호출 8개를 전부 동기 프록시로 처리했다. 2026-09-21 평가 결과, 동기가 필요한 호출은 `input()`의 stdin 읽기 하나뿐이었고, 나머지 7개는 단방향 알림인데도 조각마다 worker를 멈췄다. 함정 35건 중 coincident가 직접 원인인 것은 2건(TRP-005, TRP-010)이지만 TRP-005 한 건이 우회 6건(센티널·resume 프로토콜, Tab 소실, 완성 중 SIGINT 불가, 설정 변경 시 worker 재생성, Enter 2회 동등 포기, 송신기 되살아남)을 낳았고, 코드는 이미 두 경로(interrupt buffer, RPC 포트)로 coincident를 우회하고 있었다. 포크는 업스트림 remote가 없고 dist가 미추적이라 유지 부담이 컸다.

결정: 네이티브 `Worker` + `MessageChannel` 비동기 RPC를 기본으로 하고, `input()`만 `SharedArrayBuffer` 메일박스([ADR-0002](./0002-stdin-mailbox-fixed-size-sab.md))로 동기 대기한다. 삭제 검사: coincident를 지우면 되살아나는 코드는 메일박스 약 100행뿐이다.

## Considered Options

- coincident 유지 + readLine·complete만 별도 RPC(이전 구현의 최종 상태): 포크 유지, 동기 출력 왕복, handshake 공존 규칙(최초 `await` 이전 등록, `instanceof` 구분)이 남는다.
- JSPI로 `input()`까지 비동기화: [ADR-0005](./0005-input-stays-blocking-prompt-stays-async.md)에서 기각.

## Consequences

coincident의 Service Worker 폴백(비격리 페이지 지원)을 잃는다. 이전 구현도 `sw.js`를 싣지 않아 쓰지 않던 경로다([ADR-0004](./0004-cross-origin-isolation-required.md)). worker→main 값 변환 함정(TRP-010)은 자체 프로토콜이 책임진다(`docs/design/01-protocols.md`).
