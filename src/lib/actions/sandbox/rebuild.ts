// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import { prompt as askPrompt } from "../../credentials/store";
import { resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import {
  normalizeRebuildSandboxOptions,
  type RebuildSandboxOptions,
} from "../../domain/lifecycle/options";

const { hydrateCredentialEnv } = require("../../onboard") as {
  hydrateCredentialEnv: (name: string) => string | null;
};
const hermesProviderAuth = require("../../hermes-provider-auth") as {
  HERMES_PROVIDER_NAME: string;
  HERMES_NOUS_API_KEY_CREDENTIAL_ENV: string;
  isHermesProviderRegistered: (runOpenshellFn: typeof runOpenshell) => boolean;
  registerHermesInferenceProvider: (
    apiKey: string,
    runOpenshellFn: typeof runOpenshell,
    credentialEnv?: string,
    baseUrl?: string,
  ) => void;
};
const { LOCAL_INFERENCE_PROVIDERS, REMOTE_PROVIDER_CONFIG, providerExistsInGateway } =
  require("../../onboard/providers") as {
    LOCAL_INFERENCE_PROVIDERS: string[];
    REMOTE_PROVIDER_CONFIG: Record<string, { providerName: string; credentialEnv: string | null }>;
    providerExistsInGateway: (name: string, runOpenshellFn: typeof runOpenshell) => boolean;
  };

import {
  detectOpenShellStateRpcPreflightIssue,
  detectOpenShellStateRpcResultIssue,
  printOpenShellStateRpcIssue,
} from "../../adapters/openshell/gateway-drift";
import { resolveOpenshell } from "../../adapters/openshell/resolve";
import { runOpenshell } from "../../adapters/openshell/runtime";
import { loadAgent } from "../../agent/defs";
import { ensureAgentBaseImage } from "../../agent/onboard";
import * as agentRuntime from "../../agent/runtime";
import { RD as _RD, B, D, G, R, YW } from "../../cli/terminal-style";
import { getSandboxDeleteOutcome } from "../../domain/sandbox/destroy";
import { getNamedGatewayLifecycleState } from "../../gateway-runtime-action";
import * as nim from "../../inference/nim";
import type {
  MessagingHookApplyRequest,
  MessagingHookOutputMap,
  MessagingOpenShellRunner,
  SandboxMessagingPlan,
} from "../../messaging";
import {
  createBuiltInChannelManifestRegistry,
  MessagingSetupApplier,
  MessagingWorkflowPlanner,
  toMessagingAgentId,
} from "../../messaging";
import { hydrateMessagingChannelConfig } from "../../messaging-channel-config";
import { getStoredMessagingChannelConfig } from "../../onboard/messaging-config";
import { pruneDisabledMessagingPolicyPresets } from "../../onboard/messaging-policy-presets";
import {
  captureSandboxListWithGatewayRecovery,
  printSandboxListFailureWithRecoveryContext,
} from "../../openshell-sandbox-list";
import * as policies from "../../policy";
import { shellQuote } from "../../runner";
import { parseLiveSandboxNames } from "../../runtime-recovery";
import * as sandboxVersion from "../../sandbox/version";
import { redact } from "../../security/redact";
import * as shields from "../../shields";
import type { Session } from "../../state/onboard-session";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import * as sandboxState from "../../state/sandbox";
import {
  createSystemDeps as createSessionDeps,
  getActiveSandboxSessions,
} from "../../state/sandbox-session";
import { removeSandboxRegistryEntry } from "./destroy";
import {
  getReconciledSandboxGatewayState,
  printGatewayLifecycleHint,
  printWrongGatewayActiveGuidance,
} from "./gateway-state";
import { executeSandboxCommand } from "./process-recovery";
import { buildRebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import {
  openRebuildShieldsWindow,
  printRebuildShieldsRecovery,
  type RebuildShieldsWindow,
  relockRebuildShieldsWindow,
} from "./rebuild-shields";

export function buildRefreshMutableOpenClawConfigHashCommand(
  configDir = "/sandbox/.openclaw",
): string {
  return [
    `config_dir=${shellQuote(configDir)}`,
    'config_file="${config_dir}/openclaw.json"',
    'hash_file="${config_dir}/.config-hash"',
    '[ -d "$config_dir" ] || exit 0',
    '[ ! -L "$config_dir" ] || { echo "refusing symlinked OpenClaw config dir: $config_dir" >&2; exit 10; }',
    '[ ! -L "$config_file" ] || { echo "refusing symlinked OpenClaw config file: $config_file" >&2; exit 11; }',
    '[ ! -L "$hash_file" ] || { echo "refusing symlinked OpenClaw config hash: $hash_file" >&2; exit 12; }',
    'owner="$(stat -c "%U" "$config_dir" 2>/dev/null || echo unknown)"',
    '[ "$owner" != "root" ] || exit 0',
    '[ -f "$config_file" ] || exit 0',
    'cd "$config_dir" || exit 13',
    "sha256sum openclaw.json > .config-hash",
    "chmod 660 .config-hash 2>/dev/null || true",
  ].join("; ");
}

function refreshMutableOpenClawConfigHashAfterPostRestoreWrites(
  sandboxName: string,
  log: (msg: string) => void,
): boolean {
  const result = executeSandboxCommand(sandboxName, buildRefreshMutableOpenClawConfigHashCommand());
  if (result && result.status === 0) {
    log("Mutable OpenClaw config hash refreshed after post-restore config writes");
    return true;
  }

  const detail = result
    ? [result.stderr, result.stdout].filter(Boolean).join("; ") || `exit ${result.status}`
    : "could not obtain sandbox SSH config";
  console.error(`  ${YW}⚠${R} Mutable OpenClaw config hash was not refreshed: ${redact(detail)}`);
  return false;
}

/**
 * Emit timestamped rebuild diagnostics when verbose rebuild logging is enabled.
 */
function _rebuildLog(msg: string) {
  console.error(`  ${D}[rebuild ${new Date().toISOString()}] ${redact(msg)}${R}`);
}

/**
 * Resolve the credential environment variable required to recreate a sandbox.
 */
function isLocalInferenceProvider(provider: string | null | undefined): provider is string {
  return Boolean(provider && LOCAL_INFERENCE_PROVIDERS.includes(provider));
}

function getRebuildCredentialEnvFromRegistry(provider: string | null | undefined): string | null {
  if (!provider || isLocalInferenceProvider(provider)) {
    return null;
  }
  const remoteConfig =
    provider === "nvidia-nim"
      ? REMOTE_PROVIDER_CONFIG.build
      : Object.values(REMOTE_PROVIDER_CONFIG).find((entry) => entry.providerName === provider);
  return remoteConfig?.credentialEnv || null;
}

function normalizeHermesRebuildAuthMethod(value: unknown): "oauth" | "api_key" | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!normalized) return null;
  if (normalized === "oauth" || normalized === "nous_oauth" || normalized === "nous_portal_oauth") {
    return "oauth";
  }
  if (
    normalized === "api" ||
    normalized === "key" ||
    normalized === "api_key" ||
    normalized === "apikey" ||
    normalized === "nous_api_key"
  ) {
    return "api_key";
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function preflightHermesProviderCredentials(
  session: Session | null,
  credentialEnv: string | null,
  log: (msg: string) => void,
): boolean {
  const authMethod =
    normalizeHermesRebuildAuthMethod(session?.hermesAuthMethod) ||
    (credentialEnv === hermesProviderAuth.HERMES_NOUS_API_KEY_CREDENTIAL_ENV ? "api_key" : null);

  if (hermesProviderAuth.isHermesProviderRegistered(runOpenshell)) {
    log("Hermes Provider rebuild preflight: provider is registered in OpenShell");
    return true;
  }

  if (authMethod === "api_key") {
    const envKey =
      nonEmptyString(process.env[hermesProviderAuth.HERMES_NOUS_API_KEY_CREDENTIAL_ENV]) ||
      nonEmptyString(process.env.NEMOCLAW_PROVIDER_KEY);
    log(
      `Hermes Provider rebuild preflight: OpenShell provider missing; API key env=${envKey ? "present" : "missing"}`,
    );
    if (envKey) {
      try {
        hermesProviderAuth.registerHermesInferenceProvider(
          envKey,
          runOpenshell,
          hermesProviderAuth.HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
        );
        return true;
      } catch (err) {
        log(
          `Hermes Provider rebuild preflight: failed to register OpenShell provider: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  console.error("");
  console.error(
    `  ${_RD}Rebuild preflight failed:${R} Hermes Provider is not registered in OpenShell.`,
  );
  console.error("  Hermes Provider credentials must be stored in OpenShell, not host-side files.");
  if (authMethod === "api_key") {
    console.error(
      `  Export the Hermes Provider API key and rerun rebuild, or re-run ${CLI_NAME} onboard to register it.`,
    );
  } else {
    console.error(
      `  Re-run ${CLI_NAME} onboard interactively to authorize Hermes Provider and register it with OpenShell.`,
    );
  }
  console.error("");
  console.error("  Sandbox is untouched — no data was lost.");
  return false;
}

async function stageMessagingManifestPlanForRebuild(
  sandboxName: string,
  sandboxEntry: registry.SandboxEntry,
  rebuildAgent: string | null,
  log: (msg: string) => void,
): Promise<SandboxMessagingPlan | null> {
  const agent = loadAgent(rebuildAgent || "openclaw");
  const planner = new MessagingWorkflowPlanner(createBuiltInChannelManifestRegistry());
  const plan = await planner.buildRebuildPlanFromSandboxEntry({
    sandboxName,
    agent: toMessagingAgentId(agent),
    sandboxEntry,
    supportedChannelIds: agent.messagingPlatforms,
  });
  if (!plan) {
    MessagingSetupApplier.clearPlanEnv();
    log("Messaging manifest rebuild plan: no configured channels");
    return null;
  }
  MessagingSetupApplier.writePlanToEnv(plan);
  if (plan.channels.length === 0) {
    log("Messaging manifest rebuild plan staged: no configured channels");
    return plan;
  }
  log(
    `Messaging manifest rebuild plan staged: ${plan.channels
      .map((channel) => channel.channelId)
      .join(",")}`,
  );
  return plan;
}

type RebuildSandboxEntry = registry.SandboxEntry & { agents?: unknown[] };

const runMessagingOpenshell: MessagingOpenShellRunner = (args, options = {}) =>
  runOpenshell([...args], {
    env: options.env as NodeJS.ProcessEnv | undefined,
    ignoreError: options.ignoreError,
    input: options.input,
    stdio: options.stdio as never,
  });

function hookOutputsFromBuildSteps(
  plan: SandboxMessagingPlan,
  request: MessagingHookApplyRequest,
): { readonly outputs: MessagingHookOutputMap } {
  const outputs: Record<string, MessagingHookOutputMap[string]> = {};
  for (const step of plan.buildSteps) {
    if (
      step.channelId !== request.channelId ||
      step.hookId !== request.hookId ||
      step.value === undefined
    ) {
      continue;
    }
    outputs[step.outputId] = {
      kind: step.kind,
      value: step.value,
    };
  }
  return { outputs };
}

function countActiveSandboxSessionsForRebuild(sandboxName: string): number {
  const opsBinRebuild = resolveOpenshell();
  // Source boundary: active-session detection depends on host process listing
  // and the OpenShell binary being installed. A failed/unavailable detector is
  // not evidence of active sessions, and rebuild's safety preflights still run
  // before destructive work. Keep the prior fail-open prompt behavior here;
  // remove this fallback only if session detection becomes a required, typed
  // OpenShell API that can distinguish "zero sessions" from "unavailable".
  if (!opsBinRebuild) return 0;

  try {
    const sessionResult = getActiveSandboxSessions(sandboxName, createSessionDeps(opsBinRebuild));
    return sessionResult.detected ? sessionResult.sessions.length : 0;
  } catch {
    return 0;
  }
}

async function confirmSandboxRebuildIfNeeded(
  skipConfirm: boolean,
  rebuildActiveSessionCount: number,
): Promise<boolean> {
  if (skipConfirm) return true;

  if (rebuildActiveSessionCount > 0) {
    const plural = rebuildActiveSessionCount > 1 ? "sessions" : "session";
    console.log(
      `  ${YW}⚠  Active SSH ${plural} detected (${rebuildActiveSessionCount} connection${rebuildActiveSessionCount > 1 ? "s" : ""})${R}`,
    );
    console.log(
      `  Rebuilding will terminate ${rebuildActiveSessionCount === 1 ? "the" : "all"} active ${plural} with a Broken pipe error.`,
    );
    console.log("");
  }
  console.log("  This will:");
  console.log("    1. Back up workspace state");
  console.log("    2. Destroy and recreate the sandbox with the current image");
  console.log("    3. Restore workspace state into the new sandbox");
  console.log("");
  const answer = await askPrompt("  Proceed? [y/N]: ");
  if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
    console.log("  Cancelled.");
    return false;
  }
  return true;
}

function checkRebuildGatewaySchemaPreflight(
  sandboxName: string,
  bail: (msg: string, code?: number) => never,
): boolean {
  const gatewayPreflightIssue = detectOpenShellStateRpcPreflightIssue();
  if (gatewayPreflightIssue) {
    printOpenShellStateRpcIssue(gatewayPreflightIssue, {
      action: `rebuilding sandbox '${sandboxName}'`,
      command: `${CLI_NAME} ${sandboxName} rebuild`,
    });
    bail("OpenShell gateway schema mismatch.");
    return false;
  }
  return true;
}

function getRebuildSandboxEntryOrBail(
  sandboxName: string,
  bail: (msg: string, code?: number) => never,
): RebuildSandboxEntry | null {
  const sb = registry.getSandbox(sandboxName) as RebuildSandboxEntry | null;
  if (!sb) {
    console.error(`  Sandbox '${sandboxName}' not found in registry.`);
    bail(`Sandbox '${sandboxName}' not found in registry.`);
    return null;
  }
  return sb;
}

function isSingleAgentRebuildSupported(
  sb: registry.SandboxEntry & { agents?: unknown[] },
  bail: (msg: string, code?: number) => never,
): boolean {
  if (sb.agents && sb.agents.length > 1) {
    console.error("  Multi-agent sandbox rebuild is not yet supported.");
    console.error(`  Back up state manually and recreate with \`${CLI_NAME} onboard\`.`);
    bail("Multi-agent sandbox rebuild is not yet supported.");
    return false;
  }
  return true;
}

async function stageRebuildMessagingPlanOrBail(
  sandboxName: string,
  sb: RebuildSandboxEntry,
  rebuildAgent: string | null,
  log: (msg: string) => void,
  bail: (msg: string, code?: number) => never,
): Promise<SandboxMessagingPlan | null> {
  try {
    return await stageMessagingManifestPlanForRebuild(sandboxName, sb, rebuildAgent, log);
  } catch (err) {
    // Source boundary: registry messaging plans and agent manifests are durable
    // host-side inputs from prior onboarding. If they drift or become invalid,
    // rebuild must fail here before backup/delete; remove this boundary only if
    // manifest staging becomes total over all persisted registry states.
    const message = err instanceof Error ? err.message : String(err);
    console.error("");
    console.error(
      `  ${_RD}Rebuild preflight failed:${R} messaging manifest plan could not be staged.`,
    );
    console.error(`  ${message}`);
    console.error("");
    console.error("  Sandbox is untouched — no data was lost.");
    bail(message);
    return null;
  }
}

function preflightRebuildCredentials(
  sandboxName: string,
  sb: RebuildSandboxEntry,
  log: (msg: string) => void,
  bail: (msg: string, code?: number) => never,
): boolean {
  const session = onboardSession.loadSession();
  const sessionMatchesTarget = session?.sandboxName === sandboxName;
  // The target registry entry is authoritative when a matching legacy session
  // omitted credentialEnv; rebuild rewrites provider/model from this entry later,
  // so remote registry providers must still fail closed before backup/delete.
  let rebuildCredentialEnv = sessionMatchesTarget
    ? session?.credentialEnv || getRebuildCredentialEnvFromRegistry(sb.provider)
    : getRebuildCredentialEnvFromRegistry(sb.provider);
  if (!sessionMatchesTarget && session?.sandboxName) {
    log(
      `Preflight warning: session belongs to '${session.sandboxName}', not '${sandboxName}' — using registry credential env ${rebuildCredentialEnv || "(none)"}`,
    );
    console.log(
      `  ${D}Note: onboard session belongs to '${session.sandboxName}', not '${sandboxName}'. ` +
        `Using the '${sandboxName}' registry entry for credential preflight.${R}`,
    );
  }

  const rebuildProvider = sb.provider;
  // Compatibility boundary for GH #2519: pre-fix local-provider sessions could
  // persist credentialEnv="OPENAI_API_KEY" even though current local-provider
  // write paths persist null. Only a session for this sandbox plus a local
  // target registry provider may bypass the key; keep until legacy sessions are
  // no longer supported by rebuild migration tests.
  if (
    sessionMatchesTarget &&
    isLocalInferenceProvider(sb.provider) &&
    rebuildCredentialEnv === "OPENAI_API_KEY"
  ) {
    console.log(
      `  ${D}Note: migrating ${sb.provider} sandbox off OPENAI_API_KEY (GH #2519). ` +
        `Local inference does not require a host API key.${R}`,
    );
    log(
      `Preflight: legacy ${sb.provider} sandbox detected (credentialEnv=OPENAI_API_KEY) — clearing for rebuild`,
    );
    rebuildCredentialEnv = null;
  }

  if (rebuildProvider === hermesProviderAuth.HERMES_PROVIDER_NAME) {
    if (
      !preflightHermesProviderCredentials(
        sessionMatchesTarget ? session : null,
        rebuildCredentialEnv,
        log,
      )
    ) {
      bail("Missing Hermes Provider credentials");
      return false;
    }
    rebuildCredentialEnv = null;
  }

  if (!rebuildCredentialEnv) {
    log(
      "Preflight credential check: no credentialEnv in session (local inference or missing session)",
    );
    return true;
  }

  const credentialValue = hydrateCredentialEnv(rebuildCredentialEnv);
  log(
    `Preflight credential check: ${rebuildCredentialEnv} → ${credentialValue ? "present" : "MISSING"}`,
  );
  if (credentialValue) return true;
  if (rebuildProvider && providerExistsInGateway(rebuildProvider, runOpenshell)) {
    log(
      `Preflight credential check: provider '${rebuildProvider}' registered in gateway — skipping env check for ${rebuildCredentialEnv}`,
    );
    return true;
  }

  console.error("");
  console.error(`  ${_RD}Rebuild preflight failed:${R} provider credential not found.`);
  console.error(`  The non-interactive recreate step requires ${rebuildCredentialEnv},`);
  console.error("  but it is not set in the environment.");
  console.error("");
  console.error("  To fix, do one of:");
  console.error(`    export ${rebuildCredentialEnv}=<your-key>`);
  console.error(`    ${CLI_NAME} onboard          # re-enter the key interactively`);
  console.error("");
  console.error("  Sandbox is untouched — no data was lost.");
  bail(`Missing credential: ${rebuildCredentialEnv}`);
  return false;
}

function printRebuildVersionSummary(
  sandboxName: string,
  agentName: string,
  versionCheck: ReturnType<typeof sandboxVersion.checkAgentVersion>,
): void {
  console.log("");
  console.log(`  ${B}Rebuild sandbox '${sandboxName}'${R}`);
  if (versionCheck.sandboxVersion) {
    console.log(`    Current:  ${agentName} v${versionCheck.sandboxVersion}`);
  }
  if (versionCheck.expectedVersion) {
    console.log(`    Target:   ${agentName} v${versionCheck.expectedVersion}`);
  }
  console.log("");
}

async function reapplyMessagingManifestAfterOpenClawDoctor(
  sandboxName: string,
  plan: SandboxMessagingPlan | null,
  log: (msg: string) => void,
): Promise<void> {
  if (!plan || plan.agent !== "openclaw") {
    log("Messaging manifest reapply skipped: no OpenClaw messaging plan");
    return;
  }

  try {
    log("Reapplying messaging manifest render and post-agent-install hooks after doctor");
    const result = await MessagingSetupApplier.applyAgentConfigAtOpenShell(plan, {
      runOpenshell: runMessagingOpenshell,
      runHook: (request) => hookOutputsFromBuildSteps(plan, request),
    });
    log(
      `messaging manifest reapply: targets=${result.appliedTargets.join(",")}, hooks=${result.appliedHooks.join(",")}`,
    );
    if (result.appliedTargets.length > 0 || result.appliedHooks.length > 0) {
      console.log(`  ${G}✓${R} Messaging manifest config reapplied`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Messaging manifest reapply failed: ${message}`);
    console.log(`  ${D}Messaging manifest config reapply skipped (${message})${R}`);
  }
}

/**
 * Rebuild a live sandbox while preserving registered agent state and policies.
 *
 * Agent sandboxes force-refresh their base image before backup/delete so local
 * `Dockerfile.base` changes fail before destructive work and are applied to the
 * recreated sandbox image.
 */
export async function rebuildSandbox(
  sandboxName: string,
  options: string[] | RebuildSandboxOptions = {},
  opts: { throwOnError?: boolean } = {},
): Promise<void> {
  const normalized = normalizeRebuildSandboxOptions(options);
  const verbose = normalized.verbose === true || process.env.NEMOCLAW_REBUILD_VERBOSE === "1";
  const log: (msg: string) => void = verbose ? _rebuildLog : () => {};
  const skipConfirm = normalized.yes === true || normalized.force === true;
  // When called from upgradeSandboxes in a loop, throwOnError prevents
  // process.exit from aborting the entire batch on the first failure.
  const bail = opts.throwOnError
    ? (msg: string, _code = 1) => {
        throw new Error(msg);
      }
    : (_msg: string, code = 1) => process.exit(code);

  // Active session detection — enrich the confirmation prompt if sessions are active
  const rebuildActiveSessionCount = countActiveSandboxSessionsForRebuild(sandboxName);

  const sb = getRebuildSandboxEntryOrBail(sandboxName, bail);
  if (!sb) return;

  // Multi-agent guard (temporary — until swarm lands)
  if (!isSingleAgentRebuildSupported(sb, bail)) return;

  const rebuildAgent = sb.agent || null;
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const agentName = agentRuntime.getAgentDisplayName(agent);

  if (!checkRebuildGatewaySchemaPreflight(sandboxName, bail)) return;

  // Hydrate non-secret messaging config before the rebuild touches anything
  // destructive. The manifest plan in registry is the durable source; legacy
  // session channel fields are read only as compatibility fallback by
  // getStoredMessagingChannelConfig().
  {
    const rebuildSession = onboardSession.loadSession();
    const hydratedMessagingConfig = hydrateMessagingChannelConfig(
      getStoredMessagingChannelConfig(sandboxName, rebuildSession),
    );
    if (hydratedMessagingConfig) {
      log(
        `Stashed messaging config for rebuild: ${Object.keys(hydratedMessagingConfig).join(",")}`,
      );
    }
  }

  // Version check — show what's changing
  const versionCheck = sandboxVersion.checkAgentVersion(sandboxName);
  printRebuildVersionSummary(sandboxName, agentName, versionCheck);

  const rebuildConfirmed = await confirmSandboxRebuildIfNeeded(
    skipConfirm,
    rebuildActiveSessionCount,
  );
  if (!rebuildConfirmed) return;

  // Step 0: Preflight — verify recreate preconditions BEFORE destroying
  // anything. The most common rebuild failure is a missing provider credential
  // when onboard runs in non-interactive mode. Checking now lets us abort with
  // the sandbox still intact. See #2273.
  if (!preflightRebuildCredentials(sandboxName, sb, log, bail)) return;

  const rebuildMessagingPlan = await stageRebuildMessagingPlanOrBail(
    sandboxName,
    sb,
    rebuildAgent,
    log,
    bail,
  );

  // Step 1: Ensure sandbox is live for backup
  const recordedGateway = resolveSandboxGatewayName(sb);
  log(`Checking sandbox liveness on ${recordedGateway}: openshell sandbox list`);
  const liveRecovery = await captureSandboxListWithGatewayRecovery({
    gatewayName: recordedGateway,
  });
  const isLive = liveRecovery.result;
  log(
    `openshell sandbox list exit=${isLive.status}, output=${(isLive.output || "").substring(0, 200)}`,
  );
  const liveListIssue = detectOpenShellStateRpcResultIssue(isLive);
  if (liveListIssue) {
    printOpenShellStateRpcIssue(liveListIssue, {
      action: `rebuilding sandbox '${sandboxName}'`,
      command: `${CLI_NAME} ${sandboxName} rebuild`,
    });
    bail("OpenShell gateway schema mismatch.");
    return;
  }
  if (isLive.status !== 0) {
    printSandboxListFailureWithRecoveryContext(liveRecovery);
    bail("Failed to query running sandboxes from OpenShell.", isLive.status || 1);
    return;
  }
  const liveNames = parseLiveSandboxNames(isLive.output || "");
  log(`Live sandboxes: ${Array.from(liveNames).join(", ") || "(none)"}`);
  // Stale-sandbox recovery (#4497): the local registry still holds this entry,
  // but the live OpenShell gateway no longer lists the sandbox — a stuck or
  // diverged provision, or the live container was reaped. This is exactly the
  // state `status` flags with a `rebuild --yes` hint, and the non-destructive
  // `connect` recovery now preserves the registry entry so this rebuild can act
  // on it. There is no live workspace state to back up, so rather than aborting
  // with "Cannot back up state" — which dead-ended the very recovery path the
  // CLI recommended — skip the backup/restore steps and recreate the sandbox
  // from the preserved registry + onboard-session metadata.
  let staleRecovery = false;
  // Full registry snapshot captured before stale recovery touches anything
  // destructive. If the recovery recreate fails after the entry was removed,
  // the snapshot is restored verbatim so no local metadata (defaultSandbox,
  // customPolicies, every field) is silently dropped or mutated (#4497).
  let staleRegistrySnapshot: ReturnType<typeof registry.load> | null = null;
  if (!liveNames.has(sandboxName)) {
    const reconciled = await getReconciledSandboxGatewayState(sandboxName);
    if (reconciled.state === "present") {
      const lifecycle = getNamedGatewayLifecycleState(recordedGateway);
      if (lifecycle.state !== "healthy_named") {
        printWrongGatewayActiveGuidance(
          sandboxName,
          lifecycle.activeGateway,
          console.error,
          "rebuild --yes",
        );
        bail(
          `Could not confirm '${sandboxName}' against gateway '${recordedGateway}' (gateway '${lifecycle.activeGateway ?? "unknown"}' is active).`,
        );
        return;
      }
      // Live on the healthy named gateway (the list omitted it). Fall through to
      // the normal backup/rebuild path so workspace state is preserved.
      log("Sandbox live on the healthy named gateway; using normal rebuild path");
    } else if (reconciled.state === "missing") {
      // Genuinely absent on a healthy named gateway — stale-sandbox recovery.
      staleRecovery = true;
      staleRegistrySnapshot = JSON.parse(JSON.stringify(registry.load()));
      console.log("");
      console.log(
        `  ${YW}⚠${R} Sandbox '${sandboxName}' is registered locally but absent from the live OpenShell gateway.`,
      );
      console.log(
        "  No live workspace state to back up — recreating from the preserved registry metadata.",
      );
      log(
        "Stale-sandbox recovery: live sandbox missing on healthy named gateway; skipping backup/restore and recreating from registry metadata",
      );
    } else if (reconciled.state === "gateway_schema_mismatch") {
      console.error(reconciled.output);
      bail("OpenShell gateway schema mismatch.");
      return;
    } else {
      // Ambiguous gateway state (wrong gateway active, or the named gateway is
      // missing/unreachable/drifted). Do NOT destroy — a transient gateway
      // problem must never be mistaken for a gone sandbox. Surface guidance and
      // abort with the registry entry intact.
      if (reconciled.state === "wrong_gateway_active") {
        printWrongGatewayActiveGuidance(
          sandboxName,
          reconciled.activeGateway,
          console.error,
          "rebuild --yes",
        );
      } else {
        console.error(
          `  Sandbox '${sandboxName}' is not visible on gateway '${recordedGateway}' and its live state could not be confirmed.`,
        );
        console.error("  Your local registry entry has been preserved — nothing was removed.");
        printGatewayLifecycleHint(reconciled.output || "", sandboxName, console.error);
      }
      bail(`Could not confirm live state of '${sandboxName}' (gateway not in a known-good state).`);
      return;
    }
  }

  // Build agent base layers before backup/delete so Dockerfile.base errors leave
  // the existing sandbox intact. This is what applies local Hermes version edits.
  if (rebuildAgent) {
    const agentDef = loadAgent(rebuildAgent);
    try {
      ensureAgentBaseImage(agentDef, { forceBaseImageRebuild: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("");
      console.error(`  ${_RD}Rebuild preflight failed:${R} agent base image could not be built.`);
      console.error(`  ${message}`);
      console.error("");
      console.error("  Sandbox is untouched — no data was lost.");
      bail(message);
      return;
    }
  }

  // On stale-sandbox recovery the live sandbox is gone, so the normal
  // unlock→recreate→relock cycle cannot run: openRebuildShieldsWindow would call
  // `shieldsDown`, which captures policy from the absent sandbox and fails, and
  // a later `shieldsUp` would try to re-seal the fresh image against the gone
  // sandbox's stale file-hash seal and may refuse (#4497). Instead, just note
  // whether the sandbox was locked (read-only). The stale shields state is reset
  // only AFTER the recreate succeeds (below) so a failed recreate leaves the
  // lockdown record intact for a retry; the operator re-applies `shields up`
  // post-recovery (printed on success) since the workspace state was lost anyway.
  let staleSandboxWasLocked = false;
  let rebuildShieldsWindow: RebuildShieldsWindow | null;
  if (staleRecovery) {
    staleSandboxWasLocked = !shields.isShieldsDown(sandboxName);
    rebuildShieldsWindow = { relocked: false, wasLocked: false };
  } else {
    rebuildShieldsWindow = openRebuildShieldsWindow(sandboxName, CLI_NAME);
  }
  if (!rebuildShieldsWindow) return bail("Failed to auto-unlock shields.");

  const relockShieldsIfNeeded = (sandboxStillExists: boolean): boolean =>
    relockRebuildShieldsWindow(sandboxName, rebuildShieldsWindow, sandboxStillExists, CLI_NAME);

  let sandboxStillExists = true;

  // backupManifest stays null on stale-sandbox recovery (#4497): the live
  // sandbox is gone, so there is nothing to back up and the downstream
  // restore/preset steps are skipped in favor of recreating from registry
  // metadata.
  let backupManifest: sandboxState.RebuildManifest | null = null;

  try {
    // Step 2: Backup (skipped on stale-sandbox recovery -- no live state exists)
    if (!staleRecovery) {
      console.log("  Backing up sandbox state...");
      log(`Agent type: ${sb.agent || "openclaw"}, stateDirs from manifest`);
      const backup = sandboxState.backupSandboxState(sandboxName);
      log(
        `Backup result: success=${backup.success}, backed=${backup.backedUpDirs.join(",")}; files=${backup.backedUpFiles.join(",")}, failed=${backup.failedDirs.join(",")}; failedFiles=${backup.failedFiles.join(",")}`,
      );
      const hasAnyBackup = backup.backedUpDirs.length > 0 || backup.backedUpFiles.length > 0;
      if (!backup.success && !hasAnyBackup) {
        // Total failure — nothing was backed up at all.
        console.error("  Failed to back up sandbox state.");
        if (backup.failedDirs.length > 0) {
          console.error(`  Failed: ${backup.failedDirs.join(", ")}`);
        }
        if (backup.failedFiles.length > 0) {
          console.error(`  Failed files: ${backup.failedFiles.join(", ")}`);
        }
        console.error("  Aborting rebuild to prevent data loss.");
        relockShieldsIfNeeded(true);
        bail("Failed to back up sandbox state.");
        return;
      }
      backupManifest = backup.manifest ?? null;
      if (!backupManifest) {
        console.error("  Failed to record backup metadata.");
        console.error("  Aborting rebuild to prevent data loss.");
        relockShieldsIfNeeded(true);
        bail("Failed to record backup metadata.");
        return;
      }
      if (!backup.success) {
        // Partial backup — some state succeeded, some failed (e.g. root-owned
        // files caused tar permission errors).  Proceed with a warning so the
        // rebuild isn't blocked by a handful of inaccessible files (#2727).
        console.warn(
          `  ${YW}⚠${R} Partial backup: ${backup.backedUpDirs.length} dirs and ` +
            `${backup.backedUpFiles.length} files OK; ${backup.failedDirs.length} dirs and ` +
            `${backup.failedFiles.length} files failed`,
        );
        if (backup.failedDirs.length > 0) {
          console.warn(`    Failed dirs: ${backup.failedDirs.join(", ")}`);
        }
        if (backup.failedFiles.length > 0) {
          console.warn(`    Failed files: ${backup.failedFiles.join(", ")}`);
        }
        console.warn("    Rebuild will continue — failed state could not be preserved.");
      } else {
        console.log(
          `  ${G}\u2713${R} State backed up (${backup.backedUpDirs.length} directories, ${backup.backedUpFiles.length} files)`,
        );
      }
      console.log(`    Backup: ${backupManifest.backupPath}`);
    }

    // Step 3: Delete sandbox without tearing down gateway or session.
    // sandboxDestroy() cleans up the gateway when it's the last sandbox and
    // nulls session.sandboxName — both break the immediate onboard --resume.
    console.log("  Deleting old sandbox...");
    const sbMeta = registry.getSandbox(sandboxName);
    log(
      `Registry entry: agent=${sbMeta?.agent}, agentVersion=${sbMeta?.agentVersion}, nimContainer=${sbMeta?.nimContainer}`,
    );
    if (sbMeta && sbMeta.nimContainer) {
      log(`Stopping NIM container: ${sbMeta.nimContainer}`);
      nim.stopNimContainerByName(sbMeta.nimContainer);
    } else {
      // Best-effort cleanup — see comment in sandboxDestroy.
      nim.stopNimContainer(sandboxName, { silent: true });
    }

    log(`Running: openshell sandbox delete ${sandboxName}`);
    const deleteResult = runOpenshell(["sandbox", "delete", sandboxName], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { alreadyGone } = getSandboxDeleteOutcome(deleteResult);
    log(`Delete result: exit=${deleteResult.status}, alreadyGone=${alreadyGone}`);
    if (deleteResult.status !== 0 && !alreadyGone) {
      console.error("  Failed to delete sandbox. Aborting rebuild.");
      if (backupManifest) {
        console.error("  State backup is preserved at: " + backupManifest.backupPath);
      }
      relockShieldsIfNeeded(true);
      bail("Failed to delete sandbox.", deleteResult.status || 1);
      return;
    }
    sandboxStillExists = false;
    removeSandboxRegistryEntry(sandboxName);
    log(
      `Registry after remove: ${JSON.stringify(registry.listSandboxes().sandboxes.map((s: { name: string }) => s.name))}`,
    );
    console.log(`  ${G}\u2713${R} Old sandbox deleted`);

    // Step 4: Recreate via onboard --resume
    console.log("");
    console.log("  Creating new sandbox with current image...");

    // Force the sandbox name so onboard recreates with the same name.
    // Mark session resumable and point at this sandbox; set env var as fallback.
    const sessionBefore = onboardSession.loadSession();
    const sessionMatchesSandbox = sessionBefore?.sandboxName === sandboxName;
    const rebuildsHermesSandbox = rebuildAgent === "hermes";
    let registryHermesToolGateways: string[] | null = null;
    if (rebuildsHermesSandbox && Array.isArray(sb.hermesToolGateways)) {
      registryHermesToolGateways = sb.hermesToolGateways.filter(
        (value: unknown): value is string => typeof value === "string",
      );
    }
    const sessionHermesToolGateways =
      rebuildsHermesSandbox &&
      sessionMatchesSandbox &&
      Array.isArray(sessionBefore?.hermesToolGateways)
        ? sessionBefore.hermesToolGateways.filter(
            (value: unknown): value is string => typeof value === "string",
          )
        : null;
    const rebuildHermesToolGateways = rebuildsHermesSandbox
      ? (registryHermesToolGateways ?? sessionHermesToolGateways ?? [])
      : [];
    const hasRebuildHermesToolGateways =
      rebuildsHermesSandbox &&
      (registryHermesToolGateways !== null || sessionHermesToolGateways !== null);
    log(
      `Session before update: sandboxName=${sessionBefore?.sandboxName}, status=${sessionBefore?.status}, resumable=${sessionBefore?.resumable}, provider=${sessionBefore?.provider}, model=${sessionBefore?.model}, sessionMatch=${sessionMatchesSandbox}`,
    );

    // Sync the session's agent field with the registry so onboard --resume
    // rebuilds the correct sandbox type.  Without this, a stale session.agent
    // from a previous onboard of a *different* agent type would be picked up
    // by resolveAgentName() and the wrong Dockerfile would be used.  (#2201)
    onboardSession.updateSession((s: Session) => {
      s.sandboxName = sandboxName;
      s.resumable = true;
      s.status = "in_progress";
      s.agent = rebuildAgent;
      s.messagingPlan = rebuildMessagingPlan;
      s.hermesToolGateways = rebuildsHermesSandbox ? rebuildHermesToolGateways : [];
      // Persist inference selection from the about-to-be-removed registry entry
      // so onboard --resume can recreate with the same provider/model in
      // non-interactive mode. Without this the registry is gone by the time
      // setupNim runs, leaving no recovery source. Assign explicitly (with a
      // null fallback) so a missing registry value doesn't silently leave a
      // stale session entry from an earlier sandbox in place.
      s.provider = sb.provider ?? null;
      s.model = sb.model ?? null;
      s.nimContainer = sb.nimContainer ?? null;
      return s;
    });
    process.env.NEMOCLAW_SANDBOX_NAME = sandboxName;

    const sessionAfter = onboardSession.loadSession();
    log(
      `Session after update: sandboxName=${sessionAfter?.sandboxName}, status=${sessionAfter?.status}, resumable=${sessionAfter?.resumable}, provider=${sessionAfter?.provider}, model=${sessionAfter?.model}`,
    );
    log(
      `Env: NEMOCLAW_SANDBOX_NAME=${process.env.NEMOCLAW_SANDBOX_NAME}, NEMOCLAW_RECREATE_SANDBOX=${process.env.NEMOCLAW_RECREATE_SANDBOX}`,
    );

    // Forward the stored --from Dockerfile path so onboard --resume uses the
    // same custom image.  Without this, the conflict check rejects the resume
    // because requestedFrom (null) !== recordedFrom (the stored path).  (#2301)
    // Only read from the session when it belongs to this sandbox to avoid
    // using config from a different sandbox's onboard run.
    const storedFromDockerfile = sessionMatchesSandbox
      ? sessionAfter?.metadata?.fromDockerfile || null
      : null;
    log(
      `Calling onboard({ resume: true, nonInteractive: true, recreateSandbox: true, fromDockerfile: ${storedFromDockerfile} })`,
    );

    // Intercept process.exit during onboard so we can attempt rollback
    // instead of dying with the sandbox destroyed.  onboard() has ~87
    // process.exit() calls that would otherwise kill the process with no
    // chance to recover.  See #2273.
    //
    // NOTE: Throwing from the overridden process.exit unwinds onboard's
    // call stack, which skips process.once("exit") listeners (lock
    // release, build context cleanup, session failure marking).  We
    // manually release the lock and mark the session failed in the
    // onboardFailed block below.
    const { onboard } = require("../../onboard");
    let onboardFailed = false;
    let onboardExitCode = 1;
    const _savedExit = process.exit;
    process.exit = ((code) => {
      onboardFailed = true;
      onboardExitCode = typeof code === "number" ? code : 1;
      // Throw a sentinel to unwind the onboard call stack.
      // The catch block below handles it.
      const err = new Error(`onboard exited with code ${onboardExitCode}`);
      err.name = "RebuildOnboardExit";
      throw err;
    }) as typeof process.exit;

    // Reaching here means the user already consented to the destructive
    // rebuild (either via --yes/--force or by answering "y" at the prompt).
    // Propagate that consent so the size-confirm gate inside the
    // non-interactive onboard does not abort after the old sandbox has
    // been deleted. The recreate path also inherits the original sandbox's
    // no-GPU intent so the inner `onboard --resume` does not enforce the
    // Docker CDI GPU preflight on hosts without an NVIDIA GPU.
    const recreateOpts = buildRebuildRecreateOnboardOpts({
      sb,
      rebuildAgent,
      storedFromDockerfile,
      autoYes: skipConfirm || rebuildConfirmed,
    });
    try {
      await onboard(recreateOpts);
      log("onboard() returned successfully");
    } catch (err) {
      onboardFailed = true;
      const message = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : "";
      if (name !== "RebuildOnboardExit") {
        log(`onboard() threw: ${message}`);
      }
    } finally {
      process.exit = _savedExit;
    }

    if (!onboardFailed) {
      sandboxStillExists = true;
    }

    if (onboardFailed) {
      // Clean up onboard's internal state that normally runs in
      // process.once("exit") listeners — those never fire because we
      // threw from the overridden process.exit instead of actually
      // exiting.  Without this the onboard lock file stays on disk and
      // blocks the next onboard/rebuild invocation.
      try {
        onboardSession.releaseOnboardLock();
      } catch {
        /* best effort */
      }
      try {
        const failedStep = onboardSession.loadSession()?.lastStepStarted;
        if (failedStep) {
          onboardSession.markStepFailed(failedStep, "Rebuild recreate failed");
        }
      } catch {
        /* best effort */
      }

      // Stale-sandbox recovery had no backup to fall back on and already removed
      // the registry entry before the recreate. If the recreate failed, restore
      // the captured entry so the recommended `rebuild --yes` (and `connect`)
      // remain retryable instead of failing at dispatch with "not found in
      // registry" (#4497). Restore unconditionally — overwriting any partial entry
      // a failed `onboard` may have registered — so the original metadata
      // (defaultSandbox, customPolicies, every field) wins, not a half-written
      // recreate entry. The restore targets only this sandbox under the registry
      // lock, leaving other sandboxes' concurrent changes intact.
      const snapshotEntry = staleRegistrySnapshot?.sandboxes?.[sandboxName];
      if (staleRecovery && snapshotEntry) {
        try {
          registry.restoreSandboxEntry(snapshotEntry, {
            reclaimDefault:
              staleRegistrySnapshot?.defaultSandbox === sandboxName ? sandboxName : null,
          });
          log("Stale-recovery recreate failed: restored preserved registry entry for retry");
        } catch (err) {
          log(
            `Failed to restore registry entry after stale-recovery recreate failure: ${String(err)}`,
          );
        }
      }

      console.error("");
      if (staleRecovery) {
        console.error(`  ${_RD}Recovery recreate failed.${R}`);
        console.error(
          "  Your local registry entry has been preserved — you can retry once the issue above is fixed.",
        );
      } else {
        console.error(`  ${_RD}Recreate failed after sandbox was destroyed.${R}`);
      }
      if (backupManifest) {
        console.error(`  Backup is preserved at: ${backupManifest.backupPath}`);
      }
      console.error("");
      console.error("  To recover manually:");
      console.error(`    1. Fix the issue above (missing credential, Docker problem, etc.)`);
      console.error(`    2. Run: ${CLI_NAME} onboard --resume`);
      console.error(`       This will recreate sandbox '${sandboxName}'.`);
      if (backupManifest) {
        console.error(`    3. Then restore your workspace state:`);
        console.error(
          `       ${CLI_NAME} ${sandboxName} snapshot restore "${backupManifest.timestamp}"`,
        );
      }
      printRebuildShieldsRecovery(sandboxName, rebuildShieldsWindow, CLI_NAME);
      console.error("");
      relockShieldsIfNeeded(false);
      bail(
        backupManifest
          ? `Recreate failed (sandbox destroyed). Backup: ${backupManifest.backupPath}`
          : "Recreate failed (stale-sandbox recovery).",
        onboardExitCode,
      );
      return;
    }

    // Recreate succeeded. For stale recovery, reset the now-stale shields state so
    // the freshly recreated (mutable) sandbox reports its true posture instead of
    // the gone sandbox's old lock seal. Deferred until here so a failed recreate
    // above leaves the lockdown record intact for a retry (#4497).
    if (staleRecovery) {
      shields.clearShieldsState(sandboxName);
    }

    const preservedRegistryFields = {
      ...(hasRebuildHermesToolGateways
        ? { hermesToolGateways: [...rebuildHermesToolGateways] }
        : {}),
    };
    if (Object.keys(preservedRegistryFields).length > 0) {
      registry.updateSandbox(sandboxName, preservedRegistryFields);
    }

    // Step 5: Restore (skipped on stale-sandbox recovery -- no backup exists)
    let restoreSucceeded = true;
    if (backupManifest) {
      console.log("");
      console.log("  Restoring workspace state...");
      log(`Restoring from: ${backupManifest.backupPath} into sandbox: ${sandboxName}`);
      const restore = sandboxState.restoreSandboxState(sandboxName, backupManifest.backupPath);
      log(
        `Restore result: success=${restore.success}, restored=${restore.restoredDirs.join(",")}; files=${restore.restoredFiles.join(",")}, failed=${restore.failedDirs.join(",")}; failedFiles=${restore.failedFiles.join(",")}`,
      );
      restoreSucceeded = restore.success;
      if (!restore.success) {
        console.error(`  Partial restore: ${restore.restoredDirs.join(", ") || "none"}`);
        console.error(`  Failed: ${restore.failedDirs.join(", ")}`);
        if (restore.failedFiles.length > 0) {
          console.error(`  Failed files: ${restore.failedFiles.join(", ")}`);
        }
        console.error(`  Manual restore available from: ${backupManifest.backupPath}`);
      } else {
        console.log(
          `  ${G}\u2713${R} State restored (${restore.restoredDirs.length} directories, ${restore.restoredFiles.length} files)`,
        );
      }
    }

    // Step 5.5: Restore policy presets (#1952)
    // Built-in policy presets live in the gateway policy engine, not the sandbox
    // filesystem, so they are lost when the sandbox is destroyed and recreated.
    // Re-apply the presets captured in the backup manifest. On stale-sandbox
    // recovery there is no manifest, so fall back to the built-in preset names
    // recorded on the registry entry (`sb.policies`) — the same source the backup
    // manifest is built from — so the recovered sandbox keeps its built-in egress
    // presets (#4497). Custom `policy-add --from-file/--from-dir` rules
    // (`sb.customPolicies`) are not re-applied here; like a normal rebuild, they
    // follow the recreate/onboard path and must be re-added if they were in use.
    const registryPolicyPresets = Array.isArray(sb.policies)
      ? sb.policies.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const rebuildDisabledChannels = [...(rebuildMessagingPlan?.disabledChannels ?? [])];
    const savedPresets = pruneDisabledMessagingPolicyPresets(
      backupManifest?.policyPresets ?? registryPolicyPresets,
      rebuildDisabledChannels,
    );
    if (savedPresets.length > 0) {
      console.log("");
      console.log("  Restoring policy presets...");
      log(`Policy presets to restore: [${savedPresets.join(",")}]`);
      const restoredPresets: string[] = [];
      const failedPresets: string[] = [];
      for (const presetName of savedPresets) {
        try {
          log(`Applying preset: ${presetName}`);
          const applied = policies.applyPreset(sandboxName, presetName);
          if (applied) {
            restoredPresets.push(presetName);
          } else {
            failedPresets.push(presetName);
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log(`Failed to apply preset '${presetName}': ${errorMessage}`);
          failedPresets.push(presetName);
        }
      }
      if (restoredPresets.length > 0) {
        console.log(`  ${G}\u2713${R} Policy presets restored: ${restoredPresets.join(", ")}`);
      }
      if (failedPresets.length > 0) {
        console.error(`  ${YW}\u26a0${R} Failed to restore presets: ${failedPresets.join(", ")}`);
        console.error(`    Re-apply manually with: ${CLI_NAME} ${sandboxName} policy-add`);
      }
    }

    // Step 6: Post-restore agent-specific migration
    const rebuiltAgent = agentRuntime.getSessionAgent(sandboxName);
    const rebuiltAgentName = agentRuntime.getAgentDisplayName(rebuiltAgent);
    const agentDef = rebuiltAgent ? loadAgent(rebuiltAgent.name) : loadAgent("openclaw");
    // #4538: set when the post-upgrade mutable-config permission repair ran but
    // could not verify the contract — the rebuilt sandbox may still EACCES on
    // gateway-side config writes, so the final result is downgraded below.
    let mutablePermsRepairUnverified = false;
    let mutableConfigHashRefreshUnverified = false;
    if (agentDef.name === "openclaw") {
      // openclaw doctor --fix validates and repairs directory structure.
      // Idempotent and safe — catches structural changes between OpenClaw versions
      // (new symlinks, new data dirs, etc.) that the restored state may be missing.
      log("Running openclaw doctor --fix inside sandbox for post-upgrade structure repair");
      const doctorResult = executeSandboxCommand(sandboxName, "openclaw doctor --fix");
      log(
        `doctor --fix: exit=${doctorResult?.status}, stdout=${(doctorResult?.stdout || "").substring(0, 200)}`,
      );
      if (doctorResult && doctorResult.status === 0) {
        console.log(`  ${G}\u2713${R} Post-upgrade structure check passed`);
      } else {
        console.log(
          `  ${D}Post-upgrade structure check skipped (doctor returned ${doctorResult?.status ?? "null"})${R}`,
        );
      }

      // doctor --fix may rewrite openclaw.json after the image build applied
      // manifest-owned messaging render and post-agent-install build-file outputs.
      // Reapply the staged plan so channel config and WeChat account seed files
      // remain paired with the restored OpenClaw extension state.
      await reapplyMessagingManifestAfterOpenClawDoctor(sandboxName, rebuildMessagingPlan, log);

      // The post-restore structure repair and seed helper can rewrite
      // openclaw.json after restoreStateFile has already refreshed
      // .config-hash. Refresh the mutable hash here so the gateway token and
      // channel seed changes are integrity-valid before the sandbox is handed
      // back to the user.
      log("Refreshing mutable OpenClaw config hash after post-restore config writes");
      if (!refreshMutableOpenClawConfigHashAfterPostRestoreWrites(sandboxName, log)) {
        mutableConfigHashRefreshUnverified = true;
      }

      // #4538: `openclaw doctor --fix` enforces a single-user 700/600 state
      // layout, which silently tightens NemoClaw's mutable config contract
      // (setgid + group-writable /sandbox/.openclaw and group-writable
      // openclaw.json). Run this LAST in the OpenClaw post-restore sequence —
      // after doctor --fix and messaging manifest reapply, both of which can
      // rewrite openclaw.json — so the
      // restored contract is not immediately undone. No-op for shields-up
      // sandboxes (config is intentionally root-owned/locked).
      log("Restoring mutable OpenClaw config permissions after post-restore config writes");
      // The shields wrapper can throw before it returns a structured result
      // (validateName, or getShieldsPosture triggering inline auto-restore). A
      // thrown error here must not abort the rest of the rebuild — treat it as an
      // unverified repair and continue.
      let permRepair: ReturnType<typeof shields.repairMutableConfigPerms> | null = null;
      try {
        permRepair = shields.repairMutableConfigPerms(sandboxName);
      } catch (err) {
        mutablePermsRepairUnverified = true;
        console.error(
          `  ${YW}⚠${R} Mutable config permission repair errored: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (permRepair === null) {
        // already handled above
      } else if (!permRepair.applied) {
        if (permRepair.skipReason === "unreadable") {
          // Posture could not be determined, so the contract may still be broken.
          // This is NOT a benign skip — surface it as incomplete.
          mutablePermsRepairUnverified = true;
          console.error(
            `  ${YW}⚠${R} Mutable config permissions not restored: ${permRepair.reason}`,
          );
        } else {
          // "locked" (shields up — config is intentionally root-owned/locked) or
          // "agent": a deliberate no-op, not a broken contract. Do not downgrade.
          log(`Mutable config permission repair skipped: ${permRepair.reason}`);
        }
      } else if (permRepair.verified) {
        console.log(`  ${G}✓${R} Mutable config permissions restored`);
      } else {
        mutablePermsRepairUnverified = true;
        console.error(
          `  ${YW}⚠${R} Mutable config permission repair incomplete: ${permRepair.errors.join("; ")}`,
        );
      }
    }
    // Hermes: no explicit post-restore step needed. Hermes's SessionDB._init_schema()
    // auto-migrates state.db (SQLite) on first connection via sequential ALTER TABLE
    // migrations (idempotent, schema_version tracked). ensure_hermes_home() repairs
    // missing directories implicitly. The NemoClaw plugin's skill cache refreshes on
    // on_session_start. Gateway startup is non-fatal if state.db migration fails.

    // Step 7: Update registry with new version
    registry.updateSandbox(sandboxName, {
      agentVersion: agentDef.expectedVersion || null,
    });
    log(`Registry updated: agentVersion=${agentDef.expectedVersion}`);

    if (!relockShieldsIfNeeded(true)) return bail("Failed to re-apply shields lockdown.");

    console.log("");
    if (restoreSucceeded && !mutablePermsRepairUnverified && !mutableConfigHashRefreshUnverified) {
      console.log(`  ${G}\u2713${R} Sandbox '${sandboxName}' rebuilt successfully`);
      if (staleRecovery) {
        console.log(
          `    ${D}Recovered from a stale registry entry \u2014 no prior workspace state was available to restore.${R}`,
        );
      }
      if (versionCheck.expectedVersion) {
        console.log(`    Now running: ${rebuiltAgentName} v${versionCheck.expectedVersion}`);
      }
    } else {
      // At least one post-restore step is incomplete. Surface every applicable
      // failure (#4538: a failed state restore and an unverified permission
      // repair are independent \u2014 report both so the operator does not miss the
      // backup-restore recovery just because permissions also need attention).
      console.log(
        `  ${YW}\u26a0${R} Sandbox '${sandboxName}' rebuilt but some post-restore steps were incomplete`,
      );
      if (!restoreSucceeded && backupManifest) {
        console.log(
          `    State restore was incomplete \u2014 backup available at: ${backupManifest.backupPath}`,
        );
      }
      if (mutablePermsRepairUnverified) {
        console.log(
          `    Mutable config permissions were not verified \u2014 run \`${CLI_NAME} ${sandboxName} doctor --fix\` to restore the OpenClaw config permission contract`,
        );
      }
      if (mutableConfigHashRefreshUnverified) {
        console.log(
          `    Mutable OpenClaw config hash was not refreshed \u2014 restart the sandbox or re-run \`${CLI_NAME} ${sandboxName} rebuild\` before relying on config integrity checks`,
        );
      }
    }
    // Stale recovery reset the shields state to mutable (the gone sandbox's lock
    // seal could not carry over to the fresh image). If lockdown had been enabled,
    // tell the operator to re-apply it on the recreated sandbox (#4497).
    if (staleRecovery && staleSandboxWasLocked) {
      console.log(
        `    ${YW}\u26a0${R} Shields were previously enabled but the recreated sandbox starts unlocked \u2014 run \`${CLI_NAME} ${sandboxName} shields up\` to restore lockdown.`,
      );
    }
  } finally {
    if (!rebuildShieldsWindow.relocked) {
      relockShieldsIfNeeded(sandboxStillExists);
    }
  }
}
