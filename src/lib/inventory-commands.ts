// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayInference } from "./inference-config";
import { CLI_NAME } from "./branding";

export interface SandboxEntry {
  name: string;
  model?: string | null;
  provider?: string | null;
  gpuEnabled?: boolean;
  policies?: string[] | null;
  messagingChannels?: string[] | null;
  agent?: string | null;
  dashboardPort?: number | null;
}

export interface MessagingBridgeHealth {
  channel: string;
  conflicts: number;
}

export interface RecoveryResult {
  sandboxes: SandboxEntry[];
  defaultSandbox?: string | null;
  recoveredFromSession?: boolean;
  recoveredFromGateway?: number;
}

export interface ListSandboxesCommandDeps {
  recoverRegistryEntries: () => Promise<RecoveryResult>;
  getLiveInference: () => GatewayInference | null;
  loadLastSession: () => { sandboxName?: string | null } | null;
  /** Detect active SSH sessions for a sandbox. Returns session count or null if unavailable. */
  getActiveSessionCount?: (sandboxName: string) => number | null;
  log?: (message?: string) => void;
}

export interface SandboxInventoryRow {
  name: string;
  model: string | null;
  provider: string | null;
  gpuEnabled: boolean;
  policies: string[];
  agent: string | null;
  dashboardPort?: number | null;
  isDefault: boolean;
  activeSessionCount: number | null;
  connected: boolean;
}

export interface SandboxInventoryResult {
  schemaVersion: 1;
  defaultSandbox: string | null;
  recovery: {
    recoveredFromSession: boolean;
    recoveredFromGateway: number;
  };
  lastOnboardedSandbox: string | null;
  sandboxes: SandboxInventoryRow[];
}

export interface MessagingOverlap {
  channel: string;
  sandboxes: [string, string];
}

export interface ShowStatusCommandDeps {
  listSandboxes: () => { sandboxes: SandboxEntry[]; defaultSandbox?: string | null };
  getLiveInference: () => GatewayInference | null;
  showServiceStatus: (options: { sandboxName?: string }) => void;
  checkMessagingBridgeHealth?: (
    sandboxName: string,
    channels: string[],
  ) => MessagingBridgeHealth[];
  backfillAndFindOverlaps?: () => MessagingOverlap[];
  readGatewayLog?: (sandboxName: string) => string | null;
  log?: (message?: string) => void;
}

function buildSandboxInventoryRow(
  sandbox: SandboxEntry,
  defaultSandbox: string | null,
  getActiveSessionCount?: (sandboxName: string) => number | null,
): SandboxInventoryRow {
  const activeSessionCount = getActiveSessionCount ? getActiveSessionCount(sandbox.name) : null;

  return {
    name: sandbox.name,
    model: sandbox.model || null,
    provider: sandbox.provider || null,
    gpuEnabled: sandbox.gpuEnabled === true,
    policies: Array.isArray(sandbox.policies) ? sandbox.policies : [],
    agent: sandbox.agent || null,
    ...(sandbox.dashboardPort != null ? { dashboardPort: sandbox.dashboardPort } : {}),
    isDefault: sandbox.name === defaultSandbox,
    activeSessionCount,
    connected: activeSessionCount !== null && activeSessionCount > 0,
  };
}

export async function getSandboxInventory(
  deps: ListSandboxesCommandDeps,
): Promise<SandboxInventoryResult> {
  const recovery = await deps.recoverRegistryEntries();
  const defaultSandbox = recovery.defaultSandbox || null;
  const lastSession = deps.loadLastSession();

  return {
    schemaVersion: 1,
    defaultSandbox,
    recovery: {
      recoveredFromSession: recovery.recoveredFromSession === true,
      recoveredFromGateway: recovery.recoveredFromGateway || 0,
    },
    lastOnboardedSandbox: lastSession?.sandboxName || null,
    sandboxes: recovery.sandboxes.map((sandbox) =>
      buildSandboxInventoryRow(sandbox, defaultSandbox, deps.getActiveSessionCount),
    ),
  };
}

/**
 * Render the `nemoclaw list` output. For the default sandbox (the one the
 * cluster-wide gateway is currently serving) the live gateway `model`/
 * `provider` take precedence over the onboarded snapshot so the CLI agrees
 * with `openshell inference get` (#2369); when they drift from stored values
 * a `(onboarded: …)` line is appended. Non-default sandboxes keep their
 * stored config — the gateway only applies to one sandbox at a time, and
 * each non-default sandbox swaps the gateway back to its stored config on
 * its next `connect`. Falls back to stored values when `liveInference`
 * is `null` (gateway unreachable).
 */
