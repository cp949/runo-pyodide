/**
 * 컴포넌트 시험 공용 도우미(jsdom 시험 전용). `react-dom/client` + `act` 조합에서 MessagePort 왕복·xterm write 같은 비동기를
 * 기다리는 `until`과, 가짜 `ResizeObserver`·`requestAnimationFrame`을 제공한다.
 */
import { act } from "react";

/** act 환경 플래그. 시험 파일 최상위에서 한 번 부른다. */
export function enableActEnvironment(): void {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
}

/** 조건이 참이 될 때까지 act 안에서 이벤트 루프를 돌린다(회전 수로만 끊는다). */
export async function until(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 2000; turn += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("기다리던 상태가 되지 않았다");
}

/** 가짜 `ResizeObserver`. 만든 인스턴스를 `instances`에 모으고 `trigger()`로 통지를 흉내 낸다. */
export class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly targets: Element[] = [];
  disconnected = false;
  constructor(private readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.targets.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  trigger(): void {
    this.callback();
  }
}

/** 가짜 rAF. `flush()`가 등록된 콜백을 한 번씩 부른다. xterm 자체도 rAF를 쓰므로 시험은 마운트 뒤 `flush()`로 기준을 맞춘다. */
export interface FakeRaf {
  /** 아직 취소·실행되지 않은 콜백 수. */
  pending(): number;
  flush(): void;
}

export function installFakeRaf(
  stub: (name: string, value: unknown) => void,
): FakeRaf {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  stub("requestAnimationFrame", (callback: () => void) => {
    const id = nextId;
    nextId += 1;
    callbacks.set(id, callback);
    return id;
  });
  stub("cancelAnimationFrame", (id: number) => {
    callbacks.delete(id);
  });
  return {
    pending: () => callbacks.size,
    flush() {
      const due = [...callbacks.values()];
      callbacks.clear();
      for (const callback of due) callback();
    },
  };
}
