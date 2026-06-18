#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hook: Catch silent failures in the embed/mine docker invocations and surface them.
# Watches PostToolUse Bash output for the telltale failure modes:
#   1. docker missing / image not pulled / wrong tag
#   2. Encoder mismatch between Step 1 and Step 2 (different model or model_path)
#   3. filter_by_label silent no-op (label column missing on one side)
#   4. Empty mined parquet (encoder mismatch or label filter wiped the pool)
#   5. Missing GPU / CUDA
# Toggle: export MINING_HOOKS=0 to disable

[[ "${MINING_HOOKS:-1}" == "0" ]] && exit 0

_stdin=$(cat)
export _HOOK_STDIN="$_stdin"

python3 << 'PYEOF'
import json, os, re, sys

raw = os.environ.get('_HOOK_STDIN', '')
if not raw:
    sys.exit(0)

try:
    data = json.loads(raw)
except (json.JSONDecodeError, ValueError):
    sys.exit(0)

if data.get('tool_name', '') != 'Bash':
    sys.exit(0)

tool_response = data.get('tool_response', {})
stdout = tool_response.get('stdout', '') or ''
stderr = tool_response.get('stderr', '') or ''
command = data.get('tool_input', {}).get('command', '') or ''
combined = stdout + '\n' + stderr

warnings = []

# 1a. docker missing
if re.search(r'\bdocker\s+run\b', command) and ('docker: command not found' in combined or re.search(r'docker:\s*command not found', combined)):
    warnings.append("`docker` not found on PATH. Install Docker (and the NVIDIA container toolkit) before re-running this skill.")

# 1b. tao-toolkit-ds image missing or unreachable
if re.search(r'(unable to find image|pull access denied|manifest unknown|repository does not exist).*tao-toolkit-ds', combined, re.IGNORECASE):
    warnings.append("The `tao_toolkit.data_services` container image (resolved from `versions.yaml`) is missing or unreachable. Resolve `DS_IMAGE` from `versions.yaml` (`images.tao_toolkit.data_services`), pre-pull with `docker pull \"$DS_IMAGE\"`, and confirm registry credentials. The data-services tag declared in versions.yaml is required — the generic `:latest` does not contain the embedding/mining entrypoints.")

# 1c. Path-mount mismatch — entrypoint reports a parquet path it cannot find that exists on the host
if re.search(r'(FileNotFoundError|No such file or directory).*\.parquet', combined):
    warnings.append("Container reported a parquet path it cannot read. Most likely the path is on the host but not mounted into the container. Use `-v $WORKSPACE:$WORKSPACE` so host and container paths match exactly.")

# 2. Generic Python traceback in either stream
if 'Traceback (most recent call last)' in combined:
    warnings.append("Python traceback detected — a docker step crashed mid-run. Fix the error and re-run from the failing step (Steps 1–2 do not need to repeat if Step 3 is the failure).")

# 3. Encoder mismatch — heuristic: two `embedding image_embeddings` invocations
#    in the SAME command block whose `model=` or `model_path=` values differ.
embed_invocations = re.findall(
    r'embedding\s+image_embeddings(.*?)(?=docker\s+run\b|\Z)',
    command, re.DOTALL,
)
if len(embed_invocations) >= 2:
    def _grab(invo, key):
        m = re.search(rf'{key}\s*=\s*([^\s\\]+)', invo)
        return m.group(1) if m else None
    models = [_grab(i, 'model') for i in embed_invocations]
    model_paths = [_grab(i, 'model_path') for i in embed_invocations]
    if all(models) and len(set(models)) > 1:
        warnings.append(f"ENCODER MISMATCH: target and source embedding steps used different `model=` values ({set(models)}). Embeddings from different encoders are not comparable — mining output will be garbage.")
    if all(model_paths) and len(set(model_paths)) > 1:
        warnings.append(f"ENCODER MISMATCH: target and source embedding steps used different `model_path=` values ({set(model_paths)}). The two embedding parquets must come from the SAME encoder weights.")

# 4. filter_by_label silent no-op — entrypoint logs a warning when it can't find a `label` column
if re.search(r"filter_by_label\s*=\s*true", command):
    if re.search(r'(label.*column.*not found|filter_by_label.*disabled|missing.*label.*column|proceeding without filter)',
                 combined, re.IGNORECASE):
        warnings.append("filter_by_label was requested but the entrypoint silently disabled it (one of the embedding parquets lacks a `label` column). The mined parquet contains UNFILTERED nearest neighbours. Backfill the missing label column and re-run Step 3.")

# 5. Empty mined parquet hint
if re.search(r'mined.*0\s+(unique|rows?|images?)', combined, re.IGNORECASE):
    warnings.append("Mining produced 0 rows. Likely causes: empty source pool, encoder mismatch (Steps 1/2 disagreed), or label filter dropped every pair.")

# 6. Missing GPU / CUDA
if re.search(r'(CUDA.*not available|no CUDA-capable device|nvidia-smi.*not found|could not select device driver.*gpu)', combined, re.IGNORECASE):
    warnings.append("No GPU detected from inside the container. Both embedding and mining require CUDA. Confirm `nvidia-smi` works on the host AND that `--gpus all` was passed to `docker run`.")

if warnings:
    print("MINING SCRIPT ISSUES:")
    for w in warnings:
        print(f"  - {w}")
PYEOF
