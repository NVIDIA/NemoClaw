// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session, SessionUpdates } from "../../../state/onboard-session";

export interface FinalizationStateOptions<Agent, VerifyChain, VerificationResult> {
  sandboxName: string;
  model: string;
  provider: string;
  nimContainer: string | null;
  agent: Agent;
  hermesAuthMethod: string | null;
  hermesToolGateways: string[];
  stagedLegacyKeys: readonly string[];
  migratedLegacyKeys: ReadonlySet<string>;
  deps: {
    ensureAgentDashboardForward(sandboxName: string, agent: NonNullable<Agent>): number;
    recordSessionComplete(updates: SessionUpdates): Promise<Session>;
    toSessionUpdates(updates: Record<string, unknown>): SessionUpdates;
    removeLegacyCredentialsFile(): void;
    cleanupStaleHostFiles(): void;
    checkAndRecoverSandboxProcesses(sandboxName: string, options: { quiet: boolean }): void;
    getChatUiUrl(): string;
    buildVerifyChain(chatUiUrl: string): VerifyChain;
    verifyDeployment(sandboxName: string, chain: VerifyChain): Promise<VerificationResult>;
    formatVerificationDiagnostics(result: VerificationResult): string[];
    printDashboard(
      sandboxName: string,
      model: string,
      provider: string,
      nimContainer: string | null,
      agent: Agent,
    ): void;
    error(message?: string): void;
    log(message?: string): void;
  };
}

export interface FinalizationStateResult {
  session: Session;
  unmigratedLegacyKeys: string[];
  verificationDiagnostics: string[];
}

export async function handleFinalizationState<Agent, VerifyChain, VerificationResult>({
  sandboxName,
  model,
  provider,
  nimContainer,
  agent,
  hermesAuthMethod,
  hermesToolGateways,
  stagedLegacyKeys,
  migratedLegacyKeys,
  deps,
}: FinalizationStateOptions<Agent, VerifyChain, VerificationResult>): Promise<FinalizationStateResult> {
  if (agent) deps.ensureAgentDashboardForward(sandboxName, agent as NonNullable<Agent>);

  const session = await deps.recordSessionComplete(
    deps.toSessionUpdates({ sandboxName, provider, model, hermesAuthMethod, hermesToolGateways }),
  );

  const allStagedMigrated =
    stagedLegacyKeys.length > 0 && stagedLegacyKeys.every((key) => migratedLegacyKeys.has(key));
  const unmigratedLegacyKeys = stagedLegacyKeys.filter((key) => !migratedLegacyKeys.has(key));
  if (allStagedMigrated) {
    deps.removeLegacyCredentialsFile();
  } else if (stagedLegacyKeys.length > 0) {
    deps.error(
      `  Kept ~/.nemoclaw/credentials.json: ${String(unmigratedLegacyKeys.length)} ` +
        `legacy credential(s) were not migrated verbatim to the gateway in this run ` +
        `(${unmigratedLegacyKeys.join(", ")}). Re-run onboard with the relevant ` +
        `providers/channels enabled to migrate them, then the file is removed automatically.`,
    );
  }

  // Sweep stale host files left by older credential migration paths (#3105).
  deps.cleanupStaleHostFiles();
  // Policy application can restart the sandbox; recover OpenClaw before verification (#3573).
  deps.checkAndRecoverSandboxProcesses(sandboxName, { quiet: true });

  // Confirm the delivered sandbox is reachable before printing the live dashboard (#2342).
  const verifyChain = deps.buildVerifyChain(deps.getChatUiUrl());
  const verificationResult = await deps.verifyDeployment(sandboxName, verifyChain);
  const verificationDiagnostics = deps.formatVerificationDiagnostics(verificationResult);
  for (const line of verificationDiagnostics) deps.log(line);

  deps.printDashboard(sandboxName, model, provider, nimContainer, agent);

  return { session, unmigratedLegacyKeys, verificationDiagnostics };
}
