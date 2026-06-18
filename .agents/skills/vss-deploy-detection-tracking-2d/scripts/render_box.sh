#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# render_box.sh verifies fixed-width deployment receipt box formatting.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# render_box.sh — Print a perfectly-aligned 128-char-wide light-box.
#
# Reads body content from stdin (one line per row) and emits:
#   ┌──── <centered title> ────┐         (exactly 128 chars)
#   │ <body line padded to 124> │        (one per stdin line)
#   └────────...────────┘                (exactly 128 chars)
#
# Empty stdin lines render as empty box rows. Body lines longer than 124
# chars are truncated with `…` (the agent should have caught that earlier;
# the helper just refuses to break the right border).
#
# Usage:
#   render_box.sh --title "<title>" < body.txt
#   echo -e "row 1\nrow 2" | render_box.sh --title "Container"
#
# Why this exists: the agent has been miscounting dashes / spaces when
# rendering boxes by hand, leading to misaligned `┐` and `│` columns.
# Pipe content through this helper instead.

set -euo pipefail

W=128
TITLE=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --title)   TITLE="$2"; shift 2 ;;
        --width)   W="$2"; shift 2 ;;
        -h|--help) sed -n '18,35p' "$0"; exit 0 ;;   # skip SPDX/license header
        *)         echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

[[ -n "$TITLE" ]] || { echo "✖ --title is required" >&2; exit 1; }

# One python invocation handles everything (title centering, body
# padding/truncation, bottom border). Using `python3 -c` (not heredoc)
# leaves the script's stdin available for the body content.
exec python3 -c '
import sys

title = sys.argv[1]
W     = int(sys.argv[2])
inner = W - 2          # corner-to-corner inside, between ┌ and ┐
content_w = W - 4      # usable area inside `│ ` and ` │` margins

# Top — centered title.
titled = f" {title} "
pad = inner - len(titled)
L = pad // 2
R = pad - L
print("┌" + "─" * L + titled + "─" * R + "┐")

# Body — one row per stdin line, padded/truncated to exact width.
for raw in sys.stdin:
    line = raw.rstrip("\n")
    if len(line) > content_w:
        line = line[: content_w - 1] + "…"
    print("│ " + line + " " * (content_w - len(line)) + " │")

# Bottom.
print("└" + "─" * inner + "┘")
' "$TITLE" "$W"
