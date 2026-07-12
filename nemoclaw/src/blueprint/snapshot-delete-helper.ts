// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { buildSubprocessEnv } from "../lib/subprocess-env.js";

// Keep this helper inline because the plugin package publishes compiled dist
// files only. It is passed as immutable source to isolated Python rather than
// loaded from a mutable host-side script path.
const SNAPSHOT_DELETE_HELPER = String.raw`
import os
import stat
import sys

O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
DIR_FLAGS = os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC


def fail() -> None:
    sys.exit(1)


def open_absolute_dir_no_follow(path: str) -> int:
    absolute = os.path.abspath(path)
    parts = [part for part in absolute.split(os.sep) if part]
    fd = os.open(os.sep, DIR_FLAGS)
    try:
        for part in parts:
            next_fd = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except Exception:
        os.close(fd)
        raise


def remove_tree_at(parent_fd: int, name: str) -> bool:
    try:
        child_fd = os.open(name, DIR_FLAGS, dir_fd=parent_fd)
    except FileNotFoundError:
        return True
    except OSError:
        return False

    try:
        try:
            entries = list(os.scandir(child_fd))
        except TypeError:
            return False
        for entry in entries:
            entry_name = entry.name
            if entry_name in ("", ".", "..") or os.sep in entry_name:
                return False
            try:
                entry_stat = os.lstat(entry_name, dir_fd=child_fd)
            except FileNotFoundError:
                continue
            if stat.S_ISDIR(entry_stat.st_mode):
                if not remove_tree_at(child_fd, entry_name):
                    return False
            else:
                try:
                    os.unlink(entry_name, dir_fd=child_fd)
                except FileNotFoundError:
                    continue
                except OSError:
                    return False
    finally:
        os.close(child_fd)

    try:
        os.rmdir(name, dir_fd=parent_fd)
        return True
    except FileNotFoundError:
        return True
    except OSError:
        return False


def main() -> None:
    if len(sys.argv) != 3:
        fail()
    snapshots_dir = sys.argv[1]
    snapshot_name = sys.argv[2]
    if (
        not snapshot_name
        or snapshot_name in (".", "..")
        or os.sep in snapshot_name
        or (os.altsep is not None and os.altsep in snapshot_name)
    ):
        fail()

    root_fd = open_absolute_dir_no_follow(snapshots_dir)
    try:
        sys.exit(0 if remove_tree_at(root_fd, snapshot_name) else 1)
    finally:
        os.close(root_fd)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        fail()
`;

export function snapshotDeletionSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

export interface SnapshotDeleteHelperOptions {
  platform?: NodeJS.Platform;
  pythonExecutable?: string;
}

export function deleteSnapshotDirectory(
  snapshotsDir: string,
  snapshotName: string,
  options: SnapshotDeleteHelperOptions = {},
): boolean {
  // The dir_fd/O_NOFOLLOW deletion primitive is POSIX-only. WSL uses the
  // Linux path; native Windows fails closed until it has an equivalent.
  if (!snapshotDeletionSupported(options.platform)) {
    return false;
  }

  const result = spawnSync(
    options.pythonExecutable ?? "python3",
    ["-I", "-c", SNAPSHOT_DELETE_HELPER, snapshotsDir, snapshotName],
    {
      encoding: "utf-8",
      env: buildSubprocessEnv(),
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    },
  );
  return result.status === 0;
}
