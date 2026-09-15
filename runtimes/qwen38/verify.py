#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Adapt the packaged semantic verifier to the generic recipe protocol."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

request = json.load(sys.stdin)
assert request["apiVersion"] == "nemoclaw.nvidia.com/recipe-execution/v1"
result = subprocess.run(
    [sys.executable, "/opt/nemoclaw/source/verify_packed.py", request["modelDirectory"], request["outputDirectory"]],
    check=True, stdout=subprocess.PIPE,
)
packed = json.loads(result.stdout)
name = packed["name"] + ".json"
metadata = (Path(request["outputDirectory"]) / name).read_bytes()
json.dump({"files": [packed, {"name": name, "size": len(metadata), "sha256": hashlib.sha256(metadata).hexdigest()}]}, sys.stdout)
