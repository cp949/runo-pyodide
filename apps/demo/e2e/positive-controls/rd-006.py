#!/usr/bin/env python3
"""양성 대조 드라이버(RD-006). 확인 스크립트가 결함을 실제로 잡는지 소스를 변조해 본다.

출처: RD-006에서 이관했다(RD-018). 짝이 되는 `.md` 기록은 없다.
규칙: `apps/demo/e2e/README.md`의 "양성 대조(positive-controls)"를 따른다.
vitest 변이 실행기가 아니라 브라우저 스크립트를 돌려야 해서 이 드라이버의 `CONTROLS` 표를 쓴다.

한 번의 실행(`CONTROLS[번호]`):
1. 대상 파일이 깨끗한지 확인한다. 아니면 중단한다.
2. `find`를 `replace`로 바꿔 소스를 변조한다. 첫 한 곳만 바꾼다.
3. dev 서버를 재시작하고 확인 스크립트를 돌린다(`[변조]` 줄).
4. `git checkout -- <파일>`로 원복한다.
5. dev 서버를 재시작하고 같은 스크립트를 다시 돌린다(`[원복]` 줄).

이 드라이버는 기대를 판정하지 않는다. 결과 줄만 출력한다.
`[변조]`에서 아래 기대 셀만 실패하고 `[원복]`이 전부 통과하는지는 사람이 대조한다(TRP-029).

사용: python3 rd-006.py <1|2|3>

변조와 기대:
- 1: `packages/pyodide-terminal/src/prompt-row.ts` `read()`의 `io.sinks.resetTail()` 삭제.
  - 원래 `stdin-reader.ts`에 있었다. RD-027에서 옮겼다.
  - 확인은 `stdin-input-check.mjs`를 `ONLY=M1`, `ONLY=U1`, `ONLY=L1`로 셀마다 돌린다.
  - 기대: M1·U1이 실패한다. 다음 REPL 프롬프트가 꼬리를 물려받는다.
  - L1은 통과해야 한다. 해당 확인만 실패한다는 대조다.
- 2: `packages/pyodide-core/src/worker/stdin-callback.ts`에서 `requestInput`을 `wait()` 뒤로 옮긴다.
  - 확인은 `stdin-input-check.mjs ONLY=RM1`이다.
  - 기대: 읽기가 시작되지 않아 입력이 버려져 실패한다.
  - 현재 소스와 맞지 않는다. 아래 "현재 상태"를 본다.
- 3: `packages/pyodide-repl/src/terminal/read-guard.ts`의 `await replRead` 삭제.
  - 확인은 `bg-input-guard-probe.mjs`다.
  - 기대: REPL 읽기가 고아가 되어 프롬프트가 돌아오지 않는다.

현재 상태:
- 2번의 `find`가 현재 소스에 없다. `main`이 `find 문자열이 없다`로 중단한다.
- `createStdinCallback`이 `deps.requestInput(true);`와 `const result = deps.wait();`, `result.kind` 분기 구조로 바뀌었다.
- 다시 쓰려면 `find`·`replace`를 그 구조에 맞춘다.

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
DEV_LOG = os.environ.get("DEV_LOG", os.path.join(tempfile.gettempdir(), "rd-006-positive-control-dev.log"))

# 변조 표. 필드:
# - `file`: 변조 대상(저장소 루트 기준).
# - `find`: 바꿀 문자열. 파일에 있어야 한다.
# - `replace`: 바꾼 뒤 문자열.
# - `scripts`: 돌릴 확인 `[파일, 인자..., {환경변수}]` 목록.
CONTROLS = {
    "1": {
        # RD-027: stdin-reader.ts가 삭제됐다.
        # stdin 읽기의 꼬리 리셋은 promptRow.read()로 옮겼다(REPL 읽기와 공유).
        "file": "packages/pyodide-terminal/src/prompt-row.ts",
        "find": "      io.sinks.resetTail();\n",
        "replace": "",
        # 꼬리가 세션 내내 남는 결함이다. 전체를 돌리면 연쇄로 실패하니 확인을 분리한다.
        # L1은 꼬리가 없어 통과해야 한다(해당 확인만 실패한다는 대조).
        "scripts": [
            ["stdin-input-check.mjs", URL, {"ONLY": "M1"}],
            ["stdin-input-check.mjs", URL, {"ONLY": "U1"}],
            ["stdin-input-check.mjs", URL, {"ONLY": "L1"}],
        ],
    },
    "2": {
        # 원본 find는 `deps.requestInput(true);\n    return deps.wait();\n`이다.
        # stdin-callback.ts가 EOF 처리(`signalInterrupt`·`checkInterrupt`)를 더하며 구조가 바뀌었다.
        # 그때 구조 `const line = deps.wait(); if (line !== null) return line;`에 맞춰 옮긴 것이 아래 find다.
        # 이후 구조가 `const result = deps.wait();`와 `result.kind` 분기로 다시 바뀌어 이 find는 맞지 않는다.
        "file": "packages/pyodide-core/src/worker/stdin-callback.ts",
        "find": "    deps.requestInput(true);\n    const line = deps.wait();\n",
        "replace": "    const line = deps.wait();\n    deps.requestInput(true);\n",
        # worker가 알림 없이 메일박스에서 정지하면 이후 확인이 모두 연쇄로 실패한다.
        # 그래서 첫 확인 하나만 본다.
        "scripts": [["stdin-input-check.mjs", URL, {"ONLY": "RM1"}]],
    },
    "3": {
        "file": "packages/pyodide-repl/src/terminal/read-guard.ts",
        "find": "      await replRead;\n",
        "replace": "",
        "scripts": [["bg-input-guard-probe.mjs", URL]],
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
        print(f"== 양성 대조 {key}: 변조 적용({c['file']})", flush=True)
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
    print("== 원복 후 재실행", flush=True)
    restart_dev()
    for name, passes, fails, _ in run_scripts(c["scripts"]):
        print(f"[원복] {name}: PASS {passes}, FAIL {len(fails)} {fails}")


# `if __name__` 가드가 없다. 실행하면 바로 `main`을 부른다.
main(sys.argv[1])
