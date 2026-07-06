# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Source this file (after copying to dogfood-env.sh and filling in secrets)
# from the shell that will run `nemoclaw onboard` and the dogfood orchestrator.
# Variables flow into the sandbox via NemoClaw's existing deploy-time env
# passthrough (src/lib/deploy/index.ts:466-498).
#
#     cp scripts/dogfood-env.sh.example scripts/dogfood-env.sh
#     # edit scripts/dogfood-env.sh — fill in secrets
#     source scripts/dogfood-env.sh
#     nemoclaw onboard          # uses canonical blueprint.yaml; env is read
#     # ... inside the running sandbox:
#     bash scripts/dogfood-orchestrator.sh

# -----------------------------------------------------------------------------
# REQUIRED — secrets, auto-fetched from local CLI credential stores.
# -----------------------------------------------------------------------------
#
# No paste required — just be logged in via `gh auth login` and `brev login`
# first; the auto-fetch below reads from where each CLI already stores its
# token. If either lookup fails, the block warns; the orchestrator's Phase 1
# env-check would then fail-fast before any cost is incurred.

# GitHub token. `gh auth token` prints the active token to stdout. Required
# scopes: `repo` (label + comment writes); `project` (Project 199 move on
# fixed-on-latest verdicts — orchestrator soft-warns if missing). To add the
# project scope: `gh auth refresh -h github.com -s project` in a real TTY.
if command -v gh >/dev/null 2>&1; then
  export GH_TOKEN="$(gh auth token 2>/dev/null || echo "")"
fi
if [ -z "${GH_TOKEN:-}" ]; then
  echo "[dogfood-env] warning: could not auto-fetch GH_TOKEN — run 'gh auth login' first." >&2
fi

# Brev account tokens. Stored in ~/.brev/credentials.json after `brev login`:
#   - access_token  : short-lived (hours); used for API calls
#   - refresh_token : longer-lived; brev CLI uses it to auto-renew access
# Must have create + delete permissions for the verification sandboxes the
# skill provisions per candidate. Pass BOTH so the orchestrator can
# reconstruct a complete credentials.json inside the sandbox — passing only
# access_token works for short runs but kills long batches when it expires.
if [ -f "$HOME/.brev/credentials.json" ] && command -v jq >/dev/null 2>&1; then
  export BREV_API_TOKEN="$(jq -r '.access_token // empty' "$HOME/.brev/credentials.json" 2>/dev/null || echo "")"
  export BREV_REFRESH_TOKEN="$(jq -r '.refresh_token // empty' "$HOME/.brev/credentials.json" 2>/dev/null || echo "")"
fi
if [ -z "${BREV_API_TOKEN:-}" ]; then
  echo "[dogfood-env] warning: could not auto-fetch BREV_API_TOKEN — run 'brev login' first." >&2
fi
# Sanity-check that the token still works on the host. If brev ls fails with
# 'logged out', the access token has expired and refresh has also lapsed.
if [ -n "${BREV_API_TOKEN:-}" ] && command -v brev >/dev/null 2>&1; then
  if ! brev ls >/dev/null 2>&1; then
    echo "[dogfood-env] warning: brev token expired locally — run 'brev login' to refresh." >&2
  fi
fi

# NVIDIA API key — ONLY needed if you plan to process non-Ollama candidates.
# The default candidate filter (VERIFY_STALE_FORCE_OLLAMA_ONLY=1, see below)
# drops anything that would need this; leave the variable unset in that case.
# When set, write the key to a file (the skill copies the file to Brev boxes
# via `brev copy` — never to argv, per the skill's hard requirement).
# export NVIDIA_API_KEY_FILE="$HOME/.nvidia-api-key"

# -----------------------------------------------------------------------------
# REQUIRED — verify-stale automation switches.
# -----------------------------------------------------------------------------

# When =1, the Step 3 self-check verdict drives Brev provisioning directly
# (no maintainer approval prompt). The self-check itself ALWAYS runs.
export VERIFY_STALE_AUTO_APPROVE="1"

# When =1, Step 10's comment-post and label-apply are skipped — drafts are
# written to $VERIFY_STALE_LOG_DIR/<issue>/comment-draft.md instead. Start
# every dogfood run with DRY_RUN=1; flip to 0 only after reviewing drafts.
export VERIFY_STALE_DRY_RUN="1"

