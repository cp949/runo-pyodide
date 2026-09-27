# TRP-019 잔류 SIGINT가 다음 시험에서 터져 느슨한 단언이 우연히 통과한다

- 상태: ACTIVE
- 적용 조건: 한 파일 안에서 실제 pyodide + interrupt buffer를 공유하며 취소·중단 시험을 연달아 돌릴 때. 특히 `expect(stderr).toMatch(/KeyboardInterrupt\n$/)`처럼 **예외 종류만** 보는 단언.

## 오해하기 쉬운 신호

- 변이를 넣었는데 해당 시험이 **통과**한다. 실측(RD-008 변이 M3, `checkInterrupt` → `signalInterrupt` 순서 뒤집기): 7건이 죽는 와중에 "`sys.stdin.readline()` 취소도 같은 `KeyboardInterrupt`다"와 "`for line in sys.stdin` 취소도 같은 `KeyboardInterrupt`다" 2건은 통과했다.
- killed 건수만 세면 "이 시험은 검출력이 있다"고 잘못 읽는다. 실제로는 그 시험이 오염된 상태에서 통과한 것이다.
- 시험 하나만 따로 돌리면 실패한다(파일 전체를 돌릴 때만 통과한다).

## 원인

SIGINT를 쓰고 소비하지 않으면 버퍼에 2가 남는다. 남은 값은 **다음 문장·다음 시험**의 엉뚱한 지점에서 터진다. 실측 트레이스백에 `File "<frozen codecs>", line 325, in decode` 프레임이 끼어들었다(`input()` 호출 지점이 아니다). 뒤 시험은 자기가 낸 취소로 오인하고 `KeyboardInterrupt`만 확인하므로 통과한다.

## 탐지/회피

- 취소·중단 시험은 **트레이스백 전체**를 고정한다(`toBe(CONSOLE_TRACEBACK)`). 종류만 보는 `toMatch`는 보조 단언으로만 쓴다.
- 시험마다 잔류를 직접 단언한다(`expect(Atomics.load(buffer, SIGNAL)).toBe(0)`).
- `afterEach`에서 버퍼를 떼고 `discardPendingInterrupt`한 뒤 Python 핸들러를 기본으로 되돌린다.
- 변이 결과를 killed 건수로 읽지 않는다. 죽은 시험을 **이름으로** 대조하고, 죽지 않은 시험은 "그 변이의 검출자가 아니다"가 아니라 "오염된 상태에서 통과했다"일 수 있다고 본다.
