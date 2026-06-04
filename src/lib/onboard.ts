// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Interactive onboarding wizard — 8 steps from zero to running sandbox.
// Supports non-interactive mode via --non-interactive flag or
// NEMOCLAW_NON_INTERACTIVE=1 env var for CI/CD pipelines.

const {
  envInt,
  LOCAL_INFERENCE_TIMEOUT_SECS,
}: typeof import("./onboard/env") = require("./onboard/env");
const {
  agentProductName,
  cliDisplayName,
  cliName,
  setOnboardBrandingAgent,
}: typeof import("./onboard/branding") = require("./onboard/branding");
const { createSelectOnboardAgent }: typeof import("./onboard/agent-selection") = require("./onboard/agent-selection");
const {
  createInferenceSelectionValidationHelpers,
}: typeof import("./onboard/inference-selection-validation") = require("./onboard/inference-selection-validation");
const { cleanupTempDir }: typeof import("./onboard/temp-files") = require("./onboard/temp-files");
const { abortNonInteractive }: typeof import("./onboard/non-interactive-abort") = require("./onboard/non-interactive-abort");
const { stopStaleDashboardListenersForSandbox } = require("./onboard/stale-gateway-cleanup");
const {
  TELEGRAM_NETWORK_CURL_CODES,
  checkTelegramReachability,
}: typeof import("./onboard/telegram-reachability") = require("./onboard/telegram-reachability");
const {
  ensureOllamaLoopbackSystemdOverride,
}: typeof import("./onboard/ollama-systemd") = require("./onboard/ollama-systemd");
const { bestEffortForwardStop } = require("./onboard/forward-cleanup");
const {
  CUSTOM_BUILD_CONTEXT_WARN_BYTES,
  isInsideIgnoredCustomBuildContextPath,
  shouldIncludeCustomBuildContextPath,
}: typeof import("./onboard/custom-build-context") = require("./onboard/custom-build-context");
const {
  buildCompatibleEndpointSandboxSmokeCommand,
  buildCompatibleEndpointSandboxSmokeScript,
  shouldRunCompatibleEndpointSandboxSmoke,
  verifyCompatibleEndpointSandboxSmoke,
}: typeof import("./onboard/compatible-endpoint-smoke") = require("./onboard/compatible-endpoint-smoke");
const {
  buildSandboxConfigSyncScript,
  runSandboxConfigSync,
  writeSandboxConfigSyncFile,
}: typeof import("./onboard/config-sync") = require("./onboard/config-sync");
const dockerGpuPatch: typeof import("./onboard/docker-gpu-patch") = require("./onboard/docker-gpu-patch");
const dockerGpuLocalInference: typeof import("./onboard/docker-gpu-local-inference") = require("./onboard/docker-gpu-local-inference");
const dockerGpuSandboxCreate: typeof import("./onboard/docker-gpu-sandbox-create") = require("./onboard/docker-gpu-sandbox-create");
const dockerDriverGatewayLaunch: typeof import("./onboard/docker-driver-gateway-launch") = require("./onboard/docker-driver-gateway-launch");
const { findReadableNvidiaCdiSpecFiles, parseDockerCdiSpecDirs }: typeof import("./onboard/docker-cdi") = require("./onboard/docker-cdi");
const { buildSandboxGpuCreateArgs, getSandboxReadyTimeoutSecs }: typeof import("./onboard/sandbox-gpu-create") = require("./onboard/sandbox-gpu-create");
const { appendResourceFlagsForProfile, selectResourceProfileForSandbox }: typeof import("./onboard/resource-profile-selection") = require("./onboard/resource-profile-selection");
const {
  isValidProxyHost,
  isValidProxyPort,
  patchStagedDockerfile,
}: typeof import("./onboard/dockerfile-patch") = require("./onboard/dockerfile-patch");
const {
  agentSupportsWebSearch,
}: typeof import("./onboard/web-search-support") = require("./onboard/web-search-support");
const onboardDashboard: typeof import("./onboard/dashboard") = require("./onboard/dashboard");
const {
  buildGatewayBootstrapSecretsScript,
  createGatewayBootstrapRepairHelpers,
  getGatewayBootstrapRepairPlan,
}: typeof import("./onboard/gateway-bootstrap") = require("./onboard/gateway-bootstrap");
const {
  verifyWebSearchInsideSandbox: verifyWebSearchInsideSandboxWithDeps,
}: typeof import("./onboard/web-search-verify") = require("./onboard/web-search-verify");
const {
  buildDirectGpuPolicyYaml,
  buildDirectSandboxGpuProofCommands,
  prepareInitialSandboxCreatePolicy,
}: typeof import("./onboard/initial-policy") = require("./onboard/initial-policy");
const {
  getSelectionDrift,
}: typeof import("./onboard/selection-drift") = require("./onboard/selection-drift");
const {
  resolveProviderKeyFallback,
}: typeof import("./onboard/provider-key-fallback") = require("./onboard/provider-key-fallback");
const { isLinuxDockerDriverGatewayEnabled }: typeof import("./onboard/docker-driver-platform") = require("./onboard/docker-driver-platform");
const {
  reconcileGatewayGpuReuseForGpuIntent,
}: typeof import("./onboard/gateway-gpu-passthrough") = require("./onboard/gateway-gpu-passthrough");
const { syncPresetSelection }: typeof import("./onboard/policy-preset-sync") = require("./onboard/policy-preset-sync");
const { maybeForceE2eStepFailure }: typeof import("./onboard/e2e-failure-injection") = require("./onboard/e2e-failure-injection");
const onboardTracing: typeof import("./onboard/tracing") = require("./onboard/tracing");
const sandboxReadinessTracing: typeof import("./onboard/sandbox-readiness-tracing") = require("./onboard/sandbox-readiness-tracing");
const {
  gatherWechatConfig,
  hasWechatConfigDrift,
  toSessionWechatConfig,
} = require("./onboard/wechat-config") as typeof import("./onboard/wechat-config");
const {
  setupSelectedMessagingChannels,
} = require("./onboard/messaging-channel-setup") as typeof import("./onboard/messaging-channel-setup");
const {
  clearAgentScopedResumeState,
}: typeof import("./onboard/agent-resume-state") = require("./onboard/agent-resume-state");
const {
  stopTrackedModelRouterForAgentChange,
}: typeof import("./onboard/model-router-process") = require("./onboard/model-router-process");
const bedrockRuntimeOnboard: typeof import("./onboard/bedrock-runtime") =
  require("./onboard/bedrock-runtime");
