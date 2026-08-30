# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# LangChain Deep Agents Code sandbox image.

# NemoClaw staging supplies a resolved base image reference. Direct Docker builds
# must pass --build-arg BASE_IMAGE=... rather than falling back to a mutable tag.
ARG BASE_IMAGE
ARG NEMOCLAW_CORPORATE_CA_B64=

# The reviewed npm graph is audited in CI; image assembly copies only its
# generated runtime artifacts and therefore needs neither npm nor network.
FROM scratch AS mcp-tool-discovery-runtime
COPY tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/BUNDLED_PACKAGES.json tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/THIRD_PARTY_LICENSES.txt /opt/mcp-tool-discovery-runtime/dist/
COPY tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/mcp-tool-discovery.bundle /opt/mcp-tool-discovery-runtime/dist/mcp-tool-discovery.mjs

FROM scratch AS managed-startup-runtime-builder
COPY tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/managed-startup-image-runtime.bundle /out/managed-startup-image-runtime.cjs

# Compile the bootstrap boundary on the target platform. The output is a
# freestanding static ELF; only its reviewed, non-executable Bash body remains
# interpreted at runtime after the native boundary has scrubbed process control.
FROM node:22-trixie@sha256:a566dd560283ae5615c8bb86b58fa8a1b6f3c82b492473a061672416266625da AS managed-bootstrap-entrypoint-builder
ARG TARGETARCH
WORKDIR /opt/nemoclaw-managed-bootstrap-build
COPY scripts/managed-bootstrap-entrypoint.c ./
COPY scripts/managed-bootstrap-trampoline.sh ./
# hadolint ignore=DL4006
RUN set -eu; \
    target_arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$target_arch" in \
        amd64) expected_machine='Advanced Micro Devices X86-64' ;; \
        arm64) expected_machine='AArch64' ;; \
        *) echo "ERROR: unsupported managed bootstrap target architecture: $target_arch" >&2; exit 1 ;; \
    esac; \
    install -d -o root -g root -m 0755 /out/usr/local/bin /out/usr/local/lib/nemoclaw; \
    gcc \
        -std=c11 -O2 -Wall -Wextra -Werror \
        -DNEMOCLAW_MANAGED_BOOTSTRAP_FREESTANDING=1 \
        -ffreestanding -fno-asynchronous-unwind-tables -fno-builtin -fno-ident \
        -fno-pie -fno-stack-protector -fno-unwind-tables \
        -no-pie -nostdlib -static \
        -Wl,--build-id=none -Wl,-z,noexecstack \
        managed-bootstrap-entrypoint.c -o /tmp/nemoclaw-managed-bootstrap; \
    install -o root -g root -m 0755 \
        /tmp/nemoclaw-managed-bootstrap /out/usr/local/bin/nemoclaw-managed-bootstrap; \
    install -o root -g root -m 0444 \
        managed-bootstrap-trampoline.sh \
        /out/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh; \
    binary=/out/usr/local/bin/nemoclaw-managed-bootstrap; \
    body=/out/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh; \
    test -f "$binary" && test ! -L "$binary"; \
    test -f "$body" && test ! -L "$body"; \
    test "$(stat -c '%u:%g:%a' "$binary")" = '0:0:755'; \
    test "$(stat -c '%u:%g:%a' "$body")" = '0:0:444'; \
    /bin/bash -n "$body"; \
    test "$(readelf -hW "$binary" | sed -n 's/^[[:space:]]*Class:[[:space:]]*//p')" = 'ELF64'; \
    test "$(readelf -hW "$binary" | sed -n 's/^[[:space:]]*Type:[[:space:]]*//p')" = 'EXEC (Executable file)'; \
    test "$(readelf -hW "$binary" | sed -n 's/^[[:space:]]*Machine:[[:space:]]*//p')" = "$expected_machine"; \
    program_headers="$(readelf -lW "$binary")"; \
    case "$program_headers" in *INTERP*) echo 'ERROR: managed bootstrap ELF has an interpreter' >&2; exit 1 ;; esac; \
    readelf -dW "$binary" | grep -Fq 'There is no dynamic section'; \
    test -z "$(nm --undefined-only "$binary")"; \
    strings "$binary" | grep -Fq '/usr/local/bin/nemoclaw-managed-bootstrap'; \
    strings "$binary" | grep -Fq '/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh'

# hadolint ignore=DL3006
FROM ${BASE_IMAGE}

# The supplied base may end as a non-root runtime user. Reset the build user
# explicitly before installing the root-owned managed-startup handoff.
USER root

