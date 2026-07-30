# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Hermes sandbox image — Hermes Agent + NemoClaw plugin inside OpenShell
#
# Layers PR-specific code (plugin, config, startup script) on top of the
# pre-built Hermes base image. Mirrors the OpenClaw Dockerfile structure.

ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:c4899e00817acb3421037efba013c720a79895bc8c4448b47aa9aca0def3104b
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

FROM scratch AS hermes-npm-patch-payload

COPY scripts/lib/reviewed-npm-archive.mts /scripts/lib/reviewed-npm-archive.mts
COPY scripts/patch-bundled-npm-brace-expansion.mts /scripts/patch-bundled-npm-brace-expansion.mts
COPY scripts/patch-bundled-npm-tar.mts /scripts/patch-bundled-npm-tar.mts

FROM scratch AS hermes-agent-payload

COPY agents/hermes/plugin/ /opt/nemoclaw-hermes-plugin/
COPY agents/hermes/generate-config.ts /opt/nemoclaw-hermes-config/generate-config.ts
COPY agents/hermes/config/ /opt/nemoclaw-hermes-config/config/
COPY agents/hermes/patch-gateway-runtime-metadata.py /opt/nemoclaw-hermes-config/patch-gateway-runtime-metadata.py
COPY agents/hermes/patch-cron-execution-runtime.py /opt/nemoclaw-hermes-config/patch-cron-execution-runtime.py
COPY agents/hermes/host/managed-tool-gateway-matrix.json /opt/nemoclaw-hermes-config/managed-tool-gateway-matrix.json
COPY src/lib/tool-disclosure.ts /src/lib/tool-disclosure.ts
COPY src/lib/messaging/ /src/lib/messaging/
COPY scripts/lib/openclaw-npm-remediation.mts /scripts/lib/openclaw-npm-remediation.mts

FROM scratch AS hermes-runtime-payload

