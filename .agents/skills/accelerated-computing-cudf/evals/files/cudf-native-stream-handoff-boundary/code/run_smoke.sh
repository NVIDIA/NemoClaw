#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
tmp_dir="$(mktemp -d "${TMPDIR:-/var/tmp}/threaded-handoff.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

nvcc -std=c++17 -O2 "$script_dir/threaded_handoff.cu" -o "$tmp_dir/threaded_handoff"
"$tmp_dir/threaded_handoff"
