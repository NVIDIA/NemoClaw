#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Example recipe adapter; model-specific behavior belongs in this artifact."""
import json
import os
from pathlib import Path
import subprocess
import sys

request = json.load(sys.stdin)
assert request["apiVersion"] == "nemoclaw.nvidia.com/recipe-execution/v1"
model = Path(request["modelDirectory"])
output = Path(request["outputDirectory"])
name = "language_model.model.layers.1.ple.ple_embedding.ngram_embedding.packed_u8"
previous = request.get("previousDirectory")
# Reuse published bytes only as a candidate. The verifier must check them before
# the supervisor accepts a new receipt. Never modify the previous directory.
if previous and Path(previous).is_dir():
    for filename in (name, name + ".json"):
        source = Path(previous) / filename
        target = output / filename
        if source.is_file() and not source.is_symlink() and not target.exists():
            os.link(source, target)
# Upstream skips a full-length packed file even if interrupted before metadata
# publication. Regenerate only this unpublished orphan.
if not (output / (name + ".json")).exists():
    (output / name).unlink(missing_ok=True)
subprocess.run(
    [sys.executable, "/opt/nemoclaw/source/recipe/files/build_ple_packed_table.py", str(model), str(output)],
    check=True, stdout=sys.stderr,
)
