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
COPY nemoclaw/package.json nemoclaw/tsconfig.json /opt/nemoclaw/
COPY nemoclaw/src/ /opt/nemoclaw/src/
WORKDIR /opt/nemoclaw
RUN npm install && npm run build

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

# Set up blueprint for local resolution
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
ARG CHAT_UI_URL=http://127.0.0.1:18789
ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1
ARG NEMOCLAW_INFERENCE_API=openai-completions
ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=
ARG NEMOCLAW_WEB_CONFIG_B64=e30=
# Set to "1" to disable device-pairing auth (development/headless only).
# Default: "0" (device auth enabled — secure by default).
ARG NEMOCLAW_DISABLE_DEVICE_AUTH=0
# Unique per build to ensure each image gets a fresh auth token.
# Pass --build-arg NEMOCLAW_BUILD_ID=$(date +%s) to bust the cache.
ARG NEMOCLAW_BUILD_ID=default

# SECURITY: Promote build-args to env vars so the Python script reads them
# via os.environ, never via string interpolation into Python source code.
# Direct ARG interpolation into python3 -c is a code injection vector (C-2).
ENV NEMOCLAW_MODEL=${NEMOCLAW_MODEL} \
    NEMOCLAW_PROVIDER_KEY=${NEMOCLAW_PROVIDER_KEY} \
    NEMOCLAW_PRIMARY_MODEL_REF=${NEMOCLAW_PRIMARY_MODEL_REF} \
    CHAT_UI_URL=${CHAT_UI_URL} \
    NEMOCLAW_INFERENCE_BASE_URL=${NEMOCLAW_INFERENCE_BASE_URL} \
    NEMOCLAW_INFERENCE_API=${NEMOCLAW_INFERENCE_API} \
    NEMOCLAW_INFERENCE_COMPAT_B64=${NEMOCLAW_INFERENCE_COMPAT_B64} \
    NEMOCLAW_WEB_CONFIG_B64=${NEMOCLAW_WEB_CONFIG_B64} \
    NEMOCLAW_DISABLE_DEVICE_AUTH=${NEMOCLAW_DISABLE_DEVICE_AUTH}

WORKDIR /sandbox
USER sandbox

# Write the COMPLETE openclaw.json including gateway config and auth token.
# This file is immutable at runtime (Landlock read-only on /sandbox/.openclaw).
# No runtime writes to openclaw.json are needed or possible.
# Build args (NEMOCLAW_MODEL, CHAT_UI_URL) customize per deployment.
# Auth token is generated per build so each image has a unique token.
RUN python3 -c "\
import base64, json, os, secrets; \
from urllib.parse import urlparse; \
model = os.environ['NEMOCLAW_MODEL']; \
chat_ui_url = os.environ['CHAT_UI_URL']; \
provider_key = os.environ['NEMOCLAW_PROVIDER_KEY']; \
primary_model_ref = os.environ['NEMOCLAW_PRIMARY_MODEL_REF']; \
inference_base_url = os.environ['NEMOCLAW_INFERENCE_BASE_URL']; \
inference_api = os.environ['NEMOCLAW_INFERENCE_API']; \
inference_compat = json.loads(base64.b64decode(os.environ['NEMOCLAW_INFERENCE_COMPAT_B64']).decode('utf-8')); \
web_config = json.loads(base64.b64decode(os.environ.get('NEMOCLAW_WEB_CONFIG_B64', 'e30=') or 'e30=').decode('utf-8')); \
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
        'models': [{**({'compat': inference_compat} if inference_compat else {}), 'id': model, 'name': primary_model_ref, 'reasoning': False, 'input': ['text'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'contextWindow': 131072, 'maxTokens': 4096}] \
    } \
}; \
config = { \
    'agents': {'defaults': {'model': {'primary': primary_model_ref}}}, \
    'models': {'mode': 'merge', 'providers': providers}, \
    'channels': {'defaults': {'configWrites': False}}, \
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
                **({'apiKey': web_config.get('apiKey', '')} if web_config.get('apiKey', '') else {}) \
            }, \
            'fetch': { \
                'enabled': bool(web_config.get('fetchEnabled', True)) \
            } \
        } \
    } \
} if web_config.get('provider') == 'brave' else {}); \
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
RUN chown root:root /sandbox/.openclaw \
    && find /sandbox/.openclaw -mindepth 1 -maxdepth 1 -exec chown -h root:root {} + \
    && chmod 755 /sandbox/.openclaw \
    && chmod 444 /sandbox/.openclaw/openclaw.json

# Pin config hash at build time so the entrypoint can verify integrity.
# Prevents the agent from creating a copy with a tampered config and
# restarting the gateway pointing at it.
RUN sha256sum /sandbox/.openclaw/openclaw.json > /sandbox/.openclaw/.config-hash \
    && chmod 444 /sandbox/.openclaw/.config-hash \
    && chown root:root /sandbox/.openclaw/.config-hash

# Entrypoint runs as root to start the gateway as the gateway user,
# then drops to sandbox for agent commands. See nemoclaw-start.sh.
ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]
CMD ["/bin/bash"]