ARG NEMOCLAW_CORPORATE_CA_B64

# Decode the host corporate-proxy CA (#6210) for runtime trust when onboarding
# includes one in the final DCode image. Published or cached bases may not carry
# the host-specific CA, so decode the argument again when it is present.
# hadolint ignore=DL3059,DL4006
RUN if [ -n "${NEMOCLAW_CORPORATE_CA_B64}" ]; then \
      command -v base64 >/dev/null 2>&1 || { echo "[nemoclaw] base64 is required to decode NEMOCLAW_CORPORATE_CA_B64 but is not installed in the build image" >&2; exit 1; }; \
      command -v update-ca-certificates >/dev/null 2>&1 || { echo "[nemoclaw] update-ca-certificates is required to anchor NEMOCLAW_CORPORATE_CA_B64 for the OpenShell proxy" >&2; exit 1; }; \
      case "${NEMOCLAW_CORPORATE_CA_B64}" in *[!A-Za-z0-9+/=]*) echo "[nemoclaw] NEMOCLAW_CORPORATE_CA_B64 is not valid base64; expected a single-line base64-encoded PEM (#6210)" >&2; exit 1 ;; esac; \
      install -d -o root -g root -m 0755 /usr/local/share/nemoclaw /usr/local/share/ca-certificates \
      && { printf '%s' "${NEMOCLAW_CORPORATE_CA_B64}" | base64 --decode > /tmp/nemoclaw-corporate-ca.decoded 2>/dev/null \
           || { echo "[nemoclaw] NEMOCLAW_CORPORATE_CA_B64 is not valid base64; expected a single-line base64-encoded PEM (#6210)" >&2; exit 1; }; } \
      && awk '/-----BEGIN CERTIFICATE-----/{f=1} f{print} /-----END CERTIFICATE-----/{f=0}' /tmp/nemoclaw-corporate-ca.decoded > /usr/local/share/nemoclaw/corporate-ca.pem \
      && rm -f /tmp/nemoclaw-corporate-ca.decoded \
      && { node -e 'const fs = require("node:fs"); const { X509Certificate } = require("node:crypto"); const pemPath = process.argv[1]; const anchorDir = process.argv[2]; const pem = fs.readFileSync(pemPath, "utf8"); const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g); if (!blocks?.length) process.exit(1); fs.writeFileSync(pemPath, blocks.map((block) => block.trim()).join("\n") + "\n"); blocks.forEach((block, index) => { if (!new X509Certificate(block).ca) process.exit(1); const name = anchorDir + "/nemoclaw-corporate-ca-" + String(index + 1).padStart(2, "0") + ".crt"; fs.writeFileSync(name, block.trim() + "\n"); });' /usr/local/share/nemoclaw/corporate-ca.pem /usr/local/share/ca-certificates \
           || { echo "[nemoclaw] NEMOCLAW_CORPORATE_CA_B64 did not decode to a bundle of valid X.509 certificates with basicConstraints CA:TRUE (#6210)" >&2; exit 1; }; } \
      && chown root:root /usr/local/share/nemoclaw/corporate-ca.pem /usr/local/share/ca-certificates/nemoclaw-corporate-ca-*.crt \
      && chmod 0444 /usr/local/share/nemoclaw/corporate-ca.pem /usr/local/share/ca-certificates/nemoclaw-corporate-ca-*.crt \
      && update-ca-certificates \
      && echo "[nemoclaw] baked host corporate-proxy CA into DCode image trust (#6210)"; \
    fi

