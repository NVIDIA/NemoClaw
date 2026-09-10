// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type * as TypeBoxValueModule from "typebox/value" with { "resolution-mode": "import" };
import { isDeepStrictEqual } from "node:util";
import { cloneAndDeepFreeze } from "../../core/immutable";
import { resolveManagedStartupInferenceRoute } from "../../inference/gateway/route-contract";
import { normalizeInferenceSelection } from "../../inference/selection";
import { BUILD_ENDPOINT_URL } from "../../inference/provider-models";
import type { ManagedStartupProfile } from "../../onboard/managed-startup/profile";
import {
  buildManagedStartupProfile,
  type ManagedStartupProfileBuilderInput,
} from "../../onboard/managed-startup/profile-builder";
import { readManagedWorkloadAuthority } from "../../onboard/workload/authority";
import { sortCanonicalMappings } from "../../config/canonical-mapping";
import {
  isCredentialEnvironmentReferenceName,
  EXPORTED_VLLM_PROFILE_ID,
  EXPORTED_VLLM_CONTEXT_WINDOW,
  isImmutableImageReference,
  isValidNemoClawBoundedText,
  isValidNemoClawInferenceEndpoint,
  isValidNemoClawLocalResourceName,
  isValidNemoClawPort,
  isValidNemoClawRuntimeProvider,
  isValidNemoClawSandboxName,
  isSupportedInferenceApi,
  NemoClawInferenceTuningSchema,
  NemoClawAgentExecutionSchema,
} from "../../config/model";
import { fingerprintOpenShellSandboxId } from "../sandbox/openshell-identity";
import { ExportSourceValuesSchema } from "./export-evidence";
import { validateManagedServing } from "./verify-managed-serving";
import type {
  CanonicalExportPolicy,
  ExportFinding,
  ExportSourceFailureCategory,
  ExportSourceVerificationResult,
  NonEmptyExportFindings,
  ObservedExportRegistry,
  QualifiedExportSnapshot,
  VerifiedExportSource,
} from "./export-evidence";

const { Check } = require("typebox/value") as typeof TypeBoxValueModule;
const DEFAULT_DASHBOARD_URL = "http://127.0.0.1:18789";
// V1 intentionally recognizes only the accepted single-sandbox Hermes binding.
// A future onboarding-default change must make a new export fidelity decision.
const DEFAULT_HERMES_API_PORT = 8642;

type SupportedExportAgent = "hermes" | "openclaw";
type ManagedStartupInferenceRoute = ReturnType<typeof resolveManagedStartupInferenceRoute>;
interface ExportAgentProfileProjection {
  readonly compatibility: Readonly<Record<string, unknown>> | null;
  readonly dashboard: ManagedStartupProfileBuilderInput["dashboard"];
  readonly primaryModelRef: string | null;
}

const EXPORT_AGENT_PROFILE_PROJECTIONS: Record<
  SupportedExportAgent,
  (route: ManagedStartupInferenceRoute) => ExportAgentProfileProjection
> = {
  openclaw: (route) => ({
    primaryModelRef: route.primaryModelRef,
    compatibility: route.inferenceCompat ?? {},
    dashboard: {
      agent: "openclaw",
      mode: "loopback",
      url: DEFAULT_DASHBOARD_URL,
      port: 18_789,
      bindAddress: "127.0.0.1",
      wslExposure: false,
    },
  }),
  hermes: (_route) => ({
    primaryModelRef: null,
    compatibility: null,
    dashboard: {
      agent: "hermes",
      mode: "disabled",
      url: DEFAULT_DASHBOARD_URL,
      browserUrl: DEFAULT_DASHBOARD_URL,
      publicPort: null,
      internalPort: null,
      tuiEnabled: false,
    },
  }),
};

type VerifiedExportSourceData = Pick<
  VerifiedExportSource,
  | "agent"
  | "execution"
  | "gateway"
  | "inference"
  | "policy"
  | "proxy"
  | "runtime"
  | "sandboxName"
  | "webSearch"
>;

function verifiedExportSource(data: VerifiedExportSourceData): VerifiedExportSource {
  return cloneAndDeepFreeze(data) as VerifiedExportSource;
}

function finding(
  field: string,
  category: ExportSourceFailureCategory,
  diagnostic: string,
): ExportFinding {
  return { field, category, diagnostic };
}

function nonEmpty(findings: ExportFinding[]): NonEmptyExportFindings {
  const [first, ...rest] = findings;
  if (!first) throw new Error("An export rejection must contain a finding.");
  return [first, ...rest];
}

