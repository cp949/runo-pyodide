/**
 * 부트스트랩 관찰기 시험. coincident가 worker 전역에서 받는 부트스트랩 메시지(배열)가 도착했는지만 기록한다.
 *
 * - coincident 리스너는 `stopImmediatePropagation()`으로 메시지를 삼킨다.
 * - 그래서 관찰기는 그보다 **먼저 등록**돼야 메시지를 본다. 성립 조건은 등록 순서다.
 * - 캡처 단계로 순서를 피하는 방식은 Chromium worker 전역에서 성립하지 않았다.
 * - 관찰기는 메시지를 소비하지 않는다.
 *
 * jsdom DOM 노드에 `message` 이벤트를 보내 "같은 대상의 리스너는 등록 순서대로 호출된다"를 시험한다.
 * 실제 worker 전역에서의 성립은 브라우저(L1)로만 확인한다.
 */
import { describe, expect, test } from "vitest";
import { createBootstrapObserver } from "../src/bootstrap-observer";

/** 이벤트를 받을 jsdom 노드. worker 전역 대신 쓴다. */
function createTarget() {
  return document.createElement("div");
}

/** `target`에 `message` 이벤트를 보내고 이벤트를 돌려준다. `defaultPrevented` 확인용으로 취소 가능하게 만든다. */
function send(target: EventTarget, data: unknown) {
  const event = new MessageEvent("message", { data, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("createBootstrapObserver", () => {
  test("메시지가 오기 전에는 수신 기록이 없다", () => {
    const observer = createBootstrapObserver(createTarget());

    expect(observer.received).toBe(false);
  });

  test("배열 메시지(부트스트랩)가 오면 수신으로 기록한다", () => {
    const target = createTarget();
    const observer = createBootstrapObserver(target);

    send(target, ["uid", false, -1]);

    expect(observer.received).toBe(true);
  });

  test("core init 프레임 같은 객체 메시지·문자열은 부트스트랩으로 세지 않는다", () => {
    const target = createTarget();
    const observer = createBootstrapObserver(target);

    send(target, { kind: "init" });
    send(target, "문자열");
    send(target, null);

    expect(observer.received).toBe(false);
  });

  test("메시지를 소비하지 않는다(뒤 리스너가 호출되고 기본 동작도 취소되지 않는다)", () => {
    const target = createTarget();
    createBootstrapObserver(target);
    const later: unknown[] = [];
    target.addEventListener("message", (event) =>
      later.push((event as MessageEvent).data),
    );

    const event = send(target, ["uid", false, -1]);

    expect(later).toEqual([["uid", false, -1]]);
    expect(event.defaultPrevented).toBe(false);
  });

  test("나중에 걸린 리스너(coincident)가 stopImmediatePropagation을 불러도, 먼저 등록된 관찰기는 메시지를 본다", () => {
    const target = createTarget();
    const observer = createBootstrapObserver(target);
    // coincident가 하는 일: 부트스트랩 리스너가 관찰기보다 나중에 등록돼 메시지를 삼킨다.
    let coincidentCalls = 0;
    target.addEventListener("message", (event) => {
      coincidentCalls += 1;
      event.stopImmediatePropagation();
      event.preventDefault();
    });

    send(target, ["uid", false, -1]);

    expect(observer.received).toBe(true);
    expect(coincidentCalls).toBe(1);
  });

  test("삼키는 리스너보다 뒤에 등록된 관찰기는 메시지를 보지 못한다(등록 순서가 성립 조건이다)", () => {
    const target = createTarget();
    target.addEventListener("message", (event) => {
      event.stopImmediatePropagation();
    });
    const observer = createBootstrapObserver(target);

    send(target, ["uid", false, -1]);

    expect(observer.received).toBe(false);
  });

  test("캡처 옵션 없이 일반 리스너로 등록한다(캡처 단계는 순서 보장이 아니다)", () => {
    const calls: Array<unknown[]> = [];
    createBootstrapObserver({
      addEventListener: (...args: unknown[]) => calls.push(args),
    } as never);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("message");
    expect(calls[0]).toHaveLength(2);
  });

  test("한 번 받은 뒤에도 리스너가 남아 이후 메시지에 영향을 주지 않는다", () => {
    const target = createTarget();
    const observer = createBootstrapObserver(target);

    send(target, ["uid", false, -1]);
    send(target, { kind: "init" });

    expect(observer.received).toBe(true);
  });
});
