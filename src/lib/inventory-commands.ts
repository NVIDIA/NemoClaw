// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayInference } from "./inference-config";

export interface SandboxEntry {
  name: string;
  model?: string | null;
  provider?: string | null;
  gpuEnabled?: boolean;
  policies?: string[] | null;
  messagingChannels?: string[] | null;
  agent?: string | null;
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

/**
 * Render the `nemoclaw list` output. For the default sandbox (the one the
 * cluster-wide gateway is currently serving) the live gateway `model`/
 * `provider` take precedence over the onboarded snapshot so the CLI agrees
 * with `openshell inference get` (#2369); when they drift from stored values
 * a `(onboarded: …)` line is appended. Non-default sandboxes keep their
 * stored config — the gateway only applies to one sandbox at a time, and
 * each non-default sandbox swaps the gateway back to its stored config on
 * its next `connect`. Falls back to stored values when `getLiveInference()`
 * returns `null` (gateway unreachable).
 */
export async function listSandboxesCommand(deps: ListSandboxesCommandDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const recovery = await deps.recoverRegistryEntries();
  const { sandboxes, defaultSandbox } = recovery;

  if (sandboxes.length === 0) {
    log("");
    const session = deps.loadLastSession();
    if (session?.sandboxName) {
      log(
        `  No sandboxes registered locally, but the last onboarded sandbox was '${session.sandboxName}'.`,
      );
      log(
        "  Retry `nemoclaw <name> connect` or `nemoclaw <name> status` once the gateway/runtime is healthy.",
      );
    } else {
      log("  No sandboxes registered. Run `nemoclaw onboard` to get started.");
    }
    log("");
    return;
  }

  const live = deps.getLiveInference();

  log("");
  if (recovery.recoveredFromSession) {
    log("  Recovered sandbox inventory from the last onboard session.");
    log("");
  }
  if ((recovery.recoveredFromGateway || 0) > 0) {
    const count = recovery.recoveredFromGateway || 0;
    log(`  Recovered ${count} sandbox entr${count === 1 ? "y" : "ies"} from the live OpenShell gateway.`);
    log("");
  }
  log("  Sandboxes:");
  for (const sb of sandboxes) {
    const isDefault = sb.name === defaultSandbox;
    const def = isDefault ? " *" : "";
    // For the default sandbox, prefer the live gateway values so the display
    // agrees with `openshell inference get` (#2369). The gateway holds a
    // single active config at a time and applies to whichever sandbox is
    // currently connected; non-default sandboxes will swap it to their stored
    // config on their next `connect`, so they keep showing stored values.
    const useLive = isDefault && live;
    const model = (useLive && live.model) || sb.model || "unknown";
    const provider = (useLive && live.provider) || sb.provider || "unknown";
    const modelDrifted = !!(useLive && live.model && live.model !== sb.model);
    const providerDrifted = !!(useLive && live.provider && live.provider !== sb.provider);
    const gpu = sb.gpuEnabled ? "GPU" : "CPU";
    const presets = sb.policies && sb.policies.length > 0 ? sb.policies.join(", ") : "none";
    const sessionCount = deps.getActiveSessionCount ? deps.getActiveSessionCount(sb.name) : null;
    const connected = sessionCount !== null && sessionCount > 0 ? " ●" : "";
    log(`    ${sb.name}${def}${connected}`);
    log(`      model: ${model}  provider: ${provider}  ${gpu}  policies: ${presets}`);
    if (modelDrifted || providerDrifted) {
      const parts: string[] = [];
      if (modelDrifted) parts.push(`model=${sb.model || "unknown"}`);
      if (providerDrifted) parts.push(`provider=${sb.provider || "unknown"}`);
      log(`      (onboarded: ${parts.join(", ")})`);
    }
  }
  log("");
  log("  * = default sandbox");
  log("");
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
      log(`    ${sb.name}${def}${model ? ` (${model})` : ""}`);
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
        "    Run `nemoclaw <sandbox> destroy` on whichever sandbox should stop polling, or rerun onboarding with the channel disabled.",
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
