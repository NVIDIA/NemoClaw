// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { CLI_NAME } from "../../cli/branding";
import { prompt as askPrompt } from "../../credentials/store";
import {
  normalizeRebuildSandboxOptions,
  type RebuildSandboxOptions,
} from "../../domain/lifecycle/options";

type AuthoritativeMessagingReuse = NonNullable<
  import("./rebuild-gpu-opt-out").RebuildRecreateOnboardOpts["authoritativeMessagingReuse"]
>;

const onboardModule = require("../../onboard") as {
  isInferenceRouteReady: (provider: string, model: string) => boolean;
  onboard: (options: import("./rebuild-gpu-opt-out").RebuildRecreateOnboardOpts) => Promise<void>;
  preflightAuthoritativeHermesToolGateways: (options: {
    sandboxName: string;
    targetGatewayName: string;
    toolGateways: string[];
  }) => Promise<string | null>;
  preflightAuthoritativeProviderAttachments: (options: {
    targetGatewayName: string;
    providerNames: string[];
  }) => Promise<void>;
  preflightAuthoritativeRebuildCreatePolicy: (options: {
    agentName: string | null;
    activeMessagingChannels: string[];
    hermesToolGateways: string[];
    recordedPolicyPresets: string[];
    customPolicies: registry.CustomPolicyEntry[];
    policyTier: string | null;
    sandboxGpuConfig: import("../../onboard/sandbox-gpu-mode").SandboxGpuConfig;
  }) => import("../../onboard/initial-policy").InitialSandboxPolicy;
  preflightAuthoritativeRebuildMessagingConflicts: (options: {
    sandboxName: string;
    targetGatewayName: string;
    webSearchEnabled: boolean;
  }) => Promise<AuthoritativeMessagingReuse>;
  snapshotAuthoritativeRebuildMessagingState: (options: {
    sandboxName: string;
    targetGatewayName: string;
    webSearchEnabled: boolean;
  }) => AuthoritativeMessagingReuse;
  preflightAuthoritativeRebuildTarget: (
    options: import("./rebuild-gpu-opt-out").RebuildRecreateOnboardOpts & {
      model: string;
      provider: string;
      sandboxName: string;
    },
  ) => Promise<import("../../onboard/fatal-runtime-preflight").FatalRuntimePreflightResult>;
};
const hermesProviderAuth = require("../../hermes-provider-auth") as {
  HERMES_PROVIDER_NAME: string;
  HERMES_NOUS_API_KEY_CREDENTIAL_ENV: string;
  isHermesProviderRegistered: (runOpenshellFn: typeof runOpenshell) => boolean;
};

