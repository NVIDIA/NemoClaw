// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Reuse the repository's pinned stopped-state helper runtime. No workload image executes here.
export const MANAGED_STATE_COPY_IMAGE =
  "node:24.18.1-trixie-slim@sha256:ac39e4b5fcb2b1b34b20364fd58b2e898f3bb80731ee6f62a7536f9df3d6aadc";

/** Runs only inside the isolated helper, with a read-only source volume. */
export function managedStateVolumeCopyProgram(): string {
  return String.raw`
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const source = "/source";
const destination = "/destination";
function validateTree(root) {
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory)) {
      const name = path.join(directory, entry);
      const stat = fs.lstatSync(name);
      if (stat.isDirectory()) walk(name);
      else if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("unsupported state entry");
    }
  };
  if (!fs.lstatSync(root).isDirectory()) throw new Error("invalid state root");
  walk(root);
}
async function digest(root) {
  const hash = crypto.createHash("sha256");
  const tar = spawn("/bin/tar", ["--sort=name", "--format=pax",
    "--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime", "--acls", "--xattrs", "--numeric-owner",
    "--sparse", "-cf", "-", "-C", root, "."], { stdio: ["ignore", "pipe", "ignore"] });
  tar.stdout.on("data", (chunk) => hash.update(chunk));
  await new Promise((resolve, reject) => {
    tar.once("error", reject);
    tar.once("close", (code) => code === 0 ? resolve() : reject(new Error("state archive failed")));
  });
  return hash.digest("hex");
}
(async () => {
  validateTree(source);
  if (fs.readdirSync(destination).length !== 0) throw new Error("destination is not empty");
  const before = await digest(source);
  execFileSync("/bin/cp", ["--archive", "--reflink=auto", "--", source + "/.", destination],
    { stdio: "ignore" });
  validateTree(destination);
  const after = await digest(source);
  const copied = await digest(destination);
  if (before !== after || before !== copied) throw new Error("state copy verification failed");
  process.stdout.write(JSON.stringify({ schemaVersion: 1, sha256: copied }) + "\n");
})().catch(() => { process.stderr.write("Managed state copy failed; original retained.\n"); process.exitCode = 1; });
`;
}
