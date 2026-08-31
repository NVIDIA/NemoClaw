// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Interactive onboarding wizard — 8 steps from zero to running sandbox.
const {
  envInt,
  LOCAL_INFERENCE_TIMEOUT_SECS,
}: typeof import("./onboard/env") = require("./onboard/env");
const {
  isNonInteractiveEnv,
}: typeof import("./core/non-interactive") = require("./core/non-interactive");
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
  assertSelectionMutationAuthority,
  credentialMutationGuardFor,
  withCredentialMutationGuard,
  resolveCompatibleEndpointSelection,
  selectFeaturedModelAfterCredentialPrompt,
}: typeof import("./onboard/setup-nim-selection") = require("./onboard/setup-nim-selection");
const setupNimFlow: typeof import("./onboard/setup-nim-flow") = require("./onboard/setup-nim-flow");
const setupNimRoutedSelection: typeof import("./onboard/inference-providers/routed-selection") = require("./onboard/inference-providers/routed-selection");
const openrouterSelection: typeof import("./onboard/openrouter-selection") = require("./onboard/openrouter-selection");
const setupNimOllama: typeof import("./onboard/setup-nim-ollama") = require("./onboard/setup-nim-ollama");
const inferenceInputCapability = require("./onboard/inference-input-capability");
const reasoningMode: typeof import("./onboard/reasoning-mode") = require("./onboard/reasoning-mode");
const toolDisclosureFlow: typeof import("./onboard/tool-disclosure-flow") = require("./onboard/tool-disclosure-flow");
const runtimeControlFlow: typeof import("./onboard/runtime-control-flow") = require("./onboard/runtime-control-flow");
const dcodeAutoApprovalFlow: typeof import("./onboard/dcode-auto-approval") = require("./onboard/dcode-auto-approval");
const observabilityPolicy: typeof import("./onboard/observability-policy-presets") = require("./onboard/observability-policy-presets");
const observabilityCommandFlag: typeof import("./onboard/observability-command-flag") = require("./onboard/observability-command-flag");
const inferenceRouteHelpers: typeof import("./onboard/inference-route") = require("./onboard/inference-route");
const {
  abortNonInteractive,
}: typeof import("./onboard/non-interactive-abort") = require("./onboard/non-interactive-abort");
const extraPlaceholderKeysModule: typeof import("./onboard/extra-placeholder-keys") = require("./onboard/extra-placeholder-keys");
const preparedDcodeRebuild: typeof import("./onboard/prepared-dcode-rebuild") = require("./onboard/prepared-dcode-rebuild");
const sandboxBuildPatchConfig: typeof import("./onboard/sandbox-build-patch-config") = require("./onboard/sandbox-build-patch-config");
const baseImageResolutionFlow: typeof import("./onboard/base-image-resolution-flow") = require("./onboard/base-image-resolution-flow");
const sandboxCreateIntentResolution: typeof import("./onboard/sandbox-create-intent-resolution") = require("./onboard/sandbox-create-intent-resolution");
const sandboxCreateOrchestration: typeof import("./onboard/sandbox-create/orchestration") = require("./onboard/sandbox-create/orchestration");
const managedWorkloadOnboard: typeof import("./onboard/managed-workload/onboard-orchestration") = require("./onboard/managed-workload/onboard-orchestration");
const onboardEntryOptions: typeof import("./onboard/entry-options") = require("./onboard/entry-options");
const onboardSessionBootstrap: typeof import("./onboard/session-bootstrap") = require("./onboard/session-bootstrap");
const resumeRuntime: typeof import("./onboard/resume/locked-runtime") = require("./onboard/resume/locked-runtime");
const channelState: typeof import("./onboard/channel-state") = require("./onboard/channel-state");
const {
  ensureOllamaLoopbackSystemdOverride,
}: typeof import("./onboard/ollama-systemd") = require("./onboard/ollama-systemd");
const { bestEffortForwardStop } = require("./onboard/forward-cleanup");
const {
  buildCompatibleEndpointSandboxSmokeCommand,
  buildCompatibleEndpointSandboxSmokeScript,
  verifyCompatibleEndpointSandboxSmoke,
}: typeof import("./onboard/compatible-endpoint-smoke") = require("./onboard/compatible-endpoint-smoke");
const {
  createNemoClawConfigSync,
}: typeof import("./onboard/config-sync") = require("./onboard/config-sync");
const dockerGpuLocalInference: typeof import("./onboard/docker-gpu-local-inference") = require("./onboard/docker-gpu-local-inference");
const dockerGpuSandboxCreate: typeof import("./onboard/docker-gpu-sandbox-create") = require("./onboard/docker-gpu-sandbox-create");
const dockerGpuRoute: typeof import("./onboard/docker-gpu-route") = require("./onboard/docker-gpu-route");
const sandboxGpuCreateFlow: typeof import("./onboard/sandbox-gpu-create-flow") = require("./onboard/sandbox-gpu-create-flow");
const dockerDriverGatewayRuntime: typeof import("./onboard/docker-driver-gateway-runtime") = require("./onboard/docker-driver-gateway-runtime");
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
  discloseInitialSandboxPolicy,
}: typeof import("./onboard/initial-policy") = require("./onboard/initial-policy");
const {
  getSelectionDrift,
}: typeof import("./onboard/selection-drift") = require("./onboard/selection-drift");
const {
  createDcodeSelectionDriftReader,
  requiresSelectionRecreate,
  usesManagedDcodeIdentity,
}: typeof import("./onboard/dcode-selection-drift") = require("./onboard/dcode-selection-drift");
const {
  completeOrdinaryOnboardSandboxCreation,
  createOnboardCreatedSandboxCompletion,
  createOnboardCreatedSandboxRegistration,
}: typeof import("./onboard/created-sandbox-finalization") = require("./onboard/created-sandbox-finalization");
const providerKeyBridge: typeof import("./onboard/provider-key-bridge") = require("./onboard/provider-key-bridge");
const compatibleEndpointGatewayRoute: typeof import("./onboard/inference-providers/compatible-endpoint-gateway-route") = require("./onboard/inference-providers/compatible-endpoint-gateway-route");
const dockerDriverPlatform: typeof import("./onboard/docker-driver-platform") = require("./onboard/docker-driver-platform");
const { isLinuxDockerDriverGatewayEnabled } = dockerDriverPlatform;
const {
  reconcileGatewayGpuReuseForGpuIntent,
}: typeof import("./onboard/gateway-gpu-passthrough") = require("./onboard/gateway-gpu-passthrough");
const {
  maybeForceE2eStepFailure,
}: typeof import("./onboard/e2e-failure-injection") = require("./onboard/e2e-failure-injection");
const onboardTracing: typeof import("./onboard/tracing") = require("./onboard/tracing");
const sandboxReadinessTracing: typeof import("./onboard/sandbox-readiness-tracing") = require("./onboard/sandbox-readiness-tracing");
const messagingChannelSetup: typeof import("./onboard/messaging-channel-setup") = require("./onboard/messaging-channel-setup");
const { applySessionRecovery } =
  require("./onboard/session-recovery") as typeof import("./onboard/session-recovery");
const bedrockRuntimeOnboard: typeof import("./onboard/bedrock-runtime") = require("./onboard/bedrock-runtime");
const openrouterRuntimeOnboard: typeof import("./onboard/openrouter-runtime") = require("./onboard/openrouter-runtime");
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
const os = require("os");
const path = require("path");
const runner: typeof import("./runner") = require("./runner");
const { ROOT, SCRIPTS, redact, run, runCapture, runCaptureEx, runFile, validateName } = runner;
const braveProviderProfile: typeof import("./onboard/brave-provider-profile") = require("./onboard/brave-provider-profile");
const {
  applyExtraProviderReconciliation,
  planRegisteredExtraProviders,
  runSandboxProviderPreDeleteCleanup,
} =
  require("./onboard/sandbox-provider-cleanup") as typeof import("./onboard/sandbox-provider-cleanup");
const docker: typeof import("./adapters/docker") = require("./adapters/docker");
const {
  dockerContainerInspectFormat,
  dockerExecArgv,
  dockerInfoFormat,
  dockerInspect,
  dockerRemoveVolumesByPrefix,
  dockerRm,
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
  ollamaModelRefsMatch,
}: typeof import("./inference/ollama/model-discovery") = require("./inference/ollama/model-discovery");
const {
  resetOllamaHostCache,
  getLocalProviderBaseUrl,
  getLocalProviderHealthCheck,
  getLocalProviderValidationBaseUrl,
  getOllamaWarmupCommand,
  validateLocalProvider,
} = localInference;
const resolveNonInteractiveModel = localInference.resolveNonInteractiveOllamaModel;
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
  prepareOllamaModel,
  printOllamaExposureWarning,
  promptOllamaModel,
  unloadOllamaModels,
} = require("./inference/ollama/proxy");
const {
  installOllamaOnWindowsHost,
  awaitWindowsOllamaReady,
  setupWindowsOllamaWith0000Binding,
  switchToWindowsOllamaHost,
  printWindowsOllamaTimeoutDiagnostics,
} = require("./inference/ollama/windows");
const vllmInference = require("./inference/vllm");
const inferenceConfig: typeof import("./inference/config") = require("./inference/config");
const { getProviderSelectionConfig, parseGatewayInference } = inferenceConfig;

const onboardProviders = require("./onboard/providers");
const credentialProviderRegistration: typeof import("./onboard/credential-provider-registration") = require("./onboard/credential-provider-registration");
const setupInferenceFactory: typeof import("./onboard/setup-inference") = require("./onboard/setup-inference");
const hermesProviderAuth = require("./hermes-provider-auth");
const onboardHermesDashboard: typeof import("./onboard/hermes-dashboard") = require("./onboard/hermes-dashboard");
const hermesAuth: typeof import("./onboard/hermes-auth") = require("./onboard/hermes-auth");
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
  getGatewayHealthWaitConfig,
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
} = credentials;
const {
  hashCredential,
}: typeof import("./security/credential-hash") = require("./security/credential-hash");
const {
  cleanupStaleHostFiles,
}: typeof import("./host-artifact-cleanup") = require("./host-artifact-cleanup");
const registry: typeof import("./state/registry") = require("./state/registry");
const sandboxMutationLock: typeof import("./state/mcp-lifecycle-lock") = require("./state/mcp-lifecycle-lock");
const gatewayRouteMutationLock: typeof import("./inference/gateway-route-mutation-lock") = require("./inference/gateway-route-mutation-lock");
const nim: typeof import("./inference/nim") = require("./inference/nim");
const onboardSession: typeof import("./state/onboard-session") = require("./state/onboard-session");
const { markCancellationRecovery: recordRecovery } = onboardSession;
const portableRetirementAuthority: typeof import("./onboard/portable-retirement-authority") = require("./onboard/portable-retirement-authority");
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
const openclawSetup: typeof import("./onboard/openclaw-setup") = require("./onboard/openclaw-setup");
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
const credentialNavigation: typeof import("./onboard/credential-navigation") = require("./onboard/credential-navigation");
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
const messagingPlanSession: typeof import("./onboard/messaging-plan-session") = require("./onboard/messaging-plan-session");
const { getChannelsFromPlan } = messagingPlanSession;
const sandboxAgent: typeof import("./onboard/sandbox-agent") = require("./onboard/sandbox-agent");
const sandboxLifecycle: typeof import("./onboard/sandbox-lifecycle") = require("./onboard/sandbox-lifecycle");
const sandboxRegistryMetadata: typeof import("./onboard/sandbox-registry-metadata") = require("./onboard/sandbox-registry-metadata");
const sandboxReuse: typeof import("./onboard/sandbox-reuse") = require("./onboard/sandbox-reuse");
const sandboxRecreateTransaction: typeof import("./onboard/sandbox-recreate-transaction") = require("./onboard/sandbox-recreate-transaction");
const {
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
  checkpointSandboxName: (sandboxName, agent) =>
    onboardSessionBootstrap.checkpointSandboxName(sandboxName, agent, onboardSession.updateSession),
  exit: process.exit,
});
const modelRouter: typeof import("./onboard/model-router") = require("./onboard/model-router");
const {
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
}: typeof import("./onboard/cancel-rollback") = require("./onboard/cancel-rollback");
const {
  createCoreOnboardFlowPhases,
  isCoreFlowCompleteBeforeFinalization,
  prepareCoreOnboardFlowContext,
  prepareFinalOnboardFlowContext,
  runCoreOnboardFlowSlice,
}: typeof import("./onboard/machine/core-flow-composition") = require("./onboard/machine/core-flow-composition");
const {
  createFinalOnboardFlowPhases,
  finalizationHandlerDeps,
  runFinalOnboardFlowSlice,
}: typeof import("./onboard/machine/final-flow-composition") = require("./onboard/machine/final-flow-composition");
const {
  applyHealthyPortReuse,
  createInitialOnboardFlowPhases,
  destroyGatewayForReuse,
  runInitialOnboardFlowSlice,
  verifyGatewayContainerRunning,
}: typeof import("./onboard/machine/initial-flow-composition") = require("./onboard/machine/initial-flow-composition");
const {
  skippedStepMessage,
}: typeof import("./onboard/skipped-step-message") = require("./onboard/skipped-step-message");
const {
  findAvailableDashboardPort,
  preflightDashboardPortRangeAvailability,
  reserveCreateSandboxDashboardPort,
  withDashboardPortReservationScope: withSandboxPortReservationScope,
} = require("./onboard/dashboard-port") as typeof import("./onboard/dashboard-port");
const authoritativeRebuildTarget: typeof import("./onboard/authoritative-rebuild-target") = require("./onboard/authoritative-rebuild-target");
const { assertDashboardPortNotReserved, buildRequiredPreflightPorts } =
  require("./onboard/preflight-ports") as typeof import("./onboard/preflight-ports");
