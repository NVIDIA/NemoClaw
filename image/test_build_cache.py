# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Opt-in regression for archived Fabric sources and Docker's Cargo target cache."""

import os
import re
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.environ.get("NEMOCLAW_TEST_IMAGE_CACHE") == "1", "requires Docker opt-in")
class FabricBuildCache(unittest.TestCase):
    def test_new_archive_cannot_reuse_an_older_core_api(self):
        source = (ROOT / "image/fabric/Dockerfile").read_text()
        rust = re.search(r"^ARG RUST_IMAGE=(.+)$", source, re.MULTILINE).group(1)
        stage = source.split("FROM base AS common-wheels\n", 1)[1].split("\nFROM ", 1)[0]
        mount = ""
        for options in re.findall(r"--mount=([^\s]+)", stage):
            fields = options.split(",")
            if "type=cache" in fields and "target=/src/fabric/target" in fields:
                # Exercise the actual policy without reading or changing an existing cache.
                fields = [field for field in fields if not field.startswith("id=")]
                fields.append("id=nemoclaw-cache-regression-" + uuid.uuid4().hex)
                mount = "--mount=" + ",".join(fields)
                break

        files = {
            "workspace/Cargo.toml": '[workspace]\nmembers = ["core", "caller"]\nresolver = "2"\n',
            "workspace/core/Cargo.toml": (
                '[package]\nname = "fixture-core"\nversion = "0.1.0"\nedition = "2021"\n'
            ),
            "workspace/caller/Cargo.toml": (
                '[package]\nname = "fixture-caller"\nversion = "0.1.0"\nedition = "2021"\n'
                '[dependencies]\nfixture-core = { path = "../core" }\n'
            ),
            "old/core/src/lib.rs": "pub fn original() -> u8 { 1 }\n",
            "old/caller/src/main.rs": "fn main() { assert_eq!(fixture_core::original(), 1); }\n",
            "new/core/src/lib.rs": ("pub fn original() -> u8 { 1 }\npub fn added() -> u8 { 2 }\n"),
            "new/caller/src/main.rs": "fn main() { assert_eq!(fixture_core::added(), 2); }\n",
        }
        dockerfile = f"""{source.splitlines()[0]}
FROM {rust} AS fixture
WORKDIR /src/fabric
COPY workspace/ ./
FROM fixture AS previous
COPY old/ ./
RUN --network=none {mount} \\
    touch -d @1789516800 core/src/lib.rs caller/src/main.rs \\
    && cargo run --offline --release --package fixture-caller \\
    && touch /previous-complete
FROM fixture AS current
COPY new/ ./
COPY --from=previous /previous-complete /previous-complete
RUN --network=none {mount} \\
    touch -d @1789516800 core/src/lib.rs && touch caller/src/main.rs \\
    && cargo run --offline --release --package fixture-caller
"""
        # The two stages model separate archive extractions at the same source path.
        # Only the caller is fresh, as when PyO3 forces the Python binding to rebuild.
        with tempfile.TemporaryDirectory(prefix="nemoclaw-cache-regression-") as directory:
            context = Path(directory)
            for name, content in {**files, "Dockerfile": dockerfile}.items():
                path = context / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            result = subprocess.run(
                [
                    "docker",
                    "buildx",
                    "build",
                    "--progress=plain",
                    "--output=type=cacheonly",
                    directory,
                ],
                capture_output=True,
                text=True,
                timeout=300,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
