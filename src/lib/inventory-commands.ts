// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayInference } from "./inference-config";

export interface SandboxEntry {
  name: string;
  model?: string | null;
  provider?: string | null;
  gpuEnabled?: boolean;
  policies?: string[] | null;
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
  log?: (message?: string) => void;
}

export interface ShowStatusCommandDeps {
  listSandboxes: () => { sandboxes: SandboxEntry[]; defaultSandbox?: string | null };
  getLiveInference: () => GatewayInference | null;
  showServiceStatus: (options: { sandboxName?: string }) => void;
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
    log(`    ${sb.name}${def}`);
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
}
