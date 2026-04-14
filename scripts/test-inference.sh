#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Test inference.local routing through OpenShell provider
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT
echo '{"model":"nvidia/nemotron-3-super-120b-a12b","messages":[{"role":"user","content":"say hello"}]}' >"$TMPFILE"
curl -s https://inference.local/v1/chat/completions -H "Content-Type: application/json" -d @"$TMPFILE"
