# pyodide 버전 고정·호환 탐지·업그레이드 절차

> 결정 근거: [ADR-0007](../adr/0007-pyodide-single-version-policy.md). 구현: RD-021. 이 문서는 (1) 버전 원천과 갱신 명령, (2) 업그레이드 절차와 판단 자료 양식, (3) 부팅 때의 호환 탐지 등급표, (4) 소비자 요구사항, (5) 분기 점검을 적는다.

결론:

- 버전 원천은 `pnpm-workspace.yaml`의 `catalog: pyodide` 한 곳이다. 코드·시험은 그 값을 직접 쓰지 않고 설치된 `pyodide/package.json`의 `version`에서 유도한다.
- 업그레이드는 판단 자료를 만들고 멈춘다. 재측정과 minor 진행은 사용자가 정한다.
- worker가 부팅 때 비공개 API 지점을 한 번 탐지하고, 문제가 있으면 main이 `console.warn`을 1회 낸다. 공개 API는 바뀌지 않는다.

## 13.1 버전 원천과 갱신 명령

| 항목        | 위치                                                                                                                                                                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 원천        | `pnpm-workspace.yaml` `catalog.pyodide`(정확한 버전, 범위 없음)                                                                                                                                                                                                         |
| 소비        | core·repl `package.json` `devDependencies.pyodide: "catalog:"`                                                                                                                                                                                                          |
| 코드 상수   | core `src/pyodide-version.ts`의 `PYODIDE_VERSION`(= `pyodide/package.json`의 `version`), `DEFAULT_PYODIDE_INDEX_URL`(`https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`). repl `src/index.ts`는 `DEFAULT_PYODIDE_INDEX_URL`을 재export한다(공개 이름·값 불변) |
| `dist`      | core `tsdown.config.ts`가 `pyodide/package.json`만 번들에 넣는다(`deps.neverBundle` 정규식 예외 + `deps.alwaysBundle`). 결과는 `version` 문자열 하나만 인라인된다. 런타임 `pyodide` import는 `dist`에 없다(`scripts/check-dist.mjs`)                                    |
| 시험 기대값 | core 상수를 import한다. 버전 리터럴은 코드·시험에 두지 않는다(13.8)                                                                                                                                                                                                     |
| tarball     | pack·publish 때 pnpm이 `catalog:`를 실제 버전으로 치환한다(`pnpm smoke:pack`이 tarball에 `catalog:`가 남지 않았음을 단언한다)                                                                                                                                           |

갱신 명령(2026-09-24 pnpm 11.25.0, 매니페스트·lockfile만 복사한 임시 작업공간에서 `--lockfile-only`로 확인):