const { printPortConflictReport } =
  require("./onboard/port-conflict-report") as typeof import("./onboard/port-conflict-report");
const { tryCleanupOrphanedDashboardForward } =
  require("./onboard/orphaned-dashboard-forward") as typeof import("./onboard/orphaned-dashboard-forward");
const { runPreflightGatewaySequence } =
  require("./onboard/preflight-gateway-sequence") as typeof import("./onboard/preflight-gateway-sequence");
const { destroyGatewayWithVolumeCleanup } =
  require("./onboard/gateway-destroy") as typeof import("./onboard/gateway-destroy");
const { gatewayCliSupportsLifecycleCommands } =
  require("./onboard/gateway-lifecycle") as typeof import("./onboard/gateway-lifecycle");
const {
  getGatewayReuseHealthWaitConfig,
  isDockerDriverGatewayHttpReady: probeDockerDriverGatewayHttpReady,
  isGatewayHttpReady: probeGatewayHttpReady,
  waitForGatewayHttpReady: waitForGatewayHttpReadyBase,
} = require("./onboard/gateway-http-readiness") as typeof import("./onboard/gateway-http-readiness");
const { isGatewayTcpReady: probeGatewayTcpReady } =
  require("./onboard/gateway-tcp-readiness") as typeof import("./onboard/gateway-tcp-readiness");
const dockerDriverGatewayEnv: typeof import("./onboard/docker-driver-gateway-env") = require("./onboard/docker-driver-gateway-env");
const {
  createDockerDriverGatewayStart,
  createGatewayLifecycleApplication,
  createGatewayRecoveryOrchestration,
  createGatewayRegistration,
  createGatewayStart,
} = require("./onboard/gateway/application") as typeof import("./onboard/gateway/application");
const { createGatewayProcessLifecycle } =
  require("./onboard/gateway/process-lifecycle") as typeof import("./onboard/gateway/process-lifecycle");
const entryDecisions: typeof import("./onboard/gateway/entry-decisions") = require("./onboard/gateway/entry-decisions");
const gatewayBinding: typeof import("./onboard/gateway-binding") = require("./onboard/gateway-binding");
const fatalRuntimePreflight: typeof import("./onboard/fatal-runtime-preflight") = require("./onboard/fatal-runtime-preflight");
const preflightGatewayAuthority: typeof import("./onboard/machine/preflight-gateway-authority") = require("./onboard/machine/preflight-gateway-authority");
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
const validation: typeof import("./validation") = require("./validation");
const urlUtils: typeof import("./core/url-utils") = require("./core/url-utils");
const buildContext = require("./build-context");
const httpProbe: typeof import("./adapters/http/probe") = require("./adapters/http/probe");
const modelPrompts: typeof import("./inference/model-prompts") = require("./inference/model-prompts");
const providerModels: typeof import("./inference/provider-models") = require("./inference/provider-models");
const validationRecovery: typeof import("./validation-recovery") = require("./validation-recovery");
const openshellInstallFlow: typeof import("./onboard/openshell-install") = require("./onboard/openshell-install");
const openshellPinFlow: typeof import("./onboard/openshell-pin") = require("./onboard/openshell-pin");

import type { CurlProbeResult } from "./adapters/http/probe";
import type { AgentDefinition } from "./agent/defs";
import type { WebSearchConfig } from "./inference/web-search";
import {
  hydrateMessagingChannelConfig,
  type MessagingChannelConfig,
} from "./messaging-channel-config";
import * as gatewayAuthorityCheckpoint from "./onboard/gateway-authority-checkpoint";
import { createGatewayHostRuntime } from "./onboard/gateway-host-runtime";
import {
  mergeRequiredHermesToolGatewayPolicyPresets,
  normalizeHermesToolGatewaySelections,
  setupHermesToolGateways,
  stringSetsEqual,
} from "./onboard/hermes-managed-tools";
import { filterEnabledChannelsByAgent } from "./onboard/messaging-state";
import { getValidatedMessagingTokenByEnvKey } from "./onboard/messaging-token";
import * as ollamaFlow from "./onboard/ollama-probe-failure";
import { runOllamaStartupOrGate } from "./onboard/ollama-startup";
import * as recreateJournal from "./onboard/onboard-recreate-journal";
import type { OpenShellInstallDeps, OpenShellInstallResult } from "./onboard/openshell-install";
import { createOnboardPolicyApplication } from "./onboard/policy-selection";
import {
  printGpuPreflightLines,
  printLowMemoryWarning,
  printSwapCreationFailed,
} from "./onboard/preflight-messages";
import { shouldSkipPreRecreateBackup } from "./onboard/sandbox-backup-on-recreate";
import {
  getResumeSandboxGpuOverrides,
  resolveSandboxGpuConfig,
  type SandboxGpuConfig,
  type SandboxGpuFlag,
} from "./onboard/sandbox-gpu-mode";
import { createSandboxRecreateProtection } from "./onboard/sandbox-recreate-protection";
import type { SelectionDrift } from "./onboard/selection-drift";
import { createSetupNimVllmHandler } from "./onboard/setup-nim-vllm";
import { formatOnboardConfigSummary, formatSandboxBuildEstimateNote } from "./onboard/summary";
import type { ModelValidationResult, OnboardOptions, ValidationFailureLike } from "./onboard/types";
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
  createGatewayServicePortOwnership,
  getDockerDriverGatewayEnv,
  getDockerDriverGatewayPid,
  getDockerDriverGatewayPortListenerPid,
  getDockerDriverGatewayPortListenerScan,
  getDockerDriverGatewayReuseDrift: getGatewayReuseDrift,
  getDockerDriverGatewayRuntimeDrift,
  getDockerDriverGatewayRuntimeDriftFromSnapshot,
  getDockerDriverGatewayStateDir,
  getGatewayPortListenerRawScan,
  isDockerDriverGatewayPortListener,
  isDockerDriverGatewayProcess,
  isDockerDriverGatewayProcessAlive,
  isDockerDriverGatewayStateInUse,
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
  enableBindMounts: onboardSessionBootstrap.isDockerBindMountsEnabled,
});

import type { JsonObject as LooseObject } from "./core/json-types";
import type { PreparedSandboxBuildContext } from "./onboard/build-context-stage";

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
  return NON_INTERACTIVE || isNonInteractiveEnv();
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
  captureOpenshell,
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
const waitForSandboxReady = sandboxReadinessTracing.createCliSandboxReadyWaiter({
  isLinuxDockerDriverGatewayEnabled,
  capture: captureOpenshell,
  getGatewayName: () => GATEWAY_NAME,
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

const { refreshDockerDriverGatewayReuseState } =
  gatewayReuse.createDockerDriverGatewayReuseApplication({
    gatewayName: () => GATEWAY_NAME,
    getGatewayCompatContainerName: () =>
      gatewayBinding.resolveGatewayCompatContainerName(GATEWAY_PORT),
    isDockerDriverGatewayEnabled: isLinuxDockerDriverGatewayEnabled,
    resolveOpenShellGatewayBinary,
    getDockerDriverGatewayEnv,
    runCaptureOpenshell,
    getDockerDriverGatewayStateDir,
    resolveOpenShellSandboxBinary,
    getDockerDriverGatewayPid,
    isDockerDriverGatewayProcessAlive,
    getDockerDriverGatewayReuseDrift: getGatewayReuseDrift,
    checkGatewayPortAvailable,
    getDockerDriverGatewayPortListenerPid,
    rememberDockerDriverGatewayPid,
    runDockerNetworkInspect: docker.dockerRun,
  });

const { getSandboxReuseState, getSandboxRecreateObservation, waitForSandboxRecreateDeleteAbsence } =
  sandboxReuse.createSandboxReuseHelpers({
    runCaptureOpenshell,
    captureOpenshell,
    getSandboxStateFromOutputs,
    getGatewayName: () => GATEWAY_NAME,
    waitUntil,
  });
const {
  executeSandboxCommandForVerification,
}: typeof import("./onboard/sandbox-verification-exec") = require("./onboard/sandbox-verification-exec");

// URL/string utilities — delegated to src/lib/core/url-utils.ts
const {
  compactText,
  normalizeProviderBaseUrl,
  isLoopbackHostname,
  formatEnvAssignment,
  parsePolicyPresetEnv,
} = urlUtils;
const {
  hydrateCredentialEnv,
}: typeof import("./onboard/credential-env") = require("./onboard/credential-env");

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

type MessagingTokenDef = import("./onboard/messaging-prep").MessagingTokenDef;

type EndpointValidationResult =
  | { ok: true; api: string | null; retry?: undefined }
  | { ok: false; retry: "credential" | "selection" | "retry" | "model"; api?: undefined };

const verifyDirectSandboxGpu = sandboxGpuPreflight.createDirectSandboxGpuVerifier({
  runOpenshell,
  compactText,
  redact,
});

const registeredCredentialProviders =
  credentialProviderRegistration.createCredentialProviderRegistration({
    root: ROOT,
    runOpenshell,
    getGatewayName: () => GATEWAY_NAME,
    getCredential,
    updateSession: onboardSession.updateSession,
    stagedLegacyValues,
    migratedLegacyKeys,
    persistMigratedLegacyKeys,
  });
const { upsertProvider, upsertMessagingProviders, providerMatchesGatewayCredential } =
  registeredCredentialProviders;
const providerExistsInGateway = (name: string, gatewayName: string = GATEWAY_NAME) =>
  onboardProviders.providerExistsInGateway(
    name,
    setupInferenceFactory.createGatewayScopedOpenshellRunner(runOpenshell, gatewayName),
  );

const {
  verifyInferenceRoute,
  isInferenceRouteReady,
  readInferenceRouteState,
  checkGatewayRouteCompatibility,
  preflightGatewayRouteDiscovery,
} = inferenceRouteHelpers.createInferenceRouteHelpers(runCaptureOpenshell);
const { inspectSandboxForCreate, confirmRecreateForSelectionDrift, isOpenclawReady } =
  sandboxLifecycle.createSandboxLifecycleHelpers({
    runCaptureOpenshell,
    getGatewayName: () => GATEWAY_NAME,
    fetchGatewayAuthTokenFromSandbox: (name: string) => fetchGatewayAuthTokenFromSandbox(name),
    agentProductName,
    prompt,
    isAffirmativeAnswer,
  });

const {
  ensureValidatedWebSearchCredential,
  ensureValidatedBraveSearchCredential,
  configureWebSearch,
  verifyWebSearchInsideSandbox,
  webSearchProviderForConfig,
} = createWebSearchFlowHelpers({ prompt, note, isNonInteractive, cliName, runCaptureOpenshell });

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
  ...reasoningMode.compatibleEndpointReasoningConfigureDeps,
});

const { promptRemoteModel, promptInputModel } = modelPrompts;
const { validateAnthropicModel, validateOpenAiLikeModel } = providerModels;
const nousModels: typeof import("./inference/nous-models") = require("./inference/nous-models");

// Build context helpers — delegated to src/lib/build-context.ts
const { shouldIncludeBuildContextPath, copyBuildContextDir, printSandboxCreateRecoveryHints } =
  buildContext;
// classifySandboxCreateFailure — see validation import above

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

