// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "./branding";
import type { GatewayInference } from "./inference-config";
import { redactFull } from "./redact";

export interface SandboxEntry {
  name: string;
  model?: string | null;
  provider?: string | null;
  gpuEnabled?: boolean;
  policies?: string[] | null;
  providerCredentialHashes?: Record<string, string> | null;
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
  /**
   * Returns the last onboard session's sandbox name and step state. The
   * step state is needed to filter out phantom names from interrupted
   * onboards — see #2753.
   */
  loadLastSession: () => {
    sandboxName?: string | null;
    steps?: { sandbox?: { status?: string } | null } | null;
  } | null;
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
  reason?: "matching-token" | "unknown-token";
}

export interface ShowStatusCommandDeps {
  listSandboxes: () => { sandboxes: SandboxEntry[]; defaultSandbox?: string | null };
  getLiveInference: () => GatewayInference | null;
  showServiceStatus: (options: { sandboxName?: string }) => void;
  getServiceStatuses?: (options: { sandboxName?: string }) => StatusServiceRow[];
  checkMessagingBridgeHealth?: (
    sandboxName: string,
    channels: string[],
  ) => MessagingBridgeHealth[];
  backfillAndFindOverlaps?: () => MessagingOverlap[];
  readGatewayLog?: (sandboxName: string) => string | null;
  log?: (message?: string) => void;
}

export interface StatusSandboxRow {
  name: string;
  model: string | null;
  provider: string | null;
  gpuEnabled: boolean;
  policies: string[];
  agent: string | null;
  dashboardPort?: number | null;
  isDefault: boolean;
}

export interface StatusServiceRow {
  name: string;
  running: boolean;
  pid: number | null;
}

export interface StatusReport {
  schemaVersion: 1;
  defaultSandbox: string | null;
  liveInference: {
    provider: string | null;
    model: string | null;
  } | null;
  sandboxes: StatusSandboxRow[];
  services: StatusServiceRow[];
}

function safeStatusString(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return redactFull(value);
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
  // #2753: only surface the last-onboarded name when its sandbox step
  // actually completed. Otherwise an interrupted onboard would leave the
  // name in the session and the empty-state hint would resurrect it.
  const lastOnboardedSandbox =
    lastSession?.sandboxName && lastSession.steps?.sandbox?.status === "complete"
      ? lastSession.sandboxName
      : null;

  return {
    schemaVersion: 1,
    defaultSandbox,
    recovery: {
      recoveredFromSession: recovery.recoveredFromSession === true,
      recoveredFromGateway: recovery.recoveredFromGateway || 0,
    },
    lastOnboardedSandbox,
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
    const agent = sandbox.agent || "openclaw";
    log(`    ${sandbox.name}${def}${connected}`);
    log(
      `      agent: ${agent}  model: ${model}  provider: ${provider}  ${gpu}  policies: ${presets}`,
    );
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

function buildStatusSandboxRow(
  sandbox: SandboxEntry,
  defaultSandbox: string | null,
  liveInference: GatewayInference | null,
): StatusSandboxRow {
  const isDefault = sandbox.name === defaultSandbox;
  const liveModel = isDefault ? liveInference?.model : null;
  const liveProvider = isDefault ? liveInference?.provider : null;
  const dashboardPort =
    typeof sandbox.dashboardPort === "number" && Number.isFinite(sandbox.dashboardPort)
      ? sandbox.dashboardPort
      : null;
  return {
    name: safeStatusString(sandbox.name) || sandbox.name,
    model: safeStatusString(liveModel || sandbox.model || null),
    provider: safeStatusString(liveProvider || sandbox.provider || null),
    gpuEnabled: sandbox.gpuEnabled === true,
    policies: Array.isArray(sandbox.policies)
      ? sandbox.policies
          .filter((policy): policy is string => typeof policy === "string")
          .map((policy) => safeStatusString(policy) || policy)
      : [],
    agent: safeStatusString(sandbox.agent || null),
    ...(dashboardPort != null ? { dashboardPort } : {}),
    isDefault,
  };
}

function normalizeServiceStatus(service: StatusServiceRow): StatusServiceRow {
  return {
    name: safeStatusString(service.name) || service.name,
    running: service.running === true,
    pid: service.running && Number.isFinite(service.pid) ? service.pid : null,
  };
}

export function getStatusReport(deps: ShowStatusCommandDeps): StatusReport {
  const { sandboxes, defaultSandbox } = deps.listSandboxes();
  const resolvedDefault = defaultSandbox || null;
  const liveInference = sandboxes.length > 0 ? deps.getLiveInference() : null;
  const services =
    deps.getServiceStatuses?.({ sandboxName: resolvedDefault || undefined }).map(
      normalizeServiceStatus,
    ) ?? [];

  return {
    schemaVersion: 1,
    defaultSandbox: safeStatusString(resolvedDefault),
    liveInference: liveInference
      ? {
          provider: safeStatusString(liveInference.provider),
          model: safeStatusString(liveInference.model),
        }
      : null,
    sandboxes: sandboxes.map((sandbox) =>
      buildStatusSandboxRow(sandbox, resolvedDefault, liveInference),
    ),
    services,
  };
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
      for (const { channel, sandboxes: pair, reason } of overlaps) {
        const detail =
          reason === "matching-token"
            ? `share the same ${channel} credential`
            : `may share a ${channel} credential; stored credential hashes are incomplete`;
        log(
          `  ⚠ '${pair[0]}' and '${pair[1]}' ${detail}. Only one bridge can poll/connect per credential.`,
        );
      }
      log(
        `    Run \`${CLI_NAME} <sandbox> channels stop <channel>\` to pause one bridge, or \`${CLI_NAME} <sandbox> channels remove <channel>\` to remove stale bridge metadata.`,
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
