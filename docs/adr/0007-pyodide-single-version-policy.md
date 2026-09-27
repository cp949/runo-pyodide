# pyodide는 단일 버전으로 고정하고, 재측정은 사람이 결정한다

이 저장소는 pyodide 비공개 API에 기댄다(`_compile.compiler.flags`, WebLoop 핸들러, `run_sync`, `time.sleep.__wrapped__`, `pyodide/webloop.py` 파일명, `_IncompleteInputError` 문구). 동등성 기준은 CPython 3.14.4 `_pyrepl` pty 실측이고, 편차 8건과 함정 6건이 번들 Python 버전(현재 3.14.2)에 묶여 있다. 정책이 없으면 세 가지가 조용히 어긋난다: 버전 리터럴이 코드·시험 여러 곳에 흩어져 일부만 바뀌고, 소비자가 `indexURL`로 다른 버전을 로드해도 알 방법이 없으며, 비공개 API가 사라져도 기능이 조용히 꺼진다. 2026-09-23 정책 그릴링 18건 중 결정으로 남는 것만 아래에 적는다.

결정:

- **한 번에 한 버전만 지원한다.** 라이브러리 버전 하나 = pyodide 버전 하나. 소비자가 `createRepl({ pyodide: { indexURL } })`로 다른 버전을 로드하면 허용하되 거부하지 않고, `pyodide.version`(URL이 아니다)을 고정 버전과 완전 일치로 비교해 `console.warn` 1회를 낸다.
- **필요할 때만 올린다.** 동기는 버그·보안·필요한 패키지·브라우저 호환이다. 분기마다 새 릴리스가 있는지만 점검한다(자동화 없음).
- **버전 원천은 `pnpm-workspace.yaml`의 `catalog: pyodide` 한 곳이다.** core·repl `package.json`의 `devDependencies.pyodide`는 `"catalog:"`이고, publish·pack 때 pnpm이 실제 버전으로 치환한다. 코드는 설치된 `pyodide/package.json`의 `version`에서 `PYODIDE_VERSION`·`DEFAULT_PYODIDE_INDEX_URL`을 유도한다(core 소유, repl은 재export). 시험 기대값도 그 상수를 import한다. 원천을 `package.json`이 아니라 catalog로 둔 이유는 core·repl 두 패키지가 같은 값을 쓰기 때문이다(`package.json` 두 곳이면 일치 시험이 필요하다).
- **업그레이드 절차는 판단 자료를 만들고 멈춘다**(patch·minor 공통). 재측정 여부와 minor 업그레이드 진행은 사용자가 정하며 자동 판정 규칙은 없다. minor(Python 3.14 → 3.15)는 동등성 기준이 새 CPython `_pyrepl`로 옮겨 가야 하므로 판단 자료에 "재측정 권고"를 명시한다.
- **비공개 API가 없을 때는 지점별로 다르다.** interrupt 공개 API(`setInterruptBuffer`·`checkInterrupt`)가 없으면 Ctrl+C가 성립하지 않으므로 시작을 거부한다(`loadFailed`). 그 밖의 지점은 해당 기능만 끄고 계속 실행하며 `ready` 페이로드 `degraded`에 식별자를 싣는다. 시험(고정 버전 부팅)에서는 `degraded: []`여야 하므로 업그레이드 때 실패로 알려진다.

세부 절차·등급표·판단 자료 양식은 [`docs/design/13-version-upgrade.md`](../design/13-version-upgrade.md).

## Considered Options

- **3.14 동작 동결**(새 Python의 메시지·동작 변화를 역보정해 3.14 REPL을 흉내 낸다): 기각. 새 Python 메시지 형식과의 역보정이 끝나지 않는다.
- **동등성 기준 폐기**: 기각. "CPython 기본 REPL과 같은 조작감"이라는 프로젝트 목적이 사라진다.
- **다중 버전 지원**: 기각. 비공개 API 분기와 pty 기준 데이터가 버전 수만큼 곱절이 된다.
- **자동 재측정 규칙**(patch는 자동, minor는 수동 등): 기각. 재측정 필요 여부는 변경 내용에 달려 있어 기준을 미리 적을 수 없다.
- **TS 상수 + 일치 시험**(코드에 버전 문자열을 두고 `package.json`과 같은지 시험): 기각. 수정 지점이 둘이다.
- **core `package.json`을 원천으로 두고 repl은 일치 시험**: 기각. repl `devDependencies`가 core와 어긋날 수 있고 시험이 그 어긋남을 뒤늦게 알린다. catalog는 두 패키지가 같은 항목을 가리킨다.

## Consequences

- 업그레이드마다 판단 자료(이전·새 번들 Python 버전, 실패한 시험, `degraded` 결과, 버전에 묶인 편차·함정 영향)를 만드는 비용이 든다.
- minor 업그레이드가 재측정으로 이어지면 새 pty 기준 측정과 편차·함정 전수 재검토가 필요한 대형 작업이 된다.
- 소비자의 `indexURL` 교체는 막지 않는다. 경고와 `versionMismatch`(내부 계약, 공개 API로 노출하지 않음)만 있고 동작은 보장하지 않는다.
- `pnpm up -r pyodide@<버전>`은 `catalog:`를 리터럴 버전으로 덮어쓰므로 쓰지 않는다(pnpm 11.25.0 실측, `13-version-upgrade.md` 1절).
- core `./worker` 타입은 `pyodide` 타입을 import한다. core는 `pyodide`를 optional peer(`^314.0.7`, Python 3.14 minor 안의 타입 호환)로 선언하고, 소비자 요구사항은 core `README.md`에 있다. 런타임 `pyodide`는 CDN에서 불러오므로 `dist`는 `pyodide`를 import하지 않는다(`scripts/check-dist.mjs`가 검사).
