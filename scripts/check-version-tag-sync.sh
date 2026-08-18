#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

# The trusted build action on this PR's base still invokes this path. The check and its callers are
# retired by this PR; remove this compatibility shim after the updated action is on main.
printf '%s\n' "Version/tag sync check retired; compatibility path only."
