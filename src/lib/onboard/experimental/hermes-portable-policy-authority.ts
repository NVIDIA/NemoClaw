// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import YAML from "yaml";

import { mergePresetNamesIntoPolicy } from "../../policy";
import { parseOpenShellPolicy } from "../../policy/merge";
import type { SandboxEntry } from "../../state/registry/types";
import { ensureRequiredTierPolicyPresets } from "../policy-tier-suppression";
import { isOpenShellNativeGpuBaselineEnrichment } from "../sandbox-gpu-route-policy";

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const MAX_POLICY_BYTES = 256 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

export interface HermesPortablePolicyCaptureResult {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly error?: Error;
}

export interface HermesPortablePolicyCapture {
  (args: readonly string[]): HermesPortablePolicyCaptureResult;
}

export interface HermesPortableLivePolicyProof {
  readonly intendedSemanticSha256: string;
  readonly verifiedLivePolicySemanticSha256: string;
  readonly expectedPolicySource: "create" | "finalized-registry";
}

function fail(message: string): never {
  throw new Error(`Hermes portable policy authority ${message}`);
}

function decode(bytes: Buffer, label: string): string {
  if (bytes.length > MAX_POLICY_BYTES) fail(`${label} exceeds the byte limit`);
  try {
    return UTF8.decode(bytes);
  } catch {
    fail(`${label} is not strict UTF-8`);
  }
}

interface CanonicalState {
  readonly active: WeakSet<object>;
  nodes: number;
}

function canonical(
  value: unknown,
  state: CanonicalState = { active: new WeakSet(), nodes: 0 },
  depth = 0,
): unknown {
  state.nodes += 1;
  if (state.nodes > 16_384 || depth > 64) fail("contains an oversized semantic structure");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") fail("contains a non-JSON semantic value");
  if (state.active.has(value)) fail("contains a cyclic semantic structure");
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => canonical(entry, state, depth + 1));
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (key.length === 0 || key.length > 1024) fail("contains an invalid mapping key");
      result[key] = canonical((value as Record<string, unknown>)[key], state, depth + 1);
    }
    return result;
  } finally {
    state.active.delete(value);
  }
}

function parseOnePolicyDocument(raw: string, label: string): Record<string, unknown> {
  let parsed: ReturnType<typeof parseOpenShellPolicy>;
  try {
    parsed = parseOpenShellPolicy(raw);
  } catch {
    fail(`${label} is invalid`);
  }
  const separators = [...raw.matchAll(/(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/gu)];
  if (separators.length > 1) fail(`${label} is duplicate or ambiguous`);
  if (separators.length === 1 && separators[0]!.index! > 0) {
    const prefix = raw.slice(0, separators[0]!.index).trim();
    if (prefix) {
      const prefixDocuments = YAML.parseAllDocuments(prefix);
      const prefixPolicy = prefixDocuments[0]?.toJSON();
      if (
        prefixDocuments.length !== 1 ||
        prefixDocuments[0]!.errors.length > 0 ||
        (prefixPolicy &&
          typeof prefixPolicy === "object" &&
          !Array.isArray(prefixPolicy) &&
          ("version" in prefixPolicy || "network_policies" in prefixPolicy))
      ) {
        fail(`${label} is duplicate or ambiguous`);
      }
    }
  }
  const documents = YAML.parseAllDocuments(parsed.yamlBody);
  if (documents.length !== 1 || documents[0]!.errors.length > 0) {
    fail(`${label} is duplicate or ambiguous`);
  }
  return parsed.policy;
}

function semanticDigest(policy: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(policy)))
    .digest("hex");
}

function rejectReservedCreateEntries(policy: Record<string, unknown>): void {
  const policies = policy.network_policies;
  if (!policies || typeof policies !== "object" || Array.isArray(policies)) return;
  if (Object.keys(policies).some((name) => name.startsWith("_provider_"))) {
    fail("create input contains a reserved provider-composed entry");
  }
}

function parseCreatePolicy(bytes: Buffer): Record<string, unknown> {
  const policy = parseOnePolicyDocument(decode(bytes, "create input"), "create input");
  rejectReservedCreateEntries(policy);
  return policy;
}

function finalizedPresetNames(entry: SandboxEntry): string[] {
  if (entry.agent !== "hermes") fail("finalized registry has another agent");
  if (entry.baselineExclusionTransition !== undefined) {
    fail("finalized registry has an incomplete baseline-policy mutation");
  }
  if ((entry.customPolicies ?? []).length > 0) {
    fail("finalized custom policy authority is not supported");
  }
  const rawPresetNames: unknown = entry.policies;
  if (rawPresetNames !== undefined && !Array.isArray(rawPresetNames)) {
    fail("finalized registry preset authority is invalid");
  }
  const presetNames = (rawPresetNames ?? []) as unknown[];
  if (
    presetNames.some((name) => typeof name !== "string" || !NAME.test(name)) ||
    new Set(presetNames).size !== presetNames.length
  ) {
    fail("finalized registry preset authority is invalid");
  }
  const names = presetNames as string[];
  const requiredNames = ensureRequiredTierPolicyPresets(entry.policyTier, names);
  if (
    requiredNames.length !== names.length ||
    requiredNames.some((name, index) => name !== names[index])
  ) {
    fail("finalized policy tier disagrees with preset authority");
  }
  return names;
}

