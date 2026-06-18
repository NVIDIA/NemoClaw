#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

want="Standard_D16ds_v5"
failures=0

check_file() {
  local file="$1"
  local pattern="$2"
  if ! grep -q "$pattern" "$file"; then
    echo "$file: expected $want system node size" >&2
    failures=$((failures + 1))
  fi
}

check_file "$SCRIPT_DIR/variables.tf" "default[[:space:]]*=[[:space:]]*\"$want\""
check_file "$SCRIPT_DIR/terraform.tfvars.example" "system_vm_size[[:space:]]*=[[:space:]]*\"$want\""
check_file "$SKILL_DIR/terraform/variables.tf" "default[[:space:]]*=[[:space:]]*\"$want\""
check_file "$SKILL_DIR/terraform/terraform.tfvars.example" "system_node_pool_vm_size[[:space:]]*=[[:space:]]*\"$want\""

exit "$failures"