const { buildVllmMenuEntries }: typeof import("./onboard/vllm-menu") = require("./onboard/vllm-menu");
const {
  detectWindowsHostOllama,
}: typeof import("./onboard/windows-host-ollama") = require("./onboard/windows-host-ollama");
const {
  installOllamaOnLinux,
}: typeof import("./onboard/install-ollama-linux") = require("./onboard/install-ollama-linux");
const {
  installOllamaOnMacOS,
}: typeof import("./onboard/install-ollama-macos") = require("./onboard/install-ollama-macos");
const crypto = require("node:crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const pRetry = require("p-retry");

/** Strip ANSI escape sequences before printing process output to the terminal.
 *  Covers CSI (color, erase, cursor), OSC, and C1 two-byte escapes per ECMA-48. */
const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g;
const runner: typeof import("./runner") = require("./runner");
const { ROOT, SCRIPTS, redact, run, runShell, runCapture, runFile, shellQuote, validateName } =
  runner;
const braveProviderProfile: typeof import("./onboard/brave-provider-profile") = require("./onboard/brave-provider-profile");
const nameValidation: typeof import("./name-validation") = require("./name-validation");
const { NAME_ALLOWED_FORMAT, getNameValidationGuidance } = nameValidation;
const docker: typeof import("./adapters/docker") = require("./adapters/docker");
const {
  dockerContainerInspectFormat,
  dockerExecArgv,
  dockerImageInspect,
  dockerInfoFormat,
  dockerInspect,
  dockerRemoveVolumesByPrefix,
  dockerRm,
  dockerRmi,
  dockerStop,
} = docker;
const gatewayDrift: typeof import("./adapters/openshell/gateway-drift") = require("./adapters/openshell/gateway-drift");
const { getGatewayClusterContainerName, getGatewayClusterImageDrift } = gatewayDrift;
const sandboxBaseImage: typeof import("./sandbox-base-image") = require("./sandbox-base-image");
const {
  OPENCLAW_SANDBOX_BASE_IMAGE: SANDBOX_BASE_IMAGE,
  SANDBOX_BASE_TAG,
} = sandboxBaseImage;
const {
  getStableGatewayImageRef,
  pullAndResolveBaseImageDigest,
}: typeof import("./onboard/base-image") = require("./onboard/base-image");
const errnoUtils: typeof import("./core/errno") = require("./core/errno");
const { isErrnoException } = errnoUtils;
const { requireValue }: typeof import("./core/require-value") = require("./core/require-value");
const { logMissingNvidiaApiKeyHelp }: typeof import("./onboard/missing-credential-hints") = require("./onboard/missing-credential-hints");

type RunnerOptions = {
  env?: NodeJS.ProcessEnv;
  stdio?: import("node:child_process").StdioOptions;
  ignoreError?: boolean;
  suppressOutput?: boolean;
  timeout?: number;
  openshellBinary?: string;
};

const { collectBuildContextStats, stageOptimizedSandboxBuildContext } = require("./sandbox/build-context");
const { buildSubprocessEnv } = require("./subprocess-env");
const {
  DASHBOARD_PORT,
  GATEWAY_PORT,
  VLLM_PORT,
  OLLAMA_PORT,
  OLLAMA_PROXY_PORT,
} = require("./core/ports");
const localInference: typeof import("./inference/local") = require("./inference/local");
const {
  findReachableOllamaHost,
  resetOllamaHostCache,
  getDefaultOllamaModel,
  getLocalProviderBaseUrl,
  getLocalProviderHealthCheck,
  getLocalProviderValidationBaseUrl,
  getOllamaModelOptions,
  getOllamaWarmupCommand,
  OLLAMA_HOST_DOCKER_INTERNAL,
  validateOllamaModel,
  validateLocalProvider,
} = localInference;
const {
  checkOllamaPortsOrWarn,
  resolveOllamaInstallMenuEntry,
  resolveRunningOllamaMenuEntry,
  assertOllamaUpgradeApplied,
} = require("./onboard/ollama-install-menu");
const {
  ensureOllamaAuthProxy,
  getOllamaProxyToken,
  isProxyHealthy,
  persistAndProbeOllamaProxy,
  startOllamaAuthProxy,
} = require("./inference/ollama/proxy");
const {
  installOllamaOnWindowsHost,
  awaitWindowsOllamaReady,
  setupWindowsOllamaWith0000Binding,
  switchToWindowsOllamaHost,
  printWindowsOllamaTimeoutDiagnostics,
} = require("./inference/ollama/windows");
const { detectVllmProfile, installVllm } = require("./inference/vllm");
const inferenceConfig: typeof import("./inference/config") = require("./inference/config");
const {
  DEFAULT_CLOUD_MODEL,
  getProviderSelectionConfig,
  parseGatewayInference,
} = inferenceConfig;

const onboardProviders = require("./onboard/providers");
const { ensureResumeProviderReady } = require("./onboard/resume-provider-shim");
const hermesProviderAuth = require("./hermes-provider-auth");
const onboardHermesDashboard: typeof import("./onboard/hermes-dashboard") = require("./onboard/hermes-dashboard");
const hermesAuth: typeof import("./onboard/hermes-auth") = require("./onboard/hermes-auth");
const { warnIfLandlockUnsupported } = require("./onboard/landlock-warning");
const {
  HERMES_AUTH_METHOD_API_KEY,
  HERMES_AUTH_METHOD_OAUTH,
  HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
  HERMES_NOUS_API_KEY_HELP_URL,
  getRequestedHermesAuthMethod,
  hermesAuthMethodLabel,
  normalizeHermesAuthMethod,
} = hermesAuth;

type HermesAuthMethod = import("./onboard/hermes-auth").HermesAuthMethod;
function getHermesToolGatewayBroker(): any {
  return require("./hermes-tool-gateway-broker");
}

type RemoteProviderConfigEntry = {
  label: string;
  providerName: string;
  providerType: string;
  credentialEnv: string;
  endpointUrl: string;
  helpUrl: string | null;
  modelMode: "catalog" | "curated" | "input";
  defaultModel: string;
  skipVerify?: boolean;
};

const {
  OPENAI_ENDPOINT_URL,
  ANTHROPIC_ENDPOINT_URL,
  REMOTE_PROVIDER_CONFIG,
  LOCAL_INFERENCE_PROVIDERS,
  OLLAMA_PROXY_CREDENTIAL_ENV,
  VLLM_LOCAL_CREDENTIAL_ENV,
  getProviderLabel,
  getEffectiveProviderName,
  getNonInteractiveProvider,
  getNonInteractiveModel,
  getSandboxInferenceConfig,
} = onboardProviders as {
  OPENAI_ENDPOINT_URL: string;
  ANTHROPIC_ENDPOINT_URL: string;
  REMOTE_PROVIDER_CONFIG: Record<string, RemoteProviderConfigEntry>;
  LOCAL_INFERENCE_PROVIDERS: string[];
  OLLAMA_PROXY_CREDENTIAL_ENV: string;
  VLLM_LOCAL_CREDENTIAL_ENV: string;
  getProviderLabel: (key: string) => string;
  getEffectiveProviderName: (key: string | null | undefined) => string | null;
  getNonInteractiveProvider: () => string | null;
  getNonInteractiveModel: (providerKey: string) => string | null;
  getSandboxInferenceConfig: (
    model: string,
    provider?: string | null,
    preferredInferenceApi?: string | null,
  ) => {
    providerKey: string;
    primaryModelRef: string;
    inferenceBaseUrl: string;
    inferenceApi: string;
    inferenceCompat: LooseObject | null;
  };
};
const { sleepSeconds, waitForHttp, waitUntil } = require("./core/wait");
const platformUtils: typeof import("./platform") = require("./platform");
const { isWsl, shouldPatchCoredns } = platformUtils;
const {
  getContainerRuntime,
  getWindowsHostOllamaDockerRequirement,
  repairLocalInferenceSystemdOverrideOrExit,
  rejectUnsupportedWindowsHostOllama,
  shouldFrontOllamaWithProxy,
}: typeof import("./onboard/local-inference-topology") = require("./onboard/local-inference-topology");
const { resolveOpenshell } = require("./adapters/openshell/resolve");
const credentials: typeof import("./credentials/store") = require("./credentials/store");
const {
  prompt,
  ensureApiKey,
  getCredential,
  stageLegacyCredentialsToEnv,
  removeLegacyCredentialsFile,
  normalizeCredentialValue,
  resolveProviderCredential,
  saveCredential,
} = credentials;
const { hashCredential }: typeof import("./security/credential-hash") = require("./security/credential-hash");
const {
  cleanupStaleHostFiles,
}: typeof import("./host-artifact-cleanup") = require("./host-artifact-cleanup");
const registry: typeof import("./state/registry") = require("./state/registry");
const { resolveSandboxImageTagFromCreateOutput } =
  require("./domain/sandbox/image-tag") as typeof import("./domain/sandbox/image-tag");
const nim: typeof import("./inference/nim") = require("./inference/nim");
const onboardSession: typeof import("./state/onboard-session") = require("./state/onboard-session");
const {
  getFutureShellPathHint,
  getPortConflictServiceHints,
  printRemediationActions,
}: typeof import("./onboard/remediation") = require("./onboard/remediation");
const resumeConfig: typeof import("./onboard/resume-config") = require("./onboard/resume-config");
const {
  getRequestedModelHint,
  getRequestedProviderHint,
  getRequestedSandboxNameHint,
  getResumeConfigConflicts,
  getResumeSandboxConflict,
} = resumeConfig;
const { pruneKnownHostsEntries }: typeof import("./onboard/known-hosts") = require("./onboard/known-hosts");
const {
  exitOnboardFromPrompt,
  getNavigationChoice,
  isAffirmativeAnswer,
  selectFromNumberedMenuOrExit,
  step,
  ...onboardPromptHelpers
}: typeof import("./onboard/prompt-helpers") = require("./onboard/prompt-helpers");
const providerRecovery: typeof import("./onboard/provider-recovery") = require("./onboard/provider-recovery");
const { createOpenclawSetup }: typeof import("./onboard/openclaw-setup") = require("./onboard/openclaw-setup");
const { createWebSearchFlowHelpers }: typeof import("./onboard/web-search-flow") = require("./onboard/web-search-flow");
const {
  createValidationRecoveryPromptHelpers,
}: typeof import("./onboard/validation-recovery-prompt") = require("./onboard/validation-recovery-prompt");
const {
  createLocalInferenceRouteApplier,
}: typeof import("./onboard/local-inference-route") = require("./onboard/local-inference-route");
const { createOpenshellCliHelpers }: typeof import("./onboard/openshell-cli") = require("./onboard/openshell-cli");
const sandboxGpuPreflight: typeof import("./onboard/sandbox-gpu-preflight") = require("./onboard/sandbox-gpu-preflight");
const {
  exitOnSandboxGpuConfigErrors,
  formatSandboxGpuPassthroughNote,
  resolveSandboxGpuFlagFromOptions,
  sandboxGpuRemediationLines,
  validateSandboxGpuPreflight,
} = sandboxGpuPreflight;
const openshellVersion: typeof import("./onboard/openshell-version") = require("./onboard/openshell-version");
const {
  getBlueprintMaxOpenshellVersion,
  getBlueprintMinOpenshellVersion,
  getInstalledOpenshellVersion,
  isOpenshellDevVersion,
  SUPPORTED_OPENSHELL_FALLBACK_VERSION,
  shouldAllowOpenshellAboveBlueprintMax,
  shouldUseOpenshellDevChannel,
  versionGte,
} = openshellVersion;
const credentialNavigation: typeof import("./onboard/credential-navigation") =
  require("./onboard/credential-navigation");
const {
  BACK_TO_SELECTION,
  createCredentialPromptHelpers,
  isBackToSelection,
} = credentialNavigation;
const { toSessionUpdates }: typeof import("./onboard/session-updates") = require("./onboard/session-updates");
const gatewayReuse: typeof import("./onboard/gateway-reuse") = require("./onboard/gateway-reuse");
const messagingConfig: typeof import("./onboard/messaging-config") = require("./onboard/messaging-config");
const {
  detectMessagingCredentialRotation,
  getMessagingChannelForEnvKey,
  getRecordedMessagingChannelsForResume: getRecordedMessagingChannelsForResumeFromState,
}: typeof import("./onboard/messaging-credentials") = require("./onboard/messaging-credentials");
const {
  collectMessagingBuildConfig,
  computeTelegramRequireMention,
  getStoredMessagingChannelConfig,
  messagingChannelConfigsEqual,
  persistMessagingChannelConfigToSession,
} = messagingConfig;
const sandboxAgent: typeof import("./onboard/sandbox-agent") = require("./onboard/sandbox-agent");
const sandboxLifecycle: typeof import("./onboard/sandbox-lifecycle") = require("./onboard/sandbox-lifecycle");
const sandboxRegistryMetadata: typeof import("./onboard/sandbox-registry-metadata") = require("./onboard/sandbox-registry-metadata");
const sandboxReuse: typeof import("./onboard/sandbox-reuse") = require("./onboard/sandbox-reuse");
const {
  RESERVED_SANDBOX_NAMES,
  formatSandboxAgentName,
  getAgentInferenceProviderOptions,
  getDefaultSandboxNameForAgent,
  getRequestedSandboxAgentName,
  getSandboxAgentDrift,
  getSandboxAgentRegistryFields,
  getSandboxPromptDefault,
  normalizeSandboxAgentName,
} = sandboxAgent;
const promptValidatedSandboxName = sandboxAgent.createPromptValidatedSandboxName({
  promptOrDefault,
  cliDisplayName,
  isNonInteractive,
  exit: process.exit,
});
const modelRouter: typeof import("./onboard/model-router") = require("./onboard/model-router");
const {
  DEFAULT_MODEL_ROUTER_CREDENTIAL_ENV,
  isRoutedInferenceProvider,
  loadBlueprintProfile,
  reconcileModelRouter,
} = modelRouter;
const routedInference: typeof import("./onboard/routed-inference") = require("./onboard/routed-inference");
const { OnboardRuntimeBoundary }: typeof import("./onboard/runtime-boundary") = require("./onboard/runtime-boundary");
const { installSandboxCancelRollback, makeOnboardCancelExit, wasSandboxDefault, restoreDefaultAfterRecreate }: typeof import("./onboard/cancel-rollback") = require("./onboard/cancel-rollback");
const { handleAgentSetupState }: typeof import("./onboard/machine/handlers/agent-setup") = require("./onboard/machine/handlers/agent-setup");
const { handleFinalizationState }: typeof import("./onboard/machine/handlers/finalization") = require("./onboard/machine/handlers/finalization");
const { handleGatewayState }: typeof import("./onboard/machine/handlers/gateway") = require("./onboard/machine/handlers/gateway");
const { handlePoliciesState }: typeof import("./onboard/machine/handlers/policies") = require("./onboard/machine/handlers/policies");
const { handlePreflightState }: typeof import("./onboard/machine/handlers/preflight") = require("./onboard/machine/handlers/preflight");
const { handleProviderInferenceState }: typeof import("./onboard/machine/handlers/provider-inference") = require("./onboard/machine/handlers/provider-inference");
const { handleSandboxState }: typeof import("./onboard/machine/handlers/sandbox") = require("./onboard/machine/handlers/sandbox");
const { getOnboardProgressStep }: typeof import("./onboard/machine/progress") = require("./onboard/machine/progress");
const policies: typeof import("./policy") = require("./policy");
const policyPresetCarry: typeof import("./onboard/policy-preset-persistence") = require("./onboard/policy-preset-persistence");
const tiers: typeof import("./policy/tiers") = require("./policy/tiers");
const { ensureUsageNoticeConsent } = require("./onboard/usage-notice");
const {
  findAvailableDashboardPort,
  preflightDashboardPortRangeAvailability,
} = require("./onboard/dashboard-port") as typeof import("./onboard/dashboard-port");
const { destroyGatewayForReuse } = require("./onboard/gateway-cleanup") as typeof import("./onboard/gateway-cleanup");
const { applyPreflightGatewayCleanup } =
  require("./onboard/preflight-gateway-cleanup-decision") as typeof import("./onboard/preflight-gateway-cleanup-decision");
const { verifyGatewayContainerRunning } =
  require("./onboard/gateway-container-running") as typeof import("./onboard/gateway-container-running");
const { applyHealthyPortReuse } =
  require("./onboard/gateway-stale-port-reuse") as typeof import("./onboard/gateway-stale-port-reuse");
const { destroyGatewayWithVolumeCleanup } =
  require("./onboard/gateway-destroy") as typeof import("./onboard/gateway-destroy");
const {
  gatewayCliSupportsLifecycleCommands,
} = require("./onboard/gateway-lifecycle") as typeof import("./onboard/gateway-lifecycle");
const { reconcilePreflightGatewayReuseState } =
  require("./onboard/preflight-gateway-reuse") as typeof import("./onboard/preflight-gateway-reuse");
const {
  getGatewayReuseHealthWaitConfig,
  isDockerDriverGatewayHttpReady,
  isGatewayHttpReady,
  waitForGatewayHttpReady,
} = require("./onboard/gateway-http-readiness") as typeof import("./onboard/gateway-http-readiness");
const { isGatewayTcpReady } =
  require("./onboard/gateway-tcp-readiness") as typeof import("./onboard/gateway-tcp-readiness");
const { trackChildExit } =
  require("./onboard/child-exit-tracker") as typeof import("./onboard/child-exit-tracker");
const { reportDockerDriverGatewayStartFailure } =
  require("./onboard/docker-driver-gateway-failure") as typeof import("./onboard/docker-driver-gateway-failure");
const { printDockerDaemonRecovery, reportLegacyGatewayStartResultFailure } =
  require("./onboard/gateway-start-failure") as typeof import("./onboard/gateway-start-failure");
const dockerDriverGatewayEnv: typeof import("./onboard/docker-driver-gateway-env") =
  require("./onboard/docker-driver-gateway-env");
const { getDockerDriverGatewayEndpoint } = dockerDriverGatewayEnv;
const dockerDriverGatewayRuntimeMarker: typeof import("./onboard/docker-driver-gateway-runtime-marker") =
  require("./onboard/docker-driver-gateway-runtime-marker");
const gatewayBinding: typeof import("./onboard/gateway-binding") = require("./onboard/gateway-binding");
const hostGatewayProcess: typeof import("./onboard/host-gateway-process") =
  require("./onboard/host-gateway-process");
const vmDriverProcess: typeof import("./onboard/vm-driver-process") = require("./onboard/vm-driver-process");
const preflightUtils: typeof import("./onboard/preflight") = require("./onboard/preflight");
const clusterImagePatch: typeof import("./cluster-image-patch") = require("./cluster-image-patch");
const {
  assessHost,
  checkPortAvailable,
  ensureSwap,
  getMemoryInfo,
  planHostRemediation,
} = preflightUtils;
const {
  assertDockerBridgeAndContainerDnsHealthy,
}: typeof import("./onboard/bridge-dns-preflight") = require("./onboard/bridge-dns-preflight");
const agentOnboard = require("./agent/onboard");
const agentDefs = require("./agent/defs");

const gatewayState: typeof import("./state/gateway") = require("./state/gateway");
const sandboxState: typeof import("./state/sandbox") = require("./state/sandbox");
const validation: typeof import("./validation") = require("./validation");
const urlUtils: typeof import("./core/url-utils") = require("./core/url-utils");
const buildContext = require("./build-context");
const httpProbe: typeof import("./adapters/http/probe") = require("./adapters/http/probe");
const modelPrompts: typeof import("./inference/model-prompts") = require("./inference/model-prompts");
const providerModels: typeof import("./inference/provider-models") = require("./inference/provider-models");
const sandboxCreateStream: typeof import("./sandbox/create-stream") = require("./sandbox/create-stream");
const validationRecovery: typeof import("./validation-recovery") = require("./validation-recovery");
const webSearch: typeof import("./inference/web-search") = require("./inference/web-search");
const openshellInstallFlow: typeof import("./onboard/openshell-install") =
  require("./onboard/openshell-install");
const openshellPinFlow: typeof import("./onboard/openshell-pin") =
  require("./onboard/openshell-pin");
const sandboxCreateFailureDiagnostics: typeof import("./onboard/sandbox-create-failure") =
  require("./onboard/sandbox-create-failure");

import type { CurlProbeResult } from "./adapters/http/probe";
import type { AgentDefinition } from "./agent/defs";
import type { WebSearchConfig } from "./inference/web-search";
import {
  hydrateMessagingChannelConfig,
  type MessagingChannelConfig,
  readMessagingChannelConfigFromEnv,
} from "./messaging-channel-config";
import { streamGatewayStart } from "./onboard/gateway";
import {
  mergeRequiredHermesToolGatewayPolicyPresets,
  normalizeHermesToolGatewaySelections,
  setupHermesToolGateways,
  stringSetsEqual,
} from "./onboard/hermes-managed-tools";
import { mergePolicyMessagingChannels } from "./onboard/messaging-policy-presets";
import {
  filterEnabledChannelsByAgent,
  getAvailableMessagingChannelsForAgent,
  resolveMessagingChannelSeed,
  resolveQrSelectedChannels,
} from "./onboard/messaging-state";
import { getValidatedMessagingToken, getValidatedMessagingTokenByEnvKey } from "./onboard/messaging-token";
import { handleOllamaProbeFailure } from "./onboard/ollama-probe-failure";
import { runOllamaStartupOrGate } from "./onboard/ollama-startup";
import type {
  DockerDriverBinaryOverrides,
  OpenShellInstallDeps,
  OpenShellInstallResult,
} from "./onboard/openshell-install";
import { getSuggestedPolicyPresets } from "./onboard/policy-presets";
import {
  computeSetupPresetSuggestions as computeSetupPresetSuggestionsImpl,
  preparePolicyPresetResumeSelection,
  type SetupPolicySelectionOptions,
  type SetupPresetSuggestionOptions,
  setupPoliciesWithSelection as setupPoliciesWithSelectionImpl,
} from "./onboard/policy-selection";
import {
  backupSandboxBeforeRecreate,
  shouldSkipPreRecreateBackup,
} from "./onboard/sandbox-backup-on-recreate";
import {
  getResumeSandboxGpuOverrides,
  resolveSandboxGpuConfig,
  type SandboxGpuConfig,
  type SandboxGpuFlag,
} from "./onboard/sandbox-gpu-mode";
import type { SelectionDrift } from "./onboard/selection-drift";
import { filterSlackSelectionByValidation } from "./onboard/slack-validation";
import { formatOnboardConfigSummary, formatSandboxBuildEstimateNote } from "./onboard/summary";
import type { ModelValidationResult, ValidationFailureLike } from "./onboard/types";
import type { ContainerRuntime } from "./platform";
import { getChannelTokenKeys, listChannels } from "./sandbox/channels";
import type { GatewayReuseState } from "./state/gateway";
import type { Session, SessionUpdates } from "./state/onboard-session";
import type { SandboxEntry } from "./state/registry";
import type { BackupResult } from "./state/sandbox";
import type { ProbeRecovery } from "./validation-recovery";

const EXPERIMENTAL = process.env.NEMOCLAW_EXPERIMENTAL === "1";
const USE_COLOR = !process.env.NO_COLOR && !!process.stdout.isTTY;
const DIM = USE_COLOR ? "\x1b[2m" : "";
const RESET = USE_COLOR ? "\x1b[0m" : "";
let OPENSHELL_BIN: string | null = null;
const GATEWAY_NAME = gatewayBinding.resolveGatewayName(GATEWAY_PORT);
const OPENCLAW_LAUNCH_AGENT_PLIST = "~/Library/LaunchAgents/ai.openclaw.gateway.plist";

const BRAVE_SEARCH_HELP_URL = "https://brave.com/search/api/";

import type {
  JsonObject as LooseObject,
} from "./core/json-types";

type OnboardOptions = {
  nonInteractive?: boolean;
  recreateSandbox?: boolean;
  resume?: boolean;
  fresh?: boolean;
  fromDockerfile?: string | null;
  sandboxName?: string | null;
  sandboxGpu?: "enable" | "disable" | null;
  sandboxGpuDevice?: string | null;
  acceptThirdPartySoftware?: boolean;
  agent?: string | null;
  controlUiPort?: number | null;
  gpu?: boolean;
  noGpu?: boolean;
  autoYes?: boolean;
};
// Non-interactive mode: set by --non-interactive flag or env var.
// When active, all prompts use env var overrides or sensible defaults.
let NON_INTERACTIVE = false;
let RECREATE_SANDBOX = false;
let AUTO_YES = false;
// Set by onboard() before preflight() when --control-ui-port is specified.
// null means "use auto-allocation" (skip dashboard port check in preflight).
let _preflightDashboardPort: number | null = null;

function isNonInteractive(): boolean {
  return NON_INTERACTIVE || process.env.NEMOCLAW_NON_INTERACTIVE === "1";
}

function isRecreateSandbox(): boolean {
  return RECREATE_SANDBOX || process.env.NEMOCLAW_RECREATE_SANDBOX === "1";
}

function isAutoYes(): boolean {
  return AUTO_YES || process.env.NEMOCLAW_YES === "1";
}

function note(message: string): void {
  console.log(`${DIM}${message}${RESET}`);
}

const promptHelperDeps = { isNonInteractive, note, prompt };

async function promptOrDefault(
  question: string,
  envVar: string | null,
  defaultValue: string,
): Promise<string> {
  return onboardPromptHelpers.promptOrDefault(promptHelperDeps, question, envVar, defaultValue);
}

async function promptYesNoOrDefault(
  question: string,
  envVar: string | null,
  defaultIsYes: boolean,
): Promise<boolean> {
  return onboardPromptHelpers.promptYesNoOrDefault(promptHelperDeps, question, envVar, defaultIsYes);
}

// ── Helpers ──────────────────────────────────────────────────────

const {
  getOpenshellBinary,
  openshellShellCommand,
  openshellArgv,
  runOpenshell,
  runCaptureOpenshell,
  safeOpenShellArgument,
  getGatewayPortArg,
  getDockerDriverGatewayEndpointArg,
} = createOpenshellCliHelpers({
  getCachedBinary: () => OPENSHELL_BIN,
  setCachedBinary: (binary: string) => {
    OPENSHELL_BIN = binary;
  },
  getGatewayPort: () => GATEWAY_PORT,
  getDockerDriverGatewayEndpoint,
});

// Gateway state functions — delegated to src/lib/state/gateway.ts
const { isSandboxReady, parseSandboxStatus, getSandboxStateFromOutputs } = gatewayState;
const { hasStaleGateway, isSelectedGateway, isGatewayHealthy, getGatewayReuseState } =
  gatewayBinding.createGatewayNameBoundClassifiers(gatewayState, GATEWAY_NAME);

const { getGatewayReuseSnapshot, selectNamedGatewayForReuseIfNeeded } =
  gatewayReuse.createGatewayReuseHelpers({
    gatewayName: GATEWAY_NAME,
    runCaptureOpenshell,
    runOpenshell,
    cliDisplayName,
  });

const { getSandboxReuseState, repairRecordedSandbox } = sandboxReuse.createSandboxReuseHelpers({
  runCaptureOpenshell,
  runOpenshell,
  getSandboxStateFromOutputs,
  note,
});

const { streamSandboxCreate } = sandboxCreateStream;

const { executeSandboxCommandForVerification }: typeof import("./onboard/sandbox-verification-exec") =
  require("./onboard/sandbox-verification-exec");

// URL/string utilities — delegated to src/lib/core/url-utils.ts
const {
  compactText,
  normalizeProviderBaseUrl,
  isLoopbackHostname,
  formatEnvAssignment,
  parsePolicyPresetEnv,
} = urlUtils;
const { hydrateCredentialEnv }: typeof import("./onboard/credential-env") =
  require("./onboard/credential-env");

const {
  summarizeCurlFailure,
  summarizeProbeFailure,
  runCurlProbe,
} = httpProbe;

const selectOnboardAgent = createSelectOnboardAgent({
  resolveAgent: agentOnboard.resolveAgent,
  loadAgent: agentDefs.loadAgent,
  isNonInteractive,
  note,
});


const { getTransportRecoveryMessage, getProbeRecovery } = validationRecovery;

// Validation functions — delegated to src/lib/validation.ts
const {
  classifyValidationFailure,
  classifyApplyFailure,
  classifySandboxCreateFailure,
  validateNvidiaApiKeyValue,
  isSafeModelId,
  shouldSkipResponsesProbe,
  shouldForceCompletionsApi,
} = validation;

// validateNvidiaApiKeyValue — see validation import above

const credentialPrompt = createCredentialPromptHelpers(exitOnboardFromPrompt);
const replaceNamedCredential = credentialPrompt.replaceNamedCredential;

const {
  promptHermesAuthMethod,
  resolveHermesNousApiKey,
  stageNousApiKeyProviderEnv,
  ensureHermesNousApiKeyEnv,
  openshellResultMessage,
  checkHermesProviderStoreReachable,
} = hermesAuth.createHermesAuthHelpers({
  isNonInteractive,
  note,
  prompt,
  getNavigationChoice,
  exitOnboardFromPrompt,
  validateNvidiaApiKeyValue: (value: string, envName: string) =>
    validateNvidiaApiKeyValue(value, envName),
  compactText,
  redact,
  runOpenshell,
  backToSelection: BACK_TO_SELECTION,
});

const { promptValidationRecovery } = createValidationRecoveryPromptHelpers({
  isNonInteractive,
  prompt,
  validateNvidiaApiKeyValue: (key: string, credentialEnv: string | null) =>
    validateNvidiaApiKeyValue(key, credentialEnv ?? undefined),
  getTransportRecoveryMessage: (failure: any) => getTransportRecoveryMessage(failure),
  exitOnboardFromPrompt,
});

const applyLocalInferenceRoute = createLocalInferenceRouteApplier({
  runOpenshell,
  isNonInteractive,
  promptValidationRecovery,
  classifyApplyFailure,
  compactText,
  redact,
  localInferenceTimeoutSecs: LOCAL_INFERENCE_TIMEOUT_SECS,
});

// Provider CRUD — thin wrappers that inject runOpenshell to avoid circular deps.
const { buildProviderArgs } = onboardProviders;

// Snapshot of legacy {env-key → value} pairs that stageLegacyCredentialsToEnv()
// imported from ~/.nemoclaw/credentials.json at the start of this run.
// Captured by the onboard() entry point; consulted by the upsertProvider /
// upsertMessagingProviders wrappers below to decide whether a successful
// gateway upsert actually migrated the *legacy* value (vs. e.g. a vllm/ollama
// branch that upserts a placeholder under the same env-key name).
const stagedLegacyValues: Map<string, string> = new Map<string, string>();

// Env-keys whose successful gateway upsert actually used the staged legacy
// value. Seeded from the persisted onboard session at the start of every
// run so a `--resume` invocation that skips already-completed upserts still
// remembers the migrations the prior attempt committed. The post-onboard
// legacy-file cleanup is gated on `stagedLegacyKeys ⊆ migratedLegacyKeys`
// so picking a local inference provider, disabling a preselected messaging
// channel, or any other path that upserts a different value under the same
// env-key name leaves the file alone instead of stranding the user's only
// copy.
const migratedLegacyKeys: Set<string> = new Set<string>();

// SHA-256 hex digest of `value`. Used to fingerprint migrated legacy
// secrets in the persisted onboard session so a later `--resume` can
// detect when the legacy file value was edited between runs (or another
// session is on disk with stale entries) and refuse to inherit a stale
// "migrated" mark.
function legacyValueHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Mirror the in-memory `migratedLegacyKeys` set into the persisted onboard
// session along with each entry's value hash. `--resume` invocations that
// skip the upsert wrappers entirely use this to inherit migration state
// from the previous attempt — but only when the staged value at restore
// time still hashes to the same digest, so an edit to the legacy file or
// an out-of-band gateway reset cannot satisfy the cleanup gate.
function persistMigratedLegacyKeys(): void {
  try {
    const hashes: Record<string, string> = {};
    for (const key of migratedLegacyKeys) {
      const stagedValue = stagedLegacyValues.get(key);
      if (stagedValue !== undefined) {
        hashes[key] = legacyValueHash(stagedValue);
      }
    }
    onboardSession.updateSession((current: Session) => {
      current.migratedLegacyValueHashes = hashes;
      return current;
    });
  } catch {
    // updateSession can throw if the session file isn't yet writable
    // (e.g. very early in the run before lockless state is established).
    // The cleanup gate in this same process still consults the in-memory
    // set, so a missed write only matters if THIS run later crashes and
    // a future --resume needs the persisted value. Best effort.
  }
}

function upsertProvider(
  name: string,
  type: string,
  credentialEnv: string,
  baseUrl: string | null,
  env: NodeJS.ProcessEnv = {},
) {
  const result = onboardProviders.upsertProvider(
    name,
    type,
    credentialEnv,
    baseUrl,
    env,
    runOpenshell,
  );
  if (result.ok && credentialEnv) {
    const stagedValue = stagedLegacyValues.get(credentialEnv);
    if (stagedValue !== undefined) {
      // openshell receives `--credential <ENV>` and reads the value from the
      // `env` block passed here, falling back to the inherited process.env.
      // Use getCredential() for the env-fallback branch (per the
      // direct credential env guard from PR #2306) — it mirrors
      // openshell's resolution order while the staging contract has
      // already populated the same value into process.env.
      const upsertedValue = env[credentialEnv] ?? getCredential(credentialEnv);
      if (upsertedValue === stagedValue) {
        // The gateway received the staged legacy value verbatim — count
        // this key as migrated.
        migratedLegacyKeys.add(credentialEnv);
      } else {
        // A later upsert under the same env-key wrote a different value
        // (e.g. a retry-loop after validation failure replaced the legacy
        // key with a freshly entered one, or a placeholder like "dummy"
        // for vllm-local). The gateway no longer holds the staged legacy
        // value under this env-key, so withdraw the migration mark — the
        // cleanup gate must keep the legacy file intact.
        migratedLegacyKeys.delete(credentialEnv);
      }
      persistMigratedLegacyKeys();
    }
  }
  return result;
}

type MessagingTokenDef = { name: string; envKey: string; token: string | null; providerType?: string };

type EndpointValidationResult =
  | { ok: true; api: string | null; retry?: undefined }
  | { ok: false; retry: "credential" | "selection" | "retry" | "model"; api?: undefined };

const verifyDirectSandboxGpu = sandboxGpuPreflight.createDirectSandboxGpuVerifier({
  runOpenshell,
  compactText,
  redact,
});


function upsertMessagingProviders(
  tokenDefs: MessagingTokenDef[],
  options: { replaceExisting?: boolean } = {},
) {
  braveProviderProfile.ensureBraveProviderProfile(tokenDefs, { root: ROOT, runOpenshell, redact });
  const upserted = onboardProviders.upsertMessagingProviders(
    tokenDefs,
    runOpenshell,
    options,
  );
  // upsertMessagingProviders process.exits on failure, so reaching this
  // point means every entry in tokenDefs that had a token was registered.
  // Mark migrated only when the registered token equals the staged legacy
  // value — a token rotated since staging (or a fresh prompt) is not a
  // legacy migration even if it happens to use the same env-key name.
  // Mirror upsertProvider's withdrawal logic so a later messaging upsert
  // that replaces the legacy value with something else cannot leave the
  // mark stuck on.
  let mutated = false;
  for (const def of tokenDefs) {
    if (!def.token || !def.envKey) continue;
    const stagedValue = stagedLegacyValues.get(def.envKey);
    if (stagedValue === undefined) continue;
    if (def.token === stagedValue) {
      migratedLegacyKeys.add(def.envKey);
      mutated = true;
    } else {
      migratedLegacyKeys.delete(def.envKey);
      mutated = true;
    }
  }
  if (mutated) persistMigratedLegacyKeys();
  return upserted;
}
function providerExistsInGateway(name: string) {
  return onboardProviders.providerExistsInGateway(name, runOpenshell);
}

// Tri-state probe factory for messaging-conflict backfill. An upfront liveness
// check is necessary because `openshell provider get` exits non-zero for both
// "provider not attached" and "gateway unreachable"; without the liveness
// gate, a transient gateway failure would be recorded as "no providers" and
// permanently suppress future backfill retries.
function makeConflictProbe() {
  let gatewayAlive: boolean | null = null;
  const isGatewayAlive = () => {
    if (gatewayAlive === null) {
      const result = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
      // runCaptureOpenshell returns stdout/stderr as a single string; treat
      // any non-empty output as a sign openshell answered. Empty output with
      // ignoreError typically means the binary failed to produce anything.
      gatewayAlive = typeof result === "string" && result.length > 0;
    }
    return gatewayAlive;
  };
  return {
    providerExists: (name: string) => {
      if (!isGatewayAlive()) return "error";
      return providerExistsInGateway(name) ? "present" : "absent";
    },
  };
}

function verifyInferenceRoute(_provider: string, _model: string): void {
  const output = runCaptureOpenshell(["inference", "get"], { ignoreError: true });
  if (!output || /Gateway inference:\s*[\r\n]+\s*Not configured/i.test(output)) {
    console.error("  OpenShell inference route was not configured.");
    process.exit(1);
  }
}

function isInferenceRouteReady(provider: string, model: string): boolean {
  const live = parseGatewayInference(
    runCaptureOpenshell(["inference", "get"], { ignoreError: true }),
  );
  return Boolean(live && live.provider === provider && live.model === model);
}

const {
  sandboxExistsInGateway,
  pruneStaleSandboxEntry,
  shouldRestoreLatestBackupOnRecreate,
  confirmRecreateForSelectionDrift,
  isOpenclawReady,
} = sandboxLifecycle.createSandboxLifecycleHelpers({
  runCaptureOpenshell,
  fetchGatewayAuthTokenFromSandbox: (sandboxName: string) => fetchGatewayAuthTokenFromSandbox(sandboxName),
  agentProductName,
  prompt,
  isAffirmativeAnswer,
});


const {
  validateBraveSearchApiKey,
  promptBraveSearchRecovery,
  promptBraveSearchApiKey,
  ensureValidatedBraveSearchCredential,
  configureWebSearch,
  verifyWebSearchInsideSandbox,
} = createWebSearchFlowHelpers({
  prompt,
  note,
  isNonInteractive,
  cliName,
  runCaptureOpenshell,
});


// getSandboxInferenceConfig — moved to onboard-providers.ts

// Inference probes — moved to inference/onboard-probes.ts
const {
  hasResponsesToolCall,
  hasChatCompletionsToolCall,
  hasChatCompletionsToolCallLeak,
  shouldRequireResponsesToolCalling,
  verifyOnboardInferenceSmoke,
  getProbeAuthMode,
  getValidationProbeCurlArgs,
  probeOpenAiLikeEndpoint,
  probeAnthropicEndpoint,
} = require("./inference/onboard-probes");

const {
  validateOpenAiLikeSelection,
  validateAnthropicSelectionWithRetryMessage,
  validateCustomOpenAiLikeSelection,
  validateCustomAnthropicSelection,
} = createInferenceSelectionValidationHelpers({
  isNonInteractive,
  agentProductName,
  promptValidationRecovery,
});


const { promptCloudModel, promptRemoteModel, promptInputModel } = modelPrompts;
const { validateAnthropicModel, validateOpenAiLikeModel } = providerModels;
const nousModels: typeof import("./inference/nous-models") = require("./inference/nous-models");

// Build context helpers — delegated to src/lib/build-context.ts
const { shouldIncludeBuildContextPath, copyBuildContextDir, printSandboxCreateRecoveryHints } =
  buildContext;
// classifySandboxCreateFailure — see validation import above

// ---------------------------------------------------------------------------
// Ollama model prompt/pull/prepare functions — from inference/ollama/proxy.ts
// (proxy lifecycle functions already imported at the top of this file)
const {
  promptOllamaModel,
  printOllamaExposureWarning,
  prepareOllamaModel,
} = require("./inference/ollama/proxy");

const ollamaModelSize: typeof import("./inference/ollama/model-size") = require("./inference/ollama/model-size");

function isOpenshellInstalled(): boolean {
  return resolveOpenshell() !== null;
}

function installOpenshell(): OpenShellInstallResult {
  return openshellPinFlow.runOpenshellInstall({
    scriptsDir: SCRIPTS,
    cwd: ROOT,
    resolveOpenshell,
    getFutureShellPathHint,
    setOpenshellBin: (bin) => {
      OPENSHELL_BIN = bin;
    },
    getBlueprintMinOpenshellVersion,
    getBlueprintMaxOpenshellVersion,
    versionGte,
    log: console.log,
  });
}

function areRequiredDockerDriverBinariesPresent(
  platform: NodeJS.Platform = process.platform,
  binaries: DockerDriverBinaryOverrides = {},
  arch: NodeJS.Architecture = process.arch,
): boolean {
  return openshellInstallFlow.areRequiredDockerDriverBinariesPresent(
    getOpenShellInstallDeps(),
    platform,
    binaries,
    arch,
  );
}

function ensureOpenshellForOnboard(): {
  installed?: boolean;
  localBin: string | null;
  futureShellPathHint: string | null;
} {
  return openshellInstallFlow.ensureOpenshellForOnboard(getOpenShellInstallDeps());
}

function getOpenShellInstallDeps(): OpenShellInstallDeps {
  return {
    isLinuxDockerDriverGatewayEnabled,
    resolveOpenShellGatewayBinary,
    resolveOpenShellSandboxBinary,
    isOpenshellInstalled,
    installOpenshell,
    getInstalledOpenshellVersion,
    getBlueprintMinOpenshellVersion,
    getBlueprintMaxOpenshellVersion,
    runCaptureOpenshell,
    shouldUseOpenshellDevChannel,
    isOpenshellDevVersion,
    versionGte,
    shouldAllowOpenshellAboveBlueprintMax,
    cliDisplayName,
    log: console.log,
    error: console.error,
    exit: process.exit,
  };
}

function runQuietOpenshell(args: string[]) {
  return runOpenshell(args, {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
    suppressOutput: true,
  });
}

function removeDockerDriverGatewayRegistration(): boolean {
  const removeResult = runQuietOpenshell(["gateway", "remove", GATEWAY_NAME]);
  if (removeResult.status === 0) return true;

  // OpenShell dev builds before NVIDIA/OpenShell#1221 used `gateway destroy`
  // for local metadata cleanup. Post-#1221 builds removed lifecycle verbs and
  // use `gateway remove` instead, so keep both forms quiet and best-effort.
  const destroyResult = runQuietOpenshell(["gateway", "destroy", "-g", GATEWAY_NAME]);
  return destroyResult.status === 0;
}

function stopDockerDriverGatewayProcess(): boolean {
  const result = hostGatewayProcess.stopHostGatewayProcesses(
    {
      log: console.log,
      warn: console.warn,
    },
    {
      gatewayBin: resolveOpenShellGatewayBinary(),
      pidFile: getDockerDriverGatewayPidFile(),
      stateDir: getDockerDriverGatewayStateDir(),
    },
  );
  return result.stopped.length > 0;
}

function stopLegacyGatewayClusterContainer(): boolean {
  const containerName = getGatewayClusterContainerName();
  const inspectResult = dockerInspect(["--type", "container", containerName], {
    ignoreError: true,
    suppressOutput: true,
  });
  if (inspectResult.status !== 0) return false;

  dockerStop(containerName, {
    ignoreError: true,
    suppressOutput: true,
  });
  dockerRm(containerName, {
    ignoreError: true,
    suppressOutput: true,
  });

  const postInspectResult = dockerInspect(["--type", "container", containerName], {
    ignoreError: true,
    suppressOutput: true,
  });
  return postInspectResult.status !== 0;
}

function retireLegacyGatewayForDockerDriverUpgrade(): void {
  runOpenshell(["forward", "stop", String(DASHBOARD_PORT)], { ignoreError: true });
  stopDockerDriverGatewayProcess();
  const stoppedLegacyContainer = stopLegacyGatewayClusterContainer();
  removeDockerDriverGatewayRegistration();
  if (stoppedLegacyContainer) {
    console.log("  ✓ Legacy OpenShell gateway container stopped for Docker-driver upgrade");
  }
}

function restartDockerDriverGatewayProcessForDrift(pid: number, reason: string): void {
  console.log(`  Existing OpenShell Docker-driver gateway is stale (${reason}); restarting...`);
  hostGatewayProcess.stopHostGatewayProcesses(
    {
      log: console.log,
      warn: console.warn,
    },
    {
      gatewayBin: resolveOpenShellGatewayBinary(),
      pidFile: getDockerDriverGatewayPidFile(),
      pids: [pid],
      stateDir: getDockerDriverGatewayStateDir(),
    },
  );
}

async function refreshDockerDriverGatewayReuseState(
  gatewayReuseState: GatewayReuseState,
): Promise<GatewayReuseState> {
  if (!isLinuxDockerDriverGatewayEnabled() || gatewayReuseState !== "healthy") {
    return gatewayReuseState;
  }
  const gatewayBin = resolveOpenShellGatewayBinary();
  const baseDesiredEnv = getDockerDriverGatewayEnv(
    runCaptureOpenshell(["--version"], { ignoreError: true }),
  );
  const runtimeIdentity = gatewayBin ? dockerDriverGatewayLaunch.buildDockerDriverGatewayRuntimeIdentity({ gatewayBin, gatewayEnv: baseDesiredEnv, stateDir: getDockerDriverGatewayStateDir(), sandboxBin: resolveOpenShellSandboxBinary(), compatContainerName: gatewayBinding.resolveGatewayCompatContainerName(GATEWAY_PORT) }) : null;
  const desiredEnv = runtimeIdentity?.desiredEnv ?? baseDesiredEnv;
  const driftBin = dockerDriverGatewayLaunch.resolveDriftGatewayBin(runtimeIdentity, gatewayBin);
  const identityBin = runtimeIdentity?.identityGatewayBin ?? gatewayBin;
  const pid = getDockerDriverGatewayPid();
  if (pid !== null && isDockerDriverGatewayProcessAlive()) {
    const drift = getDockerDriverGatewayRuntimeDrift(pid, desiredEnv, driftBin);
    if (drift) {
      console.log(
        `  Existing OpenShell Docker-driver gateway is stale (${drift.reason}); it will be recreated.`,
      );
      return "stale";
    }
    return gatewayReuseState;
  }

  const portCheck = await checkGatewayPortAvailable();
  const dockerGatewayPid = getDockerDriverGatewayPortListenerPid(portCheck, {
    gatewayBin: identityBin,
  });
  if (dockerGatewayPid !== null) {
    const drift = getDockerDriverGatewayRuntimeDrift(dockerGatewayPid, desiredEnv, driftBin);
    rememberDockerDriverGatewayPid(dockerGatewayPid);
    if (drift) {
      console.log(
        `  Existing OpenShell Docker-driver gateway is stale (${drift.reason}); it will be recreated.`,
      );
      return "stale";
    }
    return "healthy";
  }

  // `openshell status` already proved the selected gateway is reachable. If
  // the port probe cannot identify the owning PID, avoid tearing down a live
  // gateway solely because the pid file is stale.
  if (!portCheck.ok && !portCheck.pid) return "healthy";

  return "stale";
}

function destroyGateway(
  clearRegistry: () => void = registry.clearAll,
  isDockerDriverGatewayEnabledForDestroy: () => boolean = isLinuxDockerDriverGatewayEnabled,
): boolean {
  return destroyGatewayWithVolumeCleanup({
    clearRegistry,
    dockerRemoveVolumesByPrefix,
    gatewayName: GATEWAY_NAME,
    hasLifecycleCommands: () => gatewayCliSupportsLifecycleCommands(runCaptureOpenshell),
    isDockerDriverGatewayEnabled: isDockerDriverGatewayEnabledForDestroy,
    removeDockerDriverGatewayRegistration,
    runOpenshell,
    stopDockerDriverGatewayProcess,
  });
}

type FinalGatewayStartFailureOptions = {
  retries: number;
  dockerUnreachable?: boolean;
  collectDiagnostics?: () => string | null | undefined;
  cleanupGateway?: () => void;
  exitProcess?: (code: number) => never;
  printError?: (message?: string) => void;
};

function handleFinalGatewayStartFailure({
  retries,
  dockerUnreachable = false,
  collectDiagnostics = () =>
    runCaptureOpenshell(["doctor", "logs", "--name", GATEWAY_NAME], {
      ignoreError: true,
      timeout: 10_000,
    }),
  cleanupGateway = destroyGateway,
  exitProcess = (code) => process.exit(code),
  printError = (message = "") => console.error(message),
}: FinalGatewayStartFailureOptions): never {
  if (dockerUnreachable) {
    printDockerDaemonRecovery(printError);
    return exitProcess(1);
  }

  printError(`  Gateway failed to start after ${retries + 1} attempts.`);
  printError("  Gateway state preserved until diagnostics are collected.");
  printError("");

  try {
    const logs = redact(collectDiagnostics() || "");
    if (logs) {
      printError("  Gateway logs:");
      for (const line of String(logs)
        .split("\n")
        .map((l) => l.replace(/\r/g, "").replace(ANSI_RE, ""))
        .filter(Boolean)) {
        printError(`    ${line}`);
      }
      printError("");
    }
  } catch {
    // doctor logs unavailable — continue to best-effort cleanup and manual instructions
  }

  printError("  Cleaning up failed gateway state...");
  try {
    cleanupGateway();
    printError("  Cleanup attempted.");
  } catch (err) {
    const message = compactText(err instanceof Error ? err.message : String(err));
    printError(message ? `  Cleanup attempt failed: ${message}` : "  Cleanup attempt failed.");
  }
  printError("");
  printError("  Diagnostic command attempted before cleanup:");
  printError(`    openshell doctor logs --name ${GATEWAY_NAME}`);
  printError("    openshell doctor check");
  printError("");
  printError("  If gateway cleanup did not complete, run:");
  printError(`    openshell gateway remove ${GATEWAY_NAME}`);
  printError(`    # For OpenShell releases that still expose lifecycle commands:`);
  printError(`    openshell gateway destroy -g ${GATEWAY_NAME}`);
  if (process.platform === "linux") {
    printError(
      "    sudo pkill -f openshell-gateway  # if a privileged host gateway process remains",
    );
  }
  printError(
    `    docker volume ls -q --filter "name=openshell-cluster-${GATEWAY_NAME}" | xargs -r docker volume rm`,
  );
  printError(`    nemoclaw onboard --resume`);
  return exitProcess(1);
}

function getGatewayClusterContainerState(): string {
  const containerName = getGatewayClusterContainerName();
  const state = dockerContainerInspectFormat(
    "{{.State.Status}}{{if .State.Health}} {{.State.Health.Status}}{{end}}",
    containerName,
    { ignoreError: true },
  )
    .trim()
    .toLowerCase();
  return state || "missing";
}

function getGatewayHealthWaitConfig(_startStatus = 0, containerState = "") {
  const isArm64 = process.arch === "arm64";
  const standardCount = envInt("NEMOCLAW_HEALTH_POLL_COUNT", isArm64 ? 30 : 12);
  const standardInterval = envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", isArm64 ? 10 : 5);
  const extendedCount = envInt("NEMOCLAW_GATEWAY_START_POLL_COUNT", standardCount);
  const extendedInterval = envInt("NEMOCLAW_GATEWAY_START_POLL_INTERVAL", standardInterval);
  const normalizedState = String(containerState || "")
    .trim()
    .toLowerCase();
  const normalizedContainerState = normalizedState || "missing";
  const useExtendedWait = normalizedContainerState !== "missing";

  return {
    count: useExtendedWait ? extendedCount : standardCount,
    interval: useExtendedWait ? extendedInterval : standardInterval,
    extended: useExtendedWait,
    containerState: normalizedContainerState,
  };
}

function buildGatewayClusterExecArgv(script: string): string[] {
  return dockerExecArgv(getGatewayClusterContainerName(), ["sh", "-lc", script]);
}

function hostCommandExists(commandName: string): boolean {
  return !!runCapture(["sh", "-c", 'command -v "$1"', "--", commandName], {
    ignoreError: true,
  });
}

function captureProcessArgs(pid: number): string {
  return runCapture(["ps", "-p", String(pid), "-o", "args="], {
    ignoreError: true,
  }).trim();
}

function checkGatewayPortAvailable() {
  return checkPortAvailable(GATEWAY_PORT, dockerDriverGatewayEnv.getGatewayPortCheckOptions());
}

function getGatewayLocalEndpoint(): string {
  return dockerDriverGatewayEnv.getGatewayHttpsEndpoint();
}

const {
  gatewayClusterHealthcheckPassed,
  repairGatewayBootstrapSecrets,
} = createGatewayBootstrapRepairHelpers({
  buildGatewayClusterExecArgv,
  run,
  runCapture,
});

function getDockerDriverGatewayStateDir(): string {
  const configured = process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  const dir = gatewayBinding.resolveGatewayStateDirName(GATEWAY_PORT);
  return path.join(os.homedir(), ".local", "state", "nemoclaw", dir);
}

function getDockerDriverGatewayPidFile(): string {
  return path.join(getDockerDriverGatewayStateDir(), "openshell-gateway.pid");
}

function resolveSiblingBinary(binaryName: string): string | null {
  const openshellBin = OPENSHELL_BIN || resolveOpenshell();
  if (typeof openshellBin !== "string" || openshellBin.length === 0) return null;
  const sibling = path.join(path.dirname(openshellBin), binaryName);
  if (fs.existsSync(sibling)) return sibling;
  return null;
}

function resolveOpenShellGatewayBinary(): string | null {
  const configured = process.env.NEMOCLAW_OPENSHELL_GATEWAY_BIN;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  const sibling = resolveSiblingBinary("openshell-gateway");
  if (sibling) return sibling;
  for (const candidate of [
    path.join(os.homedir(), ".local", "bin", "openshell-gateway"),
    "/usr/local/bin/openshell-gateway",
    "/usr/bin/openshell-gateway",
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveOpenShellSandboxBinary(): string | null {
  const configured = process.env.NEMOCLAW_OPENSHELL_SANDBOX_BIN;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  const sibling = resolveSiblingBinary("openshell-sandbox");
  if (sibling) return sibling;
  for (const candidate of [
    path.join(os.homedir(), ".local", "bin", "openshell-sandbox"),
    "/usr/local/bin/openshell-sandbox",
    "/usr/bin/openshell-sandbox",
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function getOpenShellDockerSupervisorImage(versionOutput: string | null = null): string {
  if (process.env.OPENSHELL_DOCKER_SUPERVISOR_IMAGE) {
    return process.env.OPENSHELL_DOCKER_SUPERVISOR_IMAGE;
  }
  const installedVersion = getInstalledOpenshellVersion(versionOutput);
  if (shouldUseOpenshellDevChannel() || isOpenshellDevVersion(versionOutput)) {
    return "ghcr.io/nvidia/openshell/supervisor:dev";
  }
  const supportedVersion = installedVersion ?? getBlueprintMaxOpenshellVersion() ?? SUPPORTED_OPENSHELL_FALLBACK_VERSION;
  return `ghcr.io/nvidia/openshell/supervisor:${supportedVersion}`;
}

function getDockerDriverGatewayEnv(
  versionOutput: string | null = null,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return dockerDriverGatewayEnv.buildDockerDriverGatewayEnv({
    platform,
    stateDir: getDockerDriverGatewayStateDir(),
    dockerNetworkName: process.env.OPENSHELL_DOCKER_NETWORK_NAME || "openshell-docker",
    getDockerSupervisorImage: () => getOpenShellDockerSupervisorImage(versionOutput),
    resolveSandboxBin: resolveOpenShellSandboxBinary,
  });
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

function getDockerDriverGatewayPid(): number | null {
  try {
    const raw = fs.readFileSync(getDockerDriverGatewayPidFile(), "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readProcessEnv(pid: number): Record<string, string> | null {
  const procEnvPath = `/proc/${pid}/environ`;
  const env: Record<string, string> = {};
  try {
    if (!fs.existsSync(procEnvPath)) return null;
    for (const entry of fs.readFileSync(procEnvPath, "utf-8").split("\0")) {
      if (!entry) continue;
      const idx = entry.indexOf("=");
      if (idx <= 0) continue;
      env[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
  } catch {
    return null;
  }
  return env;
}

function hasDockerDriverGatewayEnv(pid: number): boolean {
  const env = readProcessEnv(pid);
  if (!env) return false;
  return (
    env.OPENSHELL_DRIVERS === "docker" ||
    Boolean(env.OPENSHELL_DOCKER_SUPERVISOR_IMAGE) ||
    env.OPENSHELL_GRPC_ENDPOINT === getDockerDriverGatewayEndpoint()
  );
}

function readProcessExe(pid: number): string | null {
  try {
    const procExePath = `/proc/${pid}/exe`;
    if (!fs.existsSync(procExePath)) return null;
    return fs.readlinkSync(procExePath);
  } catch {
    return null;
  }
}

function normalizeGatewayExecutablePath(value: string | null | undefined): string | null {
  if (!value) return null;
  const withoutDeletedSuffix = value.replace(/ \(deleted\)$/, "");
  try {
    return fs.realpathSync.native(withoutDeletedSuffix);
  } catch {
    return path.resolve(withoutDeletedSuffix);
  }
}

type DockerDriverGatewayRuntimeDrift = { reason: string };

function shouldRequireDockerDriverEnv(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux";
}

function getDockerDriverGatewayRuntimeDriftFromSnapshot({
  processEnv,
  processExe,
  desiredEnv,
  gatewayBin,
}: {
  processEnv: Record<string, string> | null;
  processExe: string | null;
  desiredEnv: Record<string, string>;
  gatewayBin?: string | null;
}): DockerDriverGatewayRuntimeDrift | null {
  if (!processEnv) {
    return { reason: "could not verify process environment" };
  }
  for (const key of dockerDriverGatewayEnv.DOCKER_DRIVER_GATEWAY_RUNTIME_ENV_KEYS) {
    const desired = desiredEnv[key];
    if (typeof desired !== "string") continue;
    const actual = processEnv[key];
    if (actual !== desired) {
      return { reason: `${key}=${actual || "<unset>"} (expected ${desired})` };
    }
  }

  if (processExe === null) {
    return { reason: "could not verify process executable" };
  }
  if (processExe.endsWith(" (deleted)")) {
    return { reason: "gateway executable was replaced on disk" };
  }
  const expectedExe = normalizeGatewayExecutablePath(gatewayBin);
  const actualExe = normalizeGatewayExecutablePath(processExe);
  if (expectedExe && actualExe && actualExe !== expectedExe) {
    return { reason: `executable=${actualExe} (expected ${expectedExe})` };
  }
  return null;
}

function getDockerDriverGatewayRuntimeDrift(
  pid: number,
  desiredEnv: Record<string, string>,
  gatewayBin?: string | null,
  platform: NodeJS.Platform = process.platform,
): DockerDriverGatewayRuntimeDrift | null {
  if (
    platform === "darwin" &&
    desiredEnv.OPENSHELL_DRIVERS === "docker"
  ) {
    const markerDrift =
      dockerDriverGatewayRuntimeMarker.getDockerDriverGatewayRuntimeMarkerDriftForStateDir(
        getDockerDriverGatewayStateDir(),
        {
          pid,
          desiredEnv,
          endpoint: getDockerDriverGatewayEndpoint(),
          gatewayBin,
          dockerHost: process.env.DOCKER_HOST || null,
          platform,
          arch: process.arch,
        },
      );
    if (markerDrift) return markerDrift;
    if (
      vmDriverProcess.hasOpenShellVmDriverChildProcess(pid, (args) =>
        runCapture([...args], { ignoreError: true }),
      )
    ) {
      return { reason: "VM driver child process is still attached to the gateway" };
    }
  }
  if (!shouldRequireDockerDriverEnv(platform)) return null;
  return getDockerDriverGatewayRuntimeDriftFromSnapshot({
    processEnv: readProcessEnv(pid),
    processExe: readProcessExe(pid),
    desiredEnv,
    gatewayBin,
  });
}

function isDockerDriverGatewayProcess(
  pid: number,
  gatewayBin?: string | null,
  opts: { requireDockerDriverEnv?: boolean } = {},
): boolean {
  const procCmdlinePath = `/proc/${pid}/cmdline`;
  let identity = "";
  try {
    if (fs.existsSync(procCmdlinePath)) {
      identity = fs.readFileSync(procCmdlinePath, "utf-8").replace(/\0/g, " ").trim();
    }
  } catch {
    identity = "";
  }
  if (!identity) {
    identity = captureProcessArgs(pid);
  }
  if (!identity) return false;
  const matchesGatewayBinary =
    identity.includes("openshell-gateway") ||
    (typeof gatewayBin === "string" && gatewayBin.length > 0 && identity.includes(gatewayBin));
  if (!matchesGatewayBinary) return false;
  if (opts.requireDockerDriverEnv && !hasDockerDriverGatewayEnv(pid)) return false;
  return true;
}

function isDockerDriverGatewayProcessAlive(): boolean {
  const pid = getDockerDriverGatewayPid();
  if (pid === null || !isPidAlive(pid)) return false;
  if (!isDockerDriverGatewayProcess(pid, resolveOpenShellGatewayBinary(), {
    requireDockerDriverEnv: shouldRequireDockerDriverEnv(),
  })) {
    clearDockerDriverGatewayRuntimeFiles();
    return false;
  }
  return true;
}

function clearDockerDriverGatewayRuntimeFiles(): void {
  fs.rmSync(getDockerDriverGatewayPidFile(), { force: true });
  dockerDriverGatewayRuntimeMarker.clearDockerDriverGatewayRuntimeMarker(
    getDockerDriverGatewayStateDir(),
  );
}

function rememberDockerDriverGatewayPid(pid: number): void {
  dockerDriverGatewayRuntimeMarker.writeDockerDriverGatewayPidFile(getDockerDriverGatewayPidFile(), pid);
}

function getDockerDriverGatewayPortListenerPid(
  portCheck: import("./onboard/preflight").PortProbeResult,
  opts: {
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    gatewayBin?: string | null;
    isPidAliveFn?: (pid: number) => boolean;
    isDockerDriverGatewayProcessFn?: (pid: number, gatewayBin?: string | null) => boolean;
  } = {},
): number | null {
  if (portCheck.ok) return null;
  if (
    !isLinuxDockerDriverGatewayEnabled(
      opts.platform ?? process.platform,
      opts.arch ?? process.arch,
    )
  )
    return null;
  const pid = Number(portCheck.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const proc = String(portCheck.process || "").toLowerCase();
  if (!proc.startsWith("openshell")) return null;
  const alive = opts.isPidAliveFn ?? isPidAlive;
  if (!alive(pid)) return null;
  const isGateway =
    opts.isDockerDriverGatewayProcessFn ??
    ((candidatePid: number, gatewayBin?: string | null) =>
      isDockerDriverGatewayProcess(candidatePid, gatewayBin, {
        requireDockerDriverEnv: shouldRequireDockerDriverEnv(opts.platform ?? process.platform),
      }));
  if (!isGateway(pid, opts.gatewayBin)) return null;
  return pid;
}

function isDockerDriverGatewayPortListener(
  portCheck: import("./onboard/preflight").PortProbeResult,
  opts: Parameters<typeof getDockerDriverGatewayPortListenerPid>[1] = {},
): boolean {
  return getDockerDriverGatewayPortListenerPid(portCheck, opts) !== null;
}

function registerDockerDriverGatewayEndpoint(): boolean {
  const selectExisting = runQuietOpenshell(["gateway", "select", GATEWAY_NAME]);
  if (selectExisting.status === 0) {
    const status = runCaptureOpenshell(["status"], { ignoreError: true });
    const namedInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
      ignoreError: true,
    });
    const currentInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
    if (isGatewayHealthy(status, namedInfo, currentInfo)) {
      process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
      return true;
    }
  }

  let addResult = runOpenshell(
    ["gateway", "add", getDockerDriverGatewayEndpointArg(), "--local", "--name", GATEWAY_NAME],
    { ignoreError: true, suppressOutput: true },
  );
  if (addResult.status !== 0) {
    removeDockerDriverGatewayRegistration();
    addResult = runOpenshell(
      ["gateway", "add", getDockerDriverGatewayEndpointArg(), "--local", "--name", GATEWAY_NAME],
      { ignoreError: true, suppressOutput: true },
    );
  }
  const selectResult = runOpenshell(["gateway", "select", GATEWAY_NAME], {
    ignoreError: true,
    suppressOutput: true,
  });
  const ok =
    (addResult.status === 0 && selectResult.status === 0) ||
    (selectResult.status === 0 &&
      isGatewayHealthy(
        runCaptureOpenshell(["status"], { ignoreError: true }),
        runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], { ignoreError: true }),
        runCaptureOpenshell(["gateway", "info"], { ignoreError: true }),
      ));
  if (ok) {
    process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
  } else if (process.env.OPENSHELL_GATEWAY === GATEWAY_NAME) {
    delete process.env.OPENSHELL_GATEWAY;
  }
  return ok;
}



function attachGatewayMetadataIfNeeded({
  forceRefresh = false,
}: { forceRefresh?: boolean } = {}): boolean {
  const gwInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
    ignoreError: true,
  });
  // runCaptureOpenshell may return stale-but-present gateway metadata. When
  // hasStaleGateway(gwInfo) is truthy we skip runOpenshell unless a repair
  // flow explicitly forces a refresh after recreating bootstrap secrets.
  if (!forceRefresh && hasStaleGateway(gwInfo)) return true;

  if (isLinuxDockerDriverGatewayEnabled()) {
    return registerDockerDriverGatewayEndpoint();
  }

  const addResult = runOpenshell(
    ["gateway", "add", getGatewayLocalEndpoint(), "--local", "--name", GATEWAY_NAME],
    { ignoreError: true, suppressOutput: true },
  );
  if (addResult.status === 0) {
    console.log("  ✓ Gateway metadata reattached");
    return true;
  }
  return false;
}

async function ensureNamedCredential(
  envName: string | null,
  label: string,
  helpUrl: string | null = null,
): Promise<string | typeof BACK_TO_SELECTION> {
  return credentialPrompt.ensureNamedCredential(envName, label, helpUrl);
}

function waitForSandboxReady(sandboxName: string, attempts = 10, delaySeconds = 2): boolean {
  for (let i = 0; i < attempts; i += 1) {
    const list = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
    if (isSandboxReady(list, sandboxName)) return true;

    // Package-managed OpenShell gateways report readiness through
    // `sandbox list`; legacy Kubernetes gateways may still expose pod state.
    if (isLinuxDockerDriverGatewayEnabled()) {
      if (i < attempts - 1) sleepSeconds(delaySeconds);
      continue;
    }
    const podPhase = runCaptureOpenshell(
      [
        "doctor",
        "exec",
        "--",
        "kubectl",
        "-n",
        "openshell",
        "get",
        "pod",
        sandboxName,
        "-o",
        "jsonpath={.status.phase}",
      ],
      { ignoreError: true },
    );
    if (podPhase === "Running") return true;
    sleepSeconds(delaySeconds);
  }
  return false;
}

// parsePolicyPresetEnv — see urlUtils import above
// isSafeModelId — see validation import above

// getNonInteractiveProvider, getNonInteractiveModel — moved to onboard-providers.ts

// ── Step 1: Preflight ────────────────────────────────────────────

// Keep the Docker CDI guard near preflight so resume hits the same early failure path.
// Jetson/Tegra uses Docker's NVIDIA runtime backend and is exempt from CDI.
function assertCdiNvidiaGpuSpecPresent(
  host: ReturnType<typeof assessHost>,
  optedOutGpuPassthrough: boolean,
  hostGpuPlatform: string | null | undefined = null,
): void {
  if (hostGpuPlatform === "jetson" || preflightUtils.isWslDockerDesktopRuntime(host)) return;
  if (!host.cdiNvidiaGpuSpecMissing || optedOutGpuPassthrough) return;
  console.error(
    "  Docker is configured for CDI device injection (CDISpecDirs is set), but no",
  );
  console.error(
    "  nvidia.com/gpu CDI spec was found on the host. OpenShell's gateway start will",
  );
  console.error(
    "  fail with `unresolvable CDI devices nvidia.com/gpu=all` (issue #3152).",
  );
  printRemediationActions(planHostRemediation(host));
  process.exit(1);
}


type PreflightOptions = Pick<
  OnboardOptions,
  "sandboxGpu" | "sandboxGpuDevice" | "gpu" | "noGpu"
> & {
  optedOutGpuPassthrough?: boolean;
};

// Reject unsupported container runtimes (currently only Podman with the
// Linux Docker-driver gateway) before any Docker-specific probes. Both
// the fresh preflight and `--resume` backstop call this — if `docker`
// resolves to Podman, surface the unsupported-runtime message instead of
// running bridge/DNS diagnostics that would be misleading.
function rejectUnsupportedContainerRuntime(host: ReturnType<typeof assessHost>): void {
  if (isLinuxDockerDriverGatewayEnabled() && host.runtime === "podman") {
    console.error(`  ✗ ${cliDisplayName()} onboarding now uses OpenShell's Docker driver.`);
    console.error(`    Podman is not supported for this ${cliDisplayName()} integration path.`);
    console.error("    Switch to Docker Engine and rerun onboarding.");
    process.exit(1);
  }
}

async function preflight(
  preflightOpts: PreflightOptions = {},
): Promise<ReturnType<typeof nim.detectGpu>> {
  step(1, 8, "Preflight checks");

  const host = assessHost();

  // Docker / runtime
  if (!host.dockerReachable) {
    console.error("  Docker is not reachable. Please fix Docker and try again.");
    printRemediationActions(planHostRemediation(host));
    process.exit(1);
  }
  // Reject unsupported runtimes (Podman) BEFORE the success log so
  // Podman users do not see a misleading `✓ Docker is running` line
  // immediately followed by a fatal unsupported-runtime exit.
  rejectUnsupportedContainerRuntime(host);
  console.log("  ✓ Docker is running");
  require("./onboard/http-proxy-preflight").warnIfHostProxyMissesLoopback();
  const gpu = nim.detectGpu();
  const sandboxGpuConfig = resolveSandboxGpuConfig(gpu, {
    flag: resolveSandboxGpuFlagFromOptions(preflightOpts),
    device: preflightOpts.sandboxGpuDevice ?? null,
  });
  exitOnSandboxGpuConfigErrors(sandboxGpuConfig);
  const optedOutGpuPassthrough =
    preflightOpts.optedOutGpuPassthrough === true ||
    preflightOpts.noGpu === true ||
    !sandboxGpuConfig.sandboxGpuEnabled;
  assertCdiNvidiaGpuSpecPresent(host, optedOutGpuPassthrough, sandboxGpuConfig.hostGpuPlatform);

  assertDockerBridgeAndContainerDnsHealthy(host);

  if (host.runtime !== "unknown") {
    console.log(`  ✓ Container runtime: ${host.runtime}`);
  }
  if (host.notes.includes("Running under WSL")) {
    console.log("  ⓘ Running under WSL");
  }

  if (
    host.isContainerRuntimeUnderProvisioned &&
    process.env.NEMOCLAW_IGNORE_RUNTIME_RESOURCES !== "1"
  ) {
    const detected: string[] = [];
    if (typeof host.dockerCpus === "number") detected.push(`${host.dockerCpus} vCPU`);
    if (typeof host.dockerMemTotalBytes === "number") {
      const gib = host.dockerMemTotalBytes / 1024 ** 3;
      detected.push(`${gib.toFixed(1)} GiB`);
    }
    const detectedStr = detected.length > 0 ? detected.join(" / ") : "unknown";
    console.warn(
      `  ⚠ Container runtime under-provisioned: ${detectedStr} detected ` +
        `(recommended: ${preflightUtils.MIN_RECOMMENDED_DOCKER_CPUS} vCPU / ${preflightUtils.MIN_RECOMMENDED_DOCKER_MEM_GIB} GiB).`,
    );
    console.warn(
      "    The sandbox build will be slow and may stall on default Colima settings.",
    );
    if (host.runtime === "colima") {
      console.warn(
        `    Suggested: colima stop && colima start --cpu ${preflightUtils.MIN_RECOMMENDED_DOCKER_CPUS} --memory ${preflightUtils.MIN_RECOMMENDED_DOCKER_MEM_GIB}`,
      );
    } else if (host.runtime === "docker-desktop") {
      console.warn("    Suggested: Docker Desktop → Settings → Resources, raise CPU/memory.");
    }
    console.warn("    Set NEMOCLAW_IGNORE_RUNTIME_RESOURCES=1 to silence this check.");
    if (isNonInteractive()) {
      console.warn("    WARNING: Non-interactive mode is continuing despite under-provisioned runtime.");
    } else {
      const proceed = await promptYesNoOrDefault("  Continue with onboarding?", null, false);
      if (!proceed) {
        console.error("  Aborted by user. Resize your container runtime and rerun `nemoclaw onboard`.");
        process.exit(1);
      }
    }
  } else if (host.dockerReachable) {
    const detected: string[] = [];
    if (typeof host.dockerCpus === "number") detected.push(`${host.dockerCpus} vCPU`);
    if (typeof host.dockerMemTotalBytes === "number") {
      const gib = host.dockerMemTotalBytes / 1024 ** 3;
      detected.push(`${gib.toFixed(1)} GiB`);
    }
    if (detected.length > 0) {
      console.log(`  ✓ Container runtime resources: ${detected.join(" / ")}`);
    }
  }

  ensureOpenshellForOnboard();

  // Classify gateway state before port checks. Legacy non-Docker-driver
  // path destroys stale/unnamed gateways here so the port frees up for
  // checks below; Docker-driver path defers the destructive recreate to
  // step [2/8] (see applyPreflightGatewayCleanup). If another gateway is
  // active but the named one exists, select it to avoid false conflicts.
  const gatewaySnapshot = selectNamedGatewayForReuseIfNeeded(getGatewayReuseSnapshot());
  let gatewayReuseState = gatewaySnapshot.gatewayReuseState;
  gatewayReuseState = await refreshDockerDriverGatewayReuseState(gatewayReuseState);

  // Verify the legacy gateway container is actually running — openshell CLI
  // metadata can be stale after a manual `docker rm`. See #2020. Newer
  // package-managed OpenShell gateways do not have an openshell-cluster-*
  // Docker container, so the live CLI health check is the source of truth.
  gatewayReuseState = await reconcilePreflightGatewayReuseState({
    gatewayReuseState,
    supportsLifecycleCommands: gatewayCliSupportsLifecycleCommands(runCaptureOpenshell),
    gatewayName: GATEWAY_NAME,
    verifyGatewayContainerRunning,
    recoverGatewayRuntime,
    waitForGatewayHttpReady,
    getGatewayLocalEndpoint,
    stopDashboardForward: () =>
      runOpenshell(["forward", "stop", String(DASHBOARD_PORT)], { ignoreError: true }),
    stopAllDashboardForwards,
    destroyGateway,
    destroyGatewayForReuse,
    getGatewayClusterImageDrift,
    exitProcess: (code) => process.exit(code),
  });

  gatewayReuseState = applyPreflightGatewayCleanup({
    gatewayReuseState,
    isDockerDriverGatewayEnabled: isLinuxDockerDriverGatewayEnabled(),
    cliDisplayName: cliDisplayName(),
    dashboardPort: DASHBOARD_PORT,
    log: console.log,
    runOpenshell,
    destroyGateway,
    destroyGatewayForReuse,
  });

  // Clean up orphaned Docker containers from interrupted onboard (e.g. Ctrl+C
  // during gateway start). The container may still be running even though
  // OpenShell has no metadata for it (gatewayReuseState === "missing").
  if (gatewayReuseState === "missing" && !isLinuxDockerDriverGatewayEnabled()) {
    const containerName = `openshell-cluster-${GATEWAY_NAME}`;
    const inspectResult = dockerInspect(
      ["--type", "container", "--format", "{{.State.Status}}", containerName],
      { ignoreError: true, suppressOutput: true },
    );
    if (inspectResult.status === 0) {
      console.log("  Cleaning up orphaned gateway container...");
      dockerStop(containerName, {
        ignoreError: true,
        suppressOutput: true,
      });
      dockerRm(containerName, {
        ignoreError: true,
        suppressOutput: true,
      });
      const postInspectResult = dockerInspect(["--type", "container", containerName], {
        ignoreError: true,
        suppressOutput: true,
      });
      if (postInspectResult.status !== 0) {
        dockerRemoveVolumesByPrefix(`openshell-cluster-${GATEWAY_NAME}`, {
          ignoreError: true,
          suppressOutput: true,
        });
        registry.clearAll();
        console.log("  ✓ Orphaned gateway container removed");
      } else {
        console.warn("  ! Found an orphaned gateway container, but automatic cleanup failed.");
      }
    }
  }

  // Required ports — gateway, plus the dashboard port when an explicit one
  // is requested. envVar is the override env var documented in
  // src/lib/core/ports.ts; surfacing it in the preflight error gives users a clear
  // escape hatch when an unrelated process is holding the default port
  // (closes #2497). When --control-ui-port is set, check that port instead
  // of the default. When auto-allocation is possible (no explicit port),
  // skip the dashboard port check entirely — ensureDashboardForward will
  // find a free port.
  const dashboardPortToCheck = _preflightDashboardPort ?? null;
  const requiredPorts = [
    {
      port: GATEWAY_PORT,
      label: "OpenShell gateway",
      envVar: "NEMOCLAW_GATEWAY_PORT",
    },
    ...(dashboardPortToCheck !== null
      ? [
          {
            port: dashboardPortToCheck,
            label: `${cliDisplayName()} dashboard`,
            envVar: "NEMOCLAW_DASHBOARD_PORT",
          },
        ]
      : []),
  ];
  for (const { port, label, envVar } of requiredPorts) {
    const portCheckOptions =
      port === GATEWAY_PORT ? dockerDriverGatewayEnv.getGatewayPortCheckOptions() : undefined;
    let portCheck = await checkPortAvailable(port, portCheckOptions);
    if (!portCheck.ok) {
      const reuse = await applyHealthyPortReuse({ port, gatewayPort: GATEWAY_PORT, dashboardPort: DASHBOARD_PORT, label, runtimeDisplayName: cliDisplayName(), gatewayName: GATEWAY_NAME, gatewayReuseState, portCheckOptions, supportsLifecycleCommands: gatewayCliSupportsLifecycleCommands(runCaptureOpenshell), destroyGateway, runOpenshell, checkPortAvailable, verifyGatewayContainerRunning });
      if (reuse === "continue") continue;
      if (reuse) { ({ gatewayReuseState, portCheck } = reuse); if (portCheck.ok) continue; }
      if (port === GATEWAY_PORT) {
        const dockerGatewayPid = getDockerDriverGatewayPortListenerPid(portCheck);
        if (dockerGatewayPid !== null) {
          rememberDockerDriverGatewayPid(dockerGatewayPid);
          console.log(
            `  ✓ Port ${port} already owned by NemoClaw OpenShell Docker gateway (${label})`,
          );
          continue;
        }
      }
      // Auto-cleanup orphaned SSH port-forward from a previous NemoClaw session
      // (e.g. dashboard forward left behind after destroy). Only kill the process
      // if its command line contains "openshell" to avoid killing unrelated SSH
      // tunnels the user may have set up on the same port. (#1950)
      if (port === DASHBOARD_PORT && portCheck.process === "ssh" && portCheck.pid) {
        // Use `ps` to get the command line — works on Linux, macOS, and WSL.
        const cmdline = captureProcessArgs(portCheck.pid);
        if (cmdline.includes("openshell")) {
          console.log(
            `  Cleaning up orphaned SSH port-forward on port ${port} (PID ${portCheck.pid})...`,
          );
          run(["kill", String(portCheck.pid)], { ignoreError: true });
          sleepSeconds(1);
          portCheck = await checkPortAvailable(port, portCheckOptions);
          if (portCheck.ok) {
            console.log(`  ✓ Port ${port} available after orphaned forward cleanup (${label})`);
            continue;
          }
        }
      }
      console.error("");
      console.error(`  !! Port ${port} is not available.`);
      console.error(`     ${label} needs this port.`);
      console.error("");
      if (portCheck.process && portCheck.process !== "unknown") {
        console.error(
          `     Blocked by: ${portCheck.process}${portCheck.pid ? ` (PID ${portCheck.pid})` : ""}`,
        );
        console.error("");
        console.error("     To fix, stop the conflicting process:");
        console.error("");
        if (portCheck.pid) {
          console.error(`       sudo kill ${portCheck.pid}`);
        } else {
          console.error(`       sudo lsof -i :${port} -sTCP:LISTEN -P -n`);
        }
        for (const hint of getPortConflictServiceHints()) {
          console.error(hint);
        }
      } else {
        console.error(`     Could not identify the process using port ${port}.`);
        console.error(`     Run: sudo lsof -i :${port} -sTCP:LISTEN`);
      }
      console.error("");
      console.error(`     Or rerun with a different port:`);
      console.error(`       ${envVar}=<port> nemoclaw onboard`);
      console.error("");
      console.error(`     Detail: ${portCheck.reason}`);
      process.exit(1);
    }
    console.log(`  ✓ Port ${port} available (${label})`);
  }
  dockerDriverGatewayEnv.warnIfGatewayWildcardBindAddress();

  // GPU
  if (gpu && gpu.type === "nvidia") {
    const lines = nim.formatNvidiaGpuPreflightLines(gpu);
    console.log(`  ✓ ${lines[0]}`);
    for (const extra of lines.slice(1)) {
      console.log(`  ${extra}`);
    }
    if (!gpu.nimCapable) {
      console.log("  ⓘ Local NIM unavailable — GPU VRAM too small");
    }
  } else if (gpu && gpu.type === "apple") {
    console.log(
      `  ✓ Apple GPU detected: ${gpu.name}${gpu.cores ? ` (${gpu.cores} cores)` : ""}, ${gpu.totalMemoryMB} MB unified memory`,
    );
    console.log("  ⓘ Local NIM unavailable — requires NVIDIA GPU");
  } else {
    console.log("  ⓘ Local NIM unavailable — no GPU detected");
  }

  validateSandboxGpuPreflight(sandboxGpuConfig);
  if (sandboxGpuConfig.sandboxGpuEnabled) {
    console.log(
      `  ✓ Sandbox GPU: enabled (${sandboxGpuConfig.mode}${sandboxGpuConfig.sandboxGpuDevice ? `, device ${sandboxGpuConfig.sandboxGpuDevice}` : ""})`,
    );
  } else if (sandboxGpuConfig.mode === "0") {
    console.log("  ✓ Sandbox GPU: disabled by configuration");
  } else {
    console.log("  ⓘ Sandbox GPU: disabled (no NVIDIA GPU detected)");
  }

  // Memory / swap check (Linux only)
  if (process.platform === "linux") {
    const mem = getMemoryInfo();
    if (mem) {
      if (mem.totalMB < 12000) {
        console.log(
          `  ⚠ Low memory detected (${mem.totalRamMB} MB RAM + ${mem.totalSwapMB} MB swap = ${mem.totalMB} MB total)`,
        );

        let proceedWithSwap: boolean = false;
        if (!isNonInteractive()) {
          const answer = await prompt(
            "  Create a 4 GB swap file to prevent OOM during sandbox build? (requires sudo) [y/N]: ",
          );
          proceedWithSwap = Boolean(answer && answer.toLowerCase().startsWith("y"));
        }

        if (!proceedWithSwap) {
          console.log(
            "  ⓘ Skipping swap creation. Sandbox build may fail with OOM on this system.",
          );
        } else {
          console.log("  Creating 4 GB swap file to prevent OOM during sandbox build...");
          const swapResult = ensureSwap(12000);
          if (swapResult.ok && swapResult.swapCreated) {
            console.log("  ✓ Swap file created and activated");
          } else if (swapResult.ok) {
            if (swapResult.reason) {
              console.log(`  ⓘ ${swapResult.reason} — existing swap should help prevent OOM`);
            } else {
              console.log(`  ✓ Memory OK: ${mem.totalRamMB} MB RAM + ${mem.totalSwapMB} MB swap`);
            }
          } else {
            console.log(`  ⚠ Could not create swap: ${swapResult.reason}`);
            console.log("  Sandbox creation may fail with OOM on low-memory systems.");
          }
        }
      } else {
        console.log(`  ✓ Memory OK: ${mem.totalRamMB} MB RAM + ${mem.totalSwapMB} MB swap`);
      }
    }
  }

  if (_preflightDashboardPort === null) preflightDashboardPortRangeAvailability(); return gpu; // #3953 — fail-fast before next step
}

// ── Step 2: Gateway ──────────────────────────────────────────────

/** Start the OpenShell gateway with retry logic and post-start health polling. */
async function startGatewayWithOptions(
  _gpu: ReturnType<typeof nim.detectGpu>,
  { exitOnFailure = true, gpuPassthrough = false }: { exitOnFailure?: boolean; gpuPassthrough?: boolean } = {},
) {
  step(2, 8, "Starting OpenShell gateway");

  if (isLinuxDockerDriverGatewayEnabled()) {
    return startDockerDriverGateway({ exitOnFailure, skipSandboxBridgeReachability: gpuPassthrough && process.env.NEMOCLAW_DOCKER_GPU_PATCH !== "0" && dockerGpuPatch.getDockerGpuPatchNetworkMode(process.env) === "host" });
  }

  const gatewaySnapshot = selectNamedGatewayForReuseIfNeeded(getGatewayReuseSnapshot());
  if (
    isGatewayHealthy(
      gatewaySnapshot.gatewayStatus,
      gatewaySnapshot.gwInfo,
      gatewaySnapshot.activeGatewayInfo,
    )
  ) {
    // Final reuse gate — `isGatewayHealthy()` parses openshell CLI metadata,
    // which can be stale when the gateway container was just restarted (e.g.
    // after `colima stop && colima start`). Verify the gateway HTTP endpoint
    // is actually serving before declaring reuse, so we don't skip startup
    // and fail later in step 4 with "Connection refused". See #3258.
    if (await isGatewayHttpReady()) {
      console.log("  ✓ Reusing existing gateway");
      runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
      process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
      return;
    }
    console.log(
      `  Gateway metadata reports healthy but ${getGatewayLocalEndpoint()}/ is not responding. Starting a fresh gateway...`,
    );
  }

  if (hasStaleGateway(gatewaySnapshot.gwInfo)) {
    console.log("  Stale gateway detected — attempting restart without destroy...");
  }

  try {
    const { execFileSync } = require("child_process");
    execFileSync("ssh-keygen", ["-R", `openshell-${GATEWAY_NAME}`], { stdio: "ignore" });
  } catch {
    /* ssh-keygen -R may fail if entry doesn't exist — safe to ignore */
  }
  const knownHostsPath = path.join(os.homedir(), ".ssh", "known_hosts");
  try {
    const kh = fs.readFileSync(knownHostsPath, "utf8");
    const cleaned = pruneKnownHostsEntries(kh);
    if (cleaned !== kh) fs.writeFileSync(knownHostsPath, cleaned);
  } catch {
    /* best-effort cleanup — ignore absent/read/write errors */
  }

  const gwArgs = ["--name", GATEWAY_NAME, "--port", getGatewayPortArg()];
  if (gpuPassthrough) {
    gwArgs.push("--gpu");
  }
  const gatewayEnv = getGatewayStartEnv();
  if (gatewayEnv.OPENSHELL_CLUSTER_IMAGE) {
    console.log(`  Using pinned OpenShell gateway image: ${gatewayEnv.OPENSHELL_CLUSTER_IMAGE}`);
  }

  const retries = exitOnFailure ? 2 : 0;
  let dockerUnreachable = false;
  try {
    await pRetry(
      async () => {
        const startResult = await streamGatewayStart(
          openshellShellCommand(["gateway", "start", ...gwArgs]),
          {
            ...process.env,
            ...gatewayEnv,
          },
        );
        if (startResult.status !== 0) {
          const failure = reportLegacyGatewayStartResultFailure(
            startResult.output || "",
            console.log,
          );
          if (failure.kind === "docker_unreachable") {
            dockerUnreachable = true;
            throw new pRetry.AbortError(
              "Docker daemon is not reachable (gateway cannot start).",
            );
          }
        }
        console.log("  Waiting for gateway health...");
        const healthWait = getGatewayHealthWaitConfig(
          startResult.status,
          getGatewayClusterContainerState(),
        );
        if (healthWait.extended) {
          console.log(
            `  Gateway container is still ${healthWait.containerState}; allowing up to ${
              healthWait.count * healthWait.interval
            }s for first-time startup.`,
          );
        }

        const healthPollCount = healthWait.count;
        const healthPollInterval = healthWait.interval;
        for (let i = 0; i < healthPollCount; i++) {
          const repairResult = repairGatewayBootstrapSecrets();
          if (repairResult.repaired) {
            attachGatewayMetadataIfNeeded({ forceRefresh: true });
          } else if (gatewayClusterHealthcheckPassed()) {
            attachGatewayMetadataIfNeeded();
          }
          // Ensure the gateway remains selected before each probe.
          runCaptureOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
          const status = runCaptureOpenshell(["status"], { ignoreError: true });
          const namedInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
            ignoreError: true,
          });
          const currentInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
          // Require BOTH the openshell CLI metadata to report healthy AND the
          // host HTTP endpoint to be serving — the CLI metadata can report
          // healthy from the previous run while the upstream is still warming
          // up after a Docker daemon restart, leading to "Connection refused"
          // in step 4. See #3258.
          if (isGatewayHealthy(status, namedInfo, currentInfo) && (await isGatewayHttpReady())) {
            return; // success
          }
          if (i < healthPollCount - 1) sleepSeconds(healthPollInterval);
        }

        throw new Error("Gateway failed to start");
      },
      {
        retries,
        minTimeout: 10_000,
        factor: 3,
        onFailedAttempt: (err: { attemptNumber: number; retriesLeft: number }) => {
          console.log(
            `  Gateway start attempt ${err.attemptNumber} failed. ${err.retriesLeft} retries left...`,
          );
          if (err.retriesLeft > 0 && exitOnFailure) {
            destroyGateway();
          }
        },
      },
    );
  } catch {
    if (exitOnFailure) {
      handleFinalGatewayStartFailure({ retries, dockerUnreachable });
    }
    throw new Error("Gateway failed to start");
  }

  console.log("  ✓ Gateway is healthy");

  // CoreDNS fix — k3s-inside-Docker has broken DNS forwarding on all platforms.
  const runtime = getContainerRuntime();
  if (shouldPatchCoredns(runtime)) {
    console.log("  Patching CoreDNS DNS forwarding...");
    run(["bash", path.join(SCRIPTS, "fix-coredns.sh"), GATEWAY_NAME], {
      ignoreError: true,
    });
    const corednsReady = waitUntil(() => {
      const check = runCaptureOpenshell(
        [
          "doctor",
          "exec",
          "--",
          "kubectl",
          "get",
          "pods",
          "-n",
          "kube-system",
          "-l",
          "k8s-app=kube-dns",
          "-o",
          'jsonpath={range .items[*]}{.status.phase}{" "}{range .status.containerStatuses[*]}{.ready}{" "}{end}{end}',
        ],
        { ignoreError: true },
      );
      return check.includes("Running") && check.includes("true") && !check.includes("false");
    }, 10);
    if (!corednsReady) {
      console.warn("  CoreDNS did not report ready within timeout; continuing may cause DNS flakiness.");
    }
  }
  runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
  process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
}

async function startDockerDriverGateway({ exitOnFailure = true, skipSandboxBridgeReachability = false }: { exitOnFailure?: boolean; skipSandboxBridgeReachability?: boolean } = {}): Promise<void> {
  dockerDriverGatewayEnv.writeDockerGatewayDebEnvOverride(() => getDockerDriverGatewayEnv());
  const gatewayBin = resolveOpenShellGatewayBinary();
  const openshellVersionOutput = runCaptureOpenshell(["--version"], {
    ignoreError: true,
  });
  const gatewayEnv = getDockerDriverGatewayEnv(openshellVersionOutput);
  const stateDir = getDockerDriverGatewayStateDir();
  const runtimeIdentity = gatewayBin ? dockerDriverGatewayLaunch.buildDockerDriverGatewayRuntimeIdentity({ gatewayBin, gatewayEnv, stateDir, sandboxBin: resolveOpenShellSandboxBinary(), compatContainerName: gatewayBinding.resolveGatewayCompatContainerName(GATEWAY_PORT) }) : null;
  const gatewayLaunch = runtimeIdentity?.launch ?? null;
  const driftGatewayBin = dockerDriverGatewayLaunch.resolveDriftGatewayBin(runtimeIdentity, gatewayBin);
  const driftGatewayEnv = runtimeIdentity?.desiredEnv ?? gatewayEnv;
  const identityGatewayBin = runtimeIdentity?.identityGatewayBin ?? gatewayBin;
  const { verifySandboxBridgeGatewayReachableOrExit } =
    require("./onboard/gateway-sandbox-reachability") as typeof import("./onboard/gateway-sandbox-reachability");

  const gatewayStatus = runCaptureOpenshell(["status"], { ignoreError: true });
  const gwInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
    ignoreError: true,
  });
  const activeGatewayInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
  const pidFileGatewayPid = getDockerDriverGatewayPid();
  if (
    pidFileGatewayPid !== null &&
    isDockerDriverGatewayProcessAlive() &&
    isGatewayHealthy(gatewayStatus, gwInfo, activeGatewayInfo)
  ) {
    const drift = getDockerDriverGatewayRuntimeDrift(pidFileGatewayPid, driftGatewayEnv, driftGatewayBin);
    if (drift) {
      restartDockerDriverGatewayProcessForDrift(pidFileGatewayPid, drift.reason);
    } else if (registerDockerDriverGatewayEndpoint() && (await isDockerDriverGatewayHttpReady())) {
      await verifySandboxBridgeGatewayReachableOrExit(exitOnFailure, { skip: skipSandboxBridgeReachability }); console.log("  ✓ Reusing existing Docker-driver gateway");
      return;
    } else {
      console.log(
        `  Docker-driver gateway metadata reports healthy but http://127.0.0.1:${GATEWAY_PORT}/ is not responding. Starting a fresh gateway...`,
      );
    }
  }

  const portCheck = await checkGatewayPortAvailable();
  const portListenerPid = getDockerDriverGatewayPortListenerPid(portCheck, {
    gatewayBin: identityGatewayBin,
  });
  if (portListenerPid !== null) {
    const drift = getDockerDriverGatewayRuntimeDrift(portListenerPid, driftGatewayEnv, driftGatewayBin);
    if (drift) {
      rememberDockerDriverGatewayPid(portListenerPid);
      restartDockerDriverGatewayProcessForDrift(portListenerPid, drift.reason);
    } else {
      rememberDockerDriverGatewayPid(portListenerPid);
    }
    if (!drift && registerDockerDriverGatewayEndpoint()) {
      const adoptedStatus = runCaptureOpenshell(["status"], { ignoreError: true });
      const adoptedGwInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
        ignoreError: true,
      });
      const adoptedActiveGatewayInfo = runCaptureOpenshell(["gateway", "info"], {
        ignoreError: true,
      });
      if (
        isGatewayHealthy(adoptedStatus, adoptedGwInfo, adoptedActiveGatewayInfo) &&
        (await isDockerDriverGatewayHttpReady())
      ) {
        await verifySandboxBridgeGatewayReachableOrExit(exitOnFailure, { skip: skipSandboxBridgeReachability }); console.log(`  ✓ Reusing existing Docker-driver gateway process (PID ${portListenerPid})`);
        return;
      }
    }
  }
  if (!gatewayBin) {
    console.error("  OpenShell Docker-driver gateway binary not found.");
    console.error(
      `  Install OpenShell v${SUPPORTED_OPENSHELL_FALLBACK_VERSION}, or set NEMOCLAW_OPENSHELL_GATEWAY_BIN.`,
    );
    if (exitOnFailure) process.exit(1);
    throw new Error("OpenShell gateway binary not found");
  }

  const existingPid = getDockerDriverGatewayPid() ?? portListenerPid;
  if (existingPid !== null && isPidAlive(existingPid)) {
    if (!isDockerDriverGatewayProcess(existingPid, identityGatewayBin)) {
      clearDockerDriverGatewayRuntimeFiles();
    } else {
      console.log(`  Restarting unhealthy Docker-driver gateway process (PID ${existingPid})...`);
      try {
        process.kill(existingPid, "SIGTERM");
        sleepSeconds(1);
      } catch {
        /* best effort; the new process will surface any remaining port conflict */
      }
    }
  }

  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(stateDir, "openshell-gateway.log");
  const logFd = dockerDriverGatewayLaunch.openDockerDriverGatewayLog(logPath, { exitOnFailure });
  console.log("  Starting OpenShell Docker-driver gateway...");
  console.log(`  Gateway log: ${logPath}`);
  const launch = gatewayLaunch ?? {
    command: gatewayBin,
    args: [],
    env: { ...process.env, ...gatewayEnv },
    mode: "host" as const,
    processGatewayBin: gatewayBin,
  };
  dockerDriverGatewayLaunch.prepareAndLogDockerDriverGatewayLaunch(launch);
  const child = dockerDriverGatewayLaunch.spawnDockerDriverGateway(launch, logFd);
  const childExit = trackChildExit(child); // #3111 zombie-safe liveness
  child.unref();
  const childPid = child.pid ?? 0;
  if (childPid <= 0) {
    throw new Error("OpenShell gateway process did not return a pid");
  }
  rememberDockerDriverGatewayPid(childPid);
  dockerDriverGatewayRuntimeMarker.writeDockerDriverGatewayRuntimeMarkerForStateDir(getDockerDriverGatewayStateDir(), { pid: childPid, desiredEnv: driftGatewayEnv, endpoint: getDockerDriverGatewayEndpoint(), gatewayBin: driftGatewayBin, openshellVersion: getInstalledOpenshellVersion(openshellVersionOutput), dockerHost: process.env.DOCKER_HOST || null });

  const pollCount = envInt("NEMOCLAW_HEALTH_POLL_COUNT", 30);
  const pollInterval = envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", 2);
  for (let i = 0; i < pollCount; i += 1) {
    if (childExit.exited || !isPidAlive(childPid)) {
      break;
    }
    if (!registerDockerDriverGatewayEndpoint()) {
      if (i < pollCount - 1) sleepSeconds(pollInterval);
      continue;
    }
    const status = runCaptureOpenshell(["status"], { ignoreError: true });
    const namedInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
      ignoreError: true,
    });
    const currentInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
    // #4430: the status/gateway-info/TCP probes above take real wall-clock time; re-confirm
    // childExit/isPidAlive *after* them so a gateway that drifts on schema and aborts during
    // migration after accepting briefly can never print the misleading healthy line below.
    if (isGatewayHealthy(status, namedInfo, currentInfo) && (await isGatewayTcpReady()) && !childExit.exited && isPidAlive(childPid)) {
      await verifySandboxBridgeGatewayReachableOrExit(exitOnFailure, { skip: skipSandboxBridgeReachability }); console.log("  ✓ Docker-driver gateway is healthy");
      return;
    }
    if (i < pollCount - 1) sleepSeconds(pollInterval);
  }

  reportDockerDriverGatewayStartFailure(logPath, childExit, { exitOnFailure });
  throw new Error("Docker-driver gateway failed to start");
}