COPY --from=mcp-tool-discovery-runtime /opt/mcp-tool-discovery-runtime/dist/ /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime/
COPY --from=managed-startup-runtime-builder /out/managed-startup-image-runtime.cjs /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs
# Keep the root-owned managed-startup handoff in this image-only layer. The
# following permissions block is replayed on the host by regression tests.
RUN managed_runtime_assertion_failed() { \
      nemoclaw_assertion="$1"; \
      nemoclaw_artifact_path="$2"; \
      if [ -e "$nemoclaw_artifact_path" ] || [ -L "$nemoclaw_artifact_path" ]; then \
        if [ "${3:-}" = dereference ] && [ -e "$nemoclaw_artifact_path" ]; then \
          nemoclaw_metadata="$(stat -L -c 'uid=%u gid=%g type=%F mode=%a' -- "$nemoclaw_artifact_path" 2>/dev/null)" \
            || nemoclaw_metadata='uid=unavailable gid=unavailable type=unavailable mode=unavailable'; \
        else \
          nemoclaw_metadata="$(stat -c 'uid=%u gid=%g type=%F mode=%a' -- "$nemoclaw_artifact_path" 2>/dev/null)" \
            || nemoclaw_metadata='uid=unavailable gid=unavailable type=unavailable mode=unavailable'; \
        fi; \
        if [ -L "$nemoclaw_artifact_path" ]; then nemoclaw_symlink_state='yes'; else nemoclaw_symlink_state='no'; fi; \
      else \
        nemoclaw_metadata='uid=unavailable gid=unavailable type=missing mode=unavailable'; \
        nemoclaw_symlink_state='no'; \
      fi; \
      printf 'ERROR: managed image assertion failed: %s path=%s %s symlink=%s\n' \
        "$nemoclaw_assertion" "$nemoclaw_artifact_path" "$nemoclaw_metadata" "$nemoclaw_symlink_state" >&2; \
      exit 1; \
    }; \
    managed_image_command_failed() { \
      nemoclaw_command_assertion="$1"; \
      nemoclaw_command_status="$2"; \
      printf 'ERROR: managed image assertion failed: %s exit-status=%s\n' \
        "$nemoclaw_command_assertion" "$nemoclaw_command_status" >&2; \
      exit 1; \
    }; \
    if find -P /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime -exec chown -h root:root '{}' + \
      && find -P /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime -type d -exec chmod 0555 '{}' + \
      && find -P /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime -type f -exec chmod 0444 '{}' +; then \
      :; \
    else \
      managed_image_command_failed mcp-tool-discovery-tree-permission-replay "$?"; \
    fi; \
    discovery_contract="$(node /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime/mcp-tool-discovery.mjs)" \
      || managed_image_command_failed mcp-tool-discovery-bundle-execution "$?"; \
    node -e 'const expected = { protocol: 1, ok: false, detail: "tool discovery received invalid runtime arguments" }; const standaloneSecretPatterns = [/(?:nvapi-|nvcf-|gh[pousr]_|sk-proj-|sk-ant-|hf_|glpat-|gsk_|pypi-|tvly-)[A-Za-z0-9_-]{10,}/gu, /github_pat_[A-Za-z0-9_]{30,}/gu, /sk-[A-Za-z0-9_-]{20,}/gu, /(?:xox[bpas]|xapp)-[A-Za-z0-9-]{10,}/gu, /A(?:K|S)IA[A-Z0-9]{16}/gu, /\bbot\d{8,10}:[A-Za-z0-9_-]{35}\b/gu, /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/gu, /\b[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/gu, /lsv2_(?:pt|sk)_[A-Za-z0-9]{10,}(?:_[A-Za-z0-9]+)*/gu, /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}\b/gu, /\b[A-Za-z0-9_=-]{32,}\b/gu]; const redactContextSecrets = (value) => value.replace(/\b(?:Bearer|Basic)\s+\S+/giu, "<REDACTED>").replace(/((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}_(?:KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)|(?:X[-_])?API[-_]KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)["\x27]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["\x27]?)[^\s"\x27]+/giu, (_match, prefix) => prefix + "<REDACTED>").replace(/((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}(?:Token|Secret|Credential)|[A-Za-z0-9]{0,128}(?:[Aa]ccess|[Rr]efresh|[Cc]lient|[Bb]earer|[Aa]uth|[Aa][Pp][Ii]|[Pp]rivate|[Ss]igning|[Ss]ession|[Bb]ot|[Aa]pp|[Rr]esolved)Key|[A-Za-z0-9]{1,128}(?:Password|Passwd|Pass))["\x27]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["\x27]?)[^\s"\x27]+/gu, (_match, prefix) => prefix + "<REDACTED>").replace(/((?:^|[^A-Za-z0-9])KEY["\x27]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["\x27]?)[^\s"\x27]+/gu, (_match, prefix) => prefix + "<REDACTED>"); const sanitize = (value) => { if (value === undefined) return "<missing>"; if (value === null || typeof value === "boolean" || typeof value === "number") return value; if (typeof value !== "string") return "<" + (Array.isArray(value) ? "array" : typeof value) + ">"; let printable = value.replace(/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*/gu, "<REDACTED>").replace(/[^\x20-\x7e]/gu, "?"); for (const pattern of standaloneSecretPatterns) printable = printable.replace(pattern, "<REDACTED>"); printable = redactContextSecrets(printable); return printable.length <= 240 ? printable : printable.slice(0, 237) + "..."; }; let result; let parsed = true; try { result = JSON.parse(process.argv[1]); } catch { parsed = false; } const record = parsed && result !== null && typeof result === "object" && !Array.isArray(result) ? result : undefined; if (record && record.protocol === expected.protocol && record.ok === expected.ok && record.detail === expected.detail) process.exit(0); const actual = record ? { protocol: sanitize(record.protocol), ok: sanitize(record.ok), detail: sanitize(record.detail) } : parsed ? { type: result === null ? "null" : Array.isArray(result) ? "array" : typeof result, value: sanitize(result) } : { type: "invalid-json", preview: sanitize(process.argv[1]) }; console.error("ERROR: managed image assertion failed: mcp-tool-discovery-json-contract actual=%s expected=%s", JSON.stringify(actual), JSON.stringify(expected)); process.exit(1);' "$discovery_contract" \
      || exit 1; \
    discovery_unsafe="$(find -L /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime \( ! -user root -o -perm /022 \) -print -quit)" \
      || managed_image_command_failed mcp-tool-discovery-tree-find-execution "$?"; \
    { test -z "$discovery_unsafe" || managed_runtime_assertion_failed mcp-tool-discovery-tree-safety "$discovery_unsafe" dereference; } \
    && { test -f /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs || managed_runtime_assertion_failed regular-file /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
    && { test ! -L /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs || managed_runtime_assertion_failed non-symlink /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
    && { chown root:root /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs 2>/dev/null || managed_runtime_assertion_failed owner-root-root /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
    && { chmod 0444 /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs 2>/dev/null || managed_runtime_assertion_failed mode-0444 /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
    && { test "$(stat -c '%u:%g:%a' /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs 2>/dev/null)" = '0:0:444' || managed_runtime_assertion_failed metadata-0:0:444 /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
    && install -d -o root -g root -m 0755 /run/nemoclaw

COPY scripts/lib/reviewed-npm-archive.mts /scripts/lib/reviewed-npm-archive.mts
COPY scripts/lib/bundled-npm-package.mts /scripts/lib/bundled-npm-package.mts
COPY scripts/patch-bundled-npm-brace-expansion.mts /scripts/patch-bundled-npm-brace-expansion.mts
COPY scripts/lib/patch-bundled-npm-ip-address.mts /scripts/lib/patch-bundled-npm-ip-address.mts
COPY scripts/patch-bundled-npm-tar.mts /scripts/patch-bundled-npm-tar.mts

# The final managed image owns the shipped dependency boundary independently
# of base freshness. Reassert the idempotent npm-private node-tar fix here.
RUN node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts \
    --npm-root /usr/local/lib/node_modules/npm

# Reassert the npm-private brace-expansion fix for the final filesystem.
# hadolint ignore=DL3059
RUN node --experimental-strip-types /scripts/patch-bundled-npm-brace-expansion.mts \
    --npm-root /usr/local/lib/node_modules/npm

# Reassert the npm-private ip-address fix for the final filesystem. When
# onboarding supplied a corporate CA, use it for the registry-backed download.
# hadolint ignore=DL3059
RUN if [ -f /usr/local/share/nemoclaw/corporate-ca.pem ]; then \
      export CURL_CA_BUNDLE=/usr/local/share/nemoclaw/corporate-ca.pem; \
    fi; \
    node --experimental-strip-types /scripts/lib/patch-bundled-npm-ip-address.mts \
      --npm-root /usr/local/lib/node_modules/npm

RUN set -eu; \
    dcode_path="$(command -v dcode 2>/dev/null || true)"; \
    if [ "$dcode_path" != "/usr/local/bin/dcode" ]; then \
        echo "ERROR: expected dcode at /usr/local/bin/dcode, got ${dcode_path:-missing}" >&2; \
        exit 1; \
    fi; \
    test -x /usr/local/bin/dcode; \
    /usr/local/bin/dcode --version

# Copy the managed-startup entrypoint, config generator, its shared identity contract,
# wrapper, startup script, and shared blueprint files.
COPY agents/langchain-deepagents-code/generate-config-entrypoint.ts /opt/nemoclaw-deepagents-code/generate-config.ts
COPY agents/langchain-deepagents-code/generate-config.ts /opt/nemoclaw-deepagents-code/agents/langchain-deepagents-code/generate-config.ts
COPY src/lib/inference/managed-dcode/identity.ts /opt/nemoclaw-deepagents-code/src/lib/inference/managed-dcode/identity.ts
COPY agents/langchain-deepagents-code/managed-dcode-runtime.py /opt/nemoclaw-deepagents-code/managed-dcode-runtime.py
COPY agents/langchain-deepagents-code/patch-managed-deepagents-code.py /opt/nemoclaw-deepagents-code/patch-managed-deepagents-code.py
# SECURITY: copy only the two hash-verified plugin inputs, never the source directory.
COPY agents/langchain-deepagents-code/profile-plugin/pyproject.toml /opt/nemoclaw-deepagents-profile-plugin/
COPY agents/langchain-deepagents-code/profile-plugin/src/nemoclaw_deepagents_profile/__init__.py /opt/nemoclaw-deepagents-profile-plugin/src/nemoclaw_deepagents_profile/
COPY agents/langchain-deepagents-code/validate-nemotron-ultra-profile.py /opt/nemoclaw-deepagents-code/validate-nemotron-ultra-profile.py
COPY agents/langchain-deepagents-code/progressive_tool_disclosure.py /opt/nemoclaw-deepagents-code/progressive_tool_disclosure.py
COPY agents/langchain-deepagents-code/nemoclaw_observability.py /opt/nemoclaw-deepagents-code/nemoclaw_observability.py
COPY agents/langchain-deepagents-code/nemoclaw_read_only_mcp.py /usr/local/lib/nemoclaw/nemoclaw_read_only_mcp.py
COPY agents/langchain-deepagents-code/validate-progressive-tool-disclosure.py /opt/nemoclaw-deepagents-code/validate-progressive-tool-disclosure.py
COPY agents/langchain-deepagents-code/validate-observability.py /opt/nemoclaw-deepagents-code/validate-observability.py
COPY agents/langchain-deepagents-code/validate-read-only-mcp-call.py /opt/nemoclaw-deepagents-code/validate-read-only-mcp-call.py
COPY agents/langchain-deepagents-code/dcode-wrapper.sh /usr/local/lib/nemoclaw/dcode-wrapper.sh
COPY agents/langchain-deepagents-code/dcode-launcher.sh /usr/local/lib/nemoclaw/dcode-launcher.sh
COPY agents/langchain-deepagents-code/dcode-login-profile.sh /usr/local/lib/nemoclaw/dcode-login-profile.sh
COPY agents/langchain-deepagents-code/dcode-session-supervisor.py /usr/local/lib/nemoclaw/dcode-session-supervisor.py
COPY scripts/lib/entrypoint-env-wrapper.sh /usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh
COPY agents/langchain-deepagents-code/start.sh /usr/local/bin/nemoclaw-start
COPY scripts/managed-startup-hold.sh /usr/local/bin/nemoclaw-managed-startup-hold
COPY --from=managed-bootstrap-entrypoint-builder /out/usr/local/bin/nemoclaw-managed-bootstrap /usr/local/bin/nemoclaw-managed-bootstrap
COPY --from=managed-bootstrap-entrypoint-builder /out/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh
COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/
# The first-party profile plugin uses Deep Agents' supported entry-point hook to
# register managed aliases without modifying third-party package source. The
# managed-runtime patch independently hardens DCode entrypoints and installs the
# reviewed Relay observability boundary. Build validation verifies both artifacts and
# fails closed in one layer.
# invalidState: a no-deps plugin install can precede missing base dependencies.
# sourceBoundary: Dockerfile.base owns dependencies; this layer only proves them.
# whyNotSourceFix: dependency completeness is a NemoClaw image-build contract.
# regressionTest: the stripped-base gate must reach this marker, then fail import.
# removalCondition: remove when installation validates dependencies atomically.
# hadolint ignore=DL4006
RUN test -f /usr/local/bin/nemoclaw-managed-bootstrap \
    && test ! -L /usr/local/bin/nemoclaw-managed-bootstrap \
    && test "$(stat -c '%u:%g:%a' /usr/local/bin/nemoclaw-managed-bootstrap)" = '0:0:755' \
    && test -f /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh \
    && test ! -L /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh \
    && test "$(stat -c '%u:%g:%a' /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh)" = '0:0:444' \
    && chmod 444 /opt/nemoclaw-deepagents-code/generate-config.ts /opt/nemoclaw-deepagents-code/agents/langchain-deepagents-code/generate-config.ts /opt/nemoclaw-deepagents-code/src/lib/inference/managed-dcode/identity.ts /opt/nemoclaw-deepagents-code/managed-dcode-runtime.py /opt/nemoclaw-deepagents-code/patch-managed-deepagents-code.py /opt/nemoclaw-deepagents-code/validate-nemotron-ultra-profile.py /opt/nemoclaw-deepagents-code/progressive_tool_disclosure.py /opt/nemoclaw-deepagents-code/nemoclaw_observability.py /opt/nemoclaw-deepagents-code/validate-progressive-tool-disclosure.py /opt/nemoclaw-deepagents-code/validate-observability.py /opt/nemoclaw-deepagents-code/validate-read-only-mcp-call.py /usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh /usr/local/lib/nemoclaw/dcode-login-profile.sh /usr/local/lib/nemoclaw/nemoclaw_read_only_mcp.py \
    && chmod 755 /usr/local/bin/nemoclaw-start /usr/local/bin/nemoclaw-managed-startup-hold /usr/local/bin/nemoclaw-managed-bootstrap /usr/local/lib/nemoclaw/dcode-wrapper.sh /usr/local/lib/nemoclaw/dcode-launcher.sh /usr/local/lib/nemoclaw/dcode-session-supervisor.py \
    && test "$(stat -c '%u:%g:%a' /usr/local/lib/nemoclaw/dcode-session-supervisor.py)" = "0:0:755" \
    && install -o root -g root -m 0755 /usr/local/lib/nemoclaw/dcode-launcher.sh /usr/local/lib/nemoclaw/dcode-managed-exec \
    && test -f /usr/local/lib/nemoclaw/dcode-managed-exec \
    && test ! -L /usr/local/lib/nemoclaw/dcode-managed-exec \
    && test "$(stat -c '%u:%g:%a' /usr/local/lib/nemoclaw/dcode-managed-exec)" = "0:0:755" \
    && cmp -s /usr/local/lib/nemoclaw/dcode-launcher.sh /usr/local/lib/nemoclaw/dcode-managed-exec \
    && chmod -R a+rX /opt/nemoclaw-blueprint \
    && test "$(find /opt/nemoclaw-deepagents-profile-plugin -type f -print | LC_ALL=C sort)" = "$(printf '%s\n' '/opt/nemoclaw-deepagents-profile-plugin/pyproject.toml' '/opt/nemoclaw-deepagents-profile-plugin/src/nemoclaw_deepagents_profile/__init__.py')" \
    && printf '%s  %s\n' '6bb8dc8108c5dd7e7f71c39aacfb0da07d285b7a324eecd691177a9ca460cfc0' '/opt/nemoclaw-deepagents-profile-plugin/src/nemoclaw_deepagents_profile/__init__.py' '7be3f7972d7cd78d3ddaf66e2ff8b07a5e6af3611034b956cf0475ba78f5a576' '/opt/nemoclaw-deepagents-profile-plugin/pyproject.toml' | sha256sum -c - \
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
ARG NEMOCLAW_REASONING_EFFORT=
ARG NEMOCLAW_TOOL_DISCLOSURE=progressive
ARG NEMOCLAW_DCODE_AUTO_APPROVAL=disabled
# DCode has no extra optional packages today, but release images participate in
# the same managed-image capability contract as OpenClaw and Hermes.
ARG NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=0
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
    esac \
    && case "$NEMOCLAW_REASONING_EFFORT" in \
        ""|low|medium|high) ;; \
        *) echo "ERROR: NEMOCLAW_REASONING_EFFORT must be empty, low, medium, or high" >&2; exit 1 ;; \
    esac

# The launcher and startup script read these root-owned files instead of
# trusting process-level environment overrides for inference routing. Invoking
# each launcher validates the build args before the image can complete. The
# empty-prompt probe targets the installed wrapper directly: it validates the
# public parser contract without requiring the image builder's kernel to support
# the runtime-only child-subreaper supervisor. Keep that parser-only probe
# hermetic so base-image or builder observability variables cannot mask the
# diagnostic under test; the post-build workflow probes the real managed chain.
RUN install -d -m 0755 /usr/local/share/nemoclaw \
    && printf '%s\n' "$NEMOCLAW_PROXY_HOST" > /usr/local/share/nemoclaw/dcode-proxy-host \
    && printf '%s\n' "$NEMOCLAW_PROXY_PORT" > /usr/local/share/nemoclaw/dcode-proxy-port \
    && printf '%s\n' "$NEMOCLAW_INFERENCE_BASE_URL" > /usr/local/share/nemoclaw/dcode-inference-base-url \
    && printf '%s\n' "$NEMOCLAW_UPSTREAM_PROVIDER" > /usr/local/share/nemoclaw/dcode-upstream-provider \
    && printf '%s\n' "$NEMOCLAW_DCODE_AUTO_APPROVAL" > /usr/local/share/nemoclaw/dcode-auto-approval \
    && printf '%s\n' "$NEMOCLAW_REASONING_EFFORT" > /usr/local/share/nemoclaw/dcode-reasoning-effort \
    && chown root:root /usr/local/share/nemoclaw/dcode-proxy-host /usr/local/share/nemoclaw/dcode-proxy-port /usr/local/share/nemoclaw/dcode-inference-base-url /usr/local/share/nemoclaw/dcode-upstream-provider /usr/local/share/nemoclaw/dcode-auto-approval /usr/local/share/nemoclaw/dcode-reasoning-effort \
    && chmod 0444 /usr/local/share/nemoclaw/dcode-proxy-host /usr/local/share/nemoclaw/dcode-proxy-port /usr/local/share/nemoclaw/dcode-inference-base-url /usr/local/share/nemoclaw/dcode-upstream-provider /usr/local/share/nemoclaw/dcode-auto-approval /usr/local/share/nemoclaw/dcode-reasoning-effort \
    && /opt/venv/bin/python3 -I /opt/nemoclaw-deepagents-code/validate-read-only-mcp-call.py \
    && rm -f /opt/nemoclaw-deepagents-code/validate-read-only-mcp-call.py \
    && unset OTEL_EXPORTER_OTLP_TRACES_ENDPOINT \
    && empty_prompt_log="$(mktemp)" \
    && if timeout 10 env -i /usr/local/lib/nemoclaw/dcode-wrapper.sh -n "" >"$empty_prompt_log" 2>&1; then empty_prompt_status=0; else empty_prompt_status=$?; fi \
    && empty_prompt_output="$(cat "$empty_prompt_log")" \
    && if [ "$empty_prompt_status" -ne 2 ] \
        || [ "$empty_prompt_output" != "NemoClaw: empty non-interactive prompt for -n; provide prompt text." ]; then \
        printf 'ERROR: managed dcode empty-prompt probe returned status %s:\n%s\n' \
            "$empty_prompt_status" "$empty_prompt_output" >&2; \
        rm -f "$empty_prompt_log"; \
        exit 1; \
    fi \
    && rm -f "$empty_prompt_log" \
    && env -i /usr/local/lib/nemoclaw/dcode-managed-exec /usr/bin/true \
    && env -i /usr/local/bin/dcode --version \
    && env -i /usr/local/bin/dcode.real --version \
    && env -i /usr/local/bin/deepagents-code --version

ENV HOME=/sandbox \
    VIRTUAL_ENV=/opt/venv \
    PATH="/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" \
    NEMOCLAW_MODEL=${NEMOCLAW_MODEL} \
    NEMOCLAW_INFERENCE_PROVIDER_ID=${NEMOCLAW_INFERENCE_PROVIDER_ID} \
    NEMOCLAW_UPSTREAM_PROVIDER=${NEMOCLAW_UPSTREAM_PROVIDER} \
    NEMOCLAW_UPSTREAM_ENDPOINT_URL=${NEMOCLAW_UPSTREAM_ENDPOINT_URL} \
    NEMOCLAW_INFERENCE_BASE_URL=${NEMOCLAW_INFERENCE_BASE_URL} \
    NEMOCLAW_INFERENCE_API=${NEMOCLAW_INFERENCE_API} \
    NEMOCLAW_REASONING_EFFORT=${NEMOCLAW_REASONING_EFFORT} \
    NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE} \
    NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=${NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION} \
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
RUN test "$(id -u sandbox):$(id -g sandbox):$(pwd)" = "999:999:/sandbox"
USER sandbox

RUN mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0 \
    && cp -r /opt/nemoclaw-blueprint/* /sandbox/.nemoclaw/blueprints/0.1.0/ \
    && node --experimental-strip-types /opt/nemoclaw-deepagents-code/generate-config.ts \
    && chmod 660 /sandbox/.deepagents/config.toml

USER root
RUN chown root:sandbox /sandbox \
    && chmod 1775 /sandbox \
    && install -o root -g root -m 0444 /usr/local/lib/nemoclaw/dcode-login-profile.sh /sandbox/.bash_profile \
    && test "$(stat -c '%U:%G:%a' /sandbox)" = 'root:sandbox:1775' \
    && test "$(stat -c '%U:%G:%a' /sandbox/.bash_profile)" = 'root:root:444' \
    && cmp -s /usr/local/lib/nemoclaw/dcode-login-profile.sh /sandbox/.bash_profile \
    && chown root:root /sandbox/.nemoclaw \
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

# Verify the managed bootstrap files in dynamically built images.
RUN test -f /usr/local/bin/nemoclaw-managed-bootstrap \
    && test ! -L /usr/local/bin/nemoclaw-managed-bootstrap \
    && test "$(stat -c '%U:%G:%a' /usr/local/bin/nemoclaw-managed-bootstrap)" = 'root:root:755' \
    && test -f /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh \
    && test ! -L /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh \
    && test "$(stat -c '%U:%G:%a' /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh)" = 'root:root:444'

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
        "libexpat1=2.8.3-1" \
        "libonig5=6.9.9-1+b1" \
        "libjq1=1.8.2-1" \
        "jq=1.8.2-1" \
        "vim-common=2:9.2.0858-1" \
        "vim-tiny=2:9.2.0858-1" \
        "libssh2-1t64=1.11.1-1+deb13u1+nemoclaw2" \
        "libssl3t64=3.5.7-1~deb13u2" \
        "nemoclaw-python3.13-htmlparser-fix=3.13.5-2+deb13u4+nemoclaw1" \
        "perl-base=5.44.0-1nemoclaw1" \
        "perl=5.44.0-1nemoclaw1" \
        | cmp -s - "$security_inventory"; \
    test "$(dpkg-query -W -f='${Version}' libexpat1)" = "2.8.3-1"; \
    test "$(dpkg-query -W -f='${Version}' libonig5)" = "6.9.9-1+b1"; \
    test "$(dpkg-query -W -f='${Version}' libjq1)" = "1.8.2-1"; \
    test "$(dpkg-query -W -f='${Version}' jq)" = "1.8.2-1"; \
    test "$(dpkg-query -W -f='${Version}' vim-common)" = "2:9.2.0858-1"; \
    test "$(dpkg-query -W -f='${Version}' vim-tiny)" = "2:9.2.0858-1"; \
    test "$(dpkg-query -W -f='${Version}' libssh2-1t64)" = "1.11.1-1+deb13u1+nemoclaw2"; \
    test "$(dpkg-query -W -f='${Version}' libssl3t64)" = "3.5.7-1~deb13u2"; \
    test "$(dpkg-query -W -f='${Version}' nemoclaw-python3.13-htmlparser-fix)" = "3.13.5-2+deb13u4+nemoclaw1"; \
    test "$(dpkg-query -W -f='${Version}' perl-base)" = "5.44.0-1nemoclaw1"; \
    test "$(dpkg-query -W -f='${Version}' perl)" = "5.44.0-1nemoclaw1"; \
    test "$(perl -e 'print $^V')" = "v5.44.0"; \
    ldd /usr/bin/jq | grep -Eq 'libonig[.]so[.]5'; \
    test "$(jq --version)" = "jq-1.8.2"; \
    printf '%s\n' '{"sandbox":"healthy"}' | jq -e '.sandbox == "healthy"' >/dev/null; \
    python3 -c "import pyexpat; assert pyexpat.EXPAT_VERSION == 'expat_2.8.3', pyexpat.EXPAT_VERSION"; \
    printf '%s  %s\n' \
        "4ff43a8578bda2f14686c67911b64c18e869841973722b1c623b5727491bdaf7" \
        /usr/lib/python3.13/html/parser.py \
        | sha256sum -c -; \
    python3 -c "import sys; from pathlib import Path; import html.parser; Path(html.parser.__file__).resolve() == Path('/usr/lib/python3.13/html/parser.py').resolve() or sys.exit('html.parser loaded from an unexpected path'); from html.parser import HTMLParser; p=HTMLParser(); [p.feed('') for _ in range(20000)]; p._pending == [] or sys.exit('empty feeds accumulated pending entries'); p.feed('<!--'); [p.feed('a' * 64) for _ in range(20000)]; p.feed('-->'); p.close(); p.rawdata == '' or sys.exit('incremental parsing retained raw data')"; \
    python3 -c "import ctypes, sys; lib=ctypes.CDLL('libssh2.so.1'); lib.libssh2_version.restype=ctypes.c_char_p; lib.libssh2_version(0) == b'1.11.1' or sys.exit('unexpected libssh2 runtime version')"; \
    vim.tiny --version | head -n 1 | grep -Eq '^VIM - Vi IMproved 9[.]2 '; \
    vim.tiny --version | grep -Fx 'Included patches: 1-858'; \
    test -z "$(dpkg --audit)"
# End completed-image security package verification.

ARG NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER=root
RUN case "$NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER" in \
        root|sandbox) ;; \
        *) echo "ERROR: NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER must be root or sandbox" >&2; exit 1 ;; \
    esac \
    && command -v setpriv >/dev/null 2>&1
USER ${NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER}
ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]
CMD ["/bin/bash"]
