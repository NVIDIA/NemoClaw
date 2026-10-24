# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Restore the pinned executable resource injector in Windows build CI only."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import time

parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--cache", type=Path, required=True)
args = parser.parse_args()
if os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true":
    raise ValueError("Executable tools are prepared only on the Windows build runner.")
if args.output.exists():
    raise ValueError("Executable tools require a fresh output directory.")
source = Path(__file__).parents[1] / "app" / "materialize-openclaw-build.py"
spec = importlib.util.spec_from_file_location("verified_app_inputs", source)
materializer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(materializer)
lock = json.loads(Path(__file__).with_name("native-tools.lock.json").read_text(encoding="utf-8"))
if lock["schemaVersion"] != 1 or lock["nodeVersion"] != "22.23.2" or lock["target"] != "win32-arm64":
    raise ValueError("The native executable tool lock differs from the target runtime.")
pin = lock["postject"]
item = {"url": pin["url"], "integrity": pin["integrity"], "sha256": pin["archiveSha256"]}
args.output.mkdir(parents=True)
args.cache.mkdir(parents=True, exist_ok=True)
archive = materializer.fetch(item, args.cache, time.monotonic() + 180)
package = args.output / "postject"
inventory = materializer.extract(archive["archive"], package)
metadata = json.loads((package / "package.json").read_text(encoding="utf-8"))
if metadata["name"] != "postject" or metadata["version"] != pin["version"] or not (package / "dist" / "api.js").is_file():
    raise ValueError("The executable injector package does not satisfy its pinned contract.")
(args.output / "tools-input.json").write_text(json.dumps({
    "schemaVersion": 1, "classification": "windows-executable-build-tools",
    "archive": archive, "inventory": inventory, "lifecycleScriptsExecuted": False,
}, indent=2) + "\n")
print("Pinned executable resource injector is ready.")
