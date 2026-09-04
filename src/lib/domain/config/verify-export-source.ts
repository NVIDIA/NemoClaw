// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import { cloneAndDeepFreeze } from "../../core/immutable";
import { resolveManagedStartupInferenceRoute } from "../../inference/gateway/route-contract";
import { normalizeInferenceSelection } from "../../inference/selection";
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
  NEMOCLAW_INFERENCE_APIS,
  type InferenceApi,
} from "../../config/model";
import { fingerprintOpenShellSandboxId } from "../sandbox/openshell-identity";
import type {
  ExportFinding,
  ExportSourceFailureCategory,
  ExportSourceVerificationResult,
  NonEmptyExportFindings,
  ObservedExportEndpointEvidence,
  ObservedExportRegistry,
  QualifiedExportSnapshot,
  VerifiedExportSource,
} from "./export-evidence";

function isSupportedInferenceApi(value: string): value is InferenceApi {
  return (NEMOCLAW_INFERENCE_APIS as readonly string[]).includes(value);
}
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

/** Report every v1-excluded capability represented by the registry row. */
export function classifyExportRegistry(entry: ObservedExportRegistry): ExportFinding[] {
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
  if (!entry.workload)
    findings.push(
      finding(
        "spec.sandboxes[].runtime.image",
        "missing-provenance",
        "A managed immutable workload receipt is required.",
      ),
    );
  else if (entry.workload.kind !== "managed-image")
    findings.push(
      finding(
        "spec.sandboxes[].runtime.image",
        "unsupported",
        "V1 export requires a managed immutable release image.",
      ),
    );
  else {
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
  }
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

function endpointConfigKey(api: string): ObservedExportEndpointEvidence["configKey"] | null {
  if (api === "anthropic-messages") return "ANTHROPIC_BASE_URL";
  if (api === "openai-completions" || api === "openai-responses") return "OPENAI_BASE_URL";
  return null;
}

function validateAgreement(
  requestedSandboxName: string,
  snapshot: QualifiedExportSnapshot,
): ExportFinding[] {
  const { registry: entry, sandbox, gateway, inference, policy } = snapshot;
  const findings = classifyExportRegistry(entry);
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
  if (!inference.provider || !inference.model || !inference.api || !inference.endpoint)
    findings.push(
      finding(
        "spec.inferenceProviders",
        "missing-provenance",
        "Hosted provider, model, API, and endpoint provenance are required.",
      ),
    );
  if (
    (inference.provider && !isValidNemoClawBoundedText(inference.provider)) ||
    (inference.model && !isValidNemoClawBoundedText(inference.model)) ||
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
  if (!inference.endpointEvidence)
    findings.push(
      finding(
        "source.inference.endpoint",
        "missing-provenance",
        "Independent live inference endpoint evidence is required.",
      ),
    );
  else {
    const expectedConfigKey = endpointConfigKey(inference.api);
    if (!isValidNemoClawInferenceEndpoint(inference.endpointEvidence.endpoint))
      findings.push(
        finding(
          "source.inference.endpoint",
          "unsupported",
          "The live inference endpoint evidence is invalid or unsafe.",
        ),
      );
    if (inference.endpointEvidence.endpoint !== inference.endpoint)
      findings.push(
        finding(
          "spec.inferenceProviders[].endpoint",
          "drifted",
          "Registry and live inference endpoints differ.",
        ),
      );
    if (
      inference.endpointEvidence.gatewayName !== gateway.name ||
      inference.endpointEvidence.providerName !== inference.provider ||
      expectedConfigKey === null ||
      inference.endpointEvidence.configKey !== expectedConfigKey
    )
      findings.push(
        finding(
          "source.inference.endpoint",
          "drifted",
          "The live endpoint evidence is not bound to the observed provider route.",
        ),
      );
  }
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

export function verifyExportSource(
  requestedSandboxName: string,
  snapshot: QualifiedExportSnapshot,
): ExportSourceVerificationResult {
  const entry = snapshot.registry;
  let authority: NonNullable<ReturnType<typeof readManagedWorkloadAuthority>> | null = null;
  let findings = validateAgreement(requestedSandboxName, snapshot);
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
  const policy = snapshot.policy.kind === "verified" ? snapshot.policy.canonical : undefined;
  if (snapshot.policy.kind === "not-representable") {
    findings = [
      ...findings,
      finding(
        "spec.sandboxes[].network.policy",
        "policy-not-representable",
        "Verified effective policy is malformed, unknown, or cannot be represented losslessly.",
      ),
    ];
  }
  if (findings.length > 0 || !policy) return { kind: "rejected", findings: nonEmpty(findings) };

  const selected = normalizeInferenceSelection(entry);
  if (
    !isValidNemoClawRuntimeProvider(entry.openshellDriver) ||
    !authority ||
    !isImmutableImageReference(authority.receipt.reference) ||
    !isValidNemoClawSandboxName(requestedSandboxName) ||
    !isValidNemoClawLocalResourceName(snapshot.gateway.name) ||
    !isValidNemoClawPort(snapshot.gateway.port) ||
    !selected.provider ||
    !isValidNemoClawBoundedText(selected.provider) ||
    !selected.model ||
    !isValidNemoClawBoundedText(selected.model) ||
    !selected.endpointUrl ||
    !isValidNemoClawInferenceEndpoint(selected.endpointUrl) ||
    !selected.preferredInferenceApi ||
    !isSupportedInferenceApi(selected.preferredInferenceApi)
  ) {
    return {
      kind: "rejected",
      findings: [
        finding("source", "missing-provenance", "Required verified source fields are incomplete."),
      ],
    };
  }
  const source = verifiedExportSource({
    sandboxName: requestedSandboxName,
    runtime: {
      provider: entry.openshellDriver,
      imageRef: authority.receipt.reference,
    },
    gateway: { name: snapshot.gateway.name, port: snapshot.gateway.port },
    inference: {
      provider: selected.provider,
      model: selected.model,
      api: selected.preferredInferenceApi,
      endpoint: selected.endpointUrl,
      ...(selected.credentialEnv === null ? {} : { credentialEnv: selected.credentialEnv }),
    },
    policy,
  } satisfies VerifiedExportSourceData);
  return {
    kind: "verified",
    source,
  };
}
