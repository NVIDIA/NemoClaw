// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Type-only: the vllm-storage value exports pull in the Docker adapter chain,
// whose module initialization probes `docker version` and rewrites
// DOCKER_HOST/DOCKER_CONTEXT. This module stays import-side-effect free (see
// createModelRouterCommandProvisioner's docstring), so the storage probes are
// injected through ModelRouterCommandDeps instead of imported as values.
import type { StorageProbeResult } from "../inference/vllm-storage";

const MODEL_ROUTER_FINGERPRINT_FILE = ".nemoclaw-source-fingerprint";

// The Model Router venv installs torch, transformers, and litellm[proxy] —
// ~2.1 GiB of packages on disk once installed (#8973). Require that footprint
// plus a wheel-download/staging allowance up front so pip does not die
// mid-install with `[Errno 28] No space left on device` and strand a partial
// venv on a nearly-full filesystem.
const MODEL_ROUTER_VENV_REQUIRED_BYTES = 3n * 1024n ** 3n;
const MIB_BYTES = 1024n ** 2n;
const MODEL_ROUTER_FINGERPRINT_IGNORED_NAMES = new Set([
  ".git",
  ".hg",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".svn",
  ".venv",
  "__pycache__",
  "build",
  "dist",
  "node_modules",
  "venv",
]);

type RunOptions = {
  ignoreError?: boolean;
  timeout?: number;
};

type PrepareModelRouterVenvOptions = {
  venvDir: string;
  allowReplaceExisting?: boolean;
};

export type ModelRouterCommandPaths = {
  rootDir: string;
  routerDir: string;
  venvDir: string;
  defaultVenvDir: string;
};

export type ModelRouterCommandDeps = {
  run: (command: string[], options?: RunOptions) => { status: number | null };
  runCapture: (command: string[], options?: RunOptions) => string;
  prepareModelRouterVenv: (options: PrepareModelRouterVenvOptions) => string;
  packageVersion: () => string;
  log?: (message: string) => void;
  sourceFingerprint?: (routerDir: string) => string | null;
  /**
   * Disk-capacity collaborators. Production uses probeHostStorage,
   * measureReclaimableDirectorySizeBytes, and formatStorageBytes from
   * vllm-storage.
   * These are required so this module remains import-pure and tests cannot
   * read capacity from the host filesystem.
   */
  probeStorage: (targetPath: string, source: string) => StorageProbeResult;
  measureDirectorySize: (targetPath: string) => bigint;
  formatStorageBytes: (bytes: bigint) => string;
};

export type ModelRouterCommandProvisioner = {
  ensureModelRouterCommand(): string;
  isManagedModelRouterCurrent(): boolean;
};

function modelRouterCommandPath(venvDir: string): string {
  return path.join(venvDir, "bin", "model-router");
}

function modelRouterFingerprintPath(venvDir: string): string {
  return path.join(venvDir, MODEL_ROUTER_FINGERPRINT_FILE);
}

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isModelRouterPackageReady(routerDir: string): boolean {
  return (
    fs.existsSync(path.join(routerDir, "pyproject.toml")) ||
    fs.existsSync(path.join(routerDir, "setup.py"))
  );
}

function shouldSkipModelRouterFingerprintEntry(name: string): boolean {
  return MODEL_ROUTER_FINGERPRINT_IGNORED_NAMES.has(name) || name.endsWith(".egg-info");
}

function hashModelRouterSourceTree(routerDir: string): string | null {
  const sourceHash = crypto.createHash("sha256");

  const hashDirectory = (currentDir: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs
        .readdirSync(currentDir, { withFileTypes: true })
        .sort((left: fs.Dirent, right: fs.Dirent) => left.name.localeCompare(right.name));
    } catch {
      return false;
    }

    let hashedSourceFile = false;
    for (const entry of entries) {
      if (shouldSkipModelRouterFingerprintEntry(entry.name)) continue;
      if (entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo")) continue;

      const entryPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(routerDir, entryPath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        hashedSourceFile = hashDirectory(entryPath) || hashedSourceFile;
        continue;
      }
      if (entry.isSymbolicLink()) {
        try {
          sourceHash.update(`link:${relativePath}\0`);
          sourceHash.update(fs.readlinkSync(entryPath));
          sourceHash.update("\0");
          hashedSourceFile = true;
        } catch {
          // Ignore unreadable links; the install step will fail if they are required.
        }
        continue;
      }
      if (!entry.isFile()) continue;
      sourceHash.update(`file:${relativePath}\0`);
      sourceHash.update(fs.readFileSync(entryPath));
      sourceHash.update("\0");
      hashedSourceFile = true;
    }
    return hashedSourceFile;
  };

  return hashDirectory(routerDir) ? `files:${sourceHash.digest("hex")}` : null;
}

