# TRP-010 `sys.stdin.read(n)`이 남긴 줄 끝 `\n`이 다음 읽기를 콜백 없이 채운다

- 상태: ACTIVE
- 적용 조건: 같은 pyodide 인스턴스에서 `sys.stdin.read(n)`처럼 줄 일부만 읽는 경로를 쓴 뒤 다시 `input()`·`readline()`·`readlines()`로 읽을 때. stdin 콜백 각본 시험이 인스턴스를 시험 사이에 공유할 때, 사용자 세션에서 `read(n)` 뒤 `input()`을 부를 때. `setStdin`을 다시 걸어도 마찬가지다.

## 오해하기 쉬운 신호

- 다음 읽기가 오류 없이 돌아온다. `readline()`이 `"\n"`, `input()`이 `""`, `readlines(1)`이 `["\n", "abc\n"]`을 돌려주고 stdin 콜백은 불리지 않는다(`readInput` 알림도 없다). 각본 시험에서는 "각본 줄이 하나 남았다"·"콜백을 덜 불렀다"로 보여 콜백 구현 결함처럼 읽힌다.
- 1글자 줄 각본에서는 반대로 `read(3)`이 콜백을 2번 부른다(`"1\n"`이 3글자에 모자라 다음 줄까지 읽는다).

## 원인

`pyodide.setStdin`은 `sys.stdin` 객체를 그대로 두고(`id(sys.stdin)` 동일 확인, pyodide 314.0.7) `TextIOWrapper`는 읽어 온 청크의 나머지를 자기 버퍼에 보관한다. `read(3)`은 `"abc\n"`에서 3글자만 돌려주고 `\n`을 남긴다. 표준 CPython 동작이다: 파이프 stdin(CPython 3.12.4)에서 `printf 'abc\ndef\n' | python3 -c "import sys; print(repr(sys.stdin.read(3)), repr(sys.stdin.readline()))"`가 `'abc' '\n'`을 낸다.

## 탐지/회피

- 시험: `afterEach`에서 `sys.stdin = open(0, encoding="utf-8", closefd=False)`로 새 스트림을 끼운다(읽기 경로 동작은 스톡과 같다). 한 시험 안에서는 `read(n)`을 마지막 경로로 둔다.
- 탐지: 콜백 호출 수가 소비한 줄 수보다 1 적으면 앞 경로가 남긴 `\n`을 의심한다.
- 앱: 사용자가 `sys.stdin.read(n)` 뒤 `input()`을 부르면 첫 `input()`이 즉시 `""`이다. 표준 `TextIOWrapper` 동작이라 편차로 등록하지 않았다(확인은 CPython 3.12.4 파이프 stdin까지이고 3.14 tty는 직접 확인하지 않았다).
