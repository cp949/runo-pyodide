#!/usr/bin/env python3
"""양성 대조 드라이버(RD-008). 확인 스크립트가 결함을 실제로 잡는지 소스를 변조해 본다.

출처: RD-008에서 이관했다(RD-018). 짝이 되는 `.md` 기록은 없다.
규칙: `apps/demo/e2e/README.md`의 "양성 대조(positive-controls)"를 따른다.

한 번의 실행(`CONTROLS[번호]`):
1. 대상 파일이 깨끗한지 확인한다. 아니면 중단한다.
2. `find`를 `replace`로 바꿔 소스를 변조한다. 첫 한 곳만 바꾼다.
3. dev 서버를 재시작하고 확인 스크립트를 돌린다(`[변조]` 줄).
4. `git checkout -- <파일>`로 원복한다.
5. dev 서버를 재시작하고 같은 스크립트를 다시 돌린다(`[원복]` 줄).

이 드라이버는 기대를 판정하지 않는다. 결과 줄만 출력한다.
`[변조]`에서 아래 기대 셀만 실패하고 `[원복]`이 전부 통과하는지는 사람이 대조한다(TRP-029).

사용: python3 rd-008.py <1|2|3>

변조와 기대:
- 1: `packages/pyodide-core/src/worker/stdin-callback.ts`의 `deps.checkInterrupt();` 삭제.
  - 확인은 `checks/input-cancel-check.mjs`를 `ONLY=RM2`, `ONLY=E1`로 셀마다 돌린다.
  - 기대: RM2가 실패한다(`EOFError` 트레이스백).
  - E1(정상 `input()`)은 통과해야 한다.
- 2: `packages/pyodide-core/src/worker/boot.ts`의 `signalInterrupt` 주입이 요청 번호를 올리지 않게 한다.
  - 확인은 `checks/input-cancel-check.mjs`를 `ONLY=T35`, `ONLY=RM2`로 셀마다 돌린다.
  - 기대: 둘 다 실패한다(시간 초과).
  - 이유: 핸들러가 설치 시점 번호 0을 `last_seq`로 잡는다.
  - 그래서 번호를 올리지 않는 전송은 세션 첫 취소부터 재전송으로 오인된다.
  - CPython이 읽기를 재시도해 프롬프트로 돌아오지 않는다.
  - 이 대조는 검출력만 증명한다. 국소성은 1번과 3번이 증명한다.
  - T35는 "번호가 0에서 1이 된 뒤에도 전진해야 한다"를 고정하려 남겼다.
- 3: `packages/pyodide-repl/src/repl-main-driver.ts`의 `isIdle`에서 `|| cancelSettling` 삭제.
  - 확인은 `checks/prompt-cancel-check.mjs`를 `ONLY=I`, `ONLY=RM1`로 셀마다 돌린다.
  - 기대: I가 실패한다(취소 직후 연타가 `^C`를 에코한다).
  - RM1은 통과해야 한다.

현재 상태:
- 2번과 3번의 `find`가 현재 소스에 없다. `main`이 `find 문자열이 없다`로 중단한다.
- 2번: `signalInterrupt` 주입은 `packages/pyodide-core/src/worker/runtime-attach.ts`에 있다.
- 3번: `isIdle`이 `phase !== "idle"`로 바뀌었다. `cancelSettling` 항이 없다. 취소 직후 구간은 `cancel-settling` phase다.
- 다시 쓰려면 대상 파일과 `find`·`replace`를 현재 구조에 맞춘다.

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
DEV_LOG = os.environ.get("DEV_LOG", os.path.join(tempfile.gettempdir(), "rd-008-positive-control-dev.log"))

# 변조 표. 필드:
# - `file`: 변조 대상(저장소 루트 기준).
# - `find`: 바꿀 문자열. 파일에 있어야 한다.
# - `replace`: 바꾼 뒤 문자열.
# - `scripts`: 돌릴 확인 `[파일, 인자..., {환경변수}]` 목록.
CONTROLS = {
    "1": {
        "file": "packages/pyodide-core/src/worker/stdin-callback.ts",
        "find": "    deps.checkInterrupt();\n",
        "replace": "",
        "scripts": [
            ["input-cancel-check.mjs", URL, {"ONLY": "RM2"}],
            ["input-cancel-check.mjs", URL, {"ONLY": "E1"}],
        ],
    },
    "2": {
        "file": "packages/pyodide-core/src/worker/boot.ts",
        "find": "        signalInterrupt: () => signalInterrupt(interruptBuffer),",
        "replace": "        signalInterrupt: () => Atomics.store(interruptBuffer, 0, 2),",
        "scripts": [
            ["input-cancel-check.mjs", URL, {"ONLY": "T35"}],
            ["input-cancel-check.mjs", URL, {"ONLY": "RM2"}],
        ],
    },
    "3": {
        # 이 게이트는 원래 index.ts에 있었다.
        # RD-010의 세션 추출로 session.ts의 `pythonRunning` 계산식으로 옮겼다(문자열은 그대로, 파일과 들여쓰기(2→4칸)만 다르다).
        # RD-020이 게이트를 core 세션(`alive && inputReadsPending === 0 && !driver.isIdle()`)과 REPL main driver의 `isIdle`로 갈랐다.
        # `cancelSettling` 항이 있는 곳은 REPL의 `isIdle`이라 그 항을 뺐다(같은 변조, 파일만 다르다).
        # 이후 `isIdle`이 `phase !== "idle"`로 바뀌어 이 find는 맞지 않는다.
        "file": "packages/pyodide-repl/src/repl-main-driver.ts",
        "find": "    isIdle: () => readLinePending || cancelSettling,",
        "replace": "    isIdle: () => readLinePending,",
        "scripts": [
            ["prompt-cancel-check.mjs", URL, {"ONLY": "I"}],
            ["prompt-cancel-check.mjs", URL, {"ONLY": "RM1"}],
        ],
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
    subprocess.Popen(
        ["pnpm", "exec", "vite", "--port", "5173", "--strictPort"],
        cwd=str(REPO / "apps" / "demo"),
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    for _ in range(100):
        if sh(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", URL]).stdout == "200":
            return
        time.sleep(0.2)
    sys.exit("dev 서버가 뜨지 않았다")


def run_scripts(scripts):
    """확인 스크립트를 차례로 돌려 결과를 모은다.

    인자 `scripts`는 `[파일, 인자..., {환경변수}]` 목록이다. 마지막 원소가 dict면 환경변수로 더한다.
    `checks/`에서 `node`로 돌리고 스크립트당 제한 시간은 1800초다.

    반환: `(라벨, PASS 수, FAIL 이름들, {FAIL 이름: FAIL 줄}, 종료 코드)` 목록이다.
    - 라벨: 파일 이름과 `ONLY`·`COMBOS`·`N` 값.
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
        r = sh(["node", str(CHECKS / script[0]), *script[1:]], cwd=str(CHECKS), timeout=1800, env=env)
        lines = r.stdout.splitlines()
        fails = [re.sub(r"\s+—.*$", "", l[6:]) for l in lines if l.startswith("FAIL")]
        passes = sum(1 for l in lines if l.startswith("PASS"))
        detail = {re.sub(r"\s+—.*$", "", l[6:]): l for l in lines if l.startswith("FAIL")}
        label = script[0] + (
            f" {','.join(f'{k}={v}' for k, v in env.items() if k in ('ONLY', 'COMBOS', 'N'))}" if env else ""
        )
        out.append((label, passes, fails, detail, r.returncode))
    return out


