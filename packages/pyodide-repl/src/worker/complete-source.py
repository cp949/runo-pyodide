import warnings
from zipimport import zipimporter

# 3.14 `_pyrepl`의 import/from 줄 완성기. 모듈 로드 시 1회 가져온다. try/except로 감싸지 않는다: 이름이 바뀌거나 없어지면
# `loadCompleteSource`가 던져 부팅이 실패한다(조용히 기능이 빠지는 것보다 낫다, TRAP-10).
from _pyrepl._module_completer import ModuleCompleter

# pyodide 내부에서 쓰는 이름(모듈·인스턴스 변수)이 후보에 섞여 나오는 것을 막는다.
INTERNAL_PREFIXES = ('_pyodide', '___')

# 스템이 빈 곳에 넣는 공백의 탭 정지 간격. 3.14 `_pyrepl`과 main의 `planTab`이 쓰는 값과 같다.
TAB_STOP = 4


class ZipStdlibModuleCompleter(ModuleCompleter):
    """pyodide의 zip stdlib(`/lib/python314.zip`)를 stdlib로 인정하는 `ModuleCompleter`.

    원본 `_is_stdlib_module`은 `FileFinder`만 stdlib로 보므로 zipimporter 아래 stdlib 패키지의 HARDCODED_SUBMODULES
    (`collections.abc` 등)가 빠져 `import collections.a` 같은 줄이 `[]`가 된다. 이 판정만 오버라이드한다.
    """

    def _is_stdlib_module(self, module_info):
        finder = module_info.module_finder
        return super()._is_stdlib_module(module_info) or (
            isinstance(finder, zipimporter) and finder.archive == self._stdlib_path
        )


def complete_source(console, source, pending=None):
    """`source` 끝(커서 자리)의 Tab 후보 `(목록, start)`를 돌려준다. `start`는 Python `str` 인덱스(코드포인트)다.

    판정 순서는 3.14 `_pyrepl/readline.py`의 `get_completions`와 같다.
    1. 모듈 완성기: `pending`(`... ` 블록의 이전 줄들)을 `\\n`으로 앞에 붙인 텍스트를 넣는다. 결과가 `None`이 아니면
       `[]`도 최종이다(이름 완성으로 폴백하면 `from os import pa`가 `pass`가 된다). 내부 이름만 빼고 정렬하지 않는다.
    2. 모듈 판정이 `None`이고 스템이 비면 공백 후보 하나(`start = len(source)`).
    3. 그 외는 `console.complete`(이름·속성 완성)를 후처리한다: 경고 억제, 전체 정렬, 내부 이름 제외.

    속성 완성은 사용자 `__getattr__`/`__dir__`을 실행해 임의 예외가 나올 수 있다 — 모듈 분기와 함께 같은 `try` 안에서
    `except Exception`으로 삼키고 빈 결과를 돌려준다. `KeyboardInterrupt`는 `BaseException`이라 잡히지 않고 그대로 전파된다
    (호출부가 `PythonError`로 받는다).
    """
    try:
        # 스템 시작 자리는 console.complete()와 같은 구분자 집합으로 구한다(집합을 복제하지 않는다). pending은 start에 영향이 없다.
        start = max(map(source.rfind, console.completer_word_break_characters)) + 1
        # 모듈 완성은 `... ` 블록의 이전 줄까지 본다. 3.14는 여러 줄 버퍼 전체를 넘긴다.
        line = pending + '\n' + source if pending else source
        # 호출마다 새 인스턴스를 만든다. 인스턴스가 모듈 목록을 캐시해서 재사용하면 loadPackage·micropip 뒤에 설치된 패키지를 놓친다.
        modules = ZipStdlibModuleCompleter().get_completions(line)
        if modules is not None:
            # 판정이 있으면 [](무동작)도 최종이다. ModuleCompleter 순서를 그대로 둔다.
            modules = [c for c in modules if not c.startswith(INTERNAL_PREFIXES)]
            return (modules, start) if modules else ([], 0)
        if start == len(source):
            # 스템이 비었다. 열은 현재 줄 안 위치이고 프롬프트를 세지 않으며 `\t`도 1로 센다.
            column = len(source) - (source.rfind('\n') + 1)
            return [' ' * (TAB_STOP - column % TAB_STOP)], len(source)
        with warnings.catch_warnings():
            # 속성 접근이 DeprecationWarning 등을 낼 수 있다. 완성 계산 중에는 경고를 stderr로 흘리지 않는다.
            warnings.simplefilter('ignore')
            completions, start = console.complete(source)
    except Exception:
        return [], 0
    completions = [c for c in completions if not c.startswith(INTERNAL_PREFIXES)]
    # pyodide는 attr 후보만 정렬한다. 이름 후보는 키워드 → 전역 → builtins 순이라 3.14처럼 전체를 정렬한다.
    return sorted(completions), start
