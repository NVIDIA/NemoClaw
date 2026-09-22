#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Cargo prepares documentation; the pinned Fern CLI validates and publishes it."""
import argparse
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STAGING = "nvidia-nemoclaw-staging.docs.buildwithfern.com/nemoclaw"
PUBLIC = "nvidia-nemoclaw.docs.buildwithfern.com/nemoclaw"


def validate_revision(revision):
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("main documentation source requires a full lowercase 40-hex commit")


def adapt_main_snippets(root):
    # Main's absolute snippet paths are relative to its original fern folder.
    for path in (root / "docs").rglob("*.mdx"):
        source = path.read_text()
        adapted = source.replace('src="/../docs/', 'src="/_main/docs/')
        if adapted != source:
            path.write_text(adapted)


def prepare_main():
    revision = json.loads((ROOT / "fern/main-source.json").read_text())["revision"]
    validate_revision(revision)
    dependency_root = ROOT / "tools/docs/main"
    identity = {
        "revision": revision,
        "dependencies": hashlib.sha256((dependency_root / "package-lock.json").read_bytes()).hexdigest(),
        "format": 2,
    }
    destination = ROOT / "fern/_main"
    stamp = destination / ".source.json"
    if not stamp.is_file() or json.loads(stamp.read_text()) != identity:
        exists = subprocess.run(["git", "cat-file", "-e", f"{revision}^{{commit}}"], cwd=ROOT, capture_output=True)
        if exists.returncode:
            subprocess.run(["git", "fetch", "--no-tags", "--depth=1", "origin", revision], cwd=ROOT, check=True)
        archive = subprocess.check_output([
            "git", "archive", revision, "LICENSE", "docs", "fern",
            "scripts/generate-starter-prompt.mts", "scripts/sync-agent-variant-docs.mts",
            "scripts/check-docs-published-routes.mts",
        ], cwd=ROOT)
        with tempfile.TemporaryDirectory(dir=ROOT / "fern") as temporary:
            staging = Path(temporary)
            with tarfile.open(fileobj=io.BytesIO(archive)) as source:
                source.extractall(staging, filter="data")
            for name in ("package.json", "package-lock.json"):
                shutil.copyfile(dependency_root / name, staging / name)
            subprocess.run(["npm.cmd" if os.name == "nt" else "npm", "ci", "--ignore-scripts", "--prefix", str(staging)], check=True)
            for script in ("generate-starter-prompt", "sync-agent-variant-docs"):
                run_main_script(staging, script)
            adapt_main_snippets(staging)
            (staging / ".source.json").write_text(json.dumps(identity, indent=2) + "\n")
            if destination.exists():
                shutil.rmtree(destination)
            # Keep TemporaryDirectory's own root in place for reliable cleanup.
            destination.mkdir()
            for child in staging.iterdir():
                shutil.move(str(child), destination / child.name)
    for script in ("generate-starter-prompt", "sync-agent-variant-docs"):
        run_main_script(destination, script, "--check")
    run_main_script(destination, "check-docs-published-routes")
    print(f"Main documentation prepared from {revision}.")


def run_main_script(directory, script, *arguments):
    result = subprocess.run(["node", f"scripts/{script}.mts", *arguments], cwd=directory, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)


def run_fern(arguments, capture=False, directory=None):
    config = json.loads((ROOT / "fern/fern.config.json").read_text())
    return subprocess.run(
        ["npx.cmd" if os.name == "nt" else "npx", "--yes", f"fern-api@{config['version']}", *arguments],
        cwd=directory or ROOT / "fern", text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.STDOUT if capture else None,
        check=not capture,
    )


def prepare():
    prepare_main()
    for arguments in (("schema", "--check"), ("docs",), ("docs", "--check")):
        subprocess.run(
            ["cargo", "run", "--locked", "-p", "nemoclaw-build", "--", *arguments],
            cwd=ROOT, check=True,
        )
    validate_v1()
    # Main keeps its existing route checker; Fern's stricter rule reports legacy
    # Markdown-download URLs and relative component links as broken.
    run_fern(["check", "--local"])


