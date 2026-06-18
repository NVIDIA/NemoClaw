FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

# Lightweight Earth2Studio dev sandbox for Harbor skill evals (Python 3.13 + uv).
RUN apt-get -o Acquire::Retries=3 update && \
    apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    git \
    jq \
    make \
    ripgrep

ENV UV_LINK_MODE=copy
ENV UV_PYTHON=3.13
# NV-ACES default repo location
ENV EARTH2STUDIO_ROOT=/workspace/repo

RUN mkdir -p /workspace/skills /workspace/input /workspace/output \
    /logs/verifier /logs/agent

WORKDIR /workspace/repo

COPY setup/bootstrap.sh /usr/local/bin/e2s-eval-bootstrap
RUN chmod +x /usr/local/bin/e2s-eval-bootstrap
