#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Initialise the LLM Wiki directory structure inside a NemoClaw sandbox.
# Designed to run once (idempotent — safe to re-run without data loss).
#
# Usage:
#   wiki-init.sh                                 # Main agent wiki under /sandbox/.openclaw-data/{wiki,wiki-raw}
#   wiki-init.sh /custom/data/root               # Main agent wiki under custom data root
#   wiki-init.sh /sandbox/.openclaw-data /sandbox/.openclaw-data/workspace-jophiel jophiel
#                                               # Sub-agent wiki under /sandbox/.openclaw-data/{wiki-jophiel,wiki-raw-jophiel}
#
# Typically invoked via:
#   openshell sandbox connect <name>
#   bash /path/to/wiki-init.sh

set -euo pipefail

DATA_ROOT="${1:-/sandbox/.openclaw-data}"
WORKSPACE="${2:-/sandbox/.openclaw/workspace}"
AGENT_ID="${3:-main}"

if [ "$AGENT_ID" = "main" ]; then
  WIKI_NAME="wiki"
  RAW_NAME="wiki-raw"
else
  WIKI_NAME="wiki-${AGENT_ID}"
  RAW_NAME="wiki-raw-${AGENT_ID}"
fi

WIKI_DIR="${DATA_ROOT}/${WIKI_NAME}"
RAW_DIR="${DATA_ROOT}/${RAW_NAME}"

GREEN='\033[0;32m'
NC='\033[0m'
info() { echo -e "${GREEN}[wiki-init]${NC} $1"; }

slug_to_title() {
  local input="$1"
  python3 - "$input" <<'PY'
import sys

value = sys.argv[1].strip()
if not value:
    print("Agent")
else:
    print(" ".join(part.capitalize() for part in value.replace("_", "-").split("-") if part))
PY
}

AGENT_TITLE="$(slug_to_title "$AGENT_ID")"

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

Content catalog for AGENT_TITLE's knowledge base. Each entry links to a wiki page
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
  sed -i "s/AGENT_TITLE/${AGENT_TITLE}/g" "${WIKI_DIR}/index.md"
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

Directory structure created for ${AGENT_ID}. Ready for first ingest.
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

This wiki belongs to ${AGENT_TITLE}. It will grow as sources are ingested
and questions are asked. See [index.md](index.md) for the content catalog
and [log.md](log.md) for activity history.
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

export WIKI_DIR RAW_DIR WORKSPACE AGENT_ID AGENT_TITLE WIKI_NAME RAW_NAME
python3 - <<'PY'
import os
from pathlib import Path


workspace = Path(os.environ["WORKSPACE"])
agent_id = os.environ["AGENT_ID"]
agent_title = os.environ["AGENT_TITLE"]
wiki_name = os.environ["WIKI_NAME"]
raw_name = os.environ["RAW_NAME"]
wiki_dir = os.environ["WIKI_DIR"]
raw_dir = os.environ["RAW_DIR"]

soul_path = workspace / "SOUL.md"
if soul_path.exists():
  soul_text = soul_path.read_text()
  if "## Wiki Practice" not in soul_text:
    soul_text = soul_text.rstrip() + "\n\n## Wiki Practice\n\n- `WIKI.md` defines your long-term knowledge workflow. Keep it aligned with your behaviour.\n- Treat `{wiki_dir}` as your deep memory and `{raw_dir}` as immutable source material.\n- Before answering non-trivial questions about long-term context, read `WIKI.md` and start from `{wiki_name}/index.md`.\n- File substantive insights back into your wiki, then keep `MEMORY.md` as a compact executive summary of what matters most.\n- If a restore or reset strips wiki behaviour from your workspace files, repair it from `WIKI.md` and the surviving wiki rather than starting over blindly.\n".format(
      wiki_dir=wiki_dir,
      raw_dir=raw_dir,
      wiki_name=wiki_name,
    )
    soul_path.write_text(soul_text)

agents_path = workspace / "AGENTS.md"
if agents_path.exists():
  agents_text = agents_path.read_text()
  startup_marker = "4. **If in MAIN SESSION** (direct chat with your human): Read `MEMORY.md` **if it exists**\n"
  if startup_marker in agents_text and f"{wiki_name}/index.md" not in agents_text:
    agents_text = agents_text.replace(
      startup_marker,
      startup_marker
      + "5. If `WIKI.md` exists: read it so you remember the wiki workflow\n"
      + f"6. If long-term knowledge matters for the task: read `{wiki_dir}/index.md` before exploring individual wiki pages\n",
    )
  if "## Wiki Startup" not in agents_text:
    agents_text = agents_text.rstrip() + "\n\n## Wiki Startup\n\n- Read `WIKI.md` when it exists so you remember the wiki workflow.\n- When long-term knowledge matters, start from `{wiki_dir}/index.md` before opening individual pages.\n".format(
      wiki_dir=wiki_dir,
    )
  if "Wiki Memory Layer" not in agents_text:
    agents_text = agents_text.rstrip() + "\n\n## Wiki Memory Layer\n\n- {agent_title} owns this wiki exclusively; other agents do not read or write it without explicit design.\n- Wiki pages: `{wiki_dir}`\n- Raw sources: `{raw_dir}`\n- Schema: `WIKI.md` in this workspace\n- Use `MEMORY.md` as the compact bootstrap summary and the wiki as the deep, on-demand knowledge base.\n- When you create or update wiki pages, also update `{wiki_name}/index.md` and append a parseable entry to `{wiki_name}/log.md`.\n".format(
      agent_title=agent_title,
      wiki_dir=wiki_dir,
      raw_dir=raw_dir,
      wiki_name=wiki_name,
    )
  agents_path.write_text(agents_text)

memory_path = workspace / "MEMORY.md"
memory_text = None
if memory_path.exists():
  existing = memory_path.read_text()
  if "Wiki Rules" not in existing or existing.strip() == "# MEMORY.md\n\nLong-term notes for Metatron.\n\n- Created after sandbox restore because this workspace did not yet have a long-term memory file.":
    memory_text = existing
else:
  memory_text = ""

if memory_text is not None:
  summary = f"""# MEMORY.md

Executive summary for {agent_title}. Use this as the bootstrap layer for long-term context; use the wiki for detail.

## Core Context

- {agent_title} maintains an independent wiki memory for its own role, decisions, and observations.
- The deep knowledge base lives in `{wiki_dir}`; `WIKI.md` defines how to maintain it.
- `MEMORY.md` stays compact and curated so it can be injected at session start.

## Sandbox State

- Workspace: `{workspace}`
- Wiki pages: `{wiki_dir}`
- Raw sources: `{raw_dir}`
- For historical detail, entities, analyses, and raw sources, start at `{wiki_name}/index.md`.

## Wiki Rules

- Read `WIKI.md` and `{wiki_name}/index.md` before answering questions that depend on accumulated knowledge.
- Add durable insights back into your wiki, not just into ephemeral chat responses.
- Treat `{raw_name}` as immutable after ingest.
- Keep this file compact and curated; the wiki holds the full detail.

## Recovery Note

- After sandbox restore, verify `SOUL.md`, `AGENTS.md`, `MEMORY.md`, and `WIKI.md` still reflect the wiki workflow even if the wiki pages themselves survived.
"""
  memory_path.write_text(summary)
PY

info "Wiki initialised at ${WIKI_DIR}"
info "Raw sources at ${RAW_DIR}"
