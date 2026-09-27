/**
 * 전역 stdout/stderr용 pyodide `Writer`(05-output.md 4.2, TRAP-01). 콘솔 리다이렉트 밖(프롬프트 대기 중 배경 콜백,
 * asyncio 예외 로그, 패키지 로딩 메시지)의 출력을 바이트 단위로 받아 콘솔 콜백과 같은 sink로 보낸다.
 * `pyodide`를 import하지 않는다(타입도 자체 선언).
 */

/** pyodide `setStdout`/`setStderr`에 넘기는 Writer의 부분집합. `isatty`는 주지 않는다(기본 false, 전역 스트림은 이미 line-buffered). */
export interface SinkWriter {
  write(buffer: Uint8Array): number;
}

/** 전역 스트림용 Writer. `sink`는 세션 sink의 `write` 또는 `writeErrorRaw`(worker에서는 RPC `notify` 래퍼). */
export function createSinkWriter(sink: (text: string) => void): SinkWriter {
  // 잘린 글자 상태는 Writer마다 따로 둔다(stdout·stderr가 공유하면 서로의 조각이 섞인다).
  const decoder = new TextDecoder();
  return {
    write(buffer) {
      const text = decoder.decode(buffer, { stream: true });
      // 잘린 글자만 도착한 조각은 아직 내보낼 텍스트가 없다.
      if (text !== "") sink(text);
      // 0을 돌려주면 호출한 쪽이 같은 바이트를 다시 쓴다.
      return buffer.length;
    },
  };
}
