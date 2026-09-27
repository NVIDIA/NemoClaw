// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { shellQuote } from "../core/shell-quote.js";

// Exact symlinks baked into OpenClaw messaging images at build time. Source
// paths are relative to the agent state-dir root (e.g. /sandbox/.openclaw);
// targets are matched exactly against `readlink(source)`.
const AUDIT_SYMLINK_WHITELIST: ReadonlyMap<string, string> = new Map([
  [
    "extensions/openclaw-weixin/node_modules/.bin/qrcode-terminal",
    "../qrcode-terminal/bin/qrcode-terminal.js",
  ],
]);

const EXTENSION_NPM_BIN_RE = /^extensions\/[A-Za-z0-9][A-Za-z0-9._-]*\/node_modules\/\.bin\/[^/]+$/;
// `openclaw plugins install <archive>` creates this peer-dependency link for
// each extension. Match both the narrow path shape and the immutable image
// target; source-only matching would permit repointing it to an arbitrary file.
const OPENCLAW_EXTENSION_PEER_LINK_RE =
  /^extensions\/[A-Za-z0-9][A-Za-z0-9._-]*\/node_modules\/openclaw$/;
const OPENCLAW_IMAGE_PACKAGE_PATHS: ReadonlySet<string> = new Set([
  // Legacy global install used by older sandboxes that still need to rebuild.
  "/usr/local/lib/node_modules/openclaw",
  // Locked runtime install used by current images; the global path points here.
  "/usr/local/lib/nemoclaw/openclaw-runtime/node_modules/openclaw",
]);

function isAllowedExtensionNpmBinSymlink(relPath: string, linkTarget: string): boolean {
  const normalizedRelPath = relPath.split(path.sep).join("/");
  if (!EXTENSION_NPM_BIN_RE.test(normalizedRelPath)) return false;
  if (linkTarget.length === 0 || linkTarget.includes("%") || path.posix.isAbsolute(linkTarget)) {
    return false;
  }

  const binDir = path.posix.dirname(normalizedRelPath);
  const nodeModulesDir = path.posix.dirname(binDir);
  const resolvedTarget = path.posix.normalize(path.posix.join(binDir, linkTarget));
  const targetWithinNodeModules = path.posix.relative(nodeModulesDir, resolvedTarget);

  return (
    targetWithinNodeModules.length > 0 &&
    targetWithinNodeModules !== ".." &&
    !targetWithinNodeModules.startsWith("../") &&
    !path.posix.isAbsolute(targetWithinNodeModules) &&
    !targetWithinNodeModules.startsWith(".bin/")
  );
}

function isAllowedOpenClawExtensionPeerSymlink(relPath: string, linkTarget: string): boolean {
  const normalizedRelPath = relPath.split(path.sep).join("/");
  return (
    OPENCLAW_EXTENSION_PEER_LINK_RE.test(normalizedRelPath) &&
    OPENCLAW_IMAGE_PACKAGE_PATHS.has(linkTarget)
  );
}

export function isAllowedStateSymlink(relPath: string, linkTarget: string): boolean {
  const exactTarget = AUDIT_SYMLINK_WHITELIST.get(relPath.split(path.sep).join("/"));
  if (exactTarget !== undefined) return exactTarget === linkTarget;
  return (
    isAllowedOpenClawExtensionPeerSymlink(relPath, linkTarget) ||
    isAllowedExtensionNpmBinSymlink(relPath, linkTarget)
  );
}

export function buildRestoreTarArgs(backupPath: string, localDirs: readonly string[]): string[] {
  return ["-cf", "-", "-C", backupPath, "--", ...localDirs];
}

function buildStaleStateDirContentsCleanupCommand(dir: string, dirName: string): string {
  const target = shellQuote(`${dir}/${dirName}`);
  return (
    `d=${target}; ` +
    'if [ -d "$d" ] && [ ! -L "$d" ]; then ' +
    'find "$d" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; fi'
  );
}

export function buildRestoreCleanupCommand(
  dir: string,
  localDirs: readonly string[],
  staleContentDirs: readonly string[] = [],
): string {
  const commands = localDirs.map((dirName) => `rm -rf -- ${shellQuote(`${dir}/${dirName}`)}`);
  const localDirSet = new Set(localDirs);
  for (const dirName of staleContentDirs) {
    if (localDirSet.has(dirName)) continue;
    commands.push(buildStaleStateDirContentsCleanupCommand(dir, dirName));
  }
  return commands.length > 0 ? commands.join(" && ") : ":";
}

/** Internal capture capability; never populated from command arguments or a persisted manifest. */
export interface CapturedOpenClawState {
  readonly sandboxName: string;
  readonly directory: string;
  assertCurrent(): void;
}

export function copyCapturedOpenClawState(
  source: CapturedOpenClawState,
  destination: string,
  directories: readonly string[],
  prefixes: readonly string[],
  files: readonly { path: string; strategy: string }[],
): { directories: string[]; files: string[] } {
  source.assertCurrent();
  const root = fs.lstatSync(source.directory);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    (root.mode & 0o077) !== 0 ||
    root.uid !== process.getuid?.()
  ) {
    throw new Error("Stopped state capture is not an owned private directory.");
  }
  const inspectTree = (relative: string): void => {
    const location = path.join(source.directory, relative);
    const entry = fs.lstatSync(location);
    if (entry.isSymbolicLink()) {
      if (!isAllowedStateSymlink(relative.split(path.sep).join("/"), fs.readlinkSync(location))) {
        throw new Error("Stopped state contains an unsupported symbolic link.");
      }
      return;
    }
    if (entry.isDirectory()) {
      for (const child of fs.readdirSync(location)) inspectTree(path.join(relative, child));
    } else if (!entry.isFile() || entry.nlink !== 1) {
      throw new Error("Stopped state contains an unsupported filesystem entry.");
    }
  };
  const copiedDirectories: string[] = [];
  const copiedFiles: string[] = [];
  for (const entry of fs.readdirSync(source.directory, { withFileTypes: true })) {
    const selectedDirectory =
      directories.includes(entry.name) || prefixes.some((prefix) => entry.name.startsWith(prefix));
    const selectedFile = files.find((file) => file.path === entry.name);
    if (!selectedDirectory && !selectedFile) continue;
    if (!/^[A-Za-z0-9._-]+$/u.test(entry.name) || entry.name === "." || entry.name === "..") {
      throw new Error("Stopped state contains an invalid declared state path.");
    }
    if (
      (selectedDirectory && !entry.isDirectory()) ||
      (selectedFile && (!entry.isFile() || selectedFile.strategy !== "copy"))
    ) {
      throw new Error("Stopped state does not match the declared OpenClaw backup contract.");
    }
    inspectTree(entry.name);
    fs.cpSync(path.join(source.directory, entry.name), path.join(destination, entry.name), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: true,
    });
    (selectedDirectory ? copiedDirectories : copiedFiles).push(entry.name);
  }
  source.assertCurrent();
  return { directories: copiedDirectories, files: copiedFiles };
}
