// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { fingerprintOpenShellSandboxId } from "../adapters/openshell/sandbox-identity";
import { parseAndValidateSandboxPolicy } from "../policy/sandbox-policy-validation";
import { sortCanonicalMappings } from "./canonical-mapping";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../state/registry/types";
import { isCredentialEnvironmentReferenceName } from "./schema";

export type ExportFidelity =
  | "exact"
  | "derived"
  | "missing"
  | "ambiguous"
  | "unsupported"
  | "drifted";
export type ExportFailureCategory =
  | "not-found"
  | "unsupported"
  | "missing-provenance"
  | "ambiguous"
  | "drifted"
  | "unstable-source"
  | "live-verification-failed"
  | "policy-not-representable"
  | "unsafe-output"
  | "output-conflict";
export interface ExportFidelityFinding {
  readonly field: string;
  readonly fidelity: ExportFidelity;
  readonly category: ExportFailureCategory;
  readonly diagnostic: string;
}
export interface ObservedExportGateway {
  readonly name: string;
  readonly port: number;
  readonly management: "nemoclaw" | "external" | "unknown";
  readonly stateRootOwned: boolean;
  readonly identity: string;
}
export interface ObservedExportInference {
  readonly topology: "hosted" | "managed" | "local" | "unknown";
  readonly provider: string;
  readonly model: string;
  readonly api: string;
  readonly endpoint: string;
  readonly credentialEnv: string | null;
  readonly identity: string;
}
export interface ObservedExportPolicy {
  readonly sandboxId: string;
  readonly revision: string;
  readonly document: string;
}
export interface ObservedExportSandboxIdentity {
  readonly sandboxId: string;
  readonly fingerprint: string;
  readonly lifecycleGeneration: string;
  readonly identity: string;
}
/** Source-only evidence; deliberately independent from the final configuration model. */
export interface ObservedExportSource {
  readonly sandboxName: string;
  readonly registry: Readonly<SandboxEntry>;
  readonly sandbox: ObservedExportSandboxIdentity;
  readonly gateway: ObservedExportGateway;
  readonly workload: Readonly<SandboxWorkloadReceipt>;
  readonly inference: ObservedExportInference;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly policyBasis: "verified-effective-state";
}
export type ExportObservation = ObservedExportSource;
export type ExportObservationResult =
  | { readonly ok: true; readonly source: ObservedExportSource; readonly attempts: 1 | 2 }
  | {
      readonly ok: false;
      readonly category: ExportFailureCategory;
      readonly findings: readonly ExportFidelityFinding[];
      readonly attempts: 1 | 2;
    };
export interface ExportObservationDependencies {
  sourceTokenFor(
    entry: Readonly<SandboxEntry>,
    sandbox: ObservedExportSandboxIdentity,
    gateway: ObservedExportGateway,
    inference: ObservedExportInference,
    policy: ObservedExportPolicy,
  ): string;
  readSourceToken(sandboxName: string): Promise<string>;
  readRegistryEntry(sandboxName: string): Promise<Readonly<SandboxEntry> | null>;
  readSandboxIdentity(sandboxName: string): Promise<ObservedExportSandboxIdentity>;
  readGateway(entry: Readonly<SandboxEntry>): Promise<ObservedExportGateway>;
  readInference(entry: Readonly<SandboxEntry>): Promise<ObservedExportInference>;
  readEffectivePolicy(
    sandboxName: string,
    gateway: ObservedExportGateway,
  ): Promise<ObservedExportPolicy>;
}

function finding(
  field: string,
  fidelity: ExportFidelity,
  category: ExportFailureCategory,
  diagnostic: string,
): ExportFidelityFinding {
  return { field, fidelity, category, diagnostic };
}
function hasEntries(value: unknown): boolean {
  return Array.isArray(value)
    ? value.length > 0
    : value !== undefined && value !== null && value !== false;
}

