# stdin 메일박스는 고정 크기 SharedArrayBuffer와 청크 루프로 만든다

`input()` 응답을 main이 정지한 worker에 넘기려면 공유 메모리가 필요하다.

growable `SharedArrayBuffer`(`.grow()`, Chrome 111+)는 채택하지 않는다.

- 길이 제한 없이 한 번에 쓸 수 있다.
- 브라우저 지원 폭이 좁다.
- 한 번 넘긴 뷰의 길이가 바뀌는 성질에 의존하게 된다.
- runo-reflected-ffi [ADR-0002](/work/cp949/runo/runo-reflected-ffi/docs/adr/0002-fixed-size-buffer-for-growable-sharedarraybuffer-gap.md)와 같은 판단이다.

결정:

- 배치는 고정 할당이다.
  - 제어 `Int32Array(4)`.
  - 데이터 `Uint8Array(64 KiB)`.
- 64 KiB를 넘는 줄은 청크로 나눈다. 주고받는 순서는 다음과 같다.
  1. worker가 `IDLE`로 돌아온다.
  2. main이 다음 청크를 쓴다.
- main 쪽 대기는 `Atomics.waitAsync`다. 없으면 1ms 폴링이다.
- 취소·오류·입력 끝은 `STATE` 값으로 표식한다(`CANCELLED`, `ERROR`, `EOF`).
  - `EOF`는 RD-048이 더했다. 취소가 아니다.
- 메일박스는 worker(세션)마다 새로 만든다. interrupt buffer와 달리 재사용하지 않는다.

## Consequences

- `CAPACITY`를 바꾸면 청크 시험을 같이 바꾼다: 정확히 64 KiB, +1 바이트, 멀티바이트 경계.
- 다른 SAB 채널을 추가할 때도 growable 대신 고정 할당을 쓴다.
