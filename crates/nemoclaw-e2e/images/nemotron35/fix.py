# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Backport vLLM PR #64506, commit 510d15c49e9858814ca868c3dbf0344e3d3b42b5.
# Preserve the checkpoint field fallback for older Transformers versions.
from importlib.metadata import distribution
from pathlib import Path
import py_compile

path = Path(distribution("vllm").locate_file("vllm/model_executor/models/nano_nemotron_vl.py"))
old = '            vit_hidden_size = config.vit_hidden_size'
new = ('            vit_hidden_size = getattr(config, "vision_hidden_size", None)\n'
       '            if vit_hidden_size is None:\n'
       '                vit_hidden_size = config.vit_hidden_size')
source = path.read_text()
if source.count(old) != 1:
    raise SystemExit("Unexpected vLLM source; refusing to patch")
path.write_text(source.replace(old, new))
py_compile.compile(str(path), doraise=True)
