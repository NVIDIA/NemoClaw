# NemoClaw sandbox image — OpenClaw + NemoClaw plugin inside OpenShell

FROM node:22-slim

ENV DEBIAN_FRONTEND=noninteractive

# ── System dependencies ───────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv \
        curl git ca-certificates \
        build-essential procps file \
        iproute2 \
    && rm -rf /var/lib/apt/lists/*

# ── Create sandbox user ───────────────────────────────────────────
RUN groupadd -r sandbox && useradd -r -g sandbox -d /sandbox -s /bin/bash sandbox \
    && mkdir -p /sandbox/.openclaw /sandbox/.nemoclaw \
    && chown -R sandbox:sandbox /sandbox

# ── Install OpenClaw CLI ──────────────────────────────────────────
RUN npm install -g openclaw@2026.3.11

# ── Install Python deps ───────────────────────────────────────────
RUN pip3 install --break-system-packages pyyaml

# ── Install Homebrew (NON-ROOT SUPPORT) ───────────────────────────
USER sandbox
ENV HOME=/sandbox

RUN mkdir -p /sandbox/.linuxbrew

RUN bash -c "\
git clone https://github.com/Homebrew/brew /sandbox/.linuxbrew/Homebrew && \
mkdir -p /sandbox/.linuxbrew/bin && \
ln -s /sandbox/.linuxbrew/Homebrew/bin/brew /sandbox/.linuxbrew/bin/brew \
"

# Add brew to PATH
ENV PATH="/sandbox/.linuxbrew/bin:/sandbox/.linuxbrew/Homebrew/bin:${PATH}"

# Initialize brew (no analytics, no root usage)
RUN brew update || true

# ── Copy NemoClaw plugin ──────────────────────────────────────────
USER root

COPY nemoclaw/dist/ /opt/nemoclaw/dist/
COPY nemoclaw/openclaw.plugin.json /opt/nemoclaw/
COPY nemoclaw/package.json /opt/nemoclaw/
COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/

WORKDIR /opt/nemoclaw
RUN npm install --omit=dev

# ── Blueprint setup ───────────────────────────────────────────────
RUN mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0 \
    && cp -r /opt/nemoclaw-blueprint/* /sandbox/.nemoclaw/blueprints/0.1.0/ \
    && chown -R sandbox:sandbox /sandbox/.nemoclaw

# ── Startup script ────────────────────────────────────────────────
COPY scripts/nemoclaw-start.sh /usr/local/bin/nemoclaw-start
RUN chmod +x /usr/local/bin/nemoclaw-start

# ── Switch to sandbox ─────────────────────────────────────────────
USER sandbox
WORKDIR /sandbox

# ── Pre-create directories ────────────────────────────────────────
RUN mkdir -p /sandbox/.openclaw/agents/main/agent \
    && chmod 700 /sandbox/.openclaw

# ── OpenClaw config ───────────────────────────────────────────────
RUN python3 -c "\
import json, os; \
config = { \
    'agents': {'defaults': {'model': {'primary': 'nvidia/nemotron-3-super-120b-a12b'}}}, \
    'models': {'mode': 'merge', 'providers': {'nvidia': { \
        'baseUrl': 'https://inference.local/v1', \
        'apiKey': 'openshell-managed', \
        'api': 'openai-completions', \
        'models': [{'id': 'nemotron-3-super-120b-a12b', 'name': 'NVIDIA Nemotron 3 Super 120B', 'reasoning': False, 'input': ['text'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'contextWindow': 131072, 'maxTokens': 4096}] \
    }}} \
}; \
path = os.path.expanduser('~/.openclaw/openclaw.json'); \
json.dump(config, open(path, 'w'), indent=2); \
os.chmod(path, 0o600)"

# ── Install plugin ────────────────────────────────────────────────
RUN openclaw doctor --fix > /dev/null 2>&1 || true \
    && openclaw plugins install /opt/nemoclaw > /dev/null 2>&1 || true

ENTRYPOINT ["/bin/bash"]
CMD []
