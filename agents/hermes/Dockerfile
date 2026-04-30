# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Hermes sandbox image — Hermes Agent + NemoClaw plugin inside OpenShell
#
# Layers PR-specific code (plugin, config, startup script) on top of the
# pre-built Hermes base image. Mirrors the OpenClaw Dockerfile structure.

ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest

# hadolint ignore=DL3006
FROM ${BASE_IMAGE}

# Harden: remove unnecessary build tools and network probes
RUN (apt-get remove --purge -y gcc gcc-12 g++ g++-12 cpp cpp-12 make \
        netcat-openbsd netcat-traditional ncat 2>/dev/null || true) \
    && apt-get autoremove --purge -y \
    && rm -rf /var/lib/apt/lists/*

# Hermes v2026.4.13+ auto-detects HTTPS_PROXY and skips fallback-IP
# transport when a proxy is present. The sandbox proxy chain
# (decode-proxy → OpenShell L7 proxy) handles credential placeholder
# rewriting and hostname-based policy enforcement. No monkey patch needed.
ENV HERMES_TELEGRAM_DISABLE_FALLBACK_IPS=1

# Copy NemoClaw plugin for Hermes (Python-based)
COPY agents/hermes/plugin/ /opt/nemoclaw-hermes-plugin/
RUN chmod -R a+rX /opt/nemoclaw-hermes-plugin/

# Copy config generation script and URL-decode proxy
COPY agents/hermes/generate-config.ts /opt/nemoclaw-generate-config.ts
RUN chmod 444 /opt/nemoclaw-generate-config.ts
COPY agents/hermes/decode-proxy.py /usr/local/bin/nemoclaw-decode-proxy
RUN chmod 755 /usr/local/bin/nemoclaw-decode-proxy

# Copy blueprint (shared infrastructure)
COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/
# Ensure sandbox user can read blueprint files copied as root
RUN chmod -R a+rX /opt/nemoclaw-blueprint/

# Copy startup script
COPY scripts/lib/sandbox-init.sh /usr/local/lib/nemoclaw/sandbox-init.sh
COPY agents/hermes/start.sh /usr/local/bin/nemoclaw-start
RUN chmod 755 /usr/local/bin/nemoclaw-start /usr/local/lib/nemoclaw/sandbox-init.sh

# Build args for config that varies per deployment.
ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b
ARG NEMOCLAW_PROVIDER_KEY=custom
ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1
# CHAT_UI_URL is a legacy name shared with the OpenClaw build arg. For
# Hermes this URL points at the OpenAI-compatible API server (port 8642,
# exposing /v1 and /health), NOT a browser chat UI. Callers authenticate
# via a bearer token in the Authorization header. See
# agents/hermes/manifest.yaml (dashboard.kind: api).
ARG CHAT_UI_URL=http://127.0.0.1:8642
ARG NEMOCLAW_MESSAGING_CHANNELS_B64=W10=
ARG NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=e30=
ARG NEMOCLAW_BUILD_ID=default

# Promote build-args to env vars for the config generation script.
ENV NEMOCLAW_MODEL=${NEMOCLAW_MODEL} \
    NEMOCLAW_PROVIDER_KEY=${NEMOCLAW_PROVIDER_KEY} \
    NEMOCLAW_INFERENCE_BASE_URL=${NEMOCLAW_INFERENCE_BASE_URL} \
    CHAT_UI_URL=${CHAT_UI_URL} \
    NEMOCLAW_MESSAGING_CHANNELS_B64=${NEMOCLAW_MESSAGING_CHANNELS_B64} \
    NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=${NEMOCLAW_MESSAGING_ALLOWED_IDS_B64}

WORKDIR /sandbox
USER sandbox

# Set up blueprint for local resolution
RUN mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0 \
    && cp -r /opt/nemoclaw-blueprint/* /sandbox/.nemoclaw/blueprints/0.1.0/

# Generate Hermes config.yaml and .env from build args.
# Config is mutable by default (600 sandbox:sandbox). Immutability is opt-in
# via `shields up`. .env holds API key placeholders for OpenShell provider pipeline.
# SECURITY: Uses a separate script file instead of inline code to avoid
# code injection via build-arg interpolation (same concern as OpenClaw C-2).
RUN node --experimental-strip-types /opt/nemoclaw-generate-config.ts

# Install NemoClaw plugin into Hermes
RUN mkdir -p /sandbox/.hermes/plugins/nemoclaw \
    && cp -r /opt/nemoclaw-hermes-plugin/* /sandbox/.hermes/plugins/nemoclaw/

# Write a default SOUL.md for the sandboxed agent.
RUN mkdir -p /sandbox/.hermes/memories \
    && printf '%s\n' \
    'You are a helpful AI assistant running inside an NVIDIA OpenShell sandbox.' \
    'Your inference is routed through NemoClaw. You have access to terminal,' \
    'file, and web tools. Be concise and helpful.' \
    > /sandbox/.hermes/SOUL.md

# Set mutable-default permissions (640/750 sandbox:sandbox).
# The sandbox user can write config; the gateway user can read it via
# supplementary sandbox-group membership. Shields-up applies 444 root:root +
# chattr +i.
# hadolint ignore=DL3002
USER root
# Flatten stale published base images that still contain the old .hermes-data
# symlink bridge. OpenShell starts the sandbox as the sandbox user, so runtime
# migration cannot rely on root privileges inside the pod.
# hadolint ignore=DL4006
RUN set -eu; \
    config_dir=/sandbox/.hermes; \
    data_dir=/sandbox/.hermes-data; \
    mkdir -p "$config_dir"; \
    if [ -L "$data_dir" ]; then \
        echo "ERROR: refusing legacy layout cleanup because $data_dir is a symlink" >&2; \
        exit 1; \
    fi; \
    if [ -d "$data_dir" ]; then \
        for entry in "$data_dir"/*; do \
            [ -e "$entry" ] || [ -L "$entry" ] || continue; \
            if [ -L "$entry" ]; then \
                echo "ERROR: refusing legacy layout cleanup because $entry is a symlink" >&2; \
                exit 1; \
            fi; \
            name="$(basename "$entry")"; \
            target="$config_dir/$name"; \
            if [ -L "$target" ]; then \
                rm -f "$target"; \
            fi; \
            if [ -d "$entry" ]; then \
                mkdir -p "$target"; \
                cp -a "$entry"/. "$target"/; \
            elif [ ! -e "$target" ]; then \
                cp -a "$entry" "$target"; \
            fi; \
        done; \
        data_real="$(readlink -f "$data_dir" 2>/dev/null || printf '%s' "$data_dir")"; \
        while :; do \
            replaced_marker="$(mktemp)"; \
            rm -f "$replaced_marker"; \
            find "$config_dir" -type l -print | while IFS= read -r link; do \
                raw_target="$(readlink "$link" 2>/dev/null || true)"; \
                resolved_target="$(readlink -f "$link" 2>/dev/null || true)"; \
                legacy_target=0; \
                case "$raw_target" in "$data_real"/* | "$data_dir"/*) legacy_target=1 ;; esac; \
                case "$resolved_target" in "$data_real"/* | "$data_dir"/*) legacy_target=1 ;; esac; \
                if [ "$legacy_target" -eq 1 ]; then \
                    copy_target="$resolved_target"; \
                    if [ -z "$copy_target" ] || { [ ! -e "$copy_target" ] && [ ! -L "$copy_target" ]; }; then \
                        copy_target="$raw_target"; \
                    fi; \
                    if [ -d "$copy_target" ] && [ ! -L "$copy_target" ]; then \
                            rm -f "$link"; \
                            mkdir -p "$link"; \
                            cp -a "$copy_target"/. "$link"/; \
                    elif [ -e "$copy_target" ] || [ -L "$copy_target" ]; then \
                            rm -f "$link"; \
                            cp -a "$copy_target" "$link"; \
                    else \
                        echo "ERROR: legacy symlink target missing: $link -> ${raw_target:-$resolved_target}" >&2; \
                        exit 1; \
                    fi; \
                    : > "$replaced_marker"; \
                fi; \
            done; \
            if [ ! -e "$replaced_marker" ]; then \
                rm -f "$replaced_marker"; \
                break; \
            fi; \
            rm -f "$replaced_marker"; \
        done; \
        rm -rf "$data_dir"; \
    fi; \
    mkdir -p "$config_dir/memories" \
        "$config_dir/sessions" \
        "$config_dir/skills" \
        "$config_dir/plugins" \
        "$config_dir/cron" \
        "$config_dir/logs" \
        "$config_dir/skins" \
        "$config_dir/plans" \
        "$config_dir/workspace" \
        "$config_dir/profiles" \
        "$config_dir/cache" \
        "$config_dir/pairing"; \
    if [ -e "$data_dir" ] || [ -L "$data_dir" ]; then \
        echo "ERROR: legacy data dir still exists after cleanup: $data_dir" >&2; \
        exit 1; \
    fi; \
    data_real="$(readlink -f "$data_dir" 2>/dev/null || printf '%s' "$data_dir")"; \
    find "$config_dir" -type l -print | while IFS= read -r link; do \
        raw_target="$(readlink "$link" 2>/dev/null || true)"; \
        resolved_target="$(readlink -f "$link" 2>/dev/null || true)"; \
        case "$raw_target" in \
            "$data_real"/* | "$data_dir"/*) \
                echo "ERROR: legacy symlink remains after cleanup: $link -> $raw_target" >&2; \
                exit 1; \
                ;; \
        esac; \
        case "$resolved_target" in \
            "$data_real"/* | "$data_dir"/*) \
                echo "ERROR: legacy symlink remains after cleanup: $link -> $resolved_target" >&2; \
                exit 1; \
                ;; \
        esac; \
    done; \
    rm -rf /root/.cache/pip /sandbox/.cache \
    && chown -R sandbox:sandbox /sandbox/.hermes \
    && chmod 750 /sandbox/.hermes \
    && chmod 640 /sandbox/.hermes/config.yaml \
    && chmod 640 /sandbox/.hermes/.env

# Pin config hash at build time for integrity verification at startup.
RUN mkdir -p /etc/nemoclaw \
    && sha256sum /sandbox/.hermes/config.yaml /sandbox/.hermes/.env \
    > /etc/nemoclaw/hermes.config-hash \
    && chown root:root /etc/nemoclaw/hermes.config-hash \
    && chmod 444 /etc/nemoclaw/hermes.config-hash

# Backward-compatible marker for host-side shields logic on older sandboxes.
RUN sha256sum /sandbox/.hermes/config.yaml /sandbox/.hermes/.env \
    > /sandbox/.hermes/.config-hash \
    && chmod 600 /sandbox/.hermes/.config-hash \
    && chown sandbox:sandbox /sandbox/.hermes/.config-hash

# start.sh handles privilege separation: runs as root initially, then drops
# to 'gateway' user via gosu for the agent process. See start.sh.
ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]
CMD ["/bin/bash"]
