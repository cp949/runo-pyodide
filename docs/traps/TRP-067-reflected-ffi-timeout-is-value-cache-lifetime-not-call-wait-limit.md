# TRP-067 `reflected_ffi_timeout`은 동기 호출 대기 상한이 아니라 원격 값 캐시 수명이라 동기 호출 중 중단을 완화하지 않는다

- 상태: ACTIVE
- 적용 조건: 설계·문서·시험이 coincident의 `reflected_ffi_timeout` 옵션을 "동기 호출 타임아웃"이나 "동기 호출 중 `interrupt()` 완화책"으로 서술·사용할 때. 동기 coincident 호출(`Atomics.wait`류 대기) 중 Ctrl+C·`interrupt()` 지연을 다룰 때.

## 오해하기 쉬운 신호

- 옵션이 실제로 전달된다. 2026-09-25 Chromium 측정에서 `timeout: 1000`이 worker 부트스트랩 배열에 실렸고 오류도 없다. 그래서 적용된 것처럼 보이고 효과만 없다.
- 호출 길이 8초, 500ms 뒤 `interrupt()`, N=10, 4조합(핸들러 없음·있음 × timeout 없음·1000): 옵션 유무와 무관하게 40/40회 결말이 호출 반환 뒤였고 "중단 요청→결말"은 중앙 7501.2~7503.7ms였다(5초 이하 0/40).

## 원인

- `coincident@4.1.1`의 `ffi_timeout(options)`는 `options?.reflected_ffi_timeout ?? -1`을 돌려준다(`coincident/src/utils.js:42-44`). 이 값은 `reflected-ffi`(0.7.2)에서 `timeout`으로 쓰여, `-1 < timeout`이면 `memo(timeout)`(`reflected-ffi/src/utils/memo.js`)이 원격 참조 값을 그 ms 동안 캐시한다(`local.js:93,198`, `remote.js:79,193`). 호출 대기·`Atomics.wait`에는 쓰이지 않는다.
- 동기 호출 중 worker는 `Atomics.pause` 바쁜 루프처럼 대기하고(renderer CPU 중앙 1.1코어), `interrupt()`는 호출 반환 뒤 다음 줄에서 `KeyboardInterrupt`로 나타난다.

## 탐지/회피

- 동기 호출 중 즉시 끝내는 경로는 `runner.stop()` 폴백(worker terminate·재생성)뿐이다: 결말 중앙 약 1.0초, 새 `ready` 약 1.8초(20/20 `restarted`). Python 상태(변수·import)를 잃는다.
- 문서·계획에는 "`interrupt()`는 호출이 반환된 뒤에 전달된다(호출 길이에 종속)"와 "`stop()` 폴백은 상태를 잃는다"를 분리해 적는다. 이 옵션을 완화책으로 넣지 않는다.
- 근거를 다시 확인하려면 옵션 없음/1000 두 조건에서 같은 호출 길이의 "중단 요청→결말"을 비교한다. 소스 위치는 위 파일·줄이다(버전이 바뀌면 다시 읽는다).
