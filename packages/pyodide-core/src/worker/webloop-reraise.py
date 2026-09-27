# WebLoop이 콜백 안에서 난 KeyboardInterrupt·SystemExit을 다시 던져 처리되지 않은 Promise 거부(브라우저 pageerror, node
# unhandledRejection)가 남는 것을 막는다(03-ctrl-c.md 2.8).
#
# pyodide의 WebLoop(run_handle)은 콜백이 KeyboardInterrupt나 SystemExit을 올리면 삼키지 않고 다시 던진다. 사용자에게 보일
# 트레이스백은 Task가 예외를 기록할 때 ConsoleFuture가 이미 표시했으므로 이 재보고에는 정보가 없다. WebLoop은 다시 던지는
# 대신 부를 핸들러 속성을 둔다(기본값 None). 이를 아무 일도 하지 않는 함수로 바꾼다.
# 편차: Task 밖의 콜백(call_later 등)에서 난 KeyboardInterrupt·SystemExit도 조용히 버려진다.
import asyncio

# 고정 버전(`PYODIDE_VERSION`) pyodide의 private 속성이다(webloop.py). 이름이 바뀌면 install()이 건너뛴다.
HANDLERS = ('_keyboard_interrupt_handler', '_system_exit_handler')


def install(report):
    """WebLoop 핸들러 속성을 no-op으로 바꾼다. 없는 속성이 있으면 바꾸지 않고 없는 이름마다 report('webloop-handlers', 이름)을 부른다."""
    loop = asyncio.get_event_loop()
    missing = [name for name in HANDLERS if not hasattr(loop, name)]
    if missing:
        # 일부만 바꾸면 반쪽 동작이 되므로 전부 건너뛴다. 알리는 일은 호출한 쪽(JS)이 report로 받는다.
        for name in missing:
            report('webloop-handlers', name)
        return
    loop._keyboard_interrupt_handler = lambda: None
    loop._system_exit_handler = lambda code: None
