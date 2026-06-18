#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hook: Catch silent Python script failures and validate analysis scripts produce output
# Parses PostToolUse stdin JSON for exit code and stdout content
# Toggle: export RCA_HOOKS=0 to disable, RCA_HOOKS=1 to enable (default: enabled)

[[ "${RCA_HOOKS:-1}" == "0" ]] && exit 0

# Read stdin JSON into variable
_stdin=$(cat)

# Pass JSON via environment variable (not argv — avoids shell quoting issues with large JSON)
export _HOOK_STDIN="$_stdin"

python3 << 'PYEOF'
import json, sys, os

raw = os.environ.get('_HOOK_STDIN', '')
if not raw:
    sys.exit(0)

try:
    data = json.loads(raw)
except (json.JSONDecodeError, ValueError):
    sys.exit(0)

tool_name = data.get('tool_name', '')
if tool_name != 'Bash':
    sys.exit(0)

# Extract fields
tool_response = data.get('tool_response', {})
stdout = tool_response.get('stdout', '') or ''
stderr = tool_response.get('stderr', '') or ''
command = data.get('tool_input', {}).get('command', '')

# Heuristic exit code: check stderr for common error patterns
has_error = False
if stderr.strip():
    error_patterns = ['Traceback', 'Error:', 'error:', 'FAILED', 'fatal:', 'Permission denied']
    has_error = any(p in stderr for p in error_patterns)

warnings = []

# Check 1: Traceback in stdout or stderr
if 'Traceback (most recent call last)' in stdout or 'Traceback (most recent call last)' in stderr:
    warnings.append("Python traceback detected — script crashed mid-execution. Fix the error and re-run to get complete results.")

# Check 2: Python analysis scripts that produce no output (likely silent failure)
if 'python' in command.lower() and not stdout.strip() and not has_error:
    analysis_keywords = ['print', 'score', 'defect', 'mean', 'count', 'compute', 'analyze', 'statistics']
    if any(kw in command.lower() for kw in analysis_keywords):
        warnings.append("Python analysis script produced NO output. It may have silently failed or has a logic error. Check for empty DataFrames, wrong file paths, or swallowed exceptions.")

# Check 3: Common data analysis red flags in output
if stdout:
    if 'nan' in stdout.lower() and ('mean' in stdout.lower() or 'score' in stdout.lower()):
        warnings.append("NaN values in analysis output. Check for empty groups, division by zero, or missing data.")
    if 'empty dataframe' in stdout.lower() or 'no rows' in stdout.lower():
        warnings.append("Empty DataFrame in output. Likely a filter that matched nothing — check your conditions.")

# Check 4: stderr warnings that may indicate partial results
if stderr.strip() and not has_error:
    warn_patterns = ['UserWarning', 'FutureWarning', 'DeprecationWarning']
    real_warnings = [line for line in stderr.splitlines()
                     if not any(wp in line for wp in warn_patterns) and line.strip()]
    if real_warnings:
        warnings.append(f"Unexpected stderr output ({len(real_warnings)} lines). Script may have partial errors.")

if warnings:
    print("SCRIPT ISSUES:")
    for w in warnings:
        print(f"  - {w}")

PYEOF
