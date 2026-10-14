# Offline AVR compiler environment. Build installation is separate from execution approval.
#
# Reproducibility pins (see README.md "Reproducible build"):
#  - base image by digest;
#  - every package that differs from the base image installed at an exact
#    version from snapshot.debian.org at one fixed timestamp;
#  - volatile apt/dpkg state removed and timestamps clamped to SOURCE_DATE_EPOCH.
FROM debian:bookworm-slim@sha256:a4672c0cb26fbdde88e38fa2dfb6c681942306680e41e4378b28770b6e79ee91
ARG SNAPSHOT=20261010T000000Z
ARG SOURCE_DATE_EPOCH=1791590400
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}
# snapshot.debian.org is plain HTTP here (the slim base has no CA bundle); apt
# verifies the signed Release files with the base image's archive keyring.
RUN printf '%s\n' \
      'Types: deb' \
      "URIs: http://snapshot.debian.org/archive/debian/${SNAPSHOT}/" \
      'Suites: bookworm' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
      '' \
      'Types: deb' \
      "URIs: http://snapshot.debian.org/archive/debian-security/${SNAPSHOT}/" \
      'Suites: bookworm-security' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
      > /etc/apt/sources.list.d/debian.sources \
 && printf '%s\n' 'Acquire::Check-Valid-Until "false";' 'Acquire::Retries "5";' \
      > /etc/apt/apt.conf.d/99snapshot \
 && apt-get update \
 && apt-get install --yes --no-install-recommends \
    avr-libc=1:2.0.0+Atmel3.6.2-3 \
    binutils-avr=2.26.20160125+Atmel3.6.2-4 \
    gcc-avr=1:5.4.0+Atmel3.6.2-3 \
    libexpat1=2.5.0-1+deb12u4 \
    libgssapi-krb5-2=1.20.1-2+deb12u5 \
    libk5crypto3=1.20.1-2+deb12u5 \
    libkeyutils1=1.6.3-2 \
    libkrb5-3=1.20.1-2+deb12u5 \
    libkrb5support0=1.20.1-2+deb12u5 \
    libmpc3=1.3.1-1 \
    libmpfr6=4.2.0-1 \
    libncursesw6=6.4-4 \
    libnsl2=1.3.0-2 \
    libpython3.11-minimal=3.11.2-6+deb12u9 \
    libpython3.11-stdlib=3.11.2-6+deb12u9 \
    libpython3-stdlib=3.11.2-1+b1 \
    libreadline8=8.2-1.3 \
    libsqlite3-0=3.40.1-2+deb12u2 \
    libssl3=3.0.22-1~deb12u1 \
    libtirpc-common=1.3.3+ds-1 \
    libtirpc3=1.3.3+ds-1 \
    media-types=10.0.0 \
    python3.11=3.11.2-6+deb12u9 \
    python3.11-minimal=3.11.2-6+deb12u9 \
    python3=3.11.2-1+b1 \
    python3-minimal=3.11.2-1+b1 \
    readline-common=8.2-1.3 \
 && test "$(avr-gcc -dumpversion)" = 5.4.0 \
 && mkdir -p /opt/specmate /outputs \
 && dpkg-query -W > /opt/specmate/packages.txt \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt /var/cache/ldconfig/aux-cache \
    /var/log/apt /var/log/dpkg.log /var/log/alternatives.log /var/log/apt/* \
    /etc/apt/sources.list.d/debian.sources /etc/apt/apt.conf.d/99snapshot \
 && { find / -xdev -newermt "@${SOURCE_DATE_EPOCH}" -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} + 2>/dev/null || true; }
USER 65532:65532
WORKDIR /outputs
