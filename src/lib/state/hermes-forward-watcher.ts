// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { HermesForwardWatcherState } from "../domain/uninstall/hermes-forward-watcher";

const HERMES_FORWARD_WATCHER_STATE_SUBDIR = "state";
const HERMES_FORWARD_WATCHER_FILE_PATTERN = /^hermes-(.+)-(\d+)\.forward\.pid$/;

export interface HermesForwardWatcherStateResult {
  readable: boolean;
  watchers: HermesForwardWatcherState[];
}

function parsePid(raw: string): number | null {
  const value = raw.trim();
  if (!/^[1-9]\d*$/.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : null;
}

function readPid(pidFile: string): number | null {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(pidFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(descriptor).isFile()) return null;
    return parsePid(fs.readFileSync(descriptor, "utf-8"));
  } catch {
    return null;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function readHermesForwardWatcherState(
  nemoclawStateDir: string,
): HermesForwardWatcherStateResult {
  const stateDir = path.join(nemoclawStateDir, HERMES_FORWARD_WATCHER_STATE_SUBDIR);
  if (!fs.existsSync(stateDir)) return { readable: true, watchers: [] };

  let entries: string[];
  try {
    const stat = fs.lstatSync(stateDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return { readable: false, watchers: [] };
    }
    entries = fs.readdirSync(stateDir);
  } catch {
    return { readable: false, watchers: [] };
  }

  const watchers = entries.flatMap((name): HermesForwardWatcherState[] => {
    const match = HERMES_FORWARD_WATCHER_FILE_PATTERN.exec(name);
    if (!match || path.basename(name) !== name) return [];
    const [, sandbox, port] = match;
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) return [];
    const pidFile = path.join(stateDir, name);
    return [
      {
        pid: readPid(pidFile),
        pidFile,
        port,
        sandbox,
        watcherScript: `${pidFile}.js`,
      },
    ];
  });
  return { readable: true, watchers };
}
