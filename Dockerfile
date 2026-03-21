# NemoClaw sandbox image — OpenClaw + NemoClaw plugin inside OpenShell

# Stage 1: Build TypeScript plugin from source
FROM node:22-slim AS builder
COPY nemoclaw/package.json nemoclaw/tsconfig.json /opt/nemoclaw/
COPY nemoclaw/src/ /opt/nemoclaw/src/
WORKDIR /opt/nemoclaw
RUN npm install && npm run build

# Stage 2: Runtime image
FROM node:22-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv \
        curl git ca-certificates \
        iproute2 \
    && rm -rf /var/lib/apt/lists/*

# Create sandbox user (matches OpenShell convention)
RUN groupadd -r sandbox && useradd -r -g sandbox -d /sandbox -s /bin/bash sandbox \
    && mkdir -p /sandbox/.nemoclaw \
    && chown -R sandbox:sandbox /sandbox

# Split .openclaw into immutable config dir + writable state dir.
# The policy makes /sandbox/.openclaw read-only via Landlock, so the agent
# cannot modify openclaw.json, auth tokens, or CORS settings.  Writable
# state (agents, plugins, etc.) lives in .openclaw-data, reached via symlinks.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/514
RUN mkdir -p /sandbox/.openclaw-data/agents/main/agent \
        /sandbox/.openclaw-data/extensions \
        /sandbox/.openclaw-data/workspace \
        /sandbox/.openclaw-data/skills \
        /sandbox/.openclaw-data/hooks \
        /sandbox/.openclaw-data/identity \
        /sandbox/.openclaw-data/devices \
        /sandbox/.openclaw-data/canvas \
        /sandbox/.openclaw-data/cron \
    && mkdir -p /sandbox/.openclaw \
    && ln -s /sandbox/.openclaw-data/agents /sandbox/.openclaw/agents \
    && ln -s /sandbox/.openclaw-data/extensions /sandbox/.openclaw/extensions \
    && ln -s /sandbox/.openclaw-data/workspace /sandbox/.openclaw/workspace \
    && ln -s /sandbox/.openclaw-data/skills /sandbox/.openclaw/skills \
    && ln -s /sandbox/.openclaw-data/hooks /sandbox/.openclaw/hooks \
    && ln -s /sandbox/.openclaw-data/identity /sandbox/.openclaw/identity \
    && ln -s /sandbox/.openclaw-data/devices /sandbox/.openclaw/devices \
    && ln -s /sandbox/.openclaw-data/canvas /sandbox/.openclaw/canvas \
    && ln -s /sandbox/.openclaw-data/cron /sandbox/.openclaw/cron \
    && touch /sandbox/.openclaw-data/update-check.json \
    && ln -s /sandbox/.openclaw-data/update-check.json /sandbox/.openclaw/update-check.json \
    && chown -R sandbox:sandbox /sandbox/.openclaw /sandbox/.openclaw-data

# Install OpenClaw CLI
RUN npm install -g openclaw@2026.3.11

# Install PyYAML for blueprint runner
RUN pip3 install --break-system-packages pyyaml

# Copy built plugin and blueprint into the sandbox
COPY --from=builder /opt/nemoclaw/dist/ /opt/nemoclaw/dist/
COPY nemoclaw/openclaw.plugin.json /opt/nemoclaw/
COPY nemoclaw/package.json /opt/nemoclaw/
COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/

# Install runtime dependencies only (no devDependencies, no build step)
WORKDIR /opt/nemoclaw
RUN npm install --omit=dev

# Set up blueprint for local resolution
RUN mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0 \
    && cp -r /opt/nemoclaw-blueprint/* /sandbox/.nemoclaw/blueprints/0.1.0/

# Copy startup script
COPY scripts/nemoclaw-start.sh /usr/local/bin/nemoclaw-start
RUN chmod +x /usr/local/bin/nemoclaw-start

# Build args for config that varies per deployment.
# nemoclaw onboard passes these at image build time.
ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b
ARG CHAT_UI_URL=http://127.0.0.1:18789
# Unique per build to ensure each image gets a fresh auth token.
# Pass --build-arg NEMOCLAW_BUILD_ID=$(date +%s) to bust the cache.
ARG NEMOCLAW_BUILD_ID=default

WORKDIR /sandbox
USER sandbox

# Write the COMPLETE openclaw.json including gateway config and auth token.
# This file is immutable at runtime (Landlock read-only on /sandbox/.openclaw).
# No runtime writes to openclaw.json are needed or possible.
# Build args (NEMOCLAW_MODEL, CHAT_UI_URL) customize per deployment.
# Auth token is generated per build so each image has a unique token.
RUN python3 -c "\
import json, os, secrets; \
from urllib.parse import urlparse; \
model = '${NEMOCLAW_MODEL}'; \
chat_ui_url = '${CHAT_UI_URL}'; \
parsed = urlparse(chat_ui_url); \
chat_origin = f'{parsed.scheme}://{parsed.netloc}' if parsed.scheme and parsed.netloc else 'http://127.0.0.1:18789'; \
origins = ['http://127.0.0.1:18789']; \
origins = list(dict.fromkeys(origins + [chat_origin])); \
config = { \
    'agents': {'defaults': {'model': {'primary': f'inference/{model}'}}}, \
    'models': {'mode': 'merge', 'providers': { \
        'nvidia': { \
            'baseUrl': 'https://inference.local/v1', \
            'apiKey': 'openshell-managed', \
            'api': 'openai-completions', \
            'models': [{'id': model.split('/')[-1], 'name': model, 'reasoning': False, 'input': ['text'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'contextWindow': 131072, 'maxTokens': 4096}] \
        }, \
        'inference': { \
            'baseUrl': 'https://inference.local/v1', \
            'apiKey': 'unused', \
            'api': 'openai-completions', \
            'models': [{'id': model, 'name': model, 'reasoning': False, 'input': ['text'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'contextWindow': 131072, 'maxTokens': 4096}] \
        } \
    }}, \
    'channels': {'defaults': {'configWrites': False}}, \
    'gateway': { \
        'mode': 'local', \
        'controlUi': { \
            'allowInsecureAuth': True, \
            'dangerouslyDisableDeviceAuth': True, \
            'allowedOrigins': origins, \
        }, \
        'trustedProxies': ['127.0.0.1', '::1'], \
        'auth': {'token': secrets.token_hex(32)} \
    } \
}; \
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
USER root
RUN chown root:root /sandbox/.openclaw \
    && find /sandbox/.openclaw -mindepth 1 -maxdepth 1 -exec chown -h root:root {} + \
    && chmod 1777 /sandbox/.openclaw \
    && chmod 444 /sandbox/.openclaw/openclaw.json
USER sandbox

ENTRYPOINT ["/bin/bash"]
CMD []
