# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Verify the exact CI candidate completely before extracting any runtime file."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import shutil
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

HEAD = "47d890728482cca05e840edd27e33e3d495aeabf"
RUN = 34551706967
ARTIFACT = 10181796438
SIZE = 1099892587
SHA = "b6e3683f4248b62e6ba3594d8ecab11d6958a23f161b526a1d11ec07d146d6ed"
UPSTREAM = "2237be355906fbe6065ce1815711eee52b2d646e"
ADAPTER = "3f8f0b14af77dedee4504bc112869a90fe89b0c8f93c434d0f29313e74bfd1fd"


def digest(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_zip(file, size=SIZE, sha=SHA):
    require(
        file.stat().st_size == size and digest(file) == sha,
        "Complete candidate ZIP hash/size mismatch",
    )


def require(value, message):
    if not value:
        raise ValueError(message)


def save(file, value):
    with file.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, new_url):
        return None


def download(destination, *, artifact=ARTIFACT, run=RUN, head=HEAD, size=SIZE, sha=SHA):
    """Keep authentication on api.github.com; the signed redirect stays in memory."""
    endpoint = (
        f"https://api.github.com/repos/NVIDIA/NemoClaw/actions/artifacts/{artifact}"
    )
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "NemoClaw-CI"}
    token = os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = "Bearer " + token
    try:
        with urllib.request.urlopen(
            urllib.request.Request(endpoint, headers=headers), timeout=30
        ) as response:
            metadata = json.load(response)
        require(
            metadata["id"] == artifact
            and metadata["size_in_bytes"] == size
            and metadata["digest"] == "sha256:" + sha
            and not metadata["expired"]
            and metadata["workflow_run"]["id"] == run
            and metadata["workflow_run"]["head_sha"] == head,
            "The GitHub artifact identity differs from the reviewed candidate",
        )
        opener = urllib.request.build_opener(NoRedirect())
        try:
            opener.open(
                urllib.request.Request(endpoint + "/zip", headers=headers), timeout=30
            )
            raise ValueError("The artifact API did not return its expected redirect")
        except urllib.error.HTTPError as error:
            require(error.code == 302, "The artifact redirect request failed")
            location = error.headers.get("Location", "")
        require(
            urllib.parse.urlsplit(location).scheme == "https",
            "The artifact redirect is not HTTPS",
        )
        started = time.monotonic()
        count = 0
        with (
            urllib.request.urlopen(location, timeout=90) as response,
            destination.open("xb") as output,
        ):
            while block := response.read(8 * 1024 * 1024):
                count += len(block)
                require(
                    count <= size and time.monotonic() - started <= 900,
                    "The candidate download exceeded its byte/time bound",
                )
                output.write(block)
        require(count == size, "The candidate download was incomplete")
    except (urllib.error.URLError, TimeoutError) as error:
        # urllib exceptions can contain signed URLs. Keep only their type.
        raise RuntimeError(
            "Candidate transport failed: " + type(error).__name__
        ) from None


def safe_name(name, root_allowed=False):
    parts = PurePosixPath(name).parts
    require(
        isinstance(name, str)
        and "\\" not in name
        and ":" not in name
        and not name.startswith("/")
        and ".." not in parts
        and (name == "runtime" and root_allowed or name.startswith("runtime/"))
        and name.rstrip("/") == "/".join(parts),
        "Unsafe candidate archive path",
    )
    return name.rstrip("/")


def document(archive, suffix, maximum=256 * 1024 * 1024):
    matches = [
        entry for entry in archive.infolist() if entry.filename.endswith("/" + suffix)
    ]
    require(
        len(matches) == 1 and matches[0].file_size <= maximum,
        "Missing, duplicate or oversized candidate metadata: " + suffix,
    )
    data = archive.read(matches[0])
    return matches[0].filename, data, json.loads(data)


