#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Initialise the LLM Wiki directory structure inside a NemoClaw sandbox.
# Designed to run once (idempotent — safe to re-run without data loss).
#
# Usage:
#   wiki-init.sh                     # Uses default paths
#   wiki-init.sh /custom/data/root   # Custom data root
#
# Typically invoked via:
#   openshell sandbox connect <name>
#   bash /path/to/wiki-init.sh

set -euo pipefail

DATA_ROOT="${1:-/sandbox/.openclaw-data}"
WIKI_DIR="${DATA_ROOT}/wiki"
RAW_DIR="${DATA_ROOT}/wiki-raw"
WORKSPACE="${2:-/sandbox/.openclaw/workspace}"

GREEN='\033[0;32m'
NC='\033[0m'
info() { echo -e "${GREEN}[wiki-init]${NC} $1"; }

# ── Create directory tree ────────────────────────────────────────
for dir in \
  "${WIKI_DIR}/entities" \
  "${WIKI_DIR}/concepts" \
  "${WIKI_DIR}/sources" \
  "${WIKI_DIR}/analyses" \
  "${RAW_DIR}/conversations" \
  "${RAW_DIR}/documents" \
  "${RAW_DIR}/web" \
  "${RAW_DIR}/observations" \
  "${RAW_DIR}/artifacts"; do
  mkdir -p "$dir"
done

# ── Seed index.md (only if missing) ─────────────────────────────
if [ ! -f "${WIKI_DIR}/index.md" ]; then
  cat >"${WIKI_DIR}/index.md" <<'EOF'
---
title: Wiki Index
category: index
created: INIT_DATE
updated: INIT_DATE
---

# Wiki Index

Content catalog for the knowledge base. Each entry links to a wiki page
with a one-line summary.

## Entities

<!-- [entity-name](entities/entity-name.md) — One-line summary. -->

## Concepts

<!-- [concept-name](concepts/concept-name.md) — One-line summary. -->

## Sources

<!-- [source-name](sources/source-name.md) — One-line summary. -->

## Analyses

<!-- [analysis-name](analyses/analysis-name.md) — One-line summary. -->
EOF
  sed -i "s/INIT_DATE/$(date +%Y-%m-%d)/g" "${WIKI_DIR}/index.md"
  info "Created index.md"
fi

# ── Seed log.md (only if missing) ───────────────────────────────
if [ ! -f "${WIKI_DIR}/log.md" ]; then
  cat >"${WIKI_DIR}/log.md" <<EOF
---
title: Wiki Log
category: log
---

# Wiki Log

Chronological record of wiki activity.

## [$(date +%Y-%m-%d)] init | Wiki initialised

Directory structure created. Ready for first ingest.
EOF
  info "Created log.md"
fi

# ── Seed overview.md (only if missing) ──────────────────────────
if [ ! -f "${WIKI_DIR}/overview.md" ]; then
  cat >"${WIKI_DIR}/overview.md" <<EOF
---
title: Overview
category: overview
created: $(date +%Y-%m-%d)
updated: $(date +%Y-%m-%d)
---

# Overview

This wiki is empty. It will grow as sources are ingested and questions
are asked. See [index.md](index.md) for the content catalog and
[log.md](log.md) for activity history.
EOF
  info "Created overview.md"
fi

# ── Deploy WIKI.md schema to workspace (only if missing) ───────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WIKI_SCHEMA_SRC="${SCRIPT_DIR}/../run/_/wiki/WIKI.md"
WIKI_SCHEMA_DST="${WORKSPACE}/WIKI.md"

if [ -f "$WIKI_SCHEMA_SRC" ] && [ ! -f "$WIKI_SCHEMA_DST" ]; then
  cp "$WIKI_SCHEMA_SRC" "$WIKI_SCHEMA_DST"
  info "Deployed WIKI.md schema to ${WIKI_SCHEMA_DST}"
elif [ ! -f "$WIKI_SCHEMA_SRC" ]; then
  info "WIKI.md source not found at ${WIKI_SCHEMA_SRC} — skipping schema deployment"
fi

info "Wiki initialised at ${WIKI_DIR}"
info "Raw sources at ${RAW_DIR}"