| 명령                                                                  | 결과                                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`pnpm-workspace.yaml`의 `catalog.pyodide`를 고치고 `pnpm install`** | 지원하는 방법. 특정 버전으로 올리거나 내린다. `pnpm-lock.yaml`의 `catalogs` 절과 `pyodide@<버전>` 항목이 바뀐다. `pnpm install --frozen-lockfile`은 catalog와 lockfile이 다르면 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`로 실패한다 |
| `pnpm up -r pyodide --latest`                                         | npm `latest` 태그 버전(2026-09-24 기준 `314.0.7`)으로 catalog 값과 lockfile을 함께 갱신한다(catalog `314.0.6`에서 `314.0.7`로 올라가는 것을 확인). 갱신 뒤 catalog 값의 minor가 바뀌었는지 확인한다                            |
| `pnpm up -r pyodide`                                                  | 변경 없음(catalog 정확한 버전을 그대로 둔다)                                                                                                                                                                                   |
| `pnpm up -r pyodide@<버전>`                                           | **쓰지 않는다.** core·repl `package.json`의 `"catalog:"`를 리터럴 버전으로 덮어써 catalog 원천이 끊긴다                                                                                                                        |

catalog 값을 바꾼 뒤 `pnpm install`이 끝나면 `pyodide/package.json`이 새 버전이 된다. `PYODIDE_VERSION`·`DEFAULT_PYODIDE_INDEX_URL`이 따라온다. `pnpm build`가 `dist`에 새 버전을 인라인한다.

## 13.2 원칙

- 한 번에 한 pyodide 버전만 지원한다. 라이브러리 버전 하나가 pyodide 버전 하나다.
- 필요할 때만 올린다(버그·보안·필요한 패키지·브라우저 호환). 새 릴리스가 나왔다는 사실만으로는 올리지 않는다.
- patch(같은 Python minor, 예 `314.0.7` → `314.0.9`)와 minor(Python 3.14 → 3.15)는 절차가 다르다.
- 업그레이드 절차는 판단 자료를 만들고 멈춘다. 재측정 여부·minor 진행은 사용자가 정한다. 자동 판정 규칙은 없다.
- 소비자가 `indexURL`로 다른 버전을 로드하는 것은 막지 않는다. 경고만 낸다(13.6).

## 13.3 patch 절차

1. `pnpm-workspace.yaml`의 `catalog.pyodide`를 새 버전으로 고치고 `pnpm install`(13.1). minor가 바뀌지 않았는지 확인한다(core `peerDependencies.pyodide`의 `^314.0.7`은 같은 minor 안에서 유지된다).
2. `pnpm check-types`·`pnpm lint`·`pnpm test`·`pnpm build`·`pnpm check-dist`·`pnpm smoke:pack`(L0). 실패한 시험 목록을 기록한다.
   - 실제 pyodide를 로드하는 node 시험이 비공개 경로를 직접 단정한다. 여기서 깨지는 것이 업그레이드 알림이다(`09-testing.md` 9.1).
   - 13.5의 "고정 버전 부팅" 시험 3건이 `degraded: []`·`versionMismatch: false`를 단정한다. 저하 지점이 생기면 이 시험이 실패한다.
   - 런타임 floor 탐지 바이트도 재확인한다(13.6 "런타임 floor 탐지 바이트 재검증").
3. `pnpm --filter demo e2e:baseline`(L2)은 사용자 지시가 있을 때만 돌려 기준선과 비교한다. 지시가 없으면 돌리지 않고 "미실행"으로 판단 자료에 적는다(`docs/agents/rubber-workflow.md` "검증 실행 예산").
4. 판단 자료(13.5)를 작성한다.
5. **멈춘다.** 사용자가 결정한다. CDN 위치는 `PYODIDE_VERSION`에서 자동 유도된다. 별도 수정은 없다.

## 13.4 minor 절차

patch 절차 1~5에 더해:

1. core `package.json`의 `peerDependencies.pyodide` 범위를 새 minor에 맞게 고친다(현재 `^314.0.7` = Python 3.14 minor 안의 타입 호환).
2. 판단 자료에 "새 CPython 기준 재측정 권고"를 명시한다. 동등성 기준(CPython 3.14.4 `_pyrepl`, pty 24×80 `TERM=xterm`)은 새 CPython `_pyrepl`로 옮겨 가야 한다(3.14 동작 동결·기준 폐기는 ADR-0007에서 기각).
3. 사용자가 재측정을 정하면 별도 RD로 진행한다: pty 캡처 도구(`docs/history/first-roadmap.md` RD-025)로 새 기준을 측정하고 편차·함정을 전수 재검토한다.

## 13.5 판단 자료 양식

업그레이드 시도마다 아래를 채운다(작업 폴더 문서 또는 사용자에게 보고하는 응답에 적는다).

- 이전·새 pyodide 버전, 이전·새 번들 Python 버전(`pyodide.runPython("import sys; sys.version")`).
- patch / minor 구분.
- L0 결과: 실패한 node 시험 목록(파일·시험 제목), 시험 수 변화.
- `ready` 페이로드 결과: 고정 버전 부팅 시험이 단정하는 값이다. `degraded`(식별자 배열)·`details`(상세 이름). 시험이 통과하면 `degraded: []`, `versionMismatch: false`다. 실패하면 어떤 식별자가 실렸는지 기록한다.
  - 시험: core `packages/pyodide-core/test/worker/boot-compat.test.ts`의 "고정 버전 pyodide 부팅은 degraded가 비고 versionMismatch가 거짓이다(업그레이드 알림 역할)", repl `packages/pyodide-repl/test/worker/repl-driver-probe.test.ts`의 "고정 버전 pyodide에서는 빈 배열이다", repl `packages/pyodide-repl/test/worker/console-compat.test.ts`의 "고정 버전 pyodide › probe()는 빈 배열이다".
- e2e 기준선 차이(L2를 돌렸다면). 미실행이면 "미실행"과 사유.
- 버전에 묶인 편차·함정의 영향 여부. 후보를 찾는 명령: `git grep -n "3\.14\.2\|314\.0\.7" docs/design/10-parity-deviations.md docs/design/11-known-traps.md docs/traps`. 2026-09-23 정책 그릴링이 지목한 목록(재확인 필요): 편차 13·18·19·26~29·34·35, 함정 TRAP-03·06·27, TRP-005·010·021. TRAP-06(TRP-019)은 업스트림(python/cpython#157548)이 수정됐는지도 본다(`11-known-traps.md` TRAP-06의 검증 방법: 재전송을 끈 단일 눌림 N=3000 소실 0이면 재전송 장치 제거 조건).
- 재측정 권고 여부(minor면 필수).

## 13.6 호환 탐지와 `ready` 페이로드

worker 부팅 순서(`00-architecture.md` 3.1): `loadPyodide` → interrupt 공개 API 확인 → `driver.createConsole` → `driver.probe` → `attachRuntime`(WebLoop 재보고 억제·SIGINT 핸들러·stdin 배선을 한 번에, `03-ctrl-c.md` 2.6) → `ready`.

- 지점 판정은 부팅 중 한 번이다.
- 결과는 `ready` 페이로드 `{ pyodideVersion, versionMismatch, degraded, details? }`로 알린다(`01-protocols.md` 1.2).
- worker는 경고를 내지 않는다.

main(core 세션)의 `ready` 핸들러는 `versionMismatch`가 참이거나 `degraded`가 비어 있지 않을 때만 다음을 **1회** 낸다. 문제가 없으면 아무것도 내지 않는다.

```text
console.warn("[session] pyodide 호환 경고", { expected, actual, degraded, details })
```

- `expected`는 core `PYODIDE_VERSION`이다.
- `actual`은 로드된 `pyodide.version`이다.
- 비교는 완전 일치다(부분 일치·범위 없음).
- `degraded`·`versionMismatch`는 공개 API에 노출하지 않는다(내부 계약, 필요해지면 별도 RD).

### 시작 거부

| 지점                                                  | 판정                                                                       | 동작                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pyodide.setInterruptBuffer`·`pyodide.checkInterrupt` | 로드 직후 두 이름이 함수인가(`worker/compat.ts` `findMissingInterruptApi`) | 없으면 콘솔을 만들기 전에 `loadFailed`(`degraded`가 아니다). Ctrl+C가 성립하지 않아 REPL을 시작하지 않는다 |