function hasEqualJsonStructure(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(sortCanonicalMappings(left)) === JSON.stringify(sortCanonicalMappings(right))
  );
}

function hasEntries(value: unknown): boolean {
  return Array.isArray(value)
    ? value.length > 0
    : value !== undefined && value !== null && value !== false;
}

function hasBraveSearch(entry: ObservedExportRegistry): boolean {
  return entry.webSearchEnabled === true && entry.webSearchProvider === "brave";
}

function classifyHermesExcludedCapabilities(entry: ObservedExportRegistry): ExportFinding[] {
  const excluded: Array<[string, unknown, string]> = [
    ["spec.sandboxes[].agents[0].tools", entry.hermesToolGateways, "enabled Hermes tool gateways"],
    [
      "spec.sandboxes[].agents[0].dashboard",
      [
        entry.hermesDashboardEnabled,
        entry.hermesDashboardPort,
        entry.hermesDashboardInternalPort,
        entry.hermesDashboardTui,
      ].some(hasEntries),
      "a non-default Hermes dashboard",
    ],
    [
      "spec.sandboxes[].agents[0].authentication",
      entry.hermesAuthMethod || entry.hermesInferenceProvider,
      "Hermes-specific authentication",
    ],
  ];
  const present = excluded.filter(([, value]) => hasEntries(value));
  if (entry.agent !== "hermes") {
    return present.length > 0
      ? [
          finding(
            "source.registry",
            "unsupported",
            "V1 export does not support stale agent-specific registry state.",
          ),
        ]
      : [];
  }
  return present.map(([field, , capability]) =>
    finding(field, "unsupported", "V1 export does not support " + capability + "."),
  );
}

function classifyExcludedCapabilities(entry: ObservedExportRegistry): ExportFinding[] {
  const excluded: Array<[string, unknown, string]> = [
    [
      "spec.sandboxes[].runtime.customImage",
      entry.fromDockerfile,
      "custom images and build contexts",
    ],
    [
      "spec.sandboxes[].runtime.gpu",
      entry.sandboxGpuEnabled || entry.sandboxGpuDevice,
      "direct sandbox GPU",
    ],
    ["spec.sandboxes[].mounts", entry.hostMounts, "host mounts"],
    ["spec.sandboxes[].observability", entry.observabilityEnabled, "observability"],
    [
      "spec.sandboxes[].integrations.webSearch",
      !hasBraveSearch(entry) && (entry.webSearchEnabled || entry.webSearchProvider),
      "web search",
    ],
    ["spec.sandboxes[].integrations.messaging", entry.messaging, "messaging"],
    ["spec.sandboxes[].integrations.mcp", entry.mcp, "managed tools"],
    [
      "spec.sandboxes[].agents.secondary",
      entry.openclawImagePluginInstalls,
      "secondary agents or added agent plugins",
    ],
    [
      "spec.sandboxes[].agents[0].toolDisclosure",
      entry.toolDisclosure === "direct",
      "direct tool disclosure",
    ],
    [
      "spec.sandboxes[].agents[0].dashboard",
      entry.dashboardRemoteBindPrepared,
      "remote dashboard exposure",
    ],
  ];
  const findings = excluded
    .filter(([, value]) => hasEntries(value))
    .map(([field, , capability]) =>
      finding(field, "unsupported", "V1 export does not support " + capability + "."),
    );
  return [...findings, ...classifyHermesExcludedCapabilities(entry)];
}

function classifyHermesApiConfiguration(entry: ObservedExportRegistry): ExportFinding[] {
  if (
    entry.agent !== "hermes" ||
    entry.hermesApiPort === undefined ||
    entry.hermesApiPort === null ||
    entry.hermesApiPort === DEFAULT_HERMES_API_PORT
  ) {
    return [];
  }
  return [
    finding(
      "spec.sandboxes[].agents[0].api",
      "unsupported",
      "V1 export requires the default Hermes API configuration.",
    ),
  ];
}

