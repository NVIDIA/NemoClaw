// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export function failMetadataWrites(names: readonly string[], error: Error, once = false) {
  let failed = false;
  const write: typeof fs.writeFileSync = (filename, contents, options) => {
    if (names.includes(path.basename(String(filename))) && (!once || !failed)) {
      failed = true;
      throw error;
    }
    return fs.writeFileSync(filename, contents, options);
  };
  return { write, reached: () => failed };
}

export function failBundleRestoration(undici: string): typeof fs.renameSync {
  return (source, destination) => {
    if (String(destination) === undici) throw new Error("EACCES: bundle rename failed");
    return fs.renameSync(source, destination);
  };
}

export function interleavePatchWorkspace(root: string, action: () => void): typeof fs.mkdtempSync {
  let entered = false;
  return (prefix, options) => {
    const workspace = Reflect.apply(fs.mkdtempSync, fs, [prefix, options]);
    if (String(prefix) === path.join(fs.realpathSync(root), ".nemoclaw-undici-") && !entered) {
      entered = true;
      action();
    }
    return workspace;
  };
}

export function createProjectLock(root: string, pid?: number): string {
  const directory = path.join(root, ".nemoclaw-undici.lock");
  fs.mkdirSync(directory);
  if (pid !== undefined) {
    fs.writeFileSync(
      path.join(directory, "owner-11111111-1111-1111-1111-111111111111.json"),
      JSON.stringify({ pid }),
    );
  }
  return directory;
}

export function createInvalidProjectLock(root: string, target: string, kind: string): void {
  const directory = path.join(root, ".nemoclaw-undici.lock");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "foreign"), "retain");
  if (kind === "symlink") fs.symlinkSync(target, directory);
  else {
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "unknown-owner"), "retain");
  }
}

export function claimLockDuringRelease(root: string, successor: string): typeof fs.unlinkSync {
  const directory = path.join(fs.realpathSync(root), ".nemoclaw-undici.lock");
  let replaced = false;
  return (filename) => {
    fs.unlinkSync(filename);
    if (path.dirname(String(filename)) === directory && !replaced) {
      replaced = true;
      const prepared = fs.mkdtempSync(path.join(root, ".successor-"));
      fs.writeFileSync(path.join(prepared, successor), JSON.stringify({ pid: process.pid }));
      fs.renameSync(prepared, directory);
    }
  };
}

export function duringWorkspaceCleanup(action: () => void): typeof fs.rmSync {
  return (directory, options) => {
    if (/^\.nemoclaw-undici-[A-Za-z0-9]{6}$/u.test(path.basename(String(directory)))) action();
    return fs.rmSync(directory, options);
  };
}

export function redirectProjectLock(root: string, target: string): string {
  const directory = path.join(root, ".nemoclaw-undici.lock");
  const [token] = fs.readdirSync(directory);
  fs.cpSync(directory, target, { recursive: true });
  fs.renameSync(directory, `${directory}.retained`);
  fs.symlinkSync(target, directory);
  return path.join(target, token!);
}
