#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Preflight check for the OSMO POD_TEMPLATE: every DIG workflow assumes
# the nvoptix denoiser binary is hostPath-mounted and /dev/shm is >= 16 GiB.
# Without those, Kit OptiX silently degrades to noisy raw path tracing and
# torchrun / IsaacSim ray-tracer buffers OOM on dshm.
#
# This script codifies the jq one-liner that previously lived in prose at
# references/preconditions.md §2 so callers (agent or human) get a
# deterministic exit code instead of having to parse the one-liner output.
#
# Usage:
#   preflight_pod_template.sh [--min-dshm-gib N]
#
# --min-dshm-gib defaults to 16. Pass 32 if your workflow needs the
# preferred size (Kit ray-tracer buffers + torchrun shared-memory).
#
# Exit codes:
#   0  template OK -- nvoptix mount present, dshm >= min
#   1  template visible but malformed (missing mount or undersized dshm)
#   2  HTTP 403 -- user lacks read permission on POD_TEMPLATE
#   3  HTTP 409 -- ConfigMap-mode deployment, CLI disabled
#   4  prerequisite missing (osmo, jq) or unexpected failure
#
# Callers (agent / preconditions.md §2) interpret the exit code:
#   0 -> save "pod template verified" to memory; proceed
#   1 -> route to physical-ai-infrastructure-setup-and-resilient-scaling
#        for the patch runbook (admin-or-equivalent assumed)
#   2 -> ask user (AskUserQuestion) whether admin already configured it;
#        on "yes" save "user-confirmed", on "no/unsure" stop
#   3 -> warn, save "skipped-409", proceed; runtime in-pod preflight
#        is the safety net
#   4 -> fix the environment and re-run

set -euo pipefail

MIN_DSHM_GIB=16
while [[ $# -gt 0 ]]; do
  case "$1" in
    --min-dshm-gib) MIN_DSHM_GIB="$2"; shift 2 ;;
    -h|--help) sed -n '3,36p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 4 ;;
  esac
done

command -v osmo >/dev/null || { echo "ERROR: osmo CLI not on PATH." >&2; exit 4; }
command -v jq   >/dev/null || { echo "ERROR: jq not installed."     >&2; exit 4; }

tmp_stdout=$(mktemp); tmp_stderr=$(mktemp)
trap 'rm -f "$tmp_stdout" "$tmp_stderr"' EXIT
if ! osmo config show POD_TEMPLATE >"$tmp_stdout" 2>"$tmp_stderr"; then
  if   grep -qE '(^|[^0-9])403([^0-9]|$)' "$tmp_stderr"; then
    echo "POD_TEMPLATE: HTTP 403 -- your account lacks read permission." >&2
    echo "  Either ask your OSMO admin to confirm the template meets DIG" >&2
    echo "  requirements, or request read access via 'osmo profile list'." >&2
    exit 2
  elif grep -qE '(^|[^0-9])409([^0-9]|$)' "$tmp_stderr"; then
    echo "POD_TEMPLATE: HTTP 409 -- config CLI disabled (ConfigMap mode)." >&2
    echo "  Runtime in-pod preflight is the only remaining safety net." >&2
    exit 3
  else
    echo "ERROR: 'osmo config show POD_TEMPLATE' failed unexpectedly:" >&2
    cat "$tmp_stderr" >&2
    exit 4
  fi
fi

nvoptix_path=$(jq -r '.default_user.spec.volumes[]? | select(.name=="nvoptix") | .hostPath.path // empty' "$tmp_stdout")
dshm_size=$(jq -r '.default_user.spec.volumes[]? | select(.name=="dshm") | .emptyDir.sizeLimit // empty' "$tmp_stdout")

bad=0
if [[ "$nvoptix_path" != "/usr/share/nvidia/nvoptix.bin" ]]; then
  echo "POD_TEMPLATE: nvoptix hostPath mount missing or wrong path." >&2
  echo "  Got: '${nvoptix_path:-<none>}'  Want: /usr/share/nvidia/nvoptix.bin" >&2
  bad=1
fi
if [[ -z "$dshm_size" ]]; then
  echo "POD_TEMPLATE: dshm emptyDir volume missing." >&2
  bad=1
else
  dshm_gib=${dshm_size%Gi}
  if ! [[ "$dshm_gib" =~ ^[0-9]+$ ]] || (( dshm_gib < MIN_DSHM_GIB )); then
    echo "POD_TEMPLATE: dshm sizeLimit is '${dshm_size}', need >= ${MIN_DSHM_GIB}Gi." >&2
    bad=1
  fi
fi

if (( bad == 1 )); then
  echo >&2
  echo "Patch via the physical-ai-infrastructure-setup-and-resilient-scaling" >&2
  echo "skill ('osmo config update POD_TEMPLATE')." >&2
  exit 1
fi

echo "POD_TEMPLATE OK: nvoptix mount + /dev/shm >= ${MIN_DSHM_GIB}Gi."
exit 0
