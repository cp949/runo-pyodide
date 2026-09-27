import type { RpcHandlers } from "./rpc";

/**
 * 핸들러 표 여러 개를 하나로 합친다. 이름이 겹치면 생성 시 예외로 알린다 — 조용히 덮어쓰면 core 핸들러를 driver가
 * 가로채도 시험이 통과한다. RPC는 생성 시점에 핸들러를 받으므로(늦은 등록 없음) 합성도 그때 한 번이다.
 */
export function composeRpcHandlers(...tables: RpcHandlers[]): RpcHandlers {
  const merged: RpcHandlers = {};
  for (const table of tables) {
    for (const [name, handler] of Object.entries(table)) {
      if (Object.hasOwn(merged, name)) {
        throw new Error(`RPC 핸들러 이름이 겹친다: ${name}`);
      }
      merged[name] = handler;
    }
  }
  return merged;
}