async function startGateway(
  _gpu: ReturnType<typeof nim.detectGpu>,
  { gpuPassthrough = false }: { gpuPassthrough?: boolean } = {},
): Promise<void> {
  return startGatewayWithOptions(_gpu, { exitOnFailure: true, gpuPassthrough });
}

async function startGatewayForRecovery(_gpu: ReturnType<typeof nim.detectGpu>): Promise<void> {
  return startGatewayWithOptions(_gpu, { exitOnFailure: false });
}

function getGatewayStartEnv(): Record<string, string> {
  const gatewayEnv = dockerDriverGatewayEnv.getGatewayStartNetworkEnv();
  const openshellVersion = getInstalledOpenshellVersion();
  const stableGatewayImage = openshellVersion
    ? `ghcr.io/nvidia/openshell/cluster:${openshellVersion}`
    : null;
  if (stableGatewayImage && openshellVersion) {
    gatewayEnv.OPENSHELL_CLUSTER_IMAGE = stableGatewayImage;
    gatewayEnv.IMAGE_TAG = openshellVersion;
    const overlayOverride = applyOverlayfsAutoFix(stableGatewayImage);
    if (overlayOverride) {
      gatewayEnv.OPENSHELL_CLUSTER_IMAGE = overlayOverride;
    }
  }
  return gatewayEnv;
}

/**
 * Memoizes `applyOverlayfsAutoFix` per upstream image for the lifetime of
 * the process. The expensive work (host assessment + image inspect / pull /
 * build) only needs to happen once per onboard invocation; both
 * `startGatewayWithOptions` and `recoverGatewayRuntime` go through
 * `getGatewayStartEnv()`, and without this cache the recovery path would
 * re-run the full assessment.
 *
 * Reset on a per-process basis only — env-var changes mid-process are
 * not modelled here and shouldn't happen in the CLI's normal flow.
 */
const overlayFixResultCache = new Map<string, string | null>();

/**
 * When the host runs Docker 26+ with the new containerd-snapshotter overlayfs
 * driver, k3s inside the upstream cluster image cannot mount nested overlays
 * and crashes. Build a tiny patched image locally that selects fuse-overlayfs
 * (or `native` via NEMOCLAW_OVERLAY_SNAPSHOTTER) and return its tag so the
 * caller can route OPENSHELL_CLUSTER_IMAGE to it. Returns null on every host
 * that is not affected, when the user opts out, or when the build fails (in
 * which case we fall through to the upstream image and let the existing
 * doctor diagnostics surface the underlying error).
 */
function applyOverlayfsAutoFix(upstreamImage: string): string | null {
  if (process.env.NEMOCLAW_DISABLE_OVERLAY_FIX === "1") {
    return null;
  }
  if (overlayFixResultCache.has(upstreamImage)) {
    return overlayFixResultCache.get(upstreamImage) ?? null;
  }
  let assessment: ReturnType<typeof preflightUtils.assessHost>;
  try {
    assessment = preflightUtils.assessHost();
  } catch (err) {
    // Don't silently swallow — log a breadcrumb so a future regression in
    // assessHost (or a Docker-daemon hang past `2>/dev/null`) doesn't make
    // the auto-fix mysteriously stop firing without any user-visible signal.
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`  Skipping overlayfs auto-fix: host assessment failed (${reason}).`);
    overlayFixResultCache.set(upstreamImage, null);
    return null;
  }
  if (!assessment.hasNestedOverlayConflict) {
    overlayFixResultCache.set(upstreamImage, null);
    return null;
  }

  const requestedSnapshotter = (process.env.NEMOCLAW_OVERLAY_SNAPSHOTTER || "")
    .trim()
    .toLowerCase();
  let snapshotter: "fuse-overlayfs" | "native" = "fuse-overlayfs";
  if (requestedSnapshotter === "native" || requestedSnapshotter === "fuse-overlayfs") {
    snapshotter = requestedSnapshotter;
  } else if (requestedSnapshotter !== "") {
    // Reject typos like 'NATIVE' or 'fuse' loudly so the user gets the image
    // they intended, not a silent default.
    console.warn(
      `  NEMOCLAW_OVERLAY_SNAPSHOTTER='${requestedSnapshotter}' is not recognized. ` +
        "Valid values are 'fuse-overlayfs' or 'native'. Falling back to 'fuse-overlayfs'.",
    );
  }

  console.log(
    `  Detected Docker 26+ containerd-snapshotter overlayfs (driver=${assessment.dockerStorageDriver}). ` +
      `Routing through a locally-built ${snapshotter} cluster image to bypass nested-overlay break.`,
  );
  console.log(
    "  Set NEMOCLAW_DISABLE_OVERLAY_FIX=1 to disable this auto-fix; see docs for the manual daemon.json workaround.",
  );

  try {
    const patchedTag = clusterImagePatch.ensurePatchedClusterImage({
      upstreamImage,
      snapshotter,
    });
    overlayFixResultCache.set(upstreamImage, patchedTag);
    return patchedTag;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`  Patched cluster image build failed: ${reason}`);
    console.error(
      "  Falling back to the upstream image. The k3s server will likely fail; see docs/reference/troubleshooting.mdx.",
    );
    overlayFixResultCache.set(upstreamImage, null);
    return null;
  }
}

