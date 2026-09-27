"""기준 데이터 디렉터리와 재생성 디렉터리를 정규화 비교한다(RD-025). 표준 라이브러리만 쓴다.

사용:
  python3 compare_baseline.py <기준 디렉터리> <재생성 디렉터리> [--json <출력 JSON>] [--files NAME[=재생성이름] ...] [--max-rows N]
      [--ignore-baseline-candidates 기준파일명=이름,이름,...]

종료 코드
  0  판정값 차이 0(환경 유래 차이는 있어도 된다. 표에 기록만 한다)
  1  판정값 차이 있음(고치려 들지 말고 차이 표를 사용자에게 올린다)
  2  실행 오류(디렉터리·파일 없음, JSON 파싱 실패, 인자 오류)

정규화 규칙
- 본문 JSON: 파싱한 값을 비교한다(키 순서·들여쓰기 무시, 배열 순서는 의미가 있으므로 그대로, bool과 int는 구분).
  본문의 모든 차이가 판정값 차이다: 케이스별 screen·cursor·res·mc·log, 게이트 분류 4종(class_native·class_pyodide 등),
  native_vs_pyodide의 차이 분류(env/zip stdlib/기타)·항목 목록·후보 집합.
- `*.meta.json`: 화이트리스트(META_JUDGEMENT_PATTERNS) 키만 비교한다. 나머지 필드는 값이 달라도 판정에 넣지 않고
  "환경 유래 차이" 표에 기록한다(META_EXCLUDED_REASONS에 사유).
- `env_*_top_level`(환경 전용 최상위 모듈 집합)은 TRAP-27 때문에 환경 유래로 기록한다(META_ENV_PATTERNS).
  단 분류 결과(counts·env/zip stdlib/기타)가 바뀌면 그 차이는 counts와 본문에서 판정값 차이로 따로 잡힌다.
- 기본 대상은 rd-016 6파일이다. rd-015처럼 파일명이 다르면 --files 기준이름=재생성이름 으로 짝지어 준다.
- `--ignore-baseline-candidates 기준파일명=이름,이름,...`(반복 가능): 기준 파일에만 있는 후보 이름을 기준의 `res` 배열에서 빼고
  재생성과 비교한다(기준 데이터 수집 당시 cwd에 있던 파일명이 모듈 후보에 섞인 경우, TRAP-27). 목록은 실행 인자로만 준다.
  * 그 파일에만 적용된다. 이름은 재생성 `res`에서는 빼지 않으므로 재생성에 있으면 차이로 남는다.
  * 기준 파일 어디에서도 빼지 못한 이름은 판정값 차이다(목록이 어긋난 것).
  * `res`를 뺀 케이스의 `screen*` 차이는 후보 열 폭(가장 긴 후보 이름)이 바뀐 열 배치 차이라 재계산할 수 없다.
    그 케이스의 `screen*` 차이는 판정이 아닌 환경 유래 표로 옮기되, 양쪽 화면에 나온 이름이 모두 해당 쪽 `res`의 원소일 때만 옮긴다.
  * 옵션 사용 사실은 출력과 --json(`ignored_baseline_candidates`)에 남는다.
"""
import argparse
import fnmatch
import json
import os
import sys

# rd-016 기준 데이터 6파일(파일명은 기준·재생성이 같아야 한다)
DEFAULT_FILES = [
    "res_import.json",
    "res_import_extra.json",
    "gate_corpus.json",
    "gate_corpus.meta.json",
    "native_vs_pyodide.json",
    "native_vs_pyodide.meta.json",
]

# *.meta.json에서 판정에 넣는 키 이름(어느 깊이든 키 이름으로 매칭, fnmatch). 매칭된 키의 값 전체를 비교한다.
META_JUDGEMENT_PATTERNS = [
    "cases",                   # 케이스 수
    "counts*",                 # counts·counts_by_origin·counts_native·counts_pyodide: 동일·차이·분류(env/zip stdlib/기타)·게이트 분류 4종 개수
    "*_differs*",              # native_vs_pyodide_differs·gate_js_vs_py_differs·result_pkgnone_differs_*: 판정이 갈린 줄 목록
    "sys_modules_*",           # 프로브 전후 sys.modules 변화
    "gate_false_non_none_*",   # 게이트 분류: 게이트 거짓인데 None이 아닌 줄(예외)
    "gate_true_none_*",        # 게이트 분류: 게이트 참인데 None인 줄(오탐)
]