COPY --from=mcp-tool-discovery-runtime /opt/mcp-tool-discovery-runtime/dist/ /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime/
COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/
COPY scripts/lib/sandbox-init.sh /usr/local/lib/nemoclaw/sandbox-init.sh
COPY scripts/lib/gateway-supervisor.sh /usr/local/lib/nemoclaw/gateway-supervisor.sh
COPY scripts/lib/sandbox-rlimits.sh /usr/local/lib/nemoclaw/sandbox-rlimits.sh
COPY agents/hermes/start.sh /usr/local/bin/nemoclaw-start
COPY scripts/gateway-control.sh /usr/local/bin/nemoclaw-gateway-control
COPY scripts/managed-gateway-control.py /usr/local/lib/nemoclaw/managed-gateway-control.py
COPY agents/hermes/validate-env-secret-boundary.py /usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py
COPY agents/hermes/patch-session-list-preview.py /usr/local/lib/nemoclaw/patch-hermes-session-list-preview.py
COPY agents/hermes/patch-discord-recovery-permissions.py /usr/local/lib/nemoclaw/patch-hermes-discord-recovery-permissions.py
COPY agents/hermes/patch-profile-policy-defaults.py /usr/local/lib/nemoclaw/patch-hermes-profile-policy-defaults.py
COPY agents/hermes/patch-langfuse-credentials.mts /usr/local/lib/nemoclaw/patch-hermes-langfuse-credentials.mts
COPY agents/hermes/seed-dashboard-config.py /usr/local/lib/nemoclaw/seed-hermes-dashboard-config.py
COPY agents/hermes/runtime-config-guard.py /usr/local/lib/nemoclaw/hermes-runtime-config-guard.py
COPY agents/hermes/finalize-tirith-marker.py /usr/local/lib/nemoclaw/finalize-tirith-marker.py
COPY agents/hermes/build-mcp-digest.py /usr/local/lib/nemoclaw/build-hermes-mcp-digest.py
COPY agents/hermes/mcp-config-transaction.py /usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py
COPY src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.85.json /usr/local/lib/nemoclaw/openshell-child-visible-credentials.v0.0.85.json
COPY scripts/state-dir-guard.py /usr/local/lib/nemoclaw/state-dir-guard.py
COPY nemoclaw-blueprint/scripts/*.js /usr/local/lib/nemoclaw/preloads/

FROM scratch AS hermes-wrapper-payload

COPY agents/hermes/hermes-wrapper.py /usr/local/lib/nemoclaw/hermes-wrapper.py

FROM scratch AS hermes-scan-payload

COPY scripts/checks/node-tar-image-scan.mts /scripts/checks/node-tar-image-scan.mts

# hadolint ignore=DL3006
FROM ${BASE_IMAGE}

# Cross-stage root copies are accepted by Docker's legacy builder and create
# one final-image layer while preserving metadata on existing parent paths.
COPY --from=hermes-npm-patch-payload / /

# The final Hermes image owns the shipped dependency boundary independently of
# base freshness. Reassert the idempotent npm-private node-tar fix here.
RUN node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts \
    --npm-root /usr/local/lib/node_modules/npm

# Reassert the npm-private brace-expansion fix for the exact final filesystem.
# hadolint ignore=DL3059
RUN node --experimental-strip-types /scripts/patch-bundled-npm-brace-expansion.mts \
    --npm-root /usr/local/lib/node_modules/npm

# Keep the final image contract explicit even when the published base image
# changes independently of this Dockerfile.
RUN set -eu; \
    hermes_path="$(command -v hermes 2>/dev/null || true)"; \
    if [ "$hermes_path" != "/usr/local/bin/hermes" ]; then \
        echo "ERROR: expected hermes at /usr/local/bin/hermes, got ${hermes_path:-missing}" >&2; \
        exit 1; \
    fi; \
    test -x /usr/local/bin/hermes; \
    /usr/local/bin/hermes --version

# Managed MCP requires the packaged Hermes client surface. A published base can
# carry the expected Hermes version while still having been built without the
# optional `mcp` dependency group, in which case Hermes silently disables both
# MCP discovery and Streamable HTTP support. This is a build-time import guard;
# the live MCP E2E proves authenticated HTTPS execution through OpenShell.
RUN /opt/hermes/.venv/bin/python -c \
    'import mcp; from tools import mcp_tool; assert getattr(mcp_tool, "_MCP_AVAILABLE", False), "Hermes MCP client runtime is unavailable"; assert getattr(mcp_tool, "_MCP_HTTP_AVAILABLE", False), "Hermes MCP Streamable HTTP runtime is unavailable"'

RUN chmod -R a+rX /opt/hermes/.venv \
    && test -r /opt/hermes/.venv/pyvenv.cfg \
    && su -s /bin/sh sandbox -c '/opt/hermes/.venv/bin/python3 -c "import urllib.request"'

# Published base images can lag Dockerfile.base while local feature branches
# still layer this final image on top. Invalid state: the selected base has
# Hermes source under /opt/hermes but lacks hermes_cli/web_dist. Prebuild the
# dashboard bundle here too so `hermes dashboard` never tries to run npm from
# the sandbox user account. Remove this fallback after all supported base image
# tags are built from Dockerfile.base with HERMES_WEB_DIST prepopulated.
RUN set -eu; \
    hermes_web_dist=/opt/hermes/hermes_cli/web_dist; \
    hermes_web_dir=/opt/hermes/web; \
    if [ ! -d "$hermes_web_dist" ]; then \
        if [ ! -f "$hermes_web_dir/package.json" ]; then \
            echo "ERROR: Hermes dashboard source missing at $hermes_web_dir" >&2; \
            exit 1; \
        fi; \
        if [ -f "$hermes_web_dir/package-lock.json" ]; then \
            npm ci --prefix "$hermes_web_dir" --prefer-offline --no-audit --no-fund; \
            npm run build --prefix "$hermes_web_dir"; \
            rm -rf "$hermes_web_dir/node_modules"; \
        elif grep -q '"web"' /opt/hermes/package-lock.json; then \
            npm ci --prefix /opt/hermes --prefer-offline --no-audit --no-fund; \
            npm run build --prefix /opt/hermes --workspace web; \
            npm ci --omit=dev --workspaces=false --prefix /opt/hermes \
                --prefer-offline --no-audit --no-fund; \
        else \
            echo "ERROR: Hermes dashboard at $hermes_web_dir is not covered by a pinned lockfile" >&2; \
            exit 1; \
        fi; \
    fi; \
    rm -rf /root/.npm /root/.cache/electron /root/.cache/node-gyp; \
    test -d "$hermes_web_dist"

ENV HERMES_WEB_DIST="/opt/hermes/hermes_cli/web_dist"

# Harden: remove unnecessary build tools and network probes. build-essential
# comes from the base image for npm/node-gyp builds; the final image does not
# compile anything, so strip the installed compiler packages and fail closed if
# command shims survive.
RUN set -eu; \
    dpkg-query -W -f='${Package}\n' >/tmp/hermes-runtime-packages.txt; \
    grep -E '^(build-essential|make|gcc|g\+\+|cpp|gcc-[0-9]+|g\+\+-[0-9]+|cpp-[0-9]+|[[:alnum:]_-]+-linux-gnu-(gcc|g\+\+|cpp)(-[0-9]+)?|netcat-openbsd|netcat-traditional|ncat)$' /tmp/hermes-runtime-packages.txt >/tmp/hermes-runtime-tool-packages.txt || true; \
    if [ -s /tmp/hermes-runtime-tool-packages.txt ]; then xargs -r apt-get purge -y </tmp/hermes-runtime-tool-packages.txt; fi; \
    rm -f /tmp/hermes-runtime-packages.txt /tmp/hermes-runtime-tool-packages.txt; \
    apt-get autoremove --purge -y; \
    rm -rf /var/lib/apt/lists/*; \
    if command -v gcc >/dev/null 2>&1; then echo "ERROR: gcc survived runtime purge" >&2; exit 1; fi; \
    if command -v g++ >/dev/null 2>&1; then echo "ERROR: g++ survived runtime purge" >&2; exit 1; fi; \
    if command -v make >/dev/null 2>&1; then echo "ERROR: make survived runtime purge" >&2; exit 1; fi

# Hermes' WeChat adapter (gateway/platforms/weixin.py:_make_ssl_connector)
# builds aiohttp with ssl.create_default_context(cafile=certifi.where()),
# bypassing SSL_CERT_FILE. Symlink certifi's bundle at SSL_CERT_FILE so
# weixin TLS trusts the OpenShell L7 proxy CA. Done at image build (as
# root, which has write perms on the venv) because at runtime root doesn't
# see SSL_CERT_FILE and the gateway user can't write the venv.
# The target doesn't need to exist at build time — OpenShell mounts it at
# sandbox start; the forward-referencing symlink resolves then.
ARG SSL_CERT_FILE=/etc/openshell-tls/ca-bundle.pem
# hadolint ignore=DL3059
RUN _hermes_certifi=$(/opt/hermes/.venv/bin/python -c 'import certifi; print(certifi.where())') \
    && ln -sf "$SSL_CERT_FILE" "$_hermes_certifi"

# Hermes v2026.4.13+ auto-detects HTTPS_PROXY and skips fallback-IP
# transport when a proxy is present. OpenShell handles REST credential
# placeholder rewriting, hostname-based policy enforcement, and native
# WebSocket credential rewrite at the egress boundary.
ENV HERMES_TELEGRAM_DISABLE_FALLBACK_IPS=1
ENV HERMES_TUI_DIR="/opt/hermes/ui-tui"

COPY --from=hermes-agent-payload / /

# Ensure the NemoClaw plugin for Hermes is readable.
RUN chmod -R a+rX /opt/nemoclaw-hermes-plugin/

# Keep the config generator and its source dependencies root-owned and
# read-only.
RUN find /opt/nemoclaw-hermes-config -type d -exec chmod 755 {} + \
    && find /opt/nemoclaw-hermes-config -type f -exec chmod 444 {} + \
    && chmod 444 /src/lib/tool-disclosure.ts \
    && chmod 444 /scripts/lib/reviewed-npm-archive.mts /scripts/lib/openclaw-npm-remediation.mts \
        /scripts/patch-bundled-npm-brace-expansion.mts /scripts/patch-bundled-npm-tar.mts \
    && chmod -R a+rX /src/lib/messaging

COPY --from=hermes-runtime-payload / /

RUN discovery_contract="$(node /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime/mcp-tool-discovery.mjs)" \
    && node -e 'const result = JSON.parse(process.argv[1]); if (result.protocol !== 1 || result.ok !== false || result.detail !== "tool discovery received invalid runtime arguments") process.exit(1);' "$discovery_contract" \
    && discovery_unsafe="$(find -L /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime \( ! -user root -o -perm /022 \) -print -quit)" \
    && test -z "$discovery_unsafe"

# Ensure sandbox user can read blueprint files copied as root
RUN chmod -R a+rX /opt/nemoclaw-blueprint/

# Apply runtime modes to the startup script and secret-boundary validator. The
# validator is the single source of truth used by start.sh at cold start and by
# its root-owned PID 1 lifecycle handler, so `recover` enforces the same boundary
# as startup.
# Dockerfile.base is the source of truth for rlimit hooks. This Hermes replay
# only repairs stale bases predating the v0.0.69 base layer, which may lack the
# profile hook, bashrc hook, or root-owned helper mode. Remove it once the
# minimum supported Hermes sandbox base tag guarantees those artifacts and
# test/sandbox-rlimit-hooks.test.ts covers that base.
RUN chmod 755 /usr/local/bin/nemoclaw-start /usr/local/lib/nemoclaw/sandbox-init.sh /usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py /usr/local/lib/nemoclaw/patch-hermes-session-list-preview.py /usr/local/lib/nemoclaw/patch-hermes-discord-recovery-permissions.py /usr/local/lib/nemoclaw/patch-hermes-profile-policy-defaults.py /usr/local/lib/nemoclaw/seed-hermes-dashboard-config.py /usr/local/lib/nemoclaw/hermes-runtime-config-guard.py /usr/local/lib/nemoclaw/finalize-tirith-marker.py /usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py \
    && chown root:root /usr/local/bin/nemoclaw-gateway-control /usr/local/lib/nemoclaw/gateway-supervisor.sh /usr/local/lib/nemoclaw/state-dir-guard.py /usr/local/lib/nemoclaw/managed-gateway-control.py /usr/local/lib/nemoclaw/build-hermes-mcp-digest.py /usr/local/lib/nemoclaw/openshell-child-visible-credentials.v0.0.85.json \
    && chmod 700 /usr/local/bin/nemoclaw-gateway-control \
    && chmod 500 /usr/local/lib/nemoclaw/state-dir-guard.py /usr/local/lib/nemoclaw/managed-gateway-control.py \
    && chmod 444 /usr/local/lib/nemoclaw/gateway-supervisor.sh /usr/local/lib/nemoclaw/build-hermes-mcp-digest.py \
    && chmod 444 /usr/local/lib/nemoclaw/patch-hermes-langfuse-credentials.mts \
    && chmod 444 /usr/local/lib/nemoclaw/openshell-child-visible-credentials.v0.0.85.json \
    && if [ -d /usr/local/lib/nemoclaw/preloads ]; then \
        chown -R 0:0 /usr/local/lib/nemoclaw/preloads \
        && find /usr/local/lib/nemoclaw/preloads -type f -exec chmod 444 {} + \
        && find /usr/local/lib/nemoclaw/preloads -type d -exec chmod 755 {} + \
        ; \
    fi \
    && chmod 444 /usr/local/lib/nemoclaw/sandbox-rlimits.sh \
    && mkdir -p /etc/profile.d \
    && printf '%s\n' \
        '# NemoClaw sandbox resource limits — see sandbox-rlimits.sh (#2173)' \
        '[ -f /usr/local/lib/nemoclaw/sandbox-rlimits.sh ] && . /usr/local/lib/nemoclaw/sandbox-rlimits.sh && harden_resource_limits --quiet && verify_resource_limits --quiet || true' \
        > /etc/profile.d/nemoclaw-rlimits.sh \
    && chmod 444 /etc/profile.d/nemoclaw-rlimits.sh \
    && (chmod 644 /etc/bash.bashrc 2>/dev/null || true) \
    && { printf '%s\n' \
          '# NemoClaw sandbox resource limits — see sandbox-rlimits.sh (#2173)' \
          '[ -f /usr/local/lib/nemoclaw/sandbox-rlimits.sh ] && . /usr/local/lib/nemoclaw/sandbox-rlimits.sh && harden_resource_limits --quiet && verify_resource_limits --quiet || true' \
          ''; \
        if [ -f /etc/bash.bashrc ]; then \
          grep -Ev 'NemoClaw sandbox resource limits|sandbox-rlimits[.]sh' /etc/bash.bashrc || true; \
        fi; \
      } > /etc/bash.bashrc.new \
    && mv /etc/bash.bashrc.new /etc/bash.bashrc \
    && chmod 444 /etc/bash.bashrc

# Build-time assertion: fail immediately if the validator was not installed or
# made executable. Catches COPY path drift or a silent chmod failure.
RUN test -x /usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py \
    || { echo "ERROR: validate-hermes-env-secret-boundary.py missing or not executable" >&2; exit 1; }

# Fresh named profiles do not receive config.yaml, so pin the reviewed
# NemoClaw policy at Hermes' source defaults as well as in generated default
# and dashboard homes. The patcher binds all seven input modules to the exact
# upstream v2026.7.20 source hashes before editing them.
ARG NEMOCLAW_HERMES_PROFILE_POLICY_PATCHER_SHA256=0a05a28e39194016edc3b41448e5ec40abf759c8a445ad2083eb6e6705766599
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_PROFILE_POLICY_PATCHER_SHA256" /usr/local/lib/nemoclaw/patch-hermes-profile-policy-defaults.py \
    | sha256sum -c - \
    || { echo "ERROR: patch-hermes-profile-policy-defaults.py hash mismatch (update NEMOCLAW_HERMES_PROFILE_POLICY_PATCHER_SHA256)" >&2; exit 1; }
RUN /usr/bin/python3 -I /usr/local/lib/nemoclaw/patch-hermes-profile-policy-defaults.py

# Prove the source-level fallback on the real installed runtime through the
# user-facing profile creation path. The new home must remain config-less while
# all security, privacy, update, browser, and session defaults fail safe.
RUN set -eu; \
    profile_probe_root="$(mktemp -d)"; \
    trap 'rm -rf "$profile_probe_root"' EXIT; \
    profile_probe_default="$profile_probe_root/.hermes"; \
    HOME="$profile_probe_root" HERMES_HOME="$profile_probe_default" \
        /usr/local/bin/hermes profile create nemoclaw-policy-probe \
        --no-alias --no-skills; \
    profile_probe_home="$profile_probe_default/profiles/nemoclaw-policy-probe"; \
    test -d "$profile_probe_home"; \
    test ! -e "$profile_probe_home/config.yaml"; \
    HOME="$profile_probe_root" HERMES_HOME="$profile_probe_home" \
        /opt/hermes/.venv/bin/python -I - <<'PY'
from pathlib import Path
from types import SimpleNamespace

from cli import CLI_CONFIG
from gateway.config import SessionResetPolicy, load_gateway_config
from hermes_cli import config as hermes_config
from hermes_cli.config import load_config_readonly
from hermes_cli.main import _resolve_pre_update_backup_mode
from tools.browser_tool import (
    _allow_unsafe_browser_evaluate,
    _restrict_browser_evaluate,
)
from tui_gateway.server import _load_show_reasoning

config = load_config_readonly()
assert config["approvals"]["mode"] == "manual", config["approvals"]
assert config["browser"]["allow_unsafe_evaluate"] is False, config["browser"]
assert config["browser"]["restrict_evaluate"] is True, config["browser"]
assert config["display"]["show_reasoning"] is False, config["display"]
assert config["display"]["show_commentary"] is False, config["display"]
assert config["updates"]["pre_update_backup"] is False, config["updates"]
assert config["updates"]["refresh_cua_driver"] is False, config["updates"]
assert CLI_CONFIG["display"]["show_reasoning"] is False, CLI_CONFIG["display"]
assert _allow_unsafe_browser_evaluate() is False
assert _restrict_browser_evaluate() is True
assert _load_show_reasoning() is False
assert SessionResetPolicy().mode == "both"
assert SessionResetPolicy.from_dict({}).mode == "both"
gateway = load_gateway_config()
assert gateway.default_reset_policy.mode == "both", gateway.default_reset_policy
assert gateway.default_reset_policy.at_hour == 4, gateway.default_reset_policy
assert gateway.default_reset_policy.idle_minutes == 1440, gateway.default_reset_policy
tui_source = Path("/opt/hermes/tui_gateway/server.py").read_text(encoding="utf-8")
assert tui_source.count('.get("show_reasoning", True)') == 0
assert tui_source.count('.get("show_reasoning", False)') == 2
agent_source = Path("/opt/hermes/agent/agent_init.py").read_text(encoding="utf-8")
assert agent_source.count("agent.show_commentary = True") == 0
assert agent_source.count("agent.show_commentary = False") == 2
assert agent_source.count('.get("show_commentary", True)') == 0
assert agent_source.count('.get("show_commentary", False)') == 1
original_load_config = hermes_config.load_config
try:
    def fail_config_load():
        raise RuntimeError("nemoclaw build probe")

    hermes_config.load_config = fail_config_load
    args = SimpleNamespace(no_backup=False, backup=False)
    assert _resolve_pre_update_backup_mode(args) == "off"
finally:
    hermes_config.load_config = original_load_config
main_source = Path("/opt/hermes/hermes_cli/main.py").read_text(encoding="utf-8")
assert main_source.count('updates_cfg.get("pre_update_backup", "quick")') == 0
assert main_source.count('updates_cfg.get("pre_update_backup", False)') == 1
assert main_source.count("refresh_cua_driver = True") == 0
assert main_source.count("refresh_cua_driver = False") == 1
assert main_source.count('_update_cfg.get("refresh_cua_driver", True)') == 0
assert main_source.count('_update_cfg.get("refresh_cua_driver", False)') == 1
PY

# Hermes v0.19.0 writes gateway lifecycle metadata directly below HERMES_HOME.
# Shields-up deliberately makes that config root root-owned and non-writable,
# so managed stop/start recovery cannot remove the old PID file and exits with
# a false PID race. Keep config/hash locks intact and relocate only Hermes's
# central PID/lock/status path helpers to the existing writable runtime
# directory while preserving Hermes's process-scoped home selection. Direct
# upstream --replace/stop and named-profile consumers remain the documented
# inherited residual; this probe does not claim a complete upstream relocation.
ARG NEMOCLAW_HERMES_GATEWAY_RUNTIME_METADATA_PATCHER_SHA256=eacc7403702bc3ba7a6997abffe4f41ffc8ab84947cb8e5b474b21469b2f1152
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_GATEWAY_RUNTIME_METADATA_PATCHER_SHA256" /opt/nemoclaw-hermes-config/patch-gateway-runtime-metadata.py \
    | sha256sum -c - \
    || { echo "ERROR: patch-gateway-runtime-metadata.py hash mismatch (update NEMOCLAW_HERMES_GATEWAY_RUNTIME_METADATA_PATCHER_SHA256)" >&2; exit 1; }
RUN /usr/bin/python3 -I \
        /opt/nemoclaw-hermes-config/patch-gateway-runtime-metadata.py \
        /opt/hermes/gateway/status.py \
    && HERMES_HOME="$(mktemp -d)" /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path

from gateway.status import (
    _get_gateway_lock_path,
    _get_pid_path,
    _get_process_hermes_home,
    _get_runtime_status_path,
)

home = _get_process_hermes_home()
runtime = home / "runtime"
assert _get_pid_path() == runtime / "gateway.pid"
assert _get_gateway_lock_path() == runtime / "gateway.lock"
assert _get_runtime_status_path() == runtime / "gateway_state.json"
assert all(path.parent == runtime for path in (
    _get_pid_path(),
    _get_gateway_lock_path(),
    _get_runtime_status_path(),
))
assert isinstance(home, Path)
PY

# Hermes v0.19.0 creates its writable cron execution-history database below
# the high-risk directory that contains cron job definitions. When Shields up
# is active, NemoClaw seals that directory, so a managed gateway restart cannot
# reopen the ledger. Relocate
# only this audit database to the existing cross-UID runtime boundary, and keep
# Hermes' quick snapshot inventory aligned. Full source hashes plus exact-shape
# patching force a fresh review when either pinned upstream module changes.
ARG NEMOCLAW_HERMES_CRON_RUNTIME_PATCHER_SHA256=2f0d3eacc02ee72608cd96d521a457ef57425bdddc00291ed90ae553f7a36039
ARG NEMOCLAW_HERMES_CRON_EXECUTIONS_SOURCE_SHA256=b37215a27a453191420622f78dc8962fa44feac2521a6f51d71b18831e7cacb7
ARG NEMOCLAW_HERMES_BACKUP_SOURCE_SHA256=1bcef6f736f1d52055837789f24becdba4a670f0a1abb5ac9973b1a1a7306f35
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_CRON_RUNTIME_PATCHER_SHA256" /opt/nemoclaw-hermes-config/patch-cron-execution-runtime.py \
        "$NEMOCLAW_HERMES_CRON_EXECUTIONS_SOURCE_SHA256" /opt/hermes/cron/executions.py \
        "$NEMOCLAW_HERMES_BACKUP_SOURCE_SHA256" /opt/hermes/hermes_cli/backup.py \
    | sha256sum -c - \
    || { echo "ERROR: Hermes cron execution runtime source identity mismatch" >&2; exit 1; }
RUN /usr/bin/python3 -I \
        /opt/nemoclaw-hermes-config/patch-cron-execution-runtime.py \
        --executions /opt/hermes/cron/executions.py \
        --backup /opt/hermes/hermes_cli/backup.py
RUN set -eu; \
    probe_home="$(mktemp -d)"; \
    trap 'rm -rf "$probe_home"' EXIT; \
    HERMES_HOME="$probe_home" /opt/hermes/.venv/bin/python -I - <<'PY'
from cron.executions import EXECUTIONS_FILE
from hermes_cli.backup import _QUICK_STATE_FILES
from hermes_constants import get_hermes_home

expected = get_hermes_home().resolve() / "runtime" / "cron-executions.db"
assert EXECUTIONS_FILE == expected
assert "runtime/cron-executions.db" in _QUICK_STATE_FILES
assert "cron/executions.db" not in _QUICK_STATE_FILES
PY

# Hermes v0.19.0 computes `sessions list` preview from the first user message,
# while #5254's user-facing expectation is that the existing row reflects the
# latest resumed/continued one-shot turn. Patch only the pinned query shape and
# prove the SessionDB list contract at build time so a Hermes update cannot
# silently drift.
RUN /usr/bin/python3 -I /usr/local/lib/nemoclaw/patch-hermes-session-list-preview.py \
    && grep -q 'ORDER BY m.timestamp DESC, m.id DESC LIMIT 1' /opt/hermes/hermes_state.py \
    && HERMES_HOME="$(mktemp -d)" /opt/hermes/.venv/bin/python - <<'PY'
from hermes_state import SessionDB

db = SessionDB()
session_id = "nemoclaw-preview-smoke"
db.create_session(session_id, "cli")
db.append_message(session_id, "user", "NEMOCLAW_PREVIEW_FIRST")
db.append_message(session_id, "assistant", "ack")
db.append_message(session_id, "user", "NEMOCLAW_PREVIEW_LATEST")
rows = db.list_sessions_rich(limit=1)
assert rows and rows[0]["id"] == session_id, rows
assert rows[0]["preview"] == "NEMOCLAW_PREVIEW_LATEST", rows
PY

# Hermes v0.19.0 forces the gateway-created Discord recovery ledger to 0600,
# which prevents sandbox-owned online backup and makes a sandbox-restored
# database unwritable by the gateway. The final layout uses a gateway:sandbox
# setgid parent, and this exact-source patch retains group write on the ledger.
# Remove it when upstream supports an equivalent cross-identity mode contract.
ARG NEMOCLAW_HERMES_DISCORD_RECOVERY_PATCHER_SHA256=e42f0712c2895c8d1c766c0748c110dc830394b2caf63c3f1a99a113ab374628
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_DISCORD_RECOVERY_PATCHER_SHA256" /usr/local/lib/nemoclaw/patch-hermes-discord-recovery-permissions.py \
    | sha256sum -c - \
    || { echo "ERROR: patch-hermes-discord-recovery-permissions.py hash mismatch (update NEMOCLAW_HERMES_DISCORD_RECOVERY_PATCHER_SHA256)" >&2; exit 1; }
RUN /usr/bin/python3 -I /usr/local/lib/nemoclaw/patch-hermes-discord-recovery-permissions.py \
        /opt/hermes/plugins/platforms/discord/recovery.py \
    && /usr/bin/python3 -I - <<'PY'
from pathlib import Path

source = Path("/opt/hermes/plugins/platforms/discord/recovery.py").read_text()
assert source.count('_DB_FILENAME = "discord_message_recovery.db"') == 1
assert source.count('directory = self._hermes_home / "gateway"') == 1
assert source.count("os.chmod(path, 0o600)") == 0
assert source.count("os.chmod(path, 0o660)") == 1
PY

# Hermes v0.19.0's bundled Langfuse plugin rejects OpenShell resolver
# placeholders before the SDK can construct its Basic-auth headers. Accept only
# the exact public/secret placeholder bound to the matching standard Langfuse
# key; raw keys keep Hermes' upstream pk-lf-/sk-lf- validation. The patcher
# fails closed when the pinned upstream source shape changes.
ARG NEMOCLAW_HERMES_LANGFUSE_PATCHER_SHA256=c6aad6a7cb56083a3fbb54617ada3edae4bbae1348ba45565944144b07fc283b
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_LANGFUSE_PATCHER_SHA256" /usr/local/lib/nemoclaw/patch-hermes-langfuse-credentials.mts \
    | sha256sum -c - \
    || { echo "ERROR: patch-hermes-langfuse-credentials.mts hash mismatch (update NEMOCLAW_HERMES_LANGFUSE_PATCHER_SHA256)" >&2; exit 1; }
RUN node --experimental-strip-types \
        /usr/local/lib/nemoclaw/patch-hermes-langfuse-credentials.mts \
        /opt/hermes/plugins/observability/langfuse/__init__.py \
    && /opt/hermes/.venv/bin/python - <<'PY'
import importlib.util
import sys

path = "/opt/hermes/plugins/observability/langfuse/__init__.py"
spec = importlib.util.spec_from_file_location("nemoclaw_langfuse_contract", path)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
validate = module._validate_langfuse_key
assert validate("HERMES_LANGFUSE_PUBLIC_KEY", "pk-lf-public") is None
assert validate("HERMES_LANGFUSE_SECRET_KEY", "sk-lf-secret") is None
assert validate(
    "HERMES_LANGFUSE_PUBLIC_KEY",
    "openshell:resolve:env:LANGFUSE_PUBLIC_KEY",
) is None
assert validate(
    "HERMES_LANGFUSE_SECRET_KEY",
    "openshell:resolve:env:v1_LANGFUSE_SECRET_KEY",
) is None
assert validate(
    "HERMES_LANGFUSE_PUBLIC_KEY",
    "openshell:resolve:env:LANGFUSE_SECRET_KEY",
) is not None
assert validate(
    "HERMES_LANGFUSE_SECRET_KEY",
    "openshell:resolve:env:v1_LANGFUSE_PUBLIC_KEY",
) is not None
PY

# Cryptographic integrity gate for the security-critical Python entrypoints:
# the wrapper and validator that enforce the runtime env secret boundary, plus
# the descriptor-safe Tirith marker finalizer. Any content change MUST be
# accompanied by an updated hash below; otherwise the build fails. This blocks
# silent supply-chain tampering of the build context (an attacker rewriting a
# file has to also rewrite the Dockerfile-committed hash, which reviewers gate).
# Regenerate with `sha256sum agents/hermes/{hermes-wrapper.py,validate-env-secret-boundary.py,finalize-tirith-marker.py}`.
ARG NEMOCLAW_HERMES_WRAPPER_SHA256=cd851746da14162ac4701d56c274dac20024ea6a11f6ffcf2ce7fb89dff388a0
ARG NEMOCLAW_HERMES_VALIDATOR_SHA256=822c7e63d068c5d09f3291350771c1a42c9686f51bfa9bc9a1f41fbe15d163b1
ARG NEMOCLAW_HERMES_TIRITH_FINALIZER_SHA256=a1e6b1c53ab297569abb87c29d15c294d729e46005bfd022136b4c447a791819
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_VALIDATOR_SHA256" /usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py \
    | sha256sum -c - \
    || { echo "ERROR: validate-hermes-env-secret-boundary.py hash mismatch (update NEMOCLAW_HERMES_VALIDATOR_SHA256)" >&2; exit 1; }
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_TIRITH_FINALIZER_SHA256" /usr/local/lib/nemoclaw/finalize-tirith-marker.py \
    | sha256sum -c - \
    || { echo "ERROR: finalize-tirith-marker.py hash mismatch (update NEMOCLAW_HERMES_TIRITH_FINALIZER_SHA256)" >&2; exit 1; }

# Wrap the hermes CLI so the runtime env secret boundary is enforced for
# `hermes gateway` no matter how it is invoked. The entrypoint guard alone left
# a direct `docker exec ... hermes gateway run` able to start the gateway with
# raw secret-shaped env vars (#4975). Relocate the real binary and install the
# wrapper in its place; the wrapper reuses the same validator and execs the real
# binary for every non-gateway subcommand. Re-assert --version through the
# wrapper so a broken relocation fails the build.
#
# The wrapper's shebang pins `/usr/bin/python3 -I` (isolated mode); fail the
# build if that absolute path is missing or non-executable so a base-image
# upgrade that drops it cannot ship a wrapper that ENOEXECs at runtime.
COPY --from=hermes-wrapper-payload / /

RUN test -x /usr/bin/python3 \
    || { echo "ERROR: /usr/bin/python3 missing or not executable; hermes-wrapper shebang would ENOEXEC" >&2; exit 1; }
# hadolint ignore=DL4006
RUN hermes_version_output="$(/usr/local/bin/hermes --version)" \
    && hermes_semver="$(printf '%s\n' "$hermes_version_output" | sed -n 's/.*v\([0-9][0-9]*[.][0-9][0-9]*[.][0-9][0-9]*\).*/\1/p; s/^\([0-9][0-9]*[.][0-9][0-9]*[.][0-9][0-9]*\)$/\1/p' | head -1)" \
    && if [ -z "$hermes_semver" ]; then \
        echo "ERROR: could not parse Hermes semver from: $hermes_version_output" >&2; \
        exit 1; \
    fi \
    && if [ "$hermes_semver" != "0.19.0" ] \
        && { grep -q '_translate_resumed_oneshot' /usr/local/lib/nemoclaw/hermes-wrapper.py \
          || grep -q 'EXPECTED_OCCURRENCES' /usr/local/lib/nemoclaw/patch-hermes-session-list-preview.py; }; then \
        echo "ERROR: installed Hermes ${hermes_semver} but Hermes v0.19.0 compatibility workarounds are still installed; re-review #5254 workaround removal before upgrading Hermes" >&2; \
        exit 1; \
    fi
