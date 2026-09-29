# 자식 REPL의 PYTHONSTARTUP 훅. `get_completions` 호출을 기록하고 동작은 바꾸지 않는다.
# RD-015·RD-016 기준 데이터를 만드는 pty 캡처가 쓴다(도구 표는 pty/tools/README.md "도구와 입출력").
#
# 입력(환경변수):
# - `COMPLOG`: 기록 파일 경로. 필수다.
# - `PTY_HOOK_MC`: `1`이면 `mc` 필드를 기록한다. 기본은 꺼짐이다.
#
# 출력: `COMPLOG`에 호출마다 JSON 한 줄 `{stem, buf, pos, res}`를 덧붙인다. 켜면 `mc`가 더해진다.
# 켜는 쪽은 common.fresh()다.
#
# - 가로채는 대상: `_pyrepl.readline.ReadlineAlikeReader.get_completions`.
# - `res`: 최종 후보.
# - `mc`: `get_module_completions()`를 다시 불러 얻은 ModuleCompleter 원시 결과(None / [] / 후보 목록).
#   - `res`만으로는 None 폴백(공백 후보·rlcompleter 결과)과 [] 무동작을 구분할 수 없다.
#   - rd-015 기준 데이터의 log 항목에는 `mc`가 없고 rd-016 기준에는 있다.
#   - 훅 한 벌로 두 데이터를 모두 재생성하려고 `PTY_HOOK_MC`로 조건화했다.
def _install():
    import json, os
    import _pyrepl.readline as rl
    cls = rl.ReadlineAlikeReader
    orig = cls.get_completions
    log = os.environ["COMPLOG"]
    with_mc = os.environ.get("PTY_HOOK_MC") == "1"
    def get_completions(self, stem):
        res = orig(self, stem)
        entry = {"stem": stem, "buf": "".join(self.buffer), "pos": self.pos, "res": res}
        if with_mc:
            try:
                mc = self.get_module_completions()
            except Exception as e:
                mc = "EXC:" + repr(e)
            entry["mc"] = mc
        with open(log, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return res
    cls.get_completions = get_completions
# 훅 함수 이름을 REPL 네임스페이스에 남기지 않는다.
_install()
del _install
