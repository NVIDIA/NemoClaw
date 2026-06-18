#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# synthesize_docker_run.sh reconstructs docker run flags from a container.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# synthesize_docker_run.sh — Reconstruct the full `docker run …` command
# for an existing container, so deploy logs and Step 3 boxes can show
# the actual flags in effect (volume mounts, --gpus, --network, env)
# instead of a truncated `docker start <name>`.
#
# Reads `docker inspect <container>` and reassembles the equivalent
# `docker run` command line — multi-line, backslash-continuation,
# easy for a human to copy or diff between deploys.
#
# Usage:
#   synthesize_docker_run.sh <container-name>
#
# Output (stdout): one multi-line `docker run …` command.
# Exit codes:
#   0  success
#   1  invalid args
#   2  docker / container not found

set -euo pipefail

CONTAINER="${1:-}"
case "$CONTAINER" in
    -h|--help|help)
        sed -n '18,28p' "$0"
        exit 0
        ;;
esac

[[ -n "$CONTAINER" ]] || { echo "Usage: $0 <container-name>" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "✖ docker not found in PATH" >&2; exit 2; }
docker inspect "$CONTAINER" >/dev/null 2>&1 \
    || { echo "✖ container not found: $CONTAINER" >&2; exit 2; }

exec python3 - "$CONTAINER" <<'PY'
import json, re, shlex, subprocess, sys

name = sys.argv[1]
raw  = subprocess.check_output(["docker", "inspect", name], text=True)
info = json.loads(raw)[0]

cfg     = info.get("Config", {})
host    = info.get("HostConfig", {})
nets    = info.get("NetworkSettings", {}).get("Networks", {}) or {}
mounts  = info.get("Mounts", []) or []
labels  = cfg.get("Labels") or {}
env     = cfg.get("Env") or []
image   = cfg.get("Image", "<image>")
cmd     = cfg.get("Cmd") or []
entry   = cfg.get("Entrypoint") or []
work    = cfg.get("WorkingDir") or ""
user    = cfg.get("User") or ""
hostname = cfg.get("Hostname") or ""

# Subtract image-baked env so we only show user-supplied -e flags. If
# the image isn't pullable / inspectable, fall back to a curated allow-
# list of vars that are nearly always user-supplied for this skill.
def get_image_env(image_ref):
    try:
        out = subprocess.check_output(["docker", "image", "inspect", image_ref], text=True)
        d = json.loads(out)[0]
        return set((d.get("Config") or {}).get("Env") or [])
    except Exception:
        return set()

image_env = get_image_env(image)
user_supplied_keys = {"DISPLAY", "XAUTHORITY", "NGC_API_KEY", "REST_API_PORT",
                      "FORCE_ENGINE_REBUILD", "GST_DEBUG", "LD_PRELOAD",
                      "RTVI_CV_IMAGE", "STREAM_ADD_DELAY", "MODEL_SOURCE",
                      "VIDEOS_SOURCE", "MODEL_REF", "VIDEOS_REF"}

# Secrets that must be redacted before the synthesized command is
# written to the deploy log or shown to the user. The deploy log is
# kept on disk under ~/rtvicv-storage/logs/ and may be attached to
# bug reports / shared on tickets, so any token-like value MUST be
# masked. Match by exact key OR by case-insensitive substring of
# common credential terms so future env vars added to the allowlist
# don't accidentally bypass the mask.
SECRET_KEYS = {"NGC_API_KEY", "NGC_CLI_API_KEY",
               "DOCKER_PASSWORD", "AUTHORIZATION",
               "AWS_SECRET_ACCESS_KEY", "GITLAB_TOKEN"}
# Underscore-boundary match so `XAUTHORITY` (X11 auth file path,
# not a secret) doesn't get redacted just because it contains the
# substring `auth`. Match `_<hint>_` / `^<hint>_` / `_<hint>$`.
SECRET_HINT_RE = re.compile(
    r"(?:^|_)(password|secret|token|api_?key|auth|credential)(?:_|$)",
    re.IGNORECASE,
)

