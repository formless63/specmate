# Offline FDM slicer environment. Building the image is separate from approving any recipe.
FROM debian:bookworm-slim@sha256:a4672c0cb26fbdde88e38fa2dfb6c681942306680e41e4378b28770b6e79ee91
RUN apt-get update \
 && apt-get install --yes --no-install-recommends \
    python3=3.11.2-1+b1 \
    prusa-slicer=2.5.0+dfsg-4 \
 && test "$(dpkg-query -W -f='${Version}' prusa-slicer)" = 2.5.0+dfsg-4 \
 && mkdir -p /opt/specmate \
 && dpkg-query -W > /opt/specmate/packages.txt \
 && rm -rf /var/lib/apt/lists/*
USER 65532:65532
WORKDIR /outputs
