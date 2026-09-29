"""기준 데이터 디렉터리와 재생성 디렉터리를 정규화 비교한다(RD-025). 표준 라이브러리만 쓴다.

사용:
  python3 compare_baseline.py <기준 디렉터리> <재생성 디렉터리> [--json <출력 JSON>] [--max-rows N]
      [--files NAME[=재생성이름] ...] [--ignore-baseline-candidates 기준파일명=이름,이름,...]

종료 코드:
  0  판정값 차이 0. 환경 유래 차이는 있어도 된다(표에 기록만 한다).
  1  판정값 차이 있음. 고치려 들지 말고 차이 표를 사용자에게 올린다.
  2  실행 오류(디렉터리·파일 없음, JSON 파싱 실패, 인자 오류).

정규화 규칙(원천은 pty/tools/README.md "`compare_baseline.py`"):
- 본문 JSON: 파싱한 값을 비교한다.
  - 키 순서·들여쓰기는 무시한다.
  - 배열 순서는 의미가 있으므로 그대로 둔다.
  - bool과 int는 구분한다.
  - 본문의 모든 차이가 판정값 차이다.
- `*.meta.json`: 화이트리스트(`META_JUDGEMENT_PATTERNS`) 키만 판정값으로 비교한다.
  - 나머지 필드는 값이 달라도 "환경 유래 차이" 표에만 기록한다. 사유는 `META_EXCLUDED_REASONS`다.
  - `env_*_top_level`(환경 전용 최상위 모듈 집합)도 환경 유래로 기록한다(`META_ENV_PATTERNS`, TRAP-27).
  - 분류 결과(counts·env/zip stdlib/기타)가 바뀌면 `counts`와 본문에서 판정값 차이로 따로 잡힌다.
- 기본 대상은 rd-016 6파일이다. 파일명이 다르면(rd-015 등) `--files 기준이름=재생성이름`으로 짝짓는다.
- `--ignore-baseline-candidates 기준파일명=이름,이름,...`(반복 가능):
  - 기준 파일의 `res` 배열에서만 지정한 이름을 뺀 뒤 재생성과 비교한다. 기준 수집 당시 cwd에 있던 파일명이 후보에 섞인 경우다(TRAP-27).
  - 목록은 실행 인자로만 준다. 그 파일에만 적용한다.
  - 재생성 `res`에서는 이름을 빼지 않는다. 재생성에 있으면 차이로 남는다.
  - 기준 어디에서도 빼지 못한 이름은 판정값 차이다. 목록이 어긋난 것이다.
  - `res`를 뺀 케이스의 `screen*` 차이는 후보 열 폭(가장 긴 후보 이름)이 바뀐 열 배치 차이라 재계산할 수 없다.
    - 양쪽 화면의 단어가 모두 해당 쪽 `res`의 원소일 때만 환경 유래 표로 옮긴다.
  - 옵션 사용 사실은 출력과 `--json`의 `ignored_baseline_candidates`에 남는다.
  - `*.meta.json`에는 적용되지 않는다.
"""
import argparse
import fnmatch
import json
import os
import sys

# `--files`가 없을 때의 대상: rd-016 기준 데이터 6파일. 기준·재생성의 파일명이 같아야 한다.
DEFAULT_FILES = [
    "res_import.json",
    "res_import_extra.json",
    "gate_corpus.json",
    "gate_corpus.meta.json",
    "native_vs_pyodide.json",
    "native_vs_pyodide.meta.json",
]

# *.meta.json에서 판정에 넣는 키 이름 패턴.
# 어느 깊이든 키 이름으로 fnmatch 매칭하고, 매칭된 키의 값 전체를 비교한다.
META_JUDGEMENT_PATTERNS = [
    "cases",                   # 케이스 수
    "counts*",                 # counts·counts_by_origin·counts_native·counts_pyodide: 동일·차이·분류(env/zip stdlib/기타)·게이트 분류 4종 개수
    "*_differs*",              # native_vs_pyodide_differs·gate_js_vs_py_differs·result_pkgnone_differs_*: 판정이 갈린 줄 목록
    "sys_modules_*",           # 프로브 전후 sys.modules 변화
    "gate_false_non_none_*",   # 게이트 분류: 게이트 거짓인데 None이 아닌 줄(예외)
    "gate_true_none_*",        # 게이트 분류: 게이트 참인데 None인 줄(오탐)
]

