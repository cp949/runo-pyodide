# TRP-073 Vite 번들에서 top-level await 모듈을 core `./worker`보다 먼저 import하면 init 수신기 등록이 그 `await` 뒤로 밀린다

- 상태: ACTIVE
- 적용 조건: 앱의 worker 파일에서 `@cp949/runo-pyodide-core/worker`와 top-level await가 있는 모듈(그런 모듈을 import하는 모듈 포함)을 함께 정적 import할 때, worker 파일의 import 순서를 바꾸거나 새 import를 맨 앞에 추가할 때, 그 worker를 Vite 8(rolldown) `vite build`로 번들할 때.

## 오해하기 쉬운 신호

- Vite dev 서버에서는 재현되지 않는다. dev는 앱 모듈을 네이티브 ESM으로 따로 제공하고, 네이티브 ESM에서는 형제 모듈이 앞 모듈의 top-level await를 기다리지 않고 평가된다. node 확인(`native/`: `root.mjs`가 `./a.mjs`(TLA) → `./b.mjs` 순으로 import)의 출력 순서는 `a start` → `b eval (receiver would register here)` → `a end` → `root body`다. 즉 dev e2e가 통과해도 프로덕션 빌드는 다르게 동작한다.
- 결과(추정, 브라우저 미실측): 앞 모듈의 `await` 동안 도착한 init 프레임은 `message` 리스너가 없어 버려지고 세션이 `loading`에 영구 정지한다. `loadFailed`도 오류 로그도 없다. main 쪽 `createRunner`에는 부팅 제한 시간이 없다(`packages/pyodide-core/src/session/runner.ts`의 타이머는 `stop()` 폴백 `STOP_FALLBACK_MS`뿐이다). 유실 추정의 근거(HTML 명세 해석)는 `docs/design/01-protocols.md` 4절 "import 순서 조건의 근거"에 있다.

## 원인

- Vite 8(rolldown) `vite build`는 모듈 코드를 import 순서대로 한 스코프에 이어 붙인다. 앞 모듈의 top-level await가 뒤 모듈 최상위 문장의 실행까지 막는다. core `./worker`의 수신기 등록 문장(`createInitReceiver(self)`, `run-worker.ts` 모듈 최상위)도 그 뒤 문장에 포함된다.
- 측정(`_works/_completed/20260925-32-rd-023-dom-bridge/verify/post-review/tla-bundle-order/result.log`, vite/8.3.0 linux-x64 node-v24.20.0, 산출물 행 번호):
  - lib 모드, TLA 모듈 먼저(`tla-first/`): `await new Promise(...)` 3행, `createInitReceiver(self)` 676행.
  - lib 모드, core 먼저(`core-first/`): `createInitReceiver(self)` 671행, `await` 690행.
  - worker 번들 모드(`new Worker(new URL("./w.worker.js", import.meta.url), { type: "module" })` + `worker.format: "es"`, TLA 모듈 먼저, `worker-mode/`): `await` 3행, `createInitReceiver(self)` 675행.

## 탐지/회피

- 회피: core `./worker`를 top-level await가 있는 모듈의 import보다 앞선 정적 import로 둔다. dom-bridge를 쓰면 dom-bridge `./worker` 다음에 둔다. 규칙의 정본은 `docs/design/01-protocols.md` 4절(worker 항목과 "import 순서 조건의 근거")이다. 이 순서를 지키면 `runWorker` 호출 시점은 자유다.
- 탐지: `vite build` 산출물에서 `createInitReceiver(self)` 행 번호가 최상위 `await` 행 번호보다 작은지 본다(`grep -n "createInitReceiver(self)\|^await" <산출물>`).
- 동적 `import()`로 core `./worker`를 늦게 평가하는 경우도 같은 유실이 생길 수 있다(시험하지 않았다, `01-protocols.md` 4절).
- 관련: worker 파일의 import 순서에 걸린 다른 함정은 `TRP-069`(리스너 등록 순서와 coincident 부트스트랩 삼킴)·`TRP-070`(`sideEffects: false`가 부수효과 전용 import를 떨어뜨림)이다.