const handleVllmSelection = createSetupNimVllmHandler({
  VLLM_PORT,
  runCapture,
  getLocalProviderBaseUrl,
  getLocalProviderValidationBaseUrl,
  getManagedVllmProviderBinding: localInference.getManagedVllmProviderBinding,
  queryVllmModels: (baseUrl, apiKey) => {
    const result = localInference.probeVllmModels(baseUrl, apiKey);
    return result.ok ? result.body : "";
  },
  isSafeModelId,
  requireValue,
  validateOpenAiLikeSelection,
  applyVllmRuntimeContextWindow: localInference.applyVllmRuntimeContextWindow,
  isDgxSparkHost: () => nim.detectNvidiaPlatform() === "spark",
  isNemoClawManagedVllmRunning: vllmInference.isNemoClawManagedVllmRunning,
  persistConfiguredManagedVllmRuntimeReceipt:
    vllmInference.persistConfiguredManagedVllmRuntimeReceipt,
  exitProcess: (code) => process.exit(code),
});
const handleLlamaCppSelection = setupNimFlow.createLlamaCppSelectionHandler({
  isNonInteractive,
  resolveCredential: resolveProviderCredential,
  ensureNamedCredential: (envName, label) => credentialPrompt.ensureNamedCredential(envName, label),
  returningToProviderSelection: credentialPrompt.returningToProviderSelection,
  probeLlamaCppAttachment: setupNimFlow.probeLlamaCppAttachment,
  validateOpenAiLikeSelection,
  error: (message) => console.error(message),
  log: (message) => console.log(message),
  exitProcess: (code): never => process.exit(code),
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
const { areRequiredDockerDriverBinariesPresent, ensureOpenshellForOnboard } =
  openshellInstallFlow.createOnboardOpenShellInstallBindings({
    getInstallDeps: getOpenShellInstallDeps,
    afterSuccessfulInstall: (persistTrustedGatewayOwner) =>
      adoptPackagedGatewayOwnerAfterTrustedInstall(persistTrustedGatewayOwner),
  });

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
      (
        require("./onboard/openshell-feature-gate") as typeof import("./onboard/openshell-feature-gate")
      ).hasRequiredOpenshellMessagingFeatures({
        openshellBin: resolveOpenshell(),
        gatewayBin: resolveOpenShellGatewayBinary(),
        sandboxBin: resolveOpenShellSandboxBinary(),
        allowExternalGatewayBin: Boolean(process.env.NEMOCLAW_OPENSHELL_GATEWAY_BIN?.trim()),
        allowExternalSandboxBin: Boolean(process.env.NEMOCLAW_OPENSHELL_SANDBOX_BIN?.trim()),
        requireSandboxBin:
          process.platform !== "darwin" ||
          Boolean(process.env.NEMOCLAW_OPENSHELL_SANDBOX_BIN?.trim()),
      }),
    shouldAllowOpenshellAboveBlueprintMax,
    cliDisplayName,
    log: console.log,
    error: console.error,
    exit: exitProcess,
  };
}

function logDockerDriverGatewayRestart(reason: string): void {
  console.log(`  Existing OpenShell Docker-driver gateway is stale (${reason}); restarting...`);
}

