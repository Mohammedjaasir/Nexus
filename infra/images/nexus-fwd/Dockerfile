# nexus-fwd: the loopback forwarder of dev deployments (B2a Task 12). Pinned base (digest written by
# tools/nexus-lock-images.cjs), one pinned package (socat), a non-root user, the Nexus entry. No healthcheck: the runner
# probes the app through it.
# B2a final review B7: socat is pinned by version AND by the sha256 of its .apk, recorded in infra/images/lock.json
# (profiles.nexus-fwd.packages.socat.apkSha256) and written here as the SOCAT_APK_SHA256 default by
# `node tools/nexus-lock-images.cjs --pin-apk socat=<sha256>` (the Alpine APKINDEX is outside the approved network, so the
# value is recorded at verification). The build fetches the .apk, checks it, and installs only that file; with no
# recorded hash it refuses loudly.
FROM docker.io/library/alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
ARG NEXUS_VERSIONS="alpine=3.20 socat=1.8.0.0-r0"
ARG SOCAT_APK_SHA256=""
LABEL nexus.versions="$NEXUS_VERSIONS"
RUN case "$SOCAT_APK_SHA256" in \
      ''|*[!0-9a-f]*) echo "nexus-fwd: the socat .apk sha256 is not pinned (infra/images/lock.json packages.socat.apkSha256 via --pin-apk); refusing an unverified package" >&2; exit 1 ;; esac \
 && [ "${#SOCAT_APK_SHA256}" -eq 64 ] || { echo "nexus-fwd: SOCAT_APK_SHA256 is not a sha256" >&2; exit 1; } \
 && mkdir -p /tmp/nexus-apk \
 && apk fetch --no-cache -o /tmp/nexus-apk socat=1.8.0.0-r0 \
 && echo "$SOCAT_APK_SHA256  /tmp/nexus-apk/socat-1.8.0.0-r0.apk" | sha256sum -c - \
 && apk add --no-cache /tmp/nexus-apk/socat-1.8.0.0-r0.apk \
 && rm -rf /tmp/nexus-apk \
 && addgroup -g 10001 nexus && adduser -u 10001 -G nexus -H -D -s /sbin/nologin nexus \
 && mkdir -p /home/nexus && chown 10001:10001 /home/nexus \
 && v="$(apk info -v socat 2>/dev/null | head -n 1)" \
 && case " $NEXUS_VERSIONS " in *" socat=${v#socat-} "*) ;; *) echo "nexus.versions does not name the installed $v" >&2; exit 1 ;; esac
COPY nexus-fwd/fwd-entry /opt/nexus/fwd-entry
RUN chmod 0755 /opt/nexus/fwd-entry
USER 10001:10001
HEALTHCHECK NONE
ENTRYPOINT ["/opt/nexus/fwd-entry"]
