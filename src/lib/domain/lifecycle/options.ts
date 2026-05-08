// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface DestroySandboxOptions {
  force?: boolean;
  yes?: boolean;
}

export interface RebuildSandboxOptions {
  force?: boolean;
  verbose?: boolean;
  yes?: boolean;
}

export interface GarbageCollectImagesOptions {
  dryRun?: boolean;
  force?: boolean;
  yes?: boolean;
}

export interface UpgradeSandboxesOptions {
  auto?: boolean;
  check?: boolean;
  yes?: boolean;
}

export function normalizeDestroySandboxOptions(
  options: string[] | DestroySandboxOptions = {},
): DestroySandboxOptions {
  if (Array.isArray(options)) {
    return {
      force: options.includes("--force"),
      yes: options.includes("--yes"),
    };
  }
  return options;
}

export function normalizeRebuildSandboxOptions(
  options: string[] | RebuildSandboxOptions = {},
): RebuildSandboxOptions {
  if (Array.isArray(options)) {
    return {
      force: options.includes("--force"),
      verbose: options.includes("--verbose") || options.includes("-v"),
      yes: options.includes("--yes"),
    };
  }
  return options;
}

export function normalizeGarbageCollectImagesOptions(
  options: string[] | GarbageCollectImagesOptions = {},
): GarbageCollectImagesOptions {
  if (Array.isArray(options)) {
    return {
      dryRun: options.includes("--dry-run"),
      force: options.includes("--force"),
      yes: options.includes("--yes"),
    };
  }
  return options;
}

export function normalizeUpgradeSandboxesOptions(
  options: string[] | UpgradeSandboxesOptions = {},
): UpgradeSandboxesOptions {
  if (Array.isArray(options)) {
    return {
      auto: options.includes("--auto"),
      check: options.includes("--check"),
      yes: options.includes("--yes"),
    };
  }
  return options;
}
