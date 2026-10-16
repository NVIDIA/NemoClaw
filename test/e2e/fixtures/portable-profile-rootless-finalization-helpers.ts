// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { loadAgent } from "../../../src/lib/agent/defs.ts";
import { finalizationHandlerDeps } from "../../../src/lib/onboard/machine/finalization-deps.ts";
import type { FinalizationStateOptions } from "../../../src/lib/onboard/machine/handlers/finalization.ts";
import type { SessionUpdates } from "../../../src/lib/state/onboard-session.ts";
import type { SandboxEntry } from "../../../src/lib/state/registry/types.ts";
import { nemoclawStateRoot } from "../../../src/lib/state/state-root.ts";
import { CLI_ENTRYPOINT } from "./paths.ts";

const agent = loadAgent("hermes");
type VerifyChain = { boundary: string };
type VerificationResult = { healthy: boolean };
export type PortableHermesFinalizationOptions = FinalizationStateOptions<
  typeof agent,
  VerifyChain,
  VerificationResult
>;

export function createPortableHermesFinalizationOptions(
  sandboxName: string,
  lifecycleEnv: NodeJS.ProcessEnv,
): PortableHermesFinalizationOptions {
  return {
    sandboxName,
    model: "e2e-readiness",
    provider: "custom",
    nimContainer: null,
    agent,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    stagedLegacyKeys: [],
    migratedLegacyKeys: new Set<string>(),
    webSearchEnabled: false,
    webSearchProvider: null,
    portableProfileSelected: true,
    deps: {
      setDefaultSandbox: () => undefined,
      toSessionUpdates: (updates) => updates as SessionUpdates,
      removeLegacyCredentialsFile: () => undefined,
      cleanupStaleHostFiles: () => undefined,
      checkAndRecoverSandboxProcesses: async (name) =>
        await finalizationHandlerDeps.checkHermesPortableSandboxReadiness(name, lifecycleEnv),
      settleOrdinaryOpenClawPairing: async () => ({ kind: "settled" as const }),
      ordinaryOpenClawPairingIncompleteMessage: () => "ordinary pairing incomplete",
      readRegistryAgent: () => "hermes",
      settlePortablePairing: async () => ({ kind: "settled" as const }),
      portablePairingIncompleteMessage: () => "portable pairing incomplete",
      getChatUiUrl: () => "http://127.0.0.1:18789",
      buildVerifyChain: () => ({ boundary: "receipt-qualified" }),
      verifyDeployment: async () => ({ healthy: true }),
      formatVerificationDiagnostics: () => ["receipt-qualified readiness verified"],
      isDeploymentHealthy: (result) => result.healthy,
      reportDeploymentReadiness: () => undefined,
      verifyWebSearchInsideSandbox: async () => true,
      printDashboard: async () => undefined,
      error: () => undefined,
      log: () => undefined,
    },
  };
}

export function writePortableRegistry(
  home: string,
  sandboxName: string,
  entry: SandboxEntry,
): void {
  const registryPath = path.join(nemoclawStateRoot(home), "sandboxes.json");
  const registry = { defaultSandbox: sandboxName, sandboxes: { [sandboxName]: entry } };
  fs.mkdirSync(path.dirname(registryPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
}

export function runPortableDoctor(
  sandboxName: string,
  environment: NodeJS.ProcessEnv,
): number | null {
  return spawnSync(process.execPath, [CLI_ENTRYPOINT, sandboxName, "doctor", "--json"], {
    env: environment,
    killSignal: "SIGKILL",
    timeout: 240_000,
  }).status;
}
