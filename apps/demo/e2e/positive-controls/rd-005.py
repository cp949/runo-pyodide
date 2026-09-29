#!/usr/bin/env python3
"""양성 대조 드라이버(RD-005). 확인 스크립트가 결함을 실제로 잡는지 소스를 변조해 본다.

출처: RD-005에서 이관했다(RD-018). 짝이 되는 `.md` 기록은 없다.
규칙: `apps/demo/e2e/README.md`의 "양성 대조(positive-controls)"를 따른다.

한 번의 실행(`CONTROLS[번호]`):
1. 대상 파일이 깨끗한지 확인한다. 아니면 중단한다.
2. `find`를 `replace`로 바꿔 소스를 변조한다. 첫 한 곳만 바꾼다.
3. dev 서버를 재시작하고 확인 스크립트를 돌린다(`[변조]` 줄).
4. `git checkout -- <파일>`로 원복한다.
5. dev 서버를 재시작하고 같은 스크립트를 다시 돌린다(`[원복]` 줄).

이 드라이버는 기대를 판정하지 않는다. 결과 줄만 출력한다.
`[변조]`에서 아래 기대 셀만 실패하고 `[원복]`이 전부 통과하는지는 사람이 대조한다(TRP-029).

사용: python3 rd-005.py <1|2|3|4>

변조와 기대:
- 1: `packages/pyodide-terminal/src/prompt-row.ts` `read()`의 `io.sinks.resetTail()` 삭제.
  - 원래 `terminal/repl-reader.ts`에 있었다. RD-027에서 옮겼다.
  - 확인은 `prompt-join-check.mjs`를 `ONLY=T1,U1`, `ONLY=W4`, 전체로 세 번 돌린다.
  - 기대: 다음 프롬프트가 앞 문장의 꼬리를 물려받아 W4·U1 등이 실패한다.
- 2: `packages/pyodide-repl/src/worker/submission-runner.ts`의 `withoutTrailingNewline` 제거.
  - 확인은 `repl-check.mjs normal`과 `trailing-newline-check.mjs`다.
  - 기대: 오류 경로에 빈 줄이 생겨 실패한다.
- 3: `packages/pyodide-repl/src/worker/repl-driver.ts`의 `onTerminated`에서
  `rpc.notify("sessionTerminated")` 삭제.
  - 확인은 `repl-check.mjs normal`이다.
  - 기대: ⑦에서 상태 `terminated`를 기다리다 시간 초과로 실패한다.
- 4: `packages/pyodide-repl/src/worker/console.ts`의 `retrieveException(fut)` 삭제.
  - 확인은 `carryover-check.mjs`다.
  - 기대: (b)에서 `never retrieved` 로그가 새어 실패한다.

전제:
- 깨끗한 트리에서만 실행한다. 시작 전 `git status --short`가 비어야 한다.
- dev 서버(5173)를 변조·원복마다 다시 띄운다(TRP-007). 끝나면 dev 서버가 하나 남으니 직접 정리한다.
- 원복은 `git checkout -- <파일>`이다.
"""
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
CHECKS = REPO / "apps" / "demo" / "e2e" / "checks"
URL = "http://localhost:5173/"
DEV_LOG = os.environ.get("DEV_LOG", os.path.join(tempfile.gettempdir(), "rd-005-positive-control-dev.log"))

# 변조 표. 필드:
# - `file`: 변조 대상(저장소 루트 기준).
# - `find`: 바꿀 문자열. 파일에 있어야 한다.
# - `replace`: 바꾼 뒤 문자열.
# - `scripts`: 돌릴 확인 `[파일, 인자..., {환경변수}]` 목록.
CONTROLS = {
    "1": {
        # RD-027: repl-reader.ts가 삭제됐다.
        # REPL 읽기의 꼬리 리셋은 promptRow.read()로 옮겼다(stdin 읽기와 공유).
        "file": "packages/pyodide-terminal/src/prompt-row.ts",
        "find": "      io.sinks.resetTail();\n",
        "replace": "",
        # 확인을 분리해서 돌린다.
        # 꼬리가 세션 내내 남는 결함이다.
        # 전체를 돌리면 U1 뒤 모든 확인이 연쇄로 실패한다.
        "scripts": [
            ["prompt-join-check.mjs", URL, {"ONLY": "T1,U1"}],
            ["prompt-join-check.mjs", URL, {"ONLY": "W4"}],
            ["prompt-join-check.mjs", URL],
        ],
    },
    "2": {
        "file": "packages/pyodide-repl/src/worker/submission-runner.ts",
        "find": "io.writeError(withoutTrailingNewline(result.formattedError));",
        "replace": "io.writeError(result.formattedError);",
        "scripts": [["repl-check.mjs", "normal", URL], ["trailing-newline-check.mjs", URL]],
    },
    "4": {
        # 회수 호출을 지운다.
        # 문법 오류 future의 예외를 회수하지 않으면 GC 때 `never retrieved` 로그가 새어야 한다.
        "file": "packages/pyodide-repl/src/worker/console.ts",
        "find": "          retrieveException(fut);\n",
        "replace": "",
        "scripts": [["carryover-check.mjs", URL]],
    },
    "3": {
        "file": "packages/pyodide-repl/src/worker/repl-driver.ts",
        "find": 'onTerminated: () => rpc.notify("sessionTerminated"),',
        "replace": "onTerminated: () => {},",
        "scripts": [["repl-check.mjs", "normal", URL]],
    },
}


def sh(args, **kw):
    """`subprocess.run`을 출력 수집(text)으로 부른다. `CompletedProcess`를 돌려준다."""
    return subprocess.run(args, capture_output=True, text=True, **kw)


