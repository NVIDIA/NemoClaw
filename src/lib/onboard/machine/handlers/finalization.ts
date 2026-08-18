// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../../cli/branding";
import { type DashboardRuntimeAgent, shouldManageDashboardForAgent } from "../../dashboard-runtime";
import type { WebSearchVerifyProvider } from "../../web-search-verify";
import {
  advanceTo,
  completeOnboardMachine,
  type OnboardStateCompleteResult,
  type OnboardStatePauseResult,
  type OnboardStateTransitionResult,
  pauseOnboardMachine,
} from "../result";

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
  webSearchProvider: WebSearchVerifyProvider | null;
  deps: {
    ensureAgentDashboardForward(sandboxName: string, agent: Agent): Promise<number> | number;
    persistDashboardPort(sandboxName: string, dashboardPort: number): void;
    /**
     * Mark this sandbox as the default. Called here (not at sandbox creation) so
     * a cancel at the policy-preset step never leaves an unconfigured sandbox
     * registered as default (#4614).
     */
    setDefaultSandbox(sandboxName: string): void;
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
    /**
     * `sandboxName` lets the chain target the API port this sandbox actually
     * owns: Hermes allocates a per-sandbox port from the 8642-8652 range, so
     * the manifest default would probe a sibling sandbox's port (#9290).
     */
    buildVerifyChain(chatUiUrl: string, sandboxName: string): VerifyChain;
    verifyDeployment(sandboxName: string, chain: VerifyChain): Promise<VerificationResult>;
    formatVerificationDiagnostics(result: VerificationResult): string[];
    isDeploymentHealthy(result: VerificationResult): boolean;
    reportDeploymentReadiness(healthy: boolean): void;
    /**
     * Confirms the live sandbox does not expose a raw web-search credential.
     * Other web-search diagnostics remain best-effort. Returns false for a
     * confirmed exposure or an unverifiable isolation result so finalization
     * cannot report the sandbox as ready.
     */
    verifyWebSearchInsideSandbox(
      sandboxName: string,
      agent: Agent,
      provider: WebSearchVerifyProvider,
    ): boolean;
    printDashboard(
      sandboxName: string,
      model: string,
      provider: string,
      nimContainer: string | null,
      agent: Agent,
      ready: boolean,
    ): void;
    error(message?: string): void;
    log(message?: string): void;
  };
}

export interface FinalizationStateResult {
  stateResult: OnboardStateTransitionResult;
  unmigratedLegacyKeys: string[];
}

export interface PostVerifyStateResult {
  stateResult: OnboardStateCompleteResult | OnboardStatePauseResult;
  verificationDiagnostics: string[];
  deploymentHealthy: boolean;
}

type TerminalReadyAgent = {
  displayName?: unknown;
  name?: unknown;
  runtime?: {
    interactive_command?: unknown;
    headless_command?: unknown;
  } | null;
};

function logTerminalReadyBlock(
  sandboxName: string,
  agent: unknown,
  log: (message?: string) => void,
): void {
  const terminalAgent = agent as TerminalReadyAgent;
  const displayName =
    typeof terminalAgent.displayName === "string"
      ? terminalAgent.displayName
      : typeof terminalAgent.name === "string"
        ? terminalAgent.name
        : "Terminal agent";
  log(`  ✓ ${displayName} terminal runtime is ready`);
  // Lead with the one-step path (#6006); `connect` still opens a sandbox shell.
  // Only terminal agents reach this block, so the variant binary (for example
  // `nemo-deepagents`) is the common case — use the resolved name, not a literal.
  log(`  Launch: ${CLI_NAME} launch ${sandboxName}`);
  log(`  Connect: ${CLI_NAME} ${sandboxName} connect`);
  if (typeof terminalAgent.runtime?.interactive_command === "string") {
    log(`  Interactive: ${terminalAgent.runtime.interactive_command}`);
  }
  if (typeof terminalAgent.runtime?.headless_command === "string") {
    log(`  Headless: ${terminalAgent.runtime.headless_command} "<task>"`);
  }
}

