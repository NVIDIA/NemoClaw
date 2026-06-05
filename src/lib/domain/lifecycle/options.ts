// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface DestroySandboxOptions {
  force?: boolean;
  yes?: boolean;
  /**
   * When the sandbox being destroyed is the last one, also tear down the
   * shared NemoClaw gateway (port forward, gateway pod, cluster volumes).
   * Default `false` — gateway is preserved so the next `nemoclaw onboard`
   * can reuse it without a full re-bootstrap. See #2166.
   *
   * Resolution order during normalization: explicit option, then
   * `--cleanup-gateway` argv flag, then `NEMOCLAW_CLEANUP_GATEWAY=1` env
   * var. Anything else leaves the field `undefined` so the runtime can
   * decide whether to prompt.
   */
  cleanupGateway?: boolean;
}

function readCleanupGatewayEnv(): boolean | undefined {
  const raw = (process.env.NEMOCLAW_CLEANUP_GATEWAY ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return undefined;
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
  const envCleanupGateway = readCleanupGatewayEnv();
  if (Array.isArray(options)) {
    const yesIdx = options.lastIndexOf("--cleanup-gateway");
    const noIdx = options.lastIndexOf("--no-cleanup-gateway");
    const cleanupGateway: boolean | undefined =
      yesIdx === -1 && noIdx === -1 ? envCleanupGateway : yesIdx > noIdx;
    return {
      force: options.includes("--force"),
      yes: options.includes("--yes"),
      ...(cleanupGateway === undefined ? {} : { cleanupGateway }),
    };
  }
  return {
    ...options,
    ...(options.cleanupGateway === undefined && envCleanupGateway !== undefined
      ? { cleanupGateway: envCleanupGateway }
      : {}),
  };
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
