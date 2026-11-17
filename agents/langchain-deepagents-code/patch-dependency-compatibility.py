#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Apply and verify the reviewed Deep Agents Code dependency compatibility contract."""

from __future__ import annotations

import base64
import csv
import hashlib
import importlib.metadata
import io
import json
import re
import sys
from pathlib import Path


WHEEL_SHA256 = "e3a4a9905540eaf87e4ec19b54f02cc791ba7cc02ca1af3f3173754af445e206"
METADATA_SHA256 = "4c7c41fab50ba2c85365179990bda77dcfe663ce55f294f7234b909d2ef40d89"

def dependency_overrides():
    """Read the same exact compatibility pins used to generate the lock."""
    overrides = {}
    for line in Path(__file__).with_name("dependency-overrides.in").read_text().splitlines():
        pin = line.partition("#")[0].strip()
        if not pin:
            continue
        name, separator, version = pin.partition("==")
        if (name not in {"filelock", "pillow"} or not separator
                or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version) or name in overrides):
            raise RuntimeError("Invalid managed dependency override")
        overrides[name] = version
    if set(overrides) != {"filelock", "pillow"}:
        raise RuntimeError("Managed dependency overrides are incomplete")
    return overrides


def patch_installed_dependency_metadata():
    """Patch only the reviewed wheel's two dependency ranges; preserve provenance."""
    overrides = dependency_overrides()
    replacements = {
        b"Requires-Dist: filelock<3.30,>=3.29.7\n": f"Requires-Dist: filelock=={overrides['filelock']}\n".encode(),
        b"Requires-Dist: pillow<13.0.0,>=12.3.0\n": f"Requires-Dist: pillow=={overrides['pillow']}\n".encode(),
        b"Requires-Dist: pillow<13.0.0,>=12.3.0; extra == 'media'\n": f"Requires-Dist: pillow=={overrides['pillow']}; extra == 'media'\n".encode(),
    }
    distribution = importlib.metadata.distribution("deepagents-code")
    if distribution.version != "0.1.87":
        raise RuntimeError("Dependency patch requires deepagents-code 0.1.87")
    for name, expected in overrides.items():
        if importlib.metadata.version(name) != expected:
            raise RuntimeError(f"Dependency patch requires {name}=={expected}")
    prefix = "deepagents_code-0.1.87.dist-info/"
    metadata_path = Path(distribution.locate_file(prefix + "METADATA"))
    record_path = metadata_path.with_name("RECORD")
    receipt_path = metadata_path.with_name("NEMOCLAW_DEPENDENCY_PATCH.json")
    for item in [metadata_path, record_path]:
        if item.is_symlink() or not item.is_file():
            raise RuntimeError("Dependency metadata is not a regular installed file")
    original = metadata_path.read_bytes()
    digest = lambda content: hashlib.sha256(content).hexdigest()
    if digest(original) != METADATA_SHA256:
        # Reverse the exact substitution to verify idempotence against upstream.
        restored = original
        for before, after in replacements.items():
            if restored.count(after) != 1:
                raise RuntimeError("Unreviewed downstream dependency metadata")
            restored = restored.replace(after, before)
        if digest(restored) != METADATA_SHA256:
            raise RuntimeError("Upstream dependency metadata differs from sealed wheel")
        original = restored
    patched = original
    for before, after in replacements.items():
        if patched.count(before) != 1:
            raise RuntimeError("Upstream dependency requirement changed")
        patched = patched.replace(before, after)
    receipt = {
        "schemaVersion": 1,
        "kind": "nemoclaw-deepagents-code-0187-dependency-compatibility",
        "upstreamWheelSha256": WHEEL_SHA256,
        "upstreamMetadataSha256": METADATA_SHA256,
        "patchedMetadataSha256": digest(patched),
        "overrides": overrides,
    }
    receipt_bytes = (json.dumps(receipt, sort_keys=True, indent=2) + "\n").encode()
    if receipt_path.is_symlink():
        raise RuntimeError("Dependency patch provenance is a symlink")
    if receipt_path.exists() and receipt_path.read_bytes() != receipt_bytes:
        raise RuntimeError("Dependency patch provenance changed")
    rows = list(csv.reader(io.StringIO(record_path.read_text())))
    if any(len(row) != 3 for row in rows):
        raise RuntimeError("Invalid installed RECORD")
    def record_entry(name, content):
        checksum = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=").decode()
        return [prefix + name, "sha256=" + checksum, str(len(content))]
    metadata_rows = [i for i, row in enumerate(rows) if row[0] == prefix + "METADATA"]
    if len(metadata_rows) != 1:
        raise RuntimeError("Ambiguous installed metadata RECORD")
    index = metadata_rows[0]
    if rows[index] not in [record_entry("METADATA", original), record_entry("METADATA", patched)]:
        raise RuntimeError("Installed metadata RECORD digest changed")
    rows[index] = record_entry("METADATA", patched)
    receipt_rows = [row for row in rows if row[0] == prefix + receipt_path.name]
    if receipt_rows and receipt_rows != [record_entry(receipt_path.name, receipt_bytes)]:
        raise RuntimeError("Dependency provenance RECORD changed")
    if not receipt_rows:
        rows.append(record_entry(receipt_path.name, receipt_bytes))
    stream = io.StringIO(newline="")
    csv.writer(stream, lineterminator="\n").writerows(rows)
    metadata_path.write_bytes(patched)
    receipt_path.write_bytes(receipt_bytes)
    record_path.write_text(stream.getvalue())
    return receipt

