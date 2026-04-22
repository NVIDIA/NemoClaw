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
FROM ${BASE_IMAGE}

# Harden: remove unnecessary build tools and network probes from base image (#830)
RUN (apt-get remove --purge -y gcc gcc-12 g++ g++-12 cpp cpp-12 make \
        netcat-openbsd netcat-traditional ncat 2>/dev/null || true) \
    && apt-get autoremove --purge -y \
    && rm -rf /var/lib/apt/lists/*


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
    fi

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
    grep -REq --include='*.js' 'assertExplicitProxyAllowed\([^)]*\) \{ if \(process\.env\.OPENSHELL_SANDBOX === "1"\) return; /\* nemoclaw' "$OC_DIST"

# Set up blueprint for local resolution.
# Blueprints are immutable at runtime; DAC protection (root ownership) is applied
# later since /sandbox/.nemoclaw is Landlock read_write for plugin state (#804).
RUN mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0 \
    && cp -r /opt/nemoclaw-blueprint/* /sandbox/.nemoclaw/blueprints/0.1.0/

# Copy startup script
COPY scripts/nemoclaw-start.sh /usr/local/bin/nemoclaw-start
RUN chmod 755 /usr/local/bin/nemoclaw-start

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
# Set to "1" to disable device-pairing auth (development/headless only).
# Default: "0" (device auth enabled — secure by default).
ARG NEMOCLAW_DISABLE_DEVICE_AUTH=0
# Unique per build to ensure each image gets a fresh auth token.
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
    NEMOCLAW_INFERENCE_COMPAT_B64=${NEMOCLAW_INFERENCE_COMPAT_B64} \
    NEMOCLAW_MESSAGING_CHANNELS_B64=${NEMOCLAW_MESSAGING_CHANNELS_B64} \
    NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=${NEMOCLAW_MESSAGING_ALLOWED_IDS_B64} \
    NEMOCLAW_DISCORD_GUILDS_B64=${NEMOCLAW_DISCORD_GUILDS_B64} \
    NEMOCLAW_DISABLE_DEVICE_AUTH=${NEMOCLAW_DISABLE_DEVICE_AUTH} \
    NEMOCLAW_PROXY_HOST=${NEMOCLAW_PROXY_HOST} \
    NEMOCLAW_PROXY_PORT=${NEMOCLAW_PROXY_PORT} \
    NEMOCLAW_WEB_SEARCH_ENABLED=${NEMOCLAW_WEB_SEARCH_ENABLED}

WORKDIR /sandbox
USER sandbox

# Write the COMPLETE openclaw.json including gateway config and auth token.
# This file is immutable at runtime (Landlock read-only on /sandbox/.openclaw).
# No runtime writes to openclaw.json are needed or possible.
# Build args (NEMOCLAW_MODEL, CHAT_UI_URL) customize per deployment.
# Auth token is generated per build so each image has a unique token.
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
RUN python3 -c "\
import base64, json, os, secrets; \
from urllib.parse import urlparse; \
proxy_url = f\"http://{os.environ['NEMOCLAW_PROXY_HOST']}:{os.environ['NEMOCLAW_PROXY_PORT']}\"; \
model = os.environ['NEMOCLAW_MODEL']; \
chat_ui_url = os.environ['CHAT_UI_URL']; \
provider_key = os.environ['NEMOCLAW_PROVIDER_KEY']; \
primary_model_ref = os.environ['NEMOCLAW_PRIMARY_MODEL_REF']; \
inference_base_url = os.environ['NEMOCLAW_INFERENCE_BASE_URL']; \
inference_api = os.environ['NEMOCLAW_INFERENCE_API']; \
context_window = int(os.environ.get('NEMOCLAW_CONTEXT_WINDOW', '131072')); \
max_tokens = int(os.environ.get('NEMOCLAW_MAX_TOKENS', '4096')); \
reasoning = os.environ.get('NEMOCLAW_REASONING', 'false') == 'true'; \
inference_compat = json.loads(base64.b64decode(os.environ['NEMOCLAW_INFERENCE_COMPAT_B64']).decode('utf-8')); \
msg_channels = json.loads(base64.b64decode(os.environ.get('NEMOCLAW_MESSAGING_CHANNELS_B64', 'W10=') or 'W10=').decode('utf-8')); \
_allowed_ids = json.loads(base64.b64decode(os.environ.get('NEMOCLAW_MESSAGING_ALLOWED_IDS_B64', 'e30=') or 'e30=').decode('utf-8')); \
_discord_guilds = json.loads(base64.b64decode(os.environ.get('NEMOCLAW_DISCORD_GUILDS_B64', 'e30=') or 'e30=').decode('utf-8')); \
_token_keys = {'discord': 'token', 'telegram': 'botToken', 'slack': 'botToken'}; \
_env_keys = {'discord': 'DISCORD_BOT_TOKEN', 'telegram': 'TELEGRAM_BOT_TOKEN', 'slack': 'SLACK_BOT_TOKEN'}; \
_ch_cfg = {ch: {'accounts': {'default': {_token_keys[ch]: f'openshell:resolve:env:{_env_keys[ch]}', 'enabled': True, **({'appToken': 'openshell:resolve:env:SLACK_APP_TOKEN'} if ch == 'slack' else {}), **({'proxy': proxy_url} if ch in ('telegram', 'discord') else {}), **({'groupPolicy': 'open'} if ch == 'telegram' else {}), **({'dmPolicy': 'allowlist', 'allowFrom': _allowed_ids[ch]} if ch in _allowed_ids and _allowed_ids[ch] else {})}}} for ch in msg_channels if ch in _token_keys}; \
_ch_cfg['discord'].update({'groupPolicy': 'allowlist', 'guilds': _discord_guilds}) if 'discord' in _ch_cfg and _discord_guilds else None; \
parsed = urlparse(chat_ui_url); \
chat_origin = f'{parsed.scheme}://{parsed.netloc}' if parsed.scheme and parsed.netloc else 'http://127.0.0.1:18789'; \
origins = ['http://127.0.0.1:18789']; \
origins = list(dict.fromkeys(origins + [chat_origin])); \
disable_device_auth = os.environ.get('NEMOCLAW_DISABLE_DEVICE_AUTH', '') == '1'; \
allow_insecure = parsed.scheme == 'http'; \
providers = { \
    provider_key: { \
        'baseUrl': inference_base_url, \
        'apiKey': 'unused', \
        'api': inference_api, \
        'models': [{**({'compat': inference_compat} if inference_compat else {}), 'id': model, 'name': primary_model_ref, 'reasoning': reasoning, 'input': ['text'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'contextWindow': context_window, 'maxTokens': max_tokens}] \
    } \
}; \
config = { \
    'agents': {'defaults': {'model': {'primary': primary_model_ref}}}, \
    'models': {'mode': 'merge', 'providers': providers}, \
    'channels': dict({'defaults': {'configWrites': False}}, **_ch_cfg), \
    'update': {'checkOnStart': False}, \
    'gateway': { \
        'mode': 'local', \
        'controlUi': { \
            'allowInsecureAuth': allow_insecure, \
            'dangerouslyDisableDeviceAuth': disable_device_auth, \
            'allowedOrigins': origins, \
        }, \
        'trustedProxies': ['127.0.0.1', '::1'], \
        'auth': {'token': secrets.token_hex(32)} \
    } \
}; \
config.update({ \
    'tools': { \
        'web': { \
            'search': { \
                'enabled': True, \
                'provider': 'brave', \
                'apiKey': 'openshell:resolve:env:BRAVE_API_KEY' \
            }, \
            'fetch': {'enabled': True} \
        } \
    } \
}) if os.environ.get('NEMOCLAW_WEB_SEARCH_ENABLED', '') == '1' else None; \
path = os.path.expanduser('~/.openclaw/openclaw.json'); \
json.dump(config, open(path, 'w'), indent=2); \
os.chmod(path, 0o600)"

# Install NemoClaw plugin into OpenClaw
RUN openclaw doctor --fix > /dev/null 2>&1 || true \
    && openclaw plugins install /opt/nemoclaw > /dev/null 2>&1 || true

# Lock openclaw.json via DAC: chown to root so the sandbox user cannot modify
# it at runtime.  This works regardless of Landlock enforcement status.
# The Landlock policy (/sandbox/.openclaw in read_only) provides defense-in-depth
# once OpenShell enables enforcement.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/514
# Lock the entire .openclaw directory tree.
# SECURITY: chmod 755 (not 1777) — the sandbox user can READ but not WRITE
# to this directory. This prevents the agent from replacing symlinks
# (e.g., pointing /sandbox/.openclaw/hooks to an attacker-controlled path).
# The writable state lives in .openclaw-data, reached via the symlinks.
# hadolint ignore=DL3002
USER root

# Ensure .openclaw-data subdirs and symlinks exist for logs, credentials, and
# sandbox. These are defined in Dockerfile.base but the GHCR base image may
# not have been rebuilt yet. Idempotent — harmless once the base catches up.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/804
RUN mkdir -p /sandbox/.openclaw-data/logs \
        /sandbox/.openclaw-data/credentials \
        /sandbox/.openclaw-data/sandbox \
        /sandbox/.openclaw-data/media \
    && chown sandbox:sandbox /sandbox/.openclaw-data/logs \
        /sandbox/.openclaw-data/credentials \
        /sandbox/.openclaw-data/sandbox \
        /sandbox/.openclaw-data/media \
    && for dir in logs credentials sandbox media; do \
        if [ -L "/sandbox/.openclaw/$dir" ]; then true; \
        elif [ -e "/sandbox/.openclaw/$dir" ]; then \
            cp -a "/sandbox/.openclaw/$dir/." "/sandbox/.openclaw-data/$dir/" 2>/dev/null || true; \
            rm -rf "/sandbox/.openclaw/$dir"; \
            ln -s "/sandbox/.openclaw-data/$dir" "/sandbox/.openclaw/$dir"; \
        else \
            ln -s "/sandbox/.openclaw-data/$dir" "/sandbox/.openclaw/$dir"; \
        fi; \
    done \
    && if [ -e /sandbox/.openclaw-data/workspace/media ] && [ ! -L /sandbox/.openclaw-data/workspace/media ]; then \
        rm -rf /sandbox/.openclaw-data/workspace/media; \
    fi \
    && ln -sfn /sandbox/.openclaw-data/media /sandbox/.openclaw-data/workspace/media

# Ensure exec approvals path compatibility when using a stale published base
# image that still points to ~/.openclaw/exec-approvals.json.
RUN OPENCLAW_DIST_DIR="$(npm root -g)/openclaw/dist" \
    && if [ ! -d "$OPENCLAW_DIST_DIR" ]; then \
        echo "Error: OpenClaw dist directory not found: $OPENCLAW_DIST_DIR"; \
        exit 1; \
    fi \
    && mkdir -p /sandbox/.openclaw-data \
    && chown sandbox:sandbox /sandbox/.openclaw-data \
    && chmod 755 /sandbox/.openclaw-data \
    && LEGACY_EXEC_APPROVALS_PATH="$(printf '%b' '\176/.openclaw/exec-approvals.json')" \
    && DATA_EXEC_APPROVALS_PATH="$(printf '%b' '\176/.openclaw-data/exec-approvals.json')" \
    && files_with_old_path="$(grep -R --include='*.js' -l "$LEGACY_EXEC_APPROVALS_PATH" "$OPENCLAW_DIST_DIR" || true)" \
    && if [ -n "$files_with_old_path" ]; then \
        files_with_old_path_file="$(mktemp)"; \
        printf '%s\n' "$files_with_old_path" > "$files_with_old_path_file"; \
        while IFS= read -r file; do \
            sed -i "s#${LEGACY_EXEC_APPROVALS_PATH}#${DATA_EXEC_APPROVALS_PATH}#g" "$file"; \
        done < "$files_with_old_path_file"; \
        rm -f "$files_with_old_path_file"; \
    elif ! grep -R --include='*.js' -q "$DATA_EXEC_APPROVALS_PATH" "$OPENCLAW_DIST_DIR"; then \
        echo "Error: Unable to verify OpenClaw exec approvals path in dist"; \
        exit 1; \
    fi \
    && if grep -R --include='*.js' -n "$LEGACY_EXEC_APPROVALS_PATH" "$OPENCLAW_DIST_DIR"; then \
        echo "Error: OpenClaw exec approvals path patch failed"; \
        exit 1; \
    fi

RUN chown root:root /sandbox/.openclaw \
    && rm -rf /root/.npm /sandbox/.npm \
    && find /sandbox/.openclaw -mindepth 1 -maxdepth 1 -exec chown -h root:root {} + \
    && chmod 755 /sandbox/.openclaw \
    && chmod 444 /sandbox/.openclaw/openclaw.json

# Pin config hash at build time so the entrypoint can verify integrity.
# Prevents the agent from creating a copy with a tampered config and
# restarting the gateway pointing at it.
RUN sha256sum /sandbox/.openclaw/openclaw.json > /sandbox/.openclaw/.config-hash \
    && chmod 444 /sandbox/.openclaw/.config-hash \
    && chown root:root /sandbox/.openclaw/.config-hash

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