# 환경 유래로 기록하되 판정에 넣지 않는 후보 집합 키(TRAP-27: 대상 인터프리터의 site-packages·cwd 등이 후보를 바꾼다).
META_ENV_PATTERNS = [
    "env_*_top_level",
]

# 화이트리스트 밖 필드가 제외되는 이유(값이 달라도 판정에 넣지 않는다). 여기에 없는 키도 제외되며 사유는 "화이트리스트 밖"으로 적는다.
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
# 시간 필드(msPer_* 등 측정 시간)는 이름 패턴으로 제외한다
META_EXCLUDED_PATTERNS = {
    "msPer_*": "측정 시간(환경 유래)",
    "*_ms": "측정 시간(환경 유래)",
    "*_at": "타임스탬프(환경 유래)",
    "*time*": "시간 필드(환경 유래)",
}

MISSING = object()


def escape(seg):
    """JSON 포인터(RFC 6901) 토큰 이스케이프."""
    return str(seg).replace("~", "~0").replace("/", "~1")


def brief(v, limit=70):
    """표 셀용 짧은 표현."""
    if v is MISSING:
        return "(없음)"
    s = json.dumps(v, ensure_ascii=False)
    return s if len(s) <= limit else s[: limit - 1] + "…"


def diff(base, regen, path=""):
    """(pointer, 기준값, 재생성값) 목록. bool과 int, int와 float는 다른 타입으로 취급한다."""
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


JUDGEMENT_FIELDS = ("screen", "cursor", "res", "mc", "log", "typed", "typed_cursor", "class", "native_only", "pyodide_only",
                    "native", "pyodide", "class_native", "class_pyodide", "gate_js", "gate_py", "parse_native", "parse_pyodide")


def annotate(pointer):
    """포인터에서 케이스(첫 토큰)와 판정 필드 이름을 뽑는다(표 가독성용)."""
    toks = pointer.split("/")[1:]
    case = toks[0] if toks else ""
    field = next((t for t in toks[1:] if t in JUDGEMENT_FIELDS), "")
    return case.replace("~1", "/").replace("~0", "~"), field


def matches(key, patterns):
    return any(fnmatch.fnmatchcase(key, p) for p in patterns)


def excluded_reason(key):
    if key in META_EXCLUDED_REASONS:
        return META_EXCLUDED_REASONS[key]
    for p, why in META_EXCLUDED_PATTERNS.items():
        if fnmatch.fnmatchcase(key, p):
            return why
    return "화이트리스트 밖"


def compare_meta(base, regen):
    """메타 비교: (판정값 차이, 환경 유래 차이) 두 목록을 돌려준다. 키 이름을 어느 깊이에서든 화이트리스트와 대조한다."""
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
                    walk(bv, rv, p)  # native·pyodide 같은 묶음은 안으로 내려가 화이트리스트 키만 고른다
                else:
                    d = diff(bv, rv, p) if bv is not MISSING and rv is not MISSING else [(p, bv, rv)]
                    env.extend((pp, x, y, excluded_reason(k)) for pp, x, y in d)
        else:
            judge.extend(diff(b, r, path))

    walk(base, regen, "")
    return judge, env


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)



def strip_ignored(base, names):
    """기준 JSON의 케이스별 log 항목 `res` 배열에서 names를 뺀 복사본과 사용 기록을 돌려준다.
    기록: removed(이름별 제거 횟수), cases(제거가 일어난 케이스)."""
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
    """화면(첫 줄 입력행·마지막 `N more...` 줄 제외)의 모든 단어가 그 케이스 log의 어느 res에든 있는지."""
    pool = {x for e in case_data.get("log", []) for x in e.get("res", []) if isinstance(x, str)}
    rows = entry[1:]
    if rows and rows[-1].strip().endswith("more..."):
        rows = rows[:-1]
    return all(w in pool for r in rows for w in r.split())


def compare_file(base_path, regen_path, name, ignore=None):
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
        # 제거가 일어난 케이스의 screen* 차이는 열 배치 차이(가장 긴 후보 이름이 열 폭을 정한다)라 환경 유래로 옮긴다
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
    """'기준이름' 또는 '기준이름=재생성이름' 목록을 (기준, 재생성) 짝으로."""
    pairs = []
    for s in specs:
        base, _, regen = s.partition("=")
        pairs.append((base, regen or base))
    return pairs


def print_report(report, max_rows):
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