function classifyRegistryProvenance(entry: ObservedExportRegistry): ExportFinding[] {
  const findings: ExportFinding[] = [];
  if (!entry.lifecycleGeneration || !entry.lifecycleLiveIdentityFingerprint)
    findings.push(
      finding(
        "source.lifecycle",
        "missing-provenance",
        "Lifecycle generation and live identity provenance are required.",
      ),
    );
  if (typeof entry.gatewayPort !== "number" || !entry.gatewayName)
    findings.push(
      finding(
        "spec.gateway",
        "missing-provenance",
        "A persisted gateway name and port are required.",
      ),
    );
  if (!entry.openshellDriver)
    findings.push(
      finding(
        "spec.sandboxes[].runtime.provider",
        "missing-provenance",
        "The persisted OpenShell runtime driver is required.",
      ),
    );
  else if (!isValidNemoClawRuntimeProvider(entry.openshellDriver))
    findings.push(
      finding(
        "spec.sandboxes[].runtime.provider",
        "unsupported",
        "The persisted OpenShell runtime driver is not a supported provider identity.",
      ),
    );
  return findings;
}

function classifyWorkload(entry: ObservedExportRegistry): ExportFinding[] {
  if (!entry.workload) {
    return [
      finding(
        "spec.sandboxes[].runtime.image",
        "missing-provenance",
        "A managed immutable workload receipt is required.",
      ),
    ];
  }
  if (entry.workload.kind !== "managed-image") {
    return [
      finding(
        "spec.sandboxes[].runtime.image",
        "unsupported",
        "V1 export requires a managed immutable release image.",
      ),
    ];
  }
  const findings: ExportFinding[] = [];
  if (!isImmutableImageReference(entry.workload.reference))
    findings.push(
      finding(
        "spec.sandboxes[].runtime.image",
        "ambiguous",
        "The managed workload reference is not pinned to an immutable digest.",
      ),
    );
  if (!entry.workload.platform)
    findings.push(
      finding(
        "source.workload.platform",
        "missing-provenance",
        "The immutable workload platform is required.",
      ),
    );
  if (entry.workload.credentialProxyReplayRequired)
    findings.push(
      finding(
        "spec.sandboxes[].runtime.proxy",
        "unsupported",
        "V1 export does not support host proxy credential replay.",
      ),
    );
  if (entry.workload.corporateCaB64 !== undefined)
    findings.push(
      finding(
        "spec.sandboxes[].runtime.corporateCa",
        "unsupported",
        "V1 export does not support a custom corporate CA bundle.",
      ),
    );
  return findings;
}

/** Report every v1-excluded capability represented by the registry row. */
export function classifyExportRegistry(entry: ObservedExportRegistry): ExportFinding[] {
  const findings = classifyExcludedCapabilities(entry);
  if (entry.agent !== "openclaw" && entry.agent !== "hermes")
    findings.push(
      finding(
        "spec.sandboxes[].agents[0].type",
        "unsupported",
        "V1 export requires OpenClaw or Hermes.",
      ),
    );
  findings.push(...classifyHermesApiConfiguration(entry));
  if (entry.pendingRouteReservation === true)
    findings.push(
      finding(
        "source.registry",
        "ambiguous",
        "The registry row is a pending route reservation, not a published sandbox.",
      ),
    );
  findings.push(...classifyRegistryProvenance(entry), ...classifyWorkload(entry));
  if (entry.hostLocalInferenceReceipt || entry.hostLocalInferenceProvenance || entry.nimContainer)
    findings.push(
      finding(
        "spec.inferenceProviders",
        "unsupported",
        "This local inference topology is not represented by v1 export.",
      ),
    );
  return findings;
}

function expectedManagedStartupProfile(entry: ObservedExportRegistry): ManagedStartupProfile {
  if (entry.agent !== "openclaw" && entry.agent !== "hermes") {
    throw new Error("The agent is unsupported.");
  }
  const agent = entry.agent;
  const selected = normalizeInferenceSelection(entry);
  if (
    !selected.provider ||
    !selected.model ||
    !selected.preferredInferenceApi ||
    !isSupportedInferenceApi(selected.preferredInferenceApi)
  ) {
    throw new Error("The inference selection is incomplete.");
  }
  const inference = resolveManagedStartupInferenceRoute(
    agent,
    selected.provider,
    selected.model,
    selected.preferredInferenceApi,
  );
  const projection = EXPORT_AGENT_PROFILE_PROJECTIONS[agent](inference);
  return buildManagedStartupProfile({
    agent,
    inference: {
      routeProvider: inference.providerKey,
      upstreamProvider: selected.provider,
      model: selected.model,
      routedBaseUrl: inference.inferenceBaseUrl,
      upstreamEndpointUrl: null,
      api: selected.preferredInferenceApi,
      primaryModelRef: projection.primaryModelRef,
      compatibility: projection.compatibility,
    },
    dashboard: projection.dashboard,
    webSearch: hasBraveSearch(entry) ? { fetchEnabled: true, provider: "brave" } : null,
    toolDisclosure: "progressive",
    hermesToolGateways: [],
    messagingPlan: null,
    dcodeAutoApprovalMode: null,
    observabilityEnabled: null,
    environment:
      entry.servingProfileProvenance?.preset.id === EXPORTED_VLLM_PROFILE_ID
        ? { NEMOCLAW_CONTEXT_WINDOW: String(EXPORTED_VLLM_CONTEXT_WINDOW) }
        : {},
    corporateCa: null,
  }).profile;
}