const {
  destroyGateway,
  removeDockerDriverGatewayRegistration,
  retireLegacyGatewayForDockerDriverUpgrade,
  runQuietOpenshell,
} = createGatewayProcessLifecycle({
  gatewayName: () => GATEWAY_NAME,
  dashboardPort: getOnboardDashboardPort,
  runOpenshell,
  runCaptureOpenshell,
  dockerInspect,
  dockerStop,
  dockerRm,
  dockerRemoveVolumesByPrefix,
  getGatewayClusterContainerName,
  getDockerDriverGatewayPid,
  isPidAlive,
  isDockerDriverGatewayProcess,
  resolveOpenShellGatewayBinary,
  clearDockerDriverGatewayRuntimeFiles,
  sleepSeconds,
  isDockerDriverGatewayEnabled: isLinuxDockerDriverGatewayEnabled,
  clearRegistry: registry.clearAll,
  killProcess: process.kill.bind(process),
  log: console.log,
  gatewayCliSupportsLifecycleCommands,
  destroyGatewayWithVolumeCleanup,
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

const { gatewayClusterHealthcheckPassed, repairGatewayBootstrapSecrets } =
  createGatewayBootstrapRepairHelpers({
    buildGatewayClusterExecArgv,
    run,
    runCapture,
  });

// parsePolicyPresetEnv — see urlUtils import above
// isSafeModelId — see validation import above

// ── Step 1: Preflight ────────────────────────────────────────────

type PreflightOptions = import("./onboard/fatal-runtime-preflight").FatalRuntimePreflightOptions;
const onboardPreflightGatewayAuthority =
  preflightGatewayAuthority.createOnboardPreflightGatewayAuthority({
    gatewayName: () => GATEWAY_NAME,
    gatewayPort: () => GATEWAY_PORT,
    collectGatewayReadiness: (deps) =>
      preflightGatewayAuthority.collectOnboardGatewayReadiness(deps),
    getGatewayOwnerDeps: () => machineGatewayOwnerDeps,
    isNonInteractive,
    ensureOpenshellForOnboard,
    updateSession: onboardSession.updateSession,
    adoptPackagedGatewayAuthorityAfterTrustedInstall:
      gatewayAuthorityCheckpoint.adoptPackagedGatewayAuthorityAfterTrustedInstall,
    checkPortAvailable,
    isDockerDriverGatewayPortListener,
    getGatewayReuseSnapshot,
    selectNamedGatewayForReuseIfNeeded,
    refreshDockerDriverGatewayReuseState,
  });

async function preflight(
  preflightOpts: PreflightOptions = {},
): Promise<ReturnType<typeof nim.detectGpu>> {
  step(1, 8, "Preflight checks");
  const { gpu, host, sandboxGpuConfig, gpuTrustGateRejection } =
    await onboardPreflightGatewayAuthority.runRuntimePreflight(preflightOpts);

  await preflightUtils.checkContainerRuntimeResources(host, {
    ignored: process.env.NEMOCLAW_IGNORE_RUNTIME_RESOURCES === "1",
    nonInteractive: isNonInteractive(),
    confirm: () => promptYesNoOrDefault("  Continue with onboarding?", null, false),
  });

  const {
    externallySupervised: gatewayExternallySupervised,
    gatewayReuseState: initialGatewayReuseState,
  } = await onboardPreflightGatewayAuthority.prepareGatewayAuthority();
  let reuseState = initialGatewayReuseState;

  // Verify the legacy gateway container is actually running — openshell CLI
  // metadata can be stale after a manual `docker rm`. See #2020. Newer
  // package-managed OpenShell gateways do not have an openshell-cluster-*
  // Docker container, so the live CLI health check is the source of truth.
  // The reuse/cleanup/orphan stages run as one composed sequence so external
  // supervision is enforced across the whole path, not per stage (#6576).
  reuseState = await runPreflightGatewaySequence({
    gatewayReuseState: reuseState,
    externallySupervised: gatewayExternallySupervised,
    supportsLifecycleCommands: gatewayCliSupportsLifecycleCommands(runCaptureOpenshell),
    isDockerDriverGatewayEnabled: isLinuxDockerDriverGatewayEnabled(),
    gatewayName: GATEWAY_NAME,
    cliDisplayName: cliDisplayName(),
    dashboardPort: getOnboardDashboardPort(),
    verifyGatewayContainerRunning,
    recoverGatewayRuntime,
    waitForGatewayHttpReady,
    getGatewayLocalEndpoint,
    stopDashboardForward: () =>
      runOpenshell(["forward", "stop", String(getOnboardDashboardPort())], {
        ignoreError: true,
      }),
    stopAllDashboardForwards,
    getGatewayClusterImageDrift,
    exitProcess: (code) => process.exit(code),
    destroyGateway,
    destroyGatewayForReuse,
    runOpenshell,
    dockerInspect,
    dockerStop,
    dockerRm,
    dockerRemoveVolumesByPrefix,
    clearRegistry: registry.clearAll,
    log: console.log,
    warn: console.warn,
  });

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
  for (const { kind, port, label, envVar } of requiredPorts) {
    const portCheckOptions = entryDecisions.selectGatewayPortCheckOptions(
      kind,
      dockerDriverGatewayEnv.getGatewayPortCheckOptions,
    );
    let portCheck = await checkPortAvailable(port, portCheckOptions);
    if (!portCheck.ok) {
      const reuse = await applyHealthyPortReuse({
        kind,
        port,
        dashboardPort: getOnboardDashboardPort(),
        label,
        runtimeDisplayName: cliDisplayName(),
        gatewayName: GATEWAY_NAME,
        gatewayReuseState: reuseState,
        externallySupervised: gatewayExternallySupervised,
        portCheckOptions,
        supportsLifecycleCommands: gatewayCliSupportsLifecycleCommands(runCaptureOpenshell),
        destroyGateway,
        runOpenshell,
        checkPortAvailable,
        verifyGatewayContainerRunning,
      });
      if (reuse === "continue") continue;
      if (reuse) {
        reuseState = reuse.gatewayReuseState;
        portCheck = reuse.portCheck;
        if (portCheck.ok) continue;
      }
      const managedListenerPid = entryDecisions.selectManagedListenerPid(kind, () =>
        getDockerDriverGatewayPortListenerPid(portCheck),
      );
      const managedListenerAccepted = entryDecisions.acceptManagedListener(
        managedListenerPid,
        (pid) => {
          rememberDockerDriverGatewayPid(pid);
          console.log(
            `  ✓ Port ${port} already owned by NemoClaw OpenShell Docker gateway (${label})`,
          );
        },
      );
      if (managedListenerAccepted) {
        continue;
      }
      // Auto-cleanup orphaned SSH port-forward from a previous NemoClaw session
      // (e.g. dashboard forward left behind after destroy). Only kill the process
      // if its command line contains "openshell" to avoid killing unrelated SSH
      // tunnels the user may have set up on the same port. (#1950)
      if (kind === "dashboard" && portCheck.process === "ssh" && portCheck.pid) {
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
      printPortConflictReport({
        port,
        label,
        envVar,
        portCheck,
        serviceHints: getPortConflictServiceHints(),
      });
      process.exit(1);
    }
    console.log(`  ✓ Port ${port} available (${label})`);
  }
  dockerDriverGatewayEnv.warnIfGatewayWildcardBindAddress();

  // GPU
  printGpuPreflightLines({ gpu, sandboxGpuConfig, gpuTrustGateRejection });

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

const applyOverlayfsAutoFix = overlayfsAutoFix.createOverlayfsAutoFix({
  assessHost: preflightUtils.assessHost,
  ensurePatchedClusterImage: clusterImagePatch.ensurePatchedClusterImage,
});

const {
  adoptPackagedGatewayOwnerAfterTrustedInstall,
  assertGatewayStartAllowed,
  bindGatewayOwner,
  getGatewayLocalEndpoint,
  getGatewayOwner,
  getGatewayStartEnv,
  isGatewayExternallySupervised,
  machineGatewayOwnerDeps,
  resetGatewayOwnerBinding,
} = createGatewayHostRuntime({
  applyOverlayfsAutoFix,
  checkGatewayPortAvailable,
  gatewayName: () => GATEWAY_NAME,
  gatewayPort: () => GATEWAY_PORT,
  getGatewayPortListenerRawScan,
  getInstalledOpenshellVersion,
  runCaptureOpenshell,
  runOpenshell,
  resolveOpenShellGatewayBinary,
  waitForGatewayHttpReady,
});

const gatewayRegistration = createGatewayRegistration({
  gatewayName: () => GATEWAY_NAME,
  getDockerDriverGatewayEndpointArg,
  getGatewayLocalEndpoint,
  hasStaleGateway,
  isGatewayHealthy,
  isLinuxDockerDriverGatewayEnabled,
  removeDockerDriverGatewayRegistration,
  runCaptureOpenshell,
  runOpenshell,
  runQuietOpenshell,
});

const dockerDriverGatewayStart = createDockerDriverGatewayStart({
  SUPPORTED_OPENSHELL_FALLBACK_VERSION,
  checkGatewayPortAvailable,
  clearDockerDriverGatewayRuntimeFiles,
  createGatewayServicePortOwnership,
  dockerDriverGatewayEnv,
  envInt,
  gatewayBinding,
  gatewayName: () => GATEWAY_NAME,
  gatewayPort: () => GATEWAY_PORT,
  getDockerDriverGatewayEndpoint,
  getDockerDriverGatewayEnv,
  getDockerDriverGatewayPid,
  getDockerDriverGatewayPortListenerScan,
  getDockerDriverGatewayRuntimeDrift,
  getDockerDriverGatewayStateDir,
  getInstalledOpenshellVersion,
  isDockerDriverGatewayHttpReady,
  isDockerDriverGatewayProcessAlive,
  isDockerDriverGatewayStateInUse,
  isGatewayHealthy,
  isGatewayTcpReady,
  isPidAlive,
  logDockerDriverGatewayRestart,
  registerDockerDriverGatewayEndpoint: gatewayRegistration.registerDockerDriverGatewayEndpoint,
  rememberDockerDriverGatewayPid,
  resolveOpenShellGatewayBinary,
  resolveOpenShellSandboxBinary,
  runCaptureOpenshell,
  sleepSeconds,
});

const gatewayStart = createGatewayStart({
  assertGatewayStartAllowed,
  cliDisplayName,
  dockerGpuLocalInference,
  dockerGpuRoute,
  dockerGpuSandboxCreate,
  gatewayName: () => GATEWAY_NAME,
  getGatewayLocalEndpoint,
  getGatewayReuseSnapshot,
  hasStaleGateway,
  isGatewayHealthy,
  isGatewayHttpReady,
  isLinuxDockerDriverGatewayEnabled,
  runOpenshell,
  selectNamedGatewayForReuseIfNeeded,
  startDockerDriverGateway: dockerDriverGatewayStart.startDockerDriverGateway,
  step,
});

const gatewayRecovery = createGatewayRecoveryOrchestration({
  SCRIPTS,
  assertGatewayStartAllowed,
  attachGatewayMetadataIfNeeded: gatewayRegistration.attachGatewayMetadataIfNeeded,
  envInt,
  gatewayClusterHealthcheckPassed,
  gatewayName: () => GATEWAY_NAME,
  getContainerRuntime,
  getGatewayClusterContainerState,
  isGatewayHealthy,
  isGatewayHttpReady,
  isLinuxDockerDriverGatewayEnabled,
  isSelectedGateway,
  repairGatewayBootstrapSecrets,
  run,
  runCaptureOpenshell,
  runOpenshell,
  shouldPatchCoredns,
  sleepSeconds,
  startDockerDriverGateway: dockerDriverGatewayStart.startDockerDriverGateway,
  startGatewayWithOptions: gatewayStart.startGatewayWithOptions,
});

const {
  recoverGatewayRuntime,
  startDockerDriverGateway,
  startGateway,
  startGatewayForRecovery,
} = createGatewayLifecycleApplication({
  dockerDriverStart: dockerDriverGatewayStart,
  recovery: gatewayRecovery,
  registration: gatewayRegistration,
  start: gatewayStart,
});

const { getSandboxRuntimeRegistryFields, hasSandboxGpuDrift, updateReusedSandboxMetadata } =
  sandboxRegistryMetadata.createSandboxRegistryMetadataHelpers({
    getOpenShellComputeDriverName: () =>
      dockerDriverPlatform.resolveCurrentOpenShellComputePlan().driverName,
    getInstalledOpenshellVersion,
    runCaptureOpenshell,
  });
const sandboxCreateOrchestrationRuntime = {
  DASHBOARD_PORT,
  get GATEWAY_NAME() {
    return GATEWAY_NAME;
  },
  get GATEWAY_PORT() {
    return GATEWAY_PORT;
  },
  ROOT,
  SCRIPTS,
  agentDefs,
  agentOnboard,
  applyExtraProviderReconciliation,
  assessHost,
  baseImageResolutionFlow,
  cliDisplayName,
  cliName,
  completeOrdinaryOnboardSandboxCreation,
  confirmRecreateForSelectionDrift,
  createOnboardCreatedSandboxCompletion,
  createOnboardCreatedSandboxRegistration,
  createSandboxRecreateProtection,
  dashboardRuntime,
  dcodeAutoApprovalFlow,
  detectMessagingCredentialRotation,
  get ensureAgentFixedForward() {
    return ensureAgentFixedForward;
  },
  get ensureDashboardForward() {
    return ensureDashboardForward;
  },
  filterEnabledChannelsByAgent,
  formatSandboxAgentName,
  formatSandboxBuildEstimateNote,
  get getDashboardForwardPort() {
    return getDashboardForwardPort;
  },
  readDcodeSelectionDrift: createDcodeSelectionDriftReader(runCaptureOpenshell, () => GATEWAY_NAME),
  getDefaultSandboxNameForAgent,
  getDockerDriverGatewayStateDir,
  getHermesToolGatewayBroker,
  getRequestedSandboxAgentName,
  getSandboxAgentDrift,
  getSandboxRecreateObservation,
  getSandboxReuseState,
  getSandboxRuntimeRegistryFields,
  getSelectionDrift,
  hasSandboxGpuDrift,
  inferenceConfig,
  inspectSandboxForCreate,
  isLinuxDockerDriverGatewayEnabled,
  isNonInteractive,
  isRecreateSandbox,
  isWsl,
  managedWorkloadOnboard,
  messagingChannelSetup,
  normalizeHermesAuthMethod,
  normalizeHermesToolGatewaySelections,
  note,
  observabilityCommandFlag,
  observabilityPolicy,
  onboardHermesDashboard,
  onboardSession,
  onboardSessionBootstrap,
  openshellArgv,
  path,
  planRegisteredExtraProviders,
  preparedDcodeRebuild,
  promptValidatedSandboxName,
  promptYesNoOrDefault,
  providerExistsInGateway,
  recreateJournal,
  registry,
  requiresSelectionRecreate,
  reserveCreateSandboxDashboardPort,
  resolveSandboxGpuConfig,
  runCaptureOpenshell,
  runOpenshell,
  runSandboxProviderPreDeleteCleanup,
  sandboxAgent,
  sandboxBuildPatchConfig,
  get sandboxCancelRollback() {
    return sandboxCancelRollback;
  },
  get sandboxCreateIntentResolver() {
    return sandboxCreateIntentResolver;
  },
  sandboxGpuCreateFlow,
  sandboxLifecycle,
  sandboxMutationLock,
  sandboxRecreateTransaction,
  sandboxRegistryMetadata,
  sandboxReuse,
  shouldSkipPreRecreateBackup,
  sleepSeconds,
  step,
  stringSetsEqual,
  toolDisclosureFlow,
  upsertMessagingProviders,
  usesManagedDcodeIdentity,
  validateName,
  verifyDirectSandboxGpu,
  waitForSandboxRecreateDeleteAbsence,
  wasSandboxDefault,
  updateReusedSandboxMetadata,
  getSandboxInferenceConfig,
  redact,
  openshellShellCommand,
  discloseInitialSandboxPolicy,
  compactText,
  runFile,
  dockerInfoFormat,
  runCapture,
};
export type SandboxCreateOrchestrationRuntime = typeof sandboxCreateOrchestrationRuntime;
const createSandboxWithBaseImageResolution =
  sandboxCreateOrchestration.createSandboxWithBaseImageResolution(
    sandboxCreateOrchestrationRuntime,
  );

const { createSandbox, createSandboxWithTemporaryManagedRuntime } =
  agentOnboard.createHermesApiPortScopedSandboxEntryPoints({
    createBaseImageResolutionContext: () =>
      baseImageResolutionFlow.createBaseImageResolutionContext({ fresh: false }),
    createSandboxWithBaseImageResolution,
    resolvePortableRuntimeContext: () => {
      const authority = sandboxGpuCreateFlow.resolveExportedPortableRuntimeAuthority(
        process.env,
        onboardSession.loadSession,
      );
      return authority ? { authority, environmentScope: null } : null;
    },
    resolveComputePlan: dockerDriverPlatform.resolveCurrentOpenShellComputePlan,
  });

// ── Step 3: Inference selection ──────────────────────────────────

type ProviderChoice = import("./onboard/provider-menu").ProviderMenuChoice;
type RebuildRouteHandoff = import("./onboard/rebuild-route-handoff").RebuildRouteHandoff;

const {
  readRecordedProvider,
  readRecordedNimContainer,
  readRecordedModel,
  readRecordedEndpointUrl,
  readRecordedInferenceRoute,
  readRecordedProviderEndpoints,
} = providerRecovery.createProviderRecoveryHelpers({
  parseGatewayInference,
  runCaptureOpenshell,
  warn: (message) => console.warn(message),
});

async function selectAndValidateOllamaModel(
  gpu: ReturnType<typeof nim.detectGpu>,
  provider: string,
  defaults: OllamaModelSelectionDefaults,
  onModelSelected?: (model: string) => void,
): Promise<ollamaFlow.OllamaModelSelectionOutcome> {
  const { requestedModel, recoveredModel, lockedModel, promptDefaultModel } = defaults;
  const probeFailures = new OllamaProbeFailureTracker();
  const confirm = (question: string, defaultIsYes: boolean) =>
    promptYesNoOrDefault(question, null, defaultIsYes);
  const interaction = { isNonInteractive, isAutoYes, confirm };
  while (true) {
    const installedModels = localInference.getOllamaModelOptions();
    let model: string | typeof BACK_TO_SELECTION;
    if (lockedModel) {
      model = lockedModel;
    } else if (isNonInteractive()) {
      model = resolveNonInteractiveModel(requestedModel, recoveredModel, gpu, installedModels);
    } else {
      model = await promptOllamaModel(gpu, {
        defaultModel: isSafeModelId(promptDefaultModel ?? "") ? promptDefaultModel : null,
        excludeModels: probeFailures.excludedModels(),
        installedModels,
      });
    }
    if (isBackToSelection(model)) {
      console.log("  Returning to provider selection.");
      console.log("");
      return { outcome: "back-to-selection" };
    }
    const selectedModel = requireValue(model, "Expected an Ollama model selection");
    onModelSelected?.(selectedModel);
    if (!installedModels.some((listedModel) => ollamaModelRefsMatch(listedModel, selectedModel))) {
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
      const action = ollamaFlow.handleOllamaProbeFailure(probe, selectedModel, isNonInteractive);
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
    return ollamaFlow.completeOllamaRuntimeContextSelection(
      localInference.applyOllamaRuntimeContextWindow(selectedModel, defaults),
      { outcome: "selected", model: selectedModel, allowToolsIncompatible },
      isNonInteractive,
    );
  }
}

type SetupNimSelectionState =
  import("./onboard/setup-nim-selection").SetupNimSelectionState<HermesAuthMethod>;
type OllamaModelSelectionDefaults =
  import("./onboard/setup-nim-selection").OllamaModelSelectionDefaults;
type SetupNimSelectionResult = "selected" | "retry-selection";

type RemoteProviderSelectionArgs = {
  selected: ProviderChoice;
  requestedModel: string | null;
  recoveredFromSandbox: boolean;
  recoveredModel: string | null;
  sandboxName: string | null;
  gatewayName: string | null;
  intendedInferenceApi: string | null;
  recoverySessionId: string | null | undefined;
};

async function handleNimLocalSelection(
  gpu: ReturnType<typeof nim.detectGpu>,
  args: Pick<
    RemoteProviderSelectionArgs,
    "requestedModel" | "recoveredFromSandbox" | "recoveredModel"
  >,
  state: SetupNimSelectionState,
): Promise<SetupNimSelectionResult> {
  const localGpu = requireValue(gpu, "GPU details are required for local NIM model selection");
  const { models, usableMemoryMB } = nim.getNimModelOptions(localGpu);
  if (models.length === 0) {
    console.log(`  No NIM model fits ${usableMemoryMB} MB. Falling back to cloud API.`);
    applyCloudFallbackSelection(state, REMOTE_PROVIDER_CONFIG.build);
    state.assertRouteCompatible?.();
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
        console.error(nim.nimModelSelectionError(targetModel, label, localGpu));
        process.exit(1);
      }
    } else {
      sel = models[0];
    }
    note(`  [non-interactive] NIM model: ${sel.name}`);
  } else {
    console.log("");
    console.log(`  Models that fit ${usableMemoryMB} MB of usable GPU memory:`);
    models.forEach((m, i) => {
      console.log(`    ${i + 1}) ${m.name} (min ${m.minGpuMemoryMB} MB)`);
    });
    console.log("");

    const modelChoice = await prompt(`  Choose model [1]: `);
    sel = selectFromNumberedMenuOrExit(modelChoice, 1, models);
  }
  const catalogModel = sel.name;
  state.model = nim.expectedServedModelId(catalogModel);
  state.provider = "vllm-local";
  state.credentialEnv = null;
  state.endpointUrl = getLocalProviderBaseUrl(state.provider);
  state.preferredInferenceApi = "openai-completions";
  if (!state.endpointUrl) {
    console.error("  Local NVIDIA NIM base URL could not be determined.");
    process.exit(1);
  }
  state.assertRouteCompatible?.();

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
    assertSelectionMutationAuthority(state, "register the NIM container credential");
    if (!nim.dockerLoginNgc(ngcKey)) {
      console.error("  Failed to login to NGC registry. Check your API key and try again.");
      console.log("");
      ngcKey = await credentialPrompt.readValue("  NGC API Key: ");
      if (credentialPrompt.returningToProviderSelection(ngcKey)) return "retry-selection";
      if (!ngcKey) {
        console.error("  NGC login failed. Cannot pull NIM images.");
        process.exit(1);
      }
      assertSelectionMutationAuthority(state, "register the NIM container credential");
      if (!nim.dockerLoginNgc(ngcKey)) {
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

  console.log(`  Pulling NIM image for ${catalogModel}...`);
  assertSelectionMutationAuthority(state, "install the local NIM runtime");
  nim.pullNimImage(catalogModel);
  console.log("  Starting NIM container...");
  const nimContainerNameLocal = nim.containerName(GATEWAY_NAME);
  assertSelectionMutationAuthority(state, "start the local NIM runtime");
  state.nimContainer = nim.startNimContainerByName(nimContainerNameLocal, catalogModel, undefined, {
    ngcApiKey: ngcApiKey ?? undefined,
  });

  console.log("  Waiting for NIM to become healthy...");
  if (!nim.waitForNimHealth(undefined, undefined, { container: nimContainerNameLocal })) {
    nim.stopNimContainerByNameOrThrow(nimContainerNameLocal);
    console.error("  NIM failed to start. Falling back to cloud API.");
    applyCloudFallbackSelection(state, REMOTE_PROVIDER_CONFIG.build);
    state.assertRouteCompatible?.();
    return "selected";
  }

  state.model = nim.adoptServedModelId(catalogModel);
  state.assertRouteCompatible?.();
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

async function handleRemoteProviderSelection(
  args: RemoteProviderSelectionArgs,
  state: SetupNimSelectionState,
  recoveredRegistryRoute: RebuildRouteHandoff["route"] | null,
): Promise<SetupNimSelectionResult> {
  const {
    selected,
    requestedModel,
    recoveredFromSandbox,
    recoveredModel,
    sandboxName,
    intendedInferenceApi,
  } = args;
  const remoteConfig = REMOTE_PROVIDER_CONFIG[selected.key];
  state.provider = remoteConfig.providerName;
  state.credentialEnv = remoteConfig.credentialEnv;
  state.endpointUrl = remoteConfig.endpointUrl;
  state.preferredInferenceApi = null;
  state.model = requestedModel || (recoveredFromSandbox ? recoveredModel : null);

  if (selected.key === "custom" || selected.key === "anthropicCompatible") {
    const kind = selected.key === "custom" ? "openai" : "anthropic";
    const endpointSelection = await resolveCompatibleEndpointSelection({
      kind,
      envUrl: process.env.NEMOCLAW_ENDPOINT_URL,
      recoveredEndpointUrl: recoveredFromSandbox
        ? (recoveredRegistryRoute?.endpointUrl ??
          readRecordedEndpointUrl(sandboxName, args.recoverySessionId))
        : null,
      nonInteractive: isNonInteractive(),
      prompt,
    });
    if (endpointSelection.action === "retry-selection") {
      return "retry-selection";
    }
    state.endpointUrl = endpointSelection.endpointUrl;
    if (selected.key === "anthropicCompatible") {
      state.endpointUrl = bedrockRuntimeOnboard.normalizeCustomAnthropicEndpointUrl(
        state.endpointUrl,
      );
    }
    const explicitApi = (process.env.NEMOCLAW_PREFERRED_API || "").trim().toLowerCase();
    state.preferredInferenceApi =
      selected.key === "custom"
        ? explicitApi === "chat-completions"
          ? "openai-completions"
          : explicitApi || null
        : null;
    if (!state.preferredInferenceApi) {
      state.preferredInferenceApi =
        selected.key === "custom" ||
        bedrockRuntimeOnboard.needsBedrockRuntimeAdapter(state.endpointUrl)
          ? "openai-completions"
          : "anthropic-messages";
    }
  }
  state.assertRouteCompatible?.();
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
      assertSelectionMutationAuthority(state, "stage the Hermes provider credential");
      stageNousApiKeyProviderEnv();
      if (isNonInteractive()) {
        if (!resolveHermesNousApiKey()) {
          console.error("  Hermes Provider Nous API Key is required in non-interactive mode.");
          process.exit(1);
        }
      } else {
        assertSelectionMutationAuthority(state, "register the Hermes provider credential");
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
    assertSelectionMutationAuthority(state, "configure Hermes provider credentials");
    state.hermesToolGateways = await setupHermesToolGateways(
      state.provider,
      state.hermesAuthMethod,
      recordedHermesToolGateways,
      { prompt, note, isNonInteractive },
    );

    const defaultModel =
      requestedModel ||
      (typeof state.model === "string" && state.model) ||
      remoteConfig.defaultModel;
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
    state.assertRouteCompatible?.();
    console.log(`  Using ${remoteConfig.label} with model: ${state.model}`);
    return "selected";
  }
  hydrateCredentialEnv(state.credentialEnv);
  if (selected.key === "build") {
    assertSelectionMutationAuthority(state, "stage the NVIDIA provider credential");
    providerKeyBridge.stageBuildProviderKeyBridge();
    let apiKeyNavigation: unknown = null;
    if (isNonInteractive()) {
      const reuseGatewayCredential = buildCredentialReuse.resolveNonInteractiveBuildCredential({
        provider: state.provider,
        helpUrl: REMOTE_PROVIDER_CONFIG.build.helpUrl,
        recoveredFromSandbox,
        providerExistsInGateway: (name) =>
          providerExistsInGateway(name, args.gatewayName ?? GATEWAY_NAME),
      });
      state.skipHostInferenceSmoke = reuseGatewayCredential;
      state.reuseGatewayCredentialWithoutLocalKey = reuseGatewayCredential;
    } else {
      assertSelectionMutationAuthority(state, "register the NVIDIA provider credential");
      apiKeyNavigation = await ensureApiKey();
    }
    state.model = await selectFeaturedModelAfterCredentialPrompt(
      state.nvidiaFeaturedModels!,
      apiKeyNavigation,
      credentialPrompt.shouldReturnToProviderSelection,
      requestedModel || (typeof state.model === "string" ? state.model : null),
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
    assertSelectionMutationAuthority(
      state,
      `stage inference provider ${JSON.stringify(state.provider)} credential`,
    );
    providerKeyBridge.stageRemoteProviderKeyBridge(state.credentialEnv);

    const _envModelRemote = (process.env.NEMOCLAW_MODEL || "").trim();
    const defaultModel =
      requestedModel ||
      (typeof state.model === "string" && state.model) ||
      _envModelRemote ||
      (recoveredFromSandbox && recoveredModel) ||
      remoteConfig.defaultModel;
    const selectedCredentialEnv = requireValue(
      state.credentialEnv,
      `Missing credential env for ${remoteConfig.label}`,
    );
    const compatibleNoAuth =
      selected.key === "custom" &&
      Boolean(
        state.endpointUrl &&
        compatibleEndpointGatewayRoute.gatewayReachableCompatibleEndpointUrl(
          state.provider,
          state.endpointUrl,
        ) !== state.endpointUrl,
      );
    const useNoAuth =
      compatibleNoAuth &&
      (!isNonInteractive() ||
        (process.env.NEMOCLAW_COMPATIBLE_AUTH_MODE || "").trim().toLowerCase() === "none");
    assertSelectionMutationAuthority(
      state,
      `register inference provider ${JSON.stringify(state.provider)} credential`,
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
      credentialMutationGuard: credentialMutationGuardFor(state),
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
      state.assertRouteCompatible?.();
      return "selected";
    }
    if (isNonInteractive()) {
      state.model = defaultModel;
      state.assertRouteCompatible?.();
      if (useNoAuth) state.credentialEnv = OLLAMA_PROXY_CREDENTIAL_ENV;
      else
        recoveredProviderReuse.resolveRecoveredProviderCredentialReuse(
          {
            selected,
            remoteConfig,
            state,
            selectedCredentialEnv,
            recoveredFromSandbox,
            selectedModel: defaultModel,
            sandboxName,
            recoveredRegistryRoute,
          },
          {
            resolveProviderCredential,
            readRecordedInferenceRoute: (name) =>
              readRecordedInferenceRoute(name, args.recoverySessionId),
            readRecordedProviderEndpoints,
            readGatewayProviderMetadata: (provider) =>
              onboardProviders.readGatewayProviderMetadata(
                provider,
                runOpenshell,
                args.gatewayName ?? GATEWAY_NAME,
              ),
            note,
          },
        );
    } else {
      assertSelectionMutationAuthority(
        state,
        `register inference provider ${JSON.stringify(state.provider)} credential`,
      );
      const credentialResult = await credentialPrompt.ensureNamedCredential(
        selectedCredentialEnv,
        compatibleNoAuth
          ? `${remoteConfig.label} API key (press Enter for no authentication)`
          : `${remoteConfig.label} API key`,
        remoteConfig.helpUrl,
        openrouterSelection.credentialValidatorForProvider(selected.key),
        compatibleNoAuth,
        credentialMutationGuardFor(state),
      );
      if (credentialPrompt.returningToProviderSelection(credentialResult)) {
        return "retry-selection";
      }
      if (credentialResult === "") state.credentialEnv = OLLAMA_PROXY_CREDENTIAL_ENV;
    }
    if (!useNoAuth)
      openrouterSelection.validateNonInteractiveCredential({
        selectedKey: selected.key,
        selectedCredentialEnv,
        isNonInteractive: isNonInteractive(),
        reuseGatewayCredentialWithoutLocalKey: state.reuseGatewayCredentialWithoutLocalKey,
        resolveProviderCredential,
        getCredential,
        error: (message) => console.error(message),
        exitProcess: (code) => process.exit(code),
      });
    let modelValidator: ((candidate: string) => ModelValidationResult) | null = null;
    if (openrouterSelection.isOpenAiLikeRemoteProvider(selected.key)) {
      const modelAuthMode = getProbeAuthMode(state.provider);
      modelValidator = (candidate) => {
        state.model = candidate;
        state.assertRouteCompatible?.();
        return validateOpenAiLikeModel(
          remoteConfig.label,
          state.endpointUrl || remoteConfig.endpointUrl,
          candidate,
          getCredential(selectedCredentialEnv) || "",
          openrouterSelection.openAiLikeModelValidationOptions(state.provider, modelAuthMode),
        );
      };
    } else if (selected.key === "anthropic") {
      modelValidator = (candidate) => {
        state.model = candidate;
        state.assertRouteCompatible?.();
        return validateAnthropicModel(
          state.endpointUrl || ANTHROPIC_ENDPOINT_URL,
          candidate,
          getCredential(selectedCredentialEnv) || "",
        );
      };
    }
    while (true) {
      if (isNonInteractive()) {
        state.model = defaultModel;
      } else if (openrouterSelection.isOpenRouterProvider(selected.key)) {
        state.model = await openrouterSelection.selectModel({
          state,
          requestedModel,
          recoveredFromSandbox,
          recoveredModel,
          remoteConfig,
          validateOpenAiLikeModel,
        });
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
      state.assertRouteCompatible?.();

      const validationResult = state.reuseGatewayCredentialWithoutLocalKey
        ? "selected"
        : await validateSelectedRemoteModel({
            selected,
            remoteConfig,
            state,
            selectedCredentialEnv,
            intendedInferenceApi,
          });
      if (validationResult === "selected") {
        state.assertRouteCompatible?.();
        break;
      }
      if (validationResult === "retry-selection") return "retry-selection";
    }
  }

  if (selected.key === "build") {
    const buildModel = requireValue(
      isBackToSelection(state.model) ? null : state.model,
      `Missing model for ${remoteConfig.label}`,
    );
    state.assertRouteCompatible?.();
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
          withCredentialMutationGuard(state, {
            requireResponsesToolCalling: shouldRequireResponsesToolCalling(state.provider),
            skipResponsesProbe: shouldSkipResponsesProbe(state.provider),
            authMode: getProbeAuthMode(state.provider),
          }),
        ),
    });
    if (buildValidation.retrySelection) return "retry-selection";
    state.preferredInferenceApi = buildValidation.preferredInferenceApi;
    state.assertRouteCompatible?.();
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
    getGatewayPort: () => GATEWAY_PORT,
    getRuntimeProvider: () => setupNimFlow.resolveCurrentRuntimeProviderBundle(),
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
    handleLlamaCppSelection,
    handleRemoteProviderSelection,
    handleNimLocalSelection,
    handleRunningOllamaSelection,
    handleWindowsHostOllamaSelection,
    handleInstallOllamaSelection,
    installVllm: setupNimFlow.withServingPortGuard(vllmInference.installVllm, checkPortAvailable),
    handleVllmSelection,
    selectVllmModelFromEnv: vllmInference.selectVllmModelFromEnv,
    handleRoutedSelection: (state) =>
      setupNimRoutedSelection.handleRoutedSelection(state, {
        modelRouter,
        localInference,
        urlUtils,
        credentials,
        hydrateCredentialEnv,
        providerKeyBridge,
        isNonInteractive,
        exitProcess: (code): never => process.exit(code),
        credentialPrompt,
      }),
    coerceAgentInferenceApi: inferenceConfig.coerceAgentInferenceApi,
    resolveAgentInferenceApi: inferenceConfig.resolveAgentInferenceApi,
    ...reasoningMode.compatibleEndpointReasoningClearDeps,
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
    checkGatewayRouteCompatibility,
    withGatewayRouteMutationLock: gatewayRouteMutationLock.withGatewayRouteMutationLock,
    withSandboxMutationLock: sandboxMutationLock.withSandboxMutationLock,
    step,
    getGatewayName: () => GATEWAY_NAME,
    runOpenshell,
    upsertProvider,
    verifyInferenceRoute,
    verifyOnboardInferenceSmoke,
    isNonInteractive,
    updateSandbox: registry.reserveSandboxInferenceRoute,
    getSandbox: registry.getSandbox,
    listSandboxes: registry.listSandboxes,
    unloadOllamaModels,
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
    openrouterRuntimeOnboard,
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
const sandboxCreateIntentResolver = sandboxCreateIntentResolution.createSandboxCreateIntentResolver<
  AgentDefinition | null,
  import("./resources-cmd").ResourceProfile
>({
  channels: MESSAGING_CHANNELS,
  messagingPreflightDeps: {
    readMessagingPlanFromEnv: messagingChannelSetup.readMessagingPlanFromEnv,
    resolveDisabledChannels: channelState.resolveDisabledChannels,
    gatewayName: () => GATEWAY_NAME,
    registry,
    providerExistsInGateway,
    providerMatchesGatewayCredential,
    isNonInteractive,
    promptYesNoOrDefault,
    cliName,
    log: (message) => console.log(message),
    error: (message) => console.error(message),
    exitProcess: (code) => process.exit(code),
    getValidatedMessagingTokenByEnvKey,
    getCredential,
    normalizeCredentialValue,
    registerExtraPlaceholderProviders: extraPlaceholderKeysModule.registerExtraPlaceholderProviders,
    getMessagingChannelForEnvKey,
  },
  filterEnabledChannelsByAgent,
  defaultPolicyPath: path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
  getAgentPolicyPath: (agent) => (agent ? agentOnboard.getAgentPolicyPath(agent) : null),
  resolveGpuPlan: (config) =>
    dockerGpuSandboxCreate.resolveProfileGpuCreatePlan(config, isLinuxDockerDriverGatewayEnabled()),
  appendResourceCreateArgs: (args, resourceProfile) =>
    appendResourceFlagsForProfile(args, resourceProfile, getOpenshellBinary(), {
      isNonInteractive,
      note,
      prompt,
      promptOrDefault,
    }),
});

const stageSandboxCredentialProviders = (
  input: import("./onboard/credential-provider-registration").StageSandboxCredentialProvidersInput<AgentDefinition | null>,
) =>
  registeredCredentialProviders.stageSandboxCredentialProviders(
    input,
    sandboxCreateIntentResolver.prepareCredentialProviders,
  );

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

const setupMessagingChannels = messagingChannelSetup.createSetupMessagingChannels({
  step,
  note,
  isNonInteractive,
  prompt,
});

// ── Step 7: OpenClaw ─────────────────────────────────────────────
const syncNemoClawConfigInSandbox = createNemoClawConfigSync({
  getProviderSelectionConfig,
  run,
  openshellArgv,
});

const configureOpenclawSandbox = openclawSetup.createConfigureOpenclawSandbox({
  syncNemoClawConfigInSandbox,
  reconcileWebSearch: openclawSetup.reconcileOpenClawWebSearchForReuse,
});

const setupOpenclaw = openclawSetup.createOpenclawSetup({
  step,
  agentProductName,
  configureOpenclawSandbox,
});

const {
  buildChain,
  buildAgentVerifyChain,
  buildControlUiUrls,
  buildOrphanedSandboxRollbackMessage,
  ensureDashboardForward,
  ensureFinalizationAgentDashboardForward,
  ensureAgentFixedForward,
  fetchGatewayAuthTokenFromSandbox,
  getDashboardForwardPort,
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
const sandboxCancelRollback = installSandboxCancelRollback({ recordRecovery }); // #4614
const {
  arePolicyPresetsApplied,
  computeSetupPresetSuggestions,
  filterSetupPolicyPresets,
  getSuggestedPolicyPresets,
  mergePolicyMessagingChannels,
  preparePolicyPresetResumeSelection,
  presetsCheckboxSelector,
  resolveSandboxBaselinePolicy,
  selectPolicyTier,
  selectTierPresetsAndAccess,
  setupPoliciesWithSelection,
  validatePolicyTierEnvEarly,
} = createOnboardPolicyApplication({
  localInferenceProviders: [...LOCAL_INFERENCE_PROVIDERS, "llama-cpp-local"],
  step,
  note,
  isNonInteractive,
  prompt,
  selectFromNumberedMenuOrExit,
  makeOnboardCancelExit,
  sandboxCancelRollback,
  useColor: USE_COLOR,
  withSandboxMutationLock: sandboxMutationLock.withSandboxMutationLock,
  waitForSandboxReady,
  waitForSandboxControlPlaneReady: finalizationHandlerDeps.waitForSandboxControlPlaneReady,
  parsePolicyPresetEnv,
  env: process.env,
});

const startRecordedStep = onboardRuntimeBoundary.startRecordedStep.bind(onboardRuntimeBoundary);
const recordStepComplete = onboardRuntimeBoundary.recordStepComplete.bind(onboardRuntimeBoundary);
const recordStepRejected = onboardRuntimeBoundary.recordStepRejected.bind(onboardRuntimeBoundary);
const recordStepSkipped = onboardRuntimeBoundary.recordStepSkipped.bind(onboardRuntimeBoundary);
const recordStepFailed = onboardRuntimeBoundary.recordStepFailed.bind(onboardRuntimeBoundary);
const recordStateSkipped = onboardRuntimeBoundary.recordStateSkipped.bind(onboardRuntimeBoundary);
const recordRepairEvent = onboardRuntimeBoundary.recordRepairEvent.bind(onboardRuntimeBoundary);
/** Run readiness gates while the authoritative rebuild target is still intact. */
async function preflightAuthoritativeRebuildTarget(
  opts: import("./onboard/authoritative-rebuild-target").AuthoritativeRebuildPreflightOptions,
): Promise<import("./state/onboard-checkpoint-types").CheckpointGatewayAuthority> {
  const authoritativeGateway = entryDecisions.requireGatewayBinding(
    authoritativeRebuildTarget.resolveAuthoritativeOnboardGatewayBinding(opts),
  );
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
  resetGatewayOwnerBinding();
  const fail = (message: string): never => {
    throw new Error(message);
  };
  try {
    await authoritativeRebuildTarget.preflightAuthoritativeRebuildTarget(
      { ...opts, controlUiPort: opts.controlUiPort ?? null },
      {
        resolveBaselinePolicy: resolveSandboxBaselinePolicy,
        bindGatewayAuthority: () => bindGatewayOwner(getGatewayOwner()),
        runFatalRuntimePreflight: async () =>
          onboardPreflightGatewayAuthority.runRuntimePreflight(
            authoritativeRebuildTarget.authoritativeRebuildRuntimePreflightOptions(opts),
            (code) => fail(`onboard runtime preflight exited with code ${String(code)}`),
          ),
        ensureOpenshell: () =>
          ensureOpenshellForOnboard((code) =>
            fail(`OpenShell component preflight exited with code ${String(code)}`),
          ),
        assertGatewayReadiness: onboardPreflightGatewayAuthority.collectGatewayReadiness,
        inferenceRouteState: (p, m) => readInferenceRouteState(authoritativeGateway.name, p, m),
        captureForwardList: () => runCaptureOpenshell(["forward", "list"], { ignoreError: true }),
        checkPort: (port) => checkPortAvailable(port),
      },
    );
    return gatewayAuthorityCheckpoint.checkpointGatewayAuthority(getGatewayOwner());
  } finally {
    resetGatewayOwnerBinding();
    GATEWAY_NAME = previous.gatewayName;
    GATEWAY_PORT = previous.gatewayPort;
    NON_INTERACTIVE = previous.nonInteractive;
    _preflightDashboardPort = previous.dashboardPort;
  }
}

// ── Main ─────────────────────────────────────────────────────────
const wrappedOnboard = onboardEntryOptions.wrapOnboard(runOnboard, onboardSession);
const onboard = onboardSessionBootstrap.wrapOnboardDeferredExit(wrappedOnboard);
async function runOnboard(opts: OnboardOptions = {}): Promise<void> {
  const hostMountScope = onboardSessionBootstrap.beginHostMountScope(opts.hostMounts);
  const hermesApiPortReservationScope = agentOnboard.createHermesApiPortReservationScope();
  resetGatewayOwnerBinding();
  setupInferenceFactory.assertNoOpenShellGatewayEndpointOverride();
  const runtimeControlRequests = runtimeControlFlow.applyOnboardRuntimeControlRequests(opts);
  const authoritativeGateway =
    authoritativeRebuildTarget.resolveAuthoritativeOnboardGatewayBinding(opts);
  const previousGatewayBinding = { name: GATEWAY_NAME, port: GATEWAY_PORT };
  const previousOpenshellGateway = process.env.OPENSHELL_GATEWAY;
  const previousOpenshellLocalTlsDir = process.env.OPENSHELL_LOCAL_TLS_DIR;
  const preparedDcodeRuntime = preparedDcodeRebuild.createPreparedDcodeRebuildRuntime(
    opts,
    authoritativeGateway?.name ?? GATEWAY_NAME,
  );
  setOnboardBrandingAgent(opts.agent || process.env.NEMOCLAW_AGENT || null);
  AUTO_YES = opts.autoYes === true || process.env.NEMOCLAW_YES === "1";
  const resolveEntryOptions = () =>
    onboardEntryOptions.resolveDefaultRunEntryOptionsFromState(opts, validateName, onboardSession);
  const initialEntryOptions = resolveEntryOptions();
  NON_INTERACTIVE = initialEntryOptions.nonInteractive;
  RECREATE_SANDBOX = opts.recreateSandbox || process.env.NEMOCLAW_RECREATE_SANDBOX === "1";
  _preflightDashboardPort =
    opts.controlUiPort ?? (process.env.NEMOCLAW_DASHBOARD_PORT != null ? DASHBOARD_PORT : null);
  onboardRuntimeBoundary.reset();
  const portableRetirementEntry = portableRetirementAuthority.beginPortableOnboardRetirementEntry({
    alreadyHeld: opts.onboardLockAlreadyHeld === true,
    command: `nemoclaw onboard${initialEntryOptions.resume ? " --resume" : ""}${initialEntryOptions.fresh ? " --fresh" : ""}${initialEntryOptions.nonInteractive ? " --non-interactive" : ""}${initialEntryOptions.requestedFromDockerfile ? ` --from ${initialEntryOptions.requestedFromDockerfile}` : ""}`,
    displayName: cliDisplayName(),
    homeDir: process.env.HOME || os.homedir(),
    loadRegistry: registry.load,
    registryFile: registry.REGISTRY_FILE,
    sessionFile: onboardSession.SESSION_FILE,
    withLifecycleLock: sandboxMutationLock.withMcpLifecycleLock,
  });
  let portableEnvScope:
    | import("./onboard/session-bootstrap").PortableOnboardEnvironmentScope
    | null = null;
  const restorePortableEnvScope = () => portableEnvScope?.restore();
  // Secure removal remains gated on successful migration of every staged legacy credential.
  let stagedLegacyKeys: string[] = [];
  let onboardTrace: ReturnType<typeof onboardTracing.startOnboardTrace> = {
    collector: null,
    span: null,
  };
  let completed = false,
    preserveDeferredExitSession = false,
    preserveIncompleteSession = false;
  try {
    await portableRetirementEntry.run(async () => {
      const entryOptions = resolveEntryOptions();
      const { fresh, nonInteractive, cannotPrompt, resume } = entryOptions;
      const { requestedFromDockerfile, requestedSandboxName } = entryOptions;
      NON_INTERACTIVE = nonInteractive;
      const validatePolicyTierBeforeRuntime =
        isNonInteractive() && !resume && opts.experimentalProfile !== "portable";
      if (validatePolicyTierBeforeRuntime) validatePolicyTierEnvEarly();
      const baseImageResolutionContext = baseImageResolutionFlow.createBaseImageResolutionContext({
        fresh,
        initialHint: opts.baseImageResolutionHint,
        initialPreResolvedMetadata: opts.preResolvedBaseImageMetadata,
      });
      const lockedRuntime = await resumeRuntime.prepare(
        opts,
        resume,
        isNonInteractive(),
        onboardSession.loadSession,
      );
      portableEnvScope = lockedRuntime.environmentScope;
      entryDecisions.clearGatewayEnvironmentWithoutBinding(authoritativeGateway, process.env);
      preparedDcodeRuntime.applyGatewayEnv(process.env);
      if (isNonInteractive() && !validatePolicyTierBeforeRuntime) validatePolicyTierEnvEarly();
      // Validate provider/model hints only after the locked profile and runtime authority are active.
      const stationSessionInput = onboardEntryOptions.prepareSessionInput(
        runtimeControlRequests,
        requestedSandboxName,
        resume,
        () =>
          resumeConfig.preflightEarlyOnboardEnvForResume(
            isNonInteractive(),
            opts.authoritativeResumeConfig === true,
          ),
      );
      const onboardingComputePlan = dockerDriverPlatform.resolveCurrentOpenShellComputePlan();
      entryDecisions.applyGatewayBindingIfPresent(authoritativeGateway, (binding) => {
        GATEWAY_NAME = binding.name;
        GATEWAY_PORT = binding.port;
        process.env.OPENSHELL_GATEWAY = binding.name;
      });
      onboardTrace = onboardTracing.startOnboardTrace(opts, process.env);
      let selectedMessagingChannels: string[] = [];
      let { session, fromDockerfile } =
        await onboardSessionBootstrap.prepareOnboardSessionValidated(
          {
            resume,
            fresh,
            requestedFromDockerfile,
            requestedSandboxName,
            cannotPrompt,
            nonInteractive: isNonInteractive(),
            authoritativeResumeConfig: opts.authoritativeResumeConfig === true,
            servingProfileProvenance: opts.servingProfileProvenance ?? null,
            apfInterceptorRequested: opts.apfInterceptorRequested ?? null,
            recreateSandboxRequested: RECREATE_SANDBOX,
            checkpointProfile: lockedRuntime.checkpointProfile,
            portableRuntimeAuthority: lockedRuntime.portableRuntimeContext?.authority ?? null,
            agentFlag: opts.agent || null,
            envAgent: process.env.NEMOCLAW_AGENT || null,
            requestedHostMounts: opts.hostMounts,
            ...stationSessionInput,
          },
          {
            loadSession: onboardSession.loadSession,
            clearSession: onboardSession.clearSession,
            createSession: onboardSession.createSession,
            saveSession: onboardSession.saveSession,
            updateSession: onboardSession.updateSession,
            applySessionRecovery,
            setOnboardBrandingAgent,
            getResumeConfigConflicts,
            recordResumeConflict: (conflict) =>
              onboardRuntimeBoundary.recordResumeConflict(conflict),
            resolvePath: path.resolve,
            cliName,
            error: (message) => console.error(message),
            exitProcess: (code) => process.exit(code),
          },
        );
      stagedLegacyValues.clear();
      migratedLegacyKeys.clear();
      stagedLegacyKeys = stageLegacyCredentialsToEnv();
      for (const key of stagedLegacyKeys) {
        const value = process.env[key];
        if (value) stagedLegacyValues.set(key, value);
      }
      if (resume) {
        const persistedHashes = session?.migratedLegacyValueHashes ?? {};
        for (const [key, hash] of Object.entries(persistedHashes)) {
          if (typeof key !== "string" || typeof hash !== "string") continue;
          const currentValue = stagedLegacyValues.get(key);
          if (currentValue === undefined || legacyValueHash(currentValue) !== hash) continue;
          migratedLegacyKeys.add(key);
        }
      }
      if (stagedLegacyKeys.length > 0) {
        console.error(
          `  Staged ${String(stagedLegacyKeys.length)} legacy credential(s) for migration to the OpenShell gateway.`,
        );
      }
      const effectiveHostMounts = hostMountScope.activate(session?.metadata.hostMounts);
      await onboardRuntimeBoundary.recordOnboardStarted(resume);
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
      registerIncompleteOnboardExitHandlerForSession(
        onboardSession,
        () => completed || preserveIncompleteSession,
      );
      const agent = await selectOnboardAgent({
        agentFlag: opts.agent,
        session,
        resume,
        canPrompt: !cannotPrompt,
      });
      const recordedSandboxName =
        session?.steps?.sandbox?.status === "complete" ? session?.sandboxName || null : null;
      const checkpointedSandboxName = onboardSessionBootstrap.getCheckpointedSandboxName(
        resume,
        agent,
        session,
      );
      const gatewaySandboxName = entryDecisions.selectResumeSandboxName(
        resume,
        recordedSandboxName,
        requestedSandboxName,
        checkpointedSandboxName,
      );
      const onboardGateway = gatewayBinding.resolveCoreOnboardGatewayBinding({
        authoritativeGateway,
        currentGateway: { name: GATEWAY_NAME, port: GATEWAY_PORT },
        resume,
        sandbox: entryDecisions.readSandboxForGatewayBinding(
          gatewaySandboxName,
          registry.getSandbox,
        ),
      });
      ({ name: GATEWAY_NAME, port: GATEWAY_PORT } = onboardGateway);
      process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
      const resolvedGatewayOwner = getGatewayOwner();
      let checkpointedGatewayOwner = resolvedGatewayOwner;
      session = onboardSession.updateSession((currentSession) => {
        checkpointedGatewayOwner = gatewayAuthorityCheckpoint.bindGatewayAuthorityToCheckpoint(
          currentSession,
          resolvedGatewayOwner,
        );
      });
      bindGatewayOwner(checkpointedGatewayOwner);
      const selectedAgentTransition = runtimeControlFlow.planSelectedAgentTransition({
        resume,
        session,
        selectedAgentName: agent?.name,
        routerPort: loadBlueprintProfile("routed")?.router.port || 4000,
        note,
      });
      setOnboardBrandingAgent(agent?.name || "openclaw");
      session = selectedAgentTransition.session;
      const resumeAgentChanged = selectedAgentTransition.resumeAgentChanged;
      const forceProviderSelectionForAgentChange = resumeAgentChanged;
      console.log("");
      console.log(`  ${cliDisplayName()} Onboarding`);
      if (isNonInteractive()) note("  (non-interactive mode)");
      if (resume) note("  (resume mode)");
      console.log("  ===================");
      onboardSessionBootstrap.reportReadOnlyHostMounts(effectiveHostMounts, note);
      const explicitSandboxGpuFlag = resolveSandboxGpuFlagFromOptions(opts);
      const recordedGpuPassthroughBeforePreflight = session?.gpuPassthrough === true;
      const initialFlowContext = {
        resume,
        fresh,
        session,
        agent,
        recordedSandboxName,
        requestedSandboxName,
        sandboxName: recordedSandboxName || requestedSandboxName || checkpointedSandboxName || null,
        fromDockerfile,
        model: session?.model || null,
        provider: session?.provider || null,
        endpointUrl: session?.endpointUrl || null,
        credentialEnv: session?.credentialEnv || null,
        hermesAuthMethod: normalizeHermesAuthMethod(session?.hermesAuthMethod),
        hermesToolGateways: normalizeHermesToolGatewaySelections(session?.hermesToolGateways),
        preferredInferenceApi: session?.preferredInferenceApi || null,
        ...reasoningMode.getCompatibleEndpointReasoningSessionState(session),
        nimContainer: session?.nimContainer || null,
        webSearchConfig: session?.webSearchConfig || null,
        webSearchSupported: false,
        selectedMessagingChannels,
        gpu: null as ReturnType<typeof nim.detectGpu> | null,
        sandboxGpuConfig: null as ReturnType<typeof resolveSandboxGpuConfig> | null,
        gpuPassthrough: false,
        resumeHasResolvedGpuIntent: false,
        requestedGpuPassthrough: opts.gpu === true,
      };
      type InitialOnboardFlowContext = typeof initialFlowContext;
      const [preflightPhase, gatewayPhase]: readonly [
        import("./onboard/machine/sequence-runner").OnboardSequencePhase<InitialOnboardFlowContext>,
        import("./onboard/machine/sequence-runner").OnboardSequencePhase<InitialOnboardFlowContext>,
      ] = createInitialOnboardFlowPhases({
        explicitSandboxGpuFlag,
        sandboxGpuDevice: opts.sandboxGpuDevice ?? null,
        gpuRequested: opts.gpu === true,
        noGpu: opts.noGpu === true,
        allowDeferredN1xManagedVllm: opts.allowDeferredN1xManagedVllm,
        env: process.env,
        recordedGpuPassthroughBeforePreflight,
        commitSelectedAgentTransition: selectedAgentTransition.commit,
        ensureResumePreflightDashboardPortAvailable: () => {
          if (_preflightDashboardPort === null) preflightDashboardPortRangeAvailability();
        },
        preflightDeps: {
          getSandbox: registry.getSandbox.bind(registry),
          getResumeSandboxGpuOverrides,
          detectGpuForReadiness: () => nim.detectGpu({ proveArm64WslDockerDesktopGpu: null }),
          detectGpu: nim.detectGpu,
          runPreflight: (preflightOptions) => preflight({ ...opts, ...preflightOptions }),
          assessHost,
          assertOnboardHostReadiness: (host, gpu, options) =>
            fatalRuntimePreflight.assertOnboardHostReadiness(host, gpu ?? null, {
              ...options,
              allowStorageRemediation: !isGatewayExternallySupervised(),
            }),
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
        assertGatewayReadiness: () =>
          onboardPreflightGatewayAuthority.collectGatewayReadiness().then(() => undefined),
        gatewayName: GATEWAY_NAME,
        recreateSandbox: isRecreateSandbox,
        requiresBindMounts: effectiveHostMounts.length > 0,
        gatewayDeps: {
          ...machineGatewayOwnerDeps,
          refreshDockerDriverGatewayReuseState,
          gatewayCliSupportsLifecycleCommands: () =>
            gatewayCliSupportsLifecycleCommands(runCaptureOpenshell),
          waitForGatewayHttpReady,
          recoverGatewayRuntime,
          getGatewayLocalEndpoint,
          stopDashboardForward: () =>
            bestEffortForwardStop(runOpenshell, getOnboardDashboardPort()),
          destroyGateway,
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
        recordRepairEvent,
      });
      // #2753: An explicit requested name precedes its checkpointed name for an unfinished sandbox.
      const coreFlowContext = prepareCoreOnboardFlowContext({
        initial: initialFlowResult,
        recordedSandboxName,
        requestedSandboxName,
        checkpointedSandboxName,
        selectedMessagingChannels,
        assertSandboxNameAllowed: onboardEntryOptions.assertDefaultSandboxNameAllowed,
      });
      const runCoreGatewayOpenshell = setupInferenceFactory.createGatewayScopedOpenshellRunner(
        runOpenshell,
        GATEWAY_NAME,
      );
      const endpointProvenance = {
        endpointSource: opts.endpointSource,
        endpointSourceProvider: opts.rebuildRegistryInferenceRoute?.route.provider ?? null,
        endpointSourceEndpointUrl: opts.rebuildRegistryInferenceRoute?.route.endpointUrl ?? null,
        getSandboxRegistryEntry: registry.getSandbox,
      };
      const providerReviewDeps = setupInferenceFactory.createDefaultProviderReviewDeps(
        onboardSession.updateSession,
        onboardSessionBootstrap.checkpointSandboxName,
      );
      const coreFlowPhases = createCoreOnboardFlowPhases<
        InitialOnboardFlowContext,
        unknown,
        MessagingChannelConfig,
        import("./resources-cmd").ResourceProfile
      >({
        resumeProvider: {
          isNonInteractive,
          isRoutedInferenceProvider,
          providerExistsInGateway,
          replaceNamedCredential,
          resumeManagedLlamaCppRuntime: setupNimFlow.bindManagedLlamaCppResume(GATEWAY_PORT),
        },
        providerInference: {
          gatewayName: GATEWAY_NAME,
          inspectSandboxForCreate,
          forceProviderSelection: forceProviderSelectionForAgentChange,
          ...authoritativeRebuildTarget.rebuildProviderFlowOptions(opts, coreFlowContext),
          endpointProvenance,
          env: process.env,
          constants: {
            hermesProviderName: hermesProviderAuth.HERMES_PROVIDER_NAME,
            hermesApiKeyAuthMethod: HERMES_AUTH_METHOD_API_KEY,
            hermesApiKeyCredentialEnv: HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
          },
          deps: {
            checkGatewayRouteCompatibility,
            preflightGatewayRouteDiscovery,
            getSandboxRecoveryAuthority: providerRecovery.getSandboxRecoveryAuthority,
            withGatewayRouteMutationLock: gatewayRouteMutationLock.withGatewayRouteMutationLock,
            normalizeHermesAuthMethod,
            setupNim: (
              g,
              s,
              a,
              recover,
              gateway,
              assertRouteCompatible,
              canProbeRoute,
              recoverySessionId,
              revalidateSandboxIdentity,
            ) =>
              setupNim(
                g,
                s,
                a,
                recover,
                opts.rebuildRegistryInferenceRoute,
                gateway,
                assertRouteCompatible,
                canProbeRoute,
                recoverySessionId,
                revalidateSandboxIdentity,
              ),
            setupInference,
            resolveHostLocalInferenceStartupSelection:
              setupNimFlow.createHermesPortableOllamaInferenceResolver({
                runtimeContext: lockedRuntime.portableRuntimeContext,
                credentialEnv: OLLAMA_PROXY_CREDENTIAL_ENV,
                getReservationSessionId: () => session?.sessionId,
                runGatewayOpenshell: runCoreGatewayOpenshell,
              }),
            startRecordedStep,
            recordStepComplete,
            recordStepRejected,
            toSessionUpdates: (updates) =>
              toSessionUpdates(updates as Parameters<typeof toSessionUpdates>[0]),
            skippedStepMessage,
            recordStateSkipped,
            recordRepairEvent,
            hydrateCredentialEnv,
            ...reasoningMode.compatibleEndpointReasoningConfigureDeps,
            ...reasoningMode.compatibleEndpointReasoningClearDeps,
            repairLocalInferenceSystemdOverrideOrExit,
            isNonInteractive,
            getOpenshellBinary,
            needsBedrockRuntimeAdapter: (providerName, url) =>
              providerName === "compatible-anthropic-endpoint" &&
              bedrockRuntimeOnboard.needsBedrockRuntimeAdapter(url),
            isInferenceRouteReady,
            isRoutedInferenceProvider,
            reconcileModelRouter,
            reupsertRoutedProvider: setupInferenceFactory.createRoutedResumeProviderUpsert({
              upsertProvider,
              runGatewayOpenshell: runCoreGatewayOpenshell,
              hydrateCredentialEnv,
            }),
            reserveSandboxInferenceRoute: registry.reserveSandboxInferenceRoute,
            registryUpdateSandbox: (name, updates) => registry.updateSandbox(name, updates),
            ...providerReviewDeps,
            promptValidatedSandboxName,
            assessHost,
            formatSandboxBuildEstimateNote,
            formatOnboardConfigSummary,
            prompt,
            cliName,
            log: (message) => console.log(message),
            error: (message) => console.error(message),
            exitProcess: (code) => process.exit(code),
            deleteEnv: (name) => {
              delete process.env[name];
            },
          },
        },
        sandbox: {
          gatewayName: GATEWAY_NAME,
          apfInterceptorRequested: session?.apfInterceptorRequested === true,
          hermesPortableLifecycle:
            lockedRuntime.portableRuntimeContext !== null && agent?.name === "hermes",
          ...authoritativeRebuildTarget.authoritativeRebuildSandboxFlowOptions(opts),
          recreateJournalTargetIntentFingerprint:
            opts.recreateJournalTargetIntentFingerprint ?? null,
          resumeAgentChanged,
          requestedObservabilityEnabled: runtimeControlRequests.requestedObservabilityEnabled,
          requestedDcodeAutoApprovalMode: runtimeControlRequests.requestedDcodeAutoApprovalMode,
          rebuildPreservedEnv: opts.rebuildPreservedEnv,
          hostMounts: effectiveHostMounts,
          endpointProvenance,
          recreateSandbox: isRecreateSandbox,
          controlUiPort: _preflightDashboardPort,
          rootDir: ROOT,
          env: process.env,
          deps: {
            checkGatewayRouteCompatibility,
            withGatewayRouteMutationLock: gatewayRouteMutationLock.withGatewayRouteMutationLock,
            resolvePath: preparedDcodeRuntime.resolveDockerfileProbePath,
            agentSupportsWebSearch,
            agentSupportsWebSearchProvider,
            ...{ note, cliName },
            updateSession: onboardSession.updateSession,
            getStoredMessagingChannelConfig,
            hydrateMessagingChannelConfig,
            messagingChannelConfigsEqual,
            getSandboxReuseState,
            getSandboxRecreateObservation,
            getDcodeSelectionDrift: sandboxCreateOrchestrationRuntime.readDcodeSelectionDrift,
            hasSandboxGpuDrift,
            getSandboxHermesToolGateways: (name) => registry.getSandbox(name)?.hermesToolGateways,
            getSandboxRegistryEntry: registry.getSandbox,
            normalizeHermesToolGatewaySelections,
            stringSetsEqual,
            removeSandboxFromRegistry: registry.removeSandboxWithReceipt.bind(registry),
            restoreSandboxRegistryEntryIfMissing:
              registry.restoreSandboxEntryIfMissing.bind(registry),
            ensureValidatedWebSearchCredential,
            isBackToSelection,
            configureWebSearch,
            startRecordedStep,
            getRecordedMessagingChannelsForResume,
            showMessagingStage: () => step(5, 8, "Messaging channels"),
            setupMessagingChannels: messagingChannelSetup.createSetupMessagingChannels({
              step,
              note,
              isNonInteractive,
              prompt,
              googlechatTunnelRuntime: opts.googlechatTunnelRuntime,
            }),
            readMessagingPlanFromEnv: messagingChannelSetup.readMessagingPlanFromEnv,
            writePlanToEnv: messagingChannelSetup.writePlanToEnv,
            clearPlanEnv: messagingChannelSetup.clearPlanEnv,
            getRegistrySandboxMessagingAuthority:
              messagingChannelSetup.getRegistrySandboxMessagingAuthority,
            providerMatchesGatewayCredential,
            stageSandboxCredentialProviders,
            promptValidatedSandboxName,
            selectResourceProfileForSandbox: () =>
              selectResourceProfileForSandbox({ isNonInteractive, note, prompt, promptOrDefault }),
            listRegistrySandboxes: registry.listSandboxes,
            planRegisteredExtraProviders: (gatewayName) =>
              planRegisteredExtraProviders(gatewayName, { runOpenshell }),
            resolveSandboxCreateIntent: sandboxCreateIntentResolver.resolve,
            createSandbox: preparedDcodeRuntime.bindCreateSandbox((...createArgs) =>
              withSandboxPortReservationScope((dashboardPortReservationScope) =>
                createSandboxWithBaseImageResolution(
                  baseImageResolutionContext,
                  lockedRuntime.portableRuntimeContext,
                  onboardingComputePlan,
                  opts.managedWorkloadRebuild ?? null,
                  opts.tempManagedRuntime === true,
                  opts.tempManagedRuntimeCatalog ?? null,
                  dashboardPortReservationScope,
                  hermesApiPortReservationScope,
                  ...createArgs,
                ),
              ),
            ),
            updateSandboxRegistry: (name, updates) => registry.updateSandbox(name, updates),
            finalizeSandboxRouteReservation: registry.finalizeSandboxRouteReservation,
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
        },
      });
      const coreFlowResult = await runCoreOnboardFlowSlice({
        context: coreFlowContext,
        runtime: onboardRuntimeBoundary.getRuntime(),
        phases: coreFlowPhases,
        resume,
        recordRepairEvent,
      });
      if (isCoreFlowCompleteBeforeFinalization(coreFlowResult)) {
        sandboxCancelRollback.disarm();
        await portableRetirementEntry.supersede(lockedRuntime.checkpointProfile);
        completed = true;
        process.exitCode = 0;
        return;
      }
      setupInferenceFactory.selectGatewayForFollowupOrExit(GATEWAY_NAME, runOpenshell);
      const finalFlowContext = prepareFinalOnboardFlowContext(coreFlowResult);
      let liveFinalFlowContext: InitialOnboardFlowContext = finalFlowContext;
      const finalFlowPhases = createFinalOnboardFlowPhases<
        InitialOnboardFlowContext,
        import("./dashboard/contract").DashboardDeliveryChain,
        import("./verify-deployment").VerifyDeploymentResult
      >({
        branchState: agent ? "agent_setup" : "openclaw",
        preserveRebuildLivePolicy: opts.rebuildPolicySourcePath !== undefined,
        agentSetupDeps: {
          handleAgentSetup: agentOnboard.handleAgentSetup,
          agentSetupContext: () => ({
            ...{ step, runCaptureOpenshell, captureOpenshell },
            openshellShellCommand,
            openshellBinary: getOpenshellBinary(),
            gatewayName: GATEWAY_NAME,
            startRecordedStep,
            recordStepComplete,
            recordStepFailed,
            skippedStepMessage,
          }),
          ensureAgentDashboardForward: (name, selectedAgent) =>
            ensureFinalizationAgentDashboardForward(
              name,
              selectedAgent,
              undefined,
              hermesApiPortReservationScope,
            ),
          persistDashboardPort: (name, port) =>
            registry.updateSandbox(name, { dashboardPort: port }),
          recordStepSkipped,
          isOpenclawReady,
          skippedStepMessage,
          recordStateSkipped,
          startRecordedStep,
          setupOpenclaw,
          configureOpenclawSandbox,
          recordStepComplete,
          toSessionUpdates: (updates) =>
            toSessionUpdates(updates as Parameters<typeof toSessionUpdates>[0]),
        },
        policiesDeps: {
          loadSession: onboardSession.loadSession,
          getActiveSandbox: (name) => registry.getSandbox(name),
          mergePolicyMessagingChannels,
          detectUnconfiguredMessagingChannels:
            messagingChannelSetup.detectUnconfiguredMessagingChannels,
          verifyCompatibleEndpointSandboxSmoke: (options) =>
            verifyCompatibleEndpointSandboxSmoke({
              ...options,
              runOpenshell: runCoreGatewayOpenshell,
              redact,
            }),
          preparePolicyPresetResumeSelection,
          arePolicyPresetsApplied,
          skippedStepMessage,
          recordStateSkipped,
          startRecordedStep,
          setupPoliciesWithSelection,
          recordStepComplete,
          toSessionUpdates: (updates) =>
            toSessionUpdates(updates as Parameters<typeof toSessionUpdates>[0]),
        },
        finalization: {
          stagedLegacyKeys,
          migratedLegacyKeys,
          webSearchEnabled: (config) => braveProviderProfile.shouldEnableBraveWebSearch(config),
          webSearchProvider: (config) => webSearchProviderForConfig(config),
        },
        finalizationDeps: {
          ensureAgentDashboardForward: ensureFinalizationAgentDashboardForward,
          setDefaultSandbox: registry.setDefault,
          verifyWebSearchInsideSandbox,
          toSessionUpdates: (updates) =>
            toSessionUpdates(updates as Parameters<typeof toSessionUpdates>[0]),
          removeLegacyCredentialsFile,
          cleanupStaleHostFiles,
          getChatUiUrl: () => process.env.CHAT_UI_URL || `http://127.0.0.1:${DASHBOARD_PORT}`,
          buildVerifyChain: (chatUiUrl, name) => buildAgentVerifyChain(chatUiUrl, name, agent),
          verifyDeployment: async (name, chain) => {
            const verifyDeploymentModule: typeof import("./verify-deployment") = require("./verify-deployment");
            return verifyDeploymentModule.verifyDeployment(
              name,
              chain,
              {
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
              },
              {
                diagnoseCustomOpenClawRuntime:
                  verifyDeploymentModule.shouldDiagnoseCustomOpenClawRuntime(
                    liveFinalFlowContext.fromDockerfile,
                    agent?.name,
                  ),
              },
            );
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
      const finalFlowResult = await runFinalOnboardFlowSlice({
        context: finalFlowContext,
        runtime: onboardRuntimeBoundary.getRuntime(),
        phases: finalFlowPhases,
        recordRepairEvent,
        afterPoliciesReady: () => {
          sandboxCancelRollback.disarm();
        },
        onContextUpdated: (context) => {
          liveFinalFlowContext = context;
        },
      });
      completed = finalFlowResult.session.machine.state === "complete";
      if (completed && finalFlowResult.session.sandboxName) {
        await portableRetirementEntry.supersede(lockedRuntime.checkpointProfile);
      }
      process.exitCode = completed ? 0 : 1;
    });
  } catch (error) {
    preserveDeferredExitSession =
      onboardSessionBootstrap.shouldPreserveIncompleteOnboardSession(error);
    throw error;
  } finally {
    try {
      await hermesApiPortReservationScope.release();
      restorePortableEnvScope();
      portableRetirementEntry.release();
      onboardRuntimeBoundary.clear();
      onboardTracing.finishOnboardTrace(onboardTrace, completed);
      GATEWAY_NAME = previousGatewayBinding.name;
      GATEWAY_PORT = previousGatewayBinding.port;
      entryDecisions.restoreGatewayEnvironment(process.env, previousOpenshellGateway);
      if (previousOpenshellLocalTlsDir === undefined) delete process.env.OPENSHELL_LOCAL_TLS_DIR;
      else process.env.OPENSHELL_LOCAL_TLS_DIR = previousOpenshellLocalTlsDir;
      resetGatewayOwnerBinding();
    } finally {
      restorePortableEnvScope();
      hostMountScope.restore();
    }
    if (preserveDeferredExitSession) preserveIncompleteSession = true;
  }
  preserveIncompleteSession = true;
}

module.exports = {
  buildOrphanedSandboxRollbackMessage,
  buildProviderArgs,
  buildGatewayBootstrapSecretsScript,
  buildCompatibleEndpointSandboxSmokeCommand,
  buildCompatibleEndpointSandboxSmokeScript,
  buildSandboxGpuCreateArgs,
  buildDirectGpuPolicyYaml,
  buildDirectSandboxGpuProofCommands,
  compactText,
  copyBuildContextDir,
  classifySandboxCreateFailure,
  configureWebSearch,
  createSandbox,
  createSandboxWithTemporaryManagedRuntime,
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
  clearAgentScopedResumeState: runtimeControlFlow.clearAgentScopedResumeState,
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
  recoverGatewayRuntime,
  buildChain,
  buildControlUiUrls,
  startGateway,
  startDockerDriverGateway,
  findAvailableDashboardPort,
  startGatewayForRecovery,
  ...{ openshellArgv, runOpenshell, runCaptureOpenshell, sleepSeconds },
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
  isNonInteractive,
  isOpenclawReady,
  arePolicyPresetsApplied,
  getSuggestedPolicyPresets,
  computeSetupPresetSuggestions,
  mergeRequiredHermesToolGatewayPolicyPresets,
  filterSetupPolicyPresets,
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
  patchStagedDockerfile,
  ensureOllamaAuthProxy,
  fetchGatewayAuthTokenFromSandbox,
  getProbeAuthMode,
  getValidationProbeCurlArgs,
  verifyCompatibleEndpointSandboxSmoke,
};
