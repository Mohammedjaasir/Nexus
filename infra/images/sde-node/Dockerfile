# sde-node: the Node sandbox of the SDE recipes (B2a Task 12). Pinned base (digest written by
# tools/nexus-lock-images.cjs), the JUnit reporters from a hash-pinned lockfile (no install scripts), a non-root user
# (10001), the Nexus entry. The build fails unless the nexus.versions label names exactly what is installed.
# B2a stabilization (constraint 5): the image also carries the Nexus egress proxy (egress-proxy.js, Node built-ins only:
# nothing downloaded), run as its own container beside an approved dependency install. It is copied after the reporters'
# install, so that layer (and its network use) is not repeated.
FROM docker.io/library/node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
ARG NEXUS_VERSIONS="node=20.20.2 jest-junit=17.0.0 mocha-junit-reporter=2.2.1"
LABEL nexus.versions="$NEXUS_VERSIONS"
COPY sde-node/reporters/package.json sde-node/reporters/package-lock.json sde-node/reporters/.npmrc /opt/nexus/reporters/
RUN cd /opt/nexus/reporters \
 && npm ci --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force \
 && n="$(node --version)" \
 && j="$(node -p "require('/opt/nexus/reporters/node_modules/jest-junit/package.json').version")" \
 && m="$(node -p "require('/opt/nexus/reporters/node_modules/mocha-junit-reporter/package.json').version")" \
 && case " $NEXUS_VERSIONS " in *" node=${n#v} jest-junit=$j mocha-junit-reporter=$m "*) ;; \
      *) echo "nexus.versions ($NEXUS_VERSIONS) does not name node ${n#v}, jest-junit $j, mocha-junit-reporter $m" >&2; exit 1 ;; esac
COPY common/nexus-entry /opt/nexus/nexus-entry
COPY sde-node/egress-proxy.js /opt/nexus/egress-proxy.js
RUN chmod 0755 /opt/nexus/nexus-entry \
 && chmod 0644 /opt/nexus/egress-proxy.js && node --check /opt/nexus/egress-proxy.js \
 && groupadd -g 10001 nexus && useradd -u 10001 -g 10001 -d /home/nexus -M -s /usr/sbin/nologin nexus \
 && mkdir -p /workspace/node_modules /home/nexus \
 && chown -R 10001:10001 /workspace /home/nexus
USER 10001:10001
WORKDIR /workspace
HEALTHCHECK NONE
ENTRYPOINT ["/opt/nexus/nexus-entry"]
