# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Generate discovery metadata from the checksum-pinned Fabric archive.

Usage: python3 image/fabric/catalog.py PATH_TO_FABRIC_TAR_GZ [--check]
No adapter code is imported or executed.
"""

import argparse
import copy
import hashlib
import io
import json
import re
import tarfile
from pathlib import Path


def entry(path, raw):
    descriptor = json.loads(raw)
    if descriptor.get("contract_version") != "fabric.adapter/v1alpha2" or not all(
        isinstance(descriptor.get(key), str) and descriptor[key]
        for key in ("adapter_id", "adapter_kind")
    ):
        raise ValueError(f"invalid adapter descriptor: {path}")
    return {
        "harness": Path(path).name.removesuffix(".fabric-adapter.json"),
        "adapter_id": descriptor["adapter_id"],
        "adapter_kind": descriptor["adapter_kind"],
        "source": path,
        "descriptor": descriptor,
    }


def collect(raw):
    adapters = []
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        for member in sorted(archive.getmembers(), key=lambda item: item.name):
            path = member.name.partition("/")[2]
            if (
                member.isfile()
                and path.startswith("adapters/")
                and path.endswith(".fabric-adapter.json")
            ):
                adapters.append(entry(path, archive.extractfile(member).read()))
    return adapters


def image_adapters(adapters, harness, package):
    """Select descriptor records actually installed by the image recipe."""
    from patch_hermes import patch_descriptor as patch_hermes_descriptor
    from patch_pi import patch_descriptor as patch_pi_descriptor

    selected = []
    for adapter in adapters:
        source = adapter["source"]
        if not (
            (package and source.startswith(f"adapters/python/{package}/"))
            or source == f"image/fabric/{harness}.fabric-adapter.json"
            or (harness == "pi" and source.startswith("adapters/typescript/pi/"))
        ):
            continue
        adapter = copy.deepcopy(adapter)
        if source.startswith("adapters/python/hermes/"):
            patch_hermes_descriptor(adapter["descriptor"])
        elif source.startswith("adapters/typescript/pi/"):
            patch_pi_descriptor(adapter["descriptor"])
        selected.append(adapter)
    if not selected:
        raise ValueError(f"image recipe has no adapter descriptors: {harness}")
    return selected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    dockerfile = (root / "image/fabric/Dockerfile").read_text()
    revision = re.search(r"^ARG FABRIC_REVISION=(\w+)$", dockerfile, re.M)[1]
    checksum = re.search(r"^ARG FABRIC_SHA256=(\w+)$", dockerfile, re.M)[1]
    raw = args.archive.read_bytes()
    if hashlib.sha256(raw).hexdigest() != checksum:
        raise ValueError("Fabric archive does not match Dockerfile checksum")
    adapters = collect(raw)
    for path in sorted((root / "image/fabric").glob("*.fabric-adapter.json")):
        adapters.append(entry(str(path.relative_to(root)), path.read_bytes()))
    catalog = {
        "schema_version": 1,
        "fabric_revision": revision,
        "source_sha256": checksum,
        "adapters": adapters,
    }
    recipes = re.search(
        r'variable "HARNESSES" \{(.*?)\n\}', (root / "docker-bake.hcl").read_text(), re.S
    )[1]
    harnesses = re.findall(
        r'^\s*([a-z][a-z-]+)\s*=\s*\{[^}\n]*adapter\s*=\s*"([^"]*)"', recipes, re.M
    )
    image_catalogs = {
        harness: json.dumps(
            {**catalog, "adapters": image_adapters(adapters, harness, package)},
            separators=(",", ":"),
        )
        for harness, package in harnesses
    }
    overrides = {
        "target": {
            harness: {"labels": {"io.nemoclaw.fabric.catalog": image_catalogs[harness]}}
            for harness, _ in harnesses
        }
    }
    for filename, value in [
        ("image/fabric/catalog.json", catalog),
        ("docker-bake.override.json", overrides),
    ]:
        path = root / filename
        text = json.dumps(value, indent=2, sort_keys=True) + "\n"
        if args.check:
            if path.read_text() != text:
                raise ValueError(f"stale generated catalog: {path}")
        else:
            path.write_text(text)


if __name__ == "__main__":
    main()
