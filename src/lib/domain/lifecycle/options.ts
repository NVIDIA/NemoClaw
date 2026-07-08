// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  DCODE_AUTO_APPROVAL_MODES,
  type DcodeAutoApprovalMode,
  isDcodeAutoApprovalMode,
} from "../../onboard/dcode-auto-approval";
import {
  normalizeToolDisclosure,
  TOOL_DISCLOSURE_VALUES,
  type ToolDisclosure,
} from "../../tool-disclosure";

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
  dcodeAutoApprovalMode?: DcodeAutoApprovalMode;
  force?: boolean;
  observabilityEnabled?: boolean;
  toolDisclosure?: ToolDisclosure;
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
  let rawDcodeAutoApprovalMode: unknown;
  let rawToolDisclosure: unknown;
  if (Array.isArray(options)) {
    const observabilityIndex = options.lastIndexOf("--observability");
    const noObservabilityIndex = options.lastIndexOf("--no-observability");
    const observabilityEnabled =
      observabilityIndex === -1 && noObservabilityIndex === -1
        ? undefined
        : observabilityIndex > noObservabilityIndex;
    const splitIndex = options.lastIndexOf("--tool-disclosure");
    const inline = [...options].reverse().find((value) => value.startsWith("--tool-disclosure="));
    const toolDisclosureFlagProvided = splitIndex >= 0 || inline !== undefined;
    rawToolDisclosure =
      splitIndex >= 0 ? options[splitIndex + 1] : inline?.slice("--tool-disclosure=".length);
    const toolDisclosure = normalizeToolDisclosure(rawToolDisclosure);
    if (toolDisclosureFlagProvided && !toolDisclosure) {
      throw new Error(`--tool-disclosure must be one of: ${TOOL_DISCLOSURE_VALUES.join(", ")}.`);
    }
    const dcodeAutoApprovalSplitIndex = options.lastIndexOf("--dcode-auto-approval");
    const dcodeAutoApprovalInline = [...options]
      .reverse()
      .find((value) => value.startsWith("--dcode-auto-approval="));
    const dcodeAutoApprovalFlagProvided =
      dcodeAutoApprovalSplitIndex >= 0 || dcodeAutoApprovalInline !== undefined;
    rawDcodeAutoApprovalMode =
      dcodeAutoApprovalSplitIndex >= 0
        ? options[dcodeAutoApprovalSplitIndex + 1]
        : dcodeAutoApprovalInline?.slice("--dcode-auto-approval=".length);
    const dcodeAutoApprovalMode = isDcodeAutoApprovalMode(rawDcodeAutoApprovalMode)
      ? rawDcodeAutoApprovalMode
      : undefined;
    if (dcodeAutoApprovalFlagProvided && !dcodeAutoApprovalMode) {
      throw new Error(
        `--dcode-auto-approval must be one of: ${DCODE_AUTO_APPROVAL_MODES.join(", ")}.`,
      );
    }
    return {
      ...(dcodeAutoApprovalMode ? { dcodeAutoApprovalMode } : {}),
      force: options.includes("--force"),
      ...(observabilityEnabled === undefined ? {} : { observabilityEnabled }),
      ...(toolDisclosure ? { toolDisclosure } : {}),
      verbose: options.includes("--verbose") || options.includes("-v"),
      yes: options.includes("--yes"),
    };
  }
  rawDcodeAutoApprovalMode = options.dcodeAutoApprovalMode;
  const dcodeAutoApprovalMode = isDcodeAutoApprovalMode(rawDcodeAutoApprovalMode)
    ? rawDcodeAutoApprovalMode
    : undefined;
  if (rawDcodeAutoApprovalMode !== undefined && !dcodeAutoApprovalMode) {
    throw new Error(
      `dcodeAutoApprovalMode must be one of: ${DCODE_AUTO_APPROVAL_MODES.join(", ")}.`,
    );
  }
  rawToolDisclosure = options.toolDisclosure;
  const toolDisclosure = normalizeToolDisclosure(rawToolDisclosure);
  if (rawToolDisclosure !== undefined && !toolDisclosure) {
    throw new Error(`toolDisclosure must be one of: ${TOOL_DISCLOSURE_VALUES.join(", ")}.`);
  }
  return {
    ...options,
    ...(dcodeAutoApprovalMode ? { dcodeAutoApprovalMode } : {}),
    ...(toolDisclosure ? { toolDisclosure } : {}),
  };
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
