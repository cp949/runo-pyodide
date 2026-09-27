# TRP-072 Vite dev는 worker에서만 import되는 bare 모듈을 브라우저가 처음 요청할 때 발견해 "의존성 최적화 → 페이지 전체 다시 불러오기"를 일으킨다

- 상태: ACTIVE
- 적용 조건: worker 파일(`src/*.worker.ts`)에서만 import하는 bare 패키지(예: `coincident/window/worker`)를 새로 쓰는 화면, 그 화면의 첫 e2e 실행. `apps/demo/vite.config.ts`의 `optimizeDeps`를 고치거나 worker 진입 파일을 추가할 때. 소비자가 dom-bridge를 Vite dev에서 쓸 때.

## 오해하기 쉬운 신호

- 첫 실행이 실행 도중 이유 없이 실패한다(페이지가 리셋돼 세션·상태가 사라진다). 캐시(`node_modules/.vite/deps`)가 생긴 두 번째 실행부터는 재현되지 않고 통과한다.
- dev 서버 로그에 `dependency optimized: coincident/window/worker` 다음 `optimized dependencies changed. reloading`이 남는다. `coincident/window/main`은 메인 그래프에서 시작 스캔이 찾았지만 worker 그래프의 `coincident/window/worker`는 그렇지 않았다.

## 원인

- Vite dev의 의존성 스캔은 기본으로 `index.html` 진입 그래프에서 시작한다. `new Worker(new URL(…))`로 참조된 worker 파일 안의 bare import는 스캔에 잡히지 않고, 브라우저가 그 worker를 처음 요청할 때 발견돼 재최적화가 일어난다(dev 서버 로그로 확인, Vite 내부 동작 문서는 확인하지 않았다).

## 탐지/회피

- `apps/demo/vite.config.ts`: `optimizeDeps: { entries: ["index.html", "src/*.worker.ts"] }`로 서버 시작 때 worker 파일을 스캔한다. 소비자도 같은 설정이 필요할 수 있다(`docs/design/16-dom-bridge.md` 16.3).
- 브라우저 없이 확인한다: `rm -rf apps/demo/node_modules/.vite/deps` 후 dev 서버를 시작하고 각 모듈(`/src/dom-bridge.worker.ts` 등)을 curl로 요청해 서버 로그에 재최적화(`optimized dependencies changed`)가 없는지 본다. 캐시가 있는 상태의 통과는 근거가 되지 않는다.