export function renderSandboxInventoryText(
  inventory: SandboxInventoryResult,
  log: (message?: string) => void = console.log,
  liveInference: GatewayInference | null = null,
): void {
  if (inventory.sandboxes.length === 0) {
    log("");
    if (inventory.lastOnboardedSandbox) {
      log(
        `  No sandboxes registered locally, but the last onboarded sandbox was '${inventory.lastOnboardedSandbox}'.`,
      );
      log(
        `  Retry \`${CLI_NAME} <name> connect\` or \`${CLI_NAME} <name> status\` once the gateway/runtime is healthy.`,
      );
    } else {
      log(`  No sandboxes registered. Run \`${CLI_NAME} onboard\` to get started.`);
    }
    log("");
    return;
  }

  log("");
  if (inventory.recovery.recoveredFromSession) {
    log("  Recovered sandbox inventory from the last onboard session.");
    log("");
  }
  if (inventory.recovery.recoveredFromGateway > 0) {
    const count = inventory.recovery.recoveredFromGateway;
    log(
      `  Recovered ${count} sandbox entr${count === 1 ? "y" : "ies"} from the live OpenShell gateway.`,
    );
    log("");
  }
  log("  Sandboxes:");
  for (const sandbox of inventory.sandboxes) {
    const useLive = sandbox.isDefault && liveInference;
    const def = sandbox.isDefault ? " *" : "";
    const model = (useLive && liveInference.model) || sandbox.model || "unknown";
    const provider = (useLive && liveInference.provider) || sandbox.provider || "unknown";
    const modelDrifted = !!(useLive && liveInference.model && liveInference.model !== sandbox.model);
    const providerDrifted =
      !!(useLive && liveInference.provider && liveInference.provider !== sandbox.provider);
    const gpu = sandbox.gpuEnabled ? "GPU" : "CPU";
    const presets = sandbox.policies.length > 0 ? sandbox.policies.join(", ") : "none";
    const connected = sandbox.connected ? " ●" : "";
    log(`    ${sandbox.name}${def}${connected}`);
    log(`      model: ${model}  provider: ${provider}  ${gpu}  policies: ${presets}`);
    if (modelDrifted || providerDrifted) {
      const parts: string[] = [];
      if (modelDrifted) parts.push(`model=${sandbox.model || "unknown"}`);
      if (providerDrifted) parts.push(`provider=${sandbox.provider || "unknown"}`);
      log(`      (onboarded: ${parts.join(", ")})`);
    }
    if (sandbox.dashboardPort != null) {
      log(`      dashboard: http://127.0.0.1:${sandbox.dashboardPort}/`);
    }
  }
  log("");
  log("  * = default sandbox");
  log("");
}

export async function listSandboxesCommand(deps: ListSandboxesCommandDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const inventory = await getSandboxInventory(deps);
  const liveInference = inventory.sandboxes.length > 0 ? deps.getLiveInference() : null;
  renderSandboxInventoryText(inventory, log, liveInference);
}

/**
 * Render the `nemoclaw status` output (no sandbox name): a compact per-row
 * listing followed by gateway/service status and messaging-bridge warnings.
 * For the default sandbox the per-row `(model)` prefers the live gateway
 * model so it agrees with `openshell inference get` (#2369); when it drifts
 * from the stored onboarded model a `(onboarded: …)` line is appended.
 * Non-default rows and the unreachable-gateway case fall back to stored.
 */
export function showStatusCommand(deps: ShowStatusCommandDeps): void {
  const log = deps.log ?? console.log;
  const { sandboxes, defaultSandbox } = deps.listSandboxes();
  if (sandboxes.length > 0) {
    const live = deps.getLiveInference();
    log("");
    log("  Sandboxes:");
    for (const sb of sandboxes) {
      const isDefault = sb.name === defaultSandbox;
      const def = isDefault ? " *" : "";
      // Prefer the live gateway model for the default sandbox so `status`
      // agrees with `openshell inference get` (#2369).
      const liveModel = isDefault && live ? live.model : null;
      const model = liveModel || sb.model;
      const portSuffix = sb.dashboardPort != null ? ` :${sb.dashboardPort}` : "";
      log(`    ${sb.name}${def}${model ? ` (${model})` : ""}${portSuffix}`);
      if (isDefault && liveModel && liveModel !== sb.model) {
        log(`      (onboarded: ${sb.model || "unknown"})`);
      }
    }
    log("");
  }

  deps.showServiceStatus({ sandboxName: defaultSandbox || undefined });

  if (deps.backfillAndFindOverlaps) {
    const overlaps = deps.backfillAndFindOverlaps();
    if (overlaps.length > 0) {
      log("");
      for (const { channel, sandboxes: pair } of overlaps) {
        log(
          `  ⚠ ${channel} is enabled on both '${pair[0]}' and '${pair[1]}'. Bot tokens only allow one sandbox to poll — both bridges will fail.`,
        );
      }
      log(
        `    Run \`${CLI_NAME} <sandbox> destroy\` on whichever sandbox should stop polling, or rerun onboarding with the channel disabled.`,
      );
    }
  }

  if (deps.checkMessagingBridgeHealth && defaultSandbox) {
    // Re-fetch: backfillAndFindOverlaps above may have populated
    // messagingChannels for the default sandbox on first run after upgrade,
    // and the original `sandboxes` snapshot is stale.
    const refreshed = deps.listSandboxes().sandboxes;
    const defaultEntry = refreshed.find((sb) => sb.name === defaultSandbox);
    const channels = defaultEntry?.messagingChannels;
    if (Array.isArray(channels) && channels.length > 0) {
      const degraded = deps.checkMessagingBridgeHealth(defaultSandbox, channels);
      if (degraded.length > 0) {
        log("");
        for (const { channel, conflicts } of degraded) {
          log(
            `  ⚠ ${channel} bridge: degraded (${conflicts} conflict errors in /tmp/gateway.log)`,
          );
        }
        log(
          "    Another sandbox is likely polling with the same bot token. See docs/reference/troubleshooting.md.",
        );

        // Surface gateway log tail for Hermes sandboxes when messaging is degraded.
        if (deps.readGatewayLog && defaultEntry?.agent === "hermes") {
          const logTail = deps.readGatewayLog(defaultSandbox);
          if (logTail) {
            log("");
            log("  Messaging gateway log (last 10 lines):");
            for (const line of logTail.split("\n")) {
              log(`    ${line}`);
            }
          }
        }
      }
    }
  }
}