# 환경 유래로 기록하되 판정에 넣지 않는 후보 집합 키 패턴.
# 대상 인터프리터의 site-packages·cwd 등이 후보를 바꾼다(TRAP-27).
META_ENV_PATTERNS = [
    "env_*_top_level",
]

# 화이트리스트 밖 필드의 제외 사유. 값이 달라도 판정에 넣지 않는다.
# 여기에 없는 키도 제외한다. 사유는 "화이트리스트 밖"으로 적는다.
META_EXCLUDED_REASONS = {
    "cwd": "실행마다 다른 임시 폴더 경로(기준 값은 이전 세션 scratchpad 경로라 재현 불가)",
    "stdlib_path": "인터프리터 설치 경로(환경 유래)",
    "sys_path": "인터프리터 설치 경로(환경 유래)",
    "python": "인터프리터 빌드 문자열(환경 유래. 버전 게이트는 ptyrepl.py가 한다)",
    "version": "pyodide 패키지 버전 표기(환경 유래. pyodide_version과 같은 값)",
    "pyodide_version": "pyodide 패키지 버전 표기(환경 유래)",
    "note": "고정 안내 문구(측정값 아님)",
    "gate_regex_js": "고정 상수 문자열(측정값 아님)",
}
# 시간 필드(`msPer_*` 등 측정 시간)는 이름 패턴으로 제외한다.
META_EXCLUDED_PATTERNS = {
    "msPer_*": "측정 시간(환경 유래)",
    "*_ms": "측정 시간(환경 유래)",
    "*_at": "타임스탬프(환경 유래)",
    "*time*": "시간 필드(환경 유래)",
}

# 한쪽에 키·원소가 없음을 나타내는 표식. None 값과 구분한다.
MISSING = object()


def escape(seg):
    """JSON 포인터(RFC 6901) 토큰을 이스케이프한다(`~` -> `~0`, `/` -> `~1`)."""
    return str(seg).replace("~", "~0").replace("/", "~1")


def brief(v, limit=70):
    """값을 표 셀용 JSON 문자열로 줄인다. `limit`자를 넘으면 자르고 `…`을 붙인다. `MISSING`은 `(없음)`이다."""
    if v is MISSING:
        return "(없음)"
    s = json.dumps(v, ensure_ascii=False)
    return s if len(s) <= limit else s[: limit - 1] + "…"


def diff(base, regen, path=""):
    """두 JSON 값의 차이를 `(JSON 포인터, 기준값, 재생성값)` 목록으로 돌려준다.

    - 한쪽에만 있는 키·원소는 없는 쪽 값을 `MISSING`으로 둔다.
    - 타입이 다르면 값이 같아 보여도 차이다(bool과 int, int와 float).
    """
    out = []
    if isinstance(base, dict) and isinstance(regen, dict):
        for k in base:
            if k not in regen:
                out.append((f"{path}/{escape(k)}", base[k], MISSING))
            else:
                out += diff(base[k], regen[k], f"{path}/{escape(k)}")
        for k in regen:
            if k not in base:
                out.append((f"{path}/{escape(k)}", MISSING, regen[k]))
    elif isinstance(base, list) and isinstance(regen, list):
        for i in range(max(len(base), len(regen))):
            if i >= len(regen):
                out.append((f"{path}/{i}", base[i], MISSING))
            elif i >= len(base):
                out.append((f"{path}/{i}", MISSING, regen[i]))
            else:
                out += diff(base[i], regen[i], f"{path}/{i}")
    elif type(base) is not type(regen) or base != regen:
        out.append((path or "/", base, regen))
    return out


# `annotate()`가 포인터에서 판정 필드 이름을 고를 때 쓰는 목록.
JUDGEMENT_FIELDS = ("screen", "cursor", "res", "mc", "log", "typed", "typed_cursor", "class", "native_only", "pyodide_only",
                    "native", "pyodide", "class_native", "class_pyodide", "gate_js", "gate_py", "parse_native", "parse_pyodide")


def annotate(pointer):
    """JSON 포인터에서 케이스(첫 토큰)와 판정 필드 이름을 뽑아 `(케이스, 필드)`로 돌려준다. 표 가독성용이다."""
    toks = pointer.split("/")[1:]
    case = toks[0] if toks else ""
    field = next((t for t in toks[1:] if t in JUDGEMENT_FIELDS), "")
    return case.replace("~1", "/").replace("~0", "~"), field


def matches(key, patterns):
    """`key`가 `patterns`의 어느 fnmatch 패턴에든 맞는가(대소문자 구분)."""
    return any(fnmatch.fnmatchcase(key, p) for p in patterns)


