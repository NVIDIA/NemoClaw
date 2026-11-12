// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Exercise the native producer's selection and public-package parity boundary. */
export function proveRealOpenClawWorkerArchiveSelection(options: {
  dist: string;
  tmp: string;
  timeoutMs: number;
  nodeExecutable: string;
}): void {
  const scratch = fs.mkdtempSync(path.join(options.tmp, "worker-selection-"));
  try {
    // Keep the caller's npm selection while ensuring its Node shebang uses the
    // reviewed executable supplied by the artifact harness.
    const nodeBin = path.join(scratch, "bin");
    fs.mkdirSync(nodeBin, { mode: 0o700 });
    fs.symlinkSync(options.nodeExecutable, path.join(nodeBin, "node"));
    const result = spawnSync(
      options.nodeExecutable,
      [
        "--input-type=module",
        "-e",
        `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const [dist, scratch] = process.argv.slice(1);
const packageRoot = path.dirname(dist);
const runtime = await import(pathToFileURL(path.join(dist, "gateway/worker-environments/runtime.js")).href);
const directory = path.join(dist, "worker-artifacts");
const names = fs.readdirSync(directory);
assert.equal(names.length, 1);
assert.equal(fs.existsSync(path.join(dist, "worker")), false);
const archive = path.join(directory, names[0]);
const hash = names[0].replace(/\\.tar\\.gz$/, "");
const cache = path.join(scratch, "cache");
const producer = runtime.createWorkerBundleProducer({ packageRoot, cacheDir: cache });
const artifact = await producer.prepare();
assert.equal(artifact.install, "bundle");
assert.equal(artifact.bundleHash, hash);
assert.equal(artifact.openclawVersion, "2026.10.5");
assert.equal(artifact.tarballPath, archive);
assert.equal(artifact.tarballBytes, fs.statSync(archive).size);
assert.equal(artifact.tarballSha256, createHash("sha256").update(fs.readFileSync(archive)).digest("hex"));
assert.equal(fs.existsSync(cache), false, "native selection rebuilt the packaged archive");
assert.deepEqual(await producer.prepare(), artifact);

const bad = path.join(scratch, "bad");
const badDir = path.join(bad, "dist/worker-artifacts");
fs.mkdirSync(badDir, { recursive: true });
fs.copyFileSync(archive, path.join(badDir, "0".repeat(64) + ".tar.gz"));
await assert.rejects(
  runtime.createWorkerBundleProducer({ packageRoot: bad, cacheDir: cache }).prepare(),
  /does not match its manifest hash/,
);
fs.copyFileSync(archive, path.join(badDir, names[0]));
await assert.rejects(
  runtime.createWorkerBundleProducer({ packageRoot: bad, cacheDir: cache }).prepare(),
  /exactly one regular archive/,
);
assert.equal(fs.existsSync(cache), false, "invalid archives triggered an unreviewed fallback");

// The native verifier obtains and checks the real public npm tarball. Patched
// gateway workers must not silently be replaced with unpatched registry bytes.
await assert.rejects(
  runtime.resolveWorkerNpmInstallationArtifact({ bundle: artifact, packageRoot }),
  /Published OpenClaw 2026\\.10\\.5 does not match the prepared worker bundle/,
);
`,
        options.dist,
        scratch,
      ],
      {
        encoding: "utf8",
        timeout: options.timeoutMs,
        env: {
          ...process.env,
          PATH: `${nodeBin}:${process.env.PATH ?? ""}`,
          HOME: scratch,
          OPENCLAW_STATE_DIR: path.join(scratch, ".openclaw"),
        },
      },
    );
    if (result.status !== 0) {
      throw new Error(`Native worker archive selection failed: ${result.error ?? result.stderr}`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Stage admitted worker bytes without changing OpenClaw's archive-selection layout. */
export function prepareRealOpenClawWorkerDirectory(options: {
  dist: string;
  tmp: string;
  timeoutMs: number;
}): { directory: string; archived: boolean; modifiedModules: string[] } {
  const { version } = JSON.parse(
    fs.readFileSync(path.join(options.dist, "..", "package.json"), "utf8"),
  ) as { version: string };
  const unpacked = path.join(options.dist, "worker");
  if (version !== "2026.10.5") {
    if (!fs.statSync(unpacked).isDirectory()) throw new Error("Missing unpacked worker directory");
    return {
      directory: unpacked,
      archived: false,
      modifiedModules: [path.join(unpacked, "worker.mjs")],
    };
  }
  const directory = fs.mkdtempSync(path.join(options.tmp, "worker-proof-"));
  fs.chmodSync(directory, 0o700);
  try {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import importlib.util, json, os, re, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("worker_archive", sys.argv[1])
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)
dist, stage = Path(sys.argv[2]), Path(sys.argv[3])
directory = dist / "worker-artifacts"
if directory.is_symlink() or not directory.is_dir() or os.path.lexists(dist / "worker"):
    raise ValueError("Unreviewed worker archive layout")
archives = list(directory.iterdir())
if len(archives) != 1 or not re.fullmatch(r"[a-f0-9]{64}[.]tar[.]gz", archives[0].name):
    raise ValueError("Expected one content-addressed worker archive")
files = archive.read_archive(archive.read_regular(archives[0], 40 * 1024 * 1024))
digest = archive.manifest_hash({name: archive.file_identity(data) for name, data in files.items()})
if archives[0].name != digest + ".tar.gz":
    raise ValueError("Worker archive does not match its native manifest")
inventory = json.loads(archive.read_regular(dist / "postinstall-inventory.json", 4 * 1024 * 1024))
if not isinstance(inventory, list) or any(not isinstance(item, str) for item in inventory) or inventory.count("dist/worker-artifacts/" + archives[0].name) != 1:
    raise ValueError("Worker archive is not uniquely owned by the postinstall inventory")
# read_archive admits only bounded, flat, unique regular artifacts. Publish the
# proof directory only after validating the complete canonical native manifest.
for name, data in files.items():
    descriptor = os.open(stage / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700)
    with os.fdopen(descriptor, "wb") as target:
        target.write(data)
print(json.dumps({"hash": digest, "modules": sorted(archive.MODULES)}))
`,
        path.resolve(import.meta.dirname, "../../scripts/lib/patch-openclaw-worker-archive.py"),
        options.dist,
        directory,
      ],
      {
        encoding: "utf8",
        timeout: options.timeoutMs,
      },
    );
    if (result.status !== 0) {
      throw new Error(`Could not stage reviewed worker archive: ${result.error ?? result.stderr}`);
    }
    const manifest = JSON.parse(result.stdout) as { modules: string[] };
    return {
      directory,
      archived: true,
      modifiedModules: manifest.modules.map((name) => path.join(directory, name)),
    };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
