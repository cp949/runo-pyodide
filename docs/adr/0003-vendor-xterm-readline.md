# xterm-readline은 소스를 벤더링해 workspace 패키지로 둔다

이전 구현은 npm `xterm-readline@1.2.2`를 그대로 쓰고 필요한 수정을 런타임 래핑으로 넣었다.

우회 7건 중 4건이 타입상 private인 멤버에 의존했다. 라이브러리를 업그레이드할 때마다 재검증이 필요했다.

- TRAP-13: `readPaste` 패치.
- TRAP-14: `activeRead`/`State` 생성 타이밍.
- TRAP-15: `Tty`가 export되지 않아 레이아웃을 재구현.
- TRAP-17: `state.moveCursorBack`·`line.pos`의 단위.

라이브러리를 고치지 않고는 풀 수 없는 편차도 있었다. 예:

- `... ` 접두사.
- 줄 단위 history 이동.
- `History` 삭제 API.

결정:

- strtok/xterm-readline 1.2.2(MIT)의 `src/*.ts`를 `packages/xterm-readline`으로 복사한다.
  - 패키지 이름은 `@cp949/runo-xterm-readline`이고 private이다.
  - 원본 커밋은 `packages/xterm-readline/README.md`에 적는다.
- 수정은 소스에서 직접 한다.
- 코어는 export된 공개 API만 쓴다.
- 업스트림 remote는 연결하지 않는다. 필요할 때 `CHANGELOG.md` 기준으로 수동 diff한다(runo-coincident와 같은 방식).
- npm 배포는 재사용 가치가 확인될 때 별도로 결정한다.

## Considered Options

- npm 의존 + 런타임 래핑 유지: 이식은 빠르다. private 의존 4건이 남는다.
- REPL 전용 라인 에디터 자작: 편차를 전부 풀 수 있다.
  - 규모가 가장 크다.
  - 검증 자산(readline 위에서 잰 회귀 기준선)을 다시 만들어야 한다.

## Consequences

- `LICENSE-MIT`와 저작권 고지를 패키지에 유지한다.
- 원본 jest 시험 8개 파일을 vitest로 옮겨 벤더링 직후 회귀를 잡는다.
