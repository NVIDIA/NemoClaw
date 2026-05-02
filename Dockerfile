# NemoClaw sandbox image — OpenClaw + NemoClaw plugin inside OpenShell
#
# Layers PR-specific code (plugin, blueprint, config, startup script) on top
# of the pre-built base image from GHCR. The base image contains all the
# expensive, rarely-changing layers (apt, gosu, users, openclaw CLI).
#
# For local builds without GHCR access, build the base first:
#   docker build -f Dockerfile.base -t ghcr.io/nvidia/nemoclaw/sandbox-base:latest .

# Global ARG — must be declared before the first FROM to be visible
# to all FROM directives. Can be overridden via --build-arg.
ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest

# Stage 1: Build TypeScript plugin from source
FROM node:22-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS builder
ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
COPY nemoclaw/package.json nemoclaw/package-lock.json nemoclaw/tsconfig.json /opt/nemoclaw/
COPY nemoclaw/src/ /opt/nemoclaw/src/
WORKDIR /opt/nemoclaw
RUN npm ci && npm run build

# Stage 2: Runtime image — pull cached base from GHCR
# hadolint ignore=DL3006
FROM ${BASE_IMAGE}

# Harden: remove unnecessary build tools and network probes from base image (#830)
# Protect procps before autoremove — the GHCR base may predate the procps
# addition, leaving it absent or auto-marked. apt-mark + conditional install
# guarantees ps/top/kill are present regardless of base image staleness.
# Ref: #2343
# hadolint ignore=DL3001
RUN apt-mark manual procps 2>/dev/null || true \
    && (apt-get remove --purge -y gcc gcc-12 g++ g++-12 cpp cpp-12 make \
        netcat-openbsd netcat-traditional ncat 2>/dev/null || true) \
    && apt-get autoremove --purge -y \
    && if ! command -v ps >/dev/null 2>&1; then \
        apt-get update && apt-get install -y --no-install-recommends procps=2:4.0.2-3 \
        && rm -rf /var/lib/apt/lists/*; \
    else \
        rm -rf /var/lib/apt/lists/*; \
    fi \
    && ps --version


# Copy built plugin and blueprint into the sandbox
COPY --from=builder /opt/nemoclaw/dist/ /opt/nemoclaw/dist/
COPY nemoclaw/openclaw.plugin.json /opt/nemoclaw/
COPY nemoclaw/package.json nemoclaw/package-lock.json /opt/nemoclaw/
COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/

# Install runtime dependencies only (no devDependencies, no build step)
WORKDIR /opt/nemoclaw
RUN npm ci --omit=dev

# Upgrade OpenClaw if the base image is stale.
#
# The GHCR base image (sandbox-base:latest) may lag behind the version pinned
# in Dockerfile.base. When that happens the fetch-guard patches below fail
# because the target functions don't exist in the older OpenClaw. Rather than
# silently skipping patches (leaving the sandbox unpatched), upgrade OpenClaw
# in-place so every build gets the version the patches expect.
#
# The minimum required version comes from nemoclaw-blueprint/blueprint.yaml
# (already COPYed to /opt/nemoclaw-blueprint/ above).
# hadolint ignore=DL3059,DL4006
RUN set -eu; \
    MIN_VER=$(grep -m 1 'min_openclaw_version' /opt/nemoclaw-blueprint/blueprint.yaml | awk '{print $2}' | tr -d '"'); \
    [ -n "$MIN_VER" ] || { echo "ERROR: Could not parse min_openclaw_version from blueprint.yaml" >&2; exit 1; }; \
    CUR_VER=$(openclaw --version 2>/dev/null | awk '{print $2}' || echo "0.0.0"); \
    if [ "$(printf '%s\n%s' "$MIN_VER" "$CUR_VER" | sort -V | head -n1)" = "$MIN_VER" ]; then \
        echo "INFO: OpenClaw $CUR_VER is current (>= $MIN_VER), no upgrade needed"; \
    else \
        echo "INFO: Base image has OpenClaw $CUR_VER, upgrading to $MIN_VER (minimum required)"; \
        # npm 10's atomic-move install can hit EROFS on overlayfs when the
        # prior install spans multiple image layers (e.g. openclaw was
        # baked into sandbox-base, then we upgrade on top here). Clearing
        # at the shell level first gives npm a clean slate and avoids the
        # rmdir failure inside npm's own install path.
        rm -rf /usr/local/lib/node_modules/openclaw /usr/local/bin/openclaw; \
        npm install -g --no-audit --no-fund --no-progress "openclaw@${MIN_VER}"; \
    fi; \
    # Pre-install the codex-acp package so the embedded ACPx runtime can
    # call the local binary instead of `npx @zed-industries/codex-acp`.
    # The sandbox's L7 proxy denies @zed-industries/* package URLs
    # (403 policy_denied), and npm still refreshes registry metadata for
    # versioned npx package specs even when the package is globally installed.
    # Installing the binary at build time and configuring ACPx to use it
    # directly keeps TC-SBX-02 off the runtime npm path.
    npm install -g --no-audit --no-fund --no-progress \
        '@zed-industries/codex-acp@0.11.1'; \
    command -v codex-acp >/dev/null

# Patch OpenClaw media fetch for proxy-only sandbox (NVIDIA/NemoClaw#1755).
#
# NemoClaw forces all sandbox egress through the OpenShell L7 proxy
# (default 10.200.0.1:3128). Two layers of OpenClaw must be patched for
# Telegram/Discord/Slack media downloads to work in this environment:
#
# === Patch 1: redirect strict-mode export to trusted-env-proxy ===
# OpenClaw's media fetch path (fetch-ClF-ZgDC.js → fetchRemoteMedia) calls
# fetchWithSsrFGuard(withStrictGuardedFetchMode({...})) unconditionally.
# Strict mode does DNS-pinning + direct connect, which fails in the sandbox
# netns where only the proxy is reachable. Rewriting the fetch-guard module
# export so the strict alias maps to withTrustedEnvProxyGuardedFetchMode
# makes the existing callsite request proxy mode without touching callers.
# The export pattern `withStrictGuardedFetchMode as <letter>` is stable
# across versions while alias letters drift between minified bundles.
# Files that define withStrictGuardedFetchMode locally without an export
# (e.g. mattermost.js) keep their original strict behavior.
#
# === Patch 2: env-gated bypass for assertExplicitProxyAllowed ===
# OpenClaw 2026.4.2 added assertExplicitProxyAllowed() in fetch-guard,
# which validates the explicit proxy URL by passing the proxy hostname
# through resolvePinnedHostnameWithPolicy() with the *target's* SsrfPolicy.
# When the target uses hostnameAllowlist (Telegram media policy:
# `["api.telegram.org"]`), the proxy hostname (e.g. 10.200.0.1) gets
# rejected with "Blocked hostname (not in allowlist)". This is an upstream
# OpenClaw design flaw: a proxy is infrastructure, not a fetch target, and
# should not be filtered through the target's allowlist.
#
# Inject an early-return guarded by `process.env.OPENSHELL_SANDBOX === "1"`
# so the bypass only activates inside an OpenShell sandbox runtime, which
# is what NemoClaw deploys into. OpenShell injects this env var when it
# starts a sandbox pod; any consumer running the same openclaw bundle
# outside an OpenShell sandbox (bare-metal, another wrapper) does not have
# OPENSHELL_SANDBOX set and keeps the full upstream SSRF check. The L7
# proxy itself enforces per-endpoint network policy inside the sandbox,
# so the trust boundary for SSRF protection is unchanged.
#
# Image-level `ENV` does NOT work here: OpenShell controls the pod env at
# runtime and image ENV vars set by Dockerfile are stripped. OPENSHELL_SANDBOX
# is the only marker reliably present in the runtime.
#
# === Removal criteria ===
# Patch 1: drop when OpenClaw deprecates withStrictGuardedFetchMode or
#   when all media-fetch callsites unconditionally pass useEnvProxy.
# Patch 2: drop when OpenClaw fixes assertExplicitProxyAllowed to skip the
#   target hostname allowlist for the proxy hostname check (or exposes config
#   to disable the check).
#
# SYNC WITH OPENCLAW: these patches grep for specific exports and function
# definitions in the compiled OpenClaw dist (withStrictGuardedFetchMode,
# assertExplicitProxyAllowed). If OpenClaw renames, removes, or restructures
# either symbol in a future release, the grep will fail and the build will
# abort. When bumping OPENCLAW_VERSION, verify both symbols still exist in
# the new dist and update the regex / sed replacement accordingly.
#
# Both patches fail-close: if grep finds no targets, the build aborts so
# the next maintainer reviewing an OPENCLAW_VERSION bump knows to revisit.
# hadolint ignore=SC2016,DL3059,DL4006
RUN set -eu; \
    OC_DIST=/usr/local/lib/node_modules/openclaw/dist; \
    # --- Patch 1: rewrite fetch-guard export --- \
    fg_export="$(grep -RIlE --include='*.js' 'export \{[^}]*withStrictGuardedFetchMode as [a-z]' "$OC_DIST")"; \
    test -n "$fg_export"; \
    for f in $fg_export; do \
        grep -q 'withTrustedEnvProxyGuardedFetchMode' "$f" || { echo "ERROR: $f missing withTrustedEnvProxyGuardedFetchMode"; exit 1; }; \
    done; \
    printf '%s\n' "$fg_export" | xargs sed -i -E 's|withStrictGuardedFetchMode as ([a-z])|withTrustedEnvProxyGuardedFetchMode as \1|g'; \
    if grep -REq --include='*.js' 'withStrictGuardedFetchMode as [a-z]' "$OC_DIST"; then echo "ERROR: Patch 1 left strict-mode export alias" >&2; exit 1; fi; \
    # --- Patch 2: neutralize assertExplicitProxyAllowed --- \
    fg_assert="$(grep -RIlE --include='*.js' 'async function assertExplicitProxyAllowed' "$OC_DIST")"; \
    test -n "$fg_assert"; \
    printf '%s\n' "$fg_assert" | xargs sed -i -E 's|(async function assertExplicitProxyAllowed\([^)]*\) \{)|\1 if (process.env.OPENSHELL_SANDBOX === "1") return; /* nemoclaw: env-gated bypass, see Dockerfile */ |'; \
    grep -REq --include='*.js' 'assertExplicitProxyAllowed\([^)]*\) \{ if \(process\.env\.OPENSHELL_SANDBOX === "1"\) return; /\* nemoclaw' "$OC_DIST"; \
    # --- Patch 3: follow symlinks in plugin-install path checks (#2203) --- \
    # OpenClaw's install-safe-path and install-package-dir reject symlinked \
    # directories via lstat. Changing lstat → stat in these two modules lets \
    # symlinks resolve; the real security gates (realpath + isPathInside \
    # containment) remain intact — a symlink escaping the base tree is still caught. \
    # Scoped to install-safe-path + install-package-dir only. \
    isp_file="$(grep -RIlE --include='*.js' 'const baseLstat = await fs\.lstat\(baseDir\)' "$OC_DIST/install-safe-path-"*.js)"; \
    test -n "$isp_file" || { echo "ERROR: install-safe-path baseLstat pattern not found" >&2; exit 1; }; \
    sed -i 's/const baseLstat = await fs\.lstat(baseDir)/const baseLstat = await fs.stat(baseDir)/' "$isp_file"; \
    if grep -q 'const baseLstat = await fs\.lstat(baseDir)' "$isp_file"; then echo "ERROR: Patch 3a (install-safe-path) left baseLstat lstat call" >&2; exit 1; fi; \
    ipd_file="$(grep -RIlE --include='*.js' 'assertInstallBaseStable' "$OC_DIST/install-package-dir-"*.js)"; \
    test -n "$ipd_file" || { echo "ERROR: install-package-dir assertInstallBaseStable not found" >&2; exit 1; }; \
    sed -i 's/const baseLstat = await fs\.lstat(params\.installBaseDir)/const baseLstat = await fs.stat(params.installBaseDir)/' "$ipd_file"; \
    sed -i 's/baseLstat\.isSymbolicLink()/false \/* nemoclaw: symlink check disabled, realpath guards containment *\//' "$ipd_file"; \
    if grep -q 'fs\.lstat(params\.installBaseDir)' "$ipd_file"; then echo "ERROR: Patch 3b (install-package-dir) left lstat in assertInstallBaseStable" >&2; exit 1; fi; \
    # --- Patch 4: graceful EACCES in replaceConfigFile for sandbox (#2254) --- \
    # Plugin install persists metadata via replaceConfigFile. In the sandbox, \
    # openclaw.json is immutable (444 root:root) by design.  OpenClaw 2026.4.24 \
    # restructured config writes: replaceConfigFile now first attempts a \
    # single-key include-file mutation (tryWriteSingleTopLevelIncludeMutation), \
    # falling back to writeConfigFile for the full config.  Both paths can hit \
    # EACCES in the read-only sandbox tree.  This patch wraps the entire \
    # write block in a try/catch that catches EACCES when OPENSHELL_SANDBOX=1 \
    # and emits a warning instead of crashing.  Plugins still load via \
    # auto-discovery from the extensions directory. \
    rcf_file="$(grep -RIlE --include='*.js' 'async function replaceConfigFile\(params\)' "$OC_DIST" | head -n 1)"; \
    test -n "$rcf_file" || { echo "ERROR: replaceConfigFile function not found in OpenClaw dist" >&2; exit 1; }; \
    python3 -c "import sys; p=sys.argv[1]; f=open(p); src=f.read(); f.close(); old='\tif (!await tryWriteSingleTopLevelIncludeMutation({\n\t\tsnapshot,\n\t\tnextConfig: params.nextConfig\n\t})) await writeConfigFile(params.nextConfig, {\n\t\tbaseSnapshot: snapshot,\n\t\t...writeOptions,\n\t\t...params.writeOptions\n\t});'; new='\ttry { if (!await tryWriteSingleTopLevelIncludeMutation({\n\t\tsnapshot,\n\t\tnextConfig: params.nextConfig\n\t})) await writeConfigFile(params.nextConfig, {\n\t\tbaseSnapshot: snapshot,\n\t\t...writeOptions,\n\t\t...params.writeOptions\n\t}); } catch(_rcfErr) { if (process.env.OPENSHELL_SANDBOX === \"1\" && _rcfErr.code === \"EACCES\") { console.error(\"[nemoclaw] Config is read-only in sandbox \\u2014 plugin metadata not persisted (plugins auto-load from extensions/)\"); } else { throw _rcfErr; } }'; assert old in src, 'tryWriteSingleTopLevelIncludeMutation/writeConfigFile pattern not found in replaceConfigFile'; f=open(p,'w'); f.write(src.replace(old,new,1)); f.close()" "$rcf_file"; \
    grep -REq --include='*.js' 'OPENSHELL_SANDBOX.*EACCES' "$rcf_file" || { echo "ERROR: Patch 4 (replaceConfigFile EACCES) not applied" >&2; exit 1; }; \
    # --- Patch 5: bump default WS handshake timeout 10s -> 60s (#2484) --- \
    # OpenClaw's WS connect handshake has a hard-coded 10s timeout on both \
    # client and server. Server-side connect-handler processing can exceed \
    # 10s under load (multiple concurrent connects on slow CI infra), \
    # causing `openclaw agent --json` to fail with "gateway timeout after \
    # 10000ms" and TC-SBX-02 to hit its 90s SSH timeout. \
    # \
    # Both env vars (OPENCLAW_HANDSHAKE_TIMEOUT_MS, \
    # OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS) are clamped at the same \
    # DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS constant, so we patch the \
    # constant itself.  Affects both client.js (used by openclaw CLI) and \
    # server.impl.js (gateway side). \
    # \
    # Removal criteria: drop when openclaw fixes the underlying connect \
    # latency, or exposes the timeout as an unbounded env override. \
    hto_files="$(grep -RIlE --include='*.js' 'DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 1e4' "$OC_DIST")"; \
    test -n "$hto_files" || { echo "ERROR: handshake-timeout constant not found" >&2; exit 1; }; \
    printf '%s\n' "$hto_files" | xargs sed -i -E 's|DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 1e4|DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 6e4|g'; \
    if grep -REq --include='*.js' 'DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 1e4' "$OC_DIST"; then echo "ERROR: Patch 5 left a 1e4 constant" >&2; exit 1; fi

# Set up blueprint for local resolution.
# Blueprints are immutable at runtime; DAC protection (root ownership) is applied
# later since /sandbox/.nemoclaw is Landlock read_write for plugin state (#804).
RUN mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0 \
    && cp -r /opt/nemoclaw-blueprint/* /sandbox/.nemoclaw/blueprints/0.1.0/

# Copy startup script and shared sandbox initialisation library
COPY scripts/lib/sandbox-init.sh /usr/local/lib/nemoclaw/sandbox-init.sh
COPY scripts/nemoclaw-start.sh /usr/local/bin/nemoclaw-start
# Copy ws-proxy-fix.js to a Landlock-accessible path. OpenShell ≥0.0.36
# blocks /opt/nemoclaw-blueprint/ from non-root users, but the entrypoint
# needs to read this file to install the NODE_OPTIONS --require preload.
COPY nemoclaw-blueprint/scripts/ws-proxy-fix.js /usr/local/lib/nemoclaw/ws-proxy-fix.js
COPY scripts/codex-acp-wrapper.sh /usr/local/bin/nemoclaw-codex-acp
COPY scripts/generate-openclaw-config.py /usr/local/lib/nemoclaw/generate-openclaw-config.py
RUN chmod 755 /usr/local/bin/nemoclaw-start /usr/local/bin/nemoclaw-codex-acp /usr/local/lib/nemoclaw/sandbox-init.sh \
    && chmod 644 /usr/local/lib/nemoclaw/ws-proxy-fix.js

# Build args for config that varies per deployment.
# nemoclaw onboard passes these at image build time.
ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b
ARG NEMOCLAW_PROVIDER_KEY=nvidia
ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b
# Default dashboard port 18789 — override at runtime via NEMOCLAW_DASHBOARD_PORT.
ARG CHAT_UI_URL=http://127.0.0.1:18789
ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1
ARG NEMOCLAW_INFERENCE_API=openai-completions
ARG NEMOCLAW_CONTEXT_WINDOW=131072
ARG NEMOCLAW_MAX_TOKENS=4096
ARG NEMOCLAW_REASONING=false
# Comma-separated list of input modalities accepted by the primary model
# (e.g. "text" or "text,image" for vision-capable models). OpenClaw's
# model schema currently accepts "text" and "image". See #2421.
ARG NEMOCLAW_INFERENCE_INPUTS=text
# Per-request inference timeout (seconds) baked into agents.defaults.timeoutSeconds.
# Increase for slow local inference (e.g., CPU Ollama). openclaw.json is
# immutable at runtime (Landlock read-only), so this can only be changed by
# rebuilding via `nemoclaw onboard`. Ref: issue #2281
ARG NEMOCLAW_AGENT_TIMEOUT=600
ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=
# Base64-encoded JSON list of messaging channel names to pre-configure
# (e.g. ["discord","telegram"]). Channels are added with placeholder tokens
# so the L7 proxy can rewrite them at egress. Default: empty list.
ARG NEMOCLAW_MESSAGING_CHANNELS_B64=W10=
# Base64-encoded JSON map of channel→allowed sender IDs for DM allowlisting
# (e.g. {"telegram":["123456789"]}). Channels with IDs get dmPolicy=allowlist;
# channels without IDs keep the OpenClaw default (pairing). Default: empty map.
ARG NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=e30=
# Base64-encoded JSON map of Discord guild configs keyed by server ID
# (e.g. {"1234567890":{"requireMention":true,"users":["555"]}}).
# Used to enable guild-channel responses for native Discord. Default: empty map.
ARG NEMOCLAW_DISCORD_GUILDS_B64=e30=
# Base64-encoded JSON Telegram config (e.g. {"requireMention":true}).
# When requireMention is true, Telegram groups get groupPolicy: mentions;
# otherwise groupPolicy: open (existing default). See #1737. Default: empty map.
ARG NEMOCLAW_TELEGRAM_CONFIG_B64=e30=
# Set to "1" to force-disable device-pairing auth. Also auto-disabled when
# CHAT_UI_URL is a non-loopback address (Brev Launchable, remote deployments)
# since terminal-based pairing is impossible in those contexts.
# Default: "0" (device auth enabled for local deployments — secure by default).
ARG NEMOCLAW_DISABLE_DEVICE_AUTH=0
# Unique per build — busts the Docker cache for the token-injection layer
# so each image gets a fresh gateway auth token.
# Pass --build-arg NEMOCLAW_BUILD_ID=$(date +%s) to bust the cache.
ARG NEMOCLAW_BUILD_ID=default
# Sandbox egress proxy host/port. Defaults match the OpenShell-injected
# gateway (10.200.0.1:3128). Operators on non-default networks can override
# at sandbox creation time by exporting NEMOCLAW_PROXY_HOST / NEMOCLAW_PROXY_PORT
# before running `nemoclaw onboard`. See #1409.
ARG NEMOCLAW_PROXY_HOST=10.200.0.1
ARG NEMOCLAW_PROXY_PORT=3128
# Non-secret flag: set to "1" when the user configured Brave Search during
# onboard. Controls whether the web search block is written to openclaw.json.
# The actual API key is injected at runtime via openshell:resolve:env, never
# baked into the image.
ARG NEMOCLAW_WEB_SEARCH_ENABLED=0

# SECURITY: Promote build-args to env vars so the Python script reads them
# via os.environ, never via string interpolation into Python source code.
# Direct ARG interpolation into python3 -c is a code injection vector (C-2).
ENV NEMOCLAW_MODEL=${NEMOCLAW_MODEL} \
    NEMOCLAW_PROVIDER_KEY=${NEMOCLAW_PROVIDER_KEY} \
    NEMOCLAW_PRIMARY_MODEL_REF=${NEMOCLAW_PRIMARY_MODEL_REF} \
    CHAT_UI_URL=${CHAT_UI_URL} \
    NEMOCLAW_INFERENCE_BASE_URL=${NEMOCLAW_INFERENCE_BASE_URL} \
    NEMOCLAW_INFERENCE_API=${NEMOCLAW_INFERENCE_API} \
    NEMOCLAW_CONTEXT_WINDOW=${NEMOCLAW_CONTEXT_WINDOW} \
    NEMOCLAW_MAX_TOKENS=${NEMOCLAW_MAX_TOKENS} \
    NEMOCLAW_REASONING=${NEMOCLAW_REASONING} \
    NEMOCLAW_INFERENCE_INPUTS=${NEMOCLAW_INFERENCE_INPUTS} \
    NEMOCLAW_AGENT_TIMEOUT=${NEMOCLAW_AGENT_TIMEOUT} \
    NEMOCLAW_INFERENCE_COMPAT_B64=${NEMOCLAW_INFERENCE_COMPAT_B64} \
    NEMOCLAW_MESSAGING_CHANNELS_B64=${NEMOCLAW_MESSAGING_CHANNELS_B64} \
    NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=${NEMOCLAW_MESSAGING_ALLOWED_IDS_B64} \
    NEMOCLAW_DISCORD_GUILDS_B64=${NEMOCLAW_DISCORD_GUILDS_B64} \
    NEMOCLAW_TELEGRAM_CONFIG_B64=${NEMOCLAW_TELEGRAM_CONFIG_B64} \
    NEMOCLAW_DISABLE_DEVICE_AUTH=${NEMOCLAW_DISABLE_DEVICE_AUTH} \
    NEMOCLAW_PROXY_HOST=${NEMOCLAW_PROXY_HOST} \
    NEMOCLAW_PROXY_PORT=${NEMOCLAW_PROXY_PORT} \
    NEMOCLAW_WEB_SEARCH_ENABLED=${NEMOCLAW_WEB_SEARCH_ENABLED}

WORKDIR /sandbox
USER sandbox

# Write openclaw.json with gateway config but WITHOUT the real auth token.
# The gateway auth token is generated at container startup by the entrypoint
# and passed via OPENCLAW_GATEWAY_TOKEN env var only to the gateway process
# (running as 'gateway' user). The token file location depends on startup mode:
#   Root mode:     /run/nemoclaw/gateway-token (gateway:gateway 0400)
#   Non-root mode: $XDG_RUNTIME_DIR/nemoclaw/gateway-token (sandbox:sandbox 0400)
# See: scripts/nemoclaw-start.sh generate_gateway_token()
#
# Config is mutable by default (600 sandbox:sandbox). Immutability is opt-in
# via `shields up` (DAC 444 root:root + chattr +i).
# Build args (NEMOCLAW_MODEL, CHAT_UI_URL) customize per deployment.
#
# Temporary workaround for NemoClaw#1738: the OpenClaw Discord extension's
# gateway uses `ws` (via @buape/carbon), which ignores HTTPS_PROXY/HTTP_PROXY
# env vars and opens a direct TCP socket to gateway.discord.gg. Sandbox netns
# blocks direct egress, so the WSS handshake never reaches Discord and the
# bot loops on close-code 1006. Baking `accounts.default.proxy` into
# openclaw.json feeds DiscordAccountConfig.proxy, which the gateway plugin
# threads through to the `ws` `agent` option, routing the upgrade through
# the OpenShell proxy. Mirror of the Telegram treatment immediately below.
# Remove once OpenClaw lands an env-var-honouring fix for the Discord
# gateway equivalent to openclaw/openclaw#62878 (Slack Socket Mode).
# Generate openclaw.json from environment variables. Config generation logic
# lives in scripts/generate-openclaw-config.py — see that file for the full
# list of env vars and derivation rules.
RUN python3 /usr/local/lib/nemoclaw/generate-openclaw-config.py

# Install NemoClaw plugin into OpenClaw. Prune non-runtime metadata from
# staged bundled plugin dependencies before this layer is committed; deleting
# it in a later layer would not reduce the OCI image imported by k3s.
RUN (openclaw doctor --fix > /dev/null 2>&1 || true) \
    && (openclaw plugins install /opt/nemoclaw > /dev/null 2>&1 || true) \
    && if [ -d /sandbox/.openclaw/plugin-runtime-deps ]; then \
        find /sandbox/.openclaw/plugin-runtime-deps -type f \( \
            -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o \
            -name '*.map' -o -name '*.tsbuildinfo' \
        \) -delete; \
        find /sandbox/.openclaw/plugin-runtime-deps -type d \( \
            -name __tests__ -o -name test -o -name tests -o -name docs -o \
            -name examples \
        \) -prune -exec rm -rf {} +; \
    fi

# SECURITY: Clear any gateway auth token that openclaw doctor/plugins may have
# auto-generated. The real token is created at container startup by the
# entrypoint (generate_gateway_token) and never stored in openclaw.json.
RUN python3 -c "\
import json, os; \
path = os.path.expanduser('~/.openclaw/openclaw.json'); \
cfg = json.load(open(path)); \
cfg.setdefault('gateway', {}).setdefault('auth', {})['token'] = ''; \
json.dump(cfg, open(path, 'w'), indent=2); \
os.chmod(path, 0o600)"

# Flatten stale published base images that still contain the old
# .openclaw-data symlink bridge. OpenShell starts the sandbox as the sandbox
# user, so runtime migration cannot rely on root privileges inside the pod.
# Doing this in the image build guarantees new PR images have only the unified
# .openclaw layout even when sandbox-base:latest has not been rebuilt yet.
# hadolint ignore=DL3002
USER root
# hadolint ignore=DL4006
RUN set -eu; \
    config_dir=/sandbox/.openclaw; \
    data_dir=/sandbox/.openclaw-data; \
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
    mkdir -p "$config_dir/agents/main/agent" \
        "$config_dir/extensions" \
        "$config_dir/workspace" \
        "$config_dir/skills" \
        "$config_dir/hooks" \
        "$config_dir/identity" \
        "$config_dir/devices" \
        "$config_dir/canvas" \
        "$config_dir/cron" \
        "$config_dir/memory" \
        "$config_dir/logs" \
        "$config_dir/credentials" \
        "$config_dir/flows" \
        "$config_dir/sandbox" \
        "$config_dir/telegram" \
        "$config_dir/media" \
        "$config_dir/plugin-runtime-deps"; \
    touch "$config_dir/update-check.json" "$config_dir/exec-approvals.json"; \
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
    rm -rf /root/.npm /sandbox/.npm

# Stale-base fallback for the gateway-in-sandbox-group setup (#2681).
# Newer base images already add the gateway user to the sandbox group, but
# the derived image must remain build-clean against older sandbox-base:latest
# tags too. The `id -nG` check makes this idempotent.
# hadolint ignore=DL4006
RUN if id gateway >/dev/null 2>&1 && id sandbox >/dev/null 2>&1; then \
        if ! id -nG gateway | tr ' ' '\n' | grep -qx sandbox; then \
            usermod -aG sandbox gateway; \
        fi; \
    fi

# Keep the image readable to the root entrypoint after capabilities are
# dropped. OpenShell starts the runtime as the sandbox user; the entrypoint
# restores the stricter mutable-default 600/700 permissions there.
# Shields-up applies 444 root:root + chattr +i on top.
#
# `chmod g+w` + setgid (chmod g+s on dirs) on the mutable config tree means
# both `sandbox` and `gateway` (now a member of the sandbox group) can write
# to OpenClaw config/state in default mode. New files created in setgid
# directories inherit group=sandbox regardless of which UID created them,
# so OpenClaw's mutateConfigFile path (control-UI toggles) writes succeed
# without needing an EACCES-swallow patch (#2681 supersedes #2693).
RUN chown -R sandbox:sandbox /sandbox/.openclaw \
    && chmod 755 /sandbox/.openclaw \
    && chmod 644 /sandbox/.openclaw/openclaw.json \
    && chmod -R g+w /sandbox/.openclaw \
    && find /sandbox/.openclaw -type d -exec chmod g+s {} +

# Pin config hash at build time so the entrypoint can verify integrity.
RUN sha256sum /sandbox/.openclaw/openclaw.json > /sandbox/.openclaw/.config-hash \
    && chmod 664 /sandbox/.openclaw/.config-hash \
    && chown sandbox:sandbox /sandbox/.openclaw/.config-hash

# DAC-protect .nemoclaw directory: /sandbox/.nemoclaw is Landlock read_write
# (for plugin state/config), but the parent and blueprints are immutable at
# runtime. Root ownership on the parent prevents the agent from renaming or
# replacing the root-owned blueprints directory. Only state/, migration/,
# snapshots/, and config.json are sandbox-owned for runtime writes.
# Sticky bit (1755): OpenShell's prepare_filesystem() chowns read_write paths
# to run_as_user at sandbox start, flipping this dir to sandbox:sandbox.
# The sticky bit survives the chown and prevents the sandbox user from
# renaming or deleting root-owned entries (blueprints/).
# Ref: https://github.com/NVIDIA/NemoClaw/issues/804
# Ref: https://github.com/NVIDIA/NemoClaw/issues/1607
RUN chown root:root /sandbox/.nemoclaw \
    && chmod 1755 /sandbox/.nemoclaw \
    && chown -R root:root /sandbox/.nemoclaw/blueprints \
    && chmod -R 755 /sandbox/.nemoclaw/blueprints \
    && mkdir -p /sandbox/.nemoclaw/state /sandbox/.nemoclaw/migration /sandbox/.nemoclaw/snapshots /sandbox/.nemoclaw/staging \
    && chown sandbox:sandbox /sandbox/.nemoclaw/state /sandbox/.nemoclaw/migration /sandbox/.nemoclaw/snapshots /sandbox/.nemoclaw/staging \
    && touch /sandbox/.nemoclaw/config.json \
    && chown sandbox:sandbox /sandbox/.nemoclaw/config.json

# Entrypoint runs as root to start the gateway as the gateway user,
# then drops to sandbox for agent commands. See nemoclaw-start.sh.
ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]
CMD ["/bin/bash"]
