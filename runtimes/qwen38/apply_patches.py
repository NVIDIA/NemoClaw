# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Apply the pinned recipe to the pinned image, retaining original and modified sources."""

import hashlib
import importlib.util
import json
from pathlib import Path
import py_compile
import shutil
import subprocess
import sys

root = Path("/opt/nemoclaw/source")
recipe = root / "recipe"
files = recipe / "files"
package = Path(importlib.util.find_spec("vllm").origin).parent
pins = json.loads((root / "pins.json").read_text())
assert hashlib.sha256((root / "recipe.tar.gz").read_bytes()).hexdigest() == pins["recipeArchiveSHA256"]
assert hashlib.sha256((files / "build_ple_packed_table.py").read_bytes()).hexdigest() == pins["preparerSHA256"]
assert hashlib.sha256(Path("/opt/nemoclaw/model.json").read_bytes()).hexdigest() == pins["modelManifestSHA256"]

targets = {
    "ple_layer_patched.py": "models/qwen3_8_flash_next/nvidia/ple_layer.py",
    "modelopt_patched.py": "model_executor/layers/quantization/modelopt.py",
    "qsa_ops_patched.py": "models/qwen3_8_flash_next/nvidia/ops/qsa.py",
    "qsa_nvidia_patched.py": "models/qwen3_8_flash_next/nvidia/qsa.py",
    "mtp_patched.py": "models/qwen3_8_flash_next/nvidia/mtp.py",
    "ple_offload/ple_offload_layer.py": "model_executor/layers/ple_offload_layer.py",
    "ple_offload/connector.py": "v1/ple_offload/connector.py",
    "ple_offload/worker.py": "v1/ple_offload/worker.py",
    "ple_offload/protocol.py": "v1/ple_offload/protocol.py",
}
for dest, source in targets.items():
    path = files / dest
    original = path.parent / "orig" / path.name if dest.startswith("ple_offload/") else Path(str(path) + ".orig")
    original.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(package / source, original)

for patch in ["ple_layer", "modelopt_mxfp8", "qsa_fp8_kv", "mtp_draft_vocab", "ple_offload"]:
    subprocess.run([sys.executable, str(files / f"patch_{patch}.py")], check=True)

# A missing packed table must never allocate its 27 GiB replacement in RAM.
# This extra change is retained beside the upstream and generated source.
worker = files / "ple_offload/worker.py"
text = worker.read_text()
old = '''                    logger.warning(
                        "PLE %s: no packed table at %s; loading shards into RAM",
                        name, path,
                    )'''
assert text.count(old) == 1
worker.write_text(text.replace(old, '                    raise RuntimeError("required verified packed PLE table is missing")'))

receipt = {}
for dest, source in targets.items():
    generated = files / dest
    py_compile.compile(str(generated), doraise=True)
    shutil.copyfile(generated, package / source)
    receipt[source] = hashlib.sha256(generated.read_bytes()).hexdigest()
(root / "patched-files.json").write_text(json.dumps(receipt, indent=2) + "\n")