function projectAgentSettings(profile: ManagedStartupProfile, defaults: ManagedStartupProfile) {
  if (profile.agentConfig.agent !== "openclaw" || defaults.agentConfig.agent !== "openclaw") {
    return {};
  }
  const overrides = Object.fromEntries(
    Object.entries(profile.tuning).filter(
      ([key, value]) => value !== defaults.tuning[key as keyof typeof defaults.tuning],
    ),
  );
  const execution = {
    ...(profile.agentConfig.agentTimeoutSeconds === defaults.agentConfig.agentTimeoutSeconds
      ? {}
      : { timeoutSeconds: profile.agentConfig.agentTimeoutSeconds }),
    ...(profile.agentConfig.heartbeatEvery === defaults.agentConfig.heartbeatEvery
      ? {}
      : { heartbeatEvery: profile.agentConfig.heartbeatEvery }),
  };
  return {
    ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
    ...(Object.keys(execution).length === 0 ? {} : { execution }),
  };
}

function classifyReasoningAgreement(
  entry: ObservedExportRegistry,
  profile: ManagedStartupProfile,
): ExportFinding[] {
  if (entry.agent !== "openclaw" || profile.agentConfig.agent !== "openclaw") return [];
  const reasoning = entry.compatibleEndpointReasoning;
  const effort = entry.compatibleEndpointReasoningEffort;
  const hasOverrides = [reasoning, effort].some((value) => value !== undefined && value !== null);
  if (entry.provider !== "compatible-endpoint" && !hasOverrides) return [];
  if (
    entry.provider === "compatible-endpoint" &&
    isDeepStrictEqual(
      [reasoning ?? "false", effort ?? "default"],
      [String(profile.tuning.reasoning), profile.tuning.reasoningEffort],
    )
  )
    return [];
  return [
    finding(
      "spec.sandboxes[].agents[0].inference.routes[].overrides",
      "drifted",
      "Registered reasoning overrides and the managed startup profile differ.",
    ),
  ];
}

function supportedAgentSettingsProfile(
  profile: ManagedStartupProfile,
  expected: ManagedStartupProfile,
): ManagedStartupProfile | null {
  if (profile.agentConfig.agent === "hermes" && expected.agentConfig.agent === "hermes") {
    return expected;
  }
  const settings = projectAgentSettings(profile, expected);
  if (
    !Check(NemoClawInferenceTuningSchema, profile.tuning) ||
    (settings.execution !== undefined &&
      !Check(NemoClawAgentExecutionSchema, settings.execution)) ||
    profile.agentConfig.agent !== "openclaw" ||
    expected.agentConfig.agent !== "openclaw"
  )
    return null;
  return {
    ...expected,
    tuning: {
      contextWindow: profile.tuning.contextWindow,
      maxTokens: profile.tuning.maxTokens,
      reasoning: profile.tuning.reasoning,
      reasoningEffort: profile.tuning.reasoningEffort,
    },
    agentConfig: {
      ...expected.agentConfig,
      agentTimeoutSeconds: profile.agentConfig.agentTimeoutSeconds,
      heartbeatEvery: profile.agentConfig.heartbeatEvery,
    },
  };
}

