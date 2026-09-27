# stdin 메일박스는 고정 크기 SharedArrayBuffer와 청크 루프로 만든다

`input()` 응답을 main이 정지한 worker에 넘기려면 공유 메모리가 필요하다. growable `SharedArrayBuffer`(`.grow()`, Chrome 111+)를 쓰면 길이 제한 없이 한 번에 쓸 수 있지만 브라우저 지원 폭이 좁고, 한 번 넘긴 뷰의 길이가 바뀌는 성질에 의존하게 된다(runo-reflected-ffi [ADR-0002](/work/cp949/runo/runo-reflected-ffi/docs/adr/0002-fixed-size-buffer-for-growable-sharedarraybuffer-gap.md)와 같은 판단).

결정: 제어 `Int32Array(4)` + 데이터 `Uint8Array(64 KiB)` 고정 할당. 64 KiB를 넘는 줄은 청크로 나눠 worker가 `IDLE` 복귀 → main이 다음 청크 순으로 주고받는다. main 쪽 대기는 `Atomics.waitAsync`, 없으면 1ms 폴링. 취소·오류는 `STATE` 값(`CANCELLED`, `ERROR`)으로 표식한다. 메일박스는 worker(세션)마다 새로 만들고 interrupt buffer와 달리 재사용하지 않는다.

## Consequences

`CAPACITY`를 바꾸면 청크 시험(정확히 64 KiB, +1 바이트, 멀티바이트 경계)을 같이 바꾼다. 다른 SAB 채널을 추가할 때도 growable 대신 고정 할당을 쓴다.
