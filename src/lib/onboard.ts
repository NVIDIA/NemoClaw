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
const {
  createOnboardAgentSelector,
}: typeof import("./onboard/agent-selection") = require("./onboard/agent-selection");
const {
  createInferenceSelectionValidationHelpers,
}: typeof import("./onboard/inference-selection-validation") = require("./onboard/inference-selection-validation");
const {
  applyCloudFallbackSelection,
  clearNimContainerBeforeRetry,
  createNvidiaFeaturedModelSession,
  createRemoteModelValidator,
  resolveCompatibleEndpointInput,
}: typeof import("./onboard/setup-nim-selection") = require("./onboard/setup-nim-selection");
const setupNimFlow: typeof import("./onboard/setup-nim-flow") = require("./onboard/setup-nim-flow");
const setupNimOllama: typeof import("./onboard/setup-nim-ollama") = require("./onboard/setup-nim-ollama");
const inferenceInputCapability = require("./onboard/inference-input-capability");
const reasoningMode: typeof import("./onboard/reasoning-mode") = require("./onboard/reasoning-mode");
const toolDisclosureFlow: typeof import("./onboard/tool-disclosure-flow") = require("./onboard/tool-disclosure-flow");
const inferenceRouteHelpers: typeof import("./onboard/inference-route") = require("./onboard/inference-route");
const { cleanupTempDir }: typeof import("./onboard/temp-files") = require("./onboard/temp-files");
const {
  abortNonInteractive,
}: typeof import("./onboard/non-interactive-abort") = require("./onboard/non-interactive-abort");
const { stopStaleDashboardListenersForSandbox } = require("./onboard/stale-gateway-cleanup");
const extraPlaceholderKeysModule: typeof import("./onboard/extra-placeholder-keys") = require("./onboard/extra-placeholder-keys");
const preparedDcodeRebuild: typeof import("./onboard/prepared-dcode-rebuild") = require("./onboard/prepared-dcode-rebuild");
const sandboxBuildPatchConfig: typeof import("./onboard/sandbox-build-patch-config") = require("./onboard/sandbox-build-patch-config");
const baseImageResolutionFlow: typeof import("./onboard/base-image-resolution-flow") = require("./onboard/base-image-resolution-flow");
const sandboxMessagingPreflight: typeof import("./onboard/sandbox-messaging-preflight") = require("./onboard/sandbox-messaging-preflight");
const sandboxCreatePlan: typeof import("./onboard/sandbox-create-plan") = require("./onboard/sandbox-create-plan");
const sandboxCreateLaunch: typeof import("./onboard/sandbox-create-launch") = require("./onboard/sandbox-create-launch");
const onboardEntryOptions: typeof import("./onboard/entry-options") = require("./onboard/entry-options");
const onboardSessionBootstrap: typeof import("./onboard/session-bootstrap") = require("./onboard/session-bootstrap");
const channelState: typeof import("./onboard/channel-state") = require("./onboard/channel-state");
const {
  ensureOllamaLoopbackSystemdOverride,
}: typeof import("./onboard/ollama-systemd") = require("./onboard/ollama-systemd");
const { bestEffortForwardStop } = require("./onboard/forward-cleanup");
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
const dockerDriverGatewayRuntime: typeof import("./onboard/docker-driver-gateway-runtime") = require("./onboard/docker-driver-gateway-runtime");
const dockerDriverGatewayCutover: typeof import("./onboard/docker-driver-gateway-cutover") = require("./onboard/docker-driver-gateway-cutover");
const { reapHostGatewayBeforeLaunchOrFail, reapDuplicateHostGatewaysExceptOrFail } =
  require("./onboard/docker-driver-gateway-prelaunch") as typeof import("./onboard/docker-driver-gateway-prelaunch");
const {
  findReadableNvidiaCdiSpecFiles,
  parseDockerCdiSpecDirs,
}: typeof import("./onboard/docker-cdi") = require("./onboard/docker-cdi");
const {
  buildSandboxGpuCreateArgs,
  getSandboxReadyTimeoutSecs,
}: typeof import("./onboard/sandbox-gpu-create") = require("./onboard/sandbox-gpu-create");
const {
  appendResourceFlagsForProfile,
  selectResourceProfileForSandbox,
}: typeof import("./onboard/resource-profile-selection") = require("./onboard/resource-profile-selection");
const {
  patchStagedDockerfile,
}: typeof import("./onboard/dockerfile-patch") = require("./onboard/dockerfile-patch");
const {
  agentSupportsWebSearch,
  agentSupportsWebSearchProvider,
}: typeof import("./onboard/web-search-support") = require("./onboard/web-search-support");
const onboardDashboard: typeof import("./onboard/dashboard") = require("./onboard/dashboard");
const dashboardRuntime: typeof import("./onboard/dashboard-runtime") = require("./onboard/dashboard-runtime");
const {
  buildGatewayBootstrapSecretsScript,
  createGatewayBootstrapRepairHelpers,
  getGatewayBootstrapRepairPlan,
}: typeof import("./onboard/gateway-bootstrap") = require("./onboard/gateway-bootstrap");
const {
  buildDirectGpuPolicyYaml,
  buildDirectSandboxGpuProofCommands,
}: typeof import("./onboard/initial-policy") = require("./onboard/initial-policy");
const {
  getSelectionDrift,
}: typeof import("./onboard/selection-drift") = require("./onboard/selection-drift");
const {
  getDcodeSelectionDrift,
  requiresSelectionRecreate,
  usesManagedDcodeIdentity,
}: typeof import("./onboard/dcode-selection-drift") = require("./onboard/dcode-selection-drift");
const {
  finalizeCreatedSandbox,
}: typeof import("./onboard/created-sandbox-finalization") = require("./onboard/created-sandbox-finalization");
const providerKeyBridge: typeof import("./onboard/provider-key-bridge") = require("./onboard/provider-key-bridge");
const {
  isLinuxDockerDriverGatewayEnabled,
}: typeof import("./onboard/docker-driver-platform") = require("./onboard/docker-driver-platform");
const {
  reconcileGatewayGpuReuseForGpuIntent,
}: typeof import("./onboard/gateway-gpu-passthrough") = require("./onboard/gateway-gpu-passthrough");
const {
  syncPresetSelection,
}: typeof import("./onboard/policy-preset-sync") = require("./onboard/policy-preset-sync");
const {
  maybeForceE2eStepFailure,
}: typeof import("./onboard/e2e-failure-injection") = require("./onboard/e2e-failure-injection");
const onboardTracing: typeof import("./onboard/tracing") = require("./onboard/tracing");
const sandboxReadinessTracing: typeof import("./onboard/sandbox-readiness-tracing") = require("./onboard/sandbox-readiness-tracing");
const {
  setupMessagingChannels: setupMessagingChannelsImpl,
  readMessagingPlanFromEnv,
  writePlanToEnv,
  clearPlanEnv,
  getRegistrySandboxMessagingPlan,
  MessagingHostStateApplier,
} = require("./onboard/messaging-channel-setup") as typeof import("./onboard/messaging-channel-setup");
const {
  clearAgentScopedResumeState,
}: typeof import("./onboard/agent-resume-state") = require("./onboard/agent-resume-state");
const {
  repairResumeMachineSnapshot,
}: typeof import("./onboard/resume-machine-repair") = require("./onboard/resume-machine-repair");
const {
  stopTrackedModelRouterForAgentChange,
}: typeof import("./onboard/model-router-process") = require("./onboard/model-router-process");
const bedrockRuntimeOnboard: typeof import("./onboard/bedrock-runtime") =
  require("./onboard/bedrock-runtime");