# This runs before `/usr/local/bin/hermes` is moved to `hermes.real`, so the
# probes check the pinned Hermes binary, not the wrapper installed below.
# Hermes consumes -p/--profile before argparse renders help, so validate those
# hidden global options behaviorally and parse every visible option token.
RUN /usr/bin/python3 -I -c 'import ast, pathlib, re, subprocess, sys; source = pathlib.Path("/usr/local/lib/nemoclaw/hermes-wrapper.py").read_text(); tree = ast.parse(source); expected_constants = {"_VALUE_FLAGS", "_TOP_LEVEL_VALUE_FLAGS", "_BOOLEAN_FLAGS", "_HERMES_SUBCOMMANDS", "_PROVIDER_MODEL_COMMAND_SCAN_REQUIRED_VALUE_FLAGS", "_PROVIDER_MODEL_COMMAND_SCAN_SESSION_FLAGS"}; constants = {node.targets[0].id: ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id in expected_constants}; missing_constants = sorted(expected_constants - set(constants)); missing_constants and sys.exit("ERROR: Hermes wrapper CLI constants not found in AST: " + ", ".join(missing_constants)); empty_constants = sorted(name for name in expected_constants if not constants[name]); empty_constants and sys.exit("ERROR: Hermes wrapper CLI constants are empty: " + ", ".join(empty_constants)); session_flags = set(constants["_PROVIDER_MODEL_COMMAND_SCAN_SESSION_FLAGS"]); required_value_flags = set(constants["_PROVIDER_MODEL_COMMAND_SCAN_REQUIRED_VALUE_FLAGS"]); profile_flags = {"-p", "--profile"}; profile_flags <= required_value_flags or sys.exit("ERROR: Hermes wrapper scanner must retain both hidden profile flags"); derived_required_value_flags = (set(constants["_VALUE_FLAGS"]) - session_flags) | set(constants["_TOP_LEVEL_VALUE_FLAGS"]) | {"-z", "--oneshot"} | profile_flags; required_value_flags != derived_required_value_flags and sys.exit("ERROR: Hermes wrapper required-value scanner flags drifted from forwarding/global flags: missing=" + ",".join(sorted(derived_required_value_flags - required_value_flags)) + " stale=" + ",".join(sorted(required_value_flags - derived_required_value_flags))); option_pattern = r"(?<![A-Za-z0-9_])--?[A-Za-z0-9][A-Za-z0-9-]*"; top_help = subprocess.check_output(["/usr/local/bin/hermes", "--help"], text=True, timeout=30); top_option_fields = [re.split(r"\s{2,}", line.strip(), maxsplit=1)[0] for line in top_help.splitlines() if line.lstrip().startswith("-")]; top_options = set(re.findall(option_pattern, "\n".join(top_option_fields))); top_expected = (required_value_flags - profile_flags) | session_flags | set(constants["_BOOLEAN_FLAGS"]); top_missing = sorted(top_expected - top_options); top_missing and sys.exit("ERROR: Hermes wrapper scanner flag allowlist drifted from pinned hermes --help: " + ", ".join(top_missing)); profile_probe_name = "nemoclaw-build-probe-missing"; profile_probe_expected = "Profile %r does not exist." % profile_probe_name; profile_probe_results = {flag: subprocess.run(["/usr/local/bin/hermes", flag, profile_probe_name, "--version"], text=True, capture_output=True, timeout=30) for flag in sorted(profile_flags)}; profile_probe_failures = sorted(flag for flag, result in profile_probe_results.items() if result.returncode == 0 or profile_probe_expected not in (result.stdout + result.stderr)); profile_probe_failures and sys.exit("ERROR: Hermes hidden profile flags drifted from the wrapper scanner: " + ", ".join(profile_probe_failures)); subcommand_match = re.search(r"^\s*\{([^}\n]+)\}\s*$", top_help, re.MULTILINE); not subcommand_match and sys.exit("ERROR: could not parse pinned hermes subcommands from --help"); pinned_subcommands = {name.strip() for name in subcommand_match.group(1).split(",")}; wrapper_subcommands = set(constants["_HERMES_SUBCOMMANDS"]); missing_subcommands = sorted(pinned_subcommands - wrapper_subcommands); stale_subcommands = sorted(wrapper_subcommands - pinned_subcommands); (missing_subcommands or stale_subcommands) and sys.exit("ERROR: Hermes wrapper subcommand allowlist drifted from pinned hermes --help: missing=" + ",".join(missing_subcommands) + " stale=" + ",".join(stale_subcommands)); chat_help = subprocess.check_output(["/usr/local/bin/hermes", "chat", "--help"], text=True, timeout=30); chat_option_fields = [re.split(r"\s{2,}", line.strip(), maxsplit=1)[0] for line in chat_help.splitlines() if line.lstrip().startswith("-")]; chat_options = set(re.findall(option_pattern, "\n".join(chat_option_fields))); chat_expected = set(constants["_VALUE_FLAGS"]) | set(constants["_VALUE_FLAGS"].values()) | set(constants["_BOOLEAN_FLAGS"]) | {"--query", "-q", "--quiet", "-Q", "--continue", "-c"}; chat_missing = sorted(chat_expected - chat_options); chat_missing and sys.exit("ERROR: Hermes wrapper forwarded flags drifted from pinned hermes chat --help: " + ", ".join(chat_missing))'
# Hermes' private unquoted-session coalescer intentionally differs from public
# help (for example, `console` is not a boundary). Bind that upstream AST set
# independently so a new command cannot silently change wrapper parsing.
# hadolint ignore=DL3059
RUN /usr/bin/python3 -I - <<'PY'
import ast
from pathlib import Path