function classifyManagedStartupProfile(
  entry: ObservedExportRegistry,
  profile: ManagedStartupProfile,
): ExportFinding[] {
  let expected: ManagedStartupProfile;
  try {
    expected = expectedManagedStartupProfile(entry);
    expected = {
      ...expected,
      proxy: {
        ...expected.proxy,
        managedHost: profile.proxy.managedHost,
        managedPort: profile.proxy.managedPort,
      },
    };
  } catch {
    return [
      finding(
        "source.workload.startupProfile",
        "missing-provenance",
        "The managed startup profile cannot be matched to the registered inference selection.",
      ),
    ];
  }
  const findings = classifyReasoningAgreement(entry, profile);
  if (entry.servingProfileProvenance?.preset.id !== EXPORTED_VLLM_PROFILE_ID) {
    const supported = supportedAgentSettingsProfile(profile, expected);
    if (!supported) {
      return [
        ...findings,
        finding(
          "source.workload.startupProfile",
          "unsupported",
          "The managed agent settings cannot be represented by v1 export.",
        ),
      ];
    }
    expected = supported;
  }
  if (!hasEqualJsonStructure(profile.inference, expected.inference)) {
    findings.push(
      finding(
        "spec.inferenceProviders",
        "drifted",
        "The managed startup profile and the registered inference selection differ.",
      ),
    );
  }
  if (!hasEqualJsonStructure({ ...profile, inference: expected.inference }, expected)) {
    findings.push(
      finding(
        "source.workload.startupProfile",
        "unsupported",
        "The managed startup profile is not the canonical profile supported by v1 export.",
      ),
    );
  }
  return findings;
}

function endpointEvidenceMatchesRoute(inference: QualifiedExportSnapshot["inference"]): boolean {
  const evidence = inference.endpointEvidence;
  if (!evidence) return false;
  if (evidence.source.kind === "builtin-profile") {
    return (
      inference.credentialEnv !== null &&
      isDeepStrictEqual(
        [evidence.source.profileId, inference.provider, inference.api, evidence.endpoint],
        ["nvidia", "nvidia-prod", "openai-completions", BUILD_ENDPOINT_URL],
      )
    );
  }
  let expectedConfigKey: string | null = null;
  if (inference.api === "anthropic-messages") expectedConfigKey = "ANTHROPIC_BASE_URL";
  else if (["openai-completions", "openai-responses"].includes(inference.api))
    expectedConfigKey = "OPENAI_BASE_URL";
  return (
    evidence.source.kind === "provider-config" &&
    expectedConfigKey !== null &&
    evidence.source.key === expectedConfigKey
  );
}

function validateSandboxIdentity(
  requestedSandboxName: string,
  snapshot: QualifiedExportSnapshot,
): ExportFinding[] {
  const { registry: entry, sandbox } = snapshot;
  const findings: ExportFinding[] = [];
  if (snapshot.sandboxName !== requestedSandboxName || entry.name !== requestedSandboxName) {
    findings.push(
      finding(
        "source.sandbox.name",
        "live-verification-failed",
        "The observed source identity does not match the requested sandbox.",
      ),
    );
  }
  if (
    !isValidNemoClawSandboxName(requestedSandboxName) ||
    !isValidNemoClawSandboxName(snapshot.sandboxName) ||
    !isValidNemoClawSandboxName(entry.name)
  ) {
    findings.push(
      finding(
        "spec.sandboxes[].name",
        "unsupported",
        "The sandbox name cannot be represented by v1.",
      ),
    );
  }
  const expectedFingerprint = fingerprintOpenShellSandboxId(sandbox.sandboxId);
  if (!expectedFingerprint || expectedFingerprint !== sandbox.fingerprint)
    findings.push(
      finding(
        "source.sandbox.identity",
        "live-verification-failed",
        "Live sandbox identity could not be verified.",
      ),
    );
  if (
    entry.lifecycleLiveIdentityFingerprint &&
    entry.lifecycleLiveIdentityFingerprint !== sandbox.fingerprint
  )
    findings.push(
      finding(
        "source.lifecycle.fingerprint",
        "drifted",
        "Registry and live sandbox identities differ.",
      ),
    );
  return findings;
}

function validateSandboxConfiguration(snapshot: QualifiedExportSnapshot): ExportFinding[] {
  const { registry: entry, sandbox, inference } = snapshot;
  const findings: ExportFinding[] = [];
  if (sandbox.workspace !== "default")
    findings.push(
      finding(
        "source.sandbox.workspace",
        "unsupported",
        "V1 export requires the default workspace.",
      ),
    );
  if (entry.workload?.kind === "managed-image" && sandbox.imageRef !== entry.workload.reference)
    findings.push(
      finding(
        "spec.sandboxes[].runtime.image",
        "drifted",
        "Registry and live sandbox images differ.",
      ),
    );
  const additionalProviders = sandbox.providerNames.filter((name) => name !== inference.provider);
  const expectedAdditionalProviders = hasBraveSearch(entry) ? [`${entry.name}-brave-search`] : [];
  if (
    !isDeepStrictEqual(additionalProviders, expectedAdditionalProviders) ||
    new Set(sandbox.providerNames).size !== sandbox.providerNames.length
  )
    findings.push(
      finding(
        "source.sandbox.providers",
        "unsupported",
        "The sandbox provider attachments do not match its supported configuration.",
      ),
    );
  return findings;
}

