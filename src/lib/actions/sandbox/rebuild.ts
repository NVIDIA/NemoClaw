// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import { prompt as askPrompt } from "../../credentials/store";
import {
  normalizeRebuildSandboxOptions,
  type RebuildSandboxOptions,
} from "../../domain/lifecycle/options";

const onboardModule = require("../../onboard") as {
  ensureValidatedBraveSearchCredential: (nonInteractive?: boolean) => Promise<unknown>;
  hydrateCredentialEnv: (name: string) => string | null;
  preflightAuthoritativeRebuildTarget: (options: {
    authoritativeResumeConfig: true;
    model: string;
    provider: string;
    sandboxName: string;
    targetGatewayName: string;
    targetGatewayPort: number;
    controlUiPort: number | null;
    sandboxGpu: "enable" | "disable" | null;
    sandboxGpuDevice: string | null;
    noGpu?: true;
  }) => Promise<void>;
};
const { ensureValidatedBraveSearchCredential, hydrateCredentialEnv } = onboardModule;
const hermesProviderAuth = require("../../hermes-provider-auth") as {
  HERMES_PROVIDER_NAME: string;
  HERMES_INFERENCE_CREDENTIAL_ENV: string;
  HERMES_NOUS_API_KEY_CREDENTIAL_ENV: string;
  inspectHermesProviderBinding: (runOpenshellFn: typeof runOpenshell) => {
    exists: boolean;
    credentialKeys: string[] | null;
  };
  isHermesProviderRegistered: (runOpenshellFn: typeof runOpenshell) => boolean;
  registerHermesInferenceProvider: (
    apiKey: string,
    runOpenshellFn: typeof runOpenshell,
    credentialEnv?: string,
    baseUrl?: string,
  ) => void;
};

import {
  detectOpenShellStateRpcPreflightIssue,
  printOpenShellStateRpcIssue,
} from "../../adapters/openshell/gateway-drift";
import { resolveOpenshell } from "../../adapters/openshell/resolve";
import { runOpenshell } from "../../adapters/openshell/runtime";
import { loadAgent } from "../../agent/defs";
import * as agentRuntime from "../../agent/runtime";
import { RD as _RD, B, D, G, R, YW } from "../../cli/terminal-style";
import { getSandboxDeleteOutcome } from "../../domain/sandbox/destroy";
import * as nim from "../../inference/nim";
import { BRAVE_API_KEY_ENV } from "../../inference/web-search";
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
  hydrateMessagingChannelConfig,
  MESSAGING_CHANNEL_CONFIG_ENV_KEYS,
} from "../../messaging-channel-config";
import { markLastStartedStepFailed } from "../../onboard/exit-step-failure";
import { getStoredMessagingChannelConfig } from "../../onboard/messaging-config";
import { resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import { pruneDisabledMessagingPolicyPresets } from "../../onboard/messaging-policy-presets";
import { resolveRecreatePolicyPresets } from "../../onboard/policy-preset-persistence";
import { shouldManageDashboardForAgent } from "../../onboard/dashboard-runtime";
import { DOCKER_GPU_PATCH_NETWORK_ENV } from "../../onboard/docker-gpu-patch";
import { enforceDockerGpuPatchPreserveNetwork } from "../../onboard/docker-gpu-local-inference";
import { isLinuxDockerDriverGatewayEnabled } from "../../onboard/docker-driver-platform";
import { resolveSandboxGpuConfig } from "../../onboard/sandbox-gpu-mode";
import { agentSupportsWebSearch } from "../../onboard/web-search-support";
import * as policies from "../../policy";
import { shellQuote } from "../../runner";
import * as sandboxVersion from "../../sandbox/version";
import { redact } from "../../security/redact";
import * as shields from "../../shields";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
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
  prepareMcpBridgesForAbsentSandboxRebuild,
  prepareMcpBridgesForRebuild,
  reattachMcpProvidersAfterRebuildAbort,
  restoreMcpBridgesAfterRebuild,
} from "./mcp-bridge";
import { ensureMessagingHostForwardAfterRebuild } from "./messaging-host-forward-lifecycle";
import { executeSandboxCommand } from "./process-recovery";
import { isolateAmbientRecreateEnv } from "./rebuild-env-isolation";
import * as rebuildImagePreflight from "./rebuild-custom-image-preflight";
import {
  REBUILD_HERMES_DASHBOARD_ENV_KEYS,
  type RebuildDurableConfig,
  resolveRebuildDockerfile,
  resolveRebuildDurableConfig,
  resolveRebuildHermesDashboardEnv,
  validatedRebuildRegistryUpdate,
} from "./rebuild-durable-config";
import {
  backupSandboxStateForRebuild,
  ensureRebuildTargetGatewaySelected,
  ensureRebuildAgentBaseImage,
  openRebuildShieldsWindowForState,
  pinRebuildAgentBaseImageForRecreate,
  type RebuildSandboxEntry,
  resolveRebuildLiveState,
  warnUnpreservedUserManagedFiles,
} from "./rebuild-flow-helpers";
import {
  buildRebuildRecreateOnboardOpts,
  getRebuildSandboxGpuOverrides,
  type RebuildRecreateOnboardOpts,
} from "./rebuild-gpu-opt-out";
import {
  checkRebuildGatewayProviderOrBail,
  shouldVerifyRebuildGatewayProvider,
} from "./rebuild-provider-preflight";
import {
  getRebuildCredentialEnvFromRegistry,
  prepareRebuildResumeConfig,
  type RebuildResumeConfig,
} from "./rebuild-resume-config";
import {
  printRebuildShieldsRecovery,
  type RebuildShieldsWindow,
  relockRebuildShieldsWindow,
} from "./rebuild-shields";
import { ensureRebuildUsageNoticeAccepted } from "./rebuild-usage-notice";

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

