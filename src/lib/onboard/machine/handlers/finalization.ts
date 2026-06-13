// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../../../state/onboard-session";
import { completeOnboardMachine, type OnboardStateCompleteResult } from "../result";

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
  webSearchEnabled: boolean;
  deps: {
    ensureAgentDashboardForward(sandboxName: string, agent: NonNullable<Agent>): number;
    /**
     * Mark this sandbox as the default. Called here (not at sandbox creation) so
     * a cancel at the policy-preset step never leaves an unconfigured sandbox
     * registered as default (#4614).
     */
    setDefaultSandbox(sandboxName: string): void;
    recordPostVerifyStarted(): Promise<Session>;
    toSessionUpdates(
      updates: Record<string, unknown>,
    ): NonNullable<OnboardStateCompleteResult["updates"]>;
    removeLegacyCredentialsFile(): void;
    cleanupStaleHostFiles(): void;
    checkAndRecoverSandboxProcesses(sandboxName: string, options: { quiet: boolean }): void;
    /**
     * Best-effort device-approval sweep that clears pending allowlisted
     * CLI/webchat scope upgrades before handoff. Never throws; swallows its own
     * failures (timeout, sandbox-exec errors). Run after process recovery
     * because that can restart the gateway (#3573), so the sweep targets the
     * freshly-recovered gateway (ref #4504 / #4263).
     */
    autoPairScopeApproval(sandboxName: string): void;
    /**
     * Best-effort warm-up that provokes the `operator.write` scope upgrade with
     * a throwaway in-sandbox `openclaw agent` run, making the request PENDING so
     * the `autoPairScopeApproval` pass (which must run immediately after) can
     * clear it before handoff. Without this, the upgrade is only requested by
     * the user's first real run — after finalization's approval pass already
     * found nothing pending — causing one silent embedded fallback (#4504-v2).
     * Order is load-bearing: warm-up (provoke) must run BEFORE
     * `autoPairScopeApproval` (approve), and after process recovery so the
     * gateway is live. Never throws; idempotent once operator.write is paired.
     */
    warmupScopeUpgrade(sandboxName: string): void;
    getChatUiUrl(): string;
    buildVerifyChain(chatUiUrl: string): VerifyChain;
    verifyDeployment(sandboxName: string, chain: VerifyChain): Promise<VerificationResult>;
    formatVerificationDiagnostics(result: VerificationResult): string[];
    /**
     * Best-effort probe that confirms the agent runtime actually accepted the
     * web-search config and (for Brave) that the L7 proxy rewrites the
     * `X-Subscription-Token` header at egress. Called after the post-policy
     * sandbox-process recovery so the final policy/gateway state is live.
     */
    verifyWebSearchInsideSandbox(sandboxName: string, agent: Agent): void;
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
  stateResult: OnboardStateCompleteResult;
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
  webSearchEnabled,
  deps,
}: FinalizationStateOptions<
  Agent,
  VerifyChain,
  VerificationResult
>): Promise<FinalizationStateResult> {
  // Reaching finalization means the policy-preset step was confirmed, so it is
  // now safe to register this sandbox as the default (#4614).
  deps.setDefaultSandbox(sandboxName);

  if (agent) deps.ensureAgentDashboardForward(sandboxName, agent as NonNullable<Agent>);

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
  // #4504-v2: provoke the operator.write scope upgrade now (throwaway agent
  // run) so the request is PENDING when the approval pass below clears it, and
  // the user's first real run connects without an embedded fallback.
  // Best-effort; never blocks. No-op/idempotent once operator.write is paired.
  deps.warmupScopeUpgrade(sandboxName);
  // Clear any pending allowlisted scope upgrade against the freshly-recovered
  // gateway before verification, so onboard hands off without a stuck pairing
  // request (#4504 / #4263). Best-effort; never blocks.
  deps.autoPairScopeApproval(sandboxName);

  // Probe Brave Search egress through the L7 proxy now that the final
  // policy and provider state are live — earlier probes would race the
  // not-yet-applied `brave` preset (#3626). Best-effort; never blocks.
  if (webSearchEnabled) {
    deps.verifyWebSearchInsideSandbox(sandboxName, agent);
  }

  await deps.recordPostVerifyStarted();

  // Confirm the delivered sandbox is reachable before printing the live dashboard (#2342).
  const verifyChain = deps.buildVerifyChain(deps.getChatUiUrl());
  const verificationResult = await deps.verifyDeployment(sandboxName, verifyChain);
  const verificationDiagnostics = deps.formatVerificationDiagnostics(verificationResult);
  for (const line of verificationDiagnostics) deps.log(line);

  deps.printDashboard(sandboxName, model, provider, nimContainer, agent);

  const stateResult = completeOnboardMachine(
    deps.toSessionUpdates({ sandboxName, provider, model, hermesAuthMethod, hermesToolGateways }),
    { state: "finalizing" },
  );

  return { stateResult, unmigratedLegacyKeys, verificationDiagnostics };
}