wrapper_tree = ast.parse(
    Path("/usr/local/lib/nemoclaw/hermes-wrapper.py").read_text(encoding="utf-8")
)
wrapper_assignments = [
    node
    for node in wrapper_tree.body
    if isinstance(node, ast.Assign)
    and len(node.targets) == 1
    and isinstance(node.targets[0], ast.Name)
    and node.targets[0].id == "_HERMES_SESSION_NAME_BOUNDARIES"
]
if len(wrapper_assignments) != 1:
    raise SystemExit("ERROR: expected one wrapper session-name boundary constant")
wrapper_value = wrapper_assignments[0].value
if not (
    isinstance(wrapper_value, ast.Call)
    and isinstance(wrapper_value.func, ast.Name)
    and wrapper_value.func.id == "frozenset"
    and len(wrapper_value.args) == 1
    and not wrapper_value.keywords
):
    raise SystemExit("ERROR: wrapper session-name boundaries are not a literal frozenset")
wrapper_boundaries = set(ast.literal_eval(wrapper_value.args[0]))

upstream_tree = ast.parse(
    Path("/opt/hermes/hermes_cli/main.py").read_text(encoding="utf-8")
)
coalescers = [
    node
    for node in upstream_tree.body
    if isinstance(node, ast.FunctionDef)
    and node.name == "_coalesce_session_name_args"
]
if len(coalescers) != 1:
    raise SystemExit("ERROR: expected one pinned Hermes session-name coalescer")