# Number of candidates processed per run. Overrides the skill's default 15.
export VERIFY_STALE_BATCH_CAP="1"

# Per-run log root. Each candidate gets <root>/<issue-number>/ with metadata,
# transcripts, self-check.json, score.json, and comment-draft.md. The
# orchestrator symlinks the latest run to <root>/latest for convenience.
# Use a persistent path so logs survive sandbox restarts.
export VERIFY_STALE_LOG_DIR="$HOME/verify-stale-runs"

# Hard ceiling on cumulative Brev spend across the batch. The orchestrator
# accumulates per-candidate cost as (candidate wallclock seconds / 3600) ×
# DOGFOOD_BREV_HOURLY_USD and halts the batch if the next candidate would
# push past this limit.
export BREV_BUDGET_USD="200"

# Conservative per-hour Brev rate used by the cost accumulator. Set higher
# than your expected SKU price so the budget gate stays safe even if the
# skill provisions a more expensive box than expected. Defaults assume a
# mid-tier GPU box (T4/L40S range); bump to 4-5 if you expect H100 SKUs,
# drop to 0.5 if you constrain to CPU-only candidates.
export DOGFOOD_BREV_HOURLY_USD="${DOGFOOD_BREV_HOURLY_USD:-3}"

# When =1, the Step 3 candidate filter drops any issue whose body or labels
# imply a non-ollama inference provider, so the skill never stalls at the
# Step 6 "Required-API-key prompt" in autonomous mode. Mount NVIDIA_API_KEY
# above and set this to 0 if you want a broader provider mix.
export VERIFY_STALE_FORCE_OLLAMA_ONLY="1"

# Suppresses all stdin prompts in nemoclaw onboard, the skill, and openclaw
# agent. Required for unattended runs. (Already wired into src/lib/onboard.ts
# line 577 and elsewhere.)
export NEMOCLAW_NON_INTERACTIVE="1"

# -----------------------------------------------------------------------------
# OPTIONAL — overrides with sensible defaults.
# -----------------------------------------------------------------------------

# Ollama model the agent itself uses for reasoning over the skill. Must be
# pre-pulled on the HOST running Ollama (the orchestrator's G10 preflight
# will attempt `ollama pull` if missing, but pulling a 5 GB model inside the
# orchestrator slows the first run; do it ahead of time when possible).
export OLLAMA_MODEL="${OLLAMA_MODEL:-nemotron-3-nano:4b}"

# Per-candidate agent timeout, in seconds. Drop this to 1800 (30 min) for
# the first real run — the skill's default per-candidate cap is also 60 min
# at the trap level, so setting this lower than 3600 means whichever fires
# first wins. Catches runaway agents before they burn the budget.
export OPENCLAW_AGENT_TIMEOUT_SEC="1800"

# Full agent invocation override. By default the orchestrator builds it as
# `openclaw agent --local --timeout $OPENCLAW_AGENT_TIMEOUT_SEC` per
# node_modules/openclaw/docs/tools/agent-send.md. Override only if your
# sandbox image ships a non-standard openclaw build.
# export OPENCLAW_AGENT_CMD="openclaw agent --local --timeout 1800"

# When =1, the orchestrator pauses after candidate selection (Phase 5) and
# prompts you via /dev/tty to confirm before any verification fires. Useful
# for the first single-candidate run; flip back to 0 for autonomous batches.
export DOGFOOD_CONFIRM_BEFORE_VERIFY="1"

# Wrap-up Gist visibility. "secret" (default) keeps the Gist URL-only; "public"
# is org-discoverable. Run logs may contain agent reasoning over issue bodies —
# treat as moderately sensitive.
export DOGFOOD_GIST_VISIBILITY="${DOGFOOD_GIST_VISIBILITY:-secret}"

# Picked up from the .example update — see PR commit
export NEMOCLAW_PROVIDER="custom"

export NEMOCLAW_MODEL="aws/anthropic/bedrock-claude-opus-4-7"
export NEMOCLAW_ENDPOINT_URL="https://inference-api.nvidia.com"