async function recoverGatewayRuntime() {
  if (isLinuxDockerDriverGatewayEnabled()) {
    try {
      await startDockerDriverGateway({ exitOnFailure: false });
      return true;
    } catch {
      return false;
    }
  }

  runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
  let status = runCaptureOpenshell(["status"], { ignoreError: true });
  if (
    status.includes("Connected") &&
    isSelectedGateway(status) &&
    (await isGatewayHttpReady())
  ) {
    process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
    return true;
  }

  const startResult = runOpenshell(
    ["gateway", "start", "--name", GATEWAY_NAME, "--port", getGatewayPortArg()],
    {
      ignoreError: true,
      env: getGatewayStartEnv(),
      suppressOutput: true,
    },
  );
  if (startResult.status !== 0) {
    const diagnostic = compactText(
      redact(`${startResult.stderr || ""} ${startResult.stdout || ""}`),
    );
    console.error(`  Gateway restart failed (exit ${startResult.status}).`);
    if (diagnostic) {
      console.error(`  ${diagnostic.slice(0, 240)}`);
    }
  }
  runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });

  const recoveryWait = getGatewayHealthWaitConfig(
    startResult.status ?? 0,
    getGatewayClusterContainerState(),
  );
  const recoveryPollCount = recoveryWait.extended
    ? recoveryWait.count
    : envInt("NEMOCLAW_HEALTH_POLL_COUNT", 10);
  const recoveryPollInterval = recoveryWait.extended
    ? recoveryWait.interval
    : envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", 2);
  for (let i = 0; i < recoveryPollCount; i++) {
    const repairResult = repairGatewayBootstrapSecrets();
    if (repairResult.repaired) {
      attachGatewayMetadataIfNeeded({ forceRefresh: true });
    } else if (gatewayClusterHealthcheckPassed()) {
      attachGatewayMetadataIfNeeded();
    }
    status = runCaptureOpenshell(["status"], { ignoreError: true });
    if (
      status.includes("Connected") &&
      isSelectedGateway(status) &&
      (await isGatewayHttpReady())
    ) {
      process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
      const runtime = getContainerRuntime();
      if (shouldPatchCoredns(runtime)) {
        run(["bash", path.join(SCRIPTS, "fix-coredns.sh"), GATEWAY_NAME], {
          ignoreError: true,
        });
      }
      return true;
    }
    if (i < recoveryPollCount - 1) sleepSeconds(recoveryPollInterval);
  }

  return false;
}

// ── Step 3: Sandbox ──────────────────────────────────────────────

const { getSandboxRuntimeRegistryFields, hasSandboxGpuDrift, updateReusedSandboxMetadata } =
  sandboxRegistryMetadata.createSandboxRegistryMetadataHelpers({
    isLinuxDockerDriverGatewayEnabled,
    getInstalledOpenshellVersion,
    runCaptureOpenshell,
  });


// ── Step 5: Sandbox ──────────────────────────────────────────────

