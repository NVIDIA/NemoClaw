# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# LangChain Deep Agents Code sandbox image.

# NemoClaw staging supplies a resolved base image reference. Direct Docker builds
# must pass --build-arg BASE_IMAGE=... rather than falling back to a mutable tag.
ARG BASE_IMAGE
ARG NEMOCLAW_CORPORATE_CA_B64=

FROM node:22-trixie-slim@sha256:e6d9a389d34ff9678438af985c9913fbd1eb6ed36e80fea56644f4b4f6dd70ba AS mcp-tool-discovery-runtime
ARG NEMOCLAW_CORPORATE_CA_B64
ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /opt/mcp-tool-discovery-runtime
COPY tools/mcp-tool-discovery-runtime/package.json tools/mcp-tool-discovery-runtime/package-lock.json tools/mcp-tool-discovery-runtime/tsconfig.json tools/mcp-tool-discovery-runtime/install-reviewed-runtime.sh tools/mcp-tool-discovery-runtime/*.ts ./
RUN ./install-reviewed-runtime.sh \
    && rm -f ./install-reviewed-runtime.sh
RUN chown -R root:root /opt/mcp-tool-discovery-runtime \
    && chmod -R a=rX /opt/mcp-tool-discovery-runtime

# hadolint ignore=DL3006
FROM ${BASE_IMAGE}

COPY --from=mcp-tool-discovery-runtime /opt/mcp-tool-discovery-runtime/dist/ /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime/
RUN discovery_contract="$(node /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime/mcp-tool-discovery.mjs)" \
    && node -e 'const result = JSON.parse(process.argv[1]); if (result.protocol !== 1 || result.ok !== false || result.detail !== "tool discovery received invalid runtime arguments") process.exit(1);' "$discovery_contract" \
    && discovery_unsafe="$(find -L /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime \( ! -user root -o -perm /022 \) -print -quit)" \
    && test -z "$discovery_unsafe"

USER root

COPY scripts/lib/reviewed-npm-archive.mts /scripts/lib/reviewed-npm-archive.mts
COPY scripts/patch-bundled-npm-brace-expansion.mts /scripts/patch-bundled-npm-brace-expansion.mts
COPY scripts/patch-bundled-npm-tar.mts /scripts/patch-bundled-npm-tar.mts

# The final managed image owns the shipped dependency boundary independently
# of base freshness. Reassert the idempotent npm-private node-tar fix here.
RUN node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts \
    --npm-root /usr/local/lib/node_modules/npm

# Reassert the npm-private brace-expansion fix for the exact final filesystem.
# hadolint ignore=DL3059
RUN node --experimental-strip-types /scripts/patch-bundled-npm-brace-expansion.mts \
    --npm-root /usr/local/lib/node_modules/npm

RUN set -eu; \
    dcode_path="$(command -v dcode 2>/dev/null || true)"; \
    if [ "$dcode_path" != "/usr/local/bin/dcode" ]; then \
        echo "ERROR: expected dcode at /usr/local/bin/dcode, got ${dcode_path:-missing}" >&2; \
        exit 1; \
    fi; \
    test -x /usr/local/bin/dcode; \
    /usr/local/bin/dcode --version

# Copy config generator, wrapper, startup script, and shared blueprint files.
COPY agents/langchain-deepagents-code/generate-config.ts /opt/nemoclaw-deepagents-code/generate-config.ts
COPY agents/langchain-deepagents-code/managed-dcode-runtime.py /opt/nemoclaw-deepagents-code/managed-dcode-runtime.py
COPY agents/langchain-deepagents-code/patch-managed-deepagents-code.py /opt/nemoclaw-deepagents-code/patch-managed-deepagents-code.py
# SECURITY: copy only the two hash-verified plugin inputs, never the source directory.
COPY agents/langchain-deepagents-code/profile-plugin/pyproject.toml /opt/nemoclaw-deepagents-profile-plugin/
COPY agents/langchain-deepagents-code/profile-plugin/src/nemoclaw_deepagents_profile/__init__.py /opt/nemoclaw-deepagents-profile-plugin/src/nemoclaw_deepagents_profile/
COPY agents/langchain-deepagents-code/validate-nemotron-ultra-profile.py /opt/nemoclaw-deepagents-code/validate-nemotron-ultra-profile.py
COPY agents/langchain-deepagents-code/progressive_tool_disclosure.py /opt/nemoclaw-deepagents-code/progressive_tool_disclosure.py
COPY agents/langchain-deepagents-code/nemoclaw_observability.py /opt/nemoclaw-deepagents-code/nemoclaw_observability.py
COPY agents/langchain-deepagents-code/validate-progressive-tool-disclosure.py /opt/nemoclaw-deepagents-code/validate-progressive-tool-disclosure.py
COPY agents/langchain-deepagents-code/validate-observability.py /opt/nemoclaw-deepagents-code/validate-observability.py
COPY agents/langchain-deepagents-code/dcode-wrapper.sh /usr/local/lib/nemoclaw/dcode-wrapper.sh
COPY agents/langchain-deepagents-code/dcode-launcher.sh /usr/local/lib/nemoclaw/dcode-launcher.sh
COPY agents/langchain-deepagents-code/dcode-session-supervisor.py /usr/local/lib/nemoclaw/dcode-session-supervisor.py
COPY agents/langchain-deepagents-code/start.sh /usr/local/bin/nemoclaw-start
COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/
# The first-party profile plugin uses Deep Agents' supported entry-point hook to
# register managed aliases without modifying third-party package source. The
# managed-runtime patch independently hardens DCode entrypoints and installs the
# reviewed Relay observability boundary. Build validation keeps both exact and
# fail closed in one layer.
# invalidState: a no-deps plugin install can precede missing base dependencies.
# sourceBoundary: Dockerfile.base owns dependencies; this layer only proves them.
# whyNotSourceFix: dependency completeness is a NemoClaw image-build contract.
# regressionTest: the stripped-base gate must reach this marker, then fail import.
# removalCondition: remove when installation validates dependencies atomically.
# hadolint ignore=DL4006
RUN chmod 444 /opt/nemoclaw-deepagents-code/generate-config.ts /opt/nemoclaw-deepagents-code/managed-dcode-runtime.py /opt/nemoclaw-deepagents-code/patch-managed-deepagents-code.py /opt/nemoclaw-deepagents-code/validate-nemotron-ultra-profile.py /opt/nemoclaw-deepagents-code/progressive_tool_disclosure.py /opt/nemoclaw-deepagents-code/nemoclaw_observability.py /opt/nemoclaw-deepagents-code/validate-progressive-tool-disclosure.py /opt/nemoclaw-deepagents-code/validate-observability.py \
    && chmod 755 /usr/local/bin/nemoclaw-start /usr/local/lib/nemoclaw/dcode-wrapper.sh /usr/local/lib/nemoclaw/dcode-launcher.sh /usr/local/lib/nemoclaw/dcode-session-supervisor.py \
    && test "$(stat -c '%u:%g:%a' /usr/local/lib/nemoclaw/dcode-session-supervisor.py)" = "0:0:755" \
    && install -o root -g root -m 0755 /usr/local/lib/nemoclaw/dcode-launcher.sh /usr/local/lib/nemoclaw/dcode-managed-exec \
    && test -f /usr/local/lib/nemoclaw/dcode-managed-exec \
    && test ! -L /usr/local/lib/nemoclaw/dcode-managed-exec \
    && test "$(stat -c '%u:%g:%a' /usr/local/lib/nemoclaw/dcode-managed-exec)" = "0:0:755" \
    && cmp -s /usr/local/lib/nemoclaw/dcode-launcher.sh /usr/local/lib/nemoclaw/dcode-managed-exec \
    && chmod -R a+rX /opt/nemoclaw-blueprint \
    && test "$(find /opt/nemoclaw-deepagents-profile-plugin -type f -print | LC_ALL=C sort)" = "$(printf '%s\n' '/opt/nemoclaw-deepagents-profile-plugin/pyproject.toml' '/opt/nemoclaw-deepagents-profile-plugin/src/nemoclaw_deepagents_profile/__init__.py')" \
    && printf '%s  %s\n' '8fe85c62293c74147848732dc56c33e8ab60133fa41c071da4328ac60f2bf44f' '/opt/nemoclaw-deepagents-profile-plugin/src/nemoclaw_deepagents_profile/__init__.py' '7ba7b77bd6f889cc861eddbe3e38fc1f4433a85b7bc2a9b516e19a19a37a7686' '/opt/nemoclaw-deepagents-profile-plugin/pyproject.toml' | sha256sum -c - \
    && /opt/venv/bin/pip3 install --no-index --no-cache-dir --no-deps --no-build-isolation /opt/nemoclaw-deepagents-profile-plugin \
    && /opt/venv/bin/python3 -I -c 'import nemoclaw_deepagents_profile; print("NEMOCLAW_DCODE_PROFILE_" + "IMPORT_GATE", flush=True); import deepagents; import deepagents_code' \
    && /opt/venv/bin/pip3 check \
    && rm -rf /opt/nemoclaw-deepagents-profile-plugin \
    && python3 /opt/nemoclaw-deepagents-code/patch-managed-deepagents-code.py \
    && install -d -m 0700 /tmp/nemoclaw-progressive-validation \
    && TMPDIR=/tmp/nemoclaw-progressive-validation python3 /opt/nemoclaw-deepagents-code/validate-progressive-tool-disclosure.py \
    && TMPDIR=/tmp/nemoclaw-progressive-validation /opt/venv/bin/python3 -I /opt/nemoclaw-deepagents-code/validate-nemotron-ultra-profile.py \
    && rm -rf /tmp/nemoclaw-progressive-validation \
    && /opt/venv/bin/python3 -I /opt/nemoclaw-deepagents-code/validate-observability.py \
    && rm -f /opt/nemoclaw-deepagents-code/validate-progressive-tool-disclosure.py \
    && rm -f /opt/nemoclaw-deepagents-code/validate-nemotron-ultra-profile.py \
    && rm -f /opt/nemoclaw-deepagents-code/validate-observability.py \
    && rm -f /usr/local/bin/dcode /usr/local/bin/deepagents-code /opt/venv/bin/dcode /opt/venv/bin/deepagents-code \
    && install -m 0755 /usr/local/lib/nemoclaw/dcode-launcher.sh /usr/local/bin/dcode \
    && install -m 0755 /usr/local/lib/nemoclaw/dcode-launcher.sh /usr/local/bin/dcode.real \
    && install -m 0755 /usr/local/lib/nemoclaw/dcode-launcher.sh /usr/local/bin/deepagents-code

ARG NEMOCLAW_MODEL=nvidia/nemotron-3-ultra-550b-a55b
ARG NEMOCLAW_INFERENCE_PROVIDER_ID=inference
ARG NEMOCLAW_UPSTREAM_PROVIDER=nvidia
ARG NEMOCLAW_UPSTREAM_ENDPOINT_URL=
ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1
ARG NEMOCLAW_INFERENCE_API=openai-completions
ARG NEMOCLAW_TOOL_DISCLOSURE=progressive
ARG NEMOCLAW_DCODE_AUTO_APPROVAL=disabled
ARG NEMOCLAW_BUILD_ID=default
ARG NEMOCLAW_DARWIN_VM_COMPAT=0
ARG NEMOCLAW_PROXY_HOST=10.200.0.1
ARG NEMOCLAW_PROXY_PORT=3128

RUN case "$NEMOCLAW_TOOL_DISCLOSURE" in \
        progressive|direct) ;; \
        *) echo "ERROR: NEMOCLAW_TOOL_DISCLOSURE must be progressive or direct" >&2; exit 1 ;; \
    esac \
    && case "$NEMOCLAW_DCODE_AUTO_APPROVAL" in \
        disabled|thread-opt-in) ;; \
        *) echo "ERROR: NEMOCLAW_DCODE_AUTO_APPROVAL must be disabled or thread-opt-in" >&2; exit 1 ;; \
    esac

# The launcher and startup script read these root-owned files instead of
# trusting process-level environment overrides for inference routing. Invoking
# each launcher validates the build args before the image can complete. The
# empty-prompt probe also exercises the installed launcher -> wrapper chain so a
# stale or misassembled image cannot silently lose the public exit-code contract.
RUN install -d -m 0755 /usr/local/share/nemoclaw \
    && printf '%s\n' "$NEMOCLAW_PROXY_HOST" > /usr/local/share/nemoclaw/dcode-proxy-host \
    && printf '%s\n' "$NEMOCLAW_PROXY_PORT" > /usr/local/share/nemoclaw/dcode-proxy-port \
    && printf '%s\n' "$NEMOCLAW_INFERENCE_BASE_URL" > /usr/local/share/nemoclaw/dcode-inference-base-url \
    && printf '%s\n' "$NEMOCLAW_DCODE_AUTO_APPROVAL" > /usr/local/share/nemoclaw/dcode-auto-approval \
    && chown root:root /usr/local/share/nemoclaw/dcode-proxy-host /usr/local/share/nemoclaw/dcode-proxy-port /usr/local/share/nemoclaw/dcode-inference-base-url /usr/local/share/nemoclaw/dcode-auto-approval \
    && chmod 0444 /usr/local/share/nemoclaw/dcode-proxy-host /usr/local/share/nemoclaw/dcode-proxy-port /usr/local/share/nemoclaw/dcode-inference-base-url /usr/local/share/nemoclaw/dcode-auto-approval \
    && empty_prompt_log="$(mktemp)" \
    && if timeout 10 /usr/local/bin/dcode -n "" >"$empty_prompt_log" 2>&1; then empty_prompt_status=0; else empty_prompt_status=$?; fi \
    && test "$empty_prompt_status" -eq 2 \
    && test "$(cat "$empty_prompt_log")" = "NemoClaw: empty non-interactive prompt for -n; provide prompt text." \
    && rm -f "$empty_prompt_log" \
    && /usr/local/lib/nemoclaw/dcode-managed-exec /usr/bin/true \
    && /usr/local/bin/dcode --version \
    && /usr/local/bin/dcode.real --version \
    && /usr/local/bin/deepagents-code --version

ENV HOME=/sandbox \
    VIRTUAL_ENV=/opt/venv \
    PATH="/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" \
    NEMOCLAW_MODEL=${NEMOCLAW_MODEL} \
    NEMOCLAW_INFERENCE_PROVIDER_ID=${NEMOCLAW_INFERENCE_PROVIDER_ID} \
    NEMOCLAW_UPSTREAM_PROVIDER=${NEMOCLAW_UPSTREAM_PROVIDER} \
    NEMOCLAW_UPSTREAM_ENDPOINT_URL=${NEMOCLAW_UPSTREAM_ENDPOINT_URL} \
    NEMOCLAW_INFERENCE_BASE_URL=${NEMOCLAW_INFERENCE_BASE_URL} \
    NEMOCLAW_INFERENCE_API=${NEMOCLAW_INFERENCE_API} \
    NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE} \
    NEMOCLAW_BUILD_ID=${NEMOCLAW_BUILD_ID} \
    DEEPAGENTS_CODE_NO_UPDATE_CHECK=1 \
    LANGGRAPH_NO_VERSION_CHECK=true \
    LANGGRAPH_CLI_NO_ANALYTICS=1 \
    OTEL_ENABLED=false \
    DEEPAGENTS_CODE_AUTO_UPDATE=0 \
    DEEPAGENTS_CODE_LANGSMITH_TRACING=false \
    DEEPAGENTS_CODE_LANGSMITH_TRACING_V2=false \
    DEEPAGENTS_CODE_LANGCHAIN_TRACING=false \
    DEEPAGENTS_CODE_LANGCHAIN_TRACING_V2=false \
    LANGSMITH_TRACING=false \
    LANGSMITH_TRACING_V2=false \
    LANGCHAIN_TRACING=false \
    LANGCHAIN_TRACING_V2=false \
    DEEPAGENTS_CODE_OFFLINE=1 \
    DEEPAGENTS_CODE_RIPGREP_INSTALLER=system \
    DEEPAGENTS_CODE_OPENAI_API_KEY=nemoclaw-managed-inference \
    OPENAI_BASE_URL=${NEMOCLAW_INFERENCE_BASE_URL}

WORKDIR /sandbox
USER sandbox

RUN mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0 \
    && cp -r /opt/nemoclaw-blueprint/* /sandbox/.nemoclaw/blueprints/0.1.0/ \
    && node --experimental-strip-types /opt/nemoclaw-deepagents-code/generate-config.ts \
    && chmod 660 /sandbox/.deepagents/config.toml

USER root
RUN chown root:root /sandbox/.nemoclaw \
    && chmod 1755 /sandbox/.nemoclaw \
    && chown -R root:root /sandbox/.nemoclaw/blueprints \
    && chmod -R 755 /sandbox/.nemoclaw/blueprints \
    && mkdir -p /sandbox/.nemoclaw/state /sandbox/.nemoclaw/migration /sandbox/.nemoclaw/snapshots /sandbox/.nemoclaw/staging \
    && chown sandbox:sandbox /sandbox/.nemoclaw/state /sandbox/.nemoclaw/migration /sandbox/.nemoclaw/snapshots /sandbox/.nemoclaw/staging \
    && printf '%s' '{}' > /sandbox/.nemoclaw/config.json \
    && chown sandbox:sandbox /sandbox/.nemoclaw/config.json

RUN if [ "$NEMOCLAW_DARWIN_VM_COMPAT" = "1" ]; then \
        chmod -R a+rwX /sandbox/.deepagents; \
        find /sandbox/.deepagents -type d -exec chmod a+rwx {} +; \
        for p in /sandbox/.nemoclaw/state /sandbox/.nemoclaw/migration /sandbox/.nemoclaw/snapshots /sandbox/.nemoclaw/staging; do \
            chmod -R a+rwX "$p"; \
            find "$p" -type d -exec chmod a+rwx {} +; \
        done; \
        chmod a+rw /sandbox/.nemoclaw/config.json; \
        chmod a+rw /sandbox/.bashrc /sandbox/.profile; \
    fi

# Gate the completed local filesystem for dynamically built managed images.
COPY scripts/checks/node-tar-image-scan.mts /scripts/checks/node-tar-image-scan.mts
RUN install -d -m 0755 /usr/local/share/nemoclaw \
    && node --experimental-strip-types /scripts/checks/node-tar-image-scan.mts \
        --root / --image build:deepagents-code \
        > /usr/local/share/nemoclaw/node-tar-inventory.json \
    && chmod 0444 /usr/local/share/nemoclaw/node-tar-inventory.json

# Verify the immutable security package inventory in the completed image.
# hadolint ignore=DL4006
RUN set -eu; \
    security_inventory=/usr/local/share/nemoclaw/security-packages.txt; \
    arch="$(dpkg --print-architecture)"; \
    test -f "$security_inventory"; \
    test ! -L "$security_inventory"; \
    test "$(stat -c '%u:%g:%a' "$security_inventory")" = "0:0:444"; \
    printf '%s\n' \
        "architecture=$arch" \
        "libexpat1=2.8.2-1" \
        "libonig5=6.9.9-1+b1" \
        "libjq1=1.8.2-1" \
        "jq=1.8.2-1" \
        "vim-common=2:9.2.0782-1" \
        "vim-tiny=2:9.2.0782-1" \
        "libssh2-1t64=1.11.1-1+deb13u1+nemoclaw1" \
        "nemoclaw-python3.13-htmlparser-fix=3.13.5-2+deb13u4+nemoclaw1" \
        | cmp -s - "$security_inventory"; \
    test "$(dpkg-query -W -f='${Version}' libexpat1)" = "2.8.2-1"; \
    test "$(dpkg-query -W -f='${Version}' libonig5)" = "6.9.9-1+b1"; \
    test "$(dpkg-query -W -f='${Version}' libjq1)" = "1.8.2-1"; \
    test "$(dpkg-query -W -f='${Version}' jq)" = "1.8.2-1"; \
    test "$(dpkg-query -W -f='${Version}' vim-common)" = "2:9.2.0782-1"; \
    test "$(dpkg-query -W -f='${Version}' vim-tiny)" = "2:9.2.0782-1"; \
    test "$(dpkg-query -W -f='${Version}' libssh2-1t64)" = "1.11.1-1+deb13u1+nemoclaw1"; \
    test "$(dpkg-query -W -f='${Version}' nemoclaw-python3.13-htmlparser-fix)" = "3.13.5-2+deb13u4+nemoclaw1"; \
    ldd /usr/bin/jq | grep -Eq 'libonig[.]so[.]5'; \
    test "$(jq --version)" = "jq-1.8.2"; \
    printf '%s\n' '{"sandbox":"healthy"}' | jq -e '.sandbox == "healthy"' >/dev/null; \
    python3 -c "import pyexpat; assert pyexpat.EXPAT_VERSION == 'expat_2.8.2', pyexpat.EXPAT_VERSION"; \
    printf '%s  %s\n' \
        "4ff43a8578bda2f14686c67911b64c18e869841973722b1c623b5727491bdaf7" \
        /usr/lib/python3.13/html/parser.py \
        | sha256sum -c -; \
    python3 -c "import sys; from pathlib import Path; import html.parser; Path(html.parser.__file__).resolve() == Path('/usr/lib/python3.13/html/parser.py').resolve() or sys.exit('html.parser loaded from an unexpected path'); from html.parser import HTMLParser; p=HTMLParser(); [p.feed('') for _ in range(20000)]; p._pending == [] or sys.exit('empty feeds accumulated pending entries'); p.feed('<!--'); [p.feed('a' * 64) for _ in range(20000)]; p.feed('-->'); p.close(); p.rawdata == '' or sys.exit('incremental parsing retained raw data')"; \
    python3 -c "import ctypes, sys; lib=ctypes.CDLL('libssh2.so.1'); lib.libssh2_version.restype=ctypes.c_char_p; lib.libssh2_version(0) == b'1.11.1' or sys.exit('unexpected libssh2 runtime version')"; \
    vim.tiny --version | head -n 1 | grep -Eq '^VIM - Vi IMproved 9[.]2 '; \
    test -z "$(dpkg --audit)"
# End completed-image security package verification.

USER sandbox
ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]
CMD ["/bin/bash"]