def check_nemoclaw_dependency_compatibility():
    """Exercise the actual 0.1.87 consumers against the downstream dependency set."""
    import asyncio
    import os
    import subprocess
    import tempfile
    import textwrap
    import unittest

    from PIL import Image
    from filelock import FileLock
    from deepagents_code import media_utils, thread_ownership


    class DownstreamCompatibility(unittest.TestCase):
        def setUp(self):
            self.temporary = tempfile.TemporaryDirectory()
            self.root = Path(self.temporary.name)

        def tearDown(self):
            thread_ownership.release_all()
            self.temporary.cleanup()

        def test_png_round_trip_uses_actual_media_consumer(self):
            image = self.root / "test.png"
            Image.new("RGB", (4, 3), "red").save(image)
            result = media_utils.get_image_from_path(image)
            self.assertIsNotNone(result)
            self.assertEqual(result.format, "png")
            self.assertEqual(base64.b64decode(result.base64_data), image.read_bytes())
            self.assertTrue(result.to_message_content()["image_url"]["url"].startswith("data:image/png;base64,"))

        def test_jpeg_and_corrupt_image_handling(self):
            image = self.root / "test.jpg"
            Image.new("RGB", (4, 3), "blue").save(image)
            self.assertEqual(media_utils.get_image_from_path(image).format, "jpeg")
            image.write_bytes(b"not an image")
            self.assertIsNone(media_utils.get_image_from_path(image))
            image.write_bytes(b"")
            self.assertIsNone(media_utils.get_image_from_path(image))

        def child_reservation(self, database):
            script = """
    import json,sys
    from pathlib import Path
    from deepagents_code.thread_ownership import try_acquire
    lease = try_acquire('requested-thread', db_path=Path(sys.argv[1]))
    print(json.dumps({'acquired': lease is not None}))
    if lease is not None: lease.release()
    """
            result = subprocess.run([sys.executable, "-I", "-c", textwrap.dedent(script), str(database)], check=True,
                                    capture_output=True, text=True, timeout=20, env={"PATH": os.environ["PATH"]})
            return json.loads(result.stdout)["acquired"]

        def test_thread_reservation_excludes_another_process_then_releases(self):
            database = self.root / "state.sqlite"
            lease = thread_ownership.try_acquire("requested-thread", db_path=database)
            self.assertIsNotNone(lease)
            self.assertEqual(lease.thread_id, "requested-thread")
            self.assertFalse(self.child_reservation(database))
            lease.release()
            self.assertTrue(self.child_reservation(database))

        def test_writer_fencing_rejects_a_rotated_token(self):
            database = self.root / "state.sqlite"
            lease = thread_ownership.try_acquire("requested-thread", db_path=database)
            original = lease.token
            async def scenario():
                async with thread_ownership.writer_guard("requested-thread", db_path=database, token=original):
                    pass
                await lease.rotate()
                with self.assertRaises(thread_ownership.ThreadOwnershipError):
                    async with thread_ownership.writer_guard("requested-thread", db_path=database, token=original):
                        pass
                async with thread_ownership.writer_guard("requested-thread", db_path=database, token=lease.token):
                    pass
            asyncio.run(scenario())

        def test_plugin_singleton_lock_constructor(self):
            file = str(self.root / ".mutation.lock")
            first = FileLock(file, is_singleton=True)
            self.assertIs(first, FileLock(file, is_singleton=True))
            with first:
                self.assertTrue(first.is_locked)
            self.assertFalse(first.is_locked)
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(DownstreamCompatibility)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        raise RuntimeError("NemoClaw downstream dependency compatibility checks failed")
    print(json.dumps({"kind": "nemoclaw-deepagents-code-downstream-compatibility", "schemaVersion": 1,
                      "testsRun": result.testsRun, "status": "passed", "versions": {
                          name: importlib.metadata.version(name) for name in ["deepagents-code", "pillow", "filelock"]
                      }}, sort_keys=True))


if __name__ == "__main__":
    if sys.argv[1:] == ["--dependency-metadata-only"]:
        patch_installed_dependency_metadata()
    elif sys.argv[1:] == ["--dependency-compatibility-check"]:
        check_nemoclaw_dependency_compatibility()
    else:
        raise SystemExit("Expected a dependency metadata or compatibility check mode")