async function createSandbox(
  gpu: ReturnType<typeof nim.detectGpu>,
  model: string,
  provider: string,
  preferredInferenceApi: string | null = null,
  sandboxNameOverride: string | null = null,
  webSearchConfig: WebSearchConfig | null = null,
  enabledChannels: string[] | null = null,
  fromDockerfile: string | null = null,
  agent: AgentDefinition | null = null,
  controlUiPort: number | null = null,
  sandboxGpuConfig: SandboxGpuConfig | null = null,
  resourceProfile: import("./resources-cmd").ResourceProfile | null = null,
  hermesToolGateways: string[] = [],
) {
  step(6, 8, "Creating sandbox");

  const sandboxName = validateName(
    sandboxNameOverride ?? (await promptValidatedSandboxName(agent)),
    "sandbox name",
  );
  enabledChannels = filterEnabledChannelsByAgent(enabledChannels, agent);
  const effectiveSandboxGpuConfig =
    sandboxGpuConfig ?? resolveSandboxGpuConfig(gpu, { flag: null, device: null });

  // Port priority: --control-ui-port > CHAT_UI_URL env > registry (resume) > agent.forwardPort > default
  // Pre-resolve port availability so CHAT_UI_URL baked into the Dockerfile,
  // the sandbox env, and the readiness probe all use the final forwarded port.
  const persistedPort = registry.getSandbox(sandboxName)?.dashboardPort ?? null;
  // When CHAT_UI_URL is set, extract its port so the allocator and the URL stay in sync.
  let envPort: number | null = null;
  if (process.env.CHAT_UI_URL) {
    try {
      const u = new URL(
        process.env.CHAT_UI_URL.includes("://")
          ? process.env.CHAT_UI_URL
          : `http://${process.env.CHAT_UI_URL}`,
      );
      const p = Number(u.port);
      if (p > 0) envPort = p;
    } catch {
      /* malformed URL — ignore */
    }
  }
  const preferredPort =
    controlUiPort ?? envPort ?? persistedPort ?? (agent ? agent.forwardPort : DASHBOARD_PORT);
  const earlyForwards = runCaptureOpenshell(["forward", "list"], { ignoreError: true });
  const effectivePort = findAvailableDashboardPort(sandboxName, preferredPort, earlyForwards);
  if (effectivePort !== preferredPort) {
    console.warn(`  ! Port ${preferredPort} is taken. Using port ${effectivePort} instead.`);
  }
  // Build chatUiUrl: preserve the hostname from CHAT_UI_URL when set, but
  // always use effectivePort so the Dockerfile, env, and readiness probe agree.
  let chatUiUrl: string;
  if (process.env.CHAT_UI_URL && controlUiPort == null) {
    const parsed = new URL(
      process.env.CHAT_UI_URL.includes("://")
        ? process.env.CHAT_UI_URL
        : `http://${process.env.CHAT_UI_URL}`,
    );
    parsed.port = String(effectivePort);
    chatUiUrl = parsed.toString().replace(/\/$/, "");
  } else {
    chatUiUrl = `http://127.0.0.1:${effectivePort}`;
  }
  const hermesDashboardForwarding = onboardHermesDashboard.createHermesDashboardOnboardForwarding({
    agentName: agent?.name,
    env: process.env,
    ensureForward: ensureAgentFixedForward,
    note,
    runOpenshell,
    getApiForwardPort: () => getDashboardForwardPort(chatUiUrl),
  });
  const hermesDashboardState = hermesDashboardForwarding.resolveStateForPort(effectivePort);

  // Check whether messaging providers will be needed — this must happen before
  // the sandbox reuse decision so we can detect stale sandboxes that were created
  // without provider attachments (security: prevents legacy raw-env-var leaks).

  // The UI toggle list can include channels the user toggled on but then
  // skipped the token prompt for. Only channels with a real token will have a
  // provider attached, so the conflict check must filter out the skipped ones
  // (otherwise we warn about phantom channels that will never poll).
  const conflictCheckChannels = Array.isArray(enabledChannels)
    ? enabledChannels.flatMap((name) => {
        const def = MESSAGING_CHANNELS.find((c) => c.name === name);
        if (!def || !def.envKey || !getValidatedMessagingToken(def, def.envKey)) return [];
        const tokenEnvKeys = getChannelTokenKeys(def);
        const credentialHashes: Record<string, string> = {};
        for (const envKey of tokenEnvKeys) {
          const hash = hashCredential(getValidatedMessagingToken(def, envKey));
          if (hash) credentialHashes[envKey] = hash;
        }
        if (Object.keys(credentialHashes).length === 0) return [];
        return [{ channel: name, credentialHashes }];
      })
    : [];

  // Messaging channels like Telegram (getUpdates), Discord (gateway), and Slack
  // (Socket Mode) enforce one consumer per channel credential. Two sandboxes
  // sharing a credential silently break both bridges (see #1953). Warn before
  // we commit.
  if (conflictCheckChannels.length > 0) {
    const { backfillMessagingChannels, findChannelConflicts } = require("./messaging-conflict");
    backfillMessagingChannels(registry, makeConflictProbe());
    const conflicts = findChannelConflicts(sandboxName, conflictCheckChannels, registry);
    if (conflicts.length > 0) {
      for (const { channel, sandbox, reason } of conflicts) {
        const detail =
          reason === "matching-token"
            ? `uses the same ${channel} credential`
            : `already has ${channel} enabled, but its credential hash is unavailable`;
        console.log(
          `  ⚠ Sandbox '${sandbox}' ${detail}. Shared channel credentials only allow one sandbox to poll/connect — continuing may break both bridges.`,
        );
      }
      if (isNonInteractive()) {
        console.error(
          `  Aborting: resolve the messaging channel conflict above or run \`${cliName()} <sandbox> channels stop <channel>\` / \`${cliName()} <sandbox> channels remove <channel>\` on the other sandbox.`,
        );
        process.exit(1);
      }
      if (!(await promptYesNoOrDefault("  Continue anyway?", null, false))) {
        console.log("  Aborting sandbox creation.");
        process.exit(1);
      }
    }
  }

  // When enabledChannels is provided (from the toggle picker), only include
  // channels the user selected. When null (backward compat), include all.
  const enabledEnvKeys =
    enabledChannels != null
      ? new Set(
          MESSAGING_CHANNELS.filter((c) => enabledChannels.includes(c.name)).flatMap((c) =>
            getChannelTokenKeys(c),
          ),
        )
      : null;

  // Drop channels the operator disabled via `nemoclaw <sandbox> channels stop`.
  // Credentials stay in the keychain; the bridge simply isn't registered with
  // the gateway on the next rebuild. `channels start` removes the entry and
  // the bridge comes back.
  const disabledChannels: string[] = require("./onboard/channel-state").resolveDisabledChannels(
    sandboxName,
  );
  const disabledChannelNames = new Set(disabledChannels);
  const disabledEnvKeys = new Set(
    MESSAGING_CHANNELS.filter((c) => disabledChannelNames.has(c.name)).flatMap((c) =>
      getChannelTokenKeys(c),
    ),
  );

  const messagingTokenDefs: MessagingTokenDef[] = [
    {
      name: `${sandboxName}-discord-bridge`,
      envKey: "DISCORD_BOT_TOKEN",
      token: getValidatedMessagingTokenByEnvKey(MESSAGING_CHANNELS, "DISCORD_BOT_TOKEN"),
    },
    {
      name: `${sandboxName}-slack-bridge`,
      envKey: "SLACK_BOT_TOKEN",
      token: getValidatedMessagingTokenByEnvKey(MESSAGING_CHANNELS, "SLACK_BOT_TOKEN"),
    },
    {
      name: `${sandboxName}-slack-app`,
      envKey: "SLACK_APP_TOKEN",
      token: getValidatedMessagingTokenByEnvKey(MESSAGING_CHANNELS, "SLACK_APP_TOKEN"),
    },
    {
      name: `${sandboxName}-telegram-bridge`,
      envKey: "TELEGRAM_BOT_TOKEN",
      token: getValidatedMessagingTokenByEnvKey(MESSAGING_CHANNELS, "TELEGRAM_BOT_TOKEN"),
    },
    {
      name: `${sandboxName}-wechat-bridge`,
      envKey: "WECHAT_BOT_TOKEN",
      token: getValidatedMessagingTokenByEnvKey(MESSAGING_CHANNELS, "WECHAT_BOT_TOKEN"),
    },
  ]
    .filter(({ envKey }) => !enabledEnvKeys || enabledEnvKeys.has(envKey))
    .filter(({ envKey }) => !disabledEnvKeys.has(envKey));

  const braveWebSearchEnabled = braveProviderProfile.shouldEnableBraveWebSearch(webSearchConfig);
  const braveApiKey = braveWebSearchEnabled ? getCredential(webSearch.BRAVE_API_KEY_ENV) || normalizeCredentialValue(process.env[webSearch.BRAVE_API_KEY_ENV]) : null;
  // Fail before any recreate/delete path runs: otherwise a missing key would
  // destroy the existing sandbox first and only then surface the abort (#3626).
  if (braveWebSearchEnabled && !braveApiKey) {
    console.error("  Brave Search is enabled, but BRAVE_API_KEY is not available in this process.");
    console.error(
      "  Re-run with BRAVE_API_KEY set, or disable Brave Search before recreating the sandbox.",
    );
    process.exit(1);
  }
  if (braveWebSearchEnabled) {
    messagingTokenDefs.push({ name: `${sandboxName}-brave-search`, envKey: webSearch.BRAVE_API_KEY_ENV, token: braveApiKey, providerType: braveProviderProfile.BRAVE_PROVIDER_PROFILE_ID });
  }
  const previousProviderCredentialHashes =
    registry.getSandbox(sandboxName)?.providerCredentialHashes ?? {};
  const hasMessagingTokens = messagingTokenDefs.some(({ token }) => !!token);
  const reusableMessagingProviders: string[] = [];
  const reusableMessagingChannels: string[] = [];
  const reusableMessagingEnvKeys = new Set<string>();
  if (enabledChannels != null) {
    for (const { name, envKey, token } of messagingTokenDefs) {
      if (token) continue;
      const channel =
        envKey === "SLACK_APP_TOKEN" ? "slack" : getMessagingChannelForEnvKey(envKey);
      if (!channel || !enabledChannels.includes(channel)) continue;
      if (!providerExistsInGateway(name)) continue;
      reusableMessagingProviders.push(name);
      reusableMessagingEnvKeys.add(envKey);
      if (!reusableMessagingChannels.includes(channel)) {
        reusableMessagingChannels.push(channel);
      }
    }
  }

  const existingRegistryEntryBeforePrune = registry.getSandbox(sandboxName);

  // Reconcile local registry state with the live OpenShell gateway state.
  const liveExists = pruneStaleSandboxEntry(sandboxName);
  // #4614: capture default AFTER prune so a stale registry row isn't read as a live sandbox.
  const sandboxWasLiveDefault = liveExists && wasSandboxDefault(registry.getDefault(), sandboxName);

  // Declared outside the liveExists block so it is accessible during
  // post-creation restore (the sandbox create path runs after the block).
  let pendingStateRestore: BackupResult | null = null;
  let pendingStateRestoreBackupPath: string | null = null;

  if (!liveExists && existingRegistryEntryBeforePrune && shouldRestoreLatestBackupOnRecreate()) {
    const latestBackup = sandboxState.getLatestBackup(sandboxName);
    if (latestBackup?.backupPath) {
      pendingStateRestoreBackupPath = latestBackup.backupPath;
      note(`  Found pre-upgrade backup for '${sandboxName}'; it will be restored after recreation.`);
    } else {
      note(
        `  No pre-upgrade backup found for '${sandboxName}'. Recreated sandbox will start with fresh state.`,
      );
    }
  }

  if (liveExists) {
    const existingSandboxState = getSandboxReuseState(sandboxName);
    const requestedAgentName = getRequestedSandboxAgentName(agent);
    const agentDrift = getSandboxAgentDrift(sandboxName, requestedAgentName);
    let recreateForAgentDrift = agentDrift.changed && isRecreateSandbox();

    if (agentDrift.changed && !isRecreateSandbox()) {
      console.log(
        `  Sandbox '${sandboxName}' already exists as ${formatSandboxAgentName(agentDrift.existingAgentName)}.`,
      );
      console.log(
        `  ${cliDisplayName()} is onboarding ${formatSandboxAgentName(agentDrift.requestedAgentName)} for this sandbox name.`,
      );
      console.log("  Side-by-side agents are supported, but each sandbox name has one agent type.");
      if (isNonInteractive()) {
        console.error(
          `  Aborting: choose a different name or set NEMOCLAW_RECREATE_SANDBOX=1 to recreate '${sandboxName}'.`,
        );
        console.error(
          `  Example: ${cliName()} onboard --name ${getDefaultSandboxNameForAgent(agent)}`,
        );
        process.exit(1);
      }
      if (
        await promptYesNoOrDefault(
          `  Delete and recreate '${sandboxName}' as ${formatSandboxAgentName(agentDrift.requestedAgentName)}?`,
          null,
          false,
        )
      ) {
        recreateForAgentDrift = true;
      } else {
        console.error("  Aborted. Existing sandbox left unchanged.");
        console.error(
          `  Re-run with a different name, for example: ${cliName()} onboard --name ${getDefaultSandboxNameForAgent(agent)}`,
        );
        process.exit(1);
      }
    }

    // Check whether messaging providers are missing from the gateway. Only
    // force recreation when at least one required provider doesn't exist yet —
    // this avoids destroying sandboxes already created with provider attachments.
    const needsProviderMigration =
      hasMessagingTokens &&
      messagingTokenDefs.some(({ name, token }) => token && !providerExistsInGateway(name));
    const selectionDrift = getSelectionDrift(sandboxName, provider, model, { runOpenshell });
    const confirmedSelectionDrift = selectionDrift.changed && !selectionDrift.unknown;
    const sandboxGpuDrift = hasSandboxGpuDrift(sandboxName, effectiveSandboxGpuConfig);
    const existingSandboxEntry = registry.getSandbox(sandboxName);
    const recordedHermesToolGateways = normalizeHermesToolGatewaySelections(
      existingSandboxEntry?.hermesToolGateways,
    );
    const hermesToolGatewayDrift = !stringSetsEqual(recordedHermesToolGateways, hermesToolGateways);
    const hermesDashboardDrift = onboardHermesDashboard.hasHermesDashboardDrift({
      agentName: agent?.name,
      existing: existingSandboxEntry,
      state: hermesDashboardState,
    });

    // Detect whether any messaging credential has been rotated since the
    // sandbox was created. Provider credentials are resolved once at sandbox
    // startup, so a rotated token requires a rebuild to take effect.
    const credentialRotation = hasMessagingTokens
      ? detectMessagingCredentialRotation(sandboxName, messagingTokenDefs)
      : { changed: false, changedProviders: [] };

    if (
      !isRecreateSandbox() &&
      !recreateForAgentDrift &&
      !needsProviderMigration &&
      !sandboxGpuDrift &&
      !credentialRotation.changed &&
      !hermesToolGatewayDrift &&
      !hermesDashboardDrift
    ) {
      // Guard against reusing a CPU-only sandbox when GPU passthrough is enabled.
      // Placed before the non-interactive / interactive split so all reuse
      // paths are covered (interactive prompt, non-interactive ready, unknown drift).
      // Note: legacy registries had gpuEnabled always true (bug fixed in this PR),
      // so gpuEnabled=true on a legacy entry doesn't guarantee GPU support.
      // The gateway Docker-inspect check (above) catches legacy CPU-only gateways
      // before we reach this point, so a legacy sandbox behind a verified GPU
      // gateway is safe to reuse — the sandbox will be recreated if needed.
      if (effectiveSandboxGpuConfig.sandboxGpuEnabled) {
        const entry = registry.getSandbox(sandboxName);
        if (entry && !entry.gpuEnabled) {
          console.error(`  Sandbox '${sandboxName}' exists but was created without GPU passthrough.`);
          console.error(
            "  Pass --recreate-sandbox to recreate with GPU, or destroy and re-onboard:",
          );
          console.error(`    nemoclaw onboard --recreate-sandbox`);
          process.exit(1);
        }
      }

      if (isNonInteractive()) {
        if (existingSandboxState === "ready") {
          if (confirmedSelectionDrift) {
            note("  [non-interactive] Recreating sandbox due to provider/model drift.");
          } else {
            policyPresetCarry.seedReusedSandboxPolicyPresets(sandboxName, isNonInteractive());
            // Upsert messaging providers even on reuse so credential changes take
            // effect without requiring a full sandbox recreation.
            upsertMessagingProviders(messagingTokenDefs);
            if (selectionDrift.unknown) {
              note(
                "  [non-interactive] Existing provider/model selection is unreadable; reusing sandbox.",
              );
              note(
                "  [non-interactive] Set NEMOCLAW_RECREATE_SANDBOX=1 (or --recreate-sandbox) to force recreation.",
              );
            } else {
              note(`  [non-interactive] Sandbox '${sandboxName}' exists and is ready — reusing it`);
              note(
                "  Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1 to force recreation.",
              );
            }
            const reusedPort = ensureDashboardForward(sandboxName, chatUiUrl);
            chatUiUrl = `http://127.0.0.1:${reusedPort}`;
            process.env.CHAT_UI_URL = chatUiUrl;
            const reusedHermesDashboardState =
              hermesDashboardForwarding.resolveStateForPort(reusedPort);
            hermesDashboardForwarding.ensureForState(reusedHermesDashboardState, sandboxName);
            updateReusedSandboxMetadata(
              sandboxName,
              agent,
              model,
              provider,
              reusedPort,
              !selectionDrift.unknown,
              effectiveSandboxGpuConfig,
            );
            registry.updateSandbox(sandboxName, {
              ...onboardHermesDashboard.getHermesDashboardRegistryFields(reusedHermesDashboardState),
              gatewayName: GATEWAY_NAME,
              gatewayPort: GATEWAY_PORT,
            });
            return sandboxName;
          }
        } else {
          console.error(`  Sandbox '${sandboxName}' already exists but is not ready.`);
          console.error(
            "  Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1 to overwrite.",
          );
          process.exit(1);
        }
      } else if (existingSandboxState === "ready") {
        if (confirmedSelectionDrift) {
          const confirmed = await confirmRecreateForSelectionDrift(
            sandboxName,
            selectionDrift,
            provider,
            model,
          );
          if (!confirmed) {
            console.error("  Aborted. Existing sandbox left unchanged.");
            process.exit(1);
          }
        } else {
          console.log(`  Sandbox '${sandboxName}' already exists.`);
          console.log("  Choosing 'n' will delete the existing sandbox and create a new one.");
          if (await promptYesNoOrDefault("  Reuse existing sandbox?", null, true)) {
            policyPresetCarry.seedReusedSandboxPolicyPresets(sandboxName, isNonInteractive());
            upsertMessagingProviders(messagingTokenDefs);
            const reusedPort2 = ensureDashboardForward(sandboxName, chatUiUrl);
            chatUiUrl = `http://127.0.0.1:${reusedPort2}`;
            process.env.CHAT_UI_URL = chatUiUrl;
            const reusedHermesDashboardState2 =
              hermesDashboardForwarding.resolveStateForPort(reusedPort2);
            hermesDashboardForwarding.ensureForState(reusedHermesDashboardState2, sandboxName);
            updateReusedSandboxMetadata(
              sandboxName,
              agent,
              model,
              provider,
              reusedPort2,
              !selectionDrift.unknown,
              effectiveSandboxGpuConfig,
            );
            registry.updateSandbox(sandboxName, {
              ...onboardHermesDashboard.getHermesDashboardRegistryFields(reusedHermesDashboardState2),
              gatewayName: GATEWAY_NAME,
              gatewayPort: GATEWAY_PORT,
            });
            return sandboxName;
          }
        }
      } else {
        console.log(`  Sandbox '${sandboxName}' exists but is not ready.`);
        console.log("  Selecting 'n' will abort onboarding.");
        if (!(await promptYesNoOrDefault("  Delete it and create a new one?", null, true))) {
          console.log("  Aborting onboarding.");
          process.exit(1);
        }
      }
    }

    if (credentialRotation.changed && existingSandboxState === "ready") {
      const rotatedNames = credentialRotation.changedProviders.join(", ");
      console.log(`  Messaging credential(s) rotated: ${rotatedNames}`);
      console.log("  Rebuilding sandbox to propagate new credentials to the L7 proxy...");
      if (!shouldSkipPreRecreateBackup(process.env)) {
        const result = backupSandboxBeforeRecreate({ sandboxName });
        if (!result.ok) {
          console.error(
            "  Set NEMOCLAW_RECREATE_WITHOUT_BACKUP=1 to recreate without preserving state.",
          );
          process.exit(1);
        }
        pendingStateRestore = result.backup;
      }
    }

    if (recreateForAgentDrift) {
      note(
        `  Sandbox '${sandboxName}' exists as ${formatSandboxAgentName(agentDrift.existingAgentName)} — recreating as ${formatSandboxAgentName(agentDrift.requestedAgentName)}.`,
      );
    } else if (needsProviderMigration) {
      console.log(`  Sandbox '${sandboxName}' exists but messaging providers are not attached.`);
      console.log("  Recreating to ensure credentials flow through the provider pipeline.");
    } else if (confirmedSelectionDrift) {
      note(`  Sandbox '${sandboxName}' exists — recreating to apply model/provider change.`);
    } else if (sandboxGpuDrift) {
      note(`  Sandbox '${sandboxName}' exists — recreating to apply sandbox GPU settings.`);
    } else if (hermesToolGatewayDrift) {
      note(`  Sandbox '${sandboxName}' exists — recreating to apply Hermes managed-tool changes.`);
    } else if (hermesDashboardDrift) {
      note(`  Sandbox '${sandboxName}' exists — recreating to apply Hermes dashboard settings.`);
    } else if (credentialRotation.changed) {
      // Message already printed above during backup.
    } else if (existingSandboxState === "ready") {
      note(`  Sandbox '${sandboxName}' exists and is ready — recreating by explicit request.`);
    } else {
      note(`  Sandbox '${sandboxName}' exists but is not ready — recreating it.`);
    }

    const previousEntry: SandboxEntry | null = registry.getSandbox(sandboxName);
    policyPresetCarry.applyRecreatePolicyCarryForward(sandboxName, isNonInteractive(), note);

    if (pendingStateRestore === null && !shouldSkipPreRecreateBackup(process.env)) {
      note("  Backing up workspace state before recreating sandbox...");
      const result = backupSandboxBeforeRecreate({ sandboxName });
      if (!result.ok) {
        console.error("  Set NEMOCLAW_RECREATE_WITHOUT_BACKUP=1 to recreate without preserving state.");
        process.exit(1);
      }
      pendingStateRestore = result.backup;
    }

    note(`  Deleting and recreating sandbox '${sandboxName}'...`);

    runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
    if (previousEntry?.imageTag) {
      const rmiResult = dockerRmi(previousEntry.imageTag, {
        ignoreError: true,
        suppressOutput: true,
      });
      if (rmiResult.status !== 0) {
        console.warn(`  Warning: failed to remove old sandbox image '${previousEntry.imageTag}'.`);
      }
    }
    registry.removeSandbox(sandboxName);
  }

  // Stage build context — use the custom Dockerfile path when provided,
  // otherwise use the optimised default that only sends what the build needs.
  // The build context contains source code, scripts, and potentially API keys
  // in env args, so it must not persist in /tmp after a failed sandbox create.
  // run() calls process.exit() on failure (bypassing normal control flow), so
  // we register a process 'exit' handler to guarantee cleanup in all cases.
  let buildCtx: string, stagedDockerfile: string;
  if (fromDockerfile) {
    const fromResolved = path.resolve(fromDockerfile);
    if (!fs.existsSync(fromResolved)) {
      console.error(`  Custom Dockerfile not found: ${fromResolved}`);
      process.exit(1);
    }
    if (!fs.statSync(fromResolved).isFile()) {
      console.error(`  Custom Dockerfile path is not a file: ${fromResolved}`);
      process.exit(1);
    }
    const buildContextDir = path.dirname(fromResolved);
    if (isInsideIgnoredCustomBuildContextPath(buildContextDir)) {
      console.error(
        `  Custom Dockerfile is inside an ignored build-context path: ${buildContextDir}`,
      );
      console.error("  Move your Dockerfile to a dedicated directory and retry.");
      process.exit(1);
    }
    console.log(`  Using custom Dockerfile: ${fromResolved}`);
    console.log(`  Docker build context: ${buildContextDir}`);
    const buildContextStats = collectBuildContextStats(
      buildContextDir,
      shouldIncludeCustomBuildContextPath,
    );
    if (buildContextStats.totalBytes > CUSTOM_BUILD_CONTEXT_WARN_BYTES) {
      const sizeMb = (buildContextStats.totalBytes / 1_000_000).toFixed(1);
      console.warn(
        `  WARN: build context contains about ${sizeMb} MB across ${buildContextStats.fileCount} files.`,
      );
      console.warn(
        "  The --from flag sends the Dockerfile's parent directory to Docker; use a dedicated directory if this is not intentional.",
      );
    }
    buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-"));
    stagedDockerfile = path.join(buildCtx, "Dockerfile");
    const cleanupCustomBuildCtx = (): void => {
      try {
        fs.rmSync(buildCtx, { recursive: true, force: true });
      } catch {
        // Best effort cleanup; the original error is more useful to the caller.
      }
    };
    // Copy the entire parent directory as build context.
    try {
      fs.cpSync(buildContextDir, buildCtx, {
        recursive: true,
        filter: shouldIncludeCustomBuildContextPath,
      });
      // If the caller pointed at a file not named "Dockerfile", copy it to the
      // location openshell expects (buildCtx/Dockerfile).
      if (path.basename(fromResolved) !== "Dockerfile") {
        fs.copyFileSync(fromResolved, stagedDockerfile);
      }
    } catch (err) {
      cleanupCustomBuildCtx();
      const errorObject = typeof err === "object" && err !== null ? err : null;
      if (isErrnoException(errorObject) && errorObject.code === "EACCES") {
        console.error(`  Permission denied while copying build context from: ${buildContextDir}`);
        console.error(
          "  The --from flag uses the Dockerfile's parent directory as the Docker build context.",
        );
        console.error("  Move your Dockerfile to a dedicated directory and retry.");
        process.exit(1);
      }
      throw err;
    }
  } else if (agent) {
    const agentBuild = agentOnboard.createAgentSandbox(agent);
    buildCtx = agentBuild.buildCtx;
    stagedDockerfile = agentBuild.stagedDockerfile;
  } else {
    ({ buildCtx, stagedDockerfile } = stageOptimizedSandboxBuildContext(ROOT));
  }
  // Returns true if the build context was fully removed, false otherwise.
  // The caller uses this to decide whether the process 'exit' safety net
  // can be deregistered — if inline cleanup fails, we leave the handler
  // armed so the temp dir is still removed on process exit.
  const cleanupBuildCtx = (): boolean => {
    try {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  };
  process.on("exit", cleanupBuildCtx);

  const defaultPolicyPath = path.join(
    ROOT,
    "nemoclaw-blueprint",
    "policies",
    "openclaw-sandbox.yaml",
  );
  const basePolicyPath = (agent && agentOnboard.getAgentPolicyPath(agent)) || defaultPolicyPath;
  const tokensByEnvKey = Object.fromEntries(
    messagingTokenDefs.map(({ envKey, token }) => [envKey, token]),
  );
  const qrSelectedChannels = resolveQrSelectedChannels(
    MESSAGING_CHANNELS,
    enabledChannels,
    disabledChannelNames,
  );
  const activeMessagingChannels = [
    ...new Set([
      ...messagingTokenDefs
        .filter(({ token }) => !!token)
        .flatMap(({ envKey }) => {
          const channel = getMessagingChannelForEnvKey(envKey);
          if (channel) return [channel];
          // SLACK_APP_TOKEN alone does not enable slack; bot token is required.
          if (envKey === "SLACK_APP_TOKEN") {
            return tokensByEnvKey["SLACK_BOT_TOKEN"] ? ["slack"] : [];
          }
          return [];
        }),
      ...reusableMessagingChannels,
      ...qrSelectedChannels,
    ]),
  ];
  const { useDockerGpuPatch, logMessage: sandboxGpuLogMessage } =
    dockerGpuSandboxCreate.resolveDockerGpuSandboxCreatePlan(effectiveSandboxGpuConfig, {
      dockerDriverGateway: isLinuxDockerDriverGatewayEnabled(),
    });
  const initialSandboxPolicy = prepareInitialSandboxCreatePolicy(
    basePolicyPath,
    activeMessagingChannels,
    {
      directGpu: effectiveSandboxGpuConfig.sandboxGpuEnabled,
      dockerGpuPatch: useDockerGpuPatch,
      additionalPresets: hermesToolGateways,
    },
  );
  if (initialSandboxPolicy.cleanup) {
    process.on("exit", initialSandboxPolicy.cleanup);
  }
  if (initialSandboxPolicy.appliedPresets.length > 0) {
    console.log(
      `  Including policy preset(s) at sandbox boot: ${initialSandboxPolicy.appliedPresets.join(", ")}`,
    );
  }
  if (sandboxGpuLogMessage) console.log(sandboxGpuLogMessage);
  const createArgs = [
    "--from",
    `${buildCtx}/Dockerfile`,
    "--name",
    sandboxName,
    "--policy",
    initialSandboxPolicy.policyPath,
    ...buildSandboxGpuCreateArgs(effectiveSandboxGpuConfig, {
      suppressGpuFlag: useDockerGpuPatch,
    }),
  ];

  appendResourceFlagsForProfile(createArgs, resourceProfile, getOpenshellBinary(), { isNonInteractive, note, prompt, promptOrDefault });
  // The recreate path above just deleted the previous sandbox, so any
  // attached providers are detached and safe to delete+create. That's
  // required for the legacy Brave generic→brave type migration since
  // `openshell provider update` cannot change `--type` (#3626).
  const messagingProviders = [
    ...new Set([
      ...upsertMessagingProviders(messagingTokenDefs, { replaceExisting: true }),
      ...reusableMessagingProviders,
    ]),
  ];
  for (const p of messagingProviders) {
    createArgs.push("--provider", p);
  }
  if (hermesToolGateways.length > 0) {
    const hermesToolGateway = getHermesToolGatewayBroker();
    createArgs.push("--provider", hermesToolGateway.getHermesToolGatewayProviderName(sandboxName));
  }

  console.log(`  Creating sandbox '${sandboxName}' (this takes a few minutes on first run)...`);
  const messagingChannelConfig = readMessagingChannelConfigFromEnv();
  const enabledTokenEnvKeys = new Set(messagingTokenDefs.map(({ envKey }) => envKey));
  const activeChannelNames = new Set(activeMessagingChannels);
  const { messagingAllowedIds, discordGuilds, slackConfig } = collectMessagingBuildConfig({
    channels: MESSAGING_CHANNELS,
    activeChannelNames,
    enabledTokenEnvKeys,
    discordSnowflakeRe: onboardProviders.DISCORD_SNOWFLAKE_RE,
  });
  // Telegram mention-only mode — parity with Discord's requireMention.
  // Off by default so existing sandboxes behave the same; opt-in via
  // TELEGRAM_REQUIRE_MENTION=1 or the interactive prompt. See #1737.
  const telegramConfig: { requireMention?: boolean } = {};
  if (enabledTokenEnvKeys.has("TELEGRAM_BOT_TOKEN")) {
    const telegramRequireMention = computeTelegramRequireMention();
    if (telegramRequireMention !== null) {
      telegramConfig.requireMention = telegramRequireMention;
    }
  }
  const wechatConfig = gatherWechatConfig(onboardSession.loadSession());
  // Persist the effective Telegram config into the session so a later resume
  // can detect drift (TELEGRAM_REQUIRE_MENTION changed since last build) and
  // force a sandbox recreate — otherwise the old groupPolicy would stay baked
  // in. Mirrors the pattern used for webSearchConfig. See CodeRabbit on #2417.
  onboardSession.updateSession((current) => {
    current.telegramConfig =
      typeof telegramConfig.requireMention === "boolean"
        ? { requireMention: telegramConfig.requireMention as boolean }
        : null;
    current.wechatConfig = toSessionWechatConfig(wechatConfig);
    current.messagingChannelConfig = messagingChannelConfig;
    return current;
  });
  // Pull the base image and resolve its digest so the Dockerfile is pinned to
  // exactly what we just fetched. This prevents stale :latest tags from
  // silently reusing a cached old image after NemoClaw upgrades (#1904).
  const resolved = agent && !fromDockerfile ? null : pullAndResolveBaseImageDigest({
    requireOpenshellSandboxAbi: isLinuxDockerDriverGatewayEnabled(),
  });
  if (resolved?.digest) {
    console.log(`  Pinning base image to ${resolved.digest.slice(0, 19)}...`);
  } else if (resolved) {
    console.log(`  Using sandbox base image ${resolved.ref}`);
  } else if (!(agent && !fromDockerfile)) {
    // Check if the image exists locally before falling back to unpinned :latest.
    // On a first-time install behind a firewall with no cached image, warn early
    // so the user knows the build will likely fail.
    const localCheck = dockerImageInspect(`${SANDBOX_BASE_IMAGE}:${SANDBOX_BASE_TAG}`, {
      ignoreError: true,
      suppressOutput: true,
    });
    if (localCheck.status === 0) {
      console.warn("  Warning: could not pull base image from registry; using cached :latest.");
    } else {
      console.warn(
        `  Warning: base image ${SANDBOX_BASE_IMAGE}:${SANDBOX_BASE_TAG} is not available locally.`,
      );
      console.warn("  The build will fail unless Docker can pull the image during build.");
      console.warn("  If offline, pull the image manually first:");
      console.warn(`    docker pull ${SANDBOX_BASE_IMAGE}:${SANDBOX_BASE_TAG}`);
    }
  }
  const buildId = String(Date.now());
  const sandboxInferenceBaseUrlOverride =
    dockerGpuLocalInference.dockerGpuPatchHostNetworkInferenceBaseUrl(
      effectiveSandboxGpuConfig,
      provider,
      { dockerDriverGateway: isLinuxDockerDriverGatewayEnabled(), log: console.log },
    );
  let hermesToolBrokerToken: string | null = null;
  if (hermesToolGateways.length > 0) {
    hermesToolBrokerToken = getHermesToolGatewayBroker().getHermesToolGatewayBrokerToken(sandboxName);
    if (!hermesToolBrokerToken) {
      console.error("  Hermes managed tools were selected, but no broker token was prepared.");
      console.error("  Re-run OAuth setup with managed tools enabled and retry onboarding.");
      process.exit(1);
    }
  }
  patchStagedDockerfile(
    stagedDockerfile,
    model,
    chatUiUrl,
    buildId,
    provider,
    preferredInferenceApi,
    webSearchConfig,
    activeMessagingChannels,
    messagingAllowedIds,
    discordGuilds,
    resolved ? resolved.ref : null,
    telegramConfig,
    wechatConfig as Record<string, unknown>,
    // Docker-on-Colima uses normal container ownership; keep the old VM chmod
    // compatibility path disabled unless a future VM-specific flow opts in.
    false,
    sandboxInferenceBaseUrlOverride,
    hermesToolGateways,
    slackConfig,
  );
  // Only pass non-sensitive env vars to the sandbox. Credentials flow through
  // OpenShell providers — the gateway injects them as placeholders and the L7
  // proxy rewrites Authorization headers with real secrets at egress.
  // See: crates/openshell-sandbox/src/secrets.rs (placeholder rewriting),
  //      crates/openshell-router/src/backend.rs (inference auth injection).
  //
  // Use the shared allowlist (subprocess-env.ts) instead of the old
  // blocklist. The blocklist only blocked 12 specific credential names
  // and passed EVERYTHING else — including GITHUB_TOKEN,
  // AWS_SECRET_ACCESS_KEY, SSH_AUTH_SOCK, KUBECONFIG, NPM_TOKEN, and
  // any CI/CD secrets that happened to be in the host environment.
  // The allowlist inverts the default: only known-safe env vars are forwarded.
  // For sandbox create, also strip KUBECONFIG and SSH_AUTH_SOCK: the generic
  // allowlist needs them for host-side subprocesses, but sandbox code must not
  // access host Kubernetes or SSH-agent credentials.
  const envArgs = [formatEnvAssignment("CHAT_UI_URL", chatUiUrl)];
  // Always pass the effective dashboard port into the sandbox so
  // nemoclaw-start.sh starts the gateway on the correct port. When the
  // user sets CHAT_UI_URL with a custom port (e.g. :18790), the port
  // must reach the container — otherwise _DASHBOARD_PORT defaults to
  // 18789 and the gateway listens on the wrong port. (#2267, #1925)
  const effectiveDashboardPort = getDashboardForwardPort(chatUiUrl);
  envArgs.push(formatEnvAssignment("NEMOCLAW_DASHBOARD_PORT", effectiveDashboardPort));
  require("./onboard/openclaw-runtime-env").appendOpenClawRuntimeEnvArgs(envArgs, agent);
  onboardHermesDashboard.appendHermesDashboardEnvArgs(envArgs, hermesDashboardState, formatEnvAssignment);
  require("./onboard/host-proxy-env").appendHostProxyEnvArgs(envArgs);
  // Propagate NEMOCLAW_PROXY_HOST / NEMOCLAW_PROXY_PORT to the runtime
  // sandbox container. patchStagedDockerfile() already substitutes them
  // into the build-time Dockerfile ARG/ENV, but `openshell sandbox create
  // -- env … nemoclaw-start` only forwards the explicitly listed env vars
  // — image-baked ENV does not propagate into the running pod. Without
  // this, nemoclaw-start.sh:898 falls back to the default 10.200.0.1:3128
  // and `HTTPS_PROXY` inside the sandbox ignores the host override. The
  // build-time substitution and runtime env stay in sync as a result.
  // Fixes #2424. Uses the shared isValidProxyHost / isValidProxyPort
  // helpers so build-time and runtime validation stay aligned.
  const sandboxProxyHost = process.env.NEMOCLAW_PROXY_HOST;
  if (sandboxProxyHost && isValidProxyHost(sandboxProxyHost)) {
    envArgs.push(formatEnvAssignment("NEMOCLAW_PROXY_HOST", sandboxProxyHost));
  }
  const sandboxProxyPort = process.env.NEMOCLAW_PROXY_PORT;
  if (sandboxProxyPort && isValidProxyPort(sandboxProxyPort)) {
    envArgs.push(formatEnvAssignment("NEMOCLAW_PROXY_PORT", sandboxProxyPort));
  }
  if (hermesToolBrokerToken) {
    // Runtime-only: do not bake the per-sandbox broker token into image layers.
    envArgs.push(formatEnvAssignment("TOOL_GATEWAY_USER_TOKEN", hermesToolBrokerToken));
  }
  const sandboxReadyTimeoutSecs = getSandboxReadyTimeoutSecs(effectiveSandboxGpuConfig);
  const sandboxEnv = buildSubprocessEnv();
  // Remove host-infrastructure credentials that the generic allowlist
  // permits for host-side processes but that must not enter the sandbox.
  delete sandboxEnv.KUBECONFIG;
  delete sandboxEnv.SSH_AUTH_SOCK;
  // Run without piping through awk — the pipe masked non-zero exit codes
  // from openshell because bash returns the status of the last pipeline
  // command (awk, always 0) unless pipefail is set. Removing the pipe
  // lets the real exit code flow through to run().
  const sandboxStartupCommand = ["env", ...envArgs, "nemoclaw-start"];
  const createCommand = `${openshellShellCommand([
    "sandbox",
    "create",
    ...createArgs,
    "--",
    ...sandboxStartupCommand,
  ])} 2>&1`;
  const dockerGpuCreatePatch = dockerGpuSandboxCreate.createDockerGpuSandboxCreatePatch({
    enabled: useDockerGpuPatch,
    sandboxName,
    gpuDevice: effectiveSandboxGpuConfig.sandboxGpuDevice,
    openshellSandboxCommand: sandboxStartupCommand,
    timeoutSecs: sandboxReadyTimeoutSecs,
    backend: effectiveSandboxGpuConfig.hostGpuPlatform === "jetson" ? "jetson" : "generic",
    deps: { runOpenshell, runCaptureOpenshell, sleep: sleepSeconds },
  });
  const createResult = await streamSandboxCreate(createCommand, sandboxEnv, {
    readyCheck: () => {
      const list = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
      if (isSandboxReady(list, sandboxName)) return true;
      dockerGpuCreatePatch.maybeApplyDuringCreate();
      return false;
    },
    failureCheck: dockerGpuCreatePatch.createFailureMessage,
    traceEvent: onboardTracing.addTraceEvent,
  });

  if (initialSandboxPolicy.cleanup && initialSandboxPolicy.cleanup()) {
    process.removeListener("exit", initialSandboxPolicy.cleanup);
  }

  // Clean up build context regardless of outcome.
  // Use fs.rmSync instead of run() to avoid spawning a shell process.
  // Only deregister the 'exit' safety net when inline cleanup succeeded;
  // otherwise leave it armed so a later process.exit() still removes the
  // temp dir (which may hold source and env-arg API keys).
  if (cleanupBuildCtx()) {
    process.removeListener("exit", cleanupBuildCtx);
  }

  dockerGpuCreatePatch.exitOnPatchError();

  if (createResult.status !== 0) {
    const failure = classifySandboxCreateFailure(createResult.output);
    if (failure.kind === "sandbox_create_incomplete") {
      // The sandbox was created in the gateway but the create stream exited
      // with a non-zero code (e.g. SSH 255).  Fall through to the ready-wait
      // loop — the sandbox may still reach Ready on its own.
      console.warn("");
      console.warn(
        `  Create stream exited with code ${createResult.status} after sandbox was created.`,
      );
      console.warn("  Checking whether the sandbox reaches Ready state...");
    } else {
      console.error("");
      console.error(`  Sandbox creation failed (exit ${createResult.status}).`);
      if (createResult.output) {
        console.error("");
        console.error(createResult.output);
      }
      console.error("  Try:  openshell sandbox list        # check gateway state");
      printSandboxCreateRecoveryHints(createResult.output);
      process.exit(createResult.status || 1);
    }
  }

  dockerGpuCreatePatch.ensureApplied();
  dockerGpuCreatePatch.waitForSupervisorReconnectIfNeeded();

  // Wait for OpenShell to report the sandbox Ready before registering.
  // On first run the sandbox can take longer to initialize;
  // without this gate, NemoClaw registers a phantom sandbox that
  // causes "sandbox not found" on every subsequent connect/status call.
  console.log("  Waiting for sandbox to become ready...");
  const readiness = sandboxReadinessTracing.waitForCreatedSandboxReadyWithTrace({
    sandboxName,
    timeoutSecs: sandboxReadyTimeoutSecs,
    runCaptureOpenshell,
    isSandboxReady,
    getSandboxFailurePhase: gatewayState.getSandboxFailurePhase,
    sleep: sleepSeconds,
  });

  const restoreBackupPath =
    pendingStateRestore?.manifest?.backupPath ?? pendingStateRestoreBackupPath;

  if (!readiness.ready) {
    const diagnostics = sandboxCreateFailureDiagnostics.collectSandboxCreateFailureDiagnostics(
      sandboxName,
      { backupPath: restoreBackupPath },
    );
    console.error("");
    sandboxReadinessTracing.printReadinessFailure(readiness, sandboxName, sandboxReadyTimeoutSecs);
    if (diagnostics) {
      console.error(`  Diagnostics saved: ${diagnostics.dir}`);
      if (diagnostics.summaryLines.length > 0) {
        console.error("  Recent OpenShell gateway failure:");
        for (const line of diagnostics.summaryLines) {
          console.error(`    ${line}`);
        }
      }
      if (diagnostics.backupPath) {
        console.error(`  State backup retained: ${diagnostics.backupPath}`);
      }
    }
    if (useDockerGpuPatch) {
      dockerGpuCreatePatch.printReadinessFailureIfEnabled();
    } else {
      // Clean up non-GPU failures after preserving local diagnostics so the
      // next onboard retry with the same name does not fail on "sandbox already exists".
      const delResult = runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
      if (delResult.status === 0) {
        console.error("  The failed sandbox has been removed; retry will recreate it.");
      } else {
        console.error("  Could not remove the failed sandbox. Manual cleanup:");
        console.error(`    openshell sandbox delete "${sandboxName}"`);
      }
    }
    console.error(`  Retry: ${cliName()} onboard`);
    process.exit(1);
  }

  // Wait for the branded dashboard to become fully ready (web server live)
  // This prevents port forwards from connecting to a non-existent port
  // or seeing 502/503 errors during initial load.
  // Probes /health endpoint and accepts 200 or 401 (device auth) as "alive".
  // Previously used `curl -sf` which failed on 401, causing false negatives. Fixes #2342.
  console.log("  Waiting for NemoClaw dashboard to become ready...");
  sandboxReadinessTracing.waitForDashboardReadyWithTrace({
    sandboxName,
    port: effectiveDashboardPort,
    runCaptureOpenshell,
    sleep: sleepSeconds,
  });

  if (effectiveSandboxGpuConfig.sandboxGpuEnabled) {
    // Runs the GPU proof, preserving Docker-GPU patch Error-phase diagnostics
    // when applicable, then gates host-network local inference reachability (#4509).
    dockerGpuLocalInference.verifyGpuSandboxAfterReady(effectiveSandboxGpuConfig, provider, {
      sandboxName,
      dockerDriverGateway: isLinuxDockerDriverGatewayEnabled(),
      useDockerGpuPatch,
      verifyDirectSandboxGpu,
      verifyGpuOrExit: dockerGpuCreatePatch.verifyGpuOrExit,
      selectedMode: dockerGpuCreatePatch.selectedMode,
      runCaptureOpenshell,
      log: console.log,
    });
  }

  // Release any stale forward on the dashboard port before claiming it for the new sandbox.
  // A previous onboard run may have left the port forwarded to a different sandbox,
  // which would silently prevent the new sandbox's dashboard from being reachable.
  // Auto-allocates the next free port if the preferred one is taken (Fixes #2174).
  // Roll back the just-created openshell sandbox on unrecoverable allocation
  // failure so the registry and `openshell sandbox list` don't drift (#2174).
  const actualDashboardPort = ensureDashboardForward(sandboxName, chatUiUrl, {
    rollbackSandboxOnFailure: true,
  });
  // Update chatUiUrl and CHAT_UI_URL env so printDashboard / getDashboardAccessInfo
  // see the final port (they re-read process.env.CHAT_UI_URL independently).
  if (actualDashboardPort !== Number(getDashboardForwardPort(chatUiUrl))) {
    chatUiUrl = `http://127.0.0.1:${actualDashboardPort}`;
  }
  process.env.CHAT_UI_URL = chatUiUrl;
  const finalHermesDashboardState =
    hermesDashboardForwarding.resolveStateForPort(actualDashboardPort);
  hermesDashboardForwarding.ensureForState(finalHermesDashboardState, sandboxName, true);

  // Register only after confirmed ready — prevents phantom entries
  const providerCredentialHashes: Record<string, string> = {};
  for (const { envKey, token } of messagingTokenDefs) {
    const hash = token ? hashCredential(token) : null;
    if (hash) {
      providerCredentialHashes[envKey] = hash;
    }
  }
  for (const envKey of reusableMessagingEnvKeys) {
    const previousHash = previousProviderCredentialHashes[envKey];
    if (typeof previousHash === "string" && previousHash) {
      providerCredentialHashes[envKey] = previousHash;
    }
  }
  // openshell tags images with seconds; buildId is ms. Parse actual tag from output. Fixes #2672.
  const resolvedImageTag = resolveSandboxImageTagFromCreateOutput(createResult.output, buildId);

  const sandboxRuntimeFields = getSandboxRuntimeRegistryFields(effectiveSandboxGpuConfig);
  registry.registerSandbox({
    name: sandboxName,
    model: model || null,
    provider: provider || null,
    ...sandboxRuntimeFields,
    ...getSandboxAgentRegistryFields(agent, !fromDockerfile),
    imageTag: resolvedImageTag,
    providerCredentialHashes:
      Object.keys(providerCredentialHashes).length > 0 ? providerCredentialHashes : undefined,
    policies: initialSandboxPolicy.appliedPresets,
    // Persist the operator's configured channel set, not the post-disabled-filter
    // active set. After `channels stop X` + rebuild, activeMessagingChannels drops
    // X, but X is still configured — losing it here means a later `channels start
    // X` has nothing to re-enable (the next rebuild sees an empty channel set and
    // never reattaches the gateway bridge). See #3381.
    messagingChannels:
      enabledChannels != null ? [...new Set(enabledChannels)] : activeMessagingChannels,
    messagingChannelConfig: messagingChannelConfig || undefined,
    disabledChannels: disabledChannels.length > 0 ? [...disabledChannels] : undefined,
    hermesToolGateways: hermesToolGateways.length > 0 ? [...hermesToolGateways] : undefined,
    ...onboardHermesDashboard.getHermesDashboardRegistryFields(finalHermesDashboardState),
    dashboardPort: actualDashboardPort,
    gatewayName: GATEWAY_NAME,
    gatewayPort: GATEWAY_PORT,
  });
  restoreDefaultAfterRecreate(registry.setDefault, sandboxName, sandboxWasLiveDefault); // #4614: default deferred to finalization

  if (restoreBackupPath) {
    note(
      pendingStateRestoreBackupPath
        ? "  Restoring workspace state from pre-upgrade backup..."
        : "  Restoring workspace state from pre-recreate backup...",
    );
    const restore = sandboxState.restoreSandboxState(sandboxName, restoreBackupPath);
    if (restore.success) {
      note(
        `  ✓ State restored (${restore.restoredDirs.length} directories, ${restore.restoredFiles.length} files)`,
      );
    } else {
      console.error(`  Warning: partial restore. Manual recovery: ${restoreBackupPath}`);
    }
  }

  // DNS proxy — run a forwarder in the sandbox pod so the isolated
  // sandbox namespace can resolve hostnames (fixes #626).
  if (sandboxRuntimeFields.openshellDriver === "kubernetes") {
    console.log("  Setting up sandbox DNS proxy...");
    runFile("bash", [path.join(SCRIPTS, "setup-dns-proxy.sh"), GATEWAY_NAME, sandboxName], {
      ignoreError: true,
    });
  }

  require("./onboard/vm-dns-monkeypatch").applyOnboardVmDnsMonkeypatch(sandboxName, sandboxRuntimeFields);

  // Check that messaging providers exist in the gateway (sandbox attachment
  // cannot be verified via CLI yet — only gateway-level existence is checked).
  for (const p of messagingProviders) {
    if (!providerExistsInGateway(p)) {
      console.error(`  ⚠ Messaging provider '${p}' was not found in the gateway.`);
      console.error(`    The credential may not be available inside the sandbox.`);
      console.error(
        `    To fix: openshell provider create --name ${p} --type generic --credential <KEY>`,
      );
    }
  }

  console.log(`  ✓ Sandbox '${sandboxName}' created`);

  warnIfLandlockUnsupported({ dockerInfoFormat, runCapture });

  // #4614: arm rollback only when the sandbox was not live before (never a recreate/rebuild).
  if (!liveExists) sandboxCancelRollback.arm(sandboxName);
  return sandboxName;
}

// ── Step 3: Inference selection ──────────────────────────────────

type ProviderChoice = { key: string; label: string };

const { readLiveInference, readRecordedProvider, readRecordedNimContainer, readRecordedModel } =
  providerRecovery.createProviderRecoveryHelpers({
    parseGatewayInference,
    runCaptureOpenshell,
  });

type OllamaModelSelectionOutcome =
  | { outcome: "selected"; model: string; allowToolsIncompatible: boolean }
  | { outcome: "back-to-selection" };
// Pick an Ollama model, pull it if missing, and validate it via the local
// proxy. Shared by the three Ollama provider branches (running, Windows-host
// install/start, install-locally). Returns "back-to-selection" so the caller
// can `continue` its labelled outer selectionLoop.
async function selectAndValidateOllamaModel(
  gpu: ReturnType<typeof nim.detectGpu>,
  provider: string,
  defaults: { requestedModel: string | null; recoveredModel: string | null },
): Promise<OllamaModelSelectionOutcome> {
  const { requestedModel, recoveredModel } = defaults;
  while (true) {
    const installedModels = getOllamaModelOptions();
    let model: string | typeof BACK_TO_SELECTION;
    if (isNonInteractive()) {
      model = localInference.resolveNonInteractiveOllamaModel(requestedModel, recoveredModel, gpu);
    } else {
      model = await promptOllamaModel(gpu);
    }
    if (isBackToSelection(model)) {
      console.log("  Returning to provider selection.");
      console.log("");
      return { outcome: "back-to-selection" };
    }
    const selectedModel = requireValue(model, "Expected an Ollama model selection");
    if (!installedModels.includes(selectedModel)) {
      const lookup = ollamaModelSize.getOllamaModelSize(selectedModel);
      const sizeLabel = ollamaModelSize.formatModelSize(lookup);
      if (isAutoYes()) {
        note(`  Pulling Ollama model '${selectedModel}' (${sizeLabel}).`);
      } else if (isNonInteractive()) {
        console.error(
          `  Ollama model '${selectedModel}' (${sizeLabel}) is not installed and ` +
            "non-interactive mode cannot prompt for confirmation. " +
            "Re-run with --yes / -y (or NEMOCLAW_YES=1) to authorise the download.",
        );
        process.exit(1);
      } else {
        const proceed = await promptYesNoOrDefault(
          `  Download Ollama model '${selectedModel}' (${sizeLabel})?`,
          null,
          false,
        );
        if (!proceed) {
          console.error(
            `  Skipped pulling Ollama model '${selectedModel}'. Choose another model or re-run with --yes to confirm.`,
          );
          console.log("  Choose a different Ollama model or select Other.");
          console.log("");
          continue;
        }
      }
    }
    const probe = await prepareOllamaModel(selectedModel, installedModels);
    if (!probe.ok) {
      const action = handleOllamaProbeFailure(probe, selectedModel, isNonInteractive);
      if (action === "back-to-selection") return { outcome: "back-to-selection" };
      continue;
    }
    const allowToolsIncompatible = probe.allowToolsIncompatible === true;
    const validationBaseUrl = getLocalProviderValidationBaseUrl(provider);
    if (!validationBaseUrl)
      abortNonInteractive("Local Ollama validation URL could not be determined.");
    const validation = await validateOpenAiLikeSelection(
      "Local Ollama",
      validationBaseUrl!,
      selectedModel,
      null,
      "Choose a different Ollama model or select Other.",
      null,
      localInference.buildOllamaProbeOptions(allowToolsIncompatible),
    );
    if (validation.retry === "selection") return { outcome: "back-to-selection" };
    if (!validation.ok) {
      if (isNonInteractive()) abortNonInteractive(`model '${selectedModel}' failed validation.`);
      continue;
    }
    // Ollama's /v1/responses endpoint does not produce correctly formatted
    // tool calls — force chat completions like vLLM/NIM.
    if (validation.api !== "openai-completions") {
      console.log(
        "  ℹ Using chat completions API (Ollama tool calls require /v1/chat/completions)",
      );
    }
    localInference.applyOllamaRuntimeContextWindow(selectedModel);
    return { outcome: "selected", model: selectedModel, allowToolsIncompatible };
  }
}

async function setupNim(
  gpu: ReturnType<typeof nim.detectGpu>,
  sandboxName: string | null = null,
  agent: AgentDefinition | null = null,
): Promise<{
  model: string | null;
  provider: string;
  endpointUrl: string | null;
  credentialEnv: string | null;
  hermesAuthMethod: HermesAuthMethod | null;
  hermesToolGateways: string[];
  preferredInferenceApi: string | null;
  nimContainer: string | null;
  allowToolsIncompatible: boolean;
}> {
  step(3, 8, "Configuring inference provider");

  let model: string | typeof BACK_TO_SELECTION | null = null;
  let provider: string = REMOTE_PROVIDER_CONFIG.build.providerName;
  let nimContainer: string | null = null;
  let endpointUrl: string | null = REMOTE_PROVIDER_CONFIG.build.endpointUrl;
  let credentialEnv: string | null = REMOTE_PROVIDER_CONFIG.build.credentialEnv;
  let hermesAuthMethod: HermesAuthMethod | null = null;
  let hermesToolGateways: string[] = [];
  let preferredInferenceApi: string | null = null;
  let allowToolsIncompatible = false;

  // Detect local inference options. Bound curl with --connect-timeout/--max-time
  // so a half-open port or stalled listener cannot hang the onboard at step 3
  // (#2674).
  const localProbeCurlArgs = ["--connect-timeout", "2", "--max-time", "5"] as const;
  const hasOllama = hostCommandExists("ollama");
  const ollamaHost = findReachableOllamaHost();
  const ollamaRunning = ollamaHost !== null;
  const isWindowsHostOllama = ollamaHost === OLLAMA_HOST_DOCKER_INTERNAL;
  const vllmRunning = !!runCapture(
    ["curl", "-sf", ...localProbeCurlArgs, `http://127.0.0.1:${VLLM_PORT}/v1/models`],
    { ignoreError: true },
  );
  // Pick a vLLM install recipe for this host. Profiles live in inference/vllm.ts;
  // null means "no supported platform" (vLLM stays behind EXPERIMENTAL).
  const vllmProfile = detectVllmProfile(gpu);
  // If the profile's image is already cached, the install path is really a
  // "start" — docker pull is a no-op and the container can come up in seconds.
  const hasVllmImage = !!(
    vllmProfile &&
    docker.dockerCapture(["images", "-q", vllmProfile.image], { ignoreError: true }).trim()
  );
  const windowsHostOllamaDockerRequirement = getWindowsHostOllamaDockerRequirement(
    isWsl() ? getContainerRuntime() : null,
  );
  // Probed even when WSL has its own Ollama: users may prefer the Windows
  // instance for GPU access and a unified model cache. See
  // src/lib/onboard/windows-host-ollama.ts for process/path fallback details.
  const winOllamaState = detectWindowsHostOllama();
  const hasWindowsOllama = winOllamaState.installed;
  const winOllamaInstalledPath = winOllamaState.installedPath;
  const winOllamaLoopbackOnly = winOllamaState.loopbackOnly;

  // Independent of findReachableOllamaHost: when WSL Ollama wins the cache
  // on 127.0.0.1, Windows-host may also be running on 0.0.0.0 and we want
  // to offer a "switch" without restarting anything.
  let windowsOllamaReachable = false;
  if (isWsl() && !isWindowsHostOllama) {
    windowsOllamaReachable = !!runCapture(
      ["curl", "-sf", ...localProbeCurlArgs, `http://host.docker.internal:${OLLAMA_PORT}/api/tags`],
      { ignoreError: true },
    );
  }

  // Mirrored mode shares loopback so both probes hit the same instance;
  // only NAT mode actually has two separate daemons to warn about.
  if (isWsl() && ollamaHost === "127.0.0.1" && windowsOllamaReachable) {
    const networkingMode = runCapture(["wslinfo", "--networking-mode"], {
      ignoreError: true,
    }).trim();
    if (networkingMode !== "mirrored") {
      console.log("");
      console.log("  ⚠ Ollama is running on both WSL and the Windows host.");
      console.log("    Stop one to avoid duplicated GPU memory and model caches.");
      console.log("");
    }
  }
  const requestedProvider = getNonInteractiveProvider();
  const requestedModel = isNonInteractive()
    ? getNonInteractiveModel(requestedProvider || "build")
    : null;
  const agentProviderOptions = getAgentInferenceProviderOptions(agent);
  const hermesProviderAvailable = agentProviderOptions.includes("hermesProvider");
  const options: Array<{ key: string; label: string }> = [];
  options.push({ key: "build", label: "NVIDIA Endpoints" });
  options.push({ key: "openai", label: "OpenAI" });
  options.push({ key: "custom", label: "Other OpenAI-compatible endpoint" });
  options.push({ key: "anthropic", label: "Anthropic" });
  options.push({ key: "anthropicCompatible", label: "Other Anthropic-compatible endpoint" });
  options.push({ key: "gemini", label: "Google Gemini" });
  const runningOllamaMenu = resolveRunningOllamaMenuEntry({
    hasOllama,
    ollamaRunning,
    ollamaHost,
    isWsl: isWsl(),
    ollamaPort: OLLAMA_PORT,
    windowsHostLabelSuffix: windowsHostOllamaDockerRequirement.supported
      ? ""
      : windowsHostOllamaDockerRequirement.labelSuffix,
  });
  if (runningOllamaMenu) options.push(runningOllamaMenu);
  if (EXPERIMENTAL && gpu && gpu.nimCapable) {
    options.push({ key: "nim-local", label: "Local NVIDIA NIM [experimental]" });
  }
  options.push(
    ...buildVllmMenuEntries({
      vllmRunning,
      vllmProfile,
      experimental: EXPERIMENTAL,
      platform: gpu?.platform,
      hasVllmImage,
    }),
  );
  // Skipped when Windows-host already won the cache: the running entry
  // above already covers that case.
  if (hasWindowsOllama && !isWindowsHostOllama) {
    options.push({
      key: "start-windows-ollama",
      label: windowsHostOllamaDockerRequirement.startLabel({
        reachable: windowsOllamaReachable,
        loopbackOnly: winOllamaLoopbackOnly,
      }),
    });
  }
  // On WSL, always offer to install Ollama on the Windows host when not
  // already installed, regardless of WSL Ollama state — users may prefer the
  // Windows-host instance (GPU access) even with WSL Ollama running.
  if (isWsl() && !hasWindowsOllama) {
    options.push({
      key: "install-windows-ollama",
      label: windowsHostOllamaDockerRequirement.installLabel,
    });
  }
  const ollamaInstallMenu = resolveOllamaInstallMenuEntry({
    hasOllama,
    ollamaRunning,
    hasWindowsOllama,
    ollamaHost,
    platform: process.platform,
    isWsl: isWsl(),
  });
  if (ollamaInstallMenu.entry) options.push(ollamaInstallMenu.entry);

  // Model Router: complexity-based routing via blueprint config.
  const blueprintRouterCfg = loadBlueprintProfile("routed");
  if (blueprintRouterCfg && blueprintRouterCfg.router?.enabled === true) {
    options.push({ key: "routed", label: "Model Router (experimental)" });
  }
  for (const providerKey of agentProviderOptions) {
    const remoteConfig = REMOTE_PROVIDER_CONFIG[providerKey];
    if (!remoteConfig || options.some((option) => option.key === providerKey)) continue;
    options.push({ key: providerKey, label: remoteConfig.label });
  }

  function rejectWindowsHostOllama(providerKey: string, windowsHostSelected: boolean): boolean {
    return rejectUnsupportedWindowsHostOllama(
      windowsHostOllamaDockerRequirement,
      providerKey,
      windowsHostSelected,
      isNonInteractive,
      abortNonInteractive,
    );
  }

  if (options.length > 1) {
    selectionLoop: while (true) {
      let selected: ProviderChoice | undefined;
      // Hoisted so downstream model-selection branches can fall back to a
      // recorded model from the same recovery decision.
      let recoveredFromSandbox = false;
      let recoveredModel: string | null = null;
      hermesAuthMethod = null;

      if (isNonInteractive() || requestedProvider) {
        let providerKey = requestedProvider;
        if (!providerKey) {
          const recordedProvider = readRecordedProvider(sandboxName);
          const hasNimContainer = !!readRecordedNimContainer(sandboxName);
          const recoveredKey = providerRecovery.providerNameToOptionKey(REMOTE_PROVIDER_CONFIG, recordedProvider, { hasNimContainer });
          if (recoveredKey) {
            // Refuse to silently switch providers behind the user's back; if
            // the previously-recorded one is gone, surface the recorded value
            // so the user can fix the dependency or override via env var.
            // Special case: on WSL, recorded ollama-local was WSL Ollama at
            // record time. If the only reachable Ollama is now Windows-host
            // (so the menu's "ollama" key points there), the availability
            // check below would pass and silently swap the daemon. Detect
            // and fail-loud with a hint.
            if (isWsl() && recordedProvider === "ollama-local" && isWindowsHostOllama) {
              console.error(
                `  Recorded provider '${recordedProvider}' (WSL Ollama) is not available in this environment.`,
              );
              console.error(
                "  Hint: Windows-host Ollama is reachable here; re-run with NEMOCLAW_PROVIDER=ollama to use it explicitly.",
              );
              process.exit(1);
            }
            if (!options.some((o) => o.key === recoveredKey)) {
              console.error(
                `  Recorded provider '${recordedProvider}' is not available in this environment.`,
              );
              console.error(
                "  Set NEMOCLAW_PROVIDER explicitly, or restore the missing local-inference dependency.",
              );
              if (recoveredKey === "ollama") {
                const winHostKey = options.find(
                  (o) =>
                    o.key === "start-windows-ollama" || o.key === "install-windows-ollama",
                )?.key;
                if (winHostKey) {
                  console.error(
                    `  Hint: Windows-host Ollama is available here — re-run with NEMOCLAW_PROVIDER=${winHostKey} to use it.`,
                  );
                }
              }
              process.exit(1);
            }
            providerKey = recoveredKey;
            recoveredFromSandbox = true;
            recoveredModel = readRecordedModel(sandboxName);
          } else if (recordedProvider === "vllm-local") {
            // vllm-local without a nimContainer marker is ambiguous — could be
            // standalone vLLM or Local NIM. Don't guess; require an override.
            console.error(
              "  Recorded provider 'vllm-local' is ambiguous (could be standalone vLLM or Local NIM).",
            );
            console.error("  Set NEMOCLAW_PROVIDER explicitly (vllm or nim-local) and re-run.");
            process.exit(1);
          } else {
            providerKey = "build";
          }
        }
        selected = options.find((o) => o.key === providerKey);
        if (!selected) {
          if (
            (providerKey === "start-windows-ollama" ||
              providerKey === "install-windows-ollama") &&
            rejectWindowsHostOllama(providerKey, isWindowsHostOllama)
          ) {
            process.exit(1);
          }
          selected = resolveProviderKeyFallback(options, providerKey, {
            canUseWindowsHostOllama:
              isWindowsHostOllama && windowsHostOllamaDockerRequirement.supported,
          });
          if (!selected) {
            if (providerKey === "hermesProvider" && !hermesProviderAvailable) {
              console.error("  Hermes Provider is only available when onboarding Hermes Agent.");
              console.error(
                "  Re-run with `nemohermes onboard` or `nemoclaw onboard --agent hermes`.",
              );
              process.exit(1);
            }
            console.error(
              `  Requested provider '${providerKey}' is not available in this environment.`,
            );
            process.exit(1);
          }
        }
        note(
          recoveredFromSandbox
            ? `  [non-interactive] Provider: ${selected.key} (recovered from sandbox '${sandboxName}')`
            : `  [non-interactive] Provider: ${selected.key}`,
        );
      } else {
        const suggestions: string[] = [];
        if (vllmRunning) suggestions.push("vLLM");
        if (ollamaRunning) suggestions.push("Ollama");
        if (suggestions.length > 0) {
          console.log(
            `  Detected local inference option${suggestions.length > 1 ? "s" : ""}: ${suggestions.join(", ")}`,
          );
          console.log("");
        }

        console.log("");
        console.log("  Inference options:");
        options.forEach((o, i) => {
          console.log(`    ${i + 1}) ${o.label}`);
        });
        console.log("");

        const envProviderHint = (process.env.NEMOCLAW_PROVIDER || "").trim().toLowerCase();
        const envProviderIdx = envProviderHint
          ? options.findIndex((o) => o.key.toLowerCase() === envProviderHint)
          : -1;
        const defaultIdx =
          (envProviderIdx >= 0 ? envProviderIdx : options.findIndex((o) => o.key === "build")) + 1;
        const choice = await prompt(`  Choose [${defaultIdx}]: `);
        selected = selectFromNumberedMenuOrExit(choice, defaultIdx, options);
      }

      if (!selected) {
        console.error("  No provider was selected.");
        process.exit(1);
      }
      if (selected.key !== "hermesProvider") {
        hermesAuthMethod = null;
        hermesToolGateways = [];
      }

      if (REMOTE_PROVIDER_CONFIG[selected.key]) {
        const remoteConfig = REMOTE_PROVIDER_CONFIG[selected.key];
        provider = remoteConfig.providerName;
        credentialEnv = remoteConfig.credentialEnv;
        endpointUrl = remoteConfig.endpointUrl;
        preferredInferenceApi = null;

        if (selected.key === "custom") {
          const _envUrl = (process.env.NEMOCLAW_ENDPOINT_URL || "").trim();
          const endpointInput = isNonInteractive()
            ? _envUrl
            : (await prompt(
                _envUrl
                  ? `  OpenAI-compatible base URL [${_envUrl}]: `
                  : "  OpenAI-compatible base URL (e.g., https://openrouter.ai): ",
              )) || _envUrl;
          const navigation = getNavigationChoice(endpointInput);
          if (navigation === "back") {
            console.log("  Returning to provider selection.");
            console.log("");
            continue selectionLoop;
          }
          if (navigation === "exit") {
            exitOnboardFromPrompt();
          }
          endpointUrl = normalizeProviderBaseUrl(endpointInput, "openai");
          if (!endpointUrl) {
            console.error("  Endpoint URL is required for Other OpenAI-compatible endpoint.");
            if (isNonInteractive()) {
              process.exit(1);
            }
            console.log("");
            continue selectionLoop;
          }
        } else if (selected.key === "anthropicCompatible") {
          const _envUrl = (process.env.NEMOCLAW_ENDPOINT_URL || "").trim();
          const endpointInput = isNonInteractive()
            ? _envUrl
            : (await prompt(
                _envUrl
                  ? `  Anthropic-compatible base URL [${_envUrl}]: `
                  : "  Anthropic-compatible base URL (e.g., https://proxy.example.com): ",
              )) || _envUrl;
          const navigation = getNavigationChoice(endpointInput);
          if (navigation === "back") {
            console.log("  Returning to provider selection.");
            console.log("");
            continue selectionLoop;
          }
          if (navigation === "exit") {
            exitOnboardFromPrompt();
          }
          endpointUrl = normalizeProviderBaseUrl(endpointInput, "anthropic");
          if (!endpointUrl) {
            console.error("  Endpoint URL is required for Other Anthropic-compatible endpoint.");
            if (isNonInteractive()) {
              process.exit(1);
            }
            console.log("");
            continue selectionLoop;
          }
          endpointUrl = bedrockRuntimeOnboard.normalizeCustomAnthropicEndpointUrl(endpointUrl);
        }

        if (selected.key === "hermesProvider") {
          const selectedHermesAuthMethod = await promptHermesAuthMethod();
          if (isBackToSelection(selectedHermesAuthMethod)) {
            hermesAuthMethod = null;
            console.log("  Returning to provider selection.");
            console.log("");
            continue selectionLoop;
          }
          hermesAuthMethod = normalizeHermesAuthMethod(
            selectedHermesAuthMethod as string | null | undefined,
          );
          if (hermesAuthMethod === HERMES_AUTH_METHOD_API_KEY) {
            credentialEnv = HERMES_NOUS_API_KEY_CREDENTIAL_ENV;
            stageNousApiKeyProviderEnv();
            if (isNonInteractive()) {
              if (!resolveHermesNousApiKey()) {
                console.error(
                  "  Hermes Provider Nous API Key is required in non-interactive mode.",
                );
                process.exit(1);
              }
            } else {
              const hermesKeyResult = await ensureHermesNousApiKeyEnv();
              if (credentialPrompt.returningToProviderSelection(hermesKeyResult))
                continue selectionLoop;
            }
          } else {
            credentialEnv = remoteConfig.credentialEnv;
          }
          const recordedHermesToolGateways = sandboxName
            ? normalizeHermesToolGatewaySelections(registry.getSandbox(sandboxName)?.hermesToolGateways)
            : null;
          hermesToolGateways = await setupHermesToolGateways(
            provider,
            hermesAuthMethod,
            recordedHermesToolGateways,
            { prompt, note, isNonInteractive },
          );

          const defaultModel =
            requestedModel ||
            (recoveredFromSandbox && recoveredModel) ||
            remoteConfig.defaultModel;
          if (isNonInteractive()) {
            model = defaultModel;
          } else {
            let hermesProviderModels: string[] = [];
            try {
              hermesProviderModels = await nousModels.getHermesProviderModelOptions();
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              console.warn(
                `  Warning: failed to load Nous model recommendations; falling back to the current/default model (${detail}).`,
              );
            }
            model = await promptRemoteModel(
              remoteConfig.label,
              selected.key,
              defaultModel,
              null,
              {
                otherShowsFullList: true,
                remoteModelOptions: { [selected.key]: hermesProviderModels },
                topLevelModelLimit: 10,
              },
            );
          }
          if (isBackToSelection(model)) {
            console.log("  Returning to provider selection.");
            console.log("");
            continue selectionLoop;
          }
          preferredInferenceApi = "openai-completions";
          console.log(`  Using ${remoteConfig.label} with model: ${model}`);
          break;
        }

        // Hydrate from credential env vars set earlier in this process
        // before checking env, so rebuild and other non-interactive callers
        // can resolve keys stored during the original interactive onboard.
        // See #2273.
        hydrateCredentialEnv(credentialEnv);

        if (selected.key === "build") {
          // Allow NEMOCLAW_PROVIDER_KEY as a fallback for NVIDIA_API_KEY.
          // Check raw process.env first — NEMOCLAW_PROVIDER_KEY is a user-facing
          // override that should take precedence before resolving from credentials.json.
          const _nvProviderKey = (process.env.NEMOCLAW_PROVIDER_KEY || "").trim();
          // check-direct-credential-env-ignore -- intentional: checking if env is already set before applying NEMOCLAW_PROVIDER_KEY override
          const existingNvidiaKey = normalizeCredentialValue(process.env.NVIDIA_API_KEY ?? "");
          if (_nvProviderKey && !existingNvidiaKey) {
            process.env.NVIDIA_API_KEY = _nvProviderKey;
          }
          if (isNonInteractive()) {
            const resolvedNvidiaKey = resolveProviderCredential("NVIDIA_API_KEY");
            if (!resolvedNvidiaKey) {
              logMissingNvidiaApiKeyHelp(REMOTE_PROVIDER_CONFIG.build.helpUrl);
              process.exit(1);
            }
            const keyError = validateNvidiaApiKeyValue(resolvedNvidiaKey);
            if (keyError) {
              console.error(keyError);
              console.error(`  Get a key from ${REMOTE_PROVIDER_CONFIG.build.helpUrl}`);
              process.exit(1);
            }
          } else {
            await ensureApiKey();
          }
          const _envModel = (process.env.NEMOCLAW_MODEL || "").trim();
          model =
            requestedModel ||
            (recoveredFromSandbox && recoveredModel) ||
            (isNonInteractive()
              ? DEFAULT_CLOUD_MODEL
              : await promptCloudModel({ defaultModelId: _envModel || undefined })) ||
            DEFAULT_CLOUD_MODEL;
          if (isBackToSelection(model)) {
            console.log("  Returning to provider selection.");
            console.log("");
            continue selectionLoop;
          }
        } else {
          // NEMOCLAW_PROVIDER_KEY is a universal alias: if the specific credential env
          // isn't already set, use NEMOCLAW_PROVIDER_KEY as the API key for this provider.
          // Check raw process.env — the override must apply before resolving from credentials.json.
          const _providerKeyHint = (process.env.NEMOCLAW_PROVIDER_KEY || "").trim();
          if (_providerKeyHint && credentialEnv) {
            // check-direct-credential-env-ignore -- intentional: checking if env is already set before applying NEMOCLAW_PROVIDER_KEY override
            const existingCredentialKey = normalizeCredentialValue(process.env[credentialEnv] ?? "");
            if (!existingCredentialKey) {
              process.env[credentialEnv] = _providerKeyHint;
            }
          }

          const _envModelRemote = (process.env.NEMOCLAW_MODEL || "").trim();
          const defaultModel =
            requestedModel ||
            _envModelRemote ||
            (recoveredFromSandbox && recoveredModel) ||
            remoteConfig.defaultModel;
          const selectedCredentialEnv = requireValue(
            credentialEnv,
            `Missing credential env for ${remoteConfig.label}`,
          );
          const bedrockSelection = await bedrockRuntimeOnboard.selectBedrockRuntimeCustomAnthropic({
            selectedKey: selected.key,
            endpointUrl,
            credentialEnv: selectedCredentialEnv,
            label: remoteConfig.label,
            helpUrl: remoteConfig.helpUrl,
            defaultModel,
            backToSelection: BACK_TO_SELECTION,
            isNonInteractive,
            promptInputModel,
            replaceNamedCredential,
          });
          if (bedrockSelection.action === "retry-selection") {
            console.log("  Returning to provider selection.");
            console.log("");
            continue selectionLoop;
          }
          if (bedrockSelection.action === "selected") {
            model = bedrockSelection.model;
            preferredInferenceApi = bedrockSelection.preferredInferenceApi;
            break;
          }
          if (isNonInteractive()) {
            if (!resolveProviderCredential(selectedCredentialEnv)) {
              console.error(
                `  ${selectedCredentialEnv} (or NEMOCLAW_PROVIDER_KEY) is required for ${remoteConfig.label} in non-interactive mode.`,
              );
              process.exit(1);
            }
          } else {
            const credentialResult = await ensureNamedCredential(
              selectedCredentialEnv,
              remoteConfig.label + " API key",
              remoteConfig.helpUrl,
            );
            if (credentialPrompt.returningToProviderSelection(credentialResult)) continue selectionLoop;
          }
          let modelValidator: ((candidate: string) => ModelValidationResult) | null = null;
          if (selected.key === "openai" || selected.key === "gemini") {
            const modelAuthMode = getProbeAuthMode(provider);
            modelValidator = (candidate) =>
              validateOpenAiLikeModel(
                remoteConfig.label,
                endpointUrl || remoteConfig.endpointUrl,
                candidate,
                getCredential(selectedCredentialEnv) || "",
                ...(modelAuthMode ? [{ authMode: modelAuthMode }] : []),
              );
          } else if (selected.key === "anthropic") {
            modelValidator = (candidate) =>
              validateAnthropicModel(
                endpointUrl || ANTHROPIC_ENDPOINT_URL,
                candidate,
                getCredential(selectedCredentialEnv) || "",
              );
          }
          while (true) {
            if (isNonInteractive()) {
              model = defaultModel;
            } else if (remoteConfig.modelMode === "curated") {
              model = await promptRemoteModel(
                remoteConfig.label,
                selected.key,
                defaultModel,
                modelValidator,
              );
            } else {
              model = await promptInputModel(remoteConfig.label, defaultModel, modelValidator);
            }
            if (isBackToSelection(model)) {
              console.log("  Returning to provider selection.");
              console.log("");
              continue selectionLoop;
            }

            if (selected.key === "custom") {
              const validation = await validateCustomOpenAiLikeSelection(
                remoteConfig.label,
                endpointUrl || OPENAI_ENDPOINT_URL,
                model,
                selectedCredentialEnv,
                remoteConfig.helpUrl,
              );
              if (validation.ok) {
                // Force chat completions for all OpenAI-compatible endpoints
                // unless the user explicitly opted in to responses via env var.
                // Many backends (Ollama, vLLM, LiteLLM) expose /v1/responses
                // but do not correctly handle the `developer` role used by the
                // Responses API — messages with that role are silently dropped,
                // causing the model to receive no system prompt or tool
                // definitions. Chat completions uses the `system` role which
                // is universally supported.
                // See: https://github.com/NVIDIA/NemoClaw/issues/1932
                const explicitApi = (process.env.NEMOCLAW_PREFERRED_API || "").trim().toLowerCase();
                if (
                  explicitApi &&
                  explicitApi !== "openai-completions" &&
                  explicitApi !== "chat-completions"
                ) {
                  preferredInferenceApi = validation.api;
                } else {
                  if (validation.api !== "openai-completions") {
                    console.log(
                      "  ℹ Using chat completions API (compatible endpoints may not support the Responses API developer role)",
                    );
                  }
                  preferredInferenceApi = "openai-completions";
                }
                break;
              }
              if (
                validation.retry === "credential" ||
                validation.retry === "retry" ||
                validation.retry === "model"
              ) {
                continue;
              }
              if (validation.retry === "selection") {
                continue selectionLoop;
              }
            } else if (selected.key === "anthropicCompatible") {
              const validation = await validateCustomAnthropicSelection(
                remoteConfig.label,
                endpointUrl || ANTHROPIC_ENDPOINT_URL,
                model,
                selectedCredentialEnv,
                remoteConfig.helpUrl,
              );
              if (validation.ok) {
                preferredInferenceApi = validation.api;
                break;
              }
              if (
                validation.retry === "credential" ||
                validation.retry === "retry" ||
                validation.retry === "model"
              ) {
                continue;
              }
              if (validation.retry === "selection") {
                continue selectionLoop;
              }
            } else {
              const retryMessage = "Please choose a provider/model again.";
              if (selected.key === "anthropic") {
                const validation = await validateAnthropicSelectionWithRetryMessage(
                  remoteConfig.label,
                  endpointUrl || ANTHROPIC_ENDPOINT_URL,
                  model,
                  selectedCredentialEnv,
                  retryMessage,
                  remoteConfig.helpUrl,
                );
                if (validation.ok) {
                  preferredInferenceApi = validation.api;
                  break;
                }
                if (
                  validation.retry === "credential" ||
                  validation.retry === "retry" ||
                  validation.retry === "model"
                ) {
                  continue;
                }
              } else {
                const validation = await validateOpenAiLikeSelection(
                  remoteConfig.label,
                  requireValue(endpointUrl, `Missing endpoint URL for ${remoteConfig.label}`),
                  model,
                  selectedCredentialEnv,
                  retryMessage,
                  remoteConfig.helpUrl,
                  {
                    requireResponsesToolCalling: shouldRequireResponsesToolCalling(provider),
                    skipResponsesProbe: shouldSkipResponsesProbe(provider),
                    authMode: getProbeAuthMode(provider),
                  },
                );
                if (validation.ok) {
                  preferredInferenceApi = validation.api;
                  break;
                }
                if (
                  validation.retry === "credential" ||
                  validation.retry === "retry" ||
                  validation.retry === "model"
                ) {
                  continue;
                }
              }
              continue selectionLoop;
            }
          }
        }

        if (selected.key === "build") {
          while (true) {
            const validation = await validateOpenAiLikeSelection(
              remoteConfig.label,
              requireValue(endpointUrl, `Missing endpoint URL for ${remoteConfig.label}`),
              model,
              credentialEnv,
              "Please choose a provider/model again.",
              remoteConfig.helpUrl,
              {
                requireResponsesToolCalling: shouldRequireResponsesToolCalling(provider),
                skipResponsesProbe: shouldSkipResponsesProbe(provider),
                authMode: getProbeAuthMode(provider),
              },
            );
            if (validation.ok) {
              preferredInferenceApi = validation.api;
              break;
            }
            if (validation.retry === "credential" || validation.retry === "retry") {
              continue;
            }
            continue selectionLoop;
          }
        }

        console.log(`  Using ${remoteConfig.label} with model: ${model}`);
        break;
      } else if (selected.key === "nim-local") {
        const localGpu = requireValue(
          gpu,
          "GPU details are required for local NIM model selection",
        );
        // List models that fit GPU VRAM
        const models = nim.listModels().filter((m) => m.minGpuMemoryMB <= localGpu.totalMemoryMB);
        if (models.length === 0) {
          console.log("  No NIM models fit your GPU VRAM. Falling back to cloud API.");
        } else {
          let sel;
          if (isNonInteractive()) {
            const targetModel = requestedModel || (recoveredFromSandbox ? recoveredModel : null);
            if (targetModel) {
              sel = models.find((m) => m.name === targetModel);
              if (!sel) {
                const label = requestedModel ? "NEMOCLAW_MODEL for NIM" : "Recorded NIM model";
                console.error(`  Unsupported ${label}: ${targetModel}`);
                process.exit(1);
              }
            } else {
              sel = models[0];
            }
            note(`  [non-interactive] NIM model: ${sel.name}`);
          } else {
            console.log("");
            console.log("  Models that fit your GPU:");
            models.forEach((m, i) => {
              console.log(`    ${i + 1}) ${m.name} (min ${m.minGpuMemoryMB} MB)`);
            });
            console.log("");

            const modelChoice = await prompt(`  Choose model [1]: `);
            sel = selectFromNumberedMenuOrExit(modelChoice, 1, models);
          }
          model = sel.name;

          // Ensure Docker is logged in to NGC registry before pulling NIM images.
          // The key is also forwarded into the NIM container at runtime (#3333),
          // so we hoist it out of the not-logged-in branch.
          let ngcApiKey: string | null = null;
          if (!nim.isNgcLoggedIn()) {
            if (isNonInteractive()) {
              console.error(
                "  Docker is not logged in to nvcr.io. In non-interactive mode, run `docker login nvcr.io` first and retry.",
              );
              process.exit(1);
            }
            console.log("");
            console.log("  NGC API Key required to pull NIM images.");
            console.log("  Get one from: https://org.ngc.nvidia.com/setup/api-key");
            console.log("");
            let ngcKey = await credentialPrompt.readValue("  NGC API Key: ");
            if (credentialPrompt.returningToProviderSelection(ngcKey)) continue selectionLoop;
            if (!ngcKey) {
              console.error("  NGC API Key is required for Local NIM.");
              process.exit(1);
            }
            if (!nim.dockerLoginNgc(ngcKey)) {
              console.error("  Failed to login to NGC registry. Check your API key and try again.");
              console.log("");
              ngcKey = await credentialPrompt.readValue("  NGC API Key: ");
              if (credentialPrompt.returningToProviderSelection(ngcKey)) continue selectionLoop;
              if (!ngcKey || !nim.dockerLoginNgc(ngcKey)) {
                console.error("  NGC login failed. Cannot pull NIM images.");
                process.exit(1);
              }
            }
            ngcApiKey = ngcKey;
          } else {
            // Docker is already logged in, but NIM still needs the key in its
            // container env to download model manifests. Users hit by the
            // original #3333 bug typically have a cached docker login from
            // the earlier broken attempt while the NGC key was never saved
            // anywhere, so a passive lookup would silently reproduce the
            // failure. Try env first, then prompt interactively; an empty
            // answer falls through to startNimContainerByName's warning so
            // we don't double-fail in non-interactive callers.
            ngcApiKey =
              hydrateCredentialEnv("NGC_API_KEY") || hydrateCredentialEnv("NVIDIA_API_KEY");
            if (!ngcApiKey && !isNonInteractive()) {
              console.log("");
              console.log("  NGC API Key required to download NIM model weights at runtime.");
              console.log("  (Docker is logged in to nvcr.io, but the key was not saved.)");
              const ngcKey = await credentialPrompt.readValue("  NGC API Key: ");
              if (credentialPrompt.returningToProviderSelection(ngcKey)) continue selectionLoop;
              ngcApiKey = ngcKey || null;
            }
          }

          console.log(`  Pulling NIM image for ${model}...`);
          nim.pullNimImage(model);

          console.log("  Starting NIM container...");
          const nimContainerNameLocal = nim.containerName(GATEWAY_NAME);
          nimContainer = nim.startNimContainerByName(nimContainerNameLocal, model, undefined, {
            ngcApiKey: ngcApiKey ?? undefined,
          });

          console.log("  Waiting for NIM to become healthy...");
          if (!nim.waitForNimHealth(undefined, undefined, { container: nimContainerNameLocal })) {
            console.error("  NIM failed to start. Falling back to cloud API.");
            model = null;
            nimContainer = null;
          } else {
            provider = "vllm-local";
            // Local NIM (vLLM under the hood) does not require a host API key —
            // setupInference registers the gateway provider with an internal
            // credential env (NEMOCLAW_VLLM_LOCAL_TOKEN). See GH #2519.
            credentialEnv = null;
            endpointUrl = getLocalProviderBaseUrl(provider);
            if (!endpointUrl) {
              console.error("  Local NVIDIA NIM base URL could not be determined.");
              process.exit(1);
            }
            const nimValidationUrl = getLocalProviderValidationBaseUrl(provider) || endpointUrl;
            const validation = await validateOpenAiLikeSelection(
              "Local NVIDIA NIM",
              nimValidationUrl,
              requireValue(model, "Expected a Local NVIDIA NIM model after startup"),
              null,
            );
            if (validation.retry === "selection" || validation.retry === "model") {
              continue selectionLoop;
            }
            if (!validation.ok) {
              continue selectionLoop;
            }
            preferredInferenceApi = validation.api;
            // NIM uses vLLM internally — same tool-call-parser limitation
            // applies to /v1/responses. Force chat completions.
            if (preferredInferenceApi !== "openai-completions") {
              console.log(
                "  ℹ Using chat completions API (tool-call-parser requires /v1/chat/completions)",
              );
            }
            preferredInferenceApi = "openai-completions";
          }
        }
        break;
      } else if (selected.key === "ollama") {
        if (rejectWindowsHostOllama(selected.key, isWindowsHostOllama)) {
          continue selectionLoop;
        }
        if (!checkOllamaPortsOrWarn({ isNonInteractive })) continue selectionLoop;
        let ollamaReady = ollamaRunning;
        const overrideState = ensureOllamaLoopbackSystemdOverride({ isNonInteractive });
        if (overrideState === "ready") {
          ollamaReady = true;
        } else if (overrideState === "failed") {
          console.error(
            "  Ollama systemd restart did not recover after applying the loopback override.",
          );
          process.exit(1);
        }
        const ollamaStartup = runOllamaStartupOrGate({
          ollamaReady,
          ollamaPort: OLLAMA_PORT,
          getLocalProviderBaseUrl,
          isNonInteractive,
        });
        if (ollamaStartup.kind === "continue") continue selectionLoop;
        if (ollamaStartup.kind === "fallback") {
          ({ provider, credentialEnv, endpointUrl, model, preferredInferenceApi } = ollamaStartup.result);
          break;
        }
        if (shouldFrontOllamaWithProxy()) {
          if (!startOllamaAuthProxy()) process.exit(1);
          console.log(
            `  ✓ Using Ollama on localhost:${OLLAMA_PORT} (proxy on :${OLLAMA_PROXY_PORT})`,
          );
        } else {
          console.log(`  ✓ Using Ollama on localhost:${OLLAMA_PORT}`);
        }
        provider = "ollama-local";
        // Local Ollama needs no user-supplied API key — the auth proxy uses
        // an internal token (NEMOCLAW_OLLAMA_PROXY_TOKEN, set in setupInference).
        // Leaving this null prevents the wizard from prompting for / caching
        // OPENAI_API_KEY and prevents the rebuild preflight from requiring it.
        // See GH #2519.
        credentialEnv = null;
        endpointUrl = getLocalProviderBaseUrl(provider);
        if (!endpointUrl) {
          console.error("  Local Ollama base URL could not be determined.");
          process.exit(1);
        }
        {
          const result = await selectAndValidateOllamaModel(gpu, provider, {
            requestedModel,
            recoveredModel: recoveredFromSandbox ? recoveredModel : null,
          });
          if (result.outcome === "back-to-selection") continue selectionLoop;
          ({ model, allowToolsIncompatible } = result);
          preferredInferenceApi = "openai-completions";
        }
        break;
      } else if (["start-windows-ollama", "install-windows-ollama"].includes(selected.key)) {
        if (rejectWindowsHostOllama(selected.key, true)) {
          continue selectionLoop;
        }
        if (!checkOllamaPortsOrWarn({ isNonInteractive })) continue selectionLoop;
        const isInstall = selected.key === "install-windows-ollama";
        const isSwitch = !isInstall && windowsOllamaReachable;
        const isRestart = !isInstall && !isSwitch && winOllamaLoopbackOnly;
        if (!isSwitch) {
          printOllamaExposureWarning();
        }
        const promptMsg = isInstall
          ? "  Install and launch Ollama on the Windows host with OLLAMA_HOST=0.0.0.0:11434? [Y/n]: "
          : isSwitch
            ? "  Use Ollama on the Windows host (already running)? [Y/n]: "
            : isRestart
              ? "  Stop the running Ollama and restart it with OLLAMA_HOST=0.0.0.0:11434? [Y/n]: "
              : "  Launch Ollama on the Windows host with OLLAMA_HOST=0.0.0.0:11434? [Y/n]: ";
        const proceed = isNonInteractive()
          ? true
          : !(await prompt(promptMsg)).trim().toLowerCase().startsWith("n");
        if (!proceed) {
          continue selectionLoop;
        }

        if (isSwitch) {
          switchToWindowsOllamaHost();
        } else if (isInstall) {
          const installResult = await installOllamaOnWindowsHost();
          if (!installResult.ok) {
            console.error(
              "  Install did not produce ollama.exe on PATH. Check the installer output above.",
            );
            if (isNonInteractive()) process.exit(1);
            continue selectionLoop;
          }
          if (!awaitWindowsOllamaReady()) {
            console.log("  Installer did not leave a reachable Ollama daemon; restarting it...");
            if (
              !setupWindowsOllamaWith0000Binding({
                installedPath: installResult.path,
              })
            ) {
              printWindowsOllamaTimeoutDiagnostics();
              if (isNonInteractive()) process.exit(1);
              continue selectionLoop;
            }
          }
          console.log(`  ✓ Using Ollama on host.docker.internal:${OLLAMA_PORT}`);
        } else {
          if (
            !setupWindowsOllamaWith0000Binding({
              announceStop: isRestart,
              installedPath: winOllamaInstalledPath || undefined,
            })
          ) {
            printWindowsOllamaTimeoutDiagnostics();
            if (isNonInteractive()) process.exit(1);
            continue selectionLoop;
          }
          console.log(`  ✓ Using Ollama on host.docker.internal:${OLLAMA_PORT}`);
        }
        provider = "ollama-local";
        credentialEnv = null;
        endpointUrl = getLocalProviderBaseUrl(provider);
        if (!endpointUrl) {
          console.error("  Local Ollama base URL could not be determined.");
          process.exit(1);
        }

        {
          const result = await selectAndValidateOllamaModel(gpu, provider, {
            requestedModel,
            recoveredModel: null,
          });
          if (result.outcome === "back-to-selection") {
            // The Windows-host action pinned resolved host to
            // host.docker.internal. Clear it so a subsequent provider pick
            // (e.g. plain WSL Ollama) starts from a fresh probe.
            resetOllamaHostCache();
            continue selectionLoop;
          }
          ({ model, allowToolsIncompatible } = result);
          preferredInferenceApi = "openai-completions";
        }
        break;
      } else if (selected.key === "install-ollama") {
        if (!checkOllamaPortsOrWarn({ isNonInteractive })) continue selectionLoop;
        const isUpgrade = ollamaInstallMenu.hasUpgradableOllama;
        const installResult = process.platform === "darwin"
          ? installOllamaOnMacOS({ isNonInteractive, isUpgrade })
          : installOllamaOnLinux({ isNonInteractive, isUpgrade });
        if (!installResult.ok) {
          if (isNonInteractive()) abortNonInteractive("Ollama install failed. See errors above.");
          continue selectionLoop;
        }
        const upgradeCheck = assertOllamaUpgradeApplied(ollamaInstallMenu);
        if (!upgradeCheck.ok) {
          console.error(`  ${upgradeCheck.message}`);
          if (isNonInteractive()) process.exit(1);
          continue selectionLoop;
        }
        if (shouldFrontOllamaWithProxy()) {
          if (!startOllamaAuthProxy()) process.exit(1);
          console.log(
            `  ✓ Using Ollama on localhost:${OLLAMA_PORT} (proxy on :${OLLAMA_PROXY_PORT})`,
          );
        } else {
          console.log(`  ✓ Using Ollama on localhost:${OLLAMA_PORT}`);
        }
        provider = "ollama-local";
        // See above ollama branch — internal proxy token, no user API key.
        credentialEnv = null;
        endpointUrl = getLocalProviderBaseUrl(provider);
        if (!endpointUrl) {
          console.error("  Local Ollama base URL could not be determined.");
          process.exit(1);
        }
        {
          const result = await selectAndValidateOllamaModel(gpu, provider, {
            requestedModel,
            recoveredModel: recoveredFromSandbox ? recoveredModel : null,
          });
          if (result.outcome === "back-to-selection") continue selectionLoop;
          ({ model, allowToolsIncompatible } = result);
          preferredInferenceApi = "openai-completions";
        }
        break;
      } else if (selected.key === "install-vllm") {
        if (!vllmProfile) {
          console.error("  No vLLM install profile available for this host.");
          if (isNonInteractive()) process.exit(1);
          continue selectionLoop;
        }
        const result = await installVllm(vllmProfile, {
          hasImage: hasVllmImage,
          nonInteractive: isNonInteractive(),
          promptFn: prompt,
        });
        if (!result.ok) {
          if (isNonInteractive()) abortNonInteractive("vLLM install failed. See errors above.");
          continue selectionLoop;
        }
        // Fall through to the same provider/model setup as the running-vLLM
        // branch. Mutate selected.key so the existing "vllm" branch picks up.
        selected = { key: "vllm", label: `Local vLLM (localhost:${VLLM_PORT}) — running` };
        // intentional fall-through to the next branch
      }
      if (selected.key === "vllm") {
        console.log(`  ✓ Using existing vLLM on localhost:${VLLM_PORT}`);
        provider = "vllm-local";
        // See NIM branch above — internal credential env, no user API key.
        credentialEnv = null;
        endpointUrl = getLocalProviderBaseUrl(provider);
        if (!endpointUrl) {
          console.error("  Local vLLM base URL could not be determined.");
          process.exit(1);
        }
        // Query vLLM for the actual model ID
        const vllmModelsRaw = runCapture(
          ["curl", "-sf", `http://127.0.0.1:${VLLM_PORT}/v1/models`],
          {
            ignoreError: true,
          },
        );
        let vllmModels: { data?: Array<{ id?: unknown }> } = {};
        try {
          vllmModels = JSON.parse(vllmModelsRaw);
          if (vllmModels.data && vllmModels.data.length > 0) {
            const detectedModel =
              typeof vllmModels.data[0]?.id === "string" ? vllmModels.data[0].id : null;
            model = detectedModel;
            if (!detectedModel || !isSafeModelId(detectedModel)) {
              console.error(`  Detected model ID contains invalid characters: ${model}`);
              process.exit(1);
            }
            console.log(`  Detected model: ${model}`);
          } else {
            console.error("  Could not detect model from vLLM. Please specify manually.");
            process.exit(1);
          }
        } catch {
          console.error(
            `  Could not query vLLM models endpoint. Is vLLM running on localhost:${VLLM_PORT}?`,
          );
          process.exit(1);
        }
        const validationBaseUrl = getLocalProviderValidationBaseUrl(provider);
        if (!validationBaseUrl) {
          console.error("  Local vLLM validation URL could not be determined.");
          process.exit(1);
        }
        const validation = await validateOpenAiLikeSelection(
          "Local vLLM",
          validationBaseUrl,
          requireValue(model as string | null | undefined, "Expected a detected vLLM model"),
          null,
        );
        if (validation.retry === "selection" || validation.retry === "model") {
          continue selectionLoop;
        }
        if (!validation.ok) continue selectionLoop;
        localInference.applyVllmRuntimeContextWindow(vllmModels, model as string);
        preferredInferenceApi = validation.api;
        // Force chat completions — vLLM's /v1/responses endpoint does not
        // run the --tool-call-parser, so tool calls arrive as raw text (#976).
        if (preferredInferenceApi !== "openai-completions") {
          console.log(
            "  ℹ Using chat completions API (tool-call-parser requires /v1/chat/completions)",
          );
        }
        preferredInferenceApi = "openai-completions";
        break;
      } else if (selected.key === "routed") {
        const bp = loadBlueprintProfile("routed");
        if (!bp || bp.router?.enabled !== true) {
          console.error("  Router is not enabled in nemoclaw-blueprint/blueprint.yaml.");
          if (isNonInteractive()) process.exit(1);
          continue selectionLoop;
        }
        const routerCredentialEnv =
          bp.router?.credential_env || bp.credential_env || DEFAULT_MODEL_ROUTER_CREDENTIAL_ENV;
        credentialEnv = routerCredentialEnv;
        const routedCredential =
          hydrateCredentialEnv(routerCredentialEnv) ||
          normalizeCredentialValue(bp.credential_default || "");
        if (routedCredential) {
          saveCredential(routerCredentialEnv, routedCredential);
        }
        const _providerKeyHint = (process.env.NEMOCLAW_PROVIDER_KEY || "").trim();
        if (_providerKeyHint && !resolveProviderCredential(routerCredentialEnv)) {
          saveCredential(routerCredentialEnv, _providerKeyHint);
        }
        if (isNonInteractive()) {
          if (!resolveProviderCredential(routerCredentialEnv)) {
            console.error(
              `  ${routerCredentialEnv} (or NEMOCLAW_PROVIDER_KEY) is required for Model Router in non-interactive mode.`,
            );
            process.exit(1);
          }
        } else {
          if (!resolveProviderCredential(routerCredentialEnv)) {
            console.log("");
            console.log("  Model Router accepts NVIDIA API keys (nvapi-...).");
            console.log("  Get one at https://build.nvidia.com");
            console.log("");
            const routerCredentialResult = await ensureNamedCredential(
              routerCredentialEnv,
              "Model Router API key",
              null,
            );
            if (credentialPrompt.returningToProviderSelection(routerCredentialResult))
              continue selectionLoop;
          }
        }
        provider = bp.provider_name || "nvidia-router";
        model = bp.model;
        const { HOST_GATEWAY_URL } = require("./inference/local");
        const routerEndpointUrl = bp.endpoint || "";
        endpointUrl = routerEndpointUrl;
        if (routerEndpointUrl.match(/localhost|127\.0\.0\.1/)) {
          const u = new URL(routerEndpointUrl);
          endpointUrl = `${HOST_GATEWAY_URL}:${u.port}${u.pathname}`;
        }
        preferredInferenceApi = "openai-completions";
        console.log(`  ✓ Using Model Router: ${provider} / ${model}`);
        break;
      }
    }
  }

  const selectedModel = isBackToSelection(model) ? null : model;
  return {
    model: selectedModel,
    provider,
    endpointUrl,
    credentialEnv,
    hermesAuthMethod,
    hermesToolGateways,
    preferredInferenceApi,
    nimContainer,
    allowToolsIncompatible,
  };
}

// ── Step 4: Inference provider ───────────────────────────────────

async function setupInference(
  sandboxName: string | null,
  model: string,
  provider: string,
  endpointUrl: string | null = null,
  credentialEnv: string | null = null,
  hermesAuthMethod: HermesAuthMethod | string | null = null,
  hermesToolGateways: string[] = [],
  options: { allowToolsIncompatible?: boolean } = {},
): Promise<{ ok: true; retry?: undefined } | { retry: "selection" }> {
  step(4, 8, "Setting up inference provider");
  runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });

  if (provider === hermesProviderAuth.HERMES_PROVIDER_NAME) {
    const targetSandbox = requireValue(sandboxName, "Hermes Provider requires a sandbox name");
    const resolvedHermesAuthMethod =
      normalizeHermesAuthMethod(hermesAuthMethod) ||
      (credentialEnv === HERMES_NOUS_API_KEY_CREDENTIAL_ENV
        ? HERMES_AUTH_METHOD_API_KEY
        : HERMES_AUTH_METHOD_OAUTH);
    const providerStore = checkHermesProviderStoreReachable(runOpenshell);
    if (!providerStore.ok) {
      console.error("  ✗ OpenShell provider storage is unreachable.");
      console.error(`    ${providerStore.message}`);
      console.error("    Restart or recreate the OpenShell gateway, then rerun onboarding.");
      if (isNonInteractive()) process.exit(1);
      return { retry: "selection" };
    }
    const providerRegistered = hermesProviderAuth.isHermesProviderRegistered(runOpenshell);
    const toolGatewayProviderRegistered =
      hermesToolGateways.length === 0
        ? true
        : providerExistsInGateway(
            getHermesToolGatewayBroker().getHermesToolGatewayProviderName(targetSandbox),
          );
    const hasFreshNousApiKey =
      resolvedHermesAuthMethod === HERMES_AUTH_METHOD_API_KEY && !!resolveHermesNousApiKey();
    const shouldPrepareHermesCredentials =
      !providerRegistered ||
      !toolGatewayProviderRegistered ||
      hasFreshNousApiKey ||
      (resolvedHermesAuthMethod === HERMES_AUTH_METHOD_OAUTH && !isNonInteractive());
    if (shouldPrepareHermesCredentials) {
      try {
        const state =
          resolvedHermesAuthMethod === HERMES_AUTH_METHOD_API_KEY
            ? await hermesProviderAuth.ensureHermesProviderApiKeyCredentials(targetSandbox, {
                apiKey: resolveHermesNousApiKey(),
                runOpenshell,
                baseUrl: endpointUrl || undefined,
              })
            : await hermesProviderAuth.ensureHermesProviderOAuthCredentials(targetSandbox, {
                allowInteractiveLogin: !isNonInteractive(),
                runOpenshell,
                baseUrl: endpointUrl || undefined,
                toolGatewayPresets: hermesToolGateways,
              });
        if (!state) {
          const authLabel = hermesAuthMethodLabel(resolvedHermesAuthMethod);
          console.error(`  ✗ Hermes Provider ${authLabel} is not available on the host.`);
          console.error(
            "    Re-run `nemoclaw onboard --agent hermes` interactively to configure credentials.",
          );
          process.exit(1);
        }
      } catch (err) {
        console.error(
          `  ✗ Failed to prepare Hermes Provider credentials: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        if (isNonInteractive()) process.exit(1);
        return { retry: "selection" };
      }
    }

    const applyResult = runOpenshell(
      ["inference", "set", "--no-verify", "--provider", provider, "--model", model],
      { ignoreError: true },
    );
    if (applyResult.status !== 0) {
      const message =
        compactText(redact(`${applyResult.stderr || ""} ${applyResult.stdout || ""}`)) ||
        `Failed to configure inference provider '${provider}'.`;
      console.error(`  ${message}`);
      if (isNonInteractive()) process.exit(applyResult.status || 1);
      return { retry: "selection" };
    }

    verifyInferenceRoute(provider, model);
    verifyOnboardInferenceSmoke({ provider, model, endpointUrl, credentialEnv });
    if (sandboxName) {
      registry.updateSandbox(sandboxName, { model, provider });
    }
    console.log(`  ✓ Inference route set: ${provider} / ${model}`);
    return { ok: true };
  }

  if (
    provider === "nvidia-prod" ||
    provider === "nvidia-nim" ||
    provider === "openai-api" ||
    provider === "anthropic-prod" ||
    provider === "compatible-anthropic-endpoint" ||
    provider === "gemini-api" ||
    provider === "compatible-endpoint"
  ) {
    const config =
      provider === "nvidia-nim"
        ? REMOTE_PROVIDER_CONFIG.build
        : Object.values(REMOTE_PROVIDER_CONFIG).find((entry) => entry.providerName === provider);
    if (!config) {
      console.error(`  Unsupported provider configuration: ${provider}`);
      process.exit(1);
    }
    const bedrockSetup = await bedrockRuntimeOnboard.setupBedrockRuntimeInference({
      sandboxName,
      provider,
      model,
      endpointUrl,
      credentialEnv,
      isNonInteractive,
      runOpenshell,
      upsertProvider,
      verifyInferenceRoute,
      verifyOnboardInferenceSmoke,
    });
    if (bedrockSetup.handled) return bedrockSetup.result;
    while (true) {
      const resolvedCredentialEnv = credentialEnv || (config && config.credentialEnv);
      const resolvedEndpointUrl = endpointUrl || (config && config.endpointUrl);
      const credentialValue = hydrateCredentialEnv(resolvedCredentialEnv);
      const env =
        resolvedCredentialEnv && credentialValue
          ? { [resolvedCredentialEnv]: credentialValue }
          : {};
      const providerResult = upsertProvider(
        provider,
        config.providerType,
        resolvedCredentialEnv,
        resolvedEndpointUrl,
        env,
      );
      if (!providerResult.ok) {
        console.error(`  ${providerResult.message}`);
        if (isNonInteractive()) {
          process.exit(providerResult.status || 1);
        }
        const retry = await promptValidationRecovery(
          config.label,
          classifyApplyFailure(providerResult.message),
          resolvedCredentialEnv,
          config.helpUrl,
        );
        if (retry === "credential" || retry === "retry") {
          continue;
        }
        if (retry === "selection" || retry === "model") {
          return { retry: "selection" };
        }
        process.exit(providerResult.status || 1);
      }
      const args = ["inference", "set"];
      if (config.skipVerify) {
        args.push("--no-verify");
      }
      args.push("--provider", provider, "--model", model);
      if (provider === "compatible-endpoint") {
        args.push("--timeout", String(LOCAL_INFERENCE_TIMEOUT_SECS));
      }
      const applyResult = runOpenshell(args, { ignoreError: true });
      if (applyResult.status === 0) {
        break;
      }
      const message =
        compactText(redact(`${applyResult.stderr || ""} ${applyResult.stdout || ""}`)) ||
        `Failed to configure inference provider '${provider}'.`;
      console.error(`  ${message}`);
      if (isNonInteractive()) {
        process.exit(applyResult.status || 1);
      }
      const retry = await promptValidationRecovery(
        config.label,
        classifyApplyFailure(message),
        resolvedCredentialEnv,
        config.helpUrl,
      );
      if (retry === "credential" || retry === "retry") {
        continue;
      }
      if (retry === "selection" || retry === "model") {
        return { retry: "selection" };
      }
      process.exit(applyResult.status || 1);
    }
  } else if (provider === "vllm-local") {
    const validation = validateLocalProvider(provider);
    if (!validation.ok) {
      const hostCheck = getLocalProviderHealthCheck(provider);
      // Use run() and check exit status rather than coercing runCapture() output
      // to boolean — curl -sf can leave output even on failure in edge cases.
      const hostResponding = hostCheck
        ? run(hostCheck, { ignoreError: true, suppressOutput: true }).status === 0
        : false;

      if (hostResponding) {
        console.warn(`  ⚠ ${validation.message}`);
        if (validation.diagnostic) {
          console.warn(`  Diagnostic: ${validation.diagnostic}`);
        }
        console.warn(
          "  The server is healthy on the host — continuing. " +
            "The sandbox uses a different network path and may work correctly.",
        );
      } else {
        console.error(`  ${validation.message}`);
        if (validation.diagnostic) {
          console.error(`  Diagnostic: ${validation.diagnostic}`);
        }
        process.exit(1);
      }
    }
    const baseUrl = getLocalProviderBaseUrl(provider);
    // Use a dedicated internal credential env so the gateway does not pick
    // up the user's host OPENAI_API_KEY for local vLLM. vLLM does not enforce
    // the bearer at runtime, but a dedicated env name prevents accidental
    // hijacking. See GH #2519.
    const providerResult = upsertProvider(
      "vllm-local",
      "openai",
      VLLM_LOCAL_CREDENTIAL_ENV,
      baseUrl,
      { [VLLM_LOCAL_CREDENTIAL_ENV]: "dummy" },
    );
    if (!providerResult.ok) {
      console.error(`  ${providerResult.message}`);
      process.exit(providerResult.status || 1);
    }
    if (await applyLocalInferenceRoute("vllm-local", model)) return { retry: "selection" };
    // Do not mutate ~/.nemoclaw/credentials.json here: local vLLM now uses
    // VLLM_LOCAL_CREDENTIAL_ENV, so any saved OPENAI_API_KEY remains available
    // to unrelated OpenAI-backed sandboxes.
  } else if (provider === "ollama-local") {
    const validation = validateLocalProvider(provider);
    let proxyReady = false;
    const frontOllamaWithProxy = shouldFrontOllamaWithProxy();
    if (!validation.ok) {
      // The container reachability check uses Docker's --add-host host-gateway,
      // which may not work on all Docker configurations (e.g., Brev, rootless).
      // The real sandbox uses k3s CoreDNS + NodeHosts — a different path.
      // Try to start/restart the auth proxy before probing — this recovers
      // from stale or missing proxy processes before we decide to abort.
      if (frontOllamaWithProxy) {
        ensureOllamaAuthProxy();
        proxyReady = isProxyHealthy();
      }
      if (proxyReady) {
        console.warn(`  ⚠ ${validation.message}`);
        if (validation.diagnostic) {
          console.warn(`  Diagnostic: ${validation.diagnostic}`);
        }
        console.warn(
          "  The auth proxy is healthy on the host — continuing. " +
            "The sandbox uses a different network path and may work correctly.",
        );
      } else {
        console.error(`  ${validation.message}`);
        if (validation.diagnostic) {
          console.error(`  Diagnostic: ${validation.diagnostic}`);
        }
        if (process.platform === "darwin") {
          console.error(
            "  On macOS, local inference also depends on OpenShell host routing support.",
          );
        }
        process.exit(1);
      }
    }
    const baseUrl = getLocalProviderBaseUrl(provider);
    let ollamaCredential = "ollama";
    if (frontOllamaWithProxy) {
      // Skip if already started during the fallback recovery above.
      if (!proxyReady) ensureOllamaAuthProxy();
      const proxyToken = getOllamaProxyToken();
      if (!proxyToken) {
        console.error(
          "  Ollama auth proxy token is not set. Re-run onboard to initialize the proxy.",
        );
        process.exit(1);
      }
      ollamaCredential = proxyToken;
      // Persist token now that ollama-local is confirmed as the provider.
      // Not persisted earlier in case the user backs out to a different provider.
      await persistAndProbeOllamaProxy(proxyToken);
    }
    // Use a dedicated internal credential env (NEMOCLAW_OLLAMA_PROXY_TOKEN)
    // so the gateway never reads the user's host OPENAI_API_KEY for local
    // Ollama. GH #2519: a stale host OPENAI_API_KEY was leaking into the
    // inference path and producing 401s.
    const providerResult = upsertProvider(
      "ollama-local",
      "openai",
      OLLAMA_PROXY_CREDENTIAL_ENV,
      baseUrl,
      { [OLLAMA_PROXY_CREDENTIAL_ENV]: ollamaCredential },
    );
    if (!providerResult.ok) {
      console.error(`  ${providerResult.message}`);
      process.exit(providerResult.status || 1);
    }
    if (await applyLocalInferenceRoute("ollama-local", model)) return { retry: "selection" };
    console.log(`  Priming Ollama model: ${model}`);
    run(getOllamaWarmupCommand(model), { ignoreError: true });
    const probe = localInference.validateOllamaModelWithToolsOverride(model, options.allowToolsIncompatible === true);
    if (!probe.ok) {
      console.error(`  ${probe.message}`);
      process.exit(1);
    }
    // Do not mutate ~/.nemoclaw/credentials.json here: local Ollama now uses
    // OLLAMA_PROXY_CREDENTIAL_ENV, so any saved OPENAI_API_KEY remains available
    // to unrelated OpenAI-backed sandboxes.
  } else if (isRoutedInferenceProvider(provider)) {
    // Blueprint profile provider (e.g., nvidia-router for the routed profile).
    // reconcileModelRouter also probes sandbox→router reachability (#4564).
    try {
      await reconcileModelRouter();
    } catch (err) {
      console.error(`  ✗ Failed to start model router: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    const routed = routedInference.upsertRoutedProvider(provider, endpointUrl, credentialEnv, { upsertProvider, hydrateCredentialEnv });
    if (!routed.ok) {
      console.error(`  ${routed.result.message}`);
      process.exit(routed.result.status || 1);
    }
    runOpenshell(["inference", "set", "--no-verify", "--provider", provider, "--model", model]);
  } else {
    console.error(`  Unsupported provider configuration: ${provider}`);
    process.exit(1);
  }

  verifyInferenceRoute(provider, model);
  verifyOnboardInferenceSmoke({ provider, model, endpointUrl, credentialEnv });
  if (sandboxName) {
    registry.updateSandbox(sandboxName, { model, provider });
  }
  console.log(`  ✓ Inference route set: ${provider} / ${model}`);
  return { ok: true };
}

// ── Step 6: Messaging channels ───────────────────────────────────

const MESSAGING_CHANNELS = listChannels();

function getRecordedMessagingChannelsForResume(
  resume: boolean,
  session: Session | null,
  sandboxName: string | null,
): string[] | null {
  return getRecordedMessagingChannelsForResumeFromState({
    resume,
    sessionMessagingChannels: session?.messagingChannels,
    sandboxName,
    channels: MESSAGING_CHANNELS,
    getCredential,
    providerExistsInGateway,
    isNonInteractive,
  });
}

const telegramReachabilityDeps = { isNonInteractive, note, promptYesNoOrDefault };

async function setupMessagingChannels(
  agent: AgentDefinition | null = null,
  existingChannels: string[] | null = null,
): Promise<string[]> {
  step(5, 8, "Messaging channels");

  const availableChannels = getAvailableMessagingChannelsForAgent(MESSAGING_CHANNELS, agent);
  const seedFromState = (includeAllExisting = false): string[] =>
    resolveMessagingChannelSeed(
      availableChannels,
      existingChannels,
      (channel) => Boolean(getValidatedMessagingToken(channel, channel.envKey)),
      { includeAllExisting },
    );

  // Non-interactive: skip prompt, tokens come from env/credentials
  if (isNonInteractive() || process.env.NEMOCLAW_NON_INTERACTIVE === "1") {
    let found = Array.from(new Set(seedFromState(false)));
    if (found.length > 0) {
      note(`  [non-interactive] Messaging tokens detected: ${found.join(", ")}`);
      if (found.includes("telegram")) {
        const telegramToken = getValidatedMessagingTokenByEnvKey(MESSAGING_CHANNELS, "TELEGRAM_BOT_TOKEN");
        if (telegramToken) {
          const reachability = await checkTelegramReachability(telegramToken, telegramReachabilityDeps);
          if (reachability.skipped) found = found.filter((c) => c !== "telegram");
        }
      }
      found = filterSlackSelectionByValidation(found, MESSAGING_CHANNELS);
    } else {
      note("  [non-interactive] No messaging tokens configured. Skipping.");
    }
    return found;
  }

  // Single-keypress toggle selector — pre-select channels that already have tokens
  // or were recorded for this sandbox (so a rebuild does not silently drop QR-only
  // channels that have no host token).
  const enabled = new Set(seedFromState(true));

  const output = process.stderr;
  // Lines above the prompt: 1 blank + 1 header + N channels + 1 blank = N + 3
  const linesAbovePrompt = availableChannels.length + 3;
  let firstDraw = true;
  const showList = () => {
    if (!firstDraw) {
      // Cursor is at end of prompt line. Move to column 0, go up, clear to end of screen.
      output.write(`\r\x1b[${linesAbovePrompt}A\x1b[J`);
    }
    firstDraw = false;
    output.write("\n");
    output.write("  Available messaging channels:\n");
    availableChannels.forEach((ch, i) => {
      const marker = enabled.has(ch.name) ? "●" : "○";
      const status = getValidatedMessagingToken(ch, ch.envKey) ? " (configured)" : "";
      output.write(`    [${i + 1}] ${marker} ${ch.name} — ${ch.description}${status}\n`);
    });
    output.write("\n");
    output.write(`  Press 1-${availableChannels.length} to toggle, Enter when done (none selected skips): `);
  };

  showList();

  await new Promise<void>((resolve, reject) => {
    const input = process.stdin;
    let rawModeEnabled = false;
    let finished = false;

    function cleanup() {
      input.removeListener("data", onData);
      if (rawModeEnabled && typeof input.setRawMode === "function") {
        input.setRawMode(false);
      }
      // Symmetric with the ref() at the entry; lets the wizard exit
      // naturally if this is the last prompt.
      if (typeof input.pause === "function") {
        input.pause();
      }
      if (typeof input.unref === "function") {
        input.unref();
      }
    }

    function finish(): void {
      if (finished) return;
      finished = true;
      cleanup();
      output.write("\n");
      resolve();
    }

    function onData(chunk: Buffer | string): void {
      const text = chunk.toString("utf8");
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === "\u0003") {
          cleanup();
          reject(Object.assign(new Error("Prompt interrupted"), { code: "SIGINT" }));
          process.kill(process.pid, "SIGINT");
          return;
        }
        if (ch === "\r" || ch === "\n") {
          finish();
          return;
        }
        const num = parseInt(ch, 10);
        if (num >= 1 && num <= availableChannels.length) {
          const channel = availableChannels[num - 1];
          if (enabled.has(channel.name)) {
            enabled.delete(channel.name);
          } else {
            enabled.add(channel.name);
          }
          showList();
        }
      }
    }

    // Re-attach stdin to the event loop. A prior prompt cleanup may have
    // unref'd it (sticky), and resume() alone would leave the raw-mode read
    // detached from the loop.
    if (typeof input.ref === "function") {
      input.ref();
    }
    input.setEncoding("utf8");
    if (typeof input.resume === "function") {
      input.resume();
    }
    if (typeof input.setRawMode === "function") {
      input.setRawMode(true);
      rawModeEnabled = true;
    }
    input.on("data", onData);
  });

  const selected = Array.from(enabled);
  if (selected.length === 0) {
    console.log("  Skipping messaging channels.");
    return [];
  }

  await setupSelectedMessagingChannels(selected, enabled, availableChannels);
  console.log("");

  // Channels where the user declined to enter a token were dropped from
  // `enabled` inside the per-channel loop, so only channels with credentials
  // configured remain in the Set.

  // Preflight: verify Telegram API is reachable from the host before sandbox creation.
  // The non-interactive branch above already ran this probe and returned early,
  // so this second call only fires on the interactive path — guard explicitly
  // to make the no-double-probe invariant visible at the call site.
  if (!isNonInteractive() && enabled.has("telegram")) {
    const telegramToken = getValidatedMessagingTokenByEnvKey(MESSAGING_CHANNELS, "TELEGRAM_BOT_TOKEN");
    if (telegramToken) {
      const reachability = await checkTelegramReachability(telegramToken, telegramReachabilityDeps);
      if (reachability.skipped) enabled.delete("telegram");
    }
  }

  return Array.from(enabled);
}


