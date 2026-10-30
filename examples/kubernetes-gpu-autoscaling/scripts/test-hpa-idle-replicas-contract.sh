#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Local contract: idle latency HPA 1/0 is a ready baseline. Leftover load
# (current/desired above 1) is not.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"

hpa_common_replicas_at_want 1 1 1
hpa_common_replicas_at_want 1 0 1
hpa_common_replicas_at_want 1 "" 1
if hpa_common_replicas_at_want 1 2 1; then
  echo "ERROR: leftover 1/2 must not look like idle 1" >&2
  exit 1
fi
if hpa_common_replicas_at_want 5 6 1; then
  echo "ERROR: leftover 5/6 must not look like idle 1" >&2
  exit 1
fi
if hpa_common_replicas_at_want 5 1 1; then
  echo "ERROR: leftover 5/1 must not look like idle 1" >&2
  exit 1
fi
hpa_common_replicas_at_want 8 8 8
if hpa_common_replicas_at_want 8 0 8; then
  echo "ERROR: 8/0 must not look like 8 GPUs" >&2
  exit 1
fi

ready="$(hpa_common_replicas_ready_message ns hpa 1 0)"
[[ "${ready}" == *"desired 0 until the latency metric exists"* ]]
ready="$(hpa_common_replicas_ready_message ns hpa 1 1)"
[[ "${ready}" == *"1 current / 1 desired"* ]]

echo "OK: idle HPA 1/0 is a ready baseline; leftover 5/6 is not"

# Helm 3 must not receive --force-conflicts. The version check has to succeed
# before a caller deletes the HPA.
fake_bin="$(mktemp -d)"
trap 'rm -rf "${fake_bin}"' EXIT
cat >"${fake_bin}/helm" <<'EOF'
#!/bin/sh
printf '%s\n' "${FAKE_HELM_VERSION}"
EOF
chmod +x "${fake_bin}/helm"
PATH="${fake_bin}:${PATH}"

helm3_args=()
FAKE_HELM_VERSION=v3.19.0 hpa_common_append_helm_force_conflicts helm3_args
[[ "${#helm3_args[@]}" -eq 0 ]]

helm4_args=(upgrade)
FAKE_HELM_VERSION=v4.3.0 hpa_common_append_helm_force_conflicts helm4_args
[[ "${helm4_args[0]}" == "upgrade" && "${helm4_args[1]}" == "--force-conflicts" ]]

unreadable_args=(upgrade)
if FAKE_HELM_VERSION=not-a-version hpa_common_append_helm_force_conflicts unreadable_args; then
  echo "ERROR: unreadable helm version must fail before the caller changes the cluster" >&2
  exit 1
fi
[[ "${#unreadable_args[@]}" -eq 1 && "${unreadable_args[0]}" == "upgrade" ]]

echo "OK: Helm 3 omits --force-conflicts; Helm 4 adds it; an unreadable version changes nothing"