function validBraveProfile(
  provider: NonNullable<QualifiedExportSnapshot["webSearchProvider"]>,
): boolean {
  const { profile, profileWorkspace } = provider;
  if (!profile || profile.id !== "brave" || !isValidNemoClawBoundedText(profile.resourceVersion))
    return false;
  if (profile.source === "builtin") {
    return isDeepStrictEqual(
      [profileWorkspace, profile.scope, profile.resourceVersion],
      ["", "", "0"],
    );
  }
  return (
    profile.source === "user" &&
    /^[1-9][0-9]*$/u.test(profile.resourceVersion) &&
    (isDeepStrictEqual([profileWorkspace, profile.scope], ["", "platform"]) ||
      isDeepStrictEqual([profileWorkspace, profile.scope], [provider.workspace, "workspace"]))
  );
}

function validateWebSearchProvider(snapshot: QualifiedExportSnapshot): ExportFinding[] {
  const { registry, webSearchProvider: provider, sandbox, gateway } = snapshot;
  if (!hasBraveSearch(registry)) {
    return provider === undefined
      ? []
      : [finding("source.webSearch", "ambiguous", "Unexpected web-search provider evidence.")];
  }
  if (!provider) {
    return [
      finding(
        "source.webSearch",
        "missing-provenance",
        "Live Brave provider evidence is required.",
      ),
    ];
  }
  if (
    !validBraveProfile(provider) ||
    !isValidNemoClawBoundedText(provider.id) ||
    !isValidNemoClawBoundedText(provider.resourceVersion) ||
    !/^[1-9][0-9]*$/u.test(provider.resourceVersion) ||
    !isDeepStrictEqual(
      [
        provider.gatewayName,
        provider.workspace,
        provider.name,
        provider.type,
        provider.credentialKeys,
        provider.configKeys,
      ],
      [
        gateway.name,
        sandbox.workspace,
        `${registry.name}-brave-search`,
        "brave",
        ["BRAVE_API_KEY"],
        [],
      ],
    )
  ) {
    return [
      finding(
        "source.webSearch",
        "drifted",
        "The live Brave provider does not match its managed binding.",
      ),
    ];
  }
  return [];
}

function validateGateway(snapshot: QualifiedExportSnapshot): ExportFinding[] {
  const { registry: entry, gateway } = snapshot;
  const findings: ExportFinding[] = [];
  if (gateway.management !== "nemoclaw" || !gateway.stateRootOwned)
    findings.push(
      finding(
        "spec.gateway.management",
        "drifted",
        "Gateway lifecycle or state-root ownership is not NemoClaw-managed.",
      ),
    );
  if (entry.gatewayName !== gateway.name || entry.gatewayPort !== gateway.port)
    findings.push(finding("spec.gateway", "drifted", "Registry and live gateway bindings differ."));
  if (!isValidNemoClawLocalResourceName(gateway.name) || !isValidNemoClawPort(gateway.port)) {
    findings.push(
      finding(
        "spec.gateway",
        "unsupported",
        "The gateway name or port cannot be represented by v1.",
      ),
    );
  }
  return findings;
}

function validateInferenceSelection(snapshot: QualifiedExportSnapshot): ExportFinding[] {
  const { registry: entry, inference } = snapshot;
  const findings: ExportFinding[] = [];
  if (inference.topology !== "hosted" && inference.topology !== "managed")
    findings.push(
      finding(
        "spec.inferenceProviders",
        "unsupported",
        "This local inference topology is not represented by v1 export.",
      ),
    );

  if (
    inference.topology !== "managed" &&
    (entry.servingProfileProvenance || inference.managedServing)
  )
    findings.push(
      finding(
        "spec.inferenceProviders[].serving",
        "unsupported",
        "Recorded managed serving requires complete live managed runtime evidence.",
      ),
    );
  const selected = normalizeInferenceSelection(entry);
  if (
    !isDeepStrictEqual(
      [
        selected.provider,
        selected.model,
        selected.preferredInferenceApi,
        selected.endpointUrl,
        selected.credentialEnv,
      ],
      [
        inference.provider,
        inference.model,
        inference.api,
        inference.endpoint,
        inference.credentialEnv,
      ],
    )
  )
    findings.push(
      finding(
        "spec.inferenceProviders",
        "drifted",
        "Registry and live inference route identities differ.",
      ),
    );
  return findings;
}

