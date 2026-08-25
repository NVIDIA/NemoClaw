# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

ARG BASE_IMAGE
FROM ${BASE_IMAGE}

COPY --chown=root:root --chmod=0444 nemoclaw-services.toml /app/config/nemoclaw-services.toml
RUN python3 - <<'PY'
from pathlib import Path
import os
import tomllib

config = Path(os.environ.get("NEMOCLAW_CUA_CONFIG_PATH", "/app/config/config.toml"))
services = Path(os.environ.get("NEMOCLAW_CUA_SERVICES_PATH", "/app/config/nemoclaw-services.toml"))
if not config.is_file() or config.is_symlink() or not services.is_file() or services.is_symlink():
    raise SystemExit("NemoCUA prepared image and projected service config must be regular files")
config_bytes = config.read_bytes()
service_bytes = services.read_bytes()
prepared = tomllib.loads(config_bytes.decode("utf-8"))
projected = tomllib.loads(service_bytes.decode("utf-8"))
if "tool_servers" in prepared or set(projected) != {"tool_servers"}:
    raise SystemExit("NemoCUA prepared config must not define the projected tool_servers table")
config.write_bytes(config_bytes.rstrip() + b"\n\n" + service_bytes)
config.chmod(0o444)
services.unlink()
PY
