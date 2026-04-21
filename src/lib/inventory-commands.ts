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

  deps.getLiveInference();

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
    const model = sb.model || "unknown";
    const provider = sb.provider || "unknown";
    const gpu = sb.gpuEnabled ? "GPU" : "CPU";
    const presets = sb.policies && sb.policies.length > 0 ? sb.policies.join(", ") : "none";
    const sessionCount = deps.getActiveSessionCount ? deps.getActiveSessionCount(sb.name) : null;
    const connected = sessionCount !== null && sessionCount > 0 ? " ●" : "";
    log(`    ${sb.name}${def}${connected}`);
    log(`      model: ${model}  provider: ${provider}  ${gpu}  policies: ${presets}`);
  }
  log("");
  log("  * = default sandbox");
  log("");
}

export function showStatusCommand(deps: ShowStatusCommandDeps): void {
  const log = deps.log ?? console.log;
  const { sandboxes, defaultSandbox } = deps.listSandboxes();
  if (sandboxes.length > 0) {
    deps.getLiveInference();
    log("");
    log("  Sandboxes:");
    for (const sb of sandboxes) {
      const isDefault = sb.name === defaultSandbox;
      const def = isDefault ? " *" : "";
      const model = sb.model;
      log(`    ${sb.name}${def}${model ? ` (${model})` : ""}`);
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
