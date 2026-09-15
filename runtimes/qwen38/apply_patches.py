# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-FileCopyrightText: Copyright (C) 2026 MiaAI Lab (https://x.com/MiaAI_lab)
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Adapt MiaAI Lab's start.sh patch installation to a retained-source image build.

Upstream: https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark
Revision: d03809008834124e80223c3482f2ddb59577a48f
Modified 2026-09-11: verify immutable inputs, preserve sources, and require packed PLE.
Modified 2026-09-15: carry attribution and license notices into generated vLLM files.
See AGPL-3.0-or-later.txt and NOTICE.md beside this file.
"""

import hashlib
import importlib.util
import json
from pathlib import Path
import py_compile
import shutil
import subprocess
import sys

def attribute_source(source, patch):
    """Retain Apache-2.0 output licensing and identify the recipe modifications."""
    original = "# SPDX-License-Identifier: Apache-2.0\n"
    if source.count(original) != 1:
        raise ValueError("pinned vLLM source license changed; review attribution before packaging")
    notice = (
        "# Generated vLLM output remains Apache-2.0 under the recipe README license scope.\n"
        "# SPDX-FileCopyrightText: Copyright (C) 2026 MiaAI Lab (https://x.com/MiaAI_lab)\n"
        "# Modified with MiaAI Lab recipe d03809008834124e80223c3482f2ddb59577a48f:\n"
        f"# /opt/nemoclaw/source/recipe/files/{patch}\n"
        "# Recipe: https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark\n"
        "# Modified 2026-09-15 by NVIDIA: attach these source and license notices.\n"
        "# The patch generator is AGPL-3.0-or-later; its output uses Apache-2.0.\n"
        "# See /opt/nemoclaw/source/recipe/README.md and /opt/nemoclaw/source/NOTICE.md.\n"
    )
    if patch == "patch_ple_offload.py":
        notice += "# NVIDIA modification 2026-09-11: worker rejects a missing packed PLE table.\n"
    if patch == "patch_qsa_fp8_kv.py":
        notice += "# FP8 KV approach: lancelind/qwen3.8-Flash-DGX (Apache-2.0), credited by MiaAI Lab.\n"
    if patch == "patch_ple_layer.py":
        notice += "# PLE quantization dispatch: vLLM PR #53899 (qwen4_exp), ported by MiaAI Lab.\n"
    return notice + source


def main():
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
    old = (
        '                    logger.warning(\n'
        '                        "PLE %s: no packed table at %s; loading shards into RAM",\n'
        '                        name, path,\n'
        '                    )'
    )
    assert text.count(old) == 1
    worker.write_text(text.replace(old, '                    raise RuntimeError("required verified packed PLE table is missing")'))

    patch_sources = {
        "ple_layer_patched.py": "patch_ple_layer.py",
        "modelopt_patched.py": "patch_modelopt_mxfp8.py",
        "qsa_ops_patched.py": "patch_qsa_fp8_kv.py",
        "qsa_nvidia_patched.py": "patch_qsa_fp8_kv.py",
        "mtp_patched.py": "patch_mtp_draft_vocab.py",
    }
    receipt = {}
    for dest, source in targets.items():
        generated = files / dest
        patch = patch_sources.get(dest, "patch_ple_offload.py")
        generated.write_text(attribute_source(generated.read_text(), patch))
        py_compile.compile(str(generated), doraise=True)
        shutil.copyfile(generated, package / source)
        receipt[source] = hashlib.sha256(generated.read_bytes()).hexdigest()
    (root / "patched-files.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    main()
