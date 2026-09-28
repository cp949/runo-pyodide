# 구버전 Chromium 실측용(DELTA-06, design.md D5). Debian snapshot.debian.org에 고정된 특정
# chromium 버전을 설치해 headless로 CDP 포트만 연다 — 컨테이너 안에는 Playwright도 node도
# 두지 않는다(호스트 node 스크립트가 `chromium.connectOverCDP()`로 붙는다). 참고(읽기 전용):
# `/work/cp949/geul/docker/chrome83/Dockerfile` — 그 이미지는 컨테이너 안에서 Playwright
# launch를 쓰므로 node·pnpm을 함께 넣지만, 이 이미지는 CDP 연결만 필요해 그 부분을 뺐다.
#
# `debian:buster-slim` 베이스 + `sources.list`를 snapshot으로 바꾸는 방식(geul chrome83과
# 동일)을 먼저 시도했으나 chromium 84.0.4147.105-1이 buster의 `libc6`(2.28)보다 새로운
# `libc6 (>= 2.29)`를 요구해 실패했다(실측: `apt-get install`이 "unmet dependencies" 다수 —
# libc6를 포함한 필수 패키지를 통째로 못 올려 연쇄 실패). 93·97도 같은 부류 문제가 생길 수
# 있어(비교 대상 buster의 `libc6`은 최초 안정화(2019) 이후 버전이 안 올라가는데, chromium은 그 뒤 버전들)
# 세 버전 모두 `debootstrap`으로
# **그 snapshot 시각의 unstable 자체를 루트 파일시스템으로 새로 만드는** 방식으로 바꿨다 —
# base 이미지의 낡은 core 패키지와 섞이지 않는다.
#
# SNAPSHOT_TIME은 버전별로 다르다: `https://snapshot.debian.org/mr/binary/chromium/<버전>/binfiles`
# → hash → `/mr/file/<hash>/info`의 `first_seen`. 단, chromium 84.0.4147.105-1은 그 시각의
# unstable이 아니라 experimental에만 있었다(실측, `snapshot.debian.org/package/chromium/84.0.4147.105-1/`
# — 당시 84~89 계열은 experimental 전용). 93·97은 같은 시각 unstable에 바로 있다.

FROM debian:bookworm-slim AS bootstrap
RUN apt-get update && apt-get install -y --no-install-recommends debootstrap ca-certificates && rm -rf /var/lib/apt/lists/*

ARG SNAPSHOT_TIME
RUN test -n "$SNAPSHOT_TIME"
RUN debootstrap --variant=minbase --no-check-gpg unstable /target \
  "http://snapshot.debian.org/archive/debian/${SNAPSHOT_TIME}"

FROM scratch
COPY --from=bootstrap /target/ /

ARG SNAPSHOT_TIME
ARG CHROMIUM_VERSION
RUN test -n "$SNAPSHOT_TIME" && test -n "$CHROMIUM_VERSION"

RUN set -eux; \
    { \
      echo "deb [check-valid-until=no trusted=yes] http://snapshot.debian.org/archive/debian/${SNAPSHOT_TIME} unstable main"; \
      echo "deb [check-valid-until=no trusted=yes] http://snapshot.debian.org/archive/debian/${SNAPSHOT_TIME} experimental main"; \
    } > /etc/apt/sources.list; \
    printf 'Acquire::Check-Valid-Until "false";\nAcquire::Retries "5";\n' > /etc/apt/apt.conf.d/99snapshot; \
    # experimental 기본 pin priority(1)는 명시 버전 지정 없이 딸려 오는 chromium의 의존 패키지(chromium-common
    # 등)를 unstable 쪽으로 끌어당긴다(실측: "chromium-common (= 84...) but 83...이 설치 대상"). 84가
    # experimental 전용이라 이 pin이 필요하다. `chromium*`로 좁힌다 — experimental에 이 시각 다른 패키지가
    # 얹혀 있어도(실측: 84 이미지에 `libwayland-*1.18.0-2~exp1.1`이 experimental에서 들어옴, opus 리뷰 확인)
    # 이 pin이 그것까지 끌어올리지 않는다. experimental에 없는 패키지는 그대로 unstable에서 온다.
    printf 'Package: chromium*\nPin: release a=experimental\nPin-Priority: 990\n' > /etc/apt/preferences.d/experimental; \
    apt-get update; \
    # dbus-x11을 먼저 설치해 apt 리졸버가 default-dbus-session-bus 가상 패키지의 provider를
    # dbus-x11로 먼저 고정하게 한다(geul chrome83 Dockerfile과 같은 이유 — 순서를 바꾸면
    # libgtk-3-0이 걸려 chromium 설치가 막힌다).
    apt-get install -y --no-install-recommends dbus-x11; \
    apt-get install -y --no-install-recommends "chromium=${CHROMIUM_VERSION}"; \
    rm -rf /var/lib/apt/lists/*

# `--no-sandbox`: 컨테이너 안 uid 0(추가 유저를 만들지 않는다 — 이 이미지는 실측 1회용이라
# root sandbox 회피가 실제 브라우저 프로세스 권한보다 우선한다). `--headless`는 버전마다
# 인자 이름이 같다(84~97 전부 `--headless`, `--headless=new`는 Chrome 109+에만 있다).
ENTRYPOINT ["chromium", "--headless", "--no-sandbox", "--disable-gpu", \
  "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9222"]
