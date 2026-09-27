# TRP-043 pyodide는 `2**53 - 1` 이상의 Python `int`를 JS `BigInt`로 만들어 `number` 타입을 조용히 깬다

- 상태: ACTIVE
- 적용 조건: Python `int`를 `to_js`/PyProxy로 JS에 넘기는 코드에서 큰 정수가 나올 수 있을 때(종료 코드, 시각, 사용자 값). 결과 타입을 `number`로 선언했을 때.

## 오해하기 쉬운 신호

- `Number.MAX_SAFE_INTEGER`(`2**53 - 1`)까지는 `number`일 것으로 보인다. 실측(pyodide 314.0.7): `2**52`·`2**53 - 2`는 `number`, `2**53 - 1`·`-(2**53 - 1)`·`2**53`은 `BigInt`다. int32 밖(`2**31`, `2**40`)도 `number`다. 일반 값 시험은 전부 통과한다.
- `BigInt`는 구조적 복제(RPC)를 통과해 `code: number` 선언과 어긋난 채 소비자에 도착한다. `JSON.stringify(BigInt)`는 `TypeError`라 데모의 `result` 표시 같은 곳에서 원인과 먼 곳에서 터진다.

## 원인

- pyodide의 `int` → JS 변환은 `|x| < 2**53 - 1`(엄격 부등호)인 값만 `number`로 만든다.

## 탐지/회피

- 결과 타입이 `number`여야 하면 Python 쪽에서 범위를 줄인 뒤 넘기고(`run-driver.py`의 `_exit_status`: int32 밖은 `& 0xFF`), TS에서 `typeof === "number"`로 검증한다(`run-driver.ts`의 `toOutcome`).
- 시험은 경계를 넣는다: `SystemExit(2**53 - 1)`·`2**53`·`-(2**53 - 1)`·`2**70 + 7`(`run-driver-classify.test.ts`).
