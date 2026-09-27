# TRP-025 `try` 안에서 async 함수를 `await` 없이 `return`하면 그 `catch`가 못 잡는다

- 상태: ACTIVE
- 적용 조건: `async function f() { try { return g() } catch (e) { ... } }` 형태에서 `g()`가 async 함수(Promise를
  돌려주는 함수)일 때. `try` 블록이 "이 안에서 나는 모든 예외를 잡는다"는 안전망 역할일 때(최상위 오류 캐치,
  인터럽트 처리 등) 특히 위험하다.

## 오해하기 쉬운 신호

- `try`/`catch`가 있으니 안전해 보인다. 정적으로 읽으면 `g()`가 던진 예외도 잡힐 것처럼 보인다.
- 정상 경로는 아무 문제 없이 동작한다. `g()` 안에서 예외가 나는 경로를 시험이 실행하지 않으면 발견되지
  않는다.
- 실패는 `f()`를 부른 쪽에서 "처리되지 않은 rejection"으로 나타나 원인과 먼 곳에서 드러난다.

## 원인

async 함수의 반환값이 promise일 때, 그 promise를 채택(adopt)하는 과정은 스펙상 `try` 블록의 **밖**에서
일어난다. `return g()`는 `g()`가 돌려준 promise를 그대로 함수의 반환값으로 넘기는데, 그 promise가 reject로
끝나는 시점은 `f()`의 `try` 스코프 밖이라 `catch`가 걸리지 않는다. `return await g()`로 바꾸면 `await`가
`try` 안에서 값을 기다리므로 예외가 그 자리에서 던져져 `catch`가 잡는다.

## 탐지/회피

- `try { return asyncFn() } catch { ... }` 패턴을 보면 `asyncFn`이 async 함수(또는 Promise를 돌려주는
  함수)인지 확인하고, 맞으면 `return await asyncFn()`로 고친다.
- `no-return-await` 계열 eslint 규칙은 **반대 방향**(불필요한 `await` 제거를 권장)이라 이 함정을 못 잡는다 —
  켜져 있으면 오히려 이 수정을 되돌리려 한다. 자동 린트에 기대지 말고 리뷰에서 직접 확인한다.
- `try` 블록이 "이 안에서 나는 모든 예외를 잡는다"는 가정으로 쓰인 안전망 코드에서는 그 안에서 부르는 모든
  async 함수 호출이 `await` 붙여 반환되는지 점검한다.
- 재현: `async function f(){ try { return g() } catch(e){ return 'caught' } }` /
  `async function g(){ throw new Error('x') }` — `f()`는 reject된 promise를 돌려주고 `'caught'`를 반환하지
  않는다.
