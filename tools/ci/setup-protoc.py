# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import hashlib
import io
import json
import os
import pathlib
import urllib.request
import zipfile

root = pathlib.Path.cwd()
pin = json.loads((root / "versions.json").read_text())["platforms"][
    os.environ["TEST_PLATFORM"]
]["protoc"]
data = urllib.request.urlopen(pin["url"], timeout=120).read()
if hashlib.sha256(data).hexdigest() != pin["sha256"]:
    raise SystemExit("protoc checksum mismatch")
destination = root / ".tools/protoc"
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    archive.extractall(destination)
binary = destination / "bin" / ("protoc.exe" if os.name == "nt" else "protoc")
binary.chmod(0o755)
with open(os.environ["GITHUB_ENV"], "a") as output:
    output.write(f"PROTOC={binary}\n")
