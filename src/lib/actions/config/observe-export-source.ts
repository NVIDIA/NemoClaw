// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { sortCanonicalMappings } from "../../config/canonical-mapping";
import { cloneAndDeepFreeze } from "../../core/immutable";
import type {
  CanonicalExportPolicy,
  ExportFinding,
  ExportSourceFailureCategory,
  ExportSourceVerificationResult,
  ExportSnapshotReader,
  ExportSnapshotReadStage,
  NonEmptyExportFindings,
  ObservedExportPolicy,
  ObservedExportSnapshot,
  QualifiedExportPolicy,
  QualifiedExportSnapshot,
  RawExportSnapshot,
  VerifiedExportSource,
} from "../../domain/config/export-evidence";
import { verifyExportSource } from "../../domain/config/verify-export-source";
import {
  isSandboxPolicyCredentialFree,
  parseAndValidateSandboxPolicy,
} from "../../policy/sandbox-policy-validation";

export type ExportObservationResult =
  | { readonly ok: true; readonly source: VerifiedExportSource; readonly attempts: 1 | 2 }
  | {
      readonly ok: false;
      readonly findings: NonEmptyExportFindings;
      readonly attempts: 1 | 2;
    };

type ObservationAttempt = Readonly<{ kind: "changed" }> | ExportSourceVerificationResult;

function finding(
  field: string,
  category: ExportSourceFailureCategory,
  diagnostic: string,
): ExportFinding {
  return { field, category, diagnostic };
}

/** Prove canonical policy representation before data enters the domain verifier. */
function canonicalizeEffectivePolicy(document: string): CanonicalExportPolicy {
  if (!isSandboxPolicyCredentialFree(document)) {
    throw new Error("Effective policy must be credential-free.");
  }
  const parsed = parseAndValidateSandboxPolicy(document);
  const canonical = YAML.stringify(sortCanonicalMappings(parsed), {
    lineWidth: 0,
    sortMapEntries: true,
  });
  const reparsed = parseAndValidateSandboxPolicy(canonical);
  if (!isDeepStrictEqual(parsed, reparsed)) {
    throw new Error("Effective policy cannot be represented losslessly.");
  }
  return cloneAndDeepFreeze(sortCanonicalMappings(reparsed)) as CanonicalExportPolicy;
}

export function qualifyEffectivePolicy(observed: ObservedExportPolicy): QualifiedExportPolicy {
  const identity = { sandboxId: observed.sandboxId, revision: observed.revision };
  try {
    return {
      ...identity,
      kind: "verified",
      canonical: canonicalizeEffectivePolicy(observed.document),
    };
  } catch {
    return { ...identity, kind: "not-representable" };
  }
}

function qualifySnapshot(observed: ObservedExportSnapshot): QualifiedExportSnapshot {
  return { ...observed, policy: qualifyEffectivePolicy(observed.policy) };
}

const LIVE_READ_DIAGNOSTICS = {
  registry: "The sandbox registry could not be read or verified.",
  "gateway-binding": "The registered gateway binding could not be read or verified.",
  "gateway-authority":
    "The gateway declaration or retained onboarding authority could not be verified. " +
    "Check the declaration against the gateway selected during onboarding.",
  "gateway-configuration":
    "External gateway export requires native Linux and an HTTP 127.0.0.1 origin without gateway credentials. " +
    "Check the declared endpoint and host platform.",
  "gateway-registration":
    "The external gateway registration could not be verified. " +
    "Check that its endpoint and authentication match the gateway declaration.",
  "gateway-listener":
    "The external gateway listener or supervisor identity could not be verified. " +
    "Check that the declared service owns the running gateway listener.",
  "gateway-stability":
    "External gateway evidence changed during export. " +
    "Retry after the gateway configuration and listener are stable.",
  "sandbox-inventory": "The live sandbox inventory could not be read or verified.",
  "sandbox-identity": "The live sandbox identity could not be read or verified.",
  "inference-route": "The live gateway inference route could not be read or verified.",
  "provider-metadata": "The live inference provider metadata could not be read or verified.",
  "web-search-provider": "The live web-search provider metadata could not be read or verified.",
  "managed-serving": "The managed serving runtime could not be read or verified.",
  "ollama-serving": "The live Ollama daemon and proxy mapping could not be read or verified.",
  "effective-policy": "The effective OpenShell policy could not be read or verified.",
} satisfies Readonly<Record<ExportSnapshotReadStage, string>>;

