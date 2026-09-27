# TRP-034 이동한 파일을 문자열·상대 경로로 가리키는 e2e 스크립트는 타입 검사와 lint를 통과한 채 깨진다

- 상태: ACTIVE
- 적용 조건: 소스 파일을 패키지 사이로 옮기거나 쪼개거나 들여쓰기·식별자를 바꿀 때. 대상은 `apps/demo/e2e/positive-controls/*.py`(`CONTROLS`의 `file` + `find` 정확 일치 문자열)와 `apps/demo/e2e/node/**/*.mjs`(소스 상대 경로 import·하드코딩)다.

## 오해하기 쉬운 신호

- `pnpm check-types`·`pnpm lint`·`pnpm test`·`pnpm --filter demo e2e:check`(`node --check`)가 전부 통과한다. `.mjs`의 import 경로와 `.py`의 문자열은 어느 쪽도 검사하지 않는다.
- 브라우저 L1·L2도 통과한다. 양성 대조(`positive-controls`)는 L3라 기본 검증에 들지 않는다.
- 드러나는 시점은 양성 대조를 실제로 돌릴 때뿐이다(`find` 미일치 또는 모듈 없음). 그때는 원인이 옮긴 커밋과 멀다.
- 한 파일의 내용이 둘로 갈라지면(예: `boot.ts`가 core와 repl로) 컨트롤마다 옮겨 가야 할 파일이 다르다. 한 곳만 고치면 나머지가 조용히 남는다.

## 원인

경로가 문자열 리터럴이거나 실행 시점에 해석되는 상대 경로라 정적 검사 대상이 아니다. 양성 대조는 `file`을 읽어 `find`가 정확히 한 번 나오는지에만 기대므로 파일이 옮겨지면 거기서 처음 실패한다.

## 탐지/회피

- 파일을 옮긴 커밋마다 L0에서 `CONTROLS`의 `file` 존재와 `find` 1회 일치를 확인한다.

  ```bash
  python3 - <<'PY'
  import glob, importlib.util, os, sys
  root = os.popen("git rev-parse --show-toplevel").read().strip()
  bad = 0
  sys.argv = ["x"]
  sys.dont_write_bytecode = True   # 스크립트 옆에 __pycache__를 만들지 않는다
  for f in sorted(glob.glob(root + "/apps/demo/e2e/positive-controls/*.py")):
      spec = importlib.util.spec_from_file_location("pc", f)
      m = importlib.util.module_from_spec(spec)
      try: spec.loader.exec_module(m)
      except BaseException: pass
      for k, c in (getattr(m, "CONTROLS", None) or {}).items():
          p = os.path.join(root, c["file"])
          n = open(p).read().count(c["find"]) if os.path.exists(p) else -1
          print(os.path.basename(f), k, c["file"], "find 횟수", n)
          bad += n != 1
  print("불일치", bad)
  PY
  ```

  출력 마지막이 `불일치 0`이어야 한다.

- `apps/demo/e2e/node/**`는 옛 경로를 grep으로 확인한다. 예: `grep -rn "packages/pyodide-repl/src/<옮긴 경로>" apps/demo/e2e`.
- `find` 문자열이 바뀐 곳(들여쓰기·식별자)은 컨트롤의 의도(어느 줄을 변조하는가)가 그대로인지도 본다. 문자열이 맞는다고 같은 지점이라는 보장은 없다.
