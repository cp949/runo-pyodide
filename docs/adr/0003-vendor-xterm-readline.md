# xterm-readline은 소스를 벤더링해 workspace 패키지로 둔다

이전 구현은 npm `xterm-readline@1.2.2`를 그대로 쓰고 필요한 수정을 런타임 래핑으로 넣었다. 우회 7건 중 4건(`readPaste` 패치, `activeRead`/`State` 생성 타이밍, `Tty` 미export로 레이아웃 재구현, `state.moveCursorBack`·`line.pos` 단위)이 타입상 private인 멤버에 의존해 라이브러리 업그레이드마다 재검증이 필요했고, `... ` 접두사·줄 단위 history 이동·`History` 삭제 API 같은 편차는 라이브러리를 고치지 않고는 풀 수 없었다.

결정: `/work/thrd/xterm-readline`(strtok/xterm-readline 1.2.2, MIT)의 `src/*.ts`를 `packages/xterm-readline`(`@cp949/runo-xterm-readline`, private)으로 복사한다. 수정은 소스에서 직접 하고, 코어는 export된 공개 API만 쓴다. 업스트림 remote는 연결하지 않고 필요할 때 `CHANGELOG.md` 기준으로 수동 diff한다(runo-coincident와 같은 방식). npm 배포는 재사용 가치가 확인될 때 별도로 결정한다.

## Considered Options

- npm 의존 + 런타임 래핑 유지: 이식은 빠르지만 4건의 private 의존이 남는다.
- REPL 전용 라인 에디터 자작: 편차를 전부 풀 수 있으나 규모가 가장 크고 검증 자산(readline 위에서 잰 회귀 기준선)을 다시 만들어야 한다.

## Consequences

`LICENSE-MIT`와 저작권 고지를 패키지에 유지한다. 원본 jest 시험 8개 파일을 vitest로 옮겨 벤더링 직후 회귀를 잡는다.