### 저하(`degraded` 식별자 6개)

| 식별자                     | 지점                                                                                       | 탐지 방법                                                                                                                                                                                                                                                                                              | 꺼지는 기능                                                                                                                                                                                                                          | 코드 위치                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `compiler-flags`           | `pyconsole._compile.compiler.flags`                                                        | `hasCompilerFlags`: 경로가 number인가(접근이 던져도 없는 것으로 본다). 판정은 `setTopLevelAwait` 앞에서 한다                                                                                                                                                                                           | TLA 스위치(`setTopLevelAwait` 건너뜀, pyodide 기본이 TLA 켬이라 `topLevelAwait: false`는 무시됨), EOF 문법 오류 문구 정규화(원문 표시). 붙여넣기 분할용 `compilerFlags()`는 상수 `TOP_LEVEL_AWAIT_FLAG`(0x2000)로 대체해 분할은 유지 | repl `worker/top-level-await.ts`(`hasCompilerFlags`), `worker/console.ts`(`probe`, `normalizeSyntaxError`, `compilerFlags`) |
| `incomplete-input-message` | pyodide 콘솔이 EOF에서 끊긴 `1 +`에 내는 문구 `_IncompleteInputError: incomplete input`    | 독립 `PyodideConsole({})`에 `1 +`를 push해 `formatted_error`의 마지막 줄이 `INCOMPLETE_INPUT_MARKER`인가(문구를 확인할 수 없으면 기대와 다른 것으로 본다). 실제 콘솔 상태를 바꾸지 않고, `formatsyntaxerror`가 설정하는 `sys.last_*`는 호출 전 값(없었으면 없음)으로 되돌린다. `compiler-flags`와 독립 | 없음(정규화 대상 문구가 바뀌면 정규화가 켜지지 않아 원문이 나온다)                                                                                                                                                                   | repl `worker/console-helpers.py`(`incomplete_input_message`), `worker/console.ts`(`probe`)                                  |
| `webloop-handlers`         | WebLoop `_keyboard_interrupt_handler`·`_system_exit_handler`                               | `hasattr`. 하나라도 없으면 둘 다 건너뜀. 상세 이름은 없는 속성 이름                                                                                                                                                                                                                                    | `KeyboardInterrupt`·`SystemExit` 재보고 억제(중단·`exit()`에서 브라우저 `pageerror`가 다시 난다)                                                                                                                                     | core `worker/webloop-reraise.py`·`webloop-reraise.ts`                                                                       |
| `run-sync`                 | `pyodide.webloop.run_sync`·`pyodide.ffi.run_sync` 호출 가능, `console.runcode` 코루틴 함수 | `find_problems`. 상세 이름 3개: `pyodide.webloop.run_sync`·`pyodide.ffi.run_sync`·`console.runcode`                                                                                                                                                                                                    | 정지한 실행(top-level await·`run_sync` 대기) 깨우기. 바쁜 루프 중단과 `time.sleep` 조각은 유지                                                                                                                                       | core `worker/sigint-handler.py`(`find_problems`, `install`), `sigint-handler.ts`                                            |
| `sleep-slice`              | `time.sleep.__wrapped__`가 원본 C 함수, `pyodide_js.checkInterrupt` 호출 가능              | `find_problems`. 상세 이름: `time.sleep.__wrapped__`·`pyodide_js.checkInterrupt`                                                                                                                                                                                                                       | `time.sleep` 20ms 조각 교체(`time.sleep`은 pyodide 기본으로 남고 SIGINT 핸들러는 설치된다)                                                                                                                                           | core `worker/sleep-slice.py`·`sleep-slice.ts`                                                                               |
| `webloop-filename`         | `pyodide.webloop.__file__`이 `pyodide/webloop.py`로 끝남                                   | `install` 안에서 `WEBLOOP_FILE_SUFFIX`와 비교. 상세는 실제 경로(없으면 `None`)                                                                                                                                                                                                                         | 끌 기능은 없다. 트레이스백의 `webloop.py` 프레임 떼기 규칙(`is_webloop`)이 무효가 되어 내부 프레임이 보일 수 있다                                                                                                                    | core `worker/sigint-handler.py`(`install`)                                                                                  |

