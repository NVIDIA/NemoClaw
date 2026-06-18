#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Shared helper: parse PostToolUse stdin JSON from Claude Code
# Source this from hooks: source "$(dirname "$0")/_parse-stdin.sh"
#
# Sets these variables:
#   HOOK_FILE_PATH     - the file_path from tool_input
#   HOOK_TRANSCRIPT    - path to current session transcript
#   HOOK_SESSION_ID    - current session ID
#   HOOK_TOOL_NAME     - the tool that was used (Write, Bash, etc.)

_stdin_data=$(cat)

HOOK_FILE_PATH=$(echo "$_stdin_data" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_input', {}).get('file_path', ''))
except:
    print('')
" 2>/dev/null)

HOOK_TRANSCRIPT=$(echo "$_stdin_data" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('transcript_path', ''))
except:
    print('')
" 2>/dev/null)

HOOK_SESSION_ID=$(echo "$_stdin_data" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('session_id', ''))
except:
    print('')
" 2>/dev/null)

HOOK_TOOL_NAME=$(echo "$_stdin_data" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_name', ''))
except:
    print('')
" 2>/dev/null)

# Back-compat: also set CLAUDE_FILE_PATH for existing hook logic
CLAUDE_FILE_PATH="$HOOK_FILE_PATH"
export CLAUDE_FILE_PATH HOOK_FILE_PATH HOOK_TRANSCRIPT HOOK_SESSION_ID HOOK_TOOL_NAME