export async function handleFinalizationState<Agent, VerifyChain, VerificationResult>({
  sandboxName,
  agent,
  stagedLegacyKeys,
  migratedLegacyKeys,
  deps,
}: FinalizationStateOptions<
  Agent,
  VerifyChain,
  VerificationResult
>): Promise<FinalizationStateResult> {
  const manageDashboard = shouldManageDashboardForAgent(agent as DashboardRuntimeAgent);

  // Reaching finalization means the policy-preset step was confirmed, so it is
  // now safe to register this sandbox as the default (#4614).
  deps.setDefaultSandbox(sandboxName);

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
  if (manageDashboard) {
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
  }

  if (manageDashboard) {
    // Scope warm-up can outlive a forward that was healthy after policy recovery.
    // Recheck the gateway and forward before verification, restarting only when needed.
    deps.checkAndRecoverSandboxProcesses(sandboxName, { quiet: true });
    // Reconcile after the final recovery because any restart above can
    // invalidate the forward created earlier in onboarding.
    const dashboardPort = await deps.ensureAgentDashboardForward(sandboxName, agent);
    if (dashboardPort > 0) {
      deps.persistDashboardPort(sandboxName, dashboardPort);
    }
  }

  return {
    stateResult: advanceTo("post_verify", { metadata: { state: "finalizing" } }),
    unmigratedLegacyKeys,
  };
}

export async function handlePostVerifyState<Agent, VerifyChain, VerificationResult>({
  sandboxName,
  model,
  provider,
  nimContainer,
  agent,
  hermesAuthMethod,
  hermesToolGateways,
  webSearchEnabled,
  webSearchProvider,
  deps,
}: FinalizationStateOptions<
  Agent,
  VerifyChain,
  VerificationResult
>): Promise<PostVerifyStateResult> {
  const manageDashboard = shouldManageDashboardForAgent(agent as DashboardRuntimeAgent);

  let verificationDiagnostics: string[] = [];
  let deploymentHealthy = true;
  if (manageDashboard) {
    // Probe web-search credential isolation and egress now that the final
    // policy, provider, process, and forwarding state are live. Egress
    // diagnostics remain best-effort, but a confirmed raw credential must
    // prevent a successful handoff (#7425).
    const webSearchCredentialBoundarySafe =
      !webSearchEnabled ||
      (webSearchProvider !== null &&
        deps.verifyWebSearchInsideSandbox(sandboxName, agent, webSearchProvider));
    // Confirm the delivered sandbox is reachable before printing the live dashboard (#2342).
    const verifyChain = deps.buildVerifyChain(deps.getChatUiUrl(), sandboxName);
    const verificationResult = await deps.verifyDeployment(sandboxName, verifyChain);
    deploymentHealthy =
      webSearchCredentialBoundarySafe && deps.isDeploymentHealthy(verificationResult);
    verificationDiagnostics = deps.formatVerificationDiagnostics(verificationResult);
    for (const line of verificationDiagnostics) deps.log(line);
    deps.printDashboard(sandboxName, model, provider, nimContainer, agent, deploymentHealthy);
    deps.reportDeploymentReadiness(deploymentHealthy);
  } else {
    logTerminalReadyBlock(sandboxName, agent, deps.log);
  }

  const sessionUpdates = deps.toSessionUpdates({
    sandboxName,
    provider,
    model,
    hermesAuthMethod,
    hermesToolGateways,
  });
  const stateResult = deploymentHealthy
    ? completeOnboardMachine(sessionUpdates, { state: "post_verify" })
    : pauseOnboardMachine(sessionUpdates, {
        state: "post_verify",
        reason: "deployment_not_ready",
      });

  return { stateResult, verificationDiagnostics, deploymentHealthy };
}
