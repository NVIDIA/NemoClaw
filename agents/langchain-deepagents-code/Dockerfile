# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# LangChain Deep Agents Code sandbox image.

# NemoClaw staging supplies a resolved base image reference. Direct Docker builds
# must pass --build-arg BASE_IMAGE=... rather than falling back to a mutable tag.
ARG BASE_IMAGE

# hadolint ignore=DL3006
FROM ${BASE_IMAGE}

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
COPY agents/langchain-deepagents-code/patch-nemotron-ultra-profile.py /opt/nemoclaw-deepagents-code/patch-nemotron-ultra-profile.py
COPY agents/langchain-deepagents-code/validate-nemotron-ultra-profile.py /opt/nemoclaw-deepagents-code/validate-nemotron-ultra-profile.py
COPY agents/langchain-deepagents-code/progressive_tool_disclosure.py /opt/nemoclaw-deepagents-code/progressive_tool_disclosure.py
COPY agents/langchain-deepagents-code/nemoclaw_observability.py /opt/nemoclaw-deepagents-code/nemoclaw_observability.py
COPY agents/langchain-deepagents-code/validate-progressive-tool-disclosure.py /opt/nemoclaw-deepagents-code/validate-progressive-tool-disclosure.py
COPY agents/langchain-deepagents-code/validate-observability.py /opt/nemoclaw-deepagents-code/validate-observability.py
COPY agents/langchain-deepagents-code/dcode-wrapper.sh /usr/local/lib/nemoclaw/dcode-wrapper.sh
COPY agents/langchain-deepagents-code/dcode-launcher.sh /usr/local/lib/nemoclaw/dcode-launcher.sh
COPY agents/langchain-deepagents-code/start.sh /usr/local/bin/nemoclaw-start
COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/
# The Nemotron bridge registers managed aliases for the released SDK profile; the
# managed-runtime patch independently hardens Deep Agents Code entrypoints and
# installs the reviewed Relay observability boundary.
# Both are exact-version, fail-closed build steps validated in one layer so no
# reusable image layer can contain only one of the required managed patches.
RUN chmod 444 /opt/nemoclaw-deepagents-code/generate-config.ts /opt/nemoclaw-deepagents-code/managed-dcode-runtime.py /opt/nemoclaw-deepagents-code/patch-managed-deepagents-code.py /opt/nemoclaw-deepagents-code/patch-nemotron-ultra-profile.py /opt/nemoclaw-deepagents-code/validate-nemotron-ultra-profile.py /opt/nemoclaw-deepagents-code/progressive_tool_disclosure.py /opt/nemoclaw-deepagents-code/nemoclaw_observability.py /opt/nemoclaw-deepagents-code/validate-progressive-tool-disclosure.py /opt/nemoclaw-deepagents-code/validate-observability.py \
    && chmod 755 /usr/local/bin/nemoclaw-start /usr/local/lib/nemoclaw/dcode-wrapper.sh /usr/local/lib/nemoclaw/dcode-launcher.sh \
    && chmod -R a+rX /opt/nemoclaw-blueprint \
    && python3 /opt/nemoclaw-deepagents-code/patch-nemotron-ultra-profile.py \
    && python3 /opt/nemoclaw-deepagents-code/patch-managed-deepagents-code.py \
    && install -d -m 0700 /tmp/nemoclaw-progressive-validation \
    && TMPDIR=/tmp/nemoclaw-progressive-validation python3 /opt/nemoclaw-deepagents-code/validate-progressive-tool-disclosure.py \
    && TMPDIR=/tmp/nemoclaw-progressive-validation python3 /opt/nemoclaw-deepagents-code/validate-nemotron-ultra-profile.py \
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
ARG NEMOCLAW_PROVIDER_KEY=inference
ARG NEMOCLAW_UPSTREAM_PROVIDER=nvidia
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
    && /usr/local/bin/dcode --version \
    && /usr/local/bin/dcode.real --version \
    && /usr/local/bin/deepagents-code --version

ENV HOME=/sandbox \
    VIRTUAL_ENV=/opt/venv \
    PATH="/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" \
    NEMOCLAW_MODEL=${NEMOCLAW_MODEL} \
    NEMOCLAW_PROVIDER_KEY=${NEMOCLAW_PROVIDER_KEY} \
    NEMOCLAW_UPSTREAM_PROVIDER=${NEMOCLAW_UPSTREAM_PROVIDER} \
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

USER sandbox
ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]
CMD ["/bin/bash"]