upstream_assignments = [
    node
    for node in coalescers[0].body
    if isinstance(node, ast.Assign)
    and len(node.targets) == 1
    and isinstance(node.targets[0], ast.Name)
    and node.targets[0].id == "_SUBCOMMANDS"
]
if len(upstream_assignments) != 1:
    raise SystemExit("ERROR: expected one pinned Hermes coalescer boundary set")
upstream_boundaries = set(ast.literal_eval(upstream_assignments[0].value))

missing = sorted(upstream_boundaries - wrapper_boundaries)
stale = sorted(wrapper_boundaries - upstream_boundaries)
if missing or stale:
    raise SystemExit(
        "ERROR: Hermes wrapper session-name boundaries drifted from pinned coalescer: "
        f"missing={','.join(missing)} stale={','.join(stale)}"
    )
PY

# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_WRAPPER_SHA256" /usr/local/lib/nemoclaw/hermes-wrapper.py \
    | sha256sum -c - \
    || { echo "ERROR: hermes-wrapper.py hash mismatch (update NEMOCLAW_HERMES_WRAPPER_SHA256)" >&2; exit 1; }
RUN mv /usr/local/bin/hermes /usr/local/bin/hermes.real \
    && install -m 0755 /usr/local/lib/nemoclaw/hermes-wrapper.py /usr/local/bin/hermes \
    && chmod 755 /usr/local/bin/hermes.real \
    && /usr/local/bin/hermes --version

# Build args for config that varies per deployment.
ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b
# Non-secret managed inference route identifier ("inference" for proxied
# providers, or a provider family such as "openai"). Never a credential.
ARG NEMOCLAW_INFERENCE_PROVIDER_ID=custom
# User-selected upstream provider name (nvidia-prod, hermes-provider, ...).
# Distinct from NEMOCLAW_INFERENCE_PROVIDER_ID, which carries the managed route
# identifier ("inference" for proxied providers) needed at routing/runtime.
ARG NEMOCLAW_UPSTREAM_PROVIDER=custom
ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1
ARG NEMOCLAW_INFERENCE_API=openai-completions
ARG NEMOCLAW_TOOL_DISCLOSURE=progressive
# CHAT_UI_URL is a legacy name shared with the OpenClaw build arg. For
# Hermes this URL points at the browser dashboard. The OpenAI-compatible
# API remains exposed separately on port 8642.
ARG CHAT_UI_URL=http://127.0.0.1:18789
ARG NEMOCLAW_MESSAGING_PLAN_B64=
ARG NEMOCLAW_WEB_SEARCH_ENABLED=0
ARG NEMOCLAW_WEB_SEARCH_PROVIDER=tavily
ARG NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=0
ARG NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64=W10=
ARG NEMOCLAW_BUILD_ID=default
ARG NEMOCLAW_DARWIN_VM_COMPAT=0
# Base64-encoded host corporate-proxy CA bundle (#6210). Empty by default. When
# onboard detects an operator-supplied corporate CA on the host it bakes it
# here; the RUN below decodes it to a root-owned file that the entrypoint
# appends to the OpenShell trust bundle at runtime. The CA is a public
# certificate, not a secret, so baking it into an image layer is acceptable.
ARG NEMOCLAW_CORPORATE_CA_B64
# Total model context window (input + output tokens). Empty by default so
# Hermes auto-detects from the endpoint's /v1/models max_model_len; onboard
# rewrites this ARG (via dockerfile-patch) when it probes a runtime value or
# the user sets NEMOCLAW_CONTEXT_WINDOW, so Hermes' NemotronH metadata default
# cannot override the real window (#6177).
ARG NEMOCLAW_CONTEXT_WINDOW=