function validateInferenceRepresentation(snapshot: QualifiedExportSnapshot): ExportFinding[] {
  const { inference } = snapshot;
  if (inference.topology === "managed") return validateManagedServing(snapshot);
  const findings: ExportFinding[] = [];
  if (
    [inference.provider, inference.model, inference.api, inference.endpoint].some((value) => !value)
  )
    findings.push(
      finding(
        "spec.inferenceProviders",
        "missing-provenance",
        "Hosted provider, model, API, and endpoint provenance are required.",
      ),
    );
  if (
    [inference.provider, inference.model].some(
      (value) => value && !isValidNemoClawBoundedText(value),
    ) ||
    (inference.api && !isSupportedInferenceApi(inference.api))
  )
    findings.push(
      finding(
        "spec.inferenceProviders",
        "unsupported",
        "The inference provider, model, or API cannot be represented by v1.",
      ),
    );
  if (inference.endpoint && !isValidNemoClawInferenceEndpoint(inference.endpoint))
    findings.push(
      finding(
        "spec.inferenceProviders[].endpoint",
        "unsupported",
        "The inference endpoint is not safe for export.",
      ),
    );
  return findings;
}

function validateEndpointEvidence(snapshot: QualifiedExportSnapshot): ExportFinding[] {
  const { inference, sandbox, gateway } = snapshot;
  const evidence = inference.endpointEvidence;
  if (!evidence) {
    return [
      finding(
        "source.inference.endpoint",
        "missing-provenance",
        "Independent live inference endpoint evidence is required.",
      ),
    ];
  }
  const findings: ExportFinding[] = [];

  if (inference.topology !== "managed" && !isValidNemoClawInferenceEndpoint(evidence.endpoint))
    findings.push(
      finding(
        "source.inference.endpoint",
        "unsupported",
        "The live inference endpoint evidence is invalid or unsafe.",
      ),
    );
  if (evidence.endpoint !== inference.endpoint)
    findings.push(
      finding(
        "spec.inferenceProviders[].endpoint",
        "drifted",
        "Registry and live inference endpoints differ.",
      ),
    );
  if (
    !evidence.provider.id ||
    !evidence.provider.resourceVersion ||
    !endpointEvidenceMatchesRoute(inference) ||
    !isDeepStrictEqual(
      [evidence.provider.workspace, evidence.provider.gatewayName, evidence.provider.name],
      [sandbox.workspace, gateway.name, inference.provider],
    )
  )
    findings.push(
      finding(
        "source.inference.endpoint",
        "drifted",
        "The live endpoint evidence is not bound to the observed provider route.",
      ),
    );
  return findings;
}

function validateCredentialReference(snapshot: QualifiedExportSnapshot): ExportFinding[] {
  const { inference } = snapshot;
  if (inference.topology === "managed") return [];
  const findings: ExportFinding[] = [];
  if (
    inference.credentialEnv !== null &&
    !isCredentialEnvironmentReferenceName(inference.credentialEnv)
  )
    findings.push(
      finding(
        "spec.inferenceProviders[].credential.env",
        "unsupported",
        "The credential environment identifier is invalid or reserved for internal use.",
      ),
    );
  return findings;
}

function validatePolicyIdentity(snapshot: QualifiedExportSnapshot): ExportFinding[] {
  const { configuration, sandbox, policy } = snapshot;
  const findings: ExportFinding[] = [];
  if (
    configuration.sandboxId !== sandbox.sandboxId ||
    configuration.workspace !== sandbox.workspace ||
    configuration.revision !== sandbox.policyVersion
  ) {
    findings.push(
      finding(
        "source.sandbox.configuration",
        "drifted",
        "Configuration is not bound to the observed sandbox and applied revision.",
      ),
    );
  }
  if (policy.sandboxId !== sandbox.sandboxId)
    findings.push(
      finding(
        "spec.sandboxes[].network.policy",
        "drifted",
        "Effective policy is not bound to the verified live sandbox identity.",
      ),
    );
  if (String(sandbox.policyVersion) !== policy.revision)
    findings.push(
      finding(
        "spec.sandboxes[].network.policy",
        "drifted",
        "The effective policy revision does not match the live sandbox.",
      ),
    );
  return findings;
}

