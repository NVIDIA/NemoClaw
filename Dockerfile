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
FROM node:22-trixie-slim@sha256:2d9f5c76c8f4dd36e8f253bee5d828a83a6c09f36188f0b0414325232e0b175d AS builder
ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_FETCH_TIMEOUT=300000
COPY nemoclaw/package.json nemoclaw/package-lock.json nemoclaw/tsconfig.json /opt/nemoclaw/
COPY nemoclaw/src/ /opt/nemoclaw/src/
WORKDIR /opt/nemoclaw
RUN npm ci && npm run build

# Stage 2: Runtime image — pull cached base from GHCR
# hadolint ignore=DL3006
FROM ${BASE_IMAGE}
ARG OPENCLAW_VERSION=2026.5.27
ARG OPENCLAW_2026_5_27_INTEGRITY=sha512-2N93zhdAo88KAbHt6T7KvYXf4s7XIkYXBgv1npYpn7e1Y9FvrtgtpsA38my9rtFW+70uXEojRPX5/OqnuDqJPw==

# OpenClaw 2026.5.27 loads some generated source through jiti. Disable its
# filesystem transform cache so source fragments that mention provider marker
# names do not persist under /tmp/jiti inside the sandbox.
ENV JITI_FS_CACHE=false

# Harden: remove unnecessary build tools and network probes from base image (#830)
# Protect runtime tools before autoremove — the GHCR base may predate the
# procps/e2fsprogs/tmux additions, leaving ps/chattr/tmux absent or auto-marked.
# The conditional install keeps stale bases usable while fresh bases skip apt.
# tmux is required by OpenClaw's bundled tmux-session flow (#4513); a stale base
# without it makes that flow fail with `tmux: command not found`.
# Refs: #2343, #4513, shields-up chattr hardening
# hadolint ignore=DL3001
RUN set -eu; \
    apt-mark manual procps e2fsprogs tmux 2>/dev/null || true; \
    (apt-get remove --purge -y gcc gcc-12 g++ g++-12 cpp cpp-12 make \
        netcat-openbsd netcat-traditional ncat 2>/dev/null || true); \
    apt-get autoremove --purge -y; \
    needs_ps=0; \
    needs_chattr=0; \
    needs_tmux=0; \
    if ! command -v ps >/dev/null 2>&1; then needs_ps=1; fi; \
    if ! command -v chattr >/dev/null 2>&1; then needs_chattr=1; fi; \
    if ! command -v tmux >/dev/null 2>&1; then needs_tmux=1; fi; \
    if [ "$needs_ps" = "1" ] || [ "$needs_chattr" = "1" ] || [ "$needs_tmux" = "1" ]; then \
        apt-get update; \
        if [ "$needs_ps" = "1" ]; then \
            apt-get install -y --no-install-recommends procps=2:4.0.4-9; \
        fi; \
        if [ "$needs_chattr" = "1" ]; then \
            apt-get install -y --no-install-recommends e2fsprogs=1.47.2-3+b11; \
        fi; \
        if [ "$needs_tmux" = "1" ]; then \
            apt-get install -y --no-install-recommends tmux=3.5a-3; \
        fi; \
    fi; \
    rm -rf /var/lib/apt/lists/*; \
    ps --version; \
    command -v chattr >/dev/null; \
    command -v tmux >/dev/null


# Copy built plugin and blueprint into the sandbox
COPY --from=builder /opt/nemoclaw/dist/ /opt/nemoclaw/dist/
COPY nemoclaw/openclaw.plugin.json /opt/nemoclaw/
COPY nemoclaw/package.json nemoclaw/package-lock.json /opt/nemoclaw/
COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/
RUN chmod -R a+rX /opt/nemoclaw /opt/nemoclaw-blueprint/

# Install runtime dependencies only (no devDependencies, no build step)
WORKDIR /opt/nemoclaw
ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_FETCH_TIMEOUT=300000
RUN npm ci --omit=dev
COPY scripts/patch-openclaw-tool-catalog.js /usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.js
COPY scripts/patch-openclaw-chat-send.js /usr/local/lib/nemoclaw/patch-openclaw-chat-send.js
COPY scripts/patch-openclaw-slack-deny-feedback.mts /usr/local/lib/nemoclaw/patch-openclaw-slack-deny-feedback.mts
RUN chmod 755 /usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.js \
        /usr/local/lib/nemoclaw/patch-openclaw-chat-send.js \
        /usr/local/lib/nemoclaw/patch-openclaw-slack-deny-feedback.mts

# Upgrade OpenClaw if the base image is stale.
#
# The GHCR base image (sandbox-base:latest) may lag behind the version pinned
# in Dockerfile.base. When that happens the fetch-guard patches below fail
# because the target functions don't exist in the older OpenClaw. Rather than
# silently skipping patches (leaving the sandbox unpatched), upgrade OpenClaw
# in-place so every build gets the version the patches expect.
#
# OPENCLAW_VERSION is the NemoClaw runtime build target. It must be at least the
# blueprint minimum, which also supports the legacy direct-blueprint image path.
# hadolint ignore=DL3059,DL4006
RUN set -eu; \
    echo "$OPENCLAW_VERSION" | grep -qxE '[0-9]+(\.[0-9]+)*' \
        || { echo "ERROR: OPENCLAW_VERSION='$OPENCLAW_VERSION' is invalid (expected e.g. 2026.3.11)" >&2; exit 1; }; \
    MIN_VER=$(grep -m 1 'min_openclaw_version' /opt/nemoclaw-blueprint/blueprint.yaml | awk '{print $2}' | tr -d '"'); \
    [ -n "$MIN_VER" ] || { echo "ERROR: Could not parse min_openclaw_version from blueprint.yaml" >&2; exit 1; }; \
    if [ "$(printf '%s\n%s' "$MIN_VER" "$OPENCLAW_VERSION" | sort -V | head -n1)" != "$MIN_VER" ]; then \
        echo "ERROR: OpenClaw build target ${OPENCLAW_VERSION} is below blueprint minimum ${MIN_VER}" >&2; exit 1; \
    fi; \
    EXPECTED_INTEGRITY=""; \
    if [ "$OPENCLAW_VERSION" = "2026.5.27" ]; then EXPECTED_INTEGRITY="$OPENCLAW_2026_5_27_INTEGRITY"; fi; \
    if [ -n "$EXPECTED_INTEGRITY" ]; then \
        REGISTRY_INTEGRITY=$(npm view "openclaw@${OPENCLAW_VERSION}" dist.integrity); \
        if [ "$REGISTRY_INTEGRITY" != "$EXPECTED_INTEGRITY" ]; then \
            echo "ERROR: OpenClaw ${OPENCLAW_VERSION} npm integrity mismatch" >&2; \
            echo "Expected: ${EXPECTED_INTEGRITY}" >&2; \
            echo "Actual:   ${REGISTRY_INTEGRITY}" >&2; exit 1; \
        fi; \
    fi; \
    CUR_VER=$(openclaw --version 2>/dev/null | awk '{print $2}' || echo "0.0.0"); \
    if [ "$(printf '%s\n%s' "$OPENCLAW_VERSION" "$CUR_VER" | sort -V | head -n1)" = "$OPENCLAW_VERSION" ]; then \
        echo "INFO: OpenClaw $CUR_VER is current (>= $OPENCLAW_VERSION), no upgrade needed"; \
    else \
        echo "INFO: Base image has OpenClaw $CUR_VER, upgrading to $OPENCLAW_VERSION"; \
        # npm 10's atomic-move install can hit EROFS on overlayfs when the
        # prior install spans multiple image layers (e.g. openclaw was
        # baked into sandbox-base, then we upgrade on top here). Clearing
        # at the shell level first gives npm a clean slate and avoids the
        # rmdir failure inside npm's own install path.
        rm -rf /usr/local/lib/node_modules/openclaw /usr/local/bin/openclaw; \
        npm install -g --no-audit --no-fund --no-progress "openclaw@${OPENCLAW_VERSION}"; \
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
# === Patch 2b: allow OpenShell host gateway through web_fetch guard ===
# OpenClaw's web_fetch SSRF guard blocks *.internal hostnames before the
# OpenShell L7 proxy sees the request. NemoClaw users legitimately reach
# host-local approved services through host.openshell.internal after the
# OpenShell policy explicitly allows that host:port. Add this exact hostname
# only to the web_fetch trusted-env-proxy policy, only inside an OpenShell
# sandbox. The generic SSRF helper and strict/direct DNS-pinned paths remain
# unmodified, so metadata/link-local/private IP literals are unchanged.
#
# === Patch 4: route unconfigured strict SSRF fetches through the egress proxy ===
# (NVIDIA/NemoClaw#4687). fetchWithSsrFGuard builds a per-request DNS-pinned
# *direct* undici dispatcher for STRICT-mode fetches that pass no explicit
# dispatcherPolicy — e.g. the @openclaw/googlechat inbound JWT signing-cert
# fetch from www.googleapis.com/service_accounts/v1/metadata/x509/.... A direct
# dispatcher ignores the global EnvHttpProxyAgent installed by
# NODE_USE_ENV_PROXY=1, so the request never reaches the OpenShell L7 proxy and
# fails in the proxy-only sandbox netns — rejecting every inbound Google Chat
# webhook. OpenClaw already has a "managed proxy" branch that routes such
# fetches through the env proxy (createHttp1EnvHttpProxyAgent) while still
# resolving + SSRF-validating the target hostname, but it is gated on
# isManagedProxyActive() (OPENCLAW_PROXY_ACTIVE=1), which NemoClaw does not set.
# Inside an OpenShell sandbox the configured egress proxy IS the managed proxy,
# so extend that activation to OPENSHELL_SANDBOX=1 for fetches that supply no
# explicit dispatcherPolicy. Explicit-proxy and direct(mTLS) dispatcher policies
# (Google auth proxy / client-cert paths) keep their existing behavior, and
# resolvePinnedHostnameWithPolicy still blocks private/link-local targets.
#
# === Removal criteria ===
# Patch 1: drop when OpenClaw deprecates withStrictGuardedFetchMode or
#   when all media-fetch callsites unconditionally pass useEnvProxy.
# Patch 2: drop when OpenClaw fixes assertExplicitProxyAllowed to skip the
#   target hostname allowlist for the proxy hostname check (or exposes config
#   to disable the check).
# Patch 2b: drop when OpenClaw ships a reviewed web_fetch trusted-proxy SSRF
#   policy surface that can allow host.openshell.internal without allowing
#   broader private/special-use hostnames.
# Patch 4: drop when OpenClaw routes unconfigured strict fetches through the
#   env proxy in proxy-only environments without OPENCLAW_PROXY_ACTIVE, or when
#   NemoClaw sets OPENCLAW_PROXY_ACTIVE=1 in the sandbox runtime instead.
#
# SYNC WITH OPENCLAW: these patches classify the compiled OpenClaw dist at
# build time. They apply the legacy patch when the old target exists, skip
# only when the dist shape proves OpenClaw no longer needs that patch, and
# fail with the OpenClaw version plus dist path for mixed or unknown shapes.
# When bumping OPENCLAW_VERSION, verify the new dist
# takes the expected branch and update the regex / sed replacement if needed.
# hadolint ignore=SC2016,DL3059,DL4006
RUN set -eu; \
    OC_DIST=/usr/local/lib/node_modules/openclaw/dist; \
    OC_VERSION="$(openclaw --version 2>/dev/null | awk '{print $2}' || true)"; \
    OC_VERSION="${OC_VERSION:-unknown}"; \
    patch_fail() { \
        echo "ERROR: OpenClaw ${OC_VERSION} fetch-guard patch cannot classify this dist shape: $*" >&2; \
        echo "       Inspect ${OC_DIST} and update the Dockerfile patch rules for this OpenClaw layout." >&2; \
        exit 1; \
    }; \
    # --- Patch 1: rewrite fetch-guard export --- \
    fg_export="$(grep -RIlE --include='*.js' 'export \{[^}]*withStrictGuardedFetchMode as [a-z]' "$OC_DIST" || true)"; \
    if [ -n "$fg_export" ]; then \
        for f in $fg_export; do \
            grep -q 'withTrustedEnvProxyGuardedFetchMode' "$f" || patch_fail "Patch 1 target $f is missing withTrustedEnvProxyGuardedFetchMode"; \
        done; \
        printf '%s\n' "$fg_export" | xargs sed -i -E 's|withStrictGuardedFetchMode as ([a-z])|withTrustedEnvProxyGuardedFetchMode as \1|g'; \
        if grep -REq --include='*.js' 'withStrictGuardedFetchMode as [a-z]' "$OC_DIST"; then echo "ERROR: Patch 1 left strict-mode export alias" >&2; exit 1; fi; \
        echo "INFO: Patch 1 applied to OpenClaw ${OC_VERSION} strict fetch export"; \
    else \
        strict_refs="$(grep -RIl --include='*.js' 'withStrictGuardedFetchMode' "$OC_DIST" || true)"; \
        trusted_refs="$(grep -RIl --include='*.js' 'withTrustedEnvProxyGuardedFetchMode' "$OC_DIST" || true)"; \
        media_fetch_files="$(grep -RIl --include='*.js' 'fetchGuardedMediaResponse' "$OC_DIST" || true)"; \
        trusted_media_fetch=0; \
        untrusted_media_fetch=0; \
        for f in $media_fetch_files; do \
            if ! grep -q 'fetchWithSsrFGuard' "$f"; then \
                continue; \
            elif grep -E 'fetchWithSsrFGuard' "$f" | grep -q 'withTrustedEnvProxyGuardedFetchMode' \
                && ! grep -E 'fetchWithSsrFGuard' "$f" | grep -vq 'withTrustedEnvProxyGuardedFetchMode'; then \
                trusted_media_fetch=1; \
            else \
                echo "ERROR: Patch 1 unreviewed media fetch shape in $f" >&2; \
                untrusted_media_fetch=1; \
            fi; \
        done; \
        if [ "$OC_VERSION" != "unknown" ] && [ -z "$strict_refs" ] && [ -n "$trusted_refs" ] && [ "$trusted_media_fetch" = "1" ] && [ "$untrusted_media_fetch" = "0" ]; then \
            echo "INFO: OpenClaw ${OC_VERSION} has no withStrictGuardedFetchMode references; Patch 1 not needed"; \
        elif [ -z "$trusted_refs" ]; then \
            patch_fail "Patch 1 target missing and withTrustedEnvProxyGuardedFetchMode is also absent"; \
        else \
            echo "ERROR: Patch 1 target missing but the fetch-guard shape is not a reviewed trusted-proxy-only layout:" >&2; \
            if [ -n "$strict_refs" ]; then printf '%s\n' "$strict_refs" | head -n 5 >&2; fi; \
            patch_fail "Patch 1 cannot safely skip"; \
        fi; \
    fi; \
    # --- Patch 2: neutralize assertExplicitProxyAllowed --- \
    fg_assert="$(grep -RIlE --include='*.js' 'async function assertExplicitProxyAllowed' "$OC_DIST" || true)"; \
    if [ -n "$fg_assert" ]; then \
        patched_assert=0; \
        for f in $fg_assert; do \
            if grep -q 'process.env.OPENSHELL_SANDBOX === "1"' "$f"; then \
                echo "INFO: Patch 2 already present in $f"; \
            else \
                sed -i -E 's|(async function assertExplicitProxyAllowed\([^)]*\) \{)|\1 if (process.env.OPENSHELL_SANDBOX === "1") return; /* nemoclaw: env-gated bypass, see Dockerfile */ |' "$f"; \
                grep -Eq 'assertExplicitProxyAllowed\([^)]*\) \{ if \(process\.env\.OPENSHELL_SANDBOX === "1"\) return; /\* nemoclaw' "$f" \
                    || patch_fail "Patch 2 verification failed for $f"; \
                patched_assert=1; \
            fi; \
        done; \
        if [ "$patched_assert" = "1" ]; then \
            echo "INFO: Patch 2 applied to OpenClaw ${OC_VERSION} explicit proxy validator"; \
        fi; \
    else \
        proxy_hostname_checks="$(grep -RIlE --include='*.js' 'resolvePinnedHostnameWithPolicy' "$OC_DIST" | while IFS= read -r f; do \
            if grep -Eq 'parsedProxyUrl|proxyUrl|proxyHostname|proxy.*[Hh]ostname|[Hh]ostname.*proxy|allowPrivateProxy' "$f"; then \
                printf '%s\n' "$f"; \
            fi; \
        done || true)"; \
        if [ -z "$proxy_hostname_checks" ]; then \
            echo "INFO: OpenClaw ${OC_VERSION} has no assertExplicitProxyAllowed proxy hostname validator; Patch 2 not needed"; \
        else \
            echo "ERROR: Patch 2 target missing but proxy hostname validation references remain:" >&2; \
            printf '%s\n' "$proxy_hostname_checks" | head -n 5 >&2; \
            patch_fail "Patch 2 cannot safely skip"; \
        fi; \
    fi; \
    # --- Patch 2b: allow OpenShell host gateway only through web_fetch trusted env proxy --- \
    # Reviewed against openclaw@2026.5.27 dist: fetchWithWebToolsNetworkGuard \
    # passes useEnvProxy into withTrustedEnvProxyGuardedFetchMode(resolved), and \
    # the SSRF guard consumes policy.allowedHostnames to skip private-network \
    # checks for an exact normalized hostname. hostnameAllowlist only gates \
    # hostname pattern matching and does not bypass .internal/private blocking. \
    web_guard_files="$(grep -RIlE --include='*.js' 'function fetchWithWebToolsNetworkGuard\(params\)' "$OC_DIST" || true)"; \
    if [ -n "$web_guard_files" ]; then \
        patched_host_gateway=0; \
        for f in $web_guard_files; do \
            if grep -q 'nemoclaw: OpenShell host gateway for web_fetch trusted env proxy' "$f"; then \
                echo "INFO: Patch 2b already present in $f"; \
            else \
                grep -q 'withTrustedEnvProxyGuardedFetchMode(resolved)' "$f" \
                    || patch_fail "Patch 2b target $f is missing reviewed trusted env-proxy web_fetch call"; \
                sed -i -E 's|return fetchWithSsrFGuard\(useEnvProxy \? withTrustedEnvProxyGuardedFetchMode\(resolved\) : withStrictGuardedFetchMode\(resolved\)\);|const hostGatewayPolicy = process.env.OPENSHELL_SANDBOX === "1" \&\& useEnvProxy \&\& new URL(resolved.url).hostname === "host.openshell.internal" ? { ...resolved.policy, allowedHostnames: [...resolved.policy?.allowedHostnames ?? [], "host.openshell.internal"] } : resolved.policy; return fetchWithSsrFGuard(useEnvProxy ? withTrustedEnvProxyGuardedFetchMode({ ...resolved, policy: hostGatewayPolicy }) : withStrictGuardedFetchMode(resolved)); /* nemoclaw: OpenShell host gateway for web_fetch trusted env proxy, see Dockerfile */|' "$f"; \
                grep -Fq 'process.env.OPENSHELL_SANDBOX === "1" && useEnvProxy && new URL(resolved.url).hostname === "host.openshell.internal"' "$f" \
                    || patch_fail "Patch 2b verification failed for $f"; \
                patched_host_gateway=1; \
            fi; \
        done; \
        if [ "$patched_host_gateway" = "1" ]; then \
            echo "INFO: Patch 2b applied to OpenClaw ${OC_VERSION} web_fetch trusted-proxy host-gateway policy"; \
        fi; \
    else \
        web_fetch_proxy_refs="$(grep -RIlE --include='*.js' 'web_fetch|useEnvProxy|useTrustedEnvProxy|withTrustedEnvProxyGuardedFetchMode\(resolved\)' "$OC_DIST" || true)"; \
        if [ -z "$web_fetch_proxy_refs" ]; then \
            echo "INFO: OpenClaw ${OC_VERSION} has no web_fetch trusted env-proxy callsite; Patch 2b not needed"; \
        else \
            echo "ERROR: Patch 2b target missing but web_fetch/trusted-proxy references remain:" >&2; \
            printf '%s\n' "$web_fetch_proxy_refs" | head -n 5 >&2; \
            patch_fail "Patch 2b cannot safely skip"; \
        fi; \
    fi; \
    # --- Patch 4: route unconfigured strict fetches through the sandbox egress proxy (#4687) --- \
    # Reviewed against openclaw@2026.5.27 dist fetch-guard: the STRICT-mode \
    # managed-proxy gate is `mode === GUARDED_FETCH_MODE.STRICT && \
    # isManagedProxyActive() && hasProxyEnvConfigured()`. Extend activation to \
    # OPENSHELL_SANDBOX=1 only for fetches with no explicit dispatcherPolicy so \
    # the per-request direct dispatcher reuses the env proxy (EnvHttpProxyAgent) \
    # like the managed-proxy path already does; explicit-proxy / direct dispatcher \
    # policies and out-of-sandbox behavior are unchanged. \
    mp_files="$(grep -RIlF --include='*.js' 'const canUseManagedProxy = mode === GUARDED_FETCH_MODE.STRICT && isManagedProxyActive() && hasProxyEnvConfigured();' "$OC_DIST" || true)"; \
    if [ -n "$mp_files" ]; then \
        patched_managed_proxy=0; \
        for f in $mp_files; do \
            if grep -q 'nemoclaw: route unconfigured strict fetch' "$f"; then \
                echo "INFO: Patch 4 already present in $f"; \
            else \
                sed -i -E 's#const canUseManagedProxy = mode === GUARDED_FETCH_MODE\.STRICT \&\& isManagedProxyActive\(\) \&\& hasProxyEnvConfigured\(\);#const canUseManagedProxy = mode === GUARDED_FETCH_MODE.STRICT \&\& (isManagedProxyActive() || (process.env.OPENSHELL_SANDBOX === "1" \&\& !params.dispatcherPolicy)) \&\& hasProxyEnvConfigured(); /* nemoclaw: route unconfigured strict fetch through sandbox egress proxy, see Dockerfile */#' "$f"; \
                grep -Fq 'process.env.OPENSHELL_SANDBOX === "1" && !params.dispatcherPolicy' "$f" \
                    || patch_fail "Patch 4 verification failed for $f"; \
                patched_managed_proxy=1; \
            fi; \
        done; \
        if [ "$patched_managed_proxy" = "1" ]; then \
            echo "INFO: Patch 4 applied to OpenClaw ${OC_VERSION} managed-proxy strict-fetch activation"; \
        fi; \
    else \
        managed_proxy_refs="$(grep -RIlE --include='*.js' 'canUseManagedProxy|isManagedProxyActive' "$OC_DIST" || true)"; \
        if [ -z "$managed_proxy_refs" ]; then \
            echo "INFO: OpenClaw ${OC_VERSION} has no managed-proxy strict-fetch gate; Patch 4 not needed"; \
        else \
            echo "ERROR: Patch 4 target missing but managed-proxy references remain:" >&2; \
            printf '%s\n' "$managed_proxy_refs" | head -n 5 >&2; \
            patch_fail "Patch 4 cannot safely skip"; \
        fi; \
    fi; \
    # --- Patch 6: cron model-provider preflight opts into trusted env-proxy mode --- \
    # Reviewed against openclaw@2026.5.27 dist: the cron isolated-agent preflight \
    # (`probeLocalProviderEndpoint`) calls `fetchWithSsrFGuard` with \
    # `auditContext: "cron-model-provider-preflight"` and a narrow hostname-allowlist \
    # SsrFPolicy from `buildLocalProviderSsrFPolicy`, but does not pass a `mode`. \
    # Default STRICT mode pins DNS for the managed inference hostname \
    # (`inference.local`), which is intentionally only resolvable through the \
    # OpenShell L7 proxy — pinned `dns.lookup` therefore fails with EAI_AGAIN and \
    # the scheduler permanently skips every cron run. Inject \
    # `mode: "trusted_env_proxy"` so the call uses the env proxy dispatcher; SSRF \
    # protection is retained through the existing hostname allowlist and the \
    # proxy's own ACLs. \
    # \
    # The patch keys on the co-located shape of the reviewed preflight call: in \
    # any file that mentions the audit context literal, both the \
    # `fetchWithSsrFGuard(` helper and the `buildLocalProviderSsrFPolicy` policy \
    # builder must appear; the audit literal itself must appear exactly once; and \
    # after patching exactly one patched literal must remain. Any ambiguous \
    # multi-callsite or mixed patched/unpatched layout fails the image build \
    # rather than silently widening the rewrite. \
    # \
    # Removal condition: drop this block (and any related `OC_VERSION` floor bump) \
    # once an OpenClaw release sets `mode: "trusted_env_proxy"` directly at the \
    # preflight call site or otherwise routes the managed inference base URL \
    # through the env-proxy dispatcher by default. The reviewed shape lives at \
    # `src/cron/isolated-agent/model-preflight.runtime.ts` in the openclaw repo. \
    preflight_files="$(grep -RIlF --include='*.js' 'cron-model-provider-preflight' "$OC_DIST" || true)"; \
    if [ -n "$preflight_files" ]; then \
        patched_preflight=0; \
        for f in $preflight_files; do \
            audit_count="$(grep -Fc 'auditContext: "cron-model-provider-preflight"' "$f" || true)"; \
            [ "${audit_count:-0}" -ge 1 ] \
                || patch_fail "Patch 6 shape gate: $f mentions cron-model-provider-preflight but has no auditContext literal"; \
            [ "${audit_count:-0}" -eq 1 ] \
                || patch_fail "Patch 6 shape gate: $f has ${audit_count} auditContext literals (expected exactly 1); refusing ambiguous multi-callsite rewrite"; \
            grep -Fq 'fetchWithSsrFGuard(' "$f" \
                || patch_fail "Patch 6 shape gate: $f has cron-model-provider-preflight but no fetchWithSsrFGuard call"; \
            grep -Fq 'buildLocalProviderSsrFPolicy' "$f" \
                || patch_fail "Patch 6 shape gate: $f has cron-model-provider-preflight but no buildLocalProviderSsrFPolicy"; \
            patched_count="$(grep -Fc 'mode: "trusted_env_proxy", auditContext: "cron-model-provider-preflight"' "$f" || true)"; \
            if [ "${patched_count:-0}" -eq 1 ]; then \
                echo "INFO: Patch 6 already present in $f"; \
            elif [ "${patched_count:-0}" -eq 0 ]; then \
                sed -i -E 's|auditContext: "cron-model-provider-preflight"|mode: "trusted_env_proxy", auditContext: "cron-model-provider-preflight"|g' "$f"; \
                new_patched_count="$(grep -Fc 'mode: "trusted_env_proxy", auditContext: "cron-model-provider-preflight"' "$f" || true)"; \
                [ "${new_patched_count:-0}" -eq 1 ] \
                    || patch_fail "Patch 6 verification: expected exactly one patched literal in $f, found ${new_patched_count}"; \
                patched_preflight=1; \
            else \
                patch_fail "Patch 6 shape gate: $f has ${patched_count} already-patched literals (expected 0 or 1); refusing mixed-state rewrite"; \
            fi; \
        done; \
        if [ "$patched_preflight" = "1" ]; then \
            echo "INFO: Patch 6 applied to OpenClaw ${OC_VERSION} cron preflight trusted env-proxy"; \
        fi; \
    else \
        preflight_refs="$(grep -RIlE --include='*.js' 'preflightCronModelProvider|probeLocalProviderEndpoint' "$OC_DIST" || true)"; \
        if [ -z "$preflight_refs" ]; then \
            echo "INFO: OpenClaw ${OC_VERSION} has no cron model-provider preflight; Patch 6 not needed"; \
        else \
            echo "ERROR: Patch 6 target missing but cron preflight references remain:" >&2; \
            printf '%s\n' "$preflight_refs" | head -n 5 >&2; \
            patch_fail "Patch 6 cannot safely skip"; \
        fi; \
    fi; \
    # --- Patch 3: follow symlinks in plugin-install path checks (#2203) --- \
    # OpenClaw's install-safe-path and install-package-dir reject symlinked \
    # directories via lstat. Changing lstat → stat in these two modules lets \
    # symlinks resolve; the real security gates (realpath + isPathInside \
    # containment) remain intact — a symlink escaping the base tree is still caught. \
    # Scoped to install-safe-path + install-package-dir only. \
    isp_file="$(grep -RIlE --include='*.js' 'const baseLstat = await fs\.(lstat|stat)\(baseDir\)' "$OC_DIST/install-safe-path-"*.js || true)"; \
    test -n "$isp_file" || { echo "ERROR: install-safe-path baseLstat pattern not found" >&2; exit 1; }; \
    sed -i 's/const baseLstat = await fs\.lstat(baseDir)/const baseLstat = await fs.stat(baseDir)/' "$isp_file"; \
    if grep -q 'const baseLstat = await fs\.lstat(baseDir)' "$isp_file"; then echo "ERROR: Patch 3a (install-safe-path) left baseLstat lstat call" >&2; exit 1; fi; \
    if ! grep -q 'const baseLstat = await fs\.stat(baseDir)' "$isp_file"; then echo "ERROR: Patch 3a (install-safe-path) did not find patched baseLstat stat call" >&2; exit 1; fi; \
    ipd_file="$(grep -RIlE --include='*.js' 'assertInstallBaseStable' "$OC_DIST/install-package-dir-"*.js || true)"; \
    test -n "$ipd_file" || { echo "ERROR: install-package-dir assertInstallBaseStable not found" >&2; exit 1; }; \
	    if grep -q 'const baseLstat = await fs\.lstat(params\.installBaseDir)' "$ipd_file"; then \
	        sed -i 's/const baseLstat = await fs\.lstat(params\.installBaseDir)/const baseLstat = await fs.stat(params.installBaseDir)/' "$ipd_file"; \
	        sed -i 's/baseLstat\.isSymbolicLink()/false \/* nemoclaw: symlink check disabled, realpath guards containment *\//' "$ipd_file"; \
	        if grep -q 'fs\.lstat(params\.installBaseDir)' "$ipd_file"; then echo "ERROR: Patch 3b (install-package-dir) left lstat in assertInstallBaseStable" >&2; exit 1; fi; \
	        if ! grep -q 'const baseLstat = await fs\.stat(params\.installBaseDir)' "$ipd_file" && ! grep -q 'await fs\.stat(params\.installBaseDir)).isDirectory()' "$ipd_file"; then echo "ERROR: Patch 3b (install-package-dir) did not find patched/safe installBaseDir stat call" >&2; exit 1; fi; \
	        if grep -q 'baseLstat\.isSymbolicLink()' "$ipd_file"; then echo "ERROR: Patch 3b (install-package-dir) left baseLstat symlink check" >&2; exit 1; fi; \
	    else \
	        grep -q 'await fs\.realpath(params\.installBaseDir) !== params\.expectedRealPath' "$ipd_file" || { echo "ERROR: install-package-dir lacks expected realpath stability guard" >&2; exit 1; }; \
	    fi; \
    # --- Patch 5: bump default WS handshake timeout 10s -> 60s (#2484) --- \
    # OpenClaw's WS connect handshake has a hard-coded 10s timeout on both \
    # client and server. Server-side connect-handler processing can exceed \
    # that limit under load (multiple concurrent connects on slow CI infra), \
    # causing `openclaw agent --json` to fail with "gateway timeout after \
    # <timeout>ms" and TC-SBX-02 to hit its 90s SSH timeout. \
    # \
    # Both env vars (OPENCLAW_HANDSHAKE_TIMEOUT_MS, \
    # OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS) are clamped at the same \
    # DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS constant, so we patch the \
    # constant itself.  Affects both client.js (used by openclaw CLI) and \
    # server.impl.js (gateway side). \
    # \
    # Removal criteria: drop when openclaw fixes the underlying connect \
    # latency, or exposes the timeout as an unbounded env override. \
    hto_files="$(grep -RIlE --include='*.js' 'DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = (1e4|15e3|6e4)' "$OC_DIST" || true)"; \
    test -n "$hto_files" || { echo "ERROR: handshake-timeout constant not found" >&2; exit 1; }; \
    printf '%s\n' "$hto_files" | xargs sed -i -E 's#DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = (1e4|15e3)#DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 6e4#g'; \
    if grep -REq --include='*.js' 'DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = (1e4|15e3)' "$OC_DIST"; then echo "ERROR: Patch 5 left a short handshake-timeout constant" >&2; exit 1; fi; \
    if ! grep -REq --include='*.js' 'DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 6e4' "$OC_DIST"; then echo "ERROR: Patch 5 did not find patched 6e4 constant" >&2; exit 1; fi

# Patch OpenClaw chat.send gateway behavior for OpenClaw 2026.5.x.
#
# OpenClaw can accept rapid TUI/WebChat chat.send requests and then emit a
# terminal chat event with state="final" but no assistant message for the later
# submitted run. That makes clients treat the turn as complete even though no
# visible reply was delivered. The shim also correlates real agent run IDs back
# to the submitted chat.send run ID when OpenClaw starts an internal run with a
# different ID, carries that submitted ID through queued follow-up turns, and
# adds the submitted run ID as the transcript idempotency key.
#
# Removal criteria: drop when upstream OpenClaw fixes openclaw/openclaw#70164
# and openclaw/openclaw#50298, or when NemoClaw no longer ships OpenClaw 2026.5.x.
# hadolint ignore=DL3059
RUN node /usr/local/lib/nemoclaw/patch-openclaw-chat-send.js \
    /usr/local/lib/node_modules/openclaw/dist

# Patch OpenClaw's pinned 2026.5.27 compiled selection runtime to expose a
# compact searchable tool catalog to the model while preserving the full
# effective tool set behind tool_call. NEMOCLAW_TOOL_CATALOG=0 disables this
# wrapper if an emergency rollback is needed. The script fails closed if the
# pinned selection-*.js shape changes.
# hadolint ignore=DL3059
RUN node /usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.js \
    /usr/local/lib/node_modules/openclaw/dist

# Set up blueprint for local resolution.
# Blueprints are immutable at runtime; DAC protection (root ownership) is applied
# later since /sandbox/.nemoclaw is Landlock read_write for plugin state (#804).
RUN mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0 \
    && cp -r /opt/nemoclaw-blueprint/* /sandbox/.nemoclaw/blueprints/0.1.0/

# Copy startup script and shared sandbox initialisation library
COPY scripts/lib/sandbox-init.sh /usr/local/lib/nemoclaw/sandbox-init.sh
COPY scripts/lib/openclaw_device_approval_policy.py /usr/local/lib/nemoclaw/openclaw_device_approval_policy.py
COPY scripts/lib/clean_runtime_shell_env_shim.py /usr/local/lib/nemoclaw/clean_runtime_shell_env_shim.py
COPY scripts/nemoclaw-start.sh /usr/local/bin/nemoclaw-start
# Copy NODE_OPTIONS preload modules to a Landlock-accessible path. OpenShell ≥0.0.36
# blocks /opt/nemoclaw-blueprint/ from non-root users, but the entrypoint
# needs to read these files to install runtime preloads under /tmp.
COPY nemoclaw-blueprint/scripts/*.js /usr/local/lib/nemoclaw/preloads/
COPY scripts/codex-acp-wrapper.sh /usr/local/bin/nemoclaw-codex-acp
COPY scripts/generate-openclaw-config.mts /scripts/generate-openclaw-config.mts
COPY src/lib/messaging/ /src/lib/messaging/
COPY nemoclaw-blueprint/openclaw-plugins/ /usr/local/share/nemoclaw/openclaw-plugins/
RUN chmod 755 /usr/local/bin/nemoclaw-start /usr/local/bin/nemoclaw-codex-acp \
        /usr/local/lib/nemoclaw/sandbox-init.sh \
        /scripts/generate-openclaw-config.mts \
        /src/lib/messaging/applier/build/messaging-build-applier.mts \
    && chmod -R a+rX /src/lib/messaging \
    && chmod 644 /usr/local/lib/nemoclaw/openclaw_device_approval_policy.py \
        /usr/local/lib/nemoclaw/clean_runtime_shell_env_shim.py \
    && if [ -d /usr/local/lib/nemoclaw/preloads ]; then find /usr/local/lib/nemoclaw/preloads -type f -name '*.js' -exec chmod 644 {} +; fi \
    && chmod 755 /usr/local/share/nemoclaw \
        /usr/local/share/nemoclaw/openclaw-plugins \
    && find /usr/local/share/nemoclaw/openclaw-plugins -type d -exec chmod 755 {} + \
    && find /usr/local/share/nemoclaw/openclaw-plugins -type f -exec chmod 644 {} +

# Build args for config that varies per deployment.
# nemoclaw onboard passes these at image build time.
ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b
ARG NEMOCLAW_PROVIDER_KEY=inference
ARG NEMOCLAW_PRIMARY_MODEL_REF=inference/nvidia/nemotron-3-super-120b-a12b
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
# Cadence for OpenClaw's periodic heartbeat
# (agents.defaults.heartbeat.every). Accepts Go-style durations like "30m",
# "5m", "1h"; "0m" disables heartbeat. Empty default preserves the OpenClaw
# built-in cadence. openclaw.json is immutable at runtime, so this can only
# change at image build time. Ref: issue #2880
ARG NEMOCLAW_AGENT_HEARTBEAT_EVERY=
ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=
# Base64-encoded messaging build plan for messaging build inputs and agent
# rendering. The plan contains placeholders only; secrets are resolved at
# runtime via OpenShell providers.
ARG NEMOCLAW_MESSAGING_PLAN_B64=
# Base64-encoded JSON array of secondary OpenClaw agent config entries
# (e.g. [{"id":"research","workspace":"/sandbox/.openclaw/workspace-research",
# "agentDir":"/sandbox/.openclaw/agents/research", ...}]).
# Each entry is appended to agents.list[] after the canonical "main" entry, so
# the primary agent always remains the default. See generate-openclaw-config.mts
# for the validator. Default: empty array (W10= == base64("[]")).
ARG NEMOCLAW_EXTRA_AGENTS_JSON_B64=W10=
# Set to "1" to force-disable device-pairing auth. Also auto-disabled when
# CHAT_UI_URL is a non-loopback address (Brev Launchable, remote deployments)
# since terminal-based pairing is impossible in those contexts.
# Default: "0" (device auth enabled for local deployments — secure by default).
ARG NEMOCLAW_DISABLE_DEVICE_AUTH=0
# Unique per build — busts the Docker cache for the token-injection layer
# so each image gets a fresh gateway auth token.
# Pass --build-arg NEMOCLAW_BUILD_ID=$(date +%s) to bust the cache.
ARG NEMOCLAW_BUILD_ID=default
# macOS OpenShell VM backend imports the Docker image into a virtiofs rootfs
# where image uid/gid ownership is presented as the host user. The VM also
# starts NemoClaw as the non-root sandbox user, so uid-owned 770/660 paths
# become unreadable unless this Darwin-only compatibility mode is enabled.
ARG NEMOCLAW_DARWIN_VM_COMPAT=0
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
ARG NEMOCLAW_OPENCLAW_OTEL=0
ARG NEMOCLAW_OPENCLAW_OTEL_ENDPOINT=http://host.openshell.internal:4318
ARG NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME=openclaw-gateway
ARG NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE=1.0

# SECURITY: Promote build-args to env vars so the TypeScript script reads them
# via process.env, never via string interpolation into executable source code.
# Direct ARG interpolation into inline source is a code injection vector (C-2).
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
    NEMOCLAW_AGENT_HEARTBEAT_EVERY=${NEMOCLAW_AGENT_HEARTBEAT_EVERY} \
    NEMOCLAW_INFERENCE_COMPAT_B64=${NEMOCLAW_INFERENCE_COMPAT_B64} \
    NEMOCLAW_MESSAGING_PLAN_B64=${NEMOCLAW_MESSAGING_PLAN_B64} \
    NEMOCLAW_EXTRA_AGENTS_JSON_B64=${NEMOCLAW_EXTRA_AGENTS_JSON_B64} \
    NEMOCLAW_OPENCLAW_WECHAT_PLUGIN_PREINSTALLED=1 \
    NEMOCLAW_DISABLE_DEVICE_AUTH=${NEMOCLAW_DISABLE_DEVICE_AUTH} \
    NEMOCLAW_PROXY_HOST=${NEMOCLAW_PROXY_HOST} \
    NEMOCLAW_PROXY_PORT=${NEMOCLAW_PROXY_PORT} \
    NEMOCLAW_WEB_SEARCH_ENABLED=${NEMOCLAW_WEB_SEARCH_ENABLED} \
    NEMOCLAW_OPENCLAW_OTEL=${NEMOCLAW_OPENCLAW_OTEL} \
    NEMOCLAW_OPENCLAW_OTEL_ENDPOINT=${NEMOCLAW_OPENCLAW_OTEL_ENDPOINT} \
    NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME=${NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME} \
    NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE=${NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE}

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
# Config is mutable by default (group-writable sandbox:sandbox). Immutability
# is opt-in via `shields up` (DAC 444 root:root + chattr +i).
# Build args (NEMOCLAW_MODEL, CHAT_UI_URL) customize per deployment.
#
# Generate base openclaw.json from environment variables. Messaging build
# steps run through src/lib/messaging/applier/build/messaging-build-applier.mts.
#
# OpenClaw's managed proxy config activates process-wide HTTP_PROXY/HTTPS_PROXY
# for child npm processes. During image build the OpenShell gateway is not
# available at the runtime sandbox proxy address yet, so defer the final proxy
# block until after build-time OpenClaw doctor/plugin commands complete.
RUN NEMOCLAW_OPENCLAW_MANAGED_PROXY=0 node --experimental-strip-types /scripts/generate-openclaw-config.mts

# Install non-messaging OpenClaw plugins that need to match the runtime.
# hadolint ignore=DL3059,DL4006
RUN set -eu; \
    if [ "$NEMOCLAW_OPENCLAW_OTEL" = "1" ] || [ "$NEMOCLAW_WEB_SEARCH_ENABLED" = "1" ]; then \
        test -n "$OPENCLAW_VERSION"; \
    fi; \
    if [ "$NEMOCLAW_OPENCLAW_OTEL" = "1" ]; then \
        openclaw plugins install "npm:@openclaw/diagnostics-otel@${OPENCLAW_VERSION}" --pin; \
    fi; \
    if [ "$NEMOCLAW_WEB_SEARCH_ENABLED" = "1" ]; then \
        openclaw plugins install "npm:@openclaw/brave-plugin@${OPENCLAW_VERSION}" --pin; \
        BRAVE_API_KEY=openshell:resolve:env:BRAVE_API_KEY openclaw doctor --fix --non-interactive; \
    elif [ "$NEMOCLAW_OPENCLAW_OTEL" = "1" ]; then \
        openclaw doctor --fix --non-interactive; \
    fi

# hadolint ignore=DL3059,DL4006
RUN node --experimental-strip-types /src/lib/messaging/applier/build/messaging-build-applier.mts --agent openclaw --phase agent-install

# Patch the OpenClaw Slack channel (@openclaw/slack) so a denied explicit
# @-mention still blocks the command but sends one bounded sender-facing
# feedback message instead of dropping silently (NemoClaw #4752). The script
# classifies the installed Slack dist by content signature, fails the build if
# a @openclaw/slack package is present but the deny path shape is unrecognized,
# and is a no-op when the Slack channel is not enabled for this image.
# Scoped to the sandbox-writable OpenClaw config dir: `openclaw plugins install`
# stages external channel packages under $HOME/.openclaw/npm, and this step runs
# as the sandbox user, so do not scan the root-owned global node_modules tree.
# Removal criteria: drop when upstream OpenClaw notifies the sender on a denied
# explicit Slack @-mention, or when NemoClaw no longer ships @openclaw/slack.
# hadolint ignore=DL3059
RUN node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-slack-deny-feedback.mts \
    /sandbox/.openclaw

# Lock down npm for the next RUN: the local OpenClaw plugin install must
# resolve from /opt/nemoclaw and the staged plugin-runtime-deps tree without
# touching the registry. Reset to false after that RUN so the runtime image
# does not propagate `only-if-cached` mode to in-sandbox `npx` / `npm install`.
ENV NPM_CONFIG_OFFLINE=true \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false

# Install NemoClaw plugin into OpenClaw (local /opt/nemoclaw, no network).
# This must fail the image build if registration fails; otherwise the sandbox
# can boot with a discoverable plugin manifest but without the /nemoclaw runtime
# command registered in the active Gateway.
# Messaging post-agent-install hooks run after the OpenClaw agent and
# NemoClaw plugin are installed; for example, WeChat seed files are written
# from messaging hook build-file outputs before the sandbox starts.
# Prune non-runtime metadata from staged bundled plugin dependencies before
# this layer is committed; deleting it in a later layer would not reduce the
# OCI image imported by k3s.
# hadolint ignore=DL3059,DL4006
RUN openclaw plugins install /opt/nemoclaw \
    && openclaw plugins enable nemoclaw \
    && openclaw plugins inspect nemoclaw --json > /dev/null \
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

# Apply messaging render and post-agent-install build-file hooks after agent/plugin installation.
# hadolint ignore=DL3059,DL4006
RUN node --experimental-strip-types /src/lib/messaging/applier/build/messaging-build-applier.mts --agent openclaw --phase post-agent-install

# Release the offline lock so the runtime sandbox can install MCP servers,
# skills, and ad-hoc packages via the OpenShell L7 proxy.
ENV NPM_CONFIG_OFFLINE=false

# SECURITY: Clear any gateway auth token that openclaw doctor/plugins may have
# auto-generated. The real token is created at container startup by the
# entrypoint (generate_gateway_token) and never stored in openclaw.json.
# Also add the final OpenClaw managed proxy config after build-time OpenClaw
# commands are done, so runtime Discord/WebSocket traffic uses the OpenShell
# gateway proxy without forcing image-build npm traffic through that proxy.
RUN python3 -c "\
import json, os; \
path = os.path.expanduser('~/.openclaw/openclaw.json'); \
cfg = json.load(open(path)); \
cfg.setdefault('gateway', {}).setdefault('auth', {})['token'] = ''; \
proxy_host = os.environ.get('NEMOCLAW_PROXY_HOST') or '10.200.0.1'; \
proxy_port = os.environ.get('NEMOCLAW_PROXY_PORT') or '3128'; \
cfg['proxy'] = { \
    'enabled': True, \
    'proxyUrl': f'http://{proxy_host}:{proxy_port}', \
    'loopbackMode': 'gateway-only', \
}; \
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
    legacy_layout=0; \
    legacy_marker=/tmp/nemoclaw-legacy-openclaw-layout; \
    rm -f "$legacy_marker"; \
    mkdir -p "$config_dir"; \
    if [ -L "$data_dir" ]; then \
        echo "ERROR: refusing legacy layout cleanup because $data_dir is a symlink" >&2; \
        exit 1; \
    fi; \
    if [ -d "$data_dir" ]; then \
        legacy_layout=1; \
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
    if [ -e "$data_dir" ] || [ -L "$data_dir" ]; then \
        echo "ERROR: legacy data dir still exists after cleanup: $data_dir" >&2; \
        exit 1; \
    fi; \
    if [ "$legacy_layout" = "1" ]; then \
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
        : > "$legacy_marker"; \
    fi; \
    for dir in \
        "$config_dir/agents/main/agent" \
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
        "$config_dir/wechat" \
        "$config_dir/media" \
        "$config_dir/plugin-runtime-deps"; do \
        install -d -o sandbox -g sandbox -m 2770 "$dir"; \
    done; \
    for file in "$config_dir/update-check.json" "$config_dir/exec-approvals.json"; do \
        touch "$file"; \
        chown sandbox:sandbox "$file"; \
        chmod 660 "$file"; \
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

# Keep the image readable to the root entrypoint after capabilities are dropped.
# Current base images already have a unified .openclaw tree. Avoid walking
# plugin-runtime-deps on every build; only fall back to the broad repair when
# the stale .openclaw-data migration path actually ran.
RUN set -eu; \
    if [ -e /tmp/nemoclaw-legacy-openclaw-layout ]; then \
        chown -R sandbox:sandbox /sandbox/.openclaw; \
        chmod -R g+rwX,o-rwx /sandbox/.openclaw; \
        find /sandbox/.openclaw -type d -exec chmod g+s {} +; \
        rm -f /tmp/nemoclaw-legacy-openclaw-layout; \
    else \
        chown sandbox:sandbox \
            /sandbox/.openclaw \
            /sandbox/.openclaw/openclaw.json \
            /sandbox/.openclaw/plugin-runtime-deps; \
        chmod 2770 /sandbox/.openclaw /sandbox/.openclaw/plugin-runtime-deps; \
        chmod 660 /sandbox/.openclaw/openclaw.json; \
    fi

# System-wide proxy hooks for shells where ~/.bashrc / ~/.profile aren't
# sourced (e.g. `bash -ic` / `bash -lc` invoked under a different user or
# without HOME=/sandbox). Defined in Dockerfile.base; replayed here so the
# fix applies before the GHCR base image catches up. Idempotent — `mv` of
# a freshly-rebuilt /etc/bash.bashrc is harmless once the base layer
# already includes the prepended hook (the cat | mv block just rewrites
# with the same first line).
# Ref: https://github.com/NVIDIA/NemoClaw/issues/2704
# hadolint ignore=SC2028,DL4006
RUN if ! grep -q "/tmp/nemoclaw-proxy-env.sh" /etc/profile.d/nemoclaw-proxy.sh 2>/dev/null; then \
        printf '%s\n' \
            '# NemoClaw runtime proxy config — see /tmp/nemoclaw-proxy-env.sh (#2704)' \
            '[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh' \
            > /etc/profile.d/nemoclaw-proxy.sh \
        && chmod 444 /etc/profile.d/nemoclaw-proxy.sh; \
    fi \
    && if ! head -2 /etc/bash.bashrc | grep -q "/tmp/nemoclaw-proxy-env.sh"; then \
        chmod 644 /etc/bash.bashrc 2>/dev/null || true; \
        { printf '%s\n' \
              '# NemoClaw runtime proxy config — see /tmp/nemoclaw-proxy-env.sh (#2704)' \
              '[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh' \
              ''; \
          cat /etc/bash.bashrc; \
        } > /etc/bash.bashrc.new \
        && mv /etc/bash.bashrc.new /etc/bash.bashrc \
        && chmod 444 /etc/bash.bashrc; \
    fi

# Pin config hash at build time so the entrypoint can verify integrity.
RUN sha256sum /sandbox/.openclaw/openclaw.json > /sandbox/.openclaw/.config-hash \
    && chmod 660 /sandbox/.openclaw/.config-hash \
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
    && printf '%s' '{}' > /sandbox/.nemoclaw/config.json \
    && chown sandbox:sandbox /sandbox/.nemoclaw/config.json

# OpenShell 0.0.37's macOS VM backend currently remaps rootfs ownership to the
# host uid/gid inside the guest, while the entrypoint runs as non-root sandbox.
# Enable this only for Darwin VM builds so Linux Docker-driver sandboxes keep
# the tighter group-only mutable-default permissions.
RUN if [ "$NEMOCLAW_DARWIN_VM_COMPAT" = "1" ]; then \
        chmod -R a+rwX /sandbox/.openclaw; \
        find /sandbox/.openclaw -type d -exec chmod a+rwx {} +; \
        chmod a+rw /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash; \
        for p in /sandbox/.nemoclaw/state /sandbox/.nemoclaw/migration /sandbox/.nemoclaw/snapshots /sandbox/.nemoclaw/staging; do \
            chmod -R a+rwX "$p"; \
            find "$p" -type d -exec chmod a+rwx {} +; \
        done; \
        chmod a+rw /sandbox/.nemoclaw/config.json; \
    fi

# Temporary workaround for OpenTelemetry JS OTLP/HTTP proxy handling.
# When diagnostics OTEL is enabled, patch the bundled exporter so Node's
# NODE_USE_ENV_PROXY=1 handling can apply instead of forcing the default agent.
# Remove once https://github.com/open-telemetry/opentelemetry-js/issues/6638
# is fixed in @opentelemetry/otlp-exporter-base.
# hadolint ignore=DL4006
RUN set -eu; \
    if [ "$NEMOCLAW_OPENCLAW_OTEL" = "1" ]; then \
        target="$(find /sandbox/.openclaw \
            -path '*/@opentelemetry/otlp-exporter-base/build/src/transport/http-transport-utils.js' \
            -print -quit 2>/dev/null || true)"; \
        if [ -z "$target" ]; then \
            echo "ERROR: NEMOCLAW_OPENCLAW_OTEL=1 but otlp-exporter-base transport was not found" >&2; \
            exit 1; \
        fi; \
        if grep -q 'NODE_USE_ENV_PROXY' "$target"; then \
            echo "INFO: OpenTelemetry OTLP proxy patch already present in $target"; \
        else \
            owner="$(stat -c '%u:%g' "$target")"; \
            mode="$(stat -c '%a' "$target")"; \
            cp -p "$target" "$target.bak"; \
            sed -i "0,/^[[:space:]]*agent,$/s//        agent: process.env.NODE_USE_ENV_PROXY === '1' ? undefined : agent,/" "$target"; \
            grep -q 'NODE_USE_ENV_PROXY' "$target" || { \
                echo "ERROR: failed to patch OpenTelemetry OTLP transport at $target" >&2; \
                exit 1; \
            }; \
            chown "$owner" "$target"; \
            chmod "$mode" "$target"; \
            echo "INFO: patched OpenTelemetry OTLP proxy handling in $target"; \
        fi; \
    fi

# Health check: poll the gateway's /health endpoint so Docker (and Compose)
# can detect and restart unhealthy containers in standalone deployments.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/1430
#
# Layered probe so Docker health does not contradict the NemoClaw delivery
# chain on runtimes where the dashboard port lives in a different network
# namespace (e.g. DGX Spark / aarch64 with OpenShell-managed forwarding).
# The reporter saw `nemoclaw status` Ready + the host forward succeed while
# Docker marked the container unhealthy because the in-container curl could
# not see the dashboard listener. See #3975.
#
#   1. Direct in-container probe (HTTP 200) — definitive when it works,
#      preserves the original Compose/standalone health signal.
#   2. A connect timeout (curl exit 28) or HTTP 4xx/5xx (curl exit 22) is a
#      real bad signal: a listener exists but is wedged or answered with a
#      failure inside this container, so Docker should restart it.
#   3. ONLY on curl exit 7 ("Couldn't connect" — the kernel refused the
#      in-container TCP connect because nothing is bound to the dashboard
#      port in THIS network namespace) the meaning depends on whether this
#      container is the one running the OpenClaw gateway:
#        a. If nemoclaw-start launched the gateway in this container it
#           drops the /tmp/nemoclaw-gateway-local marker (see
#           scripts/nemoclaw-start.sh). The gateway is local but its port
#           may be forwarded out of this namespace (#3975), so confirm the
#           gateway came up: the process is still alive (pgrep
#           --ignore-ancestors) AND the gateway log is non-empty. A
#           standalone deployment whose gateway never started fails here so
#           Docker restarts it (#1430).
#        b. If the marker is ABSENT the OpenClaw gateway is delivered
#           outside this container (OpenShell docker-driver deployments run
#           it on the host / in a host-side process chain — #4503). An
#           in-container curl/pgrep cannot observe an out-of-namespace
#           gateway, so a process-name fallback here produced false
#           "unhealthy" while `nemoclaw status` and OpenShell reported the
#           sandbox Ready. We must not drive Docker health off a signal we
#           cannot prove: report healthy and defer to NemoClaw/OpenShell's
#           host-side delivery-chain monitoring (verify-deployment.ts, host
#           port forward, sandbox status).
#
# The process pattern matches both `openclaw gateway run` (the launcher
# command nemoclaw-start runs) and `openclaw-gateway` (the re-execed
# binary form OpenClaw switches into after startup). This is the same
# variant set the host-side gateway-stop script in services.ts matches.
#
# pgrep uses --ignore-ancestors so it cannot self-match the healthcheck
# shell that Docker spawns to run this CMD — that shell's argv contains
# the literal 'openclaw gateway' string we're searching for, and
# without --ignore-ancestors `pgrep -f` would happily report it as the
# live gateway even after the real process exited (procps 4.0+ supports
# this flag; the base image pins procps to 2:4.0.4-9).
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD port="${NEMOCLAW_DASHBOARD_PORT:-${OPENCLAW_GATEWAY_PORT:-}}"; \
        if [ -z "$port" ]; then \
            port="$(python3 -c 'import os; from urllib.parse import urlparse; raw = os.environ.get("CHAT_UI_URL") or "http://127.0.0.1:18789"; raw = raw if "://" in raw else "http://" + raw; u = urlparse(raw); print(u.port or 18789)' 2>/dev/null || printf '18789')"; \
        fi; \
        rc=0; \
        curl -sf --max-time 3 "http://127.0.0.1:${port}/health" > /dev/null 2>&1 || rc=$?; \
        if [ "$rc" = 0 ]; then exit 0; fi; \
        if [ "$rc" != 7 ]; then exit 1; fi; \
        [ -f /tmp/nemoclaw-gateway-local ] || exit 0; \
        pgrep --ignore-ancestors -f 'openclaw[ -]gateway' > /dev/null 2>&1 || exit 1; \
        [ -s /tmp/gateway.log ]

# Entrypoint runs as root to start the gateway as the gateway user,
# then drops to sandbox for agent commands. See nemoclaw-start.sh.
ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]
CMD ["/bin/bash"]