// ── Step 7: OpenClaw ─────────────────────────────────────────────

function syncNemoClawConfigInSandbox(sandboxName: string, provider: string, model: string): void {
  runSandboxConfigSync(sandboxName, {
    getSelectionConfig: () => getProviderSelectionConfig(provider, model),
    runConnectScript: (name, scriptContent) => {
      run(openshellArgv(["sandbox", "connect", name]), {
        stdio: ["pipe", "ignore", "inherit"],
        input: scriptContent,
      });
    },
  });
}

const setupOpenclaw = createOpenclawSetup({
  step,
  agentProductName,
  getProviderSelectionConfig,
  buildSandboxConfigSyncScript,
  writeSandboxConfigSyncFile,
  run,
  openshellArgv,
  cleanupTempDir,
});

// ── Step 7: Policy presets ───────────────────────────────────────

function arePolicyPresetsApplied(sandboxName: string, selectedPresets: string[] = []): boolean {
  if (!Array.isArray(selectedPresets) || selectedPresets.length === 0) return false;
  const applied = new Set(policies.getAppliedPresets(sandboxName));
  return selectedPresets.every((preset) => applied.has(preset));
}

/**
 * Prompt the user to select a policy tier (restricted / balanced / open).
 * Uses the same radio-style TUI as presetsCheckboxSelector (single-select).
 * In non-interactive mode reads NEMOCLAW_POLICY_TIER (default: balanced).
 * Returns the tier name string.
 *
 * @returns {Promise<string>}
 */