def excluded_reason(key):
    """메타 키 `key`가 판정에서 제외되는 사유를 돌려준다. 사유표에 없으면 `화이트리스트 밖`이다."""
    if key in META_EXCLUDED_REASONS:
        return META_EXCLUDED_REASONS[key]
    for p, why in META_EXCLUDED_PATTERNS.items():
        if fnmatch.fnmatchcase(key, p):
            return why
    return "화이트리스트 밖"


def compare_meta(base, regen):
    """메타 JSON을 비교해 `(판정값 차이, 환경 유래 차이)` 두 목록을 돌려준다.

    - 키 이름을 어느 깊이에서든 화이트리스트와 대조한다.
    - 환경 유래 항목은 `(포인터, 기준값, 재생성값, 사유)`다.
    """
    judge, env = [], []

    def walk(b, r, path):
        if isinstance(b, dict) and isinstance(r, dict):
            for k in list(b) + [k for k in r if k not in b]:
                bv, rv = b.get(k, MISSING), r.get(k, MISSING)
                p = f"{path}/{escape(k)}"
                if matches(k, META_JUDGEMENT_PATTERNS):
                    judge.extend(diff(bv, rv, p) if bv is not MISSING and rv is not MISSING else [(p, bv, rv)])
                elif matches(k, META_ENV_PATTERNS):
                    d = diff(bv, rv, p) if bv is not MISSING and rv is not MISSING else [(p, bv, rv)]
                    env.extend((pp, x, y, "환경 전용 최상위 모듈 집합(TRAP-27)") for pp, x, y in d)
                elif isinstance(bv, dict) and isinstance(rv, dict):
                    walk(bv, rv, p)  # native·pyodide 같은 묶음은 안으로 내려가 화이트리스트 키를 고른다
                else:
                    d = diff(bv, rv, p) if bv is not MISSING and rv is not MISSING else [(p, bv, rv)]
                    env.extend((pp, x, y, excluded_reason(k)) for pp, x, y in d)
        else:
            judge.extend(diff(b, r, path))

    walk(base, regen, "")
    return judge, env


def load(path):
    """UTF-8 JSON 파일을 읽는다."""
    with open(path, encoding="utf-8") as f:
        return json.load(f)



def strip_ignored(base, names):
    """기준 JSON의 `res` 배열에서 `names`를 뺀 복사본과 사용 기록을 돌려준다.

    - 기준이 dict가 아니면 그대로 돌려준다.
    - 기록: `removed`(이름별 제거 횟수), `cases`(제거가 일어난 케이스).
    """
    names = set(names)
    removed = {n: 0 for n in names}
    cases = []

    def walk(node, case):
        hit = False
        if isinstance(node, dict):
            out = {}
            for k, v in node.items():
                if k == "res" and isinstance(v, list):
                    kept = [x for x in v if not (isinstance(x, str) and x in names)]
                    for x in v:
                        if isinstance(x, str) and x in names:
                            removed[x] += 1
                    hit = hit or len(kept) != len(v)
                    out[k] = kept
                else:
                    out[k], h = walk(v, case)
                    hit = hit or h
            return out, hit
        if isinstance(node, list):
            items = [walk(x, case) for x in node]
            return [x for x, _ in items], any(h for _, h in items)
        return node, False

    if not isinstance(base, dict):
        return base, {"removed": removed, "cases": cases}
    stripped = {}
    for case, v in base.items():
        stripped[case], hit = walk(v, case)
        if hit:
            cases.append(case)
    return stripped, {"removed": removed, "cases": cases}


def screen_names_in_res(entry, case_data):
    """화면 `entry`(행 목록)의 모든 단어가 그 케이스 `log`의 어느 `res`에든 있는가.

    첫 줄(입력행)과 마지막 `N more...` 줄은 검사에서 뺀다.
    """
    pool = {x for e in case_data.get("log", []) for x in e.get("res", []) if isinstance(x, str)}
    rows = entry[1:]
    if rows and rows[-1].strip().endswith("more..."):
        rows = rows[:-1]
    return all(w in pool for r in rows for w in r.split())


