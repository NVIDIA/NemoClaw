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

const LIVE_READ_SOURCE_LABELS = {
  registry: "sandbox registry",
  "gateway-binding": "registered gateway binding",
  "sandbox-inventory": "live sandbox inventory",
  "sandbox-identity": "live sandbox identity",
  "inference-route": "live gateway inference route",
  "provider-metadata": "live inference provider metadata",
  "effective-policy": "effective OpenShell policy",
} satisfies Readonly<Record<ExportSnapshotReadStage, string>>;

function failedLiveRead(stage: ExportSnapshotReadStage): ObservationAttempt {
  return {
    kind: "rejected",
    findings: [
      finding(
        "source.live",
        "live-verification-failed",
        `The ${LIVE_READ_SOURCE_LABELS[stage]} could not be read or verified.`,
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
  const confirmed = cloneAndDeepFreeze(await reader.read(sandboxName));
  if (confirmed.kind === "read-failed") return failedLiveRead(confirmed.stage);
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