const {
  installOllamaOnLinux,
}: typeof import("./onboard/install-ollama-linux") = require("./onboard/install-ollama-linux");
const {
  installOllamaOnMacOS,
}: typeof import("./onboard/install-ollama-macos") = require("./onboard/install-ollama-macos");
const {
  OllamaProbeFailureTracker,
}: typeof import("./onboard/ollama-probe-failure-tracker") = require("./onboard/ollama-probe-failure-tracker");
const crypto = require("node:crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const pRetry = require("p-retry");

const runner: typeof import("./runner") = require("./runner");
const { ROOT, SCRIPTS, redact, run, runCapture, runCaptureEx, runFile, validateName } = runner;
const braveProviderProfile: typeof import("./onboard/brave-provider-profile") = require("./onboard/brave-provider-profile");
const { runSandboxProviderPreDeleteCleanup } =
  require("./onboard/sandbox-provider-cleanup") as typeof import("./onboard/sandbox-provider-cleanup");
const nameValidation: typeof import("./name-validation") = require("./name-validation");
const { getNameValidationGuidance } = nameValidation;
const docker: typeof import("./adapters/docker") = require("./adapters/docker");
const {
  dockerContainerInspectFormat,
  dockerExecArgv,
  dockerInfoFormat,
  dockerInspect,
  dockerRemoveVolumesByPrefix,
  dockerRm,
  dockerRmi,
  dockerStop,
} = docker;
const gatewayDrift: typeof import("./adapters/openshell/gateway-drift") = require("./adapters/openshell/gateway-drift");
const {
  getGatewayClusterContainerName,
  getGatewayClusterImageDrift: getGatewayClusterImageDriftForName,
} = gatewayDrift;
const sandboxBaseImage: typeof import("./sandbox-base-image") = require("./sandbox-base-image");
const { OPENCLAW_SANDBOX_BASE_IMAGE: SANDBOX_BASE_IMAGE, SANDBOX_BASE_TAG } = sandboxBaseImage;
const {
  getStableGatewayImageRef,
  pullAndResolveBaseImageDigest,
}: typeof import("./onboard/base-image") = require("./onboard/base-image");
const { requireValue }: typeof import("./core/require-value") = require("./core/require-value");
const buildCredentialReuse: typeof import("./onboard/build-credential-reuse") = require("./onboard/build-credential-reuse");
const recoveredProviderReuse: typeof import("./onboard/recovered-provider-reuse") = require("./onboard/recovered-provider-reuse");

type RunnerOptions = {
  env?: NodeJS.ProcessEnv;
  stdio?: import("node:child_process").StdioOptions;
  ignoreError?: boolean;
  suppressOutput?: boolean;
  timeout?: number;
  openshellBinary?: string;
};

const {
  DASHBOARD_PORT,
  GATEWAY_PORT: DEFAULT_GATEWAY_PORT,
  VLLM_PORT,
  OLLAMA_PORT,
  OLLAMA_PROXY_PORT,
} = require("./core/ports");
const localInference: typeof import("./inference/local") = require("./inference/local");
const {
  resetOllamaHostCache,
  getLocalProviderBaseUrl,
  getLocalProviderHealthCheck,
  getLocalProviderValidationBaseUrl,
  getOllamaModelOptions,
  getOllamaWarmupCommand,
  validateLocalProvider,
} = localInference;
const {
  checkOllamaPortsOrWarn,
  assertOllamaUpgradeApplied,
} = require("./onboard/ollama-install-menu");
const {
  detectInferenceProviderHostState,
}: typeof import("./onboard/provider-host-state") = require("./onboard/provider-host-state");
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
const { installVllm } = require("./inference/vllm");
const inferenceConfig: typeof import("./inference/config") = require("./inference/config");
const { DEFAULT_CLOUD_MODEL, getProviderSelectionConfig, parseGatewayInference } = inferenceConfig;

const onboardProviders = require("./onboard/providers");
const inferenceProviders: typeof import("./onboard/inference-providers") = require("./onboard/inference-providers");
const setupInferenceFactory: typeof import("./onboard/setup-inference") =
  require("./onboard/setup-inference");
const resumeProviderShim = require("./onboard/resume-provider-shim");
const hermesProviderAuth = require("./hermes-provider-auth");
const onboardHermesDashboard: typeof import("./onboard/hermes-dashboard") = require("./onboard/hermes-dashboard");
const hermesAuth: typeof import("./onboard/hermes-auth") = require("./onboard/hermes-auth");
const { warnIfLandlockUnsupported } = require("./onboard/landlock-warning");
const {
  HERMES_AUTH_METHOD_API_KEY,
  HERMES_AUTH_METHOD_OAUTH,
  HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
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
  getNonInteractiveProvider: (allowHostedInferenceStaging?: boolean) => string | null;
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
const { sleepSeconds, waitUntil } = require("./core/wait");
const platformUtils: typeof import("./platform") = require("./platform");
const { isWsl, shouldPatchCoredns } = platformUtils;
const {
  getContainerRuntime,
  repairLocalInferenceSystemdOverrideOrExit,
  rejectUnsupportedWindowsHostOllama,
  shouldFrontOllamaWithProxy,
}: typeof import("./onboard/local-inference-topology") = require("./onboard/local-inference-topology");
const {
  waitForGatewayHealth,
}: typeof import("./onboard/gateway-health-wait") = require("./onboard/gateway-health-wait");
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
const {
  hashCredential,
}: typeof import("./security/credential-hash") = require("./security/credential-hash");
const {
  cleanupStaleHostFiles,
}: typeof import("./host-artifact-cleanup") = require("./host-artifact-cleanup");
const registry: typeof import("./state/registry") = require("./state/registry");
const sandboxMutationLock: typeof import("./state/mcp-lifecycle-lock") =
  require("./state/mcp-lifecycle-lock");
const { resolveSandboxImageTagFromCreateOutput } =
  require("./domain/sandbox/image-tag") as typeof import("./domain/sandbox/image-tag");
const nim: typeof import("./inference/nim") = require("./inference/nim");
const onboardSession: typeof import("./state/onboard-session") = require("./state/onboard-session");
const {
  registerIncompleteOnboardExitHandlerForSession,
}: typeof import("./onboard/onboard-exit-handler") = require("./onboard/onboard-exit-handler");
const {
  getFutureShellPathHint,
  getPortConflictServiceHints,
}: typeof import("./onboard/remediation") = require("./onboard/remediation");
const resumeConfig: typeof import("./onboard/resume-config") = require("./onboard/resume-config");
const {
  getRequestedModelHint,
  getRequestedProviderHint,
  getRequestedSandboxNameHint,
  getResumeConfigConflicts,
  getResumeSandboxConflict,
} = resumeConfig;
const {
  pruneKnownHostsEntries,
}: typeof import("./onboard/known-hosts") = require("./onboard/known-hosts");
const {
  exitOnboardFromPrompt,
  getNavigationChoice,
  isAffirmativeAnswer,
  selectFromNumberedMenuOrExit,
  step,
  ...onboardPromptHelpers
}: typeof import("./onboard/prompt-helpers") = require("./onboard/prompt-helpers");
const providerRecovery: typeof import("./onboard/provider-recovery") = require("./onboard/provider-recovery");
const {
  createOpenclawSetup,
}: typeof import("./onboard/openclaw-setup") = require("./onboard/openclaw-setup");
const {
  createWebSearchFlowHelpers,
}: typeof import("./onboard/web-search-flow") = require("./onboard/web-search-flow");
const {
  createValidationRecoveryPromptHelpers,
}: typeof import("./onboard/validation-recovery-prompt") = require("./onboard/validation-recovery-prompt");
const {
  createOpenshellCliHelpers,
}: typeof import("./onboard/openshell-cli") = require("./onboard/openshell-cli");
const sandboxGpuPreflight: typeof import("./onboard/sandbox-gpu-preflight") = require("./onboard/sandbox-gpu-preflight");
const { resolveSandboxGpuFlagFromOptions, validateSandboxGpuPreflight } = sandboxGpuPreflight;
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
const { BACK_TO_SELECTION, createCredentialPromptHelpers, isBackToSelection } =
  credentialNavigation;
const {
  toSessionUpdates,
}: typeof import("./onboard/session-updates") = require("./onboard/session-updates");
const gatewayReuse: typeof import("./onboard/gateway-reuse") = require("./onboard/gateway-reuse");
const messagingConfig: typeof import("./onboard/messaging-config") = require("./onboard/messaging-config");
const {
  detectMessagingCredentialRotation,
  getMessagingChannelForEnvKey,
  getRecordedMessagingChannelsForResume: getRecordedMessagingChannelsForResumeFromState,
}: typeof import("./onboard/messaging-credentials") = require("./onboard/messaging-credentials");
const { getStoredMessagingChannelConfig, messagingChannelConfigsEqual } = messagingConfig;
const messagingPlanSession: typeof import("./onboard/messaging-plan-session") =
  require("./onboard/messaging-plan-session");
const { getChannelsFromPlan } = messagingPlanSession;
const sandboxAgent: typeof import("./onboard/sandbox-agent") = require("./onboard/sandbox-agent");
const sandboxLifecycle: typeof import("./onboard/sandbox-lifecycle") = require("./onboard/sandbox-lifecycle");
const sandboxRegistryMetadata: typeof import("./onboard/sandbox-registry-metadata") = require("./onboard/sandbox-registry-metadata");
const sandboxReuse: typeof import("./onboard/sandbox-reuse") = require("./onboard/sandbox-reuse");
const sandboxRegistration: typeof import("./onboard/sandbox-registration") =
  require("./onboard/sandbox-registration");
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
const {
  OnboardRuntimeBoundary,
}: typeof import("./onboard/runtime-boundary") = require("./onboard/runtime-boundary");
const {
  installSandboxCancelRollback,
  makeOnboardCancelExit,
  wasSandboxDefault,
  restoreDefaultAfterRecreate,
}: typeof import("./onboard/cancel-rollback") = require("./onboard/cancel-rollback");
const {
  createCoreOnboardFlowPhases,
  runCoreOnboardFlowSlice,
}: typeof import("./onboard/machine/core-flow-phases") = require("./onboard/machine/core-flow-phases");
const {
  createFinalOnboardFlowPhases,
  runFinalOnboardFlowSlice,
}: typeof import("./onboard/machine/final-flow-phases") = require("./onboard/machine/final-flow-phases");
const {
  createInitialOnboardFlowPhases,
  runInitialOnboardFlowSlice,
}: typeof import("./onboard/machine/initial-flow-phases") = require("./onboard/machine/initial-flow-phases");
const {
  advanceTo,
}: typeof import("./onboard/machine/result") = require("./onboard/machine/result");
const { skippedStepMessage }: typeof import("./onboard/skipped-step-message") =
  require("./onboard/skipped-step-message");
const policies: typeof import("./policy") = require("./policy");
const policyPresetCarry: typeof import("./onboard/policy-preset-persistence") = require("./onboard/policy-preset-persistence");
const tiers: typeof import("./policy/tiers") = require("./policy/tiers");
const policyTierEnv: typeof import("./onboard/policy-tier-env") = require("./onboard/policy-tier-env");
const { ensureUsageNoticeConsent } = require("./onboard/usage-notice");
const {
  findAvailableDashboardPort,
  preflightDashboardPortRangeAvailability,
  resolveCreateSandboxDashboardPort,
} = require("./onboard/dashboard-port") as typeof import("./onboard/dashboard-port");
const authoritativeRebuildTarget: typeof import("./onboard/authoritative-rebuild-target") =
  require("./onboard/authoritative-rebuild-target");
const { assertDashboardPortNotReserved, buildRequiredPreflightPorts } =
  require("./onboard/preflight-ports") as typeof import("./onboard/preflight-ports");
const { tryCleanupOrphanedDashboardForward } =
  require("./onboard/orphaned-dashboard-forward") as typeof import("./onboard/orphaned-dashboard-forward");
const { destroyGatewayForReuse } =
  require("./onboard/gateway-cleanup") as typeof import("./onboard/gateway-cleanup");
const { applyPreflightGatewayCleanup } =
  require("./onboard/preflight-gateway-cleanup-decision") as typeof import("./onboard/preflight-gateway-cleanup-decision");
const { verifyGatewayContainerRunning } =
  require("./onboard/gateway-container-running") as typeof import("./onboard/gateway-container-running");
const { applyHealthyPortReuse } =
  require("./onboard/gateway-stale-port-reuse") as typeof import("./onboard/gateway-stale-port-reuse");
const { destroyGatewayWithVolumeCleanup } =
  require("./onboard/gateway-destroy") as typeof import("./onboard/gateway-destroy");
const { gatewayCliSupportsLifecycleCommands } =
  require("./onboard/gateway-lifecycle") as typeof import("./onboard/gateway-lifecycle");
const { reconcilePreflightGatewayReuseState } =
  require("./onboard/preflight-gateway-reuse") as typeof import("./onboard/preflight-gateway-reuse");
const {
  getGatewayReuseHealthWaitConfig,
  isDockerDriverGatewayHttpReady: probeDockerDriverGatewayHttpReady,
  isGatewayHttpReady: probeGatewayHttpReady,
  waitForGatewayHttpReady: waitForGatewayHttpReadyBase,
} = require("./onboard/gateway-http-readiness") as typeof import("./onboard/gateway-http-readiness");
const { isGatewayTcpReady: probeGatewayTcpReady } =
  require("./onboard/gateway-tcp-readiness") as typeof import("./onboard/gateway-tcp-readiness");
const { trackChildExit } =
  require("./onboard/child-exit-tracker") as typeof import("./onboard/child-exit-tracker");
const { reportDockerDriverGatewayStartFailure } =
  require("./onboard/docker-driver-gateway-failure") as typeof import("./onboard/docker-driver-gateway-failure");
const { createFinalGatewayStartFailureHandler, reportLegacyGatewayStartResultFailure } =
  require("./onboard/gateway-start-failure") as typeof import("./onboard/gateway-start-failure");
const dockerDriverGatewayEnv: typeof import("./onboard/docker-driver-gateway-env") =
  require("./onboard/docker-driver-gateway-env");
const dockerDriverGatewayRuntimeMarker: typeof import("./onboard/docker-driver-gateway-runtime-marker") =
  require("./onboard/docker-driver-gateway-runtime-marker");
const gatewayBinding: typeof import("./onboard/gateway-binding") = require("./onboard/gateway-binding");
const fatalRuntimePreflight: typeof import("./onboard/fatal-runtime-preflight") =
  require("./onboard/fatal-runtime-preflight");
const preflightUtils: typeof import("./onboard/preflight") = require("./onboard/preflight");
const clusterImagePatch: typeof import("./cluster-image-patch") = require("./cluster-image-patch");
const overlayfsAutoFix: typeof import("./onboard/overlayfs-auto-fix") = require("./onboard/overlayfs-auto-fix");
const { assessHost, checkPortAvailable, ensureSwap, getMemoryInfo } = preflightUtils;
const {
  assertDockerBridgeAndContainerDnsHealthy,
}: typeof import("./onboard/bridge-dns-preflight") = require("./onboard/bridge-dns-preflight");
const agentOnboard = require("./agent/onboard");
const agentDefs = require("./agent/defs");

const gatewayState: typeof import("./state/gateway") = require("./state/gateway");
const notReadyRecreate: typeof import("./onboard/not-ready-recreate") = require("./onboard/not-ready-recreate");
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
} from "./messaging-channel-config";
import { finalizationHandlerDeps } from "./onboard/finalization-deps";
import { streamGatewayStart } from "./onboard/gateway";
import {
  mergeRequiredHermesToolGatewayPolicyPresets,
  normalizeHermesToolGatewaySelections,
  setupHermesToolGateways,
  stringSetsEqual,
} from "./onboard/hermes-managed-tools";
import { mergePolicyMessagingChannels } from "./onboard/messaging-policy-presets";
import { filterEnabledChannelsByAgent } from "./onboard/messaging-state";
import { getValidatedMessagingTokenByEnvKey } from "./onboard/messaging-token";
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
import { createPolicySelectionPromptHelpers } from "./onboard/policy-selection-prompts";
import {
  printLowMemoryWarning,
  printMessagingProviderMissing,
  printSwapCreationFailed,
} from "./onboard/preflight-messages";
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
import { formatOnboardConfigSummary, formatSandboxBuildEstimateNote } from "./onboard/summary";
import type {
  ModelValidationResult,
  OnboardOptions as SharedOnboardOptions,
  ValidationFailureLike,
} from "./onboard/types";
import type { ContainerRuntime } from "./platform";
import { listChannels } from "./sandbox/channels";
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
let GATEWAY_PORT = DEFAULT_GATEWAY_PORT;
let GATEWAY_NAME = gatewayBinding.resolveGatewayName(GATEWAY_PORT);
const {
  clearDockerDriverGatewayRuntimeFiles,
  getDockerDriverGatewayEnv,
  getDockerDriverGatewayPid,
  getDockerDriverGatewayPortListenerScan,
  getDockerDriverGatewayPortListenerPid,
  getDockerDriverGatewayRuntimeDrift,
  getDockerDriverGatewayRuntimeDriftFromSnapshot,
  getDockerDriverGatewayStateDir,
  isDockerDriverGatewayPortListener,
  isDockerDriverGatewayProcess,
  isDockerDriverGatewayProcessAlive,
  isPidAlive,
  rememberDockerDriverGatewayPid,
  resolveOpenShellGatewayBinary,
  resolveOpenShellSandboxBinary,
  shouldRequireDockerDriverEnv,
} = dockerDriverGatewayRuntime.createDockerDriverGatewayRuntimeHelpers({
  gatewayPort: () => GATEWAY_PORT,
  getCachedOpenshellBinary: () => OPENSHELL_BIN,
  getBlueprintMaxOpenshellVersion,
  getInstalledOpenshellVersion,
  isOpenshellDevVersion,
  runCapture,
  runCaptureEx,
  shouldUseOpenshellDevChannel,
  supportedOpenshellFallbackVersion: SUPPORTED_OPENSHELL_FALLBACK_VERSION,
});

import type { JsonObject as LooseObject } from "./core/json-types";
import type { PreparedSandboxBuildContext } from "./onboard/build-context-stage";

type OnboardOptions = SharedOnboardOptions & {
  baseImageResolutionHint?:
    | import("./sandbox-base-image").SandboxBaseImageResolutionMetadata
    | null;
};
// Non-interactive mode: set by --non-interactive flag or env var.
// When active, all prompts use env var overrides or sensible defaults.
let NON_INTERACTIVE = false;
let RECREATE_SANDBOX = false;
let AUTO_YES = false;
// Set by onboard() before preflight() when --control-ui-port is specified.
// null means "use auto-allocation" (skip dashboard port check in preflight).
let _preflightDashboardPort: number | null = null;

function getOnboardDashboardPort(): number {
  return _preflightDashboardPort ?? DASHBOARD_PORT;
}

function isNonInteractive(): boolean {
  return NON_INTERACTIVE || process.env.NEMOCLAW_NON_INTERACTIVE === "1";
}

function isRecreateSandbox(requested = false): boolean {
  return requested || RECREATE_SANDBOX || process.env.NEMOCLAW_RECREATE_SANDBOX === "1";
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
  return onboardPromptHelpers.promptYesNoOrDefault(
    promptHelperDeps,
    question,
    envVar,
    defaultIsYes,
  );
}

// ── Helpers ──────────────────────────────────────────────────────

const {
  getDockerDriverGatewayEndpoint,
  getGatewayClusterImageDrift,
  isGatewayHttpReady,
  isDockerDriverGatewayHttpReady,
  waitForGatewayHttpReady,
  isGatewayTcpReady,
} = gatewayBinding.createDynamicGatewayRuntimeHelpers({
  getGatewayName: () => GATEWAY_NAME,
  getGatewayPort: () => GATEWAY_PORT,
  getDockerDriverGatewayEndpoint: dockerDriverGatewayEnv.getDockerDriverGatewayEndpoint,
  getGatewayClusterImageDrift: getGatewayClusterImageDriftForName,
  probeGatewayHttpReady,
  probeDockerDriverGatewayHttpReady,
  waitForGatewayHttpReadyBase,
  probeGatewayTcpReady,
});

const {
  getOpenshellBinary,
  openshellShellCommand,
  openshellArgv,
  runOpenshell,
  runCaptureOpenshell,
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
const waitForSandboxReady = sandboxReadinessTracing.createSandboxReadyWaiter({
  runCaptureOpenshell,
  isSandboxReady,
  isLinuxDockerDriverGatewayEnabled,
  sleep: sleepSeconds,
});
const { hasStaleGateway, isSelectedGateway, isGatewayHealthy, getGatewayReuseState } =
  gatewayBinding.createGatewayNameBoundClassifiers(gatewayState, () => GATEWAY_NAME);

const { getGatewayReuseSnapshot, selectNamedGatewayForReuseIfNeeded } =
  gatewayReuse.createGatewayReuseHelpers({
    gatewayName: () => GATEWAY_NAME,
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

const {
  executeSandboxCommandForVerification,
}: typeof import("./onboard/sandbox-verification-exec") =
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

const { summarizeCurlFailure, summarizeProbeFailure } = httpProbe;

const selectOnboardAgent = createOnboardAgentSelector({ isNonInteractive, note, prompt });

const { getTransportRecoveryMessage } = validationRecovery;

// Validation functions — delegated to src/lib/validation.ts
const {
  classifyValidationFailure,
  classifyApplyFailure,
  classifySandboxCreateFailure,
  validateNvidiaApiKeyValue,
  isSafeModelId,
  shouldSkipResponsesProbe,
} = validation;

// validateNvidiaApiKeyValue — see validation import above

const credentialPrompt = createCredentialPromptHelpers(exitOnboardFromPrompt);
const replaceNamedCredential = credentialPrompt.replaceNamedCredential;

const {
  promptHermesAuthMethod,
  resolveHermesNousApiKey,
  stageNousApiKeyProviderEnv,
  ensureHermesNousApiKeyEnv,
  checkHermesProviderStoreReachable,
} = hermesAuth.createHermesAuthHelpers({
  isNonInteractive,
  error: (message) => console.error(message),
  exitProcess: (code) => process.exit(code),
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

type MessagingTokenDef = import("./onboard/messaging-prep").MessagingTokenDef;

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
  // biome-ignore format: keep src/lib/onboard.ts net-neutral for growth guardrail.
  braveProviderProfile.ensureWebSearchProviderProfiles(tokenDefs, { root: ROOT, runOpenshell, redact });
  const upserted = onboardProviders.upsertMessagingProviders(tokenDefs, runOpenshell, options);
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
const providerExistsInGateway = (name: string) =>
  onboardProviders.providerExistsInGateway(name, runOpenshell);

const { verifyInferenceRoute, isInferenceRouteReady } =
  inferenceRouteHelpers.createInferenceRouteHelpers(runCaptureOpenshell);

const {
  inspectSandboxForCreate,
  pruneStaleSandboxEntry,
  confirmRecreateForSelectionDrift,
  isOpenclawReady,
} = sandboxLifecycle.createSandboxLifecycleHelpers({
  runCaptureOpenshell,
  fetchGatewayAuthTokenFromSandbox: (sandboxName: string) =>
    fetchGatewayAuthTokenFromSandbox(sandboxName),
  agentProductName,
  prompt,
  isAffirmativeAnswer,
});

// biome-ignore format: keep src/lib/onboard.ts net-neutral for growth guardrail.
const { ensureValidatedWebSearchCredential, ensureValidatedBraveSearchCredential, configureWebSearch, verifyWebSearchInsideSandbox } = createWebSearchFlowHelpers({ prompt, note, isNonInteractive, cliName, runCaptureOpenshell });

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
const { validateSelectedRemoteModel } = createRemoteModelValidator({
  OPENAI_ENDPOINT_URL,
  ANTHROPIC_ENDPOINT_URL,
  requireValue,
  isBackToSelection,
  validateCustomOpenAiLikeSelection,
  validateCustomAnthropicSelection,
  validateAnthropicSelectionWithRetryMessage,
  validateOpenAiLikeSelection,
  shouldRequireResponsesToolCalling,
  shouldSkipResponsesProbe,
  getProbeAuthMode,
  configureCompatibleEndpointReasoning: reasoningMode.configureCompatibleEndpointReasoning,
});

const { promptCloudModel, promptRemoteModel, promptInputModel } = modelPrompts;
const { validateAnthropicModel, validateOpenAiLikeModel } = providerModels;
const nousModels: typeof import("./inference/nous-models") = require("./inference/nous-models");

// Build context helpers — delegated to src/lib/build-context.ts
const { shouldIncludeBuildContextPath, copyBuildContextDir, printSandboxCreateRecoveryHints } =
  buildContext;
// classifySandboxCreateFailure — see validation import above

const {
  promptOllamaModel,
  printOllamaExposureWarning,
  prepareOllamaModel,
}: typeof import("./inference/ollama/proxy") = require("./inference/ollama/proxy");

const {
  handleWindowsHostOllamaSelection,
  handleRunningOllamaSelection,
  handleInstallOllamaSelection,
} = setupNimOllama.createSetupNimOllamaHandlers({
  OLLAMA_PORT,
  OLLAMA_PROXY_PORT,
  process,
  isNonInteractive,
  prompt,
  checkOllamaPortsOrWarn,
  ensureOllamaLoopbackSystemdOverride,
  runOllamaStartupOrGate,
  shouldFrontOllamaWithProxy,
  startOllamaAuthProxy,
  getLocalProviderBaseUrl,
  selectAndValidateOllamaModel,
  printOllamaExposureWarning,
  switchToWindowsOllamaHost,
  installOllamaOnWindowsHost,
  awaitWindowsOllamaReady,
  setupWindowsOllamaWith0000Binding,
  printWindowsOllamaTimeoutDiagnostics,
  resetOllamaHostCache,
  installOllamaOnMacOS,
  installOllamaOnLinux,
  abortNonInteractive,
  assertOllamaUpgradeApplied,
});

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

function ensureOpenshellForOnboard(
  exitProcess: (code: number) => never = (code) => process.exit(code),
): OpenShellInstallResult {
  return openshellInstallFlow.ensureOpenshellForOnboard(getOpenShellInstallDeps(exitProcess));
}

function getOpenShellInstallDeps(
  exitProcess: (code: number) => never = (code) => process.exit(code),
): OpenShellInstallDeps {
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
    hasRequiredOpenshellMessagingFeatures: () =>
      // biome-ignore format: keep src/lib/onboard.ts net-neutral for growth guardrail.
      (require("./onboard/openshell-feature-gate") as typeof import("./onboard/openshell-feature-gate")).hasRequiredOpenshellMessagingFeatures({ openshellBin: resolveOpenshell(), gatewayBin: resolveOpenShellGatewayBinary(), sandboxBin: resolveOpenShellSandboxBinary(), allowExternalGatewayBin: Boolean(process.env.NEMOCLAW_OPENSHELL_GATEWAY_BIN?.trim()), allowExternalSandboxBin: Boolean(process.env.NEMOCLAW_OPENSHELL_SANDBOX_BIN?.trim()), requireSandboxBin: process.platform !== "darwin" || Boolean(process.env.NEMOCLAW_OPENSHELL_SANDBOX_BIN?.trim()) }),
    shouldAllowOpenshellAboveBlueprintMax,
    cliDisplayName,
    log: console.log,
    error: console.error,
    exit: exitProcess,
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

function terminateDockerDriverGatewayProcess(pid: number): boolean {
  if (!isPidAlive(pid)) {
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 10; i += 1) {
      if (!isPidAlive(pid)) break;
      sleepSeconds(1);
    }
    if (isPidAlive(pid)) process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

function stopDockerDriverGatewayProcess(): boolean {
  const pid = getDockerDriverGatewayPid();
  if (pid === null || !isPidAlive(pid)) {
    clearDockerDriverGatewayRuntimeFiles();
    return false;
  }
  if (!isDockerDriverGatewayProcess(pid, resolveOpenShellGatewayBinary())) {
    clearDockerDriverGatewayRuntimeFiles();
    return false;
  }

  const stopped = terminateDockerDriverGatewayProcess(pid);
  clearDockerDriverGatewayRuntimeFiles();
  return stopped;
}

function stopLegacyGatewayClusterContainer(): boolean {
  const containerName = getGatewayClusterContainerName(GATEWAY_NAME);
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
  runOpenshell(["forward", "stop", String(getOnboardDashboardPort())], { ignoreError: true });
  stopDockerDriverGatewayProcess();
  const stoppedLegacyContainer = stopLegacyGatewayClusterContainer();
  removeDockerDriverGatewayRegistration();
  if (stoppedLegacyContainer) {
    console.log("  ✓ Legacy OpenShell gateway container stopped for Docker-driver upgrade");
  }
}

function logDockerDriverGatewayRestart(reason: string): void {
  console.log(`  Existing OpenShell Docker-driver gateway is stale (${reason}); restarting...`);
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
  const runtimeIdentity = gatewayBin
    ? dockerDriverGatewayLaunch.buildDockerDriverGatewayRuntimeIdentity({
        gatewayBin,
        gatewayEnv: baseDesiredEnv,
        stateDir: getDockerDriverGatewayStateDir(),
        sandboxBin: resolveOpenShellSandboxBinary(),
        gatewayName: GATEWAY_NAME,
        compatContainerName: gatewayBinding.resolveGatewayCompatContainerName(GATEWAY_PORT),
      })
    : null;
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

const handleFinalGatewayStartFailure = createFinalGatewayStartFailureHandler({
  getGatewayName: () => GATEWAY_NAME,
  collectDiagnostics: () =>
    runCaptureOpenshell(["doctor", "logs", "--name", GATEWAY_NAME], {
      ignoreError: true,
      timeout: 10_000,
    }),
  cleanupGateway: destroyGateway,
});

function getGatewayClusterContainerState(): string {
  const containerName = getGatewayClusterContainerName(GATEWAY_NAME);
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
  return dockerExecArgv(getGatewayClusterContainerName(GATEWAY_NAME), ["sh", "-lc", script]);
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
  return dockerDriverGatewayEnv.getGatewayHttpsEndpoint(GATEWAY_PORT);
}

const { gatewayClusterHealthcheckPassed, repairGatewayBootstrapSecrets } =
  createGatewayBootstrapRepairHelpers({
    buildGatewayClusterExecArgv,
    run,
    runCapture,
  });

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
}: {
  forceRefresh?: boolean;
} = {}): boolean {
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

// parsePolicyPresetEnv — see urlUtils import above
// isSafeModelId — see validation import above

// getNonInteractiveProvider, getNonInteractiveModel — moved to onboard-providers.ts

// ── Step 1: Preflight ────────────────────────────────────────────

type PreflightOptions = import("./onboard/fatal-runtime-preflight").FatalRuntimePreflightOptions;

async function preflight(
  preflightOpts: PreflightOptions = {},
): Promise<ReturnType<typeof nim.detectGpu>> {
  step(1, 8, "Preflight checks");

  const { gpu, host, sandboxGpuConfig } = fatalRuntimePreflight.runFatalOnboardRuntimePreflight(
    preflightOpts,
    {
      nonInteractive: isNonInteractive(),
    },
  );

  await preflightUtils.checkContainerRuntimeResources(host, {
    ignored: process.env.NEMOCLAW_IGNORE_RUNTIME_RESOURCES === "1",
    nonInteractive: isNonInteractive(),
    confirm: () => promptYesNoOrDefault("  Continue with onboarding?", null, false),
  });

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
      runOpenshell(["forward", "stop", String(getOnboardDashboardPort())], {
        ignoreError: true,
      }),
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
    dashboardPort: getOnboardDashboardPort(),
    log: console.log,
    warn: console.warn,
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
  // #4984 — fail fast on an explicit reserved dashboard port; deferred paths
  // (CHAT_UI_URL / persisted) are caught at createSandbox.
  assertDashboardPortNotReserved(dashboardPortToCheck);
  const requiredPorts = buildRequiredPreflightPorts({
    gatewayPort: GATEWAY_PORT,
    dashboardPort: dashboardPortToCheck,
    dashboardLabel: `${cliDisplayName()} dashboard`,
  });
  for (const { port, label, envVar } of requiredPorts) {
    const portCheckOptions =
      port === GATEWAY_PORT ? dockerDriverGatewayEnv.getGatewayPortCheckOptions() : undefined;
    let portCheck = await checkPortAvailable(port, portCheckOptions);
    if (!portCheck.ok) {
      const reuse = await applyHealthyPortReuse({
        port,
        gatewayPort: GATEWAY_PORT,
        dashboardPort: getOnboardDashboardPort(),
        label,
        runtimeDisplayName: cliDisplayName(),
        gatewayName: GATEWAY_NAME,
        gatewayReuseState,
        portCheckOptions,
        supportsLifecycleCommands: gatewayCliSupportsLifecycleCommands(runCaptureOpenshell),
        destroyGateway,
        runOpenshell,
        checkPortAvailable,
        verifyGatewayContainerRunning,
      });
      if (reuse === "continue") continue;
      if (reuse) {
        ({ gatewayReuseState, portCheck } = reuse);
        if (portCheck.ok) continue;
      }
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
      if (port === getOnboardDashboardPort() && portCheck.process === "ssh" && portCheck.pid) {
        const outcome = await tryCleanupOrphanedDashboardForward({
          port,
          pid: portCheck.pid,
          label,
          portCheckOptions,
          captureProcessArgs,
          runCaptureOpenshell,
          run,
          sleepSeconds,
          checkPortAvailable,
        });
        if (outcome.kind === "killed-still-blocked") portCheck = outcome.portCheck;
        else if (outcome.kind !== "not-openshell") continue;
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
        printLowMemoryWarning(mem);

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
            printSwapCreationFailed(swapResult.reason);
          }
        }
      } else {
        console.log(`  ✓ Memory OK: ${mem.totalRamMB} MB RAM + ${mem.totalSwapMB} MB swap`);
      }
    }
  }

  if (_preflightDashboardPort === null) preflightDashboardPortRangeAvailability();
  return gpu; // #3953 — fail-fast before next step
}

// ── Step 2: Gateway ──────────────────────────────────────────────

/** Start the OpenShell gateway with retry logic and post-start health polling. */
async function startGatewayWithOptions(
  _gpu: ReturnType<typeof nim.detectGpu>,
  {
    exitOnFailure = true,
    gpuPassthrough = false,
  }: { exitOnFailure?: boolean; gpuPassthrough?: boolean } = {},
) {
  step(2, 8, "Starting OpenShell gateway");

  if (isLinuxDockerDriverGatewayEnabled()) {
    return startDockerDriverGateway({
      exitOnFailure,
      skipSandboxBridgeReachability: dockerGpuLocalInference.shouldSkipGpuBridgeProbe(
        gpuPassthrough,
        _gpu?.platform,
      ),
    });
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
            throw new pRetry.AbortError("Docker daemon is not reachable (gateway cannot start).");
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

        if (
          await waitForGatewayHealth({
            attachGatewayMetadataIfNeeded,
            gatewayClusterHealthcheckPassed,
            gatewayName: GATEWAY_NAME,
            healthPollCount: healthWait.count,
            healthPollIntervalSeconds: healthWait.interval,
            isGatewayHealthy,
            isGatewayHttpReady,
            repairGatewayBootstrapSecrets,
            runCaptureOpenshell,
            sleepSeconds,
          })
        ) {
          return;
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
      console.warn(
        "  CoreDNS did not report ready within timeout; continuing may cause DNS flakiness.",
      );
    }
  }
  runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
  process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
}

/**
 * Reconcile or create the host Docker-driver gateway. The public onboard()
 * entrypoint holds acquireOnboardLock()'s atomic cross-process filesystem lock
 * (created with openSync("wx")) across this whole call, so separate concurrent
 * `nemoclaw onboard` CLI processes cannot race creation.
 * The strict post-reap bind check below remains a second boundary against
 * recovery commands or external processes that do not participate in that
 * lock; the OS then permits only one child to bind the port.
 */
async function startDockerDriverGateway({
  exitOnFailure = true,
  skipSandboxBridgeReachability = false,
}: {
  exitOnFailure?: boolean;
  skipSandboxBridgeReachability?: boolean;
} = {}): Promise<void> {
  const gatewayBin = resolveOpenShellGatewayBinary();
  const openshellVersionOutput = runCaptureOpenshell(["--version"], { ignoreError: true });
  const gatewayEnv = getDockerDriverGatewayEnv(openshellVersionOutput);
  const stateDir = getDockerDriverGatewayStateDir();
  const runtimeIdentity = gatewayBin
    ? dockerDriverGatewayLaunch.buildDockerDriverGatewayRuntimeIdentity({
        gatewayBin,
        gatewayEnv,
        stateDir,
        sandboxBin: resolveOpenShellSandboxBinary(),
        gatewayName: GATEWAY_NAME,
        compatContainerName: gatewayBinding.resolveGatewayCompatContainerName(GATEWAY_PORT),
        ensureLocalTlsBundle: true,
      })
    : null;
  const gatewayLaunch = runtimeIdentity?.launch ?? null;
  const driftGatewayBin = dockerDriverGatewayLaunch.resolveDriftGatewayBin(
    runtimeIdentity,
    gatewayBin,
  );
  const driftGatewayEnv = runtimeIdentity?.desiredEnv ?? gatewayEnv;
  const identityGatewayBin = runtimeIdentity?.identityGatewayBin ?? gatewayBin;
  const { verifySandboxBridgeGatewayReachableOrExit } =
    require("./onboard/gateway-sandbox-reachability") as typeof import("./onboard/gateway-sandbox-reachability");
  if (
    await dockerDriverGatewayEnv.startPackageManagedDockerDriverGatewayWithEnvOverride({
      clearDockerDriverGatewayRuntimeFiles,
      exitOnFailure,
      gatewayEnv: driftGatewayEnv,
      gatewayName: GATEWAY_NAME,
      isDockerDriverGatewayReady: () => isDockerDriverGatewayHttpReady(),
      registerDockerDriverGatewayEndpoint,
      runCaptureOpenshell,
      skipSandboxBridgeReachability,
      verifySandboxBridgeGatewayReachableOrExit: (fail, options) =>
        verifySandboxBridgeGatewayReachableOrExit(fail, {
          ...options,
          port: GATEWAY_PORT,
        }),
    })
  )
    return;

  const gatewayStatus = runCaptureOpenshell(["status"], { ignoreError: true });
  const gwInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
    ignoreError: true,
  });
  const activeGatewayInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
  // Port availability and listener enumeration are not atomic. The cutover
  // rechecks health before adoption, reaps every observed duplicate, and
  // requires a fresh strict bind proof after reaping before launch.
  const portListenerScan = getDockerDriverGatewayPortListenerScan(
    await checkGatewayPortAvailable(),
    { gatewayBin: identityGatewayBin },
  );
  const cutover = await dockerDriverGatewayCutover.runDockerDriverGatewayCutover(
    {
      gatewayBin,
      identityGatewayBin,
      driftGatewayBin,
      driftGatewayEnv,
      exitOnFailure,
      skipSandboxBridgeReachability,
      stateDir,
      portListenerScan,
      pidFileGatewayPid: getDockerDriverGatewayPid(),
      initialHealth: {
        status: gatewayStatus,
        namedInfo: gwInfo,
        activeInfo: activeGatewayInfo,
      },
    },
    {
      isDockerDriverGatewayProcessAlive,
      isGatewayHealthy,
      getDockerDriverGatewayRuntimeDrift,
      logDockerDriverGatewayRestart,
      registerDockerDriverGatewayEndpoint,
      isDockerDriverGatewayHttpReady,
      verifySandboxBridgeGatewayReachableOrExit: (fail, options) =>
        verifySandboxBridgeGatewayReachableOrExit(fail, {
          ...options,
          port: GATEWAY_PORT,
        }),
      readGatewayHealth: () => ({
        status: runCaptureOpenshell(["status"], { ignoreError: true }),
        namedInfo: runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
          ignoreError: true,
        }),
        activeInfo: runCaptureOpenshell(["gateway", "info"], { ignoreError: true }),
      }),
      rememberDockerDriverGatewayPid,
      reapDuplicateHostGatewaysExceptOrFail,
      reapHostGatewayBeforeLaunchOrFail,
      isGatewayPortAvailable: async () => {
        const probe = await checkGatewayPortAvailable();
        return probe.ok && !probe.warning;
      },
      reportUntrustedGatewayPort: (message) => {
        const detail =
          `Refusing to start a second OpenShell gateway: ${message}. ` +
          `Inspect port ${GATEWAY_PORT} and stop only its owning process before retrying.`;
        console.error(`  ${detail}`);
        if (exitOnFailure) process.exit(1);
        throw new Error(detail);
      },
      reportMissingGatewayBinary: () => {
        console.error("  OpenShell Docker-driver gateway binary not found.");
        console.error(
          `  Install OpenShell v${SUPPORTED_OPENSHELL_FALLBACK_VERSION}, or set NEMOCLAW_OPENSHELL_GATEWAY_BIN.`,
        );
        if (exitOnFailure) process.exit(1);
        throw new Error("OpenShell gateway binary not found");
      },
      log: (message) => console.log(message),
    },
  );
  if (cutover === "reused") return;
  if (!gatewayBin) throw new Error("OpenShell gateway binary missing after cutover");

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
  dockerDriverGatewayRuntimeMarker.writeDockerDriverGatewayRuntimeMarkerForStateDir(
    getDockerDriverGatewayStateDir(),
    {
      pid: childPid,
      desiredEnv: driftGatewayEnv,
      endpoint: getDockerDriverGatewayEndpoint(),
      gatewayBin: driftGatewayBin,
      openshellVersion: getInstalledOpenshellVersion(openshellVersionOutput),
      dockerHost: process.env.DOCKER_HOST || null,
    },
  );

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
    if (
      isGatewayHealthy(status, namedInfo, currentInfo) &&
      (await isGatewayTcpReady()) &&
      !childExit.exited &&
      isPidAlive(childPid)
    ) {
      await verifySandboxBridgeGatewayReachableOrExit(exitOnFailure, {
        skip: skipSandboxBridgeReachability,
        port: GATEWAY_PORT,
      });
      console.log("  ✓ Docker-driver gateway is healthy");
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

async function startGatewayForRecovery(options = {}): Promise<void> {
  return require("./onboard/gateway-recovery").startGatewayForRecovery(options, {
    getGatewayStartEnv,
    runCaptureOpenshell,
    runOpenshell,
    startGatewayWithOptions,
    isLinuxDockerDriverGatewayEnabled,
  });
}

function getGatewayStartEnv(): Record<string, string> {
  const gatewayEnv = dockerDriverGatewayEnv.getGatewayStartNetworkEnv(GATEWAY_PORT);
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

const applyOverlayfsAutoFix = overlayfsAutoFix.createOverlayfsAutoFix({
  assessHost: preflightUtils.assessHost,
  ensurePatchedClusterImage: clusterImagePatch.ensurePatchedClusterImage,
});

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
  if (status.includes("Connected") && isSelectedGateway(status) && (await isGatewayHttpReady())) {
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
    if (status.includes("Connected") && isSelectedGateway(status) && (await isGatewayHttpReady())) {
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

const { getSandboxRuntimeRegistryFields, hasSandboxGpuDrift, updateReusedSandboxMetadata } =
  sandboxRegistryMetadata.createSandboxRegistryMetadataHelpers({
    isLinuxDockerDriverGatewayEnabled,
    getInstalledOpenshellVersion,
    runCaptureOpenshell,
  });

// ── Step 5: Sandbox ──────────────────────────────────────────────

async function createSandboxWithBaseImageResolution(
  baseImageResolutionContext: import("./onboard/base-image-resolution-flow").BaseImageResolutionContext,
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
  hermesAuthMethod: HermesAuthMethod | null = null,
  createIntent: import("./onboard/types").SandboxCreateIntent | null = null,
  preparedBuildContext: PreparedSandboxBuildContext | null = null,
) {
  step(6, 8, "Creating sandbox");

  const sandboxName = validateName(
    sandboxNameOverride ?? (await promptValidatedSandboxName(agent)),
    "sandbox name",
  );
  preparedDcodeRebuild.assertPreparedDcodeTarget(preparedBuildContext, agent, fromDockerfile);
  enabledChannels = filterEnabledChannelsByAgent(enabledChannels, agent);
  const effectiveSandboxGpuConfig =
    sandboxGpuConfig ?? resolveSandboxGpuConfig(gpu, { flag: null, device: null });
  const manageDashboard = dashboardRuntime.shouldManageDashboardForAgent(agent);
  const isManagedDcodeAgent = usesManagedDcodeIdentity(agent?.name, fromDockerfile);
  let effectivePort = 0,
    chatUiUrl = "";
  if (manageDashboard) {
    ({ effectivePort, chatUiUrl } = resolveCreateSandboxDashboardPort({
      sandboxName,
      controlUiPort,
      chatUiUrlEnv: process.env.CHAT_UI_URL,
      persistedPort: registry.getSandbox(sandboxName)?.dashboardPort ?? null,
      agentForwardPort: dashboardRuntime.getAgentPrimaryForwardPort(agent, DASHBOARD_PORT),
      defaultPort: DASHBOARD_PORT,
      forwardListOutput: runCaptureOpenshell(["forward", "list"], { ignoreError: true }),
      warn: (message) => console.warn(message),
    }));
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

  const {
    messagingTokenDefs,
    extraPlaceholderKeys,
    hasMessagingTokens,
    reusableMessagingProviders,
    reusableMessagingChannels,
    disabledChannelNames,
    disabledChannels,
  } = await sandboxMessagingPreflight.prepareSandboxMessagingPreflight(
    {
      channels: MESSAGING_CHANNELS,
      enabledChannels,
      sandboxName,
      agentName: agent?.name ?? "openclaw",
      webSearchConfig,
      env: process.env,
    },
    {
      readMessagingPlanFromEnv,
      resolveDisabledChannels: channelState.resolveDisabledChannels,
      gatewayName: GATEWAY_NAME,
      registry,
      providerExistsInGateway,
      isNonInteractive,
      promptYesNoOrDefault,
      cliName,
      log: (message) => console.log(message),
      error: (message) => console.error(message),
      exitProcess: (code) => process.exit(code),
      getValidatedMessagingTokenByEnvKey,
      getCredential,
      normalizeCredentialValue,
      registerExtraPlaceholderProviders:
        extraPlaceholderKeysModule.registerExtraPlaceholderProviders,
      getMessagingChannelForEnvKey,
    },
  );

  // biome-ignore format: keep src/lib/onboard.ts net-neutral for growth guardrail.
  const { existingEntry, preservedMcpState, liveExists, effectiveToolDisclosure, toolDisclosureMigrationNeeded, toolDisclosureMigrationNote } = toolDisclosureFlow.prepareSandboxToolDisclosure(sandboxName, preparedBuildContext?.rebuildTarget?.fromDockerfile ? preparedBuildContext.stagedDockerfile : fromDockerfile, isRecreateSandbox(createIntent?.recreate), inspectSandboxForCreate, createIntent?.toolDisclosure ?? null);
  if (liveExists && isManagedDcodeAgent && !existingEntry) {
    console.error(
      `  Sandbox '${sandboxName}' is live but missing its NemoClaw registry record; refusing unverified DCode reuse or recreation.`,
    );
    console.error(
      "  Choose a different sandbox name, or remove the orphan explicitly with OpenShell.",
    );
    process.exit(1);
  }
  // #4614: capture default AFTER prune so a stale registry row isn't read as a live sandbox.
  const sandboxWasLiveDefault = liveExists && wasSandboxDefault(registry.getDefault(), sandboxName);

  let pendingStateRestore: BackupResult | null = null;
  let pendingStateRestoreBackupPath: string | null = null;
  let notReadyRecreateInProgress = false;

  pendingStateRestoreBackupPath = notReadyRecreate.selectPreUpgradeBackupForCreate({
    liveExists,
    hasExistingRegistryEntry: existingEntry !== null,
    sandboxName,
    note,
  });

  if (liveExists) {
    const existingSandboxState = getSandboxReuseState(sandboxName);
    const requestedAgentName = getRequestedSandboxAgentName(agent);
    const agentDrift = getSandboxAgentDrift(sandboxName, requestedAgentName);
    let recreateForAgentDrift = agentDrift.changed && isRecreateSandbox(createIntent?.recreate);

    if (agentDrift.changed && !isRecreateSandbox(createIntent?.recreate)) {
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
    const selectionDrift = isManagedDcodeAgent
      ? getDcodeSelectionDrift(sandboxName, provider, model, preferredInferenceApi, {
          runCaptureOpenshell,
        })
      : getSelectionDrift(sandboxName, provider, model, { runOpenshell });
    const actionableSelectionDrift = requiresSelectionRecreate(selectionDrift, isManagedDcodeAgent);
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
      !isRecreateSandbox(createIntent?.recreate) &&
      !recreateForAgentDrift &&
      !needsProviderMigration &&
      !sandboxGpuDrift &&
      !credentialRotation.changed &&
      !hermesToolGatewayDrift &&
      !hermesDashboardDrift &&
      !toolDisclosureMigrationNeeded
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
          console.error(
            `  Sandbox '${sandboxName}' exists but was created without GPU passthrough.`,
          );
          console.error(
            "  Pass --recreate-sandbox to recreate with GPU, or destroy and re-onboard:",
          );
          console.error(`    nemoclaw onboard --recreate-sandbox`);
          process.exit(1);
        }
      }

      if (isNonInteractive()) {
        if (existingSandboxState === "ready") {
          if (actionableSelectionDrift) {
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
            ({ chatUiUrl } = sandboxReuse.applyReusedSandboxDashboardState({
              sandboxName,
              chatUiUrl,
              env: process.env,
              agent,
              model,
              provider,
              selectionVerified: !selectionDrift.unknown,
              sandboxGpuConfig: effectiveSandboxGpuConfig,
              gatewayName: GATEWAY_NAME,
              gatewayPort: GATEWAY_PORT,
              manageDashboard,
              ensureDashboardForward,
              hermesDashboardForwarding,
              updateReusedSandboxMetadata,
            }));
            return sandboxName;
          }
        } else {
          notReadyRecreateInProgress = true;
          const outcome = notReadyRecreate.resolveNotReadyOutcome(sandboxName, note);
          if (outcome.kind === "blocked") {
            for (const hint of outcome.hints) console.error(hint);
            process.exit(1);
          }
          pendingStateRestoreBackupPath = outcome.restoreBackupPath;
        }
      } else if (existingSandboxState === "ready") {
        if (actionableSelectionDrift) {
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
            ({ chatUiUrl } = sandboxReuse.applyReusedSandboxDashboardState({
              sandboxName,
              chatUiUrl,
              env: process.env,
              agent,
              model,
              provider,
              selectionVerified: !selectionDrift.unknown,
              sandboxGpuConfig: effectiveSandboxGpuConfig,
              gatewayName: GATEWAY_NAME,
              gatewayPort: GATEWAY_PORT,
              manageDashboard,
              ensureDashboardForward,
              hermesDashboardForwarding,
              updateReusedSandboxMetadata,
            }));
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
    } else if (actionableSelectionDrift) {
      note(
        `  Sandbox '${sandboxName}' exists — recreating because its live model/provider selection is stale or unreadable.`,
      );
    } else if (sandboxGpuDrift) {
      note(`  Sandbox '${sandboxName}' exists — recreating to apply sandbox GPU settings.`);
    } else if (hermesToolGatewayDrift) {
      note(`  Sandbox '${sandboxName}' exists — recreating to apply Hermes managed-tool changes.`);
    } else if (hermesDashboardDrift) {
      note(`  Sandbox '${sandboxName}' exists — recreating to apply Hermes dashboard settings.`);
    } else if (toolDisclosureMigrationNote) {
      note(toolDisclosureMigrationNote);
    } else if (credentialRotation.changed) {
      // Message already printed above during backup.
    } else if (existingSandboxState === "ready") {
      note(`  Sandbox '${sandboxName}' exists and is ready — recreating by explicit request.`);
    } else {
      note(`  Sandbox '${sandboxName}' exists but is not ready — recreating it.`);
    }

    if (preservedMcpState) {
      console.error(
        `  Sandbox '${sandboxName}' has managed MCP servers. Refusing the generic onboard recreation path.`,
      );
      console.error(
        `  Run \`${cliName()} ${sandboxName} rebuild --yes --tool-disclosure ${effectiveToolDisclosure}\` so MCP providers and adapter state are preserved transactionally.`,
      );
      process.exit(1);
    }

    const previousEntry: SandboxEntry | null = registry.getSandbox(sandboxName);
    baseImageResolutionFlow.captureBaseResolution(
      baseImageResolutionContext,
      previousEntry?.imageTag,
    );
    policyPresetCarry.applyRecreatePolicyCarryForward(sandboxName, isNonInteractive(), note);

    const noRestorePending = pendingStateRestore === null && pendingStateRestoreBackupPath === null;
    if (
      noRestorePending &&
      !notReadyRecreateInProgress &&
      !shouldSkipPreRecreateBackup(process.env)
    ) {
      note("  Backing up workspace state before recreating sandbox...");
      const result = backupSandboxBeforeRecreate({ sandboxName });
      if (!result.ok) {
        console.error(
          "  Set NEMOCLAW_RECREATE_WITHOUT_BACKUP=1 to recreate without preserving state.",
        );
        process.exit(1);
      }
      pendingStateRestore = result.backup;
    }

    note(`  Deleting and recreating sandbox '${sandboxName}'...`);

    runSandboxProviderPreDeleteCleanup(sandboxName, { runOpenshell, redact });
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
  const { buildCtx, stagedDockerfile, origin, cleanupBuildCtx } =
    preparedDcodeRebuild.resolveSandboxBuildContext(
      {
        preparedBuildContext,
        agent,
        fromDockerfile,
      },
      {
        createAgentSandbox: (selectedAgent) =>
          baseImageResolutionFlow.createAgentSandboxWithResolution(
            baseImageResolutionContext,
            selectedAgent,
            agentOnboard.createAgentSandbox,
          ),
      },
    );
  // Returns true if the build context was fully removed, false otherwise.
  // The caller uses this to decide whether the process 'exit' safety net
  // can be deregistered — if inline cleanup fails, we leave the handler
  // armed so the temp dir is still removed on process exit.
  const defaultPolicyPath = path.join(
    ROOT,
    "nemoclaw-blueprint",
    "policies",
    "openclaw-sandbox.yaml",
  );
  const basePolicyPath = (agent && agentOnboard.getAgentPolicyPath(agent)) || defaultPolicyPath;
  const dockerDriverGateway = isLinuxDockerDriverGatewayEnabled();
  const {
    activeMessagingChannels,
    initialSandboxPolicy,
    createArgs,
    messagingProviders,
    useDockerGpuPatch,
    sandboxGpuLogMessage,
  } = sandboxCreatePlan.prepareSandboxCreatePlan({
    basePolicyPath,
    buildCtx,
    sandboxName,
    channels: MESSAGING_CHANNELS,
    enabledChannels,
    disabledChannelNames,
    messagingTokenDefs,
    reusableMessagingChannels,
    reusableMessagingProviders,
    extraProviders: registry.listExtraProviders(),
    hermesToolGateways,
    sandboxGpuConfig: effectiveSandboxGpuConfig,
    dockerDriverGateway,
    appendResourceFlags: (args) =>
      appendResourceFlagsForProfile(args, resourceProfile, getOpenshellBinary(), {
        isNonInteractive,
        note,
        prompt,
        promptOrDefault,
      }),
    runProviderPreDeleteCleanup: () =>
      runSandboxProviderPreDeleteCleanup(sandboxName, {
        runOpenshell,
        redact,
        tolerateMissingSandbox: true,
      }),
    upsertMessagingProviders,
    getMessagingChannelForEnvKey,
    getHermesToolGatewayProviderName: (targetSandbox) =>
      getHermesToolGatewayBroker().getHermesToolGatewayProviderName(targetSandbox),
    agentName: agent?.name,
  });
  if (initialSandboxPolicy.cleanup) {
    process.on("exit", initialSandboxPolicy.cleanup);
  }
  if (initialSandboxPolicy.appliedPresets.length > 0) {
    console.log(
      `  Including policy preset(s) at sandbox boot: ${initialSandboxPolicy.appliedPresets.join(", ")}`,
    );
  }
  if (sandboxGpuLogMessage) console.log(sandboxGpuLogMessage);

  console.log(`  Creating sandbox '${sandboxName}' (this takes a few minutes on first run)...`);
  const envMessagingState = MessagingHostStateApplier.readPlanStateFromEnv();
  const plannedMessagingState =
    envMessagingState?.plan.sandboxName === sandboxName ? envMessagingState : undefined;
  sandboxBuildPatchConfig.prepareSandboxBuildPatchConfig({
    configuredMessagingChannels:
      getChannelsFromPlan(plannedMessagingState?.plan) ?? activeMessagingChannels,
  });
  const buildId = await preparedDcodeRebuild.resolveSandboxBuildId({
    preparedBuildContext,
    agent,
    fromDockerfile,
    stagedDockerfile,
    model,
    chatUiUrl,
    provider,
    preferredInferenceApi,
    webSearchConfig,
    toolDisclosure: effectiveToolDisclosure,
    hermesToolGateways,
    sandboxGpuConfig: effectiveSandboxGpuConfig,
    ...baseImageResolutionFlow.getBaseImageResolutionPatchOptions(baseImageResolutionContext),
    gatewayPort: GATEWAY_PORT,
  });
  const sandboxReadyTimeoutSecs = getSandboxReadyTimeoutSecs(effectiveSandboxGpuConfig);
  const { createCommand, effectiveDashboardPort, prebuild, sandboxEnv, sandboxStartupCommand } =
    await sandboxCreateLaunch.prepareSandboxCreateLaunchWithPrebuild({
      agent,
      chatUiUrl,
      createArgs,
      sandboxName,
      env: process.env,
      extraPlaceholderKeys,
      getDashboardForwardPort,
      hermesDashboardState,
      manageDashboard,
      openshellShellCommand,
      prebuild: { buildCtx, buildId, dockerDriverGateway, origin },
    });
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
    readyCheckOutputPatterns: agentDefs.isTerminalAgent(agent) ? [] : undefined,
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

  const restoreBackupPath =
    pendingStateRestore?.manifest?.backupPath ?? pendingStateRestoreBackupPath;

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
      sandboxCreateFailureDiagnostics.printSandboxCreateFailureDiagnostics(sandboxName, {
        backupPath: restoreBackupPath,
      });
      console.error("  Try:  openshell sandbox list        # check gateway state");
      printSandboxCreateRecoveryHints(createResult.output, { createArgs: prebuild.createArgs });
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

  if (!readiness.ready) {
    console.error("");
    sandboxReadinessTracing.printReadinessFailure(readiness, sandboxName, sandboxReadyTimeoutSecs);
    sandboxCreateFailureDiagnostics.printSandboxCreateFailureDiagnostics(sandboxName, {
      backupPath: restoreBackupPath,
    });
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

  if (manageDashboard) {
    console.log("  Waiting for NemoClaw dashboard to become ready...");
    sandboxReadinessTracing.waitForDashboardReadyWithTrace({
      sandboxName,
      port: effectiveDashboardPort,
      runCaptureOpenshell,
      sleep: sleepSeconds,
    });
  }

  if (effectiveSandboxGpuConfig.sandboxGpuEnabled) {
    // Runs the GPU proof, preserving Docker-GPU patch Error-phase diagnostics
    // when applicable, then gates host-network local inference reachability (#4509).
    dockerGpuLocalInference.verifyGpuSandboxAfterReady(effectiveSandboxGpuConfig, provider, {
      sandboxName,
      dockerDriverGateway,
      useDockerGpuPatch,
      verifyDirectSandboxGpu,
      verifyGpuOrExit: dockerGpuCreatePatch.verifyGpuOrExit,
      selectedMode: dockerGpuCreatePatch.selectedMode,
      runCaptureOpenshell,
      log: console.log,
    });
  }

  let actualDashboardPort = 0;
  let finalHermesDashboardState = hermesDashboardState;
  if (manageDashboard) {
    actualDashboardPort = ensureDashboardForward(sandboxName, chatUiUrl, {
      rollbackSandboxOnFailure: true,
    });
    if (actualDashboardPort !== Number(getDashboardForwardPort(chatUiUrl))) {
      chatUiUrl = `http://127.0.0.1:${actualDashboardPort}`;
    }
    process.env.CHAT_UI_URL = chatUiUrl;
    finalHermesDashboardState = hermesDashboardForwarding.resolveStateForPort(actualDashboardPort);
    hermesDashboardForwarding.ensureForState(finalHermesDashboardState, sandboxName, true);
  }

  // Resolve registry metadata now, but publish it only after restored state is
  // reconciled and the live agent selection is verified.
  // openshell tags images with seconds; buildId is ms. Parse actual tag from output. Fixes #2672.
  const resolvedImageTag =
    prebuild.imageRef ?? resolveSandboxImageTagFromCreateOutput(createResult.output, buildId);

  const sandboxRuntimeFields = getSandboxRuntimeRegistryFields(effectiveSandboxGpuConfig);
  const inferenceSelection = sandboxRegistration.selection;

  finalizeCreatedSandbox(
    {
      sandboxName,
      restoreBackupPath,
      preUpgradeBackup: pendingStateRestoreBackupPath !== null,
      validateManagedDcode: isManagedDcodeAgent,
      provider,
      model,
      preferredInferenceApi,
    },
    {
      restoreSandboxState: sandboxState.restoreSandboxState,
      getDcodeSelectionDrift: (name, selectedProvider, selectedModel, selectedApi) =>
        getDcodeSelectionDrift(name, selectedProvider, selectedModel, selectedApi, {
          runCaptureOpenshell,
        }),
      note,
      error: console.error,
      exitProcess: (code) => process.exit(code),
      register: () =>
        sandboxRegistration.registerCreatedSandbox({
          sandboxName,
          inferenceSelection: inferenceSelection(
            sandboxName,
            provider,
            model,
            preferredInferenceApi,
          ),
          runtimeFields: sandboxRuntimeFields,
          agent,
          agentVersionKnown: !fromDockerfile,
          imageTag: resolvedImageTag,
          appliedPolicies: initialSandboxPolicy.appliedPresets,
          toolDisclosure: effectiveToolDisclosure,
          // biome-ignore format: keep src/lib/onboard.ts net-neutral for growth guardrail.
          ...sandboxRegistration.creationFidelity(webSearchConfig, fromDockerfile, normalizeHermesAuthMethod(hermesAuthMethod)),
          plannedMessagingState,
          preservedMcpState,
          hermesToolGateways,
          hermesDashboardState: finalHermesDashboardState,
          dashboardPort: actualDashboardPort,
          gatewayName: GATEWAY_NAME,
          gatewayPort: GATEWAY_PORT,
        }),
    },
  );
  restoreDefaultAfterRecreate(registry.setDefault, sandboxName, sandboxWasLiveDefault); // #4614: default deferred to finalization

  // DNS proxy — run a forwarder in the sandbox pod so the isolated
  // sandbox namespace can resolve hostnames (fixes #626).
  if (sandboxRuntimeFields.openshellDriver === "kubernetes") {
    console.log("  Setting up sandbox DNS proxy...");
    runFile("bash", [path.join(SCRIPTS, "setup-dns-proxy.sh"), GATEWAY_NAME, sandboxName], {
      ignoreError: true,
    });
  }

  require("./onboard/vm-dns-monkeypatch").applyOnboardVmDnsMonkeypatch(
    sandboxName,
    sandboxRuntimeFields,
  );

  // Check that messaging providers exist in the gateway (sandbox attachment
  // cannot be verified via CLI yet — only gateway-level existence is checked).
  for (const p of messagingProviders) {
    if (!providerExistsInGateway(p)) {
      printMessagingProviderMissing(p);
    }
  }

  console.log(`  ✓ Sandbox '${sandboxName}' created`);

  warnIfLandlockUnsupported({ dockerInfoFormat, runCapture });

  // #4614: arm rollback only when the sandbox was not live before (never a recreate/rebuild).
  if (!liveExists) sandboxCancelRollback.arm(sandboxName);
  return sandboxName;
}

type CreateSandboxArgs =
  Parameters<typeof createSandboxWithBaseImageResolution> extends [unknown, ...infer Args]
    ? Args
    : never;

async function createSandbox(...args: CreateSandboxArgs): Promise<string> {
  return createSandboxWithBaseImageResolution(
    baseImageResolutionFlow.createBaseImageResolutionContext({ fresh: false }),
    ...args,
  );
}

// ── Step 3: Inference selection ──────────────────────────────────

type ProviderChoice = import("./onboard/provider-menu").ProviderMenuChoice;
type RebuildRouteHandoff = import("./onboard/rebuild-route-handoff").RebuildRouteHandoff;

// biome-ignore format: keep src/lib/onboard.ts net-neutral for growth guardrail.
const { readRecordedProvider, readRecordedNimContainer, readRecordedModel, readRecordedEndpointUrl,
  readRecordedInferenceRoute, readRecordedProviderEndpoints } = providerRecovery.createProviderRecoveryHelpers({ parseGatewayInference, runCaptureOpenshell });

type OllamaModelSelectionOutcome =
  | { outcome: "selected"; model: string; allowToolsIncompatible: boolean }
  | { outcome: "back-to-selection" };
async function selectAndValidateOllamaModel(
  gpu: ReturnType<typeof nim.detectGpu>,
  provider: string,
  defaults: { requestedModel: string | null; recoveredModel: string | null },
): Promise<OllamaModelSelectionOutcome> {
  const { requestedModel, recoveredModel } = defaults;
  const probeFailures = new OllamaProbeFailureTracker();
  const confirm = (question: string, defaultIsYes: boolean) =>
    promptYesNoOrDefault(question, null, defaultIsYes);
  const interaction = { isNonInteractive, isAutoYes, confirm };
  while (true) {
    const installedModels = getOllamaModelOptions();
    let model: string | typeof BACK_TO_SELECTION;
    if (isNonInteractive()) {
      model = localInference.resolveNonInteractiveOllamaModel(requestedModel, recoveredModel, gpu);
    } else {
      model = await promptOllamaModel(gpu, { excludeModels: probeFailures.excludedModels() });
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
    const probe = await prepareOllamaModel(selectedModel, installedModels, interaction);
    if (!probe.ok) {
      const probeFailureLimitReached = probeFailures.recordFailure(selectedModel);
      const action = handleOllamaProbeFailure(probe, selectedModel, isNonInteractive);
      if (action === "back-to-selection") return { outcome: "back-to-selection" };
      if (probeFailureLimitReached) {
        console.error(probeFailures.formatLimitMessage(selectedModel));
        return { outcome: "back-to-selection" };
      }
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

type SetupNimSelectionState =
  import("./onboard/setup-nim-selection").SetupNimSelectionState<HermesAuthMethod>;
type SetupNimSelectionResult = "selected" | "retry-selection";

// biome-ignore format: keep src/lib/onboard.ts net-neutral for growth guardrail.
type RemoteProviderSelectionArgs = { selected: ProviderChoice; requestedModel: string | null; recoveredFromSandbox: boolean; recoveredModel: string | null; sandboxName: string | null; intendedInferenceApi: string | null };

async function handleVllmSelection(
  state: SetupNimSelectionState,
): Promise<SetupNimSelectionResult> {
  console.log(`  ✓ Using existing vLLM on localhost:${VLLM_PORT}`);
  state.provider = "vllm-local";
  // Local vLLM uses an internal credential env, no user API key.
  state.credentialEnv = null;
  state.endpointUrl = getLocalProviderBaseUrl(state.provider);
  if (!state.endpointUrl) {
    console.error("  Local vLLM base URL could not be determined.");
    process.exit(1);
  }

  // Source boundary: local vLLM is an external process, so /v1/models can be
  // unreachable, malformed, empty, or return an unsafe served id. setupNim is
  // the last safe point before writing provider state, so fail closed here
  // rather than returning a partially configured local provider. Remove this
  // local guard only if the vLLM manager owns a typed, validated model probe.
  const vllmModelsRaw = runCapture(["curl", "-sf", `http://127.0.0.1:${VLLM_PORT}/v1/models`], {
    ignoreError: true,
  });
  let vllmModels: { data?: Array<{ id?: unknown }> } = {};
  try {
    vllmModels = JSON.parse(vllmModelsRaw);
    if (vllmModels.data && vllmModels.data.length > 0) {
      const detectedModel =
        typeof vllmModels.data[0]?.id === "string" ? vllmModels.data[0].id : null;
      state.model = detectedModel;
      if (!detectedModel || !isSafeModelId(detectedModel)) {
        console.error(`  Detected model ID contains invalid characters: ${state.model}`);
        process.exit(1);
      }
      console.log(`  Detected model: ${state.model}`);
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

  const validationBaseUrl = getLocalProviderValidationBaseUrl(state.provider);
  if (!validationBaseUrl) {
    console.error("  Local vLLM validation URL could not be determined.");
    process.exit(1);
  }
  const validation = await validateOpenAiLikeSelection(
    "Local vLLM",
    validationBaseUrl,
    requireValue(state.model as string | null | undefined, "Expected a detected vLLM model"),
    null,
  );
  if (validation.retry === "selection" || validation.retry === "model") {
    return "retry-selection";
  }
  if (!validation.ok) return "retry-selection";

  localInference.applyVllmRuntimeContextWindow(vllmModels, state.model as string);
  state.preferredInferenceApi = validation.api;
  // Force chat completions — vLLM's /v1/responses endpoint does not run the
  // --tool-call-parser, so tool calls arrive as raw text (#976).
  if (state.preferredInferenceApi !== "openai-completions") {
    console.log("  ℹ Using chat completions API (tool-call-parser requires /v1/chat/completions)");
  }
  state.preferredInferenceApi = "openai-completions";
  return "selected";
}

async function handleRoutedSelection(
  state: SetupNimSelectionState,
): Promise<SetupNimSelectionResult> {
  const bp = loadBlueprintProfile("routed");
  if (!bp || bp.router?.enabled !== true) {
    console.error("  Router is not enabled in nemoclaw-blueprint/blueprint.yaml.");
    if (isNonInteractive()) process.exit(1);
    return "retry-selection";
  }

  const routerCredentialEnv =
    bp.router?.credential_env || bp.credential_env || DEFAULT_MODEL_ROUTER_CREDENTIAL_ENV;
  state.credentialEnv = routerCredentialEnv;
  const routedCredential =
    hydrateCredentialEnv(routerCredentialEnv) ||
    normalizeCredentialValue(bp.credential_default || "");
  if (routedCredential) {
    saveCredential(routerCredentialEnv, routedCredential);
  }
  providerKeyBridge.stageRouterProviderKeyBridge(routerCredentialEnv);
  if (isNonInteractive()) {
    if (!resolveProviderCredential(routerCredentialEnv)) {
      console.error(
        `  ${routerCredentialEnv} (or NEMOCLAW_PROVIDER_KEY) is required for Model Router in non-interactive mode.`,
      );
      process.exit(1);
    }
  } else if (!resolveProviderCredential(routerCredentialEnv)) {
    console.log("");
    console.log("  Model Router accepts NVIDIA API keys (nvapi-...).");
    console.log("  Get one at https://build.nvidia.com");
    console.log("");
    const routerCredentialResult = await ensureNamedCredential(
      routerCredentialEnv,
      "Model Router API key",
      null,
    );
    if (credentialPrompt.returningToProviderSelection(routerCredentialResult)) {
      return "retry-selection";
    }
  }

  state.provider = bp.provider_name || "nvidia-router";
  state.model = bp.model;
  const { HOST_GATEWAY_URL } = require("./inference/local");
  const routerEndpointUrl = bp.endpoint || "";
  state.endpointUrl = routerEndpointUrl;
  if (routerEndpointUrl.match(/localhost|127\.0\.0\.1/)) {
    const u = new URL(routerEndpointUrl);
    state.endpointUrl = `${HOST_GATEWAY_URL}:${u.port}${u.pathname}`;
  }
  state.preferredInferenceApi = "openai-completions";
  console.log(`  ✓ Using Model Router: ${state.provider} / ${state.model}`);
  return "selected";
}

async function handleNimLocalSelection(
  gpu: ReturnType<typeof nim.detectGpu>,
  args: Pick<
    RemoteProviderSelectionArgs,
    "requestedModel" | "recoveredFromSandbox" | "recoveredModel"
  >,
  state: SetupNimSelectionState,
): Promise<SetupNimSelectionResult> {
  const localGpu = requireValue(gpu, "GPU details are required for local NIM model selection");
  const models = nim.listModels().filter((m) => m.minGpuMemoryMB <= localGpu.totalMemoryMB);
  if (models.length === 0) {
    console.log("  No NIM models fit your GPU VRAM. Falling back to cloud API.");
    applyCloudFallbackSelection(state, REMOTE_PROVIDER_CONFIG.build);
    return "selected";
  }

  let sel;
  if (isNonInteractive()) {
    const targetModel =
      args.requestedModel || (args.recoveredFromSandbox ? args.recoveredModel : null);
    if (targetModel) {
      sel = models.find((m) => m.name === targetModel);
      if (!sel) {
        const label = args.requestedModel ? "NEMOCLAW_MODEL for NIM" : "Recorded NIM model";
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
  state.model = sel.name;

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
    if (credentialPrompt.returningToProviderSelection(ngcKey)) return "retry-selection";
    if (!ngcKey) {
      console.error("  NGC API Key is required for Local NIM.");
      process.exit(1);
    }
    if (!nim.dockerLoginNgc(ngcKey)) {
      console.error("  Failed to login to NGC registry. Check your API key and try again.");
      console.log("");
      ngcKey = await credentialPrompt.readValue("  NGC API Key: ");
      if (credentialPrompt.returningToProviderSelection(ngcKey)) return "retry-selection";
      if (!ngcKey || !nim.dockerLoginNgc(ngcKey)) {
        console.error("  NGC login failed. Cannot pull NIM images.");
        process.exit(1);
      }
    }
    ngcApiKey = ngcKey;
  } else {
    ngcApiKey =
      hydrateCredentialEnv("NGC_API_KEY") || hydrateCredentialEnv("NVIDIA_INFERENCE_API_KEY");
    if (!ngcApiKey && !isNonInteractive()) {
      console.log("");
      console.log("  NGC API Key required to download NIM model weights at runtime.");
      console.log("  (Docker is logged in to nvcr.io, but the key was not saved.)");
      const ngcKey = await credentialPrompt.readValue("  NGC API Key: ");
      if (credentialPrompt.returningToProviderSelection(ngcKey)) return "retry-selection";
      ngcApiKey = ngcKey || null;
    }
  }

  console.log(`  Pulling NIM image for ${state.model}...`);
  nim.pullNimImage(state.model);

  console.log("  Starting NIM container...");
  const nimContainerNameLocal = nim.containerName(GATEWAY_NAME);
  state.nimContainer = nim.startNimContainerByName(nimContainerNameLocal, state.model, undefined, {
    ngcApiKey: ngcApiKey ?? undefined,
  });

  console.log("  Waiting for NIM to become healthy...");
  if (!nim.waitForNimHealth(undefined, undefined, { container: nimContainerNameLocal })) {
    console.error("  NIM failed to start. Falling back to cloud API.");
    applyCloudFallbackSelection(state, REMOTE_PROVIDER_CONFIG.build);
    return "selected";
  }

  state.provider = "vllm-local";
  state.credentialEnv = null;
  state.endpointUrl = getLocalProviderBaseUrl(state.provider);
  if (!state.endpointUrl) {
    console.error("  Local NVIDIA NIM base URL could not be determined.");
    process.exit(1);
  }
  state.model = nim.adoptServedModelId(state.model);
  const nimValidationUrl = getLocalProviderValidationBaseUrl(state.provider) || state.endpointUrl;
  const validation = await validateOpenAiLikeSelection(
    "Local NVIDIA NIM",
    nimValidationUrl,
    requireValue(state.model, "Expected a Local NVIDIA NIM model after startup"),
    null,
  );
  if (validation.retry === "selection" || validation.retry === "model") {
    clearNimContainerBeforeRetry(state);
    return "retry-selection";
  }
  if (!validation.ok) {
    clearNimContainerBeforeRetry(state);
    return "retry-selection";
  }
  if (validation.api !== "openai-completions") {
    console.log("  ℹ Using chat completions API (tool-call-parser requires /v1/chat/completions)");
  }
  state.preferredInferenceApi = "openai-completions";
  return "selected";
}

// biome-ignore format: keep src/lib/onboard.ts net-neutral for growth guardrail.
async function handleRemoteProviderSelection(args: RemoteProviderSelectionArgs, state: SetupNimSelectionState, recoveredRegistryRoute: RebuildRouteHandoff["route"] | null): Promise<SetupNimSelectionResult> {
  const { selected, requestedModel, recoveredFromSandbox, recoveredModel, sandboxName, intendedInferenceApi } = args;
  const remoteConfig = REMOTE_PROVIDER_CONFIG[selected.key];
  state.provider = remoteConfig.providerName;
  state.credentialEnv = remoteConfig.credentialEnv;
  state.endpointUrl = remoteConfig.endpointUrl;
  state.preferredInferenceApi = null;

  if (selected.key === "custom" || selected.key === "anthropicCompatible") {
    const kind = selected.key === "custom" ? "openai" : "anthropic";
    const endpointInput = await resolveCompatibleEndpointInput({
      kind,
      envUrl: process.env.NEMOCLAW_ENDPOINT_URL,
      recoveredEndpointUrl: recoveredFromSandbox
        ? (recoveredRegistryRoute?.endpointUrl ?? readRecordedEndpointUrl(sandboxName))
        : null,
      nonInteractive: isNonInteractive(),
      prompt,
    });
    const navigation = getNavigationChoice(endpointInput);
    if (navigation === "back") {
      console.log("  Returning to provider selection.");
      console.log("");
      return "retry-selection";
    }
    if (navigation === "exit") {
      exitOnboardFromPrompt();
    }
    state.endpointUrl = normalizeProviderBaseUrl(endpointInput, kind);
    if (!state.endpointUrl) {
      console.error(
        selected.key === "custom"
          ? "  Endpoint URL is required for Other OpenAI-compatible endpoint."
          : "  Endpoint URL is required for Other Anthropic-compatible endpoint.",
      );
      if (isNonInteractive()) {
        process.exit(1);
      }
      console.log("");
      return "retry-selection";
    }
    if (selected.key === "anthropicCompatible") {
      state.endpointUrl = bedrockRuntimeOnboard.normalizeCustomAnthropicEndpointUrl(
        state.endpointUrl,
      );
    }
  }

  if (selected.key === "hermesProvider") {
    const selectedHermesAuthMethod = await promptHermesAuthMethod();
    if (isBackToSelection(selectedHermesAuthMethod)) {
      state.hermesAuthMethod = null;
      console.log("  Returning to provider selection.");
      console.log("");
      return "retry-selection";
    }
    state.hermesAuthMethod = normalizeHermesAuthMethod(
      selectedHermesAuthMethod as string | null | undefined,
    );
    if (state.hermesAuthMethod === HERMES_AUTH_METHOD_API_KEY) {
      state.credentialEnv = HERMES_NOUS_API_KEY_CREDENTIAL_ENV;
      stageNousApiKeyProviderEnv();
      if (isNonInteractive()) {
        if (!resolveHermesNousApiKey()) {
          console.error("  Hermes Provider Nous API Key is required in non-interactive mode.");
          process.exit(1);
        }
      } else {
        const hermesKeyResult = await ensureHermesNousApiKeyEnv();
        if (credentialPrompt.returningToProviderSelection(hermesKeyResult)) {
          return "retry-selection";
        }
      }
    } else {
      state.credentialEnv = remoteConfig.credentialEnv;
    }
    const recordedHermesToolGateways = sandboxName
      ? normalizeHermesToolGatewaySelections(registry.getSandbox(sandboxName)?.hermesToolGateways)
      : null;
    state.hermesToolGateways = await setupHermesToolGateways(
      state.provider,
      state.hermesAuthMethod,
      recordedHermesToolGateways,
      { prompt, note, isNonInteractive },
    );

    const defaultModel =
      requestedModel || (recoveredFromSandbox && recoveredModel) || remoteConfig.defaultModel;
    if (isNonInteractive()) {
      state.model = defaultModel;
    } else {
      let hermesProviderModels: string[] = [];
      try {
        hermesProviderModels = await nousModels.getHermesProviderModelOptions();
      } catch (err) {
        // Source boundary: Nous model recommendations are advisory network data,
        // while the user's requested/default model remains the source of truth
        // for onboarding. Keep Hermes auth/tool-gateway state and continue with
        // fallback model prompting. Remove this fallback only when the provider
        // registry can supply recommendations without network failure modes.
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(
          `  Warning: failed to load Nous model recommendations; falling back to the current/default model (${detail}).`,
        );
      }
      state.model = await promptRemoteModel(remoteConfig.label, selected.key, defaultModel, null, {
        otherShowsFullList: true,
        remoteModelOptions: { [selected.key]: hermesProviderModels },
        topLevelModelLimit: 10,
      });
    }
    if (isBackToSelection(state.model)) {
      console.log("  Returning to provider selection.");
      console.log("");
      return "retry-selection";
    }
    state.preferredInferenceApi = "openai-completions";
    console.log(`  Using ${remoteConfig.label} with model: ${state.model}`);
    return "selected";
  }
  hydrateCredentialEnv(state.credentialEnv);
  if (selected.key === "build") {
    providerKeyBridge.stageBuildProviderKeyBridge();
    if (isNonInteractive()) {
      const reuseGatewayCredential = buildCredentialReuse.resolveNonInteractiveBuildCredential({
        provider: state.provider,
        helpUrl: REMOTE_PROVIDER_CONFIG.build.helpUrl,
        recoveredFromSandbox,
        providerExistsInGateway,
      });
      state.skipHostInferenceSmoke = reuseGatewayCredential;
      state.reuseGatewayCredentialWithoutLocalKey = reuseGatewayCredential;
    } else {
      await ensureApiKey();
    }
    state.model = await state.nvidiaFeaturedModels!.select(
      requestedModel,
      recoveredFromSandbox ? recoveredModel : null,
      isNonInteractive(),
      process.env.NEMOCLAW_MODEL,
    );
    if (isBackToSelection(state.model)) {
      console.log("  Returning to provider selection.");
      console.log("");
      return "retry-selection";
    }
  } else {
    providerKeyBridge.stageRemoteProviderKeyBridge(state.credentialEnv);

    const _envModelRemote = (process.env.NEMOCLAW_MODEL || "").trim();
    const defaultModel =
      requestedModel ||
      _envModelRemote ||
      (recoveredFromSandbox && recoveredModel) ||
      remoteConfig.defaultModel;
    const selectedCredentialEnv = requireValue(
      state.credentialEnv,
      `Missing credential env for ${remoteConfig.label}`,
    );
    const bedrockSelection = await bedrockRuntimeOnboard.selectBedrockRuntimeCustomAnthropic({
      selectedKey: selected.key,
      endpointUrl: state.endpointUrl,
      credentialEnv: selectedCredentialEnv,
      label: remoteConfig.label,
      helpUrl: remoteConfig.helpUrl,
      defaultModel,
      backToSelection: BACK_TO_SELECTION,
      isNonInteractive,
      promptInputModel,
      replaceNamedCredential,
      exitProcess: (code) => process.exit(code),
      error: (message) => console.error(message),
      log: (message) => console.log(message),
    });
    if (bedrockSelection.action === "retry-selection") {
      console.log("  Returning to provider selection.");
      console.log("");
      return "retry-selection";
    }
    if (bedrockSelection.action === "selected") {
      state.model = bedrockSelection.model;
      state.preferredInferenceApi = bedrockSelection.preferredInferenceApi;
      return "selected";
    }
    if (isNonInteractive()) {
      // biome-ignore format: keep src/lib/onboard.ts net-neutral for growth guardrail.
      recoveredProviderReuse.resolveRecoveredProviderCredentialReuse(
        { selected, remoteConfig, state, selectedCredentialEnv, recoveredFromSandbox, selectedModel: defaultModel, sandboxName, recoveredRegistryRoute },
        { resolveProviderCredential, readRecordedInferenceRoute, readRecordedProviderEndpoints, readGatewayProviderMetadata: (provider) => onboardProviders.readGatewayProviderMetadata(provider, runOpenshell), note },
      );
    } else {
      const credentialResult = await ensureNamedCredential(
        selectedCredentialEnv,
        `${remoteConfig.label} API key`,
        remoteConfig.helpUrl,
      );
      if (credentialPrompt.returningToProviderSelection(credentialResult)) {
        return "retry-selection";
      }
    }
    let modelValidator: ((candidate: string) => ModelValidationResult) | null = null;
    if (selected.key === "openai" || selected.key === "gemini") {
      const modelAuthMode = getProbeAuthMode(state.provider);
      modelValidator = (candidate) =>
        validateOpenAiLikeModel(
          remoteConfig.label,
          state.endpointUrl || remoteConfig.endpointUrl,
          candidate,
          getCredential(selectedCredentialEnv) || "",
          ...(modelAuthMode ? [{ authMode: modelAuthMode }] : []),
        );
    } else if (selected.key === "anthropic") {
      modelValidator = (candidate) =>
        validateAnthropicModel(
          state.endpointUrl || ANTHROPIC_ENDPOINT_URL,
          candidate,
          getCredential(selectedCredentialEnv) || "",
        );
    }
    while (true) {
      if (isNonInteractive()) {
        state.model = defaultModel;
      } else if (remoteConfig.modelMode === "curated") {
        state.model = await promptRemoteModel(
          remoteConfig.label,
          selected.key,
          defaultModel,
          modelValidator,
        );
      } else {
        state.model = await promptInputModel(remoteConfig.label, defaultModel, modelValidator);
      }
      if (isBackToSelection(state.model)) {
        console.log("  Returning to provider selection.");
        console.log("");
        return "retry-selection";
      }

      const validationResult = state.reuseGatewayCredentialWithoutLocalKey
        ? "selected"
        : await validateSelectedRemoteModel(
            // biome-ignore format: keep src/lib/onboard.ts net-neutral for growth guardrail.
            { selected, remoteConfig, state, selectedCredentialEnv, intendedInferenceApi },
          );
      if (validationResult === "selected") break;
      if (validationResult === "retry-selection") return "retry-selection";
    }
  }

  if (selected.key === "build") {
    const buildModel = requireValue(
      isBackToSelection(state.model) ? null : state.model,
      `Missing model for ${remoteConfig.label}`,
    );
    const buildValidation = await buildCredentialReuse.resolveBuildPreferredInferenceApi({
      reuseGatewayCredentialWithoutLocalKey: state.skipHostInferenceSmoke === true,
      note,
      probe: () =>
        validateOpenAiLikeSelection(
          remoteConfig.label,
          requireValue(state.endpointUrl, `Missing endpoint URL for ${remoteConfig.label}`),
          buildModel,
          state.credentialEnv,
          "Please choose a provider/model again.",
          remoteConfig.helpUrl,
          {
            requireResponsesToolCalling: shouldRequireResponsesToolCalling(state.provider),
            skipResponsesProbe: shouldSkipResponsesProbe(state.provider),
            authMode: getProbeAuthMode(state.provider),
          },
        ),
    });
    if (buildValidation.retrySelection) return "retry-selection";
    state.preferredInferenceApi = buildValidation.preferredInferenceApi;
  }

  console.log(`  Using ${remoteConfig.label} with model: ${state.model}`);
  return "selected";
}

export type SetupNimDeps = import("./onboard/setup-nim-flow").SetupNimFlowDeps;
export type SetupNim = import("./onboard/setup-nim-flow").SetupNim;

function getSetupNimDeps(): SetupNimDeps {
  return {
    remoteProviderConfig: REMOTE_PROVIDER_CONFIG,
    experimental: EXPERIMENTAL,
    ollamaPort: OLLAMA_PORT,
    vllmPort: VLLM_PORT,
    step,
    isNonInteractive,
    getNonInteractiveProvider,
    getNonInteractiveModel,
    createNvidiaFeaturedModelSession,
    detectInferenceProviderHostState,
    getAgentInferenceProviderOptions,
    loadRoutedProfile: () => loadBlueprintProfile("routed"),
    readRecordedProvider,
    readRecordedNimContainer,
    readRecordedModel,
    prompt,
    selectFromNumberedMenu: selectFromNumberedMenuOrExit,
    note,
    log: (message = "") => console.log(message),
    error: (message) => console.error(message),
    exitProcess: (code): never => process.exit(code),
    abortNonInteractive,
    rejectWindowsHostOllama: (requirement, providerKey, windowsHostSelected) =>
      rejectUnsupportedWindowsHostOllama(
        requirement,
        providerKey,
        windowsHostSelected,
        isNonInteractive,
        abortNonInteractive,
      ),
    handleRemoteProviderSelection,
    handleNimLocalSelection,
    handleRunningOllamaSelection,
    handleWindowsHostOllamaSelection,
    handleInstallOllamaSelection,
    installVllm,
    handleVllmSelection,
    handleRoutedSelection,
    coerceAgentInferenceApi: inferenceConfig.coerceAgentInferenceApi,
    clearCompatibleEndpointReasoning: reasoningMode.clearCompatibleEndpointReasoning,
    maybePromptForInferenceInputCapability: (model) =>
      inferenceInputCapability.maybePromptForInferenceInputCapability(model, {
        isNonInteractive,
        prompt,
      }),
  };
}

const setupNim = setupNimFlow.createSetupNim(getSetupNimDeps());

// ── Step 4: Inference provider ───────────────────────────────────

function getSetupInferenceDeps(): SetupInferenceDeps {
  return {
    step,
    getGatewayName: () => GATEWAY_NAME,
    runOpenshell,
    upsertProvider,
    verifyInferenceRoute,
    verifyOnboardInferenceSmoke,
    isNonInteractive,
    updateSandbox: registry.updateSandbox,
    hermesProviderAuth,
    getHermesToolGatewayBroker,
    providerExistsInGateway,
    normalizeHermesAuthMethod,
    resolveHermesNousApiKey,
    checkHermesProviderStoreReachable,
    hermesAuthMethodLabel,
    hermesConstants: {
      HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
      HERMES_AUTH_METHOD_API_KEY,
      HERMES_AUTH_METHOD_OAUTH,
    },
    requireValue,
    redact,
    compactText,
    REMOTE_PROVIDER_CONFIG,
    hydrateCredentialEnv,
    promptValidationRecovery,
    classifyApplyFailure,
    localInferenceTimeoutSecs: LOCAL_INFERENCE_TIMEOUT_SECS,
    bedrockRuntimeOnboard,
    validateLocalProvider,
    getLocalProviderHealthCheck,
    getLocalProviderBaseUrl,
    run,
    vllmLocalCredentialEnv: VLLM_LOCAL_CREDENTIAL_ENV,
    getOllamaWarmupCommand,
    shouldFrontOllamaWithProxy,
    ensureOllamaAuthProxy,
    isProxyHealthy,
    getOllamaProxyToken,
    persistAndProbeOllamaProxy,
    localInference,
    ollamaProxyCredentialEnv: OLLAMA_PROXY_CREDENTIAL_ENV,
    isRoutedInferenceProvider,
    reconcileModelRouter,
    routedInference,
    log: (message: string) => console.log(message),
    error: (message: string) => console.error(message),
    exitProcess: (code: number): never => process.exit(code),
  };
}

export type SetupInferenceDeps = import("./onboard/setup-inference").SetupInferenceDeps;
export type SetupInference = import("./onboard/setup-inference").SetupInference;

function createSetupInference(overrides: Partial<SetupInferenceDeps> = {}): SetupInference {
  return setupInferenceFactory.createSetupInference(getSetupInferenceDeps(), overrides);
}

const setupInference = createSetupInference();

// ── Step 6: Messaging channels ───────────────────────────────────

const MESSAGING_CHANNELS = listChannels();

function getRecordedMessagingChannelsForResume(
  resume: boolean,
  session: Session | null,
  sandboxName: string | null,
): string[] | null {
  return getRecordedMessagingChannelsForResumeFromState({
    resume,
    sessionMessagingChannels: getChannelsFromPlan(session?.messagingPlan),
    sandboxName,
    channels: MESSAGING_CHANNELS,
    getCredential,
    providerExistsInGateway,
    isNonInteractive,
  });
}

async function setupMessagingChannels(
  agent: AgentDefinition | null = null,
  existingChannels: string[] | null = null,
  sandboxName: string | null = null,
): Promise<string[]> {
  return setupMessagingChannelsImpl(agent, existingChannels, {
    step,
    note,
    isNonInteractive,
    sandboxName,
  });
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

function getPolicySelectionPromptHelpers(): ReturnType<typeof createPolicySelectionPromptHelpers> {
  return createPolicySelectionPromptHelpers({
    tiers,
    policyTierEnv,
    isNonInteractive,
    note,
    prompt,
    selectFromNumberedMenuOrExit,
    makeOnboardCancelExit,
    sandboxCancelRollback,
    useColor: USE_COLOR,
  });
}

async function selectPolicyTier(): Promise<string> {
  return getPolicySelectionPromptHelpers().selectPolicyTier();
}

async function selectTierPresetsAndAccess(
  tierName: string,
  allPresets: Array<{ name: string; description?: string }>,
  extraSelected: string[] = [],
): Promise<Array<{ name: string; access: string }>> {
  return getPolicySelectionPromptHelpers().selectTierPresetsAndAccess(
    tierName,
    allPresets,
    extraSelected,
  );
}

async function presetsCheckboxSelector(
  allPresets: Array<{ name: string; description: string }>,
  initialSelected: string[],
): Promise<string[]> {
  return getPolicySelectionPromptHelpers().presetsCheckboxSelector(allPresets, initialSelected);
}

const computeSetupPresetSuggestions = (
  tierName: string,
  options: SetupPresetSuggestionOptions = {},
): string[] =>
  computeSetupPresetSuggestionsImpl(
    { policies, tiers, localInferenceProviders: LOCAL_INFERENCE_PROVIDERS },
    tierName,
    options,
  );

async function setupPoliciesWithSelection(
  sandboxName: string,
  options: SetupPolicySelectionOptions = {},
) {
  return sandboxMutationLock.withSandboxMutationLock(sandboxName, () =>
    setupPoliciesWithSelectionImpl(
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
        setPolicyTier: (s, t) => registry.updateSandbox(s, { policyTier: t }),
        getRecordedPolicyTier: (s) => registry.getSandbox(s)?.policyTier ?? null,
        selectTierPresetsAndAccess,
        parsePolicyPresetEnv,
        env: process.env,
      },
      sandboxName,
      options,
    ),
  );
}

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

const sandboxCancelRollback = installSandboxCancelRollback({
  runOpenshell,
  registry,
  clearOnboardSession: onboardSession.clearSession,
}); // #4614

const startRecordedStep = onboardRuntimeBoundary.startRecordedStep.bind(onboardRuntimeBoundary);
const recordStepComplete = onboardRuntimeBoundary.recordStepComplete.bind(onboardRuntimeBoundary);
const recordStepSkipped = onboardRuntimeBoundary.recordStepSkipped.bind(onboardRuntimeBoundary);
const recordStepFailed = onboardRuntimeBoundary.recordStepFailed.bind(onboardRuntimeBoundary);
const recordStateSkipped = onboardRuntimeBoundary.recordStateSkipped.bind(onboardRuntimeBoundary);
const recordRepairEvent = onboardRuntimeBoundary.recordRepairEvent.bind(onboardRuntimeBoundary);
const recordStateResult =
  onboardRuntimeBoundary.recordStateResultWithStepCompatibility.bind(onboardRuntimeBoundary);
const recordCompatibleStateResult =
  onboardRuntimeBoundary.recordCompatibleStateResult.bind(onboardRuntimeBoundary);
const recordPostVerifyStarted =
  onboardRuntimeBoundary.recordPostVerifyStarted.bind(onboardRuntimeBoundary);

/** Run only non-mutating fatal onboard gates while the rebuild target is still intact. */
async function preflightAuthoritativeRebuildTarget(
  opts: import("./onboard/authoritative-rebuild-target").AuthoritativeRebuildPreflightOptions,
): Promise<void> {
  const authoritativeGateway =
    authoritativeRebuildTarget.resolveAuthoritativeOnboardGatewayBinding(opts);
  if (!authoritativeGateway) throw new Error("Authoritative rebuild preflight has no gateway");
  const previous = {
    dashboardPort: _preflightDashboardPort,
    gatewayName: GATEWAY_NAME,
    gatewayPort: GATEWAY_PORT,
    nonInteractive: NON_INTERACTIVE,
  };
  GATEWAY_NAME = authoritativeGateway.name;
  GATEWAY_PORT = authoritativeGateway.port;
  NON_INTERACTIVE = true;
  _preflightDashboardPort = opts.controlUiPort ?? null;
  const fail = (message: string): never => {
    throw new Error(message);
  };
  try {
    await authoritativeRebuildTarget.preflightAuthoritativeRebuildTarget(
      { ...opts, controlUiPort: opts.controlUiPort ?? null },
      {
        runFatalRuntimePreflight: () =>
          fatalRuntimePreflight.runFatalOnboardRuntimePreflight(
            {
              sandboxGpu: opts.sandboxGpu,
              sandboxGpuDevice: opts.sandboxGpuDevice,
              noGpu: opts.noGpu,
            },
            {
              nonInteractive: true,
              exitProcess: (code) =>
                fail(`onboard runtime preflight exited with code ${String(code)}`),
            },
          ),
        ensureOpenshell: () =>
          ensureOpenshellForOnboard((code) =>
            fail(`OpenShell component preflight exited with code ${String(code)}`),
          ),
        inferenceRouteReady: isInferenceRouteReady,
        captureForwardList: () => runCaptureOpenshell(["forward", "list"], { ignoreError: true }),
        checkPort: (port) => checkPortAvailable(port),
      },
    );
  } finally {
    GATEWAY_NAME = previous.gatewayName;
    GATEWAY_PORT = previous.gatewayPort;
    NON_INTERACTIVE = previous.nonInteractive;
    _preflightDashboardPort = previous.dashboardPort;
  }
}

// ── Main ─────────────────────────────────────────────────────────
const onboard = onboardEntryOptions.withNonInteractiveEnvironment(runOnboard);
async function runOnboard(opts: OnboardOptions = {}): Promise<void> {
  const requestedToolDisclosure = toolDisclosureFlow.applyOnboardToolDisclosureRequest(
    opts.toolDisclosure,
  );
  const authoritativeGateway =
    authoritativeRebuildTarget.resolveAuthoritativeOnboardGatewayBinding(opts);
  const previousGatewayBinding = { name: GATEWAY_NAME, port: GATEWAY_PORT };
  const previousOpenshellGateway = process.env.OPENSHELL_GATEWAY;
  const preparedDcodeRuntime = preparedDcodeRebuild.createPreparedDcodeRebuildRuntime(
    opts,
    authoritativeGateway?.name ?? GATEWAY_NAME,
  );
  setOnboardBrandingAgent(opts.agent || process.env.NEMOCLAW_AGENT || null);
  NON_INTERACTIVE = opts.nonInteractive || process.env.NEMOCLAW_NON_INTERACTIVE === "1";
  RECREATE_SANDBOX = opts.recreateSandbox || process.env.NEMOCLAW_RECREATE_SANDBOX === "1";
  AUTO_YES = opts.autoYes === true || process.env.NEMOCLAW_YES === "1";
  _preflightDashboardPort =
    opts.controlUiPort ?? (process.env.NEMOCLAW_DASHBOARD_PORT != null ? DASHBOARD_PORT : null);
  onboardRuntimeBoundary.reset();
  if (!authoritativeGateway) delete process.env.OPENSHELL_GATEWAY;
  preparedDcodeRuntime.applyGatewayEnv(process.env);
  const { resume, fresh, requestedFromDockerfile, requestedSandboxName, cannotPrompt } =
    onboardEntryOptions.resolveOnboardEntryOptions(
      {
        opts,
        env: process.env,
        stdinIsTty: Boolean(process.stdin && process.stdin.isTTY),
        stdoutIsTty: Boolean(process.stdout && process.stdout.isTTY),
        persistedSessionStatus: onboardSession.loadSession()?.status ?? null,
      },
      {
        isNonInteractive,
        validateName,
        reservedSandboxNames: RESERVED_SANDBOX_NAMES,
        cliDisplayName,
        getNameValidationGuidance,
        error: (message) => console.error(message),
        exitProcess: (code) => process.exit(code),
      },
    );
  const baseImageResolutionContext = baseImageResolutionFlow.createBaseImageResolutionContext({
    fresh,
    initialHint: opts.baseImageResolutionHint,
  });
  if (isNonInteractive()) policyTierEnv.validatePolicyTierEnvEarly();
  const noticeAccepted = await ensureUsageNoticeConsent({
    nonInteractive: isNonInteractive(),
    acceptedByFlag: opts.acceptThirdPartySoftware === true,
    writeLine: console.error,
  });
  if (!noticeAccepted) {
    process.exit(1);
  }
  // Validate provider/model hints before preflight so configuration errors are not reported as Docker failures.
  // biome-ignore format: keep src/lib/onboard.ts net-neutral for growth guardrail.
  resumeConfig.preflightEarlyOnboardEnvForResume(isNonInteractive(), opts.authoritativeResumeConfig === true);
  const ownsOnboardLock = opts.onboardLockAlreadyHeld !== true;
  const lockResult = ownsOnboardLock
    ? onboardSession.acquireOnboardLock(
        `nemoclaw onboard${resume ? " --resume" : ""}${fresh ? " --fresh" : ""}${isNonInteractive() ? " --non-interactive" : ""}${requestedFromDockerfile ? ` --from ${requestedFromDockerfile}` : ""}`,
      )
    : { acquired: true as const };
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
    if (lockReleased || !ownsOnboardLock) return;
    lockReleased = true;
    onboardSession.releaseOnboardLock();
  };
  if (ownsOnboardLock) process.once("exit", releaseOnboardLock);

  if (authoritativeGateway) {
    GATEWAY_NAME = authoritativeGateway.name;
    GATEWAY_PORT = authoritativeGateway.port;
    process.env.OPENSHELL_GATEWAY = authoritativeGateway.name;
  }

  let onboardTrace: ReturnType<typeof onboardTracing.startOnboardTrace> = {
    collector: null,
    span: null,
  };
  let traceCompleted = false;
  try {
    onboardTrace = onboardTracing.startOnboardTrace(opts, process.env);
    let selectedMessagingChannels: string[] = [];
    let { session, fromDockerfile } = await onboardSessionBootstrap.prepareOnboardSession(
      {
        resume,
        fresh,
        requestedFromDockerfile,
        requestedSandboxName,
        cannotPrompt,
        nonInteractive: isNonInteractive(),
        authoritativeResumeConfig: opts.authoritativeResumeConfig === true,
        agentFlag: opts.agent || null,
        envAgent: process.env.NEMOCLAW_AGENT || null,
        requestedToolDisclosure,
      },
      {
        loadSession: onboardSession.loadSession,
        clearSession: onboardSession.clearSession,
        createSession: onboardSession.createSession,
        saveSession: onboardSession.saveSession,
        updateSession: onboardSession.updateSession,
        repairResumeMachineSnapshot,
        setOnboardBrandingAgent,
        getResumeConfigConflicts,
        recordResumeConflict: (conflict) => onboardRuntimeBoundary.recordResumeConflict(conflict),
        resolvePath: path.resolve,
        cliName,
        error: (message) => console.error(message),
        exitProcess: (code) => process.exit(code),
      },
    );
    await onboardRuntimeBoundary.recordOnboardStarted(resume);
    await (resume ? recordCompatibleStateResult : recordStateResult)(
      advanceTo("preflight", { metadata: { state: "init" } }),
    );
    // Resume backstop: a session may exist without a sandboxName if sandbox
    // creation failed before that step. Non-interactive --from cannot infer a
    // safe name in that state.
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
    registerIncompleteOnboardExitHandlerForSession(onboardSession, () => completed);

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

    console.log("");
    console.log(`  ${cliDisplayName()} Onboarding`);
    if (isNonInteractive()) note("  (non-interactive mode)");
    if (resume) note("  (resume mode)");
    console.log("  ===================");

    const explicitSandboxGpuFlag = resolveSandboxGpuFlagFromOptions(opts);
    const recordedGpuPassthroughBeforePreflight = session?.gpuPassthrough === true;
    type InitialOnboardFlowContext =
      import("./onboard/machine/initial-flow-phases").InitialOnboardFlowContext<
        typeof agent,
        ReturnType<typeof nim.detectGpu>,
        ReturnType<typeof resolveSandboxGpuConfig>
      >;
    const initialFlowContext: InitialOnboardFlowContext = {
      resume,
      fresh,
      session,
      agent,
      recordedSandboxName,
      requestedSandboxName,
      sandboxName: recordedSandboxName || requestedSandboxName || null,
      fromDockerfile,
      model: session?.model || null,
      provider: session?.provider || null,
      endpointUrl: session?.endpointUrl || null,
      credentialEnv: session?.credentialEnv || null,
      hermesAuthMethod: normalizeHermesAuthMethod(session?.hermesAuthMethod),
      hermesToolGateways: normalizeHermesToolGatewaySelections(session?.hermesToolGateways),
      preferredInferenceApi: session?.preferredInferenceApi || null,
      compatibleEndpointReasoning: session?.compatibleEndpointReasoning || null,
      nimContainer: session?.nimContainer || null,
      webSearchConfig: session?.webSearchConfig || null,
      webSearchSupported: false,
      selectedMessagingChannels,
      gpu: null,
      sandboxGpuConfig: null,
      gpuPassthrough: false,
      resumeHasResolvedGpuIntent: false,
      requestedGpuPassthrough: opts.gpu === true,
    };

    const [preflightPhase, gatewayPhase]: readonly [
      import("./onboard/machine/sequence-runner").OnboardSequencePhase<InitialOnboardFlowContext>,
      import("./onboard/machine/sequence-runner").OnboardSequencePhase<InitialOnboardFlowContext>,
    ] = createInitialOnboardFlowPhases({
      explicitSandboxGpuFlag,
      sandboxGpuDevice: opts.sandboxGpuDevice ?? null,
      gpuRequested: opts.gpu === true,
      noGpu: opts.noGpu === true,
      env: process.env,
      recordedGpuPassthroughBeforePreflight,
      ensureResumePreflightDashboardPortAvailable: () => {
        if (_preflightDashboardPort === null) preflightDashboardPortRangeAvailability();
      },
      preflightDeps: {
        getSandbox: registry.getSandbox.bind(registry),
        getResumeSandboxGpuOverrides,
        detectGpu: nim.detectGpu,
        runPreflight: (preflightOptions) => preflight({ ...opts, ...preflightOptions }),
        assessHost,
        assertCdiNvidiaGpuSpecPresent: preflightUtils.assertCdiNvidiaGpuSpecPresent,
        rejectUnsupportedContainerRuntime: fatalRuntimePreflight.rejectUnsupportedContainerRuntime,
        assertDockerBridgeAndContainerDnsHealthy,
        resolveSandboxGpuConfig,
        validateSandboxGpuPreflight,
        skippedStepMessage,
        recordStateSkipped,
        startRecordedStep,
        recordStepComplete,
        updateSession: onboardSession.updateSession,
      },
      getInitialGatewayReuseState: () =>
        selectNamedGatewayForReuseIfNeeded(getGatewayReuseSnapshot()).gatewayReuseState,
      gatewayName: GATEWAY_NAME,
      recreateSandbox: isRecreateSandbox,
      gatewayDeps: {
        refreshDockerDriverGatewayReuseState,
        gatewayCliSupportsLifecycleCommands: () =>
          gatewayCliSupportsLifecycleCommands(runCaptureOpenshell),
        verifyGatewayContainerRunning,
        waitForGatewayHttpReady,
        recoverGatewayRuntime,
        getGatewayLocalEndpoint,
        stopDashboardForward: () => bestEffortForwardStop(runOpenshell, getOnboardDashboardPort()),
        destroyGateway,
        destroyGatewayForReuse,
        getGatewayClusterImageDrift,
        stopAllDashboardForwards,
        reconcileGatewayGpuReuseForGpuIntent,
        isLinuxDockerDriverGatewayEnabled,
        retireLegacyGatewayForDockerDriverUpgrade,
        destroyGatewayRuntimeForGpuReuse: () =>
          destroyGateway(
            () => undefined,
            () => false,
          ),
        skippedStepMessage,
        recordStateSkipped,
        note,
        startRecordedStep,
        startGateway,
        recordStepComplete,
        exitProcess: (code) => process.exit(code),
      },
      note,
    });
    const initialFlowResult = await runInitialOnboardFlowSlice({
      context: initialFlowContext,
      runtime: onboardRuntimeBoundary.getRuntime(),
      phases: [preflightPhase, gatewayPhase],
      resume,
      recordStateResult: recordCompatibleStateResult,
    });

    const initialContext = initialFlowResult.context;
    if (!initialContext.sandboxGpuConfig) {
      throw new Error("Preflight did not produce a sandbox GPU configuration.");
    }
    session = initialFlowResult.session;
    const sandboxGpuConfig = initialContext.sandboxGpuConfig;
    const { gpuPassthrough } = initialContext;
    const gpu = initialContext.gpu ?? null;

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

    const coreFlowContext: InitialOnboardFlowContext = {
      ...initialContext,
      session,
      sandboxName,
      selectedMessagingChannels,
      gpu,
      sandboxGpuConfig,
      gpuPassthrough,
    };

    const [providerInferencePhase, sandboxPhase] =
      createCoreOnboardFlowPhases<InitialOnboardFlowContext>({
        forceProviderSelection: forceProviderSelectionForAgentChange,
        ...authoritativeRebuildTarget.rebuildProviderFlowOptions(opts, coreFlowContext),
        env: process.env,
        constants: {
          hermesProviderName: hermesProviderAuth.HERMES_PROVIDER_NAME,
          hermesApiKeyAuthMethod: HERMES_AUTH_METHOD_API_KEY,
          hermesApiKeyCredentialEnv: HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
        },
        providerDeps: {
          normalizeHermesAuthMethod,
          setupNim: (gpu, sandboxName, agent, recoverProvider) =>
            setupNim(gpu, sandboxName, agent, recoverProvider, opts.rebuildRegistryInferenceRoute),
          setupInference,
          startRecordedStep,
          recordStepComplete,
          toSessionUpdates: (updates) =>
            toSessionUpdates(updates as Parameters<typeof toSessionUpdates>[0]),
          skippedStepMessage,
          ...resumeProviderShim,
          recordStateSkipped,
          recordRepairEvent,
          hydrateCredentialEnv,
          configureCompatibleEndpointReasoning: reasoningMode.configureCompatibleEndpointReasoning,
          clearCompatibleEndpointReasoning: reasoningMode.clearCompatibleEndpointReasoning,
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
            const r = routedInference.upsertRoutedProvider(p, url, ce, {
              upsertProvider,
              hydrateCredentialEnv,
            });
            return {
              ok: r.ok,
              endpointUrl: r.endpointUrl,
              message: r.result.message,
              status: r.result.status,
            };
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
        sandbox: {
          resumeAgentChanged,
          controlUiPort: opts.controlUiPort || null,
          rootDir: ROOT,
        },
        sandboxDeps: {
          resolvePath: preparedDcodeRuntime.resolveDockerfileProbePath,
          agentSupportsWebSearch,
          agentSupportsWebSearchProvider,
          note,
          updateSession: onboardSession.updateSession,
          getStoredMessagingChannelConfig,
          hydrateMessagingChannelConfig,
          messagingChannelConfigsEqual,
          getSandboxReuseState,
          getDcodeSelectionDrift: (name, selectedProvider, selectedModel, selectedApi) =>
            getDcodeSelectionDrift(name, selectedProvider, selectedModel, selectedApi, {
              runCaptureOpenshell,
            }),
          hasSandboxGpuDrift,
          getSandboxHermesToolGateways: (name) => registry.getSandbox(name)?.hermesToolGateways,
          getSandboxRegistryEntry: registry.getSandbox,
          normalizeHermesToolGatewaySelections,
          stringSetsEqual,
          removeSandboxFromRegistry: registry.removeSandbox.bind(registry),
          repairRecordedSandbox,
          ensureValidatedWebSearchCredential,
          isBackToSelection,
          configureWebSearch,
          startRecordedStep,
          getRecordedMessagingChannelsForResume,
          setupMessagingChannels,
          readMessagingPlanFromEnv,
          writePlanToEnv,
          clearPlanEnv,
          getRegistrySandboxMessagingPlan,
          promptValidatedSandboxName,
          selectResourceProfileForSandbox: () =>
            selectResourceProfileForSandbox({ isNonInteractive, note, prompt, promptOrDefault }),
          stopStaleDashboardListenersForSandbox,
          listRegistrySandboxes: registry.listSandboxes,
          createSandbox: preparedDcodeRuntime.bindCreateSandbox(
            createSandboxWithBaseImageResolution.bind(null, baseImageResolutionContext),
          ),
          updateSandboxRegistry: (name, updates) => registry.updateSandbox(name, updates),
          getSandboxAgentRegistryFields,
          recordStepComplete,
          toSessionUpdates: (updates) =>
            toSessionUpdates(updates as Parameters<typeof toSessionUpdates>[0]),
          skippedStepMessage,
          recordStateSkipped,
          recordRepairEvent,
          withSandboxMutationLock: sandboxMutationLock.withSandboxMutationLock,
          error: (message) => console.error(message),
          exitProcess: (code) => process.exit(code),
        },
      });
    const coreFlowResult = await runCoreOnboardFlowSlice({
      context: coreFlowContext,
      runtime: onboardRuntimeBoundary.getRuntime(),
      phases: [providerInferencePhase, sandboxPhase],
      resume,
      recordStateResult: recordCompatibleStateResult,
    });
    const coreContext = coreFlowResult.context;
    session = coreContext.session;
    sandboxName = coreContext.sandboxName;
    if (!sandboxName || !coreContext.model || !coreContext.provider) {
      throw new Error("Onboarding state is incomplete after sandbox setup.");
    }
    const model = coreContext.model;
    const provider = coreContext.provider;
    const endpointUrl = coreContext.endpointUrl;
    const credentialEnv = coreContext.credentialEnv;
    const hermesAuthMethod = coreContext.hermesAuthMethod;
    const hermesToolGateways = coreContext.hermesToolGateways;
    const nimContainer = coreContext.nimContainer;
    let webSearchConfig = coreContext.webSearchConfig as WebSearchConfig | null;
    const webSearchSupported = coreContext.webSearchSupported;

    const finalFlowContext: InitialOnboardFlowContext = {
      ...coreContext,
      session,
      sandboxName,
      model,
      provider,
      endpointUrl,
      credentialEnv,
      hermesAuthMethod,
      hermesToolGateways,
      nimContainer,
      webSearchConfig,
      selectedMessagingChannels: coreContext.selectedMessagingChannels,
      webSearchSupported,
    };
    let liveFinalFlowContext = finalFlowContext;

    const [branchSetupPhase, policiesPhase, finalizationPhase] = createFinalOnboardFlowPhases<
      InitialOnboardFlowContext,
      import("./dashboard/contract").DashboardDeliveryChain,
      import("./verify-deployment").VerifyDeploymentResult
    >({
      branchState: agent ? "agent_setup" : "openclaw",
      agentSetupDeps: {
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
        ensureAgentDashboardForward: (name, selectedAgent) =>
          selectedAgent ? ensureAgentDashboardForward(name, selectedAgent) : 0,
        recordStepSkipped,
        isOpenclawReady,
        skippedStepMessage,
        recordStateSkipped,
        startRecordedStep,
        setupOpenclaw,
        syncNemoClawConfigInSandbox,
        recordStepComplete,
        toSessionUpdates: (updates) =>
          toSessionUpdates(updates as Parameters<typeof toSessionUpdates>[0]),
      },
      policiesDeps: {
        loadSession: onboardSession.loadSession,
        getActiveSandbox: (name) => registry.getSandbox(name),
        mergePolicyMessagingChannels,
        verifyCompatibleEndpointSandboxSmoke: (options) =>
          verifyCompatibleEndpointSandboxSmoke({ ...options, runOpenshell, redact }),
        preparePolicyPresetResumeSelection: (name, options) =>
          preparePolicyPresetResumeSelection({ policies }, name, options),
        arePolicyPresetsApplied,
        skippedStepMessage,
        recordStateSkipped,
        startRecordedStep,
        setupPoliciesWithSelection,
        updateSession: onboardSession.updateSession,
        recordStepComplete,
        toSessionUpdates: (updates) =>
          toSessionUpdates(updates as Parameters<typeof toSessionUpdates>[0]),
        persistAppliedPolicyPresets: policyPresetCarry.persistFinalizedPolicyPresets,
      },
      finalization: {
        stagedLegacyKeys,
        migratedLegacyKeys,
        webSearchEnabled: (config) => braveProviderProfile.shouldEnableBraveWebSearch(config),
      },
      finalizationDeps: {
        ensureAgentDashboardForward: (name, selectedAgent) =>
          selectedAgent ? ensureAgentDashboardForward(name, selectedAgent) : 0,
        setDefaultSandbox: registry.setDefault,
        verifyWebSearchInsideSandbox,
        recordPostVerifyStarted,
        toSessionUpdates: (updates) =>
          toSessionUpdates(updates as Parameters<typeof toSessionUpdates>[0]),
        removeLegacyCredentialsFile,
        cleanupStaleHostFiles,
        ...finalizationHandlerDeps,
        getChatUiUrl: () => process.env.CHAT_UI_URL || `http://127.0.0.1:${DASHBOARD_PORT}`,
        buildVerifyChain: (chatUiUrl) =>
          // biome-ignore format: keep src/lib/onboard.ts net-neutral for growth guardrail.
          buildChain({ chatUiUrl, isWsl: isWsl(), wslHostAddress: getWslHostAddress(), dashboardHealthEndpoint: agent?.dashboard.healthPath, gatewayPort: agent?.healthProbe?.port, gatewayHealthEndpoint: agent?.healthProbe?.url }),
        verifyDeployment: async (name, chain) => {
          const verifyDeploymentModule: typeof import("./verify-deployment") =
            require("./verify-deployment");
          return verifyDeploymentModule.verifyDeployment(name, chain, {
            executeSandboxCommand: (sandbox: string, script: string) =>
              executeSandboxCommandForVerification(sandbox, script),
            probeHostPort: (port: number, probePath: string) => {
              const result = runCapture(
                [
                  "curl",
                  "-so",
                  "/dev/null",
                  "-w",
                  "%{http_code}",
                  "--max-time",
                  "3",
                  `http://127.0.0.1:${port}${probePath}`,
                ],
                { ignoreError: true },
              );
              return parseInt(result.trim(), 10) || 0;
            },
            captureForwardList: () =>
              runCaptureOpenshell(["forward", "list"], { ignoreError: true }) || null,
            getMessagingChannels: () => liveFinalFlowContext.selectedMessagingChannels || [],
            providerExistsInGateway: (providerName: string) =>
              providerExistsInGateway(providerName),
          });
        },
        formatVerificationDiagnostics: (result) => {
          const verifyDeploymentModule: typeof import("./verify-deployment") =
            require("./verify-deployment");
          return verifyDeploymentModule.formatVerificationDiagnostics(result);
        },
        printDashboard,
        error: (message) => console.error(message),
        log: (message) => console.log(message),
      },
    });

    await runFinalOnboardFlowSlice({
      context: finalFlowContext,
      runtime: onboardRuntimeBoundary.getRuntime(),
      phases: [branchSetupPhase, policiesPhase, finalizationPhase],
      resume,
      recordStateResult: recordCompatibleStateResult,
      afterPoliciesResultApplied: () => {
        sandboxCancelRollback.disarm();
      },
      onContextUpdated: (context) => {
        liveFinalFlowContext = context;
      },
    });
    completed = true;
    traceCompleted = true;
  } finally {
    releaseOnboardLock();
    onboardRuntimeBoundary.clear();
    onboardTracing.finishOnboardTrace(onboardTrace, traceCompleted);
    if (authoritativeGateway) {
      GATEWAY_NAME = previousGatewayBinding.name;
      GATEWAY_PORT = previousGatewayBinding.port;
      if (previousOpenshellGateway === undefined) delete process.env.OPENSHELL_GATEWAY;
      else process.env.OPENSHELL_GATEWAY = previousOpenshellGateway;
    }
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
  ensureValidatedWebSearchCredential,
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
  preflightAuthoritativeRebuildTarget,
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
  agentSupportsWebSearchProvider,
  createSetupInference,
  setupInference,
  setupMessagingChannels,
  MESSAGING_CHANNELS,
  selectOnboardAgent,
  setupNim,
  providerNameToOptionKey: (
    name: string | null | undefined,
    opts: { hasNimContainer?: boolean } = {},
  ) => providerRecovery.providerNameToOptionKey(REMOTE_PROVIDER_CONFIG, name, opts),
  readRecordedProvider,
  readRecordedModel,
  readRecordedNimContainer,
  readRecordedEndpointUrl,
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
  registerIncompleteOnboardExitHandlerForSession,
  hydrateCredentialEnv,
  pruneKnownHostsEntries,
  shouldIncludeBuildContextPath,
  writeSandboxConfigSyncFile,
  patchStagedDockerfile,
  ensureOllamaAuthProxy,
  fetchGatewayAuthTokenFromSandbox,
  getProbeAuthMode,
  getValidationProbeCurlArgs,
  verifyCompatibleEndpointSandboxSmoke,
  resumeProviderShimDeps: { isRoutedInferenceProvider, replaceNamedCredential },
};
