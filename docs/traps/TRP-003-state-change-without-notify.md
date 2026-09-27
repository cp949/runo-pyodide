# TRP-003 상태를 되돌리는 쪽이 notify하지 않으면 반대편 대기가 영영 깨어나지 않는다

- 상태: ACTIVE
- 적용 조건: 메일박스처럼 SharedArrayBuffer 상태 하나를 양쪽이 `Atomics.wait`/`waitAsync`로 번갈아 기다리는 채널에 상태 전이를 추가하거나 기존 전이를 고칠 때.

## 오해하기 쉬운 신호

- 일반 흐름(읽기 하나에 `deliver` 하나, 여러 청크)은 전부 통과한다. `deliver`가 `untilIdle()`에서 잠들 일이 거의 없다.
- 설계 문서 초안(`01-protocols.md` 2.2)은 IDLE 복귀 notify를 READY 경로에만 적었다. 초안대로 구현하면 취소·오류 표식 직후의 `deliver` 시험을 추가하기 전까지 모든 시험이 통과했다.
- 재현 조건은 좁은 경합이다: worker가 표식(취소·오류)을 가져가기 전에 main이 다음 `deliver`를 부른다. 이때 main은 `untilIdle()`에서 영구 대기하고 worker는 다음 읽기에서 영구 대기한다.

## 원인

`Atomics.waitAsync(ctrl, STATE, 현재값)`은 값이 바뀔 때의 `notify`로만 깨어난다. 값을 바꾸고 notify하지 않으면 대기자가 깨어날 기회를 잃는다(lost wake-up).

## 탐지/회피

- 회피: 상태를 바꾸는 모든 경로가 `setState()`(store + notify)를 거친다. IDLE 복귀도 마찬가지다.
- 탐지: worker가 `wait()`에 들어가지 않은 채 표식을 쓰고 곧바로 `deliver`하는 결정적 시험("표식 직후의 deliver", `cancel`·`fail` 각각). 각 경로의 notify를 제거하는 변이가 시험을 실패시키는지 확인한다.