/** Reconstruct the exact live policy authorized by a completed onboarding policy step. */
export function resolveHermesPortableExpectedPolicyBytes(
  createPolicyBytes: Buffer,
  finalizedRegistryEntry?: SandboxEntry | null,
): { readonly bytes: Buffer; readonly source: "create" | "finalized-registry" } {
  parseCreatePolicy(createPolicyBytes);
  if (finalizedRegistryEntry?.policyPresetsFinalized !== true) {
    return { bytes: Buffer.from(createPolicyBytes), source: "create" };
  }
  const presetNames = finalizedPresetNames(finalizedRegistryEntry);
  const excludedBaselineKeys = (finalizedRegistryEntry.baselineExclusions ?? []).map(
    (entry) => entry.key,
  );
  let composed: ReturnType<typeof mergePresetNamesIntoPolicy>;
  try {
    composed = mergePresetNamesIntoPolicy(decode(createPolicyBytes, "create input"), presetNames, {
      agent: "hermes",
      sandboxName: finalizedRegistryEntry.name,
      excludedBaselineKeys,
    });
  } catch {
    fail("cannot compose finalized registry preset authority");
  }
  if (
    composed.missingPresets.length > 0 ||
    composed.appliedPresets.length !== presetNames.length ||
    composed.appliedPresets.some((name, index) => name !== presetNames[index])
  ) {
    fail("cannot compose finalized registry preset authority");
  }
  const bytes = Buffer.from(composed.policy, "utf8");
  parseCreatePolicy(bytes);
  return { bytes, source: "finalized-registry" };
}

/** Capture and bind the exact create-policy bytes before sandbox creation. */
export function hermesPortableCreatePolicySemanticDigest(bytes: Buffer): string {
  return semanticDigest(parseCreatePolicy(bytes));
}

function capturePolicy(
  capture: HermesPortablePolicyCapture,
  args: readonly string[],
  label: string,
): Record<string, unknown> {
  const result = capture(args);
  decode(result.stderr, `${label} stderr`);
  if (result.status !== 0 || result.error) {
    fail(`${label} failed with status ${String(result.status)}`);
  }
  return parseOnePolicyDocument(decode(result.stdout, label), label);
}

/**
 * Prove the current 0.0.106 Hermes matrix's empty provider projection.
 * Both reads are explicitly gateway and sandbox scoped. A non-empty full/base
 * delta is unsupported until OpenShell exposes an authoritative projection.
 */
export function proveHermesPortableLivePolicy(input: {
  readonly gatewayName: string;
  readonly sandboxName: string;
  readonly createPolicyBytes: Buffer;
  readonly finalizedRegistryEntry?: SandboxEntry | null;
  readonly capture: HermesPortablePolicyCapture;
}): HermesPortableLivePolicyProof {
  if (!NAME.test(input.gatewayName) || !NAME.test(input.sandboxName)) {
    fail("gateway or sandbox identity is invalid");
  }
  const expected = resolveHermesPortableExpectedPolicyBytes(
    input.createPolicyBytes,
    input.finalizedRegistryEntry,
  );
  const intended = parseCreatePolicy(expected.bytes);
  const intendedSemanticSha256 = semanticDigest(intended);
  const prefix = ["policy", "get", "-g", input.gatewayName] as const;
  const base = capturePolicy(
    input.capture,
    [...prefix, "--base", input.sandboxName],
    "scoped base policy",
  );
  const full = capturePolicy(
    input.capture,
    [...prefix, "--full", input.sandboxName],
    "scoped full policy",
  );
  const baseDigest = semanticDigest(base);
  const fullDigest = semanticDigest(full);
  if (
    baseDigest !== intendedSemanticSha256 &&
    !isOpenShellNativeGpuBaselineEnrichment(intended, base)
  ) {
    fail("scoped base policy disagrees with create input");
  }
  if (fullDigest !== baseDigest) {
    fail("scoped full policy contains an unproven provider-composed or out-of-band delta");
  }
  return {
    intendedSemanticSha256,
    verifiedLivePolicySemanticSha256: fullDigest,
    expectedPolicySource: expected.source,
  };
}

export const hermesPortablePolicyAuthorityInternals = {
  isOpenShellNativeGpuBaselineEnrichment,
  semanticDigest,
};
