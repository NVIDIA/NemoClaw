# Lightweight test sandbox for NemoClaw E2E testing
# Simulates the OpenClaw-in-OpenShell environment without requiring
# the full NVIDIA base image or openshell CLI

FROM node:22-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv \
        curl git ca-certificates \
        iproute2 \
    && rm -rf /var/lib/apt/lists/*

# Create sandbox user (matches OpenShell convention)
RUN groupadd -r sandbox && useradd -r -g sandbox -d /sandbox -s /bin/bash sandbox \
    && mkdir -p /sandbox/.openclaw /sandbox/.nemoclaw \
    && chown -R sandbox:sandbox /sandbox

# Install OpenClaw CLI
RUN npm install -g openclaw@2026.3.11

# Install PyYAML for blueprint runner
RUN pip3 install --break-system-packages pyyaml

# Copy our plugin and blueprint into the sandbox
COPY nemoclaw/ /opt/nemoclaw/
COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/

# Build the TS plugin inside the container
WORKDIR /opt/nemoclaw
RUN npm install && rm -rf dist && npx tsc

# Patch OpenClaw's nvidia provider to replace Meta Llama 3.3 70B with
# Nemotron 3 Super 120B. OpenClaw's embedded agent has a hardcoded model
# catalog that doesn't include Nemotron 3 Super yet. This replaces the
# one Meta/Llama model with NVIDIA's latest until OpenClaw ships an update.
RUN find /usr/local/lib/node_modules/openclaw/dist -name "*.js" \
      -exec grep -l "meta/llama-3.3-70b-instruct" {} \; \
    | xargs -I{} sed -i \
        -e 's|meta/llama-3.3-70b-instruct|nvidia/nemotron-3-super-120b-a12b|g' \
        -e 's|Meta Llama 3.3 70B Instruct|Nemotron 3 Super 120B|g' \
        {}
# Nemotron 3 Super supports reasoning; flip the flag and bump maxTokens
RUN find /usr/local/lib/node_modules/openclaw/dist -name "*.js" \
      -exec grep -l "nemotron-3-super-120b-a12b" {} \; \
    | xargs -I{} python3 -c "import re,sys;\
s=open('{}').read();\
s=re.sub(r'(id:\\s*\"nvidia/nemotron-3-super-120b-a12b.*?reasoning:\\s*)false',r'\\1true',s,flags=re.DOTALL);\
s=re.sub(r'(id:\\s*\"nvidia/nemotron-3-super-120b-a12b.*?maxTokens:\\s*)4096',r'\\g<1>8192',s,flags=re.DOTALL);\
open('{}','w').write(s)"

# Set up blueprint for local resolution
RUN mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0 \
    && cp -r /opt/nemoclaw-blueprint/* /sandbox/.nemoclaw/blueprints/0.1.0/

# Copy startup script
COPY scripts/nemoclaw-start.sh /usr/local/bin/nemoclaw-start
RUN chmod +x /usr/local/bin/nemoclaw-start

WORKDIR /sandbox
USER sandbox

# Pre-create OpenClaw directories
RUN mkdir -p /sandbox/.openclaw/agents/main/agent \
    && chmod 700 /sandbox/.openclaw

ENTRYPOINT ["nemoclaw-start"]
CMD []
