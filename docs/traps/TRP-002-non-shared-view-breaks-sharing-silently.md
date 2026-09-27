# TRP-002 비공유 typed array를 postMessage로 넘기면 메모리 공유가 조용히 끊긴다

- 상태: ACTIVE
- 적용 조건: 초기화 프레임(`postMessage`)이나 `workerData`로 뷰를 넘길 때. 프레임에 SharedArrayBuffer 채널을 새로 추가하거나 버퍼 생성 코드를 바꿀 때 다시 해당한다.

## 오해하기 쉬운 신호

- `new Int32Array(4)`와 `new Int32Array(new SharedArrayBuffer(16))`는 같은 타입이고 `Atomics.load/store/add`가 둘 다 오류 없이 동작한다.
- `postMessage`는 비공유 뷰를 오류 없이 복사한다. worker는 자기 복사본을 읽고 쓴다.
- 결과: main이 `signalInterrupt`로 SIGINT를 써도 worker의 `setInterruptBuffer` 폴링은 절대 2를 보지 못한다. Ctrl+C가 오류 로그 없이 영영 안 먹는다. 같은 스레드의 단일 뷰로만 돌리는 시험은 통과한다.
- 메일박스 `ctrl`이 비공유면 worker의 `Atomics.wait`가 `TypeError`로 바로 터지지만(시끄러운 실패), interrupt buffer는 조용하다.

## 원인

구조적 복제는 `SharedArrayBuffer`만 같은 메모리를 가리키게 복제하고 `ArrayBuffer`는 복사한다. 뷰의 타입(`Int32Array`)만으로는 어느 쪽인지 구별되지 않는다.

## 탐지/회피

- 회피: 초기화 프레임의 뷰는 `parseInitFrame`이 `value.buffer instanceof SharedArrayBuffer`로 확인한다. 프레임에 뷰 필드를 추가하면 `isSharedView` 검사와 시험(`init-frame.test.ts`의 "SharedArrayBuffer 위의 뷰가 아니면 던진다")에 같은 항목을 더한다.
- 탐지: 버퍼를 스레드 경계 너머로 쓰는 시험은 한쪽에서 쓴 값을 다른 스레드가 읽는 것까지 본다(`thread-scenario.test.ts`의 "같은 메모리로 본다").
