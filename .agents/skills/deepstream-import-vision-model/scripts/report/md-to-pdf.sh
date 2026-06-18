#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Convert GitHub-Flavored Markdown (with optional Mermaid diagrams) to PDF with
# correct wrapping: listings for code, Lua filter for tables/inline paths, LaTeX header.
#
# Usage:
#   ./md-to-pdf.sh <source.md> [output.pdf]
# If output.pdf is omitted, writes <source>.pdf next to the source file.
#
# Requires: mmdc (Mermaid CLI), pandoc, pdflatex, packages: listings, xcolor, ragged2e.
#
# Do NOT replace this with plain "pandoc --highlight-style=..." — highlighted Verbatim
# boxes do not wrap long lines; --listings + latex-pdf-wrap.tex + pandoc-wrap-tables.lua are required.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

SRC_INPUT="${1:?Usage: $0 <markdown.md> [output.pdf]}"
if [[ "$SRC_INPUT" != /* ]]; then
  SRC="$(cd "$(dirname "$SRC_INPUT")" && pwd)/$(basename "$SRC_INPUT")"
else
  SRC="$SRC_INPUT"
fi
[[ -f "$SRC" ]] || { echo "error: file not found: $SRC" >&2; exit 1; }

SRC_DIR="$(dirname "$SRC")"

if [[ -n "${2-}" ]]; then
  OUT="$2"
  if [[ "$OUT" != /* ]]; then
    OUT="$(pwd)/$OUT"
  fi
else
  OUT="${SRC%.md}.pdf"
fi

STEM="$(basename "$SRC" .md)"
INTERMEDIATE="${SRC_DIR}/${STEM}._pdf.md"
IMG_DIR="${SRC_DIR}/mermaid_pdf/${STEM}"

python3 "$SCRIPT_DIR/render-mermaid-for-pdf.py" \
  --img-dir "$IMG_DIR" \
  "$SRC" \
  "$INTERMEDIATE"

pandoc "$INTERMEDIATE" \
  --from=gfm \
  --lua-filter="$SCRIPT_DIR/pandoc-wrap-tables.lua" \
  --include-in-header="$SCRIPT_DIR/latex-pdf-wrap.tex" \
  --pdf-engine=pdflatex \
  -V geometry:margin=1in \
  --listings \
  --resource-path="$SRC_DIR:$SCRIPT_DIR" \
  -o "$OUT"

echo "Wrote $OUT"