# Promote persistent image config to env vars for config generation.
# NEMOCLAW_MESSAGING_PLAN_B64 intentionally remains ARG-only: Docker exposes it
# to build RUN processes without retaining the full plan in the final image env.
ENV NEMOCLAW_MODEL=${NEMOCLAW_MODEL} \
    NEMOCLAW_INFERENCE_PROVIDER_ID=${NEMOCLAW_INFERENCE_PROVIDER_ID} \
    NEMOCLAW_UPSTREAM_PROVIDER=${NEMOCLAW_UPSTREAM_PROVIDER} \
    NEMOCLAW_INFERENCE_BASE_URL=${NEMOCLAW_INFERENCE_BASE_URL} \
    NEMOCLAW_INFERENCE_API=${NEMOCLAW_INFERENCE_API} \
    NEMOCLAW_CONTEXT_WINDOW=${NEMOCLAW_CONTEXT_WINDOW} \
    NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE} \
    CHAT_UI_URL=${CHAT_UI_URL} \
    NEMOCLAW_WEB_SEARCH_ENABLED=${NEMOCLAW_WEB_SEARCH_ENABLED} \
    NEMOCLAW_WEB_SEARCH_PROVIDER=${NEMOCLAW_WEB_SEARCH_PROVIDER} \
    NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=${NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER} \
    NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64=${NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64}

# Bake reduced messaging runtime metadata for the entrypoint. Hermes runtime
# config refresh consumes generic manifest-owned aliases from this artifact.
# hadolint ignore=DL3059
RUN node --experimental-strip-types /src/lib/messaging/applier/build/messaging-build-applier.mts --agent hermes --phase runtime-setup \
    && runtime_plan=/usr/local/share/nemoclaw/messaging-runtime-plan.json \
    && { [ ! -f "$runtime_plan" ] || { test ! -L "$runtime_plan" \
    && node -e "const fs=require('fs'); const path=process.argv[1]; const st=fs.statSync(path); if (!st.isFile() || st.uid !== 0 || st.gid !== 0 || (st.mode & 0o022) !== 0) throw new Error('unsafe runtime plan file metadata'); const p=JSON.parse(fs.readFileSync(path,'utf8')); for (const k of ['agentRender','buildSteps','stateUpdates','healthChecks']) if (Object.hasOwn(p,k)) throw new Error('runtime plan contains unreduced key '+k); const runtimeSetup=p.runtimeSetup; const isObject=(v)=>v && typeof v === 'object' && !Array.isArray(v); if (!isObject(runtimeSetup) || !Array.isArray(runtimeSetup.nodePreloads) || !Array.isArray(runtimeSetup.envAliases) || !Array.isArray(runtimeSetup.secretScans) || !runtimeSetup.nodePreloads.every(isObject) || !runtimeSetup.envAliases.every(isObject) || !runtimeSetup.secretScans.every(isObject)) throw new Error('runtime plan missing reduced runtimeSetup shape');" "$runtime_plan"; }; }

# Apply messaging agent-install hooks as root so Hermes Python packages can update
# /opt/hermes/.venv before the runtime drops to the sandbox user.
WORKDIR /opt/hermes
# hadolint ignore=DL3059
RUN node --experimental-strip-types /src/lib/messaging/applier/build/messaging-build-applier.mts --agent hermes --phase agent-install

# Decode the host corporate-proxy CA (#6210) to a root-owned, read-only file
# when onboard baked one in. No-op when NEMOCLAW_CORPORATE_CA_B64 is empty. The
# ARG is expanded by the shell (not interpolated into source), and its value is
# base64 sanitized host-side, so this is not an injection vector. Must run as
# root, before the USER sandbox drop below.
# hadolint ignore=DL3059,DL4006
RUN if [ -n "${NEMOCLAW_CORPORATE_CA_B64}" ]; then \
      command -v base64 >/dev/null 2>&1 || { echo "[nemoclaw] base64 is required to decode NEMOCLAW_CORPORATE_CA_B64 but is not installed in the build image" >&2; exit 1; }; \
      command -v openssl >/dev/null 2>&1 || { echo "[nemoclaw] openssl is required to validate NEMOCLAW_CORPORATE_CA_B64 but is not installed in the build image (#6210)" >&2; exit 1; }; \
      mkdir -p /usr/local/share/nemoclaw \
      && { printf '%s' "${NEMOCLAW_CORPORATE_CA_B64}" | base64 --decode > /tmp/nemoclaw-corporate-ca.decoded 2>/dev/null \
           || { echo "[nemoclaw] NEMOCLAW_CORPORATE_CA_B64 is not valid base64; expected a single-line base64-encoded PEM (#6210)" >&2; exit 1; }; } \
      && awk '/-----BEGIN CERTIFICATE-----/{f=1} f{print} /-----END CERTIFICATE-----/{f=0}' /tmp/nemoclaw-corporate-ca.decoded > /usr/local/share/nemoclaw/corporate-ca.pem \
      && rm -f /tmp/nemoclaw-corporate-ca.decoded \
      && { grep -qF -- "-----BEGIN CERTIFICATE-----" /usr/local/share/nemoclaw/corporate-ca.pem || { echo "[nemoclaw] NEMOCLAW_CORPORATE_CA_B64 did not decode to a bundle of valid X.509 certificates (#6210)" >&2; exit 1; }; } \
      && { openssl crl2pkcs7 -nocrl -certfile /usr/local/share/nemoclaw/corporate-ca.pem >/dev/null 2>&1 || { echo "[nemoclaw] NEMOCLAW_CORPORATE_CA_B64 did not decode to a bundle of valid X.509 certificates (#6210)" >&2; exit 1; }; } \
      && chown root:root /usr/local/share/nemoclaw/corporate-ca.pem \
      && chmod 0444 /usr/local/share/nemoclaw/corporate-ca.pem \
      && echo "[nemoclaw] baked host corporate-proxy CA into image trust (#6210)"; \
    fi

WORKDIR /sandbox
USER sandbox