def is_secret(key):
    if key in SECRET_KEYS:
        return True
    return bool(SECRET_HINT_RE.search(key))

def is_user_supplied(kv):
    if kv in image_env:
        return False
    k = kv.split("=", 1)[0]
    # If we couldn't read image_env, fall back to allowlist.
    if not image_env and k not in user_supplied_keys:
        return False
    return True

lines = ["docker run -d --name " + name]

# Network: --network=host or default bridge / custom.
net_mode = host.get("NetworkMode", "default")
if net_mode and net_mode not in ("default", "bridge"):
    lines.append(f"  --network={net_mode}")

# GPU passthrough.
dev_reqs = host.get("DeviceRequests") or []
for dr in dev_reqs:
    caps = dr.get("Capabilities") or []
    has_gpu = any("gpu" in (cap_set or []) for cap_set in caps)
    if not has_gpu:
        continue
    count = dr.get("Count", 0)
    ids   = dr.get("DeviceIDs") or []
    if count == -1 or (not ids and count == 0):
        lines.append("  --gpus all")
    elif ids:
        lines.append(f"  --gpus 'device={','.join(ids)}'")
    else:
        lines.append(f"  --gpus {count}")

# Runtime (Jetson uses --runtime nvidia). Both `nvidia` and
# `nvidia-container-runtime` map to `--runtime=nvidia` at the
# docker-run CLI level — older docker installs report the latter from
# `docker inspect`, but the CLI flag is always `nvidia`.
runtime = host.get("Runtime", "")
if runtime in ("nvidia", "nvidia-container-runtime"):
    lines.append("  --runtime=nvidia")
elif runtime and runtime != "runc":
    lines.append(f"  --runtime={runtime}")

# Privileged / IPC / shm.
if host.get("Privileged"):
    lines.append("  --privileged")
ipc = host.get("IpcMode", "")
if ipc and ipc not in ("private", "shareable"):
    lines.append(f"  --ipc={ipc}")
shm = host.get("ShmSize", 0)
if shm and shm != 67108864:  # 64 MiB default
    lines.append(f"  --shm-size={shm}")

# Restart policy.
rp = (host.get("RestartPolicy") or {}).get("Name", "")
if rp and rp != "no":
    lines.append(f"  --restart={rp}")

# Env vars — only those NOT inherited from the image (user-supplied
# via -e at docker run time). Secrets (NGC_API_KEY, *PASSWORD*, *TOKEN*,
# etc.) are masked with `***REDACTED***` so the synthesized command can
# safely land in the on-disk deploy log without leaking credentials.
for kv in env:
    if not is_user_supplied(kv):
        continue
    if "=" in kv:
        k, _, v = kv.partition("=")
        if is_secret(k):
            v = "***REDACTED***"
        elif any(c in v for c in ' \t"\'$`\\&|;<>()'):
            v = '"' + v.replace('"', '\\"') + '"'
        lines.append(f"  -e {k}={v}")
    else:
        lines.append(f"  -e {kv}")

# Volume mounts (bind / volume). shlex.quote keeps the output copy-paste
# correct when host or container paths contain spaces or shell metacharacters
# (returns the input unchanged when no quoting is needed).
for m in mounts:
    src  = m.get("Source", "")
    dst  = m.get("Destination", "")
    rw   = "" if m.get("RW", True) else ":ro"
    if src and dst:
        lines.append(f"  -v {shlex.quote(f'{src}:{dst}{rw}')}")

# Hostname / user / workdir overrides.
if hostname and not hostname.startswith(name[:8]):
    lines.append(f"  --hostname={hostname}")
if user:
    lines.append(f"  -u {user}")
if work:
    lines.append(f"  -w {work}")

# Image (always last among options).
lines.append(f"  {image}")

# Optional command + entrypoint at the very end.
if entry:
    # Image-baked entrypoint is implicit; only show explicit override.
    pass
if cmd:
    quoted = " ".join(c if " " not in c else f'"{c}"' for c in cmd)
    lines.append(f"  {quoted}")

print(" \\\n".join(lines))
PY