def compare_file(base_path, regen_path, name, ignore=None):
    """파일 한 쌍을 비교해 결과 레코드를 돌려준다.

    - 레코드 키: `name`, `status`, `judgement_diffs`, `env_diffs`, `error`.
    - 제외 옵션을 쓰면 `ignored_baseline_candidates`가 더해진다.
    - `status`: `same`, `judgement-diff`, `error`(파일 없음·JSON 읽기 실패).
    - `name`이 `.meta.json`으로 끝나면 메타 규칙으로 비교한다.
    - `ignore`(제외할 기준 후보 이름 집합)는 본문 JSON에만 적용한다.
    """
    rec = {"name": name, "status": None, "judgement_diffs": [], "env_diffs": [], "error": None}
    if ignore:
        rec["ignored_baseline_candidates"] = {"names": sorted(ignore)}
    for label, p in (("기준", base_path), ("재생성", regen_path)):
        if not os.path.isfile(p):
            rec["status"] = "error"
            rec["error"] = f"{label} 파일 없음: {p}"
            return rec
    try:
        base, regen = load(base_path), load(regen_path)
    except (OSError, ValueError) as e:
        rec["status"] = "error"
        rec["error"] = f"JSON 읽기 실패: {e}"
        return rec
    if name.endswith(".meta.json"):
        judge, env = compare_meta(base, regen)
    elif ignore:
        stripped, used = strip_ignored(base, ignore)
        judge, env = diff(stripped, regen), []
        # 제거가 일어난 케이스의 screen* 차이는 열 배치 차이라 환경 유래로 옮긴다.
        # 가장 긴 후보 이름이 열 폭을 정한다.
        moved, kept = [], []
        for d in judge:
            toks = d[0].split("/")[1:]
            case = toks[0].replace("~1", "/").replace("~0", "~") if toks else ""
            fld = toks[1] if len(toks) > 1 else ""
            if case in used["cases"] and fld.startswith("screen") and isinstance(base.get(case), dict) and isinstance(regen.get(case), dict) \
                    and screen_names_in_res(base[case].get(fld, []), base[case]) and screen_names_in_res(regen[case].get(fld, []), regen[case]):
                moved.append(d)
            else:
                kept.append(d)
        judge = kept
        env = [(pp, x, y, "제외 후보 적용 케이스의 열 배치 차이(가장 긴 후보 이름이 열 폭을 정함)") for pp, x, y in moved]
        unused = sorted(n for n, c in used["removed"].items() if c == 0)
        for n in unused:
            judge.append((f"/(ignore-baseline-candidates)/{escape(n)}", "기준 res에서 제거할 이름", "기준 어디에도 없음(사용되지 않은 제외 이름)"))
        rec["ignored_baseline_candidates"].update({
            "removed_counts": used["removed"], "cases": used["cases"], "unused": unused,
            "screen_diffs_moved_to_env": len(moved),
        })
    else:
        judge, env = diff(base, regen), []
    rec["judgement_diffs"] = [
        {"pointer": p, "case": annotate(p)[0], "field": annotate(p)[1], "baseline": None if b is MISSING else b,
         "regen": None if r is MISSING else r, "baseline_missing": b is MISSING, "regen_missing": r is MISSING}
        for p, b, r in judge
    ]
    rec["env_diffs"] = [
        {"pointer": p, "reason": why, "baseline": None if b is MISSING else b, "regen": None if r is MISSING else r}
        for p, b, r, why in env
    ]
    rec["status"] = "judgement-diff" if judge else "same"
    return rec


def parse_files(specs):
    """`기준이름` 또는 `기준이름=재생성이름` 목록을 `(기준, 재생성)` 짝으로 바꾼다. 재생성 이름을 생략하면 기준과 같다."""
    pairs = []
    for s in specs:
        base, _, regen = s.partition("=")
        pairs.append((base, regen or base))
    return pairs


