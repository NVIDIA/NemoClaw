// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function fail(message: string): never {
  throw new Error(`Windows OpenClaw packager: ${message}`);
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function relativeRegularFile(root: string, value: string, label: string): string {
  const normalized = value.replaceAll("/", path.sep);
  if (path.isAbsolute(normalized) || normalized.split(path.sep).includes("..")) {
    fail(`${label} must be a relative path`);
  }
  const file = fs.realpathSync.native(path.join(root, normalized));
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || !fs.statSync(file).isFile()) {
    fail(`${label} must resolve to a regular file under the artifact root`);
  }
  return file;
}

const [rootArgument, archiveArgument, version, nodeRelative, entryRelative] = process.argv.slice(2);
if (!rootArgument || !archiveArgument || !version || !nodeRelative || !entryRelative) {
  fail("usage: <root> <archive.zip> <version> <node-relative> <entry-relative>");
}
if (!/^[0-9]+(?:[.][0-9]+){2,3}(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
  fail("version is invalid");
}
const root = fs.realpathSync.native(rootArgument);
if (!fs.statSync(root).isDirectory()) fail("artifact root must be a directory");
const archive = path.resolve(archiveArgument);
if (path.extname(archive).toLowerCase() !== ".zip" || !path.basename(archive).includes(version)) {
  fail("archive must be a versioned .zip path");
}
if (fs.existsSync(archive)) fail("archive already exists");
const nodePath = relativeRegularFile(root, nodeRelative, "Node executable");
const entryPath = relativeRegularFile(root, entryRelative, "OpenClaw entrypoint");
const systemRoot = process.env.SystemRoot;
if (!systemRoot) fail("SystemRoot is unavailable");
const tar = path.join(systemRoot, "System32", "tar.exe");
const result = spawnSync(tar, ["-a", "-c", "-f", archive, "-C", root, "."], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
if (result.status !== 0) {
  fs.rmSync(archive, { force: true });
  fail(`archive creation failed: ${result.stderr.trim()}`);
}
const manifest = {
  schemaVersion: 1,
  name: "openclaw",
  version,
  platform: "windows",
  architecture:
    process.env.PROCESSOR_ARCHITEW6432?.toLowerCase() === "arm64" ||
    /\b(?:arm64|armv8|aarch64)\b/iu.test(process.env.PROCESSOR_IDENTIFIER ?? "")
      ? "arm64"
      : process.arch,
  archive: path.basename(archive),
  archiveSha256: sha256(archive),
  nodeRelativePath: nodeRelative.replaceAll("\\", "/"),
  nodeSha256: sha256(nodePath),
  entryRelativePath: entryRelative.replaceAll("\\", "/"),
  entrySha256: sha256(entryPath),
} as const;
const manifestPath = archive.replace(/[.]zip$/iu, ".manifest.json");
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(`${JSON.stringify({ archive, manifestPath, ...manifest }, null, 2)}\n`);
