# sde-python: the Python sandbox of the SDE recipes (B2a Task 12). Pinned base (digest written by
# tools/nexus-lock-images.cjs), pytest, build, wheel and setuptools from a hash-pinned lockfile (wheels only, no
# dependency resolution at build time), a non-root user (10001), the Nexus entry. The build self-test fails unless the
# nexus.versions label names exactly the installed python, pytest, build, wheel and setuptools.
FROM docker.io/library/python:3.11-slim-bookworm@sha256:0a310eeecf4e1f5a0743f9a6520c90c88d089c903ca5fd283f501e3a805f5f89
ARG NEXUS_VERSIONS="python=3.11.17 pytest=9.1.1 build=1.6.1 wheel=0.48.0 setuptools=84.0.0"
LABEL nexus.versions="$NEXUS_VERSIONS"
COPY sde-python/requirements.lock /opt/nexus/requirements.lock
RUN python -m pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --only-binary=:all: \
      -r /opt/nexus/requirements.lock \
 && py="$(python -c 'import platform; print(platform.python_version())')" \
 && pt="$(python -c 'import pytest; print(pytest.__version__)')" \
 && bd="$(python -c 'import importlib.metadata as m; print(m.version("build"))')" \
 && wh="$(python -c 'import importlib.metadata as m; print(m.version("wheel"))')" \
 && st="$(python -c 'import importlib.metadata as m; print(m.version("setuptools"))')" \
 && python -m pytest --version \
 && case " $NEXUS_VERSIONS " in *" python=$py pytest=$pt build=$bd wheel=$wh setuptools=$st "*) ;; \
      *) echo "nexus.versions ($NEXUS_VERSIONS) does not name python $py, pytest $pt, build $bd, wheel $wh, setuptools $st" >&2; exit 1 ;; esac
COPY common/nexus-entry /opt/nexus/nexus-entry
RUN chmod 0755 /opt/nexus/nexus-entry \
 && groupadd -g 10001 nexus && useradd -u 10001 -g 10001 -d /home/nexus -M -s /usr/sbin/nologin nexus \
 && mkdir -p /workspace /deps /home/nexus \
 && chown -R 10001:10001 /workspace /deps /home/nexus
USER 10001:10001
WORKDIR /workspace
HEALTHCHECK NONE
ENTRYPOINT ["/opt/nexus/nexus-entry"]