function validateAgreement(
  requestedSandboxName: string,
  snapshot: QualifiedExportSnapshot,
): ExportFinding[] {
  return [
    ...classifyExportRegistry(snapshot.registry),
    ...validateSandboxIdentity(requestedSandboxName, snapshot),
    ...validateSandboxConfiguration(snapshot),
    ...validateWebSearchProvider(snapshot),
    ...validateGateway(snapshot),
    ...validateInferenceSelection(snapshot),
    ...validateInferenceRepresentation(snapshot),
    ...validateEndpointEvidence(snapshot),
    ...validateCredentialReference(snapshot),
    ...validatePolicyIdentity(snapshot),
  ];
}

function inspectWorkload(entry: ObservedExportRegistry) {
  let authority: NonNullable<ReturnType<typeof readManagedWorkloadAuthority>> | null = null;
  const findings: ExportFinding[] = [];
  if (entry.workload?.kind === "managed-image") {
    try {
      authority = readManagedWorkloadAuthority(entry);
      if (authority) findings.push(...classifyManagedStartupProfile(entry, authority.profile));
    } catch {
      findings.push(
        finding(
          "source.workload",
          "missing-provenance",
          "The managed workload authority could not be verified.",
        ),
      );
    }
  }
  return { authority, findings };
}

function projectVerifiedInference(
  snapshot: QualifiedExportSnapshot,
  selected: ReturnType<typeof normalizeInferenceSelection>,
  settings: ReturnType<typeof projectAgentSettings>,
) {
  const common = {
    ...(settings.overrides ? { overrides: settings.overrides } : {}),
    provider: selected.provider,
    model: selected.model,
    api: selected.preferredInferenceApi,
  };
  return snapshot.inference.topology === "managed"
    ? { ...common, serving: snapshot.inference.managedServing?.serving }
    : {
        ...common,
        endpoint: selected.endpointUrl,
        ...(selected.credentialEnv === null ? {} : { credentialEnv: selected.credentialEnv }),
      };
}

function completeVerifiedSource(
  requestedSandboxName: string,
  snapshot: QualifiedExportSnapshot,
  authority: NonNullable<ReturnType<typeof readManagedWorkloadAuthority>> | null,
  policy: CanonicalExportPolicy,
): ExportSourceVerificationResult {
  const entry = snapshot.registry;
  const selected = normalizeInferenceSelection(entry);
  const settings =
    authority && snapshot.inference.topology !== "managed"
      ? projectAgentSettings(authority.profile, expectedManagedStartupProfile(entry))
      : {};
  const proxy = authority?.profile.proxy;
  const values = {
    sandboxName: requestedSandboxName,
    agent: entry.agent,
    ...(settings.execution ? { execution: settings.execution } : {}),
    ...(hasBraveSearch(entry)
      ? {
          webSearch: {
            provider: "brave",
            agentRefs: ["primary"],
            credential: { env: "BRAVE_API_KEY" },
          },
        }
      : {}),
    runtime: { provider: entry.openshellDriver, imageRef: authority?.receipt.reference },
    gateway: { name: snapshot.gateway.name, port: snapshot.gateway.port },
    ...(proxy && !hasEqualJsonStructure(proxy, expectedManagedStartupProfile(entry).proxy)
      ? { proxy: { host: proxy.managedHost, port: proxy.managedPort } }
      : {}),
    inference: projectVerifiedInference(snapshot, selected, settings),
  };
  if (!Check(ExportSourceValuesSchema, values)) {
    return {
      kind: "rejected",
      findings: [
        finding("source", "missing-provenance", "Required verified source fields are incomplete."),
      ],
    };
  }
  const source = verifiedExportSource({ ...values, policy });
  return {
    kind: "verified",
    source,
  };
}

export function verifyExportSource(
  requestedSandboxName: string,
  snapshot: QualifiedExportSnapshot,
): ExportSourceVerificationResult {
  const entry = snapshot.registry;
  const findings = validateAgreement(requestedSandboxName, snapshot);
  const { authority, findings: workloadFindings } = inspectWorkload(entry);
  findings.push(...workloadFindings);
  const policy = snapshot.policy.kind === "verified" ? snapshot.policy.canonical : undefined;
  if (snapshot.policy.kind === "not-representable") {
    findings.push(
      finding(
        "spec.sandboxes[].network.policy",
        "policy-not-representable",
        "Verified effective policy is malformed, unknown, or cannot be represented losslessly.",
      ),
    );
  }
  if (findings.length > 0 || !policy) return { kind: "rejected", findings: nonEmpty(findings) };

  return completeVerifiedSource(requestedSandboxName, snapshot, authority, policy);
}