function failedLiveRead(stage: ExportSnapshotReadStage): ObservationAttempt {
  return {
    kind: "rejected",
    findings: [finding("source.live", "live-verification-failed", LIVE_READ_DIAGNOSTICS[stage])],
  };
}

function failedCleanup(
  failure: Extract<RawExportSnapshot, { kind: "cleanup-failed" }>,
): ObservationAttempt {
  const directoryName =
    typeof failure.directoryName === "string" &&
    failure.directoryName.length === "nemoclaw-export-gateway-".length + 6 &&
    /^nemoclaw-export-gateway-[A-Za-z0-9]{6}$/u.test(failure.directoryName)
      ? ` '${failure.directoryName}'`
      : "";
  const primary =
    failure.readFailure && Object.hasOwn(LIVE_READ_DIAGNOSTICS, failure.readFailure)
      ? `${LIVE_READ_DIAGNOSTICS[failure.readFailure]} `
      : "";
  return {
    kind: "rejected",
    findings: [
      finding(
        "source.cleanup",
        "live-verification-failed",
        `${primary}The external gateway CLI temporary directory could not be removed. ` +
          `After the export process exits, inspect directory${directoryName} in its operating-system temporary directory. ` +
          "Remove it only if it is owned by your user. Export was refused.",
      ),
    ],
  };
}

async function observeAttempt(
  sandboxName: string,
  reader: ExportSnapshotReader,
): Promise<ObservationAttempt> {
  const observed = cloneAndDeepFreeze(await reader.read(sandboxName));
  if (observed.kind === "read-failed") return failedLiveRead(observed.stage);
  if (observed.kind === "cleanup-failed") return failedCleanup(observed);
  const confirmed = cloneAndDeepFreeze(await reader.read(sandboxName));
  if (confirmed.kind === "read-failed") return failedLiveRead(confirmed.stage);
  if (confirmed.kind === "cleanup-failed") return failedCleanup(confirmed);
  if (!isDeepStrictEqual(observed, confirmed)) return { kind: "changed" };
  if (observed.kind === "not-found") {
    if (observed.sandboxName !== sandboxName) {
      return {
        kind: "rejected",
        findings: [
          finding(
            "source.sandbox.name",
            "live-verification-failed",
            "The observed source identity does not match the requested sandbox.",
          ),
        ],
      };
    }
    return {
      kind: "rejected",
      findings: [finding("source.registry", "not-found", "The source sandbox is not registered.")],
    };
  }
  return verifyExportSource(sandboxName, qualifySnapshot(observed));
}

/** Compare two complete snapshots and retry the pair once when they differ. */
export async function observeStableExportSource(
  sandboxName: string,
  reader: ExportSnapshotReader,
): Promise<ExportObservationResult> {
  for (const attempts of [1, 2] as const) {
    const outcome = await observeAttempt(sandboxName, reader);
    if (outcome.kind === "changed") {
      if (attempts === 1) continue;
      return {
        ok: false,
        findings: [
          finding(
            "source",
            "unstable-source",
            "Source state changed during both complete observation attempts.",
          ),
        ],
        attempts,
      };
    }
    if (outcome.kind === "verified") return { ok: true, source: outcome.source, attempts };
    return { ok: false, findings: outcome.findings, attempts };
  }
  throw new Error("unreachable");
}
