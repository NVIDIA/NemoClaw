# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-FileCopyrightText: Copyright (C) 2026 MiaAI Lab (https://x.com/MiaAI_lab)
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Verify every packed row against the pinned safetensors, with bounded RAM.

Adapted from MiaAI Lab's files/build_ple_packed_table.py:
https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark
Revision: d03809008834124e80223c3482f2ddb59577a48f
Modified 2026-09-11: check shape, size, snapshot, and every packed row; emit a hash.
Attribution and license corrected 2026-09-15.
See AGPL-3.0-or-later.txt and NOTICE.md beside this file.
"""
import hashlib
import json
import os
import struct
import sys

import numpy as np

snapshot, prepared = sys.argv[1:]
index = json.load(open(os.path.join(snapshot, "model.safetensors.index.json")))["weight_map"]
prefix = "model.language_model.layers.1.ple.ple_embedding.ngram_embedding"
name = "language_model.model.layers.1.ple.ple_embedding.ngram_embedding.packed_u8"
metadata = json.load(open(os.path.join(prepared, name + ".json")))
assert metadata["snapshot"] == os.path.basename(os.path.normpath(snapshot))
assert metadata["num_shards"] == 128
assert metadata["codes_width"] == 80 and metadata["scales_width"] == 10
assert metadata["row_width"] == 90
assert metadata["total_rows"] == metadata["rows_per_shard"] * 128
headers = {}


def view(key, dtype, width):
    file = index[key]
    if file not in headers:
        with open(os.path.join(snapshot, file), "rb") as source:
            size = struct.unpack("<Q", source.read(8))[0]
            assert size < 32 * 1024 * 1024
            headers[file] = (json.loads(source.read(size)), size + 8)
    header, base = headers[file]
    tensor = header[key]
    assert tensor["dtype"] == dtype
    assert tensor["shape"] == [metadata["rows_per_shard"], width]
    start, end = tensor["data_offsets"]
    assert end - start == metadata["rows_per_shard"] * width
    return np.memmap(os.path.join(snapshot, file), dtype=np.uint8, mode="r",
                     offset=base + start, shape=tuple(tensor["shape"]))


digest = hashlib.sha256()
size = metadata["total_rows"] * 90
assert os.path.getsize(os.path.join(prepared, name)) == size
with open(os.path.join(prepared, name), "rb") as packed:
    for shard in range(128):
        codes = view(f"{prefix}.shard_{shard}.weight", "U8", 80)
        scales = view(f"{prefix}.shard_{shard}.weight_scale", "F8_E4M3", 10)
        for row in range(0, len(codes), 1 << 18):
            expected = np.concatenate([codes[row:row + (1 << 18)], scales[row:row + (1 << 18)]], axis=1).tobytes()
            actual = packed.read(len(expected))
            assert actual == expected, f"packed PLE differs at shard {shard}, row {row}"
            digest.update(actual)
    assert packed.read(1) == b""
print(json.dumps({"name": name, "size": size, "sha256": digest.hexdigest()}))
