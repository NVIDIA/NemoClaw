#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Exercise the packaged upstream preparer and verifier with tiny real tensors."""
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest

PREFIX = "model.language_model.layers.1.ple.ple_embedding.ngram_embedding"
PACKED = "language_model.model.layers.1.ple.ple_embedding.ngram_embedding.packed_u8"
SOURCE = Path("/opt/nemoclaw/source")


class PackedPLE(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.snapshot = Path(self.temp.name) / "pinned-model-fixture"
        self.output = Path(self.temp.name) / "prepared"
        self.snapshot.mkdir()
        self.output.mkdir()
        tensors, index, data, packed = {}, {}, bytearray(), bytearray()
        for shard in range(128):
            codes = bytes((shard + n) % 256 for n in range(3 * 80))
            scales = bytes((shard * 7 + n) % 256 for n in range(3 * 10))
            for suffix, value, width, dtype in [
                ("weight", codes, 80, "U8"),
                ("weight_scale", scales, 10, "F8_E4M3"),
            ]:
                key = f"{PREFIX}.shard_{shard}.{suffix}"
                tensors[key] = {"dtype": dtype, "shape": [3, width],
                                "data_offsets": [len(data), len(data) + len(value)]}
                index[key] = "fixture.safetensors"
                data.extend(value)
            for row in range(3):
                packed.extend(codes[row * 80:(row + 1) * 80])
                packed.extend(scales[row * 10:(row + 1) * 10])
        header = json.dumps(tensors).encode()
        (self.snapshot / "fixture.safetensors").write_bytes(struct.pack("<Q", len(header)) + header + data)
        (self.snapshot / "model.safetensors.index.json").write_text(json.dumps({"weight_map": index}))
        self.expected = bytes(packed)
        subprocess.run(["python3", str(SOURCE / "recipe/files/build_ple_packed_table.py"),
                        str(self.snapshot), str(self.output)], check=True, capture_output=True)

    def verify(self):
        return subprocess.run(["python3", str(SOURCE / "verify_packed.py"),
                               str(self.snapshot), str(self.output)], capture_output=True)

    def test_complete_preparation_matches_every_source_row(self):
        result = self.verify()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        receipt = json.loads(result.stdout)
        self.assertEqual((self.output / PACKED).read_bytes(), self.expected)
        self.assertEqual(receipt, {"name": PACKED, "size": len(self.expected),
                                   "sha256": hashlib.sha256(self.expected).hexdigest()})

    def test_last_shard_corruption_with_correct_size_is_rejected(self):
        packed = self.output / PACKED
        data = bytearray(packed.read_bytes())
        data[-1] ^= 1
        packed.write_bytes(data)
        result = self.verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(packed.read_bytes(), data)

    def test_interrupted_preparation_is_not_complete(self):
        packed = self.output / PACKED
        packed.write_bytes(self.expected[:-1])
        result = self.verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")

    def test_missing_model_shard_does_not_produce_a_receipt(self):
        path = self.snapshot / "model.safetensors.index.json"
        index = json.loads(path.read_text())
        del index["weight_map"][f"{PREFIX}.shard_127.weight_scale"]
        path.write_text(json.dumps(index))
        result = self.verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")

    def test_wrong_snapshot_provenance_is_rejected(self):
        path = self.output / (PACKED + ".json")
        metadata = json.loads(path.read_text())
        metadata["snapshot"] = "another-revision"
        path.write_text(json.dumps(metadata))
        self.assertNotEqual(self.verify().returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
