# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Relay image. Build context is the browser-vm/ project root (as wired in
# docker-compose.yml):
#
#   docker build -f deploy/relay.Dockerfile -t browser-vm-relay:<sha> .
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /relay

COPY relay/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY relay/relay.py .

EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=5s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8787/healthz',timeout=3).status==200 else 1)"

CMD ["python", "relay.py"]