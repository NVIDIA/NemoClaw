# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Pi sandbox image.

# NemoClaw staging supplies a resolved base image reference. Direct Docker builds
# must pass --build-arg BASE_IMAGE=... rather than falling back to a mutable tag.
ARG BASE_IMAGE
ARG NEMOCLAW_CORPORATE_CA_B64=

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
# hadolint ignore=DL3066
USER root

ARG NEMOCLAW_CORPORATE_CA_B64
ARG NEMOCLAW_TOOL_DISCLOSURE=progressive

# Decode the host corporate-proxy CA (#6210) for runtime trust when onboarding
# includes one in the final Pi image. Published or cached bases may not carry
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
      && echo "[nemoclaw] baked host corporate-proxy CA into Pi image trust (#6210)"; \
    fi

COPY --from=managed-startup-runtime-builder /out/managed-startup-image-runtime.cjs /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs
# Keep the root-owned managed-startup handoff in this image-only layer. The
# following permissions block is replayed on the host by regression tests.
RUN managed_runtime_assertion_failed() { \
      nemoclaw_assertion="$1"; \
      nemoclaw_artifact_path="$2"; \
      if [ -e "$nemoclaw_artifact_path" ] || [ -L "$nemoclaw_artifact_path" ]; then \
        nemoclaw_metadata="$(stat -c 'uid=%u gid=%g type=%F mode=%a' -- "$nemoclaw_artifact_path" 2>/dev/null)" \
          || nemoclaw_metadata='uid=unavailable gid=unavailable type=unavailable mode=unavailable'; \
        if [ -L "$nemoclaw_artifact_path" ]; then nemoclaw_symlink_state='yes'; else nemoclaw_symlink_state='no'; fi; \
      else \
        nemoclaw_metadata='uid=unavailable gid=unavailable type=missing mode=unavailable'; \
        nemoclaw_symlink_state='no'; \
      fi; \
      printf 'ERROR: managed image assertion failed: %s path=%s %s symlink=%s\n' \
        "$nemoclaw_assertion" "$nemoclaw_artifact_path" "$nemoclaw_metadata" "$nemoclaw_symlink_state" >&2; \
      exit 1; \
    }; \
    { test -f /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs || managed_runtime_assertion_failed regular-file /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
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

ARG PI_VERSION=0.84.1

# hadolint ignore=DL4006
RUN set -eu; \
    pi_path="$(command -v pi 2>/dev/null || true)"; \
    if [ "$pi_path" != "/usr/local/bin/pi" ]; then \
        echo "ERROR: expected pi at /usr/local/bin/pi, got ${pi_path:-missing}" >&2; \
        exit 1; \
    fi; \
    test -x /usr/local/bin/pi; \
    pi_version="$(/usr/local/bin/pi --version)"; \
    installed_version="$(printf '%s' "$pi_version" | tr -d '[:space:]')"; \
    [ "$installed_version" = "${PI_VERSION}" ]

COPY agents/pi/generate-config.ts /opt/nemoclaw-pi/generate-config.ts
COPY scripts/lib/entrypoint-env-wrapper.sh /usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh
COPY agents/pi/start.sh /usr/local/bin/nemoclaw-start
COPY scripts/managed-startup-hold.sh /usr/local/bin/nemoclaw-managed-startup-hold
COPY --from=managed-bootstrap-entrypoint-builder /out/usr/local/bin/nemoclaw-managed-bootstrap /usr/local/bin/nemoclaw-managed-bootstrap
COPY --from=managed-bootstrap-entrypoint-builder /out/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh
COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/

RUN test -f /usr/local/bin/nemoclaw-managed-bootstrap \
    && test ! -L /usr/local/bin/nemoclaw-managed-bootstrap \
    && test "$(stat -c '%u:%g:%a' /usr/local/bin/nemoclaw-managed-bootstrap)" = '0:0:755' \
    && test -f /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh \
    && test ! -L /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh \
    && test "$(stat -c '%u:%g:%a' /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh)" = '0:0:444' \
    && chmod 444 /opt/nemoclaw-pi/generate-config.ts /usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh \
    && chmod 755 /usr/local/bin/nemoclaw-start /usr/local/bin/nemoclaw-managed-startup-hold \
    && chmod -R a+rX /opt/nemoclaw-blueprint

ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b
ARG NEMOCLAW_INFERENCE_PROVIDER_ID=inference
ARG NEMOCLAW_UPSTREAM_PROVIDER=nvidia
ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1
ARG NEMOCLAW_INFERENCE_API=openai-completions
ARG NEMOCLAW_CONTEXT_WINDOW=
# hadolint ignore=DL3064
ARG NEMOCLAW_MAX_TOKENS=
ARG NEMOCLAW_REASONING=
# Pi installs no optional package. The Pi image still declares the managed-image
# capability contract used by OpenClaw, Hermes, and Deep Agents Code.
ARG NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=0
ARG NEMOCLAW_BUILD_ID=default
ARG NEMOCLAW_DARWIN_VM_COMPAT=0
ARG NEMOCLAW_PROXY_HOST=10.200.0.1
ARG NEMOCLAW_PROXY_PORT=3128

RUN case "$NEMOCLAW_INFERENCE_API" in \
        openai-completions) ;; \
        *) echo "ERROR: NEMOCLAW_INFERENCE_API must be openai-completions for Pi" >&2; exit 1 ;; \
    esac

