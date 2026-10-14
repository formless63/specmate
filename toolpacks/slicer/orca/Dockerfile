# Offline OrcaSlicer FDM slicing environment. Building the image is separate from
# approving any recipe. See ../README.md "Reproducible OrcaSlicer image".
#
# Reproducibility pins:
#  - base image by digest;
#  - the upstream release AppImage by URL and SHA-256 (the GitHub release asset digest);
#  - every package that differs from the base installed at an exact version
#    (packages.txt) from snapshot.ubuntu.com at one fixed timestamp;
#  - volatile apt/dpkg state and the dbus-generated machine ID removed, and
#    timestamps clamped to SOURCE_DATE_EPOCH.
ARG BASE=ubuntu@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

FROM ${BASE} AS extract
ARG SOURCE_DATE_EPOCH=1791590400
ADD --checksum=sha256:d12fb8c8eac1aecd2dfb6377acd48f994f8fa439ed5292fa532dd82880f029fd \
    https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v2.4.2/OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.4.2.AppImage \
    /tmp/orca.AppImage
# The AppImage runtime extracts its own squashfs without FUSE; nothing else runs.
RUN cd /tmp && chmod 0755 orca.AppImage && ./orca.AppImage --appimage-extract >/dev/null \
 && mv /tmp/squashfs-root /opt/orcaslicer \
 && chmod -R u=rwX,go=rX /opt/orcaslicer \
 && find /opt/orcaslicer -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

FROM ${BASE}
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
 && : > /etc/machine-id && rm -f /var/lib/dbus/machine-id \
 && { find / -xdev -newermt "@${SOURCE_DATE_EPOCH}" -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} + 2>/dev/null || true; }
# A bind mount (not COPY) keeps parent directory timestamps out of the layer.
RUN --mount=type=bind,from=extract,source=/opt/orcaslicer,target=/mnt/orcaslicer \
    cp -a /mnt/orcaslicer /opt/orcaslicer \
 && printf '%s\n' 'OrcaSlicer 2.4.2' \
      'OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.4.2.AppImage' \
      'sha256:d12fb8c8eac1aecd2dfb6377acd48f994f8fa439ed5292fa532dd82880f029fd' \
      > /opt/specmate/orcaslicer-release.txt \
 && find /opt -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +
USER 65532:65532
WORKDIR /outputs