- `degraded` 순서: driver `probe`가 돌려준 것(`compiler-flags`·`incomplete-input-message`) 뒤에 core 지점이 처음 보고한 순서. 중복은 없다.
- `details`는 식별자별 상세 이름의 `Record<string, string[]>`이다. 상세가 하나도 없으면 페이로드에 키 자체가 없다.
- 식별자 6개는 고정이다. 새 지점을 더하면 이 표·`worker/compat.ts`의 `CoreDegradedId`(core 4개)·driver `probe` 반환(REPL 2개)·시험을 함께 고친다.
- `probe` 계약(driver 내부): `WorkerDriverSession.probe?(context: { pyodide, pyconsole }): string[]`.
  - 선택 메서드다. 탐지할 지점이 없는 driver는 구현하지 않는다.
  - core가 `createConsole` 직후 한 번 부르고 결과를 `degraded`에 합친다.
  - 콘솔·전역 상태를 바꾸지 않아야 한다.
  - 던지면 `loadFailed`다.
- 각 지점은 가짜 객체·실제 pyodide 속성 삭제/문구 변조 시험과 변이 검사로 고정한다: core `worker/boot-compat.test.ts`·`worker/compat.test.ts`·`protocol/ready-payload.test.ts`·`session/core-session.test.ts`, repl `worker/console-compat.test.ts`·`worker/repl-driver-probe.test.ts`·`worker/boot.test.ts`.

### 런타임 floor 탐지 바이트(`WASM_RUNTIME_PROBE`) 재검증

`packages/pyodide-core/src/runtime-support.ts`의 `WASM_RUNTIME_PROBE`(29바이트 wasm 모듈)는 **pyodide 314.0.7이 요구하는 두 wasm 기능**(reference types + legacy Wasm 예외 처리, [ADR-0008](../adr/0008-chrome84-build-floor-and-pyodide-runtime-floor.md))만 검사하도록 고정돼 있다.

