# Offline UVtools resin-file inspection environment (UVtoolsCmd, no GUI use).
# Building the image is separate from approving any recipe. See ../README.md
# "Reproducible UVtools image".
#
# Reproducibility pins:
#  - base image by digest;
#  - the upstream release zip by URL and SHA-256 (the GitHub release asset digest);
#  - every package that differs from the base installed at an exact version
#    (packages.txt) from snapshot.ubuntu.com at one fixed timestamp;
#  - volatile apt/dpkg state removed and timestamps clamped to SOURCE_DATE_EPOCH.
ARG BASE=ubuntu@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

FROM ${BASE} AS runtime
ARG SNAPSHOT=20261010T000000Z
ARG SOURCE_DATE_EPOCH=1791590400
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}
# snapshot.ubuntu.com redirects to HTTPS and the base has no CA bundle, so peer
# verification is disabled for that host only; apt still verifies the signed
# InRelease files with the base image's Ubuntu archive keyring and every package hash.
RUN --mount=type=bind,source=packages.txt,target=/tmp/packages.txt \
    printf '%s\n' \
      'Acquire::https::snapshot.ubuntu.com::Verify-Peer "false";' \
      'Acquire::Check-Valid-Until "false";' 'Acquire::Retries "5";' \
      > /etc/apt/apt.conf.d/99snapshot \
 && sed -i -e "s#http://archive.ubuntu.com/ubuntu/#https://snapshot.ubuntu.com/ubuntu/${SNAPSHOT}/#" \
      -e "s#http://security.ubuntu.com/ubuntu/#https://snapshot.ubuntu.com/ubuntu/${SNAPSHOT}/#" \
      /etc/apt/sources.list.d/ubuntu.sources \
 && apt-get update \
 && xargs -a /tmp/packages.txt apt-get install --yes --no-install-recommends \
 && mkdir -p /opt/specmate /outputs \
 && dpkg-query -W > /opt/specmate/packages.txt \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt /var/cache/ldconfig/aux-cache \
    /var/cache/debconf/*-old /var/lib/dpkg/*-old /var/log/apt /var/log/dpkg.log \
    /var/log/alternatives.log /etc/apt/apt.conf.d/99snapshot \
 && sed -i -e "s#https://snapshot.ubuntu.com/ubuntu/${SNAPSHOT}/#http://archive.ubuntu.com/ubuntu/#" \
      /etc/apt/sources.list.d/ubuntu.sources \
 && { find / -xdev -newermt "@${SOURCE_DATE_EPOCH}" -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} + 2>/dev/null || true; }

FROM runtime AS extract
ADD --checksum=sha256:bcd47d2d045ff0b8489fd2f7866569521586888c636e2f17603af65a932acb76 \
    https://github.com/sn4k3/UVtools/releases/download/v7.0.0/UVtools_linux-x64_v7.0.0.zip \
    /tmp/uvtools.zip
RUN python3 -I -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' \
      /tmp/uvtools.zip /opt/uvtools \
 && chmod -R u=rwX,go=rX /opt/uvtools \
 && chmod 0755 /opt/uvtools/UVtoolsCmd /opt/uvtools/UVtools \
 && find /opt/uvtools -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

FROM runtime
# A bind mount (not COPY) keeps parent directory timestamps out of the layer.
RUN --mount=type=bind,from=extract,source=/opt/uvtools,target=/mnt/uvtools \
    cp -a /mnt/uvtools /opt/uvtools \
 && printf '%s\n' 'UVtools 7.0.0' 'UVtools_linux-x64_v7.0.0.zip' \
      'sha256:bcd47d2d045ff0b8489fd2f7866569521586888c636e2f17603af65a932acb76' \
      > /opt/specmate/uvtools-release.txt \
 && find /opt -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +
USER 65532:65532
WORKDIR /outputs