async function selectPolicyTier(): Promise<string> {
  const allTiers = tiers.listTiers();
  const defaultTier = allTiers.find((t) => t.name === "balanced") || allTiers[1];

  if (isNonInteractive()) {
    const name = (process.env.NEMOCLAW_POLICY_TIER || "balanced").trim().toLowerCase();
    if (!tiers.getTier(name)) {
      console.error(
        `  Unknown policy tier: ${name}. Valid: ${allTiers.map((t) => t.name).join(", ")}`,
      );
      process.exit(1);
    }
    note(`  [non-interactive] Policy tier: ${name}`);
    return name;
  }

  const RADIO_ON = USE_COLOR ? "[\x1b[32m✓\x1b[0m]" : "[✓]";
  const RADIO_OFF = USE_COLOR ? "\x1b[2m[ ]\x1b[0m" : "[ ]";

  // ── Fallback: non-TTY ─────────────────────────────────────────────
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("");
    console.log("  Policy tier — controls which network presets are enabled:");
    allTiers.forEach((t) => {
      const marker = t.name === defaultTier.name ? RADIO_ON : RADIO_OFF;
      console.log(`    ${marker} ${t.label}`);
    });
    console.log("");
    const answer = await prompt(
      `  Select tier [1-${allTiers.length}] (default: ${allTiers.indexOf(defaultTier) + 1} ${defaultTier.name}): `,
    );
    const chosen = selectFromNumberedMenuOrExit(answer, allTiers.indexOf(defaultTier) + 1, allTiers);
    console.log(`  Tier: ${chosen.label}`);
    return chosen.name;
  }

  // ── Raw-mode TUI (radio — single selection) ───────────────────────
  let cursor = allTiers.indexOf(defaultTier);
  let selectedIdx = cursor;
  const n = allTiers.length;

  const G = USE_COLOR ? "\x1b[32m" : "";
  const D = USE_COLOR ? "\x1b[2m" : "";
  const R = USE_COLOR ? "\x1b[0m" : "";
  const HINT = USE_COLOR
    ? `  ${G}↑/↓ j/k${R}  ${D}move${R}    ${G}Space${R}  ${D}select${R}    ${G}Enter${R}  ${D}confirm${R}`
    : "  ↑/↓ j/k  move    Space  select    Enter  confirm";

  const renderLines = () => {
    const lines = ["  Policy tier — controls which network presets are enabled:"];
    allTiers.forEach((t, i) => {
      const radio = i === selectedIdx ? RADIO_ON : RADIO_OFF;
      const arrow = i === cursor ? ">" : " ";
      lines.push(`   ${arrow} ${radio} ${t.label}`);
    });
    lines.push("");
    lines.push(HINT);
    return lines;
  };

  process.stdout.write("\n");
  const initial = renderLines();
  for (const line of initial) process.stdout.write(`${line}\n`);
  let lineCount = initial.length;

  const redraw = () => {
    process.stdout.write(`\x1b[${lineCount}A`);
    const lines = renderLines();
    for (const line of lines) process.stdout.write(`\r\x1b[2K${line}\n`);
    lineCount = lines.length;
  };

  // Re-attach stdin to the event loop. A prior prompt cleanup may have
  // unref'd it (sticky), and resume() alone would leave the raw-mode read
  // detached from the loop.
  if (typeof process.stdin.ref === "function") process.stdin.ref();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise<string>((resolve) => {
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      // Symmetric with the ref() at the entry; lets the wizard exit
      // naturally if this is the last prompt.
      if (typeof process.stdin.unref === "function") process.stdin.unref();
      process.stdin.removeListener("data", onData);
      process.removeListener("SIGTERM", onSigterm);
    };

    const onSigterm = makeOnboardCancelExit(sandboxCancelRollback, cleanup);
    process.once("SIGTERM", onSigterm);

    const onData = (key: string) => {
      if (key === "\r" || key === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(allTiers[selectedIdx].name);
      } else if (key === " ") {
        selectedIdx = cursor;
        redraw();
      } else if (key === "\x03") {
        makeOnboardCancelExit(sandboxCancelRollback, cleanup)();
      } else if (key === "\x1b[A" || key === "k") {
        cursor = (cursor - 1 + n) % n;
        redraw();
      } else if (key === "\x1b[B" || key === "j") {
        cursor = (cursor + 1) % n;
        redraw();
      }
    };

    process.stdin.on("data", onData);
  });
}

/**
 * Combined preset selector: shows ALL available presets, pre-checks those in
 * the chosen tier, and lets the user include/exclude any preset and toggle
 * per-preset access (read vs read-write).
 *
 * Tier presets are listed first (in tier order), then remaining presets
 * alphabetically. Tier presets are pre-checked; others start unchecked.
 *
 * Keys:
 *   ↑/↓ j/k — move cursor
 *   Space    — include / exclude current preset
 *   r        — toggle read / read-write for current preset
 *   Enter    — confirm
 *
 * @param {string} tierName
 * @param {Array<{name: string}>} allPresets
 * @param {string[]} [extraSelected]  — names pre-checked even if not in tier (e.g. already-applied)
 * @returns {Promise<Array<{name: string, access: string}>>}
 */
async function selectTierPresetsAndAccess(
  tierName: string,
  allPresets: Array<{ name: string; description?: string }>,
  extraSelected: string[] = [],
): Promise<Array<{ name: string; access: string }>> {
  const tierDef = tiers.getTier(tierName);
  const tierPresetMap: Record<string, string> = {};
  if (tierDef) {
    for (const p of tierDef.presets) {
      tierPresetMap[p.name] = p.access;
    }
  }

  // Tier presets first (in tier order), then the rest in their original order.
  const tierNames = tierDef ? tierDef.presets.map((p) => p.name) : [];
  const tierSet = new Set(tierNames);
  const ordered: Array<{ name: string; description?: string }> = [
    ...tierNames
      .map((name) => allPresets.find((p) => p.name === name))
      .filter((p): p is { name: string; description?: string } => Boolean(p)),
    ...allPresets.filter((p) => !tierSet.has(p.name)),
  ];

  // Initial inclusion: tier presets + any already-applied extras.
  const included = new Set([
    ...tierNames,
    ...extraSelected.filter((n) => ordered.find((p) => p.name === n)),
  ]);

  // Access levels: tier defaults for tier presets, read-write default for others.
  const accessModes: Record<string, string> = {};
  for (const p of ordered) {
    accessModes[p.name] = tierPresetMap[p.name] ?? "read-write";
  }

  const G = USE_COLOR ? "\x1b[32m" : "";
  const O = USE_COLOR ? "\x1b[38;5;208m" : "";
  const D = USE_COLOR ? "\x1b[2m" : "";
  const R = USE_COLOR ? "\x1b[0m" : "";
  const GREEN_CHECK = USE_COLOR ? `[${G}✓${R}]` : "[✓]";
  const EMPTY_CHECK = USE_COLOR ? `${D}[ ]${R}` : "[ ]";
  const TOGGLE_RW = USE_COLOR ? `[${O}rw${R}]` : "[rw]";
  const TOGGLE_R = USE_COLOR ? `${D}[ r]${R}` : "[ r]";

  const label = tierDef ? `  Presets  (${tierDef.label} defaults):` : "  Presets:";
  const n = ordered.length;

  // ── Non-interactive: return tier defaults silently ─────────────────
  if (isNonInteractive()) {
    return ordered
      .filter((p) => included.has(p.name))
      .map((p) => ({ name: p.name, access: accessModes[p.name] }));
  }

  // ── Fallback: non-TTY ─────────────────────────────────────────────
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("");
    console.log(label);
    ordered.forEach((p) => {
      const isIncluded = included.has(p.name);
      const isRw = accessModes[p.name] === "read-write";
      const check = isIncluded ? GREEN_CHECK : EMPTY_CHECK;
      const badge = isIncluded ? (isRw ? "[rw]" : "[ r]") : "    ";
      console.log(`    ${check} ${badge} ${p.name}`);
    });
    console.log("");
    const rawInclude = await prompt(
      "  Include presets (comma-separated names, Enter to keep defaults): ",
    );
    if (rawInclude.trim()) {
      const knownNames = new Set(ordered.map((p) => p.name));
      included.clear();
      for (const name of rawInclude
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        if (knownNames.has(name)) {
          included.add(name);
        } else {
          console.error(`  Unknown preset name ignored: ${name}`);
        }
      }
    }
    return ordered
      .filter((p) => included.has(p.name))
      .map((p) => ({ name: p.name, access: accessModes[p.name] }));
  }

  // ── Raw-mode TUI ─────────────────────────────────────────────────
  let cursor = 0;

  const HINT = USE_COLOR
    ? `  ${G}↑/↓ j/k${R}  ${D}move${R}    ${G}Space${R}  ${D}include${R}    ${G}r${R}  ${D}toggle rw${R}    ${G}Enter${R}  ${D}confirm${R}`
    : "  ↑/↓ j/k  move    Space  include    r  toggle rw    Enter  confirm";

  const renderLines = () => {
    const lines = [label];
    ordered.forEach((p, i) => {
      const isIncluded = included.has(p.name);
      const isRw = accessModes[p.name] === "read-write";
      const check = isIncluded ? GREEN_CHECK : EMPTY_CHECK;
      // badge is 4 visible chars + 1 space; blank when unchecked to keep name aligned
      const badge = isIncluded ? (isRw ? TOGGLE_RW + " " : TOGGLE_R + " ") : "     ";
      const arrow = i === cursor ? ">" : " ";
      lines.push(`   ${arrow} ${check} ${badge}${p.name}`);
    });
    lines.push("");
    lines.push(HINT);
    return lines;
  };

  process.stdout.write("\n");
  const initial = renderLines();
  for (const line of initial) process.stdout.write(`${line}\n`);
  let lineCount = initial.length;

  const redraw = () => {
    process.stdout.write(`\x1b[${lineCount}A`);
    const lines = renderLines();
    for (const line of lines) process.stdout.write(`\r\x1b[2K${line}\n`);
    lineCount = lines.length;
  };

  // Re-attach stdin to the event loop. A prior prompt cleanup may have
  // unref'd it (sticky), and resume() alone would leave the raw-mode read
  // detached from the loop.
  if (typeof process.stdin.ref === "function") process.stdin.ref();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise<Array<{ name: string; access: string }>>((resolve) => {
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      // Symmetric with the ref() at the entry; lets the wizard exit
      // naturally if this is the last prompt.
      if (typeof process.stdin.unref === "function") process.stdin.unref();
      process.stdin.removeListener("data", onData);
      process.removeListener("SIGTERM", onSigterm);
    };

    const onSigterm = makeOnboardCancelExit(sandboxCancelRollback, cleanup);
    process.once("SIGTERM", onSigterm);

    const onData = (key: string) => {
      if (key === "\r" || key === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(
          ordered
            .filter((p) => included.has(p.name))
            .map((p) => ({ name: p.name, access: accessModes[p.name] })),
        );
      } else if (key === "\x03") {
        makeOnboardCancelExit(sandboxCancelRollback, cleanup)();
      } else if (key === "\x1b[A" || key === "k") {
        cursor = (cursor - 1 + n) % n;
        redraw();
      } else if (key === "\x1b[B" || key === "j") {
        cursor = (cursor + 1) % n;
        redraw();
      } else if (key === " ") {
        const currentPreset = ordered[cursor];
        if (!currentPreset) return;
        const name = currentPreset.name;
        if (included.has(name)) {
          included.delete(name);
        } else {
          included.add(name);
        }
        redraw();
      } else if (key === "r" || key === "R") {
        const currentPreset = ordered[cursor];
        if (!currentPreset) return;
        const name = currentPreset.name;
        accessModes[name] = accessModes[name] === "read-write" ? "read" : "read-write";
        redraw();
      }
    };

    process.stdin.on("data", onData);
  });
}

/**
 * Raw-mode TUI preset selector.
 * Keys: ↑/↓ or k/j to move, Space to toggle, a to select/unselect all, Enter to confirm.
 * Falls back to a simple line-based prompt when stdin is not a TTY.
 */
async function presetsCheckboxSelector(
  allPresets: Array<{ name: string; description: string }>,
  initialSelected: string[],
): Promise<string[]> {
  const selected = new Set<string>(initialSelected);
  const n = allPresets.length;

  // ── Zero-presets guard ────────────────────────────────────────────
  if (n === 0) {
    console.log("  No policy presets are available.");
    return [];
  }

  const GREEN_CHECK = USE_COLOR ? "[\x1b[32m✓\x1b[0m]" : "[✓]";

  // ── Fallback: non-TTY or redirected stdout (piped input) ──────────
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("");
    console.log("  Available policy presets:");
    allPresets.forEach((p) => {
      const marker = selected.has(p.name) ? GREEN_CHECK : "[ ]";
      console.log(`    ${marker} ${p.name.padEnd(14)} — ${p.description}`);
    });
    console.log("");
    const raw = await prompt("  Select presets (comma-separated names, Enter to skip): ");
    if (!raw.trim()) {
      console.log("  Skipping policy presets.");
      return [];
    }
    const knownNames = new Set(allPresets.map((p) => p.name));
    const chosen = [];
    for (const name of raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (knownNames.has(name)) {
        chosen.push(name);
      } else {
        console.error(`  Unknown preset name ignored: ${name}`);
      }
    }
    return chosen;
  }

  // ── Raw-mode TUI ─────────────────────────────────────────────────
  let cursor = 0;

  const G = USE_COLOR ? "\x1b[32m" : "";
  const D = USE_COLOR ? "\x1b[2m" : "";
  const R = USE_COLOR ? "\x1b[0m" : "";
  const HINT = USE_COLOR
    ? `  ${G}↑/↓ j/k${R}  ${D}move${R}    ${G}Space${R}  ${D}toggle${R}    ${G}a${R}  ${D}all/none${R}    ${G}Enter${R}  ${D}confirm${R}`
    : "  ↑/↓ j/k  move    Space  toggle    a  all/none    Enter  confirm";

  const renderLines = () => {
    const lines = ["  Available policy presets:"];
    allPresets.forEach((p, i) => {
      const check = selected.has(p.name) ? GREEN_CHECK : "[ ]";
      const arrow = i === cursor ? ">" : " ";
      lines.push(`   ${arrow} ${check} ${p.name.padEnd(14)} — ${p.description}`);
    });
    lines.push("");
    lines.push(HINT);
    return lines;
  };

  // Initial paint
  process.stdout.write("\n");
  const initial = renderLines();
  for (const line of initial) process.stdout.write(`${line}\n`);
  let lineCount = initial.length;

  const redraw = () => {
    process.stdout.write(`\x1b[${lineCount}A`);
    const lines = renderLines();
    for (const line of lines) process.stdout.write(`\r\x1b[2K${line}\n`);
    lineCount = lines.length;
  };

  // Re-attach stdin to the event loop. A prior prompt cleanup may have
  // unref'd it (sticky), and resume() alone would leave the raw-mode read
  // detached from the loop.
  if (typeof process.stdin.ref === "function") process.stdin.ref();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise<string[]>((resolve) => {
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      // Symmetric with the ref() at the entry; lets the wizard exit
      // naturally if this is the last prompt.
      if (typeof process.stdin.unref === "function") process.stdin.unref();
      process.stdin.removeListener("data", onData);
      process.removeListener("SIGTERM", onSigterm);
    };

    const onSigterm = makeOnboardCancelExit(sandboxCancelRollback, cleanup);
    process.once("SIGTERM", onSigterm);

    const onData = (key: string) => {
      if (key === "\r" || key === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve([...selected]);
      } else if (key === "\x03") {
        makeOnboardCancelExit(sandboxCancelRollback, cleanup)(); // Ctrl+C
      } else if (key === "\x1b[A" || key === "k") {
        cursor = (cursor - 1 + n) % n;
        redraw();
      } else if (key === "\x1b[B" || key === "j") {
        cursor = (cursor + 1) % n;
        redraw();
      } else if (key === " ") {
        const currentPreset = allPresets[cursor];
        if (!currentPreset) return;
        const name = currentPreset.name;
        if (selected.has(name)) selected.delete(name);
        else selected.add(name);
        redraw();
      } else if (key === "a") {
        if (selected.size === n) selected.clear();
        else for (const p of allPresets) selected.add(p.name);
        redraw();
      }
    };

    process.stdin.on("data", onData);
  });
}

const computeSetupPresetSuggestions = (
  tierName: string,
  options: SetupPresetSuggestionOptions = {},
): string[] => computeSetupPresetSuggestionsImpl({ policies, tiers, localInferenceProviders: LOCAL_INFERENCE_PROVIDERS }, tierName, options);

async function setupPoliciesWithSelection(
  sandboxName: string,
  options: SetupPolicySelectionOptions = {},
) {
  const selectedTier = await setupPoliciesWithSelectionImpl(
    {
      policies,
      tiers,
      localInferenceProviders: LOCAL_INFERENCE_PROVIDERS,
      step,
      note,
      isNonInteractive,
      waitForSandboxReady,
      syncPresetSelection,
      selectPolicyTier,
      setPolicyTier: (sandbox, tierName) => registry.updateSandbox(sandbox, { policyTier: tierName }),
      selectTierPresetsAndAccess,
      parsePolicyPresetEnv,
      env: process.env,
    },
    sandboxName,
    options,
  );
  return selectedTier;
}

// ── Dashboard ────────────────────────────────────────────────────

const {
  buildChain,
  buildControlUiUrls,
  buildOrphanedSandboxRollbackMessage,
  ensureDashboardForward,
  ensureAgentDashboardForward,
  ensureAgentFixedForward,
  fetchGatewayAuthTokenFromSandbox,
  getDashboardForwardPort,
  getWslHostAddress,
  printDashboard,
  stopAllDashboardForwards,
} = onboardDashboard.createOnboardDashboardHelpers({
  runOpenshell,
  runCaptureOpenshell,
  openshellArgv,
  runCapture,
  cliName,
  agentProductName,
  getProviderLabel,
  note,
  isWsl,
  redact,
  sleep: sleepSeconds,
  printAgentDashboardUi: agentOnboard.printDashboardUi,
});

const onboardRuntimeBoundary = new OnboardRuntimeBoundary({
  toSessionUpdates: (updates: Record<string, unknown>) =>
    toSessionUpdates(updates as Parameters<typeof toSessionUpdates>[0]),
  maybeForceE2eStepFailure,
});

const sandboxCancelRollback = installSandboxCancelRollback({ runOpenshell, registry, clearOnboardSession: onboardSession.clearSession }); // #4614

const startRecordedStep = onboardRuntimeBoundary.startRecordedStep.bind(onboardRuntimeBoundary);
const recordStepComplete = onboardRuntimeBoundary.recordStepComplete.bind(onboardRuntimeBoundary);
const recordStepSkipped = onboardRuntimeBoundary.recordStepSkipped.bind(onboardRuntimeBoundary);
const recordStepFailed = onboardRuntimeBoundary.recordStepFailed.bind(onboardRuntimeBoundary);
const recordStateSkipped = onboardRuntimeBoundary.recordStateSkipped.bind(onboardRuntimeBoundary);
const recordRepairEvent = onboardRuntimeBoundary.recordRepairEvent.bind(onboardRuntimeBoundary);
const recordPostVerifyStarted = onboardRuntimeBoundary.recordPostVerifyStarted.bind(onboardRuntimeBoundary);
const recordSessionComplete = onboardRuntimeBoundary.recordSessionComplete.bind(onboardRuntimeBoundary);

function skippedStepMessage(
  stepName: string,
  detail?: string | null,
  reason: "resume" | "reuse" = "resume",
): void {
  const progressStep = getOnboardProgressStep(stepName);
  const stepInfo =
    progressStep && stepName === "openclaw"
      ? { ...progressStep, title: `Setting up ${agentProductName()} inside sandbox` }
      : progressStep;
  if (stepInfo) {
    step(stepInfo.number, stepInfo.total, stepInfo.title);
  }
  const prefix = reason === "reuse" ? "[reuse]" : "[resume]";
  console.log(`  ${prefix} Skipping ${stepName}${detail ? ` (${detail})` : ""}`);
}

