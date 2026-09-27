/**
 * worker에서 본 main `window` 프록시를 한 겹 감싸, `parent`·`top`·`opener`를 읽으면 명시 오류를 던진다. iframe 안에서 실행할 때
 * 상위 문서로 올라가는 가장 흔한 길을 실수로도 열지 않으려는 장치다. 얕은 차단이다: `window.frames`·`window.self.parent`·
 * `document.defaultView.parent` 같은 우회는 막지 않는다. 보안 경계가 아니다(경계는 iframe sandbox·origin 분리가 맡는다).
 *
 * 감싸는 프록시의 target은 원격 프록시가 아니라 빈 일반 객체다. reflected-ffi 원격 프록시는 자기 target이 비어 있는데도
 * `getOwnPropertyDescriptor`가 실제 창의 설명자를 그대로 돌려준다. 실제 `window.document`·`location`은 비설정(non-configurable)
 * own 속성이라 그 요청은 프록시 불변식 위반(`TypeError: 'getOwnPropertyDescriptor' on proxy: trap reported non-configurability …`)으로
 * 던진다. 원격 프록시를 target으로 삼으면 바깥 Proxy의 `[[Get]]`이 `get` trap 결과를 검사하려고 target(원격 프록시)에 설명자를
 * 묻기 때문에 `get` trap만 있는 감싸기로도 `.document` 읽기가 이 오류로 실패한다(순수 JS `new Proxy(remote, { get: (t, k) =>
 * Reflect.get(t, k) }).document`로 재현, Python에서는 `window.document`가 실패한다: Chromium L1 실측). 그래서 모든 연산을 원격으로
 * 직접 위임하고, 설명자는 원격 설명자를 묻지 않고 값에서 만들어 설정 가능(configurable)한 데이터 설명자로 돌려준다(빈 target에는
 * 없는 속성이라 불변식에 걸리지 않는다). 빈 target을 바꾸는 연산(`defineProperty`·`setPrototypeOf`·`preventExtensions`)은 거부한다:
 * target에 비설정 속성이 생기거나 확장 불가가 되면 뒤의 설명자·나열 요청이 불변식 오류로 영구히 깨진다. Python `setattr`은 `set`
 * 경로라 영향이 없다. `has`는 심볼 키까지 원격에 위임한다: 메서드 호출 때 receiver로 넘어간 이 프록시를 reflected-ffi가 비공개
 * 심볼의 `in` 검사로 원격 창 참조로 되돌려야 main 쪽 `this`가 원본 창이 된다.
 */
const BLOCKED_PROPERTIES: ReadonlySet<string> = new Set([
  "parent",
  "top",
  "opener",
]);

function assertNotBlocked(property: string | symbol): void {
  if (typeof property === "string" && BLOCKED_PROPERTIES.has(property))
    throw new Error(`runo.browser: window.${property} 접근은 막혀 있다`);
}

export function guardedWindow<T extends object>(target: T): T {
  return new Proxy({} as T, {
    get(_, property) {
      assertNotBlocked(property);
      // receiver를 넘기지 않아 접근자의 this가 프록시가 아니라 원본이다(비공개 필드·원격 프록시가 프록시 receiver에 깨지지 않는다).
      return Reflect.get(target, property);
    },
    set: (_, property, value) => Reflect.set(target, property, value),
    has: (_, property) => Reflect.has(target, property),
    deleteProperty: (_, property) => Reflect.deleteProperty(target, property),
    // 차단 대상은 나열에서 뺀다(`Object.keys`·`dir()`이 차단 속성의 설명자 요청으로 던지지 않게 한다).
    ownKeys: () =>
      Reflect.ownKeys(target).filter(
        (key) => typeof key !== "string" || !BLOCKED_PROPERTIES.has(key),
      ),
    getOwnPropertyDescriptor(_, property) {
      // 차단 대상은 설명자 요청으로도 값이 새지 않는다(없는 속성처럼 undefined). 직접 읽기(`get`)만 명시 오류를 던진다.
      if (typeof property === "string" && BLOCKED_PROPERTIES.has(property))
        return undefined;
      if (!Reflect.has(target, property)) return undefined;
      return {
        value: Reflect.get(target, property),
        writable: true,
        enumerable: true,
        configurable: true,
      };
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(target),
    // 빈 target에 속성을 만들지 않는다(비설정 속성이 생기면 뒤의 설명자·나열 요청이 불변식 오류로 깨지고 원격에도 반영되지 않는다).
    defineProperty: () => false,
    // 빈 target의 프로토타입을 바꾸지 않는다(조회는 원격을 따르므로 바꿔도 효과가 없다).
    setPrototypeOf: () => false,
    // 빈 target의 확장 가능 상태를 유지한다(설정 불가 설명자를 만들지 않으므로 불변식과 충돌하지 않는다).
    preventExtensions: () => false,
  });
}