def report(tag, results):
    """`run_scripts` 결과를 `[태그] 라벨: PASS n, FAIL m [...] exit=코드` 줄로 출력한다.

    FAIL 줄은 앞 400자까지(접두 6자는 뗀다) 덧붙인다.
    """
    for name, passes, fails, detail, code in results:
        print(f"[{tag}] {name}: PASS {passes}, FAIL {len(fails)} {fails} exit={code}")
        for f in fails:
            print(f"   FAIL {detail[f][6:400]}")


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
        print(f"== 양성 대조 {key}: 변조 적용({c['file']})", flush=True)
        restart_dev()
        mutated = run_scripts(c["scripts"])
    finally:
        sh(["git", "checkout", "--", c["file"]], cwd=str(REPO))
    # 원복 뒤 대상 파일이 깨끗한지 확인한다.
    restored_clean = sh(["git", "diff", "--quiet", "--", c["file"]], cwd=str(REPO)).returncode == 0
    print(f"원복(git checkout) 후 깨끗함: {restored_clean}")
    report("변조", mutated)
    # 원복한 소스로 같은 확인을 다시 돌린다. 전부 통과해야 한다.
    print("== 원복 후 재실행", flush=True)
    restart_dev()
    report("원복", run_scripts(c["scripts"]))


# `if __name__` 가드가 없다. 실행하면 바로 `main`을 부른다.
main(sys.argv[1])