# Set up blueprint for local resolution
RUN mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0 \
    && cp -r /opt/nemoclaw-blueprint/* /sandbox/.nemoclaw/blueprints/0.1.0/

# Run Hermes' upstream repair before NemoClaw writes the generated config.yaml
# and .env that become the startup integrity trust anchor. Doctor-created
# defaults are overwritten by the generator below.
# Generate Hermes config.yaml and .env from build args.
# Config is mutable by default (600 sandbox:sandbox). Immutability is opt-in
# via `shields up`. .env holds API key placeholders for OpenShell provider pipeline.
# SECURITY: Uses a separate script file instead of inline code to avoid
# code injection via build-arg interpolation (same concern as OpenClaw C-2).
RUN HERMES_HOME=/sandbox/.hermes /usr/local/bin/hermes doctor --fix \
    && node --experimental-strip-types /opt/nemoclaw-hermes-config/generate-config.ts \
    && rm -rf /sandbox/.cache

# Prove that the installed dashboard seeder carries every reviewed policy value
# from the generated default home into a fresh isolated dashboard home. This is
# deliberately exact: a missing leaf or an unexpected session-reset default
# must fail the image build instead of broadening behavior at runtime.
RUN dashboard_probe=/tmp/nemoclaw-dashboard-policy-probe.yaml \
    && rm -f "$dashboard_probe" "$dashboard_probe.nemoclaw.tmp" \
    && /opt/hermes/.venv/bin/python -I \
        /usr/local/lib/nemoclaw/seed-hermes-dashboard-config.py \
        /sandbox/.hermes/config.yaml "$dashboard_probe" \
    && /opt/hermes/.venv/bin/python -I - "$dashboard_probe" <<'PY'
import sys
from pathlib import Path

import yaml

path = Path(sys.argv[1])
config = yaml.safe_load(path.read_text(encoding="utf-8"))
expected = {
    "approvals": {"mode": "manual"},
    "browser": {"restrict_evaluate": True},
    "session_reset": {
        "mode": "both",
        "at_hour": 4,
        "idle_minutes": 1440,
        "notify": True,
        "notify_exclude_platforms": ["api_server", "webhook"],
        "bg_process_max_age_hours": 24,
    },
    "display": {
        "show_reasoning": False,
        "show_commentary": False,
    },
    "updates": {
        "pre_update_backup": False,
        "refresh_cua_driver": False,
    },
}
for section, values in expected.items():
    assert config.get(section) == values, (section, config.get(section), values)
path.unlink()
PY

# Install NemoClaw plugin into Hermes
# hadolint ignore=DL3059
RUN mkdir -p /sandbox/.hermes/plugins/nemoclaw \
    && cp -r /opt/nemoclaw-hermes-plugin/* /sandbox/.hermes/plugins/nemoclaw/

# Apply messaging render and post-agent-install build-file hooks after agent/plugin installation.
# hadolint ignore=DL3059
RUN node --experimental-strip-types /src/lib/messaging/applier/build/messaging-build-applier.mts --agent hermes --phase post-agent-install

# Write the default SOUL.md (agent identity) for the sandboxed agent.
# This is the stock Hermes default soul (hermes_cli/default_soul.py,
# DEFAULT_SOUL_MD) shipped verbatim. The OpenShell/NemoClaw environment is
# described separately via HERMES_ENVIRONMENT_HINT (below), which Hermes
# appends to the system prompt's environment-hints block — the correct slot
# for execution-environment facts, keeping the identity slot unmodified.
RUN mkdir -p /sandbox/.hermes/memories \
    && printf '%s' \
    'You are Hermes Agent, an intelligent AI assistant created by Nous Research. You are helpful, knowledgeable, and direct. You assist users with a wide range of tasks including answering questions, writing and editing code, analyzing information, creative work, and executing actions via your tools. You communicate clearly, admit uncertainty when appropriate, and prioritize being genuinely useful over being verbose unless otherwise directed below. Be targeted and efficient in your exploration and investigations.' \
    > /sandbox/.hermes/SOUL.md

# Describe the execution environment via Hermes's dedicated environment-hint
# mechanism (agent/prompt_builder.py:build_environment_hints). This lands in
# the system prompt's environment slot, not the identity slot, and is read once
# at prompt-build time so it stays in the cache-safe portion of the prompt.
ENV HERMES_ENVIRONMENT_HINT="You are running inside an NVIDIA OpenShell sandbox, with inference routed through NemoClaw. Your terminal, file, and web tools execute against the sandbox filesystem and egress through the OpenShell L7 proxy, which enforces network policy and rewrites credentials at the boundary, so you never see raw secrets. Your config and memory live under /sandbox/.hermes and are mutable unless shields are up. Work within the sandbox boundary."

# Set mutable-default permissions (640 files, 3770 config root).
# The sandbox user can write config; the gateway user can read it via
# supplementary sandbox-group membership and create Hermes v0.14 runtime dirs
# without being able to remove sticky-protected config files. Shields-up applies
# 444 root:root + chattr +i.
# hadolint ignore=DL3002
USER root

# Flatten stale published base images that still contain the old .hermes-data
# symlink bridge. The base resolver owns published-image provenance and exports
# immutable digests; this final-image boundary owns layout validation so local,
# rebuilt, and caller-selected bases remain supported. Retired OpenClaw state
# must never enter a Hermes final image. OpenShell starts the sandbox as the
# sandbox user, so the .hermes-data migration cannot rely on root privileges
# inside the pod.
# hadolint ignore=DL4006
RUN set -eu; \
    config_dir=/sandbox/.hermes; \
    data_dir=/sandbox/.hermes-data; \
    openclaw_dir=/sandbox/.openclaw; \
    if [ -e "$openclaw_dir" ] || [ -L "$openclaw_dir" ]; then \
        echo "ERROR: Hermes base image contains retired OpenClaw state: $openclaw_dir" >&2; \
        exit 1; \
    fi; \
    mkdir -p "$config_dir"; \
    if [ -L "$data_dir" ]; then \
        echo "ERROR: refusing legacy layout cleanup because $data_dir is a symlink" >&2; \
        exit 1; \
    fi; \
    if [ -d "$data_dir" ]; then \
        legacy_link="$(find "$data_dir" -type l -print -quit)"; \
        if [ -n "$legacy_link" ]; then \
            echo "ERROR: refusing legacy layout cleanup because $legacy_link is a symlink" >&2; \
            exit 1; \
        fi; \
        for entry in "$data_dir"/*; do \
            [ -e "$entry" ] || [ -L "$entry" ] || continue; \
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
        "$config_dir/logs/curator" \
        "$config_dir/skins" \
        "$config_dir/plans" \
        "$config_dir/workspace" \
        "$config_dir/profiles" \
        "$config_dir/cache" \
        "$config_dir/hooks" \
        "$config_dir/image_cache" \
        "$config_dir/audio_cache" \
        "$config_dir/pairing" \
        "$config_dir/platforms" \
        "$config_dir/platforms/whatsapp" \
        "$config_dir/platforms/whatsapp/session" \
        "$config_dir/gateway" \
        "$config_dir/weixin" \
        "$config_dir/weixin/accounts" \
        "$config_dir/runtime" \
        "$config_dir/dashboard-home"; \
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
    && chown gateway:sandbox \
        /sandbox/.hermes/cron \
        /sandbox/.hermes/gateway \
        /sandbox/.hermes/runtime \
    && chmod 3770 /sandbox/.hermes \
    && chmod 770 \
        /sandbox/.hermes/memories \
        /sandbox/.hermes/sessions \
        /sandbox/.hermes/skills \
        /sandbox/.hermes/plugins \
        /sandbox/.hermes/cron \
        /sandbox/.hermes/logs \
        /sandbox/.hermes/logs/curator \
        /sandbox/.hermes/skins \
        /sandbox/.hermes/plans \
        /sandbox/.hermes/workspace \
        /sandbox/.hermes/profiles \
        /sandbox/.hermes/cache \
        /sandbox/.hermes/hooks \
        /sandbox/.hermes/image_cache \
        /sandbox/.hermes/audio_cache \
        /sandbox/.hermes/pairing \
        /sandbox/.hermes/platforms \
        /sandbox/.hermes/platforms/whatsapp \
        /sandbox/.hermes/platforms/whatsapp/session \
        /sandbox/.hermes/gateway \
        /sandbox/.hermes/weixin \
        /sandbox/.hermes/weixin/accounts \
        /sandbox/.hermes/runtime \
        /sandbox/.hermes/dashboard-home \
    && chmod 2770 \
        /sandbox/.hermes/logs \
        /sandbox/.hermes/logs/curator \
        /sandbox/.hermes/platforms \
        /sandbox/.hermes/platforms/whatsapp \
        /sandbox/.hermes/platforms/whatsapp/session \
        /sandbox/.hermes/cron \
        /sandbox/.hermes/gateway \
        /sandbox/.hermes/runtime \
    && chmod 640 /sandbox/.hermes/config.yaml \
    && chmod 640 /sandbox/.hermes/.env \
    && find -P /sandbox/.hermes/logs -type f -exec chown sandbox:sandbox {} + \
    && find -P /sandbox/.hermes/logs -type f -exec chmod 660 {} + \
    && for name in state.db state.db-wal state.db-shm gateway.lock gateway_state.json channel_directory.json; do \
        rm -f "/sandbox/.hermes/${name}"; \
        ln -s "runtime/${name}" "/sandbox/.hermes/${name}"; \
    done \
    && : > /sandbox/.hermes/.hermes_history \
    && chown sandbox:sandbox /sandbox/.hermes/.hermes_history \
    && chmod 660 /sandbox/.hermes/.hermes_history

# Prove the cron execution ledger contract across the real image identities.
# Hermes' gateway-side scheduler creates the live WAL-backed database in the
# writable runtime boundary, sandbox reads and online-copies it before
# atomically restoring a sandbox-owned replacement, and gateway then reopens
# that replacement through the upstream ledger API.
RUN test "$(stat -c '%U:%G %a' /sandbox/.hermes/runtime)" = "gateway:sandbox 2770" \
    && test ! -e /sandbox/.hermes/cron/executions.db \
    && umask 0007 \
    && HERMES_HOME=/sandbox/.hermes gosu gateway /opt/hermes/.venv/bin/python -I - <<'PY'
from cron.executions import create_execution

created = create_execution(
    "nemoclaw-cross-uid-create-probe",
    source="nemoclaw-image-build",
)
assert created["job_id"] == "nemoclaw-cross-uid-create-probe"
assert created["status"] == "claimed"
PY

RUN test "$(stat -c '%U:%G %a' /sandbox/.hermes/runtime/cron-executions.db)" = "gateway:sandbox 640" \
    && umask 0007 \
    && HERMES_HOME=/sandbox/.hermes gosu sandbox /opt/hermes/.venv/bin/python -I - <<'PY'
import os
import sqlite3
from pathlib import Path

path = Path("/sandbox/.hermes/runtime/cron-executions.db")
staged = path.with_name(".nemoclaw-cron-executions-staged")
staged.unlink(missing_ok=True)
source = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
target = sqlite3.connect(staged, timeout=30)
try:
    assert source.execute(
        "SELECT job_id, status FROM executions"
    ).fetchone() == ("nemoclaw-cross-uid-create-probe", "claimed")
    source.backup(target)
    assert target.execute("PRAGMA quick_check").fetchone() == ("ok",)
finally:
    target.close()
    source.close()
os.chmod(staged, 0o660)
os.replace(staged, path)
for suffix in ("-wal", "-shm"):
    path.with_name(f"{path.name}{suffix}").unlink(missing_ok=True)
PY

RUN test "$(stat -c '%U:%G %a' /sandbox/.hermes/runtime/cron-executions.db)" = "sandbox:sandbox 660" \
    && umask 0007 \
    && HERMES_HOME=/sandbox/.hermes gosu gateway /opt/hermes/.venv/bin/python -I - <<'PY'
from cron.executions import create_execution, list_executions

created = create_execution(
    "nemoclaw-cross-uid-reopen-probe",
    source="nemoclaw-image-build",
)
assert created["job_id"] == "nemoclaw-cross-uid-reopen-probe"
assert {
    row["job_id"] for row in list_executions(limit=10)
} == {
    "nemoclaw-cross-uid-create-probe",
    "nemoclaw-cross-uid-reopen-probe",
}
PY

RUN test "$(stat -c '%U:%G %a' /sandbox/.hermes/runtime/cron-executions.db)" = "sandbox:sandbox 660" \
    && rm -f /sandbox/.hermes/runtime/cron-executions.db \
        /sandbox/.hermes/runtime/cron-executions.db-wal \
        /sandbox/.hermes/runtime/cron-executions.db-shm

# Prove the Discord ledger contract across the real image identities. The
# gateway creates the live WAL-backed database, sandbox reads and online-copies
# it before atomically restoring a sandbox-owned replacement, and gateway then
# reopens that replacement for a write.
RUN test "$(stat -c '%U:%G %a' /sandbox/.hermes/gateway)" = "gateway:sandbox 2770" \
    && umask 0007 \
    && HERMES_HOME=/sandbox/.hermes gosu gateway /opt/hermes/.venv/bin/python -I - <<'PY'
from pathlib import Path

from plugins.platforms.discord.recovery import DiscordRecoveryStore

store = DiscordRecoveryStore(Path("/sandbox/.hermes"))


def create_probe(conn):
    conn.execute(
        "CREATE TABLE IF NOT EXISTS nemoclaw_identity_probe "
        "(value TEXT NOT NULL)"
    )
    conn.execute("DELETE FROM nemoclaw_identity_probe")
    conn.execute(
        "INSERT INTO nemoclaw_identity_probe(value) VALUES (?)",
        ("gateway-created",),
    )
    return True


assert store.call(create_probe, default=False) is True
PY

RUN test "$(stat -c '%U:%G %a' /sandbox/.hermes/gateway/discord_message_recovery.db)" = "gateway:sandbox 660" \
    && umask 0007 \
    && HERMES_HOME=/sandbox/.hermes gosu sandbox /opt/hermes/.venv/bin/python -I - <<'PY'
import os
import sqlite3
from pathlib import Path

path = Path("/sandbox/.hermes/gateway/discord_message_recovery.db")
staged = path.with_name(".nemoclaw-discord-recovery-staged")
staged.unlink(missing_ok=True)
source = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
target = sqlite3.connect(staged, timeout=30)
try:
    assert source.execute(
        "SELECT value FROM nemoclaw_identity_probe"
    ).fetchone() == ("gateway-created",)
    source.backup(target)
    assert target.execute("PRAGMA quick_check").fetchone() == ("ok",)
finally:
    target.close()
    source.close()
os.chmod(staged, 0o660)
os.replace(staged, path)
PY

RUN test "$(stat -c '%U:%G %a' /sandbox/.hermes/gateway/discord_message_recovery.db)" = "sandbox:sandbox 660" \
    && umask 0007 \
    && HERMES_HOME=/sandbox/.hermes gosu gateway /opt/hermes/.venv/bin/python -I - <<'PY'
from pathlib import Path

from plugins.platforms.discord.recovery import DiscordRecoveryStore

store = DiscordRecoveryStore(Path("/sandbox/.hermes"))


def reopen_probe(conn):
    conn.execute(
        "UPDATE nemoclaw_identity_probe SET value = ?",
        ("gateway-reopened",),
    )
    return conn.execute(
        "SELECT value FROM nemoclaw_identity_probe"
    ).fetchone()


assert store.call(reopen_probe) == ("gateway-reopened",)
PY

RUN test "$(stat -c '%U:%G %a' /sandbox/.hermes/gateway/discord_message_recovery.db)" = "sandbox:sandbox 660" \
    && rm -f /sandbox/.hermes/gateway/discord_message_recovery.db \
        /sandbox/.hermes/gateway/discord_message_recovery.db-wal \
        /sandbox/.hermes/gateway/discord_message_recovery.db-shm

# Pin config hash at build time for integrity verification at startup. Invoke
# the installed runtime guard's `_canonical_mcp_servers_digest` directly so
# image sealing and runtime verification cannot drift onto different JSON
# canonicalization contracts.
RUN mkdir -p /etc/nemoclaw \
    && sha256sum /sandbox/.hermes/config.yaml /sandbox/.hermes/.env \
    > /etc/nemoclaw/hermes.config-hash \
    && mcp_digest="$(/opt/hermes/.venv/bin/python -I /usr/local/lib/nemoclaw/build-hermes-mcp-digest.py --guard /usr/local/lib/nemoclaw/hermes-runtime-config-guard.py --config /sandbox/.hermes/config.yaml)" \
    && printf '# nemoclaw-hermes-mcp-state-v1 intended=%s applied=%s\n' "$mcp_digest" "$mcp_digest" \
    >> /etc/nemoclaw/hermes.config-hash \
    && chown root:root /etc/nemoclaw/hermes.config-hash \
    && chmod 444 /etc/nemoclaw/hermes.config-hash

# Backward-compatible marker for host-side shields logic on older sandboxes.
RUN cp /etc/nemoclaw/hermes.config-hash /sandbox/.hermes/.config-hash \
    && chmod 640 /sandbox/.hermes/.config-hash \
    && chown sandbox:sandbox /sandbox/.hermes/.config-hash

# OpenShell's macOS VM backend currently remaps extracted rootfs ownership to
# the host uid/gid before startup. Hermes uses /sandbox as a read_write path, so
# that repair walks the trusted rc files too; keep this Darwin-only so Linux
# Docker-driver sandboxes retain the tighter default permissions.
RUN if [ "$NEMOCLAW_DARWIN_VM_COMPAT" = "1" ]; then \
        chmod -R a+rwX /sandbox/.hermes; \
        find /sandbox/.hermes -type d -exec chmod a+rwx {} +; \
        chmod a+rw /sandbox/.bashrc /sandbox/.profile; \
    fi

# Gate the completed local filesystem too; CI repeats this scan in an isolated
# container and retains evidence keyed to the final image ID.
COPY --from=hermes-scan-payload / /

# These executables are git-tracked 0755 but check out group-writable (0775)
# under umask 002, and COPY carries that source mode into the image. Normalize
# before the check_metadata gate below asserts root:root 755. A RUN chmod is
# builder-independent; COPY --chmod requires BuildKit.
RUN chmod 755 /usr/local/lib/nemoclaw/hermes-wrapper.py /scripts/checks/node-tar-image-scan.mts

RUN check_metadata() { \
        path="$1"; \
        expected="$2"; \
        actual="$(stat -c '%U:%G %a' "$path")"; \
        [ "$actual" = "$expected" ] \
            || { echo "ERROR: $path metadata is $actual, expected $expected" >&2; return 1; }; \
    }; \
    check_absent() { \
        path="$1"; \
        { [ ! -e "$path" ] && [ ! -L "$path" ]; } \
            || { echo "ERROR: build-only Hermes path leaked into the final image: $path" >&2; return 1; }; \
    }; \
    check_absent /opt/hermes/tests \
    && check_absent /root/.npm \
    && check_absent /root/.cache/electron \
    && check_absent /root/.cache/node-gyp \
    && check_absent /sandbox/.cache \
    && check_metadata /scripts/patch-bundled-npm-brace-expansion.mts 'root:root 444' \
    && check_metadata /scripts/patch-bundled-npm-tar.mts 'root:root 444' \
    && check_metadata /opt/nemoclaw-hermes-config/generate-config.ts 'root:root 444' \
    && check_metadata /usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py 'root:root 755' \
    && check_metadata /usr/local/lib/nemoclaw/patch-hermes-discord-recovery-permissions.py 'root:root 755' \
    && check_metadata /usr/local/lib/nemoclaw/patch-hermes-profile-policy-defaults.py 'root:root 755' \
    && check_metadata /usr/local/bin/nemoclaw-gateway-control 'root:root 700' \
    && check_metadata /usr/local/lib/nemoclaw/preloads/sandbox-safety-net.js 'root:root 444' \
    && check_metadata /usr/local/lib/nemoclaw/hermes-wrapper.py 'root:root 755' \
    && check_metadata /scripts/checks/node-tar-image-scan.mts 'root:root 755' \
    && install -d -m 0755 /usr/local/share/nemoclaw \
    && node --experimental-strip-types /scripts/checks/node-tar-image-scan.mts \
        --root / --image build:hermes \
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
        "perl-base=5.44.0-1nemoclaw1" \
        "perl=5.44.0-1nemoclaw1" \
        | cmp -s - "$security_inventory"; \
    test "$(dpkg-query -W -f='${Version}' libexpat1)" = "2.8.2-1"; \
    test "$(dpkg-query -W -f='${Version}' libonig5)" = "6.9.9-1+b1"; \
    test "$(dpkg-query -W -f='${Version}' libjq1)" = "1.8.2-1"; \
    test "$(dpkg-query -W -f='${Version}' jq)" = "1.8.2-1"; \
    test "$(dpkg-query -W -f='${Version}' vim-common)" = "2:9.2.0782-1"; \
    test "$(dpkg-query -W -f='${Version}' vim-tiny)" = "2:9.2.0782-1"; \
    test "$(dpkg-query -W -f='${Version}' libssh2-1t64)" = "1.11.1-1+deb13u1+nemoclaw1"; \
    test "$(dpkg-query -W -f='${Version}' nemoclaw-python3.13-htmlparser-fix)" = "3.13.5-2+deb13u4+nemoclaw1"; \
    test "$(dpkg-query -W -f='${Version}' perl-base)" = "5.44.0-1nemoclaw1"; \
    test "$(dpkg-query -W -f='${Version}' perl)" = "5.44.0-1nemoclaw1"; \
    test "$(perl -e 'print $^V')" = "v5.44.0"; \
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

# start.sh handles privilege separation: runs as root initially, then drops
# to 'gateway' user via gosu for the agent process. See start.sh.
ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]
CMD ["/bin/bash"]
