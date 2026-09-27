# pty 기준 스냅샷(재측정 없음)

`res_s*.json`·`cases.json`은 `/work/cp949/pyodide-samples/_works/_completed/20260920-04-rd-016-tab-completion/reference/measure-3.14/`에서 그대로 복사했다(RD-015 그릴링 확정 5, DELTA-05.md "## 계획"). 실제 CPython 3.14.4 REPL(pty)에서 측정한 Tab 완성 결과이며, 이 저장소가 임베드한 pyodide 번들의 인터프리터(3.14.2)와는 패치 버전이 다르다 — 두 버전 사이의 후보 집합 차이는 `apps/demo/e2e/README.md`에 이미 명시된 허용 편차다. `verify/tab-check.mjs`의 C3·C10 계열 판정 리터럴은 이 스냅샷(특히 `res_s10_0.json`의 각 케이스 `screen2` 행)에서 그대로 옮겼다.

재생성 명령: `../REGEN.md` 참고.