- 묶인 대상은 pyodide 버전 자체가 아니다.
- 그 버전의 wasm 산출물(`pyodide.asm.wasm`)이 요구하는 기능 집합에 묶여 있다.

patch·minor 절차(13.3·13.4) 모두, `pyodide.asm.wasm`이 바뀌면(pyodide 업그레이드마다 재빌드된다) 다음을 13.5 판단 자료에 추가한다:

- 새 `pyodide.asm.wasm`이 요구하는 wasm 기능이 이전과 같은지 확인한다. 방법은 ADR-0008 "런타임 floor: 정적 판정과 실측"과 같다.
  - `wasm-tools`/`wabt` 등으로 type·tag 섹션을 다시 읽는다.
  - 또는 node의 `--experimental-wasm-*` 플래그 조합으로 필수 기능을 재확인한다.
- 요구 기능이 바뀌지 않았으면 `WASM_RUNTIME_PROBE`는 그대로 두고 판단 자료에 "탐지 바이트 재확인: 변경 없음"을 남긴다.
- 요구 기능이 바뀌었으면(예: exnref로 전환) `WASM_RUNTIME_PROBE`를 새 최소 모듈로 교체하고, 런타임 floor 정적 판정·실측(ADR-0008)을 다시 한다. 이 교체는 "필요할 때만 올린다"(13.2)의 사유 중 "브라우저 호환"에 해당한다.

## 13.7 소비자 요구사항

- core `./worker` 타입(`dist/worker.d.mts`)은 `pyodide`·`pyodide/ffi` 타입을 import한다.
- core는 `pyodide`를 optional peer(`peerDependencies.pyodide: "^314.0.7"`, `peerDependenciesMeta.pyodide.optional: true`)로 선언한다.
- `./worker` 타입을 쓰는 소비자는 같은 minor의 `pyodide`를 설치한다.
- 런타임에서는 `pyodide`를 import하지 않는다(worker가 CDN에서 불러온다). 타입을 쓰지 않는 소비자는 설치하지 않아도 된다.
- repl은 `pyodide` 타입을 노출하지 않아 peer 선언이 없다(repl `dist`에 `pyodide` import 없음).
- `skipLibCheck: false`인 소비자 tsconfig 요구는 `09-testing.md` 9.8.3에 있다.
- 자세한 소비자 안내는 core `packages/pyodide-core/README.md`.

## 13.8 확인 명령

- 버전 리터럴 0건(코드·시험·스크립트, 주석 포함). 걸러 내는 것은 core peer 범위 한 줄과 허용 파일 하나다.

  ```bash
  git grep -n '314\.0\.7' -- packages apps/demo/src scripts ':!packages/pyodide-repl/test/terminal/import-gate-corpus.ts' \
    | grep -v '^packages/pyodide-core/package.json:[0-9]*: *"pyodide": "\^314\.0\.7"'
  ```

  출력이 0줄이어야 한다. 경로 밖이라 대상이 아닌 것: `apps/demo/e2e/results/*.json`, `apps/demo/e2e/pty/**/*.meta.json`, `docs/`. `import-gate-corpus.ts`는 3.14.4 pty 실측 데이터라 버전 문자열을 포함하는 허용 파일이다. 새 버전으로 올리면 위 명령의 `314\.0\.7`을 이전 버전으로 바꿔 실행해 0줄을 확인한다.

- `pnpm check-dist`: core·repl `dist/*.mjs`에 `pyodide` 런타임 import(`from "pyodide`·`import("pyodide`)가 없다. tsdown을 올리면 이 검사가 인라인 설정 회귀를 먼저 알린다.
- `pnpm smoke:pack`: pack된 3개 `package.json`에 `catalog:`가 남지 않았고, core에 optional peer `pyodide`가 있고, 소비자 설치 뒤 `PYODIDE_VERSION`이 catalog 값과 같다.

## 13.9 분기 점검 체크리스트

분기마다 아래 세 가지를 확인하고 결과만 기록한다(자동화 없음). 업그레이드는 13.2의 사유가 있을 때만 시작한다.

- [ ] pyodide 새 릴리스 존재 여부(`npm view pyodide versions --json | tail`).
- [ ] 새 릴리스가 번들하는 Python 버전.
- [ ] 알려진 보안 이슈(pyodide·번들 Python).