import {
  detectOpenShellStateRpcPreflightIssue,
  printOpenShellStateRpcIssue,
} from "../../adapters/openshell/gateway-drift";
import { resolveOpenshell } from "../../adapters/openshell/resolve";
import { captureOpenshell, runOpenshell } from "../../adapters/openshell/runtime";
import { loadAgent } from "../../agent/defs";
import * as agentRuntime from "../../agent/runtime";
import { RD as _RD, B, D, G, R, YW } from "../../cli/terminal-style";
import { getSandboxDeleteOutcome } from "../../domain/sandbox/destroy";
import type {
  MessagingHookApplyRequest,
  MessagingHookOutputMap,
  MessagingOpenShellRunner,
  SandboxMessagingPlan,
} from "../../messaging";
import {
  createBuiltInChannelManifestRegistry,
  createBuiltInRenderTemplateResolver,
  isMessagingSupportedAgent,
  listSupportedMessagingChannelIdsForAgent,
  MessagingSetupApplier,
  MessagingWorkflowPlanner,
  tryGetMessagingAgentId,
} from "../../messaging";
import { MESSAGING_SETUP_APPLIER_ENV_KEY } from "../../messaging/applier/types";
import {
  getMessagingChannelConfigEnvKeys,
  hydrateMessagingChannelConfig,
  MESSAGING_CHANNEL_CONFIG_ENV_KEYS,
} from "../../messaging-channel-config";
import { markLastStartedStepFailed } from "../../onboard/exit-step-failure";
import { normalizeHermesToolGatewaySelections } from "../../onboard/hermes-managed-tools";
import { getStoredMessagingChannelConfig } from "../../onboard/messaging-config";
import { mergeRebuildMessagingPolicyPresets } from "../../onboard/messaging-policy-presets";
import * as policies from "../../policy";
import { shellQuote } from "../../runner";
import { parseLiveSandboxNames, parseReadySandboxNames } from "../../runtime-recovery";
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
import { ensureMessagingHostForwardAfterRebuild } from "./messaging-host-forward-lifecycle";
import { executeSandboxCommand } from "./process-recovery";
import {
  cleanupPreparedRebuildBuildContext,
  preflightRebuildImage,
} from "./rebuild-custom-image-preflight";
import { isolateAmbientRecreateEnv } from "./rebuild-env-isolation";
import {
  backupSandboxStateForRebuild,
  ensureRebuildAgentBaseImage,
  ensureRebuildTargetGatewaySelected,
  openRebuildShieldsWindowForState,
  pinRebuildAgentBaseImageForRecreate,
  type RebuildSandboxEntry,
  resolveRebuildLiveState,
} from "./rebuild-flow-helpers";
import { buildRebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import { preflightRebuildInferenceRoute } from "./rebuild-inference-preflight";
import { beginRebuildProviderDetachOrBail } from "./rebuild-provider-detach-transaction";
import {
  checkRebuildGatewayProviderOrBail,
  shouldVerifyRebuildGatewayProvider,
} from "./rebuild-provider-preflight";
import {
  getRebuildCredentialEnvFromRegistry,
  isLocalInferenceProvider,
  prepareRebuildResumeConfig,
} from "./rebuild-resume-config";
import { printRebuildShieldsRecovery, relockRebuildShieldsWindow } from "./rebuild-shields";
import {
  installPrependedExitAndSignalRecovery,
  installRetainedResourceSignalCleanup,
} from "./rebuild-signal-cleanup";
import { preflightRebuildBraveSearchRoute } from "./rebuild-web-search-preflight";

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
  log("Hermes Provider rebuild preflight: recorded OpenShell provider is missing");

  console.error("");
  console.error(
    `  ${_RD}Rebuild preflight failed:${R} Hermes Provider is not registered in OpenShell.`,
  );
  console.error("  Hermes Provider credentials must be stored in OpenShell, not host-side files.");
  if (authMethod === "api_key") {
    console.error(
      `  Re-run ${CLI_NAME} onboard to register the Hermes Provider before rebuilding.`,
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

export async function stageMessagingManifestPlanForRebuild(
  sandboxName: string,
  sandboxEntry: registry.SandboxEntry,
  rebuildAgent: string | null,
  log: (msg: string) => void,
): Promise<SandboxMessagingPlan | null> {
  const agent = loadAgent(rebuildAgent || "openclaw");
  const manifestRegistry = createBuiltInChannelManifestRegistry();
  const manifests = manifestRegistry.list();
  const agentId = tryGetMessagingAgentId(agent, manifests);
  if (agentId === null) {
    MessagingSetupApplier.clearPlanEnv();
    log(
      `Messaging manifest rebuild plan skipped: agent '${agent.name}' is not supported by any channel manifest`,
    );
    return null;
  }
  if (!isMessagingSupportedAgent(agent, manifests)) {
    MessagingSetupApplier.clearPlanEnv();
    log(
      `Messaging manifest rebuild plan skipped: agent '${agent.name}' has no supported messaging channels`,
    );
    return null;
  }
  const supportedChannelIds = listSupportedMessagingChannelIdsForAgent(manifests, agentId);
  const planner = new MessagingWorkflowPlanner(
    manifestRegistry,
    undefined,
    createBuiltInRenderTemplateResolver(),
  );
  const plan = await planner.buildRebuildPlanFromSandboxEntry({
    sandboxName,
    agent: agentId,
    sandboxEntry,
    supportedChannelIds,
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
    // Source boundary: persisted registry messaging plans and current channel
    // manifests are host-side inputs. If they drift or become invalid, rebuild
    // must fail here before backup/delete; remove this boundary only if manifest
    // staging becomes total over all persisted registry states.
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
  const registryCredentialEnv = getRebuildCredentialEnvFromRegistry(sb.provider, sb.credentialEnv);
  let rebuildCredentialEnv = registryCredentialEnv;
  if (sessionMatchesTarget && registryCredentialEnv === null) {
    rebuildCredentialEnv = session?.credentialEnv || null;
  }
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
    if (!checkRebuildGatewayProviderOrBail(rebuildProvider, rebuildCredentialEnv, log, bail)) {
      return false;
    }
    log(
      "Preflight credential check: no credentialEnv in session (local inference or missing session)",
    );
    return true;
  }

  if (shouldVerifyRebuildGatewayProvider(rebuildProvider)) {
    if (!checkRebuildGatewayProviderOrBail(rebuildProvider, rebuildCredentialEnv, log, bail)) {
      return false;
    }
    log(
      `Preflight credential check: provider '${rebuildProvider}' registered in gateway — using its stored credential instead of hydrating ${rebuildCredentialEnv} on the host`,
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

type RebuildInferenceSelection = Pick<
  AtomicRebuildPreflight["resumeConfig"],
  "model" | "preferredInferenceApi" | "provider"
>;

function validateRecordedInferenceRoute(
  sandboxName: string,
  selection: RebuildInferenceSelection,
  bail: RebuildBail,
): boolean {
  const inferenceProbe = preflightRebuildInferenceRoute({
    sandboxName,
    provider: selection.provider,
    model: selection.model,
    preferredInferenceApi: selection.preferredInferenceApi,
  });
  if (inferenceProbe.ok) return true;

  console.error("");
  console.error(
    `  ${_RD}Rebuild preflight failed:${R} recorded inference credentials or route for provider '${selection.provider}' were rejected.`,
  );
  console.error(`  ${redact(inferenceProbe.detail)}`);
  console.error("  Sandbox is untouched — no data was lost.");
  bail("Recorded inference route smoke check failed.");
  return false;
}

function preflightListedSandboxInferenceRoute(
  sandboxName: string,
  selection: RebuildInferenceSelection,
  bail: RebuildBail,
): boolean {
  let liveList: ReturnType<typeof captureOpenshell>;
  try {
    liveList = captureOpenshell(["sandbox", "list"], { ignoreError: true });
  } catch {
    // The authoritative liveness pass below owns list failures and gateway
    // recovery. A failed early read is not evidence that this is a live sandbox.
    return true;
  }
  if (liveList.status !== 0) return true;
  if (!parseReadySandboxNames(liveList.output || "").has(sandboxName)) return true;
  return validateRecordedInferenceRoute(sandboxName, selection, bail);
}

function hydrateMessagingConfigForRebuild(sandboxName: string, log: (msg: string) => void): void {
  const rebuildSession = onboardSession.loadSession();
  const hydratedMessagingConfig = hydrateMessagingChannelConfig(
    getStoredMessagingChannelConfig(sandboxName, rebuildSession),
  );
  if (hydratedMessagingConfig) {
    log(`Stashed messaging config for rebuild: ${Object.keys(hydratedMessagingConfig).join(",")}`);
  }
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
interface RebuildSandboxExecutionOptions {
  throwOnError?: boolean;
  /** Internal installer recovery input; never exposed as a CLI option. */
  recoveryManifest?: sandboxState.RebuildManifest;
}

type RebuildBail = (message: string, code?: number) => never;

function failPreparedRecoveryPreDelete(
  detail: string,
  errorMessage: string,
  bail: RebuildBail,
): never {
  console.error("");
  console.error(`  ${_RD}Recovery pre-delete check failed:${R} ${detail}.`);
  console.error("  Sandbox is untouched — no data was lost.");
  return bail(errorMessage);
}

function revalidatePreparedRecoveryBeforeDelete(
  sandboxName: string,
  initialEntry: RebuildSandboxEntry,
  candidate: sandboxState.RebuildManifest | null,
  registrySnapshot: registry.SandboxRegistry | null,
  bail: RebuildBail,
): {
  manifest: sandboxState.RebuildManifest | null;
  registrySnapshot: registry.SandboxRegistry | null;
} {
  if (!candidate) return { manifest: null, registrySnapshot };

  const refreshedRegistrySnapshot = JSON.parse(
    JSON.stringify(registry.load()),
  ) as registry.SandboxRegistry;
  const currentEntry = refreshedRegistrySnapshot.sandboxes[sandboxName];
  if (!currentEntry) {
    return failPreparedRecoveryPreDelete(
      "registry entry no longer exists",
      "Recovery registry identity changed during preflight.",
      bail,
    );
  }
  if (!isDeepStrictEqual(currentEntry, initialEntry)) {
    return failPreparedRecoveryPreDelete(
      "registered sandbox configuration changed during preflight",
      "Recovery registry configuration changed during preflight.",
      bail,
    );
  }

  const latestManifest = sandboxState.getLatestBackup(sandboxName);
  if (
    !latestManifest ||
    latestManifest.timestamp !== candidate.timestamp ||
    latestManifest.backupPath !== candidate.backupPath
  ) {
    return failPreparedRecoveryPreDelete(
      "latest prepared backup changed during preflight",
      "Recovery backup identity changed during preflight.",
      bail,
    );
  }

  const validation = sandboxState.validateRebuildRecoveryManifest(
    sandboxName,
    currentEntry.agent,
    latestManifest,
  );
  if (!validation.ok) {
    return failPreparedRecoveryPreDelete(
      validation.reason,
      `Invalid recovery manifest: ${validation.reason}`,
      bail,
    );
  }
  if (!sandboxState.hasPositiveManagedImageEvidence(currentEntry)) {
    return failPreparedRecoveryPreDelete(
      "registry no longer has a NemoClaw-managed image fingerprint",
      "Recovery registry entry has no NemoClaw-managed image fingerprint.",
      bail,
    );
  }

  return {
    manifest: validation.manifest,
    registrySnapshot: refreshedRegistrySnapshot,
  };
}

type AtomicRebuildPreflight = {
  hermesToolGateways: string[];
  hermesToolProvider: string | null;
  removePreflightSignalCleanup: () => void;
  recreateOpts: ReturnType<typeof buildRebuildRecreateOnboardOpts>;
  rebuildMessagingPlan: SandboxMessagingPlan | null;
  restoreBaseImagePin: () => void;
  resumeConfig: NonNullable<ReturnType<typeof prepareRebuildResumeConfig>>;
  storedFromDockerfile: string | null;
  webSearchConfig: import("../../inference/web-search").WebSearchConfig | null;
};

async function preflightAtomicRebuild(
  sandboxName: string,
  sb: RebuildSandboxEntry,
  rebuildAgent: string | null,
  autoYes: boolean,
  log: (message: string) => void,
  bail: RebuildBail,
): Promise<AtomicRebuildPreflight | null> {
  if (!(await ensureRebuildTargetGatewaySelected(sandboxName, sb, log, bail))) return null;
  if (!checkRebuildGatewaySchemaPreflight(sandboxName, bail)) return null;

  // #5735: registry + matching-session state is authoritative. Ambient
  // onboarding selection (including NEMOCLAW_PROVIDER_KEY) is isolated only
  // for the inner resume and never reinterpreted as a rebuild credential.
  const resumeConfig = prepareRebuildResumeConfig(sandboxName, sb, rebuildAgent, log, bail);
  if (!resumeConfig) return null;
  const credentialEntry = {
    ...sb,
    provider: resumeConfig.provider,
    model: resumeConfig.model,
    credentialEnv: resumeConfig.credentialEnv,
  };
  if (!preflightRebuildCredentials(sandboxName, credentialEntry, log, bail)) return null;
  if (!preflightListedSandboxInferenceRoute(sandboxName, resumeConfig, bail)) return null;

  const rebuildMessagingPlan = await stageRebuildMessagingPlanOrBail(
    sandboxName,
    sb,
    rebuildAgent,
    log,
    bail,
  );
  const preflightSession = onboardSession.loadSession();
  const preflightSessionMatchesSandbox = preflightSession?.sandboxName === sandboxName;
  const rawHermesToolGateways =
    rebuildAgent === "hermes"
      ? Array.isArray(sb.hermesToolGateways)
        ? sb.hermesToolGateways
        : preflightSessionMatchesSandbox
          ? preflightSession?.hermesToolGateways
          : []
      : [];
  const preflightHermesToolGateways = normalizeHermesToolGatewaySelections(rawHermesToolGateways);
  const unknownHermesToolGateways = Array.isArray(rawHermesToolGateways)
    ? rawHermesToolGateways.filter(
        (value): value is string =>
          typeof value === "string" && !preflightHermesToolGateways.includes(value),
      )
    : [];
  if (unknownHermesToolGateways.length > 0) {
    const message = `Unknown recorded Hermes managed tool gateway: ${unknownHermesToolGateways.join(", ")}.`;
    console.error("");
    console.error(`  ${_RD}Rebuild preflight failed:${R} ${message}`);
    console.error("  Sandbox is untouched — no data was lost.");
    bail(message);
    return null;
  }
  const managedImage = sandboxState.hasPositiveManagedImageEvidence(sb);
  const storedFromDockerfile =
    !managedImage && preflightSessionMatchesSandbox
      ? preflightSession?.metadata?.fromDockerfile || null
      : null;
  if (!managedImage && !storedFromDockerfile) {
    const message =
      "Cannot recreate a custom-image sandbox without its matching recorded Dockerfile path.";
    console.error("");
    console.error(`  ${_RD}Rebuild preflight failed:${R} ${message}`);
    console.error("  Sandbox is untouched — no data was lost.");
    bail(message);
    return null;
  }
  const webSearchConfig =
    preflightSessionMatchesSandbox && preflightSession?.webSearchConfig?.fetchEnabled === true
      ? preflightSession.webSearchConfig
      : null;
  if (
    !preflightSessionMatchesSandbox &&
    Array.isArray(sb.policies) &&
    sb.policies.includes("brave")
  ) {
    const message =
      "Cannot safely recreate a Brave-enabled sandbox without its matching onboarding session.";
    console.error("");
    console.error(`  ${_RD}Rebuild preflight failed:${R} ${message}`);
    console.error("  Sandbox is untouched — no data was lost.");
    bail(message);
    return null;
  }

  let recreateOpts: ReturnType<typeof buildRebuildRecreateOnboardOpts>;
  try {
    recreateOpts = buildRebuildRecreateOnboardOpts({
      sb,
      rebuildAgent,
      storedFromDockerfile,
      webSearchConfig,
      autoYes,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("");
    console.error(`  ${_RD}Rebuild preflight failed:${R} ${message}`);
    console.error("  Sandbox is untouched — no data was lost.");
    bail(message);
    return null;
  }

  try {
    recreateOpts.authoritativeMessagingReuse =
      await onboardModule.preflightAuthoritativeRebuildMessagingConflicts({
        sandboxName,
        targetGatewayName: recreateOpts.targetGatewayName,
        webSearchEnabled: webSearchConfig?.fetchEnabled === true,
      });
    recreateOpts.authoritativeMessagingPrevalidated = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("");
    console.error(`  ${_RD}Rebuild preflight failed:${R} messaging conflict checks did not pass.`);
    console.error(`  ${redact(message)}`);
    console.error("  Sandbox is untouched — no data was lost.");
    bail(message);
    return null;
  }

  let hermesToolProvider: string | null = null;
  try {
    hermesToolProvider = await onboardModule.preflightAuthoritativeHermesToolGateways({
      sandboxName,
      targetGatewayName: recreateOpts.targetGatewayName,
      toolGateways: preflightHermesToolGateways,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("");
    console.error(
      `  ${_RD}Rebuild preflight failed:${R} Hermes managed-tool runtime is not ready.`,
    );
    console.error(`  ${redact(message)}`);
    console.error("  Sandbox is untouched — no data was lost.");
    bail(message);
    return null;
  }

  if (webSearchConfig) {
    // A successful Brave Search API probe consumes one request. Run it once per
    // rebuild here; later TOCTOU checks still verify the retained provider
    // attachment without issuing additional searches.
    const braveProbe = preflightRebuildBraveSearchRoute(sandboxName);
    if (!braveProbe.ok) {
      console.error("");
      console.error(
        `  ${_RD}Rebuild preflight failed:${R} retained Brave Search credentials or route were rejected.`,
      );
      console.error(`  ${redact(braveProbe.detail)}`);
      console.error("  Sandbox is untouched — no data was lost.");
      bail("Recorded Brave Search route smoke check failed.");
      return null;
    }
    recreateOpts.authoritativeWebSearchValidated = true;
  }

  let runtimePreflight: import("../../onboard/fatal-runtime-preflight").FatalRuntimePreflightResult;
  try {
    runtimePreflight = await onboardModule.preflightAuthoritativeRebuildTarget({
      ...recreateOpts,
      model: resumeConfig.model,
      provider: resumeConfig.provider,
      sandboxName,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("");
    console.error(
      `  ${_RD}Rebuild preflight failed:${R} replacement onboarding checks did not pass.`,
    );
    console.error(`  ${redact(message)}`);
    console.error("  Sandbox is untouched — no data was lost.");
    bail(message);
    return null;
  }
  recreateOpts.authoritativeRuntimePreflight = runtimePreflight;
  const { sandboxGpuConfig } = runtimePreflight;

  const baseImagePreflight = ensureRebuildAgentBaseImage(rebuildAgent, bail);
  if (!baseImagePreflight.ok) return null;
  const restoreBaseImagePin = pinRebuildAgentBaseImageForRecreate(baseImagePreflight);
  let completed = false;
  let removePreflightSignalCleanup: () => void = () => undefined;
  let preparedInitialPolicy: import("../../onboard/initial-policy").InitialSandboxPolicy | null =
    null;
  const rebuildDisabledChannels = [...(rebuildMessagingPlan?.disabledChannels ?? [])];
  const rebuildEnabledChannelIds = (rebuildMessagingPlan?.channels ?? [])
    .filter((channel) => !channel.disabled)
    .map((channel) => channel.channelId);
  const recordedPolicyPresets = mergeRebuildMessagingPolicyPresets(
    null,
    Array.isArray(sb.policies) ? sb.policies : [],
    rebuildEnabledChannelIds,
    rebuildDisabledChannels,
  );
  try {
    try {
      const rawInitialPolicy = onboardModule.preflightAuthoritativeRebuildCreatePolicy({
        agentName: rebuildAgent,
        activeMessagingChannels: recreateOpts.authoritativeMessagingReuse?.channels ?? [],
        hermesToolGateways: preflightHermesToolGateways,
        recordedPolicyPresets,
        customPolicies: Array.isArray(sb.customPolicies) ? sb.customPolicies : [],
        policyTier: recreateOpts.authoritativePolicyTier,
        sandboxGpuConfig,
      });
      if (rawInitialPolicy.cleanup) {
        const cleanup = rawInitialPolicy.cleanup;
        let cleaned = false;
        preparedInitialPolicy = {
          ...rawInitialPolicy,
          cleanup: () => {
            if (cleaned) return true;
            const succeeded = cleanup();
            if (succeeded) cleaned = true;
            return succeeded;
          },
        };
      } else {
        preparedInitialPolicy = rawInitialPolicy;
      }
      if (preparedInitialPolicy.cleanup) {
        process.once("exit", preparedInitialPolicy.cleanup);
      }
      removePreflightSignalCleanup = installRetainedResourceSignalCleanup(() => {
        try {
          if (preparedInitialPolicy?.cleanup?.()) {
            process.removeListener("exit", preparedInitialPolicy.cleanup);
          }
        } finally {
          restoreBaseImagePin();
        }
      });
      recreateOpts.authoritativeInitialPolicy = preparedInitialPolicy;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("");
      console.error(
        `  ${_RD}Rebuild preflight failed:${R} replacement sandbox policy could not be prepared.`,
      );
      console.error(`  ${redact(message)}`);
      console.error("  Sandbox is untouched — no data was lost.");
      bail(message);
      return null;
    }

    const imagePreflight = await preflightRebuildImage({
      agent: rebuildAgent ? loadAgent(rebuildAgent) : null,
      fromDockerfile: storedFromDockerfile,
      model: resumeConfig.model,
      provider: resumeConfig.provider,
      preferredInferenceApi: resumeConfig.preferredInferenceApi,
      compatibleEndpointReasoning: resumeConfig.compatibleEndpointReasoning,
      webSearchConfig,
      hermesToolGateways: preflightHermesToolGateways,
      sandboxGpuConfig,
      gatewayPort: recreateOpts.targetGatewayPort,
      chatUiUrl:
        recreateOpts.controlUiPort === null
          ? ""
          : `http://127.0.0.1:${String(recreateOpts.controlUiPort)}`,
    });
    if (!imagePreflight.ok) {
      console.error("");
      console.error(
        `  ${_RD}Rebuild preflight failed:${R} replacement sandbox image did not build.`,
      );
      console.error(`  ${redact(imagePreflight.detail)}`);
      console.error("  Sandbox is untouched — no data was lost.");
      bail("Replacement sandbox image preflight failed");
      return null;
    }

    recreateOpts.preparedBuildContext = imagePreflight.preparedBuildContext;
    recreateOpts.authoritativeDockerGpuPatchNetwork =
      imagePreflight.preparedBuildContext.dockerGpuPatchNetwork;
    const restorePreflightResources = () => {
      cleanupPreparedRebuildBuildContext(imagePreflight.preparedBuildContext);
      if (preparedInitialPolicy?.cleanup?.()) {
        process.removeListener("exit", preparedInitialPolicy.cleanup);
      }
      restoreBaseImagePin();
    };

    completed = true;
    return {
      hermesToolGateways: preflightHermesToolGateways,
      hermesToolProvider,
      removePreflightSignalCleanup,
      recreateOpts,
      rebuildMessagingPlan,
      restoreBaseImagePin: restorePreflightResources,
      resumeConfig,
      storedFromDockerfile,
      webSearchConfig,
    };
  } finally {
    if (!completed) {
      removePreflightSignalCleanup();
      if (preparedInitialPolicy?.cleanup?.()) {
        process.removeListener("exit", preparedInitialPolicy.cleanup);
      }
      restoreBaseImagePin();
    }
  }
}

async function revalidateAtomicRebuildTarget(
  sandboxName: string,
  initialEntry: RebuildSandboxEntry,
  selection: Pick<
    AtomicRebuildPreflight["resumeConfig"],
    "model" | "preferredInferenceApi" | "provider"
  >,
  recreateOpts: AtomicRebuildPreflight["recreateOpts"],
  hermesToolGateways: string[],
  hermesToolProvider: string | null,
  probeExistingSandbox: boolean,
  bail: RebuildBail,
): Promise<boolean> {
  const currentEntry = registry.getSandbox(sandboxName) as RebuildSandboxEntry | null;
  if (!currentEntry || !isDeepStrictEqual(currentEntry, initialEntry)) {
    console.error("");
    console.error(
      `  ${_RD}Rebuild preflight failed:${R} registered sandbox configuration changed during preflight.`,
    );
    console.error("  Sandbox is untouched — no data was lost.");
    bail("Sandbox registry configuration changed during rebuild preflight.");
    return false;
  }
  if (!checkRebuildGatewaySchemaPreflight(sandboxName, bail)) return false;
  try {
    const runtimePreflight = await onboardModule.preflightAuthoritativeRebuildTarget({
      ...recreateOpts,
      model: selection.model,
      provider: selection.provider,
      sandboxName,
    });
    if (
      recreateOpts.authoritativeRuntimePreflight &&
      !isDeepStrictEqual(
        runtimePreflight.sandboxGpuConfig,
        recreateOpts.authoritativeRuntimePreflight.sandboxGpuConfig,
      )
    ) {
      throw new Error("Sandbox GPU/runtime configuration changed during rebuild preflight.");
    }
    const messagingReuse = recreateOpts.authoritativeMessagingReuse;
    if (!messagingReuse) {
      throw new Error("Authoritative messaging provider attachments were not prepared.");
    }
    const currentMessagingReuse = onboardModule.snapshotAuthoritativeRebuildMessagingState({
      sandboxName,
      targetGatewayName: recreateOpts.targetGatewayName,
      webSearchEnabled: recreateOpts.authoritativeWebSearchConfig?.fetchEnabled === true,
    });
    if (!isDeepStrictEqual(currentMessagingReuse, messagingReuse)) {
      throw new Error(
        "Messaging channels or provider attachments changed during rebuild preflight.",
      );
    }
    await onboardModule.preflightAuthoritativeProviderAttachments({
      targetGatewayName: recreateOpts.targetGatewayName,
      providerNames: [...messagingReuse.providers, ...messagingReuse.extraProviders],
    });
    const currentHermesToolProvider = await onboardModule.preflightAuthoritativeHermesToolGateways({
      sandboxName,
      targetGatewayName: recreateOpts.targetGatewayName,
      toolGateways: hermesToolGateways,
    });
    if (currentHermesToolProvider !== hermesToolProvider) {
      throw new Error("Hermes managed-tool provider identity changed during rebuild preflight.");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("");
    console.error(
      `  ${_RD}Rebuild preflight failed:${R} replacement target changed during preflight.`,
    );
    console.error(`  ${redact(message)}`);
    console.error("  Sandbox is untouched — no data was lost.");
    bail(message);
    return false;
  }
  if (probeExistingSandbox) {
    if (!validateRecordedInferenceRoute(sandboxName, selection, bail)) return false;
  }
  if (onboardModule.isInferenceRouteReady(selection.provider, selection.model)) return true;

  console.error("");
  console.error(
    `  ${_RD}Rebuild preflight failed:${R} OpenShell inference route changed during preflight.`,
  );
  console.error("  Sandbox is untouched — no data was lost.");
  bail("OpenShell inference route changed during rebuild preflight.");
  return false;
}

async function revalidateAtomicRebuildTargetAfterBackup(options: {
  sandboxName: string;
  initialEntry: RebuildSandboxEntry;
  resumeConfig: AtomicRebuildPreflight["resumeConfig"];
  recreateOpts: AtomicRebuildPreflight["recreateOpts"];
  hermesToolGateways: string[];
  hermesToolProvider: string | null;
  probeExistingSandbox: boolean;
  relock: (sandboxStillExists: boolean) => boolean;
  bail: RebuildBail;
}): Promise<boolean> {
  try {
    const targetStillValid = await revalidateAtomicRebuildTarget(
      options.sandboxName,
      options.initialEntry,
      options.resumeConfig,
      options.recreateOpts,
      options.hermesToolGateways,
      options.hermesToolProvider,
      options.probeExistingSandbox,
      (message): never => {
        throw new Error(message);
      },
    );
    if (!targetStillValid) throw new Error("Replacement target changed after backup.");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.relock(true);
    options.bail(message);
    return false;
  }
}

function acquireRebuildLockOrBail(sandboxName: string, bail: RebuildBail): boolean {
  const lockResult = onboardSession.acquireOnboardLock(`${CLI_NAME} ${sandboxName} rebuild`);
  if (lockResult.acquired) return true;

  console.error(`  Another ${CLI_NAME} onboarding or rebuild run is already in progress.`);
  if (lockResult.holderPid) console.error(`  Lock holder PID: ${lockResult.holderPid}`);
  if (lockResult.holderStartedAt) console.error(`  Started: ${lockResult.holderStartedAt}`);
  console.error(`  Wait for it to finish, or remove the stale lock: ${lockResult.lockFile}`);
  bail("Another onboarding or rebuild run is already in progress.");
  return false;
}

function restoreRebuildProcessEnv(previous: {
  openshellGateway: string | undefined;
  openshellLocalTlsDir: string | undefined;
  sandboxName: string | undefined;
}): void {
  const restore = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("OPENSHELL_GATEWAY", previous.openshellGateway);
  restore("OPENSHELL_LOCAL_TLS_DIR", previous.openshellLocalTlsDir);
  restore("NEMOCLAW_SANDBOX_NAME", previous.sandboxName);
}

function isolateTargetMessagingEnv(env: NodeJS.ProcessEnv = process.env): () => void {
  const names = [
    ...new Set([
      ...MESSAGING_CHANNEL_CONFIG_ENV_KEYS.flatMap((key) => getMessagingChannelConfigEnvKeys(key)),
      MESSAGING_SETUP_APPLIER_ENV_KEY,
    ]),
  ];
  const saved = new Map(names.map((name) => [name, env[name]] as const));
  for (const name of names) delete env[name];
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [name, value] of saved) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  };
}

function sandboxExistsAfterFailedRecreate(
  sandboxName: string,
  log: (message: string) => void,
): boolean {
  let result: ReturnType<typeof captureOpenshell>;
  try {
    result = captureOpenshell(["sandbox", "list"], {
      ignoreError: true,
      includeStderr: true,
    });
  } catch (err) {
    log(
      `Recreate failure liveness check threw; assuming the sandbox exists: ${err instanceof Error ? err.message : String(err)}`,
    );
    return true;
  }
  if (result.status !== 0) {
    log("Recreate failure liveness check was inconclusive; assuming the sandbox exists");
    return true;
  }
  const exists = parseLiveSandboxNames(result.output || "").has(sandboxName);
  log(`Recreate failure liveness check: sandbox exists=${String(exists)}`);
  return exists;
}

function restoreRegistrySnapshotForRetry(
  sandboxName: string,
  snapshot: registry.SandboxRegistry | null,
  log: (message: string) => void,
): boolean {
  const snapshotEntry = snapshot?.sandboxes?.[sandboxName];
  if (!snapshotEntry) {
    console.error("  Could not restore the original registry entry: snapshot is unavailable.");
    return false;
  }
  try {
    registry.restoreSandboxEntry(snapshotEntry, {
      reclaimDefault: snapshot?.defaultSandbox === sandboxName ? sandboxName : null,
    });
    log("Recreate failed: restored preserved registry entry for retry");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Failed to restore registry entry after recovery recreate failure: ${message}`);
    console.error(`  Could not restore the original registry entry: ${redact(message)}`);
    return false;
  }
}

export async function rebuildSandbox(
  sandboxName: string,
  options: string[] | RebuildSandboxOptions = {},
  opts: RebuildSandboxExecutionOptions = {},
): Promise<void> {
  const restoreMessagingEnv = isolateTargetMessagingEnv();
  try {
    await rebuildSandboxInner(sandboxName, options, opts);
  } finally {
    restoreMessagingEnv();
  }
}

async function rebuildSandboxInner(
  sandboxName: string,
  options: string[] | RebuildSandboxOptions = {},
  opts: RebuildSandboxExecutionOptions = {},
): Promise<void> {
  const normalized = normalizeRebuildSandboxOptions(options);
  const verbose = normalized.verbose === true || process.env.NEMOCLAW_REBUILD_VERBOSE === "1";
  const log: (msg: string) => void = verbose ? _rebuildLog : () => {};
  const skipConfirm = normalized.yes === true || normalized.force === true;
  // When called from upgradeSandboxes in a loop, throwOnError prevents
  // process.exit from aborting the entire batch on the first failure.
  const bail: RebuildBail = opts.throwOnError
    ? (msg: string, _code = 1) => {
        throw new Error(msg);
      }
    : (_msg: string, code = 1) => process.exit(code);

  // Active session detection — enrich the confirmation prompt if sessions are active
  const rebuildActiveSessionCount = countActiveSandboxSessionsForRebuild(sandboxName);

  const sb = getRebuildSandboxEntryOrBail(sandboxName, bail);
  if (!sb) return;

  let recoveryManifest: sandboxState.RebuildManifest | null = null;
  if (opts.recoveryManifest) {
    const validation = sandboxState.validateRebuildRecoveryManifest(
      sandboxName,
      sb.agent,
      opts.recoveryManifest,
    );
    if (!validation.ok) {
      console.error("");
      console.error(`  ${_RD}Recovery preflight failed:${R} ${validation.reason}.`);
      console.error("  Sandbox is untouched — no data was lost.");
      bail(`Invalid recovery manifest: ${validation.reason}`);
      return;
    }
    if (!sandboxState.hasPositiveManagedImageEvidence(sb)) {
      console.error("");
      console.error(
        `  ${_RD}Recovery preflight failed:${R} registry has no NemoClaw-managed image fingerprint.`,
      );
      console.error(
        "  Pre-fingerprint and custom-image sandboxes are not recreated automatically.",
      );
      console.error("  Sandbox is untouched — no data was lost.");
      bail("Recovery registry entry has no NemoClaw-managed image fingerprint.");
      return;
    }
    recoveryManifest = validation.manifest;
  }

  // Multi-agent guard (temporary — until swarm lands)
  if (!isSingleAgentRebuildSupported(sb, bail)) return;

  const rebuildAgent = sb.agent || null;
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const agentName = agentRuntime.getAgentDisplayName(agent);

  // Hydrate non-secret messaging config before the rebuild touches anything
  // destructive. The manifest plan in registry is the durable source; legacy
  // session channel fields are read only as compatibility fallback by
  // getStoredMessagingChannelConfig().
  hydrateMessagingConfigForRebuild(sandboxName, log);

  // Version check — show what's changing
  const versionCheck = sandboxVersion.checkAgentVersion(sandboxName);
  printRebuildVersionSummary(sandboxName, agentName, versionCheck);

  const rebuildConfirmed = await confirmSandboxRebuildIfNeeded(
    skipConfirm,
    rebuildActiveSessionCount,
  );
  if (!rebuildConfirmed) return;

  const previousOpenshellGateway = process.env.OPENSHELL_GATEWAY;
  const previousOpenshellLocalTlsDir = process.env.OPENSHELL_LOCAL_TLS_DIR;
  const previousSandboxName = process.env.NEMOCLAW_SANDBOX_NAME;
  if (!acquireRebuildLockOrBail(sandboxName, bail)) return;

  let rebuildLockReleased = false;
  const releaseRebuildLock = () => {
    if (rebuildLockReleased) return;
    rebuildLockReleased = true;
    onboardSession.releaseOnboardLock();
  };
  process.once("exit", releaseRebuildLock);
  let restoreBaseImagePin: () => void = () => undefined;
  let removeRetainedResourceSignalCleanup: () => void = () => undefined;

  try {
    // Step 0: resolve and validate every determinable recreate precondition
    // while the existing sandbox, registry entry, and workspace are untouched.
    const restoreAmbientPreflightEnv = isolateAmbientRecreateEnv();
    let preflight: AtomicRebuildPreflight | null;
    try {
      preflight = await preflightAtomicRebuild(
        sandboxName,
        sb,
        rebuildAgent,
        skipConfirm || rebuildConfirmed,
        log,
        bail,
      );
    } finally {
      restoreAmbientPreflightEnv();
    }
    if (!preflight) return;
    const {
      hermesToolGateways,
      hermesToolProvider,
      removePreflightSignalCleanup,
      recreateOpts,
      rebuildMessagingPlan,
      resumeConfig,
      storedFromDockerfile,
      webSearchConfig,
    } = preflight;
    restoreBaseImagePin = preflight.restoreBaseImagePin;
    removePreflightSignalCleanup();
    removeRetainedResourceSignalCleanup = installRetainedResourceSignalCleanup(restoreBaseImagePin);

    // Step 1: Ensure sandbox is live for backup, or identify stale recovery.
    const liveState = await resolveRebuildLiveState(sandboxName, sb, log, bail);
    if (!liveState) return;
    const { staleRecovery } = liveState;
    const preparedBackupRecovery = recoveryManifest !== null;
    const recoveryRecreate = staleRecovery || preparedBackupRecovery;
    let recoveryRegistrySnapshot: registry.SandboxRegistry | null =
      liveState.staleRegistrySnapshot ??
      (JSON.parse(JSON.stringify(registry.load())) as registry.SandboxRegistry);

    // Close the time-of-check/time-of-use window after image building. The
    // outer onboard lock serializes NemoClaw lifecycle work; this second target
    // check also catches direct registry or gateway changes before shields,
    // backup, or delete.
    if (
      !(await revalidateAtomicRebuildTarget(
        sandboxName,
        sb,
        resumeConfig,
        recreateOpts,
        hermesToolGateways,
        hermesToolProvider,
        false,
        bail,
      ))
    ) {
      return;
    }

    // Validate prepared recovery identity before shields are opened. A failed
    // read-only check must never leave the still-live sandbox in an unlocked
    // window while process.exit unwinds the rebuild.
    const preDeleteRecovery = revalidatePreparedRecoveryBeforeDelete(
      sandboxName,
      sb,
      recoveryManifest,
      recoveryRegistrySnapshot,
      bail,
    );
    recoveryManifest = preDeleteRecovery.manifest;
    recoveryRegistrySnapshot = preDeleteRecovery.registrySnapshot;

    // On stale-sandbox recovery the live sandbox is gone, so the normal
    // unlock→recreate→relock cycle cannot run. Track stale lock state and defer
    // clearing old shields state until recreate succeeds (#4497).
    const { rebuildShieldsWindow, staleSandboxWasLocked } = openRebuildShieldsWindowForState(
      sandboxName,
      recoveryRecreate,
    );
    if (!rebuildShieldsWindow) return bail("Failed to auto-unlock shields.");

    const relockShieldsIfNeeded = (sandboxStillExists: boolean): boolean =>
      relockRebuildShieldsWindow(sandboxName, rebuildShieldsWindow, sandboxStillExists, CLI_NAME);

    let sandboxStillExists = true;
    const removeShieldsInterruptionRecovery = installPrependedExitAndSignalRecovery(() => {
      relockShieldsIfNeeded(sandboxStillExists);
    });
    let postDeleteRecoveryArmed = false;
    let onboardFailed = false;
    let onboardExitCode = 1;
    let restorePostDeleteExit: () => void = () => undefined;
    let backupManifestForRecovery: sandboxState.RebuildManifest | null = null;
    let postDeleteSignalHandlersArmed = false;
    let postDeleteSigintHandler: (() => void) | null = null;
    let postDeleteSigtermHandler: (() => void) | null = null;
    const removePostDeleteSignalHandlers = () => {
      postDeleteSignalHandlersArmed = false;
      if (postDeleteSigintHandler) process.removeListener("SIGINT", postDeleteSigintHandler);
      if (postDeleteSigtermHandler) process.removeListener("SIGTERM", postDeleteSigtermHandler);
    };
    try {
      // Step 2: Backup (skipped on stale-sandbox recovery -- no live state exists)
      // Installer recovery already has a validated pre-upgrade backup. Reuse it
      // instead of trying to reach a non-Ready sandbox to create a second backup.
      const backupManifest =
        recoveryManifest ??
        backupSandboxStateForRebuild(
          sandboxName,
          sb,
          staleRecovery,
          log,
          relockShieldsIfNeeded,
          bail,
        );
      if (backupManifest === undefined) return;
      backupManifestForRecovery = backupManifest;

      // Backup can take minutes, and direct OpenShell/registry edits do not
      // participate in NemoClaw's lifecycle lock. Re-run the non-mutating
      // target contract immediately before delete. Use a throwing boundary so
      // shields are relocked before the caller's normal exit behavior runs.
      if (
        !(await revalidateAtomicRebuildTargetAfterBackup({
          sandboxName,
          initialEntry: sb,
          resumeConfig,
          recreateOpts,
          hermesToolGateways,
          hermesToolProvider,
          probeExistingSandbox: !staleRecovery,
          relock: relockShieldsIfNeeded,
          bail,
        }))
      ) {
        return;
      }

      const providerDetachTransaction = beginRebuildProviderDetachOrBail({
        sandboxName,
        messagingReuse: recreateOpts.authoritativeMessagingReuse,
        hermesToolProvider,
        staleRecovery,
        relock: () => {
          relockShieldsIfNeeded(true);
        },
        bail,
        runOpenshell,
      });

      // Step 3: Delete sandbox without tearing down gateway or session.
      // sandboxDestroy() cleans up the gateway when it's the last sandbox and
      // nulls session.sandboxName — both break the immediate onboard --resume.
      console.log("  Deleting old sandbox...");
      const sbMeta = registry.getSandbox(sandboxName);
      log(
        `Registry entry: agent=${sbMeta?.agent}, agentVersion=${sbMeta?.agentVersion}, nimContainer=${sbMeta?.nimContainer}`,
      );
      // The gateway-scoped host inference runtime is part of the validated
      // recreate target, not the sandbox being replaced. Keep it alive across
      // delete/recreate so the recorded route proven above remains usable and
      // local NIM/vLLM rebuilds cannot strand a fresh sandbox on a stopped host
      // container.

      log(`Running: openshell sandbox delete ${sandboxName}`);
      let deleteResult: ReturnType<typeof runOpenshell>;
      try {
        deleteResult = runOpenshell(["sandbox", "delete", sandboxName], {
          ignoreError: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        relockShieldsIfNeeded(true);
        providerDetachTransaction.rollback();
        throw err;
      }
      const { alreadyGone } = getSandboxDeleteOutcome(deleteResult);
      log(`Delete result: exit=${deleteResult.status}, alreadyGone=${alreadyGone}`);
      if (deleteResult.status !== 0 && !alreadyGone) {
        console.error("  Failed to delete sandbox. Aborting rebuild.");
        if (backupManifest) {
          console.error("  State backup is preserved at: " + backupManifest.backupPath);
        }
        relockShieldsIfNeeded(true);
        providerDetachTransaction.rollback();
        bail("Failed to delete sandbox.", deleteResult.status || 1);
        return;
      }
      providerDetachTransaction.commit();

      // From this point until authoritative onboard finishes, every failure is
      // recovery-sensitive: the old sandbox is gone, while registry/session
      // preparation and replacement creation can still fail. Convert all
      // process.exit paths into exceptions so the outer recovery boundary can
      // restore the registry snapshot and relock a partial replacement.
      const savedPostDeleteExit = process.exit;
      let postDeleteExitRestored = false;
      restorePostDeleteExit = () => {
        if (postDeleteExitRestored) return;
        postDeleteExitRestored = true;
        process.exit = savedPostDeleteExit;
      };
      process.exit = ((code) => {
        onboardFailed = true;
        onboardExitCode = typeof code === "number" ? code : 1;
        const err = new Error(`post-delete rebuild exited with code ${onboardExitCode}`);
        err.name = "RebuildOnboardExit";
        throw err;
      }) as typeof process.exit;
      postDeleteRecoveryArmed = true;
      const handlePostDeleteSignal = () => {
        if (!postDeleteSignalHandlersArmed) return;
        removePostDeleteSignalHandlers();
        try {
          if (postDeleteRecoveryArmed) {
            restoreRegistrySnapshotForRetry(sandboxName, recoveryRegistrySnapshot, log);
          }
        } finally {
          sandboxStillExists = true;
          try {
            relockShieldsIfNeeded(true);
          } finally {
            restorePostDeleteExit();
          }
        }
      };
      postDeleteSigintHandler = handlePostDeleteSignal;
      postDeleteSigtermHandler = handlePostDeleteSignal;
      postDeleteSignalHandlersArmed = true;
      process.prependOnceListener("SIGINT", postDeleteSigintHandler);
      process.prependOnceListener("SIGTERM", postDeleteSigtermHandler);
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
      const rebuildHermesToolGateways = rebuildsHermesSandbox ? hermesToolGateways : [];
      const hasRebuildHermesToolGateways = rebuildsHermesSandbox;
      const rebuildHermesAuthMethod =
        rebuildsHermesSandbox && sessionMatchesSandbox
          ? normalizeHermesRebuildAuthMethod(sessionBefore?.hermesAuthMethod)
          : null;
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
        s.hermesAuthMethod = rebuildHermesAuthMethod;
        s.policyPresets = [
          ...new Set([
            ...(Array.isArray(sb.policies)
              ? sb.policies.filter((value: unknown): value is string => typeof value === "string")
              : []),
            ...(Array.isArray(sb.customPolicies)
              ? sb.customPolicies.map((policy) => policy.name).filter(Boolean)
              : []),
          ]),
        ];
        s.metadata = { ...(s.metadata ?? {}), fromDockerfile: storedFromDockerfile };
        s.webSearchConfig = webSearchConfig;
        // Persist inference selection from the about-to-be-removed registry entry
        // so onboard --resume can recreate with the same provider/model in
        // non-interactive mode. Without this the registry is gone by the time
        // setupNim runs, leaving no recovery source. Assign explicitly (with a
        // null fallback) so a missing registry value doesn't silently leave a
        // stale session entry from an earlier sandbox in place.
        // #5735: apply the recreate config resolved + validated BEFORE delete by
        // prepareRebuildResumeConfig, so onboard --resume recreates the recorded
        // sandbox in non-interactive mode. Provider/model/credential/endpoint come
        // from the about-to-be-removed registry entry or a validated matching
        // custom-endpoint session, never ambient env. Assign explicitly so missing
        // values cannot leave stale entries from an earlier sandbox in place.
        s.provider = resumeConfig.provider;
        s.model = resumeConfig.model;
        s.nimContainer = resumeConfig.nimContainer;
        s.credentialEnv = resumeConfig.credentialEnv;
        s.preferredInferenceApi = resumeConfig.preferredInferenceApi;
        s.compatibleEndpointReasoning = resumeConfig.compatibleEndpointReasoning;
        // `onboard --resume` uses the session as the recreate contract. Always
        // overwrite the endpoint from the preflighted registry-derived config,
        // even when the pre-existing session currently matches this sandbox name:
        // stale recovery can be retrying after an earlier failed recreate left a
        // partial session behind. Leaving the old endpoint in that case can silently
        // steer the recreate to the wrong provider URL. `prepareRebuildResumeConfig`
        // already validates whether this endpoint is recoverable before any
        // destructive work, so this is the safest source boundary (#4497/#5869).
        s.endpointUrl = resumeConfig.endpointUrl;
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

      log(
        `Calling onboard({ resume: true, nonInteractive: true, recreateSandbox: true, fromDockerfile: ${storedFromDockerfile} })`,
      );

      // The post-delete process-exit guard installed above stays active through
      // the entire authoritative onboard attempt. The outer rebuild owns the
      // lifecycle lock and recovery snapshot (#2273).

      // #5735: isolate ambient onboard-selection env only for the duration of the
      // recreate. The session was just pinned to the registry agent/provider/
      // model/credential above, so removing NEMOCLAW_AGENT/PROVIDER/PROVIDER_KEY/
      // ENDPOINT_URL/MODEL forces onboard --resume to recreate from that pinned
      // config (and the already-registered gateway provider) instead of an
      // unrelated onboard's values. Restored in finally so a bulk rebuild loop
      // and the caller's process env are left untouched.
      const restoreAmbientRecreateEnv = isolateAmbientRecreateEnv();
      try {
        try {
          await onboardModule.onboard(recreateOpts);
          log("onboard() returned successfully");
        } catch (err) {
          onboardFailed = true;
          const message = err instanceof Error ? err.message : String(err);
          const name = err instanceof Error ? err.name : "";
          if (name !== "RebuildOnboardExit") {
            log(`onboard() threw: ${message}`);
          }
        }

        if (!onboardFailed) {
          sandboxStillExists = true;
          postDeleteRecoveryArmed = false;
        }

        if (onboardFailed) {
          sandboxStillExists = sandboxExistsAfterFailedRecreate(sandboxName, log);
          try {
            markLastStartedStepFailed(onboardSession, "Rebuild recreate failed");
          } catch {
            /* best effort */
          }

          // Recovery already removed the registry entry before the recreate. If the
          // recreate failed, restore the captured entry so the recommended
          // `rebuild --yes` (and `connect`)
          // remain retryable instead of failing at dispatch with "not found in
          // registry" (#4497). Restore unconditionally — overwriting any partial entry
          // a failed `onboard` may have registered — so the original metadata
          // (defaultSandbox, customPolicies, every field) wins, not a half-written
          // recreate entry. The restore targets only this sandbox under the registry
          // lock, leaving other sandboxes' concurrent changes intact.
          const registryRestored = restoreRegistrySnapshotForRetry(
            sandboxName,
            recoveryRegistrySnapshot,
            log,
          );

          console.error("");
          if (recoveryRecreate) {
            console.error(`  ${_RD}Recovery recreate failed.${R}`);
            if (registryRestored) {
              console.error(
                "  Your local registry entry has been preserved — you can retry once the issue above is fixed.",
              );
            }
          } else if (sandboxStillExists) {
            console.error(
              `  ${_RD}Recreate did not finish, but the replacement sandbox exists.${R}`,
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
          relockShieldsIfNeeded(sandboxStillExists);
          postDeleteRecoveryArmed = false;
          removePostDeleteSignalHandlers();
          restorePostDeleteExit();
          bail(
            backupManifest
              ? sandboxStillExists
                ? `Recreate incomplete (replacement sandbox exists). Backup: ${backupManifest.backupPath}`
                : `Recreate failed (sandbox destroyed). Backup: ${backupManifest.backupPath}`
              : "Recreate failed (stale-sandbox recovery).",
            onboardExitCode,
          );
          return;
        }
      } finally {
        restoreAmbientRecreateEnv();
      }

      // Recreate succeeded. Reset the prior shields state so the freshly recreated
      // (mutable) sandbox reports its true posture. Deferred until here so a failed
      // recreate above leaves the lockdown record intact for a retry (#4497).
      if (recoveryRecreate) {
        shields.clearShieldsState(sandboxName);
      }

      const preservedRegistryFields = {
        ...(hasRebuildHermesToolGateways
          ? { hermesToolGateways: [...rebuildHermesToolGateways] }
          : {}),
        ...(Array.isArray(sb.customPolicies) && sb.customPolicies.length > 0
          ? { customPolicies: sb.customPolicies.map((policy) => ({ ...policy })) }
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
      // (`sb.customPolicies`) were validated and merged into the prepared boot
      // policy before deletion, so only built-in presets need this live reapply.
      const registryPolicyPresets = Array.isArray(sb.policies)
        ? sb.policies.filter((value: unknown): value is string => typeof value === "string")
        : [];
      const rebuildDisabledChannels = [...(rebuildMessagingPlan?.disabledChannels ?? [])];
      const rebuildEnabledChannelIds = (rebuildMessagingPlan?.channels ?? [])
        .filter((ch) => !ch.disabled)
        .map((ch) => ch.channelId);
      const savedPresets = mergeRebuildMessagingPolicyPresets(
        backupManifest?.policyPresets,
        registryPolicyPresets,
        rebuildEnabledChannelIds,
        rebuildDisabledChannels,
      );
      const restoredPresets: string[] = [];
      const failedPresets: string[] = [];
      if (savedPresets.length > 0) {
        console.log("");
        console.log("  Restoring policy presets...");
        log(`Policy presets to restore: [${savedPresets.join(",")}]`);
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
      let messagingHostForwardUnverified = false;
      const policyPresetRestoreIncomplete = failedPresets.length > 0;
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
      //
      // Source-of-truth reconciliation for `policies`:
      //
      // - Invalid state: `registry.policies` retained a preset name after the
      //   reapply loop pruned it (disabled messaging channel) or skipped it
      //   (failed `applyPreset`), so `policy-list` showed a ● marker for a
      //   preset whose rules were absent from the gateway.
      // - Source boundary: `policies.applyPreset` only appends to
      //   `registry.policies`; nothing else writes the canonical post-rebuild
      //   set. The reapply loop above is the only place that knows which
      //   presets were actually reapplied.
      // - Source-fix constraint: must run after the reapply loop and use the
      //   successfully restored subset, not `savedPresets` (which still
      //   includes failures).
      // - Regression test:
      //   `src/lib/actions/sandbox/rebuild-flow.test.ts` asserts
      //   `registry.updateSandbox` receives `policies: restoredPresets` for
      //   both the successful-rebuild and partial-restore harnesses.
      // - Removal condition: drop this once `applyPreset` writes the
      //   canonical post-apply set itself (replacing its append-only
      //   contract), making the rebuild flow's reconciliation redundant.
      registry.updateSandbox(sandboxName, {
        agentVersion: agentDef.expectedVersion || null,
        policies: restoredPresets,
      });
      log(
        `Registry updated: agentVersion=${agentDef.expectedVersion}, policies=[${restoredPresets.join(",")}]`,
      );

      if (!relockShieldsIfNeeded(true)) return bail("Failed to re-apply shields lockdown.");
      removePostDeleteSignalHandlers();
      if (!ensureMessagingHostForwardAfterRebuild(sandboxName, rebuildMessagingPlan)) {
        messagingHostForwardUnverified = true;
      }

      console.log("");
      const postRestoreComplete =
        restoreSucceeded &&
        !mutablePermsRepairUnverified &&
        !mutableConfigHashRefreshUnverified &&
        !messagingHostForwardUnverified &&
        !policyPresetRestoreIncomplete;
      if (postRestoreComplete) {
        console.log(`  ${G}\u2713${R} Sandbox '${sandboxName}' rebuilt successfully`);
        if (staleRecovery && !backupManifest) {
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
        if (messagingHostForwardUnverified) {
          console.log(
            `    Messaging webhook forward was not verified \u2014 run \`${CLI_NAME} ${sandboxName} connect\` after resolving the port conflict`,
          );
        }
        if (policyPresetRestoreIncomplete) {
          console.log(
            `    Policy presets failed to reapply: ${failedPresets.join(", ")} \u2014 re-apply manually with \`${CLI_NAME} ${sandboxName} policy-add\``,
          );
        }
      }
      // Stale recovery reset the shields state to mutable (the gone sandbox's lock
      // seal could not carry over to the fresh image). If lockdown had been enabled,
      // tell the operator to re-apply it on the recreated sandbox (#4497).
      if (recoveryRecreate && staleSandboxWasLocked) {
        console.log(
          `    ${YW}\u26a0${R} Shields were previously enabled but the recreated sandbox starts unlocked \u2014 run \`${CLI_NAME} ${sandboxName} shields up\` to restore lockdown.`,
        );
      }
      if (preparedBackupRecovery && !postRestoreComplete) {
        bail(
          `Prepared backup recovery for '${sandboxName}' completed with unverified post-restore state.`,
        );
      }
    } catch (err) {
      if (postDeleteRecoveryArmed) {
        postDeleteRecoveryArmed = false;
        removePostDeleteSignalHandlers();
        restorePostDeleteExit();
        const registryRestored = restoreRegistrySnapshotForRetry(
          sandboxName,
          recoveryRegistrySnapshot,
          log,
        );
        // A failure anywhere after delete may have happened before create, in
        // create, or after a partial create. Without a non-exiting structured
        // liveness API, assume a replacement may exist and attempt relock.
        sandboxStillExists = true;
        relockShieldsIfNeeded(true);
        console.error("");
        console.error(`  ${_RD}Rebuild failed after the old sandbox was deleted.${R}`);
        if (backupManifestForRecovery) {
          console.error(`  Backup is preserved at: ${backupManifestForRecovery.backupPath}`);
        }
        console.error(
          registryRestored
            ? "  The original registry entry was restored for a safe retry."
            : "  The original registry entry could not be restored; inspect the registry before retrying.",
        );
      }
      throw err;
    } finally {
      removePostDeleteSignalHandlers();
      restorePostDeleteExit();
      if (!rebuildShieldsWindow.relocked) {
        relockShieldsIfNeeded(sandboxStillExists);
      }
      removeShieldsInterruptionRecovery();
    }
  } finally {
    try {
      removeRetainedResourceSignalCleanup();
      restoreBaseImagePin();
      restoreRebuildProcessEnv({
        openshellGateway: previousOpenshellGateway,
        openshellLocalTlsDir: previousOpenshellLocalTlsDir,
        sandboxName: previousSandboxName,
      });
    } finally {
      process.removeListener("exit", releaseRebuildLock);
      releaseRebuildLock();
    }
  }
}
