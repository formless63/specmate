# Offline AVR compiler environment. Build installation is separate from execution approval.
FROM debian:bookworm-slim@sha256:a4672c0cb26fbdde88e38fa2dfb6c681942306680e41e4378b28770b6e79ee91
RUN apt-get update \
 && apt-get install --yes --no-install-recommends \
    python3=3.11.2-1+b1 \
    gcc-avr=1:5.4.0+Atmel3.6.2-3 \
    binutils-avr=2.26.20160125+Atmel3.6.2-4 \
    avr-libc=1:2.0.0+Atmel3.6.2-3 \
 && test "$(avr-gcc -dumpversion)" = 5.4.0 \
 && mkdir -p /opt/specmate \
 && dpkg-query -W > /opt/specmate/packages.txt \
 && rm -rf /var/lib/apt/lists/*
USER 65532:65532
WORKDIR /outputs