function nonEmptyString(value: unknown): string | null {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function preflightHermesProviderCredentials(
  persistedAuthMethod: unknown,
  credentialEnv: string | null,
  log: (msg: string) => void,
): boolean {
  const authMethod =
    normalizeHermesRebuildAuthMethod(persistedAuthMethod) ||
    (credentialEnv === hermesProviderAuth.HERMES_NOUS_API_KEY_CREDENTIAL_ENV ? "api_key" : null);
  const expectedCredentialEnv =
    authMethod === "api_key"
      ? hermesProviderAuth.HERMES_NOUS_API_KEY_CREDENTIAL_ENV
      : hermesProviderAuth.HERMES_INFERENCE_CREDENTIAL_ENV;
  const binding = hermesProviderAuth.inspectHermesProviderBinding(runOpenshell);

  if (binding.exists) {
    const matches =
      binding.credentialKeys?.length === 1 && binding.credentialKeys[0] === expectedCredentialEnv;
    log(
      `Hermes Provider rebuild preflight: expected ${expectedCredentialEnv}; observed ${binding.credentialKeys?.join(",") || "unavailable"}`,
    );
    if (matches) return true;
    console.error("");
    console.error(
      `  ${_RD}Rebuild preflight failed:${R} the shared Hermes Provider credential binding has changed.`,
    );
    console.error(
      `  Expected exactly ${expectedCredentialEnv}; re-run Hermes onboarding to reconcile it.`,
    );
    console.error("  Sandbox is untouched — no data was lost.");
    return false;
  }

  if (authMethod === "api_key") {
    const envKey = nonEmptyString(
      process.env[hermesProviderAuth.HERMES_NOUS_API_KEY_CREDENTIAL_ENV],
    );
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
        const registered = hermesProviderAuth.inspectHermesProviderBinding(runOpenshell);
        return (
          registered.credentialKeys?.length === 1 &&
          registered.credentialKeys[0] === hermesProviderAuth.HERMES_NOUS_API_KEY_CREDENTIAL_ENV
        );
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
  sb: RebuildSandboxEntry,
  bail: (msg: string, code?: number) => never,
): boolean {
  const gatewayPreflightIssue = detectOpenShellStateRpcPreflightIssue({
    gatewayName: resolveSandboxGatewayName(sb),
  });
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
  sb: RebuildSandboxEntry,
  log: (msg: string) => void,
  bail: (msg: string, code?: number) => never,
): boolean {
  const rebuildCredentialEnv = getRebuildCredentialEnvFromRegistry(sb.provider, sb.credentialEnv);
  const rebuildProvider = sb.provider;

  if (rebuildProvider === hermesProviderAuth.HERMES_PROVIDER_NAME) {
    if (!preflightHermesProviderCredentials(sb.hermesAuthMethod, rebuildCredentialEnv, log)) {
      bail("Missing Hermes Provider credentials");
      return false;
    }
    return true;
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

  const credentialValue = hydrateCredentialEnv(rebuildCredentialEnv);
  log(
    `Preflight credential check: ${rebuildCredentialEnv} → ${credentialValue ? "present" : "MISSING"}`,
  );
  if (!checkRebuildGatewayProviderOrBail(rebuildProvider, rebuildCredentialEnv, log, bail)) {
    return false;
  }
  if (!credentialValue && shouldVerifyRebuildGatewayProvider(rebuildProvider)) {
    log(
      `Preflight credential check: provider '${rebuildProvider}' registered in gateway — skipping env check for ${rebuildCredentialEnv}`,
    );
    return true;
  }
  if (credentialValue) return true;

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

type RebuildBail = (message: string, code?: number) => never;

type RebuildTargetConfig = {
  resumeConfig: RebuildResumeConfig;
  sessionSnapshot: Session | null;
  sessionMatchesSandbox: boolean;
  durableConfig: RebuildDurableConfig;
  hermesToolGateways: string[];
  hasHermesToolGateways: boolean;
  credentialEnv: string | null;
  fromDockerfile: string | null;
  agentDefinition: ReturnType<typeof loadAgent> | null;
};

function printRebuildPreflightFailure(
  summary: string,
  detail: string,
  bailMessage: string,
  bail: RebuildBail,
): void {
  console.error("");
  console.error(`  ${_RD}Rebuild preflight failed:${R} ${summary}`);
  console.error(`  ${detail}`);
  console.error("  Sandbox is untouched — no data was lost.");
  bail(bailMessage);
}

function stringListOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item: unknown): item is string => typeof item === "string");
}

function resolveRebuildHermesToolGateways(
  rebuildAgent: string | null,
  sb: RebuildSandboxEntry,
  session: Session | null,
  sessionMatchesSandbox: boolean,
): { gateways: string[]; recorded: boolean } {
  if (rebuildAgent !== "hermes") return { gateways: [], recorded: false };
  const registryGateways = stringListOrNull(sb.hermesToolGateways);
  const sessionGateways = sessionMatchesSandbox
    ? stringListOrNull(session?.hermesToolGateways)
    : null;
  return {
    gateways: registryGateways ?? sessionGateways ?? [],
    recorded: registryGateways !== null || sessionGateways !== null,
  };
}

function validateRebuildDurableConfig(
  durableConfig: RebuildDurableConfig,
  resumeConfig: RebuildResumeConfig,
  bail: RebuildBail,
): boolean {
  if (durableConfig.webSearchError) {
    printRebuildPreflightFailure(
      "recorded web-search state is invalid.",
      durableConfig.webSearchError,
      "Recorded web-search state is invalid",
      bail,
    );
    return false;
  }
  if (durableConfig.fromDockerfileError) {
    printRebuildPreflightFailure(
      "recorded custom Dockerfile is invalid.",
      durableConfig.fromDockerfileError,
      "Recorded custom Dockerfile is invalid",
      bail,
    );
    return false;
  }
  if (
    durableConfig.hermesAuthMethodError ||
    (resumeConfig.provider === hermesProviderAuth.HERMES_PROVIDER_NAME &&
      durableConfig.hermesAuthMethod === null)
  ) {
    printRebuildPreflightFailure(
      "Hermes auth state is incomplete.",
      durableConfig.hermesAuthMethodError ??
        "cannot determine the recorded Hermes Provider authentication method",
      "Cannot determine recorded Hermes Provider authentication method",
      bail,
    );
    return false;
  }
  return true;
}

function prepareRebuildTargetConfig(
  sandboxName: string,
  sb: RebuildSandboxEntry,
  rebuildAgent: string | null,
  log: (message: string) => void,
  bail: RebuildBail,
): RebuildTargetConfig | null {
  const resumeConfig = prepareRebuildResumeConfig(sandboxName, sb, rebuildAgent, log, bail);
  if (!resumeConfig) return null;
  const sessionSnapshot = onboardSession.loadSession();
  const sessionMatchesSandbox = sessionSnapshot?.sandboxName === sandboxName;
  const durableConfig = resolveRebuildDurableConfig(sandboxName, sb, sessionSnapshot, {
    provider: resumeConfig.provider,
    model: resumeConfig.model,
  });
  if (!validateRebuildDurableConfig(durableConfig, resumeConfig, bail)) return null;

  const dockerfile = resolveRebuildDockerfile(durableConfig.fromDockerfile);
  if (!dockerfile.ok) {
    printRebuildPreflightFailure(
      "recorded custom Dockerfile is unavailable.",
      `${dockerfile.path}: ${dockerfile.reason}`,
      "Recorded custom Dockerfile is unavailable",
      bail,
    );
    return null;
  }

  const hermesGateways = resolveRebuildHermesToolGateways(
    rebuildAgent,
    sb,
    sessionSnapshot,
    sessionMatchesSandbox,
  );
  const credentialEnv =
    resumeConfig.provider === hermesProviderAuth.HERMES_PROVIDER_NAME
      ? durableConfig.hermesAuthMethod === "api_key"
        ? hermesProviderAuth.HERMES_NOUS_API_KEY_CREDENTIAL_ENV
        : hermesProviderAuth.HERMES_INFERENCE_CREDENTIAL_ENV
      : resumeConfig.credentialEnv;

  return {
    resumeConfig,
    sessionSnapshot,
    sessionMatchesSandbox,
    durableConfig,
    hermesToolGateways: hermesGateways.gateways,
    hasHermesToolGateways: hermesGateways.recorded,
    credentialEnv,
    fromDockerfile: dockerfile.path,
    agentDefinition: rebuildAgent && rebuildAgent !== "openclaw" ? loadAgent(rebuildAgent) : null,
  };
}

async function preflightRebuildBraveSearchCredential(
  durableConfig: RebuildDurableConfig,
  bail: RebuildBail,
): Promise<boolean> {
  if (!durableConfig.webSearchConfig) return true;
  try {
    const credential = await ensureValidatedBraveSearchCredential(true);
    if (typeof credential !== "string" || !credential.trim()) {
      throw new Error("Brave Search credential validation did not return a usable key.");
    }
    return true;
  } catch (err) {
    printRebuildPreflightFailure(
      "Brave Web Search credential is invalid.",
      err instanceof Error ? err.message : String(err),
      "Brave Web Search credential preflight failed",
      bail,
    );
    return false;
  }
}

async function preflightRebuildTargetRuntime(
  target: RebuildTargetConfig,
  sb: RebuildSandboxEntry,
  recreateOptions: RebuildRecreateOnboardOpts,
  log: (message: string) => void,
  bail: RebuildBail,
): Promise<boolean> {
  if (
    target.durableConfig.webSearchConfig &&
    !agentSupportsWebSearch(target.agentDefinition, target.fromDockerfile)
  ) {
    printRebuildPreflightFailure(
      "the recorded agent/image does not support Brave Web Search.",
      "Recreate with a supported image before enabling recorded web-search state.",
      "Recorded Brave Web Search is unsupported by the rebuild image",
      bail,
    );
    return false;
  }

  const managesDashboard = shouldManageDashboardForAgent(target.agentDefinition);
  const gpuEnv = { ...process.env };
  delete gpuEnv.NEMOCLAW_SANDBOX_GPU;
  delete gpuEnv.NEMOCLAW_SANDBOX_GPU_DEVICE;
  const sandboxGpuConfig = resolveSandboxGpuConfig(nim.detectGpu(), {
    flag: recreateOptions.sandboxGpu,
    device: recreateOptions.sandboxGpuDevice,
    env: gpuEnv,
  });
  if (sandboxGpuConfig.errors.length > 0) {
    printRebuildPreflightFailure(
      "the recorded sandbox GPU state cannot be recreated.",
      sandboxGpuConfig.errors.join(" "),
      "Recorded sandbox GPU state is invalid",
      bail,
    );
    return false;
  }
  try {
    await enforceDockerGpuPatchPreserveNetwork(target.resumeConfig.provider, sandboxGpuConfig, {
      dockerDriverGateway: isLinuxDockerDriverGatewayEnabled(),
      gatewayPort: recreateOptions.targetGatewayPort,
      log,
    });
  } catch (err) {
    printRebuildPreflightFailure(
      "the recorded GPU network path is not reachable.",
      err instanceof Error ? err.message : String(err),
      "Sandbox GPU network preflight failed",
      bail,
    );
    return false;
  }

  const customImage = await rebuildImagePreflight.preflightRebuildImage({
    agent: target.agentDefinition,
    fromDockerfile: target.fromDockerfile,
    model: target.resumeConfig.model,
    provider: target.resumeConfig.provider,
    preferredInferenceApi: target.resumeConfig.preferredInferenceApi,
    compatibleEndpointReasoning: target.resumeConfig.compatibleEndpointReasoning,
    webSearchConfig: target.durableConfig.webSearchConfig,
    hermesToolGateways: target.hermesToolGateways,
    sandboxGpuConfig,
    gatewayPort: recreateOptions.targetGatewayPort,
    chatUiUrl: managesDashboard ? `http://127.0.0.1:${String(recreateOptions.controlUiPort)}` : "",
  });
  if (!customImage.ok) {
    printRebuildPreflightFailure(
      "the replacement sandbox image did not build.",
      redact(customImage.detail),
      "Replacement sandbox image preflight failed",
      bail,
    );
    return false;
  }
  if (!(await preflightRebuildBraveSearchCredential(target.durableConfig, bail))) return false;

  // Credential preflight must use the same trusted selection. Legacy registry
  // rows may recover provider/model from their own matching onboard session;
  // checking the raw row first would miss that remote credential requirement.
  return preflightRebuildCredentials(
    {
      ...sb,
      provider: target.resumeConfig.provider,
      model: target.resumeConfig.model,
      credentialEnv: target.credentialEnv,
      hermesAuthMethod: target.durableConfig.hermesAuthMethod,
    },
    log,
    bail,
  );
}

async function preflightAuthoritativeOnboardRuntime(
  sandboxName: string,
  resumeConfig: RebuildResumeConfig,
  recreateOptions: RebuildRecreateOnboardOpts,
  bail: RebuildBail,
): Promise<boolean> {
  try {
    await onboardModule.preflightAuthoritativeRebuildTarget({
      ...recreateOptions,
      model: resumeConfig.model,
      provider: resumeConfig.provider,
      sandboxName,
    });
    return true;
  } catch (err) {
    printRebuildPreflightFailure(
      "the replacement onboarding host/runtime checks did not pass.",
      err instanceof Error ? err.message : String(err),
      "Replacement onboarding preflight failed",
      bail,
    );
    return false;
  }
}

function prepareRebuildRecreateOptions(
  sb: RebuildSandboxEntry,
  rebuildAgent: string | null,
  storedFromDockerfile: string | null,
  autoYes: boolean,
  bail: RebuildBail,
): RebuildRecreateOnboardOpts | null {
  try {
    return buildRebuildRecreateOnboardOpts({
      sb,
      rebuildAgent,
      storedFromDockerfile,
      autoYes,
      usageNoticeAccepted: true,
    });
  } catch (err) {
    printRebuildPreflightFailure(
      "the recorded recreate target is invalid.",
      err instanceof Error ? err.message : String(err),
      "Recorded recreate target is invalid",
      bail,
    );
    return null;
  }
}

function stageRebuildHermesDashboardConfig(
  rebuildAgent: string | null,
  sb: RebuildSandboxEntry,
  controlUiPort: number | null,
  bail: RebuildBail,
): boolean {
  const resolved = resolveRebuildHermesDashboardEnv(rebuildAgent, sb, controlUiPort);
  if (!resolved.ok) {
    printRebuildPreflightFailure(
      "the recorded Hermes dashboard state is invalid.",
      resolved.reason,
      "Recorded Hermes dashboard state is invalid",
      bail,
    );
    return false;
  }
  for (const key of REBUILD_HERMES_DASHBOARD_ENV_KEYS) {
    const value = resolved.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return true;
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

type McpRebuildPreparation = Awaited<ReturnType<typeof prepareMcpBridgesForRebuild>>;

async function prepareMcpForRebuild(
  sandboxName: string,
  staleRecovery: boolean,
  relockShieldsIfNeeded: (sandboxStillExists: boolean) => boolean,
  bail: (message: string, code?: number) => never,
): Promise<McpRebuildPreparation | null> {
  try {
    return await (staleRecovery
      ? prepareMcpBridgesForAbsentSandboxRebuild(sandboxName)
      : prepareMcpBridgesForRebuild(sandboxName));
  } catch (error) {
    relockShieldsIfNeeded(!staleRecovery);
    bail(
      `Failed to preserve MCP bridges before rebuild: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function reattachMcpAfterDeleteFailure(
  sandboxName: string,
  entries: McpRebuildPreparation["detachedProviderEntries"],
  scrubbedAdapterEntries: McpRebuildPreparation["scrubbedAdapterEntries"],
): Promise<string | undefined> {
  try {
    await reattachMcpProvidersAfterRebuildAbort(sandboxName, entries, scrubbedAdapterEntries);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function restoreMcpRegistryForRebuildRetry(
  staleRecovery: boolean,
  entries: McpRebuildPreparation["entries"],
  original: RebuildSandboxEntry,
  log: (message: string) => void,
): void {
  if (staleRecovery || entries.length === 0) return;
  try {
    // MCP-bearing rebuilds deliberately preserve the registry entry instead of
    // removing it. Restore any metadata overwritten by a partial onboard, but
    // leave the current default pointer alone: a concurrent `nemoclaw use`
    // selection must win because this rebuild never moved that pointer.
    registry.restoreSandboxEntry(original);
    log("Recreate failed: restored MCP-bearing registry entry for stale recovery retry");
  } catch (error) {
    log(`Failed to restore MCP-bearing registry entry after recreate failure: ${String(error)}`);
  }
}

function printMcpRebuildRetryCommand(
  sandboxName: string,
  entries: McpRebuildPreparation["entries"],
): void {
  if (entries.length > 0) {
    console.error(`    2. Run: ${CLI_NAME} ${sandboxName} rebuild --yes`);
    console.error(
      `       This will recreate sandbox '${sandboxName}' and restore its MCP bridges.`,
    );
    return;
  }
  console.error(`    2. Run: ${CLI_NAME} onboard --resume`);
  console.error(`       This will recreate sandbox '${sandboxName}'.`);
}

async function restoreMcpAfterRebuild(
  sandboxName: string,
  entries: McpRebuildPreparation["entries"],
): Promise<boolean> {
  if (entries.length === 0) return true;
  console.log("  Restoring MCP bridges...");
  try {
    await restoreMcpBridgesAfterRebuild(sandboxName, entries);
    console.log(`  ${G}✓${R} MCP bridges restored`);
    return true;
  } catch (error) {
    console.error(
      `  ${YW}⚠${R} MCP bridge restore incomplete: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

function postRestoreCompleted(status: {
  messagingHostForwardUnverified: boolean;
  mcpBridgeRestoreUnverified: boolean;
  mutableConfigHashRefreshUnverified: boolean;
  mutablePermsRepairUnverified: boolean;
  policyPresetRestoreIncomplete: boolean;
  restoreSucceeded: boolean;
}): boolean {
  return (
    status.restoreSucceeded &&
    !status.mutablePermsRepairUnverified &&
    !status.mutableConfigHashRefreshUnverified &&
    !status.messagingHostForwardUnverified &&
    !status.mcpBridgeRestoreUnverified &&
    !status.policyPresetRestoreIncomplete
  );
}

function printMcpRestoreRecovery(sandboxName: string, mcpBridgeRestoreUnverified: boolean): void {
  if (!mcpBridgeRestoreUnverified) return;
  console.log(
    `    MCP bridge definitions were preserved but not fully refreshed — fix the reported cause, then run \`${CLI_NAME} ${sandboxName} mcp restart\``,
  );
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
  return withMcpLifecycleLock(sandboxName, async () => {
    const scopedEnvKeys = [
      BRAVE_API_KEY_ENV,
      MESSAGING_SETUP_APPLIER_ENV_KEY,
      "OPENSHELL_GATEWAY",
      DOCKER_GPU_PATCH_NETWORK_ENV,
      ...REBUILD_HERMES_DASHBOARD_ENV_KEYS,
      ...MESSAGING_CHANNEL_CONFIG_ENV_KEYS,
    ];
    const savedEnv = scopedEnvKeys.map((key) => [key, process.env[key]] as const);
    try {
      await rebuildSandboxUnlocked(sandboxName, options, opts);
    } finally {
      for (const key of scopedEnvKeys) delete process.env[key];
      Object.assign(
        process.env,
        Object.fromEntries(
          savedEnv.filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
      );
    }
  });
}

async function ensureRebuildUsageNoticeOrBail(bail: RebuildBail): Promise<void> {
  let accepted = false;
  try {
    accepted = await ensureRebuildUsageNoticeAccepted({
      stdinIsTty: process.stdin?.isTTY === true,
    });
  } catch (err) {
    printRebuildPreflightFailure(
      "the current third-party software notice could not be recorded.",
      err instanceof Error ? err.message : String(err),
      "Third-party software notice preflight failed",
      bail,
    );
  }
  if (accepted) return;
  printRebuildPreflightFailure(
    "the current third-party software notice was not accepted.",
    "Accept the current notice before rebuilding.",
    "Third-party software notice was not accepted",
    bail,
  );
}

function acquireRebuildOnboardLock(sandboxName: string, bail: RebuildBail): () => void {
  const lock = onboardSession.acquireOnboardLock(
    `${CLI_NAME} ${sandboxName} rebuild --authoritative-resume`,
  );
  if (!lock.acquired) {
    console.error(`  Another ${CLI_NAME} onboarding run is already in progress.`);
    if (lock.holderPid) console.error(`  Lock holder PID: ${lock.holderPid}`);
    console.error("  Sandbox is untouched — no data was lost.");
    bail("Could not acquire onboard lock before rebuild");
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    onboardSession.releaseOnboardLock();
  };
  process.once("exit", release);
  return release;
}

function assertRebuildEntryUnchanged(
  sandboxName: string,
  confirmedEntrySnapshot: string,
  bail: RebuildBail,
): void {
  const lockedEntry = registry.getSandbox(sandboxName);
  if (lockedEntry && JSON.stringify(lockedEntry) === confirmedEntrySnapshot) return;
  printRebuildPreflightFailure(
    "the sandbox configuration changed while rebuild confirmation was pending.",
    "Review the current sandbox state and rerun rebuild.",
    "Sandbox configuration changed before rebuild lock acquisition",
    bail,
  );
}

async function rebuildSandboxUnlocked(
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
  const confirmedEntrySnapshot = JSON.stringify(sb);

  // Multi-agent guard (temporary — until swarm lands)
  if (!isSingleAgentRebuildSupported(sb, bail)) return;

  const rebuildAgent = sb.agent || null;
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const agentName = agentRuntime.getAgentDisplayName(agent);

  if (!checkRebuildGatewaySchemaPreflight(sandboxName, sb, bail)) return;

  // Version check — show what's changing
  const versionCheck = sandboxVersion.checkAgentVersion(sandboxName);
  printRebuildVersionSummary(sandboxName, agentName, versionCheck);

  const rebuildConfirmed = await confirmSandboxRebuildIfNeeded(
    skipConfirm,
    rebuildActiveSessionCount,
  );
  if (!rebuildConfirmed) return;

  await ensureRebuildUsageNoticeOrBail(bail);

  // Serialize every gateway/provider/image proof with onboarding, not only
  // deletion. Otherwise another run can invalidate a long preflight before
  // this rebuild opens its destructive window.
  const releaseRebuildOnboardLock = acquireRebuildOnboardLock(sandboxName, bail);
  let keepLockForRecreate = false;
  let lockedPreparation: {
    targetConfig: RebuildTargetConfig;
    recreateOptions: RebuildRecreateOnboardOpts;
    rebuildMessagingPlan: Awaited<ReturnType<typeof stageRebuildMessagingPlanOrBail>>;
    rebuildBaseImagePreflight: ReturnType<typeof ensureRebuildAgentBaseImage>;
    liveState: NonNullable<Awaited<ReturnType<typeof resolveRebuildLiveState>>>;
  } | null = null;

  try {
    assertRebuildEntryUnchanged(sandboxName, confirmedEntrySnapshot, bail);
    // Hydrate non-secret messaging config only after serialization. The
    // registry manifest is durable; legacy session fields are compatibility
    // fallback and must come from the same locked target snapshot.
    hydrateMessagingConfigForRebuild(sandboxName, log);

    // Provider inspection and credential replacement are gateway-scoped. Bind
    // the whole preflight to this sandbox's persisted gateway before either can
    // observe or mutate shared OpenShell provider state.
    if (!(await ensureRebuildTargetGatewaySelected(sandboxName, sb, log, bail))) return;

    // Step 0 / #5735 (PRA-6/PRA-9): resolve and validate the entire recreate config — agent,
    // provider, model, credential, endpoint — from the registry/session BEFORE any
    // destructive backup/delete, and surface/neutralize ambient onboard-selection
    // env that would otherwise steer the resume away from the recorded sandbox.
    // Fails closed (sandbox untouched) when a precondition cannot be satisfied.
    const targetConfig = prepareRebuildTargetConfig(sandboxName, sb, rebuildAgent, log, bail);
    if (!targetConfig) return;
    const {
      resumeConfig,
      sessionSnapshot: rebuildSessionSnapshot,
      sessionMatchesSandbox: rebuildSessionMatchesSandbox,
      durableConfig: rebuildDurableConfig,
      hermesToolGateways: rebuildHermesToolGateways,
      hasHermesToolGateways: hasRebuildHermesToolGateways,
      credentialEnv: rebuildCredentialEnv,
      fromDockerfile: storedFromDockerfile,
    } = targetConfig;
    const rebuildsHermesSandbox = rebuildAgent === "hermes";
    const recreateOptions = prepareRebuildRecreateOptions(
      sb,
      rebuildAgent,
      storedFromDockerfile,
      skipConfirm || rebuildConfirmed,
      bail,
    );
    if (!recreateOptions) return;
    if (!stageRebuildHermesDashboardConfig(rebuildAgent, sb, recreateOptions.controlUiPort, bail)) {
      return;
    }
    const rebuildMessagingPlan = await stageRebuildMessagingPlanOrBail(
      sandboxName,
      sb,
      rebuildAgent,
      log,
      bail,
    );
    if (
      !(await preflightAuthoritativeOnboardRuntime(
        sandboxName,
        resumeConfig,
        recreateOptions,
        bail,
      ))
    )
      return;
    // Component installation can replace the CLI/gateway binaries. Reconfirm
    // the exact named gateway before any provider inspection or deletion.
    if (!(await ensureRebuildTargetGatewaySelected(sandboxName, sb, log, bail))) return;
    if (!checkRebuildGatewaySchemaPreflight(sandboxName, sb, bail)) return;
    // Build and pin agent base layers before validating the exact final image.
    // The same immutable ref is scoped into both the dry build and recreate.
    const rebuildBaseImagePreflight = ensureRebuildAgentBaseImage(rebuildAgent, bail);
    if (!rebuildBaseImagePreflight.ok) return;
    const restorePreflightBaseImageOverride =
      pinRebuildAgentBaseImageForRecreate(rebuildBaseImagePreflight);
    let targetRuntimeReady = false;
    try {
      targetRuntimeReady = await preflightRebuildTargetRuntime(
        targetConfig,
        sb,
        recreateOptions,
        log,
        bail,
      );
    } finally {
      restorePreflightBaseImageOverride();
    }
    if (!targetRuntimeReady) return;
    const validatedRegistryUpdate = validatedRebuildRegistryUpdate(
      resumeConfig,
      rebuildDurableConfig,
      storedFromDockerfile,
      rebuildCredentialEnv,
    );
    if (!registry.updateSandbox(sandboxName, validatedRegistryUpdate)) {
      bail("Sandbox registry entry disappeared during rebuild preflight");
      return;
    }
    Object.assign(sb, validatedRegistryUpdate);

    // Step 1: Ensure sandbox is live for backup, or identify stale-sandbox recovery.
    const liveState = await resolveRebuildLiveState(sandboxName, sb, log, bail);
    if (!liveState) return;
    lockedPreparation = {
      targetConfig,
      recreateOptions,
      rebuildMessagingPlan,
      rebuildBaseImagePreflight,
      liveState,
    };
    keepLockForRecreate = true;
  } finally {
    if (!keepLockForRecreate) {
      process.removeListener("exit", releaseRebuildOnboardLock);
      releaseRebuildOnboardLock();
    }
  }
  if (!lockedPreparation) return;
  const {
    targetConfig,
    recreateOptions,
    rebuildMessagingPlan,
    rebuildBaseImagePreflight,
    liveState,
  } = lockedPreparation;
  const {
    resumeConfig,
    sessionSnapshot: rebuildSessionSnapshot,
    sessionMatchesSandbox: rebuildSessionMatchesSandbox,
    durableConfig: rebuildDurableConfig,
    hermesToolGateways: rebuildHermesToolGateways,
    hasHermesToolGateways: hasRebuildHermesToolGateways,
    credentialEnv: rebuildCredentialEnv,
    fromDockerfile: storedFromDockerfile,
  } = targetConfig;
  const rebuildsHermesSandbox = rebuildAgent === "hermes";
  const { staleRecovery, staleRegistrySnapshot } = liveState;

  // On stale-sandbox recovery the live sandbox is gone, so the normal
  // unlock→recreate→relock cycle cannot run. Track stale lock state and defer
  // clearing old shields state until recreate succeeds (#4497).
  let rebuildShieldsWindow: RebuildShieldsWindow | null;
  let staleSandboxWasLocked: boolean;
  try {
    ({ rebuildShieldsWindow, staleSandboxWasLocked } = openRebuildShieldsWindowForState(
      sandboxName,
      staleRecovery,
    ));
  } catch (err) {
    process.removeListener("exit", releaseRebuildOnboardLock);
    releaseRebuildOnboardLock();
    throw err;
  }
  if (!rebuildShieldsWindow) {
    process.removeListener("exit", releaseRebuildOnboardLock);
    releaseRebuildOnboardLock();
    return bail("Failed to auto-unlock shields.");
  }

  const relockShieldsIfNeeded = (sandboxStillExists: boolean): boolean =>
    relockRebuildShieldsWindow(sandboxName, rebuildShieldsWindow, sandboxStillExists, CLI_NAME);

  let sandboxStillExists = true;

  try {
    // Step 2: Backup (skipped on stale-sandbox recovery -- no live state exists)
    const backupManifest = backupSandboxStateForRebuild(
      sandboxName,
      sb,
      staleRecovery,
      log,
      relockShieldsIfNeeded,
      bail,
    );
    if (backupManifest === undefined) return;
    const registryPolicyPresets = Array.isArray(sb.policies)
      ? sb.policies.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const rebuildDisabledChannels = [...(rebuildMessagingPlan?.disabledChannels ?? [])];
    const rebuildPolicyPresets = pruneDisabledMessagingPolicyPresets(
      backupManifest?.policyPresets ?? registryPolicyPresets,
      rebuildDisabledChannels,
    );
    const rebuildSessionPolicyPresets = resolveRecreatePolicyPresets(
      rebuildPolicyPresets,
      sb.policyPresetsFinalized === true,
      (sb.customPolicies?.length ?? 0) > 0,
      {},
      true,
    ).policyPresets;

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

    const mcpPreparation = await prepareMcpForRebuild(
      sandboxName,
      staleRecovery,
      relockShieldsIfNeeded,
      bail,
    );
    if (!mcpPreparation) return;
    // MCP preparation removes only adapter entries whose exact ownership
    // fingerprints match the registry. Probe afterward so a Deep Agents
    // `.mcp.json` containing only NemoClaw-managed entries is not mislabeled as
    // unpreserved user state; any file that remains still needs the warning.
    if (!staleRecovery) warnUnpreservedUserManagedFiles(sandboxName, log);
    const rebuildMcpEntries = mcpPreparation.entries;
    const rebuildDetachedMcpProviderEntries = mcpPreparation.detachedProviderEntries;
    const rebuildScrubbedMcpAdapterEntries = mcpPreparation.scrubbedAdapterEntries;

    log(`Running: openshell sandbox delete ${sandboxName}`);
    const deleteResult = runOpenshell(["sandbox", "delete", sandboxName], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { alreadyGone } = getSandboxDeleteOutcome(deleteResult);
    log(`Delete result: exit=${deleteResult.status}, alreadyGone=${alreadyGone}`);
    if (deleteResult.status !== 0 && !alreadyGone) {
      console.error("  Failed to delete sandbox. Aborting rebuild.");
      const mcpRecoveryFailure = await reattachMcpAfterDeleteFailure(
        sandboxName,
        rebuildDetachedMcpProviderEntries,
        rebuildScrubbedMcpAdapterEntries,
      );
      if (mcpRecoveryFailure) {
        console.error(
          `  Failed to reattach MCP providers to the existing sandbox: ${mcpRecoveryFailure}`,
        );
      }
      if (backupManifest) {
        console.error("  State backup is preserved at: " + backupManifest.backupPath);
      }
      relockShieldsIfNeeded(true);
      bail(
        mcpRecoveryFailure
          ? `Failed to delete sandbox; MCP provider recovery also failed: ${mcpRecoveryFailure}`
          : "Failed to delete sandbox.",
        deleteResult.status || 1,
      );
      return;
    }
    sandboxStillExists = false;
    if (rebuildMcpEntries.length === 0) {
      removeSandboxRegistryEntry(sandboxName);
    } else {
      // The registry entry is the durable MCP rebuild transaction. The inner
      // onboard run observes that the sandbox is absent, carries the MCP state
      // into the replacement registration, and never enters generic live
      // recreation. Keeping it here closes every process-death window between
      // successful delete and fresh registry registration.
      log("Preserving MCP-bearing registry entry across sandbox recreation");
    }
    log(
      `Registry after remove: ${JSON.stringify(registry.listSandboxes().sandboxes.map((s: { name: string }) => s.name))}`,
    );
    console.log(`  ${G}\u2713${R} Old sandbox deleted`);

    // Step 4: Recreate via onboard --resume
    console.log("");
    console.log("  Creating new sandbox with current image...");

    // Force the sandbox name so onboard recreates with the same name.
    // Mark session resumable and point at this sandbox; set env var as fallback.
    const sessionBefore = rebuildSessionSnapshot;
    const sessionMatchesSandbox = rebuildSessionMatchesSandbox;
    const rebuildGpuOverrides = getRebuildSandboxGpuOverrides(sb);
    log(
      `Session before update: sandboxName=${sessionBefore?.sandboxName}, status=${sessionBefore?.status}, resumable=${sessionBefore?.resumable}, provider=${sessionBefore?.provider}, model=${sessionBefore?.model}, sessionMatch=${sessionMatchesSandbox}`,
    );

    // Sync the session's agent field with the registry so onboard --resume
    // rebuilds the correct sandbox type.  Without this, a stale session.agent
    // from a previous onboard of a *different* agent type would be picked up
    // by resolveAgentName() and the wrong Dockerfile would be used.  (#2201)
    onboardSession.updateSession((s: Session) => {
      // This is a new target-scoped flow even when the previous session belongs
      // to the target: the old sandbox is gone, so cached sandbox/agent/policy
      // completion markers must not skip replacement creation or tear down the
      // crash-safe MCP registry transaction. Preserve only target-owned config
      // that has no durable registry source.
      Object.assign(
        s,
        onboardSession.createSession({
          mode: "non-interactive",
          hermesAuthMethod: rebuildDurableConfig.hermesAuthMethod,
          webSearchConfig: rebuildDurableConfig.webSearchConfig,
          telegramConfig: sessionMatchesSandbox ? sessionBefore?.telegramConfig : null,
          wechatConfig: sessionMatchesSandbox ? sessionBefore?.wechatConfig : null,
          migratedLegacyValueHashes: sessionMatchesSandbox
            ? sessionBefore?.migratedLegacyValueHashes
            : null,
          routerPid:
            resumeConfig.provider === "nvidia-router" ? sessionBefore?.routerPid : undefined,
          routerCredentialHash:
            resumeConfig.provider === "nvidia-router" ? sessionBefore?.routerCredentialHash : null,
          metadata: {
            gatewayName: recreateOptions.targetGatewayName,
            fromDockerfile: storedFromDockerfile,
          },
        }),
      );
      // The outer gate completed the non-mutating runtime/component/port
      // checks while the old sandbox was intact. Cache preflight so inner
      // resume runs only its live GPU/CDI/DNS backstops and cannot enter the
      // full gateway reconciliation/cleanup path after delete.
      s.steps.preflight.status = "complete";
      s.steps.preflight.startedAt = null;
      s.steps.preflight.completedAt = s.updatedAt;
      s.steps.preflight.error = null;
      s.steps.gateway.status = "complete";
      s.steps.gateway.startedAt = null;
      s.steps.gateway.completedAt = s.updatedAt;
      s.steps.gateway.error = null;
      s.sandboxName = sandboxName;
      s.resumable = true;
      s.status = "in_progress";
      s.agent = rebuildAgent;
      s.messagingPlan = rebuildMessagingPlan;
      s.hermesToolGateways = rebuildsHermesSandbox ? rebuildHermesToolGateways : [];
      // The loaded session may belong to a different sandbox. Seed the exact
      // target set captured before delete so the inner policy phase reconciles
      // that set instead of unrelated session presets or ambient policy env.
      s.policyPresets = rebuildSessionPolicyPresets;
      s.gpuPassthrough = rebuildGpuOverrides.sessionGpuPassthrough;
      s.metadata.fromDockerfile = storedFromDockerfile;
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
      s.credentialEnv = rebuildCredentialEnv;
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
    const sessionAfter = onboardSession.loadSession();
    log(
      `Session after update: sandboxName=${sessionAfter?.sandboxName}, status=${sessionAfter?.status}, resumable=${sessionAfter?.resumable}, provider=${sessionAfter?.provider}, model=${sessionAfter?.model}`,
    );
    log(
      `Recreate env will target NEMOCLAW_SANDBOX_NAME=${sandboxName}; NEMOCLAW_RECREATE_SANDBOX=${process.env.NEMOCLAW_RECREATE_SANDBOX}`,
    );

    // Forward the target session's stored --from Dockerfile path. Unrelated
    // session metadata was cleared in the target-scoped rewrite above.
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
    // #5735: isolate ambient onboard-selection/config env only for the duration of the
    // recreate. The session was just pinned to the registry agent/provider/
    // model/credential/reasoning above, so removing NEMOCLAW_AGENT/PROVIDER/
    // provider, model, image, policy, VLLM, and GPU overrides forces onboard
    // --resume to recreate from that pinned config (and the already-registered
    // gateway provider) instead of unrelated ambient values. Restored in finally
    // so a bulk rebuild loop and the caller's process env are left untouched.
    const restoreAmbientRecreateEnv = isolateAmbientRecreateEnv();
    const previousSandboxName = process.env.NEMOCLAW_SANDBOX_NAME;
    process.env.NEMOCLAW_SANDBOX_NAME = sandboxName;
    const restoreRebuildBaseImageOverride =
      pinRebuildAgentBaseImageForRecreate(rebuildBaseImagePreflight);
    try {
      await onboard(recreateOptions);
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
      restoreRebuildBaseImageOverride();
      restoreAmbientRecreateEnv();
      if (previousSandboxName === undefined) delete process.env.NEMOCLAW_SANDBOX_NAME;
      else process.env.NEMOCLAW_SANDBOX_NAME = previousSandboxName;
    }

    if (!onboardFailed) {
      sandboxStillExists = true;
    }

    if (onboardFailed) {
      // The outer rebuild owns the onboard lock across the entire destructive
      // window and releases it in the enclosing finally. Only mark the inner
      // state failure here; releasing early would reopen the post-delete race.
      try {
        markLastStartedStepFailed(onboardSession, "Rebuild recreate failed");
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
      restoreMcpRegistryForRebuildRetry(staleRecovery, rebuildMcpEntries, sb, log);

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
      printMcpRebuildRetryCommand(sandboxName, rebuildMcpEntries);
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
    const savedPresets = rebuildPolicyPresets;
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
    let mcpBridgeRestoreUnverified = false;
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

    mcpBridgeRestoreUnverified = !(await restoreMcpAfterRebuild(sandboxName, rebuildMcpEntries));

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
    const policyPresetsFinalized =
      sb.policyPresetsFinalized === true &&
      failedPresets.length === 0 &&
      (sb.customPolicies?.length ?? 0) === 0
        ? true
        : undefined;
    registry.updateSandbox(sandboxName, {
      agentVersion: agentDef.expectedVersion || null,
      policies: restoredPresets,
      policyTier: sb.policyTier ?? null,
      policyPresetsFinalized,
    });
    log(
      `Registry updated: agentVersion=${agentDef.expectedVersion}, policies=[${restoredPresets.join(",")}], policyPresetsFinalized=${String(policyPresetsFinalized === true)}`,
    );

    if (!relockShieldsIfNeeded(true)) return bail("Failed to re-apply shields lockdown.");
    if (!ensureMessagingHostForwardAfterRebuild(sandboxName, rebuildMessagingPlan)) {
      messagingHostForwardUnverified = true;
    }

    console.log("");
    if (
      postRestoreCompleted({
        messagingHostForwardUnverified,
        mcpBridgeRestoreUnverified,
        mutableConfigHashRefreshUnverified,
        mutablePermsRepairUnverified,
        policyPresetRestoreIncomplete,
        restoreSucceeded,
      })
    ) {
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
      if (messagingHostForwardUnverified) {
        console.log(
          `    Messaging webhook forward was not verified \u2014 run \`${CLI_NAME} ${sandboxName} connect\` after resolving the port conflict`,
        );
      }
      printMcpRestoreRecovery(sandboxName, mcpBridgeRestoreUnverified);
      if (policyPresetRestoreIncomplete) {
        console.log(
          `    Policy presets failed to reapply: ${failedPresets.join(", ")} \u2014 re-apply manually with \`${CLI_NAME} ${sandboxName} policy-add\``,
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
    process.removeListener("exit", releaseRebuildOnboardLock);
    releaseRebuildOnboardLock();
  }
}