# The startup script reads the root-owned proxy host and port files instead of
# trusting process-level environment overrides.
RUN install -d -m 0755 /usr/local/share/nemoclaw \
    && printf '%s\n' "$NEMOCLAW_PROXY_HOST" > /usr/local/share/nemoclaw/pi-proxy-host \
    && printf '%s\n' "$NEMOCLAW_PROXY_PORT" > /usr/local/share/nemoclaw/pi-proxy-port \
    && chown root:root /usr/local/share/nemoclaw/pi-proxy-host /usr/local/share/nemoclaw/pi-proxy-port \
    && chmod 0444 /usr/local/share/nemoclaw/pi-proxy-host /usr/local/share/nemoclaw/pi-proxy-port

# hadolint ignore=DL3064
ENV HOME=/sandbox \
    PATH="/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" \
    NEMOCLAW_MODEL=${NEMOCLAW_MODEL} \
    NEMOCLAW_INFERENCE_PROVIDER_ID=${NEMOCLAW_INFERENCE_PROVIDER_ID} \
    NEMOCLAW_UPSTREAM_PROVIDER=${NEMOCLAW_UPSTREAM_PROVIDER} \
    NEMOCLAW_INFERENCE_BASE_URL=${NEMOCLAW_INFERENCE_BASE_URL} \
    NEMOCLAW_INFERENCE_API=${NEMOCLAW_INFERENCE_API} \
    NEMOCLAW_CONTEXT_WINDOW=${NEMOCLAW_CONTEXT_WINDOW} \
    NEMOCLAW_MAX_TOKENS=${NEMOCLAW_MAX_TOKENS} \
    NEMOCLAW_REASONING=${NEMOCLAW_REASONING} \
    NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE} \
    NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=${NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION} \
    NEMOCLAW_BUILD_ID=${NEMOCLAW_BUILD_ID} \
    PI_OFFLINE=1 \
    PI_TELEMETRY=0

WORKDIR /sandbox
RUN test "$(id -u sandbox):$(id -g sandbox):$(pwd)" = "999:999:/sandbox"
# hadolint ignore=DL3066
USER sandbox

# Generate the managed model catalog from the build arguments. OpenShell supplies
# the sandbox route credential at runtime, so this file is credential-free.
RUN umask 077 \
    && mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0 \
    && cp -r /opt/nemoclaw-blueprint/* /sandbox/.nemoclaw/blueprints/0.1.0/ \
    && node --experimental-strip-types /opt/nemoclaw-pi/generate-config.ts \
    && test "$(stat -c %a /sandbox/.pi/agent/models.json)" = "600"

# hadolint ignore=DL3066
USER root
RUN chown root:sandbox /sandbox \
    && chmod 1775 /sandbox \
    && test "$(stat -c '%U:%G:%a' /sandbox)" = 'root:sandbox:1775' \
    && chown root:root /sandbox/.nemoclaw \
    && chmod 1755 /sandbox/.nemoclaw \
    && chown -R root:root /sandbox/.nemoclaw/blueprints \
    && chmod -R 755 /sandbox/.nemoclaw/blueprints \
    && mkdir -p /sandbox/.nemoclaw/state /sandbox/.nemoclaw/migration /sandbox/.nemoclaw/snapshots /sandbox/.nemoclaw/staging \
    && chown sandbox:sandbox /sandbox/.nemoclaw/state /sandbox/.nemoclaw/migration /sandbox/.nemoclaw/snapshots /sandbox/.nemoclaw/staging \
    && printf '%s' '{}' > /sandbox/.nemoclaw/config.json \
    && chown sandbox:sandbox /sandbox/.nemoclaw/config.json

RUN if [ "$NEMOCLAW_DARWIN_VM_COMPAT" = "1" ]; then \
        chmod -R a+rwX /sandbox/.pi; \
        find /sandbox/.pi -type d -exec chmod a+rwx {} +; \
        for p in /sandbox/.nemoclaw/state /sandbox/.nemoclaw/migration /sandbox/.nemoclaw/snapshots /sandbox/.nemoclaw/staging; do \
            chmod -R a+rwX "$p"; \
            find "$p" -type d -exec chmod a+rwx {} +; \
        done; \
        chmod a+rw /sandbox/.nemoclaw/config.json; \
    fi

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
    python3 -c "import ctypes, sys; lib=ctypes.CDLL('libssh2.so.1'); lib.libssh2_version.restype=ctypes.c_char_p; lib.libssh2_version(0) == b'1.11.1' or sys.exit('unexpected libssh2 runtime version')"; \
    vim.tiny --version | head -n 1 | grep -Eq '^VIM - Vi IMproved 9[.]2 '; \
    vim.tiny --version | grep -Fx 'Included patches: 1-858'; \
    test -z "$(dpkg --audit)"
# End completed-image security package verification.

# Reject a build whose image environment or managed state carries a known
# upstream provider credential pattern.
# hadolint ignore=DL4006
RUN set -eu; \
    if env | grep -Eq '^(NVIDIA_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY)='; then \
        echo "ERROR: an upstream provider credential is present in the Pi image environment" >&2; \
        exit 1; \
    fi; \
    if grep -RIlEq '(nvapi-|sk-proj-|sk-ant-)[A-Za-z0-9_-]{10,}' /sandbox/.pi /usr/local/share/nemoclaw 2>/dev/null; then \
        echo "ERROR: a provider credential pattern is present in Pi managed state" >&2; \
        exit 1; \
    fi

ARG NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER=root
RUN case "$NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER" in \
        root|sandbox) ;; \
        *) echo "ERROR: NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER must be root or sandbox" >&2; exit 1 ;; \
    esac \
    && command -v setpriv >/dev/null 2>&1
USER ${NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER}
ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]
CMD []