def documents(archive, *, head=None, adapter=None):
    head = HEAD if head is None else head
    adapter = ADAPTER if adapter is None else adapter
    name, _, candidate = document(archive, "runtime-candidate.json", 65536)
    require(
        candidate["controllerSource"] == head
        and candidate["upstreamCommit"] == UPSTREAM
        and candidate["status"] == "candidate-bytes-exported"
        and candidate["completeByteInventory"] is True
        and all(
            candidate[key] is False
            for key in [
                "runtimeExecutionQualified",
                "installedAcceptance",
                "activationAllowed",
            ]
        ),
        "The candidate receipt has an unexpected identity or qualification claim",
    )
    _, raw, inventory = document(archive, "payload-inventory.json")
    require(
        hashlib.sha256(raw).hexdigest() == candidate["inventorySha256"],
        "Candidate inventory hash mismatch",
    )
    for suffix, key in [
        ("official-runtime-build.json", "buildReceiptSha256"),
        ("native-adaptation.json", "adaptationReceiptSha256"),
    ]:
        _, raw, value = document(archive, suffix)
        require(
            hashlib.sha256(raw).hexdigest() == candidate[key],
            "Candidate producer receipt hash mismatch",
        )
        if suffix == "native-adaptation.json":
            adaptation = value
        else:
            require(
                value["status"] == "runtime-provisioned"
                and value["sourceUnchanged"] is True
                and value["fallbacks"] == [],
                "The official production graph did not complete unchanged",
            )
    require(
        candidate["startupAdapterSha256"] == adapter,
        "The candidate has the wrong reviewed startup adapter",
    )
    require(
        len(inventory["files"]) <= 500000 and len(inventory["directories"]) <= 500000,
        "Candidate inventory exceeds its bound",
    )
    files = {safe_name("runtime/" + row["path"]): row for row in inventory["files"]}
    directories = {
        safe_name("runtime/" + value, True) for value in inventory["directories"]
    }
    require(
        len(files) == len(inventory["files"])
        and len(directories) == len(inventory["directories"])
        and not set(files) & directories,
        "Duplicate candidate inventory paths",
    )
    all_names = set(files) | directories
    require(
        len({name.casefold() for name in all_names}) == len(all_names),
        "Case-colliding Windows candidate paths",
    )
    links = {}
    for name, row in files.items():
        if "linkTarget" in row:
            target = row["linkTarget"]
            require(
                isinstance(target, str)
                and "\\" not in target
                and ":" not in target
                and not target.startswith("/"),
                "Unsafe runtime link target",
            )
            resolved = posixpath.normpath(
                posixpath.join(posixpath.dirname(name), target)
            )
            require(
                resolved in all_names and resolved.startswith("runtime/"),
                "Runtime link leaves or misses the inventory",
            )
            links[name] = resolved
    for name in all_names:
        require(
            not any(
                parent.as_posix() in links for parent in PurePosixPath(name).parents
            ),
            "Archive entry traverses a link parent",
        )
    for name, target in links.items():
        visited = {name}
        while target in links:
            require(target not in visited, "Cyclic runtime link")
            visited.add(target)
            target = links[target]
    for row in adaptation["files"]:
        recorded = files["runtime/" + row["path"]]
        require(
            recorded.get("sha256") == row["sha256"]
            and recorded.get("bytes") == row["bytes"],
            "Adapted metadata differs from candidate inventory",
        )
    hooks = [
        row
        for row in adaptation["files"]
        if row["path"].endswith("/nemoclaw_native_windows.py")
    ]
    require(
        len(hooks) == 3 and all(row["sha256"] == adapter for row in hooks),
        "Candidate startup hooks differ",
    )
    source = candidate["archive"]
    require(
        PurePosixPath(source["file"]).name == source["file"],
        "Invalid nested archive name",
    )
    receipt_name, _, _ = document(archive, "runtime-candidate.json", 65536)
    tar_name = posixpath.dirname(receipt_name) + "/" + source["file"]
    require(
        archive.getinfo(tar_name).file_size == source["bytes"],
        "Nested archive size mismatch",
    )
    return candidate, inventory, files, directories, links, tar_name


class HashedReader:
    def __init__(self, stream):
        self.stream, self.hash, self.bytes = stream, hashlib.sha256(), 0

    def read(self, size=-1):
        data = self.stream.read(size)
        self.hash.update(data)
        self.bytes += len(data)
        return data


def verify_members(archive, details):
    candidate, _, files, directories, links, tar_name = details
    seen, total = set(), 0
    with archive.open(tar_name) as source:
        reader = HashedReader(source)
        with tarfile.open(fileobj=reader, mode="r|gz") as tar:
            for member in tar:
                name = safe_name(member.name, True)
                require(name not in seen, "Duplicate nested archive entry")
                seen.add(name)
                if member.isdir():
                    require(name in directories, "Unlisted candidate directory")
                elif member.issym():
                    require(
                        name in links and member.linkname == files[name]["linkTarget"],
                        "Changed candidate link",
                    )
                else:
                    row = files.get(name, {})
                    require(
                        member.isfile()
                        and name not in links
                        and member.size == row.get("bytes"),
                        "Changed candidate file size/type",
                    )
                    total += member.size
                    require(total <= 8 * 1024**3, "Candidate expands beyond its bound")
                    require(
                        hashlib.file_digest(
                            tar.extractfile(member), "sha256"
                        ).hexdigest()
                        == row["sha256"],
                        "Candidate file hash mismatch: " + name,
                    )
        while reader.read(1024 * 1024):
            pass
        require(
            reader.bytes == candidate["archive"]["bytes"]
            and reader.hash.hexdigest() == candidate["archive"]["sha256"],
            "Nested archive digest mismatch",
        )
    require(
        seen == set(files) | directories,
        "Candidate tar membership differs from inventory",
    )
    return total