def validate_v1():
    source = ROOT / "fern"
    config = json.loads(subprocess.check_output([
        "node", "-e",
        "const fs = require('node:fs'); const {createRequire} = require('node:module'); "
        "const yaml = createRequire(process.argv[1])('yaml'); "
        "console.log(JSON.stringify(yaml.parse(fs.readFileSync(process.argv[2], 'utf8'))));",
        str(source / "_main/package.json"), str(source / "docs.yml"),
    ], text=True))
    config["versions"] = [version for version in config["versions"] if version["slug"] == "v1"]
    if len(config["versions"]) != 1:
        raise ValueError("Fern must define exactly one v1 version")
    for legacy_setting in ("redirects", "css", "experimental", "js"):
        config.pop(legacy_setting, None)
    config["logo"]["href"] = "/nemoclaw/v1/overview"
    (ROOT / ".build").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=ROOT / ".build") as temporary:
        destination = Path(temporary) / "fern"
        destination.mkdir()
        shutil.copyfile(source / "fern.config.json", destination / "fern.config.json")
        shutil.copytree(source / "_generated", destination / "_generated")
        shutil.copytree(source / "assets", destination / "assets")
        (destination / "docs.yml").write_text(json.dumps(config, indent=2) + "\n")
        run_fern(["check", "--local", "--strict-broken-links"], directory=destination)


def preview_url(identifier):
    if not re.fullmatch(r"nemoclaw-v1(?:-[a-z0-9]+)*", identifier):
        raise ValueError("preview ID must be nemoclaw-v1 or start with nemoclaw-v1- and use lowercase words/numbers")
    return f"https://nvidia-preview-{identifier}.docs.buildwithfern.com/nemoclaw"


def publish_preview(identifier):
    expected = preview_url(identifier)
    prepare()
    result = run_fern(
        ["generate", "--docs", "--instance", STAGING, "--preview", "--id", identifier], capture=True,
    )
    print(result.stdout, end="")
    if result.returncode:
        raise RuntimeError("Fern preview publication failed")
    match = re.search(r"Published docs to (https://[^\s\x1b]+)", result.stdout)
    if not match or not (match[1] == expected or match[1].startswith(expected + "/")):
        raise RuntimeError("Fern did not report the expected v1 preview URL")
    return match[1]


def publish_public():
    if os.environ.get("FERN_V1_PUBLIC_ENABLED") != "true":
        raise ValueError("set FERN_V1_PUBLIC_ENABLED=true only after coordinating shared-site publication")
    # Check the release identity before compiling, validating, or using a Fern token.
    tag = os.environ.get("GITHUB_REF_NAME", "")
    if os.environ.get("GITHUB_REF_TYPE") != "tag" or not re.fullmatch(r"v1\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", tag):
        raise ValueError("public publication requires a v1 release tag")
    tagged = subprocess.check_output(["git", "rev-parse", f"{tag}^{{commit}}"], cwd=ROOT).strip()
    current = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).strip()
    if tagged != current:
        raise ValueError("public publication must run from the tagged commit")
    subprocess.run(["git", "fetch", "--no-tags", "origin", "v1"], cwd=ROOT, check=True)
    subprocess.run(["git", "merge-base", "--is-ancestor", "HEAD", "origin/v1"], cwd=ROOT, check=True)
    prepare()
    run_fern(["generate", "--docs", "--instance", PUBLIC])


def delete_preview(identifier):
    result = run_fern(["docs", "preview", "delete", preview_url(identifier)], capture=True)
    print(result.stdout, end="")
    if result.returncode and "Domain not registered" not in result.stdout.splitlines():
        raise RuntimeError("Fern preview deletion failed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check", help="generate, check schema freshness, and validate Fern without publication")
    sub.add_parser("dev", help="prepare and start Fern's local server; regenerate after source edits")
    for name in ("preview", "delete"):
        sub.add_parser(name).add_argument("--id", required=True)
    sub.add_parser("public", help="publish main and v1 versions from a tagged v1 release")
    args = parser.parse_args()
    if args.command == "check":
        prepare()
    elif args.command == "dev":
        prepare()
        run_fern(["docs", "dev"])
    elif args.command == "preview":
        url = publish_preview(args.id)
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                output.write(f"preview_url={url}\n")
    elif args.command == "delete":
        delete_preview(args.id)
    else:
        publish_public()


if __name__ == "__main__":
    main()