def print_report(report, max_rows):
    """파일별 한 줄 요약과 판정값·환경 유래 차이 표(앞 `max_rows`건)를 stdout에 낸다."""
    print(f"기준: {report['baseline_dir']}\n재생성: {report['regen_dir']}\n")
    for f in report["files"]:
        tag = {"same": "일치", "judgement-diff": "차이", "error": "오류"}[f["status"]]
        label = f["name"] if f["name"] == f["regen_name"] else f"{f['name']} <- {f['regen_name']}"
        if f["status"] == "error":
            print(f"[{tag}] {label}: {f['error']}")
        else:
            print(f"[{tag}] {label}: 판정값 차이 {len(f['judgement_diffs'])}, 환경 유래 차이 {len(f['env_diffs'])}")
        ig = f.get("ignored_baseline_candidates")
        if ig:
            rc = ig.get("removed_counts")
            extra = f", 제거 횟수 합 {sum(rc.values())}, 적용 케이스 {ig['cases']}, 화면 차이 {ig['screen_diffs_moved_to_env']}건을 환경 유래로 이동" if rc is not None else ""
            print(f"    (기준 후보 제외 옵션 사용: {len(ig['names'])}개 이름 {','.join(ig['names'])}{extra})")
    rows = [(f["name"], "판정", d["pointer"], d["baseline"] if not d["baseline_missing"] else MISSING,
             d["regen"] if not d["regen_missing"] else MISSING) for f in report["files"] for d in f["judgement_diffs"]]
    env_rows = [(f["name"], d["reason"], d["pointer"], d["baseline"], d["regen"]) for f in report["files"] for d in f["env_diffs"]]
    for title, table in (("판정값 차이", rows), ("환경 유래 차이(판정 아님, REGEN.md에 기록)", env_rows)):
        if not table:
            continue
        print(f"\n{title} {len(table)}건" + (f"(앞 {max_rows}건만 표시, 전체는 --json)" if len(table) > max_rows else ""))
        print("| 파일 | 분류/사유 | JSON 포인터 | 기준값 | 재생성값 |\n|---|---|---|---|---|")
        for name, kind, ptr, b, r in table[:max_rows]:
            print(f"| {name} | {kind} | {ptr} | {brief(b)} | {brief(r)} |".replace("\n", "\\n"))
    print(f"\n종료 코드 {report['exit_code']}: " + {0: "판정값 차이 0", 1: "판정값 차이 있음", 2: "실행 오류"}[report["exit_code"]])


def main(argv=None):
    """인자를 검증해 파일 쌍을 비교하고 보고한다. 종료 코드(0·1·2)를 돌려준다.

    `--json`이 있으면 같은 내용을 기계 판독 JSON으로 쓴다.
    """
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("baseline", help="기준 데이터 디렉터리(읽기 전용)")
    ap.add_argument("regen", help="재생성 디렉터리")
    ap.add_argument("--json", dest="json_out", default=None, help="기계 판독용 결과 JSON 경로")
    ap.add_argument("--files", nargs="+", default=None, metavar="NAME[=REGEN_NAME]",
                    help="비교할 파일(기본: rd-016 6파일). 기준과 재생성의 이름이 다르면 기준이름=재생성이름")
    ap.add_argument("--ignore-baseline-candidates", action="append", default=[], metavar="기준파일명=이름,이름,...",
                    help="기준 파일 res 배열에서 뺄 후보 이름(그 파일에만 적용, 반복 가능). 기준 수집 당시 cwd 오염 이름용(TRAP-27)")
    ap.add_argument("--max-rows", type=int, default=60, help="표에 표시할 최대 행 수(--json에는 전부 담는다)")
    args = ap.parse_args(argv)

    for label, d in (("기준", args.baseline), ("재생성", args.regen)):
        if not os.path.isdir(d):
            print(f"오류: {label} 디렉터리가 없다: {d}", file=sys.stderr)
            return 2
    pairs = parse_files(args.files or DEFAULT_FILES)
    ignore = {}
    for spec in args.ignore_baseline_candidates:
        fname, sep, names = spec.partition("=")
        lst = [n for n in names.split(",") if n]
        if not sep or not fname or not lst:
            print(f"오류: --ignore-baseline-candidates 형식은 기준파일명=이름,이름,...이다: {spec!r}", file=sys.stderr)
            return 2
        if fname not in [b for b, _ in pairs]:
            print(f"오류: --ignore-baseline-candidates의 파일이 대상 목록에 없다: {fname}", file=sys.stderr)
            return 2
        ignore.setdefault(fname, set()).update(lst)
    files = []
    for base_name, regen_name in pairs:
        rec = compare_file(os.path.join(args.baseline, base_name), os.path.join(args.regen, regen_name), base_name,
                           ignore.get(base_name))
        rec["regen_name"] = regen_name
        files.append(rec)
    if any(f["status"] == "error" for f in files):
        code = 2
    elif any(f["status"] == "judgement-diff" for f in files):
        code = 1
    else:
        code = 0
    report = {
        "baseline_dir": os.path.abspath(args.baseline),
        "regen_dir": os.path.abspath(args.regen),
        "exit_code": code,
        "files": files,
        "totals": {
            "judgement_diffs": sum(len(f["judgement_diffs"]) for f in files),
            "env_diffs": sum(len(f["env_diffs"]) for f in files),
        },
    }
    print_report(report, args.max_rows)
    if args.json_out:
        os.makedirs(os.path.dirname(os.path.abspath(args.json_out)), exist_ok=True)
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=1)
    return code


if __name__ == "__main__":
    sys.exit(main())
