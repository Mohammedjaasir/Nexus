# nexus-fwd: the loopback forwarder of dev deployments (B2a Task 12). Pinned base (digest written by
# tools/nexus-lock-images.cjs), one pinned package (socat), a non-root user, the Nexus entry. No healthcheck: the runner
# probes the app through it.
FROM docker.io/library/alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
ARG NEXUS_VERSIONS="alpine=3.20 socat=1.8.0.0-r0"
LABEL nexus.versions="$NEXUS_VERSIONS"
RUN apk add --no-cache socat=1.8.0.0-r0 \
 && addgroup -g 10001 nexus && adduser -u 10001 -G nexus -H -D -s /sbin/nologin nexus \
 && mkdir -p /home/nexus && chown 10001:10001 /home/nexus \
 && v="$(apk info -v socat 2>/dev/null | head -n 1)" \
 && case " $NEXUS_VERSIONS " in *" socat=${v#socat-} "*) ;; *) echo "nexus.versions does not name the installed $v" >&2; exit 1 ;; esac
COPY nexus-fwd/fwd-entry /opt/nexus/fwd-entry
RUN chmod 0755 /opt/nexus/fwd-entry
USER 10001:10001
HEALTHCHECK NONE
ENTRYPOINT ["/opt/nexus/fwd-entry"]
