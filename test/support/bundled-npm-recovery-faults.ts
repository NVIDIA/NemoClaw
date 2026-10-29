// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export function alterBackupCopy(
  copy: typeof fs.cpSync,
  live: string,
  mutate: (destination: string) => void,
): typeof fs.cpSync {
  return (source, destination, options) => {
    copy(source, destination, options);
    if (String(source) === live) mutate(String(destination));
  };
}

export function racePackageFileOpen(
  open: typeof fs.openSync,
  target: string,
  mutate: () => void,
  afterOpen = false,
): typeof fs.openSync {
  let injected = false;
  return (file, flags, mode) => {
    if (String(file) !== target || injected) return open(file, flags, mode);
    injected = true;
    if (afterOpen) {
      const descriptor = open(file, flags, mode);
      mutate();
      return descriptor;
    }
    mutate();
    return open(file, flags, mode);
  };
}

export function snapshotBackupFiles(directory: string): Record<string, Buffer> {
  return Object.fromEntries(
    fs
      .readdirSync(directory)
      .sort()
      .map((name) => [name, fs.readFileSync(path.join(directory, name))]),
  );
}

export function failReplacementRename(rename: typeof fs.renameSync): typeof fs.renameSync {
  return (source, destination) => {
    if (String(source).endsWith("/replacement")) {
      throw new Error("injected replacement rename failure");
    }
    rename(source, destination);
  };
}

export function corruptAfterReplacementRename(
  rename: typeof fs.renameSync,
  corrupt: () => void,
  failRollback = false,
): typeof fs.renameSync {
  return (source, destination) => {
    if (failRollback && String(source).includes(".nemoclaw-backup-")) {
      throw new Error("injected rollback rename failure");
    }
    rename(source, destination);
    if (String(source).endsWith("/replacement")) corrupt();
  };
}

export function alterPublishedBackup(
  fixture: { root: string; live: string; parent: string },
  markerPath: string,
  scenario: string,
): string {
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  const backup = path.join(fixture.parent, marker.backup.name);
  let retainedBackup = backup;
  if (scenario === "changed-live") fs.writeFileSync(path.join(fixture.live, "payload"), "new");
  if (scenario === "partial-backup") fs.unlinkSync(path.join(backup, "payload"));
  if (scenario === "changed-backup") fs.writeFileSync(path.join(backup, "payload"), "new");
  if (scenario === "wrong-inode") marker.backup.inode = -1;
  if (scenario === "wrong-digest") marker.backup.digest = "0".repeat(64);
  if (scenario === "escaped-name") marker.backup.name = `../${marker.backup.name}`;
  if (scenario === "linked-backup") {
    retainedBackup = path.join(fixture.root, "outside-backup");
    fs.renameSync(backup, retainedBackup);
    fs.symlinkSync(retainedBackup, backup);
  }
  if (scenario === "hardlinked-file")
    fs.linkSync(path.join(backup, "payload"), path.join(fixture.root, "linked-payload"));
  if (scenario === "multiple-backups") fs.cpSync(backup, `${backup}0`, { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify(marker));
  if (scenario === "missing-marker") fs.unlinkSync(markerPath);
  return retainedBackup;
}