def dev_pid():
    """5173 포트를 듣는 프로세스의 pid를 돌려준다. 없으면 `None`이다. `ss -ltnp` 출력에서 읽는다."""
    m = re.search(r":5173\b.*?pid=(\d+)", sh(["ss", "-ltnp"]).stdout)
    return int(m.group(1)) if m else None


def restart_dev():
    """dev 서버를 다시 띄운다.

    - 떠 있는 서버는 SIGTERM으로 끝내고 약 5초까지 기다린다.
    - `apps/demo`에서 `pnpm exec vite --port 5173 --strictPort`를 새 세션으로 띄운다.
    - 서버 로그는 `DEV_LOG`에 덧붙인다.
    - 응답 코드 200이 올 때까지 약 20초 기다린다. 안 오면 종료한다.

    재시작하는 이유:
    - `git checkout`이 파일을 새 inode로 바꾸면 Vite 감시가 그 파일을 놓친다.
    - 그러면 서버가 낡은 모듈을 계속 준다(TRP-007).
    - 변조와 원복 때마다 재시작해 최신 소스를 읽게 한다.
    """
    pid = dev_pid()
    if pid:
        os.kill(pid, signal.SIGTERM)
        for _ in range(50):
            if dev_pid() is None:
                break
            time.sleep(0.1)
    log = open(DEV_LOG, "a")
    subprocess.Popen(["pnpm", "exec", "vite", "--port", "5173", "--strictPort"], cwd=str(REPO / "apps" / "demo"), stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(100):
        if sh(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", URL]).stdout == "200":
            return
        time.sleep(0.2)
    sys.exit("dev 서버가 뜨지 않았다")


def run_scripts(scripts):
    """확인 스크립트를 차례로 돌려 결과를 모은다.

    인자 `scripts`는 `[파일, 인자..., {환경변수}]` 목록이다. 마지막 원소가 dict면 환경변수로 더한다.
    `checks/`에서 `node`로 돌리고 스크립트당 제한 시간은 400초다.

    반환: `(라벨, PASS 수, FAIL 이름들, {FAIL 이름: FAIL 줄})` 목록이다.
    - 라벨: 파일 이름과 `ONLY` 값.
    - PASS·FAIL: 출력에서 `PASS`·`FAIL`로 시작하는 줄이다.
    - FAIL 이름: FAIL 줄에서 접두 `FAIL  `과 `  —` 뒤 사유를 뗀 것.
    """
    out = []
    for script in scripts:
        # 마지막 원소가 dict면 환경변수다(`ONLY`로 셀을 고른다).
        env = None
        if isinstance(script[-1], dict):
            env = {**os.environ, **script[-1]}
            script = script[:-1]
        r = sh(["node", str(CHECKS / script[0]), *script[1:]], cwd=str(CHECKS), timeout=400, env=env)
        fails = [re.sub(r"\s+—.*$", "", l[6:]) for l in r.stdout.splitlines() if l.startswith("FAIL")]
        passes = sum(1 for l in r.stdout.splitlines() if l.startswith("PASS"))
        detail = {re.sub(r"\s+—.*$", "", l[6:]): l for l in r.stdout.splitlines() if l.startswith("FAIL")}
        label = script[0] + (f" ONLY={env['ONLY']}" if env else "")
        out.append((label, passes, fails, detail))
    return out


def main(key):
    """변조 → 확인 → 원복 → 재확인을 한 번 돌리고 결과를 출력한다.

    인자 `key`는 `CONTROLS`의 번호다.
    - 대상 파일이 깨끗하지 않거나 `find`가 없으면 중단한다.
    - 확인 도중 예외가 나도 `finally`에서 `git checkout -- <파일>`로 원복한다.
    - 기대와 실제 결과의 대조는 하지 않는다.
    """
    c = CONTROLS[key]
    path = REPO / c["file"]
    if sh(["git", "diff", "--quiet", "--", c["file"]], cwd=str(REPO)).returncode != 0:
        sys.exit(f"대상 파일이 깨끗하지 않다: {c['file']}")
    original = path.read_text(encoding="utf-8")
    if c["find"] not in original:
        sys.exit(f"find 문자열이 없다: {c['find']!r}")
    # 변조 적용 뒤 확인을 돌린다. 예외가 나도 원복한다.
    try:
        path.write_text(original.replace(c["find"], c["replace"], 1), encoding="utf-8")
        print(f"== 양성 대조 {key}: 변조 적용({c['file']})")
        restart_dev()
        mutated = run_scripts(c["scripts"])
    finally:
        sh(["git", "checkout", "--", c["file"]], cwd=str(REPO))
    # 원복 뒤 대상 파일이 깨끗한지 확인한다.
    restored_clean = sh(["git", "diff", "--quiet", "--", c["file"]], cwd=str(REPO)).returncode == 0
    print(f"원복(git checkout) 후 깨끗함: {restored_clean}")
    for name, passes, fails, detail in mutated:
        print(f"[변조] {name}: PASS {passes}, FAIL {len(fails)}")
        for f in fails:
            print(f"   FAIL {detail[f][6:260]}")
    # 원복한 소스로 같은 확인을 다시 돌린다. 전부 통과해야 한다.
    print("== 원복 후 재실행")
    restart_dev()
    for name, passes, fails, _ in run_scripts(c["scripts"]):
        print(f"[원복] {name}: PASS {passes}, FAIL {len(fails)} {fails}")


# `if __name__` 가드가 없다. 실행하면 바로 `main`을 부른다.
main(sys.argv[1])
