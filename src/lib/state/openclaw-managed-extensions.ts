// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { shellQuote } from "../core/shell-quote.js";
import { listOpenClawPluginExtensionIds } from "../messaging/channels/metadata.js";

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
const OPENCLAW_GLOBAL_PACKAGE_PATH = "/usr/local/lib/node_modules/openclaw";

// Preserve extensions baked into the freshly rebuilt image instead of
// replacing them with archived copies. Messaging IDs come from the reviewed
// channel manifests; the remaining entries are installed by Dockerfile.base.
export const OPENCLAW_IMAGE_MANAGED_EXTENSION_DIRS = [
  "nemoclaw",
  "diagnostics-otel",
  "brave",
  ...listOpenClawPluginExtensionIds(),
] as const;

interface OpenClawRestoreManifest {
  readonly agentType: string;
}

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
    linkTarget === OPENCLAW_GLOBAL_PACKAGE_PATH
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

export function shouldPreserveOpenClawManagedExtensions(
  manifest: OpenClawRestoreManifest,
  dir: string,
  localDirs: readonly string[],
): boolean {
  return (
    localDirs.includes("extensions") &&
    (manifest.agentType === "openclaw" || dir.replace(/\/+$/, "") === "/sandbox/.openclaw")
  );
}

export function buildRestoreTarArgs(
  backupPath: string,
  localDirs: readonly string[],
  managedExtensionDirs: readonly string[],
): string[] {
  const args = ["-cf", "-", "-C", backupPath];
  for (const extensionName of managedExtensionDirs) {
    args.push("--exclude", `extensions/${extensionName}`);
  }
  args.push("--", ...localDirs);
  return args;
}

function buildOpenClawExtensionsCleanupCommand(
  dir: string,
  managedExtensionDirs: readonly string[],
  requiredExtensionDirs: ReadonlySet<string>,
): string {
  const extensionsDir = `${dir}/extensions`;
  const quotedExtensionsDir = shellQuote(extensionsDir);
  const validationCommands = managedExtensionDirs
    .map((extensionName) => {
      const managedPath = `${extensionsDir}/${extensionName}`;
      if (requiredExtensionDirs.has(extensionName)) {
        return (
          `p=${shellQuote(managedPath)}; ` +
          'if [ ! -d "$p" ] || [ -L "$p" ]; then ' +
          'echo "refusing missing or unsafe image-managed extension: $p" >&2; exit 20; fi'
        );
      }
      return (
        `p=${shellQuote(managedPath)}; ` +
        'if { [ -e "$p" ] || [ -L "$p" ]; } && { [ ! -d "$p" ] || [ -L "$p" ]; }; then ' +
        'echo "refusing to preserve unsafe managed extension: $p" >&2; exit 20; fi'
      );
    })
    .join("; ");
  const validateManagedPaths = `{ ${validationCommands}; }`;
  const preservedNames = managedExtensionDirs
    .map((extensionName) => `! -name ${shellQuote(extensionName)}`)
    .join(" ");

  return [
    `mkdir -p -- ${quotedExtensionsDir}`,
    validateManagedPaths,
    `find ${quotedExtensionsDir} -mindepth 1 -maxdepth 1 ${preservedNames} -exec rm -rf -- {} +`,
  ].join(" && ");
}

export function buildRestoreCleanupCommand(
  dir: string,
  localDirs: readonly string[],
  managedExtensionDirs: readonly string[],
  requiredExtensionDirs: ReadonlySet<string>,
): string {
  const preserveManagedExtensions = managedExtensionDirs.length > 0;
  const commands: string[] = [];
  for (const dirName of localDirs) {
    if (preserveManagedExtensions && dirName === "extensions") continue;
    commands.push(`rm -rf -- ${shellQuote(`${dir}/${dirName}`)}`);
  }
  if (preserveManagedExtensions) {
    commands.push(
      buildOpenClawExtensionsCleanupCommand(dir, managedExtensionDirs, requiredExtensionDirs),
    );
  }
  return commands.length > 0 ? commands.join(" && ") : ":";
}
