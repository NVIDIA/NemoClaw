#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw walkthrough — sandboxed agent approval flow.
#
# This sets up a split-screen workflow:
#   LEFT:  OpenClaw agent (chat)
#   RIGHT: OpenShell TUI (monitor + approve network egress)
#
# The agent runs inside a sandboxed environment with a strict network
# policy. When it tries to access a service not in the allow list,
# the TUI prompts the operator to approve or deny the request.
#
# Prerequisites:
#   - NemoClaw setup complete (./scripts/setup.sh)
#   - NVIDIA_API_KEY in environment
#
# Suggested prompts that trigger the approval flow:
#
#   1. "Write a Python script that fetches the current NVIDIA stock price
#       and prints it." → triggers PyPI (pip install) + finance API access
#
#   2. "Search the web for the latest MLPerf inference benchmarks and
#       summarize them." → triggers web search API access
#
#   3. "Install the requests library and fetch the top story from
#       Hacker News." → triggers PyPI + news.ycombinator.com access
#
# Usage:
#   ./scripts/walkthrough.sh
#
# This opens two panes in tmux. If tmux is not available, run manually:
#
#   Terminal 1 (TUI):
#     openshell term
#
#   Terminal 2 (Agent):
#     openshell sandbox connect nemoclaw
#     export NVIDIA_API_KEY=nvapi-...
#     nemoclaw-start
#     openclaw agent --agent main --local --session-id live

set -euo pipefail

[ -n "${NVIDIA_API_KEY:-}" ] || { echo "NVIDIA_API_KEY required"; exit 1; }

echo ""
echo "  ┌─────────────────────────────────────────────────────┐"
echo "  │  NemoClaw Walkthrough                               │"
echo "  │                                                     │"
echo "  │  LEFT pane:   OpenShell TUI (monitor + approve)     │"
echo "  │  RIGHT pane:  OpenClaw agent (chat)                 │"
echo "  │                                                     │"
echo "  │  When the agent tries to access a new service,      │"
echo "  │  the TUI will prompt you to approve or deny.        │"
echo "  │                                                     │"
echo "  │  Try asking:                                        │"
echo "  │    \"Fetch the current NVIDIA stock price\"            │"
echo "  │    \"Install requests and get the top HN story\"       │"
echo "  └─────────────────────────────────────────────────────┘"
echo ""

if ! command -v tmux > /dev/null 2>&1; then
  echo "tmux not found. Run these in two separate terminals:"
  echo ""
  echo "  Terminal 1 (TUI):"
  echo "    openshell term"
  echo ""
  echo "  Terminal 2 (Agent):"
  echo "    openshell sandbox connect nemoclaw"
  echo "    export NVIDIA_API_KEY=$NVIDIA_API_KEY"
  echo "    nemoclaw-start"
  echo "    openclaw agent --agent main --local --session-id live"
  exit 0
fi

SESSION="nemoclaw-walkthrough"

# Kill old session if it exists
tmux kill-session -t "$SESSION" 2>/dev/null || true

# Create session with TUI on the left
tmux new-session -d -s "$SESSION" -x 200 -y 50 "openshell term"

# Split right pane for the agent
tmux split-window -h -t "$SESSION" \
  "openshell sandbox connect nemoclaw -- bash -c 'export NVIDIA_API_KEY=$NVIDIA_API_KEY && nemoclaw-start openclaw agent --agent main --local --session-id live'"

# Even split
tmux select-layout -t "$SESSION" even-horizontal

# Attach
tmux attach -t "$SESSION"