/** Report every v1-excluded capability represented by the registry row. */
export function classifyExportRegistryFidelity(
  entry: Readonly<SandboxEntry>,
): ExportFidelityFinding[] {
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
  ];
  const findings = excluded
    .filter(([, value]) => hasEntries(value))
    .map(([field, , capability]) =>
      finding(
        field,
        "unsupported",
        "unsupported",
        "V1 export does not support " + capability + ".",
      ),
    );
  if (entry.agent !== "openclaw")
    findings.push(
      finding(
        "spec.sandboxes[].agents[0].type",
        "unsupported",
        "unsupported",
        "V1 export requires OpenClaw.",
      ),
    );
  if (entry.pendingRouteReservation === true)
    findings.push(
      finding(
        "source.registry",
        "ambiguous",
        "ambiguous",
        "The registry row is a pending route reservation, not a published sandbox.",
      ),
    );
  if (!entry.lifecycleGeneration || !entry.lifecycleLiveIdentityFingerprint)
    findings.push(
      finding(
        "source.lifecycle",
        "missing",
        "missing-provenance",
        "Lifecycle generation and live identity provenance are required.",
      ),
    );
  if (typeof entry.gatewayPort !== "number" || !entry.gatewayName)
    findings.push(
      finding(
        "spec.gateway",
        "missing",
        "missing-provenance",
        "A persisted gateway name and port are required.",
      ),
    );
  if (!entry.openshellDriver)
    findings.push(
      finding(
        "spec.sandboxes[].runtime.provider",
        "missing",
        "missing-provenance",
        "The persisted OpenShell runtime driver is required.",
      ),
    );
  if (!entry.workload)
    findings.push(
      finding(
        "spec.sandboxes[].runtime.image",
        "missing",
        "missing-provenance",
        "A managed immutable workload receipt is required.",
      ),
    );
  else if (entry.workload.kind !== "managed-image")
    findings.push(
      finding(
        "spec.sandboxes[].runtime.image",
        "unsupported",
        "unsupported",
        "V1 export requires a managed immutable release image.",
      ),
    );
  else if (!entry.workload.reference.includes("@sha256:"))
    findings.push(
      finding(
        "spec.sandboxes[].runtime.image",
        "ambiguous",
        "ambiguous",
        "The managed workload reference is not pinned to an immutable digest.",
      ),
    );
  if (entry.hostLocalInferenceReceipt || entry.hostLocalInferenceProvenance || entry.nimContainer)
    findings.push(
      finding(
        "spec.inferenceProviders",
        "unsupported",
        "unsupported",
        "V1 export supports hosted external inference only.",
      ),
    );
  return findings;
}
/** Parse, schema-check, and prove canonical YAML round-trip without dropping semantics. */
export function canonicalizeEffectivePolicy(document: string): Readonly<Record<string, unknown>> {
  const parsed = parseAndValidateSandboxPolicy(document);
  const canonical = YAML.stringify(sortCanonicalMappings(parsed), {
    lineWidth: 0,
    sortMapEntries: true,
  });
  const reparsed = parseAndValidateSandboxPolicy(canonical);
  if (!isDeepStrictEqual(parsed, reparsed))
    throw new Error("Effective policy cannot be represented losslessly.");
  return sortCanonicalMappings(reparsed) as Readonly<Record<string, unknown>>;
}
function validateAgreement(
  entry: Readonly<SandboxEntry>,
  sandbox: ObservedExportSandboxIdentity,
  gateway: ObservedExportGateway,
  inference: ObservedExportInference,
  policy: ObservedExportPolicy,
): ExportFidelityFinding[] {
  const findings = classifyExportRegistryFidelity(entry);
  const expectedFingerprint = fingerprintOpenShellSandboxId(sandbox.sandboxId);
  if (!expectedFingerprint || expectedFingerprint !== sandbox.fingerprint)
    findings.push(
      finding(
        "source.sandbox.identity",
        "drifted",
        "live-verification-failed",
        "Live sandbox identity could not be verified.",
      ),
    );
  if (entry.lifecycleGeneration && entry.lifecycleGeneration !== sandbox.lifecycleGeneration)
    findings.push(
      finding(
        "source.lifecycle.generation",
        "drifted",
        "drifted",
        "Registry and live lifecycle generations differ.",
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
        "drifted",
        "Registry and live sandbox identities differ.",
      ),
    );
  if (gateway.management !== "nemoclaw" || !gateway.stateRootOwned)
    findings.push(
      finding(
        "spec.gateway.management",
        "drifted",
        "drifted",
        "Gateway lifecycle or state-root ownership is not NemoClaw-managed.",
      ),
    );
  if (entry.gatewayName !== gateway.name || entry.gatewayPort !== gateway.port)
    findings.push(
      finding("spec.gateway", "drifted", "drifted", "Registry and live gateway bindings differ."),
    );
  if (inference.topology !== "hosted")
    findings.push(
      finding(
        "spec.inferenceProviders",
        "unsupported",
        "unsupported",
        "V1 export supports hosted external inference only.",
      ),
    );
  if (
    !isDeepStrictEqual(
      [
        entry.provider,
        entry.model,
        entry.preferredInferenceApi,
        entry.endpointUrl,
        entry.credentialEnv,
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
        "drifted",
        "Registry and live inference route identities differ.",
      ),
    );
  if (!inference.provider || !inference.model || !inference.api || !inference.endpoint)
    findings.push(
      finding(
        "spec.inferenceProviders",
        "missing",
        "missing-provenance",
        "Hosted provider, model, API, and endpoint provenance are required.",
      ),
    );
  if (
    inference.credentialEnv !== null &&
    !isCredentialEnvironmentReferenceName(inference.credentialEnv)
  )
    findings.push(
      finding(
        "spec.inferenceProviders[].credential.env",
        "unsupported",
        "unsupported",
        "The credential environment identifier is invalid or reserved for internal use.",
      ),
    );
  if (policy.sandboxId !== sandbox.sandboxId)
    findings.push(
      finding(
        "spec.sandboxes[].network.policy",
        "drifted",
        "drifted",
        "Effective policy is not bound to the verified live sandbox identity.",
      ),
    );
  return findings;
}
async function observeAttempt(
  sandboxName: string,
  deps: ExportObservationDependencies,
): Promise<{ stable: boolean; source?: ObservedExportSource; findings: ExportFidelityFinding[] }> {
  const entry = await deps.readRegistryEntry(sandboxName);
  if (!entry) {
    return {
      stable: true,
      findings: [
        finding("source.registry", "missing", "not-found", "The source sandbox is not registered."),
      ],
    };
  }
  const sandbox = await deps.readSandboxIdentity(sandboxName);
  const gateway = await deps.readGateway(entry);
  const inference = await deps.readInference(entry);
  const policyObservation = await deps.readEffectivePolicy(sandboxName, gateway);
  let policy: Readonly<Record<string, unknown>> | undefined;
  let findings = validateAgreement(entry, sandbox, gateway, inference, policyObservation);
  try {
    policy = canonicalizeEffectivePolicy(policyObservation.document);
  } catch {
    findings = [
      ...findings,
      finding(
        "spec.sandboxes[].network.policy",
        "unsupported",
        "policy-not-representable",
        "Verified effective policy is malformed, unknown, or cannot be represented losslessly.",
      ),
    ];
  }
  const observedToken = deps.sourceTokenFor(entry, sandbox, gateway, inference, policyObservation);
  const confirmationToken = await deps.readSourceToken(sandboxName);
  if (observedToken !== confirmationToken) return { stable: false, findings: [] };
  if (findings.length > 0 || !policy) return { stable: true, findings };
  return {
    stable: true,
    findings: [],
    source: {
      sandboxName,
      registry: entry,
      sandbox,
      gateway,
      workload: entry.workload!,
      inference,
      policy,
      policyBasis: "verified-effective-state",
    },
  };
}

/** Complete read-only observation with one whole-attempt retry on source-token change. */
export async function observeStableExportSource(
  sandboxName: string,
  deps: ExportObservationDependencies,
): Promise<ExportObservationResult> {
  for (const attempts of [1, 2] as const) {
    try {
      const observed = await observeAttempt(sandboxName, deps);
      if (!observed.stable) {
        if (attempts === 1) continue;
        return {
          ok: false,
          category: "unstable-source",
          findings: [
            finding(
              "source",
              "drifted",
              "unstable-source",
              "Source state changed during both complete observation attempts.",
            ),
          ],
          attempts,
        };
      }
      if (observed.source) return { ok: true, source: observed.source, attempts };
      return {
        ok: false,
        category: observed.findings[0]?.category ?? "ambiguous",
        findings: observed.findings,
        attempts,
      };
    } catch {
      return {
        ok: false,
        category: "live-verification-failed",
        findings: [
          finding(
            "source.live",
            "missing",
            "live-verification-failed",
            "Required live source state could not be read or verified.",
          ),
        ],
        attempts,
      };
    }
  }
  throw new Error("unreachable");
}