// ── Main ─────────────────────────────────────────────────────────

async function onboard(opts: OnboardOptions = {}): Promise<void> {
  setOnboardBrandingAgent(opts.agent || process.env.NEMOCLAW_AGENT || null);
  NON_INTERACTIVE = opts.nonInteractive || process.env.NEMOCLAW_NON_INTERACTIVE === "1";
  RECREATE_SANDBOX = opts.recreateSandbox || process.env.NEMOCLAW_RECREATE_SANDBOX === "1";
  AUTO_YES = opts.autoYes === true || process.env.NEMOCLAW_YES === "1";
  _preflightDashboardPort = opts.controlUiPort ?? (process.env.NEMOCLAW_DASHBOARD_PORT != null ? DASHBOARD_PORT : null);
  onboardRuntimeBoundary.reset();
  delete process.env.OPENSHELL_GATEWAY;
  const resume = opts.resume === true;
  const fresh = opts.fresh === true;
  if (resume && fresh) {
    console.error("  --resume and --fresh cannot both be set.");
    process.exit(1);
  }
  // In non-interactive mode also accept the env var so CI pipelines can set it.
  // This is the explicitly requested value; on resume it may be absent and the
  // session-recorded path is used instead (see below).
  const requestedFromDockerfile =
    opts.fromDockerfile ||
    (isNonInteractive() ? process.env.NEMOCLAW_FROM_DOCKERFILE || null : null);
  // Resolve the explicit sandbox name early so both validation and the
  // --from guard work off the same source. --name always counts; the env
  // var is used as the interactive prompt default via getSandboxPromptDefault,
  // and also as the resolved name when we cannot prompt (non-interactive or
  // missing-TTY runs such as CI scripts and piped stdin).
  const stdinIsTty = Boolean(process.stdin && process.stdin.isTTY);
  const stdoutIsTty = Boolean(process.stdout && process.stdout.isTTY);
  const cannotPrompt = isNonInteractive() || !stdinIsTty || !stdoutIsTty;
  let requestedSandboxName: string | null =
    typeof opts.sandboxName === "string" && opts.sandboxName.length > 0 ? opts.sandboxName : null;
  let requestedSandboxSource: "--name" | "NEMOCLAW_SANDBOX_NAME" | null = requestedSandboxName
    ? "--name"
    : null;
  if (!requestedSandboxName && cannotPrompt) {
    const envName = process.env.NEMOCLAW_SANDBOX_NAME;
    if (typeof envName === "string" && envName.trim().length > 0) {
      requestedSandboxName = envName.trim();
      requestedSandboxSource = "NEMOCLAW_SANDBOX_NAME";
    }
  }
  if (requestedSandboxName) {
    try {
      const validated = validateName(requestedSandboxName, "sandbox name");
      if (RESERVED_SANDBOX_NAMES.has(validated)) {
        console.error(`  Reserved name: '${validated}' is a ${cliDisplayName()} CLI command.`);
        console.error(
          `  Choose a different sandbox name (passed via ${requestedSandboxSource}) to avoid routing conflicts.`,
        );
        process.exit(1);
      }
      requestedSandboxName = validated;
    } catch (error) {
      console.error(`  ${error instanceof Error ? error.message : String(error)}`);
      for (const line of getNameValidationGuidance("sandbox name", requestedSandboxName, {
        includeAllowedFormat: false,
      })) {
        console.error(`  ${line}`);
      }
      process.exit(1);
    }
  }
  // The downstream prompt path silently defaults to 'my-assistant' when no
  // input arrives. With --from in play that would clobber the default
  // sandbox, so refuse to proceed unless the caller has supplied a name
  // out-of-band. Cover both --non-interactive and missing-TTY runs (CI
  // scripts, piped stdin) — the issue's test plan asks for both. The resume
  // case is handled separately after session load (see below) because its
  // recorded sandboxName may already satisfy the requirement.
  if (cannotPrompt && !resume && requestedFromDockerfile && !requestedSandboxName) {
    console.error(
      "  --from <Dockerfile> requires --name <sandbox> (or NEMOCLAW_SANDBOX_NAME) when running without a TTY or with --non-interactive.",
    );
    console.error("  A sandbox name cannot be prompted for in this context.");
    process.exit(1);
  }
  const noticeAccepted = await ensureUsageNoticeConsent({
    nonInteractive: isNonInteractive(),
    acceptedByFlag: opts.acceptThirdPartySoftware === true,
    writeLine: console.error,
  });
  if (!noticeAccepted) {
    process.exit(1);
  }
  // Validate NEMOCLAW_PROVIDER early so invalid values fail before
  // preflight (Docker/OpenShell checks). Without this, users see a
  // misleading 'Docker is not reachable' error instead of the real
  // problem: an unsupported provider value.
  getRequestedProviderHint();
  const lockResult = onboardSession.acquireOnboardLock(
    `nemoclaw onboard${resume ? " --resume" : ""}${fresh ? " --fresh" : ""}${isNonInteractive() ? " --non-interactive" : ""}${requestedFromDockerfile ? ` --from ${requestedFromDockerfile}` : ""}`,
  );
  if (!lockResult.acquired) {
    console.error(`  Another ${cliDisplayName()} onboarding run is already in progress.`);
    if (lockResult.holderPid) {
      console.error(`  Lock holder PID: ${lockResult.holderPid}`);
    }
    if (lockResult.holderStartedAt) {
      console.error(`  Started: ${lockResult.holderStartedAt}`);
    }
    console.error("  Wait for it to finish, or remove the stale lock if the previous run crashed:");
    console.error(`    rm -f "${lockResult.lockFile}"`);
    process.exit(1);
  }

  // Stage any pre-fix plaintext credentials.json into process.env so the
  // provider upserts later in this run can pick the values up. The file is
  // NOT removed here — the secure unlink runs only after onboarding
  // completes successfully and only when every staged value was actually
  // pushed to the gateway in this run.
  stagedLegacyValues.clear();
  migratedLegacyKeys.clear();

  const stagedLegacyKeys = stageLegacyCredentialsToEnv();
  for (const key of stagedLegacyKeys) {
    const value = process.env[key];
    if (value) stagedLegacyValues.set(key, value);
  }

  // Only carry forward migration state across processes when the user is
  // explicitly continuing the same attempt via `--resume`. Even then,
  // validate each persisted entry against the *current* staged value: if
  // the legacy file was edited between runs (so the staged secret no
  // longer matches what the gateway holds), the hash mismatch drops that
  // key from migratedLegacyKeys and the cleanup gate forces a fresh
  // upsert before the file can be removed. A fresh / non-resume run
  // ignores prior persisted state entirely so a stale or unrelated
  // session record cannot satisfy the cleanup gate.
  if (resume) {
    const previousSession = onboardSession.loadSession();
    const persistedHashes = previousSession?.migratedLegacyValueHashes ?? {};
    for (const [key, hash] of Object.entries(persistedHashes)) {
      if (typeof key !== "string" || typeof hash !== "string") continue;
      const currentValue = stagedLegacyValues.get(key);
      if (currentValue === undefined) continue;
      if (legacyValueHash(currentValue) !== hash) continue;
      migratedLegacyKeys.add(key);
    }
  }

  if (stagedLegacyKeys.length > 0) {
    console.error(
      `  Staged ${String(stagedLegacyKeys.length)} legacy credential(s) for migration to the OpenShell gateway.`,
    );
  }

  let lockReleased = false;
  const releaseOnboardLock = () => {
    if (lockReleased) return;
    lockReleased = true;
    onboardSession.releaseOnboardLock();
  };
  process.once("exit", releaseOnboardLock);

  let onboardTrace: ReturnType<typeof onboardTracing.startOnboardTrace> = { collector: null, span: null };
  let traceCompleted = false;
  try {
    onboardTrace = onboardTracing.startOnboardTrace(opts, process.env);
    let session: Session | null;
    let selectedMessagingChannels: string[] = [];
    // Merged, absolute fromDockerfile: explicit flag/env takes precedence; on
    // resume falls back to what the original session recorded so the same image
    // is used even when --from is omitted from the resume invocation.
    let fromDockerfile: string | null;
    if (resume) {
      session = onboardSession.loadSession();
      setOnboardBrandingAgent(opts.agent || session?.agent || process.env.NEMOCLAW_AGENT || null);
      if (!session || session.resumable === false) {
        console.error("  No resumable onboarding session was found.");
        console.error("  --resume only continues an interrupted onboarding run.");
        console.error("  To change configuration on an existing sandbox, rebuild it:");
        console.error(`    ${cliName()} onboard`);
        process.exit(1);
      }
      const sessionFrom = session?.metadata?.fromDockerfile || null;
      fromDockerfile = requestedFromDockerfile
        ? path.resolve(requestedFromDockerfile)
        : sessionFrom
          ? path.resolve(sessionFrom)
          : null;
      const resumeConflicts = getResumeConfigConflicts(session, {
        nonInteractive: isNonInteractive(),
        fromDockerfile: requestedFromDockerfile,
        sandboxName: requestedSandboxName,
        agent: opts.agent || null,
      });
      if (resumeConflicts.length > 0) {
        for (const conflict of resumeConflicts) {
          try { await onboardRuntimeBoundary.recordResumeConflict(conflict); } catch { /* diagnostic-only */ }
          if (conflict.field === "sandbox") {
            console.error(
              `  Resumable state belongs to sandbox '${conflict.recorded}', not '${conflict.requested}'.`,
            );
          } else if (conflict.field === "agent") {
            console.error(
              `  Session was started with agent '${conflict.recorded}', not '${conflict.requested}'.`,
            );
          } else if (conflict.field === "fromDockerfile") {
            if (!conflict.recorded) {
              console.error(
                `  Session was started without --from; add --from '${conflict.requested}' to resume it.`,
              );
            } else if (!conflict.requested) {
              console.error(
                `  Session was started with --from '${conflict.recorded}'; rerun with that path to resume it.`,
              );
            } else {
              console.error(
                `  Session was started with --from '${conflict.recorded}', not '${conflict.requested}'.`,
              );
            }
          } else {
            console.error(
              `  Resumable state recorded ${conflict.field} '${conflict.recorded}', not '${conflict.requested}'.`,
            );
          }
        }
        console.error(`  Run: ${cliName()} onboard              # start a fresh onboarding session`);
        console.error("  Or rerun with the original settings to continue that session.");
        process.exit(1);
      }
      onboardSession.updateSession((current: Session) => {
        current.mode = isNonInteractive() ? "non-interactive" : "interactive";
        current.failure = null;
        current.status = "in_progress";
        return current;
      });
      session = onboardSession.loadSession();
      // #2753: a resumed onboard whose sandbox step did not complete has no
      // recorded sandboxName (the onboard fix only persists it after
      // createSandbox succeeds). Falling through would silently default to
      // the agent's `my-assistant` instead of the user's original --name.
      // Use `cannotPrompt` so non-TTY runs without explicit --non-interactive
      // are also caught, and `requestedSandboxName` (already env-var-resolved
      // and trimmed above, lines 8302-8308) so whitespace-only env values
      // can't satisfy the guard.
      const sandboxStepCompleted = session?.steps?.sandbox?.status === "complete";
      const recoveredSandboxName =
        requestedSandboxName || (sandboxStepCompleted ? session?.sandboxName || null : null);
      if (cannotPrompt && !recoveredSandboxName) {
        console.error(
          "  Cannot resume non-interactive onboard: the previous run was interrupted before sandbox creation completed,",
        );
        console.error(
          "  so no sandbox name was recorded. Re-run with --name <sandbox> (or set NEMOCLAW_SANDBOX_NAME).",
        );
        process.exit(1);
      }
    } else {
      // --fresh asks for an explicit fresh start. createSession + saveSession
      // already overwrites any existing file, but clearing first removes the
      // old file outright so an interrupted createSession cannot leave the
      // previous session readable on disk.
      if (fresh) {
        onboardSession.clearSession();
      }
      fromDockerfile = requestedFromDockerfile ? path.resolve(requestedFromDockerfile) : null;
      session = onboardSession.saveSession(
        onboardSession.createSession({
          mode: isNonInteractive() ? "non-interactive" : "interactive",
          metadata: { gatewayName: "nemoclaw", fromDockerfile: fromDockerfile || null },
        }),
      );
    }
    await onboardRuntimeBoundary.recordOnboardStarted(resume);
    // Backstop for the resume path: a session may exist (so the early guard
    // skipped because resume === true) but never have recorded a sandboxName
    // — sandbox creation could have failed before that step ran. Without a
    // --name or env-var seed, the downstream prompt path would fall back to
    // 'my-assistant' under no TTY, exactly the silent-default the early
    // guard is meant to prevent.
    if (
      resume &&
      cannotPrompt &&
      fromDockerfile &&
      !requestedSandboxName &&
      !session?.sandboxName
    ) {
      console.error(
        "  --from <Dockerfile> requires --name <sandbox> (or NEMOCLAW_SANDBOX_NAME) when running without a TTY or with --non-interactive.",
      );
      console.error(
        "  The resumed session has no recorded sandbox name, so one cannot be inferred.",
      );
      process.exit(1);
    }

    let completed = false;
    process.once("exit", (code) => {
      if (!completed && code !== 0) {
        const current = onboardSession.loadSession();
        const failedStep = current?.lastStepStarted;
        if (failedStep) {
          onboardSession.markStepFailed(failedStep, "Onboarding exited before the step completed.");
        }
      }
    });

    const agent = await selectOnboardAgent({
      agentFlag: opts.agent,
      session,
      resume,
      canPrompt: !cannotPrompt,
    });
    const selectedAgentName = normalizeSandboxAgentName(agent?.name);
    const recordedAgentName = normalizeSandboxAgentName(session?.agent);
    let resumeAgentChanged = false;
    let forceProviderSelectionForAgentChange = false;
    if (resume && session && recordedAgentName !== selectedAgentName) {
      resumeAgentChanged = true;
      forceProviderSelectionForAgentChange = true;
      note(
        `  Agent changed from ${formatSandboxAgentName(recordedAgentName)} to ${formatSandboxAgentName(selectedAgentName)}; refreshing provider selection.`,
      );
      await stopTrackedModelRouterForAgentChange(
        session,
        loadBlueprintProfile("routed")?.router.port || 4000,
      );
      onboardSession.updateSession((current: Session) =>
        clearAgentScopedResumeState(current, selectedAgentName),
      );
    }
    setOnboardBrandingAgent(agent?.name || "openclaw");
    session = onboardSession.updateSession((s: Session) => {
      s.agent = agent?.name ?? null;
      return s;
    });

    const recordedSandboxName =
      session?.steps?.sandbox?.status === "complete" ? session?.sandboxName || null : null;
    const resumeSandboxNameForGpu = recordedSandboxName || requestedSandboxName || null;

    console.log("");
    console.log(`  ${cliDisplayName()} Onboarding`);
    if (isNonInteractive()) note("  (non-interactive mode)");
    if (resume) note("  (resume mode)");
    console.log("  ===================");

    const explicitSandboxGpuFlag = resolveSandboxGpuFlagFromOptions(opts);
    const recordedGpuPassthroughBeforePreflight = session?.gpuPassthrough === true;
    const preflightResult = await handlePreflightState({
      resume,
      session,
      recordedSandboxName,
      requestedSandboxName,
      explicitSandboxGpuFlag,
      sandboxGpuDevice: opts.sandboxGpuDevice ?? null,
      gpuRequested: opts.gpu === true,
      noGpu: opts.noGpu === true,
      env: process.env,
      deps: {
        getSandbox: registry.getSandbox.bind(registry),
        getResumeSandboxGpuOverrides,
        detectGpu: nim.detectGpu,
        runPreflight: (preflightOptions) => preflight({ ...opts, ...preflightOptions }),
        assessHost,
        assertCdiNvidiaGpuSpecPresent,
        // Resume backstops for #3508/#3630/Podman: the cached preflight
        // step does not capture host Docker/DNS state, and a session
        // written by an older NemoClaw may not have run the new bridge/
        // DNS fatal checks (mirrors the assertCdiNvidiaGpuSpecPresent
        // resume pattern). Podman rejection runs first so users on
        // unsupported runtimes don't see Docker-specific diagnostics.
        rejectUnsupportedContainerRuntime,
        assertDockerBridgeAndContainerDnsHealthy,
        resolveSandboxGpuConfig,
        validateSandboxGpuPreflight,
        skippedStepMessage,
        recordStateSkipped,
        startRecordedStep,
        recordStepComplete,
        updateSession: onboardSession.updateSession,
      },
    });
    if (resume && _preflightDashboardPort === null) preflightDashboardPortRangeAvailability(); // #3953 — resume must mirror preflight()'s fail-fast
    session = preflightResult.session;
    const {
      sandboxGpuConfig,
      resumeHasResolvedGpuIntent,
      requestedGpuPassthrough,
      gpuPassthrough,
    } = preflightResult;
    const gpu = preflightResult.gpu ?? null;
    if (gpuPassthrough) {
      note(
        formatSandboxGpuPassthroughNote({
          hostGpuPlatform: sandboxGpuConfig.hostGpuPlatform,
          resumeHasResolvedGpuIntent,
          recordedGpuPassthroughBeforePreflight,
          requestedGpuPassthrough,
          sandboxGpuMode: sandboxGpuConfig.mode,
        }),
      );
    } else if (gpu?.platform === "jetson") {
      note("  Sandbox GPU disabled by configuration on Jetson/Tegra.");
    } else if (process.platform === "linux" && !opts.noGpu) {
      try {
        const lspci = spawnSync("lspci", { encoding: "utf-8", timeout: 5000 });
        if (lspci.status === 0 && /nvidia/i.test(lspci.stdout || "")) {
          const smi = spawnSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader,nounits"], { encoding: "utf-8", timeout: 5000 });
          note(smi.status === 0 && smi.stdout?.trim() ? "  NVIDIA GPU detected with working drivers, but GPU passthrough was not enabled.\n  If Docker GPU support is needed, install nvidia-container-toolkit and run:\n  sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker" : "  NVIDIA GPU hardware detected but nvidia-smi is not available.\n  Install NVIDIA drivers and the Container Toolkit for default GPU passthrough.");
        }
      } catch {
        /* lspci not available — skip hint */
      }
    }
    dockerGpuLocalInference.configureLocalInferenceForDockerGpuHostNetwork(sandboxGpuConfig, {
      dockerDriverGateway: isLinuxDockerDriverGatewayEnabled(),
      note,
    });

    const gatewaySnapshot = selectNamedGatewayForReuseIfNeeded(getGatewayReuseSnapshot());
    const gatewayResult = await handleGatewayState({
      resume,
      session,
      initialGatewayReuseState: gatewaySnapshot.gatewayReuseState,
      gpu,
      gpuPassthrough,
      gatewayName: GATEWAY_NAME,
      recordedSandboxName,
      requestedSandboxName,
      recreateSandbox: isRecreateSandbox(),
      deps: {
        refreshDockerDriverGatewayReuseState,
        gatewayCliSupportsLifecycleCommands: () => gatewayCliSupportsLifecycleCommands(runCaptureOpenshell),
        verifyGatewayContainerRunning,
        waitForGatewayHttpReady,
        recoverGatewayRuntime,
        getGatewayLocalEndpoint,
        stopDashboardForward: () => bestEffortForwardStop(runOpenshell, DASHBOARD_PORT),
        destroyGateway,
        destroyGatewayForReuse,
        getGatewayClusterImageDrift,
        stopAllDashboardForwards,
        reconcileGatewayGpuReuseForGpuIntent,
        isLinuxDockerDriverGatewayEnabled,
        retireLegacyGatewayForDockerDriverUpgrade,
        destroyGatewayRuntimeForGpuReuse: () => destroyGateway(() => undefined, () => false),
        skippedStepMessage,
        recordStateSkipped,
        note,
        startRecordedStep,
        startGateway,
        recordStepComplete,
        exitProcess: (code) => process.exit(code),
      },
    });
    session = gatewayResult.session;

    // #2753: prefer requestedSandboxName over an unconfirmed session name.
    // A pre-fix session may carry sandboxName even though sandbox creation
    // never completed; users supplying `--name` / NEMOCLAW_SANDBOX_NAME on
    // the resume run must win, otherwise the stale name silently overrides
    // their explicit recovery input.
    let sandboxName = recordedSandboxName || requestedSandboxName || null;
    if (sandboxName && RESERVED_SANDBOX_NAMES.has(sandboxName)) {
      console.error(
        `  Reserved name in resumed session: '${sandboxName}' is a ${cliDisplayName()} CLI command.`,
      );
      console.error("  Start a fresh onboard with --name <sandbox> to choose a different name.");
      process.exit(1);
    }
    const providerInferenceResult = await handleProviderInferenceState({
      resume,
      session,
      gpu,
      sandboxName,
      agent,
      forceProviderSelection: forceProviderSelectionForAgentChange,
      initial: {
        model: session?.model || null,
        provider: session?.provider || null,
        endpointUrl: session?.endpointUrl || null,
        credentialEnv: session?.credentialEnv || null,
        hermesAuthMethod:
          normalizeHermesAuthMethod(session?.hermesAuthMethod) ||
          (session?.provider === hermesProviderAuth.HERMES_PROVIDER_NAME &&
          session?.credentialEnv === HERMES_NOUS_API_KEY_CREDENTIAL_ENV
            ? HERMES_AUTH_METHOD_API_KEY
            : null),
        hermesToolGateways: normalizeHermesToolGatewaySelections(session?.hermesToolGateways),
        preferredInferenceApi: session?.preferredInferenceApi || null,
        nimContainer: session?.nimContainer || null,
        webSearchConfig: session?.webSearchConfig || null,
      },
      selectedMessagingChannels,
      env: process.env,
      constants: {
        hermesProviderName: hermesProviderAuth.HERMES_PROVIDER_NAME,
        hermesApiKeyAuthMethod: HERMES_AUTH_METHOD_API_KEY,
        hermesApiKeyCredentialEnv: HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
      },
      deps: {
        normalizeHermesAuthMethod,
        setupNim,
        setupInference,
        startRecordedStep,
        recordStepComplete,
        toSessionUpdates: (updates) => toSessionUpdates(updates as Parameters<typeof toSessionUpdates>[0]),
        skippedStepMessage,
        ensureResumeProviderReady,
        recordStateSkipped,
        recordRepairEvent,
        hydrateCredentialEnv,
        repairLocalInferenceSystemdOverrideOrExit,
        isNonInteractive,
        getOpenshellBinary,
        needsBedrockRuntimeAdapter: (providerName, url) =>
          providerName === "compatible-anthropic-endpoint" &&
          bedrockRuntimeOnboard.needsBedrockRuntimeAdapter(url),
        isInferenceRouteReady,
        isRoutedInferenceProvider,
        reconcileModelRouter,
        reupsertRoutedProvider: (p, url, ce) => {
          const r = routedInference.upsertRoutedProvider(p, url, ce, { upsertProvider, hydrateCredentialEnv });
          return { ok: r.ok, endpointUrl: r.endpointUrl, message: r.result.message, status: r.result.status };
        },
        registryUpdateSandbox: (name, updates) => registry.updateSandbox(name, updates),
        promptValidatedSandboxName,
        assessHost,
        formatSandboxBuildEstimateNote,
        formatOnboardConfigSummary,
        promptYesNoOrDefault,
        cliName,
        log: (message) => console.log(message),
        error: (message) => console.error(message),
        exitProcess: (code) => process.exit(code),
        deleteEnv: (name) => {
          delete process.env[name];
        },
      },
    });
    session = providerInferenceResult.session;
    sandboxName = providerInferenceResult.sandboxName;
    const {
      model,
      provider,
      endpointUrl,
      credentialEnv,
      hermesAuthMethod,
      hermesToolGateways,
      preferredInferenceApi,
      nimContainer,
    } = providerInferenceResult;
    let webSearchConfig = providerInferenceResult.webSearchConfig as WebSearchConfig | null;

    const sandboxStateResult = await handleSandboxState({
      resume,
      fresh,
      resumeAgentChanged,
      session,
      sandboxName,
      model,
      provider,
      nimContainer,
      webSearchConfig,
      selectedMessagingChannels,
      fromDockerfile,
      agent,
      gpu,
      preferredInferenceApi,
      sandboxGpuConfig,
      hermesToolGateways,
      controlUiPort: opts.controlUiPort || null,
      rootDir: ROOT,
      deps: {
        resolvePath: path.resolve,
        agentSupportsWebSearch,
        note,
        updateSession: onboardSession.updateSession,
        getStoredMessagingChannelConfig,
        hydrateMessagingChannelConfig,
        messagingChannelConfigsEqual,
        persistMessagingChannelConfigToSession,
        getSandboxReuseState,
        computeTelegramRequireMention,
        hasSandboxGpuDrift,
        hasWechatConfigDrift,
        getSandboxHermesToolGateways: (name) => registry.getSandbox(name)?.hermesToolGateways,
        normalizeHermesToolGatewaySelections,
        stringSetsEqual,
        removeSandboxFromRegistry: registry.removeSandbox.bind(registry),
        repairRecordedSandbox,
        ensureValidatedBraveSearchCredential,
        isBackToSelection,
        configureWebSearch,
        startRecordedStep,
        getRecordedMessagingChannelsForResume,
        getSandboxMessagingChannels: (name) => registry.getSandbox(name)?.messagingChannels,
        setupMessagingChannels,
        readMessagingChannelConfigFromEnv,
        promptValidatedSandboxName,
        selectResourceProfileForSandbox: () => selectResourceProfileForSandbox({ isNonInteractive, note, prompt, promptOrDefault }),
        stopStaleDashboardListenersForSandbox,
        listRegistrySandboxes: registry.listSandboxes,
        createSandbox,
        updateSandboxRegistry: (name, updates) => registry.updateSandbox(name, updates),
        getSandboxAgentRegistryFields,
        recordStepComplete,
        toSessionUpdates: (updates) => toSessionUpdates(updates as Parameters<typeof toSessionUpdates>[0]),
        skippedStepMessage,
        recordStateSkipped,
        recordRepairEvent,
        error: (message) => console.error(message),
        exitProcess: (code) => process.exit(code),
      },
    });
    session = sandboxStateResult.session;
    sandboxName = sandboxStateResult.sandboxName;
    webSearchConfig = sandboxStateResult.webSearchConfig ?? null;
    selectedMessagingChannels = sandboxStateResult.selectedMessagingChannels;
    const webSearchSupported = sandboxStateResult.webSearchSupported;

    const agentSetupResult = await handleAgentSetupState({
      agent,
      sandboxName,
      model,
      provider,
      resume,
      session,
      hermesAuthMethod,
      hermesToolGateways,
      deps: {
        handleAgentSetup: agentOnboard.handleAgentSetup,
        agentSetupContext: () => ({
          step,
          runCaptureOpenshell,
          openshellShellCommand,
          openshellBinary: getOpenshellBinary(),
          buildSandboxConfigSyncScript,
          writeSandboxConfigSyncFile,
          cleanupTempDir,
          startRecordedStep,
          recordStepComplete,
          recordStepFailed,
          skippedStepMessage,
        }),
        ensureAgentDashboardForward,
        recordStepSkipped,
        isOpenclawReady,
        skippedStepMessage,
        recordStateSkipped,
        startRecordedStep,
        setupOpenclaw,
        syncNemoClawConfigInSandbox,
        recordStepComplete,
        toSessionUpdates: (updates) => toSessionUpdates(updates as Parameters<typeof toSessionUpdates>[0]),
      },
    });
    session = agentSetupResult.session;

    const policiesResult = await handlePoliciesState({
      resume,
      sandboxName,
      provider,
      model,
      endpointUrl,
      credentialEnv,
      selectedMessagingChannels,
      webSearchConfig,
      webSearchSupported,
      hermesToolGateways,
      agent,
      deps: {
        loadSession: onboardSession.loadSession,
        getActiveSandbox: (name) => registry.getSandbox(name),
        mergePolicyMessagingChannels,
        verifyCompatibleEndpointSandboxSmoke: (options) =>
          verifyCompatibleEndpointSandboxSmoke({
            ...options,
            runOpenshell,
            redact,
          }),
        preparePolicyPresetResumeSelection: (name, options) =>
          preparePolicyPresetResumeSelection({ policies }, name, options),
        arePolicyPresetsApplied,
        skippedStepMessage,
        recordStateSkipped,
        startRecordedStep,
        setupPoliciesWithSelection,
        updateSession: onboardSession.updateSession,
        recordStepComplete,
        toSessionUpdates: (updates) => toSessionUpdates(updates as Parameters<typeof toSessionUpdates>[0]),
        persistAppliedPolicyPresets: policyPresetCarry.persistFinalizedPolicyPresets,
      },
    });
    session = policiesResult.session;
    sandboxCancelRollback.disarm(); // #4614: policies confirmed, past the cancellable window

    await handleFinalizationState({
      sandboxName,
      model,
      provider,
      nimContainer,
      agent,
      hermesAuthMethod,
      hermesToolGateways,
      stagedLegacyKeys,
      migratedLegacyKeys,
      webSearchEnabled: braveProviderProfile.shouldEnableBraveWebSearch(webSearchConfig),
      deps: {
        ensureAgentDashboardForward,
        setDefaultSandbox: registry.setDefault,
        verifyWebSearchInsideSandbox,
        recordPostVerifyStarted,
        recordSessionComplete,
        toSessionUpdates: (updates) => toSessionUpdates(updates as Parameters<typeof toSessionUpdates>[0]),
        removeLegacyCredentialsFile,
        cleanupStaleHostFiles,
        checkAndRecoverSandboxProcesses: (name, options) => {
          const processRecovery: typeof import("./actions/sandbox/process-recovery") =
            require("./actions/sandbox/process-recovery");
          processRecovery.checkAndRecoverSandboxProcesses(name, options);
        },
        getChatUiUrl: () => process.env.CHAT_UI_URL || `http://127.0.0.1:${DASHBOARD_PORT}`,
        buildVerifyChain: (chatUiUrl) =>
          buildChain({ chatUiUrl, isWsl: isWsl(), wslHostAddress: getWslHostAddress() }),
        verifyDeployment: async (name, chain) => {
          const verifyDeploymentModule: typeof import("./verify-deployment") = require("./verify-deployment");
          return verifyDeploymentModule.verifyDeployment(name, chain, {
            executeSandboxCommand: executeSandboxCommandForVerification,
            probeHostPort: (port: number, probePath: string) => {
              const result = runCapture(
                ["curl", "-so", "/dev/null", "-w", "%{http_code}", "--max-time", "3", `http://127.0.0.1:${port}${probePath}`],
                { ignoreError: true },
              );
              return parseInt(result.trim(), 10) || 0;
            },
            captureForwardList: () => runCaptureOpenshell(["forward", "list"], { ignoreError: true }) || null,
            getMessagingChannels: () => selectedMessagingChannels || [],
            providerExistsInGateway: (providerName: string) => providerExistsInGateway(providerName),
            probeChannelRuntimeStatus: require("./onboard/verify-channel-runtime").buildOnboardChannelRuntimeProbe(agent, name),
          });
        },
        formatVerificationDiagnostics: (result) => {
          const verifyDeploymentModule: typeof import("./verify-deployment") = require("./verify-deployment");
          return verifyDeploymentModule.formatVerificationDiagnostics(result);
        },
        printDashboard,
        error: (message) => console.error(message),
        log: (message) => console.log(message),
      },
    });
    traceCompleted = true;
  } finally {
    releaseOnboardLock();
    onboardRuntimeBoundary.clear();
    onboardTracing.finishOnboardTrace(onboardTrace, traceCompleted);
  }
}

module.exports = {
  buildOrphanedSandboxRollbackMessage,
  buildProviderArgs,
  buildGatewayBootstrapSecretsScript,
  buildCompatibleEndpointSandboxSmokeCommand,
  buildCompatibleEndpointSandboxSmokeScript,
  buildSandboxConfigSyncScript,
  buildSandboxGpuCreateArgs,
  buildDirectGpuPolicyYaml,
  buildDirectSandboxGpuProofCommands,
  compactText,
  copyBuildContextDir,
  classifySandboxCreateFailure,
  configureWebSearch,
  createSandbox,
  ensureValidatedBraveSearchCredential,
  formatEnvAssignment,
  getFutureShellPathHint,
  areRequiredDockerDriverBinariesPresent,
  ensureOpenshellForOnboard,
  shouldRequireDockerDriverEnv,
  getGatewayBootstrapRepairPlan,
  getGatewayLocalEndpoint,
  getGatewayStartEnv,
  getDockerDriverGatewayEnv,
  getDockerDriverGatewayRuntimeDriftFromSnapshot,
  getGatewayClusterContainerState,
  getGatewayHealthWaitConfig,
  getGatewayReuseHealthWaitConfig,
  getGatewayReuseState,
  isDockerDriverGatewayPortListener,
  isDockerDriverGatewayHttpReady,
  isGatewayHttpReady,
  waitForGatewayHttpReady,
  handleFinalGatewayStartFailure,
  getNavigationChoice,
  getSandboxInferenceConfig,
  getInstalledOpenshellVersion,
  getBlueprintMinOpenshellVersion,
  getBlueprintMaxOpenshellVersion,
  isLinuxDockerDriverGatewayEnabled,
  findReadableNvidiaCdiSpecFiles,
  parseDockerCdiSpecDirs,
  getResumeSandboxGpuOverrides,
  getSandboxReadyTimeoutSecs,
  resolveSandboxGpuConfig,
  shouldAllowOpenshellAboveBlueprintMax,
  pullAndResolveBaseImageDigest,
  SANDBOX_BASE_IMAGE,
  SANDBOX_BASE_TAG,
  versionGte,
  getRequestedModelHint,
  getRequestedProviderHint,
  getStableGatewayImageRef,
  getResumeConfigConflicts,
  isGatewayHealthy,
  hasStaleGateway,
  getRequestedSandboxNameHint,
  getResumeSandboxConflict,
  clearAgentScopedResumeState,
  getSandboxReuseState,
  getSandboxStateFromOutputs,
  getPortConflictServiceHints,
  classifyValidationFailure,
  isSandboxReady,
  isLoopbackHostname,
  normalizeProviderBaseUrl,
  onboard,
  onboardSession,
  printSandboxCreateRecoveryHints,
  promptYesNoOrDefault,
  providerExistsInGateway,
  parsePolicyPresetEnv,
  parseSandboxStatus,
  pruneStaleSandboxEntry,
  repairRecordedSandbox,
  recoverGatewayRuntime,
  buildChain,
  buildControlUiUrls,

  startGateway,
  findAvailableDashboardPort,
  startGatewayForRecovery,
  openshellArgv,
  runCaptureOpenshell,
  agentSupportsWebSearch,
  setupInference,
  setupMessagingChannels,
  MESSAGING_CHANNELS,
  selectOnboardAgent,
  setupNim,
  providerNameToOptionKey: (name: string | null | undefined, opts: { hasNimContainer?: boolean } = {}) => providerRecovery.providerNameToOptionKey(REMOTE_PROVIDER_CONFIG, name, opts),
  readRecordedProvider,
  readRecordedModel,
  readRecordedNimContainer,
  isInferenceRouteReady,
  shouldRunCompatibleEndpointSandboxSmoke,
  isNonInteractive,
  isOpenclawReady,
  arePolicyPresetsApplied,
  getSuggestedPolicyPresets,
  computeSetupPresetSuggestions,
  mergeRequiredHermesToolGatewayPolicyPresets,
  filterSetupPolicyPresets: policies.filterSetupPolicyPresets,
  LOCAL_INFERENCE_PROVIDERS,
  presetsCheckboxSelector,
  selectPolicyTier,
  selectTierPresetsAndAccess,
  setupPoliciesWithSelection,
  summarizeCurlFailure,
  summarizeProbeFailure,
  hasResponsesToolCall,
  hasChatCompletionsToolCall,
  hasChatCompletionsToolCallLeak,
  upsertProvider,
  normalizeHermesAuthMethod,
  hashCredential,
  detectMessagingCredentialRotation,
  getDefaultSandboxNameForAgent,
  getSandboxPromptDefault,
  getRequestedSandboxAgentName,
  normalizeSandboxAgentName,
  hydrateCredentialEnv,
  pruneKnownHostsEntries,
  shouldIncludeBuildContextPath,
  writeSandboxConfigSyncFile,
  patchStagedDockerfile,
  ensureOllamaAuthProxy,
  fetchGatewayAuthTokenFromSandbox,
  getProbeAuthMode,
  getValidationProbeCurlArgs,
  checkTelegramReachability,
  TELEGRAM_NETWORK_CURL_CODES,
  verifyCompatibleEndpointSandboxSmoke,
  resumeProviderShimDeps: { isRoutedInferenceProvider, replaceNamedCredential },
};