def extract_verified(archive, details, destination, *, created=None):
    require(
        not destination.exists() and not destination.is_symlink(),
        "The candidate extraction root must be fresh",
    )
    _, _, files, directories, links, tar_name = details
    all_names = set(files) | directories
    destination.mkdir()
    if created is not None:
        created(destination)
    for name in sorted(directories, key=lambda value: (value.count("/"), value)):
        (destination / Path(*PurePosixPath(name).parts[1:])).mkdir(exist_ok=True)
    with (
        archive.open(tar_name) as source,
        tarfile.open(fileobj=source, mode="r|gz") as tar,
    ):
        for member in tar:
            name = safe_name(member.name, True)
            require(name in all_names, "An extraction entry changed after verification")
            if not member.isfile():
                require(
                    member.isdir()
                    and name in directories
                    or member.issym()
                    and name in links,
                    "An extraction entry changed type after verification",
                )
                continue
            require(
                name in files
                and name not in links
                and member.size == files[name]["bytes"],
                "An extraction file changed type or size after verification",
            )
            target = destination / Path(*PurePosixPath(name).parts[1:])
            with tar.extractfile(member) as incoming, target.open("xb") as output:
                shutil.copyfileobj(incoming, output, 1024 * 1024)
            require(
                digest(target) == files[member.name]["sha256"],
                "Extracted candidate file changed",
            )
    for name, resolved in links.items():
        target = destination / Path(*PurePosixPath(name).parts[1:])
        final = resolved
        while final in links:
            final = links[final]
        target.symlink_to(
            files[name]["linkTarget"], target_is_directory=final in directories
        )
    for name in links:
        target = destination / Path(*PurePosixPath(name).parts[1:])
        require(
            target.resolve(strict=True).is_relative_to(destination.resolve()),
            "Extracted runtime link escaped",
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zip", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--source-archive", type=Path, required=True)
    args = parser.parse_args()
    require(
        os.name == "nt" and os.environ.get("GITHUB_ACTIONS") == "true",
        "Candidate staging requires disposable Windows CI",
    )
    args.output.mkdir(parents=True)
    if not args.zip.exists():
        download(args.zip)
    verify_zip(args.zip)
    save(
        args.output / "zip-verification.json",
        {
            "artifactId": ARTIFACT,
            "runId": RUN,
            "head": HEAD,
            "bytes": SIZE,
            "sha256": SHA,
            "completeZipVerified": True,
        },
    )
    with zipfile.ZipFile(args.zip) as archive:
        require(
            len(archive.namelist()) == len(set(archive.namelist())),
            "Duplicate outer archive entries",
        )
        details = documents(archive)
        total = verify_members(archive, details)
        candidate, inventory, files, directories, links, _ = details
        save(args.output / "runtime-candidate.json", candidate)
        save(
            args.output / "link-inventory.json",
            {
                "links": [
                    {
                        "path": name,
                        "target": files[name]["linkTarget"],
                        "resolved": target,
                    }
                    for name, target in links.items()
                ]
            },
        )
        save(
            args.output / "archive-verification.json",
            {
                "head": HEAD,
                "zipSha256": SHA,
                "archive": candidate["archive"],
                "inventorySha256": candidate["inventorySha256"],
                "files": len(files),
                "directories": len(directories),
                "links": len(links),
                "logicalBytes": total,
                "completeNestedArchiveVerified": True,
                "everyInventoriedFileVerified": True,
                "runtimeExecuted": False,
                "installedAcceptance": False,
            },
        )
        extract_verified(archive, details, args.runtime_root)
        spec = importlib.util.spec_from_file_location(
            "official_inventory",
            Path(__file__).with_name("official-runtime-inventory.py"),
        )
        owner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(owner)
        source_count = owner.verify_official_source(
            args.runtime_root, args.source_archive
        )
        require(
            source_count == candidate["sourceFilesVerified"],
            "The independently verified original source count differs",
        )
        save(
            args.output / "extraction.json",
            {
                "runtimeRoot": str(args.runtime_root),
                "allFilesRehashed": True,
                "allLinksContained": True,
                "originalSourceFilesVerified": source_count,
                "runtimeExecuted": False,
            },
        )


if __name__ == "__main__":
    main()
