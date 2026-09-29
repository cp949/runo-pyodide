# main↔worker 통신에 동기 브리지 라이브러리(coincident)를 쓰지 않는다

이전 구현(`docs/design/12-previous-implementation.md`)은 `@cp949/coincident`로 worker→main 호출 8개를 전부 동기 프록시로 처리했다. `@cp949/coincident`는 WebReflection/coincident 4.1.1의 TypeScript 포크다.

2026-09-21 평가 결과:

- 동기가 필요한 호출은 `input()`의 stdin 읽기 하나뿐이다.
- 나머지 7개는 단방향 알림이다. 그런데도 조각마다 worker를 멈췄다.
- 함정 35건 중 coincident가 직접 원인인 것은 2건이다(`docs/design/11-known-traps.md` "새 구조에서 제거됨").
  - 하나는 main→worker 호출이 worker의 동기 대기 중 응답하지 않는 것이다. 이 한 건이 우회 6건을 낳았다.
    - 센티널·resume 프로토콜
    - Tab 소실
    - 완성 중 SIGINT 불가
    - 설정 변경 시 worker 재생성
    - Enter 2회 동등 포기
    - 송신기 되살아남
  - 다른 하나는 `Error`가 아닌 값으로 reject하면 worker가 함수 이름 문자열을 반환값으로 받는 것이다.
- 코드는 이미 두 경로(interrupt buffer, RPC 포트)로 coincident를 우회하고 있었다.
- 포크는 업스트림 remote가 없고 dist가 미추적이라 유지 부담이 컸다.

결정:

- 네이티브 `Worker` + `MessageChannel` 비동기 RPC를 기본으로 한다.
- `input()`만 `SharedArrayBuffer` 메일박스로 동기 대기한다([ADR-0002](./0002-stdin-mailbox-fixed-size-sab.md)).
- 삭제 검사(당시 추정): coincident를 지우면 되살아나는 코드는 메일박스 약 100행뿐이다.

예외: DOM 접근 전용 `pyodide-dom-bridge` 패키지만 coincident 계열에 의존한다([ADR-0006](./0006-pyodide-core-and-plugin-packages.md)).

## Considered Options

- coincident 유지 + readLine·complete만 별도 RPC(이전 구현의 최종 상태): 기각.
  - 포크를 계속 유지해야 한다.
  - 출력이 동기 왕복으로 남는다.
  - handshake 공존 규칙이 남는다(최초 `await` 이전 등록, `instanceof` 구분).
- JSPI로 `input()`까지 비동기화: [ADR-0005](./0005-input-stays-blocking-prompt-stays-async.md)에서 기각.

## Consequences

- coincident의 Service Worker 폴백(비격리 페이지 지원)을 잃는다.
  - 이전 구현도 `sw.js`를 싣지 않아 쓰지 않던 경로다([ADR-0004](./0004-cross-origin-isolation-required.md)).
- worker→main 값 변환 함정은 자체 프로토콜이 책임진다(`docs/design/01-protocols.md`).