function readModelRouterInstalledFingerprint(venvDir: string): string | null {
  try {
    const fingerprint = fs.readFileSync(modelRouterFingerprintPath(venvDir), "utf8").trim();
    return fingerprint || null;
  } catch {
    return null;
  }
}

function writeModelRouterInstalledFingerprint(fingerprint: string | null, venvDir: string): void {
  if (!fingerprint) return;
  fs.writeFileSync(modelRouterFingerprintPath(venvDir), `${fingerprint}\n`, { mode: 0o600 });
}

/**
 * Build the managed Model Router command boundary around explicit process
 * dependencies. Keeping command discovery and source fingerprinting here lets
 * focused tests exercise provisioning directly without loading all of onboard
 * or replacing CommonJS module-cache entries.
 */
export function createModelRouterCommandProvisioner(
  paths: ModelRouterCommandPaths,
  deps: ModelRouterCommandDeps,
): ModelRouterCommandProvisioner {
  const relativeRouterDir = path.relative(paths.rootDir, paths.routerDir).split(path.sep).join("/");

  const getSourceFingerprint = (): string | null => {
    if (deps.sourceFingerprint) return deps.sourceFingerprint(paths.routerDir);

    const gitHead = deps
      .runCapture(["git", "-C", paths.routerDir, "rev-parse", "HEAD"], {
        ignoreError: true,
      })
      .trim();
    if (/^[0-9a-f]{40}$/i.test(gitHead)) return `git:${gitHead}`;

    const gitLink = deps
      .runCapture(["git", "-C", paths.rootDir, "rev-parse", `HEAD:${relativeRouterDir}`], {
        ignoreError: true,
      })
      .trim();
    if (/^[0-9a-f]{40}$/i.test(gitLink)) return `gitlink:${gitLink}`;

    return hashModelRouterSourceTree(paths.routerDir);
  };

  const isManagedModelRouterCurrent = (): boolean => {
    if (!isExecutableFile(modelRouterCommandPath(paths.venvDir))) return false;
    const sourceFingerprint = getSourceFingerprint();
    if (sourceFingerprint) {
      return readModelRouterInstalledFingerprint(paths.venvDir) === sourceFingerprint;
    }
    // When source fingerprint is unavailable (no git), accept an existing
    // install-prefixed fingerprint to avoid reinstalling on every onboard.
    const installed = readModelRouterInstalledFingerprint(paths.venvDir);
    return installed !== null && installed.startsWith("install:");
  };

  // Block venv creation when verified capacity is too low, instead of letting
  // pip fail during installation with `[Errno 28]` and no guidance (#8973).
  // `reclaimableVenvDir` is an existing venv that this install will replace.
  // Its current footprint counts toward usable capacity because replacement
  // removes it before creating the new environment.
  const assertVenvDiskSpace = (reclaimableVenvDir: string | null): void => {
    // The probe requires an absolute path. Resolve the supported relative
    // NEMOCLAW_MODEL_ROUTER_VENV value so capacity is checked at its intended
    // location.
    const probe = deps.probeStorage(path.resolve(paths.venvDir), "Model Router venv");
    if (!probe.ok) {
      // Continue when the filesystem does not report capacity, matching the
      // managed-vLLM storage guard's unverifiable-capacity behavior.
      (deps.log ?? console.log)(
        `  Continuing because free disk space for the Model Router environment could not be verified (${probe.reason}).`,
      );
      return;
    }
    const reclaimableBytes = reclaimableVenvDir ? deps.measureDirectorySize(reclaimableVenvDir) : 0n;
    const availableBytes = probe.capacity.availableBytes + reclaimableBytes;
    if (availableBytes >= MODEL_ROUTER_VENV_REQUIRED_BYTES) return;
    // State the shortfall in MiB: near the threshold both sides round to the
    // same "3 GiB" and the message would otherwise read as a contradiction.
    const shortfallMib =
      (MODEL_ROUTER_VENV_REQUIRED_BYTES - availableBytes + MIB_BYTES - 1n) / MIB_BYTES;
    throw new Error(
      `Model Router installation needs at least ${deps.formatStorageBytes(MODEL_ROUTER_VENV_REQUIRED_BYTES)} of free or reclaimable capacity ` +
        `at ${probe.capacity.path} (~2.1 GiB of Python packages plus download staging), but only ` +
        `${deps.formatStorageBytes(availableBytes)} is available. ` +
        `Free at least ${String(shortfallMib)} MiB, then run \`nemoclaw onboard --resume\`.`,
    );
  };

  const initializeModelRouterSubmodule = (): void => {
    if (isModelRouterPackageReady(paths.routerDir)) return;
    if (
      !fs.existsSync(path.join(paths.rootDir, ".gitmodules")) ||
      !fs.existsSync(path.join(paths.rootDir, ".git"))
    ) {
      return;
    }
    (deps.log ?? console.log)("  Initializing Model Router source...");
    deps.run(
      [
        "git",
        "-C",
        paths.rootDir,
        "submodule",
        "update",
        "--init",
        "--depth",
        "1",
        relativeRouterDir,
      ],
      { ignoreError: true },
    );
  };

  const installModelRouterCommand = (): string => {
    initializeModelRouterSubmodule();
    if (!isModelRouterPackageReady(paths.routerDir)) {
      throw new Error(
        `Model Router source is not initialized at ${paths.routerDir}. ` +
          `Run: git -C ${paths.rootDir} submodule update --init --depth 1 ${relativeRouterDir}`,
      );
    }

    const routerCommand = modelRouterCommandPath(paths.venvDir);
    const sourceFingerprint = getSourceFingerprint();
    const allowReplaceExistingVenv =
      path.resolve(paths.venvDir) === path.resolve(paths.defaultVenvDir) ||
      readModelRouterInstalledFingerprint(paths.venvDir) !== null;
    assertVenvDiskSpace(
      allowReplaceExistingVenv && fs.existsSync(paths.venvDir) ? paths.venvDir : null,
    );
    const venvPython = deps.prepareModelRouterVenv({
      venvDir: paths.venvDir,
      allowReplaceExisting: allowReplaceExistingVenv,
    });

    const installResult = deps.run(
      [
        venvPython,
        "-m",
        "pip",
        "install",
        "--quiet",
        "--upgrade",
        `${paths.routerDir}[prefill,proxy]`,
      ],
      { ignoreError: true, timeout: 600_000 },
    );
    if (installResult.status !== 0) {
      throw new Error("Failed to install Model Router dependencies.");
    }
    if (!isExecutableFile(routerCommand)) {
      throw new Error("Model Router install did not produce the model-router command.");
    }
    const effectiveFingerprint = sourceFingerprint ?? `install:${deps.packageVersion()}`;
    writeModelRouterInstalledFingerprint(effectiveFingerprint, paths.venvDir);
    return routerCommand;
  };

  const resolveHostCommandPath = (): string | null => {
    const result = deps.runCapture(["sh", "-c", 'command -v "$1"', "--", "model-router"], {
      ignoreError: true,
    });
    return result.trim() || null;
  };

  const ensureModelRouterCommand = (): string => {
    const managedCommand = modelRouterCommandPath(paths.venvDir);

    if (isModelRouterPackageReady(paths.routerDir) && isManagedModelRouterCurrent()) {
      return managedCommand;
    }

    if (!isModelRouterPackageReady(paths.routerDir)) {
      initializeModelRouterSubmodule();
    }

    if (isModelRouterPackageReady(paths.routerDir)) {
      if (isManagedModelRouterCurrent()) return managedCommand;
      return installModelRouterCommand();
    }

    if (isExecutableFile(managedCommand)) return managedCommand;
    return resolveHostCommandPath() || installModelRouterCommand();
  };

  return { ensureModelRouterCommand, isManagedModelRouterCurrent };
}
