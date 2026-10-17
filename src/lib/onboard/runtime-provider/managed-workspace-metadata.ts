// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeProviderPrivilegedSandboxCommandResult } from "./contract";

type Workspace = { readonly uid: number; readonly gid: number; readonly mode: number };
type Observation = Workspace & {
  readonly dev: number;
  readonly ino: number;
  readonly mtime: number;
};

// Read metadata only. The root-owned parent prevents the workload from replacing
// /sandbox between this observation and the directory-only engine archive copy.
const INSPECT_WORKSPACE = `
const fs = require('node:fs');
const parent = fs.lstatSync('/');
const s = fs.lstatSync('/sandbox');
if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) !== 0 ||
    !s.isDirectory() || s.isSymbolicLink()) process.exit(20);
process.stdout.write(JSON.stringify({uid:s.uid,gid:s.gid,mode:s.mode & 0o7777,
  dev:s.dev,ino:s.ino,mtime:Math.floor(s.mtimeMs / 1000)}));
`;

function observe(
  execute: (command: readonly string[]) => RuntimeProviderPrivilegedSandboxCommandResult,
): Observation {
  const result = execute(["/usr/local/bin/node", "-e", INSPECT_WORKSPACE]);
  if (result.status !== 0 || result.error || result.signal) {
    throw new Error("Could not inspect the exact managed workspace directory.");
  }
  let value: Observation;
  try {
    value = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw new Error("Managed workspace metadata was unreadable.");
  }
  if (
    !value ||
    [value.uid, value.gid, value.mode, value.dev, value.ino, value.mtime].some(
      (field) => !Number.isSafeInteger(field) || field < 0,
    )
  ) {
    throw new Error("Managed workspace metadata was invalid.");
  }
  return value;
}

function directoryArchive(workspace: Workspace, mtime: number): Buffer {
  // One USTAR directory header plus two end blocks; never include workspace
  // contents, links, OpenShell control material, or caller-selected paths.
  const archive = Buffer.alloc(1536);
  archive.write("sandbox/", 0, "ascii");
  for (const [offset, size, value] of [
    [100, 8, workspace.mode],
    [108, 8, workspace.uid],
    [116, 8, workspace.gid],
    [124, 12, 0],
    [136, 12, mtime],
  ]) {
    const octal = value.toString(8);
    if (octal.length >= size) throw new Error("Managed workspace metadata exceeds USTAR limits.");
    archive.write(`${octal.padStart(size - 1, "0")}\0`, offset, size, "ascii");
  }
  archive[156] = "5".charCodeAt(0);
  archive.write("ustar\0", 257, 6, "ascii");
  archive.write("00", 263, 2, "ascii");
  archive.fill(0x20, 148, 156);
  const checksum = archive.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  archive.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return archive;
}

/** Engine archive transport restores directory metadata without workload capabilities. */
export function prepareManagedWorkspaceMetadata(
  workspace: Workspace,
  operations: {
    readonly execute: (command: readonly string[]) => RuntimeProviderPrivilegedSandboxCommandResult;
    readonly copyDirectory: (archive: Buffer) => RuntimeProviderPrivilegedSandboxCommandResult;
  },
): void {
  if (
    !Number.isSafeInteger(workspace.uid) ||
    workspace.uid < 0 ||
    workspace.uid > 0o7777777 ||
    !Number.isSafeInteger(workspace.gid) ||
    workspace.gid <= 0 ||
    workspace.gid > 0o7777777 ||
    (workspace.mode !== 0o755 && workspace.mode !== 0o1775)
  ) {
    throw new Error("Managed workspace requires declared numeric ownership and mode.");
  }
  const before = observe(operations.execute);
  if (
    before.uid === workspace.uid &&
    before.gid === workspace.gid &&
    before.mode === workspace.mode
  )
    return;
  const copied = operations.copyDirectory(directoryArchive(workspace, before.mtime));
  if (copied.status !== 0 || copied.error || copied.signal) {
    throw new Error("Managed workspace directory metadata could not be restored.");
  }
  const after = observe(operations.execute);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.uid !== workspace.uid ||
    after.gid !== workspace.gid ||
    after.mode !== workspace.mode
  ) {
    throw new Error(
      "Managed workspace directory did not retain its identity and declared metadata.",
    );
  }
}
