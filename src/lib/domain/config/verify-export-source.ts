// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type * as TypeBoxValueModule from "typebox/value" with { "resolution-mode": "import" };
import { isDeepStrictEqual } from "node:util";
import { cloneAndDeepFreeze } from "../../core/immutable";
import { resolveManagedStartupInferenceRoute } from "../../inference/gateway/route-contract";
import { normalizeInferenceSelection } from "../../inference/selection";
import { BUILD_ENDPOINT_URL } from "../../inference/provider-models";
import type { ManagedStartupProfile } from "../../onboard/managed-startup/profile";
import { buildManagedStartupProfile } from "../../onboard/managed-startup/profile-builder";
import { readManagedWorkloadAuthority } from "../../onboard/workload/authority";
import { sortCanonicalMappings } from "../../config/canonical-mapping";
import {
  isCredentialEnvironmentReferenceName,
  isImmutableImageReference,
  isValidNemoClawBoundedText,
  isValidNemoClawInferenceEndpoint,
  isValidNemoClawLocalResourceName,
  isValidNemoClawPort,
  isValidNemoClawRuntimeProvider,
  isValidNemoClawSandboxName,
  isSupportedInferenceApi,
} from "../../config/model";
import { fingerprintOpenShellSandboxId } from "../sandbox/openshell-identity";
import { ExportSourceValuesSchema } from "./export-evidence";
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

type VerifiedExportSourceData = Pick<
  VerifiedExportSource,
  "gateway" | "inference" | "policy" | "runtime" | "sandboxName"
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
      entry.webSearchEnabled || entry.webSearchProvider,
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
    [
      "spec.inferenceProviders[].reasoning",
      entry.compatibleEndpointReasoning || entry.compatibleEndpointReasoningEffort,
      "compatible-endpoint reasoning overrides",
    ],
  ];
  const findings = excluded
    .filter(([, value]) => hasEntries(value))
    .map(([field, , capability]) =>
      finding(field, "unsupported", "V1 export does not support " + capability + "."),
    );
  return findings;
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
  if (entry.agent !== "openclaw")
    findings.push(
      finding("spec.sandboxes[].agents[0].type", "unsupported", "V1 export requires OpenClaw."),
    );
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
        "V1 export supports hosted external inference only.",
      ),
    );
  return findings;
}

function expectedManagedStartupProfile(entry: ObservedExportRegistry): ManagedStartupProfile {
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
    "openclaw",
    selected.provider,
    selected.model,
    selected.preferredInferenceApi,
  );
  return buildManagedStartupProfile({
    agent: "openclaw",
    inference: {
      routeProvider: inference.providerKey,
      upstreamProvider: selected.provider,
      model: selected.model,
      routedBaseUrl: inference.inferenceBaseUrl,
      upstreamEndpointUrl: null,
      api: selected.preferredInferenceApi,
      primaryModelRef: inference.primaryModelRef,
      compatibility: inference.inferenceCompat ?? {},
    },
    dashboard: {
      agent: "openclaw",
      mode: "loopback",
      url: "http://127.0.0.1:18789",
      port: 18_789,
      bindAddress: "127.0.0.1",
      wslExposure: false,
    },
    webSearch: null,
    toolDisclosure: "progressive",
    hermesToolGateways: [],
    messagingPlan: null,
    dcodeAutoApprovalMode: null,
    observabilityEnabled: null,
    environment: {},
    corporateCa: null,
  }).profile;
}

function classifyManagedStartupProfile(
  entry: ObservedExportRegistry,
  profile: ManagedStartupProfile,
): ExportFinding[] {
  let expected: ManagedStartupProfile;
  try {
    expected = expectedManagedStartupProfile(entry);
  } catch {
    return [
      finding(
        "source.workload.startupProfile",
        "missing-provenance",
        "The managed startup profile cannot be matched to the registered inference selection.",
      ),
    ];
  }
  const findings: ExportFinding[] = [];
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
  if (sandbox.providerNames.some((name) => name !== inference.provider))
    findings.push(
      finding(
        "source.sandbox.providers",
        "unsupported",
        "V1 export does not support additional provider attachments.",
      ),
    );
  return findings;
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
  if (inference.topology !== "hosted")
    findings.push(
      finding(
        "spec.inferenceProviders",
        "unsupported",
        "V1 export supports hosted external inference only.",
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

  if (!isValidNemoClawInferenceEndpoint(evidence.endpoint))
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

function completeVerifiedSource(
  requestedSandboxName: string,
  snapshot: QualifiedExportSnapshot,
  authority: NonNullable<ReturnType<typeof readManagedWorkloadAuthority>> | null,
  policy: CanonicalExportPolicy,
): ExportSourceVerificationResult {
  const entry = snapshot.registry;
  const selected = normalizeInferenceSelection(entry);
  const values = {
    sandboxName: requestedSandboxName,
    runtime: { provider: entry.openshellDriver, imageRef: authority?.receipt.reference },
    gateway: { name: snapshot.gateway.name, port: snapshot.gateway.port },
    inference: {
      provider: selected.provider,
      model: selected.model,
      api: selected.preferredInferenceApi,
      endpoint: selected.endpointUrl,
      ...(selected.credentialEnv === null ? {} : { credentialEnv: selected.credentialEnv }),
    },
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
