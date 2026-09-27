# pty 기준 스냅샷 — `import`/`from` 줄 모듈 완성(재측정 없음)

`res_import.json`·`res_import_extra.json`·`cases_import.json`·`gate_corpus.json`·`gate_corpus.meta.json`·`native_vs_pyodide.json`·`native_vs_pyodide.meta.json`·`SUMMARY-import.md`는 `/work/cp949/pyodide-samples/_works/_completed/20260921-01-rd-016a-import-completion/reference/measure-3.14/`에서 그대로 복사했다(RD-016 그릴링 확정 2, 재측정 없음). 실제 CPython 3.14.4 REPL(pty 24×80, `TERM=xterm`, 빈 임시 cwd)에서 측정한 모듈 완성 결과다.

| 파일                     | 내용                                                                              | 쓰는 곳                                                                           |
| ------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `res_import.json`        | 케이스 A01~A37의 pty 화면 행·커서(Tab 단계별)와 후보 로그. 키는 입력 텍스트       | `worker/module-completion-parity.test.ts`(A01~A36. A37은 quirk 단위)              |
| `res_import_extra.json`  | 케이스 X01~X04(스템·파싱 불일치 quirk)                                            | 같은 시험                                                                         |
| `cases_import.json`      | 케이스 정의(입력 텍스트·Tab 횟수)와 `setup` 5줄                                   | 같은 시험(setup)                                                                  |
| `native_vs_pyodide.json` | 95줄의 네이티브(3.14.4)·pyodide(314.0.7, zip 보정 전) `ModuleCompleter` 결과 대조 | 편차 18·19 근거                                                                   |
| `gate_corpus.json`       | 게이트 코퍼스 53줄과 분류                                                         | `terminal/import-gate.test.ts`·`worker/complete-source.test.ts`(리터럴로 옮겨 씀) |
| `*.meta.json`            | 측정 환경 요약(`cwd`·경로는 실행마다 다르다)                                      | 참고                                                                              |
| `SUMMARY-import.md`      | 측정 요약                                                                         | 참고                                                                              |

## 주의

- **버전**: 기준 pty는 Python 3.14.4이고 이 저장소가 임베드한 pyodide 314.0.7은 3.14.2다. 후보 집합 차이는 등록 편차다(`docs/design/10-parity-deviations.md` 18·19). 모듈 후보의 개수·전체 목록은 단정하지 않는다(TRAP-27).
- **`SUMMARY-import.md` 코퍼스 표의 "게이트" 열**은 기각된 `/\b(import|from)\b/` 게이트 기준이다(`gate_corpus.meta.json`의 `gate_regex_js`도 같다). 채택한 게이트는 부분 문자열 `/import|from/`이고(`docs/design/07-tab-completion.md` 7.5, TRAP-33), 이 열의 "게이트 거짓·비None(예외) 5줄"(숫자 리터럴 뒤 키워드)은 채택 게이트에서 참이다. 표의 "게이트 거짓·None"·"게이트 참" 구분을 그대로 채택 게이트의 분류로 읽지 않는다.
- **`[ not unique ]` 행**: 3.14 pty 화면에만 있는 안내 행이다. 이 저장소는 출력하지 않는다(편차 16). 시험은 이 행을 비교에서 뺀다.
- **`108 more...`**: 3.14 목록 메뉴의 쪽 넘김 표시다. 이 저장소는 200개 상한과 `...N개 더` 행을 쓰므로(편차 16) `import `·`from ` 두 번째 Tab 목록은 열 우선 배치의 구조만 대조한다.
- 값은 결정적이지만 `*.meta.json`의 `cwd`·경로는 실행마다 다르다.

재생성 명령: `../REGEN.md` 참고.
